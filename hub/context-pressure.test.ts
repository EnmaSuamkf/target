/**
 * Tests for the context-pressure override (context-pressure.ts + runner.ts):
 * once the shared session is more than 60% full, a step is delegated to a
 * subagent even when its own "Use subagent" toggle says inline.
 *
 * The condition is the whole feature, so this file is mostly about WHERE it is
 * evaluated and WHEN it fires:
 *
 *  - it reads the session THIS dispatch resumes, not some other one, and not
 *    the workflow's stale `lastSessionId` when a judge pass resumes the step's
 *    own session;
 *  - it is strictly greater than 60% — exactly 60.0% is not pressure;
 *  - it is one-way: it can turn delegation ON for an inline step and can never
 *    turn it off for a delegated one;
 *  - it never fires on a fresh conversation (no session = no context to crowd)
 *    or when occupancy simply can't be measured, so an unreadable transcript
 *    quietly keeps the operator's choice instead of overriding it;
 *  - and the overridden step is told to delegate AND told why, instead of
 *    receiving the inline instruction it was configured with.
 *
 * Throwaway HOME/TARGET_HOME/AWB_HOME as in progress.test.ts — `os.homedir()`
 * reads $HOME on POSIX, which is what lets the fake transcripts live somewhere
 * other than the operator's real ~/.claude tree. The hooks are real awb hooks
 * so `hookRuntime` resolves a workdir exactly as it does in production; that
 * resolution is half of what's under test, since a workflow whose workdir can't
 * be resolved must never be overridden.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-context-pressure-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { createAwbHook } = await import("./awb.ts");
const { getStep, getWorkflow, insertStep, insertWorkflow, markStepJudging, markStepRunning, setWorkflowSessionId, updateStepConfig } =
	await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { claudeProjectDir } = await import("./transcript.ts");
// The window is derived from the transcript's model now (models.ts). These
// fixtures name no model on purpose, so they measure against the documented
// fallback — the ratios under test are about the 60% rule, not the window.
const { FALLBACK_CONTEXT_WINDOW_TOKENS } = await import("./models.ts");
const { CONTEXT_PRESSURE_RATIO, isContextPressured, sessionContextRatio, shouldForceSubagent, workflowContextRatio } =
	await import("./context-pressure.ts");
const { CONTEXT_PRESSURE_SUFFIX, INLINE_SUFFIX, SUBAGENT_SUFFIX, composeStepInput, dispatchStep, subagentInstruction } =
	await import("./runner.ts");
// Every exec prompt names the on-disk copies of the prior steps' results
// (step-results.ts); the byte-for-byte assertion below spells it out.
const { stepResultsNote } = await import("./step-results.ts");
const { hookRuntime } = await import("./awb.ts");

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

interface Dispatch {
	input: string;
	sessionId: string | null;
}

/** Every dispatch this file's fake broker received, newest last. Cleared per workflow. */
const dispatches: Dispatch[] = [];

/**
 * One fake awb broker for the whole file: it accepts every dispatch and records
 * the turn it was handed. Sharing it matters — `hookRuntime` only resolves a
 * hook whose URL is on the port awb's config says the broker listens on, so the
 * config below is pointed at this one server rather than at a port per test.
 */
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

/**
 * Points awb's config at the fake broker's port. `createAwbHook` rewrites
 * hooks.json (and the default port with it), so this runs after every hook
 * registration — without it `inspectLocalHook` reads the hook URL as remote,
 * `hookRuntime` returns a null workdir, and the whole override silently can't
 * measure anything. Which is precisely the case one of the tests below pins.
 */
function pointAwbAtBroker(): void {
	const file = path.join(String(process.env.AWB_HOME), "hooks.json");
	const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	config.port = brokerPort;
	fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/**
 * A workflow backed by a REAL awb hook registered under AWB_HOME, so
 * `hookRuntime` resolves its workdir exactly as in production, pointed at the
 * fake broker so the dispatch is captured. Resets `dispatches`, which therefore
 * always holds just the turns this workflow sent.
 */
function makeWorkflow(options: { useSubagent?: boolean } = {}) {
	dispatches.length = 0;
	const id = `cp-wf-${++seq}`;
	const agentName = `cp-agent-${seq}`;
	const workdir = path.join(tmpHome, "sandboxes", agentName);
	const hook = createAwbHook(agentName, workdir, "{{payload}}", { runner: "claude" });
	pointAwbAtBroker();
	const workflow = insertWorkflow({
		id,
		name: `pressure ${id}`,
		agentName,
		hookUrl: hook.hookUrl.replace(/:\d+\//, `:${brokerPort}/`),
		secret: hook.secret,
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	const step = insertStep(id, "the step", options);
	return { workflow, step: getStep(step.id)!, workdir, dispatches };
}

/**
 * Writes a transcript for `sessionId` whose LAST assistant turn occupies
 * `ratio` of the context window — that last turn is exactly what
 * `readTokenUsage` reports as `contextTokens`. An earlier, much larger turn is
 * written first so a test can't pass by summing turns instead of reading the
 * latest one.
 */
function writeTranscript(workdir: string, sessionId: string, ratio: number): void {
	const file = path.join(claudeProjectDir(workdir), `${sessionId}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const turn = (id: string, tokens: number) =>
		JSON.stringify({
			type: "assistant",
			message: { id, role: "assistant", usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 } },
		});
	const lines = [
		turn("msg-early", FALLBACK_CONTEXT_WINDOW_TOKENS),
		turn("msg-last", Math.round(ratio * FALLBACK_CONTEXT_WINDOW_TOKENS)),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/** The workflow as `dispatchStep` will see it, after a session has been attached to it. */
function withSession(workflowId: string, sessionId: string) {
	setWorkflowSessionId(workflowId, sessionId);
	return getWorkflow(workflowId)!;
}

// --- the condition itself -------------------------------------------------

test("the threshold is 60% and the comparison is strictly greater", () => {
	// Exactly at the line is NOT pressure: the rule is "over 60%".
	assert.equal(CONTEXT_PRESSURE_RATIO, 0.6);
	assert.equal(isContextPressured(0.6), false);
	assert.equal(isContextPressured(0.600001), true);
	assert.equal(isContextPressured(0.59), false);
	assert.equal(isContextPressured(0.99), true);
	// Unmeasurable occupancy is never pressure.
	assert.equal(isContextPressured(null), false);
});

test("the override is one-way: it can only turn delegation ON", () => {
	// Inline step, crowded session → forced to delegate.
	assert.equal(shouldForceSubagent(false, 0.75), true);
	// Inline step, roomy session → the operator's choice stands.
	assert.equal(shouldForceSubagent(false, 0.5), false);
	// Already delegating: there is nothing to override, at any occupancy.
	assert.equal(shouldForceSubagent(true, 0.99), false);
	assert.equal(shouldForceSubagent(true, 0.1), false);
	// Unknown occupancy never overrides.
	assert.equal(shouldForceSubagent(false, null), false);
});

test("occupancy is read from the session's last turn, and is unknown without a session or workdir", async () => {
	const { workflow, workdir } = makeWorkflow();
	writeTranscript(workdir, "sess-ratio", 0.72);

	assert.equal(sessionContextRatio(workdir, "sess-ratio"), 0.72);
	// Not the sum of every turn (the earlier turn alone was a full window).
	assert.ok((sessionContextRatio(workdir, "sess-ratio") ?? 0) < 1);
	// Unknown, not zero, when there's nothing to measure.
	assert.equal(sessionContextRatio(workdir, null), null);
	assert.equal(sessionContextRatio(null, "sess-ratio"), null);
	assert.equal(sessionContextRatio(workdir, "no-such-session"), null);
	// And through the workflow's own hook, which is how dispatch resolves it.
	assert.equal(workflowContextRatio(workflow, "sess-ratio"), 0.72);
	assert.equal(workflowContextRatio(workflow, null), null);
});

test("subagentInstruction returns the override text only for a forced inline step", () => {
	assert.equal(subagentInstruction(true), SUBAGENT_SUFFIX);
	assert.equal(subagentInstruction(false), INLINE_SUFFIX);
	assert.equal(subagentInstruction(false, true), CONTEXT_PRESSURE_SUFFIX);
	// `forced` is meaningless for a step that already delegates.
	assert.equal(subagentInstruction(true, true), SUBAGENT_SUFFIX);
});

test("the override instruction tells the agent to delegate, and why", () => {
	assert.match(CONTEXT_PRESSURE_SUFFIX, /delegating the work to a subagent \(the Task tool\)/);
	assert.match(CONTEXT_PRESSURE_SUFFIX, /more than 60% full/);
	// It replaces the inline instruction — the agent must not be handed both a
	// "run this yourself" and a "delegate this" in the same turn.
	assert.ok(!CONTEXT_PRESSURE_SUFFIX.includes(INLINE_SUFFIX.trim()));
	assert.ok(!CONTEXT_PRESSURE_SUFFIX.includes("do NOT delegate"));
});

// --- where the condition sits in the dispatch path -------------------------

test("an inline step on a session over 60% is dispatched with the delegation override", async () => {
	const { workflow, step, workdir, dispatches } = makeWorkflow({ useSubagent: false });
	writeTranscript(workdir, "sess-hot", 0.85);

	await dispatchStep(step, withSession(workflow.id, "sess-hot"), cfg, silent);

	assert.equal(dispatches.length, 1);
	assert.equal(dispatches[0].sessionId, "sess-hot", "it resumed the crowded session");
	assert.ok(dispatches[0].input.includes(CONTEXT_PRESSURE_SUFFIX), "the override instruction is there");
	assert.ok(!dispatches[0].input.includes(INLINE_SUFFIX), "and the inline instruction it was configured with is gone");
});

test("the same inline step on a session under 60% keeps running inline", async () => {
	const { workflow, step, workdir, dispatches } = makeWorkflow({ useSubagent: false });
	writeTranscript(workdir, "sess-cool", 0.42);

	await dispatchStep(step, withSession(workflow.id, "sess-cool"), cfg, silent);

	assert.equal(dispatches[0].sessionId, "sess-cool");
	assert.ok(dispatches[0].input.includes(INLINE_SUFFIX), "the operator's choice stands");
	assert.ok(!dispatches[0].input.includes(CONTEXT_PRESSURE_SUFFIX));
});

test("exactly 60.0% does not trip the override", async () => {
	const { workflow, step, workdir, dispatches } = makeWorkflow({ useSubagent: false });
	writeTranscript(workdir, "sess-edge", 0.6);

	const wf = withSession(workflow.id, "sess-edge");
	assert.equal(workflowContextRatio(wf, "sess-edge"), 0.6, "the fixture really sits on the boundary");
	await dispatchStep(step, wf, cfg, silent);

	assert.ok(dispatches[0].input.includes(INLINE_SUFFIX), "the boundary belongs to the operator's choice");
	assert.ok(!dispatches[0].input.includes(CONTEXT_PRESSURE_SUFFIX));
});

test("a delegated step is dispatched identically whether or not the session is crowded", async () => {
	const { workflow, step, workdir, dispatches } = makeWorkflow({ useSubagent: true });
	writeTranscript(workdir, "sess-full", 0.97);

	await dispatchStep(step, withSession(workflow.id, "sess-full"), cfg, silent);

	assert.ok(!dispatches[0].input.includes(CONTEXT_PRESSURE_SUFFIX), "no need to explain an override that didn't happen");
	const priorResults = stepResultsNote(hookRuntime(getWorkflow(workflow.id)!.hookUrl).workdir);
	assert.equal(
		dispatches[0].input,
		`the step${priorResults}${SUBAGENT_SUFFIX}`,
		"byte-identical to a step dispatched on an empty session",
	);
});

test("a fresh conversation is never pressured — the first step honours its toggle", async () => {
	const { workflow, step, workdir, dispatches } = makeWorkflow({ useSubagent: false });
	// A crowded transcript exists, but it belongs to a session this workflow has
	// not adopted: with no `lastSessionId` the dispatch starts fresh, and a thread
	// that doesn't exist yet cannot be crowded.
	writeTranscript(workdir, "someone-elses-session", 0.9);

	await dispatchStep(step, getWorkflow(workflow.id)!, cfg, silent);

	assert.equal(dispatches[0].sessionId, null, "fresh session");
	assert.ok(dispatches[0].input.includes(INLINE_SUFFIX));
	assert.ok(!dispatches[0].input.includes(CONTEXT_PRESSURE_SUFFIX));
});

test("a session with no readable transcript is not treated as pressure", async () => {
	const { workflow, step, dispatches } = makeWorkflow({ useSubagent: false });
	// Session id set, but nothing was ever written for it.
	await dispatchStep(step, withSession(workflow.id, "sess-missing-transcript"), cfg, silent);

	assert.ok(dispatches[0].input.includes(INLINE_SUFFIX), "unmeasurable ≠ crowded");
	assert.ok(!dispatches[0].input.includes(CONTEXT_PRESSURE_SUFFIX));
});

test("resuming with `resumeSession: false` measures nothing, since the run starts fresh", async () => {
	const { workflow, step, workdir, dispatches } = makeWorkflow({ useSubagent: false });
	writeTranscript(workdir, "sess-hot-2", 0.88);

	// The caller forced a brand-new session: the crowded one is not the thread
	// this step lands on, so it must not decide anything about it.
	await dispatchStep(step, withSession(workflow.id, "sess-hot-2"), cfg, silent, { resumeSession: false });

	assert.equal(dispatches[0].sessionId, null);
	assert.ok(dispatches[0].input.includes(INLINE_SUFFIX));
	assert.ok(!dispatches[0].input.includes(CONTEXT_PRESSURE_SUFFIX));
});

test("the judge measures the step's OWN session, not the workflow's newer one", async () => {
	const { workflow, step, workdir, dispatches } = makeWorkflow({ useSubagent: false });
	// The step is being judged on the session it ran in — which is crowded — while
	// the workflow has since moved on to a roomy one. The judge resumes the
	// former, so that's the occupancy the condition has to read.
	writeTranscript(workdir, "sess-step-own", 0.9);
	writeTranscript(workdir, "sess-workflow-newer", 0.1);

	await dispatchStep(judgeableStep(step.id, "sess-step-own"), withSession(workflow.id, "sess-workflow-newer"), cfg, silent, {
		mode: "judge",
	});

	assert.equal(dispatches[0].sessionId, "sess-step-own");
	assert.match(dispatches[0].input, /The step's work was done by a subagent/, "read the crowded session the step really ran in");
});

// --- the judge pass --------------------------------------------------------

/** An inline step with a criterion, already parked in its judge phase on `sessionId`. */
function judgeableStep(stepId: string, sessionId: string) {
	updateStepConfig(stepId, {
		acceptanceCriteria: "must be X",
		manualReview: false,
		useSubagent: false,
		maxRetries: 0,
		retryIntervalSeconds: 0,
	});
	markStepRunning(stepId);
	markStepJudging(stepId, { result: "done", sessionId });
	return getStep(stepId)!;
}

test("the judge of an overridden step is told the work went to a subagent", async () => {
	const { workflow, step, workdir, dispatches } = makeWorkflow({ useSubagent: false });
	writeTranscript(workdir, "sess-judge", 0.8);

	await dispatchStep(judgeableStep(step.id, "sess-judge"), withSession(workflow.id, "sess-judge"), cfg, silent, { mode: "judge" });

	// The exec pass really ran in a subagent, so "distrust your own narration"
	// would point the judge at a thread that never held the work.
	assert.match(dispatches[0].input, /The step's work was done by a subagent/);
	// And the judge itself still answers on this thread — no instruction to delegate.
	assert.ok(!dispatches[0].input.includes(CONTEXT_PRESSURE_SUFFIX));
	assert.ok(!dispatches[0].input.includes(SUBAGENT_SUFFIX));
	assert.ok(!dispatches[0].input.includes(INLINE_SUFFIX));
});

test("the judge of an inline step on a roomy session still blames the thread's own narration", async () => {
	const { workflow, step, workdir, dispatches } = makeWorkflow({ useSubagent: false });
	writeTranscript(workdir, "sess-judge-cool", 0.3);

	await dispatchStep(judgeableStep(step.id, "sess-judge-cool"), withSession(workflow.id, "sess-judge-cool"), cfg, silent, {
		mode: "judge",
	});

	assert.match(dispatches[0].input, /do NOT trust your memory or what you said while doing the step/);
	assert.ok(!dispatches[0].input.includes("subagent"));
});

// --- composeStepInput, the dry-run view ------------------------------------

test("composeStepInput honours forceSubagent without any of the dispatch machinery", async () => {
	const { workflow, step } = makeWorkflow({ useSubagent: false });
	const forced = composeStepInput(step, workflow, { forceSubagent: true });
	const notForced = composeStepInput(step, workflow, { forceSubagent: false });
	const omitted = composeStepInput(step, workflow, {});

	assert.ok(forced.includes(CONTEXT_PRESSURE_SUFFIX));
	assert.ok(notForced.includes(INLINE_SUFFIX));
	// Omitted means "no override", so a caller that never heard of the flag gets
	// exactly what it got before the feature existed.
	assert.equal(omitted, notForced);
});
