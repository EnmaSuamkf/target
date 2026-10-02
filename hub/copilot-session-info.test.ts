/**
 * The two read paths that surface Copilot usage to a person: the Conversation
 * panel's `GET /api/workflows/:id/session-info` and the `node hub/tokens.ts <id>`
 * CLI. Throwaway HOME / TARGET_HOME / AWB_HOME / COPILOT_HOME; real-shaped events
 * without the reasoning blobs.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-copilot-info-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");
const copilotDir = path.join(tmpHome, "copilot");
process.env.COPILOT_HOME = copilotDir;

const { createAwbHook } = await import("./awb.ts");
const { insertWorkflow, setWorkflowSessionId } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const SESSION = "dddddddd-0000-4000-8000-000000000001";
const COMPACTED_AT = "2026-10-01T20:39:08.162Z";
const lines = [
	{ type: "session.start", data: { sessionId: SESSION, selectedModel: "claude-haiku-4.5", contextTier: null } },
	{ type: "assistant.message", data: { messageId: "m", model: "claude-haiku-4.5", content: "ok", toolRequests: [] } },
	{ type: "session.compaction_complete", timestamp: COMPACTED_AT, data: { success: true, preCompactionTokens: 1045, postCompactionTokens: 758, trigger: "manual" } },
	{
		type: "session.shutdown",
		data: {
			modelMetrics: { "claude-haiku-4.5": { requests: { count: 3, cost: 0.33 }, usage: { inputTokens: 49265, outputTokens: 515, cacheReadTokens: 30000, cacheWriteTokens: 19000, reasoningTokens: 0 } } },
			agentMetrics: { main: {} },
			currentModel: "claude-haiku-4.5",
			currentTokens: 13446,
		},
	},
];
fs.mkdirSync(path.join(copilotDir, "session-state", SESSION), { recursive: true });
fs.writeFileSync(path.join(copilotDir, "session-state", SESSION, "events.jsonl"), `${lines.map((l, i) => JSON.stringify({ ...l, id: `e${i}`, timestamp: (l as { timestamp?: string }).timestamp ?? "2026-10-01T20:00:00.000Z" })).join("\n")}\n`);

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
test.after(() => server.close());

test("session-info for a copilot workflow reports harness copilot with exact usage and the compaction", async () => {
	const agentName = "copilot-info-agent";
	const hook = createAwbHook(agentName, path.join(tmpHome, "sandboxes", agentName), "{{payload}}", { runner: "copilot" });
	const workflow = insertWorkflow({
		id: "cp-info-1",
		name: "copilot info",
		agentName,
		hookUrl: hook.hookUrl,
		secret: hook.secret,
		mdPath: path.join(tmpHome, "cp-info-1.md"),
	});
	setWorkflowSessionId(workflow.id, SESSION);
	const res = await fetch(`http://127.0.0.1:${address.port}/api/workflows/${workflow.id}/session-info`, {
		headers: { authorization: `Bearer ${cfg.adminToken}` },
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		sessionId: string;
		harness: string;
		usage: { contextTokens: number; contextEstimated: boolean; contextWindow: number; model: string; totalInputTokens: number; compactions: number; costUsd: null };
		lastCompactionAt: string | null;
		compactionPending: boolean;
	};
	assert.equal(body.harness, "copilot");
	assert.equal(body.sessionId, SESSION);
	assert.equal(body.usage.contextTokens, 13446);
	assert.equal(body.usage.contextEstimated, false);
	assert.equal(body.usage.contextWindow, 128_000);
	assert.equal(body.usage.model, "claude-haiku-4.5");
	assert.equal(body.usage.totalInputTokens, 49265);
	assert.equal(body.usage.compactions, 1);
	assert.equal(body.usage.costUsd, null);
	assert.equal(body.lastCompactionAt, COMPACTED_AT);
	assert.equal(body.compactionPending, true);
});

test("node hub/tokens.ts <copilot session id> prints exact numbers, without the ≈ marker", () => {
	const out = execFileSync(process.execPath, [path.join(import.meta.dirname, "tokens.ts"), SESSION], {
		env: { ...process.env },
		encoding: "utf8",
	});
	assert.match(out, /13,446 \/ 128,000 tokens {2}\(10\.5%\)/);
	assert.match(out, /input total: {5}49,265/);
	assert.match(out, /input \(new\): {5}265/);
	assert.doesNotMatch(out, /≈|estimated/);
});

test("the CLI reports an unknown copilot id as missing rather than printing zeros", () => {
	assert.throws(() => execFileSync(process.execPath, [path.join(import.meta.dirname, "tokens.ts"), "eeeeeeee-0000-4000-8000-000000000000"], { env: { ...process.env }, encoding: "utf8", stdio: "pipe" }));
});
