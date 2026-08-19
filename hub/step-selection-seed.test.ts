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

const { seedSelectionFromSteps, selectionAfterPoll, stepStatuses } = await import("./ui/src/lib/stepSelection.ts");

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

test("WorkflowDetail seeds when steps arrive, not only on workflow.id", () => {
	const source = fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src/views/WorkflowDetail.tsx"),
		"utf8",
	);

	assert.match(source, /selectionSynced\.current = false/, "workflow switch resets the one-time seed");
	assert.match(source, /seedSelectionFromSteps\(taskSteps\)/, "steps loading after mount must seed from the server");
	assert.match(source, /selectionSynced\.current = true/, "only seed once per workflow open");
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
