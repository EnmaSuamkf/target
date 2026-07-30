import { useEffect, useState } from "react";
import type { StagedStepImages, StepConfigInput } from "../api/types.ts";
import { ExpandableTextarea } from "../components/ExpandableTextarea.tsx";
import { Field } from "../components/Field.tsx";
import { Modal } from "../components/Modal.tsx";
import { Switch } from "../components/Switch.tsx";
import { useStagedImages } from "../hooks/useStagedImages.ts";
import styles from "./AddStepModal.module.css";

/**
 * "Add step" for a step held at its manual-review gate: the human read the
 * result, it needs a correction, and the correction has to run BEFORE whatever
 * came next. The server inserts the new step directly after `afterIndex` and
 * pushes the rest down, so pressing Continue afterwards dispatches this step
 * rather than the one that used to follow.
 *
 * Same fields as the step editor and the collapsible add-step form under the
 * list — a step is a step wherever it's written — but in a dialog rather than
 * inline, because it's opened from a step's action row and inline growth there
 * would push the rest of the list off screen. The consequence ("this runs next")
 * is in the dialog's description rather than in a hint, since it's the entire
 * reason this dialog exists and not a detail of one field.
 */
export function AddStepModal({
	open,
	afterIndex,
	onClose,
	onAdd,
}: {
	open: boolean;
	/** 1-based number of the step this one is inserted after, for the copy. */
	afterIndex: number;
	onClose: () => void;
	onAdd: (input: StepConfigInput, staged?: StagedStepImages) => Promise<void>;
}): React.JSX.Element {
	// The step doesn't exist yet, so its images are held here and uploaded by the
	// caller right after the create returns an id.
	const staged = useStagedImages("add-step-after");
	const [description, setDescription] = useState("");
	const [criteria, setCriteria] = useState("");
	const [manualReview, setManualReview] = useState(false);
	// Default ON — every step ran through a subagent before this toggle existed.
	const [useSubagent, setUseSubagent] = useState(true);
	const [maxRetries, setMaxRetries] = useState("0");
	const [interval, setInterval] = useState("0");
	const [saving, setSaving] = useState(false);

	// Fresh form on every open — a dialog reopened after an add must not still be
	// holding the previous step's text.
	useEffect(() => {
		if (!open) return;
		setDescription("");
		setCriteria("");
		setManualReview(false);
		setUseSubagent(true);
		setMaxRetries("0");
		setInterval("0");
		staged.reset();
		// `staged.reset` is stable (useCallback with no deps); listing it would only
		// add noise to a "clear the form when it opens" effect.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// The wait between retries only means something with more than one retry.
	const intervalEnabled = (parseInt(maxRetries, 10) || 0) > 1;
	const canSubmit = description.trim() !== "" && !saving;

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (!canSubmit) return;
		setSaving(true);
		try {
			await onAdd(
				{
					description: description.trim(),
					acceptanceCriteria: criteria.trim(),
					// Always sent, like the other two step forms: the server only touches
					// the stored gate when the field is present.
					manualReview,
					useSubagent,
					maxRetries: Math.max(0, parseInt(maxRetries, 10) || 0),
					retryIntervalSeconds: intervalEnabled ? Math.max(0, parseInt(interval, 10) || 0) : 0,
				},
				staged.staged,
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			open={open}
			title={`Add a step after step ${afterIndex}`}
			description="It goes in right after this one, so it's the next thing the agent does when you press Continue. Everything that followed moves down a place."
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn" onClick={onClose} disabled={saving}>
						Cancel
					</button>
					<button type="submit" form="add-step-after" className="btn btn--primary" disabled={!canSubmit}>
						{saving ? "Adding…" : "Add step"}
					</button>
				</>
			}
		>
			<form id="add-step-after" className={styles.form} onSubmit={submit}>
				<Field label="Task description" required>
					{(props) => (
						<ExpandableTextarea
							{...props}
							value={description}
							placeholder="What the agent should do in this step…"
							onChange={setDescription}
							expandTitle="Edit task description"
							attachments={staged.attachmentsFor("description")}
							required
							autoFocus
						/>
					)}
				</Field>

				<Field
					label="Acceptance criteria"
					hint="Optional — what a good result must satisfy. Empty = no judge. If set, the agent self-evaluates its result after running and re-runs the step on a reject, up to the retry budget."
				>
					{(props) => (
						<ExpandableTextarea
							{...props}
							value={criteria}
							placeholder="Optional — what a good result must satisfy."
							onChange={setCriteria}
							expandTitle="Edit acceptance criteria"
							attachments={staged.attachmentsFor("acceptance")}
						/>
					)}
				</Field>

				<div className={styles.gateRow}>
					<div className={styles.gateText}>
						<span className="label">Manual review</span>
						<p className="hint" id="add-step-after-review-hint">
							The workflow stops after this step too and waits for you: it's marked <em>waiting</em> until you press
							Continue on it.
						</p>
					</div>
					<Switch
						checked={manualReview}
						onChange={setManualReview}
						label="Manual review"
						describedBy="add-step-after-review-hint"
						disabled={saving}
					/>
				</div>

				<div className={styles.gateRow}>
					<div className={styles.gateText}>
						<span className="label">Use subagent</span>
						<p className="hint" id="add-step-after-subagent-hint">
							On: the agent delegates this step to a subagent (the Task tool), keeping the shared session light. Off:
							it does the work itself, inline in the conversation.
						</p>
					</div>
					<Switch
						checked={useSubagent}
						onChange={setUseSubagent}
						label="Use subagent"
						describedBy="add-step-after-subagent-hint"
						disabled={saving}
					/>
				</div>

				<div className={styles.grid}>
					<Field label="Max retries">
						{(props) => (
							<input
								{...props}
								type="number"
								className="input"
								min={0}
								step={1}
								value={maxRetries}
								onChange={(ev) => setMaxRetries(ev.target.value)}
							/>
						)}
					</Field>
					<Field
						label="Interval (s)"
						hint="Seconds between re-runs after a judge reject. Only editable with more than one retry."
					>
						{(props) => (
							<input
								{...props}
								type="number"
								className="input"
								min={0}
								step={1}
								value={intervalEnabled ? interval : "0"}
								disabled={!intervalEnabled}
								onChange={(ev) => setInterval(ev.target.value)}
							/>
						)}
					</Field>
				</div>
			</form>
		</Modal>
	);
}
