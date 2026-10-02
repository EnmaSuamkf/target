/**
 * The Copilot CLI usage reader: `<COPILOT_HOME>/session-state/<id>/events.jsonl`.
 *
 * Fixtures are built from the real event shapes (envelope `type`/`data`/`id`/
 * `timestamp`/`parentId`, `session.shutdown.data.modelMetrics`, ...) with the
 * large opaque reasoning fields and any personal paths left out. Throwaway
 * HOME and COPILOT_HOME: the operator's own sessions are never read.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-copilot-usage-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");
process.env.COPILOT_HOME = path.join(tmpHome, "copilot");

const { copilotHome, readTokenUsage, usageSnapshot } = await import("./transcript.ts");

const WORKDIR = path.join(tmpHome, "wd");
let counter = 0;
function sessionId(): string {
	counter += 1;
	return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

let seq = 0;
function event(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
	seq += 1;
	return JSON.stringify({
		type,
		data,
		...extra,
		id: `evt-${seq}`,
		timestamp: `2026-10-01T20:${String(seq % 60).padStart(2, "0")}:00.000Z`,
		parentId: `evt-${seq - 1}`,
	});
}

const start = (): string => event("session.start", { sessionId: "x", selectedModel: "claude-haiku-4.5", contextTier: null });
const userMsg = (): string => event("user.message", { content: "hello" });
const assistant = (model: string, extra: Record<string, unknown> = {}): string =>
	event("assistant.message", { messageId: "m", model, content: "hi", toolRequests: [], outputTokens: 5, ...extra });
const modelChange = (newModel: string): string =>
	event("session.model_change", { source: "agent", contextTier: null, newModel, reasoningEffort: null });

interface Metric {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	requests: number;
}
function shutdown(models: Record<string, Metric>, currentTokens: number | null, extra: Record<string, unknown> = {}): string {
	const modelMetrics: Record<string, unknown> = {};
	for (const [model, m] of Object.entries(models)) {
		modelMetrics[model] = {
			requests: { count: m.requests, cost: 0.33 },
			usage: {
				inputTokens: m.input,
				outputTokens: m.output,
				cacheReadTokens: m.cacheRead,
				cacheWriteTokens: m.cacheWrite,
				reasoningTokens: 0,
			},
			totalNanoAiu: 0,
		};
	}
	return event("session.shutdown", {
		shutdownType: "routine",
		totalPremiumRequests: 0.33,
		modelMetrics,
		agentMetrics: { main: {} },
		currentModel: Object.keys(models)[0],
		...(currentTokens === null ? {} : { currentTokens }),
		...extra,
	});
}

function writeSession(id: string, lines: string[]): string {
	const dir = path.join(process.env.COPILOT_HOME as string, "session-state", id);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "events.jsonl");
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

const HAIKU = "claude-haiku-4.5";

test("copilotHome honours COPILOT_HOME and defaults to ~/.copilot", () => {
	assert.equal(copilotHome(), process.env.COPILOT_HOME);
	const saved = process.env.COPILOT_HOME;
	delete process.env.COPILOT_HOME;
	try {
		assert.equal(copilotHome(), path.join(os.homedir(), ".copilot"));
	} finally {
		process.env.COPILOT_HOME = saved;
	}
});

test("cache buckets are not double counted: totalInputTokens equals Copilot's inputTokens", () => {
	const id = sessionId();
	// Real numbers: input 15704 = cacheWrite 15694 + 10 uncached.
	writeSession(id, [
		start(),
		userMsg(),
		assistant(HAIKU),
		shutdown({ [HAIKU]: { input: 15704, output: 40, cacheRead: 0, cacheWrite: 15694, requests: 1 } }, 13586),
	]);
	const u = readTokenUsage(WORKDIR, id, "copilot");
	assert.equal(u.inputTokens, 10);
	assert.equal(u.cacheCreationTokens, 15694);
	assert.equal(u.cacheReadTokens, 0);
	assert.equal(u.totalInputTokens, 15704);
	assert.equal(u.outputTokens, 40);
	assert.equal(u.turns, 1);
});

test("totals sum over models and keep cacheRead out of the uncached bucket", () => {
	const id = sessionId();
	writeSession(id, [
		start(),
		shutdown(
			{
				[HAIKU]: { input: 43356, output: 857, cacheRead: 31752, cacheWrite: 11574, requests: 4 },
				"gpt-5-mini": { input: 1000, output: 10, cacheRead: 400, cacheWrite: 0, requests: 2 },
			},
			9000,
		),
	]);
	const u = readTokenUsage(WORKDIR, id, "copilot");
	assert.equal(u.inputTokens, 30 + 600);
	assert.equal(u.cacheReadTokens, 31752 + 400);
	assert.equal(u.cacheCreationTokens, 11574);
	assert.equal(u.totalInputTokens, 43356 + 1000);
	assert.equal(u.outputTokens, 867);
	assert.equal(u.turns, 6);
	assert.equal(u.includesSubagents, true);
});

test("an inconsistent metric (cache above input) never goes negative", () => {
	const id = sessionId();
	writeSession(id, [start(), shutdown({ [HAIKU]: { input: 5, output: 1, cacheRead: 10, cacheWrite: 10, requests: 1 } }, 1)]);
	assert.equal(readTokenUsage(WORKDIR, id, "copilot").inputTokens, 0);
});

test("contextTokens is currentTokens, exact (contextEstimated false)", () => {
	const id = sessionId();
	writeSession(id, [start(), assistant(HAIKU), shutdown({ [HAIKU]: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } }, 13586)]);
	const u = readTokenUsage(WORKDIR, id, "copilot");
	assert.equal(u.contextTokens, 13586);
	assert.equal(u.contextEstimated, false);
});

test("without currentTokens the occupancy is 0", () => {
	const id = sessionId();
	writeSession(id, [start(), shutdown({ [HAIKU]: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } }, null)]);
	assert.equal(readTokenUsage(WORKDIR, id, "copilot").contextTokens, 0);
});

test("the LAST shutdown wins: metrics are cumulative, never summed across shutdowns", () => {
	const id = sessionId();
	writeSession(id, [
		start(),
		assistant(HAIKU),
		shutdown({ [HAIKU]: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 900, requests: 1 } }, 5000),
		event("session.resume", { contextTier: null }),
		assistant(HAIKU),
		shutdown({ [HAIKU]: { input: 2500, output: 30, cacheRead: 1000, cacheWrite: 900, requests: 2 } }, 7000),
	]);
	const u = readTokenUsage(WORKDIR, id, "copilot");
	assert.equal(u.totalInputTokens, 2500);
	assert.equal(u.inputTokens, 600);
	assert.equal(u.outputTokens, 30);
	assert.equal(u.turns, 2);
	assert.equal(u.contextTokens, 7000);
});

test("a session with events but no shutdown yields zero tokens but still the model", () => {
	const id = sessionId();
	writeSession(id, [start(), userMsg(), assistant("gpt-5-mini")]);
	const u = readTokenUsage(WORKDIR, id, "copilot");
	assert.equal(u.totalInputTokens, 0);
	assert.equal(u.outputTokens, 0);
	assert.equal(u.contextTokens, 0);
	assert.equal(u.turns, 0);
	assert.equal(u.model, "gpt-5-mini");
});

test("the model is the last assistant.message model; model_change is the fallback", () => {
	const a = sessionId();
	writeSession(a, [start(), modelChange("gpt-5-mini"), assistant("claude-sonnet-4.6"), assistant("gpt-5.4"), modelChange("gpt-5-mini")]);
	assert.equal(readTokenUsage(WORKDIR, a, "copilot").model, "gpt-5.4");

	const b = sessionId();
	writeSession(b, [start(), modelChange("gpt-5-mini"), userMsg(), modelChange("claude-sonnet-4.6")]);
	assert.equal(readTokenUsage(WORKDIR, b, "copilot").model, "claude-sonnet-4.6");

	const c = sessionId();
	writeSession(c, [start(), modelChange("gpt-5-mini"), assistant("")]);
	assert.equal(readTokenUsage(WORKDIR, c, "copilot").model, "gpt-5-mini", "an empty model is ignored");
});

test("a subagent's message does not name the session's model while a main-thread one exists", () => {
	const id = sessionId();
	writeSession(id, [start(), assistant("gpt-5.4"), assistant("claude-haiku-4.5", { parentToolCallId: "tool-1" })]);
	assert.equal(readTokenUsage(WORKDIR, id, "copilot").model, "gpt-5.4");
});

test("costUsd is always null", () => {
	const id = sessionId();
	writeSession(id, [start(), shutdown({ [HAIKU]: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } }, 10)]);
	assert.equal(readTokenUsage(WORKDIR, id, "copilot").costUsd, null);
});

test("usageSnapshot reports agent copilot, context_estimated false and cost_usd null", () => {
	const id = sessionId();
	writeSession(id, [
		start(),
		assistant(HAIKU),
		shutdown({ [HAIKU]: { input: 15704, output: 40, cacheRead: 0, cacheWrite: 15694, requests: 1 } }, 13586),
	]);
	const snap = usageSnapshot(readTokenUsage(WORKDIR, id, "copilot"), "copilot");
	assert.equal(snap.agent, "copilot");
	assert.equal(snap.context_estimated, false);
	assert.equal(snap.cost_usd, null);
	assert.equal(snap.input_tokens, 15704);
	assert.equal(snap.input_tokens_uncached, 10);
	assert.equal(snap.context_tokens, 13586);
	assert.equal(snap.model, HAIKU);
	assert.equal(snap.includes_subagents, true);
});

test("a missing session, or an id trying to leave session-state, reads as empty", () => {
	for (const id of ["99999999-9999-4999-8999-999999999999", "../x", ""]) {
		const u = readTokenUsage(WORKDIR, id, "copilot");
		assert.equal(u.turns, 0);
		assert.equal(u.model, null);
	}
});

test("sniffing finds a copilot session when no claude/cursor artefact matches", () => {
	const id = sessionId();
	writeSession(id, [start(), assistant(HAIKU), shutdown({ [HAIKU]: { input: 200, output: 2, cacheRead: 50, cacheWrite: 0, requests: 1 } }, 321)]);
	const u = readTokenUsage(WORKDIR, id);
	assert.equal(u.totalInputTokens, 200);
	assert.equal(u.contextTokens, 321);
	assert.equal(u.model, HAIKU);
});

test("a claude transcript with the same id still wins when sniffing", () => {
	const id = sessionId();
	writeSession(id, [start(), shutdown({ [HAIKU]: { input: 200, output: 2, cacheRead: 0, cacheWrite: 0, requests: 1 } }, 321)]);
	const slug = WORKDIR.replace(/[^a-zA-Z0-9-]/g, "-");
	const dir = path.join(os.homedir(), ".claude", "projects", slug);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${id}.jsonl`),
		`${JSON.stringify({
			type: "assistant",
			timestamp: "2026-08-19T19:30:00.000Z",
			message: { id: "c1", role: "assistant", model: "claude-opus-5", usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } },
		})}\n`,
	);
	assert.equal(readTokenUsage(WORKDIR, id).model, "claude-opus-5");
});

test("a big file: only the tail is parsed, and a changed file is re-read (cache by mtime/size)", () => {
	const id = sessionId();
	const filler = JSON.stringify({ type: "tool.execution_complete", data: { toolCallId: "t", result: "x".repeat(2000) } });
	const head = [start(), userMsg(), assistant("old-model")];
	// ~8 MB of ordinary lines, so the head is far outside the 1 MiB tail.
	const lines = [...head, ...Array.from({ length: 4000 }, () => filler)];
	lines.push(assistant(HAIKU), shutdown({ [HAIKU]: { input: 15704, output: 40, cacheRead: 0, cacheWrite: 15694, requests: 1 } }, 13586));
	const file = writeSession(id, lines);
	assert.ok(fs.statSync(file).size > 6 * 1024 * 1024);

	const realParse = JSON.parse;
	let parsed = 0;
	JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
		parsed += 1;
		return realParse(...args);
	}) as typeof JSON.parse;
	try {
		const u = readTokenUsage(WORKDIR, id, "copilot");
		assert.equal(u.totalInputTokens, 15704);
		assert.equal(u.model, HAIKU);
		assert.ok(parsed <= 3, `parsed ${parsed} lines of ${lines.length}`);

		parsed = 0;
		readTokenUsage(WORKDIR, id, "copilot");
		assert.equal(parsed, 0, "an unchanged file is served from the cache");

		fs.appendFileSync(file, `${shutdown({ [HAIKU]: { input: 20000, output: 50, cacheRead: 0, cacheWrite: 19000, requests: 2 } }, 15000)}\n`);
		assert.equal(readTokenUsage(WORKDIR, id, "copilot").totalInputTokens, 20000);
		assert.ok(parsed > 0 && parsed <= 3);
	} finally {
		JSON.parse = realParse;
	}
});

test("a shutdown older than the first tail window is still found (the read grows)", () => {
	const id = sessionId();
	const filler = JSON.stringify({ type: "tool.execution_complete", data: { result: "y".repeat(2000) } });
	const lines = [start(), shutdown({ [HAIKU]: { input: 777, output: 7, cacheRead: 0, cacheWrite: 0, requests: 1 } }, 99), ...Array.from({ length: 1500 }, () => filler)];
	writeSession(id, lines);
	const u = readTokenUsage(WORKDIR, id, "copilot");
	assert.equal(u.totalInputTokens, 777);
	assert.equal(u.contextTokens, 99);
});
