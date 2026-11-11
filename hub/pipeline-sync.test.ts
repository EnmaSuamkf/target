/**
 * Server-catalog sync of pipelines (docs/pipelines.md, "Catalog sync"): the
 * capability the hub advertises, the domain's upsert/prune rules, trust across a
 * sync, template command steps whose pipeline is missing, read-only server
 * copies, and a revoked pipeline failing its dispatch.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { FetchLike } from "./sync.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-pipeline-sync-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const ORIGIN = "https://catalog.example";

const { loadConfig } = await import("./config.ts");
const { getTemplate, getWorkflow, insertTemplate, open, saveReportSettings } = await import("./db.ts");
const { getCatalogSyncStatus, syncServerCatalog } = await import("./catalog-sync.ts");
const { activateDeviceCredential, beginDeviceLink, deleteDeviceLink } = await import("./device-link.ts");
const { recordOwnerSnapshot } = await import("./owner-permissions.ts");
const { syncClientCapabilities } = await import("./sync.ts");
const {
	approvePipeline,
	deletePipeline,
	getPipeline,
	isTrusted,
	PipelineStoreError,
	updatePipeline,
	upsertServerPipeline,
} = await import("./pipeline-store.ts");
const { addStep, createWorkflow, startWorkflow } = await import("./workflow.ts");
const { sourceHash } = await import("./pipeline-yaml.ts");

const cfg = loadConfig();
const silent = () => {};

// The HTTP routes are exercised for real: the read-only rule of a server copy is
// answered by the route, not only by the store.
const { createServer } = await import("./server.ts");
const { createSession } = await import("./account.ts");
const httpServer = createServer(cfg, () => {});
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const httpAddress = httpServer.address();
if (!httpAddress || typeof httpAddress === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${httpAddress.port}`;
test.after(() => httpServer.close());
saveReportSettings({ enabled: false, url: "", token: "", intervalMs: 60_000, includeConversations: "off" });

/** A minimal valid pipeline, named `name`, running `run`. */
function yaml(name: string, run = "echo ok"): string {
	return `name: ${name}\nsteps:\n  - run: ${run}\n`;
}

function owner(permissions: string[]): unknown {
	return { id: "owner_pipeline_sync", permissions, granted: { groups: [] } };
}

function linkDevice(permissions: string[]): void {
	deleteDeviceLink();
	beginDeviceLink({ origin: ORIGIN, deviceName: "pipeline-sync" });
	activateDeviceCredential({
		deviceId: "dev_pipeline_sync",
		deviceSecret: "secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
	recordOwnerSnapshot(owner(permissions), "dev_pipeline_sync", ORIGIN);
}

/** A catalog response. `pipelines` is omitted from `allowed` unless `withPipelines` is set. */
function catalog(partial: Record<string, unknown> = {}, withPipelines = true): Record<string, unknown> {
	return {
		contract_version: "catalog-sync/v1",
		server_time: new Date().toISOString(),
		owner_id: "owner_pipeline_sync",
		allowed: {
			templates: true,
			tcp_tools: false,
			resource_sets: false,
			...(withPipelines ? { pipelines: true } : {}),
		},
		templates: [],
		tcp_tools: [],
		resource_sets: [],
		...(withPipelines ? { pipelines: [] } : {}),
		...partial,
	};
}

function fetchWith(body: unknown): FetchLike {
	return async (url) => {
		if (new URL(url).pathname === "/api/sync/catalog") {
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		}
		return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
	};
}

/** One pipeline item as the server sends it: the YAML text is the pipeline. */
function pipelineItem(id: string, source: string, tags: string[] = []): Record<string, unknown> {
	return {
		id,
		name: source.match(/^name: (.*)$/m)?.[1] ?? id,
		updatedAt: new Date().toISOString(),
		data: { tags, source, sourceHash: sourceHash(source) },
	};
}

function pipelineRow(id: string): Record<string, unknown> | undefined {
	return open().prepare("SELECT * FROM pipelines WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

/** Inserts a local pipeline with a fixed id, the way an operator's own row would look. */
function insertLocalWithId(id: string, source: string): void {
	const now = new Date().toISOString();
	open()
		.prepare(
			`INSERT INTO pipelines (id, name, tags, source, source_hash, trusted_hash, origin, sync_source, synced_at, revoked, created_at, updated_at)
			 VALUES (?, 'local name', '[]', ?, ?, NULL, 'local', NULL, NULL, 0, ?, ?)`,
		)
		.run(id, source, sourceHash(source), now, now);
}

test("the hub advertises the pipelines resource capability", () => {
	const caps = syncClientCapabilities();
	assert.deepEqual(caps.resources, { version: 2, tcp_tools: true, resource_sets: true, pipelines: true });
});

test("a response without the pipelines domain changes nothing", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	const source = yaml("kept-old-server");
	upsertServerPipeline("pl-old-server", { name: "kept", source, serverHash: undefined }, "catalog");
	const before = pipelineRow("pl-old-server");

	// An older server: no `pipelines` in `allowed`, and a list that must be ignored.
	const body = catalog({ pipelines: [] }, false);
	body.pipelines = [pipelineItem("pl-old-server", yaml("changed-by-old-server"))];
	const result = await syncServerCatalog({ fetchImpl: fetchWith(body) });

	assert.deepEqual(pipelineRow("pl-old-server"), before, "the row is untouched");
	assert.equal(result.pipelines.added + result.pipelines.updated + result.pipelines.removed + result.pipelines.revoked, 0);
});

test("pipelines are upserted before templates, so a command step resolves in the same sync", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	const source = yaml("ordered");
	const body = catalog({
		pipelines: [pipelineItem("pl-ordered", source)],
		templates: [
			{
				id: "tpl-ordered",
				name: "ordered",
				updatedAt: new Date().toISOString(),
				data: {
					tags: [],
					steps: [
						{ description: "agent part" },
						{ kind: "command", pipelineId: "pl-ordered", pipelineInputs: {}, description: "run it" },
					],
				},
			},
		],
	});
	await syncServerCatalog({ fetchImpl: fetchWith(body) });

	assert.equal(getPipeline("pl-ordered")?.origin, "server");
	const template = getTemplate("tpl-ordered");
	assert.ok(template, "template synced");
	assert.deepEqual(
		template.steps.map((step) => step.kind),
		["task", "command"],
		"the command step survived because its pipeline arrived first",
	);
});

test("a local pipeline with the same id is never overwritten", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	const localSource = yaml("mine");
	insertLocalWithId("pl-local-collision", localSource);

	const result = await syncServerCatalog({
		fetchImpl: fetchWith(catalog({ pipelines: [pipelineItem("pl-local-collision", yaml("theirs", "echo other"))] })),
	});

	const row = pipelineRow("pl-local-collision");
	assert.equal(row?.origin, "local");
	assert.equal(row?.source, localSource);
	assert.equal(result.pipelines.skipped, 1);
});

test("a changed source drops trust, and an unchanged source keeps the approval", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	const sourceA = yaml("trusted-one", "echo a");
	await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [pipelineItem("pl-trust", sourceA)] })) });
	const arrived = getPipeline("pl-trust")!;
	assert.equal(isTrusted(arrived), false, "a synced pipeline arrives untrusted");

	approvePipeline("pl-trust", arrived.sourceHash);
	assert.equal(isTrusted(getPipeline("pl-trust")!), true);

	await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [pipelineItem("pl-trust", sourceA)] })) });
	assert.equal(isTrusted(getPipeline("pl-trust")!), true, "unchanged text keeps the approval");

	const sourceB = yaml("trusted-one", "echo b");
	await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [pipelineItem("pl-trust", sourceB)] })) });
	const changed = getPipeline("pl-trust")!;
	assert.equal(changed.source, sourceB);
	assert.equal(isTrusted(changed), false, "changed text is untrusted");
	assert.notEqual(changed.trustedHash, changed.sourceHash);
});

test("the hub recomputes the hash and does not trust the server's", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	const source = yaml("hash-check");
	const item = pipelineItem("pl-hash", source);
	(item.data as Record<string, unknown>).sourceHash = "0".repeat(64);
	await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [item] })) });
	assert.equal(getPipeline("pl-hash")?.sourceHash, sourceHash(source));
});

test("an ungranted pipeline is marked revoked while referenced, and deleted when not", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	const keep = yaml("granted-still");
	const referenced = yaml("referenced-gone");
	const unreferenced = yaml("unreferenced-gone");
	await syncServerCatalog({
		fetchImpl: fetchWith(
			catalog({
				pipelines: [
					pipelineItem("pl-keep", keep),
					pipelineItem("pl-referenced", referenced),
					pipelineItem("pl-unreferenced", unreferenced),
				],
			}),
		),
	});
	insertTemplate({
		name: "uses the referenced pipeline",
		steps: [{ kind: "command", pipelineId: "pl-referenced", pipelineInputs: {}, description: "x" }],
	});

	const result = await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [pipelineItem("pl-keep", keep)] })) });

	assert.equal(getPipeline("pl-keep")?.revoked, false);
	assert.equal(getPipeline("pl-referenced")?.revoked, true, "referenced: revoked, kept");
	assert.equal(getPipeline("pl-unreferenced"), null, "unreferenced: deleted");
	assert.equal(result.pipelines.revoked, 1);
	assert.equal(result.pipelines.removed, 1);
});

test("a template command step whose pipeline did not arrive is dropped from the copy", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	const body = catalog({
		pipelines: [pipelineItem("pl-present", yaml("present"))],
		templates: [
			{
				id: "tpl-missing-pipeline",
				name: "partly missing",
				updatedAt: new Date().toISOString(),
				data: {
					tags: [],
					steps: [
						{ description: "keep the agent step" },
						{ kind: "command", pipelineId: "pl-not-granted", pipelineInputs: {}, description: "drop me" },
						{ kind: "command", pipelineId: "pl-present", pipelineInputs: {}, description: "keep me" },
					],
				},
			},
		],
	});
	await syncServerCatalog({ fetchImpl: fetchWith(body) });

	const steps = getTemplate("tpl-missing-pipeline")!.steps;
	assert.deepEqual(
		steps.map((step) => step.description),
		["keep the agent step", "keep me"],
	);
});

test("a revoked pipeline fails its dispatch with 'pipeline revoked'", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	const source = yaml("about-to-be-revoked", "echo never");
	await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [pipelineItem("pl-revoke-run", source)] })) });
	approvePipeline("pl-revoke-run", sourceHashOf("pl-revoke-run"));

	const workdir = fs.mkdtempSync(path.join(tmpHome, "wd-"));
	const wf = createWorkflow("revoked dispatch", { workdir });
	const step = addStep(wf.id, "", { kind: "command", pipelineId: "pl-revoke-run", pipelineInputs: {} });

	// The workflow's step still references the pipeline, so the sync revokes rather than deletes it.
	await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [] })) });
	assert.equal(getPipeline("pl-revoke-run")?.revoked, true);

	await startWorkflow(wf.id, cfg, silent, [step.id]);
	const started = Date.now();
	while (getWorkflow(wf.id)?.status !== "failed") {
		if (Date.now() - started > 15_000) throw new Error("timed out waiting for the revoked step to fail");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const row = open().prepare("SELECT error FROM steps WHERE id = ?").get(step.id) as { error: string };
	assert.equal(row.error, "pipeline revoked");
});

test("a server copy is read-only except for approval", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	const source = yaml("read-only-copy");
	await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [pipelineItem("pl-readonly", source)] })) });

	assert.throws(
		() => updatePipeline("pl-readonly", { tags: ["edited"] }),
		(err: unknown) => err instanceof PipelineStoreError && err.code === "server_managed",
	);
	assert.throws(
		() => deletePipeline("pl-readonly"),
		(err: unknown) => err instanceof PipelineStoreError && err.code === "server_managed",
	);
	const approved = approvePipeline("pl-readonly", sourceHashOf("pl-readonly"));
	assert.equal(approved && isTrusted(approved), true, "approval is still allowed");
});

function sourceHashOf(id: string): string {
	return getPipeline(id)!.sourceHash;
}

test("the sync domain is reported in the status", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync"]);
	await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [pipelineItem("pl-status", yaml("status"))] })) });
	assert.ok(getCatalogSyncStatus().pipelines, "pipelines result is stored");
});

test("server-origin pipelines are read-only over the HTTP API, and approve still works", async () => {
	linkDevice(["client.templates.sync", "client.pipelines.sync", "client.pipelines.edit", "client.pipelines.delete", "client.workflows.manage"]);
	const source = yaml("http-readonly");
	await syncServerCatalog({ fetchImpl: fetchWith(catalog({ pipelines: [pipelineItem("pl-http-ro", source)] })) });
	const before = getPipeline("pl-http-ro")!;

	const admin = { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
	const patch = await fetch(`${baseUrl}/api/pipelines/pl-http-ro`, {
		method: "PATCH",
		headers: admin,
		body: JSON.stringify({ tags: ["edited"] }),
	});
	assert.equal(patch.status, 409);
	assert.equal(((await patch.json()) as { error: string }).error, "server_managed");

	const del = await fetch(`${baseUrl}/api/pipelines/pl-http-ro`, { method: "DELETE", headers: admin });
	assert.equal(del.status, 409);
	assert.equal(((await del.json()) as { error: string }).error, "server_managed");
	assert.ok(getPipeline("pl-http-ro"), "the copy still exists");

	const session = createSession();
	const approve = await fetch(`${baseUrl}/api/pipelines/pl-http-ro/approve`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: `target_session=${session.token}` },
		body: JSON.stringify({ sourceHash: before.sourceHash }),
	});
	assert.equal(approve.status, 200, await approve.clone().text());
	assert.equal(isTrusted(getPipeline("pl-http-ro")!), true, "approval took effect");
});

test("pipeline routes are gated by the client.pipelines.* IDs; approve stays on client.workflows.manage", async () => {
	const admin = { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
	const sessionCookie = `target_session=${createSession().token}`;

	// Creating needs client.pipelines.create. A manager without it is refused.
	linkDevice(["client.workflows.manage"]);
	const refusedCreate = await fetch(`${baseUrl}/api/pipelines`, { method: "POST", headers: admin, body: JSON.stringify({ source: yaml("gate-create") }) });
	assert.equal(refusedCreate.status, 403, "create without client.pipelines.create is refused");

	linkDevice(["client.pipelines.create"]);
	const created = await fetch(`${baseUrl}/api/pipelines`, { method: "POST", headers: admin, body: JSON.stringify({ source: yaml("gate-one") }) });
	assert.equal(created.status, 200, await created.clone().text());
	const id = ((await created.json()) as { pipeline: { id: string } }).pipeline.id;
	const sourceHashOfLocal = getPipeline(id)!.sourceHash;

	// Editing and deleting each need their own ID; create alone does neither.
	const patch = await fetch(`${baseUrl}/api/pipelines/${id}`, { method: "PATCH", headers: admin, body: JSON.stringify({ tags: ["x"] }) });
	assert.equal(patch.status, 403, "edit needs client.pipelines.edit");
	const del = await fetch(`${baseUrl}/api/pipelines/${id}`, { method: "DELETE", headers: admin });
	assert.equal(del.status, 403, "delete needs client.pipelines.delete");

	// Export needs client.pipelines.export, not create.
	const exported = await fetch(`${baseUrl}/api/pipelines/export`, { headers: admin });
	assert.equal(exported.status, 403, "export needs client.pipelines.export");

	// Approval is a trust decision, so it keeps client.workflows.manage even for a
	// holder of every client.pipelines.* ID.
	linkDevice(["client.pipelines.create", "client.pipelines.edit", "client.pipelines.delete", "client.pipelines.export"]);
	const approveWithoutManage = await fetch(`${baseUrl}/api/pipelines/${id}/approve`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: sessionCookie },
		body: JSON.stringify({ sourceHash: sourceHashOfLocal }),
	});
	assert.equal(approveWithoutManage.status, 403, "approve needs client.workflows.manage");

	// With the matching ID, an edit goes through.
	linkDevice(["client.pipelines.edit"]);
	const okPatch = await fetch(`${baseUrl}/api/pipelines/${id}`, { method: "PATCH", headers: admin, body: JSON.stringify({ tags: ["edited"] }) });
	assert.equal(okPatch.status, 200, await okPatch.clone().text());
});
