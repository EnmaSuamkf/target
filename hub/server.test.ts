/**
 * Tests for the routes that seed a workflow's steps from a template:
 *
 *  - POST /api/workflows accepts an optional templateId and, when given,
 *    seeds the new workflow with that template's steps (same order, same
 *    judge config) right after creating it.
 *  - POST /api/workflows/:id/steps/from-template does the same thing for an
 *    already-existing workflow, appending after whatever steps it already has.
 *
 * Everything else about workflow creation/step management is already covered
 * elsewhere (workflow.test.ts); this only exercises the templateId paths,
 * through the real HTTP server so the wiring in server.ts is covered too.
 *
 * Same throwaway-TARGET_HOME convention as workflow.test.ts/templates.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-server-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too: createAwbHook (reached via POST /api/workflows → createWorkflow)
// would otherwise write test hooks into the REAL ~/.agent-webhook-bridge/hooks.json,
// polluting the operator's broker and, on a lost-update, clobbering a real hook
// (which then 404s on dispatch after the next awb restart). Point AWB_HOME at the
// same throwaway dir so each suite gets its own empty hooks.json.
process.env.AWB_HOME = tmpHome;

const { insertTemplate, setWorkflowSessionId } = await import("./db.ts");
const { deleteAwbHook } = await import("./awb.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { _impl: terminalImpl } = await import("./terminal.ts");
const { transcriptPath } = await import("./transcript.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
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

test("POST /api/workflows with a templateId seeds the new workflow with the template's steps, in order", async () => {
	const template = insertTemplate({
		name: "release checklist",
		tags: ["release"],
		steps: [
			{ description: "bump version" },
			{ description: "write changelog", acceptanceCriteria: "mentions every merged PR", maxRetries: 2, retryIntervalSeconds: 30 },
			{ description: "publish" },
		],
	});

	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "from template", templateId: template.id }),
	});
	assert.equal(createRes.status, 200);
	const created = (await createRes.json()) as { workflow: { id: string; name: string } };
	assert.equal(created.workflow.name, "from template");

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`);
	assert.equal(detailRes.status, 200);
	const detail = (await detailRes.json()) as {
		steps: { description: string; orderIndex: number; acceptanceCriteria: string | null; maxRetries: number; retryIntervalSeconds: number }[];
	};

	assert.equal(detail.steps.length, 3);
	const byOrder = [...detail.steps].sort((a, b) => a.orderIndex - b.orderIndex);
	assert.deepEqual(
		byOrder.map((s) => s.description),
		["bump version", "write changelog", "publish"],
	);
	assert.equal(byOrder[1].acceptanceCriteria, "mentions every merged PR");
	assert.equal(byOrder[1].maxRetries, 2);
	assert.equal(byOrder[1].retryIntervalSeconds, 30);
});

test("POST /api/workflows with an unknown templateId is rejected and creates nothing", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "should not exist", templateId: "does-not-exist" }),
	});
	assert.equal(res.status, 404);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "unknown_template");

	const listRes = await fetch(`${baseUrl}/api/workflows`);
	const list = (await listRes.json()) as { workflows: { name: string }[] };
	assert.ok(!list.workflows.some((w) => w.name === "should not exist"));
});

test("POST /api/workflows/:id/steps/from-template appends the template's steps after existing ones, in order", async () => {
	const template = insertTemplate({
		name: "pr checklist",
		tags: ["pr"],
		steps: [
			{ description: "open the PR" },
			{ description: "merge the PR", acceptanceCriteria: "PR is merged", maxRetries: 3, retryIntervalSeconds: 15 },
		],
	});

	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "existing workflow" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const workflowId = created.workflow.id;

	const stepRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "manual first step" }),
	});
	assert.equal(stepRes.status, 200);

	const fromTplRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: template.id }),
	});
	assert.equal(fromTplRes.status, 200);

	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`);
	const detail = (await detailRes.json()) as {
		steps: { description: string; orderIndex: number; acceptanceCriteria: string | null; maxRetries: number; retryIntervalSeconds: number }[];
	};
	assert.equal(detail.steps.length, 3);
	const byOrder = [...detail.steps].sort((a, b) => a.orderIndex - b.orderIndex);
	assert.deepEqual(
		byOrder.map((s) => s.description),
		["manual first step", "open the PR", "merge the PR"],
	);
	assert.equal(byOrder[2].acceptanceCriteria, "PR is merged");
	assert.equal(byOrder[2].maxRetries, 3);
	assert.equal(byOrder[2].retryIntervalSeconds, 15);
});

test("POST /api/workflows/:id/steps/from-template is idempotent: calling it twice with the same template only adds the steps once", async () => {
	const template = insertTemplate({
		name: "idempotent checklist",
		tags: ["idempotent"],
		steps: [{ description: "step a" }, { description: "step b" }],
	});

	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "idempotent workflow" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const workflowId = created.workflow.id;

	const firstRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: template.id }),
	});
	assert.equal(firstRes.status, 200);
	const first = (await firstRes.json()) as { added: number; skipped: number };
	assert.equal(first.added, 2);
	assert.equal(first.skipped, 0);

	const secondRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: template.id }),
	});
	assert.equal(secondRes.status, 200);
	const second = (await secondRes.json()) as { added: number; skipped: number };
	assert.equal(second.added, 0);
	assert.equal(second.skipped, 2);

	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`);
	const detail = (await detailRes.json()) as { steps: { description: string }[] };
	assert.equal(detail.steps.length, 2);
	assert.deepEqual(
		detail.steps.map((s) => s.description),
		["step a", "step b"],
	);
});

test("POST /api/workflows/:id/steps/from-template with partial overlap only adds the missing steps", async () => {
	const template = insertTemplate({
		name: "partial overlap checklist",
		tags: ["partial"],
		steps: [{ description: "shared step" }, { description: "new step" }],
	});

	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "partial overlap workflow" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const workflowId = created.workflow.id;

	const stepRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "shared step" }),
	});
	assert.equal(stepRes.status, 200);

	const fromTplRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: template.id }),
	});
	assert.equal(fromTplRes.status, 200);
	const body = (await fromTplRes.json()) as { added: number; skipped: number };
	assert.equal(body.added, 1);
	assert.equal(body.skipped, 1);

	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`);
	const detail = (await detailRes.json()) as { steps: { description: string; orderIndex: number }[] };
	assert.equal(detail.steps.length, 2);
	const byOrder = [...detail.steps].sort((a, b) => a.orderIndex - b.orderIndex);
	assert.deepEqual(
		byOrder.map((s) => s.description),
		["shared step", "new step"],
	);
});

test("POST /api/workflows/:id/steps/from-template with an unknown templateId is rejected and adds nothing", async () => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "workflow for unknown template" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const workflowId = created.workflow.id;

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: "does-not-exist" }),
	});
	assert.equal(res.status, 404);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "unknown_template");

	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`);
	const detail = (await detailRes.json()) as { steps: unknown[] };
	assert.equal(detail.steps.length, 0);
});

test("POST /api/workflows/:id/steps/from-template with an unknown workflowId is rejected", async () => {
	const template = insertTemplate({ name: "orphan template", steps: [{ description: "step" }] });

	const res = await fetch(`${baseUrl}/api/workflows/does-not-exist/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: template.id }),
	});
	assert.equal(res.status, 404);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "unknown_workflow");
});

test("POST /api/workflows without a templateId still creates an empty workflow (unchanged behavior)", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "plain workflow" }),
	});
	assert.equal(res.status, 200);
	const created = (await res.json()) as { workflow: { id: string } };

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`);
	const detail = (await detailRes.json()) as { steps: unknown[] };
	assert.equal(detail.steps.length, 0);
});

/**
 * POST /api/workflows/:id/open-terminal — spawns a local terminal resuming
 * the workflow's session. Real terminal emulators aren't installed on a CI
 * box, so the success case swaps terminal.ts's `_impl.spawn` for a fake that
 * reports an immediate "spawn" and never touches a real OS process.
 */

function fakeSpawnChild() {
	return {
		once(event: string, cb: () => void) {
			if (event === "spawn") cb();
		},
		unref() {},
	};
}

test("POST /api/workflows/:id/open-terminal requires an admin token", async () => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "open-terminal auth" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/open-terminal`, { method: "POST" });
	assert.equal(res.status, 401);
});

test("POST /api/workflows/:id/open-terminal on an unknown workflow returns unknown_workflow", async () => {
	const res = await fetch(`${baseUrl}/api/workflows/does-not-exist/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 404);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "unknown_workflow");
});

test("POST /api/workflows/:id/open-terminal before any step has reported a session returns no_session_yet", async () => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "open-terminal no session" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "no_session_yet");
});

test("POST /api/workflows/:id/open-terminal with a session but no resolvable hook/workdir returns unknown_workdir", async () => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "open-terminal no workdir" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string; agentName: string } };
	setWorkflowSessionId(created.workflow.id, "sess-orphaned");
	// Simulates the hook having gone missing from awb's hooks.json while the
	// workflow row (and its now-unresolvable session) is still around.
	deleteAwbHook(created.workflow.agentName);

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "unknown_workdir");
});

test("POST /api/workflows/:id/open-terminal with a resolvable session spawns a terminal cd'd into the workdir", async (t) => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "open-terminal success" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	setWorkflowSessionId(created.workflow.id, "sess-abc");

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`);
	const detail = (await detailRes.json()) as { workflow: { workdir: string } };

	const calls: { bin: string; args: string[] }[] = [];
	const originalSpawn = terminalImpl.spawn;
	t.after(() => {
		terminalImpl.spawn = originalSpawn;
	});
	terminalImpl.spawn = ((bin: string, args: string[]) => {
		calls.push({ bin, args });
		return fakeSpawnChild();
	}) as unknown as typeof terminalImpl.spawn;

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { ok: boolean; sessionId: string; workdir: string };
	assert.equal(body.ok, true);
	assert.equal(body.sessionId, "sess-abc");
	assert.equal(body.workdir, detail.workflow.workdir);

	assert.equal(calls.length, 1);
	const shellCmd = calls[0].args.at(-1) ?? "";
	assert.match(shellCmd, /^cd '.*' && claude --resume 'sess-abc'; exec bash$/);
	assert.ok(shellCmd.includes(detail.workflow.workdir));
});

/**
 * GET /api/workflows/:id/session-info — read-only harness/session/usage
 * summary behind the "Open conversation" block. Unlike open-terminal, it
 * needs no admin token (these tests call it with no auth header at all),
 * matching GET /api/workflows/:id.
 */

test("GET /api/workflows/:id/session-info on an unknown workflow returns unknown_workflow", async () => {
	const res = await fetch(`${baseUrl}/api/workflows/does-not-exist/session-info`);
	assert.equal(res.status, 404);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "unknown_workflow");
});

test("GET /api/workflows/:id/session-info before any step has reported a session returns a null session and usage", async () => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "session-info no session" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/session-info`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { sessionId: string | null; harness: string | null; usage: unknown };
	assert.equal(body.sessionId, null);
	assert.equal(body.usage, null);
});

test("GET /api/workflows/:id/session-info with a resolvable session returns the harness and real token usage", async (t) => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "session-info with usage" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	setWorkflowSessionId(created.workflow.id, "sess-usage");

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`);
	const detail = (await detailRes.json()) as { workflow: { workdir: string; harness: string } };

	// Writes the exact transcript file `claude --resume` itself would read, so
	// readTokenUsage() sees real numbers instead of the all-zero fallback for
	// a missing file.
	const file = transcriptPath(detail.workflow.workdir, "sess-usage");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
	const line = JSON.stringify({
		message: {
			id: "msg-1",
			usage: { input_tokens: 1000, cache_creation_input_tokens: 500, cache_read_input_tokens: 200, output_tokens: 300 },
		},
	});
	fs.writeFileSync(file, `${line}\n`);

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/session-info`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		sessionId: string;
		harness: string;
		usage: { contextTokens: number; contextWindow: number; totalInputTokens: number; outputTokens: number; turns: number; includesSubagents: boolean };
	};
	assert.equal(body.sessionId, "sess-usage");
	assert.equal(body.harness, detail.workflow.harness);
	assert.equal(body.usage.turns, 1);
	assert.equal(body.usage.totalInputTokens, 1700);
	assert.equal(body.usage.outputTokens, 300);
	assert.equal(body.usage.contextTokens, 1700);
	assert.equal(body.usage.contextWindow, 200_000);
	assert.equal(body.usage.includesSubagents, false);
});
