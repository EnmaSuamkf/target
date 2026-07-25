import type { StepStatus, WorkflowStatus } from "../api/types.ts";

/**
 * Status pill. A `running` badge carries a pulsing dot so in-flight work is
 * distinguishable at a glance from a settled state, which matters on a screen
 * that repaints every 2 seconds. A `queued` badge carries a steady dot
 * (accepted by the broker but waiting on the workdir lock — not yet active).
 */
export function Badge({
	status,
	label,
}: {
	status: WorkflowStatus | StepStatus;
	/** Overrides the text without changing the colour (e.g. "judging"). */
	label?: string;
}): React.JSX.Element {
	const showDot = status === "running" || status === "queued";
	return (
		<span className={`badge badge--${status}`}>
			{showDot && <span className="badge__dot" aria-hidden="true" />}
			{label ?? status}
		</span>
	);
}
