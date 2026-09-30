/**
 * Tests for the schedule SERIES model (D1, D15, D23): turning a workflow into
 * the armed instance of a series (`setSchedule`), cancelling it
 * (`cancelSchedule`), what deletion, cloning and archiving do to a scheduled
 * workflow, and the persistent schedule notices table.
 *
 * What's worth pinning down, and why:
 *
 *  - only a workflow that isn't in progress can be scheduled, and never one
 *    that continues an adopted conversation — every run is a clone, and a clone
 *    can't continue that thread;
 *  - `next_run_at` is computed from the spec in the schedule's zone, and
 *    rescheduling the armed instance keeps its series (id, name) instead of
 *    starting a new one;
 *  - cancelling leaves a normal workflow; deleting the armed instance ends the
 *    series; past instances are never touched;
 *  - a NORMAL clone never copies a schedule (only the fire path will);
 *  - an armed instance is never archivable, by hand or by the sweep.
 *
 * `now` is injected wherever the engine takes it, so nothing depends on the
 * wall clock. Same throwaway-TARGET_HOME convention as the other hub tests.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-schedule-series-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too: createWorkflow/cloneWorkflow create hooks.
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const {
	acknowledgeNotice,
	getArmedInstance,
	getNotice,
	getWorkflow,
	insertWorkflow,
	listArmedInstances,
	listNotices,
	listSeriesInstances,
	open,
	recordNotice,
	saveArchiveSettings,
	setWorkflowStatus,
	updateWorkflowSchedule,
} = await import("./db.ts");
const {
	addStep,
	archiveWorkflow,
	autoArchive,
	cancelSchedule,
	cloneWorkflow,
	createWorkflow,
	isArchivable,
	removeWorkflow,
	ScheduleServerManagedError,
	ScheduleValidationError,
	setSchedule,
	WorkflowArchivedError,
	WorkflowError,
	WorkflowNotArchivableError,
} = await import("./workflow.ts");

type Status = "draft" | "running" | "paused" | "waiting" | "completed" | "failed";

const NOW = new Date("2026-09-30T12:00:00.000Z"); // a Wednesday
const DAILY_9_MADRID = { spec: { kind: "daily" as const, time: "09:00" }, timezone: "Europe/Madrid" };
let seq = 0;

/** A bare workflow row in `status` (no hook — enough for the series rules). */
function makeWorkflow(status: Status = "draft", extra: { adoptedSessionId?: string } = {}): string {
	seq += 1;
	const id = `wf-series-${seq}`;
	insertWorkflow({
		id,
		name: `series test ${seq}`,
		agentName: `series-agent-${seq}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
		...extra,
	});
	setWorkflowStatus(id, status);
	return id;
}

// --- setSchedule: who may be scheduled --------------------------------------

test("setSchedule is allowed for draft, completed and failed workflows", () => {
	for (const status of ["draft", "completed", "failed"] as const) {
		const id = makeWorkflow(status);
		const wf = setSchedule(id, DAILY_9_MADRID, { now: NOW });
		assert.equal(wf.scheduleState, "armed", status);
		assert.equal(wf.status, status, "scheduling doesn't change the status");
	}
});

test("setSchedule is refused for workflows in progress", () => {
	for (const status of ["running", "waiting", "paused"] as const) {
		const id = makeWorkflow(status);
		assert.throws(() => setSchedule(id, DAILY_9_MADRID, { now: NOW }), WorkflowError, status);
		const wf = getWorkflow(id)!;
		assert.equal(wf.scheduleState, null, `${status}: nothing written`);
		assert.equal(wf.seriesId, null);
	}
});

test("setSchedule is refused for a workflow continuing an adopted conversation (D23)", () => {
	const id = makeWorkflow("draft", { adoptedSessionId: "operator-session-1" });
	assert.throws(() => setSchedule(id, DAILY_9_MADRID, { now: NOW }), /adopted conversation/);
	assert.equal(getWorkflow(id)!.scheduleState, null);
});

test("setSchedule is refused for archived workflows and unknown ids", () => {
	const id = makeWorkflow("completed");
	archiveWorkflow(id, NOW);
	assert.throws(() => setSchedule(id, DAILY_9_MADRID, { now: NOW }), WorkflowArchivedError);
	assert.throws(() => setSchedule("nope", DAILY_9_MADRID, { now: NOW }), /unknown workflow/);
});

test("setSchedule rejects invalid specs and zones with field errors", () => {
	const id = makeWorkflow();
	assert.throws(
		() => setSchedule(id, { spec: { kind: "daily", time: "25:00" }, timezone: "Mars/Olympus" }, { now: NOW }),
		(err: unknown) => {
			assert.ok(err instanceof ScheduleValidationError);
			assert.deepEqual(err.fields.map((f) => f.field).sort(), ["time", "timezone"]);
			return true;
		},
	);
	assert.throws(
		() =>
			setSchedule(id, { ...DAILY_9_MADRID, includePrevious: "yes" as unknown as boolean }, { now: NOW }),
		ScheduleValidationError,
	);
	assert.equal(getWorkflow(id)!.scheduleState, null);
});

test("a once schedule in the past is refused", () => {
	const id = makeWorkflow();
	assert.throws(
		() => setSchedule(id, { spec: { kind: "once", at: "2026-09-29T09:00" }, timezone: "UTC" }, { now: NOW }),
		(err: unknown) => err instanceof ScheduleValidationError && err.fields[0].field === "at",
	);
});

// --- setSchedule: what it writes --------------------------------------------

test("setSchedule creates a series and computes next_run_at in the schedule's zone", () => {
	const id = makeWorkflow();
	const wf = setSchedule(id, DAILY_9_MADRID, { now: NOW });
	// 12:00Z is 14:00 in Madrid (CEST), so today's 09:00 has passed → tomorrow 07:00Z.
	assert.equal(wf.nextRunAt, "2026-10-01T07:00:00.000Z");
	assert.equal(wf.scheduledFor, "2026-10-01T07:00:00.000Z");
	assert.ok(wf.seriesId);
	assert.equal(wf.seriesName, wf.name);
	assert.deepEqual(wf.schedule, { kind: "daily", time: "09:00" });
	assert.equal(wf.scheduleTimezone, "Europe/Madrid");
	assert.equal(wf.includePrevious, true, "on by default");
	assert.equal(wf.managedBy, "local");
	assert.equal(wf.previousInstanceId, null);
	assert.equal(wf.previousRunBlock, null);
	// persisted, not just returned
	assert.deepEqual(getWorkflow(id), wf);
	assert.deepEqual(getArmedInstance(wf.seriesId!)?.id, id);
	assert.ok(listArmedInstances().some((w) => w.id === id));
});

test("weekly and once schedules compute their next run", () => {
	const weekly = setSchedule(
		makeWorkflow(),
		{ spec: { kind: "weekly", days: [1, 5], time: "08:30" }, timezone: "America/New_York", includePrevious: false },
		{ now: NOW },
	);
	assert.equal(weekly.nextRunAt, "2026-10-02T12:30:00.000Z"); // Friday 08:30 EDT
	assert.equal(weekly.includePrevious, false);
	const once = setSchedule(makeWorkflow(), { spec: { kind: "once", at: "2026-12-24T18:00" }, timezone: "UTC" }, { now: NOW });
	assert.equal(once.nextRunAt, "2026-12-24T18:00:00.000Z");
});

test("rescheduling the armed instance keeps its series and recomputes next_run_at", () => {
	const id = makeWorkflow();
	const first = setSchedule(id, DAILY_9_MADRID, { now: NOW });
	// The workflow is renamed; the series keeps the name it was created with.
	open().prepare("UPDATE workflows SET name = 'renamed' WHERE id = ?").run(id);
	const second = setSchedule(
		id,
		{ spec: { kind: "daily", time: "18:00" }, timezone: "Europe/Madrid" },
		{ now: NOW },
	);
	assert.equal(second.seriesId, first.seriesId);
	assert.equal(second.seriesName, first.seriesName);
	assert.equal(second.nextRunAt, "2026-09-30T16:00:00.000Z"); // today 18:00 CEST
	assert.equal(listSeriesInstances(first.seriesId!).length, 1);
	// includePrevious omitted on a reschedule keeps the series' value
	setSchedule(id, { ...DAILY_9_MADRID, includePrevious: false }, { now: NOW });
	assert.equal(setSchedule(id, DAILY_9_MADRID, { now: NOW }).includePrevious, false);
});

test("a missed once is rescheduled within its series", () => {
	const id = makeWorkflow();
	const armed = setSchedule(id, { spec: { kind: "once", at: "2026-10-01T09:00" }, timezone: "UTC" }, { now: NOW });
	updateWorkflowSchedule(id, { scheduleState: "missed", nextRunAt: null });
	const again = setSchedule(id, { spec: { kind: "once", at: "2026-10-03T09:00" }, timezone: "UTC" }, { now: NOW });
	assert.equal(again.seriesId, armed.seriesId);
	assert.equal(again.scheduleState, "armed");
	assert.equal(again.nextRunAt, "2026-10-03T09:00:00.000Z");
});

test("a past (fired) instance can't be scheduled — its series has moved on", () => {
	const id = makeWorkflow("completed");
	setSchedule(id, DAILY_9_MADRID, { now: NOW });
	updateWorkflowSchedule(id, { scheduleState: "fired", nextRunAt: null });
	assert.throws(() => setSchedule(id, DAILY_9_MADRID, { now: NOW }), /past run/);
});

test("a server-managed series refuses local schedule edits (D15)", () => {
	const id = makeWorkflow();
	setSchedule(id, DAILY_9_MADRID, { now: NOW, actor: "server" });
	assert.equal(getWorkflow(id)!.managedBy, "server");
	assert.throws(() => setSchedule(id, DAILY_9_MADRID, { now: NOW }), ScheduleServerManagedError);
	assert.throws(() => cancelSchedule(id), ScheduleServerManagedError);
	assert.equal(getWorkflow(id)!.scheduleState, "armed");
	// the server itself may
	assert.equal(cancelSchedule(id, { actor: "server" }).scheduleState, "cancelled");
});

// --- cancel -----------------------------------------------------------------

test("cancelSchedule turns the armed instance back into a normal workflow, leaving past instances alone", () => {
	const pastId = makeWorkflow("completed");
	const armedId = makeWorkflow("draft");
	const armed = setSchedule(armedId, DAILY_9_MADRID, { now: NOW });
	// Put a past instance into the same series by hand.
	updateWorkflowSchedule(pastId, {
		seriesId: armed.seriesId,
		seriesName: armed.seriesName,
		schedule: armed.schedule,
		scheduleTimezone: armed.scheduleTimezone,
		scheduleState: "fired",
		scheduledFor: "2026-09-30T07:00:00.000Z",
	});
	const pastBefore = getWorkflow(pastId);

	const cancelled = cancelSchedule(armedId);
	assert.equal(cancelled.scheduleState, "cancelled");
	assert.equal(cancelled.nextRunAt, null);
	assert.equal(cancelled.seriesId, armed.seriesId, "kept as series history");
	assert.equal(isArchivable({ ...cancelled, status: "completed" }), true, "a normal workflow again");
	assert.equal(getArmedInstance(armed.seriesId!), null);
	assert.ok(!listArmedInstances().some((w) => w.id === armedId));
	assert.deepEqual(getWorkflow(pastId), pastBefore, "past instance untouched");
	// idempotent, and a no-op on a workflow that was never scheduled
	assert.deepEqual(cancelSchedule(armedId), cancelled);
	const plain = makeWorkflow();
	assert.equal(cancelSchedule(plain).scheduleState, null);
});

test("a cancelled workflow scheduled again starts a new series", () => {
	const id = makeWorkflow();
	const first = setSchedule(id, DAILY_9_MADRID, { now: NOW });
	cancelSchedule(id);
	const second = setSchedule(id, DAILY_9_MADRID, { now: NOW });
	assert.notEqual(second.seriesId, first.seriesId);
	assert.equal(second.scheduleState, "armed");
});

// --- delete / clone / archive ------------------------------------------------

test("deleting the armed instance cancels its series; past instances survive", () => {
	const armed = createWorkflow("series to delete");
	addStep(armed.id, "do the thing");
	const scheduled = setSchedule(armed.id, DAILY_9_MADRID, { now: NOW });
	const pastId = makeWorkflow("completed");
	updateWorkflowSchedule(pastId, { seriesId: scheduled.seriesId, scheduleState: "fired" });

	removeWorkflow(armed.id);
	assert.equal(getWorkflow(armed.id), null);
	assert.equal(getArmedInstance(scheduled.seriesId!), null, "nothing left to fire");
	assert.ok(!listArmedInstances().some((w) => w.seriesId === scheduled.seriesId));
	const remaining = listSeriesInstances(scheduled.seriesId!);
	assert.deepEqual(
		remaining.map((w) => [w.id, w.scheduleState]),
		[[pastId, "fired"]],
	);
});

test("a normal clone of a scheduled workflow copies no schedule", () => {
	const source = createWorkflow("scheduled source");
	addStep(source.id, "step one");
	const scheduled = setSchedule(source.id, DAILY_9_MADRID, { now: NOW });
	updateWorkflowSchedule(source.id, { previousRunBlock: "previous run: …", previousInstanceId: "wf-old" });

	const clone = cloneWorkflow(source.id);
	for (const key of [
		"seriesId",
		"seriesName",
		"schedule",
		"scheduleTimezone",
		"scheduledFor",
		"scheduleState",
		"nextRunAt",
		"previousInstanceId",
		"previousRunBlock",
		"announcedAt",
	] as const) {
		assert.equal(clone[key], null, key);
	}
	assert.equal(clone.managedBy, "local");
	assert.equal(clone.includePrevious, true);
	// the source is still the series' only armed instance
	assert.equal(getArmedInstance(scheduled.seriesId!)?.id, source.id);
	assert.equal(listSeriesInstances(scheduled.seriesId!).length, 1);
});

test("an armed instance is never archivable, by hand or by the sweep", () => {
	// A completed workflow turned into a series stays `completed` while armed —
	// exactly the case the status rule alone would archive.
	const id = makeWorkflow("completed");
	setSchedule(id, DAILY_9_MADRID, { now: NOW });
	open().prepare("UPDATE workflows SET updated_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", id);
	const wf = getWorkflow(id)!;
	assert.equal(isArchivable(wf), false);
	assert.throws(() => archiveWorkflow(id, NOW), WorkflowNotArchivableError);
	saveArchiveSettings({ archiveAfterDays: 30 });
	assert.ok(!autoArchive(NOW).includes(id));
	assert.equal(getWorkflow(id)!.archivedAt, null);
	// once cancelled, the ordinary rule applies again
	cancelSchedule(id);
	assert.equal(isArchivable(getWorkflow(id)!), true);
	// a past (fired) completed instance is archivable like any other
	assert.equal(isArchivable({ ...wf, scheduleState: "fired" }), true);
});

// --- notices ----------------------------------------------------------------

test("notices: record, list (open vs all, per series), acknowledge", () => {
	const a = recordNotice({
		workflowId: "wf-a",
		seriesId: "series-notices-1",
		kind: "missed",
		detail: { occurrences: ["2026-09-29T07:00:00.000Z", "2026-09-30T07:00:00.000Z"] },
		now: new Date("2026-09-30T10:00:00.000Z"),
	});
	const b = recordNotice({
		seriesId: "series-notices-2",
		kind: "skipped",
		reason: "busy",
		now: new Date("2026-09-30T11:00:00.000Z"),
	});
	assert.equal(a.acknowledgedAt, null);
	assert.deepEqual(getNotice(a.id), a);
	assert.deepEqual(getNotice(b.id)?.detail, {});
	assert.equal(getNotice(b.id)?.workflowId, null);

	const open1 = listNotices().filter((n) => n.seriesId?.startsWith("series-notices-"));
	assert.deepEqual(open1.map((n) => n.id), [b.id, a.id], "newest first");
	assert.deepEqual(listNotices({ seriesId: "series-notices-1" }).map((n) => n.id), [a.id]);

	const acked = acknowledgeNotice(a.id, new Date("2026-09-30T12:00:00.000Z"));
	assert.equal(acked?.acknowledgedAt, "2026-09-30T12:00:00.000Z");
	// a repeat keeps the original acknowledgement time
	assert.equal(acknowledgeNotice(a.id, new Date("2026-10-01T00:00:00.000Z"))?.acknowledgedAt, "2026-09-30T12:00:00.000Z");
	assert.ok(!listNotices().some((n) => n.id === a.id), "acknowledged ones leave the open list");
	assert.ok(listNotices({ includeAcknowledged: true }).some((n) => n.id === a.id));
	assert.equal(acknowledgeNotice("no-such-notice"), null);
});
