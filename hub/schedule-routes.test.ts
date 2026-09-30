/**
 * Route tests for the schedule HTTP API (server.ts) and its MCP tools:
 *
 *   GET/PUT/DELETE /api/workflows/:id/schedule
 *   POST /api/workflows/:id/schedule/{run-now,reschedule,dismiss}
 *   GET /api/schedule-notices, POST /api/schedule-notices/:id/ack
 *   POST /api/schedule/preview
 *
 * Plus the workflow DTO's schedule fields, the D22 permission rule (execute
 * AND manage), and 409 server_managed (D15). Hits the real hub server; the MCP
 * server is spawned for real against it. Runs started by Run now go to a fake
 * awb hook that accepts and never calls back.
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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-schedule-routes-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { getWorkflow, insertStep, insertWorkflow, recordNotice, setWorkflowStatus, updateWorkflowSchedule } =
	await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { setSchedule } = await import("./workflow.ts");
const { activateDeviceCredential, beginDeviceLink, deleteDeviceLink } = await import("./device-link.ts");
const { clearOwnerSnapshot, recordOwnerSnapshot } = await import("./owner-permissions.ts");

const cfg = loadConfig();

// --- fake awb hook + hub server -------------------------------------------------

const hook = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
const hookAddr = hook.address();
if (!hookAddr || typeof hookAddr === "string") throw new Error("fake hook did not bind");
const hookPort = hookAddr.port;

const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("server did not bind");
const baseUrl = `http://127.0.0.1:${addr.port}`;

test.after(() => {
	hook.close();
	server.close();
});

async function api(method: string, route: string, body?: unknown, auth = true) {
	const res = await fetch(`${baseUrl}${route}`, {
		method,
		headers: {
			"content-type": "application/json",
			...(auth ? { authorization: `Bearer ${cfg.adminToken}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

let seq = 0;
function makeWorkflow(options: { status?: "draft" | "running" | "completed"; adoptedSessionId?: string } = {}) {
	seq += 1;
	const id = `wf-routes-${seq}`;
	insertWorkflow({
		id,
		name: `Routes ${seq}`,
		agentName: `routes-agent-${seq}`,
		hookUrl: `http://127.0.0.1:${hookPort}/hook/${id}`,
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
		...(options.adoptedSessionId ? { adoptedSessionId: options.adoptedSessionId } : {}),
	});
	insertStep(id, "the only step");
	if (options.status) setWorkflowStatus(id, options.status);
	return id;
}

const DAILY = { spec: { kind: "daily", time: "09:00" }, timezone: "Europe/Madrid" };

/** A `once` instance that the scheduler has marked missed. */
function missedOnce(options: { server?: boolean } = {}) {
	const id = makeWorkflow();
	setSchedule(
		id,
		{ spec: { kind: "once", at: "2099-01-01T09:00" }, timezone: "UTC" },
		options.server ? { actor: "server" } : {},
	);
	updateWorkflowSchedule(id, { scheduleState: "missed", nextRunAt: null });
	return id;
}

// --- GET/PUT/DELETE /api/workflows/:id/schedule ------------------------------------------

test("the workflow DTO carries schedule: null and nextRunAt: null until scheduled", async () => {
	const id = makeWorkflow();
	const res = await api("GET", `/api/workflows/${id}`);
	assert.equal(res.status, 200);
	assert.equal(res.body.workflow.schedule, null);
	assert.equal(res.body.workflow.nextRunAt, null);
	const sched = await api("GET", `/api/workflows/${id}/schedule`);
	assert.equal(sched.status, 200);
	assert.deepEqual(sched.body, { schedule: null, nextRunAt: null, instances: [] });
});

test("PUT schedules the workflow: series + schedule fields and the computed nextRunAt", async () => {
	const id = makeWorkflow();
	const res = await api("PUT", `/api/workflows/${id}/schedule`, { ...DAILY, includePrevious: false });
	assert.equal(res.status, 200, JSON.stringify(res.body));
	const wf = res.body.workflow;
	assert.ok(Date.parse(wf.nextRunAt) > Date.now(), "next run in the future");
	assert.equal(wf.schedule.state, "armed");
	assert.deepEqual(wf.schedule.spec, DAILY.spec);
	assert.equal(wf.schedule.timezone, "Europe/Madrid");
	assert.equal(wf.schedule.includePrevious, false);
	assert.equal(wf.schedule.seriesName, `Routes ${seq}`);
	assert.equal(wf.schedule.managedBy, "local");
	assert.ok(wf.schedule.seriesId);
	assert.equal(wf.schedule.nextRunAt, wf.nextRunAt);

	const detail = await api("GET", `/api/workflows/${id}`);
	assert.equal(detail.body.workflow.nextRunAt, wf.nextRunAt);
	const sched = await api("GET", `/api/workflows/${id}/schedule`);
	assert.equal(sched.body.schedule.seriesId, wf.schedule.seriesId);
	assert.equal(sched.body.nextRunAt, wf.nextRunAt);
	assert.deepEqual(
		sched.body.instances.map((i: { id: string; scheduleState: string }) => [i.id, i.scheduleState]),
		[[id, "armed"]],
	);
});

test("PUT answers 400 invalid_schedule with validateSchedule's field errors", async () => {
	const id = makeWorkflow();
	const bad = await api("PUT", `/api/workflows/${id}/schedule`, {
		spec: { kind: "weekly", days: [], time: "25:00" },
		timezone: "Mars/Olympus",
	});
	assert.equal(bad.status, 400);
	assert.equal(bad.body.error, "invalid_schedule");
	assert.deepEqual(bad.body.fields.map((f: { field: string }) => f.field).sort(), ["days", "time", "timezone"]);
	assert.ok(bad.body.fields.every((f: { message: string }) => typeof f.message === "string" && f.message));

	const missing = await api("PUT", `/api/workflows/${id}/schedule`, {});
	assert.equal(missing.status, 400);
	assert.equal(missing.body.error, "invalid_schedule");

	const past = await api("PUT", `/api/workflows/${id}/schedule`, {
		spec: { kind: "once", at: "2020-01-01T09:00" },
		timezone: "UTC",
	});
	assert.equal(past.status, 400);
	assert.equal(past.body.error, "invalid_schedule");
	assert.equal(past.body.fields[0].field, "at");

	const flag = await api("PUT", `/api/workflows/${id}/schedule`, { ...DAILY, includePrevious: "yes" });
	assert.equal(flag.status, 400);
	assert.equal(flag.body.fields[0].field, "includePrevious");
	assert.equal(getWorkflow(id)!.scheduleState, null, "nothing written");
});

test("PUT refuses a workflow in progress, an adopted conversation, and unknown ids", async () => {
	const running = await api("PUT", `/api/workflows/${makeWorkflow({ status: "running" })}/schedule`, DAILY);
	assert.equal(running.status, 400);
	assert.match(running.body.error, /only a draft, completed or failed workflow/);
	const adopted = await api("PUT", `/api/workflows/${makeWorkflow({ adoptedSessionId: "sess-op" })}/schedule`, DAILY);
	assert.equal(adopted.status, 400);
	assert.match(adopted.body.error, /adopted conversation/);
	const unknown = await api("PUT", "/api/workflows/nope/schedule", DAILY);
	assert.equal(unknown.status, 404);
	assert.equal((await api("GET", "/api/workflows/nope/schedule")).status, 404);
});

test("mutations need the admin token", async () => {
	const id = makeWorkflow();
	for (const [method, route] of [
		["PUT", `/api/workflows/${id}/schedule`],
		["DELETE", `/api/workflows/${id}/schedule`],
		["POST", `/api/workflows/${id}/schedule/run-now`],
		["POST", `/api/workflows/${id}/schedule/reschedule`],
		["POST", `/api/workflows/${id}/schedule/dismiss`],
		["POST", "/api/schedule/preview"],
		["POST", "/api/schedule-notices/x/ack"],
	] as const) {
		const res = await api(method, route, DAILY, false);
		assert.equal(res.status, 401, `${method} ${route}`);
	}
});

test("DELETE cancels: the workflow is normal again and has no next run", async () => {
	const id = makeWorkflow();
	await api("PUT", `/api/workflows/${id}/schedule`, DAILY);
	const res = await api("DELETE", `/api/workflows/${id}/schedule`);
	assert.equal(res.status, 200, JSON.stringify(res.body));
	assert.equal(res.body.workflow.schedule.state, "cancelled");
	assert.equal(res.body.workflow.nextRunAt, null, "computed: only an armed instance has a next run");
	assert.equal(getWorkflow(id)!.scheduleState, "cancelled");
	// cancelling something with no live schedule is a harmless no-op
	assert.equal((await api("DELETE", `/api/workflows/${makeWorkflow()}/schedule`)).status, 200);
});

test("409 server_managed for PUT, DELETE and reschedule of a server-managed series", async () => {
	const id = makeWorkflow();
	setSchedule(id, { spec: { kind: "daily", time: "09:00" }, timezone: "UTC" }, { actor: "server" });
	const put = await api("PUT", `/api/workflows/${id}/schedule`, DAILY);
	assert.equal(put.status, 409);
	assert.equal(put.body.error, "server_managed");
	const del = await api("DELETE", `/api/workflows/${id}/schedule`);
	assert.equal(del.status, 409);
	assert.equal(del.body.error, "server_managed");
	assert.equal(getWorkflow(id)!.scheduleState, "armed", "unchanged");
	assert.equal((await api("GET", `/api/workflows/${id}`)).body.workflow.schedule.managedBy, "server");

	const missed = missedOnce({ server: true });
	const re = await api("POST", `/api/workflows/${missed}/schedule/reschedule`, {
		spec: { kind: "once", at: "2099-06-01T09:00" },
		timezone: "UTC",
	});
	assert.equal(re.status, 409);
	assert.equal(re.body.error, "server_managed");
	assert.equal((await api("POST", `/api/workflows/${missed}/schedule/dismiss`)).body.error, "server_managed");
	assert.equal((await api("POST", `/api/workflows/${missed}/schedule/run-now`)).body.error, "server_managed");
	assert.equal(getWorkflow(missed)!.scheduleState, "missed");
});

// --- missed once: run-now / reschedule / dismiss --------------------------------------------

test("run-now starts a missed once (and only once)", async () => {
	const id = missedOnce();
	const res = await api("POST", `/api/workflows/${id}/schedule/run-now`);
	assert.equal(res.status, 200, JSON.stringify(res.body));
	assert.equal(res.body.workflow.schedule.state, "fired");
	assert.equal(res.body.workflow.status, "running");
	const again = await api("POST", `/api/workflows/${id}/schedule/run-now`);
	assert.equal(again.status, 409);
	assert.equal(again.body.error, "not_missed");
});

test("reschedule re-arms a missed once in its series; invalid input is 400", async () => {
	const id = missedOnce();
	const seriesId = getWorkflow(id)!.seriesId;
	const invalid = await api("POST", `/api/workflows/${id}/schedule/reschedule`, {
		spec: { kind: "once", at: "not a date" },
		timezone: "UTC",
	});
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.error, "invalid_schedule");
	const res = await api("POST", `/api/workflows/${id}/schedule/reschedule`, {
		spec: { kind: "once", at: "2099-06-01T09:00" },
		timezone: "UTC",
	});
	assert.equal(res.status, 200, JSON.stringify(res.body));
	assert.equal(res.body.workflow.schedule.state, "armed");
	assert.equal(res.body.workflow.schedule.seriesId, seriesId);
	assert.equal(res.body.workflow.nextRunAt, "2099-06-01T09:00:00.000Z");
});

test("dismiss releases a missed once as a normal workflow", async () => {
	const id = missedOnce();
	const res = await api("POST", `/api/workflows/${id}/schedule/dismiss`);
	assert.equal(res.status, 200, JSON.stringify(res.body));
	assert.equal(res.body.workflow.schedule.state, "cancelled");
	assert.equal(res.body.workflow.status, "draft");
});

test("run-now / reschedule / dismiss answer 409 not_missed on anything that wasn't missed", async () => {
	const armed = makeWorkflow();
	await api("PUT", `/api/workflows/${armed}/schedule`, DAILY);
	for (const id of [armed, makeWorkflow()]) {
		for (const action of ["run-now", "reschedule", "dismiss"]) {
			const res = await api("POST", `/api/workflows/${id}/schedule/${action}`, DAILY);
			assert.equal(res.status, 409, `${action} on ${id}`);
			assert.equal(res.body.error, "not_missed");
		}
	}
	assert.equal(getWorkflow(armed)!.scheduleState, "armed");
	assert.equal((await api("POST", "/api/workflows/nope/schedule/run-now")).status, 404);
});

// --- permissions (D22) -----------------------------------------------------------------------

test("schedule mutations need BOTH client.workflows.execute and client.workflows.manage", async (t) => {
	const ORIGIN = "https://server.example";
	const link = (permissions: string[] | null) => {
		deleteDeviceLink();
		beginDeviceLink({ origin: ORIGIN, deviceName: "schedule-routes" });
		activateDeviceCredential({
			deviceId: "dev_sched",
			deviceSecret: "secret",
			scopes: ["ingest:write", "sync:write"],
			credentialVersion: 1,
		});
		if (permissions) recordOwnerSnapshot({ id: "owner_sched", permissions, granted: { groups: [] } }, "dev_sched", ORIGIN);
	};
	t.after(() => {
		deleteDeviceLink();
		clearOwnerSnapshot();
	});
	const id = makeWorkflow();
	const missed = missedOnce();
	const mutations = [
		["PUT", `/api/workflows/${id}/schedule`],
		["DELETE", `/api/workflows/${id}/schedule`],
		["POST", `/api/workflows/${missed}/schedule/run-now`],
		["POST", `/api/workflows/${missed}/schedule/reschedule`],
		["POST", `/api/workflows/${missed}/schedule/dismiss`],
	] as const;

	link(["client.read", "client.workflows.execute"]);
	for (const [method, route] of mutations) {
		const res = await api(method, route, DAILY);
		assert.equal(res.status, 403, `${method} ${route}`);
		assert.equal(res.body.error, "forbidden");
		assert.equal(res.body.permission, "client.workflows.manage");
	}
	link(["client.read", "client.workflows.manage"]);
	for (const [method, route] of mutations) {
		const res = await api(method, route, DAILY);
		assert.equal(res.status, 403, `${method} ${route}`);
		assert.equal(res.body.permission, "client.workflows.execute");
	}
	// Linked but no owner snapshot yet: read-only, refused too.
	link(null);
	clearOwnerSnapshot();
	assert.equal((await api("PUT", `/api/workflows/${id}/schedule`, DAILY)).status, 403);
	assert.equal(getWorkflow(id)!.scheduleState, null, "nothing was scheduled by a refused request");
	assert.equal(getWorkflow(missed)!.scheduleState, "missed");

	// Reads stay open.
	assert.equal((await api("GET", `/api/workflows/${id}/schedule`)).status, 200);
	assert.equal((await api("GET", "/api/schedule-notices")).status, 200);

	link(["client.read", "client.workflows.execute", "client.workflows.manage"]);
	const ok = await api("PUT", `/api/workflows/${id}/schedule`, DAILY);
	assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// --- notices -------------------------------------------------------------------------------------

test("GET /api/schedule-notices lists all or only unacknowledged; POST ack acknowledges", async () => {
	const seriesId = "series-routes-notices";
	const a = recordNotice({ seriesId, kind: "missed", reason: "offline", detail: { count: 2 } });
	const b = recordNotice({ seriesId, kind: "skipped", reason: "busy" });

	const all = await api("GET", `/api/schedule-notices?seriesId=${seriesId}`);
	assert.equal(all.status, 200);
	assert.deepEqual(all.body.notices.map((n: { id: string }) => n.id).sort(), [a.id, b.id].sort());
	assert.deepEqual(all.body.notices.find((n: { id: string }) => n.id === a.id).detail, { count: 2 });

	const ack = await api("POST", `/api/schedule-notices/${a.id}/ack`);
	assert.equal(ack.status, 200);
	assert.equal(ack.body.notice.id, a.id);
	assert.ok(ack.body.notice.acknowledgedAt);

	const open = await api("GET", `/api/schedule-notices?unacknowledged=1&seriesId=${seriesId}`);
	assert.deepEqual(open.body.notices.map((n: { id: string }) => n.id), [b.id]);
	const stillAll = await api("GET", `/api/schedule-notices?seriesId=${seriesId}`);
	assert.equal(stillAll.body.notices.length, 2, "acknowledged ones are still listed without the filter");

	const unknown = await api("POST", "/api/schedule-notices/no-such-notice/ack");
	assert.equal(unknown.status, 404);
	assert.equal(unknown.body.error, "unknown_notice");
});

// --- preview ---------------------------------------------------------------------------------------

test("POST /api/schedule/preview returns the next 3 occurrences (ISO + local)", async () => {
	const daily = await api("POST", "/api/schedule/preview", DAILY);
	assert.equal(daily.status, 200, JSON.stringify(daily.body));
	assert.equal(daily.body.timezone, "Europe/Madrid");
	const occ = daily.body.occurrences as { at: string; local: string }[];
	assert.equal(occ.length, 3);
	const times = occ.map((o) => Date.parse(o.at));
	assert.ok(times[0] > Date.now());
	assert.ok(times[0] < times[1] && times[1] < times[2], "ascending");
	for (const o of occ) assert.match(o.local, /^\d{4}-\d{2}-\d{2} 09:00$/);

	const weekly = await api("POST", "/api/schedule/preview", {
		spec: { kind: "weekly", days: [1], time: "07:30" },
		timezone: "America/New_York",
	});
	assert.equal(weekly.body.occurrences.length, 3);
	for (const o of weekly.body.occurrences) {
		assert.match(o.local, / 07:30$/);
		const [y, m, d] = o.local.slice(0, 10).split("-").map(Number);
		assert.equal(new Date(Date.UTC(y, m - 1, d)).getUTCDay(), 1, "a Monday");
	}

	const once = await api("POST", "/api/schedule/preview", { spec: { kind: "once", at: "2099-01-01T09:00" }, timezone: "UTC" });
	assert.deepEqual(once.body.occurrences, [{ at: "2099-01-01T09:00:00.000Z", local: "2099-01-01 09:00" }]);
	const pastOnce = await api("POST", "/api/schedule/preview", { spec: { kind: "once", at: "2020-01-01T09:00" }, timezone: "UTC" });
	assert.deepEqual(pastOnce.body.occurrences, []);

	const invalid = await api("POST", "/api/schedule/preview", { spec: { kind: "daily", time: "9" }, timezone: "UTC" });
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.error, "invalid_schedule");
	assert.equal(invalid.body.fields[0].field, "time");
});

// --- MCP tools ---------------------------------------------------------------------------------------

test("MCP: set_schedule, cancel_schedule and list_schedule_notices exist and call the API", async () => {
	const mcpPath = fileURLToPath(new URL("../mcp/target-mcp.mjs", import.meta.url));
	const child = spawn(process.execPath, [mcpPath], {
		env: { ...process.env, TARGET_HUB_URL: baseUrl, TARGET_ADMIN_TOKEN: cfg.adminToken },
		stdio: ["pipe", "pipe", "inherit"],
	});
	const lines = readline.createInterface({ input: child.stdout! });
	const waiting = new Map<number, (msg: any) => void>();
	lines.on("line", (line) => {
		const msg = JSON.parse(line);
		waiting.get(msg.id)?.(msg);
	});
	let nextId = 0;
	const rpc = (method: string, params: unknown) =>
		new Promise<any>((resolve) => {
			const id = ++nextId;
			waiting.set(id, (msg) => resolve(msg.result));
			child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	try {
		const { tools } = await rpc("tools/list", {});
		const names = tools.map((t: { name: string }) => t.name);
		for (const name of ["set_schedule", "cancel_schedule", "list_schedule_notices"]) {
			assert.ok(names.includes(name), `${name} is listed`);
		}

		const id = makeWorkflow();
		const set = await rpc("tools/call", {
			name: "set_schedule",
			arguments: { workflowId: id, spec: { kind: "daily", time: "10:00" }, timezone: "UTC" },
		});
		assert.notEqual(set.isError, true, set.content[0].text);
		assert.equal(JSON.parse(set.content[0].text).workflow.schedule.state, "armed");
		assert.equal(getWorkflow(id)!.scheduleState, "armed");

		const invalid = await rpc("tools/call", {
			name: "set_schedule",
			arguments: { workflowId: id, spec: { kind: "daily", time: "99:00" }, timezone: "UTC" },
		});
		assert.equal(invalid.isError, true);
		assert.equal(JSON.parse(JSON.parse(invalid.content[0].text).message).error, "invalid_schedule");

		const cancel = await rpc("tools/call", { name: "cancel_schedule", arguments: { workflowId: id } });
		assert.notEqual(cancel.isError, true);
		assert.equal(getWorkflow(id)!.scheduleState, "cancelled");

		const notice = recordNotice({ seriesId: "series-mcp", kind: "broken", reason: "clone_failed" });
		const listed = await rpc("tools/call", {
			name: "list_schedule_notices",
			arguments: { unacknowledged: true, seriesId: "series-mcp" },
		});
		assert.notEqual(listed.isError, true);
		assert.deepEqual(
			JSON.parse(listed.content[0].text).notices.map((n: { id: string }) => n.id),
			[notice.id],
		);
	} finally {
		child.kill();
	}
});
