/**
 * Small formatting helpers shared by the views. Everything here is display-only
 * — no business logic, which lives on the server.
 */

/** `1234` → `1.2k`. Used for token counts, which get long fast. */
export function compactNumber(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(Math.round(n));
}

export function truncate(value: string | null | undefined, max: number): string {
	const s = String(value ?? "");
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Relative time ("just now", "5m ago", "3d ago") for ISO timestamps, falling
 * back to a plain date past a week where "12d ago" stops being useful.
 */
export function relativeTime(iso: string | null | undefined): string {
	if (!iso) return "";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";

	const seconds = Math.round((Date.now() - then) / 1000);
	if (seconds < 45) return "just now";
	if (seconds < 90) return "1m ago";

	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.round(hours / 24);
	if (days <= 7) return `${days}d ago`;

	return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * How long a step has been in flight, from its start/finish stamps. A step
 * that started but hasn't finished is measured against now, so a running step
 * shows a live duration as the 2s poll re-renders it. A `queued` step has no
 * `started_at` yet (it's waiting on the workdir lock), so its wait is measured
 * from `queued_at` instead — showing how long it's been queued, not 0/blank.
 */
export function duration(startedAt: string | null, finishedAt: string | null, queuedAt?: string | null): string {
	const startIso = startedAt ?? queuedAt ?? null;
	if (!startIso) return "";
	const start = new Date(startIso).getTime();
	if (Number.isNaN(start)) return "";
	const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
	if (Number.isNaN(end)) return "";

	const seconds = Math.max(0, Math.round((end - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/** Collapses `$HOME/projects/x` to `~/projects/x` for display. */
export function prettyPath(path: string | null | undefined): string {
	if (!path) return "";
	return path.replace(/^\/(?:home|Users)\/[^/]+/, "~");
}
