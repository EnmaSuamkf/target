/**
 * Register and heartbeat carry `owner`; a role change on the second beat
 * changes the effective permission mode.
 */
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, beforeEach } from "node:test";
import type { FetchLike } from "./sync.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-owner-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".awb");
const MOCK_BASE = "http://127.0.0.1:8901";
process.env.TARGET_SYNC_URL = MOCK_BASE;
process.env.TARGET_SYNC_ENABLED = "true";
delete process.env.TARGET_SYNC_TOKEN;

const { runSyncTick, resetSyncExecutorState } = await import("./sync.ts");
const { loadConfig } = await import("./config.ts");
const { activateDeviceCredential, beginDeviceLink, deleteDeviceLink } = await import("./device-link.ts");
const { hasPermission, resolvePermissionMode } = await import("./owner-permissions.ts");

beforeEach(() => {
	resetSyncExecutorState();
});

function owner(permissions: string[], id = "owner_sync"): unknown {
	return { id, permissions, granted: { groups: [] } };
}

function createOwnerMock(initial: unknown): {
	fetchImpl: FetchLike;
	setOwner(next: unknown): void;
} {
	let current = initial;
	let clientToken: string | null = null;
	const fetchImpl: FetchLike = async (url, init) => {
		const u = new URL(url);
		const method = init?.method ?? "GET";
		if (method === "POST" && u.pathname === "/api/sync/register") {
			clientToken = `sync_${crypto.randomBytes(8).toString("hex")}`;
			return new Response(
				JSON.stringify({
					client_id: "dev_sync_owner",
					client_token: clientToken,
					created_at: new Date().toISOString(),
					owner: current,
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}
		if (method === "POST" && u.pathname === "/api/sync/heartbeat") {
			return new Response(JSON.stringify({ ok: true, server_time: new Date().toISOString(), owner: current }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (method === "GET" && u.pathname === "/api/sync/commands") {
			return new Response(JSON.stringify({ commands: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ accepted: [], rejected: [], duplicates: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return {
		fetchImpl,
		setOwner(next) {
			current = next;
		},
	};
}

function link(): void {
	deleteDeviceLink();
	beginDeviceLink({ origin: MOCK_BASE, deviceName: "sync-owner" });
	activateDeviceCredential({
		deviceId: "dev_sync_owner",
		deviceSecret: "secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
}

test("register owner is enforced, and a second heartbeat with a new role updates the mode", async () => {
	link();
	const mock = createOwnerMock(owner(["remote.read"]));
	const hubCfg = loadConfig();
	const tick = { hubConfig: hubCfg, fetchImpl: mock.fetchImpl, config: { enabled: true, url: MOCK_BASE, token: "", intervalMs: 10_000 } };

	await runSyncTick(tick);
	assert.equal(resolvePermissionMode().mode, "enforced");
	assert.equal(hasPermission("remote.read"), true);
	assert.equal(hasPermission("remote.workflows.create"), false);

	mock.setOwner(owner(["remote.read", "remote.workflows.create", "remote.workflows.manage"]));
	await runSyncTick(tick);
	assert.equal(resolvePermissionMode().mode, "enforced");
	assert.equal(hasPermission("remote.workflows.create"), true);
	assert.equal(hasPermission("remote.workflows.manage"), true);
	assert.equal(hasPermission("remote.workflows.execute"), false);
});
