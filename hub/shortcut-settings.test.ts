/**
 * Tests for the keyboard-shortcut bindings: the storage layer in db.ts and the
 * two routes the Settings view uses (GET/PUT /api/settings/shortcuts).
 *
 * The bindings are one key (a single a–z letter) per action — focus the first
 * workflow, toggle dictation, open the create-workflow modal — so what's worth
 * pinning down is the round-trip, the per-action default fallback, the admin
 * gate on the write, and the refusal to store two actions on the same key.
 *
 * Same throwaway-TARGET_HOME convention as settings.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-shortcuts-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { getShortcutSettings, saveShortcutSettings, defaultShortcutSettings } = await import("./db.ts");
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

interface ShortcutSettingsBody {
	settings: {
		bindings: { focusWorkflow: { key: string }; toggleDictation: { key: string }; createWorkflow: { key: string } };
		updatedAt: string | null;
	};
}

test("getShortcutSettings on a fresh hub reports the default W/R/N bindings and no save stamp", () => {
	const settings = getShortcutSettings();
	assert.deepEqual(settings.bindings, {
		focusWorkflow: { key: "w" },
		toggleDictation: { key: "r" },
		createWorkflow: { key: "n" },
	});
	assert.equal(settings.updatedAt, null);
});

test("defaultShortcutSettings is the W/R/N set", () => {
	assert.deepEqual(defaultShortcutSettings().bindings, {
		focusWorkflow: { key: "w" },
		toggleDictation: { key: "r" },
		createWorkflow: { key: "n" },
	});
});

test("saveShortcutSettings persists the three keys and a save stamp", () => {
	const saved = saveShortcutSettings({
		bindings: {
			focusWorkflow: { key: "q" },
			toggleDictation: { key: "d" },
			createWorkflow: { key: "m" },
		},
	});
	assert.equal(saved.bindings.focusWorkflow.key, "q");
	assert.equal(saved.bindings.toggleDictation.key, "d");
	assert.equal(saved.bindings.createWorkflow.key, "m");
	assert.ok(saved.updatedAt);
	// Read back through a fresh query, not the returned object.
	assert.deepEqual(getShortcutSettings(), saved);
});

test("saveShortcutSettings replaces the previous row instead of adding a second one", () => {
	saveShortcutSettings({
		bindings: { focusWorkflow: { key: "a" }, toggleDictation: { key: "b" }, createWorkflow: { key: "c" } },
	});
	const second = saveShortcutSettings({
		bindings: { focusWorkflow: { key: "x" }, toggleDictation: { key: "y" }, createWorkflow: { key: "z" } },
	});
	assert.deepEqual(getShortcutSettings(), second);
	assert.equal(second.bindings.focusWorkflow.key, "x");
});

test("GET /api/settings/shortcuts needs no admin token and returns the stored bindings", async () => {
	saveShortcutSettings({
		bindings: { focusWorkflow: { key: "f" }, toggleDictation: { key: "t" }, createWorkflow: { key: "c" } },
	});

	const res = await fetch(`${baseUrl}/api/settings/shortcuts`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as ShortcutSettingsBody;
	assert.equal(body.settings.bindings.focusWorkflow.key, "f");
	assert.equal(body.settings.bindings.toggleDictation.key, "t");
	assert.equal(body.settings.bindings.createWorkflow.key, "c");
});

test("PUT /api/settings/shortcuts requires an admin token", async () => {
	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "a" }, toggleDictation: { key: "b" }, createWorkflow: { key: "c" } },
		}),
	});
	assert.equal(res.status, 401);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "unauthorized");
});

test("PUT /api/settings/shortcuts saves the bindings and a later GET reads them back", async () => {
	const putRes = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "g" }, toggleDictation: { key: "h" }, createWorkflow: { key: "j" } },
		}),
	});
	assert.equal(putRes.status, 200);
	const put = (await putRes.json()) as ShortcutSettingsBody;
	assert.equal(put.settings.bindings.focusWorkflow.key, "g");
	assert.equal(put.settings.bindings.createWorkflow.key, "j");

	const getRes = await fetch(`${baseUrl}/api/settings/shortcuts`);
	const got = (await getRes.json()) as ShortcutSettingsBody;
	assert.deepEqual(got.settings, put.settings);
});

test("PUT /api/settings/shortcuts rejects two actions sharing the same key", async () => {
	await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "k" }, toggleDictation: { key: "k" }, createWorkflow: { key: "l" } },
		}),
	}).then((r) => r.json());

	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "p" }, toggleDictation: { key: "p" }, createWorkflow: { key: "l" } },
		}),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /share the key/);

	// Nothing was stored: the previous state is intact.
	const got = (await (await fetch(`${baseUrl}/api/settings/shortcuts`)).json()) as ShortcutSettingsBody;
	assert.notEqual(got.settings.bindings.focusWorkflow.key, "p");
});

test("PUT /api/settings/shortcuts without a bindings field keeps the configured keys", async () => {
	await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "u" }, toggleDictation: { key: "v" }, createWorkflow: { key: "w" } },
		}),
	});

	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({}),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as ShortcutSettingsBody;
	assert.equal(body.settings.bindings.focusWorkflow.key, "u");
	assert.equal(body.settings.bindings.createWorkflow.key, "w");
});

test("PUT /api/settings/shortcuts coerces an invalid key back to that action's default", async () => {
	// focusWorkflow gets a number (invalid) -> falls back to default "w".
	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "3" }, toggleDictation: { key: "e" }, createWorkflow: { key: "f" } },
		}),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as ShortcutSettingsBody;
	assert.equal(body.settings.bindings.focusWorkflow.key, "w");
	assert.equal(body.settings.bindings.toggleDictation.key, "e");
});

test("an unsupported method on /api/settings/shortcuts is a 404", async () => {
	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, { method: "DELETE", headers: adminHeaders() });
	assert.equal(res.status, 404);
});
