/**
 * readTokenUsage / canReadTokenUsage with an explicit harness: the harness
 * decides the reader, and a null harness keeps the old shape-sniffing.
 * Throwaway HOME/TARGET_HOME/AWB_HOME, same convention as context-occupancy.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-harness-usage-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { canReadTokenUsage, claudeProjectDir, readTokenUsage } = await import("./transcript.ts");

const WORKDIR = path.join(tmpHome, "wd");

function claudeTurn(id: string, context: number): string {
	return JSON.stringify({
		type: "assistant",
		timestamp: "2026-08-19T19:30:00.000Z",
		message: {
			id,
			role: "assistant",
			model: "claude-opus-5",
			usage: {
				input_tokens: 2,
				cache_creation_input_tokens: 100,
				cache_read_input_tokens: context - 102,
				output_tokens: 50,
			},
		},
	});
}

function writeClaudeSession(sessionId: string): void {
	const dir = claudeProjectDir(WORKDIR);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${claudeTurn("m1", 5000)}\n${claudeTurn("m2", 9000)}\n`);
}

test("harness \"claude\" on a claude transcript equals the sniffed result", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	writeClaudeSession(id);
	const sniffed = readTokenUsage(WORKDIR, id);
	assert.equal(sniffed.contextTokens, 9000);
	assert.deepEqual(readTokenUsage(WORKDIR, id, "claude"), sniffed);
});

test("harness null/undefined/unknown keeps the sniffing result unchanged", () => {
	const id = "22222222-2222-4222-8222-222222222222";
	writeClaudeSession(id);
	const sniffed = readTokenUsage(WORKDIR, id);
	assert.deepEqual(readTokenUsage(WORKDIR, id, null), sniffed);
	assert.deepEqual(readTokenUsage(WORKDIR, id, undefined), sniffed);
	assert.deepEqual(readTokenUsage(WORKDIR, id, "some-future-runner"), sniffed);
});

test("harness \"copilot\" with a session id that does not exist returns zeroed usage", () => {
	const usage = readTokenUsage(WORKDIR, "33333333-3333-4333-8333-333333333333", "copilot");
	assert.equal(usage.turns, 0);
	assert.equal(usage.contextTokens, 0);
	assert.equal(usage.totalInputTokens, 0);
	assert.equal(usage.outputTokens, 0);
	assert.equal(usage.lastCompactionAt, null);
	assert.equal(usage.costUsd, null);
});

test("an explicit harness is not overridden by the id's shape", () => {
	// A claude transcript read as copilot/cursor must not be picked up by sniffing.
	const id = "44444444-4444-4444-8444-444444444444";
	writeClaudeSession(id);
	assert.equal(readTokenUsage(WORKDIR, id, "copilot").turns, 0);
	assert.equal(readTokenUsage(WORKDIR, id, "cursor").turns, 0);
	assert.equal(readTokenUsage(WORKDIR, id, "claude").contextTokens, 9000);
});

test("harness \"free-code\" reads the .jsonl path directly", () => {
	const file = path.join(tmpHome, "fc.jsonl");
	fs.writeFileSync(file, "");
	assert.deepEqual(readTokenUsage("", file, "free-code"), readTokenUsage("", file));
});

test("canReadTokenUsage honours the harness and falls back to sniffing", () => {
	const id = "55555555-5555-4555-8555-555555555555";
	assert.equal(canReadTokenUsage(null, id), false);
	assert.equal(canReadTokenUsage(null, id, null), false);
	assert.equal(canReadTokenUsage(null, id, "claude"), false);
	assert.equal(canReadTokenUsage(WORKDIR, id, "claude"), true);
	assert.equal(canReadTokenUsage(null, id, "copilot"), true, "copilot is looked up by id, no workdir");
	assert.equal(canReadTokenUsage(null, "/x/s.jsonl", "free-code"), true);
	assert.equal(canReadTokenUsage(WORKDIR, "", "copilot"), false);
});
