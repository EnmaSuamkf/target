/**
 * API tests for Slack delivery credentials
 * (GET/PUT /api/settings/notifications/slack-credentials).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-slack-delivery-api-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { getSlackDeliverySettings } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
const route = "/api/settings/notifications/slack-credentials";

test.after(() => {
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

interface SlackDeliveryBody {
	settings: {
		xoxcConfigured: boolean;
		xoxdConfigured: boolean;
		updatedAt: string | null;
		envConfigured: boolean;
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

test("GET /api/settings/notifications/slack-credentials never returns raw tokens", async () => {
	const prev = clearSlackEnv();
	try {
		process.env.TARGET_SLACK_XOXC_TOKEN = "xoxc-env-secret";
		process.env.TARGET_SLACK_XOXD_TOKEN = "xoxd-env-secret";
		const res = await fetch(`${baseUrl}${route}`, { headers: adminHeaders() });
		assert.equal(res.status, 200);
		const body = (await res.json()) as SlackDeliveryBody;
		assert.equal(body.settings.xoxcConfigured, true);
		assert.equal(body.settings.xoxdConfigured, true);
		assert.equal(body.settings.envConfigured, true);
		assert.equal(body.settings.updatedAt, null);
		const raw = JSON.stringify(body);
		assert.equal(raw.includes("xoxc-env-secret"), false);
		assert.equal(raw.includes("xoxd-env-secret"), false);
		assert.equal("xoxcToken" in body.settings, false);
		assert.equal("xoxdToken" in body.settings, false);
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

test("PUT persists tokens and GET returns only configured flags", async () => {
	const putRes = await fetch(`${baseUrl}${route}`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ xoxc: "xoxc-saved-secret", xoxd: "xoxd-saved-secret" }),
	});
	assert.equal(putRes.status, 200);
	const putBody = (await putRes.json()) as SlackDeliveryBody;
	assert.equal(putBody.settings.xoxcConfigured, true);
	assert.equal(putBody.settings.xoxdConfigured, true);
	assert.equal(putBody.settings.envConfigured, false);
	assert.ok(putBody.settings.updatedAt);
	assert.equal(JSON.stringify(putBody).includes("xoxc-saved-secret"), false);
	assert.equal(JSON.stringify(putBody).includes("xoxd-saved-secret"), false);

	const getRes = await fetch(`${baseUrl}${route}`, { headers: adminHeaders() });
	const getBody = (await getRes.json()) as SlackDeliveryBody;
	assert.deepEqual(getBody.settings, putBody.settings);

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
