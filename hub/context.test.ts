/**
 * Tests for the Conversation context feature (see docs/feature.md and
 * docs/acceptanceCriteria.md): a workflow-level preamble injected before the
 * first step of a fresh conversation, exactly once, never re-injected.
 *
 * The injection lives in runner.ts's `dispatchStep`, which POSTs the step's
 * input to the workflow's awb hook. To observe the actual input string the
 * agent receives, these tests stand up a tiny local HTTP server that plays the
 * awb hook: it accepts the POST, records the body, and answers `{ok:true}`
 * with a session id so the workflow's callback path runs for real. That keeps
 * the whole dispatch + callback pipeline honest without a real awb install.
 *
 * Same throwaway-TARGET_HOME convention as the other suites.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-context-"));
process.env.TARGET_HOME = tmpHome;

const { insertStep, insertWorkflow, getWorkflow } = await import("./db.ts");
const { createServer } = await import("./server.ts");
const { loadConfig } = await import("./config.ts");
const { startWorkflow, restartWorkflow, setConversationContext } = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};

let seq = 0;

/**
 * A fake awb hook: an HTTP server that records every dispatched input and
 * answers `{ok:true, session_id}` immediately, then POSTs the result callback
 * to the hub so the workflow's onStepResult path runs for real. Each recorded
 * dispatch is pushed onto `inputs` in order.
 */
function startFakeHook(onDispatch: (body: { jobId: string; input: string; callbackUrl: string }) => void) {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			onDispatch(body);
		});
	});
	return new Promise<{ server: http.Server; url: string }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
			resolve({ server, url: `http://127.0.0.1:${addr.port}/hook/agent` });
		});
	});
}

/** A workflow with `count` pending steps and a conversation context, wired straight into the DB. */
function makeWorkflow(count: number, conversationContext: string | null, hookUrl: string) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext,
	});
	const steps = Array.from({ length: count }, (_, i) => insertStep(id, `step ${i + 1}`));
	return { workflow, steps };
}

/** Drives a step to a successful exec result with a session, exactly as awb's callback would. */
async function finishStepOk(stepId: string, sessionId: string) {
	const { onStepResult } = await import("./workflow.ts");
	await onStepResult(stepId, { ok: true, result: "fine", sessionId }, cfg, silent);
}

test("context is injected before all, on the first dispatched step only (acceptance #1)", async () => {
	const inputs: { input: string }[] = [];
	const { server, url } = await startFakeHook((body) => inputs.push({ input: body.input }));
	test.after(() => server.close());

	const { workflow, steps } = makeWorkflow(2, "You are writing for a junior audience.", url);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await finishStepOk(steps[0].id, "sess-1");
	await finishStepOk(steps[1].id, "sess-1"); // resumed — same session

	assert.equal(inputs.length, 2, "both steps were dispatched");
	// First dispatch: the preamble is prepended before the step description.
	assert.match(inputs[0].input, /^Conversation context — this background applies to every step of this workflow:/);
	assert.match(inputs[0].input, /You are writing for a junior audience\./);
	assert.match(inputs[0].input, /step 1/);
	// Second dispatch: resumes the session, so NO preamble — just the step.
	assert.doesNotMatch(inputs[1].input, /Conversation context/);
	assert.match(inputs[1].input, /^step 2/);
});

test("context is not re-injected on subsequent steps once a session exists (acceptance #2)", async () => {
	const inputs: { input: string }[] = [];
	const { server, url } = await startFakeHook((body) => inputs.push({ input: body.input }));
	test.after(() => server.close());

	const { workflow, steps } = makeWorkflow(3, "BACKGROUND-XYZ", url);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id, steps[2].id]);
	await finishStepOk(steps[0].id, "sess-1");
	await finishStepOk(steps[1].id, "sess-1");
	await finishStepOk(steps[2].id, "sess-1");

	// Only the first of three dispatches carries the preamble.
	assert.equal(inputs.filter((d) => d.input.includes("BACKGROUND-XYZ")).length, 1);
	assert.match(inputs[0].input, /BACKGROUND-XYZ/);
	assert.doesNotMatch(inputs[1].input, /BACKGROUND-XYZ/);
	assert.doesNotMatch(inputs[2].input, /BACKGROUND-XYZ/);
});

test("contextInjected flag tracks injection state and is observable (acceptance #3)", async () => {
	const inputs: { input: string }[] = [];
	const { server, url } = await startFakeHook((body) => inputs.push({ input: body.input }));
	test.after(() => server.close());

	const { workflow, steps } = makeWorkflow(1, "ctx", url);
	// Before any run: not injected, no session.
	assert.equal(getWorkflow(workflow.id)?.contextInjected, false);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	// Dispatched but no session reported yet — still not injected.
	assert.equal(getWorkflow(workflow.id)?.contextInjected, false);
	assert.match(inputs[0].input, /ctx/);

	await finishStepOk(steps[0].id, "sess-1");
	// Session established → the guard flips to injected.
	assert.equal(getWorkflow(workflow.id)?.contextInjected, true);
});

test("a failed first dispatch (no session) re-injects on the next attempt (acceptance #4)", async () => {
	const inputs: { input: string }[] = [];
	const { server, url } = await startFakeHook((body) => inputs.push({ input: body.input }));
	test.after(() => server.close());

	const { workflow, steps } = makeWorkflow(1, "PREAMBLE", url);
	const { onStepResult } = await import("./workflow.ts");

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	// First attempt fails with no session — the flag stays false.
	await onStepResult(steps[0].id, { ok: false, error: "boom" }, cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.contextInjected, false);
	assert.equal(getWorkflow(workflow.id)?.lastSessionId, null);
	// Re-run the same step on demand (the ▶ button): runStep starts a manual
	// run, which is a fresh conversation (still no session) → re-injects.
	const { runStep } = await import("./workflow.ts");
	await runStep(workflow.id, steps[0].id, cfg, silent);

	// The re-run is a fresh conversation (still no session) → re-injected.
	assert.equal(inputs.length, 2);
	assert.match(inputs[1].input, /PREAMBLE/);
});

test("restart re-injects the context on the new first step (acceptance #5)", async () => {
	const inputs: { input: string }[] = [];
	const { server, url } = await startFakeHook((body) => inputs.push({ input: body.input }));
	test.after(() => server.close());

	const { workflow, steps } = makeWorkflow(1, "RESTART-CTX", url);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await finishStepOk(steps[0].id, "sess-1");
	assert.equal(getWorkflow(workflow.id)?.contextInjected, true);
	assert.equal(inputs.filter((d) => d.input.includes("RESTART-CTX")).length, 1);

	// Restart: fresh conversation, guard reset → injected again.
	await restartWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	assert.equal(getWorkflow(workflow.id)?.contextInjected, false); // reset before the callback
	assert.match(inputs.at(-1)!.input, /RESTART-CTX/);
	assert.equal(inputs.filter((d) => d.input.includes("RESTART-CTX")).length, 2);
});

test("once injected, the context is locked — editing is rejected until the flag is reset (acceptance #6)", async () => {
	const { workflow } = makeWorkflow(1, "initial context", "http://127.0.0.1:1/hook");
	const { setContextInjected } = await import("./db.ts");

	// Before injection (flag false): editing is allowed.
	setConversationContext(workflow.id, "edited before run");
	assert.equal(getWorkflow(workflow.id)?.conversationContext, "edited before run");
	assert.equal(getWorkflow(workflow.id)?.contextInjected, false);

	// After injection (flag true): editing is rejected — same value, different
	// value, and clearing all throw. The stored value is left untouched.
	setContextInjected(workflow.id, true);
	assert.throws(() => setConversationContext(workflow.id, "edited before run"), /context already injected/);
	assert.throws(() => setConversationContext(workflow.id, "different"), /context already injected/);
	assert.throws(() => setConversationContext(workflow.id, ""), /context already injected/);
	assert.equal(getWorkflow(workflow.id)?.conversationContext, "edited before run");
	assert.equal(getWorkflow(workflow.id)?.contextInjected, true);

	// Once the flag is reset (a restart does this — see the restart test),
	// editing works again.
	setContextInjected(workflow.id, false);
	setConversationContext(workflow.id, "after reset");
	assert.equal(getWorkflow(workflow.id)?.conversationContext, "after reset");
	assert.equal(getWorkflow(workflow.id)?.contextInjected, false);
});

test("an injected context is locked for the rest of the in-flight conversation", async () => {
	const inputs: { input: string }[] = [];
	const { server, url } = await startFakeHook((body) => inputs.push({ input: body.input }));
	test.after(() => server.close());

	const { workflow, steps } = makeWorkflow(2, "OLD", url);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await finishStepOk(steps[0].id, "sess-1"); // session established, OLD injected on step 1
	assert.equal(getWorkflow(workflow.id)?.contextInjected, true);

	// The context is now locked: editing mid-conversation is rejected, so the
	// agent keeps operating under the original context.
	assert.throws(() => setConversationContext(workflow.id, "NEW"), /context already injected/);
	assert.equal(getWorkflow(workflow.id)?.conversationContext, "OLD");

	await finishStepOk(steps[1].id, "sess-1"); // resumes — no preamble
	assert.equal(inputs.length, 2);
	assert.match(inputs[0].input, /OLD/);
	// Step 2 resumes the session → no preamble (and the blocked edit never landed).
	assert.doesNotMatch(inputs[1].input, /OLD/);
	assert.doesNotMatch(inputs[1].input, /NEW/);
});

test("an empty context behaves exactly as before — no preamble ever (acceptance #7)", async () => {
	const inputs: { input: string }[] = [];
	const { server, url } = await startFakeHook((body) => inputs.push({ input: body.input }));
	test.after(() => server.close());

	const { workflow, steps } = makeWorkflow(2, null, url);
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await finishStepOk(steps[0].id, "sess-1");
	await finishStepOk(steps[1].id, "sess-1");

	assert.doesNotMatch(inputs[0].input, /Conversation context/);
	assert.doesNotMatch(inputs[1].input, /Conversation context/);
	assert.equal(getWorkflow(workflow.id)?.contextInjected, false);
});

// --- API wiring (acceptance #8, #9) -------------------------------------

const apiServer = createServer(cfg, silent);
await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
const apiAddr = apiServer.address();
if (!apiAddr || typeof apiAddr === "string") throw new Error("api server did not bind");
const apiBase = `http://127.0.0.1:${apiAddr.port}`;
test.after(() => apiServer.close());

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

test("POST /api/workflows ignores conversationContext — context is set only via PATCH (acceptance #8)", async () => {
	// Context is no longer part of workflow creation; even if a caller sends
	// it in the create body, it's ignored. Workflows always start with null
	// context and are given one afterward via PATCH /.../context (or set-context).
	const res = await fetch(`${apiBase}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "ctx workflow", conversationContext: "should be ignored" }),
	});
	assert.equal(res.status, 200);
	const created = (await res.json()) as { workflow: { id: string; conversationContext: string | null; contextInjected: boolean } };
	assert.equal(created.workflow.conversationContext, null);
	assert.equal(created.workflow.contextInjected, false);
});

test("POST /api/workflows without conversationContext creates a workflow with null context", async () => {
	const res = await fetch(`${apiBase}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "no ctx workflow" }),
	});
	const created = (await res.json()) as { workflow: { id: string; conversationContext: string | null } };
	assert.equal(created.workflow.conversationContext, null);
});

test("PATCH /api/workflows/:id/context updates the context and round-trips (acceptance #8)", async () => {
	const createRes = await fetch(`${apiBase}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "ctx patch workflow" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };

	const patchRes = await fetch(`${apiBase}/api/workflows/${created.workflow.id}/context`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ conversationContext: "patched context" }),
	});
	assert.equal(patchRes.status, 200);
	const patched = (await patchRes.json()) as { workflow: { conversationContext: string | null; contextInjected: boolean } };
	assert.equal(patched.workflow.conversationContext, "patched context");
	// A real change → flag reset to false.
	assert.equal(patched.workflow.contextInjected, false);
});

test("PATCH /api/workflows/:id/context with an empty string clears the context", async () => {
	const createRes = await fetch(`${apiBase}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "ctx clear workflow" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	// Start with no context, set one via PATCH, then clear it with an empty string.
	await fetch(`${apiBase}/api/workflows/${created.workflow.id}/context`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ conversationContext: "to be cleared" }),
	});

	const patchRes = await fetch(`${apiBase}/api/workflows/${created.workflow.id}/context`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ conversationContext: "" }),
	});
	assert.equal(patchRes.status, 200);
	const patched = (await patchRes.json()) as { workflow: { conversationContext: string | null } };
	assert.equal(patched.workflow.conversationContext, null);
});

test("PATCH /api/workflows/:id/context requires an admin token", async () => {
	const createRes = await fetch(`${apiBase}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "ctx auth workflow" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };

	const res = await fetch(`${apiBase}/api/workflows/${created.workflow.id}/context`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversationContext: "no auth" }),
	});
	assert.equal(res.status, 401);
});

test("PATCH /api/workflows/:id/context on an unknown workflow returns unknown_workflow", async () => {
	const res = await fetch(`${apiBase}/api/workflows/does-not-exist/context`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ conversationContext: "x" }),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "unknown workflow");
});

test("PATCH /api/workflows/:id/context is rejected once the context has been injected (acceptance #6)", async () => {
	const createRes = await fetch(`${apiBase}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "ctx lock workflow" }),
	});
	const created = (await createRes.json()) as { workflow: { id: string } };
	// Set a context while it's still editable.
	const setRes = await fetch(`${apiBase}/api/workflows/${created.workflow.id}/context`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ conversationContext: "lockable" }),
	});
	assert.equal(setRes.status, 200);
	// Mark it injected (the first step having established a session does this).
	const { setContextInjected } = await import("./db.ts");
	setContextInjected(created.workflow.id, true);
	// Editing is now rejected by the API with a clear error.
	const res = await fetch(`${apiBase}/api/workflows/${created.workflow.id}/context`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ conversationContext: "nope" }),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "context already injected");
});
