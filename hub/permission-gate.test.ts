/**
 * HTTP matrix: a role that only has remote.read is refused on every mutation
 * family; the full catalogue is accepted. Hits the real hub server.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-permission-gate-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { insertStep, insertWorkflow } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const {
	activateDeviceCredential,
	beginDeviceLink,
	deleteDeviceLink,
} = await import("./device-link.ts");
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

const ORIGIN = "https://server.example";
const FULL_PERMISSIONS = [
	"remote.read",
	"remote.workflows.create",
	"remote.workflows.steps.add",
	"remote.workflows.steps.edit",
	"remote.workflows.manage",
	"remote.workflows.execute",
	"remote.templates.create",
	"remote.templates.edit",
	"remote.templates.delete",
	"remote.templates.import",
	"remote.templates.export",
	"remote.tcp-tools.create",
	"remote.tcp-tools.edit",
	"remote.tcp-tools.delete",
	"remote.tcp-tools.import",
	"remote.tcp-tools.export",
	"remote.rci.create",
	"remote.rci.edit",
	"remote.rci.delete",
	"remote.rci.import",
	"remote.rci.export",
];

function owner(permissions: string[]): unknown {
	return {
		id: "owner_gate",
		permissions,
		granted: { groups: [] },
	};
}

function linkAndGrant(permissions: string[]): void {
	deleteDeviceLink();
	beginDeviceLink({ origin: ORIGIN, deviceName: "gate" });
	activateDeviceCredential({
		deviceId: "dev_gate",
		deviceSecret: "secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
	recordOwnerSnapshot(owner(permissions), "dev_gate", ORIGIN);
}

function headers(): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

const seeded = insertWorkflow({
	id: "wf-gate",
	name: "gate workflow",
	agentName: "agent-gate",
	hookUrl: "http://127.0.0.1:1/hook",
	secret: "s",
	mdPath: path.join(tmpHome, "wf-gate.md"),
});
const seededStep = insertStep(seeded.id, "pending step");

type Case = {
	family: string;
	permission: string;
	method: string;
	path: string;
	body?: Record<string, unknown>;
};

const MATRIX: Case[] = [
	{
		family: "workflows.create",
		permission: "remote.workflows.create",
		method: "POST",
		path: "/api/workflows",
		body: { name: "created-by-gate" },
	},
	{
		family: "steps.add",
		permission: "remote.workflows.steps.add",
		method: "POST",
		path: `/api/workflows/${seeded.id}/steps`,
		body: { description: "added by gate" },
	},
	{
		family: "steps.edit",
		permission: "remote.workflows.steps.edit",
		method: "PATCH",
		path: `/api/workflows/${seeded.id}/steps/${seededStep.id}`,
		body: { description: "edited by gate" },
	},
	{
		family: "manage",
		permission: "remote.workflows.manage",
		method: "PATCH",
		path: `/api/workflows/${seeded.id}/name`,
		body: { name: "renamed-by-gate" },
	},
	{
		family: "execute",
		permission: "remote.workflows.execute",
		method: "POST",
		path: `/api/workflows/${seeded.id}/start`,
		body: { stepIds: [] },
	},
	{
		family: "templates",
		permission: "remote.templates.create",
		method: "POST",
		path: "/api/templates",
		body: { name: "gate-template", tags: [], steps: [{ description: "t" }] },
	},
	{
		family: "tcp-tools",
		permission: "remote.tcp-tools.create",
		method: "POST",
		path: "/api/tcps",
		body: { name: "gate-tcp", tools: [] },
	},
	{
		family: "rci",
		permission: "remote.rci.create",
		method: "POST",
		path: "/api/resourcesets",
		body: { name: "gate-rci", resources: [] },
	},
];

async function call(entry: Case): Promise<Response> {
	return fetch(`${baseUrl}${entry.path}`, {
		method: entry.method,
		headers: headers(),
		body: entry.body ? JSON.stringify(entry.body) : undefined,
	});
}

test("remote.read only: each mutation family answers 403 with the missing permission", async () => {
	linkAndGrant(["remote.read"]);
	for (const entry of MATRIX) {
		const res = await call(entry);
		assert.equal(res.status, 403, `${entry.family} should be 403`);
		const body = (await res.json()) as { error: string; permission: string; mode: string };
		assert.equal(body.error, "forbidden");
		assert.equal(body.permission, entry.permission, entry.family);
		assert.equal(body.mode, "enforced");
	}
});

test("full role: each mutation family answers 2xx", async () => {
	linkAndGrant(FULL_PERMISSIONS);
	for (const entry of MATRIX) {
		const res = await call(entry);
		assert.ok(res.status >= 200 && res.status < 300, `${entry.family} should be 2xx, got ${res.status}`);
		await res.json().catch(() => null);
	}
});
