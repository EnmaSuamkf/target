/**
 * Tests for how a schedule series moves from one instance to the next (D3–D5):
 * `cloneScheduledInstance` (the next instance, cloned from the firing one) and
 * `attachPreviousRun` / `buildPreviousRunBlock` (the reference to the previous
 * run a firing instance is given).
 *
 * What's worth pinning down, and why:
 *
 *  - instance names are rendered from the stored series name, so they never
 *    chain ("X · date · date") however many generations a series runs;
 *  - the conversation context is copied verbatim and never grows: the
 *    previous-run block lives in its own column and reaches the agent only
 *    through the context step, so a clone (which copies the context) can't
 *    pick it up;
 *  - a docker instance gets the previous run's results directory added to its
 *    hook, and keeps it when the hook's mounts are re-synced wholesale.
 *
 * Same throwaway-TARGET_HOME convention as the other hub tests.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-schedule-instance-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too: every instance is a real createWorkflow with its own hook.
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { getContextStep, getWorkflow, listSeriesInstances, listSteps, setWorkflowStatus, updateWorkflowSchedule } =
	await import("./db.ts");
const {
	addStep,
	attachPreviousRun,
	buildPreviousRunBlock,
	cloneScheduledInstance,
	cloneWorkflow,
	createWorkflow,
	setSchedule,
} = await import("./workflow.ts");
const { composeStepInput } = await import("./runner.ts");
const { hookRuntime } = await import("./awb.ts");
const { syncWorkflowDockerMounts } = await import("./docker-mounts.ts");
const { stepResultsDir } = await import("./step-results.ts");

const NOW = new Date("2026-09-30T12:00:00.000Z");
const CONTEXT = "Background for every run: the nightly report covers yesterday's orders.";

/** An armed first instance with a context and two steps. */
function armedSeries(name: string, options: { sandbox?: "docker"; includePrevious?: boolean } = {}) {
	const wf = createWorkflow(name, {
		conversationContext: CONTEXT,
		...(options.sandbox ? { sandbox: options.sandbox } : {}),
	});
	addStep(wf.id, "collect the orders", { acceptanceCriteria: "orders collected", maxRetries: 2 });
	addStep(wf.id, "write the report");
	return setSchedule(
		wf.id,
		{
			spec: { kind: "daily", time: "09:00" },
			timezone: "Europe/Madrid",
			...(options.includePrevious === undefined ? {} : { includePrevious: options.includePrevious }),
		},
		{ now: NOW },
	);
}

/** What the firing path will do: mark the source fired and arm the next one. */
function fire(armedId: string, nextRunAt: string) {
	updateWorkflowSchedule(armedId, { scheduleState: "fired", nextRunAt: null });
	return cloneScheduledInstance(armedId, nextRunAt);
}

test("instance names come from the series name and never chain across generations", () => {
	const first = armedSeries("Nightly report");
	const second = fire(first.id, "2026-10-01T07:00:00.000Z");
	const third = fire(second.id, "2026-10-02T07:00:00.000Z");
	const fourth = fire(third.id, "2026-10-03T07:00:00.000Z");

	assert.equal(second.name, "Nightly report · 2026-10-01 09:00");
	assert.equal(third.name, "Nightly report · 2026-10-02 09:00");
	assert.equal(fourth.name, "Nightly report · 2026-10-03 09:00", "no '· date · date' chaining");
	for (const instance of [second, third, fourth]) assert.equal(instance.seriesName, "Nightly report");
});

test("the name is rendered in the schedule's zone, across a DST change", () => {
	const first = armedSeries("Zone check");
	// 2026-10-25 is the October change in Madrid: 09:00 is 08:00Z from then on.
	assert.equal(fire(first.id, "2026-10-26T08:00:00.000Z").name, "Zone check · 2026-10-26 09:00");
});

test("the next instance carries the series and is armed for the next run", () => {
	const first = armedSeries("Series fields", { includePrevious: false });
	const second = fire(first.id, "2026-10-01T07:00:00.000Z");
	assert.equal(second.seriesId, first.seriesId);
	assert.deepEqual(second.schedule, first.schedule);
	assert.equal(second.scheduleTimezone, "Europe/Madrid");
	assert.equal(second.includePrevious, false);
	assert.equal(second.managedBy, "local");
	assert.equal(second.scheduleState, "armed");
	assert.equal(second.scheduledFor, "2026-10-01T07:00:00.000Z");
	assert.equal(second.nextRunAt, "2026-10-01T07:00:00.000Z");
	assert.equal(second.previousInstanceId, first.id);
	assert.equal(second.previousRunBlock, null, "written at fire time, not clone time");
	assert.equal(second.status, "draft");
	// steps are the source's definition (the context step is re-materialised)
	const tasks = (id: string) =>
		listSteps(id)
			.filter((s) => s.kind === "task")
			.map((s) => [s.description, s.acceptanceCriteria, s.maxRetries, s.status]);
	assert.deepEqual(tasks(second.id), tasks(first.id));
	assert.deepEqual(
		listSeriesInstances(first.seriesId!).map((w) => [w.id, w.scheduleState]),
		[
			[first.id, "fired"],
			[second.id, "armed"],
		],
	);
});

test("cloneScheduledInstance refuses a workflow that isn't a scheduled instance", () => {
	const plain = createWorkflow("not scheduled");
	assert.throws(() => cloneScheduledInstance(plain.id, "2026-10-01T07:00:00.000Z"), /not an instance of a schedule/);
	assert.throws(() => cloneScheduledInstance("nope", "2026-10-01T07:00:00.000Z"), /unknown workflow/);
});

test("conversation_context stays identical across generations; the block reaches the context step only", () => {
	const first = armedSeries("Context check");
	setWorkflowStatus(first.id, "completed");
	const second = fire(first.id, "2026-10-01T07:00:00.000Z");
	const secondFired = attachPreviousRun(second.id);
	setWorkflowStatus(second.id, "completed");
	const third = fire(second.id, "2026-10-02T07:00:00.000Z");
	const thirdFired = attachPreviousRun(third.id);
	const fourth = fire(third.id, "2026-10-03T07:00:00.000Z");

	for (const wf of [first, secondFired, thirdFired, fourth]) {
		assert.equal(getWorkflow(wf.id)!.conversationContext, CONTEXT, `${wf.name}: context never grows`);
	}

	// The block names the previous instance, its outcome and its results dir.
	const block = thirdFired.previousRunBlock!;
	assert.equal(block, buildPreviousRunBlock(getWorkflow(second.id)!));
	assert.match(block, new RegExp(`id ${second.id}`));
	assert.match(block, /Final status: completed/);
	assert.ok(block.includes(stepResultsDir(second.agentName)));
	assert.ok(path.isAbsolute(stepResultsDir(second.agentName)));
	assert.match(block, /may read the files/);
	// ...and only the IMMEDIATE previous run — no accumulated history.
	assert.ok(!block.includes(first.id));
	assert.ok(!block.includes(stepResultsDir(first.agentName)));
	assert.equal(fourth.previousRunBlock, null, "the clone doesn't inherit its source's block");

	// It is delivered through the context step: label and actual payload.
	const contextStep = getContextStep(third.id)!;
	assert.ok(contextStep.description.includes(CONTEXT));
	assert.ok(contextStep.description.includes(block));
	const payload = composeStepInput(contextStep, getWorkflow(third.id)!);
	assert.ok(payload.includes(CONTEXT));
	assert.ok(payload.includes(block));
	// ...and not through the task steps' own prompts.
	const task = listSteps(third.id).find((s) => s.kind === "task")!;
	assert.ok(!composeStepInput(task, getWorkflow(third.id)!).includes(block));
	// A normal clone of a fired instance copies the context, never the block.
	const copy = cloneWorkflow(third.id);
	assert.equal(copy.conversationContext, CONTEXT);
	assert.equal(copy.previousRunBlock, null);
	assert.ok(!getContextStep(copy.id)!.description.includes(block));
});

test("a workflow with no context text still gets a context step for the block", () => {
	const wf = createWorkflow("no context");
	addStep(wf.id, "only step");
	const first = setSchedule(wf.id, { spec: { kind: "daily", time: "09:00" }, timezone: "UTC" }, { now: NOW });
	assert.equal(getContextStep(first.id), null);
	const second = attachPreviousRun(fire(first.id, "2026-10-01T09:00:00.000Z").id);
	assert.equal(second.conversationContext, null);
	const step = getContextStep(second.id)!;
	assert.equal(step.description, second.previousRunBlock);
	assert.ok(composeStepInput(step, second).includes(second.previousRunBlock!));
});

test("include_previous off (or no previous instance) means no block", () => {
	const off = armedSeries("Toggle off", { includePrevious: false });
	const next = attachPreviousRun(fire(off.id, "2026-10-01T07:00:00.000Z").id);
	assert.equal(next.previousRunBlock, null);
	assert.ok(!getContextStep(next.id)!.description.includes("Previous run"));
	// the first instance of a series has nothing to reference
	const first = attachPreviousRun(armedSeries("First run").id);
	assert.equal(first.previousRunBlock, null);
});

test("docker: the previous run's results dir is added to the new instance's hook and survives a re-sync", () => {
	const first = armedSeries("Docker series", { sandbox: "docker" });
	const prevDir = stepResultsDir(first.agentName);
	fs.mkdirSync(prevDir, { recursive: true });
	fs.writeFileSync(path.join(prevDir, "01-collect-the-orders.md"), "# Step 1\n");
	const second = fire(first.id, "2026-10-01T07:00:00.000Z");
	assert.equal(hookRuntime(second.hookUrl).sandbox?.kind, "docker");
	assert.ok(!hookRuntime(second.hookUrl).sandbox?.mounts?.includes(prevDir), "not before it fires");

	const fired = attachPreviousRun(second.id);
	const mounts = hookRuntime(fired.hookUrl).sandbox?.mounts ?? [];
	assert.ok(mounts.includes(prevDir), `mounts: ${JSON.stringify(mounts)}`);
	// Only the previous run's own directory: never the hub home or the steps root.
	assert.ok(!mounts.includes(tmpHome));
	assert.ok(!mounts.includes(path.dirname(prevDir)));
	// The hook's list is replaced wholesale on a Settings/mounts re-sync — the
	// previous-run mount must be part of what it's replaced with.
	syncWorkflowDockerMounts(getWorkflow(fired.id)!);
	assert.ok(hookRuntime(fired.hookUrl).sandbox?.mounts?.includes(prevDir));
	// The source's own hook is untouched.
	assert.ok(!hookRuntime(first.hookUrl).sandbox?.mounts?.includes(stepResultsDir(second.agentName)));
});

test("docker: no mount when the previous run left no results directory", () => {
	const first = armedSeries("Docker empty", { sandbox: "docker" });
	const prevDir = stepResultsDir(first.agentName);
	fs.rmSync(prevDir, { recursive: true, force: true });
	const fired = attachPreviousRun(fire(first.id, "2026-10-01T07:00:00.000Z").id);
	assert.ok(fired.previousRunBlock?.includes(prevDir), "the block still names it");
	assert.ok(!(hookRuntime(fired.hookUrl).sandbox?.mounts ?? []).includes(prevDir));
	assert.equal(fs.existsSync(prevDir), false, "nothing created on the host either");
});
