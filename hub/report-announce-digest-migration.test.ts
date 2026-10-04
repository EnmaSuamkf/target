/**
 * Tests that an existing DB without `reported_meta_digest` / `reported_plan_digest`
 * (db.ts's `addWorkflowColumn` migration for them) upgrades cleanly: the
 * pre-existing workflow row survives, and its digests read back as NULL —
 * exactly "never announced", which is what makes `announceWorkflows` back-fill
 * it exactly once instead of treating the upgrade as a no-op forever.
 *
 * Same convention as workflow-completed.test.ts's own legacy-schema test:
 * seed a `workflows` table as it looked before these columns existed, THEN
 * import db.ts, so every assertion below runs against the real upgrade path,
 * not a simulation of it. Runs against a throwaway TARGET_HOME, so nothing
 * here touches the operator's real ~/.target.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-report-digest-migration-"));
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
	// A workflow written by a hub from before these digest columns existed.
	const now = new Date().toISOString();
	legacy
		.prepare(
			"INSERT INTO workflows (id, name, agent_name, hook_url, secret, status, md_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"legacy-wf",
			"a workflow from before digests existed",
			"legacy-agent",
			"http://127.0.0.1:1/hook",
			"s",
			"completed",
			path.join(tmpHome, "legacy.md"),
			now,
			now,
		);
	legacy.close();
}

const { getReportedDigests, getWorkflow, setReportedDigests } = await import("./db.ts");

test("a pre-existing DB without the digest columns migrates, and the old row survives", () => {
	const legacy = getWorkflow("legacy-wf");
	assert.ok(legacy, "the pre-migration workflow is still readable");
	assert.equal(legacy?.name, "a workflow from before digests existed");
	assert.equal(legacy?.status, "completed");
});

test("a pre-existing row's digests read back as NULL — 'never announced'", () => {
	assert.deepEqual(getReportedDigests("legacy-wf"), { meta: null, plan: null });
});

test("setReportedDigests writes meta and plan independently, leaving the other alone", () => {
	setReportedDigests("legacy-wf", { meta: "digest-a" });
	assert.deepEqual(getReportedDigests("legacy-wf"), { meta: "digest-a", plan: null });

	setReportedDigests("legacy-wf", { plan: "digest-b" });
	assert.deepEqual(getReportedDigests("legacy-wf"), { meta: "digest-a", plan: "digest-b" });
});
