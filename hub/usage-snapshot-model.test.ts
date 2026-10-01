/**
 * Where `usage.snapshot.model` comes from, per runner, and where it is null
 * although a model is derivable.
 *
 * ROOT-CAUSE NOTE (investigation for "model and agent in usage.snapshot").
 * `TokenUsage.model` is `RawUsage.lastModel` (transcript.ts):
 *
 * - claude:    `message.model` of the last assistant line of the MAIN transcript
 *              (`<synthetic>` ignored). Subagent transcripts are summed for the
 *              billed totals but never consulted for the model.
 * - free-code: the last `model_change.modelId` (or `message.model`) in the file.
 * - cursor:    result-JSON `model` / `modelUsage` keys, else the logged `--model`
 *              flag, else the tracking database (`ai_code_hashes.model`), else
 *              `providerOptions.cursor.modelName` in the agent-transcript.
 *
 * Measured on this machine's real transcripts (readTokenUsage over each):
 * - claude:    40 of 43 sessions resolve a model. The 3 nulls are sessions whose
 *              only assistant turn is a `<synthetic>` API-error notice, so no
 *              model ever ran: null is correct there (guard test below).
 * - free-code: 296 of 296 sessions carry `model_change` + `message.model`.
 * - cursor:    38 of 72 sessions (awb `agent -p` logs) resolve null. awb passes
 *              no `--model`, the result JSON has no `model`, the agent-transcript
 *              has no `modelName`, and the tracking database only has rows for
 *              conversations that EDITED files. A research/review/read-only step
 *              leaves nothing naming the model, yet the CLI's own default
 *              (`~/.cursor/cli-config.json` -> `model.modelId`, the model a
 *              flag-less `agent -p` runs on) is on disk. THAT is the dominant
 *              cause of production `model: null`.
 *
 * Scenarios that reproduce a null where a model is derivable (these FAIL today):
 *  1. cursor, no edits, no flag, no modelName -> CLI default model unused.
 *  2. claude, main transcript has no real model but a subagent's does.
 *
 * Scenarios checked that already work (guards, pass today): claude `<synthetic>`
 * last turn, free-code model_change carried across a resume, cursor `--model`,
 * cursor transcript `modelName`. And one where null is the honest answer: a
 * snapshot taken before any assistant turn exists.
 *
 * HOME/TARGET_HOME/AWB_HOME are redirected before transcript.ts is imported.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-usage-model-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { claudeProjectDir, readTokenUsage, usageSnapshot } = await import("./transcript.ts");

const WORKDIR = path.join(tmpHome, "workdir");

function reset(): void {
	for (const dir of [".agent-webhook-bridge", ".cursor", ".claude", ".target"]) fs.rmSync(path.join(tmpHome, dir), { recursive: true, force: true });
}

function writeLines(file: string, lines: string[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function claudeTurn(id: string, model: string): string {
	return JSON.stringify({
		type: "assistant",
		message: { id, role: "assistant", model, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5_000, output_tokens: 20 } },
	});
}

const SYNTHETIC = claudeTurn("syn-1", "<synthetic>");

// --- claude ---

test("claude: a <synthetic> last turn keeps the real model before it", () => {
	reset();
	writeLines(path.join(claudeProjectDir(WORKDIR), "s-synth-last.jsonl"), [claudeTurn("m1", "claude-opus-5"), SYNTHETIC]);
	assert.equal(usageSnapshot(readTokenUsage(WORKDIR, "s-synth-last")).model, "claude-opus-5");
});

test("claude: a snapshot before any assistant turn has no model to report", () => {
	reset();
	writeLines(path.join(claudeProjectDir(WORKDIR), "s-no-turn.jsonl"), [JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })]);
	assert.equal(usageSnapshot(readTokenUsage(WORKDIR, "s-no-turn")).model, null, "nothing ran yet: null, never invented");
});

test("claude: only a <synthetic> turn means no model ran, so null is correct", () => {
	reset();
	writeLines(path.join(claudeProjectDir(WORKDIR), "s-only-synth.jsonl"), [SYNTHETIC]);
	assert.equal(readTokenUsage(WORKDIR, "s-only-synth").model, null);
});

test("claude: with no real model on the main thread, the subagents' model is reported", () => {
	reset();
	writeLines(path.join(claudeProjectDir(WORKDIR), "s-sub-model.jsonl"), [SYNTHETIC]);
	writeLines(path.join(claudeProjectDir(WORKDIR), "s-sub-model", "subagents", "a.jsonl"), [claudeTurn("sub-1", "claude-sonnet-5-5")]);
	const usage = readTokenUsage(WORKDIR, "s-sub-model");
	assert.equal(usage.includesSubagents, true);
	assert.equal(usage.model, "claude-sonnet-5-5", "the work was billed on this model; null leaves the server pricing it at the fallback");
});

// --- free-code ---

test("free-code: the model_change before a resume still names the model after it", () => {
	reset();
	const file = path.join(tmpHome, "fc", "2026-08-18T20-53-10-367Z_resumed.jsonl");
	const turn = (id: string) => JSON.stringify({ message: { id, role: "assistant", usage: { input: 10, cacheRead: 5_000, cacheWrite: 0, output: 20 } } });
	writeLines(file, [JSON.stringify({ type: "model_change", modelId: "accounts/fireworks/models/kimi-k3" }), turn("a")]);
	fs.appendFileSync(file, `${JSON.stringify({ type: "session", resumed: true })}\n${turn("b")}\n`);
	assert.equal(readTokenUsage("/nowhere", file).model, "accounts/fireworks/models/kimi-k3");
});

// --- cursor ---

const SID = "11111111-2222-3333-4444-555555555555";

function writeCursorLog(head = `$ agent -p "do the step" --output-format json --resume ${SID}`): void {
	const result = JSON.stringify({ type: "result", subtype: "success", session_id: SID, result: "done", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5_000, cacheWriteTokens: 0 } });
	const logs = path.join(tmpHome, ".agent-webhook-bridge", "logs");
	fs.mkdirSync(logs, { recursive: true });
	fs.writeFileSync(path.join(logs, "run.log"), `${head}\ncwd: ${WORKDIR}\n\n${result}\n`);
}

function writeCliConfig(modelId: string): void {
	fs.mkdirSync(path.join(tmpHome, ".cursor"), { recursive: true });
	fs.writeFileSync(path.join(tmpHome, ".cursor", "cli-config.json"), JSON.stringify({ model: { modelId, displayModelId: modelId }, selectedModel: { modelId } }));
}

test("cursor: a --model flag on the command line names the model", () => {
	reset();
	writeCursorLog(`$ agent -p "do the step" --model claude-opus-4-8 --resume ${SID}`);
	assert.equal(readTokenUsage(WORKDIR, SID).model, "claude-opus-4-8");
});

test("cursor: the agent-transcript modelName names the model when nothing else does", () => {
	reset();
	writeCursorLog();
	const part = { type: "text", text: "ok", providerOptions: { cursor: { modelName: "Composer 2.5 Fast" } } };
	writeLines(path.join(tmpHome, ".cursor", "projects", "p", "agent-transcripts", SID, `${SID}.jsonl`), [
		JSON.stringify({ role: "assistant", message: { content: [part] } }),
	]);
	assert.equal(readTokenUsage(WORKDIR, SID).model, "composer-2.5-fast");
});

test("cursor: a step that edited nothing falls back to the CLI's default model", () => {
	// The dominant production null: no --model (awb passes none), no model in the
	// result JSON, no modelName in the transcript, no tracking-database rows
	// because the conversation never edited a file. The flag-less `agent -p` ran
	// on the CLI's configured default, which is on disk.
	reset();
	writeCursorLog();
	writeCliConfig("grok-4.6");
	assert.equal(readTokenUsage(WORKDIR, SID).model, "grok-4.6");
});
