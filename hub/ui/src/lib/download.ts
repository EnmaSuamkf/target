/**
 * Handing a value to the operator as a file on their machine.
 *
 * The browser has no "save this object" API, so the whole trick is: serialise,
 * wrap in a Blob, point a synthetic <a download> at an object URL and click it.
 * Same shape as the recovery-token download (components/RecoveryToken.tsx) —
 * it's here because template export needs it too, and a second hand-rolled copy
 * would be a second place to forget `revokeObjectURL`.
 */

/** Serialises `value` as pretty-printed JSON and downloads it as `filename`. */
export function downloadJson(filename: string, value: unknown): void {
	// Indented on purpose: an exported bundle is a file a human may open, diff or
	// hand-edit before importing it back, and one long line makes all three worse.
	const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

/**
 * A filesystem-safe filename derived from a user-typed name ("Release
 * checklist!" → "release-checklist.json"). Anything that isn't a letter, digit
 * or dash becomes a dash, because the name is free text and may legally contain
 * slashes, quotes or emoji — none of which belong in a filename on every OS the
 * hub's UI opens on. A name that survives as nothing at all falls back to
 * `fallback`, so the download is never called ".json".
 */
export function jsonFilename(name: string, fallback: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return `${slug || fallback}.json`;
}
