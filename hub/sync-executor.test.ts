/**
 * Unit tests for the remote-sync command executor (sync.ts).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, beforeEach } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-executor-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".awb");

const { executeSyncCommand, resetSyncExecutorState, resolveLocalWorkflowId } = await import("./sync.ts");
type SyncCommand = import("./sync.ts").SyncCommand;
const { loadConfig } = await import("./config.ts");
const { getWorkflowByRemoteId, getSyncStepMap, listSteps } = await import("./db.ts");
const { forceStepStatus, forceWorkflowStatus } = await import("./workflow.ts");

const cfg = loadConfig();
let remoteSeq = 0;

function nextRemoteId(): string {
	remoteSeq += 1;
	return `rwf_executor_${remoteSeq}`;
}

function command(
	remoteId: string,
	id: string,
	type: string,
	payload: Record<string, unknown> = {},
): SyncCommand {
	return {
		id,
		type,
		remote_id: remoteId,
		sequence: 1,
		payload,
		status: "delivered",
	};
}

function taskSteps(workflowId: string) {
	return listSteps(workflowId).filter((s) => s.kind === "task");
}

beforeEach(() => {
	resetSyncExecutorState();
});

test("workflow.create maps remote_id to a local workflow with origin=remote", async () => {
	const remoteId = nextRemoteId();
	const result = await executeSyncCommand(
		command(remoteId, "cmd_create", "workflow.create", { name: "Remote workflow" }),
		cfg,
	);
	assert.equal(result.noop, false);
	assert.ok(result.localId);

	const localId = resolveLocalWorkflowId(remoteId);
	assert.equal(localId, result.localId);

	const workflow = getWorkflowByRemoteId(remoteId);
	assert.ok(workflow);
	assert.equal(workflow!.origin, "remote");
	assert.equal(workflow!.remoteId, remoteId);
	assert.equal(workflow!.name, "Remote workflow");
});

test("step.add registers step_key in the remote map", async () => {
	const remoteId = nextRemoteId();
	await executeSyncCommand(command(remoteId, "cmd_create", "workflow.create", { name: "Steps" }), cfg);
	const localId = resolveLocalWorkflowId(remoteId)!;

	await executeSyncCommand(
		command(remoteId, "cmd_add", "step.add", {
			step_key: "plan",
			description: "Plan the work",
		}),
		cfg,
	);

	const map = getSyncStepMap(remoteId);
	assert.ok(map.plan);
	const steps = taskSteps(localId);
	assert.equal(steps.length, 1);
	assert.equal(steps[0]!.description, "Plan the work");
	assert.equal(steps[0]!.id, map.plan);
});

test("workflow.start respects step_keys selection", async () => {
	const remoteId = nextRemoteId();
	await executeSyncCommand(command(remoteId, "cmd_create", "workflow.create", { name: "Pick steps" }), cfg);
	await executeSyncCommand(
		command(remoteId, "cmd_add1", "step.add", { step_key: "s1", description: "First" }),
		cfg,
	);
	await executeSyncCommand(
		command(remoteId, "cmd_add2", "step.add", { step_key: "s2", description: "Second" }),
		cfg,
	);

	await executeSyncCommand(
		command(remoteId, "cmd_start", "workflow.start", { step_keys: ["s2"] }),
		cfg,
	);

	const workflow = getWorkflowByRemoteId(remoteId);
	const map = getSyncStepMap(remoteId);
	const steps = listSteps(workflow!.id).filter((s) => s.kind === "task");
	const s1 = steps.find((s) => s.id === map.s1);
	const s2 = steps.find((s) => s.id === map.s2);
	assert.equal(s1?.selected, false);
	assert.equal(s2?.selected, true);
});

test("workflow.restart runs only step_keys selected, not the whole workflow", async () => {
	const remoteId = nextRemoteId();
	await executeSyncCommand(command(remoteId, "cmd_create", "workflow.create", { name: "Subset" }), cfg);
	for (const [key, desc] of [
		["s1", "First"],
		["s2", "Second"],
		["s3", "Third"],
	] as const) {
		await executeSyncCommand(
			command(remoteId, `cmd_add_${key}`, "step.add", { step_key: key, description: desc }),
			cfg,
		);
	}
	const localId = resolveLocalWorkflowId(remoteId)!;
	const map = getSyncStepMap(remoteId);
	for (const key of ["s1", "s2", "s3"] as const) {
		forceStepStatus(localId, map[key]!, "done", () => {});
	}
	forceWorkflowStatus(localId, "completed", () => {});

	await executeSyncCommand(
		command(remoteId, "cmd_restart", "workflow.restart", { step_keys: ["s2"] }),
		cfg,
	);

	const steps = taskSteps(localId);
	const byKey = (key: string) => steps.find((s) => s.id === map[key]);
	assert.equal(byKey("s1")?.status, "done");
	assert.equal(byKey("s1")?.selected, false);
	assert.equal(byKey("s3")?.status, "done");
	assert.equal(byKey("s3")?.selected, false);
	assert.notEqual(byKey("s2")?.status, "done");
	assert.equal(byKey("s2")?.selected, true);
});

test("workflow.start re-runs completed steps via restart", async () => {
	const remoteId = nextRemoteId();
	await executeSyncCommand(command(remoteId, "cmd_create", "workflow.create", { name: "Re-run" }), cfg);
	await executeSyncCommand(
		command(remoteId, "cmd_add", "step.add", { step_key: "s1", description: "Do it" }),
		cfg,
	);
	const localId = resolveLocalWorkflowId(remoteId)!;
	const map = getSyncStepMap(remoteId);
	forceStepStatus(localId, map.s1!, "done", () => {});
	forceWorkflowStatus(localId, "completed", () => {});

	await executeSyncCommand(
		command(remoteId, "cmd_start", "workflow.start", { step_keys: ["s1"] }),
		cfg,
	);

	const step = taskSteps(localId)[0];
	assert.notEqual(step!.status, "done");
	const workflow = getWorkflowByRemoteId(remoteId);
	assert.equal(workflow!.status, "running");
});

test("workflow.start rejects missing step_keys", async () => {
	const remoteId = nextRemoteId();
	await executeSyncCommand(command(remoteId, "cmd_create", "workflow.create", { name: "Run" }), cfg);
	await executeSyncCommand(
		command(remoteId, "cmd_add", "step.add", { step_key: "s1", description: "Do it" }),
		cfg,
	);

	await assert.rejects(
		() => executeSyncCommand(command(remoteId, "cmd_start", "workflow.start"), cfg),
		/ step_keys required /,
	);
});

test("workflow.start sets the workflow status to running", async () => {
	const remoteId = nextRemoteId();
	await executeSyncCommand(command(remoteId, "cmd_create", "workflow.create", { name: "Run" }), cfg);
	await executeSyncCommand(
		command(remoteId, "cmd_add", "step.add", { step_key: "s1", description: "Do it" }),
		cfg,
	);

	await executeSyncCommand(
		command(remoteId, "cmd_start", "workflow.start", { step_keys: ["s1"] }),
		cfg,
	);

	const workflow = getWorkflowByRemoteId(remoteId);
	assert.equal(workflow!.status, "running");
});

test("workflow.pause pauses a running workflow", async () => {
	const remoteId = nextRemoteId();
	await executeSyncCommand(command(remoteId, "cmd_create", "workflow.create", { name: "Pause me" }), cfg);
	await executeSyncCommand(
		command(remoteId, "cmd_add", "step.add", { step_key: "s1", description: "Do it" }),
		cfg,
	);
	await executeSyncCommand(
		command(remoteId, "cmd_start", "workflow.start", { step_keys: ["s1"] }),
		cfg,
	);

	await executeSyncCommand(command(remoteId, "cmd_pause", "workflow.pause"), cfg);

	const workflow = getWorkflowByRemoteId(remoteId);
	assert.equal(workflow!.status, "paused");
});

test("workflow.delete succeeds when the remote workflow is already gone locally", async () => {
	const remoteId = nextRemoteId();
	await assert.doesNotReject(() =>
		executeSyncCommand(command(remoteId, "cmd_delete_gone", "workflow.delete"), cfg),
	);
	assert.equal(getWorkflowByRemoteId(remoteId), null);
});

test("duplicate command_id is a no-op", async () => {
	const remoteId = nextRemoteId();
	const create = command(remoteId, "cmd_dup", "workflow.create", { name: "Once" });
	const first = await executeSyncCommand(create, cfg);
	assert.equal(first.noop, false);

	const second = await executeSyncCommand(create, cfg);
	assert.equal(second.noop, true);
	assert.equal(second.localId, first.localId);
	assert.equal(taskSteps(resolveLocalWorkflowId(remoteId)!).length, 0);

	const localId = resolveLocalWorkflowId(remoteId)!;
	const addCmd = command(remoteId, "cmd_add_once", "step.add", {
		step_key: "k1",
		description: "Only one",
	});
	const addFirst = await executeSyncCommand(addCmd, cfg);
	assert.equal(addFirst.noop, false);
	const stepsBefore = taskSteps(localId).length;

	const addSecond = await executeSyncCommand(addCmd, cfg);
	assert.equal(addSecond.noop, true);
	assert.equal(taskSteps(localId).length, stepsBefore);
});
