import type { ScheduleNotice, ScheduleNoticeKind, Workflow } from "../api/types.ts";

/**
 * The notices banner's logic, free of React (hub/ui-schedule-notices.test.ts
 * imports it directly): what each notice says, how loudly, and which ones
 * carry the missed-once choices.
 */

const FALLBACK_MESSAGES: Record<ScheduleNoticeKind, string> = {
	missed: "A scheduled run was missed because the hub was offline.",
	skipped: "A scheduled run was skipped.",
	broken: "A schedule is broken: its next run could not be created. No further runs happen until it is rescheduled.",
	failed: "A scheduled run failed.",
};

/** The notice's text: the hub's own sentence, or a generic one for the kind when it carries none. */
export function noticeMessage(notice: Pick<ScheduleNotice, "kind" | "detail">): string {
	const message = notice.detail?.message;
	return typeof message === "string" && message.trim() !== "" ? message : FALLBACK_MESSAGES[notice.kind];
}

/**
 * How loud a notice is. A broken series and a failed run are errors — work
 * that should have happened didn't and won't retry by itself; a missed or
 * skipped run is a warning — the series carries on (or, for a missed once,
 * waits for a choice).
 */
export function noticeTone(kind: ScheduleNoticeKind): "error" | "warn" {
	return kind === "broken" || kind === "failed" ? "error" : "warn";
}

/** A `once` whose time passed while the hub was offline: it waits for Run now / Reschedule / Dismiss (D8). */
export function isMissedOnce(workflow: Pick<Workflow, "schedule"> | null | undefined): boolean {
	return workflow?.schedule?.state === "missed";
}

/**
 * The workflow a notice's missed-once actions act on, or null when it offers
 * none. Keyed on the workflow's CURRENT state, not the notice's kind: a `once`
 * becomes `missed` both when the hub was offline (a `missed` notice) and when
 * its run was skipped (a `skipped` notice), and once the operator has chosen,
 * the old notice must stop offering choices that the hub would refuse (409
 * `not_missed`). A server-managed series is the server's to decide (D15).
 */
export function missedOnceFor(
	notice: Pick<ScheduleNotice, "workflowId">,
	workflowsById: ReadonlyMap<string, Workflow>,
): Workflow | null {
	const workflow = notice.workflowId ? workflowsById.get(notice.workflowId) : undefined;
	if (!workflow || !isMissedOnce(workflow) || workflow.schedule?.managedBy === "server") return null;
	return workflow;
}

/** The label a notice leads with. */
export const NOTICE_TITLES: Record<ScheduleNoticeKind, string> = {
	missed: "Missed",
	skipped: "Skipped",
	broken: "Schedule broken",
	failed: "Run failed",
};
