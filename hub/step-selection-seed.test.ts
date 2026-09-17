/**
 * Regression tests for step checkbox selection surviving a page reload.
 *
 * The complaint: select steps, run (or just tick boxes), refresh — the engine
 * still had the right `selected` flags in the DB but every box looked
 * unchecked. Root cause: WorkflowDetail seeded local selection only in an
 * effect keyed on `workflow.id`, which runs once on mount while `steps` is
 * still `[]` (the detail fetch hasn't returned yet). The poll never re-seeded
 * (by design — mid-run toggles would be overwritten), so the selection stayed
 * empty forever.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const {
	absorbServerSelectedPending,
	adoptNewlyVisibleSteps,
	reconcileSelectionWithServer,
	stepIdsForStartRun,
	stepIdsForStartRunWithServer,
	seedSelectionFromSteps,
	selectionAfterPoll,
	shouldPushSelectionToServer,
	stepStatuses,
	workflowRunActive,
} = await import("./ui/src/lib/stepSelection.ts");

test("seedSelectionFromSteps mirrors the server's selected flags", () => {
	const seeded = seedSelectionFromSteps([
		{ id: "a", status: "pending", selected: true },
		{ id: "b", status: "failed", selected: true },
		{ id: "c", status: "pending", selected: false },
	]);
	assert.deepEqual([...seeded].sort(), ["a", "b"]);
});

test("after a simulated reload, seed then poll keeps failed steps ticked", () => {
	// Mount: steps still loading → empty selection (nothing to seed yet).
	let selection = seedSelectionFromSteps([]);
	assert.equal(selection.size, 0);

	// Detail fetch lands — seed once from the server.
	const steps = [
		{ id: "a", status: "done", selected: false },
		{ id: "b", status: "failed", selected: true },
	];
	selection = seedSelectionFromSteps(steps);
	assert.deepEqual([...selection], ["b"]);

	// First poll after seed: no pending→done transitions, so nothing drops.
	const previous = new Map<string, string>();
	const afterPoll = selectionAfterPoll(selection, previous, steps);
	seenStatuses(steps, previous);
	assert.deepEqual([...afterPoll], ["b"]);
});

/** What WorkflowDetail does after each poll — update the ref for the next one. */
function seenStatuses(steps: { id: string; status: string }[], previous: Map<string, string>): void {
	for (const [id, status] of stepStatuses(steps)) previous.set(id, status);
}

test("reconcileSelectionWithServer mirrors the server for pending steps", () => {
	const steps = [
		{ id: "a", status: "done", selected: false },
		{ id: "b", status: "pending", selected: false },
		{ id: "c", status: "pending", selected: true },
	];
	// Local still thinks b is ticked (drift); server says it is not.
	const reconciled = reconcileSelectionWithServer(new Set(["a", "b", "c"]), steps);
	assert.deepEqual([...reconciled].sort(), ["c"]);
});

test("reconcileSelectionWithServer keeps a re-ticked done step", () => {
	const steps = [{ id: "a", status: "done", selected: true }];
	const reconciled = reconcileSelectionWithServer(new Set(["a"]), steps);
	assert.deepEqual([...reconciled], ["a"]);
});

test("stepIdsForStartRunWithServer includes server-selected runnable steps missing locally", () => {
	const steps = [
		{ id: "a", status: "pending", selected: true },
		{ id: "b", status: "pending", selected: true },
		{ id: "c", status: "pending", selected: false },
	];
	assert.deepEqual(stepIdsForStartRunWithServer(steps, new Set(["a"]), false).sort(), ["a", "b"]);
});

test("stepIdsForStartRun sends every runnable step when all are selected", () => {
	const steps = [
		{ id: "a", status: "done", selected: false },
		{ id: "b", status: "pending", selected: true },
		{ id: "c", status: "pending", selected: true },
	];
	assert.deepEqual(stepIdsForStartRun(steps, new Set(["a", "b", "c"]), true), ["b", "c"]);
	assert.deepEqual(stepIdsForStartRun(steps, new Set(["b"]), false), ["b"]);
});

test("absorbServerSelectedPending picks up server ticks missing locally", () => {
	const steps = [
		{ id: "a", status: "pending", selected: true },
		{ id: "b", status: "pending", selected: false },
	];
	const next = absorbServerSelectedPending(new Set(["b"]), steps);
	assert.deepEqual([...next].sort(), ["a", "b"]);
});

test("adoptNewlyVisibleSteps ticks pending steps the server already selected", () => {
	const known = new Set(["a"]);
	const steps = [
		{ id: "a", status: "done", selected: false },
		{ id: "b", status: "pending", selected: true },
		{ id: "c", status: "pending", selected: true },
	];
	const next = adoptNewlyVisibleSteps(new Set(["a"]), known, steps);
	assert.deepEqual([...next].sort(), ["a", "b", "c"]);
});

test("adoptNewlyVisibleSteps ignores steps that were already known", () => {
	const known = new Set(["a", "b"]);
	const steps = [
		{ id: "a", status: "pending", selected: false },
		{ id: "b", status: "pending", selected: true },
	];
	const same = adoptNewlyVisibleSteps(new Set(["a"]), known, steps);
	assert.deepEqual([...same], ["a"]);
});

test("reconcileSelectionWithServer preserves local ticks during a run", () => {
	const steps = [
		{ id: "a", status: "done", selected: false },
		{ id: "b", status: "pending", selected: false },
		{ id: "c", status: "pending", selected: true },
	];
	const reconciled = reconcileSelectionWithServer(new Set(["a", "b", "c"]), steps, {
		preserveLocalDuringRun: true,
	});
	// Done steps still mirror the server; only in-flight ids keep a local tick.
	assert.deepEqual([...reconciled].sort(), ["b", "c"]);
});

test("shouldPushSelectionToServer allows expansion mid-run but not shrink", () => {
	const onServer = new Set(["a", "b"]);
	const runningStep = [{ id: "x", status: "running" }];
	assert.equal(shouldPushSelectionToServer(new Set(["a", "b", "c"]), onServer, "running"), true);
	assert.equal(shouldPushSelectionToServer(new Set(["a"]), onServer, "running"), false);
	assert.equal(shouldPushSelectionToServer(new Set(["a"]), onServer, "draft"), false);
	// Badge can lag behind the row: still no shrink while a step is in flight.
	assert.equal(
		shouldPushSelectionToServer(new Set(["a"]), onServer, "draft", runningStep),
		false,
	);
	assert.equal(
		shouldPushSelectionToServer(new Set(["a", "b", "c"]), onServer, "draft", runningStep),
		true,
	);
});

test("workflowRunActive follows step rows when the workflow badge lags", () => {
	assert.equal(workflowRunActive("draft", [{ id: "a", status: "running" }]), true);
	assert.equal(workflowRunActive("draft", [{ id: "a", status: "pending" }]), false);
	assert.equal(workflowRunActive("waiting", []), true);
});

test("WorkflowDetail seeds when steps arrive, not only on workflow.id", () => {
	const source = fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src/views/WorkflowDetail.tsx"),
		"utf8",
	);

	assert.match(source, /selectionSynced\.current = false/, "workflow switch resets the one-time seed");
	assert.match(source, /seedSelectionFromSteps\(taskSteps\)/, "steps loading after mount must seed from the server");
	assert.match(source, /selectionSynced\.current = true/, "only seed once per workflow open");
	assert.match(source, /reconcileSelectionWithServer/, "poll must reconcile list checkboxes with server flags");
	assert.match(source, /adoptNewlyVisibleSteps/, "poll must adopt steps appended while the workflow is open");
	assert.match(source, /absorbServerSelectedPending/, "poll must absorb server ticks missing locally");
	assert.match(source, /stepIdsForStartRunWithServer/, "Start must union local ticks with server-selected runnable steps");
	assert.match(source, /stepsFullyLoaded/, "Start stays disabled until every step row has loaded");
	assert.match(source, /shouldPushSelectionToServer/, "poll must not shrink server selection mid-run");
	assert.match(source, /workflowRunActive/, "run-in-flight must follow step rows when the badge lags");
	assert.match(
		source,
		/shouldPushSelectionToServer\(next, onServer, workflow\.status, taskSteps\)/,
		"poll must heal server drift even when local Set is unchanged",
	);
	assert.match(source, /allowShrink: false/, "poll sync must not shrink server selection mid-run");
});

test("App clears steps when the selected workflow changes", () => {
	const source = fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src/App.tsx"),
		"utf8",
	);

	assert.match(
		source,
		/setSteps\(\[\]\)[\s\S]{0,120}setSessionInfo\(null\)[\s\S]{0,120}void refreshDetail\(selectedId\)/,
		"stale steps must not linger while the next workflow loads",
	);
});
