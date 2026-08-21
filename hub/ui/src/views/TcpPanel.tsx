import { useState } from "react";
import type { Tcp, TcpSelection, Workflow } from "../api/types.ts";
import { initialTcpDraftState, isTcpDirty, markTcpSaved, reconcileTcpDraft } from "./tcpDraft.ts";
import { TcpSelectionEditor } from "./TcpSelectionEditor.tsx";
import styles from "./DetailPanels.module.css";

/** Selector for TCP packs attached to a workflow's conversation. */
export function TcpPanel({
	workflow,
	tcps,
	onSave,
}: {
	workflow: Workflow;
	tcps: Tcp[];
	onSave: (tcpSelections: TcpSelection[]) => Promise<boolean>;
}): React.JSX.Element {
	const locked = workflow.contextInjected;
	const serverSelections = workflow.tcpSelections ?? [];

	const [state, setState] = useState(() => initialTcpDraftState(workflow.id, serverSelections));
	const [saving, setSaving] = useState(false);

	// Reconcile during render so the 2s poll never wipes unsaved checkbox toggles.
	const current = reconcileTcpDraft(state, workflow.id, serverSelections);
	if (current !== state) setState(current);

	const selected = current.draft;
	const dirty = isTcpDirty(current);

	const save = async (): Promise<void> => {
		if (locked || saving) return;
		setSaving(true);
		try {
			if (await onSave(selected)) setState((prev) => markTcpSaved(prev, selected));
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className={styles.block}>
			<div className={styles.blockHead}>
				<h3 className={styles.blockTitle}>TCP tools</h3>
				<span className={`badge ${locked ? "badge--completed" : "badge--pending"}`}>{locked ? "locked" : "editable"}</span>
			</div>
			<p className="hint">Attach Tool Context Protocol packs or individual tools. They are injected into the agent context on the first step.</p>
			<TcpSelectionEditor
				tcps={tcps}
				selections={selected}
				disabled={locked}
				onChange={(next) => setState((prev) => ({ ...prev, draft: next }))}
			/>
			<button type="button" className="btn btn--sm btn--primary" disabled={locked || saving || !dirty || tcps.length === 0} onClick={() => void save()}>
				{saving ? "Saving…" : "Save TCP selection"}
			</button>
		</section>
	);
}
