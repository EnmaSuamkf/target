/**
 * Tests for the routes that seed a workflow's steps from a template:
 *
 *  - POST /api/workflows accepts an optional templateId and, when given,
 *    seeds the new workflow with that template's steps (same order, same
 *    judge config) right after creating it.
 *  - POST /api/workflows/:id/steps/from-template does the same thing for an
 *    already-existing workflow, appending after whatever steps it already has —
 *    the full template every time, duplicate descriptions included.
 *
 * …plus the HTTP surface of the per-step manual-review gate: the `manualReview`
 * flag through create/edit/publicStep, and POST .../steps/:stepId/continue.
 * (The gate's behaviour itself lives in manual-review.test.ts; here it's only
 * the routing, the admin gate and the status codes.)
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

const { getStep, insertTemplate, markStepRunning, markStepWaiting, markStepJudging, setWorkflowSessionId, setWorkflowStatus } =
	await import("./db.ts");
const { deleteAwbHook } = await import("./awb.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { _impl: terminalImpl } = await import("./terminal.ts");
const { transcriptPath } = await import("./transcript.ts");
const { FALLBACK_CONTEXT_WINDOW_TOKENS } = await import("./models.ts");

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

test("GET /api/runners reports which agent CLIs are installed on this host", async () => {
	// Read-only but gated like every other data route since the single-user
	// access layer (the create form only exists after login anyway). The exact
	// installed booleans depend on the machine, so only the shape is pinned:
	// both known runners, each carrying a boolean.
	const res = await fetch(`${baseUrl}/api/runners`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { runners: { id: string; installed: boolean }[] };
	const ids = body.runners.map((r) => r.id).sort();
	assert.deepEqual(ids, ["claude", "cursor", "free-code"]);
	for (const r of body.runners) assert.equal(typeof r.installed, "boolean");
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

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() });
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

	const listRes = await fetch(`${baseUrl}/api/workflows`, { headers: adminHeaders() });
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

	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() });
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

test("POST /api/workflows/:id/steps/from-template appends the whole template again when it was already applied", async () => {
	const template = insertTemplate({
		name: "repeatable checklist",
		tags: ["repeatable"],
		steps: [{ description: "step a" }, { description: "step b" }],
	});

	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "repeatable workflow" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const workflowId = created.workflow.id;

	const firstRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: template.id }),
	});
	assert.equal(firstRes.status, 200);
	const first = (await firstRes.json()) as { added: number };
	assert.equal(first.added, 2);

	const secondRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: template.id }),
	});
	assert.equal(secondRes.status, 200);
	const second = (await secondRes.json()) as { added: number };
	assert.equal(second.added, 2);

	// The second round lands after the first, in template order — a repeat run of
	// the same checklist, not a no-op.
	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() });
	const detail = (await detailRes.json()) as { steps: { description: string; orderIndex: number }[] };
	assert.equal(detail.steps.length, 4);
	const byOrder = [...detail.steps].sort((a, b) => a.orderIndex - b.orderIndex);
	assert.deepEqual(
		byOrder.map((s) => s.description),
		["step a", "step b", "step a", "step b"],
	);
	// Duplicated descriptions must still be separately addressable steps.
	const ids = new Set((detail.steps as { id?: string }[]).map((s) => s.id));
	assert.equal(ids.size, 4);
});

test("POST /api/workflows/:id/steps/from-template adds steps that duplicate ones added by hand", async () => {
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
	const body = (await fromTplRes.json()) as { added: number };
	assert.equal(body.added, 2);

	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() });
	const detail = (await detailRes.json()) as { steps: { description: string; orderIndex: number }[] };
	assert.equal(detail.steps.length, 3);
	const byOrder = [...detail.steps].sort((a, b) => a.orderIndex - b.orderIndex);
	assert.deepEqual(
		byOrder.map((s) => s.description),
		["shared step", "shared step", "new step"],
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

	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() });
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

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() });
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

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() });
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
	const res = await fetch(`${baseUrl}/api/workflows/does-not-exist/session-info`, { headers: adminHeaders() });
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

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/session-info`, { headers: adminHeaders() });
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

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() });
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

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/session-info`, { headers: adminHeaders() });
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
	// The window is derived from the transcript's model (hub/models.ts); this
	// fixture's turn names none, so it measures against the documented fallback.
	// The derivation itself is pinned in models.test.ts.
	assert.equal(body.usage.contextWindow, FALLBACK_CONTEXT_WINDOW_TOKENS);
	assert.equal(body.usage.includesSubagents, false);
});

test("GET /api/workflows/:id/session-info after a failed step returns usage from that step's session", async (t) => {
	const { onStepResult } = await import("./workflow.ts");

	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "session-info failed step" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const stepRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "fail on purpose" }),
	});
	const { step } = (await stepRes.json()) as { step: { id: string } };
	markStepRunning(step.id);
	setWorkflowSessionId(created.workflow.id, "sess-failed");

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() });
	const detail = (await detailRes.json()) as { workflow: { workdir: string } };

	const file = transcriptPath(detail.workflow.workdir, "sess-failed");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
	fs.writeFileSync(
		file,
		`${JSON.stringify({
			message: {
				id: "msg-fail",
				role: "assistant",
				usage: { input_tokens: 4200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 },
			},
		})}\n`,
	);

	await onStepResult(step.id, { ok: false, error: "boom", sessionId: "sess-failed" }, cfg, silent);

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/session-info`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { sessionId: string; usage: { contextTokens: number; turns: number } };
	assert.equal(body.sessionId, "sess-failed");
	assert.equal(body.usage.turns, 1);
	assert.equal(body.usage.contextTokens, 4200);
});

test("GET /api/workflows/:id/session-info during judging uses finalized usage, not a stale streaming copy", async (t) => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "session-info judging usage" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const stepRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "judged step", acceptanceCriteria: "ok" }),
	});
	const { step } = (await stepRes.json()) as { step: { id: string } };
	const sessionId = "sess-judging-usage";
	markStepRunning(step.id);
	markStepJudging(step.id, { result: "done", sessionId });

	const detailRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() });
	const detail = (await detailRes.json()) as { workflow: { workdir: string } };

	const file = transcriptPath(detail.workflow.workdir, sessionId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
	const line = (id: string, usage: { input: number; cacheCreation: number; cacheRead: number; output: number }) =>
		JSON.stringify({
			message: {
				id,
				role: "assistant",
				usage: {
					input_tokens: usage.input,
					cache_creation_input_tokens: usage.cacheCreation,
					cache_read_input_tokens: usage.cacheRead,
					output_tokens: usage.output,
				},
			},
		});
	fs.writeFileSync(
		file,
		[
			line("msg-1", { input: 50_000, cacheCreation: 0, cacheRead: 0, output: 100 }),
			line("msg-2", { input: 100, cacheCreation: 0, cacheRead: 1_249_900, output: 50 }),
			line("msg-2", { input: 80_000, cacheCreation: 5_000, cacheRead: 740_500, output: 200 }),
		].join("\n") + "\n",
	);

	const res = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/session-info`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		sessionId: string;
		usage: { contextTokens: number; totalInputTokens: number; turns: number };
	};
	assert.equal(body.sessionId, sessionId);
	assert.equal(body.usage.turns, 2);
	assert.equal(body.usage.contextTokens, 825_500);
	assert.notEqual(body.usage.contextTokens, body.usage.totalInputTokens);
});

/**
 * The manual-review gate over HTTP: the flag on step create/edit (and through
 * `publicStep`), and the Continue route that releases a held step. The engine
 * rules it relies on are covered in manual-review.test.ts — here we only prove
 * the wiring, the admin gate and the status codes match the other step routes.
 */

interface StepBody {
	step: { id: string; status: string; manualReview: boolean; acceptanceCriteria: string | null; description: string };
}

/** A fresh workflow with one step, created the way the UI creates them. */
async function createWorkflowWithStep(name: string, step: Record<string, unknown>) {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const stepRes = await fetch(`${baseUrl}/api/workflows/${created.workflow.id}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify(step),
	});
	assert.equal(stepRes.status, 200);
	const body = (await stepRes.json()) as StepBody;
	return { workflowId: created.workflow.id, step: body.step };
}

/** Drives a step into the hold the way a finished, accepted run would. */
function holdStep(workflowId: string, stepId: string): void {
	markStepRunning(stepId);
	assert.ok(markStepWaiting(stepId, { result: "the work" }));
	setWorkflowStatus(workflowId, "waiting");
}

test("POST /api/workflows/:id/steps with manualReview: true round-trips through publicStep", async () => {
	const { workflowId, step } = await createWorkflowWithStep("gated step", {
		description: "ship it",
		manualReview: true,
	});
	assert.equal(step.manualReview, true);

	// And on the read path, not just the create response.
	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() });
	const detail = (await detailRes.json()) as { steps: { manualReview: boolean }[] };
	assert.equal(detail.steps[0].manualReview, true);
});

test("a step created without the field is not gated", async () => {
	const { step } = await createWorkflowWithStep("ungated step", { description: "just run" });
	assert.equal(step.manualReview, false);
});

test("PATCH of a step without manualReview leaves the gate as it was", async () => {
	const { workflowId, step } = await createWorkflowWithStep("gate preserved", {
		description: "ship it",
		manualReview: true,
	});

	// A plain description edit — the field is absent from the body entirely.
	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "ship it, carefully" }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as StepBody;
	assert.equal(body.step.description, "ship it, carefully");
	assert.equal(body.step.manualReview, true);
});

test("PATCH with manualReview: false turns the gate off", async () => {
	const { workflowId, step } = await createWorkflowWithStep("gate cleared", {
		description: "ship it",
		manualReview: true,
	});

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "ship it", manualReview: false }),
	});
	assert.equal(res.status, 200);
	assert.equal(((await res.json()) as StepBody).step.manualReview, false);
	assert.equal(getStep(step.id)?.manualReview, false);
});

test("POST .../continue requires an admin token", async () => {
	const { workflowId, step } = await createWorkflowWithStep("continue auth", {
		description: "ship it",
		manualReview: true,
	});
	holdStep(workflowId, step.id);

	const noToken = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/continue`, { method: "POST" });
	assert.equal(noToken.status, 401);
	// The access gate answers first (no session, no token): login_required.
	assert.equal(((await noToken.json()) as { error: string }).error, "login_required");

	const badToken = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/continue`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer not-the-admin-token" },
	});
	assert.equal(badToken.status, 401);
	assert.equal(((await badToken.json()) as { error: string }).error, "login_required");

	// The hold is untouched by either attempt.
	assert.equal(getStep(step.id)?.status, "waiting");
});

test("POST .../continue on a waiting step returns the step, now done", async () => {
	const { workflowId, step } = await createWorkflowWithStep("continue ok", {
		description: "ship it",
		manualReview: true,
	});
	holdStep(workflowId, step.id);

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/continue`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as StepBody;
	assert.equal(body.step.id, step.id);
	assert.equal(body.step.status, "done");
	assert.equal(getStep(step.id)?.status, "done");

	// It was the only step, so the workflow finished on the release.
	const detailRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() });
	const detail = (await detailRes.json()) as { workflow: { status: string } };
	assert.equal(detail.workflow.status, "completed");
});

test("POST .../continue on a step that is not waiting returns 400", async () => {
	const { workflowId, step } = await createWorkflowWithStep("continue not waiting", {
		description: "ship it",
		manualReview: true,
	});
	// Still pending — nothing has run, so there is no hold to release.
	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/continue`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 400);
	assert.match(((await res.json()) as { error: string }).error, /only a step waiting for its manual review/);
	assert.equal(getStep(step.id)?.status, "pending");
});

test("POST .../continue twice: the second call is a 400, not a second release", async () => {
	const { workflowId, step } = await createWorkflowWithStep("continue twice", {
		description: "ship it",
		manualReview: true,
	});
	holdStep(workflowId, step.id);

	const first = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/continue`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(first.status, 200);
	// The UI polls every 2s, so a double click on a stale view is expected.
	const second = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/continue`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(second.status, 400);
	assert.equal(getStep(step.id)?.status, "done");
});

test("POST .../continue on an unknown step returns 400", async () => {
	const { workflowId } = await createWorkflowWithStep("continue unknown step", { description: "ship it" });
	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/no-such-step/continue`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 400);
	assert.equal(((await res.json()) as { error: string }).error, "unknown step");
});

test("POST .../continue on an unknown workflow returns 400", async () => {
	const res = await fetch(`${baseUrl}/api/workflows/does-not-exist/steps/whatever/continue`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 400);
	assert.equal(((await res.json()) as { error: string }).error, "unknown workflow");
});

test("a template's manualReview flag is carried onto the steps it seeds, both ways", async () => {
	const template = insertTemplate({
		name: "gated checklist",
		tags: ["gated"],
		steps: [
			{ description: "prepare the release" },
			{ description: "sign the release off", manualReview: true, acceptanceCriteria: "the changelog is right" },
		],
	});
	assert.equal(template.steps[1].manualReview, true);
	assert.equal(template.steps[0].manualReview, false);

	// (a) seeding a brand-new workflow with ?templateId.
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "from gated template", templateId: template.id }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	const seeded = (await (await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() })).json()) as {
		steps: { orderIndex: number; manualReview: boolean }[];
	};
	const seededByOrder = [...seeded.steps].sort((a, b) => a.orderIndex - b.orderIndex);
	assert.deepEqual(seededByOrder.map((s) => s.manualReview), [false, true]);

	// (b) appending it to an existing workflow.
	const plainRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "gated template appended" }),
	});
	const plain = (await plainRes.json()) as { workflow: { id: string } };
	const appendRes = await fetch(`${baseUrl}/api/workflows/${plain.workflow.id}/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: template.id }),
	});
	assert.equal(appendRes.status, 200);
	const appended = (await appendRes.json()) as { steps: { orderIndex: number; manualReview: boolean }[] };
	const appendedByOrder = [...appended.steps].sort((a, b) => a.orderIndex - b.orderIndex);
	assert.deepEqual(appendedByOrder.map((s) => s.manualReview), [false, true]);
});

/**
 * The rest of what a step held at its manual-review gate offers, over HTTP.
 * Continue (above) was the only answer it had; these are the other three —
 * Abort, Open conversation and Add step — proven here as wiring, status codes
 * and the admin gate. Their engine behaviour is manual-review.test.ts's.
 */

test("POST .../abort on a waiting step refuses the result and stops the workflow", async () => {
	const { workflowId, step } = await createWorkflowWithStep("abort a held step", {
		description: "ship it",
		manualReview: true,
	});
	holdStep(workflowId, step.id);

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/abort`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workflow: { status: string } };
	assert.equal(body.workflow.status, "failed");
	assert.equal(getStep(step.id)?.status, "failed");
	assert.equal(getStep(step.id)?.error, "aborted");
	// The result the operator rejected is still there to read.
	assert.equal(getStep(step.id)?.result, "the work");
});

test("POST .../abort on a waiting step requires an admin token", async () => {
	const { workflowId, step } = await createWorkflowWithStep("abort a held step unauthenticated", {
		description: "ship it",
		manualReview: true,
	});
	holdStep(workflowId, step.id);

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/abort`, {
		method: "POST",
		headers: { "content-type": "application/json" },
	});
	assert.equal(res.status, 401);
	assert.equal(getStep(step.id)?.status, "waiting");
});

test("POST .../steps/:stepId/open-terminal resumes THAT step's session, not the workflow's newest", async (t) => {
	const { workflowId, step } = await createWorkflowWithStep("step conversation", {
		description: "ship it",
		manualReview: true,
	});
	markStepRunning(step.id);
	assert.ok(markStepWaiting(step.id, { result: "the work", sessionId: "sess-this-step" }));
	setWorkflowStatus(workflowId, "waiting");
	// A newer session on the workflow: the workflow-level route would resume this
	// one, which is exactly the confusion the per-step route exists to avoid.
	setWorkflowSessionId(workflowId, "sess-newer");

	const detail = (await (await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() })).json()) as {
		workflow: { workdir: string };
	};

	const calls: { bin: string; args: string[] }[] = [];
	const originalSpawn = terminalImpl.spawn;
	t.after(() => {
		terminalImpl.spawn = originalSpawn;
	});
	terminalImpl.spawn = ((bin: string, args: string[]) => {
		calls.push({ bin, args });
		return fakeSpawnChild();
	}) as unknown as typeof terminalImpl.spawn;

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { ok: boolean; sessionId: string; workdir: string };
	assert.equal(body.ok, true);
	assert.equal(body.sessionId, "sess-this-step");
	assert.equal(body.workdir, detail.workflow.workdir);

	assert.equal(calls.length, 1);
	const shellCmd = calls[0].args.at(-1) ?? "";
	assert.match(shellCmd, /^cd '.*' && claude --resume 'sess-this-step'; exec bash$/);
});

test("POST .../steps/:stepId/open-terminal requires an admin token", async () => {
	const { workflowId, step } = await createWorkflowWithStep("step conversation auth", { description: "ship it" });
	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/open-terminal`, {
		method: "POST",
	});
	assert.equal(res.status, 401);
});

test("POST .../steps/:stepId/open-terminal on a step that never reported a session returns no_session_yet", async () => {
	const { workflowId, step } = await createWorkflowWithStep("step conversation no session", {
		description: "ship it",
	});
	// Even with a session on the workflow: this step doesn't have one, and the
	// point of the route is that it answers for the step.
	setWorkflowSessionId(workflowId, "sess-elsewhere");

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${step.id}/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 400);
	assert.equal(((await res.json()) as { error: string }).error, "no_session_yet");
});

test("POST .../steps/:stepId/open-terminal on an unknown step, or one of another workflow, returns unknown_step", async () => {
	const { workflowId } = await createWorkflowWithStep("step conversation unknown", { description: "ship it" });
	const other = await createWorkflowWithStep("step conversation other", { description: "elsewhere" });

	const unknown = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/no-such-step/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(unknown.status, 404);
	assert.equal(((await unknown.json()) as { error: string }).error, "unknown_step");

	const foreign = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${other.step.id}/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(foreign.status, 404);
	assert.equal(((await foreign.json()) as { error: string }).error, "unknown_step");
});

test("POST /api/workflows/:id/steps with afterStepId inserts the step right after that one", async () => {
	const { workflowId, step } = await createWorkflowWithStep("insert after", { description: "first" });
	for (const description of ["second", "third"]) {
		await fetch(`${baseUrl}/api/workflows/${workflowId}/steps`, {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({ description }),
		});
	}

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "the correction", afterStepId: step.id, manualReview: true }),
	});
	assert.equal(res.status, 200);
	const inserted = (await res.json()) as StepBody;
	assert.equal(inserted.step.manualReview, true);

	const detail = (await (await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() })).json()) as {
		steps: { description: string; orderIndex: number }[];
	};
	const byOrder = [...detail.steps].sort((a, b) => a.orderIndex - b.orderIndex);
	assert.deepEqual(
		byOrder.map((s) => s.description),
		["first", "the correction", "second", "third"],
	);
	assert.deepEqual(
		byOrder.map((s) => s.orderIndex),
		[0, 1, 2, 3],
	);
});

test("POST /api/workflows/:id/steps with an afterStepId from another workflow returns 400 and adds nothing", async () => {
	const { workflowId } = await createWorkflowWithStep("insert after foreign", { description: "first" });
	const other = await createWorkflowWithStep("insert after foreign source", { description: "elsewhere" });

	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "nope", afterStepId: other.step.id }),
	});
	assert.equal(res.status, 400);
	assert.equal(((await res.json()) as { error: string }).error, "unknown step");

	const detail = (await (await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() })).json()) as { steps: unknown[] };
	assert.equal(detail.steps.length, 1);
});

/**
 * The selection-sync route: PUT /api/workflows/:id/selection rewrites the run
 * selection as the checkboxes stand right now, so a step unticked mid-run is
 * really skipped. Only the wiring, the admin gate and the status codes here —
 * what the engine does with the flags is run-selection.test.ts's.
 */

test("PUT /api/workflows/:id/selection rewrites the selected flags", async () => {
	const { workflowId, step } = await createWorkflowWithStep("selection sync", { description: "first" });
	const secondRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "second" }),
	});
	const second = ((await secondRes.json()) as StepBody).step;

	// Untick the second step: only the first is selected afterwards, and the
	// answer carries the steps so the caller can confirm without a re-fetch.
	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/selection`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ stepIds: [step.id] }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { steps: { id: string; selected: boolean }[] };
	assert.equal(body.steps.find((s) => s.id === step.id)?.selected, true);
	assert.equal(body.steps.find((s) => s.id === second.id)?.selected, false);

	// And on the read path, not just in the response.
	const detail = (await (await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() })).json()) as {
		steps: { id: string; selected: boolean }[];
	};
	assert.equal(detail.steps.find((s) => s.id === step.id)?.selected, true);
	assert.equal(detail.steps.find((s) => s.id === second.id)?.selected, false);

	// Unticking EVERYTHING is a real answer too — "run nothing", not "run all".
	const none = await fetch(`${baseUrl}/api/workflows/${workflowId}/selection`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ stepIds: [] }),
	});
	assert.equal(none.status, 200);
	const cleared = (await none.json()) as { steps: { selected: boolean }[] };
	assert.ok(cleared.steps.every((s) => s.selected === false));
});

test("PUT /api/workflows/:id/selection requires an admin token", async () => {
	const { workflowId, step } = await createWorkflowWithStep("selection sync auth", { description: "first" });
	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/selection`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ stepIds: [step.id] }),
	});
	assert.equal(res.status, 401);
	// The flag is untouched by the refused call.
	assert.equal(getStep(step.id)?.selected, true);
});

test("PUT /api/workflows/:id/selection on an unknown workflow returns 400", async () => {
	const res = await fetch(`${baseUrl}/api/workflows/does-not-exist/selection`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ stepIds: [] }),
	});
	assert.equal(res.status, 400);
	assert.equal(((await res.json()) as { error: string }).error, "unknown workflow");
});

// --- template export / import over HTTP -------------------------------
//
// The bundle rules themselves are covered in templates.test.ts; here it's only
// the routing (both "export"/"import" sit where a template id would), the auth
// level of each half, and the error codes a bad file comes back with.

test("GET /api/templates/:id/export returns that template as a versioned bundle", async () => {
	const template = insertTemplate({
		name: "exportable",
		tags: ["ops"],
		steps: [{ description: "do the thing", acceptanceCriteria: "it is done", manualReview: true, maxRetries: 2, retryIntervalSeconds: 30 }],
	});

	const res = await fetch(`${baseUrl}/api/templates/${template.id}/export`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const bundle = (await res.json()) as {
		kind: string;
		schemaVersion: number;
		exportedAt: string;
		templates: { name: string; tags: string[]; steps: { description: string; manualReview: boolean }[] }[];
	};
	assert.equal(bundle.kind, "target.templates");
	assert.equal(bundle.schemaVersion, 1);
	assert.ok(!Number.isNaN(Date.parse(bundle.exportedAt)));
	assert.equal(bundle.templates.length, 1);
	assert.equal(bundle.templates[0].name, "exportable");
	assert.deepEqual(bundle.templates[0].tags, ["ops"]);
	assert.equal(bundle.templates[0].steps[0].manualReview, true);
	// The id never travels — the importing hub mints its own.
	assert.ok(!("id" in bundle.templates[0]));
});

test("GET /api/templates/:id/export on an unknown id is a 404 unknown_template", async () => {
	const res = await fetch(`${baseUrl}/api/templates/does-not-exist/export`, { headers: adminHeaders() });
	assert.equal(res.status, 404);
	assert.equal(((await res.json()) as { error: string }).error, "unknown_template");
});

test("GET /api/templates/export returns every template in one bundle", async () => {
	const template = insertTemplate({ name: "in the all-export", steps: [{ description: "step" }] });
	const res = await fetch(`${baseUrl}/api/templates/export`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const bundle = (await res.json()) as { kind: string; templates: { name: string }[] };
	assert.equal(bundle.kind, "target.templates");
	assert.ok(bundle.templates.some((t) => t.name === template.name));
});

test("POST /api/templates/import stores the bundle's templates and returns them in the public shape", async () => {
	const source = insertTemplate({
		name: "import me",
		tags: ["release"],
		steps: [{ description: "step one", useSubagent: false }],
	});
	const exportRes = await fetch(`${baseUrl}/api/templates/${source.id}/export`, { headers: adminHeaders() });
	const bundle = await exportRes.json();

	const res = await fetch(`${baseUrl}/api/templates/import`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify(bundle),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		templates: { id: string; name: string; tags: string[]; steps: { description: string; useSubagent: boolean }[]; createdAt: string }[];
	};
	assert.equal(body.templates.length, 1);
	const imported = body.templates[0];
	// Same content, fresh id, and the colliding name disambiguated by the hub.
	assert.notEqual(imported.id, source.id);
	assert.equal(imported.name, "Clone - import me");
	assert.deepEqual(imported.tags, ["release"]);
	assert.equal(imported.steps[0].description, "step one");
	assert.equal(imported.steps[0].useSubagent, false);
	assert.ok(imported.createdAt);

	// And it's really in the list, not just in the response.
	const listRes = await fetch(`${baseUrl}/api/templates`, { headers: adminHeaders() });
	const list = (await listRes.json()) as { templates: { id: string }[] };
	assert.ok(list.templates.some((t) => t.id === imported.id));
});

test("POST /api/templates/import rejects a malformed bundle with the reason it failed on", async () => {
	const cases: [unknown, string][] = [
		[{ kind: "other.tool", schemaVersion: 1, templates: [] }, "unknown_kind"],
		[{ kind: "target.templates", schemaVersion: 99, templates: [{ name: "x", steps: [] }] }, "unsupported_schema_version"],
		[{ kind: "target.templates", schemaVersion: 1, templates: [{ steps: [] }] }, "invalid_bundle"],
		[{ kind: "target.templates", schemaVersion: 1, templates: [] }, "empty_bundle"],
	];
	for (const [body, expected] of cases) {
		const res = await fetch(`${baseUrl}/api/templates/import`, {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify(body),
		});
		assert.equal(res.status, 400);
		assert.equal(((await res.json()) as { error: string }).error, expected);
	}
});

test("POST /api/templates/import requires an admin token and creates nothing without one", async () => {
	const res = await fetch(`${baseUrl}/api/templates/import`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ kind: "target.templates", schemaVersion: 1, templates: [{ name: "unauthorized import", steps: [] }] }),
	});
	// The blanket access gate answers first — either way it never reached the DB.
	assert.equal(res.status, 401);
	const listRes = await fetch(`${baseUrl}/api/templates`, { headers: adminHeaders() });
	const list = (await listRes.json()) as { templates: { name: string }[] };
	assert.ok(!list.templates.some((t) => t.name === "unauthorized import"));
});
