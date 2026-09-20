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
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}

		if (!state.clientToken || !auth.includes(state.clientToken)) {
			return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
		}

		if (method === "POST" && u.pathname === "/api/sync/heartbeat") {
			state.heartbeats.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(JSON.stringify({ ok: true, server_time: new Date().toISOString() }), {
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
		capabilities?: { runners?: Array<{ id: string; installed: boolean }> };
	};
	assert.equal(hb.status, "idle");
	assert.ok(Array.isArray(hb.capabilities?.runners));
	assert.ok(hb.capabilities!.runners!.some((r) => r.id === "claude" || r.id === "free-code" || r.id === "cursor"));
});
