/**
 * Integration tests for the remote-sync agent against an in-process mock server
 * (no target-server dependency — exercises register, poll, apply, ack, events).
 */
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, beforeEach } from "node:test";
import type { FetchLike, SyncCommand } from "./sync.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-mock-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".awb");

const MOCK_BASE = "http://127.0.0.1:8900";
process.env.TARGET_SYNC_URL = MOCK_BASE;
process.env.TARGET_SYNC_ENABLED = "true";
delete process.env.TARGET_SYNC_TOKEN;

interface MockSyncState {
	clientId: string | null;
	clientToken: string | null;
	commands: SyncCommand[];
	acks: Array<{ commandId: string; body: unknown }>;
	eventBatches: unknown[];
	heartbeats: unknown[];
	/** `server_capabilities` on the register response (omitted when undefined, like an older server). */
	registerCapabilities?: unknown;
	/** `server_capabilities` on heartbeat responses (omitted when undefined). */
	heartbeatCapabilities?: unknown;
	/** Answer heartbeats with 503 (a failed heartbeat). */
	failHeartbeat?: boolean;
}

function createMockSyncServer(): { fetchImpl: FetchLike; state: MockSyncState; enqueue(cmd: SyncCommand): void } {
	const state: MockSyncState = {
		clientId: null,
		clientToken: null,
		commands: [],
		acks: [],
		eventBatches: [],
		heartbeats: [],
	};

	const fetchImpl: FetchLike = async (url, init) => {
		const u = new URL(url);
		const method = init?.method ?? "GET";
		const headers = init?.headers as Record<string, string> | undefined;
		const auth = headers?.authorization ?? headers?.Authorization ?? "";

		if (method === "POST" && u.pathname === "/api/sync/register") {
			state.clientId = crypto.randomUUID();
			state.clientToken = `sync_${crypto.randomBytes(16).toString("hex")}`;
			return new Response(
				JSON.stringify({
					client_id: state.clientId,
					client_token: state.clientToken,
					created_at: new Date().toISOString(),
					...(state.registerCapabilities !== undefined ? { server_capabilities: state.registerCapabilities } : {}),
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}

		if (!state.clientToken || !auth.includes(state.clientToken)) {
			return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
		}

		if (method === "POST" && u.pathname === "/api/sync/heartbeat") {
			state.heartbeats.push(JSON.parse(String(init?.body ?? "{}")));
			if (state.failHeartbeat) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
			const hb = {
				ok: true,
				server_time: new Date().toISOString(),
				...(state.heartbeatCapabilities !== undefined ? { server_capabilities: state.heartbeatCapabilities } : {}),
			};
			return new Response(JSON.stringify(hb), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		if (method === "GET" && u.pathname === "/api/sync/commands") {
			const batch = state.commands.splice(0, state.commands.length);
			return new Response(JSON.stringify({ commands: batch }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		const ackMatch = u.pathname.match(/^\/api\/sync\/commands\/([^/]+)\/ack$/);
		if (method === "POST" && ackMatch) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			state.acks.push({ commandId: ackMatch[1]!, body });
			return new Response(
				JSON.stringify({ command_id: ackMatch[1], status: "acked", already_recorded: false }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		if (method === "POST" && u.pathname === "/api/sync/events") {
			const body = JSON.parse(String(init?.body ?? "{}"));
			state.eventBatches.push(body);
			const events = (body.events ?? []) as Array<{ id: string }>;
			return new Response(
				JSON.stringify({ accepted: events.map((e) => e.id), rejected: [], duplicates: [] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
	};

	return {
		fetchImpl,
		state,
		enqueue(cmd: SyncCommand) {
			state.commands.push(cmd);
		},
	};
}

const { runSyncTick, resetSyncExecutorState } = await import("./sync.ts");
const { loadConfig } = await import("./config.ts");
const { getWorkflowByRemoteId, getSyncCredentials } = await import("./db.ts");

beforeEach(() => {
	resetSyncExecutorState();
});

test("mock server: register → poll → apply workflow.create → ack → push events", async () => {
	const mock = createMockSyncServer();
	const hubCfg = loadConfig();

	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: { enabled: true, url: MOCK_BASE, token: "", intervalMs: 10_000 } });

	const { clientId, token } = getSyncCredentials();
	assert.ok(clientId);
	assert.ok(token?.startsWith("sync_"));
	assert.equal(mock.state.heartbeats.length, 1);

	const remoteId = "rwf_mock_1";
	mock.enqueue({
		id: "cmd_mock_1",
		type: "workflow.create",
		remote_id: remoteId,
		sequence: 1,
		payload: { name: "Mock remote workflow" },
		status: "delivered",
	});

	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: { enabled: true, url: MOCK_BASE, token: token!, intervalMs: 10_000 } });

	const local = getWorkflowByRemoteId(remoteId);
	assert.ok(local, "local workflow should exist");
	assert.equal(local!.origin, "remote");
	assert.equal(local!.remoteId, remoteId);
	assert.equal(local!.name, "Mock remote workflow");

	assert.equal(mock.state.acks.length, 1);
	const ackBody = mock.state.acks[0]!.body as { status: string; local_id?: string; remote_id?: string };
	assert.equal(ackBody.status, "applied");
	assert.equal(ackBody.local_id, local!.id);
	assert.equal(ackBody.remote_id, remoteId);

	assert.ok(mock.state.eventBatches.length >= 1);
	const lastBatch = mock.state.eventBatches.at(-1) as { events: Array<{ type: string }> };
	assert.ok(lastBatch.events.some((e) => e.type === "workflow.created" || e.type === "command.ack"));
});

test("mock server: heartbeat reports idle availability", async () => {
	const mock = createMockSyncServer();
	const hubCfg = loadConfig();

	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: { enabled: true, url: MOCK_BASE, token: "", intervalMs: 10_000 } });

	assert.equal(mock.state.heartbeats.length, 1);
	const hb = mock.state.heartbeats[0] as {
		status: string;
		capabilities?: {
			runners?: Array<{ id: string; installed: boolean }>;
			resources?: { version: number; tcp_tools?: boolean; resource_sets?: boolean };
			commands?: string[];
		};
	};
	assert.equal(hb.status, "idle");
	assert.ok(Array.isArray(hb.capabilities?.runners));
	assert.ok(hb.capabilities!.runners!.some((r) => r.id === "claude" || r.id === "free-code" || r.id === "cursor"));
	assert.deepEqual(hb.capabilities?.resources, { version: 2, tcp_tools: true, resource_sets: true });
	assert.ok(hb.capabilities?.commands?.includes("tcp-tool.upsert"));
});

// --- server_capabilities + gated archive events (D13) ----------------------

const {
	pendingSyncEvents,
	serverSupportsEvent,
} = await import("./sync.ts");
const {
	clearServerCapabilities,
	recordServerCapabilities,
	resetServerCapabilitiesCache,
	serverAdvertisedEvents,
} = await import("./server-capabilities.ts");
const { getServerCapabilitiesJson, insertWorkflow, open, setWorkflowRemoteMeta, setWorkflowStatus } = await import(
	"./db.ts"
);
const { archiveWorkflow, autoArchive, unarchiveWorkflow } = await import("./workflow.ts");
const { deleteDeviceLink } = await import("./device-link.ts");

const ARCHIVE_EVENTS = ["workflow.archived", "workflow.unarchived"];
const syncCfg = (token: string) => ({ enabled: true, url: MOCK_BASE, token, intervalMs: 10_000 });
let archiveSeq = 0;

/** A completed (archivable) workflow; remote-origin with a remote_id unless `local`. */
function makeCompletedWorkflow(local = false): { id: string; remoteId: string | null } {
	archiveSeq += 1;
	const id = `wf-sync-archive-${archiveSeq}`;
	insertWorkflow({
		id,
		name: `sync archive ${archiveSeq}`,
		agentName: `sync-archive-agent-${archiveSeq}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	setWorkflowStatus(id, "completed");
	if (local) return { id, remoteId: null };
	const remoteId = `rwf_archive_${archiveSeq}`;
	setWorkflowRemoteMeta(id, { origin: "remote", remoteId, remoteSyncedAt: new Date().toISOString() });
	return { id, remoteId };
}

function archiveEventsFor(remoteId: string | null) {
	return pendingSyncEvents().filter((e) => ARCHIVE_EVENTS.includes(e.type) && e.remote_id === (remoteId ?? undefined));
}

test("server_capabilities: parsed from heartbeat, non-strings ignored, persisted across a cache reload; missing → empty", async () => {
	clearServerCapabilities();
	const mock = createMockSyncServer();
	const hubCfg = loadConfig();
	mock.state.heartbeatCapabilities = { events: ["client.heartbeat", "workflow.archived", 42, null, { x: 1 }] };

	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: syncCfg("") });
	assert.equal(serverSupportsEvent("workflow.archived"), true);
	assert.equal(serverSupportsEvent("workflow.unarchived"), false);
	assert.deepEqual(serverAdvertisedEvents(), ["client.heartbeat", "workflow.archived"]);

	// Survives a restart: drop the in-memory cache and re-read from settings.
	resetServerCapabilitiesCache();
	assert.ok(getServerCapabilitiesJson());
	assert.equal(serverSupportsEvent("workflow.archived"), true);

	// An older server (no server_capabilities) clears support.
	const { token } = getSyncCredentials();
	mock.state.heartbeatCapabilities = undefined;
	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	assert.equal(serverSupportsEvent("workflow.archived"), false);
	assert.deepEqual(serverAdvertisedEvents(), []);

	// server_capabilities present but without `events` → empty too.
	recordServerCapabilities({ server_capabilities: { events: ["workflow.archived"] } });
	mock.state.heartbeatCapabilities = {};
	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	assert.deepEqual(serverAdvertisedEvents(), []);
	resetServerCapabilitiesCache();
	assert.deepEqual(serverAdvertisedEvents(), []);
});

test("server_capabilities: parsed from the register response", async () => {
	clearServerCapabilities();
	const mock = createMockSyncServer();
	mock.state.registerCapabilities = { events: ["workflow.unarchived"] };
	mock.state.failHeartbeat = true;
	await assert.rejects(
		runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") }),
		/heartbeat failed \(503\)/,
	);
	assert.equal(serverSupportsEvent("workflow.unarchived"), true);
});

test("server_capabilities: a failed heartbeat keeps the last known value", async () => {
	const mock = createMockSyncServer();
	const hubCfg = loadConfig();
	mock.state.heartbeatCapabilities = { events: ARCHIVE_EVENTS };
	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: syncCfg("") });
	assert.equal(serverSupportsEvent("workflow.archived"), true);

	const { token } = getSyncCredentials();
	mock.state.heartbeatCapabilities = undefined;
	mock.state.failHeartbeat = true;
	await assert.rejects(runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: syncCfg(token!) }));
	assert.equal(serverSupportsEvent("workflow.archived"), true);
});

test("archive/unarchive of a remote workflow emits workflow.archived / workflow.unarchived when advertised", async () => {
	recordServerCapabilities({ server_capabilities: { events: ARCHIVE_EVENTS } });
	const { id, remoteId } = makeCompletedWorkflow();
	const at = new Date("2026-09-30T12:00:00.000Z");

	archiveWorkflow(id, at);
	archiveWorkflow(id, new Date("2026-10-01T00:00:00.000Z")); // idempotent no-op → no second event
	assert.deepEqual(archiveEventsFor(remoteId), [
		{ type: "workflow.archived", remote_id: remoteId!, payload: { archived_at: at.toISOString() } },
	]);

	unarchiveWorkflow(id);
	unarchiveWorkflow(id); // no-op → nothing
	assert.deepEqual(archiveEventsFor(remoteId).at(-1), {
		type: "workflow.unarchived",
		remote_id: remoteId!,
		payload: { archived_at: null },
	});
	assert.equal(archiveEventsFor(remoteId).length, 2);

	// The daemon sweep goes through the same hook.
	open().prepare("UPDATE workflows SET updated_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", id);
	const sweepAt = new Date("2026-09-30T12:00:00.000Z");
	assert.ok(autoArchive(sweepAt).includes(id));
	assert.deepEqual(archiveEventsFor(remoteId).at(-1), {
		type: "workflow.archived",
		remote_id: remoteId!,
		payload: { archived_at: sweepAt.toISOString() },
	});

	// They flush with the batch like any other event (ids/created_at attached).
	const mock = createMockSyncServer();
	mock.state.heartbeatCapabilities = { events: ARCHIVE_EVENTS };
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") });
	const pushed = mock.state.eventBatches.flatMap(
		(b) => (b as { events: Array<{ id: string; type: string; remote_id?: string; created_at: string }> }).events,
	);
	const mine = pushed.filter((e) => e.remote_id === remoteId && ARCHIVE_EVENTS.includes(e.type));
	assert.deepEqual(
		mine.map((e) => e.type),
		["workflow.archived", "workflow.unarchived", "workflow.archived"],
	);
	for (const e of mine) {
		assert.equal(typeof e.id, "string");
		assert.ok(e.created_at);
	}
});

test("archive events are not queued when the server doesn't advertise them", () => {
	recordServerCapabilities({ server_capabilities: { events: ["client.heartbeat", "command.ack"] } });
	const { id, remoteId } = makeCompletedWorkflow();
	archiveWorkflow(id);
	unarchiveWorkflow(id);
	assert.deepEqual(archiveEventsFor(remoteId), []);

	clearServerCapabilities(); // older server: no server_capabilities at all
	archiveWorkflow(id);
	assert.deepEqual(archiveEventsFor(remoteId), []);
});

test("a gated event is dropped at flush when the server stopped advertising it", async () => {
	recordServerCapabilities({ server_capabilities: { events: ARCHIVE_EVENTS } });
	const { id, remoteId } = makeCompletedWorkflow();
	archiveWorkflow(id);
	assert.equal(archiveEventsFor(remoteId).length, 1);

	const mock = createMockSyncServer(); // heartbeat without server_capabilities → downgrade
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") });
	const pushed = mock.state.eventBatches.flatMap((b) => (b as { events: Array<{ type: string }> }).events);
	assert.ok(!pushed.some((e) => ARCHIVE_EVENTS.includes(e.type)));
	assert.deepEqual(archiveEventsFor(remoteId), []);
});

test("local-origin workflows never emit archive events, even when advertised", () => {
	recordServerCapabilities({ server_capabilities: { events: ARCHIVE_EVENTS } });
	const { id } = makeCompletedWorkflow(true);
	archiveWorkflow(id);
	unarchiveWorkflow(id);
	assert.deepEqual(
		pendingSyncEvents().filter((e) => ARCHIVE_EVENTS.includes(e.type)),
		[],
	);
});

test("unlinking the hub clears the advertised server capabilities", () => {
	recordServerCapabilities({ server_capabilities: { events: ARCHIVE_EVENTS } });
	assert.equal(serverSupportsEvent("workflow.archived"), true);
	deleteDeviceLink();
	assert.equal(serverSupportsEvent("workflow.archived"), false);
	resetServerCapabilitiesCache();
	assert.equal(getServerCapabilitiesJson(), null);
	assert.equal(serverSupportsEvent("workflow.archived"), false);
});

// --- schedule commands over the wire (D17) -------------------------------------

test("the schedule commands are advertised in capabilities.commands and ack over the wire", async () => {
	const { syncClientCapabilities } = await import("./sync.ts");
	const { getWorkflow } = await import("./db.ts");
	assert.ok(syncClientCapabilities().commands.includes("workflow.set_schedule"));
	assert.ok(syncClientCapabilities().commands.includes("workflow.cancel_schedule"));

	const mock = createMockSyncServer();
	const hubCfg = loadConfig();
	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: syncCfg("") });
	const hb = mock.state.heartbeats.at(-1) as { capabilities?: { commands?: string[] } };
	assert.ok(hb.capabilities?.commands?.includes("workflow.set_schedule"));
	assert.ok(hb.capabilities?.commands?.includes("workflow.cancel_schedule"));

	const remoteId = "rwf_schedule_wire";
	const envelope = (id: string, type: string, payload: Record<string, unknown>, sequence: number): SyncCommand => ({
		id,
		type,
		remote_id: remoteId,
		sequence,
		payload,
		status: "delivered",
	});
	mock.enqueue(envelope("cmd_wire_1", "workflow.create", { name: "Wire series" }, 1));
	mock.enqueue(
		envelope("cmd_wire_2", "workflow.set_schedule", { series_id: "series_wire", spec: { kind: "hourly" }, timezone: "UTC" }, 2),
	);
	mock.enqueue(
		envelope(
			"cmd_wire_3",
			"workflow.set_schedule",
			{ series_id: "series_wire", spec: { kind: "daily", time: "09:00" }, timezone: "UTC" },
			3,
		),
	);
	mock.enqueue(envelope("cmd_wire_4", "workflow.cancel_schedule", { series_id: "series_wire" }, 4));
	const { token } = getSyncCredentials();
	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: syncCfg(token!) });

	const acks = new Map(mock.state.acks.map((a) => [a.commandId, a.body as { status: string; local_id?: string; error?: { message?: string } }]));
	const local = getWorkflowByRemoteId(remoteId)!;
	assert.equal(acks.get("cmd_wire_2")?.status, "failed", "an invalid spec acks failed");
	assert.match(acks.get("cmd_wire_2")?.error?.message ?? "", /invalid schedule: kind/);
	assert.equal(acks.get("cmd_wire_3")?.status, "applied");
	assert.equal(acks.get("cmd_wire_3")?.local_id, local.id);
	assert.equal(acks.get("cmd_wire_4")?.status, "applied");
	const wf = getWorkflow(local.id)!;
	assert.equal(wf.seriesId, "series_wire");
	assert.equal(wf.managedBy, "server");
	assert.equal(wf.scheduleState, "cancelled");
});
