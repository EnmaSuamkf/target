/**
 * Tests for the derived context window (models.ts + transcript.ts) and for the
 * token meter the UI renders from `usage.contextWindow`.
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

const { _stats, contextWindowForModel, COPILOT_MODEL_CONTEXT_WINDOWS, FALLBACK_CONTEXT_WINDOW_TOKENS, MODEL_CONTEXT_WINDOWS } = await import("./models.ts");
const { claudeProjectDir, readTokenUsage } = await import("./transcript.ts");

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

test("config.json is read once per edit, not once per lookup — and an edit is still picked up", () => {
	// contextWindowForModel runs on every /session-info poll. It used to re-read
	// and re-parse config.json each time; now a stat decides whether it changed.
	const file = path.join(String(process.env.TARGET_HOME), "config.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ modelContextWindows: { "cache-probe": 111_000 } }));
	try {
		assert.equal(contextWindowForModel("cache-probe"), 111_000);
		const reads = _stats.configReads;
		for (let i = 0; i < 50; i++) contextWindowForModel(i % 2 ? "cache-probe" : "claude-sonnet-5");
		assert.equal(_stats.configReads, reads, "50 lookups, zero re-reads of an unchanged file");

		// An edit lands on the very next lookup — including one that keeps the
		// file the same size, which only the mtime gives away.
		fs.writeFileSync(file, JSON.stringify({ modelContextWindows: { "cache-probe": 222_000 } }));
		const later = new Date(Date.now() + 5_000);
		fs.utimesSync(file, later, later);
		assert.equal(contextWindowForModel("cache-probe"), 222_000);
		assert.equal(_stats.configReads, reads + 1);

		// Deleting the file is an edit too: the overrides go away.
		fs.rmSync(file);
		assert.equal(contextWindowForModel("cache-probe"), FALLBACK_CONTEXT_WINDOW_TOKENS);
	} finally {
		fs.rmSync(file, { force: true });
	}
});

test("a window the run stated beats the table, but not the operator", () => {
	// Cursor runs the same model id at more than one size (272k or 1M), so what
	// the run itself declared outranks the table entry for the id.
	assert.equal(contextWindowForModel("gpt-5.6-sol", 272_000), 272_000);
	assert.equal(contextWindowForModel("gpt-5.6-sol"), MODEL_CONTEXT_WINDOWS["gpt-5.6-sol"]);
	assert.equal(contextWindowForModel(null, 300_000), 300_000, "a stated size needs no model id");
	assert.equal(contextWindowForModel("gpt-5.6-sol", 0), MODEL_CONTEXT_WINDOWS["gpt-5.6-sol"], "a non-size is ignored");
	withConfig({ modelContextWindows: { "gpt-5.6-sol": 400_000 } }, () => {
		assert.equal(contextWindowForModel("gpt-5.6-sol", 272_000), 400_000, "the operator's override still wins");
	});
});

test("free-code's kimi-k3 has its published 1M window, not the 200k fallback", () => {
	// Fireworks: "1,048,576 tokens". Measured here: 191,734 in one turn — which a
	// 200k (or free-code's own 128k) denominator would put at 96% (150%).
	assert.equal(contextWindowForModel("accounts/fireworks/models/kimi-k3"), 1_048_576);
	const file = writeFreeCode("kimi.jsonl", [
		JSON.stringify({ type: "model_change", id: "m0", timestamp: "2026-08-06T21:40:00.000Z", provider: "fireworks", modelId: "accounts/fireworks/models/kimi-k3" }),
		JSON.stringify({
			type: "message",
			id: "a1",
			timestamp: "2026-08-06T22:28:19.489Z",
			message: { role: "assistant", content: [], usage: { input: 1_734, output: 900, cacheRead: 190_000, cacheWrite: 0 } },
		}),
	]);
	const usage = readTokenUsage("/irrelevant", file);
	assert.equal(usage.model, "accounts/fireworks/models/kimi-k3");
	assert.equal(usage.contextWindow, 1_048_576);
	assert.equal(usage.contextTokens, 191_734);
});

test("docs/context-meter.md lists MODEL_CONTEXT_WINDOWS entry for entry", () => {
	// The doc promises its table IS the table in models.ts; this keeps it true.
	const doc = fs.readFileSync(new URL("../docs/context-meter.md", import.meta.url), "utf8");
	const section = doc.slice(doc.indexOf("### Model table"), doc.indexOf("## When the hub's number differs"));
	const rows = [...section.matchAll(/^\| `([^`]+)` \| ([\d,]+) \|/gm)].map((m) => [m[1], Number(m[2]!.replaceAll(",", ""))]);
	assert.deepEqual(rows, Object.entries(MODEL_CONTEXT_WINDOWS), "same ids, same windows, same order");
});

// --- GitHub Copilot CLI ids -------------------------------------------------

test("copilot: observed ids resolve to Copilot's max_prompt_tokens, not the full window", () => {
	assert.equal(contextWindowForModel("claude-haiku-4.5"), 128_000);
	assert.equal(contextWindowForModel("gpt-5.4"), 922_000);
	assert.equal(contextWindowForModel("gpt-5.4-nano"), 272_000);
	assert.equal(contextWindowForModel("gpt-4o-mini-2024-07-18"), 64_000, "a dated variant resolves through its prefix");
	// gpt-5.4 must not swallow its siblings through the prefix match.
	assert.equal(contextWindowForModel("gpt-5.4-mini"), 128_000);
	assert.equal(contextWindowForModel("gpt-5.4-nano"), 272_000);
});

test("copilot: every documented id has an exact entry", () => {
	for (const id of [
		"claude-haiku-4.5", "claude-sonnet-4.6", "claude-sonnet-5", "claude-sonnet-5.5", "claude-opus-4.7", "claude-opus-4.8",
		"claude-opus-5", "claude-opus-5.5", "claude-fable-5", "claude-fable-5.1", "gpt-5-mini", "gpt-5.3-codex", "gpt-5.4",
		"gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna",
		"gpt-6-sol", "gpt-6.1-sol", "gemini-3.6-flash", "gemini-3.7-flash", "grok-4.5", "kimi-k2.7-code", "kimi-k3",
	]) {
		assert.ok(COPILOT_MODEL_CONTEXT_WINDOWS[id] !== undefined, `${id} has no Copilot entry`);
	}
});

test("copilot: claude-opus-5.5 does not resolve through claude-opus-5 (and the reverse)", () => {
	assert.equal(contextWindowForModel("claude-opus-5"), 1_000_000, "no harness: Claude Code's measured window");
	assert.equal(contextWindowForModel("claude-opus-5", null, "copilot"), 128_000, "a Copilot session: its own table wins");
	assert.equal(contextWindowForModel("claude-opus-5.5"), 128_000);
	assert.equal(contextWindowForModel("claude-opus-5.5", null, "copilot"), 128_000);
	assert.equal(contextWindowForModel("claude-sonnet-5.5"), 128_000);
	assert.equal(contextWindowForModel("claude-fable-5.1"), 128_000);
	// A dated Claude Code id still resolves through its entry.
	assert.equal(contextWindowForModel("claude-opus-5-20260430"), 1_000_000);
	// An unlisted point release never inherits a neighbour's window.
	assert.equal(contextWindowForModel("claude-opus-5.9"), FALLBACK_CONTEXT_WINDOW_TOKENS);
	assert.equal(contextWindowForModel("claude-opus-5.5-20261001"), 128_000, "a dated Copilot id uses the longest prefix");
});

test("copilot: an id that Cursor also spells keeps Cursor's window without a harness", () => {
	assert.equal(contextWindowForModel("gpt-5.6-sol"), 1_000_000);
	assert.equal(contextWindowForModel("gpt-5.6-sol", null, "copilot"), 128_000);
});

test("copilot: other named harnesses never inherit Copilot's ids", () => {
	assert.equal(contextWindowForModel("claude-haiku-4.5", null, "cursor"), FALLBACK_CONTEXT_WINDOW_TOKENS);
	assert.equal(contextWindowForModel("claude-opus-5", null, "claude"), 1_000_000);
});

test("copilot: an unknown model falls back to FALLBACK_CONTEXT_WINDOW_TOKENS", () => {
	assert.equal(contextWindowForModel("mystery-model-9.9", null, "copilot"), FALLBACK_CONTEXT_WINDOW_TOKENS);
	assert.equal(contextWindowForModel("gpt-5.4-ultra", null, "copilot"), 922_000, "a longer suffix after a dash is still the gpt-5.4 family");
});

test("copilot: the operator override and a stated window still win", () => {
	const file = path.join(tmpHome, ".target", "config.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ modelContextWindows: { "claude-haiku-4.5": 90_000, "claude-opus-5.5": 700_000 } }));
	try {
		assert.equal(contextWindowForModel("claude-haiku-4.5", null, "copilot"), 90_000);
		assert.equal(contextWindowForModel("claude-haiku-4.5", 50_000, "copilot"), 90_000, "override beats stated");
		assert.equal(contextWindowForModel("claude-opus-5.5"), 700_000);
		assert.equal(contextWindowForModel("gpt-5.4", 500_000, "copilot"), 500_000, "stated beats the table");
	} finally {
		fs.rmSync(file, { force: true });
	}
});

test("copilot: a Copilot session's window comes from its own table end to end", () => {
	const copilotHome = path.join(tmpHome, "copilot");
	const prevHome = process.env.COPILOT_HOME;
	process.env.COPILOT_HOME = copilotHome;
	try {
		const id = "abababab-0000-4000-8000-000000000001";
		const dir = path.join(copilotHome, "session-state", id);
		fs.mkdirSync(dir, { recursive: true });
		const lines = [
			{ type: "assistant.message", data: { model: "claude-opus-5", content: "hi", toolRequests: [] } },
			{ type: "session.shutdown", data: { currentTokens: 20_000, modelMetrics: { "claude-opus-5": { requests: { count: 1 }, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } } } },
		];
		fs.writeFileSync(path.join(dir, "events.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		const u = readTokenUsage(workdir, id, "copilot");
		assert.equal(u.contextWindow, 128_000, "not Claude Code's 1M for the same id");
		assert.equal(u.contextTokens, 20_000);
	} finally {
		if (prevHome === undefined) delete process.env.COPILOT_HOME;
		else process.env.COPILOT_HOME = prevHome;
	}
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

test("occupancy ratio divides by the DERIVED window", () => {
	// 500k tokens: half of a claude-sonnet-5 window, but two and a half times the
	// old assumed 200k. Under the hardcoded window the meter read permanently red;
	// under the real window it reflects actual occupancy.
	writeClaude("sess-gate", [claudeTurn("m1", "claude-sonnet-5", 500_000)]);
	const usage = readTokenUsage(workdir, "sess-gate");
	const ratio = usage.contextTokens / usage.contextWindow;
	assert.ok(ratio < 0.6, `expected under 60%, got ${ratio}`);

	// The same token count on a genuinely 200k model IS over 60%.
	writeClaude("sess-gate-small", [claudeTurn("m1", "claude-haiku-5", 150_000)]);
	const small = readTokenUsage(workdir, "sess-gate-small");
	const smallRatio = small.contextTokens / small.contextWindow;
	assert.ok(smallRatio > 0.6, `expected over 60%, got ${smallRatio}`);
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
