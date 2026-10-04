/**
 * Copy text to the clipboard and say whether it worked. Never throws.
 *
 * `navigator.clipboard` exists only in a secure context (https or localhost).
 * The hub also serves over plain http on a LAN address, where it is undefined,
 * so there it falls back to a hidden textarea and `document.execCommand("copy")`.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Permission denied or document not focused — try the fallback below.
	}
	return execCommandCopy(text);
}

function execCommandCopy(text: string): boolean {
	if (typeof document === "undefined" || !document.body) return false;
	let area: HTMLTextAreaElement | null = null;
	try {
		area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.setAttribute("aria-hidden", "true");
		area.style.position = "fixed";
		area.style.top = "0";
		area.style.left = "-9999px";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		area.setSelectionRange(0, text.length);
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		area?.remove();
	}
}
