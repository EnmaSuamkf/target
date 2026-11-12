/**
 * A command step's branch agents (docs/pipelines.md, "Branch agents"): an
 * on-success agent after a passing pipeline, an on-failure agent after each
 * failed one (before the next retry), no acceptance criteria and no judge.
 *
 * The pipelines run real shell commands in a temporary workdir. The awb hook is
 * a stubbed fetch that accepts every dispatch and records its prompt; the test
 * plays the broker by calling `onStepResult`, as the result callback would.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-branch-agents-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { loadConfig } = await import("./config.ts");
const { getStep, getWorkflow, insertTemplate, getTemplate } = await import("./db.ts");
const { insertPipeline } = await import("./pipeline-store.ts");
const { listPipelineRunsForStep } = await import("./pipeline-runs.ts");
const { abortStep, addStep, createWorkflow, editStep, onStepResult, startWorkflow, WorkflowError } = await import(
	"./workflow.ts"
);

const cfg = loadConfig();
const silent = () => {};

const workdirs: string[] = [];
function freshWorkdir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "target-branch-agents-wd-"));
	workdirs.push(dir);
	return dir;
}

/** Every request, with the parsed body of a dispatch. */
const requests: { url: string; body: Record<string, unknown> | null }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	let body: Record<string, unknown> | null = null;
	try {
		body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
	} catch {
		body = null;
	}
	requests.push({ url, body });
	if (url.endsWith("/abort")) {
		return new Response(JSON.stringify({ result: "killed", exited: true, signal: "SIGTERM" }), { status: 200 });
	}
	return new Response("{}", { status: 200 });
}) as typeof fetch;

test.after(() => {
	globalThis.fetch = realFetch;
	for (const dir of workdirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the engine");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** The prompts dispatched to this workflow's hook, oldest first. */
function dispatches(workflowId: string): { jobId: string; input: string }[] {
	const hook = getWorkflow(workflowId)!.hookUrl;
	return requests
		.filter((r) => r.url === hook && r.body && typeof r.body.input === "string")
		.map((r) => ({ jobId: String(r.body!.jobId), input: String(r.body!.input) }));
}

function pipelineWith(name: string, steps: string, approve = true): { id: string } {
	return insertPipeline({ source: `name: ${name}\nsteps:\n${steps}`, approve });
}

test("a passing pipeline runs the on-success agent with the report, and no judge; its answer completes the step", async () => {
	const wf = createWorkflow("on success", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("build", `  - name: Build\n    run: echo built\n`);
	const step = addStep(wf.id, "", {
		kind: "command",
		pipelineId: pipeline.id,
		pipelineInputs: {},
		onSuccessTask: "Write the release notes.",
		onFailureTask: "Fix the build.",
	});
	assert.equal(step.onSuccessTask, "Write the release notes.");
	assert.equal(step.acceptanceCriteria, null);

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => dispatches(wf.id).length === 1);

	const running = getStep(step.id)!;
	assert.equal(running.status, "running", "the step holds while its agent works");
	assert.equal(running.phase, "on_success");
	const [prompt] = dispatches(wf.id);
	assert.equal(prompt.jobId, step.id);
	assert.match(prompt.input, /The hub ran these pipelines since your last step:/);
	assert.match(prompt.input, /"build"/);
	assert.match(prompt.input, /The pipeline of this command step passed\. Your task:\n\nWrite the release notes\./);
	assert.doesNotMatch(prompt.input, /Fix the build/, "only the matching branch runs");
	assert.doesNotMatch(prompt.input, /acceptance criteri/i, "no criterion: nothing is judged");

	await onStepResult(step.id, { ok: true, result: "Notes written.", sessionId: "sess-1" }, cfg, silent);
	await until(() => getWorkflow(wf.id)?.status === "completed");

	const done = getStep(step.id)!;
	assert.equal(done.status, "done");
	assert.match(done.result ?? "", /On-success agent:\nNotes written\./);
	assert.equal(done.sessionId, "sess-1");
	assert.equal(getWorkflow(wf.id)!.lastSessionId, "sess-1", "the next step resumes the agent's conversation");
	assert.equal(dispatches(wf.id).length, 1, "no judge was dispatched");
});

test("a failing pipeline runs the on-failure agent before each retry, and a fixed run settles the step", async () => {
	const workdir = freshWorkdir();
	const wf = createWorkflow("on failure fixes", { workdir });
	// Fails until the "agent" creates fixed.txt in the workdir.
	const pipeline = pipelineWith(
		"tests",
		`  - name: Tests\n    run: test -f "$FIXED"\n    env:\n      FIXED: \${{ workflow.workdir }}/fixed.txt\n`,
	);
	const step = addStep(wf.id, "", {
		kind: "command",
		pipelineId: pipeline.id,
		pipelineInputs: {},
		maxRetries: 2,
		onFailureTask: "Make the tests pass.",
	});

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => dispatches(wf.id).length === 1);
	const branching = getStep(step.id)!;
	assert.equal(branching.phase, "on_failure");
	assert.equal(branching.status, "running");
	assert.match(branching.error ?? "", /^pipeline failed: Tests exit 1$/);
	const [prompt] = dispatches(wf.id);
	assert.match(prompt.input, /The pipeline of this command step failed\. Your task:\n\nMake the tests pass\./);
	assert.match(prompt.input, /✗ Tests/);

	fs.writeFileSync(path.join(workdir, "fixed.txt"), "ok");
	await onStepResult(step.id, { ok: true, result: "Fixed it." }, cfg, silent);
	await until(() => getWorkflow(wf.id)?.status === "completed");

	const done = getStep(step.id)!;
	assert.equal(done.status, "done");
	assert.equal(done.retryCount, 1, "one retry was spent");
	assert.equal(listPipelineRunsForStep(step.id).length, 2, "the pipeline ran again after the agent");
	assert.equal(dispatches(wf.id).length, 1, "a passing run with no on-success task dispatches nothing");
});

test("the on-failure agent also runs after the last failed run, then the step and the workflow fail", async () => {
	const wf = createWorkflow("on failure exhausts", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("always-red", `  - run: exit 2\n`);
	const step = addStep(wf.id, "", {
		kind: "command",
		pipelineId: pipeline.id,
		pipelineInputs: {},
		maxRetries: 1,
		onFailureTask: "Try to fix it.",
	});

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => dispatches(wf.id).length === 1);
	await onStepResult(step.id, { ok: true, result: "tried" }, cfg, silent);
	await until(() => dispatches(wf.id).length === 2);
	assert.equal(getStep(step.id)!.retryCount, 1);
	await onStepResult(step.id, { ok: true, result: "tried again" }, cfg, silent);
	await until(() => getWorkflow(wf.id)?.status === "failed");

	const failed = getStep(step.id)!;
	assert.equal(failed.status, "failed");
	assert.match(failed.error ?? "", /^pipeline failed: /);
	assert.match(failed.result ?? "", /On-failure agent:\ntried again/);
	assert.equal(listPipelineRunsForStep(step.id).length, 2);
});

test("a branch agent that fails fails the step and the workflow, with no retry", async () => {
	const wf = createWorkflow("agent fails", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("red", `  - run: exit 1\n`);
	const step = addStep(wf.id, "", {
		kind: "command",
		pipelineId: pipeline.id,
		pipelineInputs: {},
		maxRetries: 3,
		onFailureTask: "Fix it.",
	});

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => dispatches(wf.id).length === 1);
	await onStepResult(step.id, { ok: false, error: "agent crashed" }, cfg, silent);
	await until(() => getWorkflow(wf.id)?.status === "failed");

	const failed = getStep(step.id)!;
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "on-failure agent failed: agent crashed");
	assert.equal(failed.retryCount, 0, "the agent's failure does not spend the pipeline's retries");
	assert.equal(listPipelineRunsForStep(step.id).length, 1);
});

test("a refusal before anything ran (untrusted pipeline) runs no agent", async () => {
	const wf = createWorkflow("refused", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("unapproved", `  - run: echo hi\n`, false);
	const step = addStep(wf.id, "", {
		kind: "command",
		pipelineId: pipeline.id,
		pipelineInputs: {},
		onFailureTask: "Fix it.",
	});

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "failed");
	assert.equal(getStep(step.id)!.error, "pipeline not trusted");
	assert.equal(dispatches(wf.id).length, 0);
});

test("aborting a step while its branch agent runs kills the agent run and fails the step", async () => {
	const wf = createWorkflow("abort branch", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("green", `  - run: echo ok\n`);
	const step = addStep(wf.id, "", {
		kind: "command",
		pipelineId: pipeline.id,
		pipelineInputs: {},
		onSuccessTask: "Deploy.",
	});

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => dispatches(wf.id).length === 1);
	await abortStep(wf.id, step.id, silent);

	const aborted = getStep(step.id)!;
	assert.equal(aborted.status, "failed");
	assert.equal(aborted.error, "aborted");
	assert.equal(getWorkflow(wf.id)!.status, "failed");
	const hookOrigin = new URL(getWorkflow(wf.id)!.hookUrl).origin;
	assert.ok(
		requests.some((r) => r.url.startsWith(hookOrigin) && r.url.endsWith("/abort") && r.body?.jobId === step.id),
		"the agent run was killed on the broker",
	);
	// A late callback from the killed agent changes nothing.
	await onStepResult(step.id, { ok: true, result: "late" }, cfg, silent);
	assert.equal(getStep(step.id)!.status, "failed");
});

test("only a command step takes branch tasks; edit sets and clears them", () => {
	const wf = createWorkflow("validation", { workdir: freshWorkdir() });
	assert.throws(
		() => addStep(wf.id, "an agent step", { onSuccessTask: "nope" }),
		(err: unknown) => err instanceof WorkflowError && /only a command step/.test(err.message),
	);
	const pipeline = pipelineWith("edit-me", `  - run: echo ok\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });
	assert.equal(step.onSuccessTask, null);
	assert.equal(step.onFailureTask, null);

	const edited = editStep(wf.id, step.id, "", { onFailureTask: "  Fix it.  " });
	assert.equal(edited.onFailureTask, "Fix it.");
	assert.equal(edited.onSuccessTask, null);

	const kept = editStep(wf.id, step.id, "renamed", {});
	assert.equal(kept.onFailureTask, "Fix it.", "an edit that omits the field leaves it alone");

	const cleared = editStep(wf.id, step.id, "", { onFailureTask: "" });
	assert.equal(cleared.onFailureTask, null);

	editStep(wf.id, step.id, "", { onSuccessTask: "Celebrate." });
	const switched = editStep(wf.id, step.id, "now an agent", { kind: "task" });
	assert.equal(switched.onSuccessTask, null, "switching to an agent step drops the branch tasks");
});

test("templates keep branch tasks on command steps only", () => {
	const template = insertTemplate({
		name: "branchy",
		steps: [
			{ description: "", kind: "command", pipelineId: "p1", pipelineInputs: {}, onSuccessTask: " Ship it ", onFailureTask: "Fix it" },
			{ description: "agent", kind: "task", onSuccessTask: "dropped" },
		],
	} as unknown as Parameters<typeof insertTemplate>[0]);
	const stored = getTemplate(template.id)!;
	assert.equal(stored.steps[0].onSuccessTask, "Ship it");
	assert.equal(stored.steps[0].onFailureTask, "Fix it");
	assert.equal(stored.steps[1].onSuccessTask, undefined);
	assert.equal(stored.steps[1].onFailureTask, undefined);
});

test("the plan reported to the server carries the branch agents and the branch phase", async () => {
	const { saveReportSettings, open } = await import("./db.ts");
	saveReportSettings({ enabled: true, url: "http://127.0.0.1:9/ingest", token: "test", intervalMs: 60_000, includeConversations: "off" });
	const wf = createWorkflow("plan branches", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("planned", `  - run: exit 1\n`);
	const step = addStep(wf.id, "", {
		kind: "command",
		pipelineId: pipeline.id,
		pipelineInputs: {},
		onSuccessTask: "Ship",
		onFailureTask: "Fix",
	});
	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => dispatches(wf.id).length === 1);

	const plans = (
		open().prepare("SELECT payload FROM report_events WHERE workflow_id = ? AND kind = 'workflow.plan' ORDER BY created_at").all(wf.id) as {
			payload: string;
		}[]
	).map((row) => JSON.parse(row.payload) as { steps: Record<string, unknown>[] });
	const latest = plans[plans.length - 1]!.steps.find((s) => s.step_id === step.id)!;
	assert.equal(latest.pipeline_id, pipeline.id);
	assert.equal(latest.on_success_task, "Ship");
	assert.equal(latest.on_failure_task, "Fix");
	assert.equal(latest.phase, "on_failure");
	assert.equal(latest.branch_failed, false);

	await onStepResult(step.id, { ok: false, error: "boom" }, cfg, silent);
	await until(() => getWorkflow(wf.id)?.status === "failed");
});
