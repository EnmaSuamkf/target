/**
 * Tests for "Open conversation" on a step that FAILED.
 *
 * The button resumes one step's own session in a terminal
 * (POST /api/workflows/:id/steps/:stepId/open-terminal → terminal.ts). It was
 * offered only on a `waiting` step — the manual-review gate — on the reasoning
 * that it is an answer to "what do I do about this result". But the state where
 * an operator most needs to talk to the agent is the one where it went wrong:
 * the step is finished, the error pane says whatever the agent chose to say, and
 * the only way to learn more than that is to reopen the conversation and ask.
 *
 * Showing the button is half the job. The other half — the half that would have
 * made it a dead button — is whether a failed step still CARRIES the session id
 * the route resolves. It did not, for the failures that go through the judge:
 * `markStepJudging` stores the exec run's session on the step row, then every
 * judge dead end (verdict rejected out of retries, verdict unparseable, judge
 * run died) settled the step through `completeStep` with no session in hand, and
 * `completeStep` wrote `session_id = ?` unconditionally — so the id was erased
 * at exactly the moment it became interesting. The route then answered
 * `no_session_yet` for a step whose conversation was alive and whose id the
 * workflow itself still knew (`chainSession` had kept it). `completeStep` now
 * COALESCEs the session, like `markStepWaiting` already did.
 *
 * What's covered here:
 *
 *  1. **The data** — that a step failed by its judge, by an unparseable verdict,
 *     by a judge that could not run, and by a plain exec failure all keep a
 *     session id an operator can resume, and that a failure carrying no session
 *     never erases the one already on the step.
 *  2. **The route** — end-to-end over HTTP: the per-step open-terminal endpoint
 *     spawns the resume command for a judge-failed step instead of refusing it.
 *     Terminal spawning is faked, as in server.test.ts — no windows open here.
 *  3. **The button** — read off StepItem.tsx's source, in the style of
 *     canvas-view.test.ts: that it is gated on failed as well as waiting, that
 *     it sits in the same action row reusing the same handler and stays disabled
 *     with no session, and that Continue/Add step are still waiting-only.
 *
 * Same throwaway-home convention as the other suites.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-step-open-conversation-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
// Isolated for the same reason server.test.ts isolates it: creating a workflow
// writes an awb hook, which must not land in the operator's real broker.
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { getStep, markStepJudging, markStepRunning } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { _impl: terminalImpl } = await import("./terminal.ts");
const { onStepResult } = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
test.after(() => server.close());

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

let seq = 0;

/**
 * A workflow with one judged step, created through the real routes so it has a
 * hook and a resolvable workdir — the open-terminal route needs both.
 */
async function createJudgedStep(): Promise<{ workflowId: string; stepId: string }> {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: `open-conversation ${++seq}` }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const stepRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "ship it", acceptanceCriteria: "it must be shipped" }),
	});
	assert.equal(stepRes.status, 200);
	const body = (await stepRes.json()) as { step: { id: string } };
	return { workflowId: created.workflow.id, stepId: body.step.id };
}

/**
 * Drives a step to the point the judge has it: the exec run finished in
 * `sessionId` and its result is stored, exactly as `onStepResult` leaves it
 * before dispatching the judge. The next callback is a verdict.
 */
async function intoJudge(sessionId: string): Promise<{ workflowId: string; stepId: string }> {
	const { workflowId, stepId } = await createJudgedStep();
	markStepRunning(stepId);
	markStepJudging(stepId, { result: "shipped it", sessionId });
	assert.equal(getStep(stepId)?.sessionId, sessionId, "the exec run's session is on the step before the verdict lands");
	return { workflowId, stepId };
}

// --- 1. a failed step still knows which conversation it ran in --------------

test("a step rejected by its judge keeps the session it ran in", async () => {
	// The plain case: no retry budget, so the reject is final and the step fails.
	const { stepId } = await intoJudge("sess-judged");

	await onStepResult(stepId, { ok: true, result: '{"ok": false, "reason": "it was not shipped"}' }, cfg, silent);

	const failed = getStep(stepId)!;
	assert.equal(failed.status, "failed");
	assert.match(String(failed.error), /rejected by the judge/);
	assert.equal(failed.sessionId, "sess-judged", "the conversation the work happened in is still reachable");
});

test("a step failed by an unparseable verdict keeps its session", async () => {
	const { stepId } = await intoJudge("sess-unparseable");

	await onStepResult(stepId, { ok: true, result: "I could not decide, sorry" }, cfg, silent);

	assert.equal(getStep(stepId)?.status, "failed");
	assert.equal(getStep(stepId)?.sessionId, "sess-unparseable");
});

test("a step failed because the judge itself died keeps its session", async () => {
	// Nothing at all is known about the verdict here — but the exec run that
	// produced the result still happened, in a conversation worth reading.
	const { stepId } = await intoJudge("sess-judge-died");

	await onStepResult(stepId, { ok: false, error: "hook unreachable" }, cfg, silent);

	assert.equal(getStep(stepId)?.status, "failed");
	assert.equal(getStep(stepId)?.sessionId, "sess-judge-died");
});

test("a plain exec failure records the session the failing run reported", async () => {
	const { stepId } = await createJudgedStep();
	markStepRunning(stepId);

	await onStepResult(stepId, { ok: false, error: "boom", sessionId: "sess-exec-failure" }, cfg, silent);

	assert.equal(getStep(stepId)?.status, "failed");
	assert.equal(getStep(stepId)?.sessionId, "sess-exec-failure");
});

test("a failure that reports no session does not erase the one the step already had", async () => {
	// The COALESCE, stated directly: "I have nothing to add" is not "there was no
	// conversation". Anything that genuinely invalidates a session (beginRetry,
	// startManualRun) nulls it explicitly instead.
	const { stepId } = await intoJudge("sess-still-there");

	await onStepResult(stepId, { ok: true, result: '{"ok": false, "reason": "no"}' }, cfg, silent);

	assert.equal(getStep(stepId)?.sessionId, "sess-still-there");
});

// --- 2. the button's target actually resolves ------------------------------

test("POST .../steps/:stepId/open-terminal resumes a judge-failed step's own conversation", async (t) => {
	const { workflowId, stepId } = await intoJudge("sess-failed-step");
	await onStepResult(stepId, { ok: true, result: '{"ok": false, "reason": "nope"}' }, cfg, silent);
	assert.equal(getStep(stepId)?.status, "failed", "the step under test really is failed");

	const detail = (await (await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() })).json()) as {
		workflow: { workdir: string };
	};

	const calls: { bin: string; args: string[] }[] = [];
	const originalSpawn = terminalImpl.spawn;
	t.after(() => {
		terminalImpl.spawn = originalSpawn;
	});
	terminalImpl.spawn = ((bin: string, args: string[]) => {
		calls.push({ bin, args });
		return {
			once(event: string, cb: () => void) {
				if (event === "spawn") cb();
			},
			unref() {},
		};
	}) as unknown as typeof terminalImpl.spawn;

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${stepId}/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	// The regression this pins: it used to be 400 no_session_yet.
	assert.equal(res.status, 200);
	const body = (await res.json()) as { ok: boolean; sessionId: string; workdir: string };
	assert.equal(body.ok, true);
	assert.equal(body.sessionId, "sess-failed-step", "and it is THIS step's conversation, not the workflow's newest");
	assert.equal(body.workdir, detail.workflow.workdir);

	assert.equal(calls.length, 1);
	assert.match(calls[0].args.at(-1) ?? "", /^cd '.*' && claude --resume 'sess-failed-step'; exec bash$/);
});

// --- 3. the button is rendered for a failed step ---------------------------

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src");
const stepItem = fs.readFileSync(path.join(uiDir, "views/StepItem.tsx"), "utf8");

test("the step card offers Open conversation on a failed step, not only a held one", () => {
	assert.match(stepItem, /const failed = step\.status === "failed";/);
	// Both states, one condition — the button is about there being a conversation
	// to reopen, which is true of a held step and of a failed one.
	assert.match(stepItem, /const conversational = waiting \|\| failed;/);
	assert.match(stepItem, /\{conversational && \(/, "the button is gated on that condition");
});

test("Open conversation is one button in the step's action row, not a second parallel one", () => {
	// Exactly one, reusing the existing handler and the shared button classes so
	// it sits in the same row as Abort/Edit/Remove/Set status….
	assert.equal(stepItem.match(/>\s*Open conversation\s*</g)?.length, 1, "one Open conversation button in the file");
	assert.equal(stepItem.match(/onOpenConversation\(step\.id\)/g)?.length, 1, "wired to the one existing handler");

	const button = stepItem.slice(
		stepItem.indexOf("{conversational && ("),
		stepItem.indexOf("Open conversation", stepItem.indexOf("{conversational && (")),
	);
	assert.match(button, /className="btn btn--sm"/, "the same button styling as its neighbours");
	// Rendered inside styles.actions, i.e. before the Abort button that closes
	// out the row — not floated somewhere above it next to the result panes.
	const row = stepItem.indexOf("<div className={styles.actions}>");
	assert.ok(row > -1 && row < stepItem.indexOf("{conversational && ("));
	assert.ok(stepItem.indexOf("{conversational && (") < stepItem.indexOf("Abort\n"));
});

test("Open conversation stays disabled, and says why, when the step reported no session", () => {
	// A step can fail before awb ever names a session (a dispatch that died on
	// the hook). Showing a live button that 400s would be worse than showing none.
	const button = stepItem.slice(stepItem.indexOf("{conversational && ("), stepItem.indexOf("{waiting && (", stepItem.indexOf("{conversational && (")));
	assert.match(button, /disabled=\{!step\.sessionId \|\| busy\}/);
	assert.match(button, /never reported a session/);
	// And when there is one, the failure case explains what the button is for.
	assert.match(button, /before it failed/);
});

test("Continue and Add step are still offered only while the gate is holding", () => {
	// Widening one button must not widen the other two: the server refuses
	// Continue on any other status, and there is nothing to insert a correction
	// after on a step nobody is being asked to approve.
	for (const label of ["Continue", "Add step"]) {
		const at = stepItem.indexOf(`\t\t\t\t\t\t${label}\n`);
		assert.ok(at > -1, `${label} is rendered`);
		const opensAt = stepItem.lastIndexOf("{waiting && (", at);
		const otherwise = stepItem.lastIndexOf("{conversational && (", at);
		assert.ok(opensAt > otherwise, `${label} is inside a waiting-only block`);
	}
});
