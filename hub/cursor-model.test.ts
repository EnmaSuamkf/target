/**
 * Which model — and so which context window — a Cursor session is measured
 * against.
 *
 * Cursor's headless result JSON and its agent-transcripts never name the model,
 * and awb doesn't pass `--model`, so the hub used to fall back to 200k for
 * every Cursor session, whatever it ran on. The sources, in the order
 * readTokenUsage tries them (transcript.ts):
 *
 * 1. `model` in the result JSON (absent on this machine);
 * 2. `--model` on the run's logged `$ agent -p …` line, with Cursor's
 *    `[context=…]` parameter as the run's stated window;
 * 3. Cursor's own tracking database, `ai_code_hashes.model` for the
 *    conversation — the one per-session record of the model it keeps;
 * 4. the agent-transcript's `modelName` (absent on this machine);
 *
 * and for the window, the size the CLI config sets for that model
 * (`modelParameters[model].context`) when the command line stated none.
 *
 * Fixture: REAL log lines, tracking rows and CLI config, see the `_comment` in
 * fixtures/cursor-model-sources.json. The only thing these tests write that
 * isn't copied from this machine is a `--model` flag, because awb never
 * passes one — that test says so where it does it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-cursor-model-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { cursorModelFromCommandLine, parseCursorContextSize, readTokenUsage } = await import("./transcript.ts");

interface Fixture {
	sessionId: string;
	logHead: string;
	resultLine: string;
	tracking: { schema: string; rows: Record<string, string | number>[] };
	cliConfig: Record<string, unknown>;
}
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/cursor-model-sources.json", import.meta.url), "utf8")) as Fixture;

// The real run: 6 input + 880 cache writes + 183,708 cache reads, one result,
// no transcript on disk here — so its reading is S itself, 184,594.
const READING = 6 + 880 + 183_708;

function reset(): void {
	for (const dir of [".agent-webhook-bridge", ".cursor", ".target"]) fs.rmSync(path.join(tmpHome, dir), { recursive: true, force: true });
}

function writeLog(head = fx.logHead): void {
	const logs = path.join(tmpHome, ".agent-webhook-bridge", "logs");
	fs.mkdirSync(logs, { recursive: true });
	fs.writeFileSync(path.join(logs, "run.log"), `${head}\ncwd: /home/lenovo/Documentos/target-server\n\n${fx.resultLine}\n`);
}

function writeTracking(): void {
	const dir = path.join(tmpHome, ".cursor", "ai-tracking");
	fs.mkdirSync(dir, { recursive: true });
	const db = new DatabaseSync(path.join(dir, "ai-code-tracking.db"));
	db.exec(fx.tracking.schema);
	const insert = db.prepare(
		"INSERT INTO ai_code_hashes (hash, source, fileExtension, fileName, requestId, conversationId, timestamp, model, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	for (const r of fx.tracking.rows) {
		insert.run(r.hash!, r.source!, r.fileExtension!, r.fileName!, r.requestId!, r.conversationId!, r.timestamp!, r.model!, r.createdAt!);
	}
	db.close();
}

function writeCliConfig(): void {
	fs.mkdirSync(path.join(tmpHome, ".cursor"), { recursive: true });
	fs.writeFileSync(path.join(tmpHome, ".cursor", "cli-config.json"), JSON.stringify(fx.cliConfig));
}

test("a Cursor session is measured against the window of the model it ran on, not the 200k fallback", () => {
	// Session 497dc5a3 ran on gpt-5.6-terra (its tracking rows say so), and the
	// CLI config runs that model at context=272k. The logged command line is the
	// real one: awb passed no --model, so the command line can't say.
	reset();
	writeLog();
	writeTracking();
	writeCliConfig();
	assert.equal(cursorModelFromCommandLine(fx.logHead), null, "awb's real command line carries no --model");

	const usage = readTokenUsage("/irrelevant", fx.sessionId);
	assert.equal(usage.model, "gpt-5.6-terra");
	assert.equal(usage.contextWindow, 272_000);
	assert.equal(usage.contextTokens, READING);
	// 67.9% of the window it really had — the fallback read the same session as 92.3%.
	assert.equal(Number(((100 * usage.contextTokens) / usage.contextWindow).toFixed(1)), 67.9);
});

test("with no size in the CLI config, the model's table entry or the fallback applies", () => {
	reset();
	writeLog();
	writeTracking();
	// The model is still known, but nothing says what size it ran at, and
	// gpt-5.6-terra has no table entry: the fallback — named, not silent.
	const usage = readTokenUsage("/irrelevant", fx.sessionId);
	assert.equal(usage.model, "gpt-5.6-terra");
	assert.equal(usage.contextWindow, 200_000);
});

test("with nothing on disk naming the model, the window stays the 200k fallback", () => {
	reset();
	writeLog();
	writeCliConfig();
	const usage = readTokenUsage("/irrelevant", fx.sessionId);
	assert.equal(usage.model, null);
	assert.equal(usage.contextWindow, 200_000);
});

test("a --model flag on the run's own command line wins, with the window it states", () => {
	// awb never passes --model, so this one flag is added to the real line —
	// in Cursor's documented parameterised form (`agent --help`).
	reset();
	writeTracking();
	writeCliConfig();
	const head = fx.logHead.replace(" --resume ", " --model claude-opus-4-8[context=1m,effort=high,fast=false] --resume ");
	assert.notEqual(head, fx.logHead);
	writeLog(head);

	assert.deepEqual(cursorModelFromCommandLine(head), { model: "claude-opus-4-8", statedWindow: 1_000_000 });
	const usage = readTokenUsage("/irrelevant", fx.sessionId);
	assert.equal(usage.model, "claude-opus-4-8", "the run's own flag beats the tracking database");
	assert.equal(usage.contextWindow, 1_000_000);

	// The operator's override still beats what the run stated.
	fs.mkdirSync(path.join(tmpHome, ".target"), { recursive: true });
	fs.writeFileSync(path.join(tmpHome, ".target", "config.json"), JSON.stringify({ modelContextWindows: { "claude-opus-4-8": 500_000 } }));
	assert.equal(readTokenUsage("/irrelevant", fx.sessionId).contextWindow, 500_000);
});

test("--model quoted inside a prompt is not a flag", () => {
	// Real logs here carry hundreds of `--model claude-3-5-haiku-20241022` inside
	// prompts that only DESCRIBE a command line. The prompt is skipped.
	const inPrompt = fx.logHead.replace(
		"Current step:",
		"Current step: run `claude -p --model claude-3-5-haiku-20241022` and report.",
	);
	assert.notEqual(inPrompt, fx.logHead);
	assert.equal(cursorModelFromCommandLine(inPrompt), null);
	// Quoted and `=` forms of a real flag are both read.
	assert.deepEqual(cursorModelFromCommandLine(`$ agent -p "x" --model 'gpt-5.6-sol[context=272k]'`), {
		model: "gpt-5.6-sol",
		statedWindow: 272_000,
	});
	assert.deepEqual(cursorModelFromCommandLine(`$ agent -p "x" --model=composer-2.5`), { model: "composer-2.5", statedWindow: null });
});

test("Cursor context sizes parse as the CLI writes them", () => {
	assert.equal(parseCursorContextSize("272k"), 272_000);
	assert.equal(parseCursorContextSize("1m"), 1_000_000);
	assert.equal(parseCursorContextSize("1M"), 1_000_000);
	assert.equal(parseCursorContextSize("200000"), 200_000);
	assert.equal(parseCursorContextSize("big"), null);
	assert.equal(parseCursorContextSize("0"), null);
});
