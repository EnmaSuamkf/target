/**
 * Compaction boundaries for the Copilot CLI: `session.compaction_complete` in
 * `<COPILOT_HOME>/session-state/<id>/events.jsonl`.
 *
 * Lines are real-shaped (envelope `type`/`data`/`id`/`timestamp`/`parentId`; the
 * `data` keys of the spike's manual `/compact` run) without the summary body.
 * Same throwaway HOME/TARGET_HOME/AWB_HOME + real awb hook + fake broker setup
 * as compaction.test.ts, with a hook whose runner is `copilot`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-copilot-compaction-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");
process.env.COPILOT_HOME = path.join(tmpHome, "copilot");

const { createAwbHook } = await import("./awb.ts");
const { getStep, getWorkflow, insertStep, insertWorkflow, setContextInjected, setWorkflowSessionId } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { compactionBoundaryOfLine, readTokenUsage } = await import("./transcript.ts");
const { boundaryFor, needsContextReinjection, observeCompaction } = await import("./compaction.ts");
const { dispatchStep } = await import("./runner.ts");

const cfg = loadConfig();
const silent = () => {};
const dispatches: string[] = [];
const broker = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => {
		body += String(chunk);
	});
	req.on("end", () => {
		dispatches.push((JSON.parse(body) as { input: string }).input);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
const brokerAddress = broker.address();
if (!brokerAddress || typeof brokerAddress === "string") throw new Error("fake broker did not bind");
const brokerPort = brokerAddress.port;
test.after(() => broker.close());

let seq = 0;
function envelope(type: string, data: Record<string, unknown>, timestamp: string): string {
	seq += 1;
	return JSON.stringify({ type, data, id: `evt-${seq}`, timestamp, parentId: `evt-${seq - 1}` });
}

const compactionStart = (at: string, trigger = "manual"): string =>
	envelope("session.compaction_start", { systemTokens: 5075, conversationTokens: 713, toolDefinitionsTokens: 7795, currentTokens: 13916, tokenLimit: 128000, trigger }, at);

const compactionComplete = (at: string, over: Record<string, unknown> = {}): string =>
	envelope(
		"session.compaction_complete",
		{
			success: true,
			preCompactionTokens: 1045,
			postCompactionTokens: 758,
			preCompactionMessagesLength: 20,
			messagesRemoved: 19,
			tokensRemoved: 287,
			compactionTokensUsed: { input: 900, output: 120 },
			checkpointNumber: 1,
			tokenLimit: 128000,
			trigger: "manual",
			...over,
		},
		at,
	);

const filler = (): string => JSON.stringify({ type: "tool.execution_complete", data: { toolCallId: "t", result: "x".repeat(2000) } });
const turn = (at: string): string => envelope("assistant.message", { messageId: "m", model: "claude-haiku-4.5", content: "ok", toolRequests: [] }, at);

let counter = 0;
function writeSession(lines: string[]): string {
	counter += 1;
	const id = `cccccccc-0000-4000-8000-${String(counter).padStart(12, "0")}`;
	const dir = path.join(process.env.COPILOT_HOME as string, "session-state", id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
	return id;
}

const T1 = "2026-10-01T20:10:00.000Z";
const T2 = "2026-10-01T21:30:00.000Z";

test("a successful session.compaction_complete is a copilot boundary with the line timestamp and token counts", () => {
	const line = JSON.parse(compactionComplete(T1)) as Record<string, unknown>;
	const boundary = compactionBoundaryOfLine(line);
	assert.deepEqual(boundary, { at: T1, format: "copilot", trigger: "manual", preTokens: 1045, postTokens: 758 });
	const auto = compactionBoundaryOfLine(JSON.parse(compactionComplete(T2, { trigger: "threshold" })) as Record<string, unknown>);
	assert.equal(auto?.trigger, "threshold");
});

test("a failed compaction, a compaction_start and ordinary lines are not boundaries", () => {
	const failed = compactionComplete(T1, { success: false, preCompactionTokens: undefined, postCompactionTokens: undefined });
	assert.equal(compactionBoundaryOfLine(JSON.parse(failed) as Record<string, unknown>), null);
	assert.equal(compactionBoundaryOfLine(JSON.parse(compactionStart(T1)) as Record<string, unknown>), null);
	assert.equal(compactionBoundaryOfLine(JSON.parse(turn(T1)) as Record<string, unknown>), null);
	// success must be exactly true, and the record needs a timestamp to compare.
	assert.equal(compactionBoundaryOfLine({ type: "session.compaction_complete", timestamp: T1, data: { success: "true" } }), null);
	assert.equal(compactionBoundaryOfLine({ type: "session.compaction_complete", data: { success: true } }), null);
});

test("readTokenUsage (copilot) counts only successful compactions and reports the later timestamp", () => {
	const id = writeSession([
		turn("2026-10-01T20:00:00.000Z"),
		compactionStart(T1),
		compactionComplete(T1),
		turn("2026-10-01T20:20:00.000Z"),
		compactionStart(T2, "threshold"),
		compactionComplete("2026-10-01T21:00:00.000Z", { success: false }),
		compactionComplete(T2, { trigger: "threshold" }),
	]);
	const u = readTokenUsage(tmpHome, id, "copilot");
	assert.equal(u.compactions, 2);
	assert.equal(u.lastCompactionAt, T2);
});

test("a session never compacted reports none", () => {
	const id = writeSession([turn(T1), compactionStart(T1), compactionComplete(T1, { success: false })]);
	const u = readTokenUsage(tmpHome, id, "copilot");
	assert.equal(u.compactions, 0);
	assert.equal(u.lastCompactionAt, null);
});

test("the boundary survives a big file where the early compaction is far outside the tail window", () => {
	const lines = [turn(T1), compactionComplete(T1), compactionComplete(T2)];
	// ~8 MB after the compactions, so neither is inside the 1 MiB tail.
	for (let i = 0; i < 4000; i++) lines.push(filler());
	lines.push(turn("2026-10-02T08:00:00.000Z"));
	const id = writeSession(lines);
	const file = path.join(process.env.COPILOT_HOME as string, "session-state", id, "events.jsonl");
	assert.ok(fs.statSync(file).size > 6 * 1024 * 1024);
	const u = readTokenUsage(tmpHome, id, "copilot");
	assert.equal(u.compactions, 2);
	assert.equal(u.lastCompactionAt, T2);
	// Growing the file scans only the new bytes but still sees a new compaction.
	const T3 = "2026-10-02T09:00:00.000Z";
	fs.appendFileSync(file, `${compactionComplete(T3)}\n`);
	const grown = readTokenUsage(tmpHome, id, "copilot");
	assert.equal(grown.compactions, 3);
	assert.equal(grown.lastCompactionAt, T3);
	// A truncated-and-rewritten file is rescanned from the start.
	fs.writeFileSync(file, `${turn(T1)}\n`);
	assert.equal(readTokenUsage(tmpHome, id, "copilot").compactions, 0);
});

test("a compaction line quoted inside another record's text is not counted", () => {
	const quoted = envelope("assistant.message", { messageId: "q", model: "claude-haiku-4.5", content: 'the type is "session.compaction_complete" here', toolRequests: [] }, T1);
	const id = writeSession([quoted, compactionComplete(T2)]);
	assert.equal(readTokenUsage(tmpHome, id, "copilot").compactions, 1);
});

// --- recovery: the existing re-injection logic on a Copilot-shaped session ---

function makeCopilotWorkflow(sessionId: string) {
	dispatches.length = 0;
	const n = ++seq;
	const id = `cp-wf-${n}`;
	const agentName = `cp-agent-${n}`;
	const workdir = path.join(tmpHome, "sandboxes", agentName);
	const hook = createAwbHook(agentName, workdir, "{{payload}}", { runner: "copilot" });
	const file = path.join(String(process.env.AWB_HOME), "hooks.json");
	const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	config.port = brokerPort;
	fs.writeFileSync(file, JSON.stringify(config, null, 2));
	const workflow = insertWorkflow({
		id,
		name: `copilot compaction ${id}`,
		agentName,
		hookUrl: hook.hookUrl.replace(/:\d+\//, `:${brokerPort}/`),
		secret: hook.secret,
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: "Copilot background.",
	});
	const step = insertStep(id, "the step");
	setWorkflowSessionId(id, sessionId);
	setContextInjected(id, true);
	return { workflow, step: getStep(step.id)!, workdir };
}

test("boundaryFor and observeCompaction see a Copilot compaction through the hook's harness", () => {
	const id = writeSession([turn(T1), compactionComplete(T1)]);
	const { workflow, workdir } = makeCopilotWorkflow(id);
	assert.equal(boundaryFor(workdir, id, "copilot"), T1);
	const observed = observeCompaction(getWorkflow(workflow.id)!, id, silent);
	assert.equal(observed.lastCompactionAt, T1);
	assert.equal(needsContextReinjection(observed), true);
});

test("a Copilot session compacted after the last handled boundary gets its context re-injected once", async () => {
	const id = writeSession([turn(T1), compactionComplete(T1)]);
	const { workflow, step } = makeCopilotWorkflow(id);
	await dispatchStep(step, getWorkflow(workflow.id)!, cfg, silent);
	assert.equal(dispatches.length, 1);
	assert.match(dispatches[0], /Copilot background\./, "the compaction re-states the conversation context");
	assert.equal(needsContextReinjection(getWorkflow(workflow.id)!), false, "recovered from");

	await dispatchStep(getStep(step.id)!, getWorkflow(workflow.id)!, cfg, silent);
	assert.doesNotMatch(dispatches[1], /Copilot background\./, "one boundary, one re-injection");

	// A later compaction arms it again.
	const file = path.join(process.env.COPILOT_HOME as string, "session-state", id, "events.jsonl");
	fs.appendFileSync(file, `${compactionComplete(T2)}\n`);
	await dispatchStep(getStep(step.id)!, getWorkflow(workflow.id)!, cfg, silent);
	assert.match(dispatches[2], /Copilot background\./);
});
