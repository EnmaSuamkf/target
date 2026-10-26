/**
 * Per-agent model allowlist: seeded enabled, replaced by PUT, custom ids, and
 * GET /api/runners filtering `models[]` to the enabled ids.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-model-settings-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
// Live discovery reads ~/.cursor and ~/.free-code: point HOME at fixtures.
process.env.HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, ".cursor"), { recursive: true });
fs.writeFileSync(
	path.join(tmpHome, ".cursor", "cli-config.json"),
	JSON.stringify({
		model: { modelId: "grok-4.6", displayName: "Grok 4.6 High Fast" },
		selectedModel: { modelId: "grok-4.6", parameters: [] },
		modelParameters: { default: [], "grok-4.5": [], "cursor-live-only": [] },
	}),
);
fs.mkdirSync(path.join(tmpHome, ".free-code", "agent"), { recursive: true });
fs.writeFileSync(
	path.join(tmpHome, ".free-code", "agent", "models.json"),
	JSON.stringify({
		providers: { acme: { models: [{ id: "model-x", name: "Model X" }] } },
	}),
);

const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
after(() => server.close());

const headers = { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };

interface View {
	settings: { runners: Record<string, { models: { id: string; label: string; source: string; enabled: boolean }[]; custom: string[] }> };
}
interface RunnersBody {
	runners: { id: string; models: { id: string; label: string; source: string }[] }[];
}

async function runnerModels(id: string) {
	const body = (await (await fetch(`${baseUrl}/api/runners`, { headers })).json()) as RunnersBody;
	return body.runners.find((r) => r.id === id)!.models;
}

test("first use: every seeded and live id is enabled, merged from all sources", async () => {
	const body = (await (await fetch(`${baseUrl}/api/settings/models`, { headers })).json()) as View;
	const claude = body.settings.runners.claude!.models;
	assert.ok(claude.every((m) => m.enabled));
	assert.ok(["opus", "sonnet", "haiku"].every((alias) => claude.some((m) => m.id === alias && m.source === "seed")));

	const cursor = body.settings.runners.cursor!.models;
	assert.equal(cursor.find((m) => m.id === "cursor-live-only")?.source, "live");
	assert.equal(cursor.find((m) => m.id === "grok-4.6")?.label, "Grok 4.6 High Fast");
	assert.equal(cursor.some((m) => m.id === "default"), false);

	assert.ok(body.settings.runners["free-code"]!.models.some((m) => m.id === "acme/model-x" && m.source === "live" && m.label === "Model X"));
	assert.ok(body.settings.runners.copilot!.models.some((m) => m.id === "gpt-5.4" && m.source === "seed"));

	const runnerModelsClaude = await runnerModels("claude");
	assert.ok(runnerModelsClaude.some((m) => m.id === "sonnet"));
});

test("PUT replaces the allowlist and runners.models keeps only enabled ids", async () => {
	const put = await fetch(`${baseUrl}/api/settings/models`, {
		method: "PUT",
		headers,
		body: JSON.stringify({ runners: { claude: { enabled: ["sonnet"], custom: [] } } }),
	});
	assert.equal(put.status, 200);
	assert.deepEqual((await runnerModels("claude")).map((m) => m.id), ["sonnet"]);

	const got = (await (await fetch(`${baseUrl}/api/settings/models`, { headers })).json()) as View;
	const claude = got.settings.runners.claude!.models;
	assert.equal(claude.find((m) => m.id === "opus")?.enabled, false);
	// A runner left out of the PUT goes back to the default: all enabled.
	assert.ok(got.settings.runners.cursor!.models.every((m) => m.enabled));
});

test("custom ids are added, enabled, and appear in runners.models as source custom", async () => {
	const put = await fetch(`${baseUrl}/api/settings/models`, {
		method: "PUT",
		headers,
		body: JSON.stringify({ runners: { copilot: { enabled: ["gpt-5.4"], custom: ["my-copilot-model"] } } }),
	});
	assert.equal(put.status, 200);
	const models = await runnerModels("copilot");
	assert.deepEqual(models.map((m) => m.id).sort(), ["gpt-5.4", "my-copilot-model"]);
	assert.equal(models.find((m) => m.id === "my-copilot-model")?.source, "custom");
});

test("PUT rejects unknown enabled ids, bad ids and unknown runners, and needs the admin token", async () => {
	const put = (body: unknown, h: Record<string, string> = headers) =>
		fetch(`${baseUrl}/api/settings/models`, { method: "PUT", headers: h, body: JSON.stringify(body) });
	assert.equal((await put({ runners: { claude: { enabled: ["not-a-model"] } } })).status, 400);
	assert.equal((await put({ runners: { claude: { custom: ["has space"] } } })).status, 400);
	assert.equal((await put({ runners: { claude: { custom: ["--evil"] } } })).status, 400);
	assert.equal((await put({ runners: { nope: {} } })).status, 400);
	assert.equal((await put({ runners: {} }, { "content-type": "application/json" })).status, 401);
});

test("context window: default shown, operator value saved, validated and used by the meter", async () => {
	const { contextWindowForModel } = await import("./models.ts");
	const put = (body: unknown) => fetch(`${baseUrl}/api/settings/models`, { method: "PUT", headers, body: JSON.stringify(body) });
	const view = async () => ((await (await fetch(`${baseUrl}/api/settings/models`, { headers })).json()) as any).settings.runners;

	const before = (await view()).claude.models.find((m: any) => m.id === "claude-sonnet-5");
	assert.equal(before.defaultWindow, 1_000_000);
	assert.equal(before.contextWindow, 1_000_000);
	assert.equal(before.windowOverridden, false);

	assert.equal((await put({ runners: { claude: { windows: { "claude-sonnet-5": 200_000 } } } })).status, 200);
	const after = (await view()).claude.models.find((m: any) => m.id === "claude-sonnet-5");
	assert.equal(after.contextWindow, 200_000);
	assert.equal(after.defaultWindow, 1_000_000);
	assert.equal(after.windowOverridden, true);

	// Per agent, and a dated id follows its base model.
	assert.equal(contextWindowForModel("claude-sonnet-5", null, "claude"), 200_000);
	assert.equal(contextWindowForModel("claude-sonnet-5-20260101", null, "claude"), 200_000);
	assert.equal(contextWindowForModel("claude-sonnet-5", null, "cursor"), 1_000_000);

	assert.equal((await put({ runners: { claude: { windows: { "claude-sonnet-5": 5 } } } })).status, 400);
	assert.equal((await put({ runners: { claude: { windows: { "claude-sonnet-5": "200k" } } } })).status, 400);
	assert.equal((await put({ runners: { claude: { windows: { nope: 200_000 } } } })).status, 400);

	// Saving without windows resets to the default.
	assert.equal((await put({ runners: { claude: {} } })).status, 200);
	assert.equal(contextWindowForModel("claude-sonnet-5", null, "claude"), 1_000_000);
});

test("cursor: the default window shown is the size the Cursor CLI is configured for", async () => {
	fs.writeFileSync(
		path.join(tmpHome, ".cursor", "cli-config.json"),
		JSON.stringify({ modelParameters: { "gpt-5.6-sol": [{ id: "context", value: "272k" }] } }),
	);
	const view = ((await (await fetch(`${baseUrl}/api/settings/models`, { headers })).json()) as any).settings.runners;
	const sol = view.cursor.models.find((m: any) => m.id === "gpt-5.6-sol");
	assert.equal(sol.defaultWindow, 272_000);
	assert.equal(sol.contextWindow, 272_000);
});
