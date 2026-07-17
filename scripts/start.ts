/**
 * `npm start`: boots the agent-webhook-bridge (awb) broker and the target hub
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
import { type ChildProcess, spawn } from "node:child_process";
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

function hubEndpoint(): Endpoint {
	const home = process.env.TARGET_HOME ?? path.join(os.homedir(), ".target");
	return endpointFromConfig(path.join(home, "config.json"), { host: "127.0.0.1", port: 8893 });
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

	const components: Component[] = [
		{ label: "awb broker", endpoint: brokerEndpoint(), reused: false, exited: false },
		{ label: "target hub", endpoint: hubEndpoint(), reused: false, exited: false },
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
		log(`target hub already listening on ${urlOf(hub.endpoint)} — reusing it.`);
	} else {
		log(`starting target hub (${urlOf(hub.endpoint)})...`);
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

	openBrowser(urlOf(hub.endpoint));

	console.log(`
Ready.

  awb broker:  ${urlOf(broker.endpoint)}
  target hub:  ${urlOf(hub.endpoint)}   (UI opened in your browser)

The hub's admin token is printed above (also in ~/.target/config.json) — the
UI asks for it and the CLI uses it automatically. Press Ctrl-C to stop both.
`);

	const spawned = components.filter((c) => c.child);
	if (spawned.length === 0) {
		log("both services were already running — nothing to hold; exiting.");
		return;
	}

	// Hold the foreground until every child we started exits, and forward a
	// Ctrl-C / SIGTERM to them so shutdown is clean rather than orphaning them.
	await new Promise<void>((resolve) => {
		let remaining = spawned.length;
		const onExit = (c: Component) => (code: number | null, signal: NodeJS.Signals | null): void => {
			c.exited = true;
			log(`${c.label} exited (${signal ?? `code ${code ?? 0}`}).`);
			if (--remaining === 0) resolve();
		};
		for (const c of spawned) c.child?.on("exit", onExit(c));

		const shutdown = (signal: NodeJS.Signals): void => {
			log(`received ${signal} — shutting down...`);
			killAll(components, signal);
		};
		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));
	});
}

main().catch((err) => {
	log(err instanceof StartError ? err.message : String(err), "error");
	process.exitCode = 1;
});
