import { useState } from "react";
import type {
	AttachmentField,
	OverridableStepStatus,
	StagedStepImages,
	Step,
	StepConfigInput,
	StepNoteTheme,
} from "../api/types.ts";
import { OVERRIDABLE_STEP_STATUSES } from "../api/types.ts";
import { Badge } from "../components/Badge.tsx";
import { ExpandableTextarea } from "../components/ExpandableTextarea.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { StepNotes } from "../components/StepNotes.tsx";
import { Switch } from "../components/Switch.tsx";
import { activityLabel, duration } from "../lib/format.ts";
import { AddStepModal } from "./AddStepModal.tsx";
import styles from "./StepItem.module.css";

/**
 * One step in the workflow's list, in either read or edit mode.
 *
 * Behaviours preserved from the previous UI because they encode real server
 * constraints, not styling choices:
 *
 * - A `running` step can't be edited, and only a `pending` one can be removed.
 * - A `waiting` step (held at its manual-review gate) can't be edited either —
 *   the server refuses it.
 * - The retry interval only applies with more than one retry, so the field is
 *   disabled and forced to 0 below that.
 * - A step running its judge phase reads "judging", not "running".
 * - The status picker can't touch a step with a job in flight (the server
 *   refuses it) — Abort is the action for that, and it's right there.
 *
 * No row has a run control of its own. Dispatching is the workflow's single
 * Start button acting on the checked steps, so there is one answer to "what will
 * run when I press go" instead of two competing ones — a per-row ▶ used to fire
 * a step immediately and outside the sequential order, which meant the checkbox
 * beside it described a run that button didn't take part in. The row still SAYS
 * what it is doing while a job is in flight (below), because that was feedback
 * the ▶ happened to carry, not a reason to keep a button.
 *
 * A `waiting` step gets its own set of four actions, because "Continue" alone
 * was a dead end: the operator being asked to approve a result had no way to say
 * anything except yes. So the hold offers the whole decision —
 *
 * - **Continue** approves it and the run carries on;
 * - **Abort** refuses it and stops the workflow (the same route, which the
 *   server reads differently for a held step than for a stuck one);
 * - **Open conversation** resumes THIS step's session in a terminal, to ask the
 *   agent what it did before deciding either way;
 * - **Add step** inserts a correction directly after this one, so Continue then
 *   runs that instead of whatever followed.
 *
 * **Add step** is the one of those that only `waiting` shows: it is an answer to
 * "what do I do about this result", and no other state is holding a result to be
 * answered. **Open conversation** is also offered on a `failed` step, which is
 * where an operator wants it most — the step is finished, its error is right
 * there, and the only way to find out more than the error says is to resume the
 * conversation and ask. The button is not about reviewing, it is about there
 * being a conversation to reopen, and a failed step has one.
 *
 * The result body is collapsed by default and expandable, replacing the old
 * hard truncation at 240 characters that made longer output unreadable. Both it
 * and the error are rendered as Markdown (components/Markdown.tsx) rather than
 * dumped as preformatted text: a step's resolution is written by an agent, and
 * agents write headings, bullets and backticked paths — shown raw, the operator
 * read `## What changed` and `**1. Canvas**` instead of the structure those
 * markers are there to carry.
 *
 * The two arrows beside the step number are the answer to "this has to run
 * before that one": a step used to be stuck wherever it was created (appended at
 * the end, or threaded in after the step being reviewed), and moving it meant
 * deleting and retyping it. They sit next to the number rather than in the
 * action row below because the number is the thing they change — press ↑ and the
 * "3" becomes a "2".
 */
/** Length past which a resolution pane offers "Show more" — see below. */
const RESULT_CLAMP = 220;

export function StepItem({
	step,
	selected,
	onToggleSelected,
	onSave,
	onRemove,
	onAbort,
	onContinue,
	onOpenConversation,
	onAddStepAfter,
	onSetStatus,
	onMove,
	canMoveUp,
	canMoveDown,
	onAttachImages,
	onRemoveAttachment,
	onAddNote,
	onEditNote,
	onRemoveNote,
	busy,
}: {
	step: Step;
	selected: boolean;
	onToggleSelected: (id: string, selected: boolean) => void;
	onSave: (id: string, input: StepConfigInput) => Promise<void>;
	onRemove: (id: string) => void;
	onAbort: (id: string) => void;
	onContinue: (id: string) => void;
	/** Opens a terminal on this step's own session, not the workflow's newest. */
	onOpenConversation: (id: string) => void;
	/** Adds a step immediately after this one, so it runs next. Resolves null when the server refused it, which keeps the dialog open on its typed-in text. */
	onAddStepAfter: (id: string, input: StepConfigInput, staged?: StagedStepImages) => Promise<Step | null>;
	/** Forces the step's status by hand; never runs the step. */
	onSetStatus: (id: string, status: OverridableStepStatus) => void;
	/** Swaps this step with its neighbour, so it runs one place earlier or later. */
	onMove: (id: string, direction: "up" | "down") => void;
	/** Whether the swap the ↑ would make is one the server will accept (see `moveStep`). */
	canMoveUp: boolean;
	/** Same for the ↓. */
	canMoveDown: boolean;
	/** Pins images to one of this step's two text inputs. */
	onAttachImages: (field: AttachmentField, stepId: string | null, files: File[]) => Promise<boolean>;
	onRemoveAttachment: (id: string) => void;
	onAddNote?: (stepId: string, content: string, theme: StepNoteTheme) => Promise<void>;
	onEditNote?: (stepId: string, noteId: string, content: string, theme: StepNoteTheme) => Promise<void>;
	onRemoveNote?: (stepId: string, noteId: string) => Promise<void>;
	busy: boolean;
}): React.JSX.Element {
	const [editing, setEditing] = useState(false);
	const [expanded, setExpanded] = useState(false);
	// Its own toggle, not the result's: a step can carry both (a failed attempt
	// that still reported something), and expanding one shouldn't expand the other.
	const [errorExpanded, setErrorExpanded] = useState(false);
	const [adding, setAdding] = useState(false);

	// The hub-owned conversation-context step. Everything an operator can do to a
	// step is refused for it by the server (edit, remove, Continue, Set status),
	// so the buttons are hidden rather than left to 400 — with the one exception of
	// Abort, which the server DOES allow, because a context dispatch that hangs has
	// to be recoverable like any other. It also has no checkbox: it is always part
	// of the run, and it isn't counted in "N steps".
	const isContext = step.kind === "context";
	const running = step.status === "running";
	const waiting = step.status === "waiting";
	const failed = step.status === "failed";
	// "Open conversation" is offered wherever there is a finished conversation to
	// have: a step held for review (decide whether to approve it) and a step that
	// FAILED (find out what actually happened). A failure is in fact the stronger
	// case of the two — the error pane above says what the agent reported, and the
	// only way to learn anything more is to go and ask it. Not offered for the
	// other states because they have no conversation yet: a pending step never
	// ran, and a running one hasn't reported its session (awb only names it in the
	// completion callback), which is also why the button stays disabled until
	// `sessionId` is actually there rather than opening a terminal onto nothing.
	const conversational = waiting || failed;
	// A step with a job in flight is the one state the override refuses: its
	// callback is still coming, so a status written now would be overwritten (or
	// would strand a live agent). Abort first — the button next to it does that.
	const inFlight = running || step.status === "queued";
	// Abort covers two different situations: unsticking a dispatch that never
	// called back, and refusing the result of a step held for review.
	const abortable = inFlight || waiting;
	const editable = !running && !waiting;
	// Delegated to a subagent, which is what a step does unless the toggle was
	// turned off — and what a step stored before that toggle existed did too. The
	// hub-owned context step is dispatched by the engine, not by this choice, so
	// it never claims either way.
	const delegated = !isContext && step.useSubagent !== false;
	const removable = step.status === "pending";
	const statusLabel = running && step.phase === "judge" ? "judging" : step.status;

	if (editing) {
		return (
			<li className={`${styles.step} ${styles.editing}`} data-step-id={step.id}>
				<StepEditor
					step={step}
					onCancel={() => setEditing(false)}
					onSave={async (input) => {
						await onSave(step.id, input);
						setEditing(false);
					}}
					onAttachImages={onAttachImages}
					onRemoveAttachment={onRemoveAttachment}
				/>
			</li>
		);
	}

	const elapsed = duration(step.startedAt, step.finishedAt, step.queuedAt);
	const activity = step.activity;
	// A held step's result is exactly what the human is being asked to approve,
	// so it's shown before the step is done, not only after.
	const hasResult = (step.status === "done" || waiting) && step.result;

	// `data-step-id` on the row is the stable hook the canvas scrolls to when one
	// of its cards is clicked — CSS Module class names are hashed, so they can't
	// be querySelector'd. See `openStepInList` in WorkflowDetail.
	return (
		<li
			className={`${styles.step} ${running ? styles.stepRunning : ""} ${waiting ? styles.stepWaiting : ""}`}
			data-step-id={step.id}
		>
			<div className={styles.head}>
				{/* The checkbox is wrapped so its tappable area can be grown to a
				    thumb's size on a phone without drawing a giant checkbox. */}
				{!isContext && (
					<label
						className={styles.checkWrap}
						title="Check to run only the selected steps on Start. Leave all unchecked to run nothing."
					>
						<input
							type="checkbox"
							className={styles.check}
							checked={selected}
							onChange={(ev) => onToggleSelected(step.id, ev.target.checked)}
							aria-label={`Include step ${step.orderIndex + 1} in the next run`}
						/>
					</label>
				)}
				<span className={styles.index}>{isContext ? "ctx" : step.orderIndex + 1}</span>
				{/* Reordering, next to the number it reorders. Disabled rather than
				    hidden when a move isn't allowed, so the control doesn't appear and
				    disappear as steps run — the tooltip says why it's off. */}
				{!isContext && (
					<span className={styles.move}>
						<button
							type="button"
							className={styles.moveBtn}
							onClick={() => onMove(step.id, "up")}
							disabled={!canMoveUp || busy}
							aria-label={`Move step ${step.orderIndex + 1} up, so it runs earlier`}
							title={
								canMoveUp
									? "Move up — this step runs one place earlier."
									: "Can't move up: this step is already first, or it (or the step above) has already run. Only pending steps can be reordered."
							}
							data-move-step="up"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M12 19V5M5 12l7-7 7 7" />
							</svg>
						</button>
						<button
							type="button"
							className={styles.moveBtn}
							onClick={() => onMove(step.id, "down")}
							disabled={!canMoveDown || busy}
							aria-label={`Move step ${step.orderIndex + 1} down, so it runs later`}
							title={
								canMoveDown
									? "Move down — this step runs one place later."
									: "Can't move down: this step is already last, or it (or the step below) has already run. Only pending steps can be reordered."
							}
							data-move-step="down"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M12 5v14M19 12l-7 7-7-7" />
							</svg>
						</button>
					</span>
				)}
				<p className={styles.description}>{step.description}</p>
				<Badge status={step.status} label={statusLabel} manual={step.statusManual} manualAt={step.statusManualAt} />
			</div>

			{isContext && (
				<p className="hint">
					Automatic — the workflow's conversation context, delivered to the agent as its own turn before every
					other step. Edit it in the Conversation context box above.
				</p>
			)}

			{(step.acceptanceCriteria ||
				elapsed ||
				step.manualRun ||
				step.manualReview ||
				delegated ||
				step.useSubagent === false ||
				activity) && (
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
					{/* Flagged for a human sign-off, so the gate is visible before the
					    step ever reaches it — not just once it's already holding. */}
					{step.manualReview && (
						<span className={styles.metaItem} title="This step stops the workflow until you press Continue on it.">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
								<circle cx="12" cy="12" r="3" />
							</svg>
							manual review
						</span>
					)}
					{/* Both halves of "how will this step run" are spelled out, not just
					    the non-default one: a row that says nothing was ambiguous between
					    "delegated" and "nobody has decided", and the two facts an operator
					    checks before pressing Start are exactly these — is this step handed
					    to a subagent, and will it stop for me. The gate above and this
					    badge sit next to each other for that reason. */}
					{delegated && (
						<span
							className={styles.metaItem}
							title="This step's work is delegated to a subagent (the Task tool), so the shared session only keeps its summary."
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M6 3v6a3 3 0 0 0 3 3h9" />
								<path d="M15 9l3 3-3 3" />
								<circle cx="6" cy="18" r="2" />
							</svg>
							subagent
						</span>
					)}
					{step.useSubagent === false && (
						<span
							className={styles.metaItem}
							title="This step runs inline in the conversation instead of being delegated to a subagent — unless the session is over 60% full when it is dispatched, in which case it is delegated anyway to keep the conversation from degrading."
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
							</svg>
							inline
						</span>
					)}
					{step.manualRun && <span className={styles.metaItem}>manual run</span>}
					{elapsed && <span className={styles.metaItem}>{elapsed}</span>}
					{/* Progress watchdog: a long step that is still writing reads as
					    healthy, and one that has gone quiet is flagged before the idle
					    timeout takes it down. */}
					{activity && (
						<span
							className={`${styles.metaItem} ${activity.state === "running-active" ? "" : styles.metaItemIdle}`}
							title={
								activity.lastProgressAt
									? `Last signal: ${activity.lastProgressKind ?? "run start"} at ${activity.lastProgressAt}`
									: undefined
							}
						>
							{activityLabel(activity)}
						</span>
					)}
				</div>
			)}

			{/* The acceptance criteria, rendered the same way as the panes below it.
			    It used to be interpolated into a single <p>, which collapsed every
			    newline into a space: a criterion written as "1. … 2. … - epic … -
			    stories …" in the editor came back as one unbroken line, while the
			    task description right above it — the same kind of operator-written
			    text — kept its shape. The editor that writes this field SAVES
			    Markdown (its toolbar is bold/lists/headings), so parsing it is what
			    the stored text already is; and plain multi-line text still comes out
			    right, because a Markdown paragraph keeps the breaks that were typed
			    inside it. The label is its own line rather than a run-in prefix, so a
			    leading list or heading starts at the left edge like the rest. */}
			{step.acceptanceCriteria && (
				<div className={styles.criteria}>
					<span className={styles.criteriaLabel}>Accepts if:</span>
					<Markdown text={step.acceptanceCriteria} className={styles.criteriaBody} />
				</div>
			)}

			{!isContext && (step.notes?.length || onAddNote) ? (
				<StepNotes
					notes={step.notes ?? []}
					busy={busy}
					{...(onAddNote
						? { onAdd: (content, theme) => onAddNote(step.id, content, theme) }
						: {})}
					{...(onEditNote
						? { onEdit: (noteId, content, theme) => onEditNote(step.id, noteId, content, theme) }
						: {})}
					{...(onRemoveNote ? { onRemove: (noteId) => onRemoveNote(step.id, noteId) } : {})}
				/>
			) : null}

			{/* The failed resolution, in the same collapsing pane as a successful
			    one and rendered the same way — an agent writes its failure in
			    Markdown too, and a stack trace or a diff in it is unreadable
			    reflowed. Only the palette differs, so a failure can never be
			    mistaken for a result at a glance. */}
			{step.error && (
				<div className={styles.error} role="alert">
					<Markdown
						text={step.error}
						className={`${styles.resultBody} ${styles.errorBody} ${errorExpanded ? styles.resultExpanded : ""}`}
					/>
					{step.error.length > RESULT_CLAMP && (
						<button type="button" className={styles.resultToggle} onClick={() => setErrorExpanded((v) => !v)}>
							{errorExpanded ? "Show less" : "Show more"}
						</button>
					)}
				</div>
			)}

			{hasResult && (
				<div className={styles.result}>
					<Markdown
						text={step.result ?? ""}
						className={`${styles.resultBody} ${expanded ? styles.resultExpanded : ""}`}
					/>
					{/* Only offer the toggle when there's plausibly more to see. */}
					{(step.result?.length ?? 0) > RESULT_CLAMP && (
						<button type="button" className={styles.resultToggle} onClick={() => setExpanded((v) => !v)}>
							{expanded ? "Show less" : "Show more"}
						</button>
					)}
				</div>
			)}

			<div className={styles.actions}>
				{/* The review decision, offered only while the gate is actually holding:
				    the server refuses Continue on any other status, so buttons that were
				    always there would just be 400s waiting to happen. */}
				{waiting && (
					/* data-continue-step is the stable hook the Alt/Shift+C shortcut
					   clicks (CSS Module class names are hashed, so they can't be
					   querySelector'd) — see lib/continueShortcut.ts. */
					<button
						type="button"
						className="btn btn--primary btn--sm"
						onClick={() => onContinue(step.id)}
						disabled={busy}
						title="Approve this step's result: it's marked done and the workflow carries on with the next step. Alt/Shift+C presses this button."
						data-continue-step
					>
						Continue
					</button>
				)}
				{/* Sits between Continue and Add step, so a held step's three actions
				    read in the order they're used; on a failed step it is simply the
				    first of the row. `data-open-conversation-step` is the stable hook
				    the tests read, for the hashed-class-name reason above. */}
				{conversational && (
					<button
						type="button"
						className="btn btn--sm"
						onClick={() => onOpenConversation(step.id)}
						disabled={!step.sessionId || busy}
						title={
							!step.sessionId
								? "This step never reported a session, so there's no conversation to resume."
								: failed
									? "Opens a terminal resuming this step's own conversation, so you can ask the agent what it actually did before it failed."
									: "Opens a terminal resuming this step's own conversation, so you can ask the agent about what it just did before you decide."
						}
						data-open-conversation-step
					>
						Open conversation
					</button>
				)}
				{waiting && (
					<button
						type="button"
						className="btn btn--sm"
						onClick={() => setAdding(true)}
						disabled={busy}
						title="Insert a new step right after this one — it becomes the next thing the agent does when you press Continue."
					>
						Add step
					</button>
				)}
				{/* Plain text, not a button: no row runs itself any more, but the state
				    the removed ▶ used to spell out is still worth spelling out, in the
				    row of actions where the eye already is. The badge above carries the
				    same fact and keeps the finer "judging" distinction; this is the
				    second, closer copy that stops the action row from looking idle
				    while a job is actually in flight. */}
				{inFlight && <span className={styles.metaItem}>{running ? "Running…" : "Queued…"}</span>}
				<button
					type="button"
					className="btn btn--sm btn--danger"
					onClick={() => onAbort(step.id)}
					disabled={!abortable || busy}
					title={
						waiting
							? "Refuse this step's result: it's recorded failed and the workflow stops here instead of carrying on. The result and the session are kept."
							: "Force-fail this stuck step so it can be re-run, without restarting the whole workflow. Also kills the spawned agent process on the broker, freeing the workdir lock. Its session is preserved."
					}
				>
					Abort
				</button>
				{!isContext && (
					<button type="button" className="btn btn--sm" onClick={() => setEditing(true)} disabled={!editable || busy}>
						Edit
					</button>
				)}
				{!isContext && (
					<button
						type="button"
						className="btn btn--sm btn--ghost"
						onClick={() => onRemove(step.id)}
						disabled={!removable || busy}
						title={removable ? "Remove this step" : "Only a pending step can be removed."}
					>
						Remove
					</button>
				)}

				{/* Correcting the status is a picker rather than a button per status:
				    it's three options, it's rare, and one native <select> is a single
				    thumb-sized target on a phone where three more buttons would not be.
				    It never holds a value — picking one fires the action and the control
				    snaps back to its prompt, because the step's real status is the badge
				    above, not this. */}
				{!isContext && (
				<select
					className={`select ${styles.statusSelect}`}
					value=""
					disabled={inFlight || busy}
					aria-label={`Set the status of step ${step.orderIndex + 1} by hand`}
					title={
						inFlight
							? "This step still has a job in flight — abort it first."
							: "Say what really happened: mark this step done, failed or pending by hand. Nothing is run."
					}
					onChange={(ev) => {
						const next = ev.target.value as OverridableStepStatus | "";
						ev.target.value = "";
						if (next) onSetStatus(step.id, next);
					}}
				>
					<option value="">Set status…</option>
					{OVERRIDABLE_STEP_STATUSES.filter((s) => s !== step.status).map((s) => (
						<option key={s} value={s}>
							Mark {s}
						</option>
					))}
				</select>
				)}
			</div>

			{/* Rendered from the step it inserts after, so the dialog knows where the
			    new step goes without the parent tracking which row opened it. Mounted
			    only while the gate holds — that's the only place the button is, and a
			    hold released from another tab should take its dialog with it. */}
			{waiting && (
				<AddStepModal
					open={adding}
					afterIndex={step.orderIndex + 1}
					onClose={() => setAdding(false)}
					onAdd={async (input, staged) => {
						if (await onAddStepAfter(step.id, input, staged)) setAdding(false);
					}}
				/>
			)}
		</li>
	);
}

/** Inline editor for a step's description and verification configuration. */
function StepEditor({
	step,
	onCancel,
	onSave,
	onAttachImages,
	onRemoveAttachment,
}: {
	step: Step;
	onCancel: () => void;
	onSave: (input: StepConfigInput) => Promise<void>;
	onAttachImages: (field: AttachmentField, stepId: string | null, files: File[]) => Promise<boolean>;
	onRemoveAttachment: (id: string) => void;
}): React.JSX.Element {
	const [description, setDescription] = useState(step.description);
	const [criteria, setCriteria] = useState(step.acceptanceCriteria ?? "");
	const [manualReview, setManualReview] = useState(step.manualReview);
	// The stored value, defaulting to on for a step from before the toggle.
	const [useSubagent, setUseSubagent] = useState(step.useSubagent !== false);
	const [maxRetries, setMaxRetries] = useState(String(step.maxRetries ?? 0));
	const [interval, setInterval] = useState(String(step.retryIntervalSeconds ?? 0));
	const [saving, setSaving] = useState(false);
	const [attaching, setAttaching] = useState(false);

	// The wait between retries only means something with more than one retry.
	const intervalEnabled = (parseInt(maxRetries, 10) || 0) > 1;

	/**
	 * The step already exists here, so an image is uploaded the moment it's picked
	 * rather than waiting for Save — the strip can only show the absolute path once
	 * the server has assigned it, and a file "saved" alongside text edits that were
	 * then cancelled would be a confusing half-state either way.
	 */
	const attach = (field: AttachmentField) => ({
		items: step.attachments.filter((a) => a.field === field),
		onAdd: async (files: File[]) => {
			setAttaching(true);
			try {
				await onAttachImages(field, step.id, files);
			} finally {
				setAttaching(false);
			}
		},
		onRemove: onRemoveAttachment,
		busy: attaching,
		label: field === "description" ? "the task description" : "the acceptance criteria",
		idPrefix: `${field}-${step.id}`,
	});

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		const trimmed = description.trim();
		if (!trimmed || saving) return;
		setSaving(true);
		try {
			await onSave({
				description: trimmed,
				acceptanceCriteria: criteria.trim(),
				// Always sent: the server only touches the stored gate when the field
				// is present, so an omitted false could never turn it back off.
				manualReview,
				// Always sent too, for the same reason.
				useSubagent,
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
				attachments={attach("description")}
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
				attachments={attach("acceptance")}
			/>
			<p className="hint">
				If set, the agent self-evaluates its result against this after running. On a reject it re-runs the step up to
				the retry budget before the workflow fails.
			</p>

			<div className={styles.gateRow}>
				<div className={styles.gateText}>
					<span className="label">Manual review</span>
					<p className="hint" id={`review-hint-${step.id}`}>
						The workflow stops after this step and waits for you: it's marked <em>waiting</em> until you press
						Continue, and no further step runs meanwhile.
					</p>
				</div>
				<Switch
					checked={manualReview}
					onChange={setManualReview}
					label="Manual review"
					describedBy={`review-hint-${step.id}`}
					disabled={saving}
				/>
			</div>

			<div className={styles.gateRow}>
				<div className={styles.gateText}>
					<span className="label">Use subagent</span>
					<p className="hint" id={`subagent-hint-${step.id}`}>
						On: the agent delegates this step to a subagent (the Task tool), so the shared session only keeps its
						summary. Off: it solves the step itself, inline in the conversation.
					</p>
				</div>
				<Switch
					checked={useSubagent}
					onChange={setUseSubagent}
					label="Use subagent"
					describedBy={`subagent-hint-${step.id}`}
					disabled={saving}
				/>
			</div>

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
