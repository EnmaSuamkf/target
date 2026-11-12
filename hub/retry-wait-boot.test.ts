/**
 * Tests for the boot check of retry waits (plan 4.2.5).
 *
 * A retry wait's timer lives in memory. When the hub restarts during a wait, the
 * step is left `pending` with a `retry_at` and no timer behind it. The boot
 * check (`reconcileOrphanRetryWaits`, called from hub/daemon.ts) clears that
 * wait, pauses an idle running workflow, and dispatches NOTHING: a re-run the
 * operator did not ask for after a restart is the one thing this must not do.
 *
 * The daemon itself is not imported here (it binds a port). Its call order is
 * checked by reading the source, the same way canvas-view.test.ts reads the UI.
 *
 * Throwaway TARGET_HOME. The workflows point at a fake hook that records every
 * dispatch it receives, so "dispatched nothing" is observed, not assumed.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-retry-wait-boot-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;

const { beginRetry, getStep, getWorkflow, insertStep, insertWorkflow, markStepRunning, setWorkflowStatus } = await import(
	"./db.ts"
);
const { reconcileOrphanRetryWaits } = await import("./workflow.ts");

/** Every dispatch the fake hook received, by job id. It answers ok and never calls back. */
const dispatchedJobIds: string[] = [];
const fakeHook = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk: Buffer) => {
		body += chunk.toString();
	});
	req.on("end", () => {
		try {
			const parsed = JSON.parse(body) as { jobId?: unknown };
			if (typeof parsed.jobId === "string") dispatchedJobIds.push(parsed.jobId);
		} catch {
			// Not a dispatch body; answer anyway.
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => fakeHook.listen(0, "127.0.0.1", resolve));
const fakeHookAddress = fakeHook.address();
if (!fakeHookAddress || typeof fakeHookAddress === "string") throw new Error("fake hook did not bind a port");
const fakeHookUrl = `http://127.0.0.1:${fakeHookAddress.port}/hook/agent`;
test.after(() => {
	fakeHook.close();
});

let seq = 0;

/** A workflow on the fake hook with one pending step, carrying a live retry wait of `waitSeconds`. */
function workflowWithWait(status: "running" | "paused", waitSeconds = 60) {
	const id = `wf-boot-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `boot ${id}`,
		agentName: `agent-${id}`,
		hookUrl: fakeHookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const step = insertStep(id, "waiting step");
	beginRetry(step.id, waitSeconds);
	setWorkflowStatus(id, status);
	return { workflow, step };
}

/** The boot check, with its log lines collected. */
function runBootCheck(): string[] {
	const lines: string[] = [];
	reconcileOrphanRetryWaits((message) => {
		lines.push(message);
	});
	return lines;
}

test("a pending step with retry_at in a running workflow is cleared, and the workflow is paused", () => {
	const { workflow, step } = workflowWithWait("running");
	assert.notEqual(getStep(step.id)?.retryAt, null, "precondition: the step is in a retry wait");

	const lines = runBootCheck();

	assert.equal(getStep(step.id)?.retryAt, null, "the interrupted wait is cleared");
	assert.equal(getStep(step.id)?.status, "pending", "the step is left pending, not run");
	assert.equal(getWorkflow(workflow.id)?.status, "paused", "an idle running workflow is paused");
	assert.ok(
		lines.includes(`retry wait of step ${step.id} was interrupted by a restart; press Start to run it`),
		"the interrupted-wait line is logged",
	);
	assert.equal(dispatchedJobIds.includes(step.id), false, "nothing is dispatched at boot");
});

test("a pending step with retry_at in a paused workflow is cleared, and the workflow stays paused", () => {
	const { workflow, step } = workflowWithWait("paused");

	const lines = runBootCheck();

	assert.equal(getStep(step.id)?.retryAt, null, "the interrupted wait is cleared");
	assert.equal(getStep(step.id)?.status, "pending");
	assert.equal(getWorkflow(workflow.id)?.status, "paused", "a paused workflow is not touched beyond the cleared wait");
	assert.ok(lines.includes(`retry wait of step ${step.id} was interrupted by a restart; press Start to run it`));
	assert.equal(dispatchedJobIds.includes(step.id), false, "nothing is dispatched at boot");
});

test("a running workflow with another step still in flight keeps running", () => {
	const { workflow, step } = workflowWithWait("running");
	const busy = insertStep(workflow.id, "still running");
	markStepRunning(busy.id);

	runBootCheck();

	assert.equal(getStep(step.id)?.retryAt, null, "the wait is still cleared");
	assert.equal(getWorkflow(workflow.id)?.status, "running", "pauseIfIdle leaves a workflow with work in flight alone");
	assert.equal(getStep(busy.id)?.status, "running", "the step in flight is not touched");
	assert.equal(dispatchedJobIds.includes(step.id), false);
});

test("the daemon runs the retry-wait check after the command-step check and before the server is created", () => {
	const daemonSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts"), "utf8");
	// The import lines carry no parentheses, so these match the calls only.
	const commandCheck = daemonSource.indexOf("failCommandStepsLeftByRestart(log)");
	const retryCheck = daemonSource.indexOf("reconcileOrphanRetryWaits(log)");
	const serverCreated = daemonSource.indexOf("createServer(cfg, log)");

	assert.ok(commandCheck > 0, "the command-step check is called");
	assert.ok(retryCheck > commandCheck, "the retry-wait check runs after the command-step check");
	assert.ok(serverCreated > retryCheck, "the retry-wait check runs before the server is created");
});
