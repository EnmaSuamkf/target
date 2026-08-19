/**
 * The rule that takes a finished step out of the run selection, client side.
 *
 * The server already clears `selected` when a step settles `done` (see
 * `DESELECT_ON_DONE` in hub/db.ts), but the open page cannot simply mirror that
 * flag on every poll: the checkboxes are local state, re-seeded from the server
 * only when the workflow changes, precisely so an operator ticking boxes for the
 * next run isn't overwritten 2 seconds later. So the page needs its own copy of
 * the rule, and this is it.
 *
 * It fires on the TRANSITION, not on the state:
 *
 * - A step that *becomes* `done` is dropped from the selection — the box was
 *   answering "what should the next Start run?", and work that just succeeded is
 *   no longer that.
 * - A step *already* `done` when we first see it is left exactly as the seed put
 *   it. That is what lets the operator re-tick a finished step to run it again:
 *   without the transition rule the next poll would silently untick it, and the
 *   box would be impossible to keep checked.
 * - Anything else — `failed` above all — is untouched. A failed step is the one
 *   the next run SHOULD pick up, so it stays ticked.
 *
 * Kept as a pure function over plain data (no React, no DOM) because that is
 * what the hub's node:test suite can drive directly — see
 * hub/step-deselect-on-done.test.ts.
 */

/** All this rule needs of a step: which one it is, and where it got to. */
export interface SelectableStep {
	id: string;
	status: string;
	selected?: boolean;
}

/**
 * Builds the checkbox selection from the server's `selected` flags. Used once
 * when a workflow's steps first arrive (including after a page reload) — the
 * poll must not re-run this every 2s or mid-run toggles would be overwritten.
 */
export function seedSelectionFromSteps(steps: readonly SelectableStep[]): Set<string> {
	return new Set(steps.filter((step) => step.selected).map((step) => step.id));
}

/**
 * Applies the rule above to one poll's worth of steps, and returns the selection
 * to render — the SAME reference when nothing finished, so the caller's
 * `setState` bails out and the common poll re-renders nothing.
 *
 * `previous` is the status of each step as of the last poll (empty on the first
 * one — every step is then a first sighting, so nothing is dropped); build the
 * next one with `stepStatuses`.
 */
export function selectionAfterPoll(
	selection: ReadonlySet<string>,
	previous: ReadonlyMap<string, string>,
	steps: readonly SelectableStep[],
): ReadonlySet<string> {
	const justFinished = steps.filter((step) => {
		const before = previous.get(step.id);
		return step.status === "done" && before !== undefined && before !== "done";
	});
	if (justFinished.length === 0) return selection;
	const next = new Set(selection);
	for (const step of justFinished) next.delete(step.id);
	return next.size === selection.size ? selection : next;
}

/**
 * The statuses to remember for the next poll. Steps that no longer exist simply
 * aren't in it, so a deleted step can't strand an entry forever.
 */
export function stepStatuses(steps: readonly SelectableStep[]): Map<string, string> {
	return new Map(steps.map((step) => [step.id, step.status]));
}
