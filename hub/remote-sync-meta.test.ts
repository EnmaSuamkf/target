/**
 * Remote sync workflow metadata: migration + API exposure of origin/remote_id.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-remote-sync-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const legacyDbFile = path.join(tmpHome, "target.db");
{
	fs.mkdirSync(path.dirname(legacyDbFile), { recursive: true });
	const legacy = new DatabaseSync(legacyDbFile);
	legacy.exec(`
		CREATE TABLE workflows (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			agent_name TEXT NOT NULL UNIQUE,
			hook_url TEXT NOT NULL,
			secret TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			last_session_id TEXT,
			md_path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);
	const now = new Date().toISOString();
	legacy
		.prepare(
			"INSERT INTO workflows (id, name, agent_name, hook_url, secret, status, md_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("legacy-wf", "Legacy workflow", "legacy-agent", "http://127.0.0.1:1/hook", "s", "draft", path.join(tmpHome, "legacy.md"), now, now);
	legacy.close();
}

const { getWorkflow, insertWorkflow, setWorkflowRemoteMeta } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

test("migration upgrades legacy workflows to origin local without data loss", () => {
	const wf = getWorkflow("legacy-wf");
	assert.ok(wf);
	assert.equal(wf!.name, "Legacy workflow");
	assert.equal(wf!.origin, "local");
	assert.equal(wf!.remoteId, null);
	assert.equal(wf!.remoteSyncedAt, null);
});

test("setWorkflowRemoteMeta stores remote id and synced timestamp", () => {
	const wf = insertWorkflow({
		id: "remote-wf-1",
		name: "Remote managed",
		agentName: "remote-agent-1",
		hookUrl: "http://127.0.0.1:1/hook2",
		secret: "secret",
		mdPath: path.join(tmpHome, "remote.md"),
		origin: "remote",
		remoteId: "rwf_server_abc",
		remoteSyncedAt: "2026-09-13T21:00:00.000Z",
	});
	assert.equal(wf.origin, "remote");
	assert.equal(wf.remoteId, "rwf_server_abc");

	const updated = setWorkflowRemoteMeta("remote-wf-1", {
		remoteSyncedAt: "2026-09-13T22:00:00.000Z",
	});
	assert.equal(updated?.remoteSyncedAt, "2026-09-13T22:00:00.000Z");
});

test("GET /api/workflows returns origin and remoteId", async () => {
	const cfg = loadConfig();
	const server = createServer(cfg, () => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const base = `http://127.0.0.1:${address.port}`;

	try {
		const res = await fetch(`${base}/api/workflows`, {
			headers: { authorization: `Bearer ${cfg.adminToken}` },
		});
		assert.equal(res.status, 200);
		const body = (await res.json()) as { workflows: { id: string; origin: string; remoteId: string | null }[] };
		const legacy = body.workflows.find((w) => w.id === "legacy-wf");
		const remote = body.workflows.find((w) => w.id === "remote-wf-1");
		assert.ok(legacy);
		assert.equal(legacy!.origin, "local");
		assert.equal(legacy!.remoteId, null);
		assert.ok(remote);
		assert.equal(remote!.origin, "remote");
		assert.equal(remote!.remoteId, "rwf_server_abc");
	} finally {
		server.close();
	}
});
