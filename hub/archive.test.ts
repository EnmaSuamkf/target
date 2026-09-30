/**
 * Tests for workflow archiving (D14): the `archived_at` flag, the manual
 * archive/unarchive calls, and the daemon's `autoArchive` sweep.
 *
 * What's worth pinning down, and why:
 *
 *  - archiving is a FLAG, not a status — the completed/failed outcome must read
 *    back unchanged after archiving, including through the read-path heal
 *    (`expireStale` → `reconcileStatus`) that re-derives statuses;
 *  - only terminal workflows are archivable (`isArchivable`, the one rule both
 *    entry points share);
 *  - the auto-archive boundary is "last activity STRICTLY older than
 *    now - archive_after_days", where last activity is the later of the
 *    workflow's `updated_at` and its steps' latest `finished_at`;
 *  - `archive_after_days` = 0 disables the sweep, and the sweep is idempotent.
 *
 * Every test injects `now`, and sets timestamps directly in SQL, so nothing
 * depends on the wall clock. Same throwaway-TARGET_HOME convention as the other
 * hub tests.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-archive-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const {
	DEFAULT_ARCHIVE_AFTER_DAYS,
	getArchiveSettings,
	getWorkflow,
	insertStep,
	insertWorkflow,
	normalizeArchiveAfterDays,
	open,
	saveArchiveSettings,
	setWorkflowStatus,
} = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const {
	archiveWorkflow,
	autoArchive,
	expireStale,
	isArchivable,
	restartWorkflow,
	resumeWorkflow,
	runStep,
	startWorkflow,
	unarchiveWorkflow,
	WorkflowArchivedError,
	WorkflowError,
	WorkflowNotArchivableError,
} = await import("./workflow.ts");

type Status = "draft" | "running" | "paused" | "waiting" | "completed" | "failed";

const cfg = loadConfig();
const silent = () => {};
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-30T12:00:00.000Z");
let seq = 0;

function daysAgo(days: number, extraMs = 0): string {
	return new Date(NOW.getTime() - days * DAY_MS + extraMs).toISOString();
}

/** A workflow in `status` whose `updated_at` is `updatedAt` (no steps unless added). */
function makeWorkflow(status: Status, updatedAt: string = daysAgo(100)): string {
	seq += 1;
	const id = `wf-archive-${seq}`;
	insertWorkflow({
		id,
		name: `archive test ${seq}`,
		agentName: `archive-agent-${seq}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	setWorkflowStatus(id, status);
	setUpdatedAt(id, updatedAt);
	return id;
}

function setUpdatedAt(id: string, updatedAt: string): void {
	open().prepare("UPDATE workflows SET updated_at = ? WHERE id = ?").run(updatedAt, id);
}

/** Adds a step settled as `status` that finished at `finishedAt`. */
function addFinishedStep(workflowId: string, status: "done" | "failed", finishedAt: string): void {
	const step = insertStep(workflowId, `step for ${workflowId}`);
	open().prepare("UPDATE steps SET status = ?, finished_at = ? WHERE id = ?").run(status, finishedAt, step.id);
}

function archivedAt(id: string): string | null {
	const wf = getWorkflow(id);
	assert.ok(wf, `workflow ${id} exists`);
	return wf.archivedAt;
}

test("new workflows start unarchived, and the default archive_after_days is 30", () => {
	const id = makeWorkflow("completed");
	assert.equal(archivedAt(id), null);
	assert.equal(DEFAULT_ARCHIVE_AFTER_DAYS, 30);
	assert.equal(getArchiveSettings().archiveAfterDays, 30);
});

test("isArchivable: completed and failed are archivable", () => {
	for (const status of ["completed", "failed"] as const) {
		const wf = getWorkflow(makeWorkflow(status));
		assert.ok(wf);
		assert.equal(isArchivable(wf), true, status);
	}
});

test("isArchivable: running, waiting, paused and draft are not", () => {
	for (const status of ["running", "waiting", "paused", "draft"] as const) {
		const wf = getWorkflow(makeWorkflow(status));
		assert.ok(wf);
		assert.equal(isArchivable(wf), false, status);
	}
});

test("archiveWorkflow sets archived_at without bumping updated_at", () => {
	const updated = daysAgo(2);
	const id = makeWorkflow("completed", updated);
	const wf = archiveWorkflow(id, NOW);
	assert.equal(wf.archivedAt, NOW.toISOString());
	assert.equal(wf.updatedAt, updated);
});

test("archiveWorkflow throws WorkflowError for non-archivable statuses and leaves them unarchived", () => {
	for (const status of ["running", "waiting", "paused", "draft"] as const) {
		const id = makeWorkflow(status);
		assert.throws(() => archiveWorkflow(id, NOW), WorkflowError, status);
		assert.equal(archivedAt(id), null, status);
	}
});

test("archiveWorkflow throws WorkflowError for an unknown workflow", () => {
	assert.throws(() => archiveWorkflow("no-such-workflow", NOW), WorkflowError);
});

test("archiveWorkflow is idempotent and keeps the original archived_at", () => {
	const id = makeWorkflow("failed");
	archiveWorkflow(id, NOW);
	const again = archiveWorkflow(id, new Date(NOW.getTime() + DAY_MS));
	assert.equal(again.archivedAt, NOW.toISOString());
});

test("the completed/failed status survives archiving, including through the read-path heal", () => {
	const completed = makeWorkflow("completed");
	addFinishedStep(completed, "done", daysAgo(100));
	const failed = makeWorkflow("failed");
	addFinishedStep(failed, "failed", daysAgo(100));
	archiveWorkflow(completed, NOW);
	archiveWorkflow(failed, NOW);
	expireStale(cfg, silent);
	assert.equal(getWorkflow(completed)?.status, "completed");
	assert.equal(getWorkflow(failed)?.status, "failed");
	assert.equal(archivedAt(completed), NOW.toISOString());
	assert.equal(archivedAt(failed), NOW.toISOString());
});

test("unarchiveWorkflow clears archived_at; throws WorkflowError for an unknown workflow", () => {
	const id = makeWorkflow("completed");
	archiveWorkflow(id, NOW);
	const wf = unarchiveWorkflow(id);
	assert.equal(wf.archivedAt, null);
	assert.equal(wf.status, "completed");
	assert.throws(() => unarchiveWorkflow("no-such-workflow"), WorkflowError);
});

test("unarchiving resets the activity clock so the next sweep doesn't re-archive it", () => {
	saveArchiveSettings({ archiveAfterDays: 30 });
	const id = makeWorkflow("completed", daysAgo(100));
	assert.ok(autoArchive(NOW).includes(id));
	unarchiveWorkflow(id);
	// updated_at is now the real wall clock; any `now` within 30 days of it
	// must leave the workflow alone.
	const after = autoArchive(new Date());
	assert.ok(!after.includes(id));
	assert.equal(archivedAt(id), null);
});

test("autoArchive boundary: just under N days is kept, just over is archived, exactly N is kept", () => {
	saveArchiveSettings({ archiveAfterDays: 30 });
	const under = makeWorkflow("completed", daysAgo(30, 1_000));
	const exact = makeWorkflow("completed", daysAgo(30));
	const over = makeWorkflow("failed", daysAgo(30, -1_000));
	const archived = autoArchive(NOW);
	assert.ok(!archived.includes(under));
	assert.ok(!archived.includes(exact));
	assert.ok(archived.includes(over));
	assert.equal(archivedAt(under), null);
	assert.equal(archivedAt(exact), null);
	assert.equal(archivedAt(over), NOW.toISOString());
});

test("autoArchive: a step finished_at more recent than updated_at keeps the workflow unarchived", () => {
	saveArchiveSettings({ archiveAfterDays: 30 });
	const recentStep = makeWorkflow("completed");
	addFinishedStep(recentStep, "done", daysAgo(5));
	setUpdatedAt(recentStep, daysAgo(100));
	const oldStep = makeWorkflow("completed");
	addFinishedStep(oldStep, "done", daysAgo(90));
	setUpdatedAt(oldStep, daysAgo(100));
	const archived = autoArchive(NOW);
	assert.ok(!archived.includes(recentStep));
	assert.ok(archived.includes(oldStep));
	assert.equal(archivedAt(recentStep), null);
});

test("autoArchive honours a custom archive_after_days", () => {
	saveArchiveSettings({ archiveAfterDays: 7 });
	const eightDays = makeWorkflow("completed", daysAgo(8));
	const sixDays = makeWorkflow("completed", daysAgo(6));
	const archived = autoArchive(NOW);
	assert.ok(archived.includes(eightDays));
	assert.ok(!archived.includes(sixDays));
	saveArchiveSettings({ archiveAfterDays: 30 });
});

test("autoArchive: archive_after_days = 0 disables it", () => {
	saveArchiveSettings({ archiveAfterDays: 0 });
	const ancient = makeWorkflow("completed", daysAgo(3650));
	assert.deepEqual(autoArchive(NOW), []);
	assert.equal(archivedAt(ancient), null);
	saveArchiveSettings({ archiveAfterDays: 30 });
});

test("autoArchive leaves already-archived workflows untouched and is idempotent", () => {
	saveArchiveSettings({ archiveAfterDays: 30 });
	const earlier = new Date(NOW.getTime() - 50 * DAY_MS);
	const preArchived = makeWorkflow("completed", daysAgo(100));
	archiveWorkflow(preArchived, earlier);
	const fresh = makeWorkflow("failed", daysAgo(100));
	const first = autoArchive(NOW);
	assert.ok(!first.includes(preArchived));
	assert.ok(first.includes(fresh));
	assert.equal(archivedAt(preArchived), earlier.toISOString());
	assert.deepEqual(autoArchive(NOW), []);
	assert.equal(archivedAt(fresh), NOW.toISOString());
});

test("autoArchive never archives old non-archivable workflows", () => {
	saveArchiveSettings({ archiveAfterDays: 30 });
	const ids = (["running", "waiting", "paused", "draft"] as const).map((s) => makeWorkflow(s, daysAgo(365)));
	const archived = autoArchive(NOW);
	for (const id of ids) {
		assert.ok(!archived.includes(id));
		assert.equal(archivedAt(id), null);
	}
});

test("autoArchive compares SQLite-style datetimes as UTC", () => {
	saveArchiveSettings({ archiveAfterDays: 30 });
	// 30 days minus 1h before NOW, in `datetime()` format: inside the window.
	const inside = makeWorkflow("completed");
	open()
		.prepare("UPDATE workflows SET updated_at = datetime(?, '-30 days', '+1 hour') WHERE id = ?")
		.run(NOW.toISOString(), inside);
	const outside = makeWorkflow("completed");
	open()
		.prepare("UPDATE workflows SET updated_at = datetime(?, '-30 days', '-1 hour') WHERE id = ?")
		.run(NOW.toISOString(), outside);
	const archived = autoArchive(NOW);
	assert.ok(!archived.includes(inside));
	assert.ok(archived.includes(outside));
});

test("archive_after_days validation: non-negative integers only", () => {
	assert.equal(normalizeArchiveAfterDays(0), 0);
	assert.equal(normalizeArchiveAfterDays(45), 45);
	assert.equal(normalizeArchiveAfterDays("12"), 12);
	for (const bad of [-1, 1.5, "abc", "", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true]) {
		assert.equal(normalizeArchiveAfterDays(bad), null, String(bad));
		assert.throws(() => saveArchiveSettings({ archiveAfterDays: bad }), RangeError);
	}
	assert.equal(saveArchiveSettings({ archiveAfterDays: "14" }).archiveAfterDays, 14);
	assert.equal(getArchiveSettings().archiveAfterDays, 14);
	// A corrupted stored value reads as disabled rather than archiving anything.
	open().prepare("UPDATE settings SET value = ? WHERE key = 'archive'").run("not json");
	assert.equal(getArchiveSettings().archiveAfterDays, 0);
	saveArchiveSettings({ archiveAfterDays: 30 });
});

test("archiveWorkflow's refusal is a WorkflowNotArchivableError (still a WorkflowError)", () => {
	const id = makeWorkflow("running");
	assert.throws(
		() => archiveWorkflow(id, NOW),
		(err: unknown) => err instanceof WorkflowNotArchivableError && err instanceof WorkflowError,
	);
});

test("the engine refuses start/resume/restart/runStep on an archived workflow with WorkflowArchivedError", async () => {
	// Enforced in workflow.ts, not only over HTTP, so sync commands and MCP are
	// refused too; a WorkflowError subclass so generic callers keep working.
	const id = makeWorkflow("completed");
	const step = insertStep(id, "archived step");
	archiveWorkflow(id, NOW);
	const isArchivedError = (err: unknown) => err instanceof WorkflowArchivedError && err instanceof WorkflowError;
	await assert.rejects(startWorkflow(id, cfg, silent, [step.id]), isArchivedError);
	await assert.rejects(resumeWorkflow(id, cfg, silent, [step.id]), isArchivedError);
	await assert.rejects(restartWorkflow(id, cfg, silent, [step.id]), isArchivedError);
	await assert.rejects(runStep(id, step.id, cfg, silent), isArchivedError);
	assert.equal(getWorkflow(id)?.status, "completed");

	// Unarchived, the archive guard no longer applies (start then refuses for its
	// own, pre-existing reason: a completed workflow is restarted, not started).
	unarchiveWorkflow(id);
	await assert.rejects(
		startWorkflow(id, cfg, silent, [step.id]),
		(err: unknown) => err instanceof WorkflowError && !(err instanceof WorkflowArchivedError),
	);
});
