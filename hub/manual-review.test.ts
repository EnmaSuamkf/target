/**
 * Tests for the per-step "Manual review" gate: a step flagged `manualReview`
 * that finishes its work (and passes its judge, if it has one) does NOT go
 * `done`. It goes `waiting`, its workflow goes `waiting`, and nothing else moves
 * until a human continues it — at which point the step completes and the engine
 * resumes exactly where it stopped.
 *
 * What's worth pinning down, and why:
 *
 *  - the gate hooks into BOTH accept paths (no-judge exec, and an `ok` verdict),
 *    and into neither failure path (a reject still retries/fails as before);
 *  - the hold is inert to everything the operator did NOT aim at it — ▶ run,
 *    Edit, Start and the timeout watchdog must all leave a `waiting` step alone,
 *    so a step can sit there for as long as the human takes;
 *  - the three deliberate answers to a hold all work: Continue approves it,
 *    Abort refuses it and stops the workflow, and a step added after the held one
 *    is what Continue then dispatches;
 *  - the notification is advisory: a delivery that fails must not change the
 *    state the engine just wrote.
 *
 * Same throwaway-TARGET_HOME + fake-awb-hook convention as abort.test.ts: the
 * fake hook answers `{ok:true}` and never calls back, so a dispatched step stays
 * `queued` — which is exactly what "the next step was dispatched" looks like
 * here, and `onStepResult` accepts a callback for a `queued` step.
 *
 * `CLAUDE_CONFIG_DIR` is pointed at the same throwaway dir so the notifier's
 * Slack detection can never see the operator's real credentials (it finds no
 * file and reports the MCP unavailable). Notifications are off by default in a
 * fresh DB anyway, so nothing in here reaches the network.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-manual-review-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

// Never let a developer's real Slack session become a transport in tests: with
// these exported, an unstubbed path would attempt an actual DM.
for (const suffix of ["XOXC", "XOXD"]) {
	for (const prefix of ["TARGET_SLACK_", "SLACK_MCP_", "SLACK_"]) delete process.env[`${prefix}${suffix}_TOKEN`];
}

/**
 * Seeds the DB file with a `steps` table as it looked BEFORE `manual_review`
 * existed, so importing db.ts below runs the real upgrade path (`addColumn`)
 * rather than the fresh-install one. Every test in this file then runs against
 * that migrated database — the migration isn't a special case, it's the setup.
 */
const legacyDbFile = path.join(tmpHome, "target.db");
{
	fs.mkdirSync(path.dirname(legacyDbFile), { recursive: true });
	const legacy = new DatabaseSync(legacyDbFile);
	legacy.exec(`
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
	// A step written by that older hub, which has never heard of the gate.
	legacy
		.prepare("INSERT INTO steps (id, workflow_id, order_index, description, callback_token, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.run("legacy-step", "legacy-wf", 0, "a step from before the gate existed", "tok", new Date().toISOString());
	legacy.close();
}

const {
	getStep,
	getWorkflow,
	insertStep,
	insertWorkflow,
	listSteps,
	markStepRunning,
	saveNotificationSettings,
	setWorkflowStatus,
	startManualRun,
	takeStatusBeforeReview,
} = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { _impl: notifierImpl } = await import("./notifier.ts");
const {
	abortStep,
	addStep,
	continueStep,
	editStep,
	onStepResult,
	expireStale,
	restartWorkflow,
	runStep,
	startWorkflow,
	writeStatusMd,
} = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

/** A fake awb hook that swallows dispatches (answers ok, never calls back). */
function startFakeHook() {
	const server = http.createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	return new Promise<{ server: http.Server; url: string }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
			resolve({ server, url: `http://127.0.0.1:${addr.port}/hook/agent` });
		});
	});
}

interface StepOptions {
	acceptanceCriteria?: string | null;
	manualReview?: boolean;
	maxRetries?: number;
}

/** A workflow whose steps are described one options-object each, in order. */
function makeWorkflow(hookUrl: string, stepOptions: StepOptions[]) {
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
	const steps = stepOptions.map((options, i) => insertStep(id, `step ${i + 1}`, options));
	return { workflow, steps };
}

/** A running fake hook, closed when the test ends. */
async function hook(t: { after: (fn: () => void) => void }): Promise<string> {
	const { server, url } = await startFakeHook();
	t.after(() => server.close());
	return url;
}

const JUDGE_OK = '{"ok": true, "reason": "looks right"}';
const JUDGE_REJECT = '{"ok": false, "reason": "missing the X"}';

// --- the migration ------------------------------------------------------

test("the manual_review column is added to a DB created without it, and old rows read as not gated", () => {
	// The legacy row above survived the ALTER TABLE and defaults to "no gate" —
	// an upgraded hub must not suddenly hold workflows that never asked for it.
	const legacy = getStep("legacy-step");
	assert.ok(legacy, "the pre-migration step is still readable");
	assert.equal(legacy?.manualReview, false);
	assert.equal(legacy?.description, "a step from before the gate existed");
});

// --- persistence --------------------------------------------------------

test("manualReview survives insert → read, and defaults to off", () => {
	const { steps } = makeWorkflow("http://127.0.0.1:1/hook", [{}, { manualReview: true }]);
	assert.equal(getStep(steps[0].id)?.manualReview, false); // opt-in
	assert.equal(getStep(steps[1].id)?.manualReview, true);
	// Also on the object insertStep returns, not just on a re-read.
	assert.equal(steps[1].manualReview, true);
});

// --- the gate -----------------------------------------------------------

test("a step WITHOUT manual review still goes straight to done and dispatches the next step", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{}, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(getStep(steps[1].id)?.status, "queued"); // the engine moved on
	assert.equal(getWorkflow(workflow.id)?.status, "running");
});

test("a gated step with no acceptance criterion holds at waiting instead of done", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work", sessionId: "sess-1" }, cfg, silent);

	const held = getStep(steps[0].id);
	assert.equal(held?.status, "waiting");
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	// The next step was NOT dispatched — the gate stops the run dead.
	assert.equal(getStep(steps[1].id)?.status, "pending");
	// Nothing about the finished work is lost while it waits, and the step is
	// not "finished" — only Continue sets that.
	assert.equal(held?.result, "the work");
	assert.equal(held?.sessionId, "sess-1");
	assert.equal(held?.finishedAt, null);
	assert.equal(held?.error, null);
});

test("a gated step's exec FAILURE fails the workflow as usual — the gate only holds accepted work", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: false, error: "boom" }, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "failed");
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
});

test("a gated step WITH a criterion is judged first: a reject with budget left retries and never holds", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true, acceptanceCriteria: "must be X", maxRetries: 1 }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent); // exec → judge
	assert.equal(getStep(steps[0].id)?.phase, "judge");

	await onStepResult(steps[0].id, { ok: true, result: JUDGE_REJECT }, cfg, silent);

	// The normal retry path ran; the gate never saw this result.
	assert.equal(getStep(steps[0].id)?.retryCount, 1);
	assert.notEqual(getStep(steps[0].id)?.status, "waiting");
	assert.notEqual(getWorkflow(workflow.id)?.status, "waiting");
});

test("a gated step WITH a criterion rejected out of retries fails, and does not hold", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true, acceptanceCriteria: "must be X" }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: JUDGE_REJECT }, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "failed");
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
});

test("a gated step WITH a criterion accepted by the judge holds at waiting", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [
		{ manualReview: true, acceptanceCriteria: "must be X" },
		{},
	]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: JUDGE_OK }, cfg, silent);

	const held = getStep(steps[0].id);
	assert.equal(held?.status, "waiting");
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	assert.equal(getStep(steps[1].id)?.status, "pending");
	// The exec result (stored on the way into the judge phase) is what the human
	// reviews — the verdict text must not have overwritten it.
	assert.equal(held?.result, "the work");
});

// --- Continue -----------------------------------------------------------

test("continueStep releases the hold: the step is done and the next one is dispatched", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	assert.equal(getStep(steps[0].id)?.status, "waiting");

	const released = await continueStep(workflow.id, steps[0].id, cfg, silent);

	assert.equal(released.status, "done");
	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.ok(getStep(steps[0].id)?.finishedAt, "finished_at set on release");
	assert.equal(getStep(steps[0].id)?.result, "the work"); // preserved through the hold
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	assert.equal(getStep(steps[1].id)?.status, "queued");
});

test("continueStep on the LAST step completes the workflow", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{}, { manualReview: true }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "one" }, cfg, silent);
	await onStepResult(steps[1].id, { ok: true, result: "two" }, cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");

	await continueStep(workflow.id, steps[1].id, cfg, silent);

	assert.equal(getStep(steps[1].id)?.status, "done");
	assert.equal(getWorkflow(workflow.id)?.status, "completed");
});

test("continueStep refuses a step that is not waiting, and changes nothing", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{}, {}, {}, {}]);
	const message = /only a step waiting for its manual review can be continued/;

	// pending — never dispatched.
	await assert.rejects(() => continueStep(workflow.id, steps[0].id, cfg, silent), message);
	assert.equal(getStep(steps[0].id)?.status, "pending");
	assert.equal(getWorkflow(workflow.id)?.status, "draft");

	// running.
	markStepRunning(steps[1].id);
	await assert.rejects(() => continueStep(workflow.id, steps[1].id, cfg, silent), message);
	assert.equal(getStep(steps[1].id)?.status, "running");

	// done.
	markStepRunning(steps[2].id);
	await onStepResult(steps[2].id, { ok: true, result: "fine" }, cfg, silent);
	assert.equal(getStep(steps[2].id)?.status, "done");
	await assert.rejects(() => continueStep(workflow.id, steps[2].id, cfg, silent), message);
	assert.equal(getStep(steps[2].id)?.status, "done");

	// failed.
	markStepRunning(steps[3].id);
	await onStepResult(steps[3].id, { ok: false, error: "boom" }, cfg, silent);
	assert.equal(getStep(steps[3].id)?.status, "failed");
	await assert.rejects(() => continueStep(workflow.id, steps[3].id, cfg, silent), message);
	assert.equal(getStep(steps[3].id)?.status, "failed");
	assert.equal(getStep(steps[3].id)?.error, "boom");
});

test("continueStep refuses an unknown workflow, an unknown step, and a step of another workflow", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }]);
	const other = makeWorkflow(url, [{ manualReview: true }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	assert.equal(getStep(steps[0].id)?.status, "waiting");

	await assert.rejects(() => continueStep("no-such-workflow", steps[0].id, cfg, silent), /unknown workflow/);
	await assert.rejects(() => continueStep(workflow.id, "no-such-step", cfg, silent), /unknown step/);
	// A real, genuinely `waiting` step — but not this workflow's.
	await assert.rejects(() => continueStep(workflow.id, other.steps[0].id, cfg, silent), /unknown step/);

	// The hold survived every one of them.
	assert.equal(getStep(steps[0].id)?.status, "waiting");
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
});

// --- Abort: the answer that isn't yes -----------------------------------
//
// Continue used to be the only thing a held step offered, which made the gate a
// question with one permitted answer: an operator looking at a result that's
// plainly wrong could only approve it (or restart the whole step and hope).
// Abort is the "no": the step is recorded `failed` and the workflow stops there.
// It goes through the same `abortStep` as a stuck dispatch, because it's the
// same button on the same step — what differs is that nothing is in flight, so
// there's no broker process to kill and no re-run implied.

test("aborting a held step refuses the result and stops the workflow", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "not what I asked for", sessionId: "sess-held" }, cfg, silent);
	assert.equal(getStep(steps[0].id)?.status, "waiting");

	const stopped = await abortStep(workflow.id, steps[0].id, silent);

	assert.equal(stopped.status, "failed");
	const held = getStep(steps[0].id);
	assert.equal(held?.status, "failed");
	assert.equal(held?.error, "aborted");
	assert.ok(held?.finishedAt, "finished_at set");
	// The rejected work and the conversation that produced it are both kept —
	// that's what makes "read it again" and "Open conversation" still possible
	// after the refusal.
	assert.equal(held?.result, "not what I asked for");
	assert.equal(held?.sessionId, "sess-held");
	// And the run really stopped: the step behind the gate was never dispatched.
	assert.equal(getStep(steps[1].id)?.status, "pending");
});

test("a held step aborted cannot then be continued — the hold is gone, not deferred", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	await abortStep(workflow.id, steps[0].id, silent);

	// The 2s poll is behind the click, so a stale Continue is a real event: it
	// must change nothing rather than resurrect the aborted step.
	await assert.rejects(
		() => continueStep(workflow.id, steps[0].id, cfg, silent),
		/only a step waiting for its manual review can be continued/,
	);
	assert.equal(getStep(steps[0].id)?.status, "failed");
	assert.equal(getStep(steps[1].id)?.status, "pending");
});

test("▶ aborting a gated ▶ run's hold stops too, and consumes the stashed status", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);
	setWorkflowStatus(workflow.id, "paused");

	await runStep(workflow.id, steps[0].id, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: "wrong" }, cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");

	await abortStep(workflow.id, steps[0].id, silent);

	// A ▶ run never drove the workflow, but a failed step still fails it — same
	// as aborting a stuck ▶ run does.
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	// The `paused` the hold interrupted was stashed for the Continue that never
	// came; the abort consumes it, so it can't be handed back by a later hold.
	assert.equal(takeStatusBeforeReview(workflow.id), null);
});

test("abort still refuses every status that isn't running, queued or waiting", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{}, {}]);

	await assert.rejects(() => abortStep(workflow.id, steps[0].id, silent), /only a running step can be aborted/);
	assert.equal(getStep(steps[0].id)?.status, "pending");
});

// --- Add step: inserting the fix in front of the queue -------------------
//
// The other thing a held step needs: the result is wrong because something has
// to happen FIRST, and appending that something at the end of the list would run
// it last — after everything it was supposed to precede. So a step can be added
// directly after another one, and the rest move down.

test("addStep with afterStepId threads the new step in behind it and pushes the rest down", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{}, {}, {}]);

	const inserted = addStep(workflow.id, "fix the thing first", { afterStepId: steps[0].id });

	assert.equal(inserted.orderIndex, 1);
	assert.deepEqual(
		listSteps(workflow.id).map((s) => s.description),
		["step 1", "fix the thing first", "step 2", "step 3"],
	);
	// Contiguous, so the numbers the UI prints (orderIndex + 1) stay 1..4.
	assert.deepEqual(
		listSteps(workflow.id).map((s) => s.orderIndex),
		[0, 1, 2, 3],
	);
	// A plain add is unchanged: still appended at the end.
	addStep(workflow.id, "and this one last");
	assert.equal(listSteps(workflow.id).at(-1)?.description, "and this one last");
});

test("addStep refuses an afterStepId that isn't a step of this workflow", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{}, {}]);
	const other = makeWorkflow(url, [{}]);

	assert.throws(() => addStep(workflow.id, "nope", { afterStepId: "no-such-step" }), /unknown step/);
	assert.throws(() => addStep(workflow.id, "nope", { afterStepId: other.steps[0].id }), /unknown step/);
	// Neither workflow was renumbered by the refusal.
	assert.deepEqual(
		listSteps(workflow.id).map((s) => s.orderIndex),
		[0, 1],
	);
	assert.equal(listSteps(workflow.id).length, 2);
	assert.equal(listSteps(other.workflow.id).length, 1);
	assert.equal(steps.length, 2);
});

test("a step added after the held one is what Continue dispatches next", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "almost right" }, cfg, silent);
	assert.equal(getStep(steps[0].id)?.status, "waiting");

	// The correction, written while the gate holds. The workflow is `waiting`,
	// not terminal, so adding a step must NOT reset it to draft here.
	const fix = addStep(workflow.id, "correct the thing before carrying on", { afterStepId: steps[0].id });
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	assert.equal(getStep(steps[0].id)?.status, "waiting");

	await continueStep(workflow.id, steps[0].id, cfg, silent);

	// The new step ran next — not the one that used to follow. New steps are
	// selected by default, which is what puts it in the run's path.
	assert.equal(getStep(fix.id)?.status, "queued");
	assert.equal(getStep(steps[1].id)?.status, "pending");
});

// --- everything else must leave a held step alone -----------------------

// --- the gate on an on-demand ▶ run ------------------------------------
//
// The gate belongs to the STEP, so running one on its own must hold exactly the
// same way. What differs is the release: a ▶ run never drove the workflow, so
// Continue hands the badge back instead of advancing the run.

test("▶ a gated step run on its own holds at waiting, and the workflow turns waiting too", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await runStep(workflow.id, steps[0].id, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: "the work", sessionId: "sess-m" }, cfg, silent);

	const held = getStep(steps[0].id);
	assert.equal(held?.manualRun, true, "this really was a ▶ run, not an engine dispatch");
	assert.equal(held?.status, "waiting");
	assert.equal(held?.result, "the work");
	assert.equal(held?.finishedAt, null);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	// A ▶ run never dispatches anything else, gate or no gate.
	assert.equal(getStep(steps[1].id)?.status, "pending");
});

test("▶ continuing a gated ▶ run settles the workflow back — it does NOT start the run", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await runStep(workflow.id, steps[0].id, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");

	const released = await continueStep(workflow.id, steps[0].id, cfg, silent);

	assert.equal(released.status, "done");
	assert.ok(getStep(steps[0].id)?.finishedAt, "finished_at set on release");
	// The badge is reconciled from the steps (one done, one pending → draft), and
	// crucially the next step was NOT dispatched: only Start ever does that.
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
	assert.equal(getStep(steps[1].id)?.status, "pending");
});

test("▶ a gated ▶ run on the last outstanding step releases into completed", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }]);

	await runStep(workflow.id, steps[0].id, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	await continueStep(workflow.id, steps[0].id, cfg, silent);

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
});

test("▶ a hold on a PAUSED workflow hands `paused` back on continue", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);
	// The operator deliberately paused the run, then re-ran one step by hand.
	setWorkflowStatus(workflow.id, "paused");

	await runStep(workflow.id, steps[0].id, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");

	await continueStep(workflow.id, steps[0].id, cfg, silent);

	// `paused` is a deliberate state; the gate borrowed the badge and gave it back.
	assert.equal(getWorkflow(workflow.id)?.status, "paused");
	assert.equal(getStep(steps[1].id)?.status, "pending");
});

test("▶ a gated ▶ run WITH a criterion is judged first: reject retries, accept holds", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [
		{ manualReview: true, acceptanceCriteria: "must be X", maxRetries: 1 },
	]);

	await runStep(workflow.id, steps[0].id, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent); // exec → judge
	assert.equal(getStep(steps[0].id)?.phase, "judge");

	// A reject goes down the normal retry path — the gate never sees it.
	await onStepResult(steps[0].id, { ok: true, result: JUDGE_REJECT }, cfg, silent);
	assert.equal(getStep(steps[0].id)?.retryCount, 1);
	assert.notEqual(getStep(steps[0].id)?.status, "waiting");

	// The retry's own result, then an accepting verdict → now it holds.
	await onStepResult(steps[0].id, { ok: true, result: "the work, fixed" }, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: JUDGE_OK }, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "waiting");
	assert.equal(getStep(steps[0].id)?.result, "the work, fixed");
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
});

test("▶ a gated ▶ run that FAILS is recorded failed, not held — the gate only holds accepted work", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }]);

	await runStep(workflow.id, steps[0].id, cfg, silent);
	await onStepResult(steps[0].id, { ok: false, error: "boom" }, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "failed");
	assert.notEqual(getWorkflow(workflow.id)?.status, "waiting");
});

test("▶ an UNGATED ▶ run is completely unaffected", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{}, {}]);

	await runStep(workflow.id, steps[0].id, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.notEqual(getWorkflow(workflow.id)?.status, "waiting");
});

test("▶ runStep refuses a waiting step and the hold survives", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work", sessionId: "sess-hold" }, cfg, silent);

	await assert.rejects(() => runStep(workflow.id, steps[0].id, cfg, silent), /waiting for its manual review/);

	const held = getStep(steps[0].id);
	assert.equal(held?.status, "waiting");
	assert.equal(held?.result, "the work"); // a ▶ re-run would have wiped this
	assert.equal(held?.sessionId, "sess-hold");
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
});

test("startManualRun (the DB half of ▶) refuses a waiting step outright", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }]);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);

	assert.equal(startManualRun(steps[0].id), false);
	assert.equal(getStep(steps[0].id)?.status, "waiting");
});

test("editStep refuses a waiting step", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);

	assert.throws(
		() => editStep(workflow.id, steps[0].id, "a different task", { manualReview: false }),
		/cannot edit a step while it waits for its manual review/,
	);
	const held = getStep(steps[0].id);
	assert.equal(held?.status, "waiting");
	assert.equal(held?.description, "step 1");
	assert.equal(held?.manualReview, true); // the gate wasn't switched off underneath the hold
});

test("startWorkflow refuses a workflow waiting for a manual review", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);

	await assert.rejects(
		() => startWorkflow(workflow.id, cfg, silent, [steps[1].id]),
		/waiting for a manual review — continue that step instead/,
	);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	assert.equal(getStep(steps[1].id)?.status, "pending"); // nothing was dispatched behind the gate
});

test("a restart is the way out of a hold the operator does NOT want to approve", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "not what I asked for" }, cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");

	// Continue is the only way FORWARD, but the gate must not be a dead end:
	// restart resets the held step and runs it again (Start is refused, Edit and
	// ▶ are refused — this is what's left, and it works).
	await restartWorkflow(workflow.id, cfg, silent, [steps[0].id]);

	assert.equal(getStep(steps[0].id)?.status, "queued"); // re-dispatched
	assert.equal(getStep(steps[0].id)?.result, null); // the rejected work is gone
	assert.equal(getStep(steps[0].id)?.manualReview, true); // and it will hold again
	assert.equal(getWorkflow(workflow.id)?.status, "running");
});

test("an edit that omits manualReview keeps it, and toggling it on/off persists", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", [{ manualReview: true }, {}]);

	// A plain description edit must not silently clear the gate.
	editStep(workflow.id, steps[0].id, "renamed task");
	assert.equal(getStep(steps[0].id)?.manualReview, true);
	assert.equal(getStep(steps[0].id)?.description, "renamed task");

	// Editing other config, still without the flag: same.
	editStep(workflow.id, steps[0].id, "renamed task", { acceptanceCriteria: "must be X", maxRetries: 2 });
	assert.equal(getStep(steps[0].id)?.manualReview, true);
	assert.equal(getStep(steps[0].id)?.acceptanceCriteria, "must be X");

	// Explicitly off, then explicitly on again.
	editStep(workflow.id, steps[0].id, "renamed task", { manualReview: false });
	assert.equal(getStep(steps[0].id)?.manualReview, false);
	editStep(workflow.id, steps[1].id, "step 2", { manualReview: true });
	assert.equal(getStep(steps[1].id)?.manualReview, true);
});

test("the timeout watchdog never fails a step sitting in waiting — a human may take as long as they like", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	assert.equal(getStep(steps[0].id)?.status, "waiting");

	// Negative limits: anything the sweep can see is already past its deadline.
	const expired = { ...cfg, stepIdleTimeoutMs: -1000, stepHardTimeoutMs: -1000, queuedTimeoutMs: -1000 };
	expireStale(expired, silent);
	expireStale(expired, silent); // and again — a hold isn't a one-sweep grace period

	assert.equal(getStep(steps[0].id)?.status, "waiting");
	assert.equal(getStep(steps[0].id)?.error, null);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	assert.equal(getStep(steps[1].id)?.status, "pending");
});

test("the read-path heal does not settle a workflow whose only unfinished step is waiting", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{}, { manualReview: true }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "one" }, cfg, silent); // step 1 done
	await onStepResult(steps[1].id, { ok: true, result: "two" }, cfg, silent); // step 2 held
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");

	// Every step is settled as far as the heal's old test was concerned (none
	// pending/running), and the progress bar reads 1 done of 2 — without the
	// `waiting` guard this would be reconciled to `draft`.
	expireStale(cfg, silent);

	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	assert.equal(getStep(steps[1].id)?.status, "waiting");
});

test("a workflow left `running` with a waiting step is not reconciled either", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	// A stale row (an older hub, or a status written out of band): the badge says
	// running while the only step is held.
	setWorkflowStatus(workflow.id, "running");

	expireStale(cfg, silent);

	// Not "completed" (the step isn't done) and not "draft" — the heal keeps its
	// hands off a workflow whose step is waiting on a person.
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	assert.equal(getStep(steps[0].id)?.status, "waiting");
});

// --- the progress file --------------------------------------------------

test("writeStatusMd renders the gate, and calls out the step that is holding", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, { manualReview: true }]);

	writeStatusMd(workflow.id);
	const before = fs.readFileSync(workflow.mdPath, "utf8");
	// Both steps advertise the gate before either runs…
	assert.equal(before.match(/Manual review: required before the workflow advances past this step/g)?.length, 2);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);

	const after = fs.readFileSync(workflow.mdPath, "utf8");
	assert.match(after, /- Status: waiting/);
	assert.match(after, /1\. \[\?\] step 1 — \*\*waiting\*\*/);
	assert.match(after, /Manual review: WAITING for a human to continue this step/);
	// The step that hasn't run yet still reads as merely gated.
	assert.match(after, /Manual review: required before the workflow advances past this step/);
});

// --- the notification is advisory --------------------------------------

test("a step still enters (and stays in) waiting when the notification fails to send", async (t) => {
	const url = await hook(t);
	// Notifications fully configured, a Slack MCP that "exists", and a send that
	// blows up — the worst case for the engine to depend on.
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const originalDetect = notifierImpl.detect;
	const originalSend = notifierImpl.send;
	t.after(() => {
		notifierImpl.detect = originalDetect;
		notifierImpl.send = originalSend;
		saveNotificationSettings({ enabled: false, channels: { slack: { username: "" } } });
	});
	notifierImpl.detect = () => [{ serverName: "slack", serverUrl: "http://127.0.0.1:1/mcp", accessToken: "tok" }];
	notifierImpl.send = async () => {
		throw new Error("slack is down");
	};

	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}]);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	// The failed send must not escape into the callback path either.
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "waiting");
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	assert.equal(getStep(steps[1].id)?.status, "pending");
	// And Continue still works afterwards — a lost message costs nothing.
	await continueStep(workflow.id, steps[0].id, cfg, silent);
	assert.equal(getStep(steps[0].id)?.status, "done");
});

test("the notification carries the workflow, the step number and its description", async (t) => {
	const url = await hook(t);
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "@ada" } } });
	const originalDetect = notifierImpl.detect;
	const originalSend = notifierImpl.send;
	t.after(() => {
		notifierImpl.detect = originalDetect;
		notifierImpl.send = originalSend;
		saveNotificationSettings({ enabled: false, channels: { slack: { username: "" } } });
	});
	const sent: { username: string; message: string }[] = [];
	notifierImpl.detect = () => [{ serverName: "slack", serverUrl: "http://127.0.0.1:1/mcp", accessToken: "tok" }];
	notifierImpl.send = async (_endpoint, username, message) => {
		sent.push({ username, message });
	};

	const { workflow, steps } = makeWorkflow(url, [{}, { manualReview: true, acceptanceCriteria: "must be X" }]);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "one" }, cfg, silent);
	await onStepResult(steps[1].id, { ok: true, result: "two" }, cfg, silent); // exec → judge
	await onStepResult(steps[1].id, { ok: true, result: JUDGE_OK }, cfg, silent); // judge accepts → hold

	assert.equal(sent.length, 1);
	assert.equal(sent[0].username, "@ada");
	assert.match(sent[0].message, new RegExp(workflow.name));
	assert.match(sent[0].message, /Step 2:/); // 1-based, like the UI
	assert.match(sent[0].message, /step 2/); // the description
	assert.match(sent[0].message, /must be X/); // what to check it against
});

test("a step that is not gated notifies nobody", async (t) => {
	const url = await hook(t);
	const originalSend = notifierImpl.send;
	t.after(() => {
		notifierImpl.send = originalSend;
	});
	let calls = 0;
	notifierImpl.send = async () => {
		calls++;
	};

	const { workflow, steps } = makeWorkflow(url, [{}]);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(calls, 0);
});

// --- a full run through the gate ---------------------------------------

test("a three-step run stops at each gate and finishes only as fast as the human continues it", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ manualReview: true }, {}, { manualReview: true }]);
	const ids = steps.map((s) => s.id);

	await startWorkflow(workflow.id, cfg, silent, ids);
	await onStepResult(ids[0], { ok: true, result: "one" }, cfg, silent);
	assert.deepEqual(listSteps(workflow.id).map((s) => s.status), ["waiting", "pending", "pending"]);

	await continueStep(workflow.id, ids[0], cfg, silent);
	assert.deepEqual(listSteps(workflow.id).map((s) => s.status), ["done", "queued", "pending"]);

	// The ungated middle step runs straight through into the third one…
	await onStepResult(ids[1], { ok: true, result: "two" }, cfg, silent);
	assert.deepEqual(listSteps(workflow.id).map((s) => s.status), ["done", "done", "queued"]);

	// …which holds again.
	await onStepResult(ids[2], { ok: true, result: "three" }, cfg, silent);
	assert.deepEqual(listSteps(workflow.id).map((s) => s.status), ["done", "done", "waiting"]);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");

	await continueStep(workflow.id, ids[2], cfg, silent);
	assert.deepEqual(listSteps(workflow.id).map((s) => s.status), ["done", "done", "done"]);
	assert.equal(getWorkflow(workflow.id)?.status, "completed");
});
