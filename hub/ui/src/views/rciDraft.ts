/**
 * When the workflow poll may adopt a new RCI selection from the server —
 * the resources counterpart of `tcpDraft.ts`, and the same rule: a draft that
 * differs from what it last agreed with (`synced`) has unsaved edits and is
 * never overwritten by the poll.
 */
import type { ResourceSelection } from "../api/types.ts";
import { sameResourceSelections } from "../rciSelection.ts";

export interface ResourceDraftState {
	id: string;
	seen: ResourceSelection[];
	draft: ResourceSelection[];
	synced: ResourceSelection[];
}

export function initialResourceDraftState(id: string, serverSelections: ResourceSelection[]): ResourceDraftState {
	return { id, seen: serverSelections, draft: serverSelections, synced: serverSelections };
}

export function isResourceDraftDirty(state: ResourceDraftState): boolean {
	return !sameResourceSelections(state.draft, state.synced);
}

/** Returns the *same object* when nothing changes, so the caller can skip the update. */
export function reconcileResourceDraft(
	state: ResourceDraftState,
	id: string,
	serverSelections: ResourceSelection[],
): ResourceDraftState {
	if (state.id !== id) return initialResourceDraftState(id, serverSelections);
	if (sameResourceSelections(state.seen, serverSelections)) return state;
	if (isResourceDraftDirty(state)) return { ...state, seen: serverSelections };
	return { id, seen: serverSelections, draft: serverSelections, synced: serverSelections };
}

export function markResourceDraftSaved(state: ResourceDraftState, saved: ResourceSelection[]): ResourceDraftState {
	return { ...state, synced: saved };
}
