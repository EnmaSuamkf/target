import type { ScheduleState, Workflow, WorkflowScheduleDetail, WorkflowStatus } from "../api/types.ts";

/**
 * How scheduled workflows read in the lists and the detail pane: the badge a
 * card carries, the run gate on an armed instance, the rail's schedule filter
 * and the series panel's ordering. Kept free of React and CSS (like
 * workflowFilter.ts) so hub/ui-schedule-list.test.ts can import it directly.
 */

/** The tooltip every run control shows on an armed instance — the hub refuses them with 409 `scheduled_armed` (D2). */
export const SCHEDULED_ARMED_TITLE = "Scheduled — runs automatically";

/** The series' next execution: can't be run by hand, runs at `nextRunAt`. */
export function isArmedInstance(workflow: Pick<Workflow, "schedule">): boolean {
	return workflow.schedule?.state === "armed";
}

/** An instance that has already run (or tried to): a normal workflow now, part of its series' history. */
export function isScheduledRun(workflow: Pick<Workflow, "schedule">): boolean {
	const state = workflow.schedule?.state;
	return state === "fired" || state === "broken";
}

/** "YYYY-MM-DD HH:mm" of an instant as the wall clock in `timezone` reads it — the same shape as the hub's `formatInZone`. */
export function formatInZone(iso: string, timezone: string | null | undefined): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	let parts: Record<string, string>;
	try {
		parts = Object.fromEntries(
			new Intl.DateTimeFormat("en-CA", {
				timeZone: timezone || "UTC",
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
	} catch {
		return date.toISOString().slice(0, 16).replace("T", " ");
	}
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * How far away a future instant is: "in 5m", "in 3h", "in 2d". The badge
 * repaints with the 2s poll, so this is live without its own timer. An instant
 * already reached reads "due now" — the scheduler fires it on its next tick.
 */
export function relativeFuture(iso: string, now: Date = new Date()): string {
	const ms = new Date(iso).getTime() - now.getTime();
	if (Number.isNaN(ms)) return "";
	if (ms <= 30_000) return "due now";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `in ${Math.max(minutes, 1)}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `in ${hours}h`;
	return `in ${Math.round(hours / 24)}d`;
}

export interface ScheduleBadgeInfo {
	/** `scheduled`/`run` read as information; `warning` needs the operator (missed, broken). */
	tone: "scheduled" | "run" | "warning";
	label: string;
	title: string;
}

/**
 * The schedule badge a workflow carries, or null for one outside any series
 * (or a cancelled schedule — a normal workflow again, nothing to flag).
 *
 * - armed: "Scheduled · next in 3h", tooltip with the absolute time and zone;
 * - fired: "Run of <series> · <occurrence>", so a run is recognisable as one
 *   execution of a schedule and not a workflow somebody started;
 * - missed / broken: warning style — both wait for the operator.
 */
export function scheduleBadge(
	workflow: Pick<Workflow, "schedule" | "name">,
	now: Date = new Date(),
): ScheduleBadgeInfo | null {
	const schedule = workflow.schedule;
	if (!schedule) return null;
	const tz = schedule.timezone ?? "UTC";
	const series = schedule.seriesName ?? workflow.name;
	switch (schedule.state) {
		case "armed": {
			if (!schedule.nextRunAt) return null;
			return {
				tone: "scheduled",
				label: `Scheduled · next ${relativeFuture(schedule.nextRunAt, now)}`,
				title: `Next run: ${formatInZone(schedule.nextRunAt, tz)} (${tz}). It runs automatically; Start and Run step are disabled until then.`,
			};
		}
		case "fired": {
			const when = schedule.scheduledFor ? formatInZone(schedule.scheduledFor, tz) : "";
			return {
				tone: "run",
				label: `Run of ${series}${when ? ` · ${when}` : ""}`,
				title: `A scheduled run of "${series}"${when ? `, for ${when} (${tz})` : ""}.`,
			};
		}
		case "missed": {
			const when = schedule.scheduledFor ? formatInZone(schedule.scheduledFor, tz) : "";
			return {
				tone: "warning",
				label: "Missed run",
				title: `The run scheduled for ${when || "its time"} (${tz}) was missed because the hub was offline. Open it to Run now, Reschedule or Dismiss.`,
			};
		}
		case "broken":
			return {
				tone: "warning",
				label: "Schedule broken",
				title: `The schedule "${series}" is broken: its next run could not be created. No further runs happen until it is rescheduled.`,
			};
		default:
			return null;
	}
}

/**
 * The rail's schedule filter. `scheduled` shows each series ONCE, by its armed
 * instance — the thing that will run next; `runs` shows the executions that
 * already happened. Offered alongside origin/status and composed with them.
 */
export type ScheduleFilter = "all" | "scheduled" | "runs";

export function filterBySchedule<W extends Pick<Workflow, "schedule">>(workflows: W[], filter: ScheduleFilter): W[] {
	if (filter === "all") return workflows;
	if (filter === "runs") return workflows.filter(isScheduledRun);
	// One per series: a series has exactly one armed instance by design (D1),
	// but a list refreshed mid-fire can briefly hold two — never show both.
	const seen = new Set<string>();
	return workflows.filter((w) => {
		if (!isArmedInstance(w)) return false;
		const series = w.schedule?.seriesId ?? "";
		if (seen.has(series)) return false;
		seen.add(series);
		return true;
	});
}

/** Which schedule filters would match something in this list (the group only shows when one does). */
export function presentScheduleFilters(workflows: Pick<Workflow, "schedule">[]): Exclude<ScheduleFilter, "all">[] {
	const out: Exclude<ScheduleFilter, "all">[] = [];
	if (workflows.some(isArmedInstance)) out.push("scheduled");
	if (workflows.some(isScheduledRun)) out.push("runs");
	return out;
}

export const SCHEDULE_FILTER_LABELS: Record<Exclude<ScheduleFilter, "all">, string> = {
	scheduled: "Scheduled",
	runs: "Scheduled runs",
};

export interface SeriesPanelRow {
	id: string;
	name: string;
	status: WorkflowStatus;
	scheduleState: ScheduleState | null;
	/** The occurrence, in the schedule's zone ("" when unknown). */
	when: string;
	/** "next" for the armed instance, "this" for the one open, else null. */
	marker: "next" | "this" | null;
}

/**
 * The series panel's rows: every instance, newest occurrence first — the armed
 * (next) one at the top, then past runs back in time. Instances without an
 * occurrence (a series' first, before it ever ran) sort last.
 */
export function seriesPanelRows(
	detail: Pick<WorkflowScheduleDetail, "instances" | "schedule">,
	currentId: string,
): SeriesPanelRow[] {
	const tz = detail.schedule?.timezone ?? "UTC";
	return [...detail.instances]
		.sort((a, b) => (b.scheduledFor ?? "").localeCompare(a.scheduledFor ?? ""))
		.map((i) => ({
			id: i.id,
			name: i.name,
			status: i.status,
			scheduleState: i.scheduleState,
			when: i.scheduledFor ? formatInZone(i.scheduledFor, tz) : "",
			marker: i.scheduleState === "armed" ? "next" : i.id === currentId ? "this" : null,
		}));
}
