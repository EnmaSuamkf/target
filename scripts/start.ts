/**
 * `npm start`: boots the agent-webhook-bridge (awb) broker and The Target Project hub
 * together, waits until both ports actually answer, opens the UI in a browser,
 * then holds the foreground with both children attached. Ctrl-C (SIGINT) or
 * SIGTERM tears both down cleanly.
 *
 * Runs after `npm run target:install` (scripts/bootstrap.mjs guarantees a node
 * >= 24), so it's TypeScript run directly by node like the rest of the repo.
 *
 * The awb clone lives in vendor/ unless AWB_DIR points elsewhere — the same
 * variable and default resolution scripts/install.ts uses. Ports come from the
 * exact config sources the daemons read (TARGET_HOME/config.json for the hub,
 * AWB_HOME/hooks.json for the broker), so overriding those to test on spare
 * ports keeps the readiness poll pointed at whatever the daemons will bind.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB_DIR = path.join(REPO_DIR, "hub");
const READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

interface Endpoint {
	host: string;
	port: number;
}

interface Component {
	label: string;
	endpoint: Endpoint;
	child?: ChildProcess;
	/** True when the port was already listening before we tried to spawn. */
	reused: boolean;
	/** True once we've seen the child exit (so we don't double-count it). */
	exited: boolean;
}

class StartError extends Error {}

function log(message: string, type: "info" | "warning" | "error" = "info"): void {
	const prefix = type === "error" ? "[error]" : type === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

function awbDir(): string {
	return process.env.AWB_DIR ?? path.join(REPO_DIR, "vendor", "agent-webhook-bridge");
}

/** Reads the port/host a JSON config exposes, falling back to defaults. */
function endpointFromConfig(file: string, fallback: Endpoint): Endpoint {
	try {
		const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Endpoint>;
		return { host: cfg.host ?? fallback.host, port: cfg.port ?? fallback.port };
	} catch {
		// Missing/invalid config → the daemon uses its own defaults, so do we.
		return fallback;
	}
}

function targetHome(): string {
	return process.env.TARGET_HOME ?? path.join(os.homedir(), ".target");
}

function hubEndpoint(): Endpoint {
	return endpointFromConfig(path.join(targetHome(), "config.json"), { host: "127.0.0.1", port: 8893 });
}

/**
 * The admin token from the hub's config.
 *
 * A hub we spawned prints it itself on startup, but one we're only reusing
 * printed it into whatever terminal started it — which isn't this one. Reading
 * it here means `npm start` always shows the token, however the hub got up.
 */
function adminToken(): string | null {
	try {
		const cfg = JSON.parse(fs.readFileSync(path.join(targetHome(), "config.json"), "utf8")) as {
			adminToken?: unknown;
		};
		return typeof cfg.adminToken === "string" && cfg.adminToken !== "" ? cfg.adminToken : null;
	} catch {
		// No config yet (first run, before the hub writes one) — the spawned hub
		// prints the token itself, so this is never the only way to see it.
		return null;
	}
}

function brokerEndpoint(): Endpoint {
	const home = process.env.AWB_HOME ?? path.join(os.homedir(), ".agent-webhook-bridge");
	return endpointFromConfig(path.join(home, "hooks.json"), { host: "127.0.0.1", port: 8890 });
}

function urlOf(e: Endpoint): string {
	return `http://${e.host}:${e.port}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when something is accepting TCP connections at host:port. */
function isListening(e: Endpoint, timeoutMs = 1000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: e.host, port: e.port });
		const done = (ok: boolean): void => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

/** Polls until the port answers or the deadline passes. */
async function waitForPort(comp: Component, deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		if (comp.exited) {
			throw new StartError(`${comp.label} exited before it started listening on ${urlOf(comp.endpoint)}`);
		}
		if (await isListening(comp.endpoint)) return;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new StartError(`${comp.label} did not come up on ${urlOf(comp.endpoint)} within ${READY_TIMEOUT_MS / 1000}s`);
}

function killAll(components: Component[], signal: NodeJS.Signals = "SIGTERM"): void {
	for (const c of components) {
		if (c.child && !c.exited) c.child.kill(signal);
	}
}

/**
 * Stops a service we didn't spawn, by finding whoever holds its port.
 *
 * A reused service has no child handle to signal, so the PID is resolved with
 * `lsof` (falling back to `fuser`) and signalled directly. Best-effort by
 * design: if neither tool exists, or the process is owned by another user,
 * this reports and moves on rather than failing the shutdown.
 */
function stopByPort(comp: Component, signal: NodeJS.Signals): void {
	const { port } = comp.endpoint;
	let pids: number[] = [];

	const lsof = spawnSync("lsof", ["-t", `-i:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
	if (lsof.status === 0 && lsof.stdout.trim()) {
		pids = lsof.stdout.trim().split(/\s+/).map(Number).filter(Number.isInteger);
	} else {
		const fuser = spawnSync("fuser", [`${port}/tcp`], { encoding: "utf8" });
		if (fuser.status === 0) {
			const out = `${fuser.stdout ?? ""} ${fuser.stderr ?? ""}`;
			pids = out.trim().split(/\s+/).map(Number).filter(Number.isInteger);
		}
	}

	// Never signal ourselves: `npm start` isn't what's holding the port, but a
	// bad parse shouldn't be able to take this process down either.
	pids = pids.filter((pid) => pid > 0 && pid !== process.pid);

	if (pids.length === 0) {
		log(`could not find the process holding ${urlOf(comp.endpoint)} — stop ${comp.label} yourself.`, "warning");
		return;
	}

	for (const pid of pids) {
		try {
			process.kill(pid, signal);
			log(`stopped ${comp.label} (pid ${pid}).`);
		} catch {
			log(`could not stop ${comp.label} (pid ${pid}) — stop it yourself.`, "warning");
		}
	}
}

/** Opens the URL in the default browser; a failure is logged, never fatal. */
function openBrowser(url: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	try {
		const child = spawn(opener, [url], {
			stdio: "ignore",
			detached: true,
			shell: process.platform === "win32",
		});
		child.on("error", () => log(`could not open a browser — open ${url} yourself.`, "warning"));
		child.unref();
	} catch {
		log(`could not open a browser — open ${url} yourself.`, "warning");
	}
}

async function main(): Promise<void> {
	const brokerEntry = path.join(awbDir(), "broker", "daemon.ts");
	if (!fs.existsSync(brokerEntry)) {
		throw new StartError(`no awb broker at ${brokerEntry}. Run \`npm run target:install\` first (or set AWB_DIR to a clone).`);
	}
	if (!fs.existsSync(path.join(HUB_DIR, "node_modules"))) {
		throw new StartError("hub dependencies are missing. Run `npm run target:install` first.");
	}
	// The UI is a Vite build (hub/ui/dist), not a checked-in file — without it
	// the hub answers `/` with a plain-text notice instead of the app, which is
	// a confusing way to find out the install step was skipped.
	if (!fs.existsSync(path.join(HUB_DIR, "ui", "dist", "index.html"))) {
		throw new StartError("the web UI isn't built. Run `npm run target:install` first.");
	}

	const components: Component[] = [
		{ label: "awb broker", endpoint: brokerEndpoint(), reused: false, exited: false },
		{ label: "The Target Project hub", endpoint: hubEndpoint(), reused: false, exited: false },
	];

	// Spawn each component only if its port isn't already answering — a broker
	// or hub someone already started is reused, not fought over (which would
	// only earn us an EADDRINUSE crash from the child).
	const broker = components[0];
	const hub = components[1];
	broker.reused = await isListening(broker.endpoint);
	hub.reused = await isListening(hub.endpoint);

	if (broker.reused) {
		log(`awb broker already listening on ${urlOf(broker.endpoint)} — reusing it.`);
	} else {
		log(`starting awb broker (${urlOf(broker.endpoint)})...`);
		broker.child = spawn(process.execPath, [brokerEntry], { cwd: awbDir(), stdio: "inherit" });
	}

	if (hub.reused) {
		log(`The Target Project hub already listening on ${urlOf(hub.endpoint)} — reusing it.`);
	} else {
		log(`starting The Target Project hub (${urlOf(hub.endpoint)})...`);
		hub.child = spawn(process.execPath, ["daemon.ts"], { cwd: HUB_DIR, stdio: "inherit" });
	}

	for (const c of components) {
		if (!c.child) continue;
		c.child.on("exit", () => {
			c.exited = true;
		});
	}

	// Wait for both to actually answer before declaring victory.
	const deadline = Date.now() + READY_TIMEOUT_MS;
	try {
		await waitForPort(broker, deadline);
		await waitForPort(hub, deadline);
	} catch (err) {
		killAll(components);
		throw err;
	}

	if (process.env.TARGET_NO_BROWSER !== "1") {
		openBrowser(urlOf(hub.endpoint));
	}

	const token = adminToken();
	const reusedAny = components.some((c) => c.reused);

	console.log(`
Ready.

  awb broker:  ${urlOf(broker.endpoint)}${broker.reused ? "   (reused)" : ""}
  The Target Project hub:  ${urlOf(hub.endpoint)}   (${
		process.env.TARGET_NO_BROWSER === "1" ? "UI not opened — desktop shell will load it" : "UI opened in your browser"
	})${hub.reused ? "   (reused)" : ""}

  admin token: ${token ?? "(unavailable — see ~/.target/config.json)"}

The UI asks for the token and the CLI uses it automatically.${
		reusedAny ? "\nServices already running were reused; Ctrl-C stops them too." : ""
	}
Press Ctrl-C to stop both.
`);

	// Hold the foreground until everything is down, and forward Ctrl-C /
	// SIGTERM so shutdown is clean rather than orphaning anything.
	//
	// Reused services aren't our children — we can't wait on an `exit` event or
	// signal them through a handle, so they're polled and stopped by PID. That
	// keeps `npm start` behaving the same either way: it stays in the
	// foreground and Ctrl-C takes the whole stack down, whether this invocation
	// spawned the services or adopted ones already running.
	await new Promise<void>((resolve) => {
		const spawned = components.filter((c) => c.child);
		const reused = components.filter((c) => !c.child);
		let remaining = spawned.length;
		let done = false;

		const finish = (): void => {
			if (done) return;
			done = true;
			clearInterval(watch);
			resolve();
		};

		const onExit = (c: Component) => (code: number | null, signal: NodeJS.Signals | null): void => {
			c.exited = true;
			log(`${c.label} exited (${signal ?? `code ${code ?? 0}`}).`);
			if (--remaining === 0 && reused.length === 0) finish();
		};
		for (const c of spawned) c.child?.on("exit", onExit(c));

		// Notice a reused service dying on its own (or being stopped from the
		// terminal that started it) so we don't hold the foreground forever.
		const watch = setInterval(() => {
			void (async () => {
				if (done || reused.length === 0) return;
				for (const c of reused) {
					if (c.exited) continue;
					if (!(await isListening(c.endpoint))) {
						c.exited = true;
						log(`${c.label} is no longer listening.`);
					}
				}
				if (components.every((c) => c.exited)) finish();
			})();
		}, 1000);

		const shutdown = (signal: NodeJS.Signals): void => {
			log(`received ${signal} — shutting down...`);
			killAll(components, signal);
			for (const c of reused) {
				if (!c.exited) stopByPort(c, signal);
			}
			// Children report their own exit; reused ones are gone once the port
			// stops answering, which the watcher above picks up. Give both a beat,
			// then leave regardless so Ctrl-C never appears to hang.
			setTimeout(finish, 1500);
		};
		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));
	});
}

main().catch((err) => {
	log(err instanceof StartError ? err.message : String(err), "error");
	process.exitCode = 1;
});
