/**
 * The engine's command steps (docs/pipelines.md, "Execution and failure",
 * "What the agent receives", "Reporting"): dispatch, settle, retries, manual
 * review, trust, abort, boot reconciliation, and the files and events they leave.
 *
 * Every pipeline here runs real shell commands in a temporary workdir. The
 * awb hook is never called: fetch is stubbed to record any request, and the
 * tests assert that none went to the workflow's hook.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-command-engine-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { loadConfig } = await import("./config.ts");
const { getStep, getWorkflow, listSteps, listUndeliveredReports, open, saveReportSettings, setWorkflowStatus } = await import("./db.ts");
const { insertPipeline } = await import("./pipeline-store.ts");
const { insertPipelineRun, listPipelineRunsForStep } = await import("./pipeline-runs.ts");
const { stepResultsDir, stepResultFileName } = await import("./step-results.ts");
const { dispatchStep } = await import("./runner.ts");
const { commandLogPath } = await import("./command-report.ts");
const {
	abortStep,
	addStep,
	continueStep,
	createWorkflow,
	failCommandStepsLeftByRestart,
	runStep,
	startWorkflow,
} = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};

// Reporting is off by default. Turn it on so the step events are queued where the
// test can read them; nothing is delivered (the daemon's flush is not running).
saveReportSettings({ enabled: true, url: "http://127.0.0.1:9/ingest", token: "test", intervalMs: 60_000, includeConversations: "off" });

const LOG_MARKER = "LOG-MARKER-DO-NOT-LEAK";
// The marker is printed, never written literally into the pipeline: a job step
// with no `name` is labelled by its `run` text, and that label is allowed in
// events. Only the output must stay out of them.
const LOG_MARKER_COMMAND = 'echo "LOG-MARKER-""DO-NOT-LEAK"';

let workdirs: string[] = [];
function freshWorkdir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "target-command-engine-wd-"));
	workdirs.push(dir);
	return dir;
}

/** Records every fetch; the engine must never call the awb hook for a command step. */
const requests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
	requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
	throw new Error("network is not expected in this test");
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

function hookRequests(workflowId: string): string[] {
	const origin = new URL(getWorkflow(workflowId)!.hookUrl).origin;
	return requests.filter((url) => url.startsWith(origin));
}

function reportEvents(workflowId: string): { kind: string; payload: Record<string, unknown> }[] {
	const rows = open()
		.prepare("SELECT kind, payload FROM report_events WHERE workflow_id = ? ORDER BY created_at")
		.all(workflowId) as { kind: string; payload: string }[];
	return rows.map((row) => ({ kind: row.kind, payload: JSON.parse(row.payload) }));
}

function pipelineWith(name: string, steps: string, approve = true): { id: string } {
	return insertPipeline({ source: `name: ${name}\nsteps:\n${steps}`, approve });
}

test("a workflow made only of command steps completes with no request to the awb hook, and leaves its files", async () => {
	const workdir = freshWorkdir();
	const wf = createWorkflow("command only", { workdir });
	const pipeline = pipelineWith("greet", `  - run: ${LOG_MARKER_COMMAND}\n  - run: echo two\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "completed");

	assert.equal(hookRequests(wf.id).length, 0, "no request reached the awb hook");
	const settled = getStep(step.id)!;
	assert.equal(settled.status, "done");
	assert.equal(settled.sessionId, null, "a command step never starts or resumes a conversation");

	const file = path.join(stepResultsDir(wf.agentName), stepResultFileName(settled));
	const md = fs.readFileSync(file, "utf8");
	assert.match(md, /The hub ran the pipeline "greet" before this step: success\./);
	assert.match(md, /✓ /, "the summary lists each job step with its marker");

	const log = fs.readFileSync(commandLogPath(wf.agentName, settled), "utf8");
	assert.match(log, new RegExp(LOG_MARKER), "the .log keeps the full output");
	assert.match(log, /two/);
});

test("a failing pipeline fails the step and the workflow, with the failing job step named", async () => {
	const wf = createWorkflow("failing pipeline", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("broken", `  - name: Tests\n    run: echo boom; exit 3\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "failed");

	const failed = getStep(step.id)!;
	assert.equal(failed.status, "failed");
	assert.match(failed.error ?? "", /^pipeline failed: Tests exit 3$/);
	assert.equal(hookRequests(wf.id).length, 0);
	const md = fs.readFileSync(path.join(stepResultsDir(wf.agentName), stepResultFileName(failed)), "utf8");
	assert.match(md, /✗ Tests\s+exit 3/);
});

test("maxRetries re-runs the whole pipeline, once per retry, and then fails the workflow", async () => {
	const workdir = freshWorkdir();
	const wf = createWorkflow("retries", { workdir });
	const counter = path.join(workdir, "attempts.txt");
	const pipeline = pipelineWith(
		"counted",
		`  - run: echo attempt >> "$COUNTER"; exit 1\n    env:\n      COUNTER: \${{ workflow.workdir }}/attempts.txt\n`,
	);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {}, maxRetries: 2, retryIntervalSeconds: 0 });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "failed");

	assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 3, "the pipeline ran three times in total");
	assert.equal(getStep(step.id)!.retryCount, 2);
	assert.equal(listPipelineRunsForStep(step.id).length, 3, "each attempt is its own run row");
});

test("the retry interval is waited out between attempts", async () => {
	const wf = createWorkflow("retry interval", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("flaky", `  - run: exit 1\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {}, maxRetries: 1, retryIntervalSeconds: 1 });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "failed");

	const [first, second] = listPipelineRunsForStep(step.id);
	const gap = Date.parse(second.startedAt) - Date.parse(first.finishedAt!);
	assert.ok(gap >= 900, `the second attempt started ${gap} ms after the first finished, expected about 1000`);
});

test("manualReview holds a successful command step at waiting until it is continued", async () => {
	const wf = createWorkflow("manual review", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("gate", `  - run: echo ok\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {}, manualReview: true });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getStep(step.id)?.status === "waiting");
	assert.equal(getWorkflow(wf.id)!.status, "waiting");

	await continueStep(wf.id, step.id, cfg, silent);
	await until(() => getWorkflow(wf.id)?.status === "completed");
	assert.equal(getStep(step.id)!.status, "done");
	assert.equal(hookRequests(wf.id).length, 0);
});

test("an untrusted pipeline fails with 'pipeline not trusted' before any job step runs", async () => {
	const workdir = freshWorkdir();
	const wf = createWorkflow("untrusted", { workdir });
	const marker = path.join(workdir, "ran.txt");
	const pipeline = pipelineWith("unapproved", `  - run: touch "$MARK"\n    env:\n      MARK: \${{ workflow.workdir }}/ran.txt\n`, false);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "failed");

	const failed = getStep(step.id)!;
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "pipeline not trusted");
	assert.equal(fs.existsSync(marker), false, "nothing ran");
	assert.equal(listPipelineRunsForStep(step.id).length, 0, "no run was started");
});

test("aborting a running pipeline kills it and fails the step with error 'aborted'", async () => {
	const wf = createWorkflow("abort", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("sleeper", `  - run: sleep 30\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	// Wait until the job step is really running, so the abort has a process to kill.
	await until(() => listPipelineRunsForStep(step.id)[0]?.steps[0]?.status === "running");

	const started = Date.now();
	await abortStep(wf.id, step.id, silent);
	assert.ok(Date.now() - started < 10_000, "the abort returned after the process group died");

	const aborted = getStep(step.id)!;
	assert.equal(aborted.status, "failed");
	assert.equal(aborted.error, "aborted");
	assert.equal(getWorkflow(wf.id)!.status, "failed");
	const run = listPipelineRunsForStep(step.id)[0];
	assert.equal(run.cancelled, true);
	assert.equal(run.conclusion, "failure");
	assert.equal(hookRequests(wf.id).length, 0, "no /abort call went to the hook");
});

test("a command step left running by a restart is failed on boot", () => {
	const wf = createWorkflow("restart", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("interrupted", `  - run: sleep 30\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });
	// The state a dead hub leaves behind: the step and its run are `running`, and
	// no process of this hub is attached to them.
	open().prepare("UPDATE steps SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), step.id);
	setWorkflowStatus(wf.id, "running");
	const run = insertPipelineRun({
		stepId: step.id,
		workflowId: wf.id,
		attempt: 1,
		pipelineId: pipeline.id,
		sourceHash: "hash",
		logPath: null,
		steps: [{ index: 0, name: "Wait" }],
	});
	open().prepare("UPDATE pipeline_run_steps SET status = 'running' WHERE run_id = ?").run(run.id);

	assert.equal(failCommandStepsLeftByRestart(silent), 1);

	const failed = getStep(step.id)!;
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "hub restarted during pipeline run");
	assert.equal(getWorkflow(wf.id)!.status, "failed");
	const closed = listPipelineRunsForStep(step.id)[0];
	assert.equal(closed.conclusion, "failure");
	assert.equal(closed.steps[0].status, "failed");
});

test("step events for command steps carry kind 'command' and never log text", async () => {
	const wf = createWorkflow("events", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("noisy", `  - run: ${LOG_MARKER_COMMAND}\n  - run: exit 2\n    continue-on-error: true\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "completed");

	const events = reportEvents(wf.id).filter((e) => String(e.payload.kind ?? "") === "command");
	const kinds = events.map((e) => e.kind);
	assert.ok(kinds.includes("step.started"), `expected step.started, got ${kinds}`);
	assert.ok(kinds.includes("step.completed"), `expected step.completed, got ${kinds}`);
	const started = events.find((e) => e.kind === "step.started")!;
	assert.equal(started.payload.pipeline_id, pipeline.id);
	assert.equal(started.payload.pipeline_name, "noisy", "a started event names the pipeline");
	const completed = events.find((e) => e.kind === "step.completed")!;
	assert.equal(completed.payload.conclusion, "success");
	assert.equal(completed.payload.pipeline_name, "noisy", "a finished event names the pipeline");
	assert.ok(Array.isArray(completed.payload.job_steps));
	assert.equal(typeof (completed.payload.job_steps as { duration_ms: unknown }[])[0].duration_ms, "number");
	const everything = JSON.stringify(reportEvents(wf.id));
	assert.equal(everything.includes(LOG_MARKER), false, "no event carries the log");
});

test("a command step whose pipeline no longer exists reports pipeline_name null, never the id", async () => {
	const wf = createWorkflow("pipeline gone", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("vanishing", `  - run: echo ok\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });
	// deletePipeline refuses a pipeline that a step uses, so the row is removed
	// directly: the step is left pointing at an id the hub no longer has.
	open().prepare("DELETE FROM pipelines WHERE id = ?").run(pipeline.id);

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "failed");

	assert.equal(getStep(step.id)!.error, "pipeline not found");
	const failed = reportEvents(wf.id).find((e) => e.kind === "step.failed" && e.payload.step_id === step.id)!;
	assert.equal(failed.payload.pipeline_id, pipeline.id);
	assert.equal(failed.payload.pipeline_name, null, "the name is unknown, so it is null, not the id");

	const failedInPlans = reportEvents(wf.id)
		.filter((e) => e.kind === "workflow.plan")
		.flatMap((e) => e.payload.steps as Record<string, unknown>[])
		.filter((s) => s.step_id === step.id && s.status === "failed");
	assert.ok(failedInPlans.length > 0, "a plan snapshot showed the step failed");
	for (const planned of failedInPlans) {
		assert.equal(planned.pipeline_id, pipeline.id);
		assert.equal(planned.pipeline_name, null, "the plan snapshot carries null too");
	}
});

test("the result of a command step reaches the next agent prompt once, and is kept until a dispatch takes it", async () => {
	const wf = createWorkflow("report for the agent", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("verify", `  - run: echo fine\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "completed");

	const undelivered = listUndeliveredReports(wf.id);
	assert.equal(undelivered.length, 1);
	assert.equal(undelivered[0].stepId, step.id);
	assert.match(undelivered[0].report, /ran the pipeline "verify" before this step: success/);
});

test("running a command step again with ▶ re-runs the pipeline in process", async () => {
	const wf = createWorkflow("manual run", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("again", `  - run: echo again\n`);
	const step = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	await until(() => getWorkflow(wf.id)?.status === "completed");
	assert.equal(listPipelineRunsForStep(step.id).length, 1);

	await runStep(wf.id, step.id, cfg, silent);
	await until(() => listPipelineRunsForStep(step.id).length === 2 && getStep(step.id)?.status === "done");
	assert.equal(listSteps(wf.id).length, 1);
	assert.equal(hookRequests(wf.id).length, 0);
});

test("the report is prepended to the next agent prompt, and marked delivered only once the hook accepts it", async () => {
	const wf = createWorkflow("report delivery", { workdir: freshWorkdir() });
	const pipeline = pipelineWith("deliver", `  - run: echo ready\n`);
	const command = addStep(wf.id, "", { kind: "command", pipelineId: pipeline.id, pipelineInputs: {} });
	const agent = addStep(wf.id, "Use the result", {});
	await startWorkflow(wf.id, cfg, silent, [command.id]);
	await until(() => getStep(command.id)?.status === "done");

	// A stand-in hook that records what it is sent. The engine's fetch stub throws,
	// so the real one is restored for the dispatch.
	const received: { input: string }[] = [];
	const hook = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			received.push(JSON.parse(body));
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
	const port = (hook.address() as { port: number }).port;
	globalThis.fetch = realFetch;
	try {
		// First, a dispatch the hook refuses: the report must stay undelivered.
		open().prepare("UPDATE workflows SET hook_url = ? WHERE id = ?").run("http://127.0.0.1:9/hook", wf.id);
		await dispatchStep(getStep(agent.id)!, getWorkflow(wf.id)!, cfg, silent);
		assert.equal(listUndeliveredReports(wf.id).length, 1, "a refused dispatch leaves the report pending");

		// Then one the hook accepts: the agent's prompt starts with the report.
		open().prepare("UPDATE workflows SET hook_url = ? WHERE id = ?").run(`http://127.0.0.1:${port}/hook`, wf.id);
		await dispatchStep(getStep(agent.id)!, getWorkflow(wf.id)!, cfg, silent);
		assert.equal(received.length, 1);
		assert.match(received[0].input, /^The hub ran these pipelines since your last step:\n\nThe hub ran the pipeline "deliver" before this step: success\./m);
		assert.equal(listUndeliveredReports(wf.id).length, 0, "the accepted dispatch delivered it");
	} finally {
		globalThis.fetch = ((async (input: string | URL | Request) => {
			requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			throw new Error("network is not expected in this test");
		}) as typeof fetch);
		await new Promise<void>((resolve) => hook.close(() => resolve()));
	}
});
