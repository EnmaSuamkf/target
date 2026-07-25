import type { Progress as ProgressData } from "../api/types.ts";

/**
 * Progress bar driven by the server-computed `progress` object — done/total/pct
 * and a `failed` flag are all decided in `stepProgress` (hub/db.ts), so the UI
 * never recomputes them and can't drift from the status markdown or the CLI.
 */
export function ProgressBar({
	progress,
	running = false,
}: {
	progress: ProgressData;
	/** Tints the bar while the workflow is actively dispatching. */
	running?: boolean;
}): React.JSX.Element {
	const modifier = progress.failed ? " progress__fill--failed" : running ? " progress__fill--running" : "";
	return (
		<div
			className="progress"
			role="progressbar"
			aria-valuenow={progress.pct}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-label={`${progress.done} of ${progress.total} steps complete`}
		>
			<div className={`progress__fill${modifier}`} style={{ width: `${progress.pct}%` }} />
		</div>
	);
}
