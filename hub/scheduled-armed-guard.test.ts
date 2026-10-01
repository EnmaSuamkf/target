/**
 * Tests for D2: a schedule's ARMED instance can't be run by hand — on any entry
 * point — while staying editable; and once it has FIRED it is a normal
 * workflow again (pause, resume, manual-review Continue, abort).
 *
 * Entry points covered, all backed by the one engine guard
 * (`refuseScheduledArmed` in workflow.ts):
 *  - the hub HTTP API: start / resume / restart and a step's ▶ run answer 409
 *    `{"error":"scheduled_armed"}`;
 *  - the MCP server (mcp/target-mcp.mjs), spawned for real against the test
 *    hub, relays that answer unchanged;
 *  - the sync command handlers (workflow.start/resume/restart, step.run): the
 *    command is acked `failed` with the guard's message.
 *
 * Same throwaway-TARGET_HOME convention as the other hub tests; dispatches go
 * to a fake awb hook that records them and never calls back.
 */
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-armed-guard-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { getAppliedSyncCommand, getStep, getSyncStepMap, getWorkflow, insertStep, insertWorkflow, listSteps } =
	await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const {
	onStepResult,
	restartWorkflow,
	resumeWorkflow,
	runStep,
	setSchedule,
	startWorkflow,
	WorkflowError,
	WorkflowScheduledArmedError,
} = await import("./workflow.ts");
const { executeSyncCommand, resetSyncExecutorState, resolveLocalWorkflowId, runSyncTick } = await import("./sync.ts");
const { runSchedulerTick } = await import("./scheduler.ts");

const cfg = loadConfig();
const silent = () => {};
const ARMED_AT = new Date("2026-09-30T08:00:00.000Z");
const DUE = new Date("2026-09-30T09:00:00.000Z");

// --- fake awb hook + the real hub HTTP server ---------------------------------

const dispatched: string[] = [];
const hook = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		dispatched.push(req.url ?? "");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
const hookAddr = hook.address();
if (!hookAddr || typeof hookAddr === "string") throw new Error("fake hook did not bind");
const hookBase = `http://127.0.0.1:${hookAddr.port}/hook`;

const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverAddr = server.address();
if (!serverAddr || typeof serverAddr === "string") throw new Error("server did not bind");
const baseUrl = `http://127.0.0.1:${serverAddr.port}`;

test.after(() => {
	hook.close();
	server.close();
});

const dispatchesFor = (id: string) => dispatched.filter((url) => url.endsWith(`/${id}`)).length;

async function api(method: string, route: string, body?: unknown) {
	const res = await fetch(`${baseUrl}${route}`, {
		method,
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let seq = 0;

/** An armed instance (daily 09:00 UTC) on the fake hook, with `steps` task steps. */
function armedInstance(options: { steps?: number; manualReviewFirst?: boolean } = {}) {
	seq += 1;
	const id = `wf-armed-${seq}`;
	insertWorkflow({
		id,
		name: `Armed ${seq}`,
		agentName: `armed-agent-${seq}`,
		hookUrl: `${hookBase}/${id}`,
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	for (let i = 0; i < (options.steps ?? 2); i++) {
		insertStep(id, `step ${i + 1}`, { manualReview: i === 0 && options.manualReviewFirst === true });
	}
	return setSchedule(id, { spec: { kind: "daily", time: "09:00" }, timezone: "UTC" }, { now: ARMED_AT });
}

/** Asserts an armed instance was left exactly as it was: nothing ran. */
function assertUntouched(id: string) {
	const wf = getWorkflow(id)!;
	assert.equal(wf.scheduleState, "armed");
	assert.equal(wf.status, "draft");
	assert.ok(listSteps(id).every((s) => s.status === "pending"), "no step moved");
	assert.equal(dispatchesFor(id), 0, "nothing dispatched");
}

// --- engine -----------------------------------------------------------------------

test("engine: start / resume / restart / step run all refuse an armed instance", async () => {
	const wf = armedInstance();
	const [step] = listSteps(wf.id).filter((s) => s.kind === "task");
	const ids = listSteps(wf.id).map((s) => s.id);
	for (const attempt of [
		() => startWorkflow(wf.id, cfg, silent, ids),
		() => resumeWorkflow(wf.id, cfg, silent, ids),
		() => restartWorkflow(wf.id, cfg, silent, ids),
		() => runStep(wf.id, step.id, cfg, silent),
	]) {
		await assert.rejects(attempt(), (err: unknown) => {
			assert.ok(err instanceof WorkflowScheduledArmedError);
			assert.ok(err instanceof WorkflowError, "still an engine refusal for generic callers");
			assert.match((err as Error).message, /^scheduled_armed: /);
			return true;
		});
	}
	assertUntouched(wf.id);
});

// --- HTTP ------------------------------------------------------------------------------

test("HTTP: start / resume / restart answer 409 scheduled_armed and run nothing", async () => {
	const wf = armedInstance();
	const stepIds = listSteps(wf.id).map((s) => s.id);
	for (const action of ["start", "resume", "restart"]) {
		const res = await api("POST", `/api/workflows/${wf.id}/${action}`, { stepIds });
		assert.equal(res.status, 409, action);
		assert.equal(res.body.error, "scheduled_armed", action);
		assert.match(String(res.body.message), /next run of a schedule/);
	}
	assertUntouched(wf.id);
});

test("HTTP: a step's ▶ run answers 409 scheduled_armed", async () => {
	const wf = armedInstance();
	const [step] = listSteps(wf.id).filter((s) => s.kind === "task");
	const res = await api("POST", `/api/workflows/${wf.id}/steps/${step.id}/run`);
	assert.equal(res.status, 409);
	assert.equal(res.body.error, "scheduled_armed");
	assertUntouched(wf.id);
});

test("HTTP: editing an armed instance still works — steps, context, name, TCP/RCI", async () => {
	const wf = armedInstance();
	const [step] = listSteps(wf.id).filter((s) => s.kind === "task");

	const renamed = await api("PATCH", `/api/workflows/${wf.id}/name`, { name: "Renamed armed" });
	assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
	const added = await api("POST", `/api/workflows/${wf.id}/steps`, { description: "a new step" });
	assert.equal(added.status, 200, JSON.stringify(added.body));
	const edited = await api("PATCH", `/api/workflows/${wf.id}/steps/${step.id}`, {
		description: "edited step",
		acceptanceCriteria: "it is done",
	});
	assert.equal(edited.status, 200, JSON.stringify(edited.body));
	const context = await api("PATCH", `/api/workflows/${wf.id}/context`, { conversationContext: "new background" });
	assert.equal(context.status, 200, JSON.stringify(context.body));
	const tcps = await api("PATCH", `/api/workflows/${wf.id}/tcps`, { tcpSelections: [] });
	assert.equal(tcps.status, 200, JSON.stringify(tcps.body));
	const rci = await api("PATCH", `/api/workflows/${wf.id}/resourcesets`, { resourceSelections: [] });
	assert.equal(rci.status, 200, JSON.stringify(rci.body));

	const after = getWorkflow(wf.id)!;
	assert.equal(after.name, "Renamed armed");
	assert.equal(after.conversationContext, "new background");
	assert.equal(getStep(step.id)!.description, "edited step");
	assert.equal(getStep(step.id)!.acceptanceCriteria, "it is done");
	assert.ok(listSteps(wf.id).some((s) => s.description === "a new step"));
	assert.equal(after.scheduleState, "armed", "still the armed instance");
	assert.equal(dispatchesFor(wf.id), 0);
});

// --- fired instances are normal workflows ---------------------------------------------------

test("HTTP: once fired, pause / resume / abort work as on any workflow", async () => {
	const wf = armedInstance();
	const tick = await runSchedulerTick({ cfg, log: silent, now: DUE, permissionState: () => ({ kind: "unrestricted" }) });
	assert.ok(tick.fired.includes(wf.id));
	assert.equal(getWorkflow(wf.id)!.scheduleState, "fired");
	assert.equal(getWorkflow(wf.id)!.status, "running");

	const paused = await api("POST", `/api/workflows/${wf.id}/pause`);
	assert.equal(paused.status, 200, JSON.stringify(paused.body));
	assert.equal((paused.body.workflow as { status: string }).status, "paused");

	const pending = listSteps(wf.id)
		.filter((s) => s.kind === "task")
		.map((s) => s.id);
	const resumed = await api("POST", `/api/workflows/${wf.id}/resume`, { stepIds: pending });
	assert.equal(resumed.status, 200, JSON.stringify(resumed.body));

	const queued = listSteps(wf.id).find((s) => s.kind === "task" && (s.status === "queued" || s.status === "running"))!;
	const aborted = await api("POST", `/api/workflows/${wf.id}/steps/${queued.id}/abort`);
	assert.equal(aborted.status, 200, JSON.stringify(aborted.body));
	assert.equal(getStep(queued.id)!.status, "failed");
});

test("HTTP: once fired, a manual-review Continue works", async () => {
	const wf = armedInstance({ manualReviewFirst: true });
	await runSchedulerTick({ cfg, log: silent, now: DUE, permissionState: () => ({ kind: "unrestricted" }) });
	const gated = listSteps(wf.id).find((s) => s.kind === "task")!;
	await onStepResult(gated.id, { ok: true, result: "done, please review", sessionId: "sess-1" }, cfg, silent);
	assert.equal(getStep(gated.id)!.status, "waiting");
	assert.equal(getWorkflow(wf.id)!.status, "waiting");

	const continued = await api("POST", `/api/workflows/${wf.id}/steps/${gated.id}/continue`);
	assert.equal(continued.status, 200, JSON.stringify(continued.body));
	assert.equal(getStep(gated.id)!.status, "done");
});

// --- MCP ------------------------------------------------------------------------------------

test("MCP: start / resume / restart and a step run surface scheduled_armed unchanged", async () => {
	const wf = armedInstance();
	const [step] = listSteps(wf.id).filter((s) => s.kind === "task");
	const mcpPath = fileURLToPath(new URL("../mcp/target-mcp.mjs", import.meta.url));
	const child = spawn(process.execPath, [mcpPath], {
		env: { ...process.env, TARGET_HUB_URL: baseUrl, TARGET_ADMIN_TOKEN: cfg.adminToken },
		stdio: ["pipe", "pipe", "inherit"],
	});
	const lines = readline.createInterface({ input: child.stdout! });
	const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
	lines.on("line", (line) => {
		const msg = JSON.parse(line) as { id: number };
		waiting.get(msg.id)?.(msg);
	});
	let nextId = 0;
	const call = (name: string, args: Record<string, unknown>) =>
		new Promise<{ isError?: boolean; content: { text: string }[] }>((resolve) => {
			const id = ++nextId;
			waiting.set(id, (msg) => resolve(msg.result as { isError?: boolean; content: { text: string }[] }));
			child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
		});
	try {
		const stepIds = listSteps(wf.id).map((s) => s.id);
		const results = [
			await call("start_workflow", { workflowId: wf.id, stepIds }),
			await call("resume_workflow", { workflowId: wf.id, stepIds }),
			await call("restart_workflow", { workflowId: wf.id, stepIds }),
			await call("hub_api", { method: "POST", path: `/api/workflows/${wf.id}/steps/${step.id}/run` }),
		];
		for (const result of results) {
			assert.equal(result.isError, true);
			// The MCP wraps the hub's error body without rewriting it.
			const outer = JSON.parse(result.content[0].text) as { error: string; message: string };
			assert.equal(outer.error, "hub_error");
			const hubBody = JSON.parse(outer.message) as { error: string; message: string };
			assert.equal(hubBody.error, "scheduled_armed");
			assert.match(hubBody.message, /^scheduled_armed: /);
		}
	} finally {
		child.kill();
	}
	assertUntouched(wf.id);
});

// --- sync ---------------------------------------------------------------------------------

test("sync: workflow.start/resume/restart and step.run on an armed instance are acked failed", async () => {
	resetSyncExecutorState();
	const remoteId = "rwf_armed_guard";
	await executeSyncCommand(
		{ id: "cmd_g_create", type: "workflow.create", remote_id: remoteId, sequence: 1, status: "delivered", payload: { name: "Remote armed" } },
		cfg,
	);
	await executeSyncCommand(
		{ id: "cmd_g_step", type: "step.add", remote_id: remoteId, sequence: 2, status: "delivered", payload: { step_key: "s1", description: "Only step" } },
		cfg,
	);
	const localId = resolveLocalWorkflowId(remoteId)!;
	setSchedule(localId, { spec: { kind: "daily", time: "09:00" }, timezone: "UTC" }, { now: ARMED_AT });
	assert.ok(getSyncStepMap(remoteId).s1);

	const commands = [
		{ id: "cmd_g_start", type: "workflow.start", payload: { step_keys: ["s1"] } },
		{ id: "cmd_g_resume", type: "workflow.resume", payload: { step_keys: ["s1"] } },
		{ id: "cmd_g_restart", type: "workflow.restart", payload: { step_keys: ["s1"] } },
		{ id: "cmd_g_run", type: "step.run", payload: { step_key: "s1" } },
	].map((c, i) => ({ ...c, remote_id: remoteId, sequence: 10 + i, status: "pending" }));
	const acks = new Map<string, { status: string; error?: { message: string } }>();
	await runSyncTick({
		hubConfig: cfg,
		config: { enabled: true, url: "https://server.example", token: "legacy-token", intervalMs: 5_000 },
		log: silent,
		fetchImpl: async (url, init) => {
			const pathname = new URL(String(url)).pathname;
			if (pathname === "/api/sync/commands") return new Response(JSON.stringify({ commands }), { status: 200 });
			const ack = /^\/api\/sync\/commands\/([^/]+)\/ack$/.exec(pathname);
			if (ack) {
				acks.set(ack[1], JSON.parse(String(init?.body)));
				return new Response("{}", { status: 200 });
			}
			if (pathname === "/api/sync/events") return new Response(JSON.stringify({ accepted: [] }), { status: 200 });
			return new Response("{}", { status: 200 });
		},
	});
	for (const c of commands) {
		const ack = acks.get(c.id);
		assert.ok(ack, `${c.type} was acked`);
		assert.equal(ack!.status, "failed", c.type);
		assert.match(ack!.error?.message ?? "", /^scheduled_armed: /, c.type);
	}
	const wf = getWorkflow(localId)!;
	assert.equal(wf.scheduleState, "armed");
	assert.equal(wf.status, "draft");
	assert.ok(listSteps(localId).every((s) => s.status === "pending"));
	// The refused commands are not recorded as applied (so a redelivery is
	// re-evaluated rather than silently no-op'd), while the setup commands are.
	for (const c of commands) assert.equal(getAppliedSyncCommand(c.id), null, c.type);
	assert.ok(getAppliedSyncCommand("cmd_g_create"));
});
