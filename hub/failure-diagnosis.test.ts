/**
 * Tests for making a failed run diagnosable (hub/server.ts result route +
 * hub/workflow.ts `onStepResult`).
 *
 * Two separate defects, both invisible until you're the one debugging at 2am:
 *
 *  1. Every CLI failure reached the operator as `exit 1`. The broker now
 *     forwards the CLI's own error text (see the awb side in
 *     vendor/agent-webhook-bridge/broker/dispatch.test.ts); this file pins the
 *     hub end — that the text arrives, is stored on the step, and reaches the
 *     progress file rather than being replaced by an exit code.
 *  2. `chainSession` sat AFTER the failure path's early return while the failed
 *     step row still stored its session id. So the hub's two answers to "which
 *     conversation is this workflow on" diverged: the next dispatch reads
 *     `workflow.lastSessionId` while the UI's "Open conversation" reads
 *     `latestStepSession()`. After a failure the operator was shown one
 *     conversation and the retry resumed a different, older one — which for a
 *     workflow whose whole premise is ONE shared conversation is the worst
 *     possible way to be wrong.
 *
 * Same throwaway-home convention as the other suites.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-failure-diagnosis-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { getStep, getWorkflow, insertStep, insertWorkflow, latestStepSession, markStepRunning, setWorkflowSessionId } =
	await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { onStepResult } = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
test.after(() => server.close());

let seq = 0;

/** A workflow with one running step, ready to receive a result callback. */
function makeRunningStep(options: { sessionId?: string | null } = {}) {
	const id = `fd-wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `failure ${id}`,
		agentName: `fd-agent-${seq}`,
		hookUrl: "http://127.0.0.1:9/hook/none",
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	if (options.sessionId !== undefined) setWorkflowSessionId(id, options.sessionId);
	const step = insertStep(id, "the step");
	markStepRunning(step.id);
	return { workflow: getWorkflow(id)!, step: getStep(step.id)! };
}

/** POSTs a result callback exactly as the broker would. */
async function postResult(stepId: string, body: Record<string, unknown>): Promise<Response> {
	const step = getStep(stepId)!;
	return fetch(`${baseUrl}/api/steps/${stepId}/result?token=${step.callbackToken}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

// --- 1. the error text reaches the operator --------------------------------

test("a failing run surfaces its real error text, not `exit 1`", async () => {
	const { step } = makeRunningStep();
	const message = "API Error: prompt is too long: 412345 tokens > 200000 maximum";

	const res = await postResult(step.id, { ok: false, exitCode: 1, error: message, logFile: "/tmp/run.log" });
	assert.equal(res.status, 200);

	const settled = getStep(step.id)!;
	assert.equal(settled.status, "failed");
	assert.equal(settled.error, message, "the CLI's own words, stored verbatim");
	assert.ok(!String(settled.error).includes("exit 1"), "the exit code is not the story");
});

test("a context overflow is legible as a context overflow", async () => {
	// The concrete case this exists for: the shared conversation grew past the
	// window. Before, this and a typo'd flag were the same `exit 1`.
	const { workflow, step } = makeRunningStep();
	await postResult(step.id, { ok: false, exitCode: 1, error: "Error: context length exceeded (input 1048577 tokens)" });

	assert.match(String(getStep(step.id)?.error), /context length exceeded/);
	// It also reaches the operator's progress file, which is where someone
	// looking at a failed workflow actually looks.
	assert.match(fs.readFileSync(getWorkflow(workflow.id)!.mdPath, "utf8"), /context length exceeded/);
});

test("a failure with no error text still falls back to the exit code, as before", async () => {
	// Visible-mode runs capture no streams, so there may genuinely be nothing to
	// forward — that path must keep working rather than storing "undefined".
	const { step } = makeRunningStep();
	await postResult(step.id, { ok: false, exitCode: 137 });
	assert.equal(getStep(step.id)?.error, "exit 137");
});

// --- 2. the two "which session?" answers must agree ------------------------

test("a failed step does not leave lastSessionId behind latestStepSession()", async () => {
	// The workflow is already on a conversation; the failing run resumed it and
	// the broker reports the (same or rotated) session it ended on.
	const { step } = makeRunningStep({ sessionId: "sess-old" });

	await onStepResult(step.id, { ok: false, error: "boom", sessionId: "sess-after-failure" }, cfg, silent);

	assert.equal(getStep(step.id)?.sessionId, "sess-after-failure", "the step row records the run's session");
	assert.equal(
		getWorkflow(step.workflowId)?.lastSessionId,
		"sess-after-failure",
		"and so does the workflow — a failed run still HAPPENED in that conversation",
	);
	assert.equal(
		latestStepSession(step.workflowId),
		getWorkflow(step.workflowId)?.lastSessionId,
		"the dispatch path and the UI now agree on which conversation this is",
	);
});

test("a failure that produced no session leaves the previous one alone", async () => {
	// A dispatch that died before the CLI ever started has no session to chain;
	// clobbering the workflow's existing one with null would strand the
	// conversation every earlier step ran in.
	const { step } = makeRunningStep({ sessionId: "sess-keep" });

	await onStepResult(step.id, { ok: false, error: "hook unreachable" }, cfg, silent);

	assert.equal(getWorkflow(step.workflowId)?.lastSessionId, "sess-keep");
});

test("the failure path still fails the workflow and says why", async () => {
	// Everything the failure path did before must keep happening — the session
	// chaining is an addition, not a replacement.
	const { workflow, step } = makeRunningStep({ sessionId: "sess-x" });
	const logged: string[] = [];

	await onStepResult(step.id, { ok: false, error: "the real reason", sessionId: "sess-y" }, cfg, (m) => logged.push(m));

	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	assert.ok(logged.some((m) => m.includes("the real reason")));
});
