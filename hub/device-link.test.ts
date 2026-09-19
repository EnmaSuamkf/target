import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-device-link-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".awb");
delete process.env.TARGET_REPORT_URL;
delete process.env.TARGET_REPORT_TOKEN;
delete process.env.TARGET_SYNC_URL;
delete process.env.TARGET_SYNC_TOKEN;

const {
	activateDeviceCredential,
	beginDeviceLink,
	deleteDeviceLink,
	getDeviceCredential,
	getDeviceLinkStatus,
	getPendingDeviceLinkTransport,
	migrateLegacyRemoteConfiguration,
	rotateDeviceKey,
	savePendingDeviceLink,
} = await import("./device-link.ts");

const identityFile = () => path.join(String(process.env.TARGET_HOME), "device-link.json");

test("an unconfigured hub remains local-first and has no identity file", () => {
	deleteDeviceLink();
	const status = getDeviceLinkStatus();
	assert.equal(status.state, "local_unconfigured");
	assert.equal(status.origin, null);
	assert.equal(fs.existsSync(identityFile()), false);
});

test("device identity uses Ed25519 and persists secrets in a private file only", () => {
	deleteDeviceLink();
	const start = beginDeviceLink({
		origin: "https://target.example",
		deviceName: "Test workstation",
	});
	assert.equal(start.publicKey.algorithm, "ed25519");
	assert.match(start.publicKey.value, /^[A-Za-z0-9_-]+$/);
	assert.match(start.idempotencyKey, /^[A-Za-z0-9_-]+$/);

	savePendingDeviceLink({
		requestId: "dlr_test_request",
		pollingCredential: "polling-secret-not-for-ui",
		expiresAt: "2026-09-19T20:00:00.000Z",
		pollAfterSeconds: 3,
	});
	const pending = getPendingDeviceLinkTransport();
	assert.equal(pending?.pollingCredential, "polling-secret-not-for-ui");

	const status = getDeviceLinkStatus();
	const serialized = JSON.stringify(status);
	assert.equal(status.state, "awaiting_authorization");
	assert.ok(!serialized.includes("polling-secret-not-for-ui"));
	assert.ok(!serialized.includes(start.idempotencyKey));
	assert.ok(!serialized.includes("privateKey"));

	const mode = fs.statSync(identityFile()).mode & 0o777;
	assert.equal(mode, 0o600);
	const dirMode = fs.statSync(String(process.env.TARGET_HOME)).mode & 0o777;
	assert.equal(dirMode, 0o700);
});

test("activation, rotation and deletion keep device secrets out of public status", () => {
	const publicBefore = getPendingDeviceLinkTransport()!.publicKey.value;
	const activated = activateDeviceCredential({
		deviceId: "dev_test_device",
		deviceSecret: "device-secret-not-for-ui",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
	assert.equal(activated.state, "connected");
	assert.equal(activated.deviceId, "dev_test_device");
	assert.ok(!JSON.stringify(activated).includes("device-secret-not-for-ui"));
	assert.equal(getPendingDeviceLinkTransport(), null, "consume removes the polling credential");

	const credential = getDeviceCredential();
	assert.equal(credential?.deviceSecret, "device-secret-not-for-ui");
	const rotated = rotateDeviceKey();
	assert.notEqual(rotated.publicKey.value, publicBefore);
	assert.equal(getDeviceCredential()?.deviceSecret, "device-secret-not-for-ui");

	deleteDeviceLink();
	assert.equal(getDeviceCredential(), null);
	assert.equal(fs.existsSync(identityFile()), false);
});

test("normal reinstall preserves a connected identity and migrates version zero in place", () => {
	deleteDeviceLink();
	beginDeviceLink({ origin: "https://target.example", deviceName: "Upgrade workstation" });
	activateDeviceCredential({
		deviceId: "dev_upgrade",
		deviceSecret: "upgrade-secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
	const before = fs.readFileSync(identityFile(), "utf8");
	// Installer/bootstrap only manages code dependencies; loading configuration
	// simulates restarting an upgraded hub against the same TARGET_HOME.
	assert.equal(getDeviceLinkStatus().state, "connected");
	assert.equal(fs.readFileSync(identityFile(), "utf8"), before);

	const legacy = JSON.parse(before) as Record<string, unknown>;
	legacy.version = 0;
	fs.writeFileSync(identityFile(), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
	assert.equal(getDeviceLinkStatus().state, "connected");
	const migrated = JSON.parse(fs.readFileSync(identityFile(), "utf8")) as { version: number; deviceSecret: string };
	assert.equal(migrated.version, 1);
	assert.equal(migrated.deviceSecret, "upgrade-secret");
	assert.equal(fs.statSync(identityFile()).mode & 0o777, 0o600);
});

test("a deliberately new TARGET_HOME has no identity and never reconstructs one", () => {
	deleteDeviceLink();
	assert.equal(getDeviceLinkStatus().state, "local_unconfigured");
	assert.equal(getDeviceCredential(), null);
	assert.equal(fs.existsSync(identityFile()), false);
});

test("legacy remote settings are detected without turning Bearer credentials into device credentials", () => {
	deleteDeviceLink();
	process.env.TARGET_REPORT_URL = "https://legacy.example/ingest";
	process.env.TARGET_REPORT_TOKEN = "legacy-report-token";
	process.env.TARGET_SYNC_URL = "https://legacy.example";
	process.env.TARGET_SYNC_TOKEN = "legacy-sync-token";
	try {
		const migrated = migrateLegacyRemoteConfiguration();
		assert.equal(migrated.state, "local_unconfigured");
		assert.deepEqual(migrated.legacy, { reportingConfigured: true, syncConfigured: true });
		assert.equal(fs.existsSync(identityFile()), false);
	} finally {
		delete process.env.TARGET_REPORT_URL;
		delete process.env.TARGET_REPORT_TOKEN;
		delete process.env.TARGET_SYNC_URL;
		delete process.env.TARGET_SYNC_TOKEN;
	}
});

test("a corrupt identity is quarantined and safely requires relinking", () => {
	fs.mkdirSync(String(process.env.TARGET_HOME), { recursive: true });
	fs.writeFileSync(identityFile(), "{not-json", { mode: 0o600 });
	const status = getDeviceLinkStatus();
	assert.equal(status.state, "relink_required");
	assert.equal(status.reason, "local_identity_unavailable");
	assert.equal(getDeviceCredential(), null);
	assert.equal(fs.existsSync(identityFile()), false);
	const quarantined = fs.readdirSync(String(process.env.TARGET_HOME)).find((file) => file.startsWith("device-link.json.corrupt-"));
	assert.ok(quarantined);
	assert.equal(fs.statSync(path.join(String(process.env.TARGET_HOME), quarantined!)).mode & 0o777, 0o600);
});
