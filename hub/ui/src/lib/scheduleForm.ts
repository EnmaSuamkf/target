import type {
	ScheduleFieldError,
	ScheduleInput,
	ScheduleKind,
	ScheduleSpec,
	Step,
	Workflow,
	WorkflowSchedule,
} from "../api/types.ts";

/**
 * The schedule dialog's logic, kept free of React so it can be tested on its
 * own (hub/ui-schedule.test.ts): what the form starts from, what it sends, what
 * it refuses before sending, and whether the dialog may edit at all.
 *
 * The hub is the authority on every rule here (hub/schedule.ts validates the
 * spec, hub/workflow.ts `setSchedule` decides who may be scheduled); these
 * checks only exist so the obvious mistakes are named next to the field that
 * caused them instead of coming back as a 400 toast.
 */

/** Weekday chips, Monday first (how a week reads on a calendar), carrying the hub's 0 = Sunday numbering. */
export const WEEKDAYS: readonly { day: number; short: string; long: string }[] = [
	{ day: 1, short: "Mon", long: "Monday" },
	{ day: 2, short: "Tue", long: "Tuesday" },
	{ day: 3, short: "Wed", long: "Wednesday" },
	{ day: 4, short: "Thu", long: "Thursday" },
	{ day: 5, short: "Fri", long: "Friday" },
	{ day: 6, short: "Sat", long: "Saturday" },
	{ day: 0, short: "Sun", long: "Sunday" },
];

export const SCHEDULE_KINDS: readonly { kind: ScheduleKind; label: string }[] = [
	{ kind: "once", label: "Once" },
	{ kind: "daily", label: "Daily" },
	{ kind: "weekly", label: "Weekly" },
];

/** What the form holds while it's being edited — every kind's fields at once, so switching kind loses nothing. */
export interface ScheduleDraft {
	kind: ScheduleKind;
	/** Local "YYYY-MM-DD" — only `once` uses it. */
	date: string;
	/** Local "HH:mm". */
	time: string;
	/** 0 = Sunday … 6 = Saturday — only `weekly` uses it. */
	days: number[];
	timezone: string;
	includePrevious: boolean;
}

export type DraftErrors = Partial<Record<"date" | "time" | "days" | "timezone", string>>;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The browser's own zone — the default a new schedule is written in (D6). */
export function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** Every IANA zone the runtime knows, with `current` guaranteed in the list (a browser may report a link such as "Asia/Calcutta"). */
export function timeZoneOptions(current: string): string[] {
	let zones: string[] = [];
	try {
		zones = Intl.supportedValuesOf("timeZone");
	} catch {
		// An engine without supportedValuesOf still gets the zone in use and UTC.
	}
	const all = new Set(zones);
	all.add("UTC");
	if (current) all.add(current);
	return [...all].sort();
}

/**
 * The searchable list's filter: every whitespace-separated term must appear,
 * case-insensitively, with "_" and " " interchangeable — so "new york" finds
 * America/New_York and "eur mad" finds Europe/Madrid.
 */
export function filterTimeZones(zones: readonly string[], query: string): string[] {
	const terms = query.toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [...zones];
	return zones.filter((zone) => {
		const name = zone.toLowerCase().replace(/_/g, " ");
		return terms.every((term) => name.includes(term));
	});
}

/** Local "YYYY-MM-DD" and "HH:mm" of an instant in a zone. */
function wallClock(date: Date, timezone: string): { date: string; time: string } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(date)
			.map((p) => [p.type, p.value]),
	);
	return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * What the form starts from. An existing schedule is loaded as it is stored; a
 * new one defaults to "once, tomorrow at 09:00" in the browser's zone — a time
 * that is in the future wherever the operator is, so Save works untouched.
 */
export function draftFromSchedule(
	schedule: WorkflowSchedule | null | undefined,
	options: { now?: Date; timezone?: string } = {},
): ScheduleDraft {
	const timezone = schedule?.timezone || options.timezone || browserTimeZone();
	const tomorrow = wallClock(new Date((options.now ?? new Date()).getTime() + 86_400_000), timezone);
	const draft: ScheduleDraft = {
		kind: "once",
		date: tomorrow.date,
		time: "09:00",
		days: [1, 2, 3, 4, 5],
		timezone,
		includePrevious: schedule ? schedule.includePrevious : true,
	};
	const spec = schedule?.spec;
	if (!spec) return draft;
	if (spec.kind === "once") {
		const [date = draft.date, time = draft.time] = spec.at.split("T");
		return { ...draft, kind: "once", date, time };
	}
	if (spec.kind === "daily") return { ...draft, kind: "daily", time: spec.time };
	return { ...draft, kind: "weekly", time: spec.time, days: [...spec.days].sort((a, b) => a - b) };
}

/** Field errors the form can name before sending; empty means it may be sent. */
export function validateDraft(draft: ScheduleDraft): DraftErrors {
	const errors: DraftErrors = {};
	if (!TIME_RE.test(draft.time)) errors.time = "Pick a time (HH:mm).";
	if (draft.kind === "once" && !DATE_RE.test(draft.date)) errors.date = "Pick a date.";
	if (draft.kind === "weekly" && draft.days.length === 0) errors.days = "Pick at least one day.";
	if (draft.timezone.trim() === "") errors.timezone = "Pick a timezone.";
	return errors;
}

/** The spec the draft describes, or null while it can't describe one. */
export function specFromDraft(draft: ScheduleDraft): ScheduleSpec | null {
	if (Object.keys(validateDraft(draft)).length > 0) return null;
	if (draft.kind === "once") return { kind: "once", at: `${draft.date}T${draft.time}` };
	if (draft.kind === "daily") return { kind: "daily", time: draft.time };
	return { kind: "weekly", days: [...new Set(draft.days)].sort((a, b) => a - b), time: draft.time };
}

/** The PUT body, or null while the draft is incomplete. */
export function scheduleInputFromDraft(draft: ScheduleDraft): ScheduleInput | null {
	const spec = specFromDraft(draft);
	if (!spec) return null;
	return { spec, timezone: draft.timezone, includePrevious: draft.includePrevious };
}

/** Maps the hub's 400 `invalid_schedule` fields onto the form's fields. */
export function draftErrorsFromServer(fields: readonly ScheduleFieldError[]): DraftErrors {
	const errors: DraftErrors = {};
	for (const f of fields) {
		const key = f.field === "at" ? "date" : f.field === "time" || f.field === "days" || f.field === "timezone" ? f.field : null;
		if (key && !errors[key]) errors[key] = f.message;
	}
	return errors;
}

/** Toggles a weekday chip. */
export function toggleDay(days: readonly number[], day: number): number[] {
	return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
}

/** "Once on 2026-10-01 at 09:00", "Every day at 09:00", "Every Mon, Wed at 09:00" — plus the zone. */
export function describeSpec(spec: ScheduleSpec | null | undefined, timezone: string | null | undefined): string {
	if (!spec) return "No schedule";
	const zone = timezone ? ` (${timezone})` : "";
	if (spec.kind === "once") return `Once on ${spec.at.replace("T", " at ")}${zone}`;
	if (spec.kind === "daily") return `Every day at ${spec.time}${zone}`;
	const names = WEEKDAYS.filter((w) => spec.days.includes(w.day)).map((w) => w.short);
	const days = names.length === 7 ? "day" : names.length === 5 && !spec.days.includes(0) && !spec.days.includes(6) ? "weekday" : names.join(", ");
	return `Every ${days} at ${spec.time}${zone}`;
}

/** Whether the workflow carries a schedule the operator can still change or cancel (the hub's "live" states). */
export function hasLiveSchedule(workflow: Pick<Workflow, "schedule">): boolean {
	const state = workflow.schedule?.state;
	return state === "armed" || state === "missed" || state === "broken";
}

/**
 * What the dialog may do for this workflow, and why not when it can't:
 *
 * - `readonly`: a series created from the server is managed there only (D15) —
 *   the dialog shows it but offers no Save or Cancel schedule.
 * - `disabled`: the hub would refuse any schedule — a workflow continuing an
 *   adopted conversation (D23: every run is a clone, and a clone can't continue
 *   someone else's thread), a past run of a series, one in progress, or an
 *   archived one.
 * - `edit`: it has a live schedule; Save changes it, Cancel schedule ends it.
 * - `create`: not scheduled yet.
 */
export type ScheduleAvailability =
	| { mode: "create" | "edit" }
	| { mode: "readonly"; reason: string }
	| { mode: "disabled"; reason: string };

export const SERVER_MANAGED_REASON =
	"This schedule was created from the server and is managed there only. It is shown here read-only — change or cancel it on the server.";
export const ADOPTED_REASON =
	"This workflow continues an adopted conversation, so it can't be scheduled: every scheduled run is a clone, and a clone can't continue that conversation.";

export function scheduleAvailability(
	workflow: Pick<Workflow, "schedule" | "adoptedSessionId" | "status" | "archivedAt">,
): ScheduleAvailability {
	const schedule = workflow.schedule ?? null;
	if (schedule?.managedBy === "server") return { mode: "readonly", reason: SERVER_MANAGED_REASON };
	if (workflow.adoptedSessionId) return { mode: "disabled", reason: ADOPTED_REASON };
	if (workflow.archivedAt) return { mode: "disabled", reason: "This workflow is archived — unarchive it to schedule it." };
	if (schedule?.state === "fired") {
		return {
			mode: "disabled",
			reason: "This is a past run of a schedule. Change the schedule on its upcoming run, or clone this one.",
		};
	}
	if (workflow.status === "running" || workflow.status === "waiting" || workflow.status === "paused") {
		return { mode: "disabled", reason: `This workflow is ${workflow.status} — it can be scheduled once it stops.` };
	}
	return { mode: hasLiveSchedule(workflow) ? "edit" : "create" };
}

/**
 * The warning shown when any step has manual review: a scheduled run that
 * reaches such a step stops there, `waiting`, until someone presses Continue —
 * which nobody is around to do at 03:00.
 */
export function manualReviewWarning(steps: readonly Pick<Step, "kind" | "manualReview" | "description">[]): string | null {
	const gated = steps.filter((s) => (s.kind ?? "task") === "task" && s.manualReview);
	if (gated.length === 0) return null;
	const which = gated.length === 1 ? "1 step has" : `${gated.length} steps have`;
	return `${which} manual review enabled. A scheduled run stops at ${gated.length === 1 ? "it" : "each of them"} and waits until someone presses Continue.`;
}

/** The preview's lines: "2026-10-01 09:00", or why there's nothing to show. */
export function previewLines(preview: { occurrences: { local: string }[] } | null, kind: ScheduleKind): string[] {
	if (!preview) return [];
	if (preview.occurrences.length === 0) {
		return [kind === "once" ? "That time has already passed — pick one in the future." : "This schedule never runs."];
	}
	return preview.occurrences.map((o) => o.local);
}
