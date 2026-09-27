/**
 * Server-origin catalog copies are usable only while the linked owner can
 * author workflows. Operator HTTP is gated; sync command handlers are not.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, beforeEach } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-server-resource-usage-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".awb");

const { executeSyncCommand, resetSyncExecutorState } = await import("./sync.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { insertWorkflow, upsertServerTemplate } = await import("./db.ts");
const { getTcp, listWorkflowTcpSelections, setTcpSyncMeta, setWorkflowTcpSelections, upsertServerTcp } =
	await import("./tcp-store.ts");
const { upsertServerResourceSet } = await import("./rci-store.ts");
const { activateDeviceCredential, beginDeviceLink, deleteDeviceLink } = await import("./device-link.ts");
const { recordOwnerSnapshot } = await import("./owner-permissions.ts");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

beforeEach(() => {
	resetSyncExecutorState();
});

const ORIGIN = "https://server.example";

function owner(permissions: string[]): unknown {
	return { id: "owner_usage", permissions, granted: { groups: [] } };
}

function linkAndGrant(permissions: string[] | null): void {
	deleteDeviceLink();
	if (permissions === null) return;
	beginDeviceLink({ origin: ORIGIN, deviceName: "usage" });
	activateDeviceCredential({
		deviceId: "dev_usage",
		deviceSecret: "secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
	if (permissions.length > 0) {
		recordOwnerSnapshot(owner(permissions), "dev_usage", ORIGIN);
	}
}

function headers() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

const serverTcp = upsertServerTcp("srv-use-tcp", {
	name: "Usage TCP",
	tools: [{ name: "echo", description: "", requestTemplate: "echo", inputs: [], tokens: {} }],
});
const serverRci = upsertServerResourceSet("srv-use-rci", { name: "Usage RCI", resources: [] });
const serverTemplate = upsertServerTemplate("srv-use-tpl", {
	name: "Usage template",
	steps: [{ description: "from server" }],
});
const workflow = insertWorkflow({
	id: "wf-usage",
	name: "usage workflow",
	agentName: "agent-usage",
	hookUrl: "http://127.0.0.1:1/hook",
	secret: "s",
	mdPath: path.join(tmpHome, "usage.md"),
});

test("list and detail include usable=true for local rows", async () => {
	linkAndGrant(null);
	const { insertTcp } = await import("./tcp-store.ts");
	const local = insertTcp({ name: "Local usage tcp", tools: [] });
	const res = await fetch(`${baseUrl}/api/tcps/${local.id}`, { headers: headers() });
	assert.equal(res.status, 200);
	assert.equal(((await res.json()) as { tcp: { usable: boolean; origin: string } }).tcp.usable, true);
});

test("unrestricted and read_only mark server copies unusable", async () => {
	linkAndGrant(null);
	const unrestricted = await fetch(`${baseUrl}/api/tcps/${serverTcp.id}`, { headers: headers() });
	assert.equal(unrestricted.status, 200);
	assert.equal(((await unrestricted.json()) as { tcp: { usable: boolean } }).tcp.usable, false);

	linkAndGrant([]);
	const readOnly = await fetch(`${baseUrl}/api/templates/${serverTemplate.id}`, { headers: headers() });
	assert.equal(readOnly.status, 200);
	assert.equal(((await readOnly.json()) as { template: { usable: boolean } }).template.usable, false);

	const rci = await fetch(`${baseUrl}/api/resourcesets/${serverRci.id}`, { headers: headers() });
	assert.equal(rci.status, 200);
	assert.equal(((await rci.json()) as { resourceSet: { usable: boolean } }).resourceSet.usable, false);
});

test("enforced + workflow permission can attach and apply a server copy", async () => {
	linkAndGrant(["client.workflows.manage", "client.workflows.steps.add"]);
	const listed = await fetch(`${baseUrl}/api/tcps/${serverTcp.id}`, { headers: headers() });
	assert.equal(((await listed.json()) as { tcp: { usable: boolean } }).tcp.usable, true);

	const attach = await fetch(`${baseUrl}/api/workflows/${workflow.id}/tcps`, {
		method: "PUT",
		headers: headers(),
		body: JSON.stringify({ tcpSelections: [{ tcpId: serverTcp.id, toolNames: null }] }),
	});
	assert.equal(attach.status, 200, await attach.text());
	assert.deepEqual(listWorkflowTcpSelections(workflow.id), [{ tcpId: serverTcp.id, toolNames: null }]);

	const apply = await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps/from-template`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ templateId: serverTemplate.id }),
	});
	assert.equal(apply.status, 200, await apply.text());
});

test("enforced without workflow permissions cannot reference a server TCP on a local template", async () => {
	linkAndGrant(["client.templates.create", "client.templates.edit"]);
	const create = await fetch(`${baseUrl}/api/templates`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			name: "local with server tcp",
			steps: [{ description: "x" }],
			tcpSelections: [{ tcpId: serverTcp.id }],
		}),
	});
	assert.equal(create.status, 403);
	assert.deepEqual(await create.json(), { error: "server_resource_disabled", resourceId: serverTcp.id });
});

test("unrestricted create-from-template of a server template is 403", async () => {
	linkAndGrant(null);
	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps/from-template`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ templateId: serverTemplate.id }),
	});
	assert.equal(res.status, 403);
	assert.deepEqual(await res.json(), { error: "server_resource_disabled", resourceId: serverTemplate.id });
});

test("revoked server TCP cannot be added but can be removed", async () => {
	linkAndGrant(["client.workflows.manage"]);
	setWorkflowTcpSelections(workflow.id, []);
	setTcpSyncMeta(serverTcp.id, { syncSource: "catalog", revoked: true });
	const add = await fetch(`${baseUrl}/api/workflows/${workflow.id}/tcps`, {
		method: "PUT",
		headers: headers(),
		body: JSON.stringify({ tcpSelections: [{ tcpId: serverTcp.id }] }),
	});
	assert.equal(add.status, 403);
	assert.deepEqual(await add.json(), { error: "server_resource_disabled", resourceId: serverTcp.id });

	setWorkflowTcpSelections(workflow.id, [{ tcpId: serverTcp.id, toolNames: null }]);
	const remove = await fetch(`${baseUrl}/api/workflows/${workflow.id}/tcps`, {
		method: "PUT",
		headers: headers(),
		body: JSON.stringify({ tcpSelections: [] }),
	});
	assert.equal(remove.status, 200, await remove.text());
	assert.deepEqual(listWorkflowTcpSelections(workflow.id), []);
	setTcpSyncMeta(serverTcp.id, { syncSource: "catalog", revoked: false });
});

test("sync-command path bypasses the operator usage gate", async () => {
	linkAndGrant(["client.read"]);
	assert.equal(getTcp(serverTcp.id)?.origin, "server");
	const remoteId = "rwf_usage_bypass";
	await executeSyncCommand(
		{
			id: "cmd_usage_wf",
			type: "workflow.create",
			remote_id: remoteId,
			sequence: 1,
			payload: { name: "Remote usage" },
			status: "delivered",
		},
		cfg,
	);
	await executeSyncCommand(
		{
			id: "cmd_usage_sel",
			type: "workflow.set_selection",
			remote_id: remoteId,
			sequence: 2,
			payload: { tcp_selections: [{ tcpId: serverTcp.id, toolNames: null }] },
			status: "delivered",
		},
		cfg,
	);
	const { resolveLocalWorkflowId } = await import("./sync.ts");
	const localId = resolveLocalWorkflowId(remoteId);
	assert.ok(localId);
	assert.deepEqual(listWorkflowTcpSelections(localId!), [{ tcpId: serverTcp.id, toolNames: null }]);
});
