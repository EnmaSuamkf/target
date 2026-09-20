/**
 * Tests for the keyboard-shortcut preferences: the storage layer in db.ts and the
 * two routes the Settings view uses (GET/PUT /api/settings/shortcuts).
 *
 * Preferences are a master enable switch plus one key (a single a–z letter) per
 * action — focus the first workflow, toggle dictation, open the create-workflow
 * modal, continue a step held for review, start the open workflow — so what's
 * worth pinning down is the round-trip, the enabled default/legacy fill, the
 * per-action default fallback, the admin gate on the write, and the refusal to
 * store two actions on the same key.
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

const { getShortcutSettings, saveShortcutSettings, defaultShortcutSettings, open } = await import("./db.ts");
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
		enabled: boolean;
		bindings: {
			focusWorkflow: { key: string };
			toggleDictation: { key: string };
			createWorkflow: { key: string };
			continueStep: { key: string };
			startWorkflow: { key: string };
		};
		updatedAt: string | null;
	};
}

test("getShortcutSettings on a fresh hub reports enabled=true, default W/R/N/C/S bindings, and no save stamp", () => {
	const settings = getShortcutSettings();
	assert.equal(settings.enabled, true);
	assert.deepEqual(settings.bindings, {
		focusWorkflow: { key: "w" },
		toggleDictation: { key: "r" },
		createWorkflow: { key: "n" },
		continueStep: { key: "c" },
		startWorkflow: { key: "s" },
	});
	assert.equal(settings.updatedAt, null);
});

test("defaultShortcutSettings is enabled with the W/R/N/C/S set", () => {
	const defaults = defaultShortcutSettings();
	assert.equal(defaults.enabled, true);
	assert.deepEqual(defaults.bindings, {
		focusWorkflow: { key: "w" },
		toggleDictation: { key: "r" },
		createWorkflow: { key: "n" },
		continueStep: { key: "c" },
		startWorkflow: { key: "s" },
	});
});

test("a legacy shortcuts blob without enabled reads back as enabled=true", () => {
	// Hubs that saved bindings before the master switch shipped have no `enabled`
	// field in the JSON. Missing must mean on, not off — otherwise upgrades would
	// silently disable every operator's shortcuts.
	open()
		.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.run(
			"shortcuts",
			JSON.stringify({
				bindings: {
					focusWorkflow: { key: "w" },
					toggleDictation: { key: "r" },
					createWorkflow: { key: "n" },
					continueStep: { key: "c" },
					startWorkflow: { key: "s" },
				},
			}),
			new Date().toISOString(),
		);
	assert.equal(getShortcutSettings().enabled, true);
	assert.equal(getShortcutSettings().bindings.focusWorkflow.key, "w");
});

test("saveShortcutSettings persists enabled, the five keys, and a save stamp", () => {
	const saved = saveShortcutSettings({
		enabled: false,
		bindings: {
			focusWorkflow: { key: "q" },
			toggleDictation: { key: "d" },
			createWorkflow: { key: "m" },
			continueStep: { key: "i" },
			startWorkflow: { key: "e" },
		},
	});
	assert.equal(saved.enabled, false);
	assert.equal(saved.bindings.focusWorkflow.key, "q");
	assert.equal(saved.bindings.toggleDictation.key, "d");
	assert.equal(saved.bindings.createWorkflow.key, "m");
	assert.equal(saved.bindings.continueStep.key, "i");
	assert.equal(saved.bindings.startWorkflow.key, "e");
	assert.ok(saved.updatedAt);
	// Read back through a fresh query, not the returned object.
	assert.deepEqual(getShortcutSettings(), saved);
});

test("saveShortcutSettings without enabled keeps the previously stored value", () => {
	saveShortcutSettings({
		enabled: false,
		bindings: {
			focusWorkflow: { key: "a" },
			toggleDictation: { key: "b" },
			createWorkflow: { key: "c" },
			continueStep: { key: "d" },
			startWorkflow: { key: "e" },
		},
	});
	const saved = saveShortcutSettings({
		bindings: {
			focusWorkflow: { key: "q" },
			toggleDictation: { key: "d" },
			createWorkflow: { key: "m" },
			continueStep: { key: "i" },
			startWorkflow: { key: "e" },
		},
	});
	assert.equal(saved.enabled, false);
	assert.equal(getShortcutSettings().enabled, false);
});

test("saveShortcutSettings replaces the previous row instead of adding a second one", () => {
	saveShortcutSettings({
		bindings: { focusWorkflow: { key: "a" }, toggleDictation: { key: "b" }, createWorkflow: { key: "c" }, continueStep: { key: "d" }, startWorkflow: { key: "e" } },
	});
	const second = saveShortcutSettings({
		bindings: { focusWorkflow: { key: "x" }, toggleDictation: { key: "y" }, createWorkflow: { key: "z" }, continueStep: { key: "i" }, startWorkflow: { key: "j" } },
	});
	assert.deepEqual(getShortcutSettings(), second);
	assert.equal(second.bindings.focusWorkflow.key, "x");
});

test("GET /api/settings/shortcuts needs no admin token and returns the stored bindings", async () => {
	saveShortcutSettings({
		enabled: true,
		bindings: { focusWorkflow: { key: "f" }, toggleDictation: { key: "t" }, createWorkflow: { key: "o" }, continueStep: { key: "c" }, startWorkflow: { key: "s" } },
	});

	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as ShortcutSettingsBody;
	assert.equal(body.settings.enabled, true);
	assert.equal(body.settings.bindings.focusWorkflow.key, "f");
	assert.equal(body.settings.bindings.toggleDictation.key, "t");
	assert.equal(body.settings.bindings.createWorkflow.key, "o");
	assert.equal(body.settings.bindings.continueStep.key, "c");
	assert.equal(body.settings.bindings.startWorkflow.key, "s");
});

test("PUT /api/settings/shortcuts requires an admin token", async () => {
	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "a" }, toggleDictation: { key: "b" }, createWorkflow: { key: "c" }, continueStep: { key: "d" } },
		}),
	});
	assert.equal(res.status, 401);
	const body = (await res.json()) as { error: string };
	// No session and no token → the access gate answers before the route does.
	assert.equal(body.error, "login_required");
});

test("PUT /api/settings/shortcuts saves the bindings and a later GET reads them back", async () => {
	const putRes = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "g" }, toggleDictation: { key: "h" }, createWorkflow: { key: "j" }, continueStep: { key: "i" }, startWorkflow: { key: "k" } },
		}),
	});
	assert.equal(putRes.status, 200);
	const put = (await putRes.json()) as ShortcutSettingsBody;
	assert.equal(put.settings.bindings.focusWorkflow.key, "g");
	assert.equal(put.settings.bindings.createWorkflow.key, "j");
	assert.equal(put.settings.bindings.continueStep.key, "i");
	assert.equal(put.settings.bindings.startWorkflow.key, "k");

	const getRes = await fetch(`${baseUrl}/api/settings/shortcuts`, { headers: adminHeaders() });
	const got = (await getRes.json()) as ShortcutSettingsBody;
	assert.deepEqual(got.settings, put.settings);
});

test("PUT /api/settings/shortcuts round-trips enabled=false", async () => {
	const putRes = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			enabled: false,
			bindings: {
				focusWorkflow: { key: "w" },
				toggleDictation: { key: "r" },
				createWorkflow: { key: "n" },
				continueStep: { key: "c" },
				startWorkflow: { key: "s" },
			},
		}),
	});
	assert.equal(putRes.status, 200);
	const put = (await putRes.json()) as ShortcutSettingsBody;
	assert.equal(put.settings.enabled, false);

	const getRes = await fetch(`${baseUrl}/api/settings/shortcuts`, { headers: adminHeaders() });
	const got = (await getRes.json()) as ShortcutSettingsBody;
	assert.equal(got.settings.enabled, false);
});

test("PUT /api/settings/shortcuts without enabled keeps the stored switch", async () => {
	await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			enabled: false,
			bindings: {
				focusWorkflow: { key: "w" },
				toggleDictation: { key: "r" },
				createWorkflow: { key: "n" },
				continueStep: { key: "c" },
				startWorkflow: { key: "s" },
			},
		}),
	});

	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: {
				focusWorkflow: { key: "u" },
				toggleDictation: { key: "v" },
				createWorkflow: { key: "x" },
				continueStep: { key: "i" },
				startWorkflow: { key: "j" },
			},
		}),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as ShortcutSettingsBody;
	assert.equal(body.settings.enabled, false, "omitting enabled must not flip the switch back on");
	assert.equal(body.settings.bindings.focusWorkflow.key, "u");
});

test("PUT /api/settings/shortcuts rejects two actions sharing the same key", async () => {
	await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "k" }, toggleDictation: { key: "k" }, createWorkflow: { key: "l" }, continueStep: { key: "i" } },
		}),
	}).then((r) => r.json());

	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "p" }, toggleDictation: { key: "p" }, createWorkflow: { key: "l" }, continueStep: { key: "i" } },
		}),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /share the key/);

	// Nothing was stored: the previous state is intact.
	const got = (await (await fetch(`${baseUrl}/api/settings/shortcuts`, { headers: adminHeaders() })).json()) as ShortcutSettingsBody;
	assert.notEqual(got.settings.bindings.focusWorkflow.key, "p");
});

test("PUT /api/settings/shortcuts without a bindings field keeps the configured keys", async () => {
	await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			enabled: true,
			bindings: { focusWorkflow: { key: "u" }, toggleDictation: { key: "v" }, createWorkflow: { key: "w" }, continueStep: { key: "i" }, startWorkflow: { key: "s" } },
		}),
	});

	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ enabled: false }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as ShortcutSettingsBody;
	assert.equal(body.settings.enabled, false);
	assert.equal(body.settings.bindings.focusWorkflow.key, "u");
	assert.equal(body.settings.bindings.createWorkflow.key, "w");
});

test("PUT /api/settings/shortcuts coerces an invalid key back to that action's default", async () => {
	// focusWorkflow gets a number (invalid) -> falls back to default "w".
	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: { focusWorkflow: { key: "3" }, toggleDictation: { key: "e" }, createWorkflow: { key: "f" }, continueStep: { key: "i" } },
		}),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as ShortcutSettingsBody;
	assert.equal(body.settings.bindings.focusWorkflow.key, "w");
	assert.equal(body.settings.bindings.toggleDictation.key, "e");
});

test("a binding set saved before continueStep existed reads back with the C default", () => {
	// A hub upgraded into this feature has a stored blob with three actions in
	// it. Normalisation fills the missing one rather than dropping it, so the
	// Continue shortcut works on that hub without anyone visiting Settings.
	saveShortcutSettings({
		bindings: {
			focusWorkflow: { key: "w" },
			toggleDictation: { key: "r" },
			createWorkflow: { key: "n" },
		} as unknown as Parameters<typeof saveShortcutSettings>[0]["bindings"],
	});
	assert.equal(getShortcutSettings().bindings.continueStep.key, "c");
});

test("PUT /api/settings/shortcuts rejects continueStep sharing a key with another action", async () => {
	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: {
				focusWorkflow: { key: "w" },
				toggleDictation: { key: "r" },
				createWorkflow: { key: "s" },
				continueStep: { key: "s" },
			},
		}),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /share the key "s"/);
});

// --- the fifth action: startWorkflow ------------------------------------

test("a binding set saved before startWorkflow existed reads back with the S default", () => {
	// The same upgrade story continueStep had, one action later: a hub that saved
	// its bindings before the Start shortcut shipped has four actions in its blob.
	// Normalisation fills the fifth rather than dropping it, so Alt/Shift+S works
	// on that hub without anyone visiting Settings.
	saveShortcutSettings({
		bindings: {
			focusWorkflow: { key: "w" },
			toggleDictation: { key: "r" },
			createWorkflow: { key: "n" },
			continueStep: { key: "c" },
		} as unknown as Parameters<typeof saveShortcutSettings>[0]["bindings"],
	});
	assert.equal(getShortcutSettings().bindings.startWorkflow.key, "s");
	// And the four it did save are untouched by the newcomer.
	assert.equal(getShortcutSettings().bindings.continueStep.key, "c");
});

test("PUT /api/settings/shortcuts round-trips a rebound startWorkflow key", async () => {
	const putRes = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: {
				focusWorkflow: { key: "w" },
				toggleDictation: { key: "r" },
				createWorkflow: { key: "n" },
				continueStep: { key: "c" },
				startWorkflow: { key: "b" },
			},
		}),
	});
	assert.equal(putRes.status, 200);
	const put = (await putRes.json()) as ShortcutSettingsBody;
	assert.equal(put.settings.bindings.startWorkflow.key, "b");

	const got = (await (await fetch(`${baseUrl}/api/settings/shortcuts`, { headers: adminHeaders() })).json()) as ShortcutSettingsBody;
	assert.equal(got.settings.bindings.startWorkflow.key, "b", "a later GET reads the rebound key back");
});

test("PUT /api/settings/shortcuts rejects startWorkflow sharing a key with another action", async () => {
	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: {
				focusWorkflow: { key: "w" },
				toggleDictation: { key: "r" },
				createWorkflow: { key: "n" },
				continueStep: { key: "c" },
				startWorkflow: { key: "c" },
			},
		}),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /share the key "c"/);

	// Nothing was stored: the previous binding is intact.
	const got = (await (await fetch(`${baseUrl}/api/settings/shortcuts`, { headers: adminHeaders() })).json()) as ShortcutSettingsBody;
	assert.equal(got.settings.bindings.startWorkflow.key, "b");
});

test("PUT /api/settings/shortcuts coerces an invalid startWorkflow key back to S", async () => {
	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({
			bindings: {
				focusWorkflow: { key: "w" },
				toggleDictation: { key: "r" },
				createWorkflow: { key: "n" },
				continueStep: { key: "c" },
				startWorkflow: { key: "start" },
			},
		}),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as ShortcutSettingsBody;
	assert.equal(body.settings.bindings.startWorkflow.key, "s");
});

test("an unsupported method on /api/settings/shortcuts is a 404", async () => {
	const res = await fetch(`${baseUrl}/api/settings/shortcuts`, { method: "DELETE", headers: adminHeaders() });
	assert.equal(res.status, 404);
});
