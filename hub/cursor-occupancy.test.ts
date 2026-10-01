/**
 * What the context meter says for a Cursor session, and in particular what it
 * says WHILE a step is being judged.
 *
 * Cursor's headless `agent -p` writes one usage block per run, summed over
 * every API round of that run. The hub used to publish that billing total as
 * occupancy (or clamp it to the window), so during a judge pass — when the
 * newest finished run is the long exec run — the meter read 100% and dropped
 * back once the short judge run landed. These tests pin the estimate that
 * replaced it (`estimateCursorOccupancy` in transcript.ts).
 *
 * Every fixture is REAL: result lines copied verbatim out of
 * ~/.agent-webhook-bridge/logs and the matching slice of the session's
 * agent-transcript, see the `_comment` in each fixture file. The expected
 * numbers are worked out by hand in the comments, not read back from the code.
 *
 * Same throwaway HOME/TARGET_HOME/AWB_HOME convention as context-occupancy.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-cursor-occupancy-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { readTokenUsage, usageSnapshot } = await import("./transcript.ts");

interface Fixture {
	sessionId: string;
	results: string[];
	transcript: string[];
}

function fixture(name: string): Fixture {
	return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fixture;
}

const logsDir = path.join(tmpHome, ".agent-webhook-bridge", "logs");

/**
 * Lays a session down the way awb and Cursor leave it on disk: one run log per
 * `agent -p` run (oldest first — the hub orders runs by log mtime) and, unless
 * `transcript` is false, the agent-transcript under ~/.cursor/projects.
 */
function writeSession(fx: Fixture, runs: number, options: { transcript?: boolean } = {}): void {
	fs.rmSync(logsDir, { recursive: true, force: true });
	fs.rmSync(path.join(tmpHome, ".cursor"), { recursive: true, force: true });
	fs.mkdirSync(logsDir, { recursive: true });
	const base = Date.now() / 1000 - 3600;
	fx.results.slice(0, runs).forEach((line, i) => {
		const file = path.join(logsDir, `run-${i}.log`);
		fs.writeFileSync(file, `$ agent -p "…" --output-format json --resume ${fx.sessionId}\n${line}\n`);
		fs.utimesSync(file, base + i * 60, base + i * 60);
	});
	if (options.transcript ?? true) {
		const dir = path.join(tmpHome, ".cursor", "projects", "proj", "agent-transcripts", fx.sessionId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${fx.sessionId}.jsonl`), `${fx.transcript.join("\n")}\n`);
	}
}

test("a judge pass no longer inherits a long exec run's billing total as a full window", () => {
	// Session a8abe85e: exec, judge, exec, judge. S = input + cache read (no cache
	// writes), n = assistant lines of the run in the transcript (none ends on a
	// tool call). Estimate = (mean + linear) / 2, linear = 2·mean − previous
	// reading (0 before the first), kept within [mean, S]:
	//   exec   S=779,704   n=13 → mean 59,977;  linear 119,954 → 89,966
	//   judge  S=211,792   n=3  → mean 70,597;  linear 51,229 → floor 70,597 → 70,597
	//   exec   S=1,796,039 n=20 → mean 89,802;  linear 109,007 → 99,404
	//   judge  S=315,058   n=3  → mean 105,019; linear 110,634 → 107,827
	// The old formula read the third run as 200,000 (100%) — what the operator saw
	// for the whole judge pass — and then 45,743 (23%) once the judge finished.
	const fx = fixture("cursor-judged-session.json");

	writeSession(fx, 3); // the judge is running: its result isn't in any log yet
	const during = readTokenUsage("/irrelevant", fx.sessionId);
	assert.equal(during.contextWindow, 200_000);
	assert.equal(during.contextEstimated, true);
	assert.equal(during.contextTokens, 99_404);
	assert.notEqual(during.contextTokens, during.contextWindow, "never clamped to the window");

	writeSession(fx, 4); // the judge finished
	const after = readTokenUsage("/irrelevant", fx.sessionId);
	assert.equal(after.contextTokens, 107_827);
	// The judge pass moves the meter by a few points, in the direction context
	// actually moves — not 100% → 23%.
	const swing = (100 * Math.abs(after.contextTokens - during.contextTokens)) / during.contextWindow;
	assert.ok(swing < 10, `swing across the judge was ${swing.toFixed(1)} points`);
	assert.ok(after.contextTokens > during.contextTokens, "a resumed conversation only grows");

	// The billed totals are untouched: they are still the sums, which is what they are.
	assert.equal(after.totalInputTokens, 779_704 + 211_792 + 1_796_039 + 315_058);
	assert.equal(after.turns, 4);
});

test("a single-round run is read exactly, and the estimate after it lands near Cursor's own /context", () => {
	// Session 20a54c9d. Run 1 is one assistant line with no tool call: one API
	// round, so its S IS its occupancy — 9,282 + 6,240 = 15,522, exactly.
	const fx = fixture("cursor-calibrated-session.json");
	writeSession(fx, 1);
	assert.equal(readTokenUsage("/irrelevant", fx.sessionId).contextTokens, 15_522);

	// Run 2: S = 59,230 + 761,920 = 821,150 over n = 16 rounds → mean 51,322;
	// linear 2·51,322 − 15,522 = 87,122; estimate 69,222. Cursor's /context bar,
	// read by the operator after this run (and after a few one-line probes of
	// their own), said 79,800. The mean alone would say 51k.
	writeSession(fx, 2);
	const usage = readTokenUsage("/irrelevant", fx.sessionId);
	assert.equal(usage.contextTokens, 69_222);
	assert.ok(usage.contextTokens <= 79_800, "below what Cursor showed after later turns were added");
	assert.equal(usage.contextEstimated, true);

	// The report server gets the same number the panel shows, and is told it's an estimate.
	const snapshot = usageSnapshot(usage);
	assert.equal(snapshot.context_tokens, 69_222);
	assert.equal(snapshot.context_estimated, true);
});

test("with no transcript to count rounds from, the last plausible reading stands instead of a clamp", () => {
	// Same session, transcript gone (e.g. removed, or written somewhere this
	// machine can't see). Run 1 is the first reading, so its S is taken as-is:
	// a session's first run is usually the one-round context step. Run 2 can't
	// be estimated — and its 821,150 billed total is four windows — so the
	// reading stays at run 1's rather than painting the bar full.
	const fx = fixture("cursor-calibrated-session.json");
	writeSession(fx, 2, { transcript: false });
	const usage = readTokenUsage("/irrelevant", fx.sessionId);
	assert.equal(usage.contextTokens, 15_522);
	assert.equal(usage.contextEstimated, true);
	assert.equal(usage.totalInputTokens, 15_522 + 821_150);

	// And a session whose every run is beyond the window, with nothing to anchor
	// on, reads as unmeasured (0) — never as 100%.
	const judged = fixture("cursor-judged-session.json");
	writeSession(judged, 3, { transcript: false });
	assert.equal(readTokenUsage("/irrelevant", judged.sessionId).contextTokens, 0);
});
