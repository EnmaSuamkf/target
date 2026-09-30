#!/usr/bin/env node
/**
 * End-to-end harness for the scheduled-workflows program: a throwaway
 * target-server + a throwaway hub + a stand-in awb broker, all local, all
 * killed when the run ends (see README.md for the rules it keeps).
 *
 *   npm run e2e:scheduled                   # every scenario
 *   npm run e2e:scheduled -- --only S0,S3   # just those
 *   npm run e2e:scheduled -- --keep         # leave the temp dir (logs, DBs) behind
 *
 * Exit code: 0 when every selected scenario passed, 1 when one failed, 2 for a
 * harness/usage problem (busy port, unexpected server checkout, bad --only).
 *
 * Nothing here talks to the live hub on 8893 or reads the real ~/.target and
 * ~/.agent-webhook-bridge: every child gets a WHITELISTED environment (no
 * inherited TARGET_*), HOME pointing into the temp dir, and its own ports.
 */
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB_REPO = path.resolve(HERE, "..", "..");
const SERVER_REPO = path.resolve(process.env.E2E_SERVER_DIR ?? path.join(HUB_REPO, "..", "target-server"));

const HUB_PORT = 8993;
const SERVER_PORT = 8994;
const BROKER_PORT = 8990;
const LIVE_HUB_PORT = 8893; // never touched; only named so the preflight can say so
const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const INTEGRATION_REF = "origin/integration/scheduled-workflows";

const ADMIN_EMAIL = "admin@admin.com"; // seeded by the server on first boot
const ADMIN_PASSWORD = "e2e-password-target";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const ALLOW_ANY_SERVER_REV = args.includes("--any-server-rev");
const onlyIdx = args.indexOf("--only");
const ONLY =
	onlyIdx >= 0
		? (args[onlyIdx + 1] ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: null;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function log(msg) {
	console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
}

class HarnessError extends Error {}

function check(cond, msg) {
	if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function checkEq(actual, expected, msg) {
	if (actual !== expected) {
		throw new Error(`assertion failed: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

/** Poll `fn` until it returns a truthy value; its last error/value goes into the timeout message. */
async function waitFor(what, fn, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			const v = await fn();
			if (v) return v;
			last = v;
		} catch (err) {
			last = err;
		}
		await sleep(intervalMs);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${last ? ` (last: ${String(last?.message ?? last)})` : ""}`);
}

function portInUse(port) {
	return new Promise((resolve) => {
		const sock = net.connect({ host: "127.0.0.1", port });
		sock.once("connect", () => {
			sock.destroy();
			resolve(true);
		});
		sock.once("error", () => resolve(false));
	});
}

async function httpJson(method, url, { headers = {}, body, timeoutMs = 15_000 } = {}) {
	const res = await fetch(url, {
		method,
		headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		// non-JSON body (HTML, empty) — callers that care read `text`
	}
	return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Run context: temp dirs, child processes, cleanup
// ---------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sched-e2e-"));
const DIRS = {
	root: TMP,
	home: path.join(TMP, "home"), // HOME for every child
	hubHome: path.join(TMP, "hub-home"), // TARGET_HOME
	awbHome: path.join(TMP, "awb-home"), // AWB_HOME
	serverData: path.join(TMP, "server"), // server cwd: DB, control DB, mail outbox
	logs: path.join(TMP, "logs"),
	bin: path.join(TMP, "bin"), // fake claude + xdg-open
	work: path.join(TMP, "work"), // hook workdirs
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const children = []; // { name, child }

function childEnv(extra) {
	// Whitelist, never inherit: a stray TARGET_REPORT_* / TARGET_SYNC_* in the
	// caller's shell must not be able to point a throwaway process at the real server.
	return {
		PATH: `${DIRS.bin}${path.delimiter}${process.env.PATH ?? ""}`,
		HOME: DIRS.home,
		LANG: process.env.LANG ?? "C.UTF-8",
		TMPDIR: TMP,
		...extra,
	};
}

function startProcess(name, cmd, cmdArgs, { cwd, env }) {
	const out = fs.openSync(path.join(DIRS.logs, `${name}.log`), "a");
	const child = spawn(cmd, cmdArgs, { cwd, env, stdio: ["ignore", out, out] });
	fs.closeSync(out);
	const entry = { name, child, exited: false };
	child.once("exit", (code, signal) => {
		entry.exited = true;
		entry.exitInfo = `code=${code} signal=${signal}`;
	});
	children.push(entry);
	return entry;
}

async function stopProcess(entry) {
	const { child } = entry;
	if (entry.exited || child.exitCode !== null) return;
	// By the child's OWN pid (we spawned node directly, no shell in between):
	// a pattern kill would also take down the live hub on 8893.
	child.kill("SIGTERM");
	const deadline = Date.now() + 5_000;
	while (!entry.exited && Date.now() < deadline) await sleep(100);
	if (!entry.exited) {
		child.kill("SIGKILL");
		while (!entry.exited) await sleep(50);
	}
}

let cleanedUp = false;
let broker = null;
async function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	for (const entry of [...children].reverse()) await stopProcess(entry).catch(() => {});
	if (broker) await broker.close().catch(() => {});
	if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
	else log(`kept ${TMP}`);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(sig, () => {
		log(`${sig} — cleaning up`);
		void cleanup().finally(() => process.exit(130));
	});
}

function tailLog(name, lines = 25) {
	try {
		const all = fs.readFileSync(path.join(DIRS.logs, `${name}.log`), "utf8").trimEnd().split("\n");
		return all.slice(-lines).join("\n");
	} catch {
		return "(no log)";
	}
}

// ---------------------------------------------------------------------------
// Stand-in awb broker
// ---------------------------------------------------------------------------

/**
 * Implements awb's hook contract and nothing else: POST /hook/<name> with
 * x-webhook-secret (checked against $AWB_HOME/hooks.json, re-read per request
 * like the real broker) and an optional `sessionid` header. It answers 202,
 * posts {} to startedCallbackUrl, then {ok, result, session_id, exitCode} to
 * callbackUrl. It never spawns an agent. A judge prompt (recognised by the
 * verdict-format instruction runner.ts appends) gets a passing verdict.
 *
 * Deterministic knobs for scenarios:
 *   broker.delayMs = n                    delay every job's completion
 *   broker.delayFor(hookName, n)          delay one hook's jobs (overlap scenario)
 *   broker.failNext(hookName)             the next exec job of that hook answers ok:false
 *   broker.jobs                           every job received, in order
 */
function createBroker() {
	const state = {
		jobs: [],
		delayMs: 0,
		hookDelay: new Map(),
		failHooks: new Set(),
		timers: new Map(), // jobId → timeout, so /abort can cancel
	};
	const JUDGE_MARKER = "end your reply with a JSON object on its own final line";

	function hooks() {
		try {
			return JSON.parse(fs.readFileSync(path.join(DIRS.awbHome, "hooks.json"), "utf8")).hooks ?? {};
		} catch {
			return {};
		}
	}

	async function postJson(url, body) {
		try {
			await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
			});
		} catch (err) {
			log(`broker: callback to ${url.split("?")[0]} failed: ${String(err)}`);
		}
	}

	function readBody(req) {
		return new Promise((resolve) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
				} catch {
					resolve({});
				}
			});
		});
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const parts = url.pathname.split("/").filter(Boolean);
		const reply = (status, obj) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(obj));
		};
		if (req.method === "GET" && url.pathname === "/health") return reply(200, { ok: true, broker: "e2e-stand-in" });
		if (req.method !== "POST" || parts[0] !== "hook" || !parts[1]) return reply(404, { error: "not_found" });
		const name = decodeURIComponent(parts[1]);
		const hook = hooks()[name];
		if (!hook) return reply(404, { error: "unknown_hook" });
		if (req.headers["x-webhook-secret"] !== hook.secret) return reply(401, { error: "bad_secret" });
		const body = await readBody(req);

		if (parts[2] === "abort") {
			const timer = state.timers.get(body.jobId);
			if (timer) clearTimeout(timer);
			state.timers.delete(body.jobId);
			return reply(200, { killed: Boolean(timer) });
		}

		const input = typeof body.input === "string" ? body.input : "";
		const isJudge = input.includes(JUDGE_MARKER);
		const sessionHeader = typeof req.headers.sessionid === "string" ? req.headers.sessionid : null;
		const sessionId = sessionHeader ?? `e2e-session-${crypto.randomUUID()}`;
		const job = {
			hook: name,
			jobId: body.jobId,
			kind: isJudge ? "judge" : "exec",
			input,
			sessionHeader,
			sessionId,
			receivedAt: new Date().toISOString(),
			completedAt: null,
		};
		state.jobs.push(job);
		reply(202, { accepted: true, jobId: body.jobId });

		const delay = state.hookDelay.get(name) ?? state.delayMs;
		void (async () => {
			await postJson(body.startedCallbackUrl, {});
			const finish = async () => {
				state.timers.delete(body.jobId);
				const fail = !isJudge && state.failHooks.delete(name);
				job.completedAt = new Date().toISOString();
				job.ok = !fail;
				await postJson(body.callbackUrl, {
					ok: !fail,
					result: fail
						? "stand-in broker: forced failure"
						: isJudge
							? 'Re-inspected the result.\n{"ok": true, "reason": "stand-in broker: criterion met"}'
							: `stand-in broker: completed ${String(body.jobId).slice(0, 8)}`,
					session_id: sessionId,
					exitCode: fail ? 1 : 0,
				});
			};
			if (delay > 0) state.timers.set(body.jobId, setTimeout(() => void finish(), delay));
			else await finish();
		})();
	});

	return {
		get jobs() {
			return state.jobs;
		},
		get delayMs() {
			return state.delayMs;
		},
		set delayMs(n) {
			state.delayMs = n;
		},
		delayFor: (hook, ms) => (ms > 0 ? state.hookDelay.set(hook, ms) : state.hookDelay.delete(hook)),
		failNext: (hook) => state.failHooks.add(hook),
		listen: () =>
			new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(BROKER_PORT, "127.0.0.1", resolve);
			}),
		close: () =>
			new Promise((resolve) => {
				for (const t of state.timers.values()) clearTimeout(t);
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

// ---------------------------------------------------------------------------
// target-server
// ---------------------------------------------------------------------------

const server = {
	cookie: "",
	async boot() {
		const dbPath = path.join(DIRS.serverData, "target-server.db");
		startProcess("server", process.execPath, [path.join(SERVER_REPO, "server.mjs")], {
			cwd: DIRS.serverData, // mail outbox + relative paths land here, not in the repo
			env: childEnv({
				HOST: "127.0.0.1",
				PORT: String(SERVER_PORT),
				TARGET_SERVER_DB: dbPath,
				TARGET_CONTROL_DB: path.join(DIRS.serverData, "control.db"),
				TARGET_DEVICE_LINKING_MODE: "optional",
				TARGET_SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
				TARGET_AUTH_SECRET: crypto.randomBytes(24).toString("hex"),
				TARGET_AUTH_SECURE_COOKIE: "0",
				TARGET_PUBLIC_URL: SERVER_URL,
				TARGET_SKIP_UI_STALE_CHECK: "1",
				TARGET_MAIL_TRANSPORT: "file", // no mail leaves the machine
			}),
		});
		await waitFor("target-server to answer", async () => (await httpJson("GET", `${SERVER_URL}/api/auth/providers`)).ok, {
			timeoutMs: 30_000,
		}).catch((err) => {
			throw new HarnessError(`${err.message}\n--- server log ---\n${tailLog("server")}`);
		});
		const login = await httpJson("POST", `${SERVER_URL}/api/auth/login`, {
			body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
		});
		if (!login.ok) throw new HarnessError(`server admin login failed: ${login.status} ${login.text}`);
		this.cookie = login.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");
		if (!this.cookie) throw new HarnessError("server login returned no session cookie");
	},
	/** Dashboard-session call (the operator). */
	api(method, p, body) {
		return httpJson(method, `${SERVER_URL}${p}`, { headers: { cookie: this.cookie, origin: SERVER_URL }, body });
	},
};

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

const hub = {
	token: "",
	async boot() {
		// The real hooks.json shape (see hub/awb.ts): hooks land on OUR broker port.
		fs.writeFileSync(
			path.join(DIRS.awbHome, "hooks.json"),
			`${JSON.stringify({ host: "127.0.0.1", port: BROKER_PORT, maxBodyBytes: 1024 * 1024, publicBaseUrl: null, hooks: {} }, null, 2)}\n`,
		);
		fs.writeFileSync(path.join(DIRS.hubHome, "config.json"), `${JSON.stringify({ port: HUB_PORT })}\n`);
		this.spawn();
		await waitFor("the hub to answer /health", async () => (await httpJson("GET", `${HUB_URL}/health`)).ok, {
			timeoutMs: 30_000,
		}).catch((err) => {
			throw new HarnessError(`${err.message}\n--- hub log ---\n${tailLog("hub")}`);
		});
		this.token = JSON.parse(fs.readFileSync(path.join(DIRS.hubHome, "config.json"), "utf8")).adminToken;
		if (!this.token) throw new HarnessError("hub wrote no adminToken to its config.json");
	},
	spawn() {
		this.entry = startProcess("hub", process.execPath, [path.join(HUB_REPO, "hub", "daemon.ts")], {
			cwd: path.join(HUB_REPO, "hub"),
			env: childEnv({
				TARGET_HOME: DIRS.hubHome,
				AWB_HOME: DIRS.awbHome,
				TARGET_SYNC_INTERVAL_MS: "5000", // the floor; a linked hub otherwise ticks every 10s
			}),
		});
	},
	/** Stop the hub (by its own pid) — used to simulate downtime. */
	async stop() {
		await stopProcess(this.entry);
	},
	async restart() {
		await this.stop();
		this.spawn();
		await waitFor("the restarted hub to answer /health", async () => (await httpJson("GET", `${HUB_URL}/health`)).ok, {
			timeoutMs: 30_000,
		});
	},
	api(method, p, body) {
		return httpJson(method, `${HUB_URL}${p}`, { headers: { authorization: `Bearer ${this.token}` }, body });
	},
	/** Direct access to the throwaway hub's SQLite file, for time travel. Stop the hub first when writing. */
	db() {
		return new DatabaseSync(path.join(DIRS.hubHome, "target.db"));
	},
};

/** Link the hub to the throwaway server through the real device-link flow. */
async function linkHub() {
	const started = await hub.api("POST", "/api/device-link/start", { origin: SERVER_URL, deviceName: "e2e-hub" });
	check(started.ok, `device-link/start answered ${started.status} ${started.text}`);
	const browserUrl = started.json?.outcome?.browserUrl;
	check(typeof browserUrl === "string", `start returned a browser URL (got ${started.text})`);
	const requestId = decodeURIComponent(new URL(browserUrl).pathname.split("/").pop());

	const approved = await server.api("POST", `/api/device-links/requests/${encodeURIComponent(requestId)}/approve`, {});
	check(approved.ok, `server approve answered ${approved.status} ${approved.text}`);

	const outcome = await waitFor(
		"the hub to consume the approved link",
		async () => {
			const polled = await hub.api("POST", "/api/device-link/poll", {});
			const o = polled.json?.outcome;
			if (o?.code === "connected") return o;
			if (["approval_denied", "approval_expired", "relink_required"].includes(o?.code)) {
				throw new HarnessError(`link failed: ${o.code}`);
			}
			return null;
		},
		{ timeoutMs: 30_000, intervalMs: 1_000 },
	);
	return { requestId, outcome };
}

/** The owner snapshot is only "enforced" after a live heartbeat; wait for it so permissions behave like production. */
async function waitForLiveOwner() {
	return await waitFor(
		"the first live heartbeat (owner permissions enforced)",
		async () => {
			const p = await hub.api("GET", "/api/permissions");
			return p.ok && p.json?.mode === "enforced" ? p.json : null;
		},
		{ timeoutMs: 45_000, intervalMs: 1_000 },
	);
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

/** Create a host-sandbox workflow with the given steps; returns { workflow, steps }. */
async function createWorkflow(name, steps, options = {}) {
	const workdir = path.join(DIRS.work, name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
	const created = await hub.api("POST", "/api/workflows", { name, workdir, ...options });
	check(created.ok, `create workflow answered ${created.status} ${created.text}`);
	const workflow = created.json.workflow;
	const made = [];
	for (const spec of steps) {
		const s = await hub.api("POST", `/api/workflows/${workflow.id}/steps`, spec);
		check(s.ok, `add step answered ${s.status} ${s.text}`);
		made.push(s.json.step);
	}
	return { workflow, steps: made };
}

async function getWorkflow(id) {
	const r = await hub.api("GET", `/api/workflows/${id}`);
	check(r.ok, `GET workflow ${id} answered ${r.status}`);
	return r.json;
}

async function waitForStatus(id, statuses, timeoutMs = 60_000) {
	const want = new Set(Array.isArray(statuses) ? statuses : [statuses]);
	return await waitFor(
		`workflow ${id} to reach ${[...want].join("|")}`,
		async () => {
			const d = await getWorkflow(id);
			return want.has(d.workflow.status) ? d : null;
		},
		{ timeoutMs, intervalMs: 500 },
	);
}

const ctx = { hub, server, get broker() { return broker; }, DIRS, HUB_URL, SERVER_URL, linkHub, createWorkflow, getWorkflow, waitForStatus, waitFor, check, checkEq, sleep, log };

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = [
	{
		id: "S0",
		title: "boot, link, and a plain two-step workflow completes through the stand-in broker",
		async run(c) {
			// Linked and live: the server knows this device and the hub sees its owner's permissions.
			const status = await c.hub.api("GET", "/api/device-link");
			c.checkEq(status.json?.status?.state, "connected", "hub device-link state");
			const devices = await c.server.api("GET", "/api/device-links/devices");
			c.check(devices.ok, `server device list answered ${devices.status}`);
			const list = devices.json?.devices ?? devices.json ?? [];
			c.check(Array.isArray(list) && list.length === 1, `exactly one linked device on the server (got ${devices.text.slice(0, 200)})`);
			const perms = await c.hub.api("GET", "/api/permissions");
			c.checkEq(perms.json?.mode, "enforced", "permission mode");

			// Sync is alive: the server registered a client for this hub.
			const clients = await c.waitFor(
				"the server to list the hub's sync client",
				async () => {
					const r = await c.server.api("GET", "/api/sync/clients");
					const arr = r.json?.clients ?? [];
					return r.ok && arr.length >= 1 ? arr : null;
				},
				{ timeoutMs: 30_000, intervalMs: 1_000 },
			);
			c.log(`S0: ${clients.length} sync client(s) registered on the server`);

			// A plain (non-scheduled) workflow: step 2 carries acceptance criteria so the judge pass runs too.
			const { workflow, steps } = await c.createWorkflow("S0 plain workflow", [
				{ description: "First step: write the word alpha." },
				{
					description: "Second step: write the word beta.",
					acceptanceCriteria: "The reply mentions beta.",
					maxRetries: 1,
				},
			]);
			const started = await c.hub.api("POST", `/api/workflows/${workflow.id}/start`, { stepIds: steps.map((s) => s.id) });
			c.check(started.ok, `start answered ${started.status} ${started.text}`);

			const done = await c.waitForStatus(workflow.id, ["completed", "failed"], 90_000);
			c.checkEq(done.workflow.status, "completed", "workflow status");
			const userSteps = done.steps.filter((s) => steps.some((made) => made.id === s.id));
			c.checkEq(userSteps.length, 2, "user steps present");
			for (const s of userSteps) c.checkEq(s.status, "done", `step ${s.id} status`);

			// The broker saw what a real run would send: exec, exec, judge; later turns resume the session.
			const jobs = c.broker.jobs.filter((j) => j.hook === done.workflow.agentName || j.hook === workflow.agentName);
			const kinds = jobs.map((j) => j.kind).join(",");
			c.check(jobs.filter((j) => j.kind === "exec").length >= 2, `at least two exec jobs reached the broker (got ${kinds})`);
			c.check(jobs.some((j) => j.kind === "judge"), `a judge job reached the broker (got ${kinds})`);
			const resumed = jobs.filter((j) => j.sessionHeader).length;
			c.check(resumed >= 1, "a later turn resumed the session through the sessionid header");
			c.log(`S0: broker jobs = ${kinds}`);
		},
	},
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function writeFakeBinaries() {
	// The hub refuses to create a host workflow when the runner CLI isn't on PATH
	// (availableRunners runs `<bin> --version`); the stand-in broker never spawns
	// it, so a stub that answers --version is all that's needed — and it keeps the
	// harness independent of a real claude install. xdg-open is stubbed so linking
	// never opens a browser on the operator's desktop.
	const stub = (name, body) => {
		const file = path.join(DIRS.bin, name);
		fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	};
	stub("claude", 'echo "0.0.0-e2e-stub"');
	stub("free-code", 'echo "0.0.0-e2e-stub"');
	stub("xdg-open", "exit 0");
}

function gitOut(cwd, ...gitArgs) {
	const r = spawnSync("git", ["-C", cwd, ...gitArgs], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : null;
}

function preflightCheckouts() {
	const serverHead = gitOut(SERVER_REPO, "rev-parse", "HEAD");
	if (!serverHead) throw new HarnessError(`${SERVER_REPO} is not a git checkout (set E2E_SERVER_DIR)`);
	const integration = gitOut(SERVER_REPO, "rev-parse", INTEGRATION_REF);
	const hubHead = gitOut(HUB_REPO, "rev-parse", "HEAD");
	log(`hub repo    ${HUB_REPO} @ ${hubHead?.slice(0, 10)}`);
	log(`server repo ${SERVER_REPO} @ ${serverHead.slice(0, 10)} (${INTEGRATION_REF} = ${integration?.slice(0, 10) ?? "?"})`);
	if (!ALLOW_ANY_SERVER_REV && integration && serverHead !== integration) {
		throw new HarnessError(
			`target-server is at ${serverHead.slice(0, 10)}, not ${INTEGRATION_REF} (${integration.slice(0, 10)}). ` +
				"Check it out detached at the integration branch, or pass --any-server-rev.",
		);
	}
}

async function main() {
	const selected = ONLY ? SCENARIOS.filter((s) => ONLY.includes(s.id)) : SCENARIOS;
	if (ONLY) {
		const unknown = ONLY.filter((id) => !SCENARIOS.some((s) => s.id === id));
		if (unknown.length > 0) {
			throw new HarnessError(`unknown scenario id(s): ${unknown.join(", ")} (known: ${SCENARIOS.map((s) => s.id).join(", ")})`);
		}
	}
	if (selected.length === 0) throw new HarnessError("no scenarios selected");

	for (const [port, what] of [
		[HUB_PORT, "throwaway hub"],
		[SERVER_PORT, "throwaway server"],
		[BROKER_PORT, "stand-in broker"],
	]) {
		if (await portInUse(port)) {
			throw new HarnessError(`port ${port} (${what}) is already in use — a previous run may have leaked a process. The live hub on ${LIVE_HUB_PORT} is never touched.`);
		}
	}
	preflightCheckouts();
	writeFakeBinaries();
	log(`temp dir ${TMP}`);

	broker = createBroker();
	await broker.listen();
	log(`stand-in broker on 127.0.0.1:${BROKER_PORT}`);
	await server.boot();
	log(`target-server up on ${SERVER_URL}`);
	await hub.boot();
	log(`hub up on ${HUB_URL}`);
	await linkHub();
	log("hub linked to the server through the device-link flow");
	await waitForLiveOwner();
	log("owner permissions are live (enforced)");

	const results = [];
	for (const scenario of selected) {
		const started = Date.now();
		log(`--- ${scenario.id}: ${scenario.title}`);
		try {
			await scenario.run(ctx);
			results.push({ id: scenario.id, title: scenario.title, pass: true, ms: Date.now() - started });
			log(`${scenario.id} PASS`);
		} catch (err) {
			results.push({ id: scenario.id, title: scenario.title, pass: false, ms: Date.now() - started, error: String(err?.message ?? err) });
			log(`${scenario.id} FAIL: ${String(err?.message ?? err)}`);
			log(`--- hub log tail ---\n${tailLog("hub")}`);
		}
	}
	return results;
}

let exitCode = 0;
try {
	const results = await main();
	console.log("\n=== scheduled-workflows e2e summary ===");
	for (const r of results) {
		console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.title}  (${(r.ms / 1000).toFixed(1)}s)`);
		if (!r.pass) console.log(`      ${r.error.split("\n").join("\n      ")}`);
	}
	const failed = results.filter((r) => !r.pass).length;
	console.log(`${results.length - failed}/${results.length} scenarios passed`);
	exitCode = failed > 0 ? 1 : 0;
} catch (err) {
	console.error(`\n[e2e] harness error: ${String(err?.message ?? err)}`);
	exitCode = 2;
} finally {
	await cleanup();
	const leaked = [];
	for (const [port] of [[HUB_PORT], [SERVER_PORT], [BROKER_PORT]]) if (await portInUse(port)) leaked.push(port);
	if (leaked.length > 0) {
		console.error(`[e2e] WARNING: ports still busy after cleanup: ${leaked.join(", ")}`);
		exitCode = exitCode || 2;
	}
}
process.exit(exitCode);
