/**
 * Tests for activity-reporting preferences: storage in db.ts and the two routes
 * the Settings view uses (GET/PUT /api/settings/report).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-report-settings-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { getReportSettings, saveReportSettings, toPublicReportSettings } = await import("./db.ts");
const { loadConfig, loadReportConfig, loadReportConfigFromEnv } = await import("./config.ts");
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

interface ReportSettingsBody {
	settings: {
		enabled: boolean;
		url: string;
		tokenConfigured: boolean;
		intervalMs: number;
		includeConversations: string;
		updatedAt: string | null;
		envConfigured: boolean;
	};
}

test("getReportSettings on a fresh hub reports reporting off and nothing configured", () => {
	const settings = getReportSettings();
	assert.equal(settings.enabled, false);
	assert.equal(settings.url, "");
	assert.equal(settings.token, "");
	assert.equal(settings.updatedAt, null);
});

test("loadReportConfigFromEnv parses the environment", () => {
	const prevUrl = process.env.TARGET_REPORT_URL;
	const prevTok = process.env.TARGET_REPORT_TOKEN;
	const prevEn = process.env.TARGET_REPORT_ENABLED;
	const prevInt = process.env.TARGET_REPORT_INTERVAL_MS;
	const prevMode = process.env.TARGET_REPORT_INCLUDE_CONVERSATIONS;
	process.env.TARGET_REPORT_URL = "https://x.example/report";
	process.env.TARGET_REPORT_TOKEN = "tok";
	process.env.TARGET_REPORT_ENABLED = "true";
	process.env.TARGET_REPORT_INTERVAL_MS = "5000";
	process.env.TARGET_REPORT_INCLUDE_CONVERSATIONS = "full";
	const envCfg = loadReportConfigFromEnv();
	assert.equal(envCfg.enabled, true);
	assert.equal(envCfg.url, "https://x.example/report");
	assert.equal(envCfg.intervalMs, 5000);
	assert.equal(envCfg.includeConversations, "full");
	delete process.env.TARGET_REPORT_URL;
	assert.equal(loadReportConfigFromEnv().enabled, false);
	if (prevUrl === undefined) delete process.env.TARGET_REPORT_URL;
	else process.env.TARGET_REPORT_URL = prevUrl;
	if (prevTok === undefined) delete process.env.TARGET_REPORT_TOKEN;
	else process.env.TARGET_REPORT_TOKEN = prevTok;
	if (prevEn === undefined) delete process.env.TARGET_REPORT_ENABLED;
	else process.env.TARGET_REPORT_ENABLED = prevEn;
	if (prevInt === undefined) delete process.env.TARGET_REPORT_INTERVAL_MS;
	else process.env.TARGET_REPORT_INTERVAL_MS = prevInt;
	if (prevMode === undefined) delete process.env.TARGET_REPORT_INCLUDE_CONVERSATIONS;
	else process.env.TARGET_REPORT_INCLUDE_CONVERSATIONS = prevMode;
});

test("loadReportConfig falls back to the environment until settings are saved", () => {
	const prevUrl = process.env.TARGET_REPORT_URL;
	const prevTok = process.env.TARGET_REPORT_TOKEN;
	const prevEn = process.env.TARGET_REPORT_ENABLED;
	process.env.TARGET_REPORT_URL = "https://env-only.example/ingest";
	process.env.TARGET_REPORT_TOKEN = "env-only";
	process.env.TARGET_REPORT_ENABLED = "true";
	const effective = loadReportConfig();
	assert.equal(effective.url, "https://env-only.example/ingest");
	assert.equal(effective.token, "env-only");
	assert.equal(effective.enabled, true);
	if (prevUrl === undefined) delete process.env.TARGET_REPORT_URL;
	else process.env.TARGET_REPORT_URL = prevUrl;
	if (prevTok === undefined) delete process.env.TARGET_REPORT_TOKEN;
	else process.env.TARGET_REPORT_TOKEN = prevTok;
	if (prevEn === undefined) delete process.env.TARGET_REPORT_ENABLED;
	else process.env.TARGET_REPORT_ENABLED = prevEn;
});

test("GET /api/settings/report reflects .env when nothing was saved yet", async () => {
	const prevUrl = process.env.TARGET_REPORT_URL;
	const prevTok = process.env.TARGET_REPORT_TOKEN;
	process.env.TARGET_REPORT_URL = "https://get-env.example/ingest";
	process.env.TARGET_REPORT_TOKEN = "tok";
	const res = await fetch(`${baseUrl}/api/settings/report`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as ReportSettingsBody;
	assert.equal(body.settings.url, "https://get-env.example/ingest");
	assert.equal(body.settings.tokenConfigured, true);
	assert.equal(body.settings.envConfigured, true);
	assert.equal(body.settings.updatedAt, null);
	if (prevUrl === undefined) delete process.env.TARGET_REPORT_URL;
	else process.env.TARGET_REPORT_URL = prevUrl;
	if (prevTok === undefined) delete process.env.TARGET_REPORT_TOKEN;
	else process.env.TARGET_REPORT_TOKEN = prevTok;
});

test("saveReportSettings persists the URL and token without returning the secret", () => {
	const saved = saveReportSettings({
		enabled: true,
		url: "  https://ingest.example.com/  ",
		token: "  secret-tok  ",
		intervalMs: 15_000,
		includeConversations: "full",
	});
	assert.equal(saved.enabled, true);
	assert.equal(saved.url, "https://ingest.example.com/");
	assert.equal(saved.token, "secret-tok");
	assert.equal(saved.intervalMs, 15_000);
	assert.equal(saved.includeConversations, "full");
	assert.ok(saved.updatedAt);

	const pub = toPublicReportSettings(saved, false);
	assert.equal(pub.tokenConfigured, true);
	assert.equal("token" in pub, false);

	assert.deepEqual(getReportSettings(), saved);
});

test("loadReportConfig uses saved settings instead of the environment", () => {
	const prevUrl = process.env.TARGET_REPORT_URL;
	process.env.TARGET_REPORT_URL = "https://env.example/ingest";
	saveReportSettings({
		enabled: true,
		url: "https://db.example/ingest",
		token: "db-tok",
		intervalMs: 20_000,
		includeConversations: "off",
	});
	const effective = loadReportConfig();
	assert.equal(effective.url, "https://db.example/ingest");
	assert.equal(effective.token, "db-tok");
	assert.equal(effective.enabled, true);
	assert.equal(effective.intervalMs, 20_000);
	assert.equal(effective.includeConversations, "off");
	if (prevUrl === undefined) delete process.env.TARGET_REPORT_URL;
	else process.env.TARGET_REPORT_URL = prevUrl;
});

test("PUT /api/settings/report requires an admin token", async () => {
	const res = await fetch(`${baseUrl}/api/settings/report`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			enabled: true,
			url: "https://x.example/ingest",
			intervalMs: 30_000,
			includeConversations: "digest",
		}),
	});
	assert.equal(res.status, 401);
});

test("PUT /api/settings/report rejects enabling reporting with an empty URL", async () => {
	const res = await fetch(`${baseUrl}/api/settings/report`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			enabled: true,
			url: "   ",
			intervalMs: 30_000,
			includeConversations: "digest",
		}),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /report server URL is required/);
});

test("PUT /api/settings/report saves and a later GET reads back without the token", async () => {
	const putRes = await fetch(`${baseUrl}/api/settings/report`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			enabled: true,
			url: "https://saved.example/ingest",
			token: "my-secret",
			intervalMs: 45_000,
			includeConversations: "digest",
		}),
	});
	assert.equal(putRes.status, 200);
	const put = (await putRes.json()) as ReportSettingsBody;
	assert.equal(put.settings.enabled, true);
	assert.equal(put.settings.url, "https://saved.example/ingest");
	assert.equal(put.settings.tokenConfigured, true);
	assert.equal(put.settings.envConfigured, false);
	assert.equal(put.settings.intervalMs, 45_000);

	const getRes = await fetch(`${baseUrl}/api/settings/report`, { headers: adminHeaders() });
	const got = (await getRes.json()) as ReportSettingsBody;
	assert.deepEqual(got.settings, put.settings);
	assert.equal(loadReportConfig().url, "https://saved.example/ingest");
});

test("PUT /api/settings/report keeps the stored token when the client omits it", async () => {
	await fetch(`${baseUrl}/api/settings/report`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			enabled: true,
			url: "https://token-keep.example/ingest",
			token: "first-secret",
			intervalMs: 30_000,
			includeConversations: "digest",
		}),
	});

	const res = await fetch(`${baseUrl}/api/settings/report`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			enabled: false,
			url: "https://token-keep.example/ingest",
			intervalMs: 30_000,
			includeConversations: "digest",
		}),
	});
	assert.equal(res.status, 200);
	assert.equal(getReportSettings().token, "first-secret");
});

test("an unsupported method on /api/settings/report is a 404", async () => {
	const res = await fetch(`${baseUrl}/api/settings/report`, { method: "DELETE", headers: adminHeaders() });
	assert.equal(res.status, 404);
});
