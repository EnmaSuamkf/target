/**
 * Tests for "a step that finishes lets go of its checkbox".
 *
 * The complaint this comes from: run a workflow, watch every step go green, and
 * every one of them is still ticked. The checkbox answers "what should the next
 * Start run?", so leaving finished work in the selection quietly turns it back
 * into "all of them" — the opposite of the subset the operator chose, and a
 * Start over that re-runs the lot.
 *
 * The rule is written twice, because the selection lives in two places, and both
 * halves are tested here:
 *
 *  1. **The server's copy** (`selected` in db.ts). Every statement that can
 *     settle a step `done` clears it — the sequential engine's own callback, a
 *     judge accepting, a manual-review Continue, and a status forced by hand —
 *     while `failed` deliberately stays selected, because THAT is the step the
 *     next run should pick up. The hub-owned context step is exempt: it has no
 *     checkbox, and `nextPendingStep` only returns selected steps, so
 *     deselecting it would silently drop the conversation background from a
 *     later run.
 *  2. **The open page's copy** (`selectionAfterPoll` in
 *     hub/ui/src/lib/stepSelection.ts). The UI cannot just mirror the server
 *     flag — the checkboxes are local state, re-seeded only when the workflow
 *     changes, so an operator's ticks survive the 2s poll. It therefore applies
 *     the same rule on the pending→done TRANSITION. The last test is the seam:
 *     WorkflowDetail.tsx must actually call it, or this file would pass while
 *     the screen it's about kept its ticks.
 *
 * Throwaway TARGET_HOME, no hook and no DOM — the same convention as
 * workflow.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-deselect-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;

const {
	completeStep,
	finishStepDone,
	getStep,
	insertStep,
	insertWorkflow,
	listSteps,
	markStepJudging,
	markStepRunning,
	markStepWaiting,
	nextPendingStep,
	overrideStepStatus,
	releaseWaitingStep,
	setStepSelection,
	startManualRun,
} = await import("./db.ts");
const { onStepResult } = await import("./workflow.ts");
const { loadConfig } = await import("./config.ts");
const { selectionAfterPoll, stepStatuses } = await import("./ui/src/lib/stepSelection.ts");

const cfg = loadConfig();
const silent = () => {};

let seq = 0;

/** A workflow with `count` pending task steps, wired straight into the DB. */
function makeWorkflow(count: number) {
	const id = `wf-deselect-${++seq}`;
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

const selected = (id: string): boolean => getStep(id)?.selected === true;

// ---------------------------------------------------------------------------
// 1. The server's copy of the selection
// ---------------------------------------------------------------------------

test("a step the engine records done is no longer selected", () => {
	const { steps } = makeWorkflow(1);
	assert.ok(selected(steps[0].id)); // new steps start selected

	completeStep(steps[0].id, { ok: true, result: "done it" });

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(selected(steps[0].id), false);
});

test("a step that FAILS stays selected — it is what the next run should pick up", () => {
	const { steps } = makeWorkflow(1);

	completeStep(steps[0].id, { ok: false, error: "boom" });

	assert.equal(getStep(steps[0].id)?.status, "failed");
	assert.ok(selected(steps[0].id));
});

test("a judge-accepted step is deselected too (finishStepDone)", () => {
	const { steps } = makeWorkflow(1);
	markStepRunning(steps[0].id);
	markStepJudging(steps[0].id, { result: "the work", sessionId: "sess-1" });

	finishStepDone(steps[0].id);

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(selected(steps[0].id), false);
});

test("continuing a step held at its manual-review gate deselects it (releaseWaitingStep)", () => {
	const { steps } = makeWorkflow(1);
	markStepRunning(steps[0].id);
	markStepWaiting(steps[0].id, { result: "please review", sessionId: "sess-2" });
	assert.ok(selected(steps[0].id)); // still selected while it holds

	assert.ok(releaseWaitingStep(steps[0].id));

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(selected(steps[0].id), false);
});

test("marking a step done BY HAND deselects it exactly like a real finish", () => {
	const { steps } = makeWorkflow(3);
	completeStep(steps[0].id, { ok: false, error: "ran out of tokens" });

	assert.ok(overrideStepStatus(steps[0].id, "done"));

	assert.equal(selected(steps[0].id), false);
	// The other two are untouched: an override is about one step.
	assert.ok(selected(steps[1].id));
	assert.ok(selected(steps[2].id));
});

test("an override to failed or pending leaves the selection alone", () => {
	const { steps } = makeWorkflow(2);
	completeStep(steps[0].id, { ok: true });
	completeStep(steps[1].id, { ok: true });
	assert.equal(selected(steps[0].id), false);

	// failed: the step is back in play, and the flag is not this feature's to set…
	assert.ok(overrideStepStatus(steps[0].id, "failed"));
	assert.equal(selected(steps[0].id), false);
	// …and a step still ticked stays ticked when it's pushed back to pending.
	setStepSelection(steps[1].workflowId, [steps[1].id]);
	assert.ok(overrideStepStatus(steps[1].id, "pending"));
	assert.ok(selected(steps[1].id));
});

test("the hub-owned context step is exempt — done, and still selected", () => {
	const { workflow } = makeWorkflow(1);
	const context = insertStep(workflow.id, "conversation context", { kind: "context" });

	completeStep(context.id, { ok: true, result: "injected" });

	assert.equal(getStep(context.id)?.status, "done");
	// It has no checkbox, and `nextPendingStep` only returns selected steps: a
	// deselected context step would never be re-dispatched after a compaction
	// put it back to pending, and the run would carry on without its background.
	assert.ok(selected(context.id));
});

test("a whole run still runs — deselecting as it goes must not stall the queue", () => {
	const { workflow, steps } = makeWorkflow(4);
	const chosen = [steps[0], steps[1], steps[3]];
	setStepSelection(workflow.id, chosen.map((s) => s.id));

	// The engine's own loop (`nextPendingStep` returns only SELECTED steps), so
	// a step that deselects itself on the way out could strand the ones behind
	// it. It doesn't: all three chosen steps are dispatched, first to last.
	const dispatched: number[] = [];
	for (;;) {
		const next = nextPendingStep(workflow.id);
		if (!next) break;
		dispatched.push(next.orderIndex);
		completeStep(next.id, { ok: true });
	}

	assert.deepEqual(dispatched, [0, 1, 3]);
	for (const step of listSteps(workflow.id)) {
		assert.equal(step.selected, false, `${step.description} is still selected`);
	}
	assert.equal(getStep(steps[2].id)?.status, "pending"); // never chosen, never run
});

test("a finished step can be re-ticked and re-run, and is deselected again", async () => {
	const { workflow, steps } = makeWorkflow(2);
	completeStep(steps[0].id, { ok: true });
	assert.equal(selected(steps[0].id), false);

	// The operator ticks it again and presses ▶ — deselection is not a lock.
	setStepSelection(workflow.id, [steps[0].id]);
	assert.ok(selected(steps[0].id));
	assert.ok(startManualRun(steps[0].id));
	await onStepResult(steps[0].id, { ok: true, result: "again" }, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(selected(steps[0].id), false);
});

// ---------------------------------------------------------------------------
// 2. The open page's copy of the selection
// ---------------------------------------------------------------------------

test("the page drops a step from the selection when it finishes", () => {
	const before = new Map([
		["a", "running"],
		["b", "pending"],
	]);
	const next = selectionAfterPoll(
		new Set(["a", "b"]),
		before,
		[
			{ id: "a", status: "done" },
			{ id: "b", status: "pending" },
		],
	);

	assert.deepEqual([...next], ["b"]);
});

test("a step that was ALREADY done when the page first saw it is left as seeded", () => {
	// This is what lets the operator re-tick a finished step: the transition is
	// long past, so no poll may untick it again.
	const steps = [{ id: "a", status: "done" }];
	const retickedByHand = new Set(["a"]);

	const first = selectionAfterPoll(retickedByHand, new Map(), steps); // first sighting
	const second = selectionAfterPoll(first, stepStatuses(steps), steps); // and every poll after

	assert.deepEqual([...first], ["a"]);
	assert.deepEqual([...second], ["a"]);
});

test("failed, waiting and running steps keep their tick", () => {
	const before = new Map([
		["a", "running"],
		["b", "running"],
		["c", "pending"],
	]);
	const next = selectionAfterPoll(
		new Set(["a", "b", "c"]),
		before,
		[
			{ id: "a", status: "failed" },
			{ id: "b", status: "waiting" },
			{ id: "c", status: "running" },
		],
	);

	assert.deepEqual([...next].sort(), ["a", "b", "c"]);
});

test("nothing finished = the very same Set back, so the poll re-renders nothing", () => {
	const selection = new Set(["a"]);
	const steps = [{ id: "a", status: "running" }];

	assert.equal(selectionAfterPoll(selection, stepStatuses(steps), steps), selection);
	// Also when the finished step wasn't ticked in the first place.
	assert.equal(selectionAfterPoll(selection, new Map([["z", "running"]]), [{ id: "z", status: "done" }]), selection);
});

test("statuses of deleted steps are forgotten", () => {
	assert.deepEqual([...stepStatuses([{ id: "a", status: "done" }]).keys()], ["a"]);
});

test("WorkflowDetail actually applies the rule (the seam these unit tests can't see)", () => {
	const source = fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src/views/WorkflowDetail.tsx"),
		"utf8",
	);

	assert.match(source, /selectionAfterPoll/, "the detail view must apply the deselect-on-done rule");
	// Driven by the polled steps, and remembering their statuses for the next
	// comparison — without the ref there is no transition to spot.
	assert.match(source, /seenStatuses\.current = stepStatuses\(taskSteps\)/);
	assert.match(source, /setSelection\(\(current\) => selectionAfterPoll\(current, previous, taskSteps\)/);
});
