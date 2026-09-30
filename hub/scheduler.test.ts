/**
 * Tests for the scheduler (scheduler.ts): what one tick does with every due
 * armed instance — fire, miss, skip or wait — and the daemon wiring.
 *
 * Every tick gets an injected `now` (and, for the permission gate, an injected
 * boot time and owner state), so nothing depends on the wall clock. Runs are
 * started for real: each armed instance points at a fake awb hook that accepts
 * dispatches and never calls back, so a started run reads `running` with its
 * first step queued, and the hook's request log says exactly what was
 * dispatched.
 *
 * The invariant checked throughout: a fire creates AT MOST one new instance,
 * and a missed or skipped run creates none (D8: no junk workflows).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-scheduler-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too: every fire clones the instance through createWorkflow.
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const {
	claimScheduledFire,
	getWorkflow,
	insertStep,
	insertWorkflow,
	listNotices,
	listSeriesInstances,
	listSteps,
	listWorkflows,
	open,
	setWorkflowStatus,
} = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { setSchedule, WorkflowError } = await import("./workflow.ts");
const {
	decideFireGate,
	dismissMissed,
	FIRE_PERMISSION,
	MISSED_GRACE_MS,
	PERMISSION_BOOT_WAIT_MS,
	rescheduleMissed,
	runMissedNow,
	runSchedulerTick,
	SCHEDULER_TICK_MS,
	startScheduler,
} = await import("./scheduler.ts");

type FirePermissionState = import("./scheduler.ts").FirePermissionState;

const cfg = loadConfig();
const silent = () => {};
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ARMED_AT = new Date("2026-09-30T08:00:00.000Z");
const DUE = new Date("2026-09-30T09:00:00.000Z"); // daily 09:00 UTC, first run
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

// --- fake awb hook -------------------------------------------------------------

const dispatched: string[] = [];
const hook = http.createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		dispatched.push(req.url ?? "");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
const hookAddress = hook.address();
if (!hookAddress || typeof hookAddress === "string") throw new Error("fake hook did not bind");
const hookBase = `http://127.0.0.1:${hookAddress.port}/hook`;
test.after(() => hook.close());

const dispatchesFor = (id: string) => dispatched.filter((url) => url.endsWith(`/${id}`)).length;

// --- fixtures --------------------------------------------------------------------

// Every test shares one DB, and a tick processes EVERY armed instance — so the
// series a previous test left armed are disarmed first, keeping each test's
// tick results (and workflow counts) about its own instances only.
beforeEach(() => {
	open()
		.prepare("UPDATE workflows SET schedule_state = 'cancelled', next_run_at = NULL WHERE schedule_state = 'armed'")
		.run();
});

let seq = 0;

/** An armed instance on the fake hook: daily 09:00 UTC by default, `steps` task steps. */
function armed(
	options: {
		spec?: { kind: "once"; at: string } | { kind: "daily"; time: string } | { kind: "weekly"; days: number[]; time: string };
		timezone?: string;
		steps?: number;
		name?: string;
	} = {},
) {
	seq += 1;
	const id = `wf-sched-${seq}`;
	insertWorkflow({
		id,
		name: options.name ?? `Series ${seq}`,
		agentName: `sched-agent-${seq}`,
		hookUrl: `${hookBase}/${id}`,
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	for (let i = 0; i < (options.steps ?? 2); i++) insertStep(id, `step ${i + 1}`);
	return setSchedule(
		id,
		{ spec: options.spec ?? { kind: "daily", time: "09:00" }, timezone: options.timezone ?? "UTC" },
		{ now: ARMED_AT },
	);
}

const unrestricted = (): FirePermissionState => ({ kind: "unrestricted" });

function tick(now: Date, extra: Partial<Parameters<typeof runSchedulerTick>[0]> = {}) {
	return runSchedulerTick({ cfg, log: silent, now, permissionState: unrestricted, ...extra });
}

const workflowCount = () => listWorkflows().length;

function assertStarted(id: string) {
	const wf = getWorkflow(id)!;
	assert.equal(wf.status, "running", "the run was started");
	const tasks = listSteps(id).filter((s) => s.kind === "task");
	assert.ok(tasks.length > 0);
	assert.ok(tasks.every((s) => s.selected), "every task step selected — never an empty selection");
	assert.equal(tasks[0].status, "queued", "first step dispatched");
	assert.equal(dispatchesFor(id), 1, "exactly one dispatch");
}

// --- firing ------------------------------------------------------------------------

test("on time: the armed instance fires, and exactly one next instance is armed", async () => {
	const first = armed({ name: "Nightly" });
	const before = workflowCount();
	const result = await tick(DUE);

	assert.deepEqual(result.fired, [first.id]);
	assert.equal(result.created.length, 1, "one new instance per fire");
	assert.equal(workflowCount(), before + 1);
	const fired = getWorkflow(first.id)!;
	assert.equal(fired.scheduleState, "fired");
	assert.equal(fired.nextRunAt, null);
	assert.equal(fired.scheduledFor, DUE.toISOString());
	assert.equal(fired.name, "Nightly", "the first instance keeps the operator's name");
	assertStarted(first.id);

	const next = getWorkflow(result.created[0])!;
	assert.equal(next.scheduleState, "armed");
	assert.equal(next.nextRunAt, "2026-10-01T09:00:00.000Z");
	assert.equal(next.name, "Nightly · 2026-10-01 09:00");
	assert.equal(next.previousInstanceId, first.id);
	assert.equal(next.status, "draft");
	assert.equal(dispatchesFor(next.id), 0, "the next instance only waits");

	// A later tick before the next run does nothing more.
	const again = await tick(at(DUE, 5 * MIN));
	assert.deepEqual(again.fired, []);
	assert.equal(workflowCount(), before + 1);
});

test("9 minutes late still fires normally", async () => {
	const wf = armed();
	const result = await tick(at(DUE, 9 * MIN));
	assert.deepEqual(result.fired, [wf.id]);
	assert.equal(result.created.length, 1);
	assert.deepEqual(result.missed, []);
	assertStarted(wf.id);
	assert.equal(listNotices({ seriesId: wf.seriesId! }).length, 0);
});

test("11 minutes late (recurring): missed, re-armed at the next occurrence, no workflow created", async () => {
	const wf = armed();
	const before = workflowCount();
	const result = await tick(at(DUE, 11 * MIN));
	assert.deepEqual(result.fired, []);
	assert.deepEqual(result.missed, [wf.id]);
	assert.equal(workflowCount(), before, "no junk workflows");
	const after = getWorkflow(wf.id)!;
	assert.equal(after.scheduleState, "armed");
	assert.equal(after.nextRunAt, "2026-10-01T09:00:00.000Z");
	assert.equal(after.scheduledFor, "2026-10-01T09:00:00.000Z");
	assert.equal(after.status, "draft");
	assert.equal(dispatchesFor(wf.id), 0, "nothing ran late");
	const [notice] = listNotices({ seriesId: wf.seriesId! });
	assert.equal(notice.kind, "missed");
	assert.deepEqual(notice.detail.occurrences, [DUE.toISOString()]);
	assert.match(String(notice.detail.message), /1 run missed \(2026-09-30 09:00\) because the hub was offline; next: 2026-10-01 09:00/);
});

test("11 minutes late (once): the instance becomes missed with a notice; nothing runs", async () => {
	const wf = armed({ spec: { kind: "once", at: "2026-09-30T09:00" } });
	const before = workflowCount();
	const result = await tick(at(DUE, 11 * MIN));
	assert.deepEqual(result.missed, [wf.id]);
	assert.equal(workflowCount(), before);
	const after = getWorkflow(wf.id)!;
	assert.equal(after.scheduleState, "missed");
	assert.equal(after.nextRunAt, null);
	assert.equal(dispatchesFor(wf.id), 0);
	const [notice] = listNotices({ seriesId: wf.seriesId! });
	assert.equal(notice.kind, "missed");
	assert.match(String(notice.detail.message), /The run scheduled for 2026-09-30 09:00 was missed/);
	// ticks after that leave it alone
	assert.deepEqual((await tick(at(DUE, 2 * DAY))).missed, []);
});

test("a once on time fires without creating a next instance", async () => {
	const wf = armed({ spec: { kind: "once", at: "2026-09-30T09:00" } });
	const before = workflowCount();
	const result = await tick(DUE);
	assert.deepEqual(result.fired, [wf.id]);
	assert.deepEqual(result.created, []);
	assert.equal(workflowCount(), before);
	assertStarted(wf.id);
});

test("boot after 3 days offline reports 3 missed runs and creates no extra workflows", async () => {
	const first = armed({ name: "Offline" });
	const fire = await tick(DUE); // runs on 09-30, arms 10-01
	const gen2 = fire.created[0];
	const before = workflowCount();
	// The hub was down from just after that until 10-03 12:00 (a fresh boot:
	// the same tick with a large gap).
	const result = await tick(new Date("2026-10-03T12:00:00.000Z"));
	assert.deepEqual(result.fired, []);
	assert.deepEqual(result.created, []);
	assert.deepEqual(result.missed, [gen2]);
	assert.equal(workflowCount(), before, "no workflow per missed run");
	const after = getWorkflow(gen2)!;
	assert.equal(after.scheduleState, "armed");
	assert.equal(after.nextRunAt, "2026-10-04T09:00:00.000Z");
	assert.equal(after.name, "Offline · 2026-10-04 09:00", "renamed to the run it now waits for");
	const [notice] = listNotices({ seriesId: first.seriesId! });
	assert.equal(notice.kind, "missed");
	assert.equal(notice.detail.count, 3);
	assert.deepEqual(notice.detail.occurrences, [
		"2026-10-01T09:00:00.000Z",
		"2026-10-02T09:00:00.000Z",
		"2026-10-03T09:00:00.000Z",
	]);
	assert.match(String(notice.detail.message), /^3 runs missed \(2026-10-01 09:00, 2026-10-02 09:00, 2026-10-03 09:00\) because the hub was offline; next: 2026-10-04 09:00\.$/);
	assert.equal(listSeriesInstances(first.seriesId!).length, 2);
});

test("back online within the grace window of the latest run: earlier ones missed, the latest fires", async () => {
	const wf = armed();
	const before = workflowCount();
	const result = await tick(new Date("2026-10-02T09:04:00.000Z"));
	assert.deepEqual(result.fired, [wf.id]);
	assert.equal(result.created.length, 1);
	assert.equal(workflowCount(), before + 1);
	assert.equal(getWorkflow(wf.id)!.scheduledFor, "2026-10-02T09:00:00.000Z");
	const [notice] = listNotices({ seriesId: wf.seriesId! });
	assert.deepEqual(notice.detail.occurrences, ["2026-09-30T09:00:00.000Z", "2026-10-01T09:00:00.000Z"]);
	assert.equal(getWorkflow(result.created[0])!.nextRunAt, "2026-10-03T09:00:00.000Z");
});

test("suspended process: a tick after a long gap (no restart) reaches the same result", async () => {
	const wf = armed();
	const before = workflowCount();
	// Normal ticks before the run…
	assert.deepEqual((await tick(at(DUE, -1 * MIN))).fired, []);
	assert.deepEqual((await tick(at(DUE, -30_000))).fired, []);
	// …then the laptop sleeps for two days and the next 30s tick comes late.
	const result = await tick(at(DUE, 2 * DAY + 3 * 60 * MIN));
	assert.deepEqual(result.missed, [wf.id]);
	assert.deepEqual(result.fired, []);
	assert.equal(workflowCount(), before);
	assert.equal(getWorkflow(wf.id)!.nextRunAt, "2026-10-03T09:00:00.000Z");
	assert.equal(listNotices({ seriesId: wf.seriesId! })[0].detail.count, 3);
});

// --- overlap (D9) -----------------------------------------------------------------

test("overlap: the previous run is still going → the due run is skipped and re-armed", async () => {
	const first = armed();
	const gen2 = (await tick(DUE)).created[0];
	assert.equal(getWorkflow(first.id)!.status, "running", "the first run never finishes (fake hook)");
	const before = workflowCount();
	const result = await tick(new Date("2026-10-01T09:00:00.000Z"));
	assert.deepEqual(result.fired, []);
	assert.deepEqual(result.skipped, [gen2]);
	assert.equal(workflowCount(), before, "a skip creates nothing");
	const after = getWorkflow(gen2)!;
	assert.equal(after.scheduleState, "armed");
	assert.equal(after.nextRunAt, "2026-10-02T09:00:00.000Z");
	assert.equal(dispatchesFor(gen2), 0);
	const notice = listNotices({ seriesId: first.seriesId! })[0];
	assert.equal(notice.kind, "skipped");
	assert.equal(notice.reason, "busy");
	assert.equal(notice.detail.busyInstanceId, first.id);
	// Waiting and paused count as busy too.
	for (const status of ["waiting", "paused"] as const) {
		setWorkflowStatus(first.id, status);
		assert.deepEqual((await tick(new Date(after.nextRunAt!))).skipped, [gen2], status);
		open().prepare("UPDATE workflows SET next_run_at = ?, scheduled_for = ? WHERE id = ?").run(
			after.nextRunAt,
			after.nextRunAt,
			gen2,
		);
	}
	// Once the previous run has finished, the next one fires.
	setWorkflowStatus(first.id, "completed");
	assert.deepEqual((await tick(new Date(after.nextRunAt!))).fired, [gen2]);
});

// --- permission gate (D10) ----------------------------------------------------------

test("decideFireGate: unrestricted, live, boot wait, cached snapshot age", () => {
	const now = DUE.getTime();
	const boot = now - 60 * MIN;
	const snap = (ageMs: number, permissions = [FIRE_PERMISSION]) => ({
		permissions,
		receivedAt: new Date(now - ageMs).toISOString(),
	});
	assert.deepEqual(decideFireGate({ kind: "unrestricted" }, now, boot), { decision: "allow" });
	assert.deepEqual(decideFireGate({ kind: "enforced", permissions: [FIRE_PERMISSION] }, now, boot), { decision: "allow" });
	assert.deepEqual(decideFireGate({ kind: "enforced", permissions: ["client.workflows.manage"] }, now, boot), {
		decision: "skip",
		reason: "forbidden",
	});
	// not heard from the server yet: wait while < 5 min since boot
	const unheard = { kind: "unavailable" as const, liveSinceBoot: false, lastSnapshot: snap(DAY) };
	assert.deepEqual(decideFireGate(unheard, now, now - 4 * MIN), { decision: "wait" });
	assert.deepEqual(decideFireGate(unheard, now, now - PERMISSION_BOOT_WAIT_MS), { decision: "allow" });
	// after the wait (or heard but lapsed): a snapshot under 7 days decides
	const lapsed = (lastSnapshot: ReturnType<typeof snap> | null) => ({
		kind: "unavailable" as const,
		liveSinceBoot: true,
		lastSnapshot,
	});
	assert.deepEqual(decideFireGate(lapsed(snap(6 * DAY)), now, now - MIN), { decision: "allow" });
	assert.deepEqual(decideFireGate(lapsed(snap(7 * DAY)), now, now - MIN), { decision: "skip", reason: "stale" });
	assert.deepEqual(decideFireGate(lapsed(null), now, boot), { decision: "skip", reason: "stale" });
	assert.deepEqual(decideFireGate(lapsed(snap(DAY, ["client.workflows.manage"])), now, boot), {
		decision: "skip",
		reason: "forbidden",
	});
});

test("permission stale: no contact with the server for 8 days → skipped (stale), re-armed", async () => {
	const wf = armed();
	const before = workflowCount();
	const result = await tick(DUE, {
		bootAt: DUE.getTime() - 60 * MIN,
		permissionState: () => ({
			kind: "unavailable",
			liveSinceBoot: false,
			lastSnapshot: { permissions: [FIRE_PERMISSION], receivedAt: new Date(DUE.getTime() - 8 * DAY).toISOString() },
		}),
	});
	assert.deepEqual(result.skipped, [wf.id]);
	assert.equal(workflowCount(), before);
	assert.equal(getWorkflow(wf.id)!.nextRunAt, "2026-10-01T09:00:00.000Z");
	assert.equal(dispatchesFor(wf.id), 0);
	const notice = listNotices({ seriesId: wf.seriesId! })[0];
	assert.equal(notice.kind, "skipped");
	assert.equal(notice.reason, "stale");
});

test("permission forbidden: the owner lacks client.workflows.execute → skipped (forbidden)", async () => {
	const wf = armed();
	const result = await tick(DUE, {
		permissionState: () => ({ kind: "enforced", permissions: ["client.workflows.manage"] }),
	});
	assert.deepEqual(result.skipped, [wf.id]);
	assert.equal(dispatchesFor(wf.id), 0);
	assert.equal(listNotices({ seriesId: wf.seriesId! })[0].reason, "forbidden");
	// A once has no next occurrence, so a skipped once waits as `missed`.
	const once = armed({ spec: { kind: "once", at: "2026-09-30T09:00" } });
	await tick(DUE, { permissionState: () => ({ kind: "enforced", permissions: [] }) });
	assert.equal(getWorkflow(once.id)!.scheduleState, "missed");
});

test("permission boot wait: held back, then fires on the cached snapshot — the wait never makes it missed", async () => {
	const wf = armed();
	const bootAt = at(DUE, 7 * MIN).getTime();
	const unheard = (): FirePermissionState => ({
		kind: "unavailable",
		liveSinceBoot: false,
		lastSnapshot: { permissions: [FIRE_PERMISSION], receivedAt: new Date(DUE.getTime() - 2 * DAY).toISOString() },
	});
	// Boot at 09:07, first tick 09:08 (8 min late): wait for the heartbeat.
	const held = await tick(at(DUE, 8 * MIN), { bootAt, permissionState: unheard });
	assert.deepEqual(held.deferred, [wf.id]);
	assert.equal(getWorkflow(wf.id)!.scheduleState, "armed", "not claimed while waiting");
	assert.equal(dispatchesFor(wf.id), 0);
	// 09:13: the 5-minute wait is over (13 min after the due time, but it was
	// first held at 8 min) → fires on the 2-day-old snapshot.
	const fired = await tick(at(DUE, 13 * MIN), { bootAt, permissionState: unheard });
	assert.deepEqual(fired.fired, [wf.id]);
	assert.deepEqual(fired.missed, []);
	assertStarted(wf.id);
});

// --- concurrency (D7) -----------------------------------------------------------------

test("two concurrent ticks fire the run once", async () => {
	const wf = armed();
	const before = workflowCount();
	const [a, b] = await Promise.all([tick(DUE), tick(DUE)]);
	assert.equal(a.fired.length + b.fired.length, 1);
	assert.equal(a.created.length + b.created.length, 1);
	assert.equal(workflowCount(), before + 1);
	assert.equal(dispatchesFor(wf.id), 1);
});

test("a run claimed by another process is left alone", async () => {
	const wf = armed();
	const before = workflowCount();
	// Another hub process on the same DB won the claim first.
	assert.equal(claimScheduledFire(wf.id, wf.nextRunAt!), true);
	assert.equal(claimScheduledFire(wf.id, wf.nextRunAt!), false, "the claim is once-only");
	open().prepare("UPDATE workflows SET schedule_state = 'armed' WHERE id = ?").run(wf.id);
	assert.equal(claimScheduledFire(wf.id, "2026-09-29T09:00:00.000Z"), false, "a stale next_run_at loses");
	claimScheduledFire(wf.id, wf.nextRunAt!);
	const result = await tick(DUE);
	assert.deepEqual(result.fired, []);
	assert.equal(workflowCount(), before);
	assert.equal(dispatchesFor(wf.id), 0);
});

// --- clone failure (D12) ----------------------------------------------------------------

test("clone failure: the series is broken with a critical notice, yet the current run starts", async () => {
	const wf = armed();
	const before = workflowCount();
	const result = await tick(DUE, {
		clone: () => {
			throw new Error("disk full");
		},
	});
	assert.deepEqual(result.fired, [wf.id]);
	assert.deepEqual(result.created, []);
	assert.equal(workflowCount(), before);
	const after = getWorkflow(wf.id)!;
	assert.equal(after.scheduleState, "broken");
	assertStarted(wf.id);
	const notice = listNotices({ seriesId: wf.seriesId! })[0];
	assert.equal(notice.kind, "broken");
	assert.equal(notice.detail.critical, true);
	assert.match(String(notice.detail.error), /disk full/);
	// Nothing is armed any more, so later ticks do nothing.
	assert.deepEqual((await tick(at(DUE, DAY))).fired, []);
});

// --- remote series (D16) ------------------------------------------------------------------

const { getSyncStepMap, saveSyncStepMap, setWorkflowRemoteMeta } = await import("./db.ts");
const { addStep } = await import("./workflow.ts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const taskIds = (id: string) => listSteps(id).filter((s) => s.kind !== "context").map((s) => s.id);

/** A server series' first instance: remote, keyed steps, scheduled by the server. */
function armedRemote(name: string) {
	seq += 1;
	const id = `wf-sched-remote-${seq}`;
	insertWorkflow({
		id,
		name,
		agentName: `sched-remote-agent-${seq}`,
		hookUrl: `${hookBase}/${id}`,
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const [a, b] = [insertStep(id, "gather"), insertStep(id, "report")];
	const remoteId = `rwf_series_${seq}`;
	setWorkflowRemoteMeta(id, { origin: "remote", remoteId, remoteSyncedAt: ARMED_AT.toISOString() });
	saveSyncStepMap(remoteId, { k_gather: a.id, k_report: b.id });
	const wf = setSchedule(
		id,
		{ spec: { kind: "daily", time: "09:00" }, timezone: "UTC", seriesId: `series_remote_${seq}` },
		{ now: ARMED_AT, actor: "server" },
	);
	return { wf, remoteId };
}

test("remote fire: the next instance is remote, with a fresh hub remote_id and the same step_keys", async () => {
	const { wf: first, remoteId } = armedRemote("Remote nightly");
	const result = await tick(DUE);
	assert.deepEqual(result.fired, [first.id]);
	assertStarted(first.id);

	const next = getWorkflow(result.created[0])!;
	assert.equal(next.origin, "remote");
	assert.match(next.remoteId ?? "", UUID_RE, "the hub mints a UUID");
	assert.notEqual(next.remoteId, remoteId);
	assert.equal(next.seriesId, first.seriesId);
	assert.equal(next.managedBy, "server");
	assert.equal(next.announcedAt, null, "waiting to be announced");
	assert.equal(next.scheduleState, "armed");
	assert.equal(next.previousInstanceId, first.id);

	const [gather, report] = taskIds(next.id);
	assert.deepEqual(getSyncStepMap(next.remoteId!), { k_gather: gather, k_report: report });
	assert.equal(listSteps(next.id).find((s) => s.id === gather)!.description, "gather");
	// The fired instance keeps its own ids and map.
	assert.equal(getWorkflow(first.id)!.remoteId, remoteId);
	assert.deepEqual(Object.keys(getSyncStepMap(remoteId)), ["k_gather", "k_report"]);
	assert.ok(!Object.values(getSyncStepMap(remoteId)).includes(gather));
});

test("remote fire: keys carry through generations, and a locally added step gets a fresh key", async () => {
	const { wf: first } = armedRemote("Remote chain");
	const second = getWorkflow((await tick(DUE)).created[0])!;
	addStep(second.id, "extra check");
	setWorkflowStatus(first.id, "completed"); // else the next run is skipped as an overlap
	const third = getWorkflow((await tick(at(DUE, DAY))).created[0])!;

	assert.notEqual(third.remoteId, second.remoteId);
	assert.equal(third.seriesId, first.seriesId);
	const map = getSyncStepMap(third.remoteId!);
	const [gather, report, extra] = taskIds(third.id);
	assert.equal(map.k_gather, gather);
	assert.equal(map.k_report, report);
	const extraKeys = Object.keys(map).filter((k) => k !== "k_gather" && k !== "k_report");
	assert.equal(extraKeys.length, 1);
	assert.equal(map[extraKeys[0]], extra);
	assert.equal(Object.keys(map).length, 3, "one key per task step, no stale ones");
});

test("local series: the next instance stays local — no remote_id, no step map", async () => {
	const first = armed({ name: "Local nightly" });
	const next = getWorkflow((await tick(DUE)).created[0])!;
	assert.equal(next.origin, "local");
	assert.equal(next.remoteId, null);
	assert.equal(next.managedBy, "local");
	assert.equal(next.seriesId, first.seriesId);
	assert.equal(getWorkflow(first.id)!.origin, "local");
});

test("a hub-managed series on a remote-origin workflow does not mint remote instances", async () => {
	seq += 1;
	const id = `wf-sched-remote-local-${seq}`;
	insertWorkflow({
		id,
		name: "Remote workflow, local schedule",
		agentName: `sched-rl-agent-${seq}`,
		hookUrl: `${hookBase}/${id}`,
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	insertStep(id, "one");
	setWorkflowRemoteMeta(id, { origin: "remote", remoteId: `rwf_rl_${seq}`, remoteSyncedAt: ARMED_AT.toISOString() });
	setSchedule(id, { spec: { kind: "daily", time: "09:00" }, timezone: "UTC" }, { now: ARMED_AT });
	const next = getWorkflow((await tick(DUE)).created[0])!;
	assert.equal(next.origin, "local", "the server knows nothing of a hub series");
	assert.equal(next.remoteId, null);
});

// --- step selection -----------------------------------------------------------------------

test("an instance whose steps already ran fires with restart semantics and every task step", async () => {
	const wf = armed({ steps: 3 });
	// An existing completed workflow turned into a series.
	open().prepare("UPDATE steps SET status = 'done', result = 'old' WHERE workflow_id = ?").run(wf.id);
	setWorkflowStatus(wf.id, "completed");
	const result = await tick(DUE);
	assert.deepEqual(result.fired, [wf.id]);
	const tasks = listSteps(wf.id).filter((s) => s.kind === "task");
	assert.equal(tasks.length, 3);
	assert.ok(tasks.every((s) => s.selected));
	assert.deepEqual(
		tasks.map((s) => s.status),
		["queued", "pending", "pending"],
		"all reset and re-run from the first",
	);
	assert.equal(getWorkflow(wf.id)!.status, "running");
});

test("empty step selection never happens: an instance with no steps is not started", async () => {
	const wf = armed({ steps: 0 });
	const result = await tick(DUE);
	assert.deepEqual(result.fired, [wf.id]);
	assert.equal(result.created.length, 1, "the series still continues");
	assert.equal(getWorkflow(wf.id)!.status, "draft", "nothing was started");
	assert.equal(dispatchesFor(wf.id), 0);
	const notice = listNotices({ seriesId: wf.seriesId! }).find((n) => n.kind === "failed")!;
	assert.equal(notice.reason, "no_steps");
});

// --- a missed once: Run now / Reschedule / Dismiss ----------------------------------------

test("missed once: Run now starts it (once only), Reschedule re-arms it, Dismiss releases it", async () => {
	const missedOnce = async () => {
		const wf = armed({ spec: { kind: "once", at: "2026-09-30T09:00" } });
		await tick(at(DUE, MISSED_GRACE_MS + MIN));
		assert.equal(getWorkflow(wf.id)!.scheduleState, "missed");
		return wf;
	};

	const a = await missedOnce();
	const before = workflowCount();
	const ran = await runMissedNow(a.id, cfg, silent);
	assert.equal(ran.scheduleState, "fired");
	assertStarted(a.id);
	assert.equal(workflowCount(), before, "a once creates no next instance");
	await assert.rejects(runMissedNow(a.id, cfg, silent), WorkflowError, "not twice");

	const b = await missedOnce();
	const re = rescheduleMissed(b.id, { spec: { kind: "once", at: "2026-10-05T10:00" }, timezone: "UTC" }, { now: DUE });
	assert.equal(re.scheduleState, "armed");
	assert.equal(re.seriesId, b.seriesId);
	assert.equal(re.nextRunAt, "2026-10-05T10:00:00.000Z");

	const c = await missedOnce();
	const dismissed = dismissMissed(c.id);
	assert.equal(dismissed.scheduleState, "cancelled");
	assert.equal(dismissed.status, "draft");

	// None of the three apply to a workflow that wasn't missed.
	const d = armed();
	await assert.rejects(runMissedNow(d.id, cfg, silent), /not missed/);
	assert.throws(() => dismissMissed(d.id), /not missed/);
});

// --- daemon wiring --------------------------------------------------------------------------

test("startScheduler ticks at boot and every 30s on an unref'd timer, surviving a failing tick", async () => {
	const calls: number[] = [];
	let intervalFn: (() => void) | null = null;
	let intervalMs = 0;
	let unrefed = false;
	let fail = false;
	startScheduler(cfg, silent, {
		tick: async () => {
			calls.push(Date.now());
			if (fail) throw new Error("boom");
		},
		setIntervalFn: (fn, ms) => {
			intervalFn = fn;
			intervalMs = ms;
			return {
				unref() {
					unrefed = true;
				},
			};
		},
	});
	assert.equal(calls.length, 1, "one tick at boot");
	assert.equal(intervalMs, SCHEDULER_TICK_MS);
	assert.equal(SCHEDULER_TICK_MS, 30_000);
	assert.equal(unrefed, true);
	await new Promise((r) => setImmediate(r));
	intervalFn!();
	assert.equal(calls.length, 2, "and one per interval");
	fail = true;
	await new Promise((r) => setImmediate(r));
	intervalFn!();
	await new Promise((r) => setImmediate(r));
	intervalFn!();
	assert.equal(calls.length, 4, "a failing tick doesn't stop the next");

	// The daemon wires it in.
	const daemon = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
	assert.match(daemon, /import \{ startScheduler \} from "\.\/scheduler\.ts";/);
	assert.match(daemon, /startScheduler\(cfg, log\);/);
});
