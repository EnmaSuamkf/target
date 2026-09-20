/**
 * Tests for Slack delivery credentials: storage in db.ts and Settings-vs-env
 * precedence in loadSlackDeliveryTokens (mirrors report-settings.test.ts).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-slack-delivery-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const {
	getSlackDeliverySettings,
	saveSlackDeliverySettings,
	toPublicSlackDeliverySettings,
} = await import("./db.ts");
const { loadSlackDeliveryTokens, loadSlackDeliveryTokensFromEnv } = await import("./config.ts");

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

test("getSlackDeliverySettings on a fresh hub has empty tokens and null updatedAt", () => {
	const settings = getSlackDeliverySettings();
	assert.equal(settings.xoxcToken, "");
	assert.equal(settings.xoxdToken, "");
	assert.equal(settings.updatedAt, null);
});

test("loadSlackDeliveryTokensFromEnv parses TARGET_SLACK_* (and aliases)", () => {
	const prev = clearSlackEnv();
	try {
		process.env.TARGET_SLACK_XOXC_TOKEN = "xoxc-from-target";
		process.env.TARGET_SLACK_XOXD_TOKEN = "xoxd-from-target";
		assert.deepEqual(loadSlackDeliveryTokensFromEnv(), {
			xoxc: "xoxc-from-target",
			xoxd: "xoxd-from-target",
		});

		delete process.env.TARGET_SLACK_XOXC_TOKEN;
		delete process.env.TARGET_SLACK_XOXD_TOKEN;
		process.env.SLACK_MCP_XOXC_TOKEN = "xoxc-mcp";
		process.env.SLACK_MCP_XOXD_TOKEN = "xoxd-mcp";
		assert.deepEqual(loadSlackDeliveryTokensFromEnv(), { xoxc: "xoxc-mcp", xoxd: "xoxd-mcp" });

		delete process.env.SLACK_MCP_XOXC_TOKEN;
		delete process.env.SLACK_MCP_XOXD_TOKEN;
		process.env.SLACK_XOXC_TOKEN = "xoxc-bare";
		process.env.SLACK_XOXD_TOKEN = "xoxd-bare";
		assert.deepEqual(loadSlackDeliveryTokensFromEnv(), { xoxc: "xoxc-bare", xoxd: "xoxd-bare" });

		clearSlackEnv();
		assert.deepEqual(loadSlackDeliveryTokensFromEnv(), { xoxc: "", xoxd: "" });
	} finally {
		restoreSlackEnv(prev);
	}
});

test("loadSlackDeliveryTokens falls back to the environment until settings are saved", () => {
	const prev = clearSlackEnv();
	try {
		process.env.TARGET_SLACK_XOXC_TOKEN = "xoxc-env-only";
		process.env.TARGET_SLACK_XOXD_TOKEN = "xoxd-env-only";
		assert.equal(getSlackDeliverySettings().updatedAt, null);
		const effective = loadSlackDeliveryTokens();
		assert.equal(effective.xoxc, "xoxc-env-only");
		assert.equal(effective.xoxd, "xoxd-env-only");
	} finally {
		restoreSlackEnv(prev);
	}
});

test("saveSlackDeliverySettings persists tokens; public getter never leaks them", () => {
	const saved = saveSlackDeliverySettings({
		xoxcToken: "  xoxc-secret  ",
		xoxdToken: "  xoxd-secret  ",
	});
	assert.equal(saved.xoxcToken, "xoxc-secret");
	assert.equal(saved.xoxdToken, "xoxd-secret");
	assert.ok(saved.updatedAt);

	const pub = toPublicSlackDeliverySettings(saved, false);
	assert.equal(pub.xoxcConfigured, true);
	assert.equal(pub.xoxdConfigured, true);
	assert.equal(pub.envConfigured, false);
	assert.equal("xoxcToken" in pub, false);
	assert.equal("xoxdToken" in pub, false);
	assert.equal(JSON.stringify(pub).includes("xoxc-secret"), false);
	assert.equal(JSON.stringify(pub).includes("xoxd-secret"), false);

	assert.deepEqual(getSlackDeliverySettings(), saved);
});

test("loadSlackDeliveryTokens uses saved settings instead of the environment", () => {
	const prev = clearSlackEnv();
	try {
		process.env.TARGET_SLACK_XOXC_TOKEN = "xoxc-env";
		process.env.TARGET_SLACK_XOXD_TOKEN = "xoxd-env";
		saveSlackDeliverySettings({
			xoxcToken: "xoxc-db",
			xoxdToken: "xoxd-db",
		});
		const effective = loadSlackDeliveryTokens();
		assert.equal(effective.xoxc, "xoxc-db");
		assert.equal(effective.xoxd, "xoxd-db");
	} finally {
		restoreSlackEnv(prev);
	}
});

test("saveSlackDeliverySettings keeps a previous secret when the field is empty", () => {
	saveSlackDeliverySettings({
		xoxcToken: "xoxc-keep",
		xoxdToken: "xoxd-keep",
	});
	const updated = saveSlackDeliverySettings({
		xoxcToken: "xoxc-new",
		xoxdToken: "",
	});
	assert.equal(updated.xoxcToken, "xoxc-new");
	assert.equal(updated.xoxdToken, "xoxd-keep");

	const omitted = saveSlackDeliverySettings({ xoxcToken: "   " });
	assert.equal(omitted.xoxcToken, "xoxc-new");
	assert.equal(omitted.xoxdToken, "xoxd-keep");
});
