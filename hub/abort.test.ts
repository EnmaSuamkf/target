/**
 * Tests for the "Abort stuck step" feature: a step whose dispatch never calls
 * back (a hung exec or judge) can be force-failed so the operator can re-run
 * it without restarting the whole workflow. The session it established is
 * preserved, the workflow moves to `failed` (mirroring onStepResult's failure
 * path), a later successful ▶ re-run reconciles it back out of `failed`, and
 * any late awb callback for the aborted step is ignored.
 *
 * Abort's other meaning — refusing the result of a step held at its
 * manual-review gate, which stops the workflow instead of unsticking anything —
 * lives with the rest of the gate, in manual-review.test.ts. Everything here is
 * about the stuck-dispatch case, including the guard that still refuses every
 * other status.
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

const { insertStep, insertWorkflow, getWorkflow, getStep, listSteps, listStepNotes, saveSyncStepMap, setWorkflowRemoteMeta } = await import("./db.ts");
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
	// Step 0 was dispatched and is stuck queued in exec (the fake hook accepts
	// the POST but never calls back, so no `started` ever flips it to running).
	// awb only reports a session in the completion callback, so a stuck first
	// dispatch has no session yet — that's expected, and it's why "Open
	// conversation" is gated on a session existing.
	assert.equal(getStep(steps[0].id)?.status, "queued");
	assert.equal(getStep(steps[0].id)?.sessionId, null);

	const { workflow: updated, abort } = await abortStep(workflow.id, steps[0].id, silent);
	assert.equal(updated.status, "failed");
	// The fake hook is not a registered local awb hook → the kill is not attempted.
	assert.deepEqual(abort, { result: "not_local", confirmed: false });
	const notes = listStepNotes(steps[0].id);
	assert.equal(notes.length, 1);
	assert.match(notes[0].content, /^Abort: COULD NOT confirm the agent stopped \(not_local\)/);
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
	// The judge dispatch was accepted by the fake hook but no `started` came
	// back, so the step sits `queued` in its judge phase (not `running`).
	assert.equal(getStep(step.id)?.status, "queued");
	assert.equal(getStep(step.id)?.phase, "judge");
	assert.equal(getStep(step.id)?.sessionId, "sess-keep"); // set during exec→judge
	assert.equal(getWorkflow(id)?.lastSessionId, "sess-keep");

	await abortStep(id, step.id, silent);
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
	assert.equal(getStep(steps[0].id)?.status, "queued");
	await abortStep(workflow.id, steps[0].id, silent);
	assert.equal(getStep(steps[0].id)?.status, "failed");

	// ▶ re-run: the step is no longer running/queued, so runStep accepts it.
	// (runStep's dispatch is also accepted by the fake hook → the step is
	// `queued`, not `running`, until a `started` callback arrives.)
	await runStep(workflow.id, steps[0].id, cfg, silent);
	assert.equal(getStep(steps[0].id)?.status, "queued");
	assert.equal(getStep(steps[0].id)?.manualRun, true);
});

test("abort rejects a non-running/non-queued step", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);
	// Step is still pending (never dispatched).
	await assert.rejects(() => abortStep(workflow.id, steps[0].id, silent), /only a running step can be aborted/);
	// Workflow/step untouched.
	assert.equal(getStep(steps[0].id)?.status, "pending");
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
});

test("abort rejects an unknown step / unknown workflow", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await assert.rejects(() => abortStep(workflow.id, "no-such-step", silent), /unknown step/);
	await assert.rejects(() => abortStep("no-such-workflow", steps[0].id, silent), /unknown workflow/);
	// A step from a different workflow is also "unknown".
	const other = makeWorkflow(1, url);
	await assert.rejects(() => abortStep(workflow.id, other.steps[0].id, silent), /unknown step/);
});

test("a late awb callback for an aborted step is ignored (no corruption)", async () => {
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await abortStep(workflow.id, steps[0].id, silent);
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
	assert.equal(getStep(steps[1].id)?.status, "queued");

	await abortStep(workflow.id, steps[1].id, silent);
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

test("POST /api/workflows/:id/steps/:stepId/abort aborts a queued step", async () => {
	// Drive a step to queued through the real API + a fake hook (the fake hook
	// accepts the POST but never sends `started`, so the step stays queued).
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { workflow, steps } = makeWorkflow(1, url);

	const startRes = await fetch(`${apiBase}/api/workflows/${workflow.id}/start`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ stepIds: [steps[0].id] }),
	});
	assert.equal(startRes.status, 200);
	assert.equal(getStep(steps[0].id)?.status, "queued");

	const res = await fetch(`${apiBase}/api/workflows/${workflow.id}/steps/${steps[0].id}/abort`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workflow: { status: string }; abort: { result: string; confirmed: boolean } };
	assert.equal(body.workflow.status, "failed");
	assert.deepEqual(body.abort, { result: "not_local", confirmed: false });
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
	assert.equal(getStep(steps[0].id)?.status, "queued");
});

test("POST .../abort on a non-running/non-queued step returns 400", async () => {
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

// --- Confirmed abort: what the broker answered ---------------------------
//
// The cases above run against a hook the hub does not recognise as local, so the
// kill is skipped (`not_local`). These register the fake broker in the (throwaway)
// AWB_HOME hooks.json — the same way inspectLocalHook finds the real one — so
// `abortAwbRun` really POSTs `/abort` and has to read the answer.

const hooksFile = path.join(tmpHome, "hooks.json");

interface FakeBroker {
	url: string;
	abortCalls: { jobId: string; secret: string | undefined }[];
	close: () => void;
}

/**
 * A fake awb broker registered as the local one: accepts dispatches, and answers
 * `/abort` with `reply` (a status + JSON body), recording what it was asked.
 */
async function startFakeBroker(reply: { status?: number; body: unknown }): Promise<FakeBroker> {
	const abortCalls: FakeBroker["abortCalls"] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			res.setHeader("content-type", "application/json");
			if (req.url?.endsWith("/abort")) {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { jobId: string };
				abortCalls.push({ jobId: parsed.jobId, secret: req.headers["x-webhook-secret"] as string | undefined });
				res.writeHead(reply.status ?? 200);
				res.end(JSON.stringify(reply.body));
				return;
			}
			res.writeHead(200);
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("fake broker did not bind");
	fs.writeFileSync(hooksFile, JSON.stringify({ port: addr.port, hooks: { agent: {} } }));
	return {
		url: `http://127.0.0.1:${addr.port}/hook/agent`,
		abortCalls,
		close: () => {
			server.close();
			fs.rmSync(hooksFile, { force: true });
		},
	};
}

/** Starts a one-step workflow against `url` and aborts it through the real API route. */
async function abortViaApi(url: string) {
	const { workflow, steps } = makeWorkflow(1, url);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	assert.equal(getStep(steps[0].id)?.status, "queued");
	const res = await fetch(`${apiBase}/api/workflows/${workflow.id}/steps/${steps[0].id}/abort`, {
		method: "POST",
		headers: adminHeaders(),
	});
	const body = (await res.json()) as { workflow: { id: string; status: string }; abort: { result: string; confirmed: boolean } };
	return { res, body, workflow, stepId: steps[0].id };
}

const BROKER_OUTCOMES = [
	{
		name: "killed",
		reply: { result: "killed", killed: true, signal: "SIGINT", exited: true },
		expect: { result: "killed", confirmed: true },
		note: "Abort: agent process stopped (SIGINT)",
	},
	{
		name: "cancelled_queued",
		reply: { result: "cancelled_queued", killed: true, signal: null, exited: false },
		expect: { result: "cancelled_queued", confirmed: true },
		note: "Abort: cancelled before it started",
	},
	{
		name: "not_running",
		reply: { result: "not_running", killed: false, signal: null, exited: false },
		expect: { result: "not_running", confirmed: false },
		note: "Abort: nothing was running",
	},
	{
		name: "kill_failed",
		reply: { result: "kill_failed", killed: false, signal: "SIGKILL", exited: false },
		expect: { result: "kill_failed", confirmed: false },
		note: "Abort: COULD NOT confirm the agent stopped (kill_failed) — it may still be running; check the workdir",
	},
] as const;

for (const outcome of BROKER_OUTCOMES) {
	test(`broker answers ${outcome.name}: step still fails as aborted, note + abort{result,confirmed} reported`, async () => {
		const broker = await startFakeBroker({ body: outcome.reply });
		test.after(() => broker.close());
		const { res, body, workflow, stepId } = await abortViaApi(broker.url);

		assert.equal(res.status, 200);
		assert.equal(body.workflow.status, "failed"); // pre-existing field untouched
		assert.deepEqual(body.abort, outcome.expect);
		// The broker was asked for exactly this step, with the hook's secret.
		assert.deepEqual(broker.abortCalls, [{ jobId: stepId, secret: "s3cret" }]);
		// Settled regardless of the verdict — even kill_failed must not strand the step.
		assert.equal(getStep(stepId)?.status, "failed");
		assert.equal(getStep(stepId)?.error, "aborted");
		assert.equal(getWorkflow(workflow.id)?.status, "failed");
		assert.deepEqual(
			listStepNotes(stepId).map((n) => n.content),
			[outcome.note],
		);
	});
}

test("OLD broker { killed: true } → killed but unverified (confirmed false)", async () => {
	const broker = await startFakeBroker({ body: { killed: true } });
	test.after(() => broker.close());
	const { body, stepId } = await abortViaApi(broker.url);
	assert.deepEqual(body.abort, { result: "killed", confirmed: false });
	assert.equal(getStep(stepId)?.status, "failed");
	assert.equal(getStep(stepId)?.error, "aborted");
	// Unverified kills must not claim the agent stopped.
	assert.equal(listStepNotes(stepId).length, 1);
	assert.equal(listStepNotes(stepId)[0].theme, "warning");
});

test("OLD broker { killed: false } → not_running, unconfirmed", async () => {
	const broker = await startFakeBroker({ body: { killed: false } });
	test.after(() => broker.close());
	const { body, stepId } = await abortViaApi(broker.url);
	assert.deepEqual(body.abort, { result: "not_running", confirmed: false });
	assert.equal(getStep(stepId)?.status, "failed");
	assert.equal(listStepNotes(stepId)[0].content, "Abort: nothing was running");
});

test("broker answering non-2xx → unreachable, unconfirmed, abort still settles", async () => {
	const broker = await startFakeBroker({ status: 500, body: { error: "boom" } });
	test.after(() => broker.close());
	const { res, body, stepId } = await abortViaApi(broker.url);
	assert.equal(res.status, 200);
	assert.deepEqual(body.abort, { result: "unreachable", confirmed: false });
	assert.equal(getStep(stepId)?.status, "failed");
	assert.equal(getStep(stepId)?.error, "aborted");
	assert.match(listStepNotes(stepId)[0].content, /^Abort: COULD NOT confirm the agent stopped \(unreachable\)/);
});

test("broker down → unreachable, unconfirmed, abort still settles", async () => {
	// Dispatch needs a live hook; the broker then goes away before the abort.
	const broker = await startFakeBroker({ body: { result: "killed", killed: true, signal: "SIGINT", exited: true } });
	const { workflow, steps } = makeWorkflow(1, broker.url);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	assert.equal(getStep(steps[0].id)?.status, "queued");
	// Keep hooks.json pointing at the port, but stop answering on it.
	const registered = fs.readFileSync(hooksFile, "utf8");
	broker.close();
	fs.writeFileSync(hooksFile, registered);
	test.after(() => fs.rmSync(hooksFile, { force: true }));

	const res = await fetch(`${apiBase}/api/workflows/${workflow.id}/steps/${steps[0].id}/abort`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { abort: { result: string; confirmed: boolean } };
	assert.deepEqual(body.abort, { result: "unreachable", confirmed: false });
	assert.equal(getStep(steps[0].id)?.status, "failed");
	assert.equal(getStep(steps[0].id)?.error, "aborted");
});

test("hook not on the local broker → not_local, unconfirmed, abort still settles", async () => {
	fs.rmSync(hooksFile, { force: true });
	const { server, url } = await startFakeHook();
	test.after(() => server.close());
	const { body, stepId } = await abortViaApi(url);
	assert.deepEqual(body.abort, { result: "not_local", confirmed: false });
	assert.equal(getStep(stepId)?.status, "failed");
	assert.match(listStepNotes(stepId)[0].content, /\(not_local\)/);
});

test("the sync command step.abort carries abort { result, confirmed } next to localId", async () => {
	const broker = await startFakeBroker({ body: { result: "killed", killed: true, signal: "SIGTERM", exited: true } });
	test.after(() => broker.close());
	const { workflow, steps } = makeWorkflow(1, broker.url);
	// The sync handler resolves the workflow by remote id and the step by key.
	const remoteId = `remote-${workflow.id}`;
	setWorkflowRemoteMeta(workflow.id, { remoteId });
	saveSyncStepMap(remoteId, { first: steps[0].id });
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	const { executeSyncCommand } = await import("./sync.ts");
	const result = await executeSyncCommand(
		{
			id: `cmd-${workflow.id}`,
			type: "step.abort",
			remote_id: remoteId,
			payload: { step_key: "first" },
		} as never,
		cfg,
	);
	assert.equal(result.localId, workflow.id);
	assert.deepEqual(result.abort, { result: "killed", confirmed: true });
	assert.equal(getStep(steps[0].id)?.status, "failed");
});

test("a failure callback that lands while the broker kill is pending does not pre-empt the abort", async () => {
	// A real broker reports the killed run as failed; that callback can reach the
	// hub BEFORE the /abort answer does. It must neither fail the step as "run
	// failed" nor spend a retry — the abort settles it as "aborted".
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let stepId = "";
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", async () => {
			res.setHeader("content-type", "application/json");
			if (req.url?.endsWith("/abort")) {
				// The kill's side effect arrives first…
				await onStepResult(stepId, { ok: false, error: "run failed" }, cfg, silent);
				await gate;
				res.writeHead(200);
				res.end(JSON.stringify({ result: "killed", killed: true, signal: "SIGINT", exited: true }));
				return;
			}
			res.writeHead(200);
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	test.after(() => {
		server.close();
		fs.rmSync(hooksFile, { force: true });
	});
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("no port");
	fs.writeFileSync(hooksFile, JSON.stringify({ port: addr.port, hooks: { agent: {} } }));
	const { workflow, steps } = makeWorkflow(1, `http://127.0.0.1:${addr.port}/hook/agent`);
	stepId = steps[0].id;
	await startWorkflow(workflow.id, cfg, silent, [stepId]);

	const pending = abortStep(workflow.id, stepId, silent);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(getStep(stepId)?.status, "queued", "callback ignored while the abort is pending");
	release();
	const { abort } = await pending;
	assert.deepEqual(abort, { result: "killed", confirmed: true });
	assert.equal(getStep(stepId)?.status, "failed");
	assert.equal(getStep(stepId)?.error, "aborted");
});
