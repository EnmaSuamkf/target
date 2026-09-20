/**
 * API tests for Slack delivery credentials
 * (GET/PUT /api/settings/notifications/slack-credentials)
 * and POST /api/settings/notifications/test.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-slack-delivery-api-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { getSlackDeliverySettings, saveNotificationSettings } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { _impl, sendTestNotification } = await import("./notifier.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
const route = "/api/settings/notifications/slack-credentials";
const testRoute = "/api/settings/notifications/test";

test.after(() => {
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

interface PublicSlackDeliveryBody {
	settings: {
		xoxcConfigured: boolean;
		xoxdConfigured: boolean;
		updatedAt: string | null;
		envConfigured: boolean;
		xoxc?: string;
		xoxd?: string;
	};
}

const SLACK_ENV_KEYS = [
	"TARGET_SLACK_XOXC_TOKEN",
	"TARGET_SLACK_XOXD_TOKEN",
	"SLACK_MCP_XOXC_TOKEN",
	"SLACK_MCP_XOXD_TOKEN",
	"SLACK_XOXC_TOKEN",
	"SLACK_XOXD_TOKEN",
] as const;

function clearSlackEnv(): Record<string, string | undefined> {
	const prev: Record<string, string | undefined> = {};
	for (const key of SLACK_ENV_KEYS) {
		prev[key] = process.env[key];
		delete process.env[key];
	}
	return prev;
}

function restoreSlackEnv(prev: Record<string, string | undefined>): void {
	for (const key of SLACK_ENV_KEYS) {
		const value = prev[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

test("GET /api/settings/notifications/slack-credentials without admin never returns raw tokens", async () => {
	const prev = clearSlackEnv();
	try {
		process.env.TARGET_SLACK_XOXC_TOKEN = "xoxc-env-secret";
		process.env.TARGET_SLACK_XOXD_TOKEN = "xoxd-env-secret";
		// Global API gate: unauthenticated requests never reach the handler, so
		// secrets cannot cross the wire. (Admin GET is the only path that includes them.)
		const res = await fetch(`${baseUrl}${route}`);
		assert.equal(res.status, 401);
		const body = (await res.json()) as { error?: string; settings?: PublicSlackDeliveryBody["settings"] };
		assert.equal(body.error, "login_required");
		assert.equal(body.settings, undefined);
		const raw = JSON.stringify(body);
		assert.equal(raw.includes("xoxc-env-secret"), false);
		assert.equal(raw.includes("xoxd-env-secret"), false);
	} finally {
		restoreSlackEnv(prev);
	}
});

test("GET /api/settings/notifications/slack-credentials with admin returns effective xoxc/xoxd", async () => {
	const prev = clearSlackEnv();
	try {
		process.env.TARGET_SLACK_XOXC_TOKEN = "xoxc-env-secret";
		process.env.TARGET_SLACK_XOXD_TOKEN = "xoxd-env-secret";
		const res = await fetch(`${baseUrl}${route}`, { headers: adminHeaders() });
		assert.equal(res.status, 200);
		const body = (await res.json()) as PublicSlackDeliveryBody;
		assert.equal(body.settings.xoxcConfigured, true);
		assert.equal(body.settings.xoxdConfigured, true);
		assert.equal(body.settings.envConfigured, true);
		assert.equal(body.settings.xoxc, "xoxc-env-secret");
		assert.equal(body.settings.xoxd, "xoxd-env-secret");
	} finally {
		restoreSlackEnv(prev);
	}
});

test("PUT /api/settings/notifications/slack-credentials requires an admin token", async () => {
	const res = await fetch(`${baseUrl}${route}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ xoxc: "xoxc-nope", xoxd: "xoxd-nope" }),
	});
	assert.equal(res.status, 401);
});

test("PUT persists tokens; PUT response stays flags-only; admin GET returns secrets", async () => {
	const putRes = await fetch(`${baseUrl}${route}`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ xoxc: "xoxc-saved-secret", xoxd: "xoxd-saved-secret" }),
	});
	assert.equal(putRes.status, 200);
	const putBody = (await putRes.json()) as PublicSlackDeliveryBody;
	assert.equal(putBody.settings.xoxcConfigured, true);
	assert.equal(putBody.settings.xoxdConfigured, true);
	assert.equal(putBody.settings.envConfigured, false);
	assert.ok(putBody.settings.updatedAt);
	assert.equal("xoxc" in putBody.settings, false);
	assert.equal("xoxd" in putBody.settings, false);
	assert.equal(JSON.stringify(putBody).includes("xoxc-saved-secret"), false);
	assert.equal(JSON.stringify(putBody).includes("xoxd-saved-secret"), false);

	const adminGet = await fetch(`${baseUrl}${route}`, { headers: adminHeaders() });
	const adminBody = (await adminGet.json()) as PublicSlackDeliveryBody;
	assert.equal(adminBody.settings.xoxcConfigured, true);
	assert.equal(adminBody.settings.xoxdConfigured, true);
	assert.equal(adminBody.settings.xoxc, "xoxc-saved-secret");
	assert.equal(adminBody.settings.xoxd, "xoxd-saved-secret");

	const stored = getSlackDeliverySettings();
	assert.equal(stored.xoxcToken, "xoxc-saved-secret");
	assert.equal(stored.xoxdToken, "xoxd-saved-secret");
});

test("PUT keeps the stored token when the client sends a blank field", async () => {
	await fetch(`${baseUrl}${route}`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ xoxc: "xoxc-keep", xoxd: "xoxd-keep" }),
	});
	const res = await fetch(`${baseUrl}${route}`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ xoxc: "xoxc-updated", xoxd: "" }),
	});
	assert.equal(res.status, 200);
	const stored = getSlackDeliverySettings();
	assert.equal(stored.xoxcToken, "xoxc-updated");
	assert.equal(stored.xoxdToken, "xoxd-keep");
});

test("POST /api/settings/notifications/test requires an admin token", async () => {
	const res = await fetch(`${baseUrl}${testRoute}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username: "ada" }),
	});
	assert.equal(res.status, 401);
});

test("POST /api/settings/notifications/test returns sent:true via mocked _impl", async (t) => {
	const originalDetect = _impl.detect;
	const originalSend = _impl.send;
	t.after(() => {
		_impl.detect = originalDetect;
		_impl.send = originalSend;
	});
	const sent: { username: string; message: string }[] = [];
	_impl.detect = () => [{ xoxc: "xoxc-test", xoxd: "xoxd-test" }];
	_impl.send = async (_transport, username, message) => {
		sent.push({ username, message });
	};

	const res = await fetch(`${baseUrl}${testRoute}`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ username: "ada-draft" }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { sent: boolean; reason?: string };
	assert.deepEqual(body, { sent: true });
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.username, "ada-draft");
	assert.match(sent[0]!.message, /Slack connection test succeeded/);
});

test("POST /api/settings/notifications/test returns sent:false with reason/detail under mocked _impl", async (t) => {
	const originalDetect = _impl.detect;
	const originalSend = _impl.send;
	t.after(() => {
		_impl.detect = originalDetect;
		_impl.send = originalSend;
	});
	_impl.detect = () => [{ xoxc: "xoxc-test", xoxd: "xoxd-test" }];
	_impl.send = async () => {
		throw new Error("chat.postMessage: channel_not_found");
	};

	const res = await fetch(`${baseUrl}${testRoute}`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ username: "ada" }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { sent: boolean; reason?: string; detail?: string };
	assert.equal(body.sent, false);
	assert.equal(body.reason, "send-failed");
	assert.equal(body.detail, "chat.postMessage: channel_not_found");
});

test("POST /api/settings/notifications/test returns no-transport as sent:false (not 500)", async (t) => {
	const originalDetect = _impl.detect;
	const originalSend = _impl.send;
	t.after(() => {
		_impl.detect = originalDetect;
		_impl.send = originalSend;
	});
	_impl.detect = () => [];
	_impl.send = async () => {
		throw new Error("should not be called");
	};

	const res = await fetch(`${baseUrl}${testRoute}`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ username: "ada" }),
	});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { sent: false, reason: "no-transport" });
});

test("sendTestNotification bypasses enabled and uses saved username when arg omitted", async (t) => {
	saveNotificationSettings({ enabled: false, channels: { slack: { username: "saved-user" } } });
	const originalDetect = _impl.detect;
	const originalSend = _impl.send;
	t.after(() => {
		_impl.detect = originalDetect;
		_impl.send = originalSend;
	});
	const sent: string[] = [];
	_impl.detect = () => [{ xoxc: "xoxc-a", xoxd: "xoxd-b" }];
	_impl.send = async (_t, username) => {
		sent.push(username);
	};

	const result = await sendTestNotification();
	assert.deepEqual(result, { sent: true });
	assert.deepEqual(sent, ["saved-user"]);
});
