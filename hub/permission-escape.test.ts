/**
 * D5: without client.workflows.manage, the local escape hatches stay locked.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-permission-escape-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { loadConfig } = await import("./config.ts");
const {
	activateDeviceCredential,
	beginDeviceLink,
	deleteDeviceLink,
	getDeviceLinkStatus,
} = await import("./device-link.ts");
const { recordOwnerSnapshot } = await import("./owner-permissions.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

const ORIGIN = "https://server.example";

function headers(): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

function linkAndGrant(permissions: string[]): void {
	deleteDeviceLink();
	beginDeviceLink({ origin: ORIGIN, deviceName: "escape" });
	activateDeviceCredential({
		deviceId: "dev_escape",
		deviceSecret: "secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
	recordOwnerSnapshot({ id: "owner_escape", permissions, granted: { groups: [] } }, "dev_escape", ORIGIN);
}

test("without manage, PUT /api/settings/sync and DELETE /api/device-link are 403", async () => {
	linkAndGrant(["client.read", "client.workflows.execute"]);
	assert.equal(getDeviceLinkStatus().state, "connected");

	const syncRes = await fetch(`${baseUrl}/api/settings/sync`, {
		method: "PUT",
		headers: headers(),
		body: JSON.stringify({ enabled: false }),
	});
	assert.equal(syncRes.status, 403);
	const syncBody = (await syncRes.json()) as { error: string; permission: string };
	assert.equal(syncBody.error, "forbidden");
	assert.equal(syncBody.permission, "client.workflows.manage");

	const unlinkRes = await fetch(`${baseUrl}/api/device-link`, {
		method: "DELETE",
		headers: headers(),
	});
	assert.equal(unlinkRes.status, 403);
	const unlinkBody = (await unlinkRes.json()) as { error: string; permission: string };
	assert.equal(unlinkBody.error, "forbidden");
	assert.equal(unlinkBody.permission, "client.workflows.manage");
	assert.equal(getDeviceLinkStatus().state, "connected");
});

test("with manage, both escape hatches answer 2xx", async () => {
	linkAndGrant(["client.read", "client.workflows.manage"]);

	const syncRes = await fetch(`${baseUrl}/api/settings/sync`, {
		method: "PUT",
		headers: headers(),
		body: JSON.stringify({ enabled: true }),
	});
	assert.equal(syncRes.status, 200);

	const unlinkRes = await fetch(`${baseUrl}/api/device-link`, {
		method: "DELETE",
		headers: headers(),
	});
	assert.ok(unlinkRes.status >= 200 && unlinkRes.status < 300);
});
