/**
 * Pure rules behind the Failure recovery controls (components/RecoveryFields.tsx,
 * the recovery marker in components/Badge.tsx). Kept out of the components so
 * the hub's node:test suite can load them without a DOM or CSS modules.
 */

/** The "Max recoveries" text as the integer the hub accepts (≥ 0); blank or invalid falls back to 1, the default. */
export function parseMaxRecoveries(text: string): number {
	const trimmed = text.trim();
	if (trimmed === "") return 1;
	const n = Number(trimmed);
	if (!Number.isFinite(n)) return 1;
	return Math.max(0, Math.floor(n));
}

/**
 * The step card's recovery marker text: "Recovery" while the toggle is on and
 * nothing was used, "Recovery 1/1" once a recovery ran (shown even if the toggle
 * was turned off since, so the used budget stays visible), null otherwise.
 */
export function recoveryMarkerLabel(step: {
	recoverOnFailure?: boolean | undefined;
	maxRecoveries?: number | undefined;
	recoveryCount?: number | undefined;
}): string | null {
	const used = step.recoveryCount ?? 0;
	const max = step.maxRecoveries ?? 1;
	if (!step.recoverOnFailure && used === 0) return null;
	return used > 0 ? `Recovery ${used}/${max}` : "Recovery";
}
