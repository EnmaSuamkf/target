/**
 * Tests for the conversation context as its OWN step.
 *
 * The workflow-level "Conversation context" used to be delivered by prepending
 * it to whatever step happened to be dispatched first, so the background and
 * that step's task arrived as one indivisible instruction. It is now delivered
 * as its own hub-owned step (`kind: "context"`) pinned at `order_index = -1`,
 * dispatched before every other step of the run, on the same shared session.
 *
 * `hub/context.test.ts` still owns the ACCEPTANCE criteria of the feature
 * (injected before all, exactly once, never re-injected, locked once injected).
 * This file owns the step itself, and it is deliberately weighted towards the
 * failures that are SILENT — the ones where the workflow runs perfectly and the
 * background is quietly missing:
 *
 *  - the step being deselected by an explicit Start selection and skipped;
 *  - a restart resetting the once-only guard but leaving the step `done`;
 *  - the step being counted as work in the progress bar and the completion DM;
 *  - the step being delegated to a subagent that then exits, taking the
 *    background with it;
 *  - the legacy prepend firing as well, so the agent is told the same thing
 *    twice in two consecutive turns.
 *
 * Same throwaway HOME/TARGET_HOME/AWB_HOME + real-awb-hook convention as the
 * other dispatch suites: `hookRuntime` has to resolve a real workdir, since one
 * of the guarantees under test is about the files written into it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-context-step-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { createAwbHook } = await import("./awb.ts");
const {
	CONTEXT_STEP_ORDER_INDEX,
	getContextStep,
	getStep,
	getWorkflow,
	insertStep,
	insertWorkflow,
	listSteps,
	setContextInjected,
	setStepSelection,
	stepProgress,
} = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const {
	CONTEXT_PRESSURE_SUFFIX,
	CONTEXT_STEP_SUFFIX,
	INLINE_SUFFIX,
	SUBAGENT_SUFFIX,
	composeStepInput,
} = await import("./runner.ts");
const { stepResultsDir } = await import("./step-results.ts");
const {
	addStep,
	editStep,
	onStepResult,
	pauseWorkflow,
	reconcileContextStep,
	removeStep,
	restartWorkflow,
	resumeWorkflow,
	runStep,
	setConversationContext,
	startWorkflow,
	forceStepStatus,
} = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

/** Every dispatch the fake broker received, in order, newest last. Cleared per workflow. */
const inputs: string[] = [];

/**
 * ONE fake awb broker for the whole file, recording every dispatched input and
 * answering `{ok:true}` like the real one. What the agent would receive is
 * exactly what lands in `inputs`, which is what most of this file asserts on.
 *
 * Shared rather than one server per test because `inspectLocalHook` only reads a
 * hook URL as local when its port is the port awb's config names — so there is
 * exactly one port a hook can be reachable on and still resolve, and the config
 * below is pointed at this server. A per-test port would dispatch fine and then
 * silently report `workdir: null`, which is the difference between this suite
 * measuring the on-disk step results and not.
 */
const broker = http.createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		inputs.push(String(body.input ?? ""));
	});
});
await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
const brokerAddress = broker.address();
if (!brokerAddress || typeof brokerAddress === "string") throw new Error("fake broker did not bind");
const brokerPort = brokerAddress.port;
test.after(() => broker.close());

/**
 * Points awb's config at the fake broker's port. `createAwbHook` rewrites
 * hooks.json on every registration, so this runs after each one — see the note
 * on `broker` for what a mismatched port costs.
 */
function pointAwbAtBroker(): void {
	const file = path.join(String(process.env.AWB_HOME), "hooks.json");
	const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	config.port = brokerPort;
	fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/**
 * A workflow on a REAL awb hook (registered in the throwaway hooks.json, so
 * `hookRuntime` resolves its workdir and the on-disk step results really get
 * written) whose dispatches land in the fake broker above. Resets `inputs`,
 * which therefore always holds just the turns this workflow sent.
 */
function makeWorkflow(options: { steps?: number; context?: string | null } = {}) {
	inputs.length = 0;
	const id = `ctxstep-wf-${++seq}`;
	const agentName = `ctxstep-agent-${seq}`;
	const workdir = path.join(tmpHome, "sandboxes", agentName);
	const hook = createAwbHook(agentName, workdir, "{{payload}}", { runner: "claude" });
	pointAwbAtBroker();
	const workflow = insertWorkflow({
		id,
		name: `context step ${id}`,
		agentName,
		hookUrl: hook.hookUrl.replace(/:\d+\//, `:${brokerPort}/`),
		secret: hook.secret,
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: options.context ?? null,
	});
	const steps = Array.from({ length: options.steps ?? 1 }, (_, i) => insertStep(id, `step ${i + 1}`));
	return { workflow, steps, workdir, inputs };
}

const finishOk = (stepId: string, sessionId = "sess-1") =>
	onStepResult(stepId, { ok: true, result: "ack", sessionId }, cfg, silent);

// --- the row itself -------------------------------------------------------

test("saving a context materialises one context step, pinned before every task step", () => {
	const { workflow, steps } = makeWorkflow({ steps: 2 });
	assert.equal(getContextStep(workflow.id), null, "no context, no step");

	setConversationContext(workflow.id, "PINEAPPLE-7743 is the codeword.");

	const context = getContextStep(workflow.id);
	assert.ok(context);
	assert.equal(context.kind, "context");
	assert.equal(context.orderIndex, CONTEXT_STEP_ORDER_INDEX);
	assert.equal(context.status, "pending");
	assert.equal(context.description, "PINEAPPLE-7743 is the codeword.");
	// The shape the design fixes it at: nothing to judge, nobody to wait for,
	// nothing to retry, and never delegated.
	assert.equal(context.acceptanceCriteria, null);
	assert.equal(context.manualReview, false);
	assert.equal(context.useSubagent, false);
	assert.equal(context.maxRetries, 0);

	// It leads the list, and the operator's steps keep the indices they had —
	// the anti-renumbering guarantee that `order_index = -1` exists to give.
	const all = listSteps(workflow.id);
	assert.deepEqual(
		all.map((s) => s.kind),
		["context", "task", "task"],
	);
	assert.equal(getStep(steps[0].id)?.orderIndex, 0);
	assert.equal(getStep(steps[1].id)?.orderIndex, 1);
});

test("a workflow with no context gets no context step at all — zero behavioural delta", async () => {
	const { workflow, steps } = makeWorkflow({ steps: 2 });

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await finishOk(steps[0].id);
	await finishOk(steps[1].id);

	assert.equal(getContextStep(workflow.id), null);
	assert.equal(listSteps(workflow.id).length, 2);
	assert.equal(inputs.length, 2);
	assert.match(inputs[0], /^step 1/);
	assert.doesNotMatch(inputs[0], /Conversation context/);
});

test("reconcileContextStep is idempotent — two calls, two identical saves, still one row", () => {
	const { workflow } = makeWorkflow();
	setConversationContext(workflow.id, "background");
	const first = getContextStep(workflow.id);
	reconcileContextStep(workflow.id);
	reconcileContextStep(workflow.id);
	setConversationContext(workflow.id, "background");

	const contextSteps = listSteps(workflow.id).filter((s) => s.kind === "context");
	assert.equal(contextSteps.length, 1);
	assert.equal(contextSteps[0].id, first?.id, "the same row, not a replacement");
});

test("re-saving different text refreshes the pending step instead of adding a second one", () => {
	const { workflow } = makeWorkflow();
	setConversationContext(workflow.id, "first");
	const first = getContextStep(workflow.id);
	setConversationContext(workflow.id, "second");
	const second = getContextStep(workflow.id);
	assert.equal(second?.id, first?.id);
	assert.equal(second?.description, "second");
	assert.equal(listSteps(workflow.id).filter((s) => s.kind === "context").length, 1);
});

test("clearing the context removes the pending context step", () => {
	const { workflow } = makeWorkflow();
	setConversationContext(workflow.id, "to be cleared");
	assert.ok(getContextStep(workflow.id));
	setConversationContext(workflow.id, "");
	assert.equal(getContextStep(workflow.id), null);
	assert.equal(listSteps(workflow.id).length, 1, "only the task step is left");
});

test("a workflow whose context was ALREADY injected gets no context step — it keeps the legacy prepend", async () => {
	// The migration case: a workflow that was mid-run when this feature landed.
	// Fabricating a `done` step would invent a run that never happened, and a
	// `pending` one would re-deliver background the conversation already carries.
	const { workflow, steps } = makeWorkflow({ steps: 1, context: "LEGACY-BG" });
	setContextInjected(workflow.id, true);

	assert.equal(reconcileContextStep(workflow.id), null);
	assert.equal(getContextStep(workflow.id), null);

	// And with no context step, the legacy path is still the one in charge: this
	// workflow has no session, so the guard (already closed) is what decides.
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	assert.equal(inputs.length, 1);
	assert.match(inputs[0], /^step 1/);
});

test("a context that is ONLY images still gets a context step", async () => {
	const { saveAttachment } = await import("./attachments.ts");
	const { workflow } = makeWorkflow({ context: null });
	saveAttachment({
		workflowId: workflow.id,
		stepId: null,
		field: "context",
		filename: "spec.png",
		mime: "image/png",
		data: Buffer.from(
			"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
			"hex",
		),
	});
	assert.ok(reconcileContextStep(workflow.id), "attaching a spec screenshot and writing nothing is a real context");
	const context = getContextStep(workflow.id);
	assert.equal(context?.kind, "context");
	assert.match(context?.description ?? "", /image/i);
});

// --- the payload ----------------------------------------------------------

test("the context step's payload is the background and nothing else", async () => {
	const { workflow } = makeWorkflow({ context: "PINEAPPLE-7743 is the codeword." });
	setConversationContext(workflow.id, "PINEAPPLE-7743 is the codeword.");
	const context = getContextStep(workflow.id);
	assert.ok(context);

	const input = composeStepInput(context, getWorkflow(workflow.id)!);

	assert.match(input, /^Conversation context — this background applies to every step of this workflow:/);
	assert.match(input, /PINEAPPLE-7743/);
	// The one sentence that has to survive the hook's fixed "Carry out the step"
	// template — there is no way to re-template an existing workflow's hook.
	assert.ok(input.includes(CONTEXT_STEP_SUFFIX));
	assert.match(input, /do not use any tools/);
	// None of the machinery meant for real work: no subagent instruction of any
	// kind (background inside a subagent dies with it), and no pointer to prior
	// step results (this step runs first, so there are none).
	assert.equal(input.includes(SUBAGENT_SUFFIX), false);
	assert.equal(input.includes(INLINE_SUFFIX), false);
	assert.equal(input.includes(CONTEXT_PRESSURE_SUFFIX), false);
	assert.doesNotMatch(input, /Prior steps' results are on disk/);
	assert.doesNotMatch(input, /acceptance criterion/i);
});

test("the operator's first step is CLEAN — the background is no longer glued to it", async () => {
	const { workflow, steps } = makeWorkflow({ steps: 2 });
	setConversationContext(workflow.id, "PINEAPPLE-7743 is the codeword.");

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await finishOk(getContextStep(workflow.id)!.id);
	await finishOk(steps[0].id);
	await finishOk(steps[1].id);

	assert.equal(inputs.length, 3);
	// Turn 1: the background alone.
	assert.match(inputs[0], /^Conversation context/);
	assert.doesNotMatch(inputs[0], /step 1/);
	// Turn 2: the task alone. This is the entire point of the change.
	assert.match(inputs[1], /^step 1/);
	assert.doesNotMatch(inputs[1], /PINEAPPLE-7743/);
	assert.doesNotMatch(inputs[1], /Conversation context/);
	assert.doesNotMatch(inputs[2], /PINEAPPLE-7743/);
});

test("the background is delivered exactly once — the legacy prepend does not also fire", async () => {
	const { workflow, steps } = makeWorkflow({ steps: 3 });
	setConversationContext(workflow.id, "ONCE-ONLY-BG");

	await startWorkflow(workflow.id, cfg, silent, steps.map((s) => s.id));
	await finishOk(getContextStep(workflow.id)!.id);
	for (const step of steps) await finishOk(step.id);

	assert.equal(inputs.filter((i) => i.includes("ONCE-ONLY-BG")).length, 1);
});

// --- the silent failures --------------------------------------------------

test("an explicit Start selection cannot deselect the context step (it would run with no background)", async () => {
	const { workflow, steps } = makeWorkflow({ steps: 3 });
	setConversationContext(workflow.id, "SELECTION-BG");

	// The UI sends an id list built from the step checkboxes; the context step is
	// never in it. Without the forced selection, `nextPendingStep` (selected = 1)
	// would skip it and the run would look perfect with the background missing.
	setStepSelection(workflow.id, [steps[2].id]);
	assert.equal(getContextStep(workflow.id)?.selected, true);

	await startWorkflow(workflow.id, cfg, silent, [steps[2].id]);
	assert.match(inputs[0], /SELECTION-BG/, "the background led the run even though only step 3 was chosen");
});

test("an EMPTY selection still runs nothing — including the context step", async () => {
	const { workflow } = makeWorkflow({ steps: 2 });
	setConversationContext(workflow.id, "NOTHING-RUNS");

	await startWorkflow(workflow.id, cfg, silent, []);
	assert.equal(getContextStep(workflow.id)?.selected, false);
	assert.equal(inputs.length, 0);
});

test("restart re-primes the new conversation even when only a later step was chosen", async () => {
	const { workflow, steps } = makeWorkflow({ steps: 3 });
	setConversationContext(workflow.id, "RESTART-BG");

	await startWorkflow(workflow.id, cfg, silent, steps.map((s) => s.id));
	await finishOk(getContextStep(workflow.id)!.id);
	for (const step of steps) await finishOk(step.id);
	assert.equal(getWorkflow(workflow.id)?.contextInjected, true);
	assert.equal(inputs.filter((i) => i.includes("RESTART-BG")).length, 1);

	// Restart drops the session and reopens the guard. The context step has to
	// come back to `pending` with it — otherwise nothing re-primes the NEW
	// conversation, and the legacy prepend that used to cover that is now off.
	await restartWorkflow(workflow.id, cfg, silent, [steps[2].id]);
	assert.equal(getContextStep(workflow.id)?.status, "queued", "re-dispatched, not left done");
	assert.equal(inputs.filter((i) => i.includes("RESTART-BG")).length, 2);
	assert.match(inputs.at(-1)!, /^Conversation context/);
});

test("resuming mid-way does NOT re-deliver a context step that already ran", async () => {
	const { workflow, steps } = makeWorkflow({ steps: 2 });
	setConversationContext(workflow.id, "RESUME-BG");

	await startWorkflow(workflow.id, cfg, silent, steps.map((s) => s.id));
	await finishOk(getContextStep(workflow.id)!.id);
	await finishOk(steps[0].id);
	pauseWorkflow(workflow.id);
	await resumeWorkflow(workflow.id, cfg, silent, steps.map((s) => s.id));

	assert.equal(getContextStep(workflow.id)?.status, "done");
	assert.equal(inputs.filter((i) => i.includes("RESUME-BG")).length, 1);
	assert.match(inputs.at(-1)!, /^step 2/, "the resume picked up at step 2, not at the background");
});

test("a judge rejecting a step retries that step, never the context step", async () => {
	const { workflow } = makeWorkflow({ steps: 0 });
	setConversationContext(workflow.id, "JUDGED-BG");
	const step = addStep(workflow.id, "do the thing", { acceptanceCriteria: "it is done", maxRetries: 1 });

	await startWorkflow(workflow.id, cfg, silent, [step.id]);
	await finishOk(getContextStep(workflow.id)!.id);
	await finishOk(step.id); // exec ok → judge dispatched
	// The judge rejects: the step re-runs, the background does not.
	await onStepResult(step.id, { ok: true, result: '{"ok": false, "reason": "not yet"}', sessionId: "sess-1" }, cfg, silent);

	assert.equal(getContextStep(workflow.id)?.status, "done");
	assert.equal(inputs.filter((i) => i.includes("JUDGED-BG")).length, 1);
});

// --- counting -------------------------------------------------------------

test("progress counts the operator's steps only", async () => {
	const { workflow, steps } = makeWorkflow({ steps: 2 });
	setConversationContext(workflow.id, "PROGRESS-BG");

	assert.deepEqual(stepProgress(workflow.id), { total: 2, done: 0, failed: 0, pct: 0 });

	await startWorkflow(workflow.id, cfg, silent, steps.map((s) => s.id));
	await finishOk(getContextStep(workflow.id)!.id);
	// The background having landed is not 33% of the operator's work.
	assert.deepEqual(stepProgress(workflow.id), { total: 2, done: 0, failed: 0, pct: 0 });

	await finishOk(steps[0].id);
	await finishOk(steps[1].id);
	assert.deepEqual(stepProgress(workflow.id), { total: 2, done: 2, failed: 0, pct: 100 });
	assert.equal(getWorkflow(workflow.id)?.status, "completed", "100% really means completed");
});

test("no 00-*.md is written, and the task steps' result filenames are unchanged", async () => {
	const { workflow, steps, workdir } = makeWorkflow({ steps: 2 });
	setConversationContext(workflow.id, "FILES-BG");

	await startWorkflow(workflow.id, cfg, silent, steps.map((s) => s.id));
	await finishOk(getContextStep(workflow.id)!.id);
	await finishOk(steps[0].id);
	await finishOk(steps[1].id);

	const files = fs.readdirSync(stepResultsDir(workdir)).sort();
	assert.deepEqual(files, ["01-step-1.md", "02-step-2.md"]);
	assert.equal(
		files.some((f) => f.startsWith("00-")),
		false,
		"the context step's one-line ack does not become a step-zero file the agent is told to trust",
	);
});

test("the progress .md reports the context step on its own line, never as step 0", async () => {
	const { workflow } = makeWorkflow({ steps: 1 });
	setConversationContext(workflow.id, "MD-BG");
	const { writeStatusMd } = await import("./workflow.ts");
	writeStatusMd(workflow.id);

	const md = fs.readFileSync(getWorkflow(workflow.id)!.mdPath, "utf8");
	assert.match(md, /- Conversation context step: \[ \] delivered as its own turn before every other step/);
	assert.doesNotMatch(md, /^0\. /m);
	assert.match(md, /^1\. \[ \] step 1/m);
	assert.match(md, /Progress: 0\/1 steps done/);
});

// --- immutability ---------------------------------------------------------

test("the context step is hub-owned: edit, remove, ▶ and status are all refused", async () => {
	const { workflow, steps } = makeWorkflow({ steps: 1 });
	setConversationContext(workflow.id, "OWNED-BG");
	const context = getContextStep(workflow.id)!;

	const managed = /managed by the hub/;
	assert.throws(() => editStep(workflow.id, context.id, "hijacked"), managed);
	assert.throws(() => removeStep(workflow.id, context.id), managed);
	assert.throws(() => forceStepStatus(workflow.id, context.id, "done", silent), managed);
	await assert.rejects(() => runStep(workflow.id, context.id, cfg, silent), managed);
	// Inserting "after" it would compute index 0 and shift every task step down —
	// the renumbering that pinning it at -1 exists to prevent.
	assert.throws(() => addStep(workflow.id, "sneaky", { afterStepId: context.id }), managed);

	// Nothing was mutated by any of that.
	assert.equal(getContextStep(workflow.id)?.description, "OWNED-BG");
	assert.equal(getStep(steps[0].id)?.orderIndex, 0);
});

test("the HTTP step routes refuse the context step with 400, not 500", async () => {
	const apiServer = createServer(cfg, silent);
	await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
	const addr = apiServer.address();
	if (!addr || typeof addr === "string") throw new Error("api server did not bind");
	const base = `http://127.0.0.1:${addr.port}`;
	test.after(() => apiServer.close());
	const headers = { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };

	const { workflow } = makeWorkflow({ steps: 1 });
	setConversationContext(workflow.id, "HTTP-BG");
	const context = getContextStep(workflow.id)!;
	const stepUrl = `${base}/api/workflows/${workflow.id}/steps/${context.id}`;

	for (const [label, res] of [
		["PATCH", await fetch(stepUrl, { method: "PATCH", headers, body: JSON.stringify({ description: "no" }) })],
		["DELETE", await fetch(stepUrl, { method: "DELETE", headers })],
		["run", await fetch(`${stepUrl}/run`, { method: "POST", headers })],
		["status", await fetch(`${stepUrl}/status`, { method: "POST", headers, body: JSON.stringify({ status: "done" }) })],
	] as const) {
		assert.equal(res.status, 400, `${label} is a refusal, not a crash`);
		const body = (await res.json()) as { error: string };
		assert.match(body.error, /managed by the hub/, `${label} says why`);
	}

	// And the step is still there, untouched.
	assert.equal(getContextStep(workflow.id)?.status, "pending");
});

test("GET /api/workflows/:id exposes the step kind so the UI can pin it", async () => {
	const apiServer = createServer(cfg, silent);
	await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
	const addr = apiServer.address();
	if (!addr || typeof addr === "string") throw new Error("api server did not bind");
	test.after(() => apiServer.close());

	const { workflow } = makeWorkflow({ steps: 2 });
	setConversationContext(workflow.id, "API-BG");

	// Data routes sit behind the access gate now — the admin token stands in
	// for the logged-in operator here.
	const res = await fetch(`http://127.0.0.1:${addr.port}/api/workflows/${workflow.id}`, {
		headers: { authorization: `Bearer ${cfg.adminToken}` },
	});
	const body = (await res.json()) as { workflow: { progress: { total: number } }; steps: { kind: string }[] };
	assert.deepEqual(
		body.steps.map((s) => s.kind),
		["context", "task", "task"],
	);
	assert.equal(body.workflow.progress.total, 2, "the progress the UI renders excludes it");
});
