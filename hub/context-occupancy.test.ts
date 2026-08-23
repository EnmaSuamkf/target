/**
 * What the context meter is allowed to say while a session is being written.
 *
 * The hub polls a transcript that the agent is appending to — most visibly
 * during a judge pass, which resumes the step's own conversation and adds turns
 * to it while the operator watches the Conversation panel. Whatever the last
 * line of that file says at the instant of the poll becomes the headline
 * "Context <used> / <window>". So the reading has to survive the lines that are
 * NOT occupancy, and both harnesses write them:
 *
 * - Claude Code stamps `model: "<synthetic>"` on a turn it fabricated rather
 *   than ran (an API error notice, a rate-limit message) with a `usage` block of
 *   all zeros;
 * - free-code writes an aborted turn (`"stopReason":"aborted"`, empty content)
 *   with the same all-zero usage.
 *
 * Both fixtures below are REAL lines copied out of this machine's transcripts,
 * trimmed only where noted — the free-code one landed on 2026-08-19 in a session
 * that had just been judged twice, which is the report these tests exist for.
 *
 * Same throwaway HOME/TARGET_HOME/AWB_HOME convention as compaction.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-occupancy-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { claudeProjectDir, contextPercent, readTokenUsage } = await import("./transcript.ts");

const WORKDIR = path.join(tmpHome, "wd");

/** One ordinary Claude Code assistant turn occupying `context` tokens. */
function claudeTurn(id: string, context: number, model = "claude-opus-5"): string {
	return JSON.stringify({
		type: "assistant",
		timestamp: "2026-08-19T19:30:00.000Z",
		message: {
			id,
			role: "assistant",
			model,
			usage: {
				input_tokens: 2,
				cache_creation_input_tokens: 100,
				cache_read_input_tokens: context - 102,
				output_tokens: 50,
			},
		},
	});
}

/**
 * REAL rate-limit line from ~/.claude/projects/-home-lenovo/855dcec3-….jsonl.
 * `model: "<synthetic>"`, `isApiErrorMessage: true`, every usage field zero —
 * the turn never reached the model, so it says nothing about the window.
 */
const CLAUDE_SYNTHETIC_LINE = JSON.stringify({"parentUuid":"5dbe8272-ed78-48de-92e6-d320b9c75d46","isSidechain":false,"type":"assistant","uuid":"b23274f0-a494-4d7c-b931-3f9dc7f55415","timestamp":"2026-07-26T15:06:19.592Z","message":{"id":"4d66b61c-bee2-43b2-92ae-7b9769247f66","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null,"speed":null},"content":[{"type":"text","text":"You've hit your session limit · resets 5:40pm (Europe/Madrid)"}]},"requestId":"req_011CdQsoN2unJjQn4H4iiYvz","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"sessionId":"855dcec3-0780-4ed1-a18f-a238856f8824","version":"2.1.220"});

/**
 * REAL aborted turn from
 * ~/.agent-webhook-bridge/sessions/check-free-code-143ca3c1/1787083991012-….jsonl,
 * written 2026-08-19T19:32:57Z as the last line of a session sitting at 86,386
 * tokens. Verbatim.
 */
const FREE_CODE_ABORTED_LINE = JSON.stringify({"type":"message","id":"6f9c910e","parentId":"4689e60d","timestamp":"2026-08-19T19:32:57.717Z","message":{"role":"assistant","content":[],"api":"openai-completions","provider":"fireworks","model":"accounts/fireworks/models/kimi-k3","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"aborted","timestamp":1787167977481,"errorMessage":"Operation aborted"}});

function writeClaudeTranscript(sessionId: string, lines: string[]): void {
	const dir = claudeProjectDir(WORKDIR);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

function writeFreeCodeTranscript(name: string, lines: string[]): string {
	const dir = path.join(tmpHome, ".agent-webhook-bridge", "sessions", "fc-hook");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

// --- turns that never reached the model ---

test("a claude <synthetic> error turn does not become the session's occupancy", () => {
	writeClaudeTranscript("sess-synthetic", [claudeTurn("msg-1", 40_000), claudeTurn("msg-2", 86_386), CLAUDE_SYNTHETIC_LINE]);
	const usage = readTokenUsage(WORKDIR, "sess-synthetic");
	assert.equal(usage.contextTokens, 86_386, "the last turn that actually sent a prompt still stands");
	assert.equal(usage.model, "claude-opus-5", "<synthetic> is not a model, so the window keeps its real one");
	assert.equal(usage.turns, 3, "it is still a turn, and still billed (zero)");
});

test("a free-code aborted turn does not become the session's occupancy", () => {
	const file = writeFreeCodeTranscript("1787083991012-aborted.jsonl", [
		JSON.stringify({ type: "model_change", modelId: "accounts/fireworks/models/kimi-k3" }),
		JSON.stringify({ message: { role: "assistant", usage: { input: 338, cacheRead: 86_048, cacheWrite: 0, output: 372 } } }),
		FREE_CODE_ABORTED_LINE,
	]);
	const usage = readTokenUsage("/nowhere", file);
	assert.equal(usage.contextTokens, 86_386, "43% full, not 0% — the aborted turn measured nothing");
	assert.ok(contextPercent(usage) > 40, "and the meter must not collapse to zero because of it");
});

// --- readings the window cannot hold ---

test("an occupancy above the window is rejected in favour of the last plausible turn", () => {
	// A line whose in+cache exceeds the model's whole window is not occupancy —
	// it is a billing total or a line the harness has not finalised. Publishing it
	// would clamp the meter's fill at 100%: a full bar on a session that is 4% full.
	writeClaudeTranscript("sess-impossible", [
		claudeTurn("msg-1", 40_000),
		claudeTurn("msg-2", 1_500_000),
	]);
	const usage = readTokenUsage(WORKDIR, "sess-impossible");
	assert.equal(usage.contextWindow, 1_000_000);
	assert.equal(usage.contextTokens, 40_000);
	assert.ok(contextPercent(usage) <= 100, "the meter can never report more than a full window");
});

test("a plausible occupancy is reported as-is, however high", () => {
	// The guard must not flatten a session that really is nearly full: that
	// reading drives the compaction warning and the 60% delegation gate.
	writeClaudeTranscript("sess-nearly-full", [claudeTurn("msg-1", 100_000), claudeTurn("msg-2", 950_000)]);
	const usage = readTokenUsage(WORKDIR, "sess-nearly-full");
	assert.equal(usage.contextTokens, 950_000);
	assert.equal(contextPercent(usage).toFixed(1), "95.0");
});

// --- the judge pass itself ---

test("a judge pass appended to a session moves the meter by its own turns only", () => {
	// The exec pass ends at 86,386; the judge resumes that same conversation and
	// adds two turns. Reading the file at any of those points must give the
	// occupancy of the newest real turn — never a jump to a full window.
	const exec = [claudeTurn("msg-1", 40_000), claudeTurn("msg-2", 86_386)];
	const judge = [claudeTurn("msg-3", 87_500), CLAUDE_SYNTHETIC_LINE, claudeTurn("msg-4", 88_900)];
	const expected = [40_000, 86_386, 87_500, 87_500, 88_900];
	for (let i = 1; i <= exec.length + judge.length; i++) {
		writeClaudeTranscript("sess-judging", [...exec, ...judge].slice(0, i));
		const usage = readTokenUsage(WORKDIR, "sess-judging");
		assert.equal(usage.contextTokens, expected[i - 1], `poll after line ${i}`);
		assert.ok(contextPercent(usage) < 10, "a 1M-window session at 89k is never a full bar");
	}
});
