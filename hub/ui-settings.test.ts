/**
 * UI catalog visibility settings: db layer and GET/PUT /api/settings/ui.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-ui-settings-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { getUiSettings, saveUiSettings } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

interface UiBody {
	settings: { showTcpCatalog: boolean; showRciCatalog: boolean; updatedAt: string | null };
}

test("getUiSettings on a fresh hub defaults both catalogs to hidden", () => {
	const settings = getUiSettings();
	assert.equal(settings.showTcpCatalog, false);
	assert.equal(settings.showRciCatalog, false);
	assert.equal(settings.updatedAt, null);
});

test("GET /api/settings/ui returns defaults on a fresh hub", async () => {
	const res = await fetch(`${baseUrl}/api/settings/ui`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as UiBody;
	assert.equal(body.settings.showTcpCatalog, false);
	assert.equal(body.settings.showRciCatalog, false);
});

test("saveUiSettings persists both flags", () => {
	const saved = saveUiSettings({ showTcpCatalog: false, showRciCatalog: true });
	assert.equal(saved.showTcpCatalog, false);
	assert.equal(saved.showRciCatalog, true);
	assert.ok(saved.updatedAt);
	assert.deepEqual(getUiSettings(), saved);
});

test("UI settings round-trip: save both flags off then on via API", async () => {
	const off = await fetch(`${baseUrl}/api/settings/ui`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ showTcpCatalog: false, showRciCatalog: false }),
	});
	assert.equal(off.status, 200);
	const offBody = (await off.json()) as UiBody;
	assert.equal(offBody.settings.showTcpCatalog, false);
	assert.equal(offBody.settings.showRciCatalog, false);

	const on = await fetch(`${baseUrl}/api/settings/ui`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ showTcpCatalog: true, showRciCatalog: true }),
	});
	assert.equal(on.status, 200);
	const onBody = (await on.json()) as UiBody;
	assert.equal(onBody.settings.showTcpCatalog, true);
	assert.equal(onBody.settings.showRciCatalog, true);

	const getRes = await fetch(`${baseUrl}/api/settings/ui`, { headers: adminHeaders() });
	assert.deepEqual((await getRes.json()) as UiBody, onBody);
});

test("PUT /api/settings/ui saves both flags and GET reads them back", async () => {
	const putRes = await fetch(`${baseUrl}/api/settings/ui`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ showTcpCatalog: false, showRciCatalog: false }),
	});
	assert.equal(putRes.status, 200);
	const put = (await putRes.json()) as UiBody;
	assert.equal(put.settings.showTcpCatalog, false);
	assert.equal(put.settings.showRciCatalog, false);

	const getRes = await fetch(`${baseUrl}/api/settings/ui`, { headers: adminHeaders() });
	const got = (await getRes.json()) as UiBody;
	assert.deepEqual(got.settings, put.settings);
});

test("PUT /api/settings/ui requires admin token", async () => {
	const res = await fetch(`${baseUrl}/api/settings/ui`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ showTcpCatalog: true, showRciCatalog: true }),
	});
	assert.equal(res.status, 401);
});
