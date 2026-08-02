/**
 * Tests for the agent-facing copy of each step's result (step-results.ts):
 * `<workdir>/.target/steps/<NN>-<slug>.md`, plus the line in every exec prompt
 * that tells the agent the directory is there.
 *
 * What actually has to hold, and why each part matters:
 *
 *  - the file lands INSIDE the workdir. That's the whole point: the workdir is
 *    the one directory mounted into the docker sandbox, so a result written
 *    anywhere else (notably `~/.target/<slug>-<id>.md`, which is under `$HOME`
 *    and deliberately never mounted) is unreadable to a sandboxed agent;
 *  - it is NOT truncated. The 500-char cut exists for the operator's summary
 *    view and would make "read what step 3 produced" useless;
 *  - the operator's progress file keeps behaving exactly as it did;
 *  - and `composeStepInput` names the directory, because a file the agent is
 *    never told about is no better than one it can't reach.
 *
 * Same throwaway HOME/TARGET_HOME/AWB_HOME + real awb hook setup as the other
 * dispatch suites — `hookRuntime` has to resolve a real workdir or there is
 * nowhere to write.
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

const { createAwbHook } = await import("./awb.ts");
const { completeStep, getStep, getWorkflow, insertStep, insertWorkflow } = await import("./db.ts");
const { composeStepInput } = await import("./runner.ts");
const { stepResultFileName, stepResultsDir, stepResultsNote, writeStepResults } = await import("./step-results.ts");
const { writeStatusMd } = await import("./workflow.ts");

let seq = 0;

/** A workflow on a real awb hook, so its workdir resolves exactly as in production. */
function makeWorkflow() {
	const id = `sr-wf-${++seq}`;
	const agentName = `sr-agent-${seq}`;
	const workdir = path.join(tmpHome, "sandboxes", agentName);
	const hook = createAwbHook(agentName, workdir, "{{payload}}", { runner: "claude" });
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

test("a completed step's result is readable at <workdir>/.target/steps/<NN>-<slug>.md", () => {
	const { workflow, workdir } = makeWorkflow();
	const step = insertStep(workflow.id, "Investigate the flaky migration");
	completeStep(step.id, { ok: true, result: "The migration races with the WAL checkpoint." });

	writeStatusMd(workflow.id);

	const file = path.join(workdir, ".target", "steps", "01-investigate-the-flaky-migration.md");
	assert.ok(fs.existsSync(file), `expected ${file}`);
	const body = fs.readFileSync(file, "utf8");
	assert.match(body, /^# Step 1: Investigate the flaky migration$/m);
	assert.match(body, /The migration races with the WAL checkpoint\./);
	assert.match(body, /- Status: done/);
});

test("the files are numbered in workflow order, so `ls` reads as the workflow", () => {
	const { workflow, workdir } = makeWorkflow();
	const steps = ["first thing", "second thing", "third thing"].map((d) => insertStep(workflow.id, d));
	for (const [i, step] of steps.entries()) completeStep(step.id, { ok: true, result: `result ${i + 1}` });

	writeStatusMd(workflow.id);

	assert.deepEqual(fs.readdirSync(stepResultsDir(workdir)).sort(), [
		"01-first-thing.md",
		"02-second-thing.md",
		"03-third-thing.md",
	]);
});

test("the result is NOT truncated — that 500-char limit belongs to the operator's summary", () => {
	const { workflow, workdir } = makeWorkflow();
	const step = insertStep(workflow.id, "produce a long answer");
	const long = "x".repeat(5000);
	completeStep(step.id, { ok: true, result: long });

	writeStatusMd(workflow.id);

	const agentCopy = fs.readFileSync(path.join(stepResultsDir(workdir), "01-produce-a-long-answer.md"), "utf8");
	assert.ok(agentCopy.includes(long), "the agent gets the whole thing");
	// …while the operator's progress file is unchanged: still the 500-char cut
	// with its ellipsis. Two readers, two views, neither one broken by the other.
	const operatorCopy = fs.readFileSync(getWorkflow(workflow.id)!.mdPath, "utf8");
	assert.ok(!operatorCopy.includes(long));
	assert.match(operatorCopy, /- Result: x{500}…/);
});

test("a re-run overwrites its file instead of leaving two answers in it", () => {
	const { workflow, workdir } = makeWorkflow();
	const step = insertStep(workflow.id, "the step");
	completeStep(step.id, { ok: true, result: "first answer" });
	writeStatusMd(workflow.id);

	// A retry clears and re-completes the same step row.
	completeStep(step.id, { ok: true, result: "second answer" });
	// completeStep only acts on a live step, so re-run it the way a retry does.
	const file = path.join(stepResultsDir(workdir), "01-the-step.md");
	writeStepResults(getWorkflow(workflow.id)!, [{ ...getStep(step.id)!, result: "second answer" }]);

	const body = fs.readFileSync(file, "utf8");
	assert.match(body, /second answer/);
	assert.ok(!body.includes("first answer"), "no stale answer left behind");
});

test("a step with no result writes no file, and an empty workflow writes no directory", () => {
	const { workflow, workdir } = makeWorkflow();
	insertStep(workflow.id, "never ran");

	writeStatusMd(workflow.id);

	assert.equal(fs.existsSync(stepResultsDir(workdir)), false, "nothing to say, nothing written");
});

test("writing is best-effort: a workflow whose hook has no local workdir is a no-op, not a throw", () => {
	const workflow = insertWorkflow({
		id: "sr-remote",
		name: "remote",
		agentName: "sr-remote-agent",
		// Not a loopback hook this hub registered, so `hookRuntime` resolves no workdir.
		hookUrl: "http://example.invalid:8890/hook/elsewhere",
		secret: "s",
		mdPath: path.join(tmpHome, "sr-remote.md"),
		conversationContext: null,
	});
	const step = insertStep(workflow.id, "remote step");
	completeStep(step.id, { ok: true, result: "done over there" });

	assert.deepEqual(writeStepResults(getWorkflow(workflow.id)!, [getStep(step.id)!]), []);
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

// --- the prompt half: the agent has to be told the directory exists ---

test("composeStepInput names the directory, with the workdir's absolute path", () => {
	const { workflow, workdir } = makeWorkflow();
	const step = insertStep(workflow.id, "the step");

	const input = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, {});

	assert.ok(input.includes(stepResultsDir(workdir)), "the exact path the agent will open");
	assert.match(input, /\.target\/steps/);
	assert.match(input, /read those files instead of relying on your memory of this thread/);
});

test("the note explains WHY, since a bare path would just be a path", () => {
	// It has to connect the files to compaction: an agent that doesn't know its
	// own history can vanish has no reason to prefer a file over its memory.
	const note = stepResultsNote("/srv/workdir");
	assert.match(note, /compacted/);
	assert.match(note, /\/srv\/workdir\/\.target\/steps\//);
	// A remote hook has no absolute path we could honestly name, so the note
	// falls back to the workdir-relative one rather than inventing one.
	assert.match(stepResultsNote(null), /`\.target\/steps\/`/);
});

test("the judge prompt is left alone", () => {
	const { workflow } = makeWorkflow();
	const step = insertStep(workflow.id, "the step", { acceptanceCriteria: "must be X" });

	const judge = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, { mode: "judge" });

	// The judge is already told, at length, to re-inspect the real artifacts
	// rather than trust the thread; a second pointer at one particular directory
	// would narrow that instruction, not strengthen it.
	assert.ok(!judge.includes(".target/steps"));
});
