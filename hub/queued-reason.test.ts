/**
 * Tests for `resolveQueuedReason` and its exposure through GET /api/workflows/:id.
 *
 * Queued steps need a human-readable explanation of WHY they're waiting. The
 * hub derives it on read from in-flight steps and awb hook workdirs — nothing
 * is stored — so these tests pin the three heuristics and the HTTP round-trip.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-queued-reason-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { getStep, insertStep, markStepQueued, markStepRunning } = await import("./db.ts");
const { createWorkflow, resolveQueuedReason } = await import("./workflow.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

test("resolveQueuedReason returns null for a non-queued step", () => {
	const workflow = createWorkflow("not queued");
	const step = insertStep(workflow.id, "pending step");
	assert.equal(resolveQueuedReason(getStep(step.id)!), null);
});

test("resolveQueuedReason reports same_workflow_in_flight when another step in the workflow is running", () => {
	const workflow = createWorkflow("in flight locally");
	const first = insertStep(workflow.id, "running step");
	const second = insertStep(workflow.id, "queued behind");
	markStepRunning(first.id);
	markStepQueued(second.id);

	const resolved = resolveQueuedReason(getStep(second.id)!);
	assert.deepEqual(resolved, { queuedReason: "same_workflow_in_flight" });
});

test("resolveQueuedReason reports workdir_lock when another workflow on the same workdir is in flight", () => {
	const sharedWorkdir = path.join(tmpHome, "shared-checkout");
	const blockerWorkflow = createWorkflow("holds the lock", { workdir: sharedWorkdir });
	const blockedWorkflow = createWorkflow("waiting on the lock", { workdir: sharedWorkdir });
	const blockerStep = insertStep(blockerWorkflow.id, "running elsewhere");
	const queuedStep = insertStep(blockedWorkflow.id, "queued here");
	markStepRunning(blockerStep.id);
	markStepQueued(queuedStep.id);

	const resolved = resolveQueuedReason(getStep(queuedStep.id)!);
	assert.equal(resolved?.queuedReason, "workdir_lock");
	assert.deepEqual(resolved?.queueBlocker, {
		workflowId: blockerWorkflow.id,
		workflowName: blockerWorkflow.name,
		stepId: blockerStep.id,
	});
});

test("resolveQueuedReason reports awaiting_started when nothing else is in flight", () => {
	const workflow = createWorkflow("solo queued");
	const step = insertStep(workflow.id, "waiting for started");
	markStepQueued(step.id);

	const resolved = resolveQueuedReason(getStep(step.id)!);
	assert.deepEqual(resolved, { queuedReason: "awaiting_started" });
});

test("GET /api/workflows/:id exposes queuedReason and queueBlocker on queued steps", async () => {
	const sharedWorkdir = path.join(tmpHome, "api-shared-checkout");
	const blockerWorkflow = createWorkflow("api blocker", { workdir: sharedWorkdir });
	const blockedWorkflow = createWorkflow("api blocked", { workdir: sharedWorkdir });
	const blockerStep = insertStep(blockerWorkflow.id, "running on shared workdir");
	const queuedStep = insertStep(blockedWorkflow.id, "queued on shared workdir");
	markStepRunning(blockerStep.id);
	markStepQueued(queuedStep.id);

	const res = await fetch(`${baseUrl}/api/workflows/${blockedWorkflow.id}`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		steps: Array<{ id: string; status: string; queuedReason?: string; queueBlocker?: Record<string, string> }>;
	};
	const step = body.steps.find((s) => s.id === queuedStep.id);
	assert.ok(step);
	assert.equal(step.status, "queued");
	assert.equal(step.queuedReason, "workdir_lock");
	assert.deepEqual(step.queueBlocker, {
		workflowId: blockerWorkflow.id,
		workflowName: blockerWorkflow.name,
		stepId: blockerStep.id,
	});

	const soloRes = await fetch(`${baseUrl}/api/workflows/${blockerWorkflow.id}`, { headers: adminHeaders() });
	const soloBody = (await soloRes.json()) as {
		steps: Array<{ id: string; status: string; queuedReason?: string }>;
	};
	const running = soloBody.steps.find((s) => s.id === blockerStep.id);
	assert.ok(running);
	assert.equal(running.status, "running");
	assert.equal(running.queuedReason, undefined);

	const awaitingWorkflow = createWorkflow("api awaiting");
	const awaitingStep = insertStep(awaitingWorkflow.id, "broker accepted");
	markStepQueued(awaitingStep.id);
	const awaitingRes = await fetch(`${baseUrl}/api/workflows/${awaitingWorkflow.id}`, { headers: adminHeaders() });
	const awaitingBody = (await awaitingRes.json()) as {
		steps: Array<{ id: string; queuedReason?: string; queueBlocker?: unknown }>;
	};
	const awaiting = awaitingBody.steps.find((s) => s.id === awaitingStep.id);
	assert.ok(awaiting);
	assert.equal(awaiting.queuedReason, "awaiting_started");
	assert.equal(awaiting.queueBlocker, undefined);
});
