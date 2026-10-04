/**
 * Tests for the persisted report-announce digests (`reported_meta_digest` /
 * `reported_plan_digest` in db.ts) and their consumers, `announceWorkflows`
 * and `reportPlan` in workflow.ts.
 *
 * The bug these fixed: `announceWorkflows()` ran once per daemon start and
 * unconditionally re-sent EVERY known workflow's metadata and plan, because
 * the in-memory dedup `reportPlan` uses (`lastPlanDigest`) starts empty in a
 * fresh process. Traffic — and bogus "updated 15m ago" timestamps on every
 * old, completed workflow — grew with total workflow history on every
 * restart. The fix persists a digest of what was last successfully queued per
 * workflow, so a restart only re-announces a workflow whose content actually
 * changed (or that was never announced at all).
 *
 * Runs against a throwaway TARGET_HOME/AWB_HOME (its own SQLite file and no
 * registered hooks), so nothing here touches the operator's real ~/.target.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-report-announce-test-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;

const { getReportedDigests, insertStep, insertWorkflow, open, pendingReportEvents, updateStepDescription } =
	await import("./db.ts");
const { announceWorkflows, renameWorkflow, resetPlanDigestCacheForTests } = await import("./workflow.ts");

let seq = 0;

/** A workflow with `count` pending steps, wired straight into the DB (no awb hook involved). */
function makeWorkflow(count = 1) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `Workflow ${id}`,
		agentName: `agent-${id}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const steps = Array.from({ length: count }, (_, i) => insertStep(id, `step ${i + 1}`));
	return { workflow, steps };
}

/** Pending report events of one `kind`, optionally narrowed to one workflow. */
function eventsOf(kind: string, workflowId?: string): ReturnType<typeof pendingReportEvents> {
	return pendingReportEvents(1000).filter((e) => e.kind === kind && (workflowId === undefined || e.workflowId === workflowId));
}

/** Empty the durable outbox between assertions, so each check only sees what happened since. */
function clearQueue(): void {
	open().prepare("DELETE FROM report_events").run();
}

function enableReporting(): void {
	process.env.TARGET_REPORT_URL = "https://ingest.example.com/report";
	process.env.TARGET_REPORT_TOKEN = "secret";
}

function disableReporting(): void {
	delete process.env.TARGET_REPORT_URL;
	delete process.env.TARGET_REPORT_TOKEN;
}

test("a workflow that was never announced (NULL digests) is announced in full", () => {
	enableReporting();
	clearQueue();
	const { workflow: wf1 } = makeWorkflow(1);
	const { workflow: wf2 } = makeWorkflow(2);

	assert.deepEqual(getReportedDigests(wf1.id), { meta: null, plan: null });
	assert.deepEqual(getReportedDigests(wf2.id), { meta: null, plan: null });

	announceWorkflows();

	assert.equal(eventsOf("workflow.updated", wf1.id).length, 1);
	assert.equal(eventsOf("workflow.plan", wf1.id).length, 1);
	assert.equal(eventsOf("workflow.updated", wf2.id).length, 1);
	assert.equal(eventsOf("workflow.plan", wf2.id).length, 1);

	const d1 = getReportedDigests(wf1.id);
	const d2 = getReportedDigests(wf2.id);
	assert.ok(d1.meta && d1.plan, "digests are persisted once queued");
	assert.ok(d2.meta && d2.plan, "digests are persisted once queued");
});

test("a second announce, after a simulated restart, emits nothing for an unchanged workflow", () => {
	enableReporting();
	clearQueue();
	const { workflow } = makeWorkflow(2);

	// First process lifetime: the workflow has never been announced.
	announceWorkflows();
	assert.equal(eventsOf("workflow.updated", workflow.id).length, 1);
	assert.equal(eventsOf("workflow.plan", workflow.id).length, 1);

	// Simulate a daemon restart: a fresh process starts with an empty
	// `lastPlanDigest` map (reportPlan's in-memory fast path), but the
	// persisted digests this fix added survive in the DB. Against the
	// pre-fix `announceWorkflows` — which re-sent every workflow
	// unconditionally on every call — this assertion of zero new events
	// would fail.
	resetPlanDigestCacheForTests();
	clearQueue();

	announceWorkflows();

	assert.equal(eventsOf("workflow.updated", workflow.id).length, 0);
	assert.equal(eventsOf("workflow.plan", workflow.id).length, 0);
});

test("renaming a workflow re-announces only that workflow", () => {
	enableReporting();
	clearQueue();
	const { workflow: wfA } = makeWorkflow(1);
	const { workflow: wfB } = makeWorkflow(1);

	announceWorkflows();
	clearQueue();

	// renameWorkflow emits its own direct workflow.updated AND, via
	// writeStatusMd, an immediate reportPlan with the new name — so by the time
	// announceWorkflows runs below, the PLAN digest is already fresh. Only the
	// persisted META digest (which only announceWorkflows itself writes) is
	// still the pre-rename one. Clear the queue so the only events counted
	// below are what the NEXT announceWorkflows() call decides to (re-)send.
	renameWorkflow(wfA.id, "Renamed Workflow A");
	clearQueue();

	announceWorkflows();

	assert.equal(eventsOf("workflow.updated", wfA.id).length, 1, "changed metadata is re-announced");
	assert.equal(eventsOf("workflow.plan", wfA.id).length, 0, "the plan was already brought up to date by the rename itself");
	assert.equal(eventsOf("workflow.updated", wfB.id).length, 0, "an untouched workflow stays silent");
	assert.equal(eventsOf("workflow.plan", wfB.id).length, 0);
});

test("changing a step re-announces only that workflow's plan", () => {
	enableReporting();
	clearQueue();
	const { workflow: wfA, steps: stepsA } = makeWorkflow(1);
	const { workflow: wfB } = makeWorkflow(1);

	announceWorkflows();
	clearQueue();

	updateStepDescription(stepsA[0]!.id, "a materially different description than before");

	announceWorkflows();

	assert.equal(eventsOf("workflow.plan", wfA.id).length, 1, "the changed plan is re-announced");
	assert.equal(eventsOf("workflow.updated", wfA.id).length, 0, "a step edit doesn't touch workflow metadata");
	assert.equal(eventsOf("workflow.updated", wfB.id).length, 0, "an untouched workflow stays silent");
	assert.equal(eventsOf("workflow.plan", wfB.id).length, 0);
});

test("reporting disabled: nothing is emitted and no digest is persisted, but a later enable still backfills", () => {
	disableReporting();
	clearQueue();
	const { workflow } = makeWorkflow(1);

	announceWorkflows();

	assert.equal(eventsOf("workflow.updated", workflow.id).length, 0);
	assert.equal(eventsOf("workflow.plan", workflow.id).length, 0);
	assert.deepEqual(getReportedDigests(workflow.id), { meta: null, plan: null });

	// Turning reporting on afterwards must see this workflow as never
	// announced — exactly the NULL-digest backfill case — not as something
	// to silently skip.
	enableReporting();
	announceWorkflows();

	assert.equal(eventsOf("workflow.updated", workflow.id).length, 1);
	assert.equal(eventsOf("workflow.plan", workflow.id).length, 1);
	const digests = getReportedDigests(workflow.id);
	assert.ok(digests.meta && digests.plan);
});
