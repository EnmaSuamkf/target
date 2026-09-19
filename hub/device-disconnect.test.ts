import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-device-disconnect-"));
process.env.TARGET_HOME = path.join(home, ".target");
process.env.AWB_HOME = path.join(home, ".awb");

const {
	activateDeviceCredential,
	beginDeviceLink,
	deleteDeviceLink,
	getDeviceCredential,
	getDeviceLinkStatus,
	getPendingRemoteCleanup,
} = await import("./device-link.ts");
const { disconnectDeviceLink, retryRemoteDisconnect } = await import("./device-link-client.ts");

function link(): void {
	deleteDeviceLink();
	beginDeviceLink({ origin: "https://server.example", deviceName: "Disconnect test" });
	activateDeviceCredential({ deviceId: "dev_disconnect", deviceSecret: "device-secret", scopes: ["ingest:write", "sync:write"], credentialVersion: 1 });
}

test("disconnect immediately disables local transport and archives the remote identity", async () => {
	link();
	let url = "";
	let auth = "";
	const outcome = await disconnectDeviceLink({
		fetchImpl: async (input, init) => {
			url = String(input);
			auth = new Headers(init.headers).get("authorization") ?? "";
			return new Response("", { status: 200 });
		},
	});
	assert.equal(url, "https://server.example/api/device-links/devices/dev_disconnect");
	assert.match(auth, /^Target-Device v1 dev_disconnect\./);
	assert.equal(outcome.status.state, "local_unconfigured");
	assert.equal(getDeviceCredential(), null);
	assert.equal(getPendingRemoteCleanup(), null);
	assert.ok(!JSON.stringify(outcome).includes("device-secret"));
});

test("offline or timeout leaves only retry cleanup material and idempotently purges it later", async () => {
	link();
	const offline = await disconnectDeviceLink({ fetchImpl: async () => { throw new Error("offline"); } });
	assert.equal(offline.status.state, "disconnected_locally");
	assert.equal(offline.status.remoteCleanupPending, true);
	assert.equal(getDeviceCredential(), null, "remote traffic stops before cleanup retry");
	assert.ok(getPendingRemoteCleanup(), "minimal cleanup material is retained");

	const retried = await retryRemoteDisconnect({ force: true, fetchImpl: async () => new Response("", { status: 410 }) });
	assert.equal(retried.status.state, "local_unconfigured");
	assert.equal(getPendingRemoteCleanup(), null);
});

test("invalid cleanup credentials are not retried and never leak through status", async () => {
	link();
	const outcome = await disconnectDeviceLink({ fetchImpl: async () => new Response("", { status: 401 }) });
	assert.equal(outcome.status.state, "local_unconfigured");
	assert.equal(getPendingRemoteCleanup(), null);
	assert.ok(!JSON.stringify(getDeviceLinkStatus()).includes("device-secret"));
});

test("backoff prevents automatic retry until due, while a repeated disconnect safely forces an idempotent retry", async () => {
	link();
	await disconnectDeviceLink({ fetchImpl: async () => { throw new Error("timeout"); } });
	let calls = 0;
	await retryRemoteDisconnect({ fetchImpl: async () => { calls += 1; return new Response("", { status: 200 }); } });
	assert.equal(calls, 0, "automatic retry honours persisted nextAttemptAt");

	const repeated = await disconnectDeviceLink({ fetchImpl: async () => { calls += 1; return new Response("", { status: 410 }); } });
	assert.equal(calls, 1);
	assert.equal(repeated.status.state, "local_unconfigured");
	assert.equal(getPendingRemoteCleanup(), null);
});

test("403 invalid cleanup response purges credentials without an aggressive retry", async () => {
	link();
	const outcome = await disconnectDeviceLink({ fetchImpl: async () => new Response("", { status: 403 }) });
	assert.equal(outcome.status.state, "local_unconfigured");
	assert.equal(getPendingRemoteCleanup(), null);
});
