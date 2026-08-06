/**
 * Tests for the two workflow-level edits the UI's header offers:
 *
 *  - **Clone** (`cloneWorkflow`, `POST /api/workflows/:id/clone`): a second
 *    workflow, named `Clone - <original>`, carrying the original's DEFINITION
 *    (every task step in order with its judge/gate/retry config, the
 *    conversation context, the runtime its agent runs under) and none of its
 *    history (status, session, results, errors, retry counters).
 *  - **Rename** (`renameWorkflow`, `PATCH /api/workflows/:id/name`): the label
 *    only — the agent name, hook URL and `.md` path keep the slug they were
 *    created with, so a rename is safe at any status.
 *
 * Both are exercised twice: through the engine (where the copy rules live) and
 * through the real HTTP server (routing, admin gate, status codes).
 *
 * Same throwaway-TARGET_HOME convention as workflow.test.ts/server.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-clone-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too: createAwbHook (reached via createWorkflow, and again by every
// clone) would otherwise write test hooks into the operator's real broker config.
process.env.AWB_HOME = tmpHome;

const { completeStep, getWorkflow, listSteps, markStepRunning, setWorkflowSessionId, setWorkflowStatus } =
	await import("./db.ts");
const { addStep, cloneWorkflow, createWorkflow, renameWorkflow, setConversationContext } =
	await import("./workflow.ts");
const { hookRuntime } = await import("./awb.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

/** A workflow with three steps, the middle one carrying every per-step option. */
function seedWorkflow(name: string) {
	const workflow = createWorkflow(name);
	addStep(workflow.id, "first task");
	addStep(workflow.id, "second task", {
		acceptanceCriteria: "the tests pass",
		manualReview: true,
		useSubagent: false,
		maxRetries: 3,
		retryIntervalSeconds: 45,
	});
	addStep(workflow.id, "third task");
	return workflow;
}

test("cloneWorkflow copies every step, in order, with its whole configuration", () => {
	const source = seedWorkflow("nightly release");

	const clone = cloneWorkflow(source.id);

	assert.equal(clone.name, "Clone - nightly release");
	assert.notEqual(clone.id, source.id);
	assert.notEqual(clone.agentName, source.agentName);
	assert.notEqual(clone.hookUrl, source.hookUrl);
	assert.notEqual(clone.mdPath, source.mdPath);

	const copied = listSteps(clone.id);
	assert.deepEqual(
		copied.map((s) => s.description),
		["first task", "second task", "third task"],
	);
	assert.deepEqual(
		copied.map((s) => s.orderIndex),
		[0, 1, 2],
	);
	const second = copied[1];
	assert.equal(second?.acceptanceCriteria, "the tests pass");
	assert.equal(second?.manualReview, true);
	assert.equal(second?.useSubagent, false);
	assert.equal(second?.maxRetries, 3);
	assert.equal(second?.retryIntervalSeconds, 45);
});

test("cloneWorkflow leaves the original untouched", () => {
	const source = seedWorkflow("untouched");
	const before = listSteps(source.id).map((s) => s.id);

	cloneWorkflow(source.id);

	const after = getWorkflow(source.id);
	assert.equal(after?.name, "untouched");
	assert.deepEqual(
		listSteps(source.id).map((s) => s.id),
		before,
	);
});

test("a clone starts clean: no run state, no results, nothing carried over from the original's run", () => {
	const source = seedWorkflow("half run");
	const steps = listSteps(source.id);
	const first = steps[0];
	assert.ok(first);
	// Put the original mid-run: a session, a running→done step with a result,
	// and a failed one carrying an error.
	setWorkflowStatus(source.id, "running");
	setWorkflowSessionId(source.id, "session-from-the-original");
	markStepRunning(first.id);
	completeStep(first.id, { ok: true, result: "shipped it", sessionId: "session-from-the-original" });
	const second = steps[1];
	assert.ok(second);
	markStepRunning(second.id);
	completeStep(second.id, { ok: false, error: "boom" });

	const clone = cloneWorkflow(source.id);

	assert.equal(clone.status, "draft");
	assert.equal(clone.lastSessionId, null);
	assert.equal(clone.contextInjected, false);
	for (const step of listSteps(clone.id)) {
		assert.equal(step.status, "pending");
		assert.equal(step.result, null);
		assert.equal(step.error, null);
		assert.equal(step.sessionId, null);
		assert.equal(step.finishedAt, null);
		assert.equal(step.retryCount, 0);
	}
	// …and the original is still exactly where it was.
	assert.equal(listSteps(source.id)[0]?.result, "shipped it");
});

test("cloneWorkflow copies the conversation context and re-materialises its context step, un-injected", () => {
	const source = createWorkflow("with background");
	addStep(source.id, "do the thing");
	setConversationContext(source.id, "we are migrating the billing service");

	const clone = cloneWorkflow(source.id);

	assert.equal(clone.conversationContext, "we are migrating the billing service");
	assert.equal(clone.contextInjected, false);
	const contextStep = listSteps(clone.id).find((s) => s.kind === "context");
	assert.ok(contextStep, "the clone has its own hub-owned context step");
	assert.equal(contextStep?.status, "pending");
	// It is the hub's step, at its reserved slot — not one of the copied tasks.
	assert.equal(contextStep?.orderIndex, -1);
	assert.deepEqual(
		listSteps(clone.id)
			.filter((s) => s.kind === "task")
			.map((s) => s.description),
		["do the thing"],
	);
});

test("a clone of a clone nests the prefix rather than replacing it", () => {
	const source = createWorkflow("original");
	const clone = cloneWorkflow(source.id);
	const cloneOfClone = cloneWorkflow(clone.id);
	assert.equal(cloneOfClone.name, "Clone - Clone - original");
});

test("cloneWorkflow refuses an unknown workflow", () => {
	assert.throws(() => cloneWorkflow("nope"), /unknown workflow/);
});

test("renameWorkflow changes the label and nothing else, and rewrites the status file", () => {
	const workflow = createWorkflow("old name");
	addStep(workflow.id, "a step");

	const renamed = renameWorkflow(workflow.id, "  new name  ");

	assert.equal(renamed.name, "new name");
	assert.equal(renamed.agentName, workflow.agentName);
	assert.equal(renamed.hookUrl, workflow.hookUrl);
	assert.equal(renamed.mdPath, workflow.mdPath);
	assert.equal(getWorkflow(workflow.id)?.name, "new name");
	assert.match(fs.readFileSync(workflow.mdPath, "utf8"), /# Workflow: new name/);
});

test("renameWorkflow refuses an empty name and an unknown workflow", () => {
	const workflow = createWorkflow("keeps its name");
	assert.throws(() => renameWorkflow(workflow.id, "   "), /name is required/);
	assert.equal(getWorkflow(workflow.id)?.name, "keeps its name");
	assert.throws(() => renameWorkflow("nope", "whatever"), /unknown workflow/);
});

test("POST /api/workflows/:id/clone returns the clone and its steps", async () => {
	const source = seedWorkflow("over http");

	const res = await fetch(`${baseUrl}/api/workflows/${source.id}/clone`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workflow: { id: string; name: string; status: string }; steps: { description: string }[] };
	assert.equal(body.workflow.name, "Clone - over http");
	assert.notEqual(body.workflow.id, source.id);
	assert.equal(body.workflow.status, "draft");
	assert.deepEqual(
		body.steps.map((s) => s.description),
		["first task", "second task", "third task"],
	);
});

test("POST /api/workflows/:id/clone needs the admin token and a workflow that exists", async () => {
	const source = createWorkflow("gated clone");

	const unauthorized = await fetch(`${baseUrl}/api/workflows/${source.id}/clone`, { method: "POST" });
	assert.equal(unauthorized.status, 401);

	const missing = await fetch(`${baseUrl}/api/workflows/does-not-exist/clone`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(missing.status, 404);
});

test("PATCH /api/workflows/:id/name renames the workflow", async () => {
	const workflow = createWorkflow("before");

	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/name`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "after" }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workflow: { name: string; agentName: string } };
	assert.equal(body.workflow.name, "after");
	// The agent it publishes keeps the name it was registered under.
	assert.equal(body.workflow.agentName, workflow.agentName);
	assert.equal(getWorkflow(workflow.id)?.name, "after");
});

test("PATCH /api/workflows/:id/name rejects an empty name, an anonymous caller and an unknown workflow", async () => {
	const workflow = createWorkflow("still here");

	const empty = await fetch(`${baseUrl}/api/workflows/${workflow.id}/name`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "  " }),
	});
	assert.equal(empty.status, 400);
	assert.equal(getWorkflow(workflow.id)?.name, "still here");

	const unauthorized = await fetch(`${baseUrl}/api/workflows/${workflow.id}/name`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "hijacked" }),
	});
	assert.equal(unauthorized.status, 401);
	assert.equal(getWorkflow(workflow.id)?.name, "still here");

	const missing = await fetch(`${baseUrl}/api/workflows/does-not-exist/name`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "whatever" }),
	});
	assert.equal(missing.status, 404);
});

// --- clone overrides: the fields the clone dialog collects on the new-workflow
// form. Three-valued, and the three values are what these cover: absent
// inherits the source's, an explicit null means the default, a value wins.

test("cloneWorkflow with no overrides inherits the source's whole runtime", () => {
	const source = createWorkflow("inherits everything", {
		workdir: path.join(tmpHome, "checkout"),
		permissionMode: "acceptEdits",
		runner: "claude",
	});

	const runtime = hookRuntime(cloneWorkflow(source.id).hookUrl);

	assert.equal(runtime.workdir, path.join(tmpHome, "checkout"));
	assert.equal(runtime.permissionMode, "acceptEdits");
	assert.equal(runtime.harness, "claude");
});

test("cloneWorkflow applies the overrides it is given, leaving the rest inherited", () => {
	const source = createWorkflow("partly changed", {
		workdir: path.join(tmpHome, "original-checkout"),
		permissionMode: "acceptEdits",
	});
	addStep(source.id, "only task");

	const clone = cloneWorkflow(source.id, {
		name: "a name of my own",
		workdir: path.join(tmpHome, "other-checkout"),
	});

	assert.equal(clone.name, "a name of my own");
	const runtime = hookRuntime(clone.hookUrl);
	assert.equal(runtime.workdir, path.join(tmpHome, "other-checkout"));
	// Untouched fields still come from the source.
	assert.equal(runtime.permissionMode, "acceptEdits");
	// And overriding the runtime changes nothing about what a clone IS.
	assert.deepEqual(
		listSteps(clone.id).map((s) => s.description),
		["only task"],
	);
});

test("an explicit null override means the default, not 'inherit'", () => {
	const source = createWorkflow("has both", {
		workdir: path.join(tmpHome, "source-checkout"),
		permissionMode: "bypassPermissions",
		sandbox: "docker",
		image: "some-image:latest",
	});

	const clone = cloneWorkflow(source.id, { workdir: null, permissionMode: null, sandbox: null });

	const runtime = hookRuntime(clone.hookUrl);
	// Cleared workdir: its OWN sandbox, never the source's directory.
	assert.equal(runtime.workdir, path.join(tmpHome, "sandboxes", clone.agentName));
	assert.equal(runtime.permissionMode, null);
	// Off docker, and the source's image does not follow it onto the host.
	assert.equal(runtime.sandbox, null);
});

test("cloneWorkflow keeps a clone off the source's directory when the source had none", () => {
	// The source is on its own per-agent sandbox, which belongs to its agent
	// alone: a second agent must not be pointed at it.
	const source = createWorkflow("on its own sandbox");

	const clone = cloneWorkflow(source.id);

	const runtime = hookRuntime(clone.hookUrl);
	assert.equal(runtime.workdir, path.join(tmpHome, "sandboxes", clone.agentName));
	assert.notEqual(runtime.workdir, hookRuntime(source.hookUrl).workdir);
});

test("POST /api/workflows/:id/clone applies the dialog's fields", async () => {
	const source = seedWorkflow("cloned over http with changes");

	const res = await fetch(`${baseUrl}/api/workflows/${source.id}/clone`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "renamed on the way out",
			workdir: path.join(tmpHome, "http-checkout"),
			runner: "claude",
			sandbox: "host",
			image: "",
			permissionMode: "acceptEdits",
		}),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		workflow: { id: string; name: string; status: string; chosenWorkdir: string; permissionMode: string };
		steps: { description: string }[];
	};

	assert.equal(body.workflow.name, "renamed on the way out");
	assert.equal(body.workflow.chosenWorkdir, path.join(tmpHome, "http-checkout"));
	assert.equal(body.workflow.permissionMode, "acceptEdits");
	assert.equal(body.workflow.status, "draft");
	// The steps are copied whatever the form said about the runtime.
	assert.deepEqual(
		body.steps.map((s) => s.description),
		["first task", "second task", "third task"],
	);
});

test("POST /api/workflows/:id/clone refuses a body it can't honour", async () => {
	const source = createWorkflow("guarded clone");

	const cases: [Record<string, unknown>, number][] = [
		[{ name: "   " }, 400],
		[{ runner: "not-a-runner" }, 400],
		[{ sandbox: "not-a-sandbox" }, 400],
		[{ permissionMode: "not-a-mode" }, 400],
		// bypassPermissions is arbitrary command execution: selecting it is not
		// the same as opting into it, even when cloning something that had it.
		[{ permissionMode: "bypassPermissions" }, 400],
	];
	for (const [body, status] of cases) {
		const res = await fetch(`${baseUrl}/api/workflows/${source.id}/clone`, {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify(body),
		});
		assert.equal(res.status, status, `body ${JSON.stringify(body)}`);
	}

	// …and the confirmed one goes through.
	const confirmed = await fetch(`${baseUrl}/api/workflows/${source.id}/clone`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ permissionMode: "bypassPermissions", acceptBypassRisk: true }),
	});
	assert.equal(confirmed.status, 200);
});

test("a workflow reports what the clone dialog needs to seed itself", async () => {
	const chosen = createWorkflow("has a checkout", {
		workdir: path.join(tmpHome, "seed-checkout"),
		permissionMode: "plan",
	});
	const own = createWorkflow("has no checkout");

	const read = async (id: string) =>
		(await (await fetch(`${baseUrl}/api/workflows/${id}`, { headers: adminHeaders() })).json()) as {
			workflow: { chosenWorkdir: string | null; permissionMode: string | null; workdir: string };
		};

	const withChoice = await read(chosen.id);
	assert.equal(withChoice.workflow.chosenWorkdir, path.join(tmpHome, "seed-checkout"));
	assert.equal(withChoice.workflow.permissionMode, "plan");

	// The per-agent sandbox is NOT reported as a chosen directory, so the dialog
	// can't seed one agent's sandbox into another agent's hook.
	const withoutChoice = await read(own.id);
	assert.equal(withoutChoice.workflow.chosenWorkdir, null);
	assert.equal(withoutChoice.workflow.workdir, path.join(tmpHome, "sandboxes", own.agentName));
	assert.equal(withoutChoice.workflow.permissionMode, null);
});

test.after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
});
