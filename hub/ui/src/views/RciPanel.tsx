import { useState } from "react";
import type { ResourceSelection, ResourceSet, Workflow } from "../api/types.ts";
import { initialResourceDraftState, isResourceDraftDirty, markResourceDraftSaved, reconcileResourceDraft } from "./rciDraft.ts";
import { ResourceSelectionEditor } from "./ResourceSelectionEditor.tsx";
import styles from "./DetailPanels.module.css";

/** Selector for the Resource Sets injected into a workflow's conversation. */
export function RciPanel({
	workflow,
	resourceSets,
	onSave,
}: {
	workflow: Workflow;
	resourceSets: ResourceSet[];
	onSave: (resourceSelections: ResourceSelection[]) => Promise<boolean>;
}): React.JSX.Element {
	const locked = workflow.contextInjected;
	const serverSelections = workflow.resourceSelections ?? [];

	const [state, setState] = useState(() => initialResourceDraftState(workflow.id, serverSelections));
	const [saving, setSaving] = useState(false);

	// Reconcile during render so the 2s poll never wipes unsaved checkbox toggles.
	const current = reconcileResourceDraft(state, workflow.id, serverSelections);
	if (current !== state) setState(current);

	const selected = current.draft;
	const dirty = isResourceDraftDirty(current);

	const save = async (): Promise<void> => {
		if (locked || saving) return;
		setSaving(true);
		try {
			if (await onSave(selected)) setState((prev) => markResourceDraftSaved(prev, selected));
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className={styles.block}>
			<div className={styles.blockHead}>
				<h3 className={styles.blockTitle}>RCI resources</h3>
				<span className={`badge ${locked ? "badge--completed" : "badge--pending"}`}>{locked ? "locked" : "editable"}</span>
			</div>
			<p className="hint">
				Attach Resource Sets or individual skills, agents and documents. Nothing is installed into the agent — the
				resources are written into the conversation on the first step, and their reference material is placed on disk
				for the agent to read.
			</p>
			<ResourceSelectionEditor
				resourceSets={resourceSets}
				selections={selected}
				disabled={locked}
				onChange={(next) => setState((prev) => ({ ...prev, draft: next }))}
			/>
			<button
				type="button"
				className="btn btn--sm btn--primary"
				disabled={locked || saving || !dirty || resourceSets.length === 0}
				onClick={() => void save()}
			>
				{saving ? "Saving…" : "Save RCI selection"}
			</button>
		</section>
	);
}
