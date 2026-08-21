/**
 * When the workflow poll may adopt a new TCP selection from the server,
 * extracted from TcpPanel so it can be tested without a DOM.
 *
 * Same rule as contextDraft: a draft that differs from what it last agreed
 * with (`synced`) has unsaved edits and is never overwritten by the poll.
 */
import type { TcpSelection } from "../api/types.ts";
import { sameTcpSelections } from "../tcpSelection.ts";

export interface TcpDraftState {
	/** Workflow the draft belongs to; a change means "show the other one". */
	id: string;
	/** The server selection last observed, used to detect an actual server change. */
	seen: TcpSelection[];
	/** What the operator currently has checked. */
	draft: TcpSelection[];
	/**
	 * The selection the draft last agreed with: the server value last adopted,
	 * or the selection last saved successfully. `draft !== synced` means unsaved edits.
	 */
	synced: TcpSelection[];
}

/** The state a freshly mounted panel starts from. */
export function initialTcpDraftState(id: string, serverSelections: TcpSelection[]): TcpDraftState {
	return { id, seen: serverSelections, draft: serverSelections, synced: serverSelections };
}

/** True when the draft holds edits that have not been saved to the server. */
export function isTcpDirty(state: TcpDraftState): boolean {
	return !sameTcpSelections(state.draft, state.synced);
}

/**
 * Folds the latest workflow TCP selections into the draft state. Returns the *same
 * object* when nothing changes, so the caller can use it as a "no update
 * needed" check and avoid an endless render loop.
 */
export function reconcileTcpDraft(state: TcpDraftState, id: string, serverSelections: TcpSelection[]): TcpDraftState {
	if (state.id !== id) return initialTcpDraftState(id, serverSelections);
	if (sameTcpSelections(state.seen, serverSelections)) return state;
	if (isTcpDirty(state)) return { ...state, seen: serverSelections };
	return { id, seen: serverSelections, draft: serverSelections, synced: serverSelections };
}

/** Records a successful save: the draft now agrees with what the server stored. */
export function markTcpSaved(state: TcpDraftState, saved: TcpSelection[]): TcpDraftState {
	return { ...state, synced: saved };
}
