import { useEffect, useMemo, useState } from "react";
import { previewSchedule } from "../api/client.ts";
import type { ScheduleFieldError, ScheduleInput, SchedulePreview, Step, Workflow } from "../api/types.ts";
import { Field } from "../components/Field.tsx";
import { Modal } from "../components/Modal.tsx";
import { Switch } from "../components/Switch.tsx";
import {
	describeSpec,
	draftErrorsFromServer,
	draftFromSchedule,
	filterTimeZones,
	manualReviewWarning,
	previewLines,
	SCHEDULE_KINDS,
	scheduleAvailability,
	scheduleInputFromDraft,
	specFromDraft,
	timeZoneOptions,
	toggleDay,
	validateDraft,
	WEEKDAYS,
	type DraftErrors,
	type ScheduleDraft,
} from "../lib/scheduleForm.ts";
import styles from "./ScheduleModal.module.css";

/** What saving answered: stored, or refused — with the hub's field errors when it named any. */
export type ScheduleSaveResult = { ok: true } | { ok: false; fields?: ScheduleFieldError[] };

/** How long the form waits after the last edit before asking the hub for a preview. */
const PREVIEW_DEBOUNCE_MS = 300;

/**
 * The workflow header's **Schedule** button: turn this workflow into a
 * scheduled series, change the schedule of its upcoming run, or cancel it —
 * one dialog for all three, because they are one setting.
 *
 * What it shows before anything is saved matters as much as what it saves:
 * the next three runs come from the hub itself (POST /api/schedule/preview),
 * so DST and timezone rules are the ones the scheduler will really apply, not
 * a second implementation in the browser. Any step with manual review gets a
 * warning, since a scheduled run stops there until someone presses Continue.
 *
 * Two cases don't get a form. A series created from the server is managed
 * there only (D15): it is shown read-only, without Save or Cancel schedule. A
 * workflow that can't be scheduled at all (an adopted conversation, D23; a past
 * run; one in progress) gets the reason instead.
 *
 * Like RenameWorkflowModal, the draft is re-seeded from the workflow on every
 * open, so Close really discards, and `onSave` resolving not-ok leaves the
 * dialog open with the edit still in it.
 */
export function ScheduleModal({
	open,
	workflow,
	steps,
	canSchedule,
	permissionHint,
	onClose,
	onSave,
	onCancelSchedule,
}: {
	open: boolean;
	workflow: Workflow;
	steps: Step[];
	/** The operator holds client.workflows.execute AND client.workflows.manage (D22). */
	canSchedule: boolean;
	/** Why not, when `canSchedule` is false. */
	permissionHint: string;
	onClose: () => void;
	onSave: (input: ScheduleInput) => Promise<ScheduleSaveResult>;
	/** Resolves true when the hub cancelled the schedule. */
	onCancelSchedule: () => Promise<boolean>;
}): React.JSX.Element {
	const [draft, setDraft] = useState<ScheduleDraft>(() => draftFromSchedule(workflow.schedule));
	const [errors, setErrors] = useState<DraftErrors>({});
	const [zoneQuery, setZoneQuery] = useState("");
	const [preview, setPreview] = useState<SchedulePreview | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const availability = scheduleAvailability(workflow);
	const readOnly = availability.mode === "readonly";
	const editing = availability.mode === "edit";
	const locked = readOnly || saving || !canSchedule;

	useEffect(() => {
		if (!open) return;
		setDraft(draftFromSchedule(workflow.schedule));
		setErrors({});
		setZoneQuery("");
		setPreview(null);
		setPreviewError(null);
		// Seeded per open, not per render: the app re-renders this every 2s (the
		// poll), and re-seeding then would overwrite the edit in progress.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// The preview follows the draft, debounced so typing a time doesn't fire a
	// request per keystroke. A draft that can't describe a spec yet shows nothing.
	const spec = specFromDraft(draft);
	const specKey = spec ? JSON.stringify([spec, draft.timezone]) : "";
	useEffect(() => {
		if (!open || !spec || availability.mode === "disabled") {
			setPreview(null);
			return;
		}
		let stale = false;
		const timer = setTimeout(() => {
			previewSchedule(spec, draft.timezone)
				.then((result) => {
					if (stale) return;
					setPreview(result);
					setPreviewError(null);
				})
				.catch((err: unknown) => {
					if (stale) return;
					setPreview(null);
					setPreviewError(err instanceof Error ? err.message : String(err));
				});
		}, PREVIEW_DEBOUNCE_MS);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
		// `specKey` stands for `spec` + zone (a new object every render).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, specKey, availability.mode]);

	const zones = useMemo(() => timeZoneOptions(draft.timezone), [draft.timezone]);
	const shownZones = useMemo(() => {
		const matches = filterTimeZones(zones, zoneQuery);
		// The selected zone always stays in the list, so the select never reads blank.
		return matches.includes(draft.timezone) ? matches : [draft.timezone, ...matches];
	}, [zones, zoneQuery, draft.timezone]);

	const warning = manualReviewWarning(steps);
	const update = (patch: Partial<ScheduleDraft>): void => {
		setDraft((d) => ({ ...d, ...patch }));
		setErrors({});
	};

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (locked) return;
		const local = validateDraft(draft);
		const input = scheduleInputFromDraft(draft);
		if (!input) {
			setErrors(local);
			return;
		}
		setSaving(true);
		try {
			const result = await onSave(input);
			if (result.ok) onClose();
			else if (result.fields) setErrors(draftErrorsFromServer(result.fields));
		} finally {
			setSaving(false);
		}
	};

	const cancelSchedule = async (): Promise<void> => {
		setSaving(true);
		try {
			if (await onCancelSchedule()) onClose();
		} finally {
			setSaving(false);
		}
	};

	// A missed `once` saved from here is RESCHEDULED (the caller sends it to the
	// reschedule endpoint): same form, but the words say what it does.
	const missed = workflow.schedule?.state === "missed";
	const title = readOnly
		? "Schedule (managed by the server)"
		: missed
			? "Reschedule missed run"
			: editing
				? "Edit schedule"
				: "Schedule workflow";

	if (availability.mode === "disabled") {
		return (
			<Modal
				open={open}
				title="Schedule workflow"
				onClose={onClose}
				size="sm"
				footer={
					<button type="button" className="btn" onClick={onClose}>
						Close
					</button>
				}
			>
				<p className="msg msg--warn" data-schedule-disabled>
					{availability.reason}
				</p>
			</Modal>
		);
	}

	return (
		<Modal
			open={open}
			title={title}
			{...(readOnly
				? {}
				: {
						description:
							"Each run is a copy of this workflow, created when the previous one fires. Edits to its steps, context and TCP/RCI carry into every later run.",
					})}
			onClose={onClose}
			footer={
				<>
					{editing && (
						<button
							type="button"
							className="btn btn--danger"
							onClick={() => void cancelSchedule()}
							disabled={saving || !canSchedule}
							title={canSchedule ? "End the schedule. This workflow becomes a normal workflow again." : permissionHint}
							data-cancel-schedule
						>
							Cancel schedule
						</button>
					)}
					<span className={styles.footerSpacer} />
					<button type="button" className="btn" onClick={onClose} disabled={saving}>
						Close
					</button>
					{!readOnly && (
						<button
							type="submit"
							form="schedule-workflow"
							className="btn btn--primary"
							disabled={locked}
							title={canSchedule ? undefined : permissionHint}
							data-save-schedule
						>
							{saving ? "Saving…" : missed ? "Reschedule" : editing ? "Save schedule" : "Schedule"}
						</button>
					)}
				</>
			}
		>
			<form id="schedule-workflow" className={styles.form} onSubmit={submit}>
				{readOnly && (
					<p className="msg msg--muted" data-schedule-readonly>
						{availability.reason}
					</p>
				)}
				{readOnly && (
					<p className={styles.summary}>{describeSpec(workflow.schedule?.spec, workflow.schedule?.timezone)}</p>
				)}

				<div className={styles.kinds} role="group" aria-label="How often it runs">
					{SCHEDULE_KINDS.map(({ kind, label }) => (
						<button
							key={kind}
							type="button"
							className={`${styles.kindBtn} ${draft.kind === kind ? styles.kindBtnOn : ""}`}
							aria-pressed={draft.kind === kind}
							onClick={() => update({ kind })}
							disabled={locked}
						>
							{label}
						</button>
					))}
				</div>

				<div className={styles.grid}>
					{draft.kind === "once" && (
						<Field label="Date" required {...(errors.date ? { error: errors.date } : {})}>
							{(props) => (
								<input
									{...props}
									type="date"
									className="input"
									value={draft.date}
									onChange={(ev) => update({ date: ev.target.value })}
									disabled={locked}
									required
								/>
							)}
						</Field>
					)}
					<Field label="Time" required {...(errors.time ? { error: errors.time } : {})}>
						{(props) => (
							<input
								{...props}
								type="time"
								className="input"
								value={draft.time}
								onChange={(ev) => update({ time: ev.target.value })}
								disabled={locked}
								required
							/>
						)}
					</Field>
				</div>

				{draft.kind === "weekly" && (
					<div>
						<span className="label">Days</span>
						<div className={styles.days} role="group" aria-label="Days of the week">
							{WEEKDAYS.map(({ day, short, long }) => (
								<button
									key={day}
									type="button"
									className={`${styles.day} ${draft.days.includes(day) ? styles.dayOn : ""}`}
									aria-pressed={draft.days.includes(day)}
									aria-label={long}
									onClick={() => update({ days: toggleDay(draft.days, day) })}
									disabled={locked}
								>
									{short}
								</button>
							))}
						</div>
						{errors.days && (
							<p className="msg msg--error" role="alert">
								{errors.days}
							</p>
						)}
					</div>
				)}

				<Field
					label="Timezone"
					hint="The wall clock the times above are read in. Defaults to this browser's."
					{...(errors.timezone ? { error: errors.timezone } : {})}
				>
					{(props) => (
						<div className={styles.zone}>
							<input
								type="search"
								className="input"
								value={zoneQuery}
								placeholder="Search timezones…"
								aria-label="Search timezones"
								onChange={(ev) => setZoneQuery(ev.target.value)}
								disabled={locked}
							/>
							<select
								{...props}
								className={`select ${styles.zoneList}`}
								size={5}
								value={draft.timezone}
								onChange={(ev) => update({ timezone: ev.target.value })}
								disabled={locked}
								data-schedule-timezone
							>
								{shownZones.map((zone) => (
									<option key={zone} value={zone}>
										{zone}
									</option>
								))}
							</select>
						</div>
					)}
				</Field>

				<div className={styles.toggleRow}>
					<div className={styles.toggleText}>
						<span className="label">Include a reference to the previous run</span>
						<p className="hint" id="schedule-include-previous-hint">
							Each run is told the previous run's id, its final status and where its step results are.
						</p>
					</div>
					<Switch
						checked={draft.includePrevious}
						onChange={(includePrevious) => update({ includePrevious })}
						label="Include a reference to the previous run"
						describedBy="schedule-include-previous-hint"
						disabled={locked}
					/>
				</div>

				<div className={styles.preview} aria-live="polite" data-schedule-preview>
					<span className="label">Next runs</span>
					{previewError ? (
						<p className="msg msg--error">{previewError}</p>
					) : preview ? (
						<ol className={styles.previewList}>
							{previewLines(preview, draft.kind).map((line) => (
								<li key={line}>{line}</li>
							))}
						</ol>
					) : (
						<p className="hint">{spec ? "Loading…" : "Complete the fields above to see when it runs."}</p>
					)}
				</div>

				{warning && (
					<p className="msg msg--warn" role="status" data-manual-review-warning>
						{warning}
					</p>
				)}
			</form>
		</Modal>
	);
}
