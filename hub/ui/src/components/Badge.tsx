import type { StepStatus, WorkflowStatus } from "../api/types.ts";

/**
 * Status pill. A `running` badge carries a pulsing dot so in-flight work is
 * distinguishable at a glance from a settled state, which matters on a screen
 * that repaints every 2 seconds. A `queued` badge carries a steady dot
 * (accepted by the broker but waiting on the workdir lock — not yet active), and
 * so does `waiting` (held at its manual-review gate: stopped, but it's the
 * status that needs the operator to do something).
 */
export function Badge({
	status,
	label,
	manual,
	manualAt,
}: {
	status: WorkflowStatus | StepStatus;
	/** Overrides the text without changing the colour (e.g. "judging"). */
	label?: string;
	/**
	 * Marks a status a person forced rather than one the engine derived. The
	 * colour is deliberately unchanged — the status means the same thing however
	 * it was reached — so the marker is a hand glyph appended inside the pill,
	 * which reads at a glance without inventing a seventh badge colour.
	 */
	manual?: boolean;
	/** ISO timestamp of the override, shown in the marker's tooltip. */
	manualAt?: string | null;
}): React.JSX.Element {
	const showDot = status === "running" || status === "queued" || status === "waiting";
	return (
		<span className={`badge badge--${status}`}>
			{showDot && <span className="badge__dot" aria-hidden="true" />}
			{label ?? status}
			{manual && (
				<span
					className="badge__manual"
					title={`Status set manually${manualAt ? ` on ${new Date(manualAt).toLocaleString()}` : ""} — not reported by a run.`}
				>
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M12 20h9" />
						<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
					</svg>
					<span className="sr-only">status set manually</span>
				</span>
			)}
		</span>
	);
}
