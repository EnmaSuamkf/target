/**
 * Body scroll lock for the overlay surfaces (see `Modal`).
 *
 * `overflow: hidden` on the body is enough on a desktop browser but not on
 * iOS Safari, which happily keeps rubber-banding the page behind a dialog and
 * — worse for a bottom sheet — scrolls the document instead of the sheet once
 * the sheet's own content hits its end. Pinning the body with `position: fixed`
 * at its current offset is the treatment that actually holds; the offset is
 * replayed with `scrollTo` on release so unlocking doesn't teleport the page
 * back to the top.
 *
 * Locks nest: dialogs do stack here (a rich-text popup opened from a field
 * inside another dialog), so this counts them and only the outermost release
 * restores the page. `data-modal-open` on the body rides along, which is how
 * the floating dictation dock knows to move out of a sheet's way in CSS.
 */

let depth = 0;
let release: (() => void) | null = null;

/** Locks the page behind an overlay. The returned function is idempotent. */
export function lockBodyScroll(): () => void {
	if (depth === 0) {
		const { body } = document;
		const scrollY = window.scrollY;
		const previous = {
			position: body.style.position,
			top: body.style.top,
			left: body.style.left,
			right: body.style.right,
			width: body.style.width,
			overflow: body.style.overflow,
		};

		body.style.position = "fixed";
		body.style.top = `-${scrollY}px`;
		body.style.left = "0";
		body.style.right = "0";
		body.style.width = "100%";
		body.style.overflow = "hidden";
		body.dataset["modalOpen"] = "true";

		release = () => {
			body.style.position = previous.position;
			body.style.top = previous.top;
			body.style.left = previous.left;
			body.style.right = previous.right;
			body.style.width = previous.width;
			body.style.overflow = previous.overflow;
			delete body.dataset["modalOpen"];
			window.scrollTo(0, scrollY);
		};
	}

	depth += 1;
	let released = false;

	return () => {
		if (released) return;
		released = true;
		depth -= 1;
		if (depth > 0) return;
		release?.();
		release = null;
	};
}
