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

/**
 * rm -rf that survives the product's own read-only locks: attachPreviousRun
 * chmods a previous run's step-results directory read-only (D5), so a plain
 * recursive delete of the temp dir fails with EACCES. Restore write access
 * first; a leftover temp dir is a warning, never a reason to change the exit code.
 */
function removeTree(dir) {
	const unlock = (p) => {
		let st;
		try {
			st = fs.lstatSync(p);
		} catch {
			return;
		}
		if (st.isSymbolicLink()) return;
		try {
			fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
		} catch {
			// best effort
		}
		if (st.isDirectory()) for (const name of fs.readdirSync(p)) unlock(path.join(p, name));
	};
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		try {
			unlock(dir);
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (err) {
			console.error(`[e2e] WARNING: could not remove ${dir}: ${String(err?.message ?? err)}`);
		}
	}
}

let cleanedUp = false;
let broker = null;
async function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	for (const entry of [...children].reverse()) await stopProcess(entry).catch(() => {});
	if (broker) await broker.close().catch(() => {});
	if (!KEEP) removeTree(TMP);
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
 *   broker.releaseHeld(hookName)          complete now every job of that hook still being held
 *   broker.jobs                           every job received, in order
 */
function createBroker() {
	const state = {
		jobs: [],
		delayMs: 0,
		hookDelay: new Map(),
		failHooks: new Set(),
		timers: new Map(), // jobId → timeout, so /abort can cancel
		finishers: new Map(), // jobId → { hook, finish }, so a held job can be released early
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
			state.finishers.delete(body.jobId);
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
				state.finishers.delete(body.jobId);
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
			if (delay > 0) {
				state.timers.set(body.jobId, setTimeout(() => void finish(), delay));
				state.finishers.set(body.jobId, { hook: name, finish });
			} else await finish();
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
		async releaseHeld(hook) {
			for (const [jobId, held] of [...state.finishers]) {
				if (held.hook !== hook) continue;
				clearTimeout(state.timers.get(jobId));
				await held.finish();
			}
		},
		listen: () =>
			new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(BROKER_PORT, "127.0.0.1", resolve);
			}),
		close: () =>
			new Promise((resolve) => {
				for (const t of state.timers.values()) clearTimeout(t);
				state.finishers.clear();
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
		// Right after boot every linked hub reads read-only until its first heartbeat.
		await waitForLiveOwner();
	},
	/**
	 * Simulated downtime: stop the hub, let `fn` rewrite the throwaway DB
	 * (`fn(db)`), start the hub again. The boot scheduler tick then sees whatever
	 * `fn` left behind, exactly as after a suspended laptop or a crash.
	 */
	async whileStopped(fn) {
		await this.stop();
		const db = this.db();
		try {
			await fn(db);
		} finally {
			db.close();
		}
		this.spawn();
		await waitFor("the hub to answer /health after downtime", async () => (await httpJson("GET", `${HUB_URL}/health`)).ok, {
			timeoutMs: 30_000,
		});
		await waitForLiveOwner();
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


// --- time + schedule helpers (all schedules here use UTC, so "tomorrow" is exactly +24h) ---

const DAY_MS = 86_400_000;
const pad2 = (n) => String(n).padStart(2, "0");
/** "YYYY-MM-DD HH:mm" in UTC — the name suffix cloneScheduledInstance renders for a UTC schedule. */
const fmtUtc = (d) =>
	`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
const hhmmUtc = (d) => `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
const atUtc = (d) => `${fmtUtc(d).replace(" ", "T")}`;

/** The next minute boundary at least `minMs` from now, plus `extraMinutes` — a real fire time a minute or two ahead. */
function minuteAhead(minMs, extraMinutes = 0) {
	const t = Math.ceil((Date.now() + minMs) / 60_000) * 60_000 + extraMinutes * 60_000;
	return new Date(t);
}

/** A daily UTC spec whose LAST occurrence was `minutesAgo` minutes ago, so its next one is ~24h away. */
const dailyJustPassed = (minutesAgo) => ({ kind: "daily", time: hhmmUtc(new Date(Date.now() - minutesAgo * 60_000)) });

/** Make `workflowId` a one-day-late, in-grace armed instance: move its next run back by exactly 24h (inside a stopped-hub window). */
function makeDue(db, workflowId) {
	const row = db.prepare("SELECT next_run_at FROM workflows WHERE id = ?").get(workflowId);
	if (!row?.next_run_at) throw new Error(`${workflowId} has no next_run_at to rewind`);
	const due = new Date(Date.parse(row.next_run_at) - DAY_MS).toISOString();
	db.prepare("UPDATE workflows SET next_run_at = ?, scheduled_for = ? WHERE id = ?").run(due, due, workflowId);
	return due;
}

async function setSchedule(id, spec, extra = {}) {
	const r = await hub.api("PUT", `/api/workflows/${id}/schedule`, { spec, timezone: "UTC", ...extra });
	check(r.ok, `PUT schedule answered ${r.status} ${r.text}`);
	return r.json.workflow;
}

/** The series' instances as the hub reports them (oldest first). */
async function seriesInstances(workflowId) {
	const r = await hub.api("GET", `/api/workflows/${workflowId}/schedule`);
	check(r.ok, `GET schedule answered ${r.status} ${r.text}`);
	return r.json.instances;
}

async function noticesFor(seriesId) {
	const r = await hub.api("GET", `/api/schedule-notices?seriesId=${encodeURIComponent(seriesId)}`);
	check(r.ok, `GET schedule-notices answered ${r.status} ${r.text}`);
	return r.json.notices ?? r.json;
}

async function runToCompletion(w, steps, want = "completed") {
	const started = await hub.api("POST", `/api/workflows/${w.id}/start`, { stepIds: steps.map((s) => s.id) });
	check(started.ok, `start answered ${started.status} ${started.text}`);
	return await waitForStatus(w.id, want, 60_000);
}

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

	{
		id: "S1",
		title: "local daily series fires on time; next instance is named and armed; 2nd fire carries the previous-run block",
		async run(c) {
			const CONTEXT = "S1 background: the team wants a short daily digest.";
			const fireAt = minuteAhead(45_000, 1); // 1–2 minutes from now
			const { workflow: w1, steps } = await c.createWorkflow("S1 daily series", [
				{ description: "Write the digest." },
				{ description: "Post the digest." },
			]);
			const ctxSet = await c.hub.api("PATCH", `/api/workflows/${w1.id}/context`, { conversationContext: CONTEXT });
			c.check(ctxSet.ok, `set context answered ${ctxSet.status} ${ctxSet.text}`);
			const armed1 = await setSchedule(w1.id, { kind: "daily", time: hhmmUtc(fireAt) });
			c.checkEq(armed1.schedule.state, "armed", "first instance state after PUT schedule");
			c.checkEq(armed1.nextRunAt, fireAt.toISOString(), "first next_run_at");
			c.log(`S1: first fire due at ${fireAt.toISOString()}`);

			// Real fire: wait for the scheduler tick (≤30s after the due time).
			const first = await c.waitFor(
				"the first instance to fire and complete",
				async () => {
					const d = await c.getWorkflow(w1.id);
					return d.workflow.schedule?.state === "fired" && d.workflow.status === "completed" ? d : null;
				},
				{ timeoutMs: 200_000, intervalMs: 2_000 },
			);
			const seriesId = first.workflow.schedule.seriesId;
			const instances = await c.waitFor(
				"the next armed instance to exist",
				async () => {
					const list = await seriesInstances(w1.id);
					return list.length === 2 && list.some((i) => i.scheduleState === "armed") ? list : null;
				},
				{ timeoutMs: 15_000 },
			);
			const armed2 = instances.find((i) => i.scheduleState === "armed");
			const nextDue = new Date(fireAt.getTime() + DAY_MS);
			c.checkEq(armed2.name, `S1 daily series · ${fmtUtc(nextDue)}`, "armed instance name");
			const armed2Detail = await c.getWorkflow(armed2.id);
			c.checkEq(armed2Detail.workflow.nextRunAt, nextDue.toISOString(), "armed instance next_run_at (tomorrow)");
			c.checkEq(armed2Detail.workflow.conversationContext, CONTEXT, "clone keeps conversation_context");
			c.checkEq(armed2Detail.workflow.schedule.seriesId, seriesId, "clone shares the series id");
			c.check(!c.broker.jobs.some((j) => j.hook === w1.agentName && j.input.includes("Previous run of this schedule")), "the FIRST run has no previous-run block");

			// Second fire: a day later, simulated as "the tick finds it due" after downtime.
			await c.hub.whileStopped((db) => makeDue(db, armed2.id));
			const second = await c.waitFor(
				"the second instance to fire and complete",
				async () => {
					const d = await c.getWorkflow(armed2.id);
					return d.workflow.schedule?.state === "fired" && d.workflow.status === "completed" ? d : null;
				},
				{ timeoutMs: 90_000, intervalMs: 2_000 },
			);
			const block = second.workflow.schedule.previousRunBlock;
			c.check(typeof block === "string" && block.length > 0, "second instance stores a previous-run block");
			c.check(block.includes(`id ${w1.id}`), `block names the previous instance id (got: ${block})`);
			c.check(block.includes("Final status: completed"), "block carries the previous final status");
			c.check(
				block.includes(path.join(DIRS.hubHome, "steps", first.workflow.agentName)),
				`block carries the absolute step-results path (got: ${block})`,
			);
			c.checkEq(second.workflow.conversationContext, CONTEXT, "conversation_context unchanged on the 2nd fire");
			c.check(!second.workflow.conversationContext.includes("Previous run of this schedule"), "block is stored apart from conversation_context");
			const ctxJob = c.broker.jobs.find(
				(j) => j.hook === second.workflow.agentName && j.input.includes("Previous run of this schedule"),
			);
			c.check(ctxJob, "the context step sent to the agent carries the previous-run block");
			c.check(ctxJob.input.includes(CONTEXT), "…together with the unchanged conversation context");
			// Third instance: armed again, block NOT accumulated.
			const third = (await seriesInstances(w1.id)).find((i) => i.scheduleState === "armed");
			c.check(third && third.id !== armed2.id, "a third instance is armed after the 2nd fire");
			const thirdDetail = await c.getWorkflow(third.id);
			c.checkEq(thirdDetail.workflow.schedule.previousRunBlock, null, "new clone starts without a previous-run block");
			c.checkEq(thirdDetail.workflow.conversationContext, CONTEXT, "conversation_context still unchanged on the clone");
			c.checkEq((await seriesInstances(w1.id)).length, 3, "exactly three instances after two fires");
		},
	},
	{
		id: "S2",
		title: "start / resume / restart / step run on an armed instance answer 409 scheduled_armed",
		async run(c) {
			const { workflow: w, steps } = await c.createWorkflow("S2 armed guard", [
				{ description: "Only step." },
			]);
			await setSchedule(w.id, { kind: "daily", time: hhmmUtc(new Date(Date.now() + 2 * 3_600_000)) });
			const ids = steps.map((s) => s.id);
			const attempts = [
				["start", "POST", `/api/workflows/${w.id}/start`, { stepIds: ids }],
				["resume", "POST", `/api/workflows/${w.id}/resume`, { stepIds: ids }],
				["restart", "POST", `/api/workflows/${w.id}/restart`, { stepIds: ids }],
				["step run", "POST", `/api/workflows/${w.id}/steps/${ids[0]}/run`, {}],
			];
			for (const [what, method, url, body] of attempts) {
				const r = await c.hub.api(method, url, body);
				c.checkEq(r.status, 409, `${what} status (body ${r.text})`);
				c.checkEq(r.json?.error, "scheduled_armed", `${what} error code`);
			}
			c.checkEq(c.broker.jobs.filter((j) => j.hook === w.agentName).length, 0, "no job reached the broker");
			const after = await c.getWorkflow(w.id);
			c.checkEq(after.workflow.schedule.state, "armed", "instance is still armed");
			c.checkEq(after.workflow.status, "draft", "instance did not start");
			// …but the armed instance IS editable (edits carry into future runs).
			const added = await c.hub.api("POST", `/api/workflows/${w.id}/steps`, { description: "Added while armed." });
			c.check(added.ok, `adding a step to an armed instance answered ${added.status} ${added.text}`);
			const ctx = await c.hub.api("PATCH", `/api/workflows/${w.id}/context`, { conversationContext: "edited while armed" });
			c.check(ctx.ok, `editing context of an armed instance answered ${ctx.status} ${ctx.text}`);
		},
	},
	{
		id: "S3",
		title: "missed recurring: 2 missed occurrences → one notice, no extra workflows, series re-armed in the future",
		async run(c) {
			const { workflow: w } = await c.createWorkflow("S3 missed recurring", [{ description: "Nightly job." }]);
			// Next occurrence is ~2h ahead; rewinding it two days leaves exactly two passed slots (F-2d, F-1d), both >10 min late.
			const armed = await setSchedule(w.id, { kind: "daily", time: hhmmUtc(new Date(Date.now() + 2 * 3_600_000)) });
			const seriesId = armed.schedule.seriesId;
			const future = armed.nextRunAt;
			const totalBefore = (await c.hub.api("GET", "/api/workflows?archived=include")).json.workflows.length;
			const rewound = new Date(Date.parse(future) - 2 * DAY_MS).toISOString();
			await c.hub.whileStopped((db) =>
				db.prepare("UPDATE workflows SET next_run_at = ?, scheduled_for = ? WHERE id = ?").run(rewound, rewound, w.id),
			);
			const notice = await c.waitFor(
				"a missed notice",
				async () => (await noticesFor(seriesId)).find((n) => n.kind === "missed"),
				{ timeoutMs: 60_000, intervalMs: 1_000 },
			);
			c.checkEq(notice.reason, "offline", "notice reason");
			c.checkEq(notice.detail.count, 2, "missed occurrence count");
			c.checkEq(notice.detail.occurrences.length, 2, "listed occurrences");
			c.check(/2 runs missed/.test(notice.detail.message), `notice message says "2 runs missed" (got: ${notice.detail.message})`);
			c.check(notice.detail.message.includes("because the hub was offline"), "notice message gives the reason");
			c.check(notice.detail.message.includes("next:"), "notice message names the next run");
			const after = await c.getWorkflow(w.id);
			c.checkEq(after.workflow.schedule.state, "armed", "series re-armed");
			c.checkEq(after.workflow.nextRunAt, future, "re-armed at the next FUTURE occurrence");
			c.check(Date.parse(after.workflow.nextRunAt) > Date.now(), "next run is in the future");
			c.checkEq((await seriesInstances(w.id)).length, 1, "no extra instances in the series");
			const totalAfter = (await c.hub.api("GET", "/api/workflows?archived=include")).json.workflows.length;
			c.checkEq(totalAfter, totalBefore, "no extra workflows were created");
			c.checkEq(c.broker.jobs.filter((j) => j.hook === w.agentName).length, 0, "nothing ran");
		},
	},
	{
		id: "S4",
		title: "missed once → state missed + notice → run-now fires it",
		async run(c) {
			const { workflow: w } = await c.createWorkflow("S4 missed once", [{ description: "One-off job." }]);
			const armed = await setSchedule(w.id, { kind: "once", at: atUtc(new Date(Date.now() + 30 * 60_000)) });
			const seriesId = armed.schedule.seriesId;
			const past = new Date(Date.now() - 3_600_000).toISOString();
			await c.hub.whileStopped((db) =>
				db.prepare("UPDATE workflows SET next_run_at = ?, scheduled_for = ? WHERE id = ?").run(past, past, w.id),
			);
			const missed = await c.waitFor(
				"the once to become missed",
				async () => {
					const d = await c.getWorkflow(w.id);
					return d.workflow.schedule?.state === "missed" ? d : null;
				},
				{ timeoutMs: 60_000, intervalMs: 1_000 },
			);
			c.checkEq(missed.workflow.nextRunAt, null, "a missed once has no next run");
			c.checkEq(missed.workflow.status, "draft", "a missed once did not run");
			const notice = (await noticesFor(seriesId)).find((n) => n.kind === "missed");
			c.check(notice, "a missed notice was recorded");
			c.check(notice.detail.message.includes("was missed because the hub was offline"), `notice message (got: ${notice.detail.message})`);
			c.checkEq(c.broker.jobs.filter((j) => j.hook === w.agentName).length, 0, "nothing ran while missed");

			const runNow = await c.hub.api("POST", `/api/workflows/${w.id}/schedule/run-now`, {});
			c.check(runNow.ok, `run-now answered ${runNow.status} ${runNow.text}`);
			const done = await c.waitForStatus(w.id, ["completed", "failed"], 60_000);
			c.checkEq(done.workflow.status, "completed", "run-now workflow status");
			c.checkEq(done.workflow.schedule.state, "fired", "state after run-now");
			const again = await c.hub.api("POST", `/api/workflows/${w.id}/schedule/run-now`, {});
			c.checkEq(again.status, 409, "a second run-now is refused");
			c.checkEq(again.json?.error, "not_missed", "second run-now error code");
		},
	},
	{
		id: "S5",
		title: "overlap: previous instance still running when the next is due → skipped + notice + re-armed",
		async run(c) {
			const { workflow: w1, steps } = await c.createWorkflow("S5 overlap", [{ description: "Slow job." }]);
			const armed1 = await setSchedule(w1.id, dailyJustPassed(2));
			const seriesId = armed1.schedule.seriesId;
			// The broker holds W1's job, so W1 is still running when W2 comes due.
			c.broker.delayFor(w1.agentName, 10 * 60_000);
			try {
				await c.hub.whileStopped((db) => makeDue(db, w1.id));
				const running = await c.waitFor(
					"W1 to fire and be running with W2 armed",
					async () => {
						const list = await seriesInstances(w1.id);
						const d = await c.getWorkflow(w1.id);
						return list.length === 2 && d.workflow.schedule.state === "fired" && d.workflow.status === "running" ? list : null;
					},
					{ timeoutMs: 90_000, intervalMs: 2_000 },
				);
				const w2 = running.find((i) => i.scheduleState === "armed");
				await c.hub.whileStopped((db) => makeDue(db, w2.id));
				const notice = await c.waitFor(
					"a skipped notice",
					async () => (await noticesFor(seriesId)).find((n) => n.kind === "skipped"),
					{ timeoutMs: 90_000, intervalMs: 1_000 },
				);
				c.checkEq(notice.reason, "busy", "skip reason");
				c.checkEq(notice.detail.busyInstanceId, w1.id, "notice names the busy instance");
				c.check(notice.detail.message.includes("still in progress"), `notice message (got: ${notice.detail.message})`);
				const w2After = await c.getWorkflow(w2.id);
				c.checkEq(w2After.workflow.schedule.state, "armed", "the skipped instance is re-armed");
				c.check(Date.parse(w2After.workflow.nextRunAt) > Date.now(), "re-armed in the future");
				c.checkEq(w2After.workflow.status, "draft", "the skipped run did not start");
				c.checkEq(c.broker.jobs.filter((j) => j.hook === w2After.workflow.agentName).length, 0, "no job for the skipped instance");
				c.checkEq((await seriesInstances(w1.id)).length, 2, "no junk instance was created for the skipped run");
				c.checkEq((await c.getWorkflow(w1.id)).workflow.status, "running", "the long run is undisturbed");
			} finally {
				c.broker.delayFor(w1.agentName, 0);
				await c.broker.releaseHeld(w1.agentName);
			}
			const done = await c.waitForStatus(w1.id, ["completed", "failed"], 60_000);
			c.checkEq(done.workflow.status, "completed", "the long run finishes once released");
		},
	},
	{
		id: "S6",
		title: "auto-archive: archive_after_days=1 archives old completed/failed only; armed/running/draft/fresh stay; list excludes archived",
		async run(c) {
			const setDays = (n) => c.hub.api("PUT", "/api/settings/archive", { archive_after_days: n });
			c.check((await setDays(1)).ok, "set archive_after_days=1");
			let holdHook = null;
			try {
				const one = (name) => c.createWorkflow(name, [{ description: `${name} step.` }]);
				const A = await one("S6 old completed");
				const B = await one("S6 old failed");
				const C = await one("S6 old running");
				const D = await one("S6 old armed");
				const E = await one("S6 fresh completed");
				const G = await one("S6 old draft");
				await runToCompletion(A.workflow, A.steps);
				c.broker.failNext(B.workflow.agentName);
				await runToCompletion(B.workflow, B.steps, "failed");
				await runToCompletion(E.workflow, E.steps);
				holdHook = C.workflow.agentName;
				c.broker.delayFor(holdHook, 10 * 60_000);
				c.check((await c.hub.api("POST", `/api/workflows/${C.workflow.id}/start`, { stepIds: C.steps.map((s) => s.id) })).ok, "start C");
				await c.waitForStatus(C.workflow.id, "running", 30_000);
				await setSchedule(D.workflow.id, { kind: "daily", time: hhmmUtc(new Date(Date.now() + 2 * 3_600_000)) });

				const old = new Date(Date.now() - 3 * DAY_MS).toISOString();
				await c.hub.whileStopped((db) => {
					for (const x of [A, B, C, D, G]) db.prepare("UPDATE workflows SET updated_at = ? WHERE id = ?").run(old, x.workflow.id);
					for (const x of [A, B]) db.prepare("UPDATE steps SET finished_at = ? WHERE workflow_id = ?").run(old, x.workflow.id);
				});
				// The daemon sweep runs every 60s (not at boot).
				await c.waitFor(
					"the sweep to archive the old completed and failed workflows",
					async () => {
						const r = await c.hub.api("GET", "/api/workflows?archived=only");
						const ids = new Set(r.json.workflows.map((w) => w.id));
						return ids.has(A.workflow.id) && ids.has(B.workflow.id) ? ids : null;
					},
					{ timeoutMs: 120_000, intervalMs: 2_000 },
				);
				const state = async (x) => (await c.getWorkflow(x.workflow.id)).workflow;
				c.check((await state(A)).archivedAt, "old completed is archived");
				c.checkEq((await state(A)).status, "completed", "archived keeps its completed outcome");
				c.check((await state(B)).archivedAt, "old failed is archived");
				c.checkEq((await state(B)).status, "failed", "archived keeps its failed outcome");
				for (const [label, x] of [["running", C], ["armed", D], ["fresh completed", E], ["draft", G]]) {
					c.checkEq((await state(x)).archivedAt, null, `${label} is not archived`);
				}
				c.checkEq((await state(C)).status, "running", "the running one is still running");
				c.checkEq((await state(D)).schedule.state, "armed", "the armed one is still armed");

				const def = (await c.hub.api("GET", "/api/workflows")).json.workflows.map((w) => w.id);
				c.check(!def.includes(A.workflow.id) && !def.includes(B.workflow.id), "GET /api/workflows excludes archived by default");
				for (const x of [C, D, E, G]) c.check(def.includes(x.workflow.id), `default list still has ${x.workflow.name}`);
				const all = (await c.hub.api("GET", "/api/workflows?archived=include")).json.workflows.map((w) => w.id);
				c.check(all.includes(A.workflow.id) && all.includes(C.workflow.id), "?archived=include lists both");
				const only = (await c.hub.api("GET", "/api/workflows?archived=only")).json.workflows.map((w) => w.id);
				c.check(!only.includes(C.workflow.id) && !only.includes(E.workflow.id), "?archived=only lists archived ones only");
				c.checkEq((await c.hub.api("GET", "/api/workflows?archived=bogus")).status, 400, "bad archived filter");
			} finally {
				if (holdHook) {
					c.broker.delayFor(holdHook, 0);
					await c.broker.releaseHeld(holdHook);
				}
				await setDays(30); // the product default, so later scenarios are unaffected
			}
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
