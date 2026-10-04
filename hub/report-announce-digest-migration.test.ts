/**
 * Tests that an existing DB without `reported_meta_digest` / `reported_plan_digest`
 * (db.ts's `addWorkflowColumn` migration for them) upgrades cleanly: the
 * pre-existing workflow rows survive, and their digests read back as NULL —
 * exactly "never announced".
 *
 * Also tests the silent legacy backfill: db.ts's migration captures the ids
 * of every workflow that existed the moment these columns were added, and
 * `announceWorkflows` (workflow.ts) uses that list to mark them as already
 * announced — persisting their current digest directly, without ever calling
 * `reportEmit` — so the operator's entire pre-existing workflow history is
 * NOT re-sent to the report server even once on the first post-upgrade
 * restart. A workflow created after the upgrade was never on that list, so it
 * is still announced for real the first time `announceWorkflows` sees it.
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
	// Two workflows written by a hub from before these digest columns existed.
	const now = new Date().toISOString();
	const insertLegacy = legacy.prepare(
		"INSERT INTO workflows (id, name, agent_name, hook_url, secret, status, md_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	insertLegacy.run(
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
	insertLegacy.run(
		"legacy-wf-silent",
		"a legacy workflow that should never be (re-)sent",
		"legacy-agent-silent",
		"http://127.0.0.1:1/hook",
		"s",
		"completed",
		path.join(tmpHome, "legacy-silent.md"),
		now,
		now,
	);
	legacy.close();
}

const { getReportedDigests, getWorkflow, insertStep, insertWorkflow, open, pendingReportEvents, setReportedDigests } =
	await import("./db.ts");
const { announceWorkflows } = await import("./workflow.ts");

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

test("a legacy workflow is silently marked as already announced, and never actually sent", () => {
	process.env.TARGET_REPORT_URL = "https://ingest.example.com/report";
	process.env.TARGET_REPORT_TOKEN = "secret";
	open().prepare("DELETE FROM report_events").run();

	// Still NULL before the first announceWorkflows() call — the migration only
	// captured the id list, it didn't compute anything yet.
	assert.deepEqual(getReportedDigests("legacy-wf-silent"), { meta: null, plan: null });

	announceWorkflows();

	const events = pendingReportEvents(1000).filter((e) => e.workflowId === "legacy-wf-silent");
	assert.deepEqual(events, [], "a legacy workflow is never actually sent, not even once");

	const digests = getReportedDigests("legacy-wf-silent");
	assert.ok(digests.meta && digests.plan, "its digest is persisted directly, so it won't look unannounced later");
});

test("a workflow created after the upgrade is still announced for real", () => {
	process.env.TARGET_REPORT_URL = "https://ingest.example.com/report";
	process.env.TARGET_REPORT_TOKEN = "secret";
	open().prepare("DELETE FROM report_events").run();

	const workflow = insertWorkflow({
		id: "post-upgrade-wf",
		name: "created after the digest columns existed",
		agentName: "post-upgrade-agent",
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, "post-upgrade.md"),
	});
	insertStep(workflow.id, "step 1");

	assert.deepEqual(getReportedDigests(workflow.id), { meta: null, plan: null });

	announceWorkflows();

	const updated = pendingReportEvents(1000).filter((e) => e.kind === "workflow.updated" && e.workflowId === workflow.id);
	const plan = pendingReportEvents(1000).filter((e) => e.kind === "workflow.plan" && e.workflowId === workflow.id);
	assert.equal(updated.length, 1, "a post-upgrade workflow is NOT on the silent-backfill list, so it is announced for real");
	assert.equal(plan.length, 1);

	const digests = getReportedDigests(workflow.id);
	assert.ok(digests.meta && digests.plan);
});
