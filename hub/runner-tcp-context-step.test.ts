/**
 * TCP / RCI catalogs must inject on the first task step when a workflow uses a
 * materialised context step — the background and tool catalogs are independent.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-runner-tcp-context-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { insertWorkflow, insertStep, getContextStep, setContextInjected, open } = await import("./db.ts");
const { reconcileContextStep, setConversationContext } = await import("./workflow.ts");
const { insertTcp, setWorkflowTcps } = await import("./tcp-store.ts");
const { composeStepInput, shouldInjectAttachmentCatalog } = await import("./runner.ts");

test("TCP catalog injects on first task step after a context step", () => {
	const tcp = insertTcp({
		name: "github",
		tools: [
			{
				name: "get_me",
				description: "GitHub profile",
				requestTemplate: "curl https://api.github.com/user",
				inputs: [],
				tokens: {},
			},
		],
	});
	const workflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "tcp-with-context-step",
		agentName: "agent-tcp-context",
		hookUrl: "http://127.0.0.1/hook/x",
		secret: "s",
		mdPath: path.join(tmpHome, "w.md"),
	});
	setConversationContext(workflow.id, "WORKFLOW-BG");
	reconcileContextStep(workflow.id);
	setWorkflowTcps(workflow.id, [tcp.id]);
	setContextInjected(workflow.id, true);

	const contextStep = getContextStep(workflow.id)!;
	open().prepare("UPDATE steps SET status = 'done' WHERE id = ?").run(contextStep.id);
	const taskStep = insertStep(workflow.id, "step 1");

	assert.equal(
		shouldInjectAttachmentCatalog(contextStep, workflow),
		false,
		"context step itself must not carry the TCP catalog",
	);
	assert.equal(
		shouldInjectAttachmentCatalog(taskStep, workflow),
		true,
		"first task step after context should inject TCP catalog",
	);
	// The regression this file exists for: `context_injected` set and the context
	// step already done used to mean the catalog was injected NEVER, on any step
	// of the workflow. Injection no longer depends on that state at all.
	const secondTask = insertStep(workflow.id, "step 2");
	assert.equal(
		shouldInjectAttachmentCatalog(secondTask, workflow),
		true,
		"a later task step still carries the catalog — capability, not background",
	);

	const prompt = composeStepInput(taskStep, workflow, {
		injectTcp: true,
		injectContext: false,
		tcpExecuteUrl: "http://127.0.0.1:9/api/tcps/execute?stepId=s&token=t",
	});
	assert.match(prompt, /get_me/);
	// The callable form: where to POST, and the body that tool takes.
	assert.match(prompt, /POST http:\/\/127\.0\.0\.1:9\/api\/tcps\/execute/);
	assert.match(prompt, /"toolName":\s*"get_me"/);
	assert.doesNotMatch(prompt, /WORKFLOW-BG/);
});
