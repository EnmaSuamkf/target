/**
 * Catalog-sync storage: origin/sync_source/revoked on templates, TCP and RCI,
 * plus the HTTP 409/export rules for server-managed copies.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-catalog-sync-store-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const legacyDbFile = path.join(tmpHome, "target.db");
{
	fs.mkdirSync(path.dirname(legacyDbFile), { recursive: true });
	const legacy = new DatabaseSync(legacyDbFile);
	const now = new Date().toISOString();
	legacy.exec(`
		CREATE TABLE templates (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '',
			steps TEXT NOT NULL DEFAULT '[]',
			tcp_ids TEXT NOT NULL DEFAULT '[]',
			tcp_selections TEXT NOT NULL DEFAULT '[]',
			resource_selections TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE tcps (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '[]',
			tools TEXT NOT NULL DEFAULT '[]',
			origin TEXT NOT NULL DEFAULT 'local',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE resource_sets (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '[]',
			resources TEXT NOT NULL DEFAULT '[]',
			origin TEXT NOT NULL DEFAULT 'local',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);
	legacy
		.prepare("INSERT INTO templates (id, name, tags, steps, tcp_ids, tcp_selections, resource_selections, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run("legacy-tpl", "Legacy template", "[]", '[{"description":"old step"}]', "[]", "[]", "[]", now, now);
	legacy
		.prepare("INSERT INTO tcps (id, name, tags, tools, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run("legacy-tcp", "Legacy tcp", "[]", "[]", "local", now, now);
	legacy
		.prepare("INSERT INTO resource_sets (id, name, tags, resources, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run("legacy-rci", "Legacy rci", "[]", "[]", "local", now, now);
	legacy.close();
}

const {
	deleteTemplate,
	getTemplate,
	insertTemplate,
	open,
	TemplateStoreError,
	updateTemplate,
	upsertServerTemplate,
} = await import("./db.ts");
const { getTcp, insertTcp, listTcps, upsertServerTcp } = await import("./tcp-store.ts");
const { getResourceSet, listResourceSets, upsertServerResourceSet } = await import("./rci-store.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

function columnNames(table: string): string[] {
	return (open().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

const cfg = loadConfig();
const server = createServer(cfg, () => {});
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

test("migration adds origin, sync_source, synced_at and revoked on an existing DB", () => {
	const templateCols = columnNames("templates");
	assert.ok(templateCols.includes("origin"));
	assert.ok(templateCols.includes("sync_source"));
	assert.ok(templateCols.includes("synced_at"));
	assert.ok(templateCols.includes("revoked"));

	const legacy = getTemplate("legacy-tpl");
	assert.ok(legacy);
	assert.equal(legacy!.name, "Legacy template");
	assert.equal(legacy!.origin, "local");
	assert.equal(legacy!.syncSource, null);
	assert.equal(legacy!.syncedAt, null);
	assert.equal(legacy!.revoked, false);

	assert.equal(listTcps().find((tcp) => tcp.id === "legacy-tcp")?.origin, "local");
	assert.ok(columnNames("tcps").includes("sync_source"));
	assert.ok(columnNames("tcps").includes("synced_at"));
	assert.ok(columnNames("tcps").includes("revoked"));

	assert.equal(listResourceSets().find((set) => set.id === "legacy-rci")?.origin, "local");
	assert.ok(columnNames("resource_sets").includes("sync_source"));
	assert.ok(columnNames("resource_sets").includes("synced_at"));
	assert.ok(columnNames("resource_sets").includes("revoked"));
});

test("upsertServerTemplate keeps the server id, origin server, then overwrites", () => {
	const first = upsertServerTemplate("srv-tpl-keep", {
		name: "Server template",
		tags: ["sync"],
		steps: [{ description: "do it" }],
		tcpSelections: [{ tcpId: "tcp-a" }],
		resourceSelections: [{ resourceSetId: "rci-a" }],
	});
	assert.equal(first.id, "srv-tpl-keep");
	assert.equal(first.origin, "server");
	assert.equal(first.syncSource, "catalog");
	assert.equal(typeof first.syncedAt, "string");
	assert.equal(first.revoked, false);
	assert.deepEqual(first.tcpSelections.map((selection) => selection.tcpId), ["tcp-a"]);
	assert.equal(getTemplate("srv-tpl-keep")?.origin, "server");

	const second = upsertServerTemplate("srv-tpl-keep", {
		name: "Server template v2",
		tags: ["sync", "v2"],
		steps: [{ description: "do it again" }],
		tcpSelections: [{ tcpId: "tcp-b" }],
		resourceSelections: [],
	});
	assert.equal(second.id, "srv-tpl-keep");
	assert.equal(second.origin, "server");
	assert.equal(second.name, "Server template v2");
	assert.deepEqual(second.tags, ["sync", "v2"]);
	assert.equal(second.steps[0]?.description, "do it again");
	assert.deepEqual(second.tcpSelections.map((selection) => selection.tcpId), ["tcp-b"]);
	assert.equal(second.syncSource, "catalog");
});

test("updateTemplate/deleteTemplate throw server_managed unless allowServerManaged", () => {
	const template = upsertServerTemplate("srv-tpl-locked", { name: "Locked template", steps: [] });
	assert.throws(() => updateTemplate(template.id, { name: "Nope" }), (err: unknown) => {
		assert.ok(err instanceof TemplateStoreError);
		assert.equal(err.code, "server_managed");
		return true;
	});
	assert.throws(() => deleteTemplate(template.id), (err: unknown) => {
		assert.ok(err instanceof TemplateStoreError);
		assert.equal(err.code, "server_managed");
		return true;
	});
	assert.equal(getTemplate(template.id)?.name, "Locked template");

	const updated = updateTemplate(template.id, { name: "Allowed edit" }, { allowServerManaged: true });
	assert.equal(updated?.name, "Allowed edit");
	assert.equal(updated?.origin, "server");
	assert.equal(deleteTemplate(template.id, { allowServerManaged: true }), true);
	assert.equal(getTemplate(template.id), null);
});

test("sync_source merges workflow and catalog on TCP, RCI and templates", () => {
	const tcp = upsertServerTcp("srv-tcp-merge", { name: "Merge TCP", tools: [] }, "workflow");
	assert.equal(tcp.syncSource, "workflow");
	const tcpBoth = upsertServerTcp("srv-tcp-merge", { name: "Merge TCP", tools: [] }, "catalog");
	assert.equal(tcpBoth.syncSource, "workflow,catalog");
	const tcpAgain = upsertServerTcp("srv-tcp-merge", { name: "Merge TCP", tools: [] }, "workflow");
	assert.equal(tcpAgain.syncSource, "workflow,catalog");

	const set = upsertServerResourceSet("srv-rci-merge", { name: "Merge RCI", resources: [] }, "catalog");
	assert.equal(set.syncSource, "catalog");
	const setBoth = upsertServerResourceSet("srv-rci-merge", { name: "Merge RCI", resources: [] }, "workflow");
	assert.equal(setBoth.syncSource, "workflow,catalog");

	const template = upsertServerTemplate("srv-tpl-merge", { name: "Merge template" }, "catalog");
	assert.equal(template.syncSource, "catalog");
	const templateBoth = upsertServerTemplate("srv-tpl-merge", { name: "Merge template" }, "workflow");
	assert.equal(templateBoth.syncSource, "workflow,catalog");
});

test("HTTP API rejects edit/delete of server templates with server_managed", async () => {
	const template = upsertServerTemplate("srv-tpl-http", { name: "HTTP template", steps: [{ description: "step" }] });
	const patch = await fetch(`${baseUrl}/api/templates/${template.id}`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "Edited" }),
	});
	assert.equal(patch.status, 409);
	assert.deepEqual(await patch.json(), { error: "server_managed" });

	const put = await fetch(`${baseUrl}/api/templates/${template.id}`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "Edited" }),
	});
	assert.equal(put.status, 409);
	assert.deepEqual(await put.json(), { error: "server_managed" });

	const del = await fetch(`${baseUrl}/api/templates/${template.id}`, { method: "DELETE", headers: adminHeaders() });
	assert.equal(del.status, 409);
	assert.deepEqual(await del.json(), { error: "server_managed" });

	const listed = await fetch(`${baseUrl}/api/templates/${template.id}`, { headers: adminHeaders() });
	assert.equal(listed.status, 200);
	assert.equal(((await listed.json()) as { template: { origin: string; name: string } }).template.origin, "server");

	const all = await fetch(`${baseUrl}/api/templates`, { headers: adminHeaders() });
	assert.equal(all.status, 200);
	const body = (await all.json()) as { templates: { id: string; origin: string }[] };
	assert.equal(body.templates.find((item) => item.id === template.id)?.origin, "server");
});

test("template and TCP exports exclude origin=server rows", async () => {
	const localTemplate = insertTemplate({ name: "Local export template", steps: [{ description: "local" }] });
	const serverTemplate = upsertServerTemplate("srv-tpl-export", { name: "Server export template" });
	const localTcp = insertTcp({ name: "Local export tcp", tools: [] });
	const serverTcp = upsertServerTcp("srv-tcp-export", { name: "Server export tcp", tools: [] }, "catalog");

	const templatesExport = await fetch(`${baseUrl}/api/templates/export`, { headers: adminHeaders() });
	assert.equal(templatesExport.status, 200);
	const templatesBundle = (await templatesExport.json()) as { templates: { name: string }[] };
	const templateNames = templatesBundle.templates.map((item) => item.name);
	assert.ok(templateNames.includes(localTemplate.name));
	assert.equal(templateNames.includes(serverTemplate.name), false);

	const oneServerTemplate = await fetch(`${baseUrl}/api/templates/${serverTemplate.id}/export`, { headers: adminHeaders() });
	assert.equal(oneServerTemplate.status, 409);
	assert.deepEqual(await oneServerTemplate.json(), { error: "server_managed" });

	const oneLocalTemplate = await fetch(`${baseUrl}/api/templates/${localTemplate.id}/export`, { headers: adminHeaders() });
	assert.equal(oneLocalTemplate.status, 200);

	const tcpsExport = await fetch(`${baseUrl}/api/tcps/export`, { headers: adminHeaders() });
	assert.equal(tcpsExport.status, 200);
	const tcpBundle = (await tcpsExport.json()) as { tcps: { name: string }[] };
	const tcpNames = tcpBundle.tcps.map((item) => item.name);
	assert.ok(tcpNames.includes(localTcp.name));
	assert.equal(tcpNames.includes(serverTcp.name), false);

	const oneServerTcp = await fetch(`${baseUrl}/api/tcps/${serverTcp.id}/export`, { headers: adminHeaders() });
	assert.equal(oneServerTcp.status, 409);
	assert.deepEqual(await oneServerTcp.json(), { error: "server_managed" });

	assert.equal(getTcp(serverTcp.id)?.origin, "server");
	assert.equal(getResourceSet("legacy-rci")?.origin, "local");
});
