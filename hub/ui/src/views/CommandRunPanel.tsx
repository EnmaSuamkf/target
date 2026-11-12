import { useEffect, useState } from "react";
import { getPipelineRunLog, listStepPipelineRuns } from "../api/client.ts";
import type { PipelineRun, PipelineRunJobStep } from "../api/types.ts";
import { formatCountdown, relativeTime, retryCountdown } from "../lib/format.ts";
import styles from "./CommandRunPanel.module.css";

/** How often the open run is re-read while its step runs. */
const RUN_POLL_MS = 2000;

function duration(startedAt: string | null, finishedAt: string | null): string {
	if (!startedAt) return "";
	const end = finishedAt ? Date.parse(finishedAt) : Date.now();
	const ms = end - Date.parse(startedAt);
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${ms} ms`;
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const MARK: Record<PipelineRunJobStep["status"], { glyph: string; label: string; tone: string | undefined }> = {
	success: { glyph: "✓", label: "passed", tone: styles.toneOk },
	failed: { glyph: "✗", label: "failed", tone: styles.toneFail },
	skipped: { glyph: "–", label: "skipped", tone: styles.toneMuted },
	running: { glyph: "●", label: "running", tone: styles.toneRun },
	pending: { glyph: "○", label: "waiting", tone: styles.toneMuted },
};

function runLabel(run: PipelineRun): { text: string; tone: string | undefined } {
	if (run.conclusion === null) return { text: "running", tone: styles.toneRun };
	if (run.conclusion === "success") return { text: "passed", tone: styles.toneOk };
	return { text: run.cancelled ? "cancelled" : "failed", tone: styles.toneFail };
}

/**
 * The latest run of a command step, drawn like a CI job: one row per job step,
 * with its status, exit code and duration. A row's log is fetched only when the
 * row is opened, so a long run does not pull every log up front. Earlier attempts
 * sit below, collapsed. While the step runs, the runs are re-read on a short poll.
 */
export function CommandRunPanel({
	stepId,
	status,
	pipelineName,
	retryAt = null,
	retryCount = 0,
	maxRetries = 0,
}: {
	stepId: string;
	status: string;
	pipelineName: string | null;
	/** The due time of the next attempt. Only a `pending` step with one is in its retry wait. */
	retryAt?: string | null;
	retryCount?: number;
	maxRetries?: number;
}): React.JSX.Element {
	const [runs, setRuns] = useState<PipelineRun[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = async (): Promise<void> => {
		try {
			setRuns(await listStepPipelineRuns(stepId));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	useEffect(() => {
		void load();
		// Re-read when the step changes state (started, finished, retried).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [stepId, status]);

	useEffect(() => {
		if (status !== "running") return;
		const timer = window.setInterval(() => void load(), RUN_POLL_MS);
		return () => window.clearInterval(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status, stepId]);

	// The header of a step in its retry wait (plan D6): the countdown to the next
	// attempt, or "due" once its time has passed. Re-rendered with the 2 s list poll.
	const retry = status === "pending" && retryAt ? retryCountdown(retryAt, Date.now()) : null;
	const retryText = retry
		? `${retry.overdue ? "Retry due" : `Retrying in ${formatCountdown(retry.seconds)}`} · retry ${retryCount}/${maxRetries}`
		: null;

	const latest = runs && runs.length > 0 ? runs[runs.length - 1] : null;
	const earlier = runs && runs.length > 1 ? runs.slice(0, -1).reverse() : [];

	return (
		<section className={styles.panel} aria-label="Pipeline run">
			<div className={styles.head}>
				<span className={styles.title}>Pipeline{pipelineName ? ` · ${pipelineName}` : ""}</span>
				{retryText && <span className={styles.retry}>{retryText}</span>}
				{latest && <span className={`${styles.conclusion} ${runLabel(latest).tone}`}>{runLabel(latest).text}</span>}
				{latest && <span className={styles.meta}>attempt {latest.attempt} · {relativeTime(latest.startedAt)}</span>}
			</div>

			{error && <p className={styles.error} role="alert">{error}</p>}
			{runs === null && !error && <p className={styles.meta}>Loading run…</p>}
			{runs !== null && !latest && <p className={styles.meta}>No run yet. It appears here once the pipeline starts.</p>}

			{latest && (
				<>
					{latest.error && <p className={styles.error}>{latest.error}</p>}
					<JobRows run={latest} />
				</>
			)}

			{earlier.length > 0 && (
				<details className={styles.earlier}>
					<summary>Earlier attempts ({earlier.length})</summary>
					{earlier.map((run) => (
						<div key={run.id} className={styles.attempt}>
							<div className={styles.head}>
								<span className={styles.title}>Attempt {run.attempt}</span>
								<span className={`${styles.conclusion} ${runLabel(run).tone}`}>{runLabel(run).text}</span>
								<span className={styles.meta}>{relativeTime(run.startedAt)}</span>
							</div>
							<JobRows run={run} />
						</div>
					))}
				</details>
			)}
		</section>
	);
}

function JobRows({ run }: { run: PipelineRun }): React.JSX.Element {
	return (
		<ol className={styles.jobs}>
			{run.steps.map((job) => (
				<JobRow key={job.index} runId={run.id} job={job} />
			))}
		</ol>
	);
}

function JobRow({ runId, job }: { runId: string; job: PipelineRunJobStep }): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [log, setLog] = useState<string | null>(null);
	const [logError, setLogError] = useState<string | null>(null);
	const mark = MARK[job.status];

	const toggle = async (): Promise<void> => {
		const next = !open;
		setOpen(next);
		// A log is fetched once, when first opened; the hub keeps it on disk.
		if (next && log === null) {
			try {
				setLog(await getPipelineRunLog(runId, job.index));
			} catch (err) {
				setLogError(err instanceof Error ? err.message : String(err));
			}
		}
	};

	return (
		<li className={styles.job}>
			<div className={styles.jobRow}>
				<span className={`${styles.glyph} ${mark.tone}`} aria-label={mark.label} title={mark.label}>
					{mark.glyph}
				</span>
				<span className={styles.jobName}>{job.name}</span>
				<span className={styles.jobMeta}>
					{job.exitCode !== null && job.status !== "success" ? `exit ${job.exitCode}` : ""}
					{job.startedAt ? ` · ${duration(job.startedAt, job.finishedAt)}` : ""}
				</span>
				{job.startedAt && (
					<button type="button" className={`btn btn--sm ${styles.logToggle}`} onClick={() => void toggle()} aria-expanded={open}>
						{open ? "Hide log" : "Log"}
					</button>
				)}
			</div>
			{open && (
				<>
					{logError && <p className={styles.error}>{logError}</p>}
					{log === null && !logError && <p className={styles.meta}>Loading log…</p>}
					{log !== null && <pre className={styles.log}>{log || "(no output)"}</pre>}
				</>
			)}
		</li>
	);
}
