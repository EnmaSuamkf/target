/**
 * Tests for the database half of the retry-wait indicator (plan 4.2.1).
 *
 * A judge-rejected or timed-out step that still has retry budget waits
 * `retryIntervalSeconds` before its next attempt. The step's `status` stays
 * `pending` during that wait; the due time is stored in `retry_at` so the UI can
 * count down to it and a restart can find a wait whose timer died.
 *
 * What is pinned here:
 *  - `beginRetry` stores `retry_at` only when the interval is > 0, and a second
 *    retry replaces the first wait;
 *  - every statement that moves a step out of `pending` (or ends its wait) nulls
 *    `retry_at`, one test per transition;
 *  - `clearOrphanRetryWaits` returns and clears only `pending` steps.
 *
 * Some transitions can only be reached from a `queued` or `running` step, and
 * those steps never carry a `retry_at` through the normal path (the statements
 * that enter those states clear it). For those tests the value is seeded straight
 * into the row, so the test exercises the clear in the transition itself.
 *
 * Throwaway TARGET_HOME, no hook and no DOM, the same convention as
 * step-deselect-on-done.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-retry-wait-db-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;

const {
	OVERRIDABLE_STEP_STATUSES,
	beginRetry,
	clearOrphanRetryWaits,
	completeStep,
	getStep,
	insertStep,
	insertWorkflow,
	markStepJudging,
	markStepQueued,
	markStepRunning,
	open,
	overrideStepStatus,
	promoteQueuedToRunning,
	resetSteps,
	startManualRun,
} = await import("./db.ts");

let seq = 0;

/** A workflow with `count` pending task steps, wired straight into the DB. */
function makeWorkflow(count: number) {
	const id = `wf-retry-wait-db-${++seq}`;
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

/** Writes `retry_at` straight into a row, for transitions that cannot be reached with it set. */
function seedRetryAt(stepId: string, at: string): void {
	open().prepare("UPDATE steps SET retry_at = ? WHERE id = ?").run(at, stepId);
}

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const retryAtOf = (id: string): string | null => getStep(id)?.retryAt ?? null;

// ---------------------------------------------------------------------------
// beginRetry: when a wait is stored
// ---------------------------------------------------------------------------

test("beginRetry with an interval stores the due time, counted from the given now", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;

	beginRetry(step.id, 45, NOW);

	const after = getStep(step.id);
	assert.equal(after?.retryAt, new Date(NOW + 45_000).toISOString());
	// The status stays pending: the wait is a display state derived from retry_at.
	assert.equal(after?.status, "pending");
	assert.equal(after?.retryCount, 1);
});

test("beginRetry with interval 0 leaves retry_at null (no visible wait)", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;

	beginRetry(step.id, 0, NOW);

	assert.equal(retryAtOf(step.id), null);
	assert.equal(getStep(step.id)?.status, "pending");
});

test("beginRetry without an interval argument leaves retry_at null", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;

	beginRetry(step.id);

	assert.equal(retryAtOf(step.id), null);
});

test("a second beginRetry replaces the wait, and interval 0 clears it", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;

	beginRetry(step.id, 60, NOW);
	assert.equal(retryAtOf(step.id), new Date(NOW + 60_000).toISOString());

	beginRetry(step.id, 30, NOW + 120_000);
	assert.equal(retryAtOf(step.id), new Date(NOW + 150_000).toISOString(), "the old due time must not survive");

	beginRetry(step.id, 0, NOW + 200_000);
	assert.equal(retryAtOf(step.id), null);
	assert.equal(getStep(step.id)?.retryCount, 3);
});

// ---------------------------------------------------------------------------
// Clear rules: one test per transition (plan 4.2.1, D4)
// ---------------------------------------------------------------------------

test("markStepQueued clears retry_at", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;
	beginRetry(step.id, 60, NOW);
	assert.notEqual(retryAtOf(step.id), null, "precondition: the step is in a wait");

	markStepQueued(step.id);

	assert.equal(getStep(step.id)?.status, "queued");
	assert.equal(retryAtOf(step.id), null);
});

test("markStepRunning clears retry_at", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;
	beginRetry(step.id, 60, NOW);

	markStepRunning(step.id);

	assert.equal(getStep(step.id)?.status, "running");
	assert.equal(retryAtOf(step.id), null);
});

test("promoteQueuedToRunning clears retry_at", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;
	markStepQueued(step.id);
	seedRetryAt(step.id, new Date(NOW + 60_000).toISOString());

	assert.equal(promoteQueuedToRunning(step.id), true);

	assert.equal(getStep(step.id)?.status, "running");
	assert.equal(retryAtOf(step.id), null);
});

test("markStepJudging clears retry_at", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;
	markStepRunning(step.id);
	seedRetryAt(step.id, new Date(NOW + 60_000).toISOString());

	markStepJudging(step.id, { result: "exec result", sessionId: "sess-1" });

	assert.equal(getStep(step.id)?.phase, "judge");
	assert.equal(retryAtOf(step.id), null);
});

test("completeStep clears retry_at when the step is settled", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;
	beginRetry(step.id, 60, NOW);

	completeStep(step.id, { ok: false, error: "boom" });

	assert.equal(getStep(step.id)?.status, "failed");
	assert.equal(retryAtOf(step.id), null);
});

test("startManualRun clears retry_at", () => {
	const { steps } = makeWorkflow(1);
	const [step] = steps;
	beginRetry(step.id, 60, NOW);

	assert.equal(startManualRun(step.id), true);

	assert.equal(getStep(step.id)?.status, "queued");
	assert.equal(retryAtOf(step.id), null);
});

test("resetSteps clears retry_at on every selected step of the workflow", () => {
	const { workflow, steps } = makeWorkflow(2);
	beginRetry(steps[0].id, 60, NOW);
	beginRetry(steps[1].id, 90, NOW);

	resetSteps(workflow.id);

	assert.equal(getStep(steps[0].id)?.status, "pending");
	assert.equal(retryAtOf(steps[0].id), null);
	assert.equal(retryAtOf(steps[1].id), null);
});

test("the manual status override clears retry_at, whatever status it sets", () => {
	for (const status of OVERRIDABLE_STEP_STATUSES) {
		const { steps } = makeWorkflow(1);
		const [step] = steps;
		beginRetry(step.id, 60, NOW);

		assert.equal(overrideStepStatus(step.id, status), true, `override to ${status}`);

		assert.equal(getStep(step.id)?.status, status);
		assert.equal(retryAtOf(step.id), null, `retry_at cleared when overridden to ${status}`);
	}
});

// ---------------------------------------------------------------------------
// clearOrphanRetryWaits: boot path (plan 4.2.5)
// ---------------------------------------------------------------------------

test("clearOrphanRetryWaits returns and clears only pending steps that carry a retry_at", () => {
	const { workflow, steps } = makeWorkflow(4);
	const [waiting, plain, running, queued] = steps;
	beginRetry(waiting.id, 60, NOW); // pending + retry_at: an orphan
	beginRetry(plain.id); // pending, no retry_at: not an orphan
	markStepRunning(running.id);
	seedRetryAt(running.id, new Date(NOW + 60_000).toISOString());
	markStepQueued(queued.id);
	seedRetryAt(queued.id, new Date(NOW + 60_000).toISOString());

	const returned = clearOrphanRetryWaits().filter((row) => row.workflowId === workflow.id);

	assert.deepEqual(returned, [{ id: waiting.id, workflowId: workflow.id }]);
	assert.equal(retryAtOf(waiting.id), null, "the orphan is cleared");
	assert.equal(getStep(waiting.id)?.status, "pending", "its status is left alone");
	assert.equal(retryAtOf(running.id), new Date(NOW + 60_000).toISOString(), "a running step is not touched");
	assert.equal(retryAtOf(queued.id), new Date(NOW + 60_000).toISOString(), "a queued step is not touched");
	assert.equal(retryAtOf(plain.id), null);
});

test("a second clearOrphanRetryWaits finds nothing left to clear for the workflow", () => {
	const { workflow, steps } = makeWorkflow(1);
	beginRetry(steps[0].id, 60, NOW);

	const first = clearOrphanRetryWaits().filter((row) => row.workflowId === workflow.id);
	const second = clearOrphanRetryWaits().filter((row) => row.workflowId === workflow.id);

	assert.equal(first.length, 1);
	assert.deepEqual(second, []);
});
