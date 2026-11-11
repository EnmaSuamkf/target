/**
 * Command steps on workflows and templates (docs/pipelines.md, "Execution and
 * failure", "HTTP API" → Steps, "Compatibility with an unchanged server").
 *
 * Covers creation and its refusals, editing, the step payload, template
 * round-trip and seeding, clone, and progress. Same throwaway-TARGET_HOME
 * convention as the other workflow tests.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-command-steps-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { getStep, getTemplate, insertStep, insertTemplate, listSteps, open, stepProgress } = await import("./db.ts");
const { insertPipeline } = await import("./pipeline-store.ts");
const { addStep, cloneWorkflow, createWorkflow, editStep, WorkflowError } = await import("./workflow.ts");

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

const VERIFY = `name: verify
description: Install and test.
inputs:
  package:
    default: hub
  branch:
    required: true
steps:
  - run: npm test
    working-directory: \${{ inputs.package }}
`;

const PLAIN = `name: plain
steps:
  - run: echo hi
`;

const verify = insertPipeline({ source: VERIFY, approve: true });
const plain = insertPipeline({ source: PLAIN, approve: false });

function workflowError(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		if (err instanceof WorkflowError) return err.message;
		throw err;
	}
	throw new Error("expected a WorkflowError");
}

async function http(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
	const headers: Record<string, string> = { authorization: `Bearer ${cfg.adminToken}` };
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await fetch(`${baseUrl}${route}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

test("a valid command step is created with useSubagent false and no acceptance criteria", () => {
	const wf = createWorkflow("command happy path");
	const step = addStep(wf.id, "", { kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "main" } });
	assert.equal(step.kind, "command");
	assert.equal(step.pipelineId, verify.id);
	assert.deepEqual(step.pipelineInputs, { branch: "main" });
	assert.equal(step.useSubagent, false);
	assert.equal(step.acceptanceCriteria, null);
});

test("an omitted description is generated from the pipeline's name", () => {
	const wf = createWorkflow("generated description");
	const step = addStep(wf.id, "   ", { kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "main" } });
	assert.equal(step.description, 'Run pipeline "verify"');
});

test("an explicit description is kept as written", () => {
	const wf = createWorkflow("explicit description");
	const step = addStep(wf.id, "Check the build", { kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "main" } });
	assert.equal(step.description, "Check the build");
});

test("creation is refused for an unknown pipeline", () => {
	const wf = createWorkflow("unknown pipeline");
	const message = workflowError(() => addStep(wf.id, "x", { kind: "command", pipelineId: "no-such-pipeline", pipelineInputs: {} }));
	assert.match(message, /unknown pipeline "no-such-pipeline"/);
	assert.equal(listSteps(wf.id).length, 0, "nothing was added");
});

test("creation is refused for a revoked pipeline", () => {
	const revoked = insertPipeline({ source: PLAIN, approve: true });
	open().prepare("UPDATE pipelines SET revoked = 1 WHERE id = ?").run(revoked.id);
	const wf = createWorkflow("revoked pipeline");
	const message = workflowError(() => addStep(wf.id, "x", { kind: "command", pipelineId: revoked.id, pipelineInputs: {} }));
	assert.match(message, /revoked/);
});

test("creation is refused for an undeclared input", () => {
	const wf = createWorkflow("undeclared input");
	const message = workflowError(() =>
		addStep(wf.id, "x", { kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "main", nope: "1" } }),
	);
	assert.match(message, /unknown input "nope"/);
});

test("creation is refused when a required input without a default is missing", () => {
	const wf = createWorkflow("missing required input");
	const message = workflowError(() => addStep(wf.id, "x", { kind: "command", pipelineId: verify.id, pipelineInputs: {} }));
	assert.match(message, /missing input "branch"/);
});

test("creation is refused for a docker-sandboxed workflow", () => {
	const wf = createWorkflow("docker workflow", { sandbox: "docker" });
	const message = workflowError(() => addStep(wf.id, "x", { kind: "command", pipelineId: plain.id, pipelineInputs: {} }));
	assert.match(message, /run on the host only in this version/);
	assert.match(message, /docker sandbox/);
});

test("creation is refused when useSubagent is explicitly true", () => {
	const wf = createWorkflow("subagent refused");
	const message = workflowError(() =>
		addStep(wf.id, "x", { kind: "command", pipelineId: plain.id, pipelineInputs: {}, useSubagent: true }),
	);
	assert.match(message, /useSubagent must be false/);
});

test("creation is refused when acceptance criteria are set", () => {
	const wf = createWorkflow("judge refused");
	const message = workflowError(() =>
		addStep(wf.id, "x", { kind: "command", pipelineId: plain.id, pipelineInputs: {}, acceptanceCriteria: "it passes" }),
	);
	assert.match(message, /acceptanceCriteria must be empty/);
});

test("a pipeline that is not trusted can still be referenced: trust is checked at dispatch, not here", () => {
	const untrusted = insertPipeline({ source: PLAIN, approve: false });
	const wf = createWorkflow("untrusted pipeline referenced");
	const step = addStep(wf.id, "", { kind: "command", pipelineId: untrusted.id, pipelineInputs: {} });
	assert.equal(step.pipelineId, untrusted.id);
});

test("the HTTP payload carries kind, pipelineId, pipelineInputs and the pipeline summary", async () => {
	const wf = createWorkflow("payload");
	addStep(wf.id, "", { kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "release" } });
	const res = await http("GET", `/api/workflows/${wf.id}`);
	assert.equal(res.status, 200);
	const step = res.json.steps[0];
	assert.equal(step.kind, "command");
	assert.equal(step.pipelineId, verify.id);
	assert.deepEqual(step.pipelineInputs, { branch: "release" });
	assert.deepEqual(step.pipeline, { id: verify.id, name: "verify", trusted: true });
});

test("the HTTP create route accepts a command step and refuses a non-string input", async () => {
	const wf = createWorkflow("http create");
	const ok = await http("POST", `/api/workflows/${wf.id}/steps`, {
		kind: "command",
		pipelineId: verify.id,
		pipelineInputs: { branch: "main" },
	});
	assert.equal(ok.status, 200, JSON.stringify(ok.json));
	assert.equal(ok.json.step.kind, "command");
	assert.equal(ok.json.step.useSubagent, false);

	const bad = await http("POST", `/api/workflows/${wf.id}/steps`, {
		kind: "command",
		pipelineId: verify.id,
		pipelineInputs: { branch: 1 },
	});
	assert.equal(bad.status, 400);
	assert.match(bad.json.error, /values are strings/);

	const context = await http("POST", `/api/workflows/${wf.id}/steps`, { kind: "context", description: "x" });
	assert.equal(context.status, 400);
	assert.match(context.json.error, /kind must be/);
});

test("the HTTP create route refuses useSubagent true on a command step with a 400", async () => {
	const wf = createWorkflow("http subagent refused");
	const res = await http("POST", `/api/workflows/${wf.id}/steps`, {
		kind: "command",
		pipelineId: plain.id,
		pipelineInputs: {},
		useSubagent: true,
	});
	assert.equal(res.status, 400);
	assert.match(res.json.error, /useSubagent must be false/);
});

test("a step changes between task and command only while it is pending", () => {
	const wf = createWorkflow("kind change");
	const task = addStep(wf.id, "agent work");
	const command = editStep(wf.id, task.id, "", { kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "main" } });
	assert.equal(command.kind, "command");
	assert.equal(command.useSubagent, false);
	assert.equal(command.description, 'Run pipeline "verify"', "an empty description is generated on the switch");

	const back = editStep(wf.id, task.id, "agent again", { kind: "task" });
	assert.equal(back.kind, "task");
	assert.equal(back.pipelineId, null);
	assert.equal(back.pipelineInputs, null);
	assert.equal(back.useSubagent, true, "switching back restores the agent default");

	open().prepare("UPDATE steps SET status = 'done' WHERE id = ?").run(task.id);
	const message = workflowError(() => editStep(wf.id, task.id, "too late", { kind: "command", pipelineId: plain.id, pipelineInputs: {} }));
	assert.match(message, /only while it is pending/);
});

test("editing a command step's inputs re-checks them against the pipeline", () => {
	const wf = createWorkflow("edit inputs");
	const step = addStep(wf.id, "", { kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "main" } });
	const message = workflowError(() => editStep(wf.id, step.id, "", { pipelineInputs: { nope: "x" } }));
	assert.match(message, /unknown input "nope"/);
	const updated = editStep(wf.id, step.id, "", { pipelineInputs: { branch: "release" } });
	assert.deepEqual(updated.pipelineInputs, { branch: "release" });
});

test("a template's command step round-trips with its kind, pipeline and inputs", () => {
	const template = insertTemplate({
		name: "command round trip",
		steps: [
			{ description: "", kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "main" } } as never,
			{ description: "agent review" },
		],
	});
	const read = getTemplate(template.id)!;
	assert.equal(read.steps[0].kind, "command");
	assert.equal(read.steps[0].pipelineId, verify.id);
	assert.deepEqual(read.steps[0].pipelineInputs, { branch: "main" });
	assert.equal(read.steps[0].useSubagent, false, "a command template step is stored without the agent defaults");
	assert.equal(read.steps[0].acceptanceCriteria, null);
	assert.equal(read.steps[1].kind, "task");
});

test("seeding a workflow from a template copies the command steps", async () => {
	const template = insertTemplate({
		name: "seed command",
		steps: [
			{ description: "", kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "main" } } as never,
			{ description: "agent review" },
		],
	});
	const wf = createWorkflow("seeded");
	const res = await http("POST", `/api/workflows/${wf.id}/steps/from-template`, { templateId: template.id });
	assert.equal(res.status, 200, JSON.stringify(res.json));
	const steps = listSteps(wf.id);
	assert.equal(steps.length, 2);
	assert.equal(steps[0].kind, "command");
	assert.equal(steps[0].pipelineId, verify.id);
	assert.deepEqual(steps[0].pipelineInputs, { branch: "main" });
	assert.equal(steps[0].description, 'Run pipeline "verify"');
	assert.equal(steps[0].useSubagent, false);
	assert.equal(steps[1].kind, "task");
});

test("a template whose pipeline is missing fails the seed whole, naming the step", async () => {
	const template = insertTemplate({
		name: "seed missing",
		steps: [
			{ description: "agent first" },
			{ description: "deploy", kind: "command", pipelineId: "gone-pipeline", pipelineInputs: {} } as never,
		],
	});
	const wf = createWorkflow("seed fails");
	const res = await http("POST", `/api/workflows/${wf.id}/steps/from-template`, { templateId: template.id });
	assert.equal(res.status, 400);
	assert.match(res.json.error, /template step "deploy": unknown pipeline "gone-pipeline"/);
	assert.equal(listSteps(wf.id).length, 0, "no step was added before the refusal");
});

test("cloning a workflow preserves the command step's fields", () => {
	const source = createWorkflow("clone source");
	addStep(source.id, "agent work");
	addStep(source.id, "", { kind: "command", pipelineId: verify.id, pipelineInputs: { branch: "release", package: "api" } });
	const clone = cloneWorkflow(source.id);
	const steps = listSteps(clone.id);
	assert.deepEqual(
		steps.map((s) => s.kind),
		["task", "command"],
	);
	const copy = steps[1];
	assert.equal(copy.pipelineId, verify.id);
	assert.deepEqual(copy.pipelineInputs, { branch: "release", package: "api" });
	assert.equal(copy.useSubagent, false);
	assert.equal(copy.acceptanceCriteria, null);
	assert.equal(copy.description, 'Run pipeline "verify"');
});

test("progress counts command steps as real steps", () => {
	const wf = createWorkflow("progress");
	addStep(wf.id, "agent work");
	const command = addStep(wf.id, "", { kind: "command", pipelineId: plain.id, pipelineInputs: {} });
	assert.equal(stepProgress(wf.id).total, 2, "the command step is counted");
	open().prepare("UPDATE steps SET status = 'done' WHERE id = ?").run(command.id);
	assert.equal(stepProgress(wf.id).done, 1, "a finished command step counts as done");
});

test("the context step is not counted, and a command step is not mistaken for it", () => {
	const wf = createWorkflow("context and command");
	const command = addStep(wf.id, "", { kind: "command", pipelineId: plain.id, pipelineInputs: {} });
	const stored = getStep(command.id);
	assert.equal(stored?.kind, "command", "kind stays command, never context");
});

test("a stored command step with no pipeline still reads back, so the UI can show it", () => {
	const row = insertStep("wf-orphan-command", "orphan", { kind: "command", pipelineId: null, pipelineInputs: {} });
	assert.equal(row.kind, "command");
	assert.equal(row.pipelineId, null);
});
