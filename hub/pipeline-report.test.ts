/**
 * What the next agent step is told about the command steps before it
 * (docs/pipelines.md, "What the agent receives"): the report format, the log
 * selection rules, the 16 KiB cap, where the reports sit in the prompt, and
 * when they are delivered.
 *
 * Same throwaway-TARGET_HOME convention as the other workflow tests. The
 * delivery tests use a local stand-in hook, so the real fetch is used for them.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { JobStepState } from "./pipeline-runner.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-pipeline-report-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { loadConfig } = await import("./config.ts");
const { clearCommandReports, getContextStep, getStep, getWorkflow, listUndeliveredReports, open } = await import("./db.ts");
const { insertPipeline } = await import("./pipeline-store.ts");
const { parsePipeline, sourceHash } = await import("./pipeline-yaml.ts");
const { runPipeline } = await import("./pipeline-runner.ts");
const { buildPipelineReport, REPORT_MAX_BYTES } = await import("./command-report.ts");
const { composeStepInput, dispatchStep } = await import("./runner.ts");
const { addStep, createWorkflow, setConversationContext, startWorkflow } = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};

const workdirs: string[] = [];
function freshWorkdir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "target-pipeline-report-wd-"));
	workdirs.push(dir);
	return dir;
}
test.after(() => {
	for (const dir of workdirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the engine");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A job step as the runner hands it over, with only the fields the report reads. */
function job(overrides: Partial<JobStepState> & { name: string }): JobStepState {
	return {
		idx: 0,
		status: "success",
		exitCode: 0,
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:04.000Z",
		logOffset: 0,
		logLength: 0,
		report: true,
		continueOnError: false,
		tail: "",
		...overrides,
	};
}

const LOG = "/home/operator/.target/steps/agent/03-verify.log";

// --- Format -----------------------------------------------------------------

test("the report matches the doc's example: header, ✓/✗ lines, durations, the continue-on-error marker and the full log path", () => {
	const text = buildPipelineReport({
		pipelineName: "verify",
		conclusion: "success",
		cancelled: false,
		logPath: LOG,
		steps: [
			job({ idx: 0, name: "Typecheck", tail: "ok" }),
			job({
				idx: 1,
				name: "Tests",
				status: "failed",
				exitCode: 1,
				startedAt: "2026-01-01T00:00:04.000Z",
				finishedAt: "2026-01-01T00:00:42.000Z",
				continueOnError: true,
				tail: "not ok 3",
			}),
			job({
				idx: 2,
				name: "Collect coverage",
				startedAt: "2026-01-01T00:00:42.000Z",
				finishedAt: "2026-01-01T00:00:43.000Z",
				report: false,
				tail: "coverage 91%",
			}),
		],
	});

	assert.match(text, /^The hub ran the pipeline "verify" before this step: success \(1 tolerated failure\)\.$/m);
	assert.match(text, /^ {2}✓ Typecheck {2}\s+4s$/m, "a passing step: marker, name, duration");
	assert.match(text, /^ {2}✗ Tests {2}\s*exit 1\s+38s \(continue-on-error\)$/m, "a tolerated failure: exit code and marker");
	assert.match(text, /^ {2}✓ Collect coverage\s+1s$/m);
	assert.match(text, /^--- Tests: last 1 line ---$/m, "the failed step's tail is shown under its name");
	assert.match(text, /^not ok 3$/m);
	assert.ok(text.endsWith(`\n\nFull log: ${LOG}`), "the report ends with the full log path");
});

test("a skipped job step is marked with a dash and its output is never shown", () => {
	const text = buildPipelineReport({
		pipelineName: "stop",
		conclusion: "failure",
		cancelled: false,
		logPath: LOG,
		steps: [
			job({ idx: 0, name: "Build", status: "failed", exitCode: 2, tail: "compile error" }),
			job({ idx: 1, name: "Deploy", status: "skipped", exitCode: null, startedAt: null, finishedAt: null, tail: "" }),
		],
	});
	assert.match(text, /^ {2}– Deploy\b/m);
	assert.match(text, /^--- Build: last 1 line ---$/m);
	assert.doesNotMatch(text, /^--- Deploy/m, "the skipped step has no section");
});

test("report: false hides a successful job step's output, but a failed one still shows its output", () => {
	const text = buildPipelineReport({
		pipelineName: "quiet",
		conclusion: "failure",
		cancelled: false,
		logPath: LOG,
		steps: [
			job({ idx: 0, name: "Chatty", report: false, tail: "QUIET-OUTPUT-OK" }),
			job({ idx: 1, name: "Loud", status: "failed", exitCode: 1, report: false, tail: "LOUD-OUTPUT-FAILED" }),
		],
	});
	assert.doesNotMatch(text, /QUIET-OUTPUT-OK/, "a successful report: false step stays out");
	assert.match(text, /LOUD-OUTPUT-FAILED/, "a failed step is shown even with report: false");
});

test("a run-level error no job step explains is stated in the header", () => {
	const text = buildPipelineReport({
		pipelineName: "slow",
		conclusion: "failure",
		cancelled: true,
		error: "the pipeline's timeout-minutes was reached",
		logPath: LOG,
		steps: [job({ idx: 0, name: "Wait", status: "failed", exitCode: null, error: "timed out after 1 minute(s)", tail: "" })],
	});
	assert.match(text, /before this step: failure, cancelled\./);
	assert.doesNotMatch(text, /Error: the pipeline's timeout/, "a failed job step already explains the failure");
});

test("the report is capped at 16 KiB with a truncation note, and still ends with the full log path", () => {
	const text = buildPipelineReport({
		pipelineName: "big",
		conclusion: "failure",
		cancelled: false,
		logPath: LOG,
		steps: [job({ idx: 0, name: "Noisy", status: "failed", exitCode: 1, tail: "line with ünïcode\n".repeat(5000) })],
	});
	assert.ok(Buffer.byteLength(text, "utf8") <= REPORT_MAX_BYTES, "within the cap");
	assert.match(text, /truncated/, "says it was cut");
	assert.ok(text.endsWith(`Full log: ${LOG}`), "the log path survives the cut");
	assert.doesNotMatch(text, /�/, "no character was split in the middle");
});

test("a real run's failed step shows exactly its last 80 lines, and a passing step with report: false shows none", async () => {
	const workdir = freshWorkdir();
	const yaml = [
		"name: long",
		"steps:",
		"  - name: Chatty",
		"    run: echo CHATTY-ONLY-IN-LOG",
		"    report: false",
		"  - name: Long",
		"    run: seq 1 200; exit 1",
		"",
	].join("\n");
	const parsed = parsePipeline(yaml);
	assert.ok(parsed.ok, JSON.stringify(parsed));
	const result = await runPipeline({
		spec: parsed.pipeline,
		sourceHash: sourceHash(yaml),
		inputs: {},
		workflow: { id: "w", name: "w", workdir },
		resultsDir: path.join(workdir, "results"),
		logPath: path.join(workdir, "results", "run.log"),
		resolveSecrets: () => ({}),
	});
	const text = buildPipelineReport({ pipelineName: "long", conclusion: result.conclusion, cancelled: false, steps: result.steps, logPath: "/x.log" });

	assert.match(text, /^--- Long: last 80 lines ---$/m);
	assert.match(text, /^200$/m, "the last line is in the report");
	assert.match(text, /^121$/m, "the first of the last 80 lines is in the report");
	assert.doesNotMatch(text, /^120$/m, "earlier lines are cut");
	assert.doesNotMatch(text, /CHATTY-ONLY-IN-LOG/, "a passing report: false step's output is hidden");
});

// --- Prompt -----------------------------------------------------------------

const VERIFY = "name: verify\nsteps:\n  - run: echo fine\n";
const GREET = "name: greet\nsteps:\n  - run: echo hello\n";

test("composeStepInput places the reports after the catalogs and before the step description, with a lead line", () => {
	const wf = createWorkflow("placement", { workdir: freshWorkdir() });
	const step = addStep(wf.id, "DESCRIPTION-MARKER", {});
	const input = composeStepInput(step, getWorkflow(wf.id)!, {
		mode: "exec",
		pipelineReports: ["REPORT-A", "REPORT-B"],
	});
	const lead = input.indexOf("The hub ran these pipelines since your last step:");
	assert.ok(lead >= 0, "the lead line is there");
	assert.ok(lead < input.indexOf("REPORT-A"), "the lead comes before the reports");
	assert.ok(input.indexOf("REPORT-A") < input.indexOf("REPORT-B"), "the reports keep their order");
	assert.ok(input.indexOf("REPORT-B") < input.indexOf("DESCRIPTION-MARKER"), "the reports come before the description");
});

test("composeStepInput without reports is unchanged: no lead line", () => {
	const wf = createWorkflow("unchanged", { workdir: freshWorkdir() });
	const step = addStep(wf.id, "DESCRIPTION-MARKER", {});
	const input = composeStepInput(step, getWorkflow(wf.id)!, { mode: "exec" });
	assert.doesNotMatch(input, /The hub ran these pipelines/);
});

// --- Delivery ---------------------------------------------------------------

/** A stand-in hook that records each prompt it accepts, and answers 200. */
async function listenHook(): Promise<{ url: string; received: { input: string }[]; close: () => Promise<void> }> {
	const received: { input: string }[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			received.push(JSON.parse(body));
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}/hook`,
		received,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function setHook(workflowId: string, url: string): void {
	open().prepare("UPDATE workflows SET hook_url = ? WHERE id = ?").run(url, workflowId);
}

/** A workflow with two settled command steps, then an agent step, all in one conversation. */
async function workflowWithTwoReports(name: string): Promise<{ workflowId: string; agentId: string; first: string; second: string }> {
	const wf = createWorkflow(name, { workdir: freshWorkdir() });
	const first = addStep(wf.id, "", { kind: "command", pipelineId: insertPipeline({ source: VERIFY, approve: true }).id, pipelineInputs: {} });
	const second = addStep(wf.id, "", { kind: "command", pipelineId: insertPipeline({ source: GREET, approve: true }).id, pipelineInputs: {} });
	const agent = addStep(wf.id, "Use both results", {});
	await startWorkflow(wf.id, cfg, silent, [first.id, second.id]);
	await until(() => getStep(first.id)?.status === "done" && getStep(second.id)?.status === "done");
	return { workflowId: wf.id, agentId: agent.id, first: first.id, second: second.id };
}

test("two consecutive command steps are both delivered to the next agent step, in order", async () => {
	const { workflowId, agentId } = await workflowWithTwoReports("two in a row");
	assert.equal(listUndeliveredReports(workflowId).length, 2);

	const hook = await listenHook();
	try {
		setHook(workflowId, hook.url);
		await dispatchStep(getStep(agentId)!, getWorkflow(workflowId)!, cfg, silent);
		assert.equal(hook.received.length, 1);
		const prompt = hook.received[0].input;
		const verify = prompt.indexOf('ran the pipeline "verify"');
		const greet = prompt.indexOf('ran the pipeline "greet"');
		assert.ok(verify >= 0 && greet > verify, "both reports, in the order the steps ran");
		assert.equal(listUndeliveredReports(workflowId).length, 0, "accepted: delivered");
	} finally {
		await hook.close();
	}
});

test("a refused dispatch keeps the reports pending, so the retry carries them again", async () => {
	const { workflowId, agentId } = await workflowWithTwoReports("refused dispatch");
	setHook(workflowId, "http://127.0.0.1:9/hook");
	await dispatchStep(getStep(agentId)!, getWorkflow(workflowId)!, cfg, silent);
	assert.equal(listUndeliveredReports(workflowId).length, 2, "still pending after a refused dispatch");

	const hook = await listenHook();
	try {
		setHook(workflowId, hook.url);
		await dispatchStep(getStep(agentId)!, getWorkflow(workflowId)!, cfg, silent);
		assert.match(hook.received[0].input, /ran the pipeline "verify"/, "the retry carries them");
		assert.equal(listUndeliveredReports(workflowId).length, 0);
	} finally {
		await hook.close();
	}
});

test("the context step and a judge prompt never carry the reports, and do not mark them delivered", async () => {
	const wf = createWorkflow("context and judge", { workdir: freshWorkdir() });
	const command = addStep(wf.id, "", { kind: "command", pipelineId: insertPipeline({ source: VERIFY, approve: true }).id, pipelineInputs: {} });
	await startWorkflow(wf.id, cfg, silent, [command.id]);
	await until(() => getStep(command.id)?.status === "done");
	assert.equal(listUndeliveredReports(wf.id).length, 1);
	// Background added after the run: the context step is materialised now, and
	// a workflow with one would otherwise run it first, before the command step.
	setConversationContext(wf.id, "Background for the run.");

	const judged = addStep(wf.id, "Judged work", { acceptanceCriteria: "it works" });
	const hook = await listenHook();
	try {
		setHook(wf.id, hook.url);
		const context = getContextStep(wf.id);
		assert.ok(context, "the workflow has a context step");
		await dispatchStep(context!, getWorkflow(wf.id)!, cfg, silent);
		assert.equal(hook.received.length, 1);
		assert.doesNotMatch(hook.received[0].input, /ran the pipeline/, "the context step never carries a report");
		assert.equal(listUndeliveredReports(wf.id).length, 1, "the context step does not deliver it");

		// Judge: a verdict prompt for the step above. Its composed input must not carry it.
		const judging = { ...getStep(judged.id)!, phase: "judge" as const };
		const judgeInput = composeStepInput(judging, getWorkflow(wf.id)!, { mode: "judge", pipelineReports: ["REPORT-SHOULD-NOT-APPEAR"] });
		assert.doesNotMatch(judgeInput, /REPORT-SHOULD-NOT-APPEAR/);
		await dispatchStep(judging, getWorkflow(wf.id)!, cfg, silent, { mode: "judge" });
		assert.doesNotMatch(hook.received[1].input, /ran the pipeline/, "a judge prompt never carries a report");
		assert.equal(listUndeliveredReports(wf.id).length, 1, "the judge does not deliver it");
	} finally {
		await hook.close();
	}
});

test("clearing the reports on restart leaves nothing for the agent to be told about", async () => {
	const { workflowId } = await workflowWithTwoReports("cleared");
	assert.equal(listUndeliveredReports(workflowId).length, 2);
	clearCommandReports(workflowId);
	assert.equal(listUndeliveredReports(workflowId).length, 0);
});
