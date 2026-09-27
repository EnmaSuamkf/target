/**
 * On-demand catalog pull: upsert/update/prune, local id collisions, 404
 * unsupported, route 403/409, and template application with a missing TCP.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { FetchLike } from "./sync.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-catalog-sync-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const ORIGIN = "https://catalog.example";

const { insertTemplate, insertWorkflow, open } = await import("./db.ts");
const { applyTemplateResourcesToWorkflow, getResourceSet, listWorkflowResourceSelections } = await import("./rci-store.ts");
const {
	applyTemplateTcpsToWorkflow,
	getTcp,
	insertTcp,
	listTcps,
	listWorkflowTcpSelections,
	setWorkflowTcpSelections,
	upsertServerTcp,
} = await import("./tcp-store.ts");
const { CatalogSyncError, getCatalogSyncStatus, setCatalogSyncFetchForTests, syncServerCatalog } = await import("./catalog-sync.ts");
const { activateDeviceCredential, beginDeviceLink, deleteDeviceLink } = await import("./device-link.ts");
const { recordOwnerSnapshot } = await import("./owner-permissions.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
test.after(() => {
	setCatalogSyncFetchForTests(null);
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

function owner(permissions: string[]): unknown {
	return { id: "owner_catalog", permissions, granted: { groups: [] } };
}

function linkDevice(permissions: string[]): void {
	deleteDeviceLink();
	beginDeviceLink({ origin: ORIGIN, deviceName: "catalog-sync" });
	activateDeviceCredential({
		deviceId: "dev_catalog",
		deviceSecret: "secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
	recordOwnerSnapshot(owner(permissions), "dev_catalog", ORIGIN);
}

function catalogResponse(partial: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		contract_version: "catalog-sync/v1",
		server_time: new Date().toISOString(),
		owner_id: "owner_catalog",
		allowed: { templates: true, tcp_tools: true, resource_sets: true },
		templates: [],
		tcp_tools: [],
		resource_sets: [],
		...partial,
	};
}

function catalogFetch(body: unknown, status = 200): FetchLike {
	return async (url) => {
		const pathname = new URL(url).pathname;
		if (pathname === "/api/sync/catalog") {
			return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		}
		return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
	};
}

function insertLocalTcp(id: string, name: string): void {
	listTcps();
	const now = new Date().toISOString();
	open()
		.prepare(
			`INSERT INTO tcps (id, name, tags, tools, origin, sync_source, synced_at, revoked, created_at, updated_at)
			 VALUES (?, ?, '[]', '[]', 'local', NULL, NULL, 0, ?, ?)`,
		)
		.run(id, name, now, now);
}

test("applying a template with a missing TCP no longer throws", () => {
	const workflow = insertWorkflow({
		id: "wf-missing-tcp",
		name: "missing tcp",
		agentName: "agent-missing-tcp",
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, "missing.md"),
	});
	const template = insertTemplate({
		name: "broken refs",
		steps: [{ description: "still apply me" }],
		tcpSelections: [{ tcpId: "no-such-tcp" }],
		resourceSelections: [{ resourceSetId: "no-such-rci" }],
	});
	assert.doesNotThrow(() => applyTemplateTcpsToWorkflow(workflow.id, template.tcpSelections));
	assert.doesNotThrow(() => applyTemplateResourcesToWorkflow(workflow.id, template.resourceSelections));
	assert.deepEqual(listWorkflowTcpSelections(workflow.id), []);
	assert.deepEqual(listWorkflowResourceSelections(workflow.id), []);
});

test("POST /api/catalog/sync is 409 not_linked when the hub is not linked", async () => {
	deleteDeviceLink();
	const res = await fetch(`${baseUrl}/api/catalog/sync`, { method: "POST", headers: adminHeaders() });
	assert.equal(res.status, 409);
	assert.deepEqual(await res.json(), { error: "not_linked" });
});

test("POST /api/catalog/sync is 403 without a catalog sync permission", async () => {
	linkDevice(["client.read"]);
	const res = await fetch(`${baseUrl}/api/catalog/sync`, { method: "POST", headers: adminHeaders() });
	assert.equal(res.status, 403);
	const body = (await res.json()) as { error: string; permission?: string };
	assert.equal(body.error, "forbidden");
});

test("syncServerCatalog upserts, updates, skips local collisions and prunes", async () => {
	linkDevice(["client.templates.sync", "client.tcp-tools.sync", "client.rci.sync"]);
	insertLocalTcp("local-collision", "I was here first");

	const first = await syncServerCatalog({
		fetchImpl: catalogFetch(
			catalogResponse({
				tcp_tools: [
					{
						id: "cat-tcp-keep",
						name: "Keep me",
						data: { tags: ["a"], tools: [{ name: "echo", requestTemplate: "echo hi", tokens: { T: "1" } }] },
					},
					{
						id: "cat-tcp-drop",
						name: "Drop me",
						data: { tools: [{ name: "noop", requestTemplate: "noop" }] },
					},
					{
						id: "cat-tcp-revoke",
						name: "Revoke me",
						data: { tools: [{ name: "held", requestTemplate: "held" }] },
					},
					{ id: "local-collision", name: "From server", data: { tools: [] } },
				],
				resource_sets: [
					{
						id: "cat-rci-keep",
						name: "Docs",
						data: { tags: ["d"], resources: [{ name: "guide", content: "# hi" }] },
					},
				],
				templates: [
					{
						id: "cat-tpl-1",
						name: "From catalog",
						data: {
							tags: ["t"],
							steps: [{ description: "do it" }],
							tcpSelections: [{ tcpId: "cat-tcp-keep" }, { tcpId: "missing-on-hub" }],
							resourceSelections: [{ resourceSetId: "cat-rci-keep" }, { resourceSetId: "missing-rci" }],
						},
					},
				],
			}),
		),
	});

	assert.equal(first.tcp_tools.added, 3);
	assert.equal(first.tcp_tools.skipped, 1);
	assert.equal(first.resource_sets.added, 1);
	assert.equal(first.templates.added, 1);
	assert.equal(getTcp("local-collision")?.origin, "local");
	assert.equal(getTcp("local-collision")?.name, "I was here first");
	assert.equal(getTcp("cat-tcp-keep")?.origin, "server");
	assert.equal(getTcp("cat-tcp-keep")?.syncSource, "catalog");
	assert.equal(getTcp("cat-tcp-keep")?.tools[0]?.tokens.T, "1");
	const { getTemplate } = await import("./db.ts");
	const pulled = getTemplate("cat-tpl-1");
	assert.equal(pulled?.origin, "server");
	assert.deepEqual(
		pulled?.tcpSelections.map((selection) => selection.tcpId),
		["cat-tcp-keep"],
	);
	assert.deepEqual(
		pulled?.resourceSelections.map((selection) => selection.resourceSetId),
		["cat-rci-keep"],
	);

	const wf = insertWorkflow({
		id: "wf-hold-tcp",
		name: "holds tcp",
		agentName: "agent-hold-tcp",
		hookUrl: "http://127.0.0.1:1/hook2",
		secret: "s",
		mdPath: path.join(tmpHome, "hold.md"),
	});
	setWorkflowTcpSelections(wf.id, [{ tcpId: "cat-tcp-revoke", toolNames: null }]);

	const second = await syncServerCatalog({
		fetchImpl: catalogFetch(
			catalogResponse({
				tcp_tools: [
					{
						id: "cat-tcp-keep",
						name: "Keep me v2",
						data: { tags: ["a", "b"], tools: [{ name: "echo", requestTemplate: "echo hi" }] },
					},
				],
				resource_sets: [
					{
						id: "cat-rci-keep",
						name: "Docs",
						data: { resources: [{ name: "guide", content: "# hi" }] },
					},
				],
				templates: [
					{
						id: "cat-tpl-1",
						name: "From catalog",
						data: { steps: [{ description: "do it" }], tcpSelections: [{ tcpId: "cat-tcp-keep" }] },
					},
				],
			}),
		),
	});

	assert.equal(second.tcp_tools.updated, 1);
	assert.equal(second.tcp_tools.removed, 1);
	assert.equal(second.tcp_tools.revoked, 1);
	assert.equal(getTcp("cat-tcp-keep")?.name, "Keep me v2");
	assert.equal(getTcp("cat-tcp-drop"), null);
	assert.equal(getTcp("cat-tcp-revoke")?.revoked, true);
	assert.equal(getTcp("cat-tcp-revoke")?.origin, "server");
	assert.equal(getResourceSet("cat-rci-keep")?.origin, "server");

	const status = getCatalogSyncStatus();
	assert.equal(typeof status.syncedAt, "string");
	assert.equal(status.tcp_tools?.updated, 1);
	assert.equal(status.tcp_tools?.revoked, 1);
});

test("GET /api/catalog/sync/status returns the last summary", async () => {
	const res = await fetch(`${baseUrl}/api/catalog/sync/status`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { syncedAt: string | null; tcp_tools: { revoked: number } | null };
	assert.equal(typeof body.syncedAt, "string");
	assert.equal(body.tcp_tools?.revoked, 1);
});

test("a 404 catalog endpoint is catalog_sync_unsupported", async () => {
	linkDevice(["client.tcp-tools.sync"]);
	await assert.rejects(() => syncServerCatalog({ fetchImpl: catalogFetch({ error: "not_found" }, 404) }), (err: unknown) => {
		assert.ok(err instanceof CatalogSyncError);
		assert.equal(err.code, "catalog_sync_unsupported");
		return true;
	});
});

test("POST /api/catalog/sync maps an old server 404 to 502 catalog_sync_unsupported", async () => {
	linkDevice(["client.templates.sync"]);
	setCatalogSyncFetchForTests(catalogFetch({ error: "not_found" }, 404));
	const res = await fetch(`${baseUrl}/api/catalog/sync`, { method: "POST", headers: adminHeaders() });
	assert.equal(res.status, 502);
	assert.deepEqual(await res.json(), { error: "catalog_sync_unsupported" });
	setCatalogSyncFetchForTests(null);
});

test("workflow-sourced copies keep the workflow source when catalog is pruned", async () => {
	linkDevice(["client.tcp-tools.sync"]);
	upsertServerTcp("both-sources", { name: "Both", tools: [] }, "workflow");
	upsertServerTcp("both-sources", { name: "Both", tools: [] }, "catalog");
	assert.equal(getTcp("both-sources")?.syncSource, "workflow,catalog");
	await syncServerCatalog({
		fetchImpl: catalogFetch(catalogResponse({ tcp_tools: [], resource_sets: [], templates: [] })),
	});
	assert.equal(getTcp("both-sources")?.syncSource, "workflow");
	assert.equal(getTcp("both-sources")?.revoked, false);
});

test("setWorkflowTcpSelections still rejects unknown TCP ids", () => {
	const workflow = insertWorkflow({
		id: "wf-strict-tcp",
		name: "strict",
		agentName: "agent-strict-tcp",
		hookUrl: "http://127.0.0.1:1/hook3",
		secret: "s",
		mdPath: path.join(tmpHome, "strict.md"),
	});
	assert.throws(() => setWorkflowTcpSelections(workflow.id, [{ tcpId: "still-missing" }]), /unknown_tcp/);
	insertTcp({ name: "unused local" });
});
