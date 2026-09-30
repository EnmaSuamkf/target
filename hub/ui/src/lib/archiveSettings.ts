/**
 * Validation for the Settings "Auto-archive" field, kept free of React so the
 * hub test suite can import it. Mirrors the hub's `normalizeArchiveAfterDays`
 * (a non-negative safe integer; 0 disables auto-archiving) so a bad value is
 * caught in the form instead of coming back as a 400.
 */
export function parseArchiveAfterDays(raw: string): { ok: true; value: number } | { ok: false; error: string } {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) {
		return { ok: false, error: "Enter a whole number of days (0 or more). 0 turns auto-archiving off." };
	}
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value)) {
		return { ok: false, error: "That number of days is too large." };
	}
	return { ok: true, value };
}
