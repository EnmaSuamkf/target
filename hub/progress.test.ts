/**
 * Tests for the progress watchdog (progress.ts): the part that tells a hung
 * agent from one that is simply working on something long — the whole reason a
 * step is no longer failed on a wall clock.
 *
 * Everything runs against a throwaway HOME/TARGET_HOME/AWB_HOME, so the fake
 * transcripts, session files and run logs written here never touch the
 * operator's real ones. `os.homedir()` reads $HOME on POSIX, which is what lets
 * us relocate the Claude Code transcript tree.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-progress-test-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { createAwbHook } = await import("./awb.ts");
const { insertStep, insertWorkflow, markStepRunning, getStep } = await import("./db.ts");
const { probeStepProgress, stepActivity } = await import("./progress.ts");
const { loadConfig } = await import("./config.ts");
const { claudeProjectDir } = await import("./transcript.ts");

const cfg = loadConfig();

let seq = 0;

/**
 * A workflow with a real awb hook (so `hookRuntime` resolves its harness and
 * workdir exactly as in production) plus one `running` step.
 */
function makeRunningStep(runner: "claude" | "free-code" = "claude") {
	const id = `pwf-${++seq}`;
	const agentName = `progress-agent-${seq}`;
	const workdir = path.join(tmpHome, "sandboxes", agentName);
	const hook = createAwbHook(agentName, workdir, "{{payload}}", { runner });
	const workflow = insertWorkflow({
		id,
		name: `progress ${id}`,
		agentName,
		hookUrl: hook.hookUrl,
		secret: hook.secret,
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const step = insertStep(id, "long step");
	markStepRunning(step.id);
	return { workflow, step: getStep(step.id)!, workdir, agentName };
}

function write(file: string, mtime = new Date()): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{}\n");
	fs.utimesSync(file, mtime, mtime);
	return file;
}

test("the freshest claude transcript wins, subagent transcripts included", () => {
	const { workflow, step, workdir } = makeRunningStep();
	const projectDir = claudeProjectDir(workdir);
	const session = "11111111-2222-3333-4444-555555555555";
	write(path.join(projectDir, `${session}.jsonl`), new Date(Date.now() - 120_000));
	// The step's real work runs in a subagent, so this is the file that actually
	// moves while it works — and the one that must count as progress.
	const subagent = write(path.join(projectDir, session, "subagents", "agent-abc.jsonl"), new Date());

	const signal = probeStepProgress(workflow, step, cfg, true);

	assert.equal(signal?.kind, "transcript");
	assert.equal(signal?.source, subagent);
	assert.ok(Date.now() - Date.parse(String(signal?.at)) < 5_000);
});

test("a free-code workflow is probed through its session file", () => {
	const { workflow, step, agentName } = makeRunningStep("free-code");
	const sessionFile = write(
		path.join(String(process.env.AWB_HOME), "sessions", agentName, "session-1.jsonl"),
		new Date(),
	);

	const signal = probeStepProgress(workflow, step, cfg, true);

	assert.equal(signal?.kind, "session-file");
	assert.equal(signal?.source, sessionFile);
});

test("awb's run log is the fallback when the harness left no transcript", () => {
	const { workflow, step, agentName } = makeRunningStep();
	const logFile = write(path.join(String(process.env.AWB_HOME), "logs", `${agentName}-1785003818744.log`), new Date());

	const signal = probeStepProgress(workflow, step, cfg, true);

	assert.equal(signal?.kind, "run-log");
	assert.equal(signal?.source, logFile);
});

test("no artifact at all yields no signal, so the caller falls back to the clock", () => {
	const { workflow, step } = makeRunningStep();

	assert.equal(probeStepProgress(workflow, step, cfg, true), null);
});

test("the fingerprint changes only when the artifact is actually touched", () => {
	const { workflow, step, agentName } = makeRunningStep();
	const logFile = path.join(String(process.env.AWB_HOME), "logs", `${agentName}-1.log`);
	write(logFile, new Date(Date.now() - 30_000));

	const first = probeStepProgress(workflow, step, cfg, true);
	const again = probeStepProgress(workflow, step, cfg, true);
	assert.equal(first?.token, again?.token); // untouched file → same fingerprint → not progress

	fs.appendFileSync(logFile, "more output\n");
	const third = probeStepProgress(workflow, step, cfg, true);
	assert.notEqual(first?.token, third?.token);
});

test("probes are throttled unless forced", () => {
	const { workflow, step, agentName } = makeRunningStep();
	write(path.join(String(process.env.AWB_HOME), "logs", `${agentName}-1.log`), new Date());

	assert.ok(probeStepProgress(workflow, step, cfg, true)); // forced: always looks
	assert.equal(probeStepProgress(workflow, step, cfg), null); // throttled right after
	assert.ok(probeStepProgress(workflow, step, cfg, true)); // the sweep's decision always forces
});

/**
 * The derived states the UI and the sweep read. They're computed from the
 * stored stamps only (no filesystem), which is why they're safe on every API
 * read.
 */
const activityCfg = { ...cfg, stepIdleWarnMs: 60_000, stepIdleTimeoutMs: 300_000, stepHardTimeoutMs: 3_600_000 };

function runningStepAt(progressAgoMs: number, startedAgoMs = progressAgoMs) {
	const { step } = makeRunningStep();
	return {
		...step,
		startedAt: new Date(Date.now() - startedAgoMs).toISOString(),
		lastProgressAt: new Date(Date.now() - progressAgoMs).toISOString(),
		lastProgressKind: "transcript" as const,
	};
}

test("activity state tracks how long the agent has been quiet", () => {
	assert.equal(stepActivity(runningStepAt(5_000), activityCfg)?.state, "running-active");
	assert.equal(stepActivity(runningStepAt(90_000), activityCfg)?.state, "running-idle");
	assert.equal(stepActivity(runningStepAt(400_000), activityCfg)?.state, "stalled");
	// Busy but past the absolute ceiling: the hard cap wins over an active clock.
	assert.equal(stepActivity(runningStepAt(1_000, 4_000_000), activityCfg)?.state, "timed-out-hard");
});

test("a step that isn't running has no activity to report", () => {
	const { step } = makeRunningStep();
	assert.equal(stepActivity({ ...step, status: "done" }, activityCfg), null);
	assert.equal(stepActivity({ ...step, status: "queued" }, activityCfg), null);
});

test("a step nobody has probed yet reads as active since its run start", () => {
	const { step } = makeRunningStep(); // markStepRunning seeds last_progress_at
	const activity = stepActivity(step, activityCfg);
	assert.equal(activity?.state, "running-active");
	assert.equal(activity?.lastProgressAt, step.startedAt);
	assert.equal(activity?.lastProgressKind, null);
});
