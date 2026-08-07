/**
 * Tests for "move a step up or down inside its workflow".
 *
 * A step used to land wherever it was created — appended at the end, or (from a
 * manual-review gate) threaded in directly after the step being reviewed — and
 * nothing could change its mind afterwards. Getting step 5 to run before step 4
 * meant deleting it and typing it out again. `moveStep` is the edit that was
 * missing, and it is deliberately a SWAP with the neighbouring step rather than
 * a free reorder: one press moves one place, and the other arrow undoes it.
 *
 * What's covered here:
 *
 *  1. **The storage swap** (`swapStepOrder` in db.ts) — two rows exchange their
 *     `order_index` and nothing else in the workflow is renumbered, which is the
 *     property the `.target/steps/<NN>-<slug>.md` result files depend on.
 *  2. **The rule** (`moveStep` in workflow.ts) — only a pending step moves, only
 *     past another pending one, never off either end, and never the hub-owned
 *     context step (which is pinned before everything at
 *     `CONTEXT_STEP_ORDER_INDEX` and isn't part of the ordering at all).
 *  3. **The page's copy of that rule** (`canMoveStep` in
 *     hub/ui/src/lib/stepMove.ts), which decides whether each arrow is live. It
 *     has to agree with the server, or the UI would offer a move that answers
 *     400.
 *  4. **The seams** the unit tests can't see: that the HTTP route exists, and
 *     that StepItem/WorkflowDetail actually render the arrows and wire them up.
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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-move-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;

const {
	CONTEXT_STEP_ORDER_INDEX,
	completeStep,
	getStep,
	insertStep,
	insertWorkflow,
	listSteps,
	markStepRunning,
	markStepWaiting,
	swapStepOrder,
} = await import("./db.ts");
const { moveStep, WorkflowError } = await import("./workflow.ts");
const { canMoveStep } = await import("./ui/src/lib/stepMove.ts");

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src");
const read = (rel: string): string => fs.readFileSync(path.join(uiDir, rel), "utf8");

let seq = 0;

/** A workflow with `count` pending task steps, wired straight into the DB. */
function makeWorkflow(count: number) {
	const id = `wf-move-${++seq}`;
	insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const steps = Array.from({ length: count }, (_, i) => insertStep(id, `step ${i + 1}`));
	return { id, steps };
}

/** The workflow's task steps in display order, by description. */
const order = (workflowId: string): string[] =>
	listSteps(workflowId)
		.filter((s) => s.kind !== "context")
		.map((s) => s.description);

// ---------------------------------------------------------------------------
// 1. The storage swap
// ---------------------------------------------------------------------------

test("swapStepOrder exchanges two steps' order_index and renumbers nothing else", () => {
	const { id, steps } = makeWorkflow(4);
	const before = listSteps(id).map((s) => s.orderIndex);

	swapStepOrder(steps[1].id, steps[2].id);

	assert.equal(getStep(steps[1].id)?.orderIndex, before[2]);
	assert.equal(getStep(steps[2].id)?.orderIndex, before[1]);
	// The steps that did NOT move keep the index their result file was named
	// after — the whole reason this is a swap and not a renumber.
	assert.equal(getStep(steps[0].id)?.orderIndex, before[0]);
	assert.equal(getStep(steps[3].id)?.orderIndex, before[3]);
	assert.deepEqual(order(id), ["step 1", "step 3", "step 2", "step 4"]);
});

// ---------------------------------------------------------------------------
// 2. The rule
// ---------------------------------------------------------------------------

test("moving a step up swaps it with the step above", () => {
	const { id, steps } = makeWorkflow(3);

	const moved = moveStep(id, steps[2].id, "up");

	assert.deepEqual(order(id), ["step 1", "step 3", "step 2"]);
	// The returned step carries its NEW index, so the caller can render it.
	assert.equal(moved.orderIndex, 1);
});

test("moving a step down swaps it with the step below", () => {
	const { id, steps } = makeWorkflow(3);

	moveStep(id, steps[0].id, "down");

	assert.deepEqual(order(id), ["step 2", "step 1", "step 3"]);
});

test("the other arrow undoes the move", () => {
	const { id, steps } = makeWorkflow(3);

	moveStep(id, steps[0].id, "down");
	moveStep(id, steps[0].id, "up");

	assert.deepEqual(order(id), ["step 1", "step 2", "step 3"]);
});

test("a step can be walked from last to first, one press at a time", () => {
	const { id, steps } = makeWorkflow(4);

	moveStep(id, steps[3].id, "up");
	moveStep(id, steps[3].id, "up");
	moveStep(id, steps[3].id, "up");

	assert.deepEqual(order(id), ["step 4", "step 1", "step 2", "step 3"]);
});

test("the ends are ends: the first can't go up and the last can't go down", () => {
	const { id, steps } = makeWorkflow(2);

	assert.throws(() => moveStep(id, steps[0].id, "up"), (err: Error) => {
		assert.ok(err instanceof WorkflowError);
		assert.match(err.message, /already first/);
		return true;
	});
	assert.throws(() => moveStep(id, steps[1].id, "down"), /already last/);
	assert.deepEqual(order(id), ["step 1", "step 2"]);
});

test("a step that has already run cannot be moved — its position is the record", () => {
	const { id, steps } = makeWorkflow(3);
	completeStep(steps[0].id, { ok: true, result: "done it" });

	assert.throws(() => moveStep(id, steps[0].id, "down"), /only a pending step can be moved/);
	assert.deepEqual(order(id), ["step 1", "step 2", "step 3"]);
});

test("a pending step cannot be moved PAST a step that has already run", () => {
	const { id, steps } = makeWorkflow(3);
	completeStep(steps[0].id, { ok: true, result: "done it" });

	assert.throws(() => moveStep(id, steps[1].id, "up"), /cannot move this step past a step that is done/);
	assert.deepEqual(order(id), ["step 1", "step 2", "step 3"]);
});

test("nor past a running one, nor past one held at its manual-review gate", () => {
	const { id, steps } = makeWorkflow(4);
	markStepRunning(steps[0].id);
	markStepRunning(steps[3].id);
	markStepWaiting(steps[3].id, { result: "please review", sessionId: "sess-1" });

	assert.throws(() => moveStep(id, steps[1].id, "up"), /past a step that is running/);
	assert.throws(() => moveStep(id, steps[2].id, "down"), /past a step that is waiting/);
	assert.deepEqual(order(id), ["step 1", "step 2", "step 3", "step 4"]);
});

test("a failed step is pending-only work again as far as reordering goes — it isn't", () => {
	// A failed step keeps its place: it ran, its result file was written, and the
	// operator's fix for it is a re-run, not a renumber.
	const { id, steps } = makeWorkflow(2);
	completeStep(steps[0].id, { ok: false, error: "boom" });

	assert.throws(() => moveStep(id, steps[0].id, "down"), /only a pending step can be moved/);
	assert.throws(() => moveStep(id, steps[1].id, "up"), /past a step that is failed/);
});

test("the hub-owned context step neither moves nor is moved past", () => {
	const { id, steps } = makeWorkflow(2);
	const context = insertStep(id, "the background", { kind: "context", orderIndex: CONTEXT_STEP_ORDER_INDEX });

	assert.throws(() => moveStep(id, context.id, "down"), /managed by the hub/);
	// Step 1 is still the FIRST task step, so its ↑ reports "already first"
	// rather than trying to swap with the context step behind it.
	assert.throws(() => moveStep(id, steps[0].id, "up"), /already first/);
	assert.equal(getStep(context.id)?.orderIndex, CONTEXT_STEP_ORDER_INDEX);
	assert.deepEqual(order(id), ["step 1", "step 2"]);
});

test("a step id from another workflow is refused, not silently reordered", () => {
	const a = makeWorkflow(2);
	const b = makeWorkflow(2);

	assert.throws(() => moveStep(a.id, b.steps[0].id, "down"), /unknown step/);
	assert.deepEqual(order(b.id), ["step 1", "step 2"]);
});

test("the move is written to the workflow's progress .md", () => {
	const { id, steps } = makeWorkflow(2);

	moveStep(id, steps[1].id, "up");

	const md = fs.readFileSync(path.join(tmpHome, `${id}.md`), "utf8");
	assert.ok(md.indexOf("step 2") < md.indexOf("step 1"), "the .md must list the steps in the new order");
});

// ---------------------------------------------------------------------------
// 3. The page's copy of the rule
// ---------------------------------------------------------------------------

test("canMoveStep agrees with the server: pending step, pending neighbour, not off an end", () => {
	const steps = [{ status: "pending" }, { status: "pending" }, { status: "pending" }];

	assert.equal(canMoveStep(steps, 0, "up"), false, "nothing above the first");
	assert.equal(canMoveStep(steps, 0, "down"), true);
	assert.equal(canMoveStep(steps, 1, "up"), true);
	assert.equal(canMoveStep(steps, 2, "down"), false, "nothing below the last");
});

test("canMoveStep turns both arrows off on a step that has run, and on its neighbours' side", () => {
	const steps = [{ status: "done" }, { status: "pending" }, { status: "pending" }];

	assert.equal(canMoveStep(steps, 0, "down"), false, "a done step doesn't move");
	assert.equal(canMoveStep(steps, 1, "up"), false, "and nothing moves past it");
	assert.equal(canMoveStep(steps, 1, "down"), true, "but the pending pair below still swaps");
});

test("canMoveStep is off for running, queued, waiting and failed steps alike", () => {
	for (const status of ["running", "queued", "waiting", "failed", "done"]) {
		const steps = [{ status }, { status: "pending" }];
		assert.equal(canMoveStep(steps, 0, "down"), false, `${status} must not move`);
		assert.equal(canMoveStep(steps, 1, "up"), false, `must not move past ${status}`);
	}
});

test("canMoveStep on an index that isn't there is false, not a crash", () => {
	assert.equal(canMoveStep([], 0, "up"), false);
	assert.equal(canMoveStep([{ status: "pending" }], 5, "down"), false);
});

// ---------------------------------------------------------------------------
// 4. The seams
// ---------------------------------------------------------------------------

test("the HTTP route exists and is admin-only", () => {
	const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8");
	const at = source.indexOf('parts[5] === "move"');

	assert.ok(at > 0, "POST /api/workflows/:id/steps/:stepId/move must be routed");
	const block = source.slice(at, at + 900);
	assert.match(block, /isAdmin/, "reordering a workflow is an admin action");
	assert.match(block, /direction must be "up" or "down"/, "the direction must be validated");
	assert.match(block, /moveStep\(workflowId, stepId, direction\)/);
});

test("StepItem renders both arrows, wired to onMove and disabled by canMove*", () => {
	const source = read("views/StepItem.tsx");

	assert.match(source, /onMove\(step\.id, "up"\)/, "the ↑ must move the step up");
	assert.match(source, /onMove\(step\.id, "down"\)/, "the ↓ must move the step down");
	assert.match(source, /disabled=\{!canMoveUp \|\| busy\}/);
	assert.match(source, /disabled=\{!canMoveDown \|\| busy\}/);
	// An icon-only button says what it does to a screen reader through its label,
	// and to everyone else through its tooltip.
	assert.match(source, /aria-label=\{`Move step \$\{step\.orderIndex \+ 1\} up/);
	assert.match(source, /aria-label=\{`Move step \$\{step\.orderIndex \+ 1\} down/);
	assert.match(source, /title=\{\s*canMoveUp/);
	assert.match(source, /title=\{\s*canMoveDown/);
});

test("WorkflowDetail decides each arrow with canMoveStep over the TASK steps only", () => {
	const source = read("views/WorkflowDetail.tsx");

	// Over `taskSteps`, not `steps`: with the context step in the list it would
	// count as step 1's neighbour and the ↑ would offer a move the server refuses.
	assert.match(source, /canMoveUp=\{canMoveStep\(taskSteps, i, "up"\)\}/);
	assert.match(source, /canMoveDown=\{canMoveStep\(taskSteps, i, "down"\)\}/);
	assert.match(source, /onMove=\{onMoveStep\}/);
});

test("App and the API client carry the move through to the server", () => {
	assert.match(read("api/client.ts"), /steps\/\$\{stepId\}\/move/);
	assert.match(read("App.tsx"), /api\.moveStep\(selectedId, stepId, direction\)/);
	assert.match(read("App.tsx"), /onMoveStep=\{\(id, direction\) => void handleMoveStep\(id, direction\)\}/);
});

test("the CLI offers the same move, and lists it in its usage", () => {
	const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");

	assert.match(source, /cmd === "move-step"/);
	assert.match(source, /move-step <workflowId> <stepId> <up\|down>/, "usage must list the command");
	assert.match(source, /steps\/\$\{stepId\}\/move/);
});
