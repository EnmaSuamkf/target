/**
 * When a step's ↑ / ↓ arrow is live — the client-side copy of the rule
 * `moveStep` (hub/workflow.ts) enforces on the server.
 *
 * The page needs its own copy because the arrows are rendered before anyone
 * presses anything: an arrow that always looked live and answered 400 on press
 * would teach the operator nothing about why a step can't move, and a disabled
 * arrow with a tooltip teaches it before the click.
 *
 * The rule itself is "only pending work reorders":
 *
 * - A step that has already run (or is running, queued, or held at its gate)
 *   owns its position. Its result was written to `<NN>-<slug>.md`
 *   under the index it had, and the run really did reach it in that order, so
 *   renumbering it would make the list disagree with what happened.
 * - The step it would swap WITH has to be pending for the same reason — moving a
 *   pending step up past a finished one would push the finished one down.
 * - The ends are ends: nothing moves up from the first slot or down from the
 *   last.
 *
 * The list this takes is the TASK steps in display order. The hub-owned context
 * step is not part of the ordering (it's pinned before everything at
 * `CONTEXT_STEP_ORDER_INDEX`) and must be filtered out before calling, or it
 * would count as step 1's neighbour and the server would refuse the move the
 * arrow offered.
 *
 * Pure function over plain data (no React, no DOM), so the hub's node:test suite
 * can drive it directly — see hub/step-move.test.ts.
 */

/** All this rule needs of a step: where it got to. */
export interface MovableStep {
	status: string;
}

/** Which way `canMoveStep` is asking about. */
export type StepMoveDirection = "up" | "down";

export function canMoveStep(
	steps: readonly MovableStep[],
	index: number,
	direction: StepMoveDirection,
): boolean {
	const step = steps[index];
	if (!step || step.status !== "pending") return false;
	const neighbour = steps[direction === "up" ? index - 1 : index + 1];
	return neighbour !== undefined && neighbour.status === "pending";
}
