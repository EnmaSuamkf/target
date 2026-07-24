/**
 * Tests for the "Abort stuck step" feature: a step whose dispatch never calls
 * back (a hung exec or judge) can be force-failed so the operator can re-run
 * it without restarting the whole workflow. The session it established is
 * preserved, the workflow moves to `failed` (mirroring onStepResult's failure
 * path), a later successful ▶ re-run reconciles it back out of `failed`, and
 * any late awb callback for the aborted step is ignored.
 *
 * Same throwaway-TARGET_HOME + fake-awb-hook convention as context.test.ts:
 * the fake hook swallows the dispatch POST (answers `{ok:true}`, records it,
 * never calls back a result) so dispatched steps stay `running` — exactly the
 * stuck state Abort exists for.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-abort-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — this suite doesn't create workflows via the
// API, but if it ever does, keep its hooks out of the real broker). See
// server.test.ts for the full rationale.
process.env.AWB_HOME = tmpHome;

const { insertStep, insertWorkflow, getWorkflow, getStep, listSteps } = await import("./db.ts");
const { createServer } = await import("./server.ts");
const { loadConfig } = await import("./config.ts");
const { startWorkflow, abortStep, runStep, onStepResult } = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

/** A fake awb hook that swallows dispatches (answers ok, never calls back). */
function startFakeHook() {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	return new Promise<{ server: http.Server; url: string }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
			resolve({ server, url: `http://127.0.0.1:${addr.port}/hook/agent` });
		});
	});
}

function makeWorkflow(count: number, hookUrl: string) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	const steps = Array.from({ length: count }, (_, i) => insertStep(id, `step ${i + 1}`));
	return { workflow, steps };
}

/** Reports a successful result with a session, exactly as awb's callback would. */
async function finishStepOk(stepId: string, sessionId: string) {
	await onStepResult(stepId, { ok: true, result: "fine", sessionId }, cfg, silent);
}

test("abort force-fails a stuck running step (exec hang: no session yet) and fails the workflow", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(2, url);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	// Step 0 was dispatched and is stuck running in exec (the fake hook never
	// calls back). awb only reports a session in the completion callback, so a
	// stuck first dispatch has no session yet — that's expected, and it's why
	// "Open conversation" is gated on a session existing.
	assert.equal(getStep(steps[0].id)?.status, "running");
	assert.equal(getStep(steps[0].id)?.sessionId, null);

	const updated = abortStep(workflow.id, steps[0].id);
	assert.equal(updated.status, "failed");
	const step = getStep(steps[0].id);
	assert.equal(step?.status, "failed");
	assert.equal(step?.error, "aborted");
	assert.ok(step?.finishedAt, "finished_at set");
});

// This is the user's exact case: a step that finished its exec work (so a
// session WAS established) and then hung in the judge phase.
test("abort preserves an established session id (judge hang) — Open conversation still works", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl: url,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	// A step WITH acceptance criteria: exec finishes → it moves into the judge
	// phase (session_id set from the exec callback) → the judge dispatch hangs.
	const step = insertStep(id, "step with criteria", { acceptanceCriteria: "must be good" });

	await startWorkflow(id, cfg, silent, [step.id]);
	await finishStepOk(step.id, "sess-keep"); // exec ok → judging, judge dispatched (hung)
	assert.equal(getStep(step.id)?.status, "running");
	assert.equal(getStep(step.id)?.phase, "judge");
	assert.equal(getStep(step.id)?.sessionId, "sess-keep"); // set during exec→judge
	assert.equal(getWorkflow(id)?.lastSessionId, "sess-keep");

	abortStep(id, step.id);
	const aborted = getStep(step.id);
	assert.equal(aborted?.status, "failed");
	assert.equal(aborted?.error, "aborted");
	// The session it established is PRESERVED across the abort — "Open
	// conversation" resolves it, and lastSessionId is untouched.
	assert.equal(aborted?.sessionId, "sess-keep");
	assert.equal(getWorkflow(id)?.lastSessionId, "sess-keep");
});

test("after abort, the step can be re-run via ▶ (startManualRun succeeds again)", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	assert.equal(getStep(steps[0].id)?.status, "running");
	abortStep(workflow.id, steps[0].id);
	assert.equal(getStep(steps[0].id)?.status, "failed");

	// ▶ re-run: the step is no longer running, so runStep accepts it.
	await runStep(workflow.id, steps[0].id, cfg, silent);
	assert.equal(getStep(steps[0].id)?.status, "running");
	assert.equal(getStep(steps[0].id)?.manualRun, true);
});

test("abort rejects a non-running step", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);
	// Step is still pending (never dispatched).
	assert.throws(() => abortStep(workflow.id, steps[0].id), /only a running step can be aborted/);
	// Workflow/step untouched.
	assert.equal(getStep(steps[0].id)?.status, "pending");
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
});

test("abort rejects an unknown step / unknown workflow", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	assert.throws(() => abortStep(workflow.id, "no-such-step"), /unknown step/);
	assert.throws(() => abortStep("no-such-workflow", steps[0].id), /unknown workflow/);
	// A step from a different workflow is also "unknown".
	const other = makeWorkflow(1, url);
	assert.throws(() => abortStep(workflow.id, other.steps[0].id), /unknown step/);
});

test("a late awb callback for an aborted step is ignored (no corruption)", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	abortStep(workflow.id, steps[0].id);
	assert.equal(getStep(steps[0].id)?.status, "failed");

	// The hung dispatch's callback finally arrives, claiming success — it must
	// be dropped, not resurrect the step or move the workflow forward.
	await onStepResult(steps[0].id, { ok: true, result: "late", sessionId: "late-sess" }, cfg, silent);
	assert.equal(getStep(steps[0].id)?.status, "failed");
	assert.equal(getStep(steps[0].id)?.result, null);
	assert.notEqual(getStep(steps[0].id)?.sessionId, "late-sess");
	assert.equal(getWorkflow(workflow.id)?.status, "failed");
});

test("abort does not touch a sibling done step (only the stuck one fails)", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(2, url);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await finishStepOk(steps[0].id, "sess-1"); // step 0 done, step 1 dispatched
	assert.equal(getStep(steps[1].id)?.status, "running");

	abortStep(workflow.id, steps[1].id);
	assert.equal(getStep(steps[0].id)?.status, "done"); // untouched
	assert.equal(getStep(steps[1].id)?.status, "failed");
});

// --- API wiring ---------------------------------------------------------

const apiServer = createServer(cfg, silent);
await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
const apiAddr = apiServer.address();
if (!apiAddr || typeof apiAddr === "string") throw new Error("api server did not bind");
const apiBase = `http://127.0.0.1:${apiAddr.port}`;
test.after(() => apiServer.close());

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

test("POST /api/workflows/:id/steps/:stepId/abort aborts a running step", async () => {
	// Drive a step to running through the real API + a fake hook.
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);

	const startRes = await fetch(`${apiBase}/api/workflows/${workflow.id}/start`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ stepIds: [steps[0].id] }),
	});
	assert.equal(startRes.status, 200);
	assert.equal(getStep(steps[0].id)?.status, "running");

	const res = await fetch(`${apiBase}/api/workflows/${workflow.id}/steps/${steps[0].id}/abort`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workflow: { status: string } };
	assert.equal(body.workflow.status, "failed");
	assert.equal(getStep(steps[0].id)?.status, "failed");
	assert.equal(getStep(steps[0].id)?.error, "aborted");
});

test("POST .../abort requires an admin token", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);

	const res = await fetch(`${apiBase}/api/workflows/${workflow.id}/steps/${steps[0].id}/abort`, {
		method: "POST",
		headers: { "content-type": "application/json" },
	});
	assert.equal(res.status, 401);
	// Untouched.
	assert.equal(getStep(steps[0].id)?.status, "running");
});

test("POST .../abort on a non-running step returns 400", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);
	// Step still pending.
	const res = await fetch(`${apiBase}/api/workflows/${workflow.id}/steps/${steps[0].id}/abort`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "only a running step can be aborted");
});

test("POST .../abort on an unknown step returns 400", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow } = makeWorkflow(1, url);
	const res = await fetch(`${apiBase}/api/workflows/${workflow.id}/steps/no-such-step/abort`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "unknown step");
});
