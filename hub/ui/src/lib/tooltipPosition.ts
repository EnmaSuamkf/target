export interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
}

export interface Size {
	width: number;
	height: number;
}

export interface TooltipPlacement {
	top: number;
	left: number;
	side: "above" | "below";
}

/**
 * Where to put a `position: fixed` tooltip so it stays inside the viewport.
 *
 * Prefers below the anchor; flips above when it does not fit below and fits
 * above better. Horizontally it is left-aligned with the anchor and clamped to
 * `margin` from either edge. A tooltip larger than the viewport is pinned to
 * the top-left margin rather than pushed off-screen.
 */
export function tooltipPosition(
	anchor: Box,
	tooltip: Size,
	viewport: Size,
	gap = 6,
	margin = 8,
): TooltipPlacement {
	const below = anchor.top + anchor.height + gap;
	const above = anchor.top - gap - tooltip.height;
	const fitsBelow = below + tooltip.height <= viewport.height - margin;
	const fitsAbove = above >= margin;
	const side = fitsBelow || !fitsAbove ? "below" : "above";
	const rawTop = side === "below" ? below : above;
	const maxTop = viewport.height - margin - tooltip.height;
	const maxLeft = viewport.width - margin - tooltip.width;
	return {
		side,
		top: Math.max(margin, Math.min(rawTop, maxTop)),
		left: Math.max(margin, Math.min(anchor.left, maxLeft)),
	};
}
