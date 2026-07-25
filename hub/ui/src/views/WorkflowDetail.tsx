import { useEffect, useMemo, useState } from "react";
import type { SessionInfo, Step, StepConfigInput, Template, Workflow } from "../api/types.ts";
import { startActionFor } from "../api/types.ts";
import { Badge } from "../components/Badge.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ProgressBar } from "../components/Progress.tsx";
import { prettyPath, relativeTime } from "../lib/format.ts";
import { ContextPanel } from "./ContextPanel.tsx";
import { SessionPanel } from "./SessionPanel.tsx";
import { StepItem } from "./StepItem.tsx";
import styles from "./WorkflowDetail.module.css";

/**
 * The selected workflow: header with status and progress, the run controls, the
 * step list, and the context/session blocks.
 *
 * Two rules from the engine drive the controls:
 *
 * - **One Start button.** Which endpoint it hits depends on status —
 *   draft→start, paused→resume, completed/failed→restart (`start` refuses
 *   those). `startActionFor` owns that mapping; the operator never picks.
 * - **Selection is explicit.** `start`/`resume`/`restart` send the checked step
 *   ids and the engine runs exactly those. An empty selection runs nothing, so
 *   the button is disabled and says why rather than silently no-op'ing.
 */
export function WorkflowDetail({
	workflow,
	steps,
	sessionInfo,
	templates,
	busy,
	onStart,
	onStop,
	onDelete,
	onSaveContext,
	onOpenTerminal,
	onAddStep,
	onSaveStep,
	onRemoveStep,
	onRunStep,
	onAbortStep,
	onAddStepsFromTemplate,
}: {
	workflow: Workflow;
	steps: Step[];
	sessionInfo: SessionInfo | null;
	templates: Template[];
	busy: boolean;
	onStart: (stepIds: string[]) => void;
	onStop: () => void;
	onDelete: () => void;
	onSaveContext: (context: string) => Promise<void>;
	onOpenTerminal: () => void;
	onAddStep: (input: StepConfigInput) => Promise<void>;
	onSaveStep: (id: string, input: StepConfigInput) => Promise<void>;
	onRemoveStep: (id: string) => void;
	onRunStep: (id: string) => void;
	onAbortStep: (id: string) => void;
	onAddStepsFromTemplate: (templateId: string) => Promise<void>;
}): React.JSX.Element {
	// Which steps the next run should dispatch. Seeded from the server's
	// `selected` flag and re-seeded when switching workflows.
	const [selection, setSelection] = useState<Set<string>>(new Set());
	const [opening, setOpening] = useState(false);

	useEffect(() => {
		setSelection(new Set(steps.filter((s) => s.selected).map((s) => s.id)));
		// Re-seed only when the workflow changes, not on every poll — otherwise
		// the operator's checkbox changes would be reverted every 2 seconds.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workflow.id]);

	// Drop ids of steps that no longer exist so a stale selection can't be sent.
	useEffect(() => {
		setSelection((current) => {
			const live = new Set(steps.map((s) => s.id));
			const next = new Set([...current].filter((id) => live.has(id)));
			return next.size === current.size ? current : next;
		});
	}, [steps]);

	const startAction = startActionFor(workflow.status);
	const running = workflow.status === "running";
	const selectedCount = selection.size;
	const allSelected = steps.length > 0 && selectedCount === steps.length;

	const startLabel = useMemo(() => {
		if (startAction === "resume") return "Resume";
		if (startAction === "restart") return "Start over";
		return "Start";
	}, [startAction]);

	const toggleStep = (id: string, checked: boolean): void => {
		setSelection((current) => {
			const next = new Set(current);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	};

	const toggleAll = (): void => {
		setSelection(allSelected ? new Set() : new Set(steps.map((s) => s.id)));
	};

	const handleOpenTerminal = async (): Promise<void> => {
		setOpening(true);
		try {
			await onOpenTerminal();
		} finally {
			setOpening(false);
		}
	};

	return (
		<section className={styles.detail} aria-label={`Workflow ${workflow.name}`}>
			<header className={styles.header}>
				<div className={styles.titleRow}>
					<h2 className={styles.title}>{workflow.name}</h2>
					<Badge status={workflow.status} />
				</div>

				<dl className={styles.facts}>
					<div className={styles.fact}>
						<dt>Agent</dt>
						<dd className="mono">{workflow.agentName}</dd>
					</div>
					<div className={styles.fact}>
						<dt>Workdir</dt>
						<dd className="mono" title={workflow.workdir ?? undefined}>
							{prettyPath(workflow.workdir) || "(unknown)"}
						</dd>
					</div>
					<div className={styles.fact}>
						<dt>Status file</dt>
						<dd className="mono" title={workflow.mdPath}>
							{prettyPath(workflow.mdPath)}
						</dd>
					</div>
					<div className={styles.fact}>
						<dt>Updated</dt>
						<dd>{relativeTime(workflow.updatedAt)}</dd>
					</div>
				</dl>

				<div className={styles.progressRow}>
					<ProgressBar progress={workflow.progress} running={running} />
					<span className={styles.progressText}>
						{workflow.progress.done}/{workflow.progress.total} steps · {workflow.progress.pct}%
					</span>
				</div>

				<div className={styles.controls}>
					<button
						type="button"
						className="btn btn--primary"
						onClick={() => onStart([...selection])}
						disabled={!startAction || busy || selectedCount === 0}
						title={
							!startAction
								? "Already running."
								: selectedCount === 0
									? "Select at least one step to run."
									: `${startLabel} the ${selectedCount} selected step${selectedCount === 1 ? "" : "s"}.`
						}
					>
						{startLabel}
						{selectedCount > 0 && startAction && <span className={styles.countPill}>{selectedCount}</span>}
					</button>

					<button type="button" className="btn" onClick={onStop} disabled={!running || busy} title="Stops dispatching further steps. The step already in flight finishes on its own.">
						Stop
					</button>

					<div className={styles.controlsSpacer} />

					<button type="button" className="btn btn--danger" onClick={onDelete} disabled={busy}>
						Delete
					</button>
				</div>
			</header>

			{/* One column, in the order the work actually reads: the context the
			    conversation starts from, the steps that run, then the session those
			    steps produced. */}
			<div className={styles.body}>
				<ContextPanel workflow={workflow} onSave={onSaveContext} />

				<div className={styles.stepsSection}>
					<div className={styles.stepsHead}>
						<h3 className={styles.sectionTitle}>
							Steps
							{steps.length > 0 && <span className={styles.count}>{steps.length}</span>}
						</h3>
						{steps.length > 0 && (
							<button type="button" className="btn btn--sm btn--ghost" onClick={toggleAll}>
								{allSelected ? "Deselect all" : "Select all"}
							</button>
						)}
					</div>

					{steps.length === 0 ? (
						<EmptyState
							title="No steps yet"
							description="Add the first task for this workflow's agent, or seed it from a template."
						/>
					) : (
						<ol className={styles.steps}>
							{steps.map((step) => (
								<StepItem
									key={step.id}
									step={step}
									selected={selection.has(step.id)}
									onToggleSelected={toggleStep}
									onSave={onSaveStep}
									onRemove={onRemoveStep}
									onRun={onRunStep}
									onAbort={onAbortStep}
									busy={busy}
								/>
							))}
						</ol>
					)}

					<AddStepForm templates={templates} onAdd={onAddStep} onAddFromTemplate={onAddStepsFromTemplate} />
				</div>

				<SessionPanel
					info={sessionInfo}
					canOpen={Boolean(sessionInfo?.sessionId ?? workflow.lastSessionId)}
					onOpenTerminal={() => void handleOpenTerminal()}
					opening={opening}
				/>
			</div>
		</section>
	);
}

/**
 * Adding steps, either by hand or by appending a template's. Collapsed by
 * default so it doesn't compete with the step list; the template path reports
 * how many were added versus skipped (the server skips descriptions the
 * workflow already has).
 */
function AddStepForm({
	templates,
	onAdd,
	onAddFromTemplate,
}: {
	templates: Template[];
	onAdd: (input: StepConfigInput) => Promise<void>;
	onAddFromTemplate: (templateId: string) => Promise<void>;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [description, setDescription] = useState("");
	const [criteria, setCriteria] = useState("");
	const [maxRetries, setMaxRetries] = useState("0");
	const [interval, setInterval] = useState("0");
	const [templateId, setTemplateId] = useState("");
	const [saving, setSaving] = useState(false);

	const intervalEnabled = (parseInt(maxRetries, 10) || 0) > 1;

	const reset = (): void => {
		setDescription("");
		setCriteria("");
		setMaxRetries("0");
		setInterval("0");
	};

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		const trimmed = description.trim();
		if (!trimmed || saving) return;
		setSaving(true);
		try {
			await onAdd({
				description: trimmed,
				acceptanceCriteria: criteria.trim(),
				maxRetries: Math.max(0, parseInt(maxRetries, 10) || 0),
				retryIntervalSeconds: intervalEnabled ? Math.max(0, parseInt(interval, 10) || 0) : 0,
			});
			reset();
		} finally {
			setSaving(false);
		}
	};

	const applyTemplate = async (): Promise<void> => {
		if (!templateId || saving) return;
		setSaving(true);
		try {
			await onAddFromTemplate(templateId);
			setTemplateId("");
		} finally {
			setSaving(false);
		}
	};

	if (!open) {
		return (
			<button type="button" className={styles.addTrigger} onClick={() => setOpen(true)}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
					<path d="M12 5v14M5 12h14" />
				</svg>
				Add step
			</button>
		);
	}

	return (
		<div className={styles.addForm}>
			<form onSubmit={submit} className={styles.addFormInner}>
				<div className="field">
					<label className="label" htmlFor="new-step-desc">
						Task description
					</label>
					<textarea
						id="new-step-desc"
						className="textarea"
						value={description}
						placeholder="What the agent should do in this step…"
						onChange={(ev) => setDescription(ev.target.value)}
						required
						autoFocus
					/>
				</div>

				<div className="field">
					<label className="label" htmlFor="new-step-criteria">
						Acceptance criteria
					</label>
					<textarea
						id="new-step-criteria"
						className="textarea"
						value={criteria}
						placeholder="Optional — what a good result must satisfy. Empty = no judge."
						onChange={(ev) => setCriteria(ev.target.value)}
					/>
					<p className="hint">
						If set, the agent self-evaluates its result after running and re-runs the step on a reject, up to the
						retry budget.
					</p>
				</div>

				<div className={styles.addGrid}>
					<div className="field">
						<label className="label" htmlFor="new-step-retries">
							Max retries
						</label>
						<input
							id="new-step-retries"
							type="number"
							className="input"
							min={0}
							step={1}
							value={maxRetries}
							onChange={(ev) => setMaxRetries(ev.target.value)}
						/>
					</div>
					<div className="field">
						<label className="label" htmlFor="new-step-interval">
							Interval (s)
						</label>
						<input
							id="new-step-interval"
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

				<div className={styles.addActions}>
					<button type="submit" className="btn btn--primary btn--sm" disabled={description.trim() === "" || saving}>
						{saving ? "Adding…" : "Add step"}
					</button>
					<button
						type="button"
						className="btn btn--sm"
						onClick={() => {
							reset();
							setOpen(false);
						}}
						disabled={saving}
					>
						Cancel
					</button>
				</div>
			</form>

			{templates.length > 0 && (
				<div className={styles.templateRow}>
					<label className="label" htmlFor="add-from-template">
						Or append a template's steps
					</label>
					<div className={styles.templateControls}>
						<select
							id="add-from-template"
							className="select"
							value={templateId}
							onChange={(ev) => setTemplateId(ev.target.value)}
						>
							<option value="">Choose a template…</option>
							{templates.map((template) => (
								<option key={template.id} value={template.id}>
									{template.name} ({template.steps.length} steps)
								</option>
							))}
						</select>
						<button
							type="button"
							className="btn btn--sm"
							onClick={() => void applyTemplate()}
							disabled={!templateId || saving}
						>
							Append
						</button>
					</div>
					<p className="hint">Steps whose description already exists in this workflow are skipped.</p>
				</div>
			)}
		</div>
	);
}
