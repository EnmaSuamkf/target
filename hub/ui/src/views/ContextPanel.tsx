import { useEffect, useState } from "react";
import type { Workflow } from "../api/types.ts";
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
 * The draft is local state seeded from the workflow, and deliberately *not*
 * re-synced while focused — the 2s poll would otherwise wipe whatever the
 * operator is typing.
 */
export function ContextPanel({
	workflow,
	onSave,
}: {
	workflow: Workflow;
	onSave: (context: string) => Promise<void>;
}): React.JSX.Element {
	const [draft, setDraft] = useState(workflow.conversationContext ?? "");
	const [focused, setFocused] = useState(false);
	const [saving, setSaving] = useState(false);

	const injected = workflow.contextInjected;
	const serverValue = workflow.conversationContext ?? "";

	// Adopt the server value on poll, but never while the field has focus.
	useEffect(() => {
		if (!focused) setDraft(serverValue);
	}, [serverValue, focused]);

	const dirty = draft !== serverValue;

	const save = async (): Promise<void> => {
		if (saving || injected) return;
		setSaving(true);
		try {
			await onSave(draft);
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
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				aria-label="Conversation context"
			/>

			{!injected && (
				<div className={styles.blockActions}>
					<button type="button" className="btn btn--sm btn--primary" onClick={save} disabled={!dirty || saving}>
						{saving ? "Saving…" : "Save context"}
					</button>
					{dirty && !saving && (
						<button type="button" className="btn btn--sm btn--ghost" onClick={() => setDraft(serverValue)}>
							Discard
						</button>
					)}
				</div>
			)}
		</section>
	);
}
