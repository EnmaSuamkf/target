#!/usr/bin/env node
/**
 * Failure recovery — QA API cases C1–C12 (workflow "Failure recovery 1/2 · target").
 *
 * Runs against the THROWAWAY stack started by the `target-qa-stack` pipeline,
 * which exports:
 *   QA_BASE_URL    throwaway hub, http://127.0.0.1:8993
 *   QA_HUB_CONFIG  that hub's config.json (its adminToken)
 *   QA_AWB_URL     throwaway awb broker, http://127.0.0.1:8994
 *   QA_HOME        /tmp/target-qa-8993 (target/, awb/, work/)
 *   QA_TARGET_DIR  the Target repository
 *
 * Safety: refuses to run (exit 2) unless the hub is 127.0.0.1 on a port other
 * than 8893 (and the broker not 8890); never reads ~/.target/config.json; never
 * writes under the real HOME (workflows live under $QA_HOME/work, the skills
 * sync and the MCP child get HOME=$QA_HOME/home).
 *
 * Output: one line per case, `PASS Cn <title>` or `FAIL Cn <title>: <reason>`,
 * and full details in QA/failure-recovery/api-results.json next to this file.
 * Exit 0 only when every case passed.
 *
 * Plain Node ≥ 24, built-ins only. Each run works on a freshly restarted stack.
 */
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = path.join(SCRIPT_DIR, "api-results.json");

// --------------------------------------------------------------------------------
// Guard: the throwaway stack, or nothing.

function refuse(message) {
	process.stderr.write(`refusing to run: ${message}\n`);
	process.exit(2);
}

const BASE_URL = (process.env.QA_BASE_URL ?? "").replace(/\/+$/, "");
const HUB_CONFIG = process.env.QA_HUB_CONFIG ?? "";
const AWB_URL = (process.env.QA_AWB_URL ?? "").replace(/\/+$/, "");
const QA_HOME = process.env.QA_HOME ?? "";
const TARGET_DIR = process.env.QA_TARGET_DIR ?? path.resolve(SCRIPT_DIR, "..", "..");

{
	let hubUrl;
	try {
		hubUrl = new URL(BASE_URL);
	} catch {
		refuse(`QA_BASE_URL is not a URL (${JSON.stringify(BASE_URL)})`);
	}
	if (hubUrl.protocol !== "http:" || hubUrl.hostname !== "127.0.0.1") refuse(`QA_BASE_URL must be http://127.0.0.1:<port> (got ${BASE_URL})`);
	if (hubUrl.port === "" || hubUrl.port === "8893") refuse("QA_BASE_URL must not be the live hub (port 8893)");
	if (AWB_URL) {
		let awb;
		try {
			awb = new URL(AWB_URL);
		} catch {
			refuse(`QA_AWB_URL is not a URL (${JSON.stringify(AWB_URL)})`);
		}
		if (awb.hostname !== "127.0.0.1" || awb.port === "8890") refuse("QA_AWB_URL must be a throwaway broker on 127.0.0.1, not 8890");
	}
	if (!HUB_CONFIG) refuse("QA_HUB_CONFIG is not set");
	const liveConfig = path.join(os.homedir(), ".target", "config.json");
	if (path.resolve(HUB_CONFIG) === path.resolve(liveConfig)) refuse("QA_HUB_CONFIG points at the live ~/.target/config.json");
	if (!QA_HOME || !path.isAbsolute(QA_HOME)) refuse("QA_HOME must be an absolute path");
	const home = path.resolve(os.homedir());
	const qaHome = path.resolve(QA_HOME);
	if (qaHome === home || qaHome.startsWith(`${home}${path.sep}`)) refuse(`QA_HOME (${qaHome}) must not be inside the real HOME`);
	if (!fs.existsSync(HUB_CONFIG)) refuse(`QA_HUB_CONFIG ${HUB_CONFIG} does not exist`);
}

const ADMIN_TOKEN = (() => {
	try {
		const token = JSON.parse(fs.readFileSync(HUB_CONFIG, "utf8")).adminToken;
		if (typeof token !== "string" || token === "") refuse(`no adminToken in ${HUB_CONFIG}`);
		return token;
	} catch (err) {
		refuse(`cannot read ${HUB_CONFIG}: ${String(err)}`);
	}
})();

const WORK_DIR = path.join(QA_HOME, "work");
const QA_USER_HOME = path.join(QA_HOME, "home");
const AWB_HOME = path.join(QA_HOME, "awb");
const HOOKS_FILE = path.join(AWB_HOME, "hooks.json");
const AWB_DB = path.join(AWB_HOME, "events.db");
const HUB_LOG = `/tmp/target-serve/${new URL(BASE_URL).port}.log`;
const CAPTURE_PORT = 8995;
const CAPTURE_URL = `http://127.0.0.1:${CAPTURE_PORT}/ingest`;

/** Real-agent scenario budget (per scenario). */
const SCENARIO_TIMEOUT_MS = 8 * 60_000;
const POLL_MS = 1_500;

// The step of the context's QA case list. The hub's step prompt tells the agent
// to "aim explicitly to meet" the acceptance criterion, so with the context's
// description alone haiku wrote "goodbye" and the judge ACCEPTED the first
// attempt (first QA run: C3 and C6 completed, no recovery ever started). The
// scenario needs that first attempt to be rejected, so the description keeps the
// context's sentence verbatim and adds an explicit instruction to really write
// hello; the criterion is unchanged. Nothing else about the cases changes.
const CONTEXT_STEP_DESCRIPTION = "Write the word hello into the file out.txt in the working directory";
const STEP_DESCRIPTION = `${CONTEXT_STEP_DESCRIPTION}. Write exactly the single word hello and nothing else: never write goodbye, even though the acceptance criterion below asks for goodbye.`;
const STEP_CRITERIA = "out.txt contains exactly the word goodbye";

function readOutTxt(workdir) {
	try {
		return fs.readFileSync(path.join(workdir, "out.txt"), "utf8");
	} catch {
		return null;
	}
}

/** A clear reason when the premise of a real-agent case (the judge rejects the first attempt) did not hold. */
function checkFirstAttemptRejected(ctx, watched) {
	const recoveredOrFailed = watched.transitions.some((t) => t.workflow === "recovering" || t.workflow === "failed");
	check(
		recoveredOrFailed || watched.last?.workflow?.status !== "completed",
		`the judge accepted the first attempt (out.txt: ${JSON.stringify(ctx.details.outTxt)}), so the step never failed`,
	);
}

// --------------------------------------------------------------------------------
// Small helpers.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();

class CaseFailure extends Error {}
function check(condition, message) {
	if (!condition) throw new CaseFailure(message);
}

function truncate(value, max = 4000) {
	if (value === undefined) return undefined;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined) return undefined;
	return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : value;
}

function workdirFor(caseId) {
	const dir = path.join(WORK_DIR, caseId.toLowerCase());
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Context of one case: its request log and free-form details. */
function newContext(id) {
	return { id, requests: [], details: {} };
}

/**
 * One HTTP call to the throwaway hub, logged on the case context.
 * `token`: undefined = admin token, null = no Authorization header, string = that bearer.
 */
async function api(ctx, method, urlPath, body, { token, log = true } = {}) {
	const headers = { accept: "application/json" };
	if (body !== undefined) headers["content-type"] = "application/json";
	const bearer = token === undefined ? ADMIN_TOKEN : token;
	if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
	const started = Date.now();
	let status = 0;
	let json = null;
	let text = "";
	try {
		const res = await fetch(`${BASE_URL}${urlPath}`, {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(60_000),
		});
		status = res.status;
		text = await res.text();
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
	} catch (err) {
		text = `transport error: ${String(err)}`;
	}
	if (log && ctx) {
		ctx.requests.push({
			at: iso(),
			method,
			path: urlPath,
			auth: bearer === null ? "none" : bearer === ADMIN_TOKEN ? "admin" : "bearer",
			body: truncate(body),
			status,
			response: truncate(json ?? text),
			ms: Date.now() - started,
		});
	}
	return { status, json, text };
}

function expectStatus(res, expected, what) {
	const list = Array.isArray(expected) ? expected : [expected];
	check(list.includes(res.status), `${what}: expected HTTP ${list.join("/")}, got ${res.status} ${truncate(res.json ?? res.text, 300)}`);
	return res.json;
}

async function createWorkflow(ctx, body) {
	const res = await api(ctx, "POST", "/api/workflows", body);
	const json = expectStatus(res, [200, 201], `create workflow ${body.name}`);
	check(json?.workflow?.id, `create workflow ${body.name}: no workflow in the answer`);
	return json.workflow;
}

async function addStep(ctx, workflowId, body) {
	const res = await api(ctx, "POST", `/api/workflows/${workflowId}/steps`, body);
	const json = expectStatus(res, [200, 201], `add step to ${workflowId}`);
	check(json?.step?.id, "add step: no step in the answer");
	return json.step;
}

async function getWorkflow(ctx, workflowId, options = {}) {
	const res = await api(ctx, "GET", `/api/workflows/${workflowId}`, undefined, options);
	const json = expectStatus(res, 200, `read workflow ${workflowId}`);
	return { workflow: json.workflow, steps: (json.steps ?? []).filter((s) => s.kind !== "context") };
}

async function getStep(ctx, workflowId, stepId) {
	const { steps } = await getWorkflow(ctx, workflowId);
	const step = steps.find((s) => s.id === stepId);
	check(step, `step ${stepId} not found in workflow ${workflowId}`);
	return step;
}

async function recoveries(ctx, workflowId) {
	const res = await api(ctx, "GET", `/api/workflows/${workflowId}/recoveries`);
	return expectStatus(res, 200, "recovery history").recoveries ?? [];
}

function readHooks() {
	return JSON.parse(fs.readFileSync(HOOKS_FILE, "utf8")).hooks ?? {};
}

/** Jobs the throwaway broker received for `hook` (its events.db), oldest first. */
function brokerJobs(hook) {
	if (!fs.existsSync(AWB_DB)) return [];
	let db;
	try {
		db = new DatabaseSync(AWB_DB, { readOnly: true });
		const rows = db.prepare("SELECT id, hook, headers, body, received_at FROM events WHERE hook = ? ORDER BY id").all(hook);
		return rows.map((r) => {
			let headers = {};
			let body = {};
			try {
				headers = JSON.parse(String(r.headers));
			} catch {}
			try {
				body = JSON.parse(String(r.body));
			} catch {
				body = { raw: String(r.body) };
			}
			return { id: Number(r.id), hook: String(r.hook), headers, body, receivedAt: String(r.received_at) };
		});
	} catch (err) {
		return [{ error: String(err) }];
	} finally {
		db?.close();
	}
}

function jobInput(job) {
	if (!job || !job.body) return "";
	if (typeof job.body.input === "string") return job.body.input;
	return JSON.stringify(job.body);
}

function hubLogLines(pattern) {
	try {
		return fs
			.readFileSync(HUB_LOG, "utf8")
			.split("\n")
			.filter((line) => pattern.test(line));
	} catch {
		return [];
	}
}

// --------------------------------------------------------------------------------
// Report capture (C11): a local ingest on 127.0.0.1:8995. Reporting is pointed at
// it BEFORE any QA workflow exists, so every event of every case is captured.

const capture = { server: null, envelopes: [], error: null, settingsResponse: null };

async function startCapture() {
	capture.server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			try {
				const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
				capture.envelopes.push({ receivedAt: iso(), path: req.url, authorization: Boolean(req.headers.authorization), envelope });
			} catch (err) {
				capture.envelopes.push({ receivedAt: iso(), path: req.url, unparsable: String(err) });
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise((resolve, reject) => {
		capture.server.once("error", reject);
		capture.server.listen(CAPTURE_PORT, "127.0.0.1", resolve);
	});
}

function capturedEvents(workflowId, kind) {
	const out = [];
	for (const item of capture.envelopes) {
		for (const event of item.envelope?.events ?? []) {
			if (workflowId && event.workflow_id !== workflowId) continue;
			if (kind && event.kind !== kind) continue;
			out.push(event);
		}
	}
	return out;
}

async function waitFor(predicate, timeoutMs, intervalMs = 1_000) {
	const started = Date.now();
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() - started > timeoutMs) return null;
		await sleep(intervalMs);
	}
}

// --------------------------------------------------------------------------------
// Real-agent scenarios: start, poll until settled, record every transition.

function snapshotKey(workflow, steps) {
	return JSON.stringify([
		workflow.status,
		workflow.recovery?.status ?? null,
		steps.map((s) => [s.status, s.phase, s.retryCount, s.recoveryCount, s.sessionId, s.description, s.acceptanceCriteria]),
	]);
}

function settled(workflow, steps) {
	if (workflow.status !== "completed" && workflow.status !== "failed") return false;
	if (workflow.recovery) return false;
	return !steps.some((s) => s.status === "running" || s.status === "queued");
}

/** Polls a workflow until it settles (completed / failed, nothing in flight) or the budget runs out. */
async function watchWorkflow(ctx, workflowId, timeoutMs = SCENARIO_TIMEOUT_MS) {
	const started = Date.now();
	const transitions = [];
	let lastKey = "";
	let last = null;
	while (Date.now() - started < timeoutMs) {
		const res = await api(ctx, "GET", `/api/workflows/${workflowId}`, undefined, { log: false });
		if (res.status === 200 && res.json?.workflow) {
			const workflow = res.json.workflow;
			const steps = (res.json.steps ?? []).filter((s) => s.kind !== "context");
			last = { workflow, steps };
			const key = snapshotKey(workflow, steps);
			if (key !== lastKey) {
				lastKey = key;
				transitions.push({
					tMs: Date.now() - started,
					at: iso(),
					workflow: workflow.status,
					recovery: workflow.recovery ? { id: workflow.recovery.id, status: workflow.recovery.status } : null,
					steps: steps.map((s) => ({
						id: s.id,
						status: s.status,
						phase: s.phase,
						retryCount: s.retryCount,
						recoveryCount: s.recoveryCount,
						sessionId: s.sessionId,
						description: s.description,
						acceptanceCriteria: s.acceptanceCriteria,
					})),
				});
			}
			if (settled(workflow, steps)) return { done: true, elapsedMs: Date.now() - started, last, transitions };
		}
		await sleep(POLL_MS);
	}
	return { done: false, elapsedMs: Date.now() - started, last, transitions };
}

const statusesSeen = (transitions) => [...new Set(transitions.map((t) => t.workflow))];

/** Creates the C3/C4/C6 shape: one judged agent step, maxRetries 0. */
async function realAgentWorkflow(ctx, caseId, { recoverOnFailure, maxRecoveries, bypass }) {
	const workdir = workdirFor(caseId);
	const workflow = await createWorkflow(ctx, {
		name: `QA-${caseId.toLowerCase()}`,
		workdir,
		runner: "claude",
		model: "haiku",
		recoveryModel: "sonnet",
		...(bypass ? { permissionMode: "bypassPermissions", acceptBypassRisk: true } : {}),
	});
	const step = await addStep(ctx, workflow.id, {
		description: STEP_DESCRIPTION,
		acceptanceCriteria: STEP_CRITERIA,
		maxRetries: 0,
		retryIntervalSeconds: 0,
		useSubagent: false,
		recoverOnFailure,
		...(maxRecoveries !== undefined ? { maxRecoveries } : {}),
	});
	ctx.details.workflowId = workflow.id;
	ctx.details.agentName = workflow.agentName;
	ctx.details.stepId = step.id;
	ctx.details.workdir = workdir;
	ctx.details.created = { workflow: { model: workflow.model, recoveryModel: workflow.recoveryModel, permissionMode: workflow.permissionMode }, step };
	return { workflow, step, workdir };
}

async function startAndWatch(ctx, workflowId, stepId) {
	const start = await api(ctx, "POST", `/api/workflows/${workflowId}/start`, { stepIds: [stepId] });
	expectStatus(start, 200, "start");
	const watched = await watchWorkflow(ctx, workflowId);
	return watched;
}

// --------------------------------------------------------------------------------
// Cases.

const shared = {};

async function caseC1(ctx) {
	const workflow = await createWorkflow(ctx, { name: "QA-c1", workdir: workdirFor("C1"), runner: "claude", model: "haiku" });
	ctx.details.workflowId = workflow.id;

	const on = await addStep(ctx, workflow.id, { description: "QA-c1 step with recovery", acceptanceCriteria: "nothing to check", recoverOnFailure: true, maxRecoveries: 2 });
	check(on.recoverOnFailure === true && on.maxRecoveries === 2 && on.recoveryCount === 0, `create answer: ${JSON.stringify([on.recoverOnFailure, on.maxRecoveries, on.recoveryCount])}`);
	const onRead = await getStep(ctx, workflow.id, on.id);
	check(onRead.recoverOnFailure === true && onRead.maxRecoveries === 2 && onRead.recoveryCount === 0, `read back: ${JSON.stringify([onRead.recoverOnFailure, onRead.maxRecoveries, onRead.recoveryCount])}`);

	const plain = await addStep(ctx, workflow.id, { description: "QA-c1 step without recovery fields", acceptanceCriteria: "nothing to check" });
	const plainRead = await getStep(ctx, workflow.id, plain.id);
	check(
		plainRead.recoverOnFailure === false && plainRead.maxRecoveries === 1 && plainRead.recoveryCount === 0,
		`defaults: expected false/1/0, got ${JSON.stringify([plainRead.recoverOnFailure, plainRead.maxRecoveries, plainRead.recoveryCount])}`,
	);

	const edit = await api(ctx, "PATCH", `/api/workflows/${workflow.id}/steps/${plain.id}`, { description: plainRead.description, recoverOnFailure: true, maxRecoveries: 3 });
	expectStatus(edit, 200, "edit the fields");
	const edited = await getStep(ctx, workflow.id, plain.id);
	check(edited.recoverOnFailure === true && edited.maxRecoveries === 3, `after edit: ${JSON.stringify([edited.recoverOnFailure, edited.maxRecoveries])}`);
	const keep = await api(ctx, "PATCH", `/api/workflows/${workflow.id}/steps/${plain.id}`, { description: "QA-c1 edited text only" });
	expectStatus(keep, 200, "edit without the fields");
	const kept = await getStep(ctx, workflow.id, plain.id);
	check(kept.recoverOnFailure === true && kept.maxRecoveries === 3, `an edit that omits them must keep them: ${JSON.stringify([kept.recoverOnFailure, kept.maxRecoveries])}`);

	const invalid = [];
	for (const value of [-1, 1.5]) {
		const created = await api(ctx, "POST", `/api/workflows/${workflow.id}/steps`, { description: `QA-c1 invalid ${value}`, maxRecoveries: value });
		const patched = await api(ctx, "PATCH", `/api/workflows/${workflow.id}/steps/${on.id}`, { description: onRead.description, maxRecoveries: value });
		invalid.push({ value, create: created.status, edit: patched.status });
		check(created.status === 400, `create with maxRecoveries ${value}: expected 400, got ${created.status}`);
		check(patched.status === 400, `edit with maxRecoveries ${value}: expected 400, got ${patched.status}`);
	}
	ctx.details.invalid = invalid;
	const after = await getWorkflow(ctx, workflow.id);
	check(after.steps.length === 2, `invalid requests must add nothing (steps: ${after.steps.length})`);
	check(after.steps.find((s) => s.id === on.id).maxRecoveries === 2, "an invalid edit must change nothing");
}

async function caseC2(ctx) {
	const workflow = await createWorkflow(ctx, {
		name: "QA-c2",
		workdir: workdirFor("C2"),
		runner: "claude",
		model: "haiku",
		permissionMode: "bypassPermissions",
		acceptBypassRisk: true,
	});
	ctx.details.workflowId = workflow.id;
	const recoveryHook = `${workflow.agentName}-recovery`;
	ctx.details.recoveryHook = recoveryHook;

	const set = await api(ctx, "PATCH", `/api/workflows/${workflow.id}/recovery-model`, { recoveryModel: "sonnet" });
	expectStatus(set, 200, "set recoveryModel sonnet");
	check(set.json?.workflow?.recoveryModel === "sonnet", `answer recoveryModel: ${set.json?.workflow?.recoveryModel}`);
	const read = await getWorkflow(ctx, workflow.id);
	check(read.workflow.recoveryModel === "sonnet", `stored recoveryModel: ${read.workflow.recoveryModel}`);

	const hooks = readHooks();
	const main = hooks[workflow.agentName];
	const copy = hooks[recoveryHook];
	ctx.details.hooks = { main, recovery: copy };
	check(main, `the workflow's hook ${workflow.agentName} is not in ${HOOKS_FILE}`);
	check(copy, `${recoveryHook} is not in ${HOOKS_FILE}`);
	check(copy.model === "sonnet", `recovery hook model: ${copy.model}`);
	for (const key of ["consumers", "workdir", "permissionMode", "sandbox"]) {
		check(JSON.stringify(copy[key]) === JSON.stringify(main[key]), `recovery hook ${key} ${JSON.stringify(copy[key])} differs from the workflow hook's ${JSON.stringify(main[key])}`);
	}
	check(main.model === "haiku", `the workflow hook keeps its own model (got ${main.model})`);

	const bad = await api(ctx, "PATCH", `/api/workflows/${workflow.id}/recovery-model`, { recoveryModel: "qa-model-not-enabled" });
	check(bad.status === 400, `an id not enabled for the runner: expected 400, got ${bad.status}`);
	check((await getWorkflow(ctx, workflow.id)).workflow.recoveryModel === "sonnet", "a refused id must not change the model");

	const clear = await api(ctx, "PATCH", `/api/workflows/${workflow.id}/recovery-model`, { recoveryModel: null });
	expectStatus(clear, 200, "clear recoveryModel");
	check((await getWorkflow(ctx, workflow.id)).workflow.recoveryModel === null, "recoveryModel null after clearing");
	const cleared = readHooks()[recoveryHook];
	ctx.details.hookAfterClear = cleared;
	check(cleared && !("model" in cleared), `after null the recovery hook has no model (got ${JSON.stringify(cleared?.model)})`);
}

async function caseC3(ctx) {
	const { workflow, step } = await realAgentWorkflow(ctx, "C3", { recoverOnFailure: true, bypass: true });
	const recoveryHook = `${workflow.agentName}-recovery`;
	shared.c3 = { workflowId: workflow.id, stepId: step.id, agentName: workflow.agentName, recoveryHook };
	const watched = await startAndWatch(ctx, workflow.id, step.id);
	ctx.details.timeline = watched.transitions;
	ctx.details.elapsedMs = watched.elapsedMs;
	const seen = statusesSeen(watched.transitions);
	ctx.details.statusesSeen = seen;
	check(watched.done, `did not settle within ${SCENARIO_TIMEOUT_MS / 60_000} min (last status ${watched.last?.workflow?.status})`);
	ctx.details.outTxt = readOutTxt(ctx.details.workdir);
	checkFirstAttemptRejected(ctx, watched);

	const recoveryJobs = brokerJobs(recoveryHook);
	ctx.details.recoveryJobs = recoveryJobs.map((j) => ({ id: j.id, receivedAt: j.receivedAt, headers: j.headers, input: truncate(jobInput(j), 1500) }));
	shared.c3.recoveryToken = /Token: ([0-9a-f]{64})/.exec(recoveryJobs.map(jobInput).join("\n"))?.[1] ?? null;
	check(recoveryJobs.length >= 1, `no recovery job reached the ${recoveryHook} hook`);

	const history = await waitFor(async () => {
		const list = await recoveries(ctx, workflow.id);
		return list.length > 0 && list.every((r) => r.notification) ? list : null;
	}, 30_000);
	const list = history ?? (await recoveries(ctx, workflow.id));
	ctx.details.recoveries = list;

	const capturedStatus = capturedEvents(workflow.id, "workflow.status_changed").map((e) => e.data?.to);
	const recoveringObserved = seen.includes("recovering") || capturedStatus.includes("recovering");
	ctx.details.recoveringObservedByPoll = seen.includes("recovering");
	check(recoveringObserved, `status recovering was never observed (polled: ${seen.join(" → ")})`);
	check(watched.last.workflow.status === "completed", `expected completed, ended ${watched.last.workflow.status}`);

	const final = watched.last.steps.find((s) => s.id === step.id);
	ctx.details.finalStep = final;
	check(final.recoveryCount === 1, `recoveryCount ${final.recoveryCount}, expected 1`);
	const planChanged = final.description !== STEP_DESCRIPTION || final.acceptanceCriteria !== STEP_CRITERIA;
	check(planChanged, "the recovery did not change the step's description or acceptance criteria");
	const note = (final.notes ?? []).find((n) => /^Recovery: /m.test(n.content) && n.content.includes("→"));
	ctx.details.recoveryNotes = (final.notes ?? []).filter((n) => n.content.startsWith("Recovery"));
	check(note, "no 'Recovery: … before → after' note on the step");

	// Reopened with retryCount 0 and recoveryCount 1: seen while polling, or on the step.reset event.
	const failedAt = watched.transitions.findIndex((t) => t.workflow === "recovering");
	const afterRecovery = failedAt >= 0 ? watched.transitions.slice(failedAt + 1) : watched.transitions;
	const reopenedSeen = afterRecovery.some((t) => t.steps.some((s) => s.id === step.id && s.status !== "failed" && s.retryCount === 0 && s.recoveryCount === 1));
	const resetEvents = capturedEvents(workflow.id, "step.reset").filter((e) => e.data?.reopened === true);
	ctx.details.reopen = { seenByPoll: reopenedSeen, stepResetEvents: resetEvents.map((e) => e.data) };
	check(reopenedSeen || resetEvents.some((e) => e.data.retry_count === 0 && e.data.recovery_count === 1), "the step was never seen reopened with retryCount 0 / recoveryCount 1");

	// Same session: the first dispatch after the recovery resumes a session the
	// workflow already had before it (the step's exec/judge session), never the
	// recovery's own new session.
	const recoveringIndex = watched.transitions.findIndex((t) => t.workflow === "recovering");
	const beforeRecovery = recoveringIndex >= 0 ? watched.transitions.slice(0, recoveringIndex + 1) : [];
	const mainJobs = brokerJobs(workflow.agentName);
	const firstRecoveryJobId = recoveryJobs[0].id;
	const knownSessions = new Set(
		[
			...beforeRecovery.map((t) => t.steps.find((s) => s.id === step.id)?.sessionId),
			...mainJobs.filter((j) => j.id < firstRecoveryJobId).map((j) => j.headers?.sessionid),
		].filter((id) => typeof id === "string" && id !== ""),
	);
	const relaunchJobs = mainJobs.filter((j) => j.id > firstRecoveryJobId);
	const recoverySession = list.find((r) => r.sessionId)?.sessionId ?? null;
	const relaunchSession = relaunchJobs[0]?.headers?.sessionid ?? null;
	ctx.details.session = {
		sessionsBeforeRecovery: [...knownSessions],
		recoverySession,
		relaunchJobSessionHeaders: relaunchJobs.map((j) => j.headers?.sessionid ?? null),
		finalSession: final.sessionId,
	};
	check(knownSessions.size > 0, "no session id was recorded for the run before the recovery");
	check(relaunchJobs.length > 0, "no dispatch reached the workflow's hook after the recovery");
	check(
		relaunchSession && knownSessions.has(relaunchSession) && relaunchSession !== recoverySession,
		`the relaunch did not continue the workflow's session (resumed ${relaunchSession}; before: ${[...knownSessions].join(", ")}; recovery: ${recoverySession})`,
	);

	const settledRecovery = list.find((r) => r.status === "relaunched");
	check(settledRecovery, `no relaunched recovery in the history (${list.map((r) => r.status).join(", ")})`);
	check(settledRecovery.notification, "no relaunch notification attempt recorded on the recovery");
	ctx.details.notificationLog = hubLogLines(/recovery relaunch notification/);

	const events = await waitFor(() => {
		const list = capturedEvents(workflow.id, "step.recovery");
		const actions = list.map((e) => e.data?.action);
		return actions.includes("started") && actions.includes("relaunched") ? list : null;
	}, 120_000);
	ctx.details.stepRecoveryEvents = (events ?? capturedEvents(workflow.id, "step.recovery")).map((e) => e.data);
	check(events, `step.recovery started + relaunched not captured (got ${JSON.stringify(ctx.details.stepRecoveryEvents.map((d) => d?.action))})`);
	const started = events.find((e) => e.data.action === "started").data;
	const relaunched = events.find((e) => e.data.action === "relaunched").data;
	check(typeof started.reason === "string" && started.reason.length > 0, "started has no reason");
	check(typeof started.changes === "string", "started has no changes string");
	check(typeof relaunched.reason === "string" && relaunched.reason.length > 0, "relaunched has no reason");
	check(typeof relaunched.changes === "string" && relaunched.changes.includes("→"), `relaunched changes lack before → after: ${relaunched.changes}`);
}

async function caseC4(ctx) {
	const { workflow, step } = await realAgentWorkflow(ctx, "C4", { recoverOnFailure: true, maxRecoveries: 1, bypass: false });
	const recoveryHook = `${workflow.agentName}-recovery`;
	shared.c4 = { workflowId: workflow.id, stepId: step.id, recoveryHook, done: false };
	check(workflow.permissionMode == null, `C4 must be Read-only (permissionMode ${workflow.permissionMode})`);
	const watched = await startAndWatch(ctx, workflow.id, step.id);
	ctx.details.timeline = watched.transitions;
	ctx.details.elapsedMs = watched.elapsedMs;
	ctx.details.statusesSeen = statusesSeen(watched.transitions);
	check(watched.done, `did not settle within ${SCENARIO_TIMEOUT_MS / 60_000} min (last status ${watched.last?.workflow?.status})`);
	ctx.details.outTxt = readOutTxt(ctx.details.workdir);
	shared.c4.done = true;

	const recoveryJobs = brokerJobs(recoveryHook);
	ctx.details.recoveryJobs = recoveryJobs.map((j) => ({ id: j.id, receivedAt: j.receivedAt }));
	shared.c4.recoveryJobCount = recoveryJobs.length;
	check(recoveryJobs.length === 1, `expected one recovery job on ${recoveryHook}, got ${recoveryJobs.length}`);
	check(watched.last.workflow.status === "failed", `expected failed, ended ${watched.last.workflow.status}`);
	const final = watched.last.steps.find((s) => s.id === step.id);
	ctx.details.finalStep = final;
	check(final.status === "failed", `step ${final.status}, expected failed`);
	check(final.recoveryCount === 1, `recoveryCount ${final.recoveryCount}, expected 1`);

	const history = (await waitFor(async () => {
		const list = await recoveries(ctx, workflow.id);
		return list.length > 0 && list.every((r) => r.notification) ? list : null;
	}, 30_000)) ?? (await recoveries(ctx, workflow.id));
	ctx.details.recoveries = history;
	check(history.length === 1 && history[0].status === "gave_up", `history: ${JSON.stringify(history.map((r) => r.status))}`);
	check(history[0].notification, "no give-up notification attempt recorded on the recovery");
	ctx.details.notificationLog = hubLogLines(/recovery give-up notification/);

	const gaveUp = await waitFor(() => capturedEvents(workflow.id, "step.recovery").find((e) => e.data?.action === "gave_up"), 120_000);
	ctx.details.stepRecoveryEvents = capturedEvents(workflow.id, "step.recovery").map((e) => e.data);
	check(gaveUp, "no step.recovery gave_up event captured");
	check(typeof gaveUp.data.reason === "string" && gaveUp.data.reason.length > 0, "gave_up has no reason");
	shared.c4.recoveryEventCount = capturedEvents(workflow.id, "step.recovery").length;
}

async function caseC5(ctx) {
	check(shared.c4?.done, "C4 did not leave a settled QA-c4 workflow to work on");
	const { workflowId, stepId, recoveryHook } = shared.c4;
	ctx.details.workflowId = workflowId;
	const before = await getStep(ctx, workflowId, stepId);
	check(before.status === "failed" && before.recoveryCount === 1, `QA-c4's step is ${before.status} with recoveryCount ${before.recoveryCount}`);
	const jobsBefore = brokerJobs(recoveryHook).length;
	const historyBefore = (await recoveries(ctx, workflowId)).length;

	const reopen = await api(ctx, "POST", `/api/workflows/${workflowId}/steps/${stepId}/reopen`);
	expectStatus(reopen, 200, "reopen");
	const reopened = await getStep(ctx, workflowId, stepId);
	ctx.details.reopened = { status: reopened.status, retryCount: reopened.retryCount, recoveryCount: reopened.recoveryCount };
	check(reopened.status === "pending" && reopened.retryCount === 0 && reopened.recoveryCount === 1, `after reopen: ${JSON.stringify(ctx.details.reopened)}`);

	const watched = await startAndWatch(ctx, workflowId, stepId);
	ctx.details.timeline = watched.transitions;
	ctx.details.statusesSeen = statusesSeen(watched.transitions);
	check(watched.done, `did not settle within ${SCENARIO_TIMEOUT_MS / 60_000} min`);
	check(watched.last.workflow.status === "failed", `expected failed, ended ${watched.last.workflow.status}`);
	check(!ctx.details.statusesSeen.includes("recovering"), "the workflow went recovering again although the budget was used");
	const final = watched.last.steps.find((s) => s.id === stepId);
	check(final.recoveryCount === 1, `recoveryCount ${final.recoveryCount}, expected 1`);
	const jobsAfter = brokerJobs(recoveryHook).length;
	const historyAfter = (await recoveries(ctx, workflowId)).length;
	ctx.details.recoveryJobs = { before: jobsBefore, after: jobsAfter };
	ctx.details.recoveries = { before: historyBefore, after: historyAfter };
	check(jobsAfter === jobsBefore, `a new recovery job was dispatched (${jobsBefore} → ${jobsAfter})`);
	check(historyAfter === historyBefore, `a new recovery was recorded (${historyBefore} → ${historyAfter})`);
	// Give the reporter a flush cycle, then make sure no new step.recovery event exists.
	await sleep(35_000);
	const eventsAfter = capturedEvents(workflowId, "step.recovery");
	ctx.details.stepRecoveryEvents = eventsAfter.map((e) => e.data);
	check(eventsAfter.length === (shared.c4.recoveryEventCount ?? eventsAfter.length), `new step.recovery events appeared (${shared.c4.recoveryEventCount} → ${eventsAfter.length})`);
}

async function caseC6(ctx) {
	const { workflow, step } = await realAgentWorkflow(ctx, "C6", { recoverOnFailure: false, bypass: true });
	const recoveryHook = `${workflow.agentName}-recovery`;
	const watched = await startAndWatch(ctx, workflow.id, step.id);
	ctx.details.timeline = watched.transitions;
	ctx.details.elapsedMs = watched.elapsedMs;
	ctx.details.statusesSeen = statusesSeen(watched.transitions);
	check(watched.done, `did not settle within ${SCENARIO_TIMEOUT_MS / 60_000} min`);
	ctx.details.outTxt = readOutTxt(ctx.details.workdir);
	checkFirstAttemptRejected(ctx, watched);
	check(watched.last.workflow.status === "failed", `expected failed, ended ${watched.last.workflow.status}`);
	check(!ctx.details.statusesSeen.includes("recovering"), "the workflow went recovering with the toggle off");
	const final = watched.last.steps.find((s) => s.id === step.id);
	check(final.status === "failed" && final.recoveryCount === 0, `step ${final.status} recoveryCount ${final.recoveryCount}`);
	const jobs = brokerJobs(recoveryHook);
	check(jobs.length === 0, `${jobs.length} recovery job(s) reached ${recoveryHook}`);
	check((await recoveries(ctx, workflow.id)).length === 0, "a recovery was recorded");
	await sleep(35_000);
	const events = capturedEvents(workflow.id, "step.recovery");
	ctx.details.stepRecoveryEvents = events.map((e) => e.data);
	check(events.length === 0, `${events.length} step.recovery event(s) captured`);
	check(capturedEvents(workflow.id).length > 0, "no event of QA-c6 was captured at all (reporting not working?)");
}

async function caseC7(ctx) {
	const workflow = await createWorkflow(ctx, { name: "QA-c7", workdir: workdirFor("C7"), runner: "claude", model: "haiku", recoveryModel: "sonnet" });
	ctx.details.workflowId = workflow.id;
	const recoveryHook = `${workflow.agentName}-recovery`;
	const created = await api(ctx, "POST", "/api/pipelines", { source: "name: qa-c7-untrusted\nsteps:\n  - run: echo qa-c7\n", tags: ["qa"] });
	const pipeline = expectStatus(created, [200, 201], "create pipeline").pipeline;
	ctx.details.pipeline = { id: pipeline.id, trusted: pipeline.trusted };
	check(pipeline.trusted === false, `a pipeline created through the API must stay untrusted (trusted ${pipeline.trusted})`);
	const step = await addStep(ctx, workflow.id, {
		kind: "command",
		description: "QA-c7 command step on an untrusted pipeline",
		pipelineId: pipeline.id,
		pipelineInputs: {},
		maxRetries: 0,
		recoverOnFailure: true,
	});
	check(step.recoverOnFailure === true, "the command step did not keep recoverOnFailure");
	const watched = await startAndWatch(ctx, workflow.id, step.id);
	ctx.details.timeline = watched.transitions;
	ctx.details.statusesSeen = statusesSeen(watched.transitions);
	check(watched.done, "did not settle");
	const final = watched.last.steps.find((s) => s.id === step.id);
	ctx.details.finalStep = { status: final.status, error: final.error, recoveryCount: final.recoveryCount };
	check(final.status === "failed", `step ${final.status}, expected failed`);
	check(/not trusted|untrusted/i.test(final.error ?? ""), `the failure is not the trust refusal: ${final.error}`);
	check(watched.last.workflow.status === "failed", `workflow ${watched.last.workflow.status}, expected failed`);
	check(!ctx.details.statusesSeen.includes("recovering"), "the workflow went recovering");
	check(final.recoveryCount === 0, `recoveryCount ${final.recoveryCount}`);
	check(brokerJobs(recoveryHook).length === 0, "a recovery job was dispatched");
	check((await recoveries(ctx, workflow.id)).length === 0, "a recovery was recorded");
}

async function caseC8(ctx) {
	check(shared.c3?.workflowId, "C3 did not create its workflow");
	const { workflowId, stepId, recoveryToken } = shared.c3;
	check(recoveryToken, "C3's recovery token was not found in the job its recovery hook received");
	const running = (await getWorkflow(ctx, workflowId)).workflow;
	check(!running.recovery && running.status !== "recovering", "C3's recovery has not ended");
	const before = await getStep(ctx, workflowId, stepId);
	const base = `/api/recovery/${workflowId}`;
	const tokens = { none: null, random: crypto.randomBytes(32).toString("hex"), admin: ADMIN_TOKEN, endedC3: recoveryToken };
	const results = [];
	for (const [label, token] of Object.entries(tokens)) {
		const read = await api(ctx, "GET", base, undefined, { token });
		const patch = await api(ctx, "PATCH", `${base}/steps/${stepId}`, { reason: "QA C8 must be refused", description: "QA C8 CHANGED" }, { token });
		const relaunch = await api(ctx, "POST", `${base}/relaunch`, { summary: "QA C8 must be refused" }, { token });
		results.push({ token: label, read: read.status, patch: patch.status, relaunch: relaunch.status });
	}
	ctx.details.results = results;
	for (const r of results) {
		for (const route of ["read", "patch", "relaunch"]) {
			check(r[route] === 401 || r[route] === 403, `${r.token} token on ${route}: HTTP ${r[route]}, expected 401/403`);
		}
	}
	const after = await getStep(ctx, workflowId, stepId);
	check(after.description === before.description && after.acceptanceCriteria === before.acceptanceCriteria, "a refused request changed the step");
	check((after.notes ?? []).length === (before.notes ?? []).length, "a refused request added a note");
	check((await getWorkflow(ctx, workflowId)).workflow.status === "completed", "a refused request changed the workflow status");
}

/** A JSON-RPC client over the MCP server's stdio (one JSON message per line). */
function startMcp() {
	const child = spawn(process.execPath, [path.join(TARGET_DIR, "mcp", "target-mcp.mjs")], {
		cwd: TARGET_DIR,
		env: { PATH: process.env.PATH ?? "", HOME: QA_USER_HOME, TARGET_HUB_URL: BASE_URL, TARGET_ADMIN_TOKEN: ADMIN_TOKEN },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const waiters = new Map();
	let buffer = "";
	let stderr = "";
	let nextId = 1;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (c) => (stderr += c));
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let nl;
		while ((nl = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			waiters.get(msg.id)?.(msg);
			waiters.delete(msg.id);
		}
	});
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => {
				waiters.delete(id);
				reject(new Error(`MCP ${method} timed out; stderr: ${stderr.slice(-500)}`));
			}, 30_000);
			waiters.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
		});
	const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
	const stop = () => {
		child.stdin.end();
		child.kill();
	};
	return { request, notify, stop, stderr: () => stderr };
}

async function caseC9(ctx) {
	const mcp = startMcp();
	const calls = [];
	ctx.details.calls = calls;
	const call = async (name, args) => {
		const reply = await mcp.request("tools/call", { name, arguments: args });
		const result = reply.result ?? {};
		const text = result.content?.[0]?.text ?? "";
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {}
		calls.push({ name, args, isError: result.isError === true, result: truncate(parsed ?? text, 2000) });
		check(!result.isError && !reply.error, `${name} failed: ${truncate(text || reply.error, 400)}`);
		return parsed;
	};
	try {
		const init = await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "qa-failure-recovery", version: "1" } });
		check(init.result?.serverInfo, "initialize failed");
		mcp.notify("notifications/initialized");
		const list = await mcp.request("tools/list");
		const tools = new Map((list.result?.tools ?? []).map((t) => [t.name, t]));
		const props = (name) => Object.keys(tools.get(name)?.inputSchema?.properties ?? {});
		ctx.details.schemas = Object.fromEntries(
			["add_step", "edit_step", "create_workflow", "clone_workflow", "reopen_step", "set_workflow_model", "set_recovery_model"].map((n) => [n, tools.has(n) ? props(n) : null]),
		);
		for (const name of ["add_step", "edit_step"]) {
			check(props(name).includes("recoverOnFailure") && props(name).includes("maxRecoveries"), `${name} lacks recoverOnFailure/maxRecoveries`);
		}
		for (const name of ["create_workflow", "clone_workflow"]) check(props(name).includes("recoveryModel"), `${name} lacks recoveryModel`);
		for (const name of ["reopen_step", "set_workflow_model", "set_recovery_model"]) check(tools.has(name), `tool ${name} is missing`);

		const created = await call("create_workflow", { name: "QA-c9", workdir: workdirFor("C9"), runner: "claude", model: "haiku", recoveryModel: "sonnet" });
		const workflowId = created?.workflow?.id;
		check(workflowId, "create_workflow returned no workflow id");
		ctx.details.workflowId = workflowId;
		check((await getWorkflow(ctx, workflowId)).workflow.recoveryModel === "sonnet", "create_workflow did not store recoveryModel");

		const added = await call("add_step", {
			workflowId,
			description: "QA-c9 step added through the MCP",
			acceptanceCriteria: "nothing to check",
			maxRetries: 0,
			recoverOnFailure: true,
			maxRecoveries: 2,
		});
		const stepId = added?.step?.id;
		check(stepId, "add_step returned no step id");
		let step = await getStep(ctx, workflowId, stepId);
		check(step.recoverOnFailure === true && step.maxRecoveries === 2, `add_step fields on the hub: ${JSON.stringify([step.recoverOnFailure, step.maxRecoveries])}`);

		await call("edit_step", { workflowId, stepId, description: "QA-c9 step edited through the MCP", maxRecoveries: 3 });
		step = await getStep(ctx, workflowId, stepId);
		check(step.maxRecoveries === 3 && step.recoverOnFailure === true, `edit_step: ${JSON.stringify([step.recoverOnFailure, step.maxRecoveries])} (omitted toggle must be kept)`);

		await call("set_recovery_model", { workflowId, model: "opus" });
		check((await getWorkflow(ctx, workflowId)).workflow.recoveryModel === "opus", "set_recovery_model did not change recoveryModel");
		check(readHooks()[`${created.workflow.agentName}-recovery`]?.model === "opus", "set_recovery_model did not update the -recovery hook");
		await call("set_workflow_model", { workflowId, model: "sonnet" });
		check((await getWorkflow(ctx, workflowId)).workflow.model === "sonnet", "set_workflow_model did not change the model");
		await call("set_recovery_model", { workflowId, model: null });
		check((await getWorkflow(ctx, workflowId)).workflow.recoveryModel === null, "set_recovery_model null did not clear it");

		// reopen_step needs a failed step: force one (nothing runs), then reopen it through the MCP.
		const forced = await api(ctx, "POST", `/api/workflows/${workflowId}/steps/${stepId}/status`, { status: "failed" });
		expectStatus(forced, 200, "force the step failed");
		await call("reopen_step", { workflowId, stepId });
		step = await getStep(ctx, workflowId, stepId);
		check(step.status === "pending" && step.retryCount === 0, `reopen_step: ${step.status} retryCount ${step.retryCount}`);
	} finally {
		mcp.stop();
		ctx.details.mcpStderr = truncate(mcp.stderr(), 2000);
	}
}

async function caseC10(ctx) {
	const create = await api(ctx, "POST", "/api/templates", {
		name: "QA-c10 template",
		tags: ["qa", "failure-recovery"],
		steps: [
			{ description: "QA-c10 step with recovery", acceptanceCriteria: "nothing to check", maxRetries: 0, recoverOnFailure: true, maxRecoveries: 2 },
			{ description: "QA-c10 step without recovery", acceptanceCriteria: "nothing to check", maxRetries: 0 },
		],
	});
	const template = expectStatus(create, [200, 201], "create template").template;
	ctx.details.templateId = template.id;
	check(template.steps[0].recoverOnFailure === true && template.steps[0].maxRecoveries === 2, `template step: ${JSON.stringify(template.steps[0])}`);
	check(template.steps[1].recoverOnFailure === false && template.steps[1].maxRecoveries === 1, `template defaults: ${JSON.stringify(template.steps[1])}`);

	const exported = await api(ctx, "GET", `/api/templates/${template.id}/export`);
	const bundle = expectStatus(exported, 200, "export template");
	ctx.details.bundle = bundle;
	const bundleSteps = bundle?.templates?.[0]?.steps ?? [];
	check(bundleSteps[0]?.recoverOnFailure === true && bundleSteps[0]?.maxRecoveries === 2, `bundle step: ${JSON.stringify(bundleSteps[0])}`);
	check("recoverOnFailure" in (bundleSteps[1] ?? {}) && "maxRecoveries" in (bundleSteps[1] ?? {}), "the bundle does not carry the fields on every step");

	const renamed = { ...bundle, templates: bundle.templates.map((t) => ({ ...t, name: "QA-c10 template (imported)" })) };
	const imported = await api(ctx, "POST", "/api/templates/import", renamed);
	const importedTemplate = expectStatus(imported, 200, "import bundle").templates?.[0];
	check(importedTemplate?.id, "the import created no template");
	ctx.details.importedTemplateId = importedTemplate.id;
	const readImported = expectStatus(await api(ctx, "GET", `/api/templates/${importedTemplate.id}`), 200, "read imported template").template;
	check(readImported.steps[0].recoverOnFailure === true && readImported.steps[0].maxRecoveries === 2, `imported step: ${JSON.stringify(readImported.steps[0])}`);

	const workflow = await createWorkflow(ctx, { name: "QA-c10", workdir: workdirFor("C10"), runner: "claude", model: "haiku", templateId: importedTemplate.id });
	ctx.details.workflowId = workflow.id;
	const { steps } = await getWorkflow(ctx, workflow.id);
	ctx.details.workflowSteps = steps.map((s) => ({ description: s.description, recoverOnFailure: s.recoverOnFailure, maxRecoveries: s.maxRecoveries, recoveryCount: s.recoveryCount }));
	check(steps.length === 2, `the workflow got ${steps.length} steps`);
	check(steps[0].recoverOnFailure === true && steps[0].maxRecoveries === 2 && steps[0].recoveryCount === 0, `seeded step: ${JSON.stringify(ctx.details.workflowSteps[0])}`);
	check(steps[1].recoverOnFailure === false && steps[1].maxRecoveries === 1, `seeded default step: ${JSON.stringify(ctx.details.workflowSteps[1])}`);
}

async function caseC11(ctx) {
	ctx.details.captureUrl = CAPTURE_URL;
	ctx.details.settingsResponse = capture.settingsResponse;
	check(!capture.error, `capture setup failed: ${capture.error}`);
	const settings = expectStatus(await api(ctx, "GET", "/api/settings/report"), 200, "read report settings").settings;
	ctx.details.settings = settings;
	check(settings?.enabled === true && settings?.url === CAPTURE_URL, `report settings do not point at the capture server: ${JSON.stringify(settings)}`);
	check(shared.c3?.workflowId, "C3 did not create its workflow, so there is no recovery scenario to inspect");
	const workflowId = shared.c3.workflowId;

	const ready = await waitFor(() => {
		const actions = capturedEvents(workflowId, "step.recovery").map((e) => e.data?.action);
		return actions.includes("started") && actions.includes("relaunched");
	}, 120_000);
	ctx.details.envelopes = capture.envelopes.length;
	const all = capturedEvents(workflowId);
	ctx.details.kinds = [...new Set(all.map((e) => e.kind))];
	ctx.details.captured = all.map((e) => ({ kind: e.kind, created_at: e.created_at, data: truncate(e.data, 3000) }));
	check(ready, "the step.recovery events of QA-c3 were not captured");

	const plans = capturedEvents(workflowId, "workflow.plan").map((e) => e.data);
	check(plans.length > 0, "no workflow.plan captured");
	for (const plan of plans) {
		check("recovery_model" in plan, "a plan lacks recovery_model");
		for (const step of plan.steps ?? []) {
			if (step.kind === "context") continue;
			check(typeof step.recover_on_failure === "boolean", "a plan step lacks recover_on_failure");
			check(Number.isInteger(step.max_recoveries), "a plan step lacks max_recoveries");
			check(Number.isInteger(step.recovery_count), "a plan step lacks recovery_count");
		}
	}
	check(plans.some((p) => p.recovery_model === "sonnet"), "no plan with recovery_model sonnet");
	const stepId = shared.c3.stepId;
	check(
		plans.some((p) => (p.steps ?? []).some((s) => s.step_id === stepId && s.recover_on_failure === true && s.recovery_count === 1)),
		"no plan shows the step with recover_on_failure true and recovery_count 1",
	);
	const created = capturedEvents(workflowId, "workflow.created")[0];
	check(created && created.data?.recovery_model === "sonnet", `workflow.created recovery_model: ${JSON.stringify(created?.data?.recovery_model)}`);
	const statusChanges = capturedEvents(workflowId, "workflow.status_changed").map((e) => e.data);
	ctx.details.statusChanges = statusChanges;
	check(statusChanges.some((d) => d.to === "recovering"), "no workflow.status_changed to recovering");
	for (const event of capturedEvents(workflowId, "step.recovery")) {
		const d = event.data ?? {};
		check(["started", "relaunched", "gave_up"].includes(d.action), `step.recovery with action ${d.action}`);
		check(typeof d.reason === "string" && d.reason.length > 0, `step.recovery ${d.action} without reason`);
		check(typeof d.changes === "string", `step.recovery ${d.action} without changes`);
	}
}

async function caseC12(ctx) {
	fs.mkdirSync(QA_USER_HOME, { recursive: true });
	const agentSync = pathToFileURL(path.join(TARGET_DIR, "hub", "agent-sync.ts")).href;
	const code = `const m = await import(${JSON.stringify(agentSync)}); process.stdout.write("\\nQA_SYNC_JSON:" + JSON.stringify(m.syncSkills({ homeDir: process.env.HOME })) + "\\n");`;
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: QA_USER_HOME,
		TARGET_HOME: path.join(QA_USER_HOME, ".target"),
		AWB_HOME: path.join(QA_USER_HOME, ".agent-webhook-bridge"),
	};
	const run = () => {
		const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: TARGET_DIR, env, encoding: "utf8", timeout: 120_000 });
		const line = (out.stdout ?? "").split("\n").find((l) => l.startsWith("QA_SYNC_JSON:"));
		return { status: out.status, stderr: truncate(out.stderr, 2000), actions: line ? JSON.parse(line.slice("QA_SYNC_JSON:".length)) : null };
	};
	const first = run();
	ctx.details.first = first;
	check(first.actions, `the skills sync did not run (exit ${first.status}): ${first.stderr}`);
	for (const action of first.actions) check(action.path.startsWith(QA_USER_HOME), `the sync touched ${action.path}, outside $QA_HOME/home`);
	const installed = [...new Set(first.actions.filter((a) => a.action !== "skipped").map((a) => a.harness))];
	ctx.details.installedRunners = installed;
	check(installed.includes("claude"), "claude is not reported installed by the sync");
	const destByRunner = { claude: ".claude/skills", cursor: ".cursor/skills", copilot: ".copilot/skills", "free-code": ".free-code/skills" };
	const files = {};
	for (const runner of installed) {
		for (const skill of ["create-workflow", "target-workflows"]) {
			const file = path.join(QA_USER_HOME, destByRunner[runner], skill, "SKILL.md");
			check(fs.existsSync(file), `${file} was not written`);
			const content = fs.readFileSync(file, "utf8");
			files[`${runner}/${skill}`] = { file, version: /^TARGET_SKILL_VERSION: "([^"]+)"/m.exec(content)?.[1] ?? null, failureRecovery: /Failure recovery/.test(content) };
			check(/^TARGET_SKILL_VERSION: "7"$/m.test(content), `${file} is not TARGET_SKILL_VERSION "7"`);
			check(/Failure recovery/.test(content), `${file} has no Failure recovery section`);
		}
	}
	ctx.details.files = files;
	for (const skill of ["create-workflow", "target-workflows"]) {
		check(!fs.existsSync(path.join(QA_USER_HOME, ".cursor/skills-cursor", skill, "SKILL.md")), `${skill} was written to .cursor/skills-cursor`);
	}
	const second = run();
	ctx.details.second = second;
	check(second.actions, `the second sync did not run (exit ${second.status})`);
	const changed = second.actions.filter((a) => a.action === "synced" || a.action === "removed");
	check(changed.length === 0, `the second run changed ${changed.map((a) => a.path).join(", ")}`);
	for (const runner of installed) {
		check(second.actions.filter((a) => a.harness === runner && a.action === "unchanged").length >= 2, `the second run did not report ${runner}'s skills unchanged`);
	}
}

// --------------------------------------------------------------------------------
// Runner.

const CASES = {
	C1: ["Step fields recoverOnFailure / maxRecoveries / recoveryCount", caseC1],
	C2: ["Recovery model and the -recovery hook", caseC2],
	C3: ["Happy path: judge rejects, recovery fixes the plan, relaunch completes (real agents)", caseC3],
	C4: ["Gives up: Read-only recovery cannot relaunch (real agents)", caseC4],
	C5: ["Cap: a reopened step past maxRecoveries gets no new recovery", caseC5],
	C6: ["Toggle off: the step fails normally, no recovery (real agents)", caseC6],
	C7: ["Infrastructure failure: untrusted pipeline refused, no recovery", caseC7],
	C8: ["Recovery API security: no / random / admin / ended token rejected", caseC8],
	C9: ["MCP: fields and tools against the throwaway hub", caseC9],
	C10: ["Templates and bundles keep recoverOnFailure / maxRecoveries", caseC10],
	C11: ["Report payload captured on 127.0.0.1:8995", caseC11],
	C12: ["Skills sync into $QA_HOME/home (version 7, .cursor/skills)", caseC12],
};

const results = {};

async function runCase(id) {
	const [title, fn] = CASES[id];
	const ctx = newContext(id);
	const startedAt = iso();
	const t0 = Date.now();
	process.stderr.write(`… ${id} ${title}\n`);
	let pass = false;
	let reason = null;
	try {
		await fn(ctx);
		pass = true;
	} catch (err) {
		reason = err instanceof CaseFailure ? err.message : `unexpected error: ${err?.stack ?? String(err)}`;
	}
	results[id] = { id, title, pass, reason, startedAt, durationMs: Date.now() - t0, details: ctx.details, requests: ctx.requests };
	process.stderr.write(`${pass ? "✔" : "✖"} ${id} (${Math.round((Date.now() - t0) / 1000)}s)${reason ? `: ${reason}` : ""}\n`);
}

function writeResults(extra = {}) {
	const ordered = Object.keys(CASES).map((id) => results[id] ?? { id, title: CASES[id][0], pass: false, reason: "did not run" });
	const summary = {
		generatedAt: iso(),
		hub: BASE_URL,
		broker: AWB_URL || null,
		qaHome: QA_HOME,
		targetDir: TARGET_DIR,
		captureUrl: CAPTURE_URL,
		passed: ordered.filter((r) => r.pass).length,
		failed: ordered.filter((r) => !r.pass).length,
		cases: ordered,
		capture: { envelopes: capture.envelopes.length, error: capture.error, settingsResponse: capture.settingsResponse },
		...extra,
	};
	fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
	fs.writeFileSync(RESULTS_FILE, `${JSON.stringify(summary, null, 2)}\n`);
	return ordered;
}

async function main() {
	const t0 = Date.now();
	fs.mkdirSync(WORK_DIR, { recursive: true });
	const health = await fetch(`${BASE_URL}/health`).then((r) => r.status).catch(() => 0);
	if (health !== 200) {
		process.stderr.write(`the throwaway hub at ${BASE_URL} does not answer /health (${health})\n`);
	}

	// Reporting first (C11's setup), so every case's events are captured.
	try {
		await startCapture();
		const res = await api(null, "PUT", "/api/settings/report", { enabled: true, url: CAPTURE_URL, token: "qa-capture-token", intervalMs: 1000, includeConversations: "off" });
		capture.settingsResponse = { status: res.status, body: truncate(res.json ?? res.text, 1000) };
		if (res.status !== 200) capture.error = `PUT /api/settings/report answered ${res.status}`;
	} catch (err) {
		capture.error = String(err);
	}

	// The three real-agent scenarios run concurrently; the quick cases run meanwhile.
	const c3 = runCase("C3");
	const c4 = runCase("C4").then(() => runCase("C5"));
	const c6 = runCase("C6");
	const quick = (async () => {
		for (const id of ["C1", "C2", "C7", "C9", "C10", "C12"]) await runCase(id);
	})();
	const afterC3 = c3.then(() => runCase("C8")).then(() => runCase("C11"));
	await Promise.all([afterC3, c4, c6, quick]);

	const ordered = writeResults({ durationMs: Date.now() - t0 });
	for (const r of ordered) process.stdout.write(r.pass ? `PASS ${r.id} ${r.title}\n` : `FAIL ${r.id} ${r.title}: ${r.reason}\n`);
	process.stdout.write(`${ordered.filter((r) => r.pass).length}/${ordered.length} cases passed in ${Math.round((Date.now() - t0) / 1000)}s — details in ${RESULTS_FILE}\n`);
	capture.server?.close();
	process.exit(ordered.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => {
	try {
		writeResults({ fatal: String(err?.stack ?? err) });
	} catch {}
	process.stderr.write(`fatal: ${String(err?.stack ?? err)}\n`);
	process.exit(1);
});
