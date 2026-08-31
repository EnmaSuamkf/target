/**
 * A delegated step has to carry its TCP tools and Resource Sets down into the
 * subagent.
 *
 * The hub injects those catalogs into the step's prompt, and that prompt goes to
 * the agent on the shared thread. When the step delegates (the `useSubagent`
 * default, or the context-pressure override), the work happens in a Task-tool
 * subagent that starts from a fresh context and inherits nothing from the
 * thread — so a catalog delivered only to the thread reaches the agent that
 * hands the work off and never the agent that does it. The tools are then
 * silently absent for the step that was supposed to use them.
 *
 * The hub never sees the Task call, so it cannot put the material in the
 * subagent itself. The two things it can do are both asserted here:
 *
 *  1. the catalog is present on EVERY delegated dispatch, not just the first
 *     (the once-only rule is for the thread, which remembers; a subagent
 *     doesn't), and
 *  2. the prompt tells the agent to copy the blocks into the subagent verbatim.
 *
 * Same throwaway-TARGET_HOME convention as the other runner suites.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-subagent-attachments-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { insertWorkflow, insertStep, getStep, getWorkflow, markStepQueued } = await import("./db.ts");
const { insertTcp, setWorkflowTcps } = await import("./tcp-store.ts");
const { insertResourceSet, setWorkflowResourceSelections } = await import("./rci-store.ts");
const { composeStepInput, shouldInjectAttachmentCatalog, SUBAGENT_ATTACHMENTS_SUFFIX } = await import("./runner.ts");

function newWorkflow(name: string) {
	return insertWorkflow({
		id: crypto.randomUUID(),
		name,
		agentName: `agent-${name}`,
		hookUrl: "http://127.0.0.1/hook/x",
		secret: "s",
		mdPath: path.join(tmpHome, `${name}.md`),
	});
}

function attachTcp(workflowId: string) {
	const tcp = insertTcp({
		name: "github",
		tools: [
			{
				name: "get_me",
				description: "Gets the authenticated user",
				requestTemplate: "curl https://api.github.com/user",
				inputs: [],
				tokens: {},
			},
		],
	});
	setWorkflowTcps(workflowId, [tcp.id]);
	return tcp;
}

function attachResources(workflowId: string) {
	const set = insertResourceSet({
		name: "kit",
		resources: [{ name: "reviewer", description: "Reviews diffs", content: "You review code.", files: [] }],
	});
	setWorkflowResourceSelections(workflowId, [{ resourceSetId: set.id }]);
	return set;
}

test("a delegated step is told to carry the TCP catalog into the subagent", () => {
	const workflow = newWorkflow("delegated-tcp");
	const tcp = attachTcp(workflow.id);
	const step = getStep(insertStep(workflow.id, "call the tool", { useSubagent: true }).id)!;

	const input = composeStepInput(step, getWorkflow(workflow.id)!, { injectTcp: true, injectResources: true });

	// The catalog itself, with the ids the subagent needs to build a call.
	assert.match(input, /TCP tools available/);
	assert.match(input, /get_me/);
	assert.match(input, new RegExp(tcp.id));
	// …and the instruction to pass it on, without which the block only ever
	// reaches the thread that delegates.
	assert.ok(input.includes(SUBAGENT_ATTACHMENTS_SUFFIX), "the delegating agent is told to copy the catalog down");
	assert.match(input, /verbatim/);
});

test("the same instruction covers RCI resources", () => {
	const workflow = newWorkflow("delegated-rci");
	attachResources(workflow.id);
	const step = getStep(insertStep(workflow.id, "use the skill", { useSubagent: true }).id)!;

	const input = composeStepInput(step, getWorkflow(workflow.id)!, { injectTcp: true, injectResources: true });

	assert.match(input, /Resources available to this workflow/);
	assert.match(input, /You review code\./);
	assert.ok(input.includes(SUBAGENT_ATTACHMENTS_SUFFIX), "resources need carrying down just as tools do");
});

test("an inline step is NOT told to copy anything — it does the work in this thread", () => {
	const workflow = newWorkflow("inline-tcp");
	attachTcp(workflow.id);
	const step = getStep(insertStep(workflow.id, "call the tool here", { useSubagent: false }).id)!;

	const input = composeStepInput(step, getWorkflow(workflow.id)!, { injectTcp: true, injectResources: true });

	assert.match(input, /TCP tools available/, "the catalog still reaches an inline step");
	assert.ok(!input.includes(SUBAGENT_ATTACHMENTS_SUFFIX), "there is no subagent to carry anything to");
});

test("a step with nothing attached is not told to copy blocks that do not exist", () => {
	const workflow = newWorkflow("delegated-bare");
	const step = getStep(insertStep(workflow.id, "just do it", { useSubagent: true }).id)!;

	const input = composeStepInput(step, getWorkflow(workflow.id)!, { injectTcp: true, injectResources: true });

	assert.ok(!input.includes(SUBAGENT_ATTACHMENTS_SUFFIX), "no attachments, nothing to carry down");
});

test("the context-pressure override counts as delegated too", () => {
	// The step's toggle says inline, but pressure sent the work to a subagent
	// anyway. The material has to follow the work, not the toggle.
	const workflow = newWorkflow("forced-tcp");
	attachTcp(workflow.id);
	const step = getStep(insertStep(workflow.id, "call the tool", { useSubagent: false }).id)!;

	const forced = composeStepInput(step, getWorkflow(workflow.id)!, {
		injectTcp: true,
		injectResources: true,
		forceSubagent: true,
	});
	assert.ok(forced.includes(SUBAGENT_ATTACHMENTS_SUFFIX), "an overridden step delegates, so it must carry the tools");

	const notForced = composeStepInput(step, getWorkflow(workflow.id)!, { injectTcp: true, injectResources: true });
	assert.ok(!notForced.includes(SUBAGENT_ATTACHMENTS_SUFFIX));
});

test("the judge pass never carries the catalog — it grades, it does not run tools", () => {
	const workflow = newWorkflow("judge-tcp");
	attachTcp(workflow.id);
	const step = getStep(insertStep(workflow.id, "call the tool", { useSubagent: true, acceptanceCriteria: "ok" }).id)!;

	const judge = composeStepInput(step, getWorkflow(workflow.id)!, { mode: "judge", injectTcp: true });
	assert.ok(!judge.includes(SUBAGENT_ATTACHMENTS_SUFFIX));
	assert.doesNotMatch(judge, /TCP tools available/);
});

// --- the injection decision itself -----------------------------------------

test("a delegated step gets the catalog on EVERY dispatch, not just the first", () => {
	// The regression this guards: the once-only rule is written for the shared
	// thread. A second delegated step used to get no catalog at all, so its
	// subagent had no way to know the tools existed.
	const workflow = newWorkflow("every-dispatch");
	attachTcp(workflow.id);
	const first = getStep(insertStep(workflow.id, "step one", { useSubagent: true }).id)!;
	const second = getStep(insertStep(workflow.id, "step two", { useSubagent: true }).id)!;

	// Simulate the first step having already run: the conversation exists and a
	// task has been queued, which is exactly what closes the once-only window.
	markStepQueued(first.id);

	const observed = getWorkflow(workflow.id)!;
	assert.equal(
		shouldInjectAttachmentCatalog(getStep(second.id)!, observed),
		true,
		"a later delegated step still needs the catalog in its own prompt",
	);

	// An inline later step gets it too. The old rule withheld it here on the
	// theory that the thread remembers — but the thread may have been compacted,
	// the step may be a retry, and the execute url carries a per-step credential
	// that is not the one an earlier prompt handed over.
	const inlineStep = getStep(insertStep(workflow.id, "step three", { useSubagent: false }).id)!;
	assert.equal(
		shouldInjectAttachmentCatalog(inlineStep, observed),
		true,
		"an inline step carries the catalog as well — it is a capability, not background",
	);
});

test("a workflow with nothing attached never injects, delegated or not", () => {
	const workflow = newWorkflow("bare-decision");
	const step = getStep(insertStep(workflow.id, "nothing attached", { useSubagent: true }).id)!;
	assert.equal(shouldInjectAttachmentCatalog(step, getWorkflow(workflow.id)!), false);
});

test("the judge pass is never a reason to inject", () => {
	const workflow = newWorkflow("judge-decision");
	attachTcp(workflow.id);
	const step = getStep(insertStep(workflow.id, "graded", { useSubagent: true }).id)!;
	assert.equal(shouldInjectAttachmentCatalog(step, getWorkflow(workflow.id)!, { mode: "judge" }), false);
});

test("a workflow with only Resource Sets attached injects too", () => {
	// RCI is independent of TCP: resources with no tools must still arrive.
	const workflow = newWorkflow("rci-only-decision");
	attachResources(workflow.id);
	const step = getStep(insertStep(workflow.id, "use the skill", { useSubagent: true }).id)!;
	assert.equal(shouldInjectAttachmentCatalog(step, getWorkflow(workflow.id)!), true);
});
