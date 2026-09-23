/**
 * Server-managed TCP / RCI copies: upsert-by-id, read-only local API, sync
 * handlers, step.add notes, and resources v2 capability.
 */
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, beforeEach } from "node:test";
import type { FetchLike, SyncCommand } from "./sync.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-server-managed-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".awb");

const {
	SYNC_COMMAND_TYPES,
	executeSyncCommand,
	resetSyncExecutorState,
	resolveLocalWorkflowId,
	runSyncTick,
	syncClientCapabilities,
} = await import("./sync.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { insertWorkflow, listStepNotes, listSteps } = await import("./db.ts");
const {
	deleteTcp,
	getTcp,
	listWorkflowTcpSelections,
	setWorkflowTcpSelections,
	TcpStoreError,
	updateTcp,
	upsertServerTcp,
} = await import("./tcp-store.ts");
const {
	deleteResourceSet,
	getResourceSet,
	listWorkflowResourceSelections,
	ResourceSetStoreError,
	updateResourceSet,
	upsertServerResourceSet,
} = await import("./rci-store.ts");

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

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

function command(
	remoteId: string,
	id: string,
	type: string,
	payload: Record<string, unknown> = {},
): SyncCommand {
	return {
		id,
		type,
		remote_id: remoteId,
		sequence: 1,
		payload,
		status: "delivered",
	};
}

const SERVER_TCP_ID = "srv-tcp-keep-id";
const SERVER_RCI_ID = "srv-rci-keep-id";

test("tcp-tool upsert keeps the server id and origin server, then overwrites", () => {
	const first = upsertServerTcp(SERVER_TCP_ID, {
		name: "Git pack",
		tags: ["vcs"],
		tools: [{ name: "status", description: "st", requestTemplate: "git status", inputs: [], tokens: {} }],
	});
	assert.equal(first.id, SERVER_TCP_ID);
	assert.equal(first.origin, "server");
	assert.equal(getTcp(SERVER_TCP_ID)?.origin, "server");
	assert.equal(getTcp(SERVER_TCP_ID)?.tools[0]?.name, "status");

	const second = upsertServerTcp(SERVER_TCP_ID, {
		name: "Git pack v2",
		tags: ["vcs", "git"],
		tools: [{ name: "diff", description: "df", requestTemplate: "git diff", inputs: [], tokens: {} }],
	});
	assert.equal(second.id, SERVER_TCP_ID);
	assert.equal(second.origin, "server");
	assert.equal(second.name, "Git pack v2");
	assert.deepEqual(second.tags, ["vcs", "git"]);
	assert.equal(second.tools[0]?.name, "diff");
	assert.equal(getTcp(SERVER_TCP_ID)?.name, "Git pack v2");
});

test("resource-set upsert keeps the server id and origin server, then overwrites", () => {
	const first = upsertServerResourceSet(SERVER_RCI_ID, {
		name: "Docs",
		tags: ["docs"],
		resources: [{ name: "guide", description: "intro", content: "# Hello", files: [] }],
	});
	assert.equal(first.id, SERVER_RCI_ID);
	assert.equal(first.origin, "server");
	assert.equal(getResourceSet(SERVER_RCI_ID)?.resources[0]?.name, "guide");

	const second = upsertServerResourceSet(SERVER_RCI_ID, {
		name: "Docs v2",
		resources: [{ name: "runbook", description: "ops", content: "# Ops", files: [] }],
	});
	assert.equal(second.id, SERVER_RCI_ID);
	assert.equal(second.origin, "server");
	assert.equal(second.name, "Docs v2");
	assert.equal(second.resources[0]?.name, "runbook");
});

test("local update/delete of server-managed catalog items is rejected", () => {
	const tcp = upsertServerTcp("srv-tcp-locked", { name: "Locked TCP", tools: [] });
	assert.throws(() => updateTcp(tcp.id, { name: "Nope" }), (err: unknown) => {
		assert.ok(err instanceof TcpStoreError);
		assert.equal(err.code, "server_managed");
		return true;
	});
	assert.throws(() => deleteTcp(tcp.id), (err: unknown) => {
		assert.ok(err instanceof TcpStoreError);
		assert.equal(err.code, "server_managed");
		return true;
	});
	assert.equal(getTcp(tcp.id)?.name, "Locked TCP");

	const set = upsertServerResourceSet("srv-rci-locked", { name: "Locked RCI", resources: [] });
	assert.throws(() => updateResourceSet(set.id, { name: "Nope" }), (err: unknown) => {
		assert.ok(err instanceof ResourceSetStoreError);
		assert.equal(err.code, "server_managed");
		return true;
	});
	assert.throws(() => deleteResourceSet(set.id), (err: unknown) => {
		assert.ok(err instanceof ResourceSetStoreError);
		assert.equal(err.code, "server_managed");
		return true;
	});
	assert.equal(getResourceSet(set.id)?.name, "Locked RCI");
});

test("HTTP API rejects local PATCH/DELETE of server-managed items with server_managed", async () => {
	const tcp = upsertServerTcp("srv-tcp-http", { name: "HTTP TCP", tools: [] });
	const patchTcp = await fetch(`${baseUrl}/api/tcps/${tcp.id}`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "Edited" }),
	});
	assert.equal(patchTcp.status, 409);
	assert.deepEqual(await patchTcp.json(), { error: "server_managed" });
	const delTcp = await fetch(`${baseUrl}/api/tcps/${tcp.id}`, { method: "DELETE", headers: adminHeaders() });
	assert.equal(delTcp.status, 409);
	assert.deepEqual(await delTcp.json(), { error: "server_managed" });
	const listedTcp = await fetch(`${baseUrl}/api/tcps/${tcp.id}`, { headers: adminHeaders() });
	assert.equal(listedTcp.status, 200);
	assert.equal(((await listedTcp.json()) as { tcp: { origin: string } }).tcp.origin, "server");

	const set = upsertServerResourceSet("srv-rci-http", { name: "HTTP RCI", resources: [] });
	const patchRci = await fetch(`${baseUrl}/api/resourcesets/${set.id}`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "Edited" }),
	});
	assert.equal(patchRci.status, 409);
	assert.deepEqual(await patchRci.json(), { error: "server_managed" });
	const delRci = await fetch(`${baseUrl}/api/resourcesets/${set.id}`, { method: "DELETE", headers: adminHeaders() });
	assert.equal(delRci.status, 409);
	assert.deepEqual(await delRci.json(), { error: "server_managed" });
	const listedRci = await fetch(`${baseUrl}/api/resourcesets/${set.id}`, { headers: adminHeaders() });
	assert.equal(listedRci.status, 200);
	assert.equal(((await listedRci.json()) as { resourceSet: { origin: string } }).resourceSet.origin, "server");
});

test("sync tcp-tool/resource-set upsert and delete apply and keep the server id", async () => {
	const remoteId = "resources:client:tcp_tools";
	await executeSyncCommand(
		command(remoteId, "cmd_tcp_up", "tcp-tool.upsert", {
			resource: {
				id: "sync-tcp-1",
				name: "Synced TCP",
				data: {
					tags: ["sync"],
					tools: [{ name: "ping", description: "p", requestTemplate: "echo ping", inputs: [], tokens: {} }],
				},
			},
		}),
		cfg,
	);
	const tcp = getTcp("sync-tcp-1");
	assert.ok(tcp);
	assert.equal(tcp!.origin, "server");
	assert.equal(tcp!.name, "Synced TCP");
	assert.equal(tcp!.tools[0]?.name, "ping");

	await executeSyncCommand(command(remoteId, "cmd_tcp_del", "tcp-tool.delete", { resource_id: "sync-tcp-1" }), cfg);
	assert.equal(getTcp("sync-tcp-1"), null);

	await executeSyncCommand(
		command("resources:client:resource_sets", "cmd_rci_up", "resource-set.upsert", {
			resource: {
				id: "sync-rci-1",
				name: "Synced RCI",
				data: { tags: ["sync"], resources: [{ name: "note", description: "", content: "# Note", files: [] }] },
			},
		}),
		cfg,
	);
	const set = getResourceSet("sync-rci-1");
	assert.ok(set);
	assert.equal(set!.origin, "server");
	assert.equal(set!.resources[0]?.name, "note");

	await executeSyncCommand(
		command("resources:client:resource_sets", "cmd_rci_del", "resource-set.delete", { resource_id: "sync-rci-1" }),
		cfg,
	);
	assert.equal(getResourceSet("sync-rci-1"), null);
});

test("workflow.set_selection succeeds after a server upsert", async () => {
	const remoteId = "rwf_sel_1";
	await executeSyncCommand(command(remoteId, "cmd_wf", "workflow.create", { name: "Select after upsert" }), cfg);
	const localId = resolveLocalWorkflowId(remoteId)!;

	await executeSyncCommand(
		command(remoteId, "cmd_up_tcp", "tcp-tool.upsert", {
			resource: {
				id: "sel-tcp",
				name: "Selectable TCP",
				data: { tools: [{ name: "t", description: "", requestTemplate: "echo t", inputs: [], tokens: {} }] },
			},
		}),
		cfg,
	);
	await executeSyncCommand(
		command(remoteId, "cmd_up_rci", "resource-set.upsert", {
			resource: {
				id: "sel-rci",
				name: "Selectable RCI",
				data: { resources: [{ name: "doc", description: "", content: "# D", files: [] }] },
			},
		}),
		cfg,
	);

	await executeSyncCommand(
		command(remoteId, "cmd_sel", "workflow.set_selection", {
			tcp_selections: [{ tcpId: "sel-tcp", toolNames: null }],
			resource_selections: [{ resourceSetId: "sel-rci", resourceNames: null }],
		}),
		cfg,
	);

	assert.deepEqual(listWorkflowTcpSelections(localId), [{ tcpId: "sel-tcp", toolNames: null }]);
	assert.deepEqual(listWorkflowResourceSelections(localId), [{ resourceSetId: "sel-rci", resourceNames: null }]);
});

test("step.add with notes copies them onto the new step", async () => {
	const remoteId = "rwf_notes_1";
	await executeSyncCommand(command(remoteId, "cmd_wf_notes", "workflow.create", { name: "Notes" }), cfg);
	await executeSyncCommand(
		command(remoteId, "cmd_add_notes", "step.add", {
			step_key: "s1",
			description: "Do work",
			notes: [{ id: "n1", content: "from server template", theme: "warning" }],
		}),
		cfg,
	);
	const localId = resolveLocalWorkflowId(remoteId)!;
	const step = listSteps(localId).find((s) => s.kind === "task");
	assert.ok(step);
	const notes = listStepNotes(step!.id);
	assert.equal(notes.length, 1);
	assert.equal(notes[0]!.content, "from server template");
	assert.equal(notes[0]!.theme, "warning");
});

test("capabilities include resources v2 and resource command types", () => {
	const caps = syncClientCapabilities();
	assert.deepEqual(caps.resources, { version: 2, tcp_tools: true, resource_sets: true });
	assert.ok(SYNC_COMMAND_TYPES.includes("tcp-tool.upsert"));
	assert.ok(SYNC_COMMAND_TYPES.includes("tcp-tool.delete"));
	assert.ok(SYNC_COMMAND_TYPES.includes("resource-set.upsert"));
	assert.ok(SYNC_COMMAND_TYPES.includes("resource-set.delete"));
	assert.ok(caps.commands.includes("tcp-tool.upsert"));
	assert.ok(caps.commands.includes("resource-set.upsert"));
});

test("register and heartbeat advertise resources v2", async () => {
	const MOCK_BASE = "http://127.0.0.1:8901";
	const captured: { register: Record<string, unknown> | null } = { register: null };
	const heartbeats: Array<Record<string, unknown>> = [];
	const token = `sync_${crypto.randomBytes(8).toString("hex")}`;
	const fetchImpl: FetchLike = async (url, init) => {
		const u = new URL(url);
		const method = init?.method ?? "GET";
		if (method === "POST" && u.pathname === "/api/sync/register") {
			captured.register = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return new Response(JSON.stringify({ client_id: "cli-caps", client_token: token }), {
				status: 201,
				headers: { "content-type": "application/json" },
			});
		}
		if (method === "POST" && u.pathname === "/api/sync/heartbeat") {
			heartbeats.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (method === "GET" && u.pathname === "/api/sync/commands") {
			return new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (method === "POST" && u.pathname === "/api/sync/events") {
			return new Response(JSON.stringify({ accepted: [], rejected: [], duplicates: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
	};

	await runSyncTick({
		hubConfig: cfg,
		fetchImpl,
		config: { enabled: true, url: MOCK_BASE, token: "", intervalMs: 10_000 },
	});

	const registerCaps = (captured.register?.capabilities ?? {}) as {
		resources?: unknown;
		commands?: string[];
	};
	assert.deepEqual(registerCaps.resources, { version: 2, tcp_tools: true, resource_sets: true });
	const commands = registerCaps.commands ?? [];
	assert.ok(commands.includes("tcp-tool.upsert"));
	assert.ok(heartbeats.length >= 1);
	assert.deepEqual((heartbeats[0]?.capabilities as { resources?: unknown }).resources, {
		version: 2,
		tcp_tools: true,
		resource_sets: true,
	});
});

test("server-managed TCP remains selectable on a local workflow", () => {
	const tcp = upsertServerTcp("srv-tcp-attach", {
		name: "Attach me",
		tools: [{ name: "t", description: "", requestTemplate: "echo t", inputs: [], tokens: {} }],
	});
	const wf = insertWorkflow({
		id: crypto.randomUUID(),
		name: "attach-wf",
		agentName: "a",
		hookUrl: "http://x/h",
		secret: "s",
		mdPath: path.join(tmpHome, "attach.md"),
	});
	const selections = setWorkflowTcpSelections(wf.id, [{ tcpId: tcp.id, toolNames: null }]);
	assert.deepEqual(selections, [{ tcpId: tcp.id, toolNames: null }]);
});
