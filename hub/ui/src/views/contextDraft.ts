/**
 * The rule that decides when the conversation-context textarea may adopt a new
 * value from the server, extracted from ContextPanel so it can be tested
 * without a DOM.
 *
 * The panel polls the workflow every 2s, so a naive "copy the server value into
 * the textarea" would wipe whatever the operator is typing. The original guard
 * was focus ("don't resync while the field is focused"), and that is exactly
 * what broke saving: clicking "Save context" blurs the textarea *before* the
 * click event is dispatched, so the resync fired on that blur, reset the draft
 * to the stale server value and disabled the (now non-dirty) Save button — the
 * typed text disappeared and nothing was ever saved.
 *
 * The rule here uses editedness instead of focus: a draft that differs from the
 * text it last agreed with (`synced`) has unsaved edits and is never
 * overwritten. Focus never enters into it.
 */

export interface DraftState {
	/** Workflow the draft belongs to; a change means "show the other one". */
	id: string;
	/** The server value last observed, used to detect an actual server change. */
	seen: string;
	/** What the operator currently has in the textarea. */
	draft: string;
	/**
	 * The text the draft last agreed with: the server value last adopted, or
	 * the text last saved successfully. `draft !== synced` means unsaved edits.
	 */
	synced: string;
}

/** The state a freshly mounted panel starts from. */
export function initialDraftState(id: string, serverValue: string): DraftState {
	return { id, seen: serverValue, draft: serverValue, synced: serverValue };
}

/** True when the draft holds edits that have not been saved to the server. */
export function isDirty(state: DraftState): boolean {
	return state.draft !== state.synced;
}

/**
 * Folds the latest `workflow` into the draft state. Returns the *same object*
 * when nothing changes, so the caller can use it as a "no update needed" check
 * and avoid an endless render loop.
 *
 * - Different workflow → always reset; a draft must never leak across
 *   workflows.
 * - Same workflow, server value actually changed → adopt it only when there
 *   are no unsaved edits to lose. (After a successful save this is what
 *   reconciles the draft with the exact stored text, which the server trims.)
 * - Server value unchanged → nothing to do, whatever the operator has typed
 *   stays put.
 */
export function reconcileDraft(state: DraftState, id: string, serverValue: string): DraftState {
	if (state.id !== id) return initialDraftState(id, serverValue);
	if (state.seen === serverValue) return state;
	if (isDirty(state)) return { ...state, seen: serverValue };
	return { id, seen: serverValue, draft: serverValue, synced: serverValue };
}

/** Records a successful save: the draft now agrees with what the server stored. */
export function markSaved(state: DraftState, saved: string): DraftState {
	return { ...state, synced: saved };
}
