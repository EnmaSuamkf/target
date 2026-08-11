/**
 * Tests for the agent-facing copy of each step's result (step-results.ts):
 * `~/.target/steps/<agent name>/<NN>-<slug>.md`, plus the line in every exec
 * prompt that tells the agent the directory is there.
 *
 * What actually has to hold, and why each part matters:
 *
 *  - the files land under the hub's own TARGET_HOME and NOWHERE inside the
 *    workflow's workdir. The workdir is usually a project the hub was merely
 *    pointed at, and a directory of the hub's scratch notes appearing in
 *    somebody else's repository is the bug this layout exists to prevent;
 *  - a `sandbox: docker` workflow gets that directory added to its hook's bind
 *    mounts, since `$HOME` is never mounted into a container and the prompt
 *    names an absolute path the agent has to be able to open;
 *  - the result is NOT truncated. The 500-char cut exists for the operator's
 *    summary view and would make "read what step 3 produced" useless;
 *  - the operator's progress file keeps behaving exactly as it did;
 *  - and `composeStepInput` names the directory, because a file the agent is
 *    never told about is no better than one it can't reach.
 *
 * Same throwaway HOME/TARGET_HOME/AWB_HOME + real awb hook setup as the other
 * dispatch suites.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-step-results-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { createAwbHook, hookRuntime } = await import("./awb.ts");
const { completeStep, getStep, getWorkflow, insertStep, insertWorkflow } = await import("./db.ts");
const { composeStepInput } = await import("./runner.ts");
const { stepResultFileName, stepResultsDir, stepResultsNote, writeStepResults } = await import("./step-results.ts");
const { writeStatusMd } = await import("./workflow.ts");

let seq = 0;

/** A workflow on a real awb hook, so its runtime resolves exactly as in production. */
function makeWorkflow(options: { sandbox?: "docker" } = {}) {
	const id = `sr-wf-${++seq}`;
	const agentName = `sr-agent-${seq}`;
	const workdir = path.join(tmpHome, "sandboxes", agentName);
	const hook = createAwbHook(agentName, workdir, "{{payload}}", { runner: "claude", sandbox: options.sandbox });
	const workflow = insertWorkflow({
		id,
		name: `results ${id}`,
		agentName,
		hookUrl: hook.hookUrl,
		secret: hook.secret,
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	return { workflow, workdir };
}

test("a completed step's result is readable at ~/.target/steps/<agent>/<NN>-<slug>.md", () => {
	const { workflow } = makeWorkflow();
	const step = insertStep(workflow.id, "Investigate the flaky migration");
	completeStep(step.id, { ok: true, result: "The migration races with the WAL checkpoint." });

	writeStatusMd(workflow.id);

	const file = path.join(
		String(process.env.TARGET_HOME),
		"steps",
		workflow.agentName,
		"01-investigate-the-flaky-migration.md",
	);
	assert.ok(fs.existsSync(file), `expected ${file}`);
	const body = fs.readFileSync(file, "utf8");
	assert.match(body, /^# Step 1: Investigate the flaky migration$/m);
	assert.match(body, /The migration races with the WAL checkpoint\./);
	assert.match(body, /- Status: done/);
});

test("nothing whatsoever is written into the workflow's workdir", () => {
	const { workflow, workdir } = makeWorkflow();
	const step = insertStep(workflow.id, "touch the repo");
	completeStep(step.id, { ok: true, result: "a result" });

	writeStatusMd(workflow.id);

	// The hub was pointed at this directory; it is not the hub's to scribble in.
	assert.equal(fs.existsSync(path.join(workdir, ".target")), false, "no .target/ in the target project");
	assert.deepEqual(fs.readdirSync(workdir), [], "the workdir is left exactly as it was found");
});

test("the files are numbered in workflow order, so `ls` reads as the workflow", () => {
	const { workflow } = makeWorkflow();
	const steps = ["first thing", "second thing", "third thing"].map((d) => insertStep(workflow.id, d));
	for (const [i, step] of steps.entries()) completeStep(step.id, { ok: true, result: `result ${i + 1}` });

	writeStatusMd(workflow.id);

	assert.deepEqual(fs.readdirSync(stepResultsDir(workflow.agentName)).sort(), [
		"01-first-thing.md",
		"02-second-thing.md",
		"03-third-thing.md",
	]);
});

test("the result is NOT truncated — that 500-char limit belongs to the operator's summary", () => {
	const { workflow } = makeWorkflow();
	const step = insertStep(workflow.id, "produce a long answer");
	const long = "x".repeat(5000);
	completeStep(step.id, { ok: true, result: long });

	writeStatusMd(workflow.id);

	const agentCopy = fs.readFileSync(
		path.join(stepResultsDir(workflow.agentName), "01-produce-a-long-answer.md"),
		"utf8",
	);
	assert.ok(agentCopy.includes(long), "the agent gets the whole thing");
	// …while the operator's progress file is unchanged: still the 500-char cut
	// with its ellipsis. Two readers, two views, neither one broken by the other.
	const operatorCopy = fs.readFileSync(getWorkflow(workflow.id)!.mdPath, "utf8");
	assert.ok(!operatorCopy.includes(long));
	assert.match(operatorCopy, /- Result: x{500}…/);
});

test("a re-run overwrites its file instead of leaving two answers in it", () => {
	const { workflow } = makeWorkflow();
	const step = insertStep(workflow.id, "the step");
	completeStep(step.id, { ok: true, result: "first answer" });
	writeStatusMd(workflow.id);

	// A retry clears and re-completes the same step row.
	completeStep(step.id, { ok: true, result: "second answer" });
	// completeStep only acts on a live step, so re-run it the way a retry does.
	const file = path.join(stepResultsDir(workflow.agentName), "01-the-step.md");
	writeStepResults(getWorkflow(workflow.id)!, [{ ...getStep(step.id)!, result: "second answer" }]);

	const body = fs.readFileSync(file, "utf8");
	assert.match(body, /second answer/);
	assert.ok(!body.includes("first answer"), "no stale answer left behind");
});

test("a step with no result writes no file, and an empty workflow writes no directory", () => {
	const { workflow } = makeWorkflow();
	insertStep(workflow.id, "never ran");

	writeStatusMd(workflow.id);

	assert.equal(fs.existsSync(stepResultsDir(workflow.agentName)), false, "nothing to say, nothing written");
});

test("a remote hook still gets its results filed hub-side — the store is the hub's, not the agent's", () => {
	const workflow = insertWorkflow({
		id: "sr-remote",
		name: "remote",
		agentName: "sr-remote-agent",
		// Not a loopback hook this hub registered, so there is no local hook to touch.
		hookUrl: "http://example.invalid:8890/hook/elsewhere",
		secret: "s",
		mdPath: path.join(tmpHome, "sr-remote.md"),
		conversationContext: null,
	});
	const step = insertStep(workflow.id, "remote step");
	completeStep(step.id, { ok: true, result: "done over there" });

	assert.deepEqual(writeStepResults(getWorkflow(workflow.id)!, [getStep(step.id)!]), [
		path.join(stepResultsDir("sr-remote-agent"), "01-remote-step.md"),
	]);
	// And the operator's progress file is still written, as it always was.
	writeStatusMd(workflow.id);
	assert.match(fs.readFileSync(workflow.mdPath, "utf8"), /done over there/);
});

test("the filename is derived from the step, padded and capped", () => {
	const { workflow } = makeWorkflow();
	const short = insertStep(workflow.id, "Fix the *thing*, please!");
	assert.equal(stepResultFileName(getStep(short.id)!), "01-fix-the-thing-please.md");
	// Two digits from the start, so step 10 doesn't sort before step 2.
	assert.equal(stepResultFileName({ ...getStep(short.id)!, orderIndex: 9 }), "10-fix-the-thing-please.md");
	// A step description can be a paragraph; a filename cannot.
	const long = insertStep(workflow.id, "word ".repeat(80));
	assert.ok(stepResultFileName(getStep(long.id)!).length <= 3 + 60 + 3);
});

// --- the sandbox half: an absolute path is only useful if it resolves ------

test("a docker workflow bind-mounts its results directory, once, and only once it exists", () => {
	const { workflow } = makeWorkflow({ sandbox: "docker" });
	assert.deepEqual(hookRuntime(workflow.hookUrl).sandbox?.mounts, [], "nothing to mount before anything is written");

	const step = insertStep(workflow.id, "the step");
	completeStep(step.id, { ok: true, result: "a result" });
	writeStatusMd(workflow.id);

	const dir = stepResultsDir(workflow.agentName);
	assert.deepEqual(hookRuntime(workflow.hookUrl).sandbox?.mounts, [dir], "the exact directory, not the hub home");
	// Written again on the next transition: the mount must not accumulate.
	writeStatusMd(workflow.id);
	assert.deepEqual(hookRuntime(workflow.hookUrl).sandbox?.mounts, [dir]);
});

test("a host workflow's hook is left alone — there is no boundary to punch through", () => {
	const { workflow } = makeWorkflow();
	const step = insertStep(workflow.id, "the step");
	completeStep(step.id, { ok: true, result: "a result" });

	writeStatusMd(workflow.id);

	assert.equal(hookRuntime(workflow.hookUrl).sandbox, null);
});

// --- the prompt half: the agent has to be told the directory exists ---

test("composeStepInput names the directory, with its absolute path", () => {
	const { workflow } = makeWorkflow();
	const step = insertStep(workflow.id, "the step");

	const input = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, {});

	assert.ok(input.includes(stepResultsDir(workflow.agentName)), "the exact path the agent will open");
	assert.match(input, /read those files instead of relying on your memory of this thread/);
});

test("the note explains WHY, since a bare path would just be a path", () => {
	// It has to connect the files to compaction: an agent that doesn't know its
	// own history can vanish has no reason to prefer a file over its memory.
	const note = stepResultsNote("some-agent");
	assert.match(note, /compacted/);
	assert.ok(note.includes(`${stepResultsDir("some-agent")}/`));
	// Never the workdir: the whole point is that the hub writes outside it.
	assert.ok(!note.includes("workdir"));
});

test("the judge prompt is left alone", () => {
	const { workflow } = makeWorkflow();
	const step = insertStep(workflow.id, "the step", { acceptanceCriteria: "must be X" });

	const judge = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, { mode: "judge" });

	// The judge is already told, at length, to re-inspect the real artifacts
	// rather than trust the thread; a second pointer at one particular directory
	// would narrow that instruction, not strengthen it.
	assert.ok(!judge.includes(stepResultsDir(workflow.agentName)));
});
