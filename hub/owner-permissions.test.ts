/**
 * Owner snapshot cache: persist, survive a process-style reload from settings,
 * expire after 3 sync intervals, clear on disconnect, drop when deviceId changes.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-owner-permissions-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".awb");
delete process.env.TARGET_SYNC_URL;
delete process.env.TARGET_SYNC_TOKEN;

const { getOwnerPermissionsJson } = await import("./db.ts");
const {
	activateDeviceCredential,
	beginDeviceLink,
	deleteDeviceLink,
} = await import("./device-link.ts");
const {
	clearOwnerSnapshot,
	hasPermission,
	recordOwnerSnapshot,
	resetOwnerPermissionsCache,
	resolvePermissionMode,
} = await import("./owner-permissions.ts");

const ORIGIN = "https://server.example";

function owner(permissions: string[], id = "owner_1"): unknown {
	return {
		id,
		permissions,
		granted: {
			groups: [
				{
					id: "remote",
					scope: "remote",
					label: "Remote",
					description: "",
					permissions: permissions.map((pid) => ({ id: pid, label: pid, description: "" })),
				},
			],
		},
	};
}

function link(deviceId: string): void {
	deleteDeviceLink();
	clearOwnerSnapshot();
	beginDeviceLink({ origin: ORIGIN, deviceName: "perm-test" });
	activateDeviceCredential({
		deviceId,
		deviceSecret: "secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
}

test("recordOwnerSnapshot persists the payload in settings", () => {
	link("dev_persist");
	recordOwnerSnapshot(owner(["client.read", "client.workflows.create"]), "dev_persist", ORIGIN);
	const raw = getOwnerPermissionsJson();
	assert.ok(raw);
	const stored = JSON.parse(raw) as { ownerId: string; permissions: string[]; deviceId: string };
	assert.equal(stored.ownerId, "owner_1");
	assert.deepEqual(stored.permissions, ["client.read", "client.workflows.create"]);
	assert.equal(stored.deviceId, "dev_persist");
	const mode = resolvePermissionMode();
	assert.equal(mode.mode, "enforced");
	assert.equal(hasPermission("client.workflows.create"), true);
	assert.equal(hasPermission("client.workflows.execute"), false);
});

test("snapshot survives a process restart by reloading settings", () => {
	link("dev_restart");
	recordOwnerSnapshot(owner(["client.read"]), "dev_restart", ORIGIN);
	const before = getOwnerPermissionsJson();
	assert.ok(before);
	resetOwnerPermissionsCache();
	assert.equal(getOwnerPermissionsJson(), before);
	const reloaded = JSON.parse(getOwnerPermissionsJson()!) as { ownerId: string; permissions: string[] };
	assert.equal(reloaded.ownerId, "owner_1");
	assert.deepEqual(reloaded.permissions, ["client.read"]);
	// Disk loads start stale until the next live heartbeat — the row is still there.
	const mode = resolvePermissionMode();
	assert.equal(mode.mode, "read_only");
	if (mode.mode === "read_only") assert.equal(mode.reason, "stale");
});

test("a live snapshot expires after 3 sync intervals", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
	link("dev_expire");
	recordOwnerSnapshot(owner(["client.read"]), "dev_expire", ORIGIN);
	assert.equal(resolvePermissionMode().mode, "enforced");
	t.mock.timers.tick(29_000);
	assert.equal(resolvePermissionMode().mode, "enforced");
	t.mock.timers.tick(2_000);
	const mode = resolvePermissionMode();
	assert.equal(mode.mode, "read_only");
	if (mode.mode === "read_only") assert.equal(mode.reason, "stale");
});

test("disconnecting the device clears the snapshot", () => {
	link("dev_clear");
	recordOwnerSnapshot(owner(["client.read"]), "dev_clear", ORIGIN);
	assert.ok(getOwnerPermissionsJson());
	deleteDeviceLink();
	assert.equal(getOwnerPermissionsJson(), null);
	assert.equal(resolvePermissionMode().mode, "unrestricted");
});

test("a different deviceId invalidates the stored snapshot", () => {
	link("dev_a");
	recordOwnerSnapshot(owner(["client.read", "client.workflows.manage"]), "dev_a", ORIGIN);
	assert.equal(resolvePermissionMode().mode, "enforced");
	activateDeviceCredential({
		deviceId: "dev_b",
		deviceSecret: "secret-b",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
	const mode = resolvePermissionMode();
	assert.equal(mode.mode, "read_only");
	if (mode.mode === "read_only") assert.equal(mode.reason, "no_owner");
	assert.equal(getOwnerPermissionsJson(), null);
});
