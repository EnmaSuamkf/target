/**
 * Tests for the retry-wait countdown helpers in the hub UI (plan D5, D6).
 *
 * The helpers take the clock as an argument, so the countdown is a pure function
 * of (retryAt, nowMs): the list badge, the canvas card and these tests all read
 * the same numbers. The text is fixed by plan D6, character for character.
 *
 * Runs with no DOM: format.ts is plain TypeScript and imports nothing at run time.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const { formatCountdown, retryCanvasLabel, retryCountdown, retryListLabel } = await import("./ui/src/lib/format.ts");

const T = Date.parse("2026-11-12T10:00:00.000Z");
const at = (msFromNow: number): string => new Date(T + msFromNow).toISOString();

test("formatCountdown: the boundaries of plan D6", () => {
	assert.equal(formatCountdown(0), "0s");
	assert.equal(formatCountdown(1), "1s");
	assert.equal(formatCountdown(59), "59s");
	assert.equal(formatCountdown(60), "1m 00s");
	assert.equal(formatCountdown(61), "1m 01s");
	assert.equal(formatCountdown(3599), "59m 59s");
	assert.equal(formatCountdown(3600), "1h 00m");
});

test("formatCountdown: the examples written in plan D6", () => {
	assert.equal(formatCountdown(45), "45s");
	assert.equal(formatCountdown(125), "2m 05s", "seconds are zero-padded in the minutes form");
	assert.equal(formatCountdown(3720), "1h 02m", "minutes are zero-padded in the hours form");
});

test("retryCountdown: a future due time gives the seconds left, rounded up", () => {
	assert.deepEqual(retryCountdown(at(45_000), T), { overdue: false, seconds: 45 });
	assert.deepEqual(retryCountdown(at(45_500), T), { overdue: false, seconds: 46 }, "a partial second rounds up");
	assert.deepEqual(retryCountdown(at(1), T), { overdue: false, seconds: 1 });
});

test("retryCountdown: a due time that has passed is overdue, never a negative count", () => {
	assert.deepEqual(retryCountdown(at(0), T), { overdue: true, seconds: 0 }, "due exactly now");
	assert.deepEqual(retryCountdown(at(-5_000), T), { overdue: true, seconds: 0 }, "due five seconds ago");
});

test("retryCountdown follows the clock it is given", () => {
	const due = at(45_000);
	assert.equal(retryCountdown(due, T).seconds, 45);
	assert.equal(retryCountdown(due, T + 10_000).seconds, 35, "ten seconds later, thirty-five left");
	assert.equal(retryCountdown(due, T + 60_000).overdue, true, "after the due time it is overdue");
});

test("retryListLabel: the list badge text", () => {
	assert.equal(retryListLabel(at(45_000), T), "retry in 45s");
	assert.equal(retryListLabel(at(3_720_000), T), "retry in 1h 02m");
	assert.equal(retryListLabel(at(0), T), "retry due");
	assert.equal(retryListLabel(at(-1_000), T), "retry due");
});

test("retryCanvasLabel: the canvas card state text", () => {
	assert.equal(retryCanvasLabel(at(45_000), T), "retrying · 45s");
	assert.equal(retryCanvasLabel(at(125_000), T), "retrying · 2m 05s");
	assert.equal(retryCanvasLabel(at(0), T), "retrying · due");
	assert.equal(retryCanvasLabel(at(-1_000), T), "retrying · due");
});

test("the list and canvas labels count down together as the clock moves", () => {
	const due = at(90_000);
	assert.equal(retryListLabel(due, T + 30_000), "retry in 1m 00s");
	assert.equal(retryCanvasLabel(due, T + 30_000), "retrying · 1m 00s");
	assert.equal(retryListLabel(due, T + 90_000), "retry due");
});

test("the four helpers take the clock as an argument and do not read it", () => {
	const source = fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src/lib/format.ts"),
		"utf8",
	);
	for (const name of ["retryCountdown", "formatCountdown", "retryListLabel", "retryCanvasLabel"]) {
		const start = source.indexOf(`export function ${name}(`);
		assert.ok(start >= 0, `${name} is exported`);
		// The body runs to the next declaration: the next export or the next doc comment.
		const nextExport = source.indexOf("\nexport function", start + 1);
		const nextDoc = source.indexOf("\n/**", start + 1);
		const ends = [nextExport, nextDoc].filter((i) => i > 0);
		const body = source.slice(start, Math.min(...ends));
		assert.equal(body.includes("Date.now"), false, `${name} must not read the clock`);
	}
});
