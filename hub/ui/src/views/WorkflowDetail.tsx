import { useEffect, useMemo, useRef, useState } from "react";
import type {
	AttachmentField,
	OverridableStepStatus,
	OverridableWorkflowStatus,
	SessionInfo,
	StagedStepImages,
	Step,
	StepConfigInput,
	Template,
	Workflow,
} from "../api/types.ts";
import { OVERRIDABLE_WORKFLOW_STATUSES, startActionFor } from "../api/types.ts";
import { Badge } from "../components/Badge.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ExpandableTextarea } from "../components/ExpandableTextarea.tsx";
import { ProgressBar } from "../components/Progress.tsx";
import { Switch } from "../components/Switch.tsx";
import { useStagedImages } from "../hooks/useStagedImages.ts";
import { prettyPath, relativeTime } from "../lib/format.ts";
import { selectionAfterPoll, stepStatuses } from "../lib/stepSelection.ts";
import { ContextPanel } from "./ContextPanel.tsx";
import { RenameWorkflowModal } from "./RenameWorkflowModal.tsx";
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
 *   the button is disabled and says why rather than silently no-op'ing. A step
 *   unticks itself when it finishes `done` (`selectionAfterPoll`), so the boxes
 *   keep meaning "what the next run should do" instead of drifting back to
 *   "everything"; after a whole run that leaves nothing ticked, and Start over
 *   asks for a choice — "Select all" is one click.
 * - **A `waiting` workflow has no Start at all.** It's held at a step's
 *   manual-review gate, and the only ways out are on that step: Continue to
 *   approve it and carry on, or Abort to refuse it and stop (the server refuses
 *   a Start on it), so the button says so instead of failing.
 * - **The status picker overrules all of that.** It doesn't run anything: it
 *   records what really happened when the engine's verdict is wrong (a run that
 *   ran out of tokens, a callback that never landed). The hub then leaves that
 *   status alone until the workflow is run again, and the badge is marked as
 *   set by hand.
 *
 * `onBack` is passed only when this pane is the whole screen (a phone, where
 * the workflow list is not next to it) — it's what turns "the detail half of a
 * split view" into "a screen you can leave".
 */
export function WorkflowDetail({
	workflow,
	steps,
	sessionInfo,
	templates,
	busy,
	onBack,
	onStart,
	onStop,
	onClone,
	onRename,
	onDelete,
	onSetStatus,
	onSaveContext,
	onAttachImages,
	onRemoveAttachment,
	onOpenTerminal,
	onAddStep,
	onSaveStep,
	onRemoveStep,
	onAbortStep,
	onContinueStep,
	onOpenStepConversation,
	onAddStepAfter,
	onSetStepStatus,
	onAddStepsFromTemplate,
}: {
	workflow: Workflow;
	steps: Step[];
	sessionInfo: SessionInfo | null;
	templates: Template[];
	busy: boolean;
	/** Only supplied when the list isn't on screen beside this pane. */
	onBack?: () => void;
	onStart: (stepIds: string[]) => void;
	onStop: () => void;
	/** Opens the clone dialog for this workflow — the new-workflow form, seeded from it. */
	onClone: () => void;
	/** Saves a new name; resolves true only when the server stored it. */
	onRename: (name: string) => Promise<boolean>;
	onDelete: () => void;
	/** Forces the workflow's status by hand; never runs anything. */
	onSetStatus: (status: OverridableWorkflowStatus) => void;
	/** Resolves true only when the server really stored the context. */
	onSaveContext: (context: string) => Promise<boolean>;
	/**
	 * Pins images to one of this workflow's text inputs. `stepId` is null for the
	 * conversation context and the step's id for its description / criteria.
	 */
	onAttachImages: (field: AttachmentField, stepId: string | null, files: File[]) => Promise<boolean>;
	onRemoveAttachment: (id: string) => void;
	onOpenTerminal: () => void;
	onAddStep: (input: StepConfigInput, staged?: StagedStepImages) => Promise<void>;
	onSaveStep: (id: string, input: StepConfigInput) => Promise<void>;
	onRemoveStep: (id: string) => void;
	onAbortStep: (id: string) => void;
	onContinueStep: (id: string) => void;
	/** Opens a terminal on one step's own session (the held step's "Open conversation"). */
	onOpenStepConversation: (id: string) => void;
	/** Inserts a step right after the given one, so it runs next. */
	onAddStepAfter: (afterStepId: string, input: StepConfigInput, staged?: StagedStepImages) => Promise<boolean>;
	/** Forces one step's status by hand; never runs the step. */
	onSetStepStatus: (id: string, status: OverridableStepStatus) => void;
	onAddStepsFromTemplate: (templateId: string) => Promise<void>;
}): React.JSX.Element {
	// Which steps the next run should dispatch. Seeded from the server's
	// `selected` flag and re-seeded when switching workflows.
	const [selection, setSelection] = useState<Set<string>>(new Set());
	const [opening, setOpening] = useState(false);
	// The rename dialog opened by "Change", next to the title.
	const [renaming, setRenaming] = useState(false);
	// Each step's status as of the previous poll, so a step that FINISHES can be
	// told apart from one that was already finished when we got here — the whole
	// difference between "untick it now" and "untick it forever". A ref, not
	// state: it feeds the next comparison, it is never rendered.
	const seenStatuses = useRef<Map<string, string>>(new Map());

	const sectionRef = useRef<HTMLElement>(null);

	// The hub-owned conversation-context step is split off BEFORE any selection
	// state is computed. It is not work the operator chose, and leaving it in
	// would break all three derived numbers at once: "Select all" could never
	// reach `allSelected` (nothing can check it), `selectedCount` would overstate
	// the run by one, and the count next to "Steps" would disagree with the
	// progress bar, which counts task steps only. It's rendered separately below.
	const contextStep = useMemo(() => steps.find((s) => s.kind === "context") ?? null, [steps]);
	const taskSteps = useMemo(() => steps.filter((s) => s.kind !== "context"), [steps]);

	useEffect(() => {
		setSelection(new Set(taskSteps.filter((s) => s.selected).map((s) => s.id)));
		// A rename dialog left open belongs to the workflow it was opened from —
		// carrying it into another one would offer that name for this workflow.
		setRenaming(false);
		// The steps of the workflow being left tell us nothing about the one being
		// opened: start the transition history empty so every step of the new
		// workflow counts as a first sighting and the seed above stands as it is.
		seenStatuses.current = new Map();
		// Re-seed only when the workflow changes, not on every poll — otherwise
		// the operator's checkbox changes would be reverted every 2 seconds.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workflow.id]);

	// A step that finishes lets go of its checkbox: the selection says what the
	// next run should do, and a step that just succeeded isn't it. Only the
	// pending→done transition does this (see `selectionAfterPoll`), so a finished
	// step the operator re-ticks to run again stays ticked.
	useEffect(() => {
		const previous = seenStatuses.current;
		seenStatuses.current = stepStatuses(taskSteps);
		// Functional form so the rule always reads the checkboxes as they stand
		// right now, and returns the same Set when nothing finished (React then
		// bails out, so the common poll re-renders nothing).
		setSelection((current) => selectionAfterPoll(current, previous, taskSteps) as Set<string>);
	}, [taskSteps]);

	// Move focus to the detail pane when a workflow is opened, so keyboard
	// navigation and screen readers land on the workflow's controls instead of
	// staying on the list item that was clicked. Runs only when the workflow
	// changes — the id is stable across the 2s poll, so this never steals focus
	// back while the operator is working in the open workflow.
	useEffect(() => {
		sectionRef.current?.focus();
	}, [workflow.id]);

	// Drop ids of steps that no longer exist so a stale selection can't be sent.
	useEffect(() => {
		setSelection((current) => {
			const live = new Set(taskSteps.map((s) => s.id));
			const next = new Set([...current].filter((id) => live.has(id)));
			return next.size === current.size ? current : next;
		});
	}, [taskSteps]);

	const startAction = startActionFor(workflow.status);
	const running = workflow.status === "running";
	// The server refuses a workflow override while a step still has a callback
	// coming — that callback would write a status over it seconds later.
	const stepInFlight = steps.some((s) => s.status === "running" || s.status === "queued");
	const selectedCount = selection.size;
	const allSelected = taskSteps.length > 0 && selectedCount === taskSteps.length;

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
		setSelection(allSelected ? new Set() : new Set(taskSteps.map((s) => s.id)));
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
		<section ref={sectionRef} className={styles.detail} tabIndex={-1} data-workflow-detail aria-label={`Workflow ${workflow.name}`}>
			<header className={styles.header}>
				{onBack && (
					<button type="button" className={styles.back} onClick={onBack}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<path d="M15 18l-6-6 6-6" />
						</svg>
						Workflows
					</button>
				)}

				<div className={styles.titleRow}>
					<h2 className={styles.title}>{workflow.name}</h2>
					{/* Next to the name, because it edits the name and nothing else —
					    it is not a run control and doesn't belong in that row. */}
					<button
						type="button"
						className={`btn btn--sm btn--ghost ${styles.rename}`}
						onClick={() => setRenaming(true)}
						disabled={busy}
						title="Change this workflow's name."
					>
						Change
					</button>
					<Badge status={workflow.status} manual={workflow.statusManual} manualAt={workflow.statusManualAt} />
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
						<dt>Sandbox</dt>
						<dd title={workflow.image ?? undefined}>
							{workflow.sandbox === "docker" ? `docker · ${workflow.image ?? "default image"}` : "this machine"}
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
					{/* data-start-workflow is the stable hook the Alt/Shift+S shortcut
					    clicks (CSS Module class names are hashed, so they can't be
					    querySelector'd) — see lib/startShortcut.ts. It sits on the button
					    whatever its label reads: it's the one run control, and `disabled`
					    below is already the whole answer to "can this be started now?". */}
					<button
						type="button"
						className="btn btn--primary"
						onClick={() => onStart([...selection])}
						disabled={!startAction || busy || selectedCount === 0}
						data-start-workflow
						title={
							!startAction
								? workflow.status === "waiting"
									? "A step is waiting for your review — Continue it to carry on, or Abort it to stop here."
									: "Already running."
								: selectedCount === 0
									? "Select at least one step to run."
									: `${startLabel} the ${selectedCount} selected step${selectedCount === 1 ? "" : "s"}. Alt/Shift+S presses this button.`
						}
					>
						{startLabel}
						{selectedCount > 0 && startAction && <span className={styles.countPill}>{selectedCount}</span>}
					</button>

					<button type="button" className="btn" onClick={onStop} disabled={!running || busy} title="Stops dispatching further steps. The step already in flight finishes on its own.">
						Stop
					</button>

					{/* Beside the run controls, because it's how you get a second run of
					    this same work without retyping it — but it dispatches nothing,
					    and it doesn't even copy on click: it opens the new-workflow form
					    seeded from this workflow, so the copy is configured before it
					    exists rather than fixed up afterwards. */}
					<button
						type="button"
						className={`btn ${styles.clone}`}
						onClick={onClone}
						disabled={busy}
						title="Copy this workflow — all of its steps, in order, and its context — into a new one. Opens the new-workflow form seeded from this workflow, so the copy's name, directory, agent and permissions can be changed before it is created."
					>
						Clone
					</button>

					{/* Says what really happened when the engine's verdict is wrong.
					    Deliberately NOT a run control: it dispatches nothing, and it's a
					    picker rather than four buttons so the run controls stay the
					    obvious thing to press — and so it's one target on a phone. */}
					<select
						className={`select ${styles.statusSelect}`}
						value=""
						disabled={busy || stepInFlight}
						aria-label="Set this workflow's status by hand"
						title={
							stepInFlight
								? "A step is still in flight — stop or abort it first."
								: "Correct the status by hand when a step really succeeded but was recorded as failed. Nothing is run."
						}
						onChange={(ev) => {
							const next = ev.target.value as OverridableWorkflowStatus | "";
							ev.target.value = "";
							if (next) onSetStatus(next);
						}}
					>
						<option value="">Set status…</option>
						{OVERRIDABLE_WORKFLOW_STATUSES.filter((s) => s !== workflow.status).map((s) => (
							<option key={s} value={s}>
								Mark {s}
							</option>
						))}
					</select>

					<div className={styles.controlsSpacer} />

					<button type="button" className={`btn btn--danger ${styles.delete}`} onClick={onDelete} disabled={busy}>
						Delete
					</button>
				</div>
			</header>

			{/* One column, in the order the work actually reads: the context the
			    conversation starts from, the steps that run, then the session those
			    steps produced. */}
			<div className={styles.body}>
				<ContextPanel
					workflow={workflow}
					onSave={onSaveContext}
					onAttach={(files) => onAttachImages("context", null, files)}
					onRemoveAttachment={onRemoveAttachment}
				/>

				<div className={styles.stepsSection}>
					<div className={styles.stepsHead}>
						<h3 className={styles.sectionTitle}>
							Steps
							{taskSteps.length > 0 && <span className={styles.count}>{taskSteps.length}</span>}
						</h3>
						{taskSteps.length > 0 && (
							<button type="button" className="btn btn--sm btn--ghost" onClick={toggleAll}>
								{allSelected ? "Deselect all" : "Select all"}
							</button>
						)}
					</div>

					{/* Pinned above the numbered list, not inside it: it runs before step 1
					    but it isn't step 0, and putting it in the <ol> would number it. */}
					{contextStep && (
						<ul className={styles.steps}>
							<StepItem
								key={contextStep.id}
								step={contextStep}
								selected={false}
								onToggleSelected={toggleStep}
								onSave={onSaveStep}
								onRemove={onRemoveStep}
								onAbort={onAbortStep}
								onContinue={onContinueStep}
								onOpenConversation={onOpenStepConversation}
								onAddStepAfter={onAddStepAfter}
								onSetStatus={onSetStepStatus}
								onAttachImages={onAttachImages}
								onRemoveAttachment={onRemoveAttachment}
								busy={busy}
							/>
						</ul>
					)}

					{taskSteps.length === 0 ? (
						<EmptyState
							title="No steps yet"
							description="Add the first task for this workflow's agent, or seed it from a template."
						/>
					) : (
						<ol className={styles.steps}>
							{taskSteps.map((step) => (
								<StepItem
									key={step.id}
									step={step}
									selected={selection.has(step.id)}
									onToggleSelected={toggleStep}
									onSave={onSaveStep}
									onRemove={onRemoveStep}
									onAbort={onAbortStep}
									onContinue={onContinueStep}
									onOpenConversation={onOpenStepConversation}
									onAddStepAfter={onAddStepAfter}
									onSetStatus={onSetStepStatus}
									onAttachImages={onAttachImages}
									onRemoveAttachment={onRemoveAttachment}
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

			<RenameWorkflowModal
				open={renaming}
				name={workflow.name}
				onClose={() => setRenaming(false)}
				onSave={onRename}
			/>
		</section>
	);
}

/**
 * Adding steps, either by hand or by appending a template's. Collapsed by
 * default so it doesn't compete with the step list; the template path reports
 * how many steps were added — always the template's full list, since appending
 * the same template twice is a legitimate way to queue a second round.
 */
function AddStepForm({
	templates,
	onAdd,
	onAddFromTemplate,
}: {
	templates: Template[];
	onAdd: (input: StepConfigInput, staged?: StagedStepImages) => Promise<void>;
	onAddFromTemplate: (templateId: string) => Promise<void>;
}): React.JSX.Element {
	// Images picked before the step exists; uploaded by the caller once it does.
	const staged = useStagedImages("new-step");
	const [open, setOpen] = useState(false);
	const [description, setDescription] = useState("");
	const [criteria, setCriteria] = useState("");
	const [manualReview, setManualReview] = useState(false);
	// Default ON — the behaviour every step had before this toggle existed.
	const [useSubagent, setUseSubagent] = useState(true);
	const [maxRetries, setMaxRetries] = useState("0");
	const [interval, setInterval] = useState("0");
	const [templateId, setTemplateId] = useState("");
	const [saving, setSaving] = useState(false);

	const intervalEnabled = (parseInt(maxRetries, 10) || 0) > 1;

	const reset = (): void => {
		setDescription("");
		setCriteria("");
		setManualReview(false);
		setUseSubagent(true);
		setMaxRetries("0");
		setInterval("0");
		staged.reset();
	};

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		const trimmed = description.trim();
		if (!trimmed || saving) return;
		setSaving(true);
		try {
			await onAdd(
				{
					description: trimmed,
					acceptanceCriteria: criteria.trim(),
					manualReview,
					useSubagent,
					maxRetries: Math.max(0, parseInt(maxRetries, 10) || 0),
					retryIntervalSeconds: intervalEnabled ? Math.max(0, parseInt(interval, 10) || 0) : 0,
				},
				staged.staged,
			);
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
					<ExpandableTextarea
						id="new-step-desc"
						value={description}
						placeholder="What the agent should do in this step…"
						onChange={setDescription}
						expandTitle="Edit task description"
						attachments={staged.attachmentsFor("description")}
						required
						autoFocus
					/>
				</div>

				<div className="field">
					<label className="label" htmlFor="new-step-criteria">
						Acceptance criteria
					</label>
					<ExpandableTextarea
						id="new-step-criteria"
						value={criteria}
						placeholder="Optional — what a good result must satisfy. Empty = no judge."
						onChange={setCriteria}
						expandTitle="Edit acceptance criteria"
						attachments={staged.attachmentsFor("acceptance")}
					/>
					<p className="hint">
						If set, the agent self-evaluates its result after running and re-runs the step on a reject, up to the
						retry budget.
					</p>
				</div>

				<div className={styles.gateRow}>
					<div className={styles.gateText}>
						<span className="label">Manual review</span>
						<p className="hint" id="new-step-review-hint">
							The workflow stops after this step and waits for you: it's marked <em>waiting</em> until you press
							Continue on it, and no further step runs meanwhile.
						</p>
					</div>
					<Switch
						checked={manualReview}
						onChange={setManualReview}
						label="Manual review"
						describedBy="new-step-review-hint"
						disabled={saving}
					/>
				</div>

				<div className={styles.gateRow}>
					<div className={styles.gateText}>
						<span className="label">Use subagent</span>
						<p className="hint" id="new-step-subagent-hint">
							On: the agent delegates this step to a subagent (the Task tool), so the shared session only keeps its
							summary. Off: it solves the step itself, inline in the conversation.
						</p>
					</div>
					<Switch
						checked={useSubagent}
						onChange={setUseSubagent}
						label="Use subagent"
						describedBy="new-step-subagent-hint"
						disabled={saving}
					/>
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
					<p className="hint">All of the template's steps are appended, even ones already in this workflow.</p>
				</div>
			)}
		</div>
	);
}
