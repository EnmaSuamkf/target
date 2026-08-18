/**
 * Tests for the token figures the hub reports — the ones that have to agree
 * with what the operator's own client says about the same session.
 *
 * The bug these pin: the hub reported the bare `usage.input_tokens` field as a
 * session's input total. With prompt caching on, essentially every input token
 * is a cache READ, so that field is near-zero and the report server's "INPUT
 * TOKENS" tile disagreed with the client by four orders of magnitude. Measured
 * on a real transcript on this machine
 * (session 1cc22650-7429-49c2-a6b3-d187ab222d9d, 143 turns):
 *
 *   input_tokens              416
 *   cache_creation      1,605,396
 *   cache_read         14,409,380
 *   ------------------------------
 *   total              16,015,192   ← what the client shows as "in 16.0M"
 *   output_tokens          98,599   ← "out 98.6k", which always agreed
 *
 * `readTokenUsage` already had the total (`totalInputTokens`); nothing read it
 * on the way out. So the coverage here is the whole path: that the sum is
 * right, that the report payload leads with it, and that the UI panel that
 * shows the operator the same numbers is rendered where it can be compared.
 *
 * HOME is redirected to a scratch dir before transcript.ts is imported, so the
 * claude-layout fixtures never touch the real ~/.claude.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-usage-report-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");

const { claudeProjectDir, contextPercent, readTokenUsage, usageSnapshot } = await import("./transcript.ts");

const hubDir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.join(hubDir, rel), "utf8");

const workdir = path.join(tmpHome, "workdir");

/** One claude assistant turn, in the shape Claude Code writes with caching on. */
function turn(
	id: string,
	usage: { input: number; cacheCreation: number; cacheRead: number; output: number },
	model = "claude-opus-5",
): string {
	return JSON.stringify({
		type: "assistant",
		message: {
			id,
			role: "assistant",
			model,
			usage: {
				input_tokens: usage.input,
				cache_creation_input_tokens: usage.cacheCreation,
				cache_read_input_tokens: usage.cacheRead,
				output_tokens: usage.output,
			},
		},
	});
}

function writeMain(sessionId: string, lines: string[]): void {
	const file = path.join(claudeProjectDir(workdir), `${sessionId}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function writeSubagent(sessionId: string, name: string, lines: string[]): void {
	const file = path.join(claudeProjectDir(workdir), sessionId, "subagents", `${name}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

test("a session's input total is new input + cache creation + cache read, not the bare field", () => {
	writeMain("s-cached", [
		turn("m1", { input: 4, cacheCreation: 12_000, cacheRead: 0, output: 300 }),
		turn("m2", { input: 3, cacheCreation: 1_000, cacheRead: 12_000, output: 200 }),
	]);

	const usage = readTokenUsage(workdir, "s-cached");

	// The three components, kept apart so the total stays auditable.
	assert.equal(usage.inputTokens, 7);
	assert.equal(usage.cacheCreationTokens, 13_000);
	assert.equal(usage.cacheReadTokens, 12_000);
	assert.equal(usage.outputTokens, 500);
	// …and the headline, which is their sum. The bare field (7) is what the hub
	// used to report as "input tokens" for this session.
	assert.equal(usage.totalInputTokens, 25_007);
	assert.equal(usage.turns, 2);
	// Occupancy is the LAST turn's input + cache, not the running total.
	assert.equal(usage.contextTokens, 13_003);
});

test("subagent transcripts are folded into the totals and the session says so", () => {
	writeMain("s-subs", [turn("m1", { input: 10, cacheCreation: 500, cacheRead: 2_000, output: 40 })]);
	writeSubagent("s-subs", "agent-a1", [turn("a1", { input: 5, cacheCreation: 100, cacheRead: 9_000, output: 60 })]);

	const usage = readTokenUsage(workdir, "s-subs");

	assert.equal(usage.turns, 2, "the subagent's turn counts — the client counts it too");
	assert.equal(usage.totalInputTokens, 10 + 500 + 2_000 + 5 + 100 + 9_000);
	assert.equal(usage.outputTokens, 100);
	assert.equal(usage.includesSubagents, true);
	// The window belongs to the MAIN thread, so occupancy ignores the subagent.
	assert.equal(usage.contextTokens, 2_510);
});

test("usageSnapshot leads with the total the client shows, and keeps every component", () => {
	// The real measured session, verbatim — this is the case that made the
	// dashboard read 416 next to a client reading 16.0M.
	const usage = {
		contextTokens: 202_014,
		contextWindow: 1_000_000,
		model: "claude-opus-5",
		lastCompactionAt: null,
		compactions: 0,
		inputTokens: 416,
		cacheCreationTokens: 1_605_396,
		cacheReadTokens: 14_409_380,
		outputTokens: 98_599,
		totalInputTokens: 16_015_192,
		turns: 143,
		includesSubagents: true,
	};

	const payload = usageSnapshot(usage);

	// The tile that was wrong.
	assert.equal(payload.input_tokens, 16_015_192, "input_tokens IS the total the client calls 'in'");
	assert.notEqual(payload.input_tokens, usage.inputTokens, "…and is no longer the uncached field");
	// Output always agreed; it must keep agreeing.
	assert.equal(payload.output_tokens, 98_599);
	// Nothing is lost: the total can be re-derived from the parts.
	assert.equal(payload.input_tokens_uncached, 416);
	assert.equal(payload.cache_creation, 1_605_396);
	assert.equal(payload.cache_read, 14_409_380);
	assert.equal(
		payload.input_tokens_uncached + payload.cache_creation + payload.cache_read,
		payload.input_tokens,
		"the headline is exactly the sum of its parts",
	);
	// What the server had no notion of at all before: how full the window is,
	// how many turns it took, and whether subagents are in the numbers.
	assert.equal(payload.context_tokens, 202_014);
	assert.equal(payload.context_window, 1_000_000);
	assert.equal(payload.context_pct, 20.2, "the same 20.2% the client's bar reads");
	assert.equal(payload.model, "claude-opus-5");
	assert.equal(payload.turns, 143);
	assert.equal(payload.includes_subagents, true);
	assert.equal(payload.compacted, false);
});

test("context percentage is against the model's real window, and is 0 rather than NaN with no window", () => {
	const base = {
		contextTokens: 100_000,
		contextWindow: 200_000,
		model: "claude-sonnet-4",
		lastCompactionAt: null,
		compactions: 1,
		inputTokens: 1,
		cacheCreationTokens: 2,
		cacheReadTokens: 3,
		outputTokens: 4,
		totalInputTokens: 6,
		turns: 1,
		includesSubagents: false,
	};
	assert.equal(contextPercent(base), 50);
	// A 200k-window session at 100k is half full; the same occupancy against a
	// 1M window is a tenth. Quoting one window for both is the bug this guards.
	assert.equal(contextPercent({ ...base, contextWindow: 1_000_000 }), 10);
	assert.equal(contextPercent({ ...base, contextWindow: 0 }), 0);
	assert.equal(usageSnapshot({ ...base, compactions: 2 }).compacted, true);
});

test("the report event is built from usageSnapshot, so the wire can't drift from the meter", () => {
	const source = read("workflow.ts");
	assert.match(source, /reportEmit\(\s*"usage\.snapshot",[\s\S]{0,200}data: usageSnapshot\(u\),/);
	// The old hand-rolled payload, which is what quoted the bare field.
	assert.doesNotMatch(source, /input_tokens: u\.inputTokens/);
});

test("the workflow detail page shows the same readout, under the Canvas/List content", () => {
	const detail = read("ui/src/views/WorkflowDetail.tsx");

	// The panel exists, has a stable hook, and renders the shared meter.
	assert.match(detail, /data-workflow-usage/);
	assert.match(detail, /<UsageMeter usage=\{sessionInfo\.usage\} \/>/);

	// Position: after the canvas/list branch closes and before the steps section
	// does — i.e. below the canvas and its legend, not above the steps.
	const canvasBranch = detail.indexOf("stepsView === \"canvas\" ? (");
	const panel = detail.indexOf("data-workflow-usage");
	const sessionPanel = detail.indexOf("<SessionPanel");
	assert.ok(canvasBranch > 0 && panel > 0 && sessionPanel > 0);
	assert.ok(panel > canvasBranch, "the usage panel comes after the Canvas/List content");
	assert.ok(panel < sessionPanel, "…and still inside the steps section, above the Conversation panel");
});

test("the meter quotes the total, in the client's own abbreviations", () => {
	const meter = read("ui/src/views/UsageMeter.tsx");

	// "Context 202.0k / 1.0M" … "20.2%"
	assert.match(meter, /Context \{compactNumber\(usage\.contextTokens\)\} \/ \{compactNumber\(usage\.contextWindow\)\}/);
	assert.match(meter, /\{pct\.toFixed\(1\)\}%/);
	// "143 turns · in 16.0M · out 98.6k · incl. subagents"
	assert.match(meter, /\{usage\.turns\} turns · in \{compactNumber\(usage\.totalInputTokens\)\}/);
	assert.match(meter, /out \{compactNumber\(usage\.outputTokens\)\}/);
	assert.match(meter, /incl\. subagents/);
	// Never the uncached field — that is the number that read as 416.
	assert.doesNotMatch(meter, /compactNumber\(usage\.inputTokens\)/);

	// Both panels render THIS component rather than their own copy of the markup.
	assert.match(read("ui/src/views/SessionPanel.tsx"), /<UsageMeter usage=\{usage\} \/>/);
});
