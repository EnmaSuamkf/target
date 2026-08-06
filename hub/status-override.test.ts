/**
 * Tests for the manual status override: forcing a step's status, and forcing a
 * workflow's, by hand.
 *
 * The case it exists for is one the engine cannot see. The agent really did the
 * work, but the run was cut short (out of tokens) or its result callback never
 * arrived, so the step is recorded `failed` — and because a workflow's status is
 * derived from its steps, the whole workflow reads `failed` too. Every status in
 * this engine is otherwise derived, and there was no way to say otherwise.
 *
 * What's worth pinning down, and why:
 *
 *  - **an override is not a run.** Correcting a `failed` step to `done` must not
 *    re-dispatch it, and must not advance the workflow. That's the one way this
 *    feature could corrupt the sequential chain, so it's tested against a fake
 *    hook that counts dispatches;
 *  - **it survives the read path.** `reconcileStatus` runs on every workflow GET
 *    (~every 2s with the UI open); without the pin, a corrected workflow would
 *    flip back to `failed` on the next poll. This is the test that would have
 *    caught "it works, then undoes itself";
 *  - **but it does not survive a re-run.** Once the engine authors a status
 *    again, the steps are telling the truth and the pin is gone;
 *  - **the derived views follow.** Progress %, the .md file and the workflow
 *    badge all have to agree with the corrected status, or the override just
 *    moves the contradiction somewhere else;
 *  - **the in-flight guard holds.** A step with a callback still coming is the
 *    one state an override must refuse, at both the engine and the HTTP layer.
 *
 * Same throwaway-TARGET_HOME + fake-awb-hook convention as manual-review.test.ts,
 * including seeding a pre-migration `steps`/`workflows` pair so importing db.ts
 * runs the real `addColumn` upgrade path rather than the fresh-install one.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-status-override-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

/**
 * A database as it looked BEFORE `status_manual`/`status_manual_at` existed, on
 * BOTH tables — the override is the first feature to add a column to
 * `workflows` and `steps` in the same change, so the upgrade path for each is
 * part of the setup rather than a special case.
 */
const legacyDbFile = path.join(tmpHome, "target.db");
{
	fs.mkdirSync(path.dirname(legacyDbFile), { recursive: true });
	const legacy = new DatabaseSync(legacyDbFile);
	legacy.exec(`
		CREATE TABLE workflows (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			agent_name TEXT NOT NULL UNIQUE,
			hook_url TEXT NOT NULL,
			secret TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			last_session_id TEXT,
			md_path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE steps (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			order_index INTEGER NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			error TEXT,
			session_id TEXT,
			callback_token TEXT NOT NULL,
			created_at TEXT NOT NULL,
			started_at TEXT,
			finished_at TEXT
		);
	`);
	const now = new Date().toISOString();
	legacy
		.prepare(
			"INSERT INTO workflows (id, name, agent_name, hook_url, secret, status, md_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("legacy-wf", "from before the override", "legacy-agent", "http://127.0.0.1:1/hook", "s", "failed", path.join(tmpHome, "legacy.md"), now, now);
	legacy
		.prepare("INSERT INTO steps (id, workflow_id, order_index, description, status, callback_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run("legacy-step", "legacy-wf", 0, "a step from before the override existed", "failed", "tok", now);
	legacy.close();
}

const {
	completeStep,
	getStep,
	getWorkflow,
	insertStep,
	insertWorkflow,
	listSteps,
	markStepRunning,
	overrideStepStatus,
	setWorkflowStatus,
	startManualRun,
	stepProgress,
	OVERRIDABLE_STEP_STATUSES,
	OVERRIDABLE_WORKFLOW_STATUSES,
} = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const {
	expireStale,
	forceStepStatus,
	forceWorkflowStatus,
	onStepResult,
	restartWorkflow,
	startWorkflow,
	writeStatusMd,
	WorkflowError,
} = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

/**
 * A fake awb hook that swallows dispatches (answers ok, never calls back) and
 * COUNTS them — the count is what proves an override didn't secretly run
 * anything.
 */
function startFakeHook() {
	const state = { dispatches: 0 };
	const server = http.createServer((req, res) => {
		state.dispatches += 1;
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	return new Promise<{ server: http.Server; url: string; state: { dispatches: number } }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
			resolve({ server, url: `http://127.0.0.1:${addr.port}/hook/agent`, state });
		});
	});
}

/** A running fake hook, closed when the test ends. */
async function hook(t: { after: (fn: () => void) => void }): Promise<{ url: string; state: { dispatches: number } }> {
	const { server, url, state } = await startFakeHook();
	t.after(() => server.close());
	return { url, state };
}

/**
 * Records a step as failed the way a real run does — `markStepRunning` then the
 * result callback's own `completeStep` — so every test starts from the
 * situation the override exists for rather than from an invented row.
 */
function onFailed(stepId: string, error: string): void {
	markStepRunning(stepId);
	completeStep(stepId, { ok: false, error });
}

function makeWorkflow(hookUrl: string, stepCount: number) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	const steps = Array.from({ length: stepCount }, (_, i) => insertStep(id, `step ${i + 1}`));
	return { workflow, steps };
}

// --- the migration ------------------------------------------------------

test("the status_manual columns are added to a DB created without them, and old rows read as engine-set", () => {
	// The legacy rows survived both ALTER TABLEs and default to "the engine set
	// this" — an upgraded hub must not claim a human touched statuses nobody did.
	const step = getStep("legacy-step");
	assert.ok(step, "the pre-migration step is still readable");
	assert.equal(step?.status, "failed");
	assert.equal(step?.statusManual, false);
	assert.equal(step?.statusManualAt, null);

	const workflow = getWorkflow("legacy-wf");
	assert.ok(workflow, "the pre-migration workflow is still readable");
	assert.equal(workflow?.statusManual, false);
	assert.equal(workflow?.statusManualAt, null);
});

test("a pre-migration workflow can be corrected by hand like any other", () => {
	forceStepStatus("legacy-wf", "legacy-step", "done", silent);
	forceWorkflowStatus("legacy-wf", "completed", silent);
	assert.equal(getStep("legacy-step")?.status, "done");
	assert.equal(getWorkflow("legacy-wf")?.status, "completed");
	assert.equal(getWorkflow("legacy-wf")?.statusManual, true);
});

// --- the step override --------------------------------------------------

test("a failed step forced to done is marked manual, keeps its finish time and drops its error", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 2);
	// The state the feature exists for: the run answered "failed" even though the
	// work landed.
	onFailed(steps[0].id, "ran out of tokens");
	const failedAt = getStep(steps[0].id)?.finishedAt;
	assert.ok(failedAt, "the failure stamped a finish time");

	const updated = forceStepStatus(workflow.id, steps[0].id, "done", silent);

	assert.equal(updated.status, "done");
	assert.equal(updated.statusManual, true);
	assert.ok(updated.statusManualAt, "the override is timestamped");
	// A red error body under a green badge is the contradiction this removes.
	assert.equal(updated.error, null);
	// The run really did end then — the override changes the verdict, not history.
	assert.equal(updated.finishedAt, failedAt);
});

test("a step forced to failed without an error of its own gets one that says a human set it", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	const updated = forceStepStatus(workflow.id, steps[0].id, "failed", silent);
	assert.equal(updated.status, "failed");
	assert.match(String(updated.error), /manual/i);
});

test("a step forced back to pending loses its finish time — it hasn't finished", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	onFailed(steps[0].id, "nope");
	const updated = forceStepStatus(workflow.id, steps[0].id, "pending", silent);
	assert.equal(updated.status, "pending");
	assert.equal(updated.finishedAt, null);
	assert.equal(updated.error, null);
	assert.equal(updated.statusManual, true);
});

test("an override never re-dispatches the step, and never advances the workflow", async (t) => {
	const { url, state } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 3);

	// Step 1 fails mid-run, which fails the workflow — the whole scenario.
	await startWorkflow(workflow.id, cfg, silent, steps.map((s) => s.id));
	await onStepResult(steps[0].id, { ok: false, error: "context window exhausted" }, cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	const dispatchesBefore = state.dispatches;

	forceStepStatus(workflow.id, steps[0].id, "done", silent);

	// Nothing was sent to the agent: not the corrected step (it isn't `pending`,
	// so the engine can't pick it) and not the next one (only `advance` dispatches,
	// and an override never calls it).
	assert.equal(state.dispatches, dispatchesBefore, "no job was dispatched by the override");
	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(getStep(steps[1].id)?.status, "pending");
});

test("correcting the last failed step clears the workflow's failed badge on its own", async (t) => {
	const { url } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 2);

	await startWorkflow(workflow.id, cfg, silent, steps.map((s) => s.id));
	await onStepResult(steps[0].id, { ok: true, result: "done" }, cfg, silent);
	await onStepResult(steps[1].id, { ok: false, error: "callback lost" }, cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");

	forceStepStatus(workflow.id, steps[1].id, "done", silent);

	// The workflow's status is a function of its steps, so it follows without a
	// second action — that's the point of reconciling after an override.
	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(stepProgress(workflow.id).pct, 100, "a manually-done step counts towards progress");
	assert.equal(stepProgress(workflow.id).failed, 0);
});

test("a step with a job in flight refuses the override — abort it first", async (t) => {
	const { url } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 2);
	markStepRunning(steps[0].id);

	assert.throws(
		() => forceStepStatus(workflow.id, steps[0].id, "done", silent),
		(err: unknown) => err instanceof WorkflowError && /in flight/.test((err as Error).message),
	);
	assert.equal(getStep(steps[0].id)?.status, "running", "the running step was left alone");

	// Queued is the same rule: the broker accepted it and a callback is coming.
	startManualRun(steps[1].id);
	assert.equal(getStep(steps[1].id)?.status, "queued");
	assert.throws(() => forceStepStatus(workflow.id, steps[1].id, "done", silent), WorkflowError);
	assert.equal(getStep(steps[1].id)?.status, "queued", "the queued step was left alone");
});

test("only the settled statuses can be forced onto a step", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	for (const status of ["running", "queued", "waiting", "nonsense"]) {
		assert.throws(
			// The engine owns these; asserting one would leave a step no callback settles.
			() => forceStepStatus(workflow.id, steps[0].id, status as never, silent),
			WorkflowError,
			`${status} must be refused`,
		);
	}
	assert.deepEqual([...OVERRIDABLE_STEP_STATUSES], ["pending", "done", "failed"]);
});

test("a manually-set step status is cleared the moment the step runs again", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	forceStepStatus(workflow.id, steps[0].id, "done", silent);
	assert.equal(getStep(steps[0].id)?.statusManual, true);

	// An on-demand ▶ run re-authors the status, so the human's marker is stale.
	startManualRun(steps[0].id);
	assert.equal(getStep(steps[0].id)?.statusManual, false);
	assert.equal(getStep(steps[0].id)?.statusManualAt, null);
});

test("an unknown step or a step from another workflow is refused", () => {
	const a = makeWorkflow("http://127.0.0.1:1/hook", 1);
	const b = makeWorkflow("http://127.0.0.1:1/hook", 1);
	assert.throws(() => forceStepStatus(a.workflow.id, "no-such-step", "done", silent), WorkflowError);
	assert.throws(() => forceStepStatus(a.workflow.id, b.steps[0].id, "done", silent), WorkflowError);
	assert.throws(() => forceStepStatus("no-such-workflow", a.steps[0].id, "done", silent), WorkflowError);
});

// --- the workflow override ----------------------------------------------

test("a workflow forced to completed stays completed across reads, even with a failed step", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 2);
	onFailed(steps[0].id, "the callback never landed");
	setWorkflowStatus(workflow.id, "failed");

	forceWorkflowStatus(workflow.id, "completed", silent);
	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(getWorkflow(workflow.id)?.statusManual, true);

	// The read-path heal runs on every workflow GET. Without the pin this would
	// derive `failed` from the still-failed step and undo the correction on the
	// next 2-second poll.
	expireStale(cfg, silent);
	expireStale(cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "completed", "the override survived the read-path heal");
});

test("an override does not survive a re-run — the engine owns the status again", async (t) => {
	const { url } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 1);
	onFailed(steps[0].id, "boom");
	setWorkflowStatus(workflow.id, "failed");
	forceWorkflowStatus(workflow.id, "completed", silent);
	assert.equal(getWorkflow(workflow.id)?.statusManual, true);

	await restartWorkflow(workflow.id, cfg, silent, [steps[0].id]);

	assert.equal(getWorkflow(workflow.id)?.statusManual, false, "the pin is gone once the engine writes a status");
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	assert.equal(getStep(steps[0].id)?.statusManual, false);
});

test("a workflow override is refused while a step is in flight", async (t) => {
	const { url } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 2);
	await startWorkflow(workflow.id, cfg, silent, steps.map((s) => s.id));
	assert.ok(
		listSteps(workflow.id).some((s) => s.status === "queued" || s.status === "running"),
		"a step is in flight after Start",
	);

	assert.throws(
		() => forceWorkflowStatus(workflow.id, "completed", silent),
		(err: unknown) => err instanceof WorkflowError && /in flight/.test((err as Error).message),
	);
	assert.equal(getWorkflow(workflow.id)?.status, "running");
});

test("only the non-engine statuses can be forced onto a workflow", () => {
	const { workflow } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	for (const status of ["running", "waiting", "nonsense"]) {
		assert.throws(() => forceWorkflowStatus(workflow.id, status as never, silent), WorkflowError, `${status} must be refused`);
	}
	assert.deepEqual([...OVERRIDABLE_WORKFLOW_STATUSES], ["draft", "paused", "completed", "failed"]);
});

// --- the derived views --------------------------------------------------

test("the progress .md says which statuses a human set", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 2);
	forceStepStatus(workflow.id, steps[0].id, "done", silent);
	forceWorkflowStatus(workflow.id, "completed", silent);
	writeStatusMd(workflow.id);

	const md = fs.readFileSync(getWorkflow(workflow.id)!.mdPath, "utf8");
	assert.match(md, /- Status: completed \(set manually/);
	assert.match(md, /Status set manually/);
	// The step that nobody touched must not be annotated.
	assert.equal(md.match(/Status set manually/g)?.length, 1);
});

// --- the HTTP surface ---------------------------------------------------

const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
test.after(() => server.close());

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

test("POST /api/workflows/:id/steps/:stepId/status needs the admin token", async () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps/${steps[0].id}/status`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ status: "done" }),
	});
	assert.equal(res.status, 401);
	assert.equal(getStep(steps[0].id)?.status, "pending");
});

test("POST /api/workflows/:id/steps/:stepId/status sets the status and reports it as manual", async () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	onFailed(steps[0].id, "out of tokens");

	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps/${steps[0].id}/status`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ status: "done" }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { step: { status: string; statusManual: boolean; statusManualAt: string } };
	assert.equal(body.step.status, "done");
	assert.equal(body.step.statusManual, true);
	assert.ok(body.step.statusManualAt);
});

test("POST /api/workflows/:id/steps/:stepId/status rejects a status the engine owns", async () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps/${steps[0].id}/status`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ status: "running" }),
	});
	assert.equal(res.status, 400);
	assert.match(String(((await res.json()) as { error: string }).error), /status must be one of/);
});

test("POST /api/workflows/:id/status needs the admin token", async () => {
	const { workflow } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/status`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ status: "completed" }),
	});
	assert.equal(res.status, 401);
});

test("POST /api/workflows/:id/status sets the status, and the detail route keeps reporting it", async () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	onFailed(steps[0].id, "the run died");
	setWorkflowStatus(workflow.id, "failed");

	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/status`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ status: "completed" }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workflow: { status: string; statusManual: boolean } };
	assert.equal(body.workflow.status, "completed");
	assert.equal(body.workflow.statusManual, true);

	// The GET runs the read-path heal, which is exactly where an unpinned
	// override would be undone — the UI polls this route every 2 seconds.
	const detail = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers: adminHeaders() });
	const detailBody = (await detail.json()) as { workflow: { status: string; statusManual: boolean } };
	assert.equal(detailBody.workflow.status, "completed");
	assert.equal(detailBody.workflow.statusManual, true);
});

test("POST /api/workflows/:id/status rejects an unknown workflow and an engine-owned status", async () => {
	const { workflow } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	const bad = await fetch(`${baseUrl}/api/workflows/${workflow.id}/status`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ status: "running" }),
	});
	assert.equal(bad.status, 400);

	const missing = await fetch(`${baseUrl}/api/workflows/no-such-workflow/status`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ status: "completed" }),
	});
	assert.equal(missing.status, 400);
});

// `overrideStepStatus` is the low-level writer `forceStepStatus` wraps: it is
// deliberately unguarded on the current status (the engine layer owns that
// rule), so what's pinned here is only that it stamps the marker and reports
// honestly when it matched no row.
test("overrideStepStatus writes the marker, and reports a miss", () => {
	const { steps } = makeWorkflow("http://127.0.0.1:1/hook", 1);
	assert.equal(overrideStepStatus(steps[0].id, "failed"), true);
	assert.equal(getStep(steps[0].id)?.statusManual, true);
	assert.equal(overrideStepStatus("no-such-step", "done"), false);
});
