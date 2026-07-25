import { useState } from "react";
import type { Step, StepConfigInput } from "../api/types.ts";
import { Badge } from "../components/Badge.tsx";
import { ExpandableTextarea } from "../components/ExpandableTextarea.tsx";
import { duration } from "../lib/format.ts";
import styles from "./StepItem.module.css";

/**
 * One step in the workflow's list, in either read or edit mode.
 *
 * Behaviours preserved from the previous UI because they encode real server
 * constraints, not styling choices:
 *
 * - A `running` step can't be edited, and only a `pending` one can be removed.
 * - `Abort` is only meaningful while running (it force-fails a dispatch that
 *   never called back, keeping the session so the step can be re-run).
 * - The retry interval only applies with more than one retry, so the field is
 *   disabled and forced to 0 below that.
 * - A step running its judge phase reads "judging", not "running".
 *
 * The result body is collapsed by default and expandable, replacing the old
 * hard truncation at 240 characters that made longer output unreadable.
 */
export function StepItem({
	step,
	selected,
	onToggleSelected,
	onSave,
	onRemove,
	onRun,
	onAbort,
	busy,
}: {
	step: Step;
	selected: boolean;
	onToggleSelected: (id: string, selected: boolean) => void;
	onSave: (id: string, input: StepConfigInput) => Promise<void>;
	onRemove: (id: string) => void;
	onRun: (id: string) => void;
	onAbort: (id: string) => void;
	busy: boolean;
}): React.JSX.Element {
	const [editing, setEditing] = useState(false);
	const [expanded, setExpanded] = useState(false);

	const running = step.status === "running";
	const editable = !running;
	const removable = step.status === "pending";
	const statusLabel = running && step.phase === "judge" ? "judging" : step.status;

	if (editing) {
		return (
			<li className={`${styles.step} ${styles.editing}`}>
				<StepEditor
					step={step}
					onCancel={() => setEditing(false)}
					onSave={async (input) => {
						await onSave(step.id, input);
						setEditing(false);
					}}
				/>
			</li>
		);
	}

	const elapsed = duration(step.startedAt, step.finishedAt);
	const hasResult = step.status === "done" && step.result;

	return (
		<li className={`${styles.step} ${running ? styles.stepRunning : ""}`}>
			<div className={styles.head}>
				<input
					type="checkbox"
					className={styles.check}
					checked={selected}
					onChange={(ev) => onToggleSelected(step.id, ev.target.checked)}
					aria-label={`Include step ${step.orderIndex + 1} in the next run`}
					title="Check to run only the selected steps on Start. Leave all unchecked to run nothing."
				/>
				<span className={styles.index}>{step.orderIndex + 1}</span>
				<p className={styles.description}>{step.description}</p>
				<Badge status={step.status} label={statusLabel} />
			</div>

			{(step.acceptanceCriteria || elapsed || step.manualRun) && (
				<div className={styles.meta}>
					{step.acceptanceCriteria && (
						<span className={styles.metaItem} title={step.acceptanceCriteria}>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M12 3v18M5 7h14M6 7l-3 6a3.5 3.5 0 0 0 6 0L6 7zM18 7l-3 6a3.5 3.5 0 0 0 6 0l-3-6z" />
							</svg>
							judged
							{step.maxRetries > 0 && (
								<span className={styles.retries}>
									{step.retryCount}/{step.maxRetries}
								</span>
							)}
						</span>
					)}
					{step.manualRun && <span className={styles.metaItem}>manual run</span>}
					{elapsed && <span className={styles.metaItem}>{elapsed}</span>}
				</div>
			)}

			{step.acceptanceCriteria && (
				<p className={styles.criteria}>
					<span className={styles.criteriaLabel}>Accepts if:</span> {step.acceptanceCriteria}
				</p>
			)}

			{step.error && (
				<div className={styles.error} role="alert">
					{step.error}
				</div>
			)}

			{hasResult && (
				<div className={styles.result}>
					<pre className={`${styles.resultBody} ${expanded ? styles.resultExpanded : ""}`}>{step.result}</pre>
					{/* Only offer the toggle when there's plausibly more to see. */}
					{(step.result?.length ?? 0) > 220 && (
						<button type="button" className={styles.resultToggle} onClick={() => setExpanded((v) => !v)}>
							{expanded ? "Show less" : "Show more"}
						</button>
					)}
				</div>
			)}

			<div className={styles.actions}>
				<button type="button" className="btn btn--sm" onClick={() => onRun(step.id)} disabled={running || busy}>
					{running ? "Running…" : "▶ Run"}
				</button>
				<button
					type="button"
					className="btn btn--sm btn--danger"
					onClick={() => onAbort(step.id)}
					disabled={!running || busy}
					title="Force-fail this stuck step so it can be re-run, without restarting the whole workflow. Its session is preserved."
				>
					Abort
				</button>
				<button type="button" className="btn btn--sm" onClick={() => setEditing(true)} disabled={!editable || busy}>
					Edit
				</button>
				<button
					type="button"
					className="btn btn--sm btn--ghost"
					onClick={() => onRemove(step.id)}
					disabled={!removable || busy}
					title={removable ? "Remove this step" : "Only a pending step can be removed."}
				>
					Remove
				</button>
			</div>
		</li>
	);
}

/** Inline editor for a step's description and judge configuration. */
function StepEditor({
	step,
	onCancel,
	onSave,
}: {
	step: Step;
	onCancel: () => void;
	onSave: (input: StepConfigInput) => Promise<void>;
}): React.JSX.Element {
	const [description, setDescription] = useState(step.description);
	const [criteria, setCriteria] = useState(step.acceptanceCriteria ?? "");
	const [maxRetries, setMaxRetries] = useState(String(step.maxRetries ?? 0));
	const [interval, setInterval] = useState(String(step.retryIntervalSeconds ?? 0));
	const [saving, setSaving] = useState(false);

	// The wait between retries only means something with more than one retry.
	const intervalEnabled = (parseInt(maxRetries, 10) || 0) > 1;

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		const trimmed = description.trim();
		if (!trimmed || saving) return;
		setSaving(true);
		try {
			await onSave({
				description: trimmed,
				acceptanceCriteria: criteria.trim(),
				maxRetries: Math.max(0, parseInt(maxRetries, 10) || 0),
				retryIntervalSeconds: intervalEnabled ? Math.max(0, parseInt(interval, 10) || 0) : 0,
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<form className={styles.editor} onSubmit={submit}>
			<div className={styles.editorHead}>
				<span className={styles.index}>{step.orderIndex + 1}</span>
				<span className={styles.editorTitle}>Editing step</span>
			</div>

			<label className="label" htmlFor={`desc-${step.id}`}>
				Task description
			</label>
			<ExpandableTextarea
				id={`desc-${step.id}`}
				value={description}
				onChange={setDescription}
				expandTitle="Edit task description"
				required
			/>

			<label className="label" htmlFor={`criteria-${step.id}`}>
				Acceptance criteria
			</label>
			<ExpandableTextarea
				id={`criteria-${step.id}`}
				value={criteria}
				placeholder="Optional — what a good result must satisfy. Empty = no judge."
				onChange={setCriteria}
				expandTitle="Edit acceptance criteria"
			/>
			<p className="hint">
				If set, the agent self-evaluates its result against this after running. On a reject it re-runs the step up to
				the retry budget before the workflow fails.
			</p>

			<div className={styles.editorGrid}>
				<div className="field">
					<label className="label" htmlFor={`retries-${step.id}`}>
						Max retries
					</label>
					<input
						id={`retries-${step.id}`}
						type="number"
						className="input"
						min={0}
						step={1}
						value={maxRetries}
						onChange={(ev) => setMaxRetries(ev.target.value)}
					/>
				</div>
				<div className="field">
					<label className="label" htmlFor={`interval-${step.id}`}>
						Interval (s)
					</label>
					<input
						id={`interval-${step.id}`}
						type="number"
						className="input"
						min={0}
						step={1}
						value={intervalEnabled ? interval : "0"}
						disabled={!intervalEnabled}
						onChange={(ev) => setInterval(ev.target.value)}
						title="Seconds to wait before each re-run after a judge reject. Only editable with more than one retry."
					/>
				</div>
			</div>

			<div className={styles.actions}>
				<button type="submit" className="btn btn--primary btn--sm" disabled={description.trim() === "" || saving}>
					{saving ? "Saving…" : "Save"}
				</button>
				<button type="button" className="btn btn--sm" onClick={onCancel} disabled={saving}>
					Cancel
				</button>
			</div>
		</form>
	);
}
