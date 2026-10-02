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
	/** Answer event pushes with 503 (nothing stored; the hub re-queues the batch). */
	failEvents?: boolean;
	/** Per-event verdict on a push; default: accepted. */
	eventVerdict?: (id: string) => "accepted" | "duplicate" | { rejected: string };
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
			if (state.failEvents) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
			state.eventBatches.push(body);
			const events = (body.events ?? []) as Array<{ id: string }>;
			const verdict = state.eventVerdict ?? (() => "accepted" as const);
			const accepted: string[] = [];
			const duplicates: string[] = [];
			const rejected: Array<{ id: string; reason: string }> = [];
			for (const e of events) {
				const v = verdict(e.id);
				if (v === "accepted") accepted.push(e.id);
				else if (v === "duplicate") duplicates.push(e.id);
				else rejected.push({ id: e.id, reason: v.rejected });
			}
			return new Response(JSON.stringify({ accepted, rejected, duplicates }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
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
	assert.deepEqual(hb.capabilities!.runners!.map((r) => r.id).sort(), ["claude", "copilot", "cursor", "free-code"]);
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

// --- schedule.instance_created announcement (D18) --------------------------------

const {
	getWorkflow: getWf,
	listNotices,
	getSyncStepMap: stepMapOf,
	saveSyncStepMap: saveStepMap,
	updateWorkflowSchedule: patchSchedule,
} = await import("./db.ts");
const { cloneScheduledInstance: cloneInstance, setSchedule: armSchedule } = await import("./workflow.ts");

const ANNOUNCE = ["schedule.instance_created"];
let announceSeq = 0;

/**
 * A server series whose first instance (server-created, announced) has fired
 * and whose next instance — cloned by the hub, fresh remote_id — waits to be
 * announced. Returns both.
 */
function remoteSeriesWithClone(): { first: string; next: string; nextRemoteId: string; firstRemoteId: string; seriesId: string } {
	announceSeq += 1;
	const first = `wf-sync-announce-${announceSeq}`;
	insertWorkflow({
		id: first,
		name: `announce ${announceSeq}`,
		agentName: `sync-announce-agent-${announceSeq}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, `${first}.md`),
	});
	const firstRemoteId = `rwf_announce_${announceSeq}`;
	setWorkflowRemoteMeta(first, { origin: "remote", remoteId: firstRemoteId, remoteSyncedAt: new Date().toISOString() });
	const seriesId = `series_announce_${announceSeq}`;
	armSchedule(first, { spec: { kind: "daily", time: "09:00" }, timezone: "UTC", seriesId }, { actor: "server" });
	patchSchedule(first, { announcedAt: new Date().toISOString() }, { touch: false });
	const created = cloneInstance(first, new Date(Date.now() + 2 * 86_400_000));
	patchSchedule(first, { scheduleState: "fired", nextRunAt: null });
	return { first, next: created.id, nextRemoteId: created.remoteId!, firstRemoteId, seriesId };
}

function announcementsIn(mock: ReturnType<typeof createMockSyncServer>, remoteId: string) {
	return (mock.state.eventBatches as Array<{ events: Array<{ id: string; type: string; remote_id?: string; payload: Record<string, unknown> }> }>)
		.flatMap((b) => b.events)
		.filter((e) => e.type === "schedule.instance_created" && e.remote_id === remoteId);
}

test("announcement: sent with the D18 payload and the deterministic id; accepted marks it announced", async () => {
	const { first, next, nextRemoteId, firstRemoteId, seriesId } = remoteSeriesWithClone();
	// A step on the clone, keyed through the series' step map.
	const { addStep } = await import("./workflow.ts");
	const step = addStep(next, "Collect the numbers", { acceptanceCriteria: "numbers in", maxRetries: 2 });
	saveStepMap(nextRemoteId, { ...stepMapOf(nextRemoteId), k_collect: step.id });

	const mock = createMockSyncServer();
	mock.state.heartbeatCapabilities = { events: ANNOUNCE };
	assert.equal(getWf(next)!.announcedAt, null);
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") });

	const sent = announcementsIn(mock, nextRemoteId);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.id, `instance-created:${nextRemoteId}`);
	const p = sent[0]!.payload;
	assert.equal(p.series_id, seriesId);
	assert.equal(p.previous_remote_id, firstRemoteId);
	assert.equal(p.name, getWf(next)!.name);
	assert.equal(p.scheduled_for, getWf(next)!.scheduledFor);
	assert.deepEqual(p.schedule, { spec: { kind: "daily", time: "09:00" }, timezone: "UTC", include_previous: true });
	assert.ok("agent" in p && "sandbox" in p && "conversation_context" in p);
	assert.deepEqual(p.steps, [
		{
			step_key: "k_collect",
			description: "Collect the numbers",
			acceptance_criteria: "numbers in",
			manual_review: false,
			use_subagent: true,
			max_retries: 2,
			retry_interval_seconds: 0,
		},
	]);
	assert.deepEqual(p.tcp_selections, []);
	assert.deepEqual(p.resource_selections, []);
	// The server-created first instance is never announced back.
	assert.equal(announcementsIn(mock, firstRemoteId).length, 0);
	assert.ok(getWf(next)!.announcedAt, "accepted → announced");
	assert.ok(getWf(first)!.announcedAt);

	// Announced: later ticks send nothing more for it.
	const { token } = getSyncCredentials();
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	assert.equal(announcementsIn(mock, nextRemoteId).length, 1);
});

test("announcement: queued once per cycle, and a failed push leaves announced_at NULL until the server answers", async () => {
	const { next, nextRemoteId } = remoteSeriesWithClone();
	const mock = createMockSyncServer();
	mock.state.heartbeatCapabilities = { events: ANNOUNCE };
	mock.state.failEvents = true;
	await assert.rejects(runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") }), /events push failed/);
	const { token } = getSyncCredentials();
	await assert.rejects(runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg(token!) }));
	// Two cycles re-derived it, but the re-queued batch holds it once.
	assert.equal(pendingSyncEvents().filter((e) => e.remote_id === nextRemoteId && e.type === "schedule.instance_created").length, 1);
	assert.equal(getWf(next)!.announcedAt, null, "not set by sending — only by the server's answer");

	mock.state.failEvents = false;
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	assert.equal(announcementsIn(mock, nextRemoteId).length, 1);
	assert.ok(getWf(next)!.announcedAt);
});

test("announcement: a hub restart before a successful push resends it (state-derived), as a duplicate that still marks it", async () => {
	const { next, nextRemoteId } = remoteSeriesWithClone();
	const mock = createMockSyncServer();
	mock.state.heartbeatCapabilities = { events: ANNOUNCE };
	mock.state.failEvents = true;
	await assert.rejects(runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") }));
	assert.equal(pendingSyncEvents().filter((e) => e.remote_id === nextRemoteId).length, 1);

	// Restart: the in-memory queue is gone; announced_at is still NULL on disk.
	resetSyncExecutorState();
	resetServerCapabilitiesCache();
	assert.equal(pendingSyncEvents().length, 0);
	assert.equal(getWf(next)!.announcedAt, null);

	// Say the lost push had in fact reached the server: it answers duplicate.
	mock.state.failEvents = false;
	mock.state.eventVerdict = (id) => (id === `instance-created:${nextRemoteId}` ? "duplicate" : "accepted");
	const { token } = getSyncCredentials();
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	const sent = announcementsIn(mock, nextRemoteId);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.id, `instance-created:${nextRemoteId}`, "same id after the restart");
	assert.ok(getWf(next)!.announcedAt, "duplicate → announced");
});

test("announcement: rejected records a broken notice with the reason and breaks the series; no resend", async () => {
	const { next, nextRemoteId, seriesId } = remoteSeriesWithClone();
	const mock = createMockSyncServer();
	mock.state.heartbeatCapabilities = { events: ANNOUNCE };
	mock.state.eventVerdict = (id) => (id === `instance-created:${nextRemoteId}` ? { rejected: "series_cancelled" } : "accepted");
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") });

	const wf = getWf(next)!;
	assert.equal(wf.announcedAt, null, "rejected is not announced");
	assert.equal(wf.scheduleState, "broken");
	assert.equal(wf.nextRunAt, null, "a broken series doesn't fire");
	const notices = listNotices({ seriesId });
	assert.equal(notices.length, 1);
	assert.equal(notices[0]!.kind, "broken");
	assert.equal(notices[0]!.reason, "announcement_rejected");
	assert.equal(notices[0]!.detail.error, "series_cancelled");
	assert.equal(notices[0]!.detail.critical, true);
	assert.equal(notices[0]!.workflowId, next);

	const { token } = getSyncCredentials();
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	assert.equal(announcementsIn(mock, nextRemoteId).length, 1, "a broken series is not re-announced");
	assert.equal(listNotices({ seriesId }).length, 1);
});

test("announcement: nothing is sent when the server doesn't advertise schedule.instance_created", async () => {
	const { next, nextRemoteId } = remoteSeriesWithClone();
	const mock = createMockSyncServer();
	mock.state.heartbeatCapabilities = { events: ["workflow.archived"] };
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") });
	const all = (mock.state.eventBatches as Array<{ events: Array<{ type: string }> }>).flatMap((b) => b.events);
	assert.ok(!all.some((e) => e.type === "schedule.instance_created"));
	assert.equal(pendingSyncEvents().filter((e) => e.remote_id === nextRemoteId).length, 0);
	assert.equal(getWf(next)!.announcedAt, null, "still waiting for a server that understands it");
	// Tidy: later tests in this file must not pick it up.
	patchSchedule(next, { scheduleState: "cancelled", nextRunAt: null });
});

// --- workflow.schedule_changed (D20, state-derived, gated by D13) -------------------

function scheduleChangesIn(mock: ReturnType<typeof createMockSyncServer>, seriesId: string) {
	return (mock.state.eventBatches as Array<{ events: Array<{ type: string; remote_id?: string; payload: Record<string, unknown> }> }>)
		.flatMap((b) => b.events)
		.filter((e) => e.type === "workflow.schedule_changed" && e.payload.series_id === seriesId)
		.map((e): Record<string, unknown> => ({ remote_id: e.remote_id, ...e.payload }));
}

test("schedule_changed: set, re-armed, broken and cancelled each send one snapshot when advertised", async () => {
	const mock = createMockSyncServer();
	mock.state.heartbeatCapabilities = { events: ["workflow.schedule_changed", "schedule.instance_created"] };
	const hubCfg = loadConfig();
	await runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: syncCfg("") });
	const { token } = getSyncCredentials();
	const tick = () => runSyncTick({ hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	const cmd = (id: string, type: string, payload: Record<string, unknown>): SyncCommand => ({
		id,
		type,
		remote_id: "rwf_changed",
		sequence: 1,
		payload,
		status: "delivered",
	});

	// Set: the server arms its workflow as a new series.
	mock.enqueue(cmd("cmd_changed_1", "workflow.create", { name: "Changed" }));
	mock.enqueue(
		cmd("cmd_changed_2", "workflow.set_schedule", {
			series_id: "series_changed",
			spec: { kind: "daily", time: "09:00" },
			timezone: "UTC",
		}),
	);
	await tick();
	const wf = getWorkflowByRemoteId("rwf_changed")!;
	assert.deepEqual(scheduleChangesIn(mock, "series_changed"), [
		{ remote_id: "rwf_changed", series_id: "series_changed", state: "armed", next_run_at: getWf(wf.id)!.nextRunAt },
	]);
	await tick();
	assert.equal(scheduleChangesIn(mock, "series_changed").length, 1, "unchanged → nothing more");

	// Updated: a new time is a new snapshot.
	mock.enqueue(
		cmd("cmd_changed_3", "workflow.set_schedule", {
			series_id: "series_changed",
			spec: { kind: "daily", time: "18:00" },
			timezone: "UTC",
		}),
	);
	await tick();
	assert.equal(scheduleChangesIn(mock, "series_changed").at(-1)!.next_run_at, getWf(wf.id)!.nextRunAt);
	assert.equal(scheduleChangesIn(mock, "series_changed").length, 2);

	// Re-armed (as the scheduler does after a miss or a skip): the next run moves on.
	const later = new Date(Date.parse(getWf(wf.id)!.nextRunAt!) + 86_400_000).toISOString();
	patchSchedule(wf.id, { nextRunAt: later, scheduledFor: later });
	await tick();
	assert.deepEqual(scheduleChangesIn(mock, "series_changed").at(-1), {
		remote_id: "rwf_changed",
		series_id: "series_changed",
		state: "armed",
		next_run_at: later,
	});

	// Broken.
	patchSchedule(wf.id, { scheduleState: "broken", nextRunAt: null });
	await tick();
	assert.deepEqual(scheduleChangesIn(mock, "series_changed").at(-1), {
		remote_id: "rwf_changed",
		series_id: "series_changed",
		state: "broken",
		next_run_at: null,
	});

	// Cancelled.
	mock.enqueue(cmd("cmd_changed_4", "workflow.cancel_schedule", { series_id: "series_changed" }));
	await tick();
	assert.deepEqual(scheduleChangesIn(mock, "series_changed").at(-1), {
		remote_id: "rwf_changed",
		series_id: "series_changed",
		state: "cancelled",
		next_run_at: null,
	});
	assert.equal(scheduleChangesIn(mock, "series_changed").length, 5);
});

test("schedule_changed: a fire re-arms the series on its next instance, reported once the server knows it", async () => {
	const { next, nextRemoteId, seriesId } = remoteSeriesWithClone();
	const mock = createMockSyncServer();
	mock.state.heartbeatCapabilities = { events: ["workflow.schedule_changed", "schedule.instance_created"] };
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") });
	assert.deepEqual(scheduleChangesIn(mock, seriesId), [], "waits for the announcement to be confirmed");
	assert.ok(getWf(next)!.announcedAt);
	const { token } = getSyncCredentials();
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	assert.deepEqual(scheduleChangesIn(mock, seriesId), [
		{ remote_id: nextRemoteId, series_id: seriesId, state: "armed", next_run_at: getWf(next)!.nextRunAt },
	]);
	patchSchedule(next, { scheduleState: "cancelled", nextRunAt: null });
});

test("schedule_changed: nothing is sent while unadvertised; once advertised the current snapshot goes out", async () => {
	const { next, nextRemoteId, seriesId } = remoteSeriesWithClone();
	patchSchedule(next, { announcedAt: new Date().toISOString() }, { touch: false });
	const mock = createMockSyncServer();
	mock.state.heartbeatCapabilities = { events: ["schedule.instance_created"] };
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") });
	const { token } = getSyncCredentials();
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	const all = (mock.state.eventBatches as Array<{ events: Array<{ type: string }> }>).flatMap((b) => b.events);
	assert.ok(!all.some((e) => e.type === "workflow.schedule_changed"));
	assert.equal(pendingSyncEvents().filter((e) => e.type === "workflow.schedule_changed").length, 0);

	mock.state.heartbeatCapabilities = { events: ["workflow.schedule_changed"] };
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	assert.deepEqual(scheduleChangesIn(mock, seriesId), [
		{ remote_id: nextRemoteId, series_id: seriesId, state: "armed", next_run_at: getWf(next)!.nextRunAt },
	]);
	patchSchedule(next, { scheduleState: "cancelled", nextRunAt: null });
});

test("instance_already_fired: a step command aimed at a fired instance is acked failed over the wire", async () => {
	const { first, firstRemoteId } = remoteSeriesWithClone();
	const mock = createMockSyncServer();
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg("") });
	mock.enqueue({
		id: "cmd_fired_add",
		type: "step.add",
		remote_id: firstRemoteId,
		sequence: 1,
		payload: { step_key: "k_late", description: "Too late" },
		status: "delivered",
	});
	const { token } = getSyncCredentials();
	await runSyncTick({ hubConfig: loadConfig(), fetchImpl: mock.fetchImpl, config: syncCfg(token!) });
	const ack = mock.state.acks.find((a) => a.commandId === "cmd_fired_add")!.body as {
		status: string;
		error?: { message?: string };
	};
	assert.equal(ack.status, "failed");
	assert.equal(ack.error?.message, "instance_already_fired");
	assert.equal(getWf(first)!.scheduleState, "fired");
});
