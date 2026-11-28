/**
 * Failure recovery ("Recover on failure"): a step that fails for good — the
 * judge's final rejection, a command step's final failure, a timeout with no
 * retries left — sends the workflow to `recovering` and dispatches a recovery
 * agent to the workflow's `<agentName>-recovery` hook, which fixes the PLAN
 * through the token-scoped recovery API and relaunches (or gives up).
 *
 * Hermetic like the other engine suites: a throwaway TARGET_HOME/AWB_HOME, a
 * fake awb broker on a random port that records every POST and never calls
 * back (callbacks are driven by the tests), the hub's real HTTP server on
 * another random port. `cfg.port` is pointed at that server so the URLs the
 * engine hands out (recovery API base URL, callbacks) reach it — never the
 * live hub. Notifications are off in a fresh DB, so nothing reaches Slack; the
 * notifier's outcome is still recorded on the recovery.
 *
 * The DB is seeded with a pre-feature `steps`/`workflows` schema before db.ts
 * is imported, so every test here runs on the MIGRATED database.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-failure-recovery-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");
for (const suffix of ["XOXC", "XOXD"]) {
	for (const prefix of ["TARGET_SLACK_", "SLACK_MCP_", "SLACK_"]) delete process.env[`${prefix}${suffix}_TOKEN`];
}

// --- a database from before Failure recovery existed --------------------------
{
	const legacy = new DatabaseSync(path.join(tmpHome, "target.db"));
	legacy.exec(`
		CREATE TABLE workflows (
			id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_name TEXT NOT NULL UNIQUE, hook_url TEXT NOT NULL,
			secret TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', last_session_id TEXT, md_path TEXT NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE steps (
			id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, order_index INTEGER NOT NULL, description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending', result TEXT, error TEXT, session_id TEXT, callback_token TEXT NOT NULL,
			created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
		);
	`);
	const now = new Date().toISOString();
	legacy
		.prepare("INSERT INTO workflows (id, name, agent_name, hook_url, secret, md_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run("legacy-wf", "legacy", "legacy-agent", "http://127.0.0.1:9/hook/legacy-agent", "s", path.join(tmpHome, "legacy.md"), now, now);
	legacy
		.prepare("INSERT INTO steps (id, workflow_id, order_index, description, callback_token, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.run("legacy-step", "legacy-wf", 0, "a step from before Failure recovery", "tok", now);
	legacy.close();
}

// --- the fake awb broker ---------------------------------------------------------
interface BrokerRequest {
	path: string;
	headers: http.IncomingHttpHeaders;
	body: { jobId?: string; input?: string; callbackUrl?: string; startedCallbackUrl?: string };
}
const brokerRequests: BrokerRequest[] = [];
const broker = http.createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		let body = {};
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		} catch {
			body = {};
		}
		brokerRequests.push({ path: req.url ?? "", headers: req.headers, body });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
const brokerPort = (broker.address() as { port: number }).port;
// hooks.json names the fake broker's port, so the hooks the hub writes point at it
// and read back as "local" (hookRuntime / upsertRecoveryHook).
fs.writeFileSync(path.join(tmpHome, "hooks.json"), JSON.stringify({ host: "127.0.0.1", port: brokerPort, hooks: {} }));

const db = await import("./db.ts");
const { getStep, getWorkflow, listSteps, open, saveReportSettings, listRecoveries, getRunningRecovery } = db;
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { insertPipeline } = await import("./pipeline-store.ts");
const workflowApi = await import("./workflow.ts");
const { addStep, createWorkflow, onStepResult, startWorkflow, expireStale, restartWorkflow, abortStep, runStep } = workflowApi;

const cfg = loadConfig();
const logs: string[] = [];
const log = (message: string) => {
	logs.push(message);
};
const server = createServer(cfg, log);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const hubPort = (server.address() as { port: number }).port;
// Every URL the engine builds (recovery API, callbacks) must reach THIS server.
cfg.port = hubPort;
const hub = `http://127.0.0.1:${hubPort}`;

saveReportSettings({ enabled: true, url: "http://127.0.0.1:9/ingest", token: "test", intervalMs: 60_000, includeConversations: "off" });

const workdirs: string[] = [];
test.after(() => {
	server.close();
	broker.close();
	for (const dir of workdirs) fs.rmSync(dir, { recursive: true, force: true });
});

function freshWorkdir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "target-recovery-wd-"));
	workdirs.push(dir);
	return dir;
}

function admin(extra: Record<string, string> = {}): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}`, ...extra };
}

async function api(method: string, url: string, body?: unknown, headers: Record<string, string> = admin()) {
	const res = await fetch(`${hub}${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
	const text = await res.text();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(text);
	} catch {
		json = { raw: text };
	}
	return { status: res.status, json };
}

function readHooks(): Record<string, Record<string, unknown>> {
	return (JSON.parse(fs.readFileSync(path.join(tmpHome, "hooks.json"), "utf8")) as { hooks: Record<string, Record<string, unknown>> }).hooks;
}

function events(workflowId: string, kind?: string): Record<string, unknown>[] {
	const rows = open()
		.prepare("SELECT kind, payload FROM report_events WHERE workflow_id = ? ORDER BY created_at, rowid")
		.all(workflowId) as { kind: string; payload: string }[];
	return rows
		.filter((r) => !kind || r.kind === kind)
		.map((r) => ({ kind: r.kind, ...(JSON.parse(r.payload) as Record<string, unknown>) }));
	// (the stored payload is the event's `data` itself)
}

function recoveryEvents(workflowId: string): Record<string, unknown>[] {
	return events(workflowId, "step.recovery");
}

function dispatchesTo(hookName: string): BrokerRequest[] {
	return brokerRequests.filter((r) => r.path === `/hook/${hookName}`);
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

let seq = 0;
/** A workflow on the fake broker with one judged agent step (maxRetries 0). */
function judgedWorkflow(options: { recoverOnFailure?: boolean; maxRecoveries?: number; recoveryModel?: string | null } = {}) {
	seq++;
	const workflow = createWorkflow(`recovery wf ${seq}`, {
		workdir: freshWorkdir(),
		runner: "claude",
		model: "haiku",
		permissionMode: "bypassPermissions",
		...(options.recoveryModel ? { recoveryModel: options.recoveryModel } : {}),
	});
	const step = addStep(workflow.id, "Write the word hello into the file out.txt in the working directory", {
		acceptanceCriteria: "out.txt contains exactly the word goodbye",
		maxRetries: 0,
		recoverOnFailure: options.recoverOnFailure ?? true,
		...(options.maxRecoveries !== undefined ? { maxRecoveries: options.maxRecoveries } : {}),
	});
	return { workflow, step };
}

/** Runs the step through exec + a rejecting judge (the hook never calls back; the test plays awb). */
async function runToRejection(workflowId: string, stepId: string, reason = "out.txt contains hello, not goodbye") {
	await startWorkflow(workflowId, cfg, log, [stepId]);
	await onStepResult(stepId, { ok: true, result: "wrote hello", sessionId: "session-main" }, cfg, log);
	assert.equal(getStep(stepId)?.phase, "judge");
	await onStepResult(stepId, { ok: true, result: JSON.stringify({ ok: false, reason }), sessionId: "session-main" }, cfg, log);
}

/** The recovery token, read back out of the prompt the fake broker received. */
function tokenFromPrompt(prompt: string): string {
	const match = /Token: ([0-9a-f]{64})/.exec(prompt);
	assert.ok(match, "the prompt carries the recovery token");
	return match[1]!;
}

function bearer(token: string): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------------

test("migration: rows from before Failure recovery read the defaults", () => {
	const step = getStep("legacy-step");
	assert.ok(step);
	assert.equal(step.recoverOnFailure, false);
	assert.equal(step.maxRecoveries, 1);
	assert.equal(step.recoveryCount, 0);
	assert.equal(getWorkflow("legacy-wf")?.recoveryModel, null);
	const recoveries = open().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recoveries'").get();
	assert.ok(recoveries, "the recoveries table exists");
});

test("API: create and edit a step with recoverOnFailure / maxRecoveries; defaults; invalid values are 400", async () => {
	const workflow = createWorkflow(`fields ${++seq}`, { workdir: freshWorkdir() });
	const withFields = await api("POST", `/api/workflows/${workflow.id}/steps`, { description: "a", recoverOnFailure: true, maxRecoveries: 2 });
	assert.equal(withFields.status, 200);
	const s1 = withFields.json.step as Record<string, unknown>;
	assert.equal(s1.recoverOnFailure, true);
	assert.equal(s1.maxRecoveries, 2);
	assert.equal(s1.recoveryCount, 0);

	const plain = await api("POST", `/api/workflows/${workflow.id}/steps`, { description: "b" });
	const s2 = plain.json.step as Record<string, unknown>;
	assert.equal(s2.recoverOnFailure, false);
	assert.equal(s2.maxRecoveries, 1);
	assert.equal(s2.recoveryCount, 0);

	const edited = await api("PATCH", `/api/workflows/${workflow.id}/steps/${s2.id}`, { description: "b", recoverOnFailure: true, maxRecoveries: 3 });
	assert.equal(edited.status, 200);
	assert.equal((edited.json.step as Record<string, unknown>).recoverOnFailure, true);
	assert.equal((edited.json.step as Record<string, unknown>).maxRecoveries, 3);

	// An edit that omits them keeps the stored values.
	const descOnly = await api("PATCH", `/api/workflows/${workflow.id}/steps/${s2.id}`, { description: "b2" });
	assert.equal((descOnly.json.step as Record<string, unknown>).recoverOnFailure, true);
	assert.equal((descOnly.json.step as Record<string, unknown>).maxRecoveries, 3);

	for (const bad of [-1, 1.5, "2", null]) {
		const add = await api("POST", `/api/workflows/${workflow.id}/steps`, { description: "c", maxRecoveries: bad });
		assert.equal(add.status, 400, `add maxRecoveries ${JSON.stringify(bad)}`);
		const edit = await api("PATCH", `/api/workflows/${workflow.id}/steps/${s1.id}`, { description: "a", maxRecoveries: bad });
		assert.equal(edit.status, 400, `edit maxRecoveries ${JSON.stringify(bad)}`);
	}
	const badToggle = await api("POST", `/api/workflows/${workflow.id}/steps`, { description: "c", recoverOnFailure: "yes" });
	assert.equal(badToggle.status, 400);
	assert.equal(getStep(String(s1.id))?.maxRecoveries, 2, "a refused edit changes nothing");
	// Engine-level guard too.
	assert.throws(() => addStep(workflow.id, "d", { maxRecoveries: -1 }), /maxRecoveries/);
});

test("recovery model: stored, returned, copied onto <agentName>-recovery; invalid id 400; null clears; delete removes the hook", async () => {
	const workflow = createWorkflow(`model ${++seq}`, {
		workdir: freshWorkdir(),
		runner: "claude",
		model: "haiku",
		permissionMode: "bypassPermissions",
	});
	const set = await api("PATCH", `/api/workflows/${workflow.id}/recovery-model`, { recoveryModel: "sonnet" });
	assert.equal(set.status, 200);
	assert.equal((set.json.workflow as Record<string, unknown>).recoveryModel, "sonnet");
	const detail = await api("GET", `/api/workflows/${workflow.id}`);
	assert.equal((detail.json.workflow as Record<string, unknown>).recoveryModel, "sonnet");
	assert.equal((detail.json.workflow as Record<string, unknown>).model, "haiku", "the workflow's own model is untouched");

	const hooks = readHooks();
	const main = hooks[workflow.agentName]!;
	const copy = hooks[`${workflow.agentName}-recovery`];
	assert.ok(copy, "the recovery hook exists");
	assert.equal(copy.model, "sonnet");
	assert.equal(main.model, "haiku");
	assert.deepEqual(copy.consumers, main.consumers);
	assert.equal(copy.workdir, main.workdir);
	assert.equal(copy.permissionMode, main.permissionMode);
	assert.equal(copy.secret, main.secret);
	assert.deepEqual(copy.sandbox, main.sandbox);

	const bad = await api("PATCH", `/api/workflows/${workflow.id}/recovery-model`, { recoveryModel: "gpt-nine-thousand" });
	assert.equal(bad.status, 400);
	assert.equal(getWorkflow(workflow.id)?.recoveryModel, "sonnet");

	const cleared = await api("PATCH", `/api/workflows/${workflow.id}/recovery-model`, { recoveryModel: null });
	assert.equal(cleared.status, 200);
	assert.equal(getWorkflow(workflow.id)?.recoveryModel, null);
	assert.equal("model" in readHooks()[`${workflow.agentName}-recovery`]!, false, "null removes the hook's model");

	const removed = await api("DELETE", `/api/workflows/${workflow.id}`);
	assert.equal(removed.status, 200);
	assert.equal(readHooks()[`${workflow.agentName}-recovery`], undefined);
	assert.equal(readHooks()[workflow.agentName], undefined);
});

test("recovery hook copies a docker sandbox block (image, mounts, env) and create accepts recoveryModel", async () => {
	const workflow = createWorkflow(`docker ${++seq}`, {
		workdir: freshWorkdir(),
		runner: "claude",
		sandbox: "docker",
		dockerMounts: [tmpHome],
		recoveryModel: "sonnet",
	});
	assert.equal(getWorkflow(workflow.id)?.recoveryModel, "sonnet");
	const hooks = readHooks();
	const copy = hooks[`${workflow.agentName}-recovery`]!;
	assert.ok(copy.sandbox, "the sandbox block is copied");
	assert.deepEqual(copy.sandbox, hooks[workflow.agentName]!.sandbox);
	assert.equal(copy.model, "sonnet");

	const viaApi = await api("POST", "/api/workflows", { name: `api create ${++seq}`, workdir: freshWorkdir(), runner: "claude", recoveryModel: "sonnet" });
	assert.equal(viaApi.status, 200);
	assert.equal((viaApi.json.workflow as Record<string, unknown>).recoveryModel, "sonnet");
	const badCreate = await api("POST", "/api/workflows", { name: `api create bad ${++seq}`, workdir: freshWorkdir(), recoveryModel: "gpt-nine-thousand" });
	assert.equal(badCreate.status, 400);
});

test("judge final rejection with the toggle on: recovering, recoveryCount 1, step.recovery started, recovery job on the -recovery hook in a new session", async () => {
	const { workflow, step } = judgedWorkflow({ recoveryModel: "sonnet" });
	await runToRejection(workflow.id, step.id);

	const wf = getWorkflow(workflow.id)!;
	assert.equal(wf.status, "recovering");
	const failed = getStep(step.id)!;
	assert.equal(failed.status, "failed");
	assert.equal(failed.recoveryCount, 1);
	assert.match(failed.error ?? "", /rejected by the judge/);

	const started = recoveryEvents(workflow.id);
	assert.equal(started.length, 1);
	assert.equal(started[0]!.action, "started");
	assert.match(String(started[0]!.reason), /out\.txt contains hello, not goodbye/);
	assert.equal(started[0]!.changes, "");
	const statusChanges = events(workflow.id, "workflow.status_changed").map((e) => e.to);
	assert.ok(statusChanges.includes("recovering"));
	assert.ok(!statusChanges.includes("failed"), "the workflow goes recovering instead of failing");

	const jobs = dispatchesTo(`${workflow.agentName}-recovery`);
	assert.equal(jobs.length, 1);
	const job = jobs[0]!;
	assert.equal(job.headers.sessionid, undefined, "a new session, not the workflow's");
	const recovery = getRunningRecovery(workflow.id)!;
	assert.equal(job.body.jobId, recovery.id);
	const prompt = job.body.input ?? "";
	assert.ok(prompt.includes(workflow.id));
	assert.ok(prompt.includes(step.id));
	assert.ok(prompt.includes("out.txt contains hello, not goodbye"));
	assert.ok(prompt.includes(hub), "the hub's own base URL");
	assert.ok(prompt.includes(`curl -s -H 'Authorization: Bearer ${tokenFromPrompt(prompt)}' ${hub}/api/recovery/${workflow.id}`));
	for (const route of ["/relaunch", "/give-up", "/reopen", "/move", "/notes", "-X PATCH", "-X DELETE"]) {
		assert.ok(prompt.includes(route), `the prompt has a curl example for ${route}`);
	}
	assert.match(prompt, /NEVER create, edit or delete code or files/);
	assert.ok(job.body.callbackUrl?.startsWith(`http://127.0.0.1:${hubPort}/api/recoveries/${recovery.id}/result?token=`));
	assert.ok(!prompt.includes(cfg.adminToken), "never the admin token");

	// Nothing else is dispatched and the UI/MCP cannot edit the steps meanwhile.
	assert.equal(dispatchesTo(workflow.agentName).length, 2, "exec + judge only");
	const edit = await api("PATCH", `/api/workflows/${workflow.id}/steps/${step.id}`, { description: "sneaky" });
	assert.equal(edit.status, 409);
	assert.equal((await api("POST", `/api/workflows/${workflow.id}/steps`, { description: "x" })).status, 409);
	assert.equal((await api("POST", `/api/workflows/${workflow.id}/start`, { stepIds: [step.id] })).status, 409);
	assert.equal((await api("POST", `/api/workflows/${workflow.id}/steps/${step.id}/reopen`)).status, 409);
	// The read-path heal leaves the badge alone.
	expireStale(cfg, log);
	assert.equal(getWorkflow(workflow.id)?.status, "recovering");

	// Settle it (abort) so later tests start from a quiet hub.
	const aborted = await api("POST", `/api/workflows/${workflow.id}/recovery/abort`);
	assert.equal(aborted.status, 200);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	const last = recoveryEvents(workflow.id).at(-1)!;
	assert.equal(last.action, "gave_up");
	assert.match(String(last.reason), /aborted by the operator/);
});

test("recovery API: token scoping (missing, random, admin, other workflow's, expired) and every route, then relaunch in the same session", async () => {
	const { workflow, step } = judgedWorkflow();
	const other = judgedWorkflow();
	const done = addStep(workflow.id, "a pending follow-up", { acceptanceCriteria: "it is followed up" });
	const extra = addStep(workflow.id, "a pending step to delete");
	await runToRejection(workflow.id, step.id);
	await runToRejection(other.workflow.id, other.step.id);
	const token = tokenFromPrompt(dispatchesTo(`${workflow.agentName}-recovery`)[0]!.body.input!);
	const otherToken = tokenFromPrompt(dispatchesTo(`${other.workflow.agentName}-recovery`)[0]!.body.input!);
	const base = `/api/recovery/${workflow.id}`;

	// --- authentication ---
	const missing = await api("GET", base, undefined, { "content-type": "application/json" });
	assert.equal(missing.status, 401);
	assert.equal((await api("GET", base, undefined, bearer("f".repeat(64)))).status, 403);
	assert.equal((await api("GET", base, undefined, admin())).status, 403, "the admin token is refused");
	assert.equal((await api("GET", base, undefined, bearer(otherToken))).status, 403, "another workflow's token is refused");
	assert.equal((await api("PATCH", `${base}/steps/${step.id}`, { reason: "x", description: "y" }, admin())).status, 403);
	assert.equal(getStep(step.id)?.description, step.description, "a refused request changes nothing");
	// The recovery token opens nothing outside the recovery API.
	assert.equal((await api("GET", `/api/workflows/${workflow.id}`, undefined, bearer(token))).status, 401);

	// --- read ---
	const view = await api("GET", base, undefined, bearer(token));
	assert.equal(view.status, 200);
	const failedView = view.json.failedStep as Record<string, unknown>;
	assert.equal(failedView.id, step.id);
	assert.equal(failedView.judgeReason, "out.txt contains hello, not goodbye");
	assert.equal(failedView.result, "wrote hello");
	assert.ok(Array.isArray(view.json.steps));
	assert.equal((view.json.recovery as Record<string, unknown>).failureKind, "judge_rejected");

	// --- edit the failed step: a before → after note, a change line ---
	const edit = await api(
		"PATCH",
		`${base}/steps/${step.id}`,
		{ reason: "make the task match its criteria", description: "Write the word goodbye into the file out.txt in the working directory", maxRetries: 1 },
		bearer(token),
	);
	assert.equal(edit.status, 200, JSON.stringify(edit.json));
	const edited = getStep(step.id)!;
	assert.match(edited.description, /goodbye/);
	assert.equal(edited.maxRetries, 1);
	const note = db.listStepNotes(step.id).find((n) => n.content.startsWith("Recovery: description:"));
	assert.ok(note, "the edit left a Recovery note");
	assert.match(note.content, /Recovery: description: "Write the word hello.*" → "Write the word goodbye.*"/);
	assert.match(note.content, /Recovery: maxRetries: 0 → 1/);
	assert.match(note.content, /Reason: make the task match its criteria/);
	// Strict fields, reason required, no kind changes.
	assert.equal((await api("PATCH", `${base}/steps/${step.id}`, { description: "z" }, bearer(token))).status, 400);
	assert.equal((await api("PATCH", `${base}/steps/${step.id}`, { reason: "r", kind: "command" }, bearer(token))).status, 400);
	assert.equal((await api("PATCH", `${base}/steps/${step.id}`, { reason: "r", maxRecoveries: -1 }, bearer(token))).status, 400);
	// Another workflow's step is out of reach.
	assert.equal((await api("PATCH", `${base}/steps/${other.step.id}`, { reason: "r", description: "z" }, bearer(token))).status, 404);

	// --- add / move / delete / note ---
	const added = await api("POST", `${base}/steps`, { reason: "check first", description: "Check out.txt exists", afterStepId: step.id }, bearer(token));
	assert.equal(added.status, 200, JSON.stringify(added.json));
	const addedId = String((added.json.step as Record<string, unknown>).id);
	assert.ok(db.listStepNotes(addedId).some((n) => n.content.startsWith("Recovery: added step")));
	const moved = await api("POST", `${base}/steps/${addedId}/move`, { reason: "later", direction: "down" }, bearer(token));
	assert.equal(moved.status, 200, JSON.stringify(moved.json));
	assert.ok(db.listStepNotes(addedId).some((n) => /Recovery: position: \d+ → \d+/.test(n.content)));
	const deleted = await api("DELETE", `${base}/steps/${extra.id}`, { reason: "not needed" }, bearer(token));
	assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
	assert.equal(getStep(extra.id), null);
	assert.ok(db.listStepNotes(step.id).some((n) => n.content.startsWith("Recovery: deleted step")));
	assert.equal((await api("DELETE", `${base}/steps/${step.id}`, { reason: "x" }, bearer(token))).status, 403, "the failed step cannot be deleted");
	const noted = await api("POST", `${base}/steps/${done.id}/notes`, { content: "keep an eye on this" }, bearer(token));
	assert.equal(noted.status, 200);

	// --- reopen: pending, retryCount 0, recoveryCount kept ---
	open().prepare("UPDATE steps SET retry_count = 2 WHERE id = ?").run(step.id);
	const reopened = await api("POST", `${base}/steps/${step.id}/reopen`, { reason: "plan fixed" }, bearer(token));
	assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
	const afterReopen = getStep(step.id)!;
	assert.equal(afterReopen.status, "pending");
	assert.equal(afterReopen.retryCount, 0);
	assert.equal(afterReopen.recoveryCount, 1);
	assert.equal(getWorkflow(workflow.id)?.status, "recovering", "reopening does not end the recovery");

	// --- relaunch: same session, every pending step selected, event + notification ---
	const execsBefore = dispatchesTo(workflow.agentName).length;
	const relaunch = await api("POST", `${base}/relaunch`, { summary: "description now asks for goodbye" }, bearer(token));
	assert.equal(relaunch.status, 200, JSON.stringify(relaunch.json));
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	const execs = dispatchesTo(workflow.agentName);
	assert.equal(execs.length, execsBefore + 1, "the workflow continued");
	const exec = execs.at(-1)!;
	assert.equal(exec.body.jobId, step.id);
	assert.equal(exec.headers.sessionid, "session-main", "it resumes the workflow's own conversation");
	assert.ok(listSteps(workflow.id).filter((s) => s.status === "pending" && s.kind !== "context").every((s) => s.selected));
	const relaunched = recoveryEvents(workflow.id).find((e) => e.action === "relaunched")!;
	assert.ok(relaunched, "step.recovery relaunched");
	assert.match(String(relaunched.reason), /rejected by the judge/);
	assert.match(String(relaunched.changes), /description: .* → /);
	const settled = listRecoveries(workflow.id)[0]!;
	assert.equal(settled.status, "relaunched");
	await until(() => (listRecoveries(workflow.id)[0]?.notification ?? null) !== null);
	assert.equal(listRecoveries(workflow.id)[0]!.notification, "notifications-disabled", "the notifier was asked");
	assert.ok(logs.some((l) => /recovery relaunch notification not sent/.test(l)));
	assert.ok(db.listStepNotes(step.id).some((n) => n.content.startsWith("Recovery relaunched the workflow")));

	// --- the token died with the recovery ---
	assert.equal((await api("GET", base, undefined, bearer(token))).status, 403);
	assert.equal((await api("PATCH", `${base}/steps/${step.id}`, { reason: "r", description: "late" }, bearer(token))).status, 403);
	assert.match(getStep(step.id)!.description, /goodbye/);
	// A late result callback of the relaunched recovery only records its answer.
	await fetch(settled.callbackToken ? `${hub}/api/recoveries/${settled.id}/result?token=${settled.callbackToken}` : "", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ok: true, result: "relaunched", session_id: "session-recovery" }),
	});
	await until(() => listRecoveries(workflow.id)[0]?.result === "relaunched");
	assert.equal(listRecoveries(workflow.id)[0]!.status, "relaunched");
	assert.equal(getWorkflow(workflow.id)?.lastSessionId, "session-main", "the recovery's own session never becomes the workflow's");

	await api("POST", `/api/workflows/${other.workflow.id}/recovery/abort`);
});

test("give up: the turn ends without a relaunch → gave_up event, notification, step failed, workflow failed", async () => {
	const { workflow, step } = judgedWorkflow();
	await runToRejection(workflow.id, step.id);
	const recovery = getRunningRecovery(workflow.id)!;
	// The agent reopened the step but never relaunched.
	const token = tokenFromPrompt(dispatchesTo(`${workflow.agentName}-recovery`)[0]!.body.input!);
	assert.equal((await api("POST", `/api/recovery/${workflow.id}/steps/${step.id}/reopen`, { reason: "try" }, bearer(token))).status, 200);
	// awb's started + result callbacks, through the hub's real routes.
	assert.equal((await fetch(`${hub}/api/recoveries/${recovery.id}/started?token=wrong`, { method: "POST" })).status, 401);
	const startedRes = await fetch(`${hub}/api/recoveries/${recovery.id}/started?token=${recovery.callbackToken}`, { method: "POST" });
	assert.equal(startedRes.status, 200);
	const res = await fetch(`${hub}/api/recoveries/${recovery.id}/result?token=${recovery.callbackToken}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ok: true, result: "I cannot write files in read-only mode." }),
	});
	assert.equal(res.status, 200);
	await until(() => getWorkflow(workflow.id)?.status === "failed");
	const failed = getStep(step.id)!;
	assert.equal(failed.status, "failed", "a reopened step goes back to failed");
	assert.equal(failed.recoveryCount, 1);
	const gaveUp = recoveryEvents(workflow.id).find((e) => e.action === "gave_up")!;
	assert.ok(gaveUp);
	assert.match(String(gaveUp.reason), /without relaunching.*read-only/);
	await until(() => listRecoveries(workflow.id)[0]?.notification != null);
	assert.ok(logs.some((l) => /recovery give-up notification not sent/.test(l)));
	assert.ok(db.listStepNotes(step.id).some((n) => n.content.startsWith("Recovery gave up:")));
	assert.equal((await api("GET", `/api/recovery/${workflow.id}`, undefined, bearer(token))).status, 403, "expired");
});

test("give up: the recovery run fails, or the agent asks to give up", async () => {
	const a = judgedWorkflow();
	await runToRejection(a.workflow.id, a.step.id);
	const ra = getRunningRecovery(a.workflow.id)!;
	await workflowApi.onRecoveryResult(ra.id, { ok: false, error: "usage limit reached" }, log);
	assert.equal(getWorkflow(a.workflow.id)?.status, "failed");
	assert.match(String(recoveryEvents(a.workflow.id).at(-1)!.reason), /recovery run failed: usage limit reached/);

	const b = judgedWorkflow();
	await runToRejection(b.workflow.id, b.step.id);
	const token = tokenFromPrompt(dispatchesTo(`${b.workflow.agentName}-recovery`)[0]!.body.input!);
	assert.equal((await api("POST", `/api/recovery/${b.workflow.id}/give-up`, {}, bearer(token))).status, 400, "a reason is required");
	const gave = await api("POST", `/api/recovery/${b.workflow.id}/give-up`, { reason: "the machine has no network" }, bearer(token));
	assert.equal(gave.status, 200);
	assert.equal(getWorkflow(b.workflow.id)?.status, "failed");
	assert.equal(getStep(b.step.id)?.status, "failed");
	assert.match(String(recoveryEvents(b.workflow.id).at(-1)!.reason), /the machine has no network/);
});

test("cap: with recoveryCount at maxRecoveries, a reopened step that fails again gets no new recovery", async () => {
	const { workflow, step } = judgedWorkflow({ maxRecoveries: 1 });
	await runToRejection(workflow.id, step.id);
	await api("POST", `/api/workflows/${workflow.id}/recovery/abort`);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	assert.equal(getStep(step.id)?.recoveryCount, 1);
	const before = recoveryEvents(workflow.id).length;

	open().prepare("UPDATE steps SET retry_count = 3 WHERE id = ?").run(step.id);
	const reopened = await api("POST", `/api/workflows/${workflow.id}/steps/${step.id}/reopen`);
	assert.equal(reopened.status, 200);
	const reopenedStep = reopened.json.step as Record<string, unknown>;
	assert.equal(reopenedStep.status, "pending");
	assert.equal(reopenedStep.retryCount, 0);
	assert.equal(reopenedStep.recoveryCount, 1);
	assert.equal(getWorkflow(workflow.id)?.status, "draft", "the workflow can be started again");
	assert.equal((await api("POST", `/api/workflows/${workflow.id}/steps/${step.id}/reopen`)).status, 400, "only a failed step reopens");

	await runToRejection(workflow.id, step.id);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	assert.equal(getStep(step.id)?.recoveryCount, 1);
	assert.equal(recoveryEvents(workflow.id).length, before, "no new step.recovery event");
	assert.equal(dispatchesTo(`${workflow.agentName}-recovery`).length, 1, "no new recovery job");
	assert.equal(getStep(step.id)?.sessionId, "session-main");
});

test("maxRecoveries 2 allows a second recovery; restart resets recoveryCount", async () => {
	const { workflow, step } = judgedWorkflow({ maxRecoveries: 2 });
	await runToRejection(workflow.id, step.id);
	let token = tokenFromPrompt(dispatchesTo(`${workflow.agentName}-recovery`).at(-1)!.body.input!);
	await api("POST", `/api/recovery/${workflow.id}/relaunch`, { summary: "again" }, bearer(token));
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	await onStepResult(step.id, { ok: true, result: "again", sessionId: "session-main" }, cfg, log);
	await onStepResult(step.id, { ok: true, result: JSON.stringify({ ok: false, reason: "still wrong" }), sessionId: "session-main" }, cfg, log);
	assert.equal(getWorkflow(workflow.id)?.status, "recovering");
	assert.equal(getStep(step.id)?.recoveryCount, 2);
	token = tokenFromPrompt(dispatchesTo(`${workflow.agentName}-recovery`).at(-1)!.body.input!);
	await api("POST", `/api/recovery/${workflow.id}/give-up`, { reason: "enough" }, bearer(token));
	assert.equal(getWorkflow(workflow.id)?.status, "failed");

	await restartWorkflow(workflow.id, cfg, log, [step.id]);
	assert.equal(getStep(step.id)?.recoveryCount, 0, "restart resets the recovery budget");
});

test("toggle off: the judge's final rejection fails the workflow exactly as before — no recovery", async () => {
	const { workflow, step } = judgedWorkflow({ recoverOnFailure: false });
	await runToRejection(workflow.id, step.id);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	assert.equal(getStep(step.id)?.recoveryCount, 0);
	assert.equal(recoveryEvents(workflow.id).length, 0);
	assert.equal(listRecoveries(workflow.id).length, 0);
	assert.equal(dispatchesTo(`${workflow.agentName}-recovery`).length, 0);
	assert.equal(readHooks()[`${workflow.agentName}-recovery`], undefined, "no recovery hook is even written");
});

test("infrastructure failures never trigger a recovery", async () => {
	const noRecovery = (workflowId: string) => {
		assert.equal(listRecoveries(workflowId).length, 0, "no recovery");
		assert.equal(recoveryEvents(workflowId).length, 0, "no step.recovery event");
	};

	// The judge could not run.
	{
		const { workflow, step } = judgedWorkflow();
		await startWorkflow(workflow.id, cfg, log, [step.id]);
		await onStepResult(step.id, { ok: true, result: "done", sessionId: "s" }, cfg, log);
		await onStepResult(step.id, { ok: false, error: "judge crashed" }, cfg, log);
		assert.equal(getWorkflow(workflow.id)?.status, "failed");
		noRecovery(workflow.id);
	}
	// An unparseable verdict.
	{
		const { workflow, step } = judgedWorkflow();
		await startWorkflow(workflow.id, cfg, log, [step.id]);
		await onStepResult(step.id, { ok: true, result: "done", sessionId: "s" }, cfg, log);
		await onStepResult(step.id, { ok: true, result: "I think it is fine", sessionId: "s" }, cfg, log);
		assert.equal(getWorkflow(workflow.id)?.status, "failed");
		noRecovery(workflow.id);
	}
	// The run itself failed (a usage limit is one of these).
	{
		const { workflow, step } = judgedWorkflow();
		await startWorkflow(workflow.id, cfg, log, [step.id]);
		await onStepResult(step.id, { ok: false, error: "You've hit your usage limit" }, cfg, log);
		assert.equal(getWorkflow(workflow.id)?.status, "failed");
		noRecovery(workflow.id);
	}
	// The hook is down (dispatch failure).
	{
		const { workflow, step } = judgedWorkflow();
		open().prepare("UPDATE workflows SET hook_url = ? WHERE id = ?").run("http://127.0.0.1:9/hook/nobody", workflow.id);
		await startWorkflow(workflow.id, cfg, log, [step.id]);
		assert.equal(getStep(step.id)?.status, "failed");
		expireStale(cfg, log);
		assert.equal(getWorkflow(workflow.id)?.status, "failed");
		noRecovery(workflow.id);
	}
	// An operator abort.
	{
		const { workflow, step } = judgedWorkflow();
		await startWorkflow(workflow.id, cfg, log, [step.id]);
		await abortStep(workflow.id, step.id, log);
		assert.equal(getWorkflow(workflow.id)?.status, "failed");
		noRecovery(workflow.id);
	}
	// An untrusted pipeline is refused before anything runs.
	{
		const workflow = createWorkflow(`untrusted ${++seq}`, { workdir: freshWorkdir() });
		const pipeline = insertPipeline({ source: `name: untrusted-${seq}\nsteps:\n  - run: echo hi\n`, approve: false });
		const step = addStep(workflow.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {}, recoverOnFailure: true });
		await startWorkflow(workflow.id, cfg, log, [step.id]);
		await until(() => getStep(step.id)?.status === "failed");
		assert.match(getStep(step.id)?.error ?? "", /not trusted/);
		assert.equal(getWorkflow(workflow.id)?.status, "failed");
		noRecovery(workflow.id);
	}
});

test("a command step's final failure (pipeline ran and failed, no retries) triggers a recovery", async () => {
	const workflow = createWorkflow(`command ${++seq}`, { workdir: freshWorkdir(), runner: "claude" });
	const pipeline = insertPipeline({ source: `name: failing-${seq}\nsteps:\n  - run: exit 3\n`, approve: true });
	const step = addStep(workflow.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {}, maxRetries: 0, recoverOnFailure: true });
	await startWorkflow(workflow.id, cfg, log, [step.id]);
	await until(() => getWorkflow(workflow.id)?.status === "recovering", 15_000);
	const recovery = getRunningRecovery(workflow.id)!;
	assert.equal(recovery.failureKind, "command_failed");
	assert.match(recovery.reason, /pipeline failed/);
	assert.equal(getStep(step.id)?.recoveryCount, 1);
	await until(() => dispatchesTo(`${workflow.agentName}-recovery`).length === 1);
	const prompt = dispatchesTo(`${workflow.agentName}-recovery`)[0]!.body.input!;
	assert.match(prompt, /pipelineInputs/);
	// A command step's pipelineInputs are a recovery's to edit (the pipeline declares none, so an unknown input is refused).
	const token = tokenFromPrompt(prompt);
	const bad = await api("PATCH", `/api/recovery/${workflow.id}/steps/${step.id}`, { reason: "r", pipelineInputs: { nope: "1" } }, bearer(token));
	assert.equal(bad.status, 400);
	await api("POST", `/api/workflows/${workflow.id}/recovery/abort`);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
});

test("a timeout with no retries left triggers a recovery; the watchdog gives up a hung recovery", async () => {
	const { workflow, step } = judgedWorkflow();
	await startWorkflow(workflow.id, cfg, log, [step.id]);
	db.promoteQueuedToRunning(step.id);
	open().prepare("UPDATE steps SET started_at = ?, last_progress_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", step.id);
	const shortCfg = { ...cfg, stepHardTimeoutMs: 1_000, stepIdleTimeoutMs: 1_000 };
	expireStale(shortCfg, log);
	assert.equal(getWorkflow(workflow.id)?.status, "recovering");
	const recovery = getRunningRecovery(workflow.id)!;
	assert.equal(recovery.failureKind, "timeout");
	assert.match(recovery.reason, /timeout/);
	assert.equal(getStep(step.id)?.recoveryCount, 1);
	await until(() => dispatchesTo(`${workflow.agentName}-recovery`).length === 1);

	// The recovery itself hangs past the hard timeout → gave up.
	open().prepare("UPDATE recoveries SET started_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", recovery.id);
	expireStale(shortCfg, log);
	await until(() => getWorkflow(workflow.id)?.status === "failed");
	assert.match(String(recoveryEvents(workflow.id).at(-1)!.reason), /timed out/);
});

test("a ▶ manual run's final judge rejection also triggers a recovery", async () => {
	const { workflow, step } = judgedWorkflow();
	await runStep(workflow.id, step.id, cfg, log);
	await onStepResult(step.id, { ok: true, result: "hello", sessionId: "s-manual" }, cfg, log);
	await onStepResult(step.id, { ok: true, result: JSON.stringify({ ok: false, reason: "says hello" }), sessionId: "s-manual" }, cfg, log);
	assert.equal(getWorkflow(workflow.id)?.status, "recovering");
	assert.equal(getRunningRecovery(workflow.id)?.failureKind, "judge_rejected");
	await api("POST", `/api/workflows/${workflow.id}/recovery/abort`);
});

test("recovery history route hides the token hash and callback token", async () => {
	const { workflow, step } = judgedWorkflow();
	await runToRejection(workflow.id, step.id);
	const detail = await api("GET", `/api/workflows/${workflow.id}`);
	const running = (detail.json.workflow as Record<string, unknown>).recovery as Record<string, unknown>;
	assert.equal(running.status, "running");
	assert.equal(running.stepId, step.id);
	const history = await api("GET", `/api/workflows/${workflow.id}/recoveries`);
	const list = history.json.recoveries as Record<string, unknown>[];
	assert.equal(list.length, 1);
	assert.equal("tokenHash" in list[0]!, false);
	assert.equal("callbackToken" in list[0]!, false);
	await api("POST", `/api/workflows/${workflow.id}/recovery/abort`);
	assert.equal(((await api("GET", `/api/workflows/${workflow.id}`)).json.workflow as Record<string, unknown>).recovery, null);
});

// --- an on-success agent fails its own attempt (fail_attempt) ------------------

/** A command step whose pipeline passes and whose on-success agent then judges the run. */
function passingCommandWorkflow(options: { maxRetries: number; recoverOnFailure: boolean }) {
	const workflow = createWorkflow(`fail-attempt ${++seq}`, { workdir: freshWorkdir(), runner: "claude" });
	const pipeline = insertPipeline({ source: `name: passing-${seq}\nsteps:\n  - run: echo qa\n`, approve: true });
	const step = addStep(workflow.id, "", {
		kind: "command",
		pipelineId: pipeline.id,
		pipelineInputs: {},
		onSuccessTask: "Check the QA output; if a case failed, call fail_attempt.",
		maxRetries: options.maxRetries,
		recoverOnFailure: options.recoverOnFailure,
	});
	return { workflow, step };
}

async function untilOnSuccessAgent(stepId: string, attempt: number): Promise<void> {
	await until(() => {
		const s = getStep(stepId);
		return s?.status === "running" && s.phase === "on_success" && s.retryCount === attempt;
	}, 15_000);
}

test("fail_attempt: refused unless the step's on-success agent is running", async () => {
	const { workflow, step } = passingCommandWorkflow({ maxRetries: 0, recoverOnFailure: true });
	const before = await api("POST", `/api/workflows/${workflow.id}/steps/${step.id}/fail-attempt`, { reason: "too early" });
	assert.equal(before.status, 400);
	assert.match(String(before.json.error), /on-success agent/);
	const judged = judgedWorkflow();
	const agentStep = await api("POST", `/api/workflows/${judged.workflow.id}/steps/${judged.step.id}/fail-attempt`, { reason: "x" });
	assert.equal(agentStep.status, 400);
	await startWorkflow(workflow.id, cfg, log, [step.id]);
	await untilOnSuccessAgent(step.id, 0);
	const empty = await api("POST", `/api/workflows/${workflow.id}/steps/${step.id}/fail-attempt`, { reason: "  " });
	assert.equal(empty.status, 400);
	assert.match(String(empty.json.error), /reason is required/);
	// Without a request the turn ends as it always did: the step is done.
	await onStepResult(step.id, { ok: true, result: "all cases passed", sessionId: "s-ok" }, cfg, log);
	assert.equal(getStep(step.id)?.status, "done");
});

test("fail_attempt on the last attempt starts Failure recovery (command_failed) with the agent's reason", async () => {
	const { workflow, step } = passingCommandWorkflow({ maxRetries: 0, recoverOnFailure: true });
	await startWorkflow(workflow.id, cfg, log, [step.id]);
	await untilOnSuccessAgent(step.id, 0);
	const res = await api("POST", `/api/workflows/${workflow.id}/steps/${step.id}/fail-attempt`, { reason: "S6 failed at 390 px" });
	assert.equal(res.status, 200);
	// Nothing settles until the agent's turn ends.
	assert.equal(getStep(step.id)?.status, "running");
	await onStepResult(step.id, { ok: true, result: "QA failed: S6", sessionId: "s-qa" }, cfg, log);
	assert.equal(getWorkflow(workflow.id)?.status, "recovering");
	const recovery = getRunningRecovery(workflow.id)!;
	assert.equal(recovery.failureKind, "command_failed");
	assert.match(recovery.reason, /on-success agent failed the attempt: S6 failed at 390 px/);
	const failed = getStep(step.id)!;
	assert.equal(failed.status, "failed");
	assert.equal(failed.recoveryCount, 1);
	assert.match(failed.result ?? "", /QA failed: S6/);
	await api("POST", `/api/workflows/${workflow.id}/recovery/abort`);
});

test("fail_attempt with retries left re-runs the pipeline; a later clean turn completes the step", async () => {
	const { workflow, step } = passingCommandWorkflow({ maxRetries: 1, recoverOnFailure: true });
	await startWorkflow(workflow.id, cfg, log, [step.id]);
	await untilOnSuccessAgent(step.id, 0);
	await api("POST", `/api/workflows/${workflow.id}/steps/${step.id}/fail-attempt`, { reason: "C3 failed" });
	await onStepResult(step.id, { ok: true, result: "QA failed: C3", sessionId: "s-1" }, cfg, log);
	// The retry runs the pipeline again, then the on-success agent again.
	await untilOnSuccessAgent(step.id, 1);
	assert.equal(getRunningRecovery(workflow.id), null);
	await onStepResult(step.id, { ok: true, result: "all cases passed", sessionId: "s-2" }, cfg, log);
	assert.equal(getStep(step.id)?.status, "done");
	assert.equal(getStep(step.id)?.recoveryCount, 0);
});

test("fail_attempt with the toggle off fails the workflow, no recovery", async () => {
	const { workflow, step } = passingCommandWorkflow({ maxRetries: 0, recoverOnFailure: false });
	await startWorkflow(workflow.id, cfg, log, [step.id]);
	await untilOnSuccessAgent(step.id, 0);
	await api("POST", `/api/workflows/${workflow.id}/steps/${step.id}/fail-attempt`, { reason: "S1 failed" });
	await onStepResult(step.id, { ok: true, result: "QA failed: S1", sessionId: "s-off" }, cfg, log);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	assert.equal(getStep(step.id)?.status, "failed");
	assert.equal(recoveryEvents(workflow.id).length, 0);
});

test("hub-written notes are reported as step.note.added: the fail request and the recovery trace", async () => {
	const { workflow, step } = passingCommandWorkflow({ maxRetries: 0, recoverOnFailure: true });
	await startWorkflow(workflow.id, cfg, log, [step.id]);
	await untilOnSuccessAgent(step.id, 0);
	await api("POST", `/api/workflows/${workflow.id}/steps/${step.id}/fail-attempt`, { reason: "S7 failed" });
	await onStepResult(step.id, { ok: true, result: "QA failed: S7", sessionId: "s-n" }, cfg, log);
	await until(() => dispatchesTo(`${workflow.agentName}-recovery`).length === 1);
	const token = tokenFromPrompt(dispatchesTo(`${workflow.agentName}-recovery`)[0]!.body.input!);
	const edit = await api("PATCH", `/api/recovery/${workflow.id}/steps/${step.id}`, { reason: "give it one more try", maxRetries: 1 }, bearer(token));
	assert.equal(edit.status, 200);
	const relaunch = await api("POST", `/api/recovery/${workflow.id}/relaunch`, { summary: "one more retry" }, bearer(token));
	assert.equal(relaunch.status, 200);
	const noteEvents = events(workflow.id, "step.note.added");
	const contents = noteEvents.map((e) => String(e.content));
	assert.ok(contents.some((c) => c.startsWith("On-success agent failed this attempt: S7 failed")), "the fail request's note is reported");
	assert.ok(contents.some((c) => c.startsWith("Recovery: maxRetries: 0 → 1")), "the recovery's before → after note is reported");
	assert.ok(contents.some((c) => c.startsWith("Recovery relaunched the workflow")), "the relaunch note is reported");
	assert.ok(noteEvents.every((e) => e.step_id === step.id && e.source === "agent"));
});
