/**
 * HTTP routes for workflow archiving: POST /api/workflows/:id/{archive,unarchive},
 * the `?archived=` filter on GET /api/workflows, the 409 `archived` refusal of
 * every run entry point (start/resume/restart/▶ step run), and the
 * `archive_after_days` setting (GET/PUT /api/settings/archive).
 *
 * Hits the real hub server on an ephemeral port, with a throwaway TARGET_HOME
 * (same convention as permission-gate.test.ts). Workflows are seeded straight
 * into the DB with settled steps, so the list's read-path heal (`expireStale`)
 * keeps their completed/failed status and nothing is ever dispatched.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-archive-routes-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { getWorkflow, insertStep, insertWorkflow, open, setWorkflowStatus } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { activateDeviceCredential, beginDeviceLink, deleteDeviceLink } = await import("./device-link.ts");
const { recordOwnerSnapshot } = await import("./owner-permissions.ts");
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

type Status = "draft" | "running" | "paused" | "waiting" | "completed" | "failed";
type StepStatus = "pending" | "running" | "done" | "failed";
type WorkflowJson = { id: string; status: string; archivedAt: string | null };

let seq = 0;

/** A workflow in `status` whose only step is `stepStatus` (settled steps keep a terminal status stable). */
function seedWorkflow(status: Status, stepStatus: StepStatus): { id: string; stepId: string } {
	seq += 1;
	const id = `wf-archive-route-${seq}`;
	insertWorkflow({
		id,
		name: `archive route ${seq}`,
		agentName: `archive-route-agent-${seq}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const step = insertStep(id, `step of ${id}`);
	open().prepare("UPDATE steps SET status = ?, finished_at = ? WHERE id = ?").run(
		stepStatus,
		stepStatus === "done" || stepStatus === "failed" ? new Date().toISOString() : null,
		step.id,
	);
	setWorkflowStatus(id, status);
	return { id, stepId: step.id };
}

function headers(): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

async function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await fetch(`${baseUrl}${urlPath}`, {
		method,
		headers: headers(),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: await res.json().catch(() => null) };
}

async function listIds(query = ""): Promise<string[]> {
	const { status, json } = await call("GET", `/api/workflows${query}`);
	assert.equal(status, 200);
	return (json.workflows as WorkflowJson[]).map((w) => w.id);
}

test("POST archive archives a completed workflow and returns it with archivedAt; unarchive clears it", async () => {
	const { id } = seedWorkflow("completed", "done");
	const archived = await call("POST", `/api/workflows/${id}/archive`);
	assert.equal(archived.status, 200);
	assert.equal(archived.json.workflow.id, id);
	assert.equal(archived.json.workflow.status, "completed", "the outcome survives archiving");
	assert.equal(typeof archived.json.workflow.archivedAt, "string");
	assert.equal(getWorkflow(id)?.archivedAt, archived.json.workflow.archivedAt);

	// Idempotent: a second archive keeps the original timestamp.
	const again = await call("POST", `/api/workflows/${id}/archive`);
	assert.equal(again.status, 200);
	assert.equal(again.json.workflow.archivedAt, archived.json.workflow.archivedAt);

	const unarchived = await call("POST", `/api/workflows/${id}/unarchive`);
	assert.equal(unarchived.status, 200);
	assert.equal(unarchived.json.workflow.archivedAt, null);
	assert.equal(getWorkflow(id)?.archivedAt, null);
});

test("POST archive accepts a failed workflow", async () => {
	const { id } = seedWorkflow("failed", "failed");
	const res = await call("POST", `/api/workflows/${id}/archive`);
	assert.equal(res.status, 200);
	assert.equal(res.json.workflow.status, "failed");
	assert.notEqual(res.json.workflow.archivedAt, null);
});

test("POST archive on a draft or running workflow answers 409 not_archivable and archives nothing", async () => {
	for (const [status, stepStatus] of [
		["draft", "pending"],
		["running", "running"],
	] as const) {
		const { id } = seedWorkflow(status, stepStatus);
		const res = await call("POST", `/api/workflows/${id}/archive`);
		assert.equal(res.status, 409, status);
		assert.equal(res.json.error, "not_archivable");
		assert.equal(getWorkflow(id)?.archivedAt, null);
	}
});

test("archive/unarchive of an unknown workflow answer 404 unknown_workflow", async () => {
	for (const action of ["archive", "unarchive"]) {
		const res = await call("POST", `/api/workflows/no-such-workflow/${action}`);
		assert.equal(res.status, 404, action);
		assert.equal(res.json.error, "unknown_workflow");
	}
});

test("archive/unarchive require client.workflows.manage when permissions are enforced", async () => {
	const { id } = seedWorkflow("completed", "done");
	const ORIGIN = "https://server.example";
	const grant = (permissions: string[]) => {
		deleteDeviceLink();
		beginDeviceLink({ origin: ORIGIN, deviceName: "archive-gate" });
		activateDeviceCredential({
			deviceId: "dev_archive_gate",
			deviceSecret: "secret",
			scopes: ["ingest:write", "sync:write"],
			credentialVersion: 1,
		});
		recordOwnerSnapshot({ id: "owner_archive", permissions, granted: { groups: [] } }, "dev_archive_gate", ORIGIN);
	};
	try {
		grant(["client.read", "client.workflows.execute"]);
		for (const action of ["archive", "unarchive"]) {
			const res = await call("POST", `/api/workflows/${id}/${action}`);
			assert.equal(res.status, 403, action);
			assert.equal(res.json.error, "forbidden");
			assert.equal(res.json.permission, "client.workflows.manage");
			assert.equal(res.json.mode, "enforced");
		}
		assert.equal(getWorkflow(id)?.archivedAt, null);

		grant(["client.read", "client.workflows.manage"]);
		const res = await call("POST", `/api/workflows/${id}/archive`);
		assert.equal(res.status, 200);
		assert.notEqual(res.json.workflow.archivedAt, null);
	} finally {
		deleteDeviceLink();
	}

	// Without the operator token at all: 401, as for every other mutation.
	const anon = await fetch(`${baseUrl}/api/workflows/${id}/unarchive`, { method: "POST" });
	assert.equal(anon.status, 401);
});

test("GET /api/workflows hides archived workflows by default; ?archived=include|only select them", async () => {
	const live = seedWorkflow("completed", "done").id;
	const filed = seedWorkflow("completed", "done").id;
	assert.equal((await call("POST", `/api/workflows/${filed}/archive`)).status, 200);

	const byDefault = await listIds();
	assert.ok(byDefault.includes(live));
	assert.ok(!byDefault.includes(filed));
	assert.deepEqual(await listIds("?archived=exclude"), byDefault);

	const all = await listIds("?archived=include");
	assert.ok(all.includes(live));
	assert.ok(all.includes(filed));

	const only = await listIds("?archived=only");
	assert.ok(only.includes(filed));
	assert.ok(!only.includes(live));
	const { json } = await call("GET", "/api/workflows?archived=only");
	for (const w of json.workflows as WorkflowJson[]) assert.notEqual(w.archivedAt, null);
});

test("GET /api/workflows with an invalid archived filter answers 400", async () => {
	for (const value of ["yes", "", "ONLY"]) {
		const res = await call("GET", `/api/workflows?archived=${value}`);
		assert.equal(res.status, 400, JSON.stringify(value));
		assert.match(String(res.json.error), /archived/);
	}
});

test("start, resume, restart and step run on an archived workflow answer 409 archived", async () => {
	const { id, stepId } = seedWorkflow("completed", "done");
	assert.equal((await call("POST", `/api/workflows/${id}/archive`)).status, 200);
	for (const action of ["start", "resume", "restart"]) {
		const res = await call("POST", `/api/workflows/${id}/${action}`, { stepIds: [stepId] });
		assert.equal(res.status, 409, action);
		assert.equal(res.json.error, "archived", action);
	}
	const run = await call("POST", `/api/workflows/${id}/steps/${stepId}/run`);
	assert.equal(run.status, 409);
	assert.equal(run.json.error, "archived");

	// Nothing moved: still completed, still archived, the step still done.
	const detail = await call("GET", `/api/workflows/${id}`);
	assert.equal(detail.json.workflow.status, "completed");
	assert.notEqual(detail.json.workflow.archivedAt, null);
	assert.equal(detail.json.steps[0].status, "done");
});

test("a paused workflow archived by hand in the DB is still refused on resume (409 archived)", async () => {
	// Archiving only accepts terminal workflows, but the run guard is on the flag
	// itself, so it holds whatever status the workflow carries.
	const { id } = seedWorkflow("paused", "pending");
	open().prepare("UPDATE workflows SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), id);
	const res = await call("POST", `/api/workflows/${id}/resume`, { stepIds: [] });
	assert.equal(res.status, 409);
	assert.equal(res.json.error, "archived");
	assert.equal(getWorkflow(id)?.status, "paused");
});

test("archive settings round-trip archive_after_days (default 30, 0 allowed, invalid → 400)", async () => {
	const initial = await call("GET", "/api/settings/archive");
	assert.equal(initial.status, 200);
	assert.equal(initial.json.settings.archive_after_days, 30);

	const seven = await call("PUT", "/api/settings/archive", { archive_after_days: 7 });
	assert.equal(seven.status, 200);
	assert.equal(seven.json.settings.archive_after_days, 7);
	assert.equal((await call("GET", "/api/settings/archive")).json.settings.archive_after_days, 7);

	const off = await call("PUT", "/api/settings/archive", { archive_after_days: 0 });
	assert.equal(off.status, 200);
	assert.equal((await call("GET", "/api/settings/archive")).json.settings.archive_after_days, 0);

	for (const bad of [-1, "abc", 1.5, null]) {
		const res = await call("PUT", "/api/settings/archive", { archive_after_days: bad });
		assert.equal(res.status, 400, JSON.stringify(bad));
		assert.match(String(res.json.error), /archive_after_days/);
	}
	const missing = await call("PUT", "/api/settings/archive", {});
	assert.equal(missing.status, 400);
	// A rejected PUT leaves the stored value alone.
	assert.equal((await call("GET", "/api/settings/archive")).json.settings.archive_after_days, 0);

	const anon = await fetch(`${baseUrl}/api/settings/archive`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ archive_after_days: 5 }),
	});
	assert.equal(anon.status, 401);
});
