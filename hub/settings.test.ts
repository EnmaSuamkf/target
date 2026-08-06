/**
 * Tests for the notification preferences: the storage layer in db.ts and the
 * two routes the Settings view uses (GET/PUT /api/settings/notifications).
 *
 * The preferences are one master switch plus the per-channel config it gates
 * (Slack only, so far), so what's worth pinning down is the round-trip, the
 * admin gate on the write, and the refusal to store "enabled with nowhere to
 * deliver".
 *
 * Same throwaway-TARGET_HOME convention as workflow.test.ts/templates.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-settings-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;

const { getNotificationSettings, saveNotificationSettings } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

interface SettingsBody {
	settings: { enabled: boolean; channels: { slack: { username: string } }; updatedAt: string | null };
}

test("getNotificationSettings on a fresh hub reports notifications off and nothing configured", () => {
	const settings = getNotificationSettings();
	assert.equal(settings.enabled, false);
	assert.equal(settings.channels.slack.username, "");
	assert.equal(settings.updatedAt, null);
});

test("saveNotificationSettings persists the switch and the Slack username, trimmed", () => {
	const saved = saveNotificationSettings({ enabled: true, channels: { slack: { username: "  @ada  " } } });
	assert.equal(saved.enabled, true);
	assert.equal(saved.channels.slack.username, "@ada");
	assert.ok(saved.updatedAt);

	// Read back through a fresh query, not the returned object.
	assert.deepEqual(getNotificationSettings(), saved);
});

test("saveNotificationSettings replaces the previous row instead of adding a second one", () => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "first" } } });
	const second = saveNotificationSettings({ enabled: false, channels: { slack: { username: "second" } } });
	assert.deepEqual(getNotificationSettings(), second);
	assert.equal(second.channels.slack.username, "second");
	assert.equal(second.enabled, false);
});

test("GET /api/settings/notifications needs no admin token and returns the stored preferences", async () => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "grace" } } });

	const res = await fetch(`${baseUrl}/api/settings/notifications`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as SettingsBody;
	assert.equal(body.settings.enabled, true);
	assert.equal(body.settings.channels.slack.username, "grace");
});

test("PUT /api/settings/notifications requires an admin token", async () => {
	const res = await fetch(`${baseUrl}/api/settings/notifications`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: true, channels: { slack: { username: "nope" } } }),
	});
	assert.equal(res.status, 401);
	const body = (await res.json()) as { error: string };
	// No session and no token → the access gate answers before the route does.
	assert.equal(body.error, "login_required");
});

test("PUT /api/settings/notifications saves the preferences and a later GET reads them back", async () => {
	const putRes = await fetch(`${baseUrl}/api/settings/notifications`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ enabled: true, channels: { slack: { username: "alan.turing" } } }),
	});
	assert.equal(putRes.status, 200);
	const put = (await putRes.json()) as SettingsBody;
	assert.equal(put.settings.enabled, true);
	assert.equal(put.settings.channels.slack.username, "alan.turing");

	const getRes = await fetch(`${baseUrl}/api/settings/notifications`, { headers: adminHeaders() });
	const got = (await getRes.json()) as SettingsBody;
	assert.deepEqual(got.settings, put.settings);
});

test("PUT /api/settings/notifications rejects enabling notifications with an empty Slack username", async () => {
	await fetch(`${baseUrl}/api/settings/notifications`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ enabled: false, channels: { slack: { username: "kept" } } }),
	});

	const res = await fetch(`${baseUrl}/api/settings/notifications`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ enabled: true, channels: { slack: { username: "   " } } }),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /slack username is required/);

	// Nothing was stored: the previous state is intact.
	const got = (await (await fetch(`${baseUrl}/api/settings/notifications`, { headers: adminHeaders() })).json()) as SettingsBody;
	assert.equal(got.settings.enabled, false);
	assert.equal(got.settings.channels.slack.username, "kept");
});

test("PUT /api/settings/notifications without a channels field keeps the configured username", async () => {
	await fetch(`${baseUrl}/api/settings/notifications`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ enabled: true, channels: { slack: { username: "ada" } } }),
	});

	const res = await fetch(`${baseUrl}/api/settings/notifications`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ enabled: false }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as SettingsBody;
	assert.equal(body.settings.enabled, false);
	assert.equal(body.settings.channels.slack.username, "ada");
});

test("an unsupported method on /api/settings/notifications is a 404", async () => {
	const res = await fetch(`${baseUrl}/api/settings/notifications`, { method: "DELETE", headers: adminHeaders() });
	assert.equal(res.status, 404);
});
