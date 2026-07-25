import { useState } from "react";
import type { Workflow } from "../api/types.ts";
import { initialDraftState, isDirty, markSaved, reconcileDraft } from "./contextDraft.ts";
import styles from "./DetailPanels.module.css";

/**
 * The workflow's conversation context — a preamble injected once, before the
 * first step of a fresh conversation.
 *
 * The locking rule comes straight from the server: once `contextInjected` is
 * true the agent is already operating under this text, so editing it
 * mid-conversation would be silently inconsistent and `PATCH .../context`
 * answers 400. The field goes read-only and says how to unlock it (restart,
 * which resets the flag and starts a fresh conversation).
 *
 * The draft is local state seeded from the workflow. The 2s poll would happily
 * wipe whatever the operator is typing, so a new server value is adopted only
 * when the draft has no unsaved edits — tracked by comparing it against
 * `synced` (the text the draft last agreed with), never by focus.
 *
 * Focus is deliberately NOT the guard: clicking "Save context" blurs the
 * textarea *before* the click is dispatched, so a focus-gated resync fired on
 * that blur, reset the draft to the stale server value and disabled the Save
 * button — the typed text vanished and nothing was ever saved.
 */
export function ContextPanel({
	workflow,
	onSave,
}: {
	workflow: Workflow;
	/** Resolves true only when the server really stored the context. */
	onSave: (context: string) => Promise<boolean>;
}): React.JSX.Element {
	const injected = workflow.contextInjected;
	const serverValue = workflow.conversationContext ?? "";

	const [state, setState] = useState(() => initialDraftState(workflow.id, serverValue));
	const [saving, setSaving] = useState(false);

	// Reconcile during render (React's derived-state pattern) rather than in an
	// effect, so adoption can never land between a blur and the click that
	// caused it. `reconcileDraft` returns the same object when there's nothing
	// to do, which keeps this from looping.
	const current = reconcileDraft(state, workflow.id, serverValue);
	if (current !== state) setState(current);

	const draft = current.draft;
	const dirty = isDirty(current);
	const setDraft = (value: string): void => setState((prev) => ({ ...prev, draft: value }));

	const save = async (): Promise<void> => {
		if (saving || injected) return;
		setSaving(true);
		try {
			// Only treat the draft as saved when the server actually took it —
			// otherwise a failed save would silently look persisted.
			if (await onSave(draft)) setState((prev) => markSaved(prev, draft));
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className={styles.block}>
			<div className={styles.blockHead}>
				<h3 className={styles.blockTitle}>Conversation context</h3>
				<span className={`badge ${injected ? "badge--completed" : "badge--pending"}`}>
					{injected ? "injected" : serverValue ? "pending" : "none"}
				</span>
			</div>

			<p className="hint">
				Background every step inherits. Injected once, before the first step of a fresh conversation.
				{injected && " Locked — the agent is already running under it. Start the workflow over to change it."}
			</p>

			<textarea
				className="textarea"
				value={draft}
				readOnly={injected}
				placeholder="Optional — constraints, definitions or a persona every step should share."
				onChange={(ev) => setDraft(ev.target.value)}
				aria-label="Conversation context"
			/>

			{!injected && (
				<div className={styles.blockActions}>
					<button type="button" className="btn btn--sm btn--primary" onClick={save} disabled={!dirty || saving}>
						{saving ? "Saving…" : "Save context"}
					</button>
					{dirty && !saving && (
						<button type="button" className="btn btn--sm btn--ghost" onClick={() => setDraft(current.synced)}>
							Discard
						</button>
					)}
				</div>
			)}
		</section>
	);
}
