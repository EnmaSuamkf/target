/**
 * Docker-friendly hub networking Settings: DB first-save semantics, Settings-vs-env
 * precedence in dockerFriendlyHubEnabled, and GET/PUT /api/settings/docker-friendly.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { HubConfig } from "./config.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-docker-friendly-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
fs.mkdirSync(tmpHome, { recursive: true });
fs.writeFileSync(path.join(tmpHome, ".env"), "# docker-friendly-settings.test isolation\n");
delete process.env.TARGET_HUB_DOCKER_FRIENDLY;

const {
	getDockerFriendlySettings,
	saveDockerFriendlySettings,
} = await import("./db.ts");
const {
	dockerFriendlyHubEnabled,
	loadConfig,
	syncDockerFriendlyNetworking,
	DOCKER_FRIENDLY_HOST,
	LOOPBACK_HOST,
} = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
const route = "/api/settings/docker-friendly";

test.after(() => {
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

function withEnv(value: string | undefined, fn: () => void): void {
	const prev = process.env.TARGET_HUB_DOCKER_FRIENDLY;
	if (value === undefined) delete process.env.TARGET_HUB_DOCKER_FRIENDLY;
	else process.env.TARGET_HUB_DOCKER_FRIENDLY = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.TARGET_HUB_DOCKER_FRIENDLY;
		else process.env.TARGET_HUB_DOCKER_FRIENDLY = prev;
	}
}

function baseCfg(): HubConfig {
	return {
		host: LOOPBACK_HOST,
		port: 8893,
		adminToken: "t",
		stepTimeoutMs: 1,
		stepIdleTimeoutMs: 1,
		stepIdleWarnMs: 1,
		stepHardTimeoutMs: 1,
		progressProbeThrottleMs: 1,
		queuedTimeoutMs: 1,
		maxInputBytes: 1,
	};
}

test("getDockerFriendlySettings on a fresh hub has enabled=false and null updatedAt", () => {
	const settings = getDockerFriendlySettings();
	assert.equal(settings.dockerFriendlyHub, false);
	assert.equal(settings.updatedAt, null);
});

test("env fallback: TARGET_HUB_DOCKER_FRIENDLY=true enables until Settings are saved", () => {
	assert.equal(getDockerFriendlySettings().updatedAt, null);
	withEnv("true", () => {
		assert.equal(dockerFriendlyHubEnabled(), true);
		const { cfg } = syncDockerFriendlyNetworking(baseCfg(), {});
		assert.equal(cfg.host, DOCKER_FRIENDLY_HOST);
	});
	withEnv(undefined, () => {
		assert.equal(dockerFriendlyHubEnabled(), false);
		const { cfg } = syncDockerFriendlyNetworking(baseCfg(), {});
		assert.equal(cfg.host, LOOPBACK_HOST);
	});
});

test("Settings-on wins over env=false and applies docker-friendly host", () => {
	saveDockerFriendlySettings({ dockerFriendlyHub: true });
	assert.ok(getDockerFriendlySettings().updatedAt);
	withEnv("false", () => {
		assert.equal(dockerFriendlyHubEnabled(), true);
		const { cfg } = syncDockerFriendlyNetworking(baseCfg(), {});
		assert.equal(cfg.host, DOCKER_FRIENDLY_HOST);
	});
});

test("Settings-off wins over env=true and keeps loopback", () => {
	saveDockerFriendlySettings({ dockerFriendlyHub: false });
	withEnv("true", () => {
		assert.equal(dockerFriendlyHubEnabled(), false);
		const { cfg } = syncDockerFriendlyNetworking(baseCfg(), {});
		assert.equal(cfg.host, LOOPBACK_HOST);
	});
});

test("GET /api/settings/docker-friendly returns the stored preference", async () => {
	saveDockerFriendlySettings({ dockerFriendlyHub: true });
	const res = await fetch(`${baseUrl}${route}`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		settings: { dockerFriendlyHub: boolean; updatedAt: string | null };
	};
	assert.equal(body.settings.dockerFriendlyHub, true);
	assert.ok(body.settings.updatedAt);
});

test("PUT /api/settings/docker-friendly requires an admin token", async () => {
	const res = await fetch(`${baseUrl}${route}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ dockerFriendlyHub: true }),
	});
	assert.equal(res.status, 401);
});

test("PUT persists and a later GET reads back", async () => {
	const put = await fetch(`${baseUrl}${route}`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ dockerFriendlyHub: false }),
	});
	assert.equal(put.status, 200);
	const putBody = (await put.json()) as {
		settings: { dockerFriendlyHub: boolean; updatedAt: string | null };
	};
	assert.equal(putBody.settings.dockerFriendlyHub, false);
	assert.ok(putBody.settings.updatedAt);

	const get = await fetch(`${baseUrl}${route}`, { headers: adminHeaders() });
	const getBody = (await get.json()) as {
		settings: { dockerFriendlyHub: boolean; updatedAt: string | null };
	};
	assert.deepEqual(getBody.settings, putBody.settings);
	assert.equal(getDockerFriendlySettings().dockerFriendlyHub, false);
});
