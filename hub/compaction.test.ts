/**
 * Tests for compaction detection and recovery (transcript.ts + compaction.ts +
 * runner.ts).
 *
 * The thing that has to be true for BOTH harnesses. A workflow reuses one
 * conversation for every step; when it's compacted the earlier turns are
 * replaced by a summary, and everything the hub said once at the top of that
 * conversation — notably the workflow's conversation-context preamble, gated by
 * a once-ever `context_injected` flag — quietly stops being visible to the
 * agent. Two harnesses write two completely different records for that moment,
 * and only one of them says anything about tokens, so the detection is pinned
 * against REAL records from both (see compaction-fixtures.ts) and specifically
 * against a free-code record with every token field removed: free-code is the
 * harness compaction has actually been observed on here, and a detector that
 * needed `preTokens`/`postTokens` would be blind exactly there.
 *
 * The recovery half is the other requirement: after a detected boundary the
 * next step re-states the conversation context WITHOUT `restartWorkflow`, which
 * is the only existing way to reopen that guard and which throws away every
 * step's progress to do it.
 *
 * Same throwaway HOME/TARGET_HOME/AWB_HOME + real awb hook + fake broker setup
 * as context-pressure.test.ts, for the same reason: `hookRuntime` has to
 * resolve a real workdir or nothing can be read at all.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { CLAUDE_COMPACT_BOUNDARIES, FREE_CODE_COMPACTIONS } from "./compaction-fixtures.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-compaction-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { createAwbHook } = await import("./awb.ts");
const { getStep, getWorkflow, insertStep, insertWorkflow, setContextInjected, setWorkflowSessionId } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { claudeProjectDir, compactionBoundaryOfLine, readTokenUsage } = await import("./transcript.ts");
const { boundaryFor, needsContextReinjection, observeCompaction } = await import("./compaction.ts");
const { dispatchStep } = await import("./runner.ts");
const { restartWorkflow } = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

interface Dispatch {
	input: string;
	sessionId: string | null;
}

const dispatches: Dispatch[] = [];

/** One fake awb broker for the whole file — see context-pressure.test.ts for why it's shared. */
const broker = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => {
		body += String(chunk);
	});
	req.on("end", () => {
		const parsed = JSON.parse(body) as { input: string };
		dispatches.push({
			input: parsed.input,
			sessionId: typeof req.headers.sessionid === "string" ? req.headers.sessionid : null,
		});
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
const brokerAddress = broker.address();
if (!brokerAddress || typeof brokerAddress === "string") throw new Error("fake broker did not bind");
const brokerPort = brokerAddress.port;
test.after(() => broker.close());

function pointAwbAtBroker(): void {
	const file = path.join(String(process.env.AWB_HOME), "hooks.json");
	const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	config.port = brokerPort;
	fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/** A workflow on a real awb hook (so the workdir resolves) pointed at the fake broker. */
function makeWorkflow(options: { context?: string | null } = {}) {
	dispatches.length = 0;
	const id = `cx-wf-${++seq}`;
	const agentName = `cx-agent-${seq}`;
	const workdir = path.join(tmpHome, "sandboxes", agentName);
	const hook = createAwbHook(agentName, workdir, "{{payload}}", { runner: "claude" });
	pointAwbAtBroker();
	const workflow = insertWorkflow({
		id,
		name: `compaction ${id}`,
		agentName,
		hookUrl: hook.hookUrl.replace(/:\d+\//, `:${brokerPort}/`),
		secret: hook.secret,
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: options.context ?? "The background every step of this workflow inherits.",
	});
	const step = insertStep(id, "the step");
	return { workflow, step: getStep(step.id)!, workdir };
}

/** An ordinary assistant turn, so a transcript under test isn't only boundary records. */
function turn(id: string, tokens: number): string {
	return JSON.stringify({
		type: "assistant",
		message: {
			id,
			role: "assistant",
			model: "claude-sonnet-5",
			usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 },
		},
	});
}

/** Writes a claude-layout transcript for `sessionId` out of the given raw JSONL lines. */
function writeClaudeTranscript(workdir: string, sessionId: string, lines: string[]): void {
	const file = path.join(claudeProjectDir(workdir), `${sessionId}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/** Writes a free-code transcript: the session id IS the file's absolute path. */
function writeFreeCodeTranscript(dir: string, name: string, lines: string[]): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

// --- format detection: one reader per harness, both pinned on real records ---

test("claude's system/compact_boundary record is detected — real records, both of them", () => {
	assert.ok(CLAUDE_COMPACT_BOUNDARIES.length >= 2, "the fixtures really are real records from two sessions");
	for (const { source, record } of CLAUDE_COMPACT_BOUNDARIES) {
		const boundary = compactionBoundaryOfLine(record);
		assert.ok(boundary, `no boundary read out of ${source}`);
		assert.equal(boundary.format, "claude");
		assert.equal(boundary.at, record.timestamp);
		// claude's record DOES carry token metadata; read it when it's there.
		const meta = record.compactMetadata as Record<string, number | string>;
		assert.equal(boundary.trigger, meta.trigger);
		assert.equal(boundary.preTokens, meta.preTokens);
		assert.equal(boundary.postTokens, meta.postTokens);
	}
});

test("free-code's type:'compaction' record is detected — real records from three sessions", () => {
	assert.equal(FREE_CODE_COMPACTIONS.length, 3);
	for (const { source, record } of FREE_CODE_COMPACTIONS) {
		const boundary = compactionBoundaryOfLine(record);
		assert.ok(boundary, `no boundary read out of ${source}`);
		assert.equal(boundary.format, "free-code");
		assert.equal(boundary.at, record.timestamp);
		// The format says nothing about a trigger and nothing about the window
		// afterwards — the record is a summary and a parent pointer, no more.
		assert.equal(boundary.trigger, null);
		assert.equal(boundary.postTokens, null);
	}
});

test("a free-code record with NO token metadata at all is still detected", () => {
	// The requirement stated plainly: strip every numeric field the record could
	// possibly be keyed off and the boundary must still be found, from its
	// presence and its timestamp alone.
	const { record } = FREE_CODE_COMPACTIONS[0];
	const stripped: Record<string, unknown> = {
		type: record.type,
		id: record.id,
		parentId: record.parentId,
		timestamp: record.timestamp,
		summary: record.summary,
	};
	const boundary = compactionBoundaryOfLine(stripped);
	assert.ok(boundary, "detection must not depend on preTokens/postTokens/tokensBefore");
	assert.equal(boundary.at, record.timestamp);
	assert.equal(boundary.preTokens, null);
	assert.equal(boundary.postTokens, null);
});

test("ordinary transcript lines are not boundaries", () => {
	assert.equal(compactionBoundaryOfLine(JSON.parse(turn("msg-1", 100)) as Record<string, unknown>), null);
	// A system line that isn't a compact_boundary, and a compaction-shaped record
	// with no timestamp (nothing to compare against a dispatch) are both rejected.
	assert.equal(compactionBoundaryOfLine({ type: "system", subtype: "hook_result", timestamp: "2026-01-01T00:00:00Z" }), null);
	assert.equal(compactionBoundaryOfLine({ type: "compaction", id: "x", summary: "…" }), null);
});

// --- reading it off a whole transcript, per layout ---

test("readTokenUsage reports the LAST boundary of a claude transcript, and counts them", () => {
	const { workdir } = makeWorkflow();
	const [first, second] = CLAUDE_COMPACT_BOUNDARIES;
	writeClaudeTranscript(workdir, "sess-claude", [
		turn("msg-1", 1000),
		JSON.stringify(first.record),
		turn("msg-2", 2000),
		JSON.stringify(second.record),
		turn("msg-3", 3000),
	]);
	const usage = readTokenUsage(workdir, "sess-claude");
	assert.equal(usage.compactions, 2);
	assert.equal(usage.lastCompactionAt, second.record.timestamp, "the newest boundary is the one that matters");
	assert.equal(usage.contextTokens, 3000, "usage accounting is unaffected by the boundary lines");
});

test("readTokenUsage reads a free-code transcript, whose session id IS its path", () => {
	const dir = path.join(tmpHome, ".agent-webhook-bridge", "sessions", "fc-hook");
	const record = FREE_CODE_COMPACTIONS[2].record;
	const file = writeFreeCodeTranscript(dir, "1785503338850-session.jsonl", [
		JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "claude-fable-5" }),
		JSON.stringify({ message: { role: "assistant", usage: { input: 500, cacheRead: 100, cacheWrite: 0, output: 20 } } }),
		JSON.stringify(record),
	]);
	// No workdir convention applies here — the path is the id.
	const usage = readTokenUsage("/nowhere", file);
	assert.equal(usage.compactions, 1);
	assert.equal(usage.lastCompactionAt, record.timestamp);
	assert.equal(usage.model, "claude-fable-5", "the model comes from the model_change record, not a message");
});

test("a transcript with no boundary reports none, and an unreadable one is not an error", () => {
	const { workdir } = makeWorkflow();
	writeClaudeTranscript(workdir, "sess-clean", [turn("msg-1", 10)]);
	assert.equal(readTokenUsage(workdir, "sess-clean").lastCompactionAt, null);
	assert.equal(boundaryFor(workdir, "sess-missing"), null);
	assert.equal(boundaryFor(null, "sess-clean"), null, "a remote hook has no workdir to look in");
	assert.equal(boundaryFor(workdir, null), null, "and a fresh conversation has no session");
});

// --- persistence ---

test("observeCompaction persists the boundary, once, and re-observing is a no-op", () => {
	const { workflow, workdir } = makeWorkflow();
	const record = CLAUDE_COMPACT_BOUNDARIES[0].record;
	writeClaudeTranscript(workdir, "sess-obs", [turn("msg-1", 10), JSON.stringify(record)]);

	assert.equal(workflow.lastCompactionAt, null, "nothing observed yet");
	const logged: string[] = [];
	const observed = observeCompaction(workflow, "sess-obs", (m) => logged.push(m));
	assert.equal(observed.lastCompactionAt, record.timestamp);
	assert.equal(getWorkflow(workflow.id)?.lastCompactionAt, record.timestamp, "and it is persisted");
	assert.equal(logged.length, 1, "an operator is told");
	assert.match(logged[0], /compacted/);

	// The UI polls the route that calls this every couple of seconds; the same
	// boundary must not produce a log line (or a write) every time.
	observeCompaction(observed, "sess-obs", (m) => logged.push(m));
	assert.equal(logged.length, 1, "the second look at the same boundary says nothing");
});

test("an older boundary never walks the marker backwards", () => {
	const { workflow, workdir } = makeWorkflow();
	const [older, newer] = [...CLAUDE_COMPACT_BOUNDARIES].sort((a, b) =>
		String(a.record.timestamp) < String(b.record.timestamp) ? -1 : 1,
	);
	writeClaudeTranscript(workdir, "sess-new", [JSON.stringify(newer.record)]);
	writeClaudeTranscript(workdir, "sess-old", [JSON.stringify(older.record)]);

	const after = observeCompaction(workflow, "sess-new", silent);
	assert.equal(after.lastCompactionAt, newer.record.timestamp);
	observeCompaction(after, "sess-old", silent);
	assert.equal(getWorkflow(workflow.id)?.lastCompactionAt, newer.record.timestamp);
});

// --- recovery: the conversation context is re-injected, without a restart ---

test("a detected boundary re-injects the conversation context on the next step — no restartWorkflow", async () => {
	const { workflow, step, workdir } = makeWorkflow({ context: "Ship the thing. Never touch prod." });
	// The state a mid-workflow step is really in: a session is chained and the
	// once-ever context guard was closed by the first step's callback. Before
	// this feature that combination meant the preamble could never be sent again
	// short of a restart, which resets every step.
	setWorkflowSessionId(workflow.id, "sess-live");
	setContextInjected(workflow.id, true);
	writeClaudeTranscript(workdir, "sess-live", [
		turn("msg-1", 5000),
		JSON.stringify(CLAUDE_COMPACT_BOUNDARIES[0].record),
		turn("msg-2", 900),
	]);

	const logged: string[] = [];
	await dispatchStep(step, getWorkflow(workflow.id)!, cfg, (m) => logged.push(m));

	assert.equal(dispatches.length, 1);
	assert.equal(dispatches[0].sessionId, "sess-live", "still the same conversation — the session id survives a compaction");
	assert.match(dispatches[0].input, /Ship the thing\. Never touch prod\./, "the background is restated");
	assert.match(dispatches[0].input, /This conversation was compacted/, "and it says why it is being restated");
	assert.ok(
		logged.some((m) => /re-injecting the workflow's conversation context/.test(m)),
		"and the operator can see it happened",
	);
	// Still true afterwards: nothing about the workflow's progress was discarded.
	assert.equal(getWorkflow(workflow.id)?.contextInjected, true);
	assert.equal(getStep(step.id)?.status, "queued");
});

test("the re-injection happens once per boundary, and a SECOND compaction arms it again", async () => {
	const { workflow, step, workdir } = makeWorkflow({ context: "Background B." });
	setWorkflowSessionId(workflow.id, "sess-twice");
	setContextInjected(workflow.id, true);
	const [first, second] = CLAUDE_COMPACT_BOUNDARIES;
	writeClaudeTranscript(workdir, "sess-twice", [turn("msg-1", 100), JSON.stringify(first.record)]);

	await dispatchStep(step, getWorkflow(workflow.id)!, cfg, silent);
	assert.match(dispatches[0].input, /Background B\./);
	assert.equal(needsContextReinjection(getWorkflow(workflow.id)!), false, "recovered from");

	// A second step on the same, still-compacted-once conversation: nothing new
	// happened, so nothing is restated.
	await dispatchStep(getStep(step.id)!, getWorkflow(workflow.id)!, cfg, silent);
	assert.equal(dispatches.length, 2);
	assert.doesNotMatch(dispatches[1].input, /Background B\./, "one boundary, one re-injection");

	// Now it gets compacted again.
	writeClaudeTranscript(workdir, "sess-twice", [
		turn("msg-1", 100),
		JSON.stringify(first.record),
		turn("msg-2", 100),
		JSON.stringify(second.record),
	]);
	await dispatchStep(getStep(step.id)!, getWorkflow(workflow.id)!, cfg, silent);
	assert.equal(dispatches.length, 3);
	assert.match(dispatches[2].input, /Background B\./, "a new boundary is a new loss of history");
});

test("a conversation that was never compacted is dispatched exactly as before", async () => {
	const { workflow, step, workdir } = makeWorkflow({ context: "Background C." });
	setWorkflowSessionId(workflow.id, "sess-quiet");
	setContextInjected(workflow.id, true);
	writeClaudeTranscript(workdir, "sess-quiet", [turn("msg-1", 100), turn("msg-2", 200)]);

	await dispatchStep(step, getWorkflow(workflow.id)!, cfg, silent);

	assert.doesNotMatch(dispatches[0].input, /Background C\./, "no boundary, no preamble");
	assert.doesNotMatch(dispatches[0].input, /This conversation was compacted/);
	assert.equal(getWorkflow(workflow.id)?.lastCompactionAt, null);
});

test("the judge pass is never given the re-injected preamble", async () => {
	const { workflow, step, workdir } = makeWorkflow({ context: "Background D." });
	setWorkflowSessionId(workflow.id, "sess-judge");
	setContextInjected(workflow.id, true);
	writeClaudeTranscript(workdir, "sess-judge", [turn("msg-1", 100), JSON.stringify(CLAUDE_COMPACT_BOUNDARIES[1].record)]);

	await dispatchStep(step, getWorkflow(workflow.id)!, cfg, silent, { mode: "judge" });

	// A verdict prompt is one graded turn on the session it was just handed;
	// prefixing the workflow's background to it is noise, and the boundary is
	// still there for the next exec dispatch to act on.
	assert.doesNotMatch(dispatches[0].input, /Background D\./);
	assert.equal(getWorkflow(workflow.id)?.lastCompactionAt, null, "the judge doesn't even look");
});

test("a restart forgets the compaction — it abandons the conversation it happened in", async () => {
	const { workflow, step, workdir } = makeWorkflow({ context: "Background E." });
	setWorkflowSessionId(workflow.id, "sess-restart");
	writeClaudeTranscript(workdir, "sess-restart", [JSON.stringify(CLAUDE_COMPACT_BOUNDARIES[0].record)]);
	observeCompaction(getWorkflow(workflow.id)!, "sess-restart", silent);
	assert.ok(getWorkflow(workflow.id)?.lastCompactionAt);

	await restartWorkflow(workflow.id, cfg, silent, [step.id]);

	const restarted = getWorkflow(workflow.id)!;
	assert.equal(restarted.lastCompactionAt, null);
	assert.equal(needsContextReinjection(restarted), false);
	// The restart's own first dispatch injects the context because it is a fresh
	// conversation, not because of a compaction — so it carries no "was compacted"
	// explanation.
	assert.match(dispatches[0].input, /Background E\./);
	assert.doesNotMatch(dispatches[0].input, /This conversation was compacted/);
});
