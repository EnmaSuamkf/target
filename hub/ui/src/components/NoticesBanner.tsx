import type { ScheduleNotice, Workflow } from "../api/types.ts";
import { relativeTime } from "../lib/format.ts";
import { missedOnceFor, NOTICE_TITLES, noticeMessage, noticeTone } from "../lib/scheduleNotices.ts";
import { MissedOnceActions } from "./MissedOnceActions.tsx";
import styles from "./NoticesBanner.module.css";

/**
 * Schedule notices nobody has acknowledged yet (GET
 * /api/schedule-notices?unacknowledged=1), one row each, under the header on
 * every view. They are persistent on the hub (D11) because what they report —
 * runs missed while the laptop slept, a run skipped, a broken series, a failed
 * run — happened while nobody was looking; a toast would be gone before anyone
 * saw it.
 *
 * Each row says what happened in the hub's own words and offers Acknowledge.
 * A notice about a `once` that is still waiting for a decision also offers
 * Run now / Reschedule / Dismiss — the same three the workflow's detail pane
 * offers — so it can be settled from wherever the operator is.
 */
export function NoticesBanner({
	notices,
	workflowsById,
	canAct,
	actHint,
	busy,
	onAcknowledge,
	onRunNow,
	onReschedule,
	onDismiss,
}: {
	notices: ScheduleNotice[];
	workflowsById: ReadonlyMap<string, Workflow>;
	/** execute AND manage — what the missed-once actions need (D22). */
	canAct: boolean;
	actHint: string;
	busy: boolean;
	onAcknowledge: (id: string) => void;
	onRunNow: (workflow: Workflow) => void;
	onReschedule: (workflow: Workflow) => void;
	onDismiss: (workflow: Workflow) => void;
}): React.JSX.Element | null {
	if (notices.length === 0) return null;
	return (
		<div className={styles.banner} role="region" aria-label="Schedule notices" data-notices-banner>
			{notices.map((notice) => {
				const missed = missedOnceFor(notice, workflowsById);
				const workflow = notice.workflowId ? workflowsById.get(notice.workflowId) : undefined;
				return (
					<div
						key={notice.id}
						className={`${styles.notice} ${noticeTone(notice.kind) === "error" ? styles.error : ""}`}
						role={noticeTone(notice.kind) === "error" ? "alert" : "status"}
						data-notice={notice.kind}
					>
						<span className={styles.text}>
							<span className={styles.title}>{NOTICE_TITLES[notice.kind]}</span>
							{noticeMessage(notice)}{" "}
							{workflow && <a href={`#/w/${workflow.id}`}>Open workflow</a>}{" "}
							<span className="hint" title={new Date(notice.createdAt).toLocaleString()}>
								· {relativeTime(notice.createdAt)}
							</span>
						</span>
						<span className={styles.actions}>
							{missed && (
								<MissedOnceActions
									canAct={canAct}
									actHint={actHint}
									busy={busy}
									onRunNow={() => onRunNow(missed)}
									onReschedule={() => onReschedule(missed)}
									onDismiss={() => onDismiss(missed)}
								/>
							)}
							<button
								type="button"
								className="btn btn--sm"
								onClick={() => onAcknowledge(notice.id)}
								disabled={busy}
								title="Hide this notice. It changes nothing about the workflow."
								data-acknowledge-notice
							>
								Acknowledge
							</button>
						</span>
					</div>
				);
			})}
		</div>
	);
}
