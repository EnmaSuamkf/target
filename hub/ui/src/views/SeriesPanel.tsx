import { useEffect, useState } from "react";
import { getWorkflowSchedule } from "../api/client.ts";
import type { Workflow, WorkflowScheduleDetail } from "../api/types.ts";
import { Badge } from "../components/Badge.tsx";
import { CollapsibleSection } from "../components/CollapsibleSection.tsx";
import { describeSpec } from "../lib/scheduleForm.ts";
import { seriesPanelRows } from "../lib/scheduleView.ts";
import styles from "./DetailPanels.module.css";

/**
 * The series this workflow belongs to: every instance, newest first (the next
 * run at the top, then past runs back in time), each with its status and a
 * link to open it. It answers "how did the previous runs of this go?" without
 * searching the list for the series' name.
 *
 * Fetched from GET /api/workflows/:id/schedule rather than derived from the
 * workflow list, which hides archived runs by default — the series' history
 * includes them. Refetched whenever this workflow's own schedule moves (a fire
 * creates the next instance, a skip re-arms it), which `updatedAt` and the
 * schedule state/next run capture; the 2s poll does not refetch it on its own.
 * Renders nothing for a workflow outside any series.
 */
export function SeriesPanel({ workflow }: { workflow: Workflow }): React.JSX.Element | null {
	const seriesId = workflow.schedule?.seriesId ?? null;
	const [detail, setDetail] = useState<WorkflowScheduleDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refreshKey = `${workflow.id}|${seriesId}|${workflow.updatedAt}|${workflow.schedule?.state}|${workflow.schedule?.nextRunAt}`;

	useEffect(() => {
		if (!seriesId) {
			setDetail(null);
			return;
		}
		let stale = false;
		getWorkflowSchedule(workflow.id)
			.then((result) => {
				if (stale) return;
				setDetail(result);
				setError(null);
			})
			.catch((err: unknown) => {
				if (!stale) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			stale = true;
		};
		// `refreshKey` stands for the fields that mean the series changed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refreshKey]);

	if (!seriesId) return null;
	const rows = detail ? seriesPanelRows(detail, workflow.id) : [];
	const schedule = workflow.schedule;

	return (
		<CollapsibleSection
			title="Schedule series"
			defaultOpen
			meta={`${rows.length} run${rows.length === 1 ? "" : "s"}`}
		>
			<div className={styles.block} data-series-panel>
				<p className="hint">
					<strong>{schedule?.seriesName ?? workflow.name}</strong> — {describeSpec(schedule?.spec, schedule?.timezone)}
					{schedule?.managedBy === "server" ? " · managed by the server" : ""}
				</p>
				{error ? (
					<p className="msg msg--error">Could not load the series: {error}</p>
				) : !detail ? (
					<p className="hint">Loading…</p>
				) : (
					<ol className={styles.seriesList}>
						{rows.map((row) => (
							<li key={row.id} className={styles.seriesRow} data-series-instance={row.id}>
								<a href={`#/w/${row.id}`} className={styles.seriesLink} aria-current={row.marker === "this" ? "true" : undefined}>
									{row.when || row.name}
								</a>
								{row.marker === "next" && <span className="badge badge--schedule-scheduled">next</span>}
								{row.marker === "this" && <span className="hint">(this run)</span>}
								{row.scheduleState === "missed" || row.scheduleState === "broken" ? (
									<span className="badge badge--schedule-warning">{row.scheduleState}</span>
								) : null}
								<Badge status={row.status} />
							</li>
						))}
					</ol>
				)}
			</div>
		</CollapsibleSection>
	);
}
