/**
 * Tests for how a workflow's status is derived from its steps. The badge is a
 * function of the CURRENT state of every step — the last attempt of each one —
 * so a step that failed and is then re-run (the ▶ button) until it succeeds
 * must stop holding the whole workflow at `failed`.
 *
 * Everything runs against a throwaway TARGET_HOME (its own SQLite file and
 * progress .md files), so nothing here touches the operator's real ~/.target.
 * Steps are driven through `onStepResult` — the same callback awb posts to
 * /api/steps/:id/result — with `startManualRun` standing in for the ▶ dispatch,
 * which keeps the hook out of the test.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-"));
process.env.TARGET_HOME = tmpHome;

const {
	completeStep,
	getStep,
	getWorkflow,
	insertStep,
	insertWorkflow,
	listSteps,
	markStepJudging,
	nextPendingStep,
	resetSteps,
	setStepSelection,
	setWorkflowStatus,
	startManualRun,
} = await import("./db.ts");
const { onStepResult, pauseWorkflow, resumeWorkflow, restartWorkflow, startWorkflow } = await import("./workflow.ts");
const { loadConfig } = await import("./config.ts");

const cfg = loadConfig();
const silent = () => {};

let seq = 0;

/** A workflow with `count` pending steps, wired straight into the DB (no awb hook involved). */
function makeWorkflow(count: number) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const steps = Array.from({ length: count }, (_, i) => insertStep(id, `step ${i + 1}`));
	return { workflow, steps };
}

/** Runs a step's exec job to the given outcome, exactly as awb's callback would. */
async function finishStep(stepId: string, ok: boolean) {
	await onStepResult(stepId, ok ? { ok: true, result: "fine" } : { ok: false, error: "boom" }, cfg, silent);
}

test("a failed step re-run successfully takes the workflow out of failed", async () => {
	const { workflow, steps } = makeWorkflow(1);

	await finishStep(steps[0].id, false);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");

	// The ▶ button: re-run that same step, this time successfully.
	assert.ok(startManualRun(steps[0].id));
	await finishStep(steps[0].id, true);

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
});

test("re-running one failed step of many leaves the workflow ready to continue", async () => {
	const { workflow, steps } = makeWorkflow(3);

	await finishStep(steps[0].id, true);
	await finishStep(steps[1].id, false);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");

	assert.ok(startManualRun(steps[1].id));
	await finishStep(steps[1].id, true);

	// Step 3 never ran, so there's still work to do: back to draft, not completed.
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
});

test("a step that fails again keeps the workflow failed", async () => {
	const { workflow, steps } = makeWorkflow(2);

	await finishStep(steps[0].id, false);
	assert.ok(startManualRun(steps[0].id));
	await finishStep(steps[0].id, false);

	assert.equal(getWorkflow(workflow.id)?.status, "failed");
});

test("a re-run that fails a step of a completed workflow fails the workflow", async () => {
	const { workflow, steps } = makeWorkflow(1);

	assert.ok(startManualRun(steps[0].id));
	await finishStep(steps[0].id, true);
	assert.equal(getWorkflow(workflow.id)?.status, "completed");

	assert.ok(startManualRun(steps[0].id));
	await finishStep(steps[0].id, false);

	assert.equal(getWorkflow(workflow.id)?.status, "failed");
});

/**
 * A manual ▶ run of a step WITH acceptance criteria is judged like an engine
 * step. We drive the judge-verdict callback directly (phase already `judge`),
 * which is where the accept/reject/retry decision lives — no hook involved.
 */
function manualStepInJudgePhase(criteria: string, opts: { maxRetries?: number } = {}) {
	const { workflow } = makeWorkflow(0);
	const step = insertStep(workflow.id, "do the thing", { acceptanceCriteria: criteria, ...opts });
	assert.ok(startManualRun(step.id));
	markStepJudging(step.id, { result: "the work", sessionId: "sess-1" });
	return { workflow, step };
}

test("manual run that passes the judge marks the step done", async () => {
	const { workflow, step } = manualStepInJudgePhase("must contain X");

	await onStepResult(step.id, { ok: true, result: '{"ok": true, "reason": "it does"}' }, cfg, silent);

	assert.equal(getStep(step.id)?.status, "done");
	assert.equal(getWorkflow(workflow.id)?.status, "completed");
});

test("manual run rejected by the judge with no retries fails the step", async () => {
	const { workflow, step } = manualStepInJudgePhase("must contain X"); // maxRetries defaults to 0

	await onStepResult(step.id, { ok: true, result: '{"ok": false, "reason": "no X"}' }, cfg, silent);

	assert.equal(getStep(step.id)?.status, "failed");
	assert.equal(getStep(step.id)?.retryCount, 0);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
});

test("an on-demand run chains its session onto the shared workflow session", async () => {
	const { workflow, steps } = makeWorkflow(1);

	assert.ok(startManualRun(steps[0].id));
	await onStepResult(steps[0].id, { ok: true, result: "fine", sessionId: "sess-shared" }, cfg, silent);

	// The ▶ run must persist its session as the workflow's shared one, so the
	// next step/run continues the same conversation instead of a fresh session.
	assert.equal(getWorkflow(workflow.id)?.lastSessionId, "sess-shared");
});

test("manual run rejected by the judge with retries left re-runs the same step", async () => {
	const { step } = manualStepInJudgePhase("must contain X", { maxRetries: 1 });

	await onStepResult(step.id, { ok: true, result: '{"ok": false, "reason": "no X"}' }, cfg, silent);

	// The retry fired (counter bumped) and the step stayed a manual run; the
	// re-dispatch can't reach the fake hook, so it ends failed — but the retry
	// is what we're proving here.
	assert.equal(getStep(step.id)?.retryCount, 1);
	assert.equal(getStep(step.id)?.manualRun, true);
});

/**
 * Step selection: Start/Resume/Restart persist the checked step ids via
 * `setStepSelection`, and the sequential engine only ever dispatches a selected
 * step (`nextPendingStep` filters on it). These prove the exact mechanism the
 * "run only the selected steps" acceptance criterion relies on, without a hook.
 */
test("selection restricts which steps the engine dispatches, in order", () => {
	const { workflow, steps } = makeWorkflow(4);
	setStepSelection(workflow.id, [steps[1].id, steps[3].id]);

	// Only selected steps are picked up, first-to-last; unselected are skipped.
	assert.equal(nextPendingStep(workflow.id)?.id, steps[1].id);
	completeStep(steps[1].id, { ok: true });
	assert.equal(nextPendingStep(workflow.id)?.id, steps[3].id);
	completeStep(steps[3].id, { ok: true });
	assert.equal(nextPendingStep(workflow.id), null); // steps 1 & 3 never run

	// The unselected steps were left untouched — still pending, never dispatched.
	assert.equal(getStep(steps[0].id)?.status, "pending");
	assert.equal(getStep(steps[2].id)?.status, "pending");
});

test("an empty selection runs nothing (0 steps selected = no-op, not 'run everything')", () => {
	const { workflow, steps } = makeWorkflow(3);
	setStepSelection(workflow.id, [steps[2].id]); // narrow to one…
	assert.equal(nextPendingStep(workflow.id)?.id, steps[2].id);
	setStepSelection(workflow.id, []); // …then clear → nothing is selected anymore
	assert.equal(nextPendingStep(workflow.id), null);
	assert.ok(listSteps(workflow.id).every((s) => !s.selected));
	// Every step is still sitting there pending — just none of them selected.
	assert.ok(listSteps(workflow.id).every((s) => s.status === "pending"));
});

test("a 10-step workflow with steps 1,3,5,7,9 selected dispatches only those, in order", () => {
	const { workflow, steps } = makeWorkflow(10);
	const odd = [steps[0], steps[2], steps[4], steps[6], steps[8]]; // 1st, 3rd, 5th, 7th, 9th
	const even = [steps[1], steps[3], steps[5], steps[7], steps[9]]; // 2nd, 4th, 6th, 8th, 10th
	setStepSelection(workflow.id, odd.map((s) => s.id));

	const dispatched: number[] = [];
	for (;;) {
		const next = nextPendingStep(workflow.id);
		if (!next) break;
		dispatched.push(next.orderIndex);
		completeStep(next.id, { ok: true });
	}
	assert.deepEqual(dispatched, [0, 2, 4, 6, 8]);
	for (const s of odd) assert.equal(getStep(s.id)?.status, "done");
	for (const s of even) assert.equal(getStep(s.id)?.status, "pending");
});

test("restart with steps 1,3,5,7,9 selected after partial completion resets+re-runs only those", () => {
	const { workflow, steps } = makeWorkflow(10);
	const odd = [steps[0], steps[2], steps[4], steps[6], steps[8]];
	const even = [steps[1], steps[3], steps[5], steps[7], steps[9]];
	// Everything done once (simulating a prior full run).
	for (const s of steps) completeStep(s.id, { ok: true });

	setStepSelection(workflow.id, odd.map((s) => s.id));
	resetSteps(workflow.id);
	for (const s of odd) assert.equal(getStep(s.id)?.status, "pending");
	for (const s of even) assert.equal(getStep(s.id)?.status, "done"); // untouched, still done

	const dispatched: number[] = [];
	for (;;) {
		const next = nextPendingStep(workflow.id);
		if (!next) break;
		dispatched.push(next.orderIndex);
		completeStep(next.id, { ok: true });
	}
	assert.deepEqual(dispatched, [0, 2, 4, 6, 8]);
	for (const s of even) assert.equal(getStep(s.id)?.status, "done"); // still never re-run
});

test("resume after a partial run with steps 1,3,5,7,9 selected finishes only those", () => {
	const { workflow, steps } = makeWorkflow(10);
	const odd = [steps[0], steps[2], steps[4], steps[6], steps[8]];
	const even = [steps[1], steps[3], steps[5], steps[7], steps[9]];
	setStepSelection(workflow.id, odd.map((s) => s.id));

	// Run the first two selected steps, then "pause" (just stop dispatching).
	for (let i = 0; i < 2; i++) {
		const next = nextPendingStep(workflow.id);
		assert.ok(next);
		completeStep(next!.id, { ok: true });
	}
	assert.equal(getStep(odd[0].id)?.status, "done");
	assert.equal(getStep(odd[1].id)?.status, "done");
	assert.equal(getStep(odd[2].id)?.status, "pending");
	for (const s of even) assert.equal(getStep(s.id)?.status, "pending");

	// Resume: re-submit the same selection and finish the rest.
	setStepSelection(workflow.id, odd.map((s) => s.id));
	const dispatched: number[] = [];
	for (;;) {
		const next = nextPendingStep(workflow.id);
		if (!next) break;
		dispatched.push(next.orderIndex);
		completeStep(next.id, { ok: true });
	}
	assert.deepEqual(dispatched, [4, 6, 8]);
	for (const s of even) assert.equal(getStep(s.id)?.status, "pending"); // never touched
});

/**
 * The completed-status guard (advance(), workflow.ts): nextPendingStep
 * returning null must NOT be read as "workflow done" when there are
 * pending-but-unselected steps left. These drive the real Start/Resume/Restart
 * path with an empty selection — safe to call for real here because 0
 * selected steps means nextPendingStep is null immediately, so advance()
 * returns before ever reaching dispatchStep (no network call is made).
 */
test("0-selected Start leaves the workflow running, not falsely completed", async () => {
	const { workflow, steps } = makeWorkflow(5);
	await startWorkflow(workflow.id, cfg, silent, []);
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	assert.ok(listSteps(workflow.id).every((s) => s.status === "pending"));
	assert.equal(nextPendingStep(workflow.id), null); // nothing selected
});

test("0-selected Resume leaves the workflow running, not falsely completed", async () => {
	const { workflow, steps } = makeWorkflow(5);
	// One step already finished (set directly — no dispatch involved), workflow
	// paused, exactly the state a real pause mid-run would leave behind.
	completeStep(steps[0].id, { ok: true });
	setWorkflowStatus(workflow.id, "running");
	pauseWorkflow(workflow.id);

	await resumeWorkflow(workflow.id, cfg, silent, []);
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	// 4 steps remain pending and unselected — resume must not touch or complete them.
	assert.equal(listSteps(workflow.id).filter((s) => s.status === "pending").length, 4);
});

test("0-selected Restart leaves the workflow running, not falsely completed, and resets nothing", async () => {
	const { workflow, steps } = makeWorkflow(5);
	// Only some steps done — 2 remain pending, so there IS real pending work
	// left; a 0-selected restart must not paper over that with "completed".
	completeStep(steps[0].id, { ok: true });
	completeStep(steps[1].id, { ok: true });
	completeStep(steps[2].id, { ok: true });
	// restartWorkflow only requires the workflow not be "running" — draft (the
	// default after insertWorkflow) already qualifies, no pause needed.

	await restartWorkflow(workflow.id, cfg, silent, []);
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	// Nothing selected → resetSteps touches nothing; the 3 done steps stay done,
	// the 2 pending steps are left alone (still pending, never dispatched).
	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(getStep(steps[1].id)?.status, "done");
	assert.equal(getStep(steps[2].id)?.status, "done");
	assert.equal(getStep(steps[3].id)?.status, "pending");
	assert.equal(getStep(steps[4].id)?.status, "pending");
	assert.equal(nextPendingStep(workflow.id), null); // nothing selected, still no dispatch
});

test("startWorkflow with exactly 1 of 10 steps selected dispatches only that one", async () => {
	// Regression test for a bug report where checking a single step and
	// pressing Start ran every step. Goes through the real `startWorkflow`
	// entry point (not `setStepSelection`/`nextPendingStep` called directly),
	// so it covers the same call path the HTTP route handler uses.
	const { workflow, steps } = makeWorkflow(10);
	const chosen = steps[4]; // an arbitrary single step, not first or last

	await startWorkflow(workflow.id, cfg, silent, [chosen.id]);

	// The chosen step was dispatched (the fake hookUrl rejects immediately,
	// so dispatchStep already resolved it to failed rather than leaving it
	// stuck "running" — either way it left "pending").
	assert.notEqual(getStep(chosen.id)?.status, "pending");
	// Every other step — none of them selected — must still be untouched.
	for (const s of steps) {
		if (s.id === chosen.id) continue;
		assert.equal(getStep(s.id)?.status, "pending");
	}
});

test("advance() marks completed when every step is truly done, even with an empty selection", async () => {
	const { workflow, steps } = makeWorkflow(5);
	for (const s of steps) completeStep(s.id, { ok: true }); // every step genuinely finished

	// Nothing selected, but there is truly no pending work anywhere — this is
	// the one case where "no next step" really does mean the workflow is done.
	await restartWorkflow(workflow.id, cfg, silent, []);
	assert.equal(getWorkflow(workflow.id)?.status, "completed");
});

test("restart resets only the selected steps, leaving the rest done", () => {
	const { workflow, steps } = makeWorkflow(3);
	for (const s of steps) completeStep(s.id, { ok: true });

	setStepSelection(workflow.id, [steps[1].id]);
	resetSteps(workflow.id); // restart wipes only the selected subset

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(getStep(steps[1].id)?.status, "pending");
	assert.equal(getStep(steps[2].id)?.status, "done");
});
