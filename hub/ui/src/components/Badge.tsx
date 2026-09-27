import type { StepStatus, WorkflowOrigin, WorkflowStatus } from "../api/types.ts";

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

/** Marks workflows created and managed by a remote sync server. */
export function OriginBadge({ origin }: { origin: WorkflowOrigin }): React.JSX.Element | null {
	if (origin !== "remote") return null;
	return (
		<span className="badge badge--remote" title="Managed by remote sync server">
			Remote
		</span>
	);
}

/** Marks TCP packs and Resource Sets that the server pushed and owns. */
export function ServerManagedBadge(): React.JSX.Element {
	return (
		<span className="badge badge--remote" title="Pushed by the Target server; local edit and delete are disabled">
			Managed by server
		</span>
	);
}

/** Marks a catalog copy pulled onto this hub. */
export function SyncedBadge(): React.JSX.Element {
	return (
		<span className="badge badge--synced" title="Pulled from the Target server; read-only on this hub">
			Synced
		</span>
	);
}

/** Whether a server copy can be attached or applied from this hub. */
export function UsagePill({
	enabled,
	revoked = false,
}: {
	enabled: boolean;
	revoked?: boolean;
}): React.JSX.Element {
	if (enabled) {
		return <span className="badge badge--enabled">Enabled</span>;
	}
	return (
		<span
			className="badge badge--disabled"
			title={revoked ? "Access revoked by the server" : "Requires a workflow create/edit permission"}
		>
			Disabled
		</span>
	);
}

/** Synced + usage pills for a server-origin catalog row. Local rows render nothing. */
export function CatalogCopyBadges({
	item,
}: {
	item: { origin?: string; usable?: boolean; revoked?: boolean };
}): React.JSX.Element | null {
	if (item.origin !== "server") return null;
	return (
		<>
			<SyncedBadge />
			<UsagePill enabled={item.usable !== false} revoked={item.revoked === true} />
		</>
	);
}
