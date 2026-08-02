/**
 * Tests for the derived context window (models.ts + transcript.ts) and for the
 * two things that consume it: the 60% delegation gate (context-pressure.ts) and
 * the token meter the UI renders from `usage.contextWindow`.
 *
 * Why this stopped being a constant. `CONTEXT_WINDOW_TOKENS = 200_000` was a
 * guess, and it was wrong by a factor: real transcripts on this machine carry
 * single turns of 370k (`claude-sonnet-5`) and 415k (`claude-fable-5`) context
 * tokens. Every threshold that divides by the window inherited that error — the
 * pressure gate fired from the first step of every workflow and the meter was
 * pinned red — so a wrong denominator isn't a cosmetic problem, it's the
 * feature not working.
 *
 * What's pinned here is therefore the derivation, not the numbers in the table:
 * the model is read from BOTH harnesses' transcripts, the lookup degrades in a
 * documented order (override → exact → prefix → fallback), and the gate reads
 * the derived value rather than a literal.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-models-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { contextWindowForModel, FALLBACK_CONTEXT_WINDOW_TOKENS, MODEL_CONTEXT_WINDOWS } = await import("./models.ts");
const { claudeProjectDir, readTokenUsage } = await import("./transcript.ts");
const { sessionContextRatio, shouldForceSubagent } = await import("./context-pressure.ts");

const workdir = path.join(tmpHome, "workdir");

/** A claude assistant turn attributed to `model`. */
function claudeTurn(id: string, model: string | null, tokens: number): string {
	return JSON.stringify({
		type: "assistant",
		message: {
			id,
			role: "assistant",
			...(model === null ? {} : { model }),
			usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
		},
	});
}

function writeClaude(sessionId: string, lines: string[]): void {
	const file = path.join(claudeProjectDir(workdir), `${sessionId}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/** free-code layout: the session id IS the transcript's absolute path. */
function writeFreeCode(name: string, lines: string[]): string {
	const dir = path.join(tmpHome, "fc-sessions");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

/** Writes ~/.target/config.json, the override layer, and removes it afterwards. */
function withConfig(overrides: Record<string, unknown>, body: () => void): void {
	const file = path.join(String(process.env.TARGET_HOME), "config.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	fs.writeFileSync(file, JSON.stringify(overrides));
	try {
		body();
	} finally {
		if (previous === null) fs.rmSync(file, { force: true });
		else fs.writeFileSync(file, previous);
	}
}

// --- the lookup itself ----------------------------------------------------

test("the window comes from the model, and no model means the documented fallback", () => {
	// The regression this branch exists for: none of the models actually in use
	// here is a 200k model, so a hardcoded 200_000 was wrong for all of them.
	assert.ok(MODEL_CONTEXT_WINDOWS["claude-sonnet-5"] > 200_000);
	assert.ok(MODEL_CONTEXT_WINDOWS["claude-opus-5"] > 200_000);
	assert.equal(contextWindowForModel("claude-sonnet-5"), MODEL_CONTEXT_WINDOWS["claude-sonnet-5"]);

	// Unknown / absent / synthetic all land on the fallback rather than throwing:
	// a transcript with no assistant turn yet is normal, not an error.
	assert.equal(contextWindowForModel(null), FALLBACK_CONTEXT_WINDOW_TOKENS);
	assert.equal(contextWindowForModel(""), FALLBACK_CONTEXT_WINDOW_TOKENS);
	assert.equal(contextWindowForModel("<synthetic>"), FALLBACK_CONTEXT_WINDOW_TOKENS);
	assert.equal(contextWindowForModel("some-model-nobody-has-heard-of"), FALLBACK_CONTEXT_WINDOW_TOKENS);
});

test("a dated model id resolves through its longest matching prefix", () => {
	// Providers append dates and revisions; an entry per variant would rot.
	assert.equal(contextWindowForModel("claude-sonnet-5-20260101"), MODEL_CONTEXT_WINDOWS["claude-sonnet-5"]);
	assert.equal(contextWindowForModel("CLAUDE-OPUS-5"), MODEL_CONTEXT_WINDOWS["claude-opus-5"], "case-insensitive");
	// free-code's fully-qualified provider ids work as-is.
	assert.equal(
		contextWindowForModel("accounts/fireworks/models/glm-5p2"),
		MODEL_CONTEXT_WINDOWS["accounts/fireworks/models/glm-5p2"],
	);
});

test("config overrides the table, so a new model doesn't need a code change", () => {
	withConfig({ modelContextWindows: { "claude-sonnet-5": 12_345, "brand-new-model": 999_000 } }, () => {
		assert.equal(contextWindowForModel("claude-sonnet-5"), 12_345, "the operator wins over the table");
		assert.equal(contextWindowForModel("brand-new-model"), 999_000);
	});
	// …and the override is not sticky: remove it and the table is back.
	assert.equal(contextWindowForModel("claude-sonnet-5"), MODEL_CONTEXT_WINDOWS["claude-sonnet-5"]);
});

test("the fallback itself is configurable, and garbage overrides are ignored", () => {
	withConfig({ fallbackContextWindowTokens: 128_000 }, () => {
		assert.equal(contextWindowForModel("unknown-model"), 128_000);
	});
	withConfig({ modelContextWindows: { "claude-sonnet-5": "200k", bad: 0, worse: -5 } }, () => {
		// A window of 0 or a string would make every ratio meaningless; the table
		// value stands instead.
		assert.equal(contextWindowForModel("claude-sonnet-5"), MODEL_CONTEXT_WINDOWS["claude-sonnet-5"]);
		assert.equal(contextWindowForModel("bad"), FALLBACK_CONTEXT_WINDOW_TOKENS);
		assert.equal(contextWindowForModel("worse"), FALLBACK_CONTEXT_WINDOW_TOKENS);
	});
});

// --- reading the model out of each harness's transcript --------------------

test("claude: the window follows message.model on the last assistant turn", () => {
	writeClaude("sess-sonnet", [claudeTurn("m1", "claude-sonnet-5", 250_000)]);
	const usage = readTokenUsage(workdir, "sess-sonnet");
	assert.equal(usage.model, "claude-sonnet-5");
	assert.equal(usage.contextWindow, MODEL_CONTEXT_WINDOWS["claude-sonnet-5"]);
	// The measurement this whole change came from: 250k of context is not "125%
	// full", it's a quarter of a 1M window.
	assert.ok(usage.contextTokens / usage.contextWindow < 0.3);
});

test("claude: a synthetic turn doesn't overwrite the real model", () => {
	writeClaude("sess-synth", [claudeTurn("m1", "claude-opus-5", 1000), claudeTurn("m2", "<synthetic>", 1000)]);
	assert.equal(readTokenUsage(workdir, "sess-synth").model, "claude-opus-5");
});

test("free-code: the window follows the model_change record", () => {
	const file = writeFreeCode("session-a.jsonl", [
		JSON.stringify({ type: "model_change", id: "a", parentId: null, provider: "anthropic", modelId: "claude-fable-5" }),
		JSON.stringify({ message: { role: "assistant", usage: { input: 300_000, cacheRead: 0, cacheWrite: 0, output: 10 } } }),
	]);
	const usage = readTokenUsage("/irrelevant", file);
	assert.equal(usage.model, "claude-fable-5");
	assert.equal(usage.contextWindow, MODEL_CONTEXT_WINDOWS["claude-fable-5"]);
});

test("free-code: a later model_change wins, since the window changes with it", () => {
	const file = writeFreeCode("session-b.jsonl", [
		JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "claude-fable-5" }),
		JSON.stringify({ message: { role: "assistant", usage: { input: 100, output: 1 } } }),
		JSON.stringify({ type: "model_change", provider: "fireworks", modelId: "accounts/fireworks/models/glm-5p2" }),
		JSON.stringify({ message: { role: "assistant", usage: { input: 200, output: 1 } } }),
	]);
	const usage = readTokenUsage("/irrelevant", file);
	assert.equal(usage.model, "accounts/fireworks/models/glm-5p2");
	assert.equal(usage.contextWindow, MODEL_CONTEXT_WINDOWS["accounts/fireworks/models/glm-5p2"]);
});

test("a transcript that names no model at all measures against the fallback", () => {
	writeClaude("sess-nameless", [claudeTurn("m1", null, 100_000)]);
	const usage = readTokenUsage(workdir, "sess-nameless");
	assert.equal(usage.model, null);
	assert.equal(usage.contextWindow, FALLBACK_CONTEXT_WINDOW_TOKENS);
});

// --- the consumers ---------------------------------------------------------

test("the 60% delegation gate divides by the DERIVED window", () => {
	// 500k tokens: half of a claude-sonnet-5 window, but two and a half times the
	// old assumed one. Under the hardcoded 200k this step was force-delegated;
	// under the real window the operator's inline toggle stands.
	writeClaude("sess-gate", [claudeTurn("m1", "claude-sonnet-5", 500_000)]);
	const ratio = sessionContextRatio(workdir, "sess-gate");
	assert.ok(ratio !== null && ratio < 0.6, `expected under the gate, got ${ratio}`);
	assert.equal(shouldForceSubagent(false, ratio), false, "not pressured — that window is a million tokens");

	// The same occupancy on a genuinely 200k model IS over the gate, which is the
	// proof that the gate still works and only the denominator changed.
	writeClaude("sess-gate-small", [claudeTurn("m1", "claude-haiku-5", 150_000)]);
	const small = sessionContextRatio(workdir, "sess-gate-small");
	assert.ok(small !== null && small > 0.6, `expected over the gate, got ${small}`);
	assert.equal(shouldForceSubagent(false, small), true);
});

test("the meter's inputs are the derived window and the model that explains it", () => {
	// SessionPanel renders `100 * contextTokens / contextWindow` and shows the
	// model as the window's provenance, so both have to reach it from here.
	writeClaude("sess-meter", [claudeTurn("m1", "claude-opus-5", 700_000)]);
	const usage = readTokenUsage(workdir, "sess-meter");
	assert.equal(usage.contextWindow, MODEL_CONTEXT_WINDOWS["claude-opus-5"]);
	assert.equal(usage.model, "claude-opus-5");
	const pct = (100 * usage.contextTokens) / usage.contextWindow;
	assert.ok(pct >= 70 && pct < 90, `70% band (amber), got ${pct}`);
});
