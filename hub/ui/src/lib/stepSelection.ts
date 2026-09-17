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

/** Steps the engine may still dispatch — their `selected` flag is authoritative. */
const ENGINE_ACTIVE = new Set(["pending", "failed", "waiting", "running", "queued"]);

const STEP_IN_FLIGHT = new Set(["running", "queued", "waiting"]);

/**
 * True while the sequential engine may still dispatch — from the workflow badge
 * and/or from step rows. The 2s poll can show `draft` for a beat after Start
 * while a step is already `running`; treating that as idle lets reconcile shrink
 * the server selection and strand the queue after the in-flight step finishes.
 */
export function workflowRunActive(
	workflowStatus: string,
	steps: readonly SelectableStep[],
): boolean {
	if (workflowStatus === "running" || workflowStatus === "waiting") return true;
	return steps.some((step) => STEP_IN_FLIGHT.has(step.status));
}

export interface ReconcileSelectionOptions {
	/**
	 * While a run is in flight (`running` / `waiting`), keep a tick the operator
	 * already has locally even if the server's `selected` flag is false. Mid-run
	 * deselects only come from an explicit toggle (which pushes immediately) or
	 * from the engine when a step settles `done`. Without this, a poll that
	 * mirrors the server can push a shrunken id list and strand the queue.
	 */
	preserveLocalDuringRun?: boolean;
}

/**
 * Pending steps the server still has ticked but the local Set missed (seed/poll
 * drift). Folds them in so the next Start sends them to the engine.
 */
export function absorbServerSelectedPending(
	selection: ReadonlySet<string>,
	steps: readonly SelectableStep[],
): Set<string> {
	let changed = false;
	const next = new Set(selection);
	for (const step of steps) {
		if (step.status !== "pending" && step.status !== "failed") continue;
		if (step.selected !== true) continue;
		if (next.has(step.id)) continue;
		next.add(step.id);
		changed = true;
	}
	return changed ? next : new Set(selection);
}

/** Ids the engine should receive on Start / Resume / Start over. */
export function stepIdsForStartRun(
	taskSteps: readonly SelectableStep[],
	selection: ReadonlySet<string>,
	allSelected: boolean,
): string[] {
	const runnable = taskSteps.filter((step) => step.status === "pending" || step.status === "failed");
	if (allSelected) {
		return runnable.map((step) => step.id);
	}
	return runnable.filter((step) => selection.has(step.id)).map((step) => step.id);
}

/**
 * Like `stepIdsForStartRun`, but also includes every runnable step the poll
 * already shows as `selected` on the server. Covers a partial local Set (seed
 * ran before every step row arrived) without ignoring an intentional subset when
 * the server flag is already off.
 */
export function stepIdsForStartRunWithServer(
	taskSteps: readonly SelectableStep[],
	selection: ReadonlySet<string>,
	allSelected: boolean,
): string[] {
	const ids = new Set(stepIdsForStartRun(taskSteps, selection, allSelected));
	for (const step of taskSteps) {
		if (step.status !== "pending" && step.status !== "failed") continue;
		if (step.selected === true) ids.add(step.id);
	}
	return [...ids];
}

export function adoptNewlyVisibleSteps(
	selection: ReadonlySet<string>,
	knownStepIds: ReadonlySet<string>,
	steps: readonly SelectableStep[],
): Set<string> {
	let changed = false;
	const next = new Set(selection);
	for (const step of steps) {
		if (knownStepIds.has(step.id)) continue;
		if (step.status === "pending" && step.selected === true) {
			next.add(step.id);
			changed = true;
		}
	}
	return changed ? next : new Set(selection);
}

/**
 * Aligns local checkbox state with the server for steps the engine still reads.
 * Done steps keep whatever `selectionAfterPoll` left (so a re-ticked finished
 * step stays ticked); everything else mirrors `step.selected` from the poll.
 *
 * Without this, a mid-run selection sync can leave the server with a pending
 * step unselected while the list still shows it checked — the run then stops
 * after the in-flight step even though the operator sees the next step selected.
 */
export function reconcileSelectionWithServer(
	selection: ReadonlySet<string>,
	steps: readonly SelectableStep[],
	options: ReconcileSelectionOptions = {},
): Set<string> {
	const preserve = options.preserveLocalDuringRun === true;
	const next = new Set(selection);
	for (const step of steps) {
		if (step.status === "done") {
			if (step.selected === true) next.add(step.id);
			else next.delete(step.id);
			continue;
		}
		if (!ENGINE_ACTIVE.has(step.status)) continue;
		if (step.selected === true) next.add(step.id);
		else if (!preserve) next.delete(step.id);
	}
	return next;
}

/**
 * Whether a poll-driven sync may call `PUT /selection`. During a run, never push
 * a list that would deselect steps the server still has ticked — only expansions
 * (local or newly adopted ids missing on the server).
 */
export function shouldPushSelectionToServer(
	next: ReadonlySet<string>,
	onServer: ReadonlySet<string>,
	_workflowStatus: string,
	_steps: readonly SelectableStep[] = [],
): boolean {
	if (setsEqual(next, onServer)) return false;
	// Poll sync is expand-only whenever the engine could still dispatch — and on
	// draft too, so a shrunken local Set cannot wipe the DB before Start.
	for (const id of next) {
		if (!onServer.has(id)) return true;
	}
	return false;
}

/** The server's current run selection, for comparing before a sync push. */
export function serverSelectedIds(steps: readonly SelectableStep[]): Set<string> {
	return new Set(steps.filter((step) => step.selected).map((step) => step.id));
}

export function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}
