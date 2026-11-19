/**
 * The step callback token is a credential for one dispatched run.
 *
 * It rotates when `dispatchStep` starts a new run, `/api/tcps/execute` accepts
 * it only while that run is queued or running, and a late `started`/`result`
 * for the token that is still current keeps working. Operator calls do not
 * use it. Nothing the hub logs retains the value.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-step-credential-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { redactSecrets } = await import("./redact.ts");
const { dispatchStep } = await import("./runner.ts");
const { insertTcp, setWorkflowTcps } = await import("./tcp-store.ts");
const {
	beginRetry,
	completeStep,
	failRunningStep,
	getStep,
	insertStep,
	insertWorkflow,
	markStepQueued,
	markStepRunning,
	setWorkflowStatus,
} = await import("./db.ts");

const logs: string[] = [];
const cfg = loadConfig();
const server = createServer(cfg, (message) => logs.push(message));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind");
if (address.port === 8893) throw new Error("refusing to use the live hub port");
const baseUrl = `http://127.0.0.1:${address.port}`;

const upstream = http.createServer((_req, res) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddr = upstream.address();
if (!upstreamAddr || typeof upstreamAddr === "string") throw new Error("upstream did not bind");

test.after(() => {
	server.close();
	upstream.close();
});

const tcp = insertTcp({
	name: "local",
	tools: [
		{
			name: "ping",
			description: "ping",
			requestTemplate: `curl -sS -X GET http://127.0.0.1:${upstreamAddr.port}/ping`,
			inputs: [],
			tokens: {},
		},
	],
});

function workflow() {
	const row = insertWorkflow({
		id: crypto.randomUUID(),
		name: "credential",
		agentName: `agent-${crypto.randomUUID()}`,
		hookUrl: "http://127.0.0.1/hook/credential",
		secret: "s",
		mdPath: path.join(tmpHome, `${crypto.randomUUID()}.md`),
	});
	setWorkflowTcps(row.id, [tcp.id]);
	setWorkflowStatus(row.id, "running");
	return row;
}

function runningStep() {
	const wf = workflow();
	const step = getStep(insertStep(wf.id, "do the thing").id)!;
	markStepRunning(step.id);
	return getStep(step.id)!;
}

function execUrl(stepId: string, token: string) {
	return `${baseUrl}/api/tcps/execute?stepId=${stepId}&token=${encodeURIComponent(token)}`;
}

async function execute(stepId: string, token: string) {
	return fetch(execUrl(stepId, token), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tcpId: tcp.id, toolName: "ping" }),
	});
}

async function callback(kind: "started" | "result", stepId: string, token: string, body: Record<string, unknown> = { ok: true, result: "done" }) {
	return fetch(`${baseUrl}/api/steps/${stepId}/${kind}?token=${encodeURIComponent(token)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(kind === "started" ? { started: true } : body),
	});
}

test("dispatchStep rotates the token and hands only the new one to the run", async () => {
	const wf = workflow();
	const step = getStep(insertStep(wf.id, "first run").id)!;
	const previous = step.callbackToken;
	let body = "";
	const hook = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			body = Buffer.concat(chunks).toString("utf8");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
	const hookAddr = hook.address();
	if (!hookAddr || typeof hookAddr === "string") throw new Error("hook did not bind");
	try {
		await dispatchStep(step, { ...wf, hookUrl: `http://127.0.0.1:${hookAddr.port}/hook` }, cfg, () => {});
	} finally {
		hook.close();
	}
	const current = getStep(step.id)!;
	assert.notEqual(current.callbackToken, previous);
	assert.equal(current.status, "queued");
	assert.equal(body.includes(previous), false);
	assert.equal(body.includes(current.callbackToken), true);
	const posted = JSON.parse(body) as { callbackUrl: string; startedCallbackUrl: string };
	assert.match(posted.callbackUrl, new RegExp(`/result\\?token=${current.callbackToken}$`));
	assert.match(posted.startedCallbackUrl, new RegExp(`/started\\?token=${current.callbackToken}$`));
});

test("a queued run may call tools; a retry wait may not", async () => {
	const wf = workflow();
	const queued = getStep(insertStep(wf.id, "queued").id)!;
	markStepQueued(queued.id);
	const allowed = await execute(queued.id, queued.callbackToken);
	assert.equal(allowed.status, 200);

	const waiting = getStep(insertStep(wf.id, "retry wait").id)!;
	markStepRunning(waiting.id);
	beginRetry(waiting.id, 60);
	const refused = await execute(waiting.id, getStep(waiting.id)!.callbackToken);
	assert.equal(refused.status, 403);
	assert.equal(((await refused.json()) as { error: string }).error, "step_not_running");
});

test("a done, failed, or aborted step's token is refused by /api/tcps/execute", async () => {
	for (const settle of ["done", "failed", "aborted"] as const) {
		const step = runningStep();
		if (settle === "aborted") failRunningStep(step.id, "aborted");
		else completeStep(step.id, { ok: settle === "done", error: settle === "failed" ? "nope" : undefined });
		const res = await execute(step.id, step.callbackToken);
		assert.equal(res.status, 403, settle);
		assert.equal(((await res.json()) as { error: string }).error, "step_not_running");
	}
});

test("an older run's token dies when the next run is dispatched", async () => {
	const wf = workflow();
	const step = getStep(insertStep(wf.id, "two runs").id)!;
	const runs: string[] = [];
	const hook = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			runs.push(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
	const hookAddr = hook.address();
	if (!hookAddr || typeof hookAddr === "string") throw new Error("hook did not bind");
	const live = { ...wf, hookUrl: `http://127.0.0.1:${hookAddr.port}/hook` };
	try {
		await dispatchStep(step, live, cfg, () => {});
		const second = getStep(step.id)!;
		await dispatchStep(second, live, cfg, () => {});
	} finally {
		hook.close();
	}
	const current = getStep(step.id)!;
	const firstRun = JSON.parse(runs[0] ?? "{}") as { callbackUrl?: string };
	const firstToken = new URL(firstRun.callbackUrl ?? "http://127.0.0.1/?token=").searchParams.get("token") ?? "";
	assert.notEqual(firstToken, "");
	assert.notEqual(current.callbackToken, firstToken);
	assert.equal(runs[1]?.includes(firstToken), false);

	const staleExecute = await execute(step.id, firstToken);
	assert.equal(staleExecute.status, 401);
	const staleStarted = await callback("started", step.id, firstToken);
	assert.equal(staleStarted.status, 401);
	const staleResult = await callback("result", step.id, firstToken);
	assert.equal(staleResult.status, 401);

	const liveExecute = await execute(step.id, current.callbackToken);
	assert.equal(liveExecute.status, 200);
	const started = await callback("started", step.id, current.callbackToken);
	assert.equal(started.status, 200);
	const result = await callback("result", step.id, current.callbackToken, { ok: true, result: "from this run" });
	assert.equal(result.status, 200);
	assert.equal(getStep(step.id)!.status, "done");
	assert.equal(getStep(step.id)!.result, "from this run");
});

test("a late result for the current run still authenticates and does not reopen the step", async () => {
	const step = runningStep();
	const first = await callback("result", step.id, step.callbackToken, { ok: true, result: "kept" });
	assert.equal(first.status, 200);
	assert.equal(getStep(step.id)!.status, "done");

	const late = await callback("result", step.id, step.callbackToken, { ok: false, error: "stale", result: "replaced" });
	assert.equal(late.status, 200);
	const after = getStep(step.id)!;
	assert.equal(after.status, "done");
	assert.equal(after.result, "kept");

	const started = await callback("started", step.id, step.callbackToken);
	assert.equal(started.status, 200);
	assert.equal(getStep(step.id)!.status, "done");
});

test("an operator session and the admin token can execute with no step credential", async () => {
	const setup = await fetch(`${baseUrl}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: "correct horse battery" }),
	});
	assert.equal(setup.status, 200);
	const cookie = setup.headers.get("set-cookie") ?? "";
	const session = /target_session=([^;]+)/.exec(cookie)?.[1];
	assert.ok(session);

	const asSession = await fetch(`${baseUrl}/api/tcps/execute`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: `target_session=${session}` },
		body: JSON.stringify({ tcpId: tcp.id, toolName: "ping" }),
	});
	assert.equal(asSession.status, 200);

	const asAdmin = await fetch(`${baseUrl}/api/tcps/execute`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` },
		body: JSON.stringify({ tcpId: tcp.id, toolName: "ping" }),
	});
	assert.equal(asAdmin.status, 200);
});

test("a callback token in an agent error is not logged or stored", async () => {
	const step = runningStep();
	const token = step.callbackToken;
	logs.length = 0;
	const error = `agent echoed http://127.0.0.1/api/steps/${step.id}/result?token=${token} and ${token}`;
	const res = await callback("result", step.id, token, { ok: false, error });
	assert.equal(res.status, 200);
	const stored = getStep(step.id)!.error ?? "";
	assert.equal(stored.includes(token), false);
	assert.equal(logs.some((line) => line.includes(token)), false);
	assert.equal(redactSecrets(error).includes(token), false);

	const daemon = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts"), "utf8");
	const logFn = /function log\([\s\S]*?\n\}/.exec(daemon)?.[0] ?? "";
	assert.match(logFn, /redactSecrets\(message\)/);
});
