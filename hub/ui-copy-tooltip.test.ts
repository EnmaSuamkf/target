/**
 * tooltipPosition (ui/src/lib/tooltipPosition.ts): keeps a fixed-position
 * tooltip inside the viewport — below the anchor by default, flipped above when
 * the bottom edge is too close, clamped at the left and right edges.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { tooltipPosition } from "./ui/src/lib/tooltipPosition.ts";

const viewport = { width: 1000, height: 800 };
const tip = { width: 300, height: 80 };

test("sits below the anchor, left-aligned, when it fits", () => {
	const anchor = { top: 100, left: 200, width: 150, height: 20 };
	assert.deepEqual(tooltipPosition(anchor, tip, viewport), { side: "below", top: 126, left: 200 });
});

test("flips above when there is no room below", () => {
	const anchor = { top: 740, left: 200, width: 150, height: 20 };
	assert.deepEqual(tooltipPosition(anchor, tip, viewport), { side: "above", top: 654, left: 200 });
});

test("stays below when it fits neither side", () => {
	const small = { width: 300, height: 120 };
	const anchor = { top: 60, left: 50, width: 100, height: 20 };
	const p = tooltipPosition(anchor, small, { width: 1000, height: 150 });
	assert.equal(p.side, "below");
	assert.equal(p.top, 150 - 8 - 120);
});

test("clamps to the right edge", () => {
	const anchor = { top: 100, left: 900, width: 80, height: 20 };
	assert.equal(tooltipPosition(anchor, tip, viewport).left, 1000 - 8 - 300);
});

test("clamps to the left edge", () => {
	const anchor = { top: 100, left: -40, width: 80, height: 20 };
	assert.equal(tooltipPosition(anchor, tip, viewport).left, 8);
});

test("a tooltip wider than the viewport pins to the margin", () => {
	const anchor = { top: 100, left: 100, width: 80, height: 20 };
	assert.equal(tooltipPosition(anchor, { width: 2000, height: 80 }, viewport).left, 8);
});
