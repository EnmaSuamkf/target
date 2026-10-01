/**
 * UI schedule notices: the banner under the header (what each notice says,
 * Acknowledge), and a missed `once`'s three choices — Run now, Reschedule and
 * Dismiss — offered by the banner and the workflow's detail pane.
 *
 * Same approach as ui-archive.test.ts: pure logic from ui/src/lib is tested
 * directly, every call the banner and the detail make is made against a
 * throwaway hub's real endpoints, and the views are checked at source level.
 * Run now really starts the workflow, on a fake awb hook that accepts the
 * dispatch.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ScheduleNotice, Workflow } from "./ui/src/api/types.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-ui-schedule-notices-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { isMissedOnce, missedOnceFor, NOTICE_TITLES, noticeMessage, noticeTone } = await import(
	"./ui/src/lib/scheduleNotices.ts"
);
const { draftFromSchedule, hasLiveSchedule, scheduleInputFromDraft } = await import("./ui/src/lib/scheduleForm.ts");
const { insertStep, insertWorkflow, recordNotice, updateWorkflowSchedule } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const uiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const read = (rel: string): string => fs.readFileSync(path.join(uiRoot, rel), "utf8");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;

// A fake awb hook: accepts every dispatch and never calls back.
const hook = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
const hookAddress = hook.address();
if (!hookAddress || typeof hookAddress === "string") throw new Error("fake hook did not bind");
const hookBase = `http://127.0.0.1:${hookAddress.port}/hook`;

test.after(() => {
	server.close();
	hook.close();
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function api<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
	const res = await fetch(`${baseUrl}${route}`, {
		method,
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: res.status, body: (await res.json()) as T };
}

const openNotices = async () =>
	(await api<{ notices: ScheduleNotice[] }>("GET", "/api/schedule-notices?unacknowledged=1")).body.notices;
const workflowsById = async () =>
	new Map((await api<{ workflows: Workflow[] }>("GET", "/api/workflows?archived=include")).body.workflows.map((w) => [w.id, w]));

let seq = 0;
/**
 * A `once` the hub was offline for: scheduled for a future time, then left
 * `missed` the way the scheduler leaves it, with the notice it records.
 */
async function missedOnce(): Promise<{ id: string; notice: ScheduleNotice }> {
	seq += 1;
	const id = `wf-missed-${seq}`;
	insertWorkflow({
		id,
		name: `Report ${seq}`,
		agentName: `missed-agent-${seq}`,
		hookUrl: `${hookBase}/${id}`,
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	insertStep(id, "write the report");
	const put = await api<{ workflow: Workflow }>("PUT", `/api/workflows/${id}/schedule`, {
		spec: { kind: "once", at: "2099-01-01T09:00" },
		timezone: "UTC",
		includePrevious: true,
	});
	assert.equal(put.status, 200);
	updateWorkflowSchedule(id, { scheduleState: "missed", nextRunAt: null, scheduledFor: "2026-09-30T09:00:00.000Z" });
	const notice = recordNotice({
		workflowId: id,
		seriesId: put.body.workflow.schedule!.seriesId,
		kind: "missed",
		reason: "offline",
		detail: { message: "The run scheduled for 2026-09-30 09:00 was missed because the hub was offline." },
	}) as unknown as ScheduleNotice;
	return { id, notice };
}

// --- banner rendering -------------------------------------------------------------

test("banner rendering: each notice's own message, its title and tone; a generic line when it has none", () => {
	const base = { detail: {} };
	assert.equal(noticeMessage({ kind: "skipped", detail: { message: "The run was skipped because the previous run was still in progress." } }), "The run was skipped because the previous run was still in progress.");
	assert.match(noticeMessage({ kind: "broken", ...base }), /No further runs happen until it is rescheduled/);
	assert.equal(noticeTone("broken"), "error");
	assert.equal(noticeTone("failed"), "error");
	assert.equal(noticeTone("missed"), "warn");
	assert.equal(noticeTone("skipped"), "warn");
	assert.equal(NOTICE_TITLES.missed, "Missed");
});

test("banner rendering: the hub's unacknowledged notices are what the banner shows, with actions only on a missed once", async () => {
	const { id, notice } = await missedOnce();
	const other = recordNotice({ kind: "skipped", reason: "busy", detail: { message: "The run was skipped." } });

	const notices = await openNotices();
	const shown = notices.find((n) => n.id === notice.id)!;
	assert.ok(shown, "the missed notice is listed");
	assert.equal(noticeMessage(shown), "The run scheduled for 2026-09-30 09:00 was missed because the hub was offline.");
	assert.ok(notices.some((n) => n.id === other.id));

	const byId = await workflowsById();
	assert.equal(missedOnceFor(shown, byId)?.id, id, "a notice about a missed once offers its choices");
	assert.equal(missedOnceFor(notices.find((n) => n.id === other.id)!, byId), null, "a notice without a workflow offers none");

	// A server-managed series is decided on the server (D15).
	const serverManaged = { ...byId.get(id)!, schedule: { ...byId.get(id)!.schedule!, managedBy: "server" as const } };
	assert.equal(missedOnceFor(shown, new Map([[id, serverManaged]])), null);
});

test("banner rendering: App shows the banner under the header, fed by the notices poll", () => {
	const app = read("src/App.tsx");
	assert.match(app, /<Header\s[^<]*?\/>\s*<NoticesBanner/, "directly under the header");
	assert.match(app, /setNotices\(await api\.listScheduleNotices\(\)\)/);
	assert.match(app, /usePolling\(refreshNotices, NOTICES_POLL_INTERVAL_MS\)/);
	assert.match(read("src/api/client.ts"), /"\/api\/schedule-notices\?unacknowledged=1"/);
	const banner = read("src/components/NoticesBanner.tsx");
	assert.match(banner, /if \(notices\.length === 0\) return null;/);
	assert.match(banner, /\{noticeMessage\(notice\)\}/);
	assert.match(banner, /const missed = missedOnceFor\(notice, workflowsById\)/);
	assert.match(banner, /\{missed && \(\s*<MissedOnceActions/);
});

// --- acknowledge ----------------------------------------------------------------------

test("acknowledge: the notice leaves the banner's list and the workflow is untouched", async () => {
	const { id, notice } = await missedOnce();
	const ack = await api<{ notice: ScheduleNotice }>("POST", `/api/schedule-notices/${notice.id}/ack`);
	assert.equal(ack.status, 200);
	assert.ok(ack.body.notice.acknowledgedAt);
	assert.ok(!(await openNotices()).some((n) => n.id === notice.id));
	assert.equal(isMissedOnce((await workflowsById()).get(id)), true, "acknowledging decides nothing");

	const banner = read("src/components/NoticesBanner.tsx");
	assert.match(banner, /onClick=\{\(\) => onAcknowledge\(notice\.id\)\}[\s\S]*?data-acknowledge-notice/);
	const app = read("src/App.tsx");
	assert.match(app, /await api\.acknowledgeScheduleNotice\(id\);\s*\/\/[^\n]*\n\s*setNotices\(\(current\) => current\.filter\(\(n\) => n\.id !== id\)\)/);
	assert.match(read("src/api/client.ts"), /`\/api\/schedule-notices\/\$\{id\}\/ack`/);
});

// --- the three missed-once actions ------------------------------------------------------------

test("Run now: starts the missed once exactly once, and its choices disappear", async () => {
	const { id, notice } = await missedOnce();
	const run = await api<{ workflow: Workflow }>("POST", `/api/workflows/${id}/schedule/run-now`);
	assert.equal(run.status, 200);
	assert.equal(run.body.workflow.schedule?.state, "fired");
	assert.equal(run.body.workflow.status, "running");
	assert.equal((await api<{ error: string }>("POST", `/api/workflows/${id}/schedule/run-now`)).body.error, "not_missed");
	assert.equal(missedOnceFor(notice, await workflowsById()), null, "the banner stops offering the choices");

	const app = read("src/App.tsx");
	assert.match(app, /const handleRunMissedNow = async \(workflow: Workflow\)[\s\S]*?api\.runMissedScheduleNow\(workflow\.id\)/);
	assert.match(app, /onRunNow=\{\(workflow\) => void handleRunMissedNow\(workflow\)\}/);
	assert.match(read("src/api/client.ts"), /`\/api\/workflows\/\$\{id\}\/schedule\/run-now`/);
});

test("Reschedule: opens the schedule dialog and saves through the reschedule endpoint", async () => {
	const { id } = await missedOnce();
	const missed = (await workflowsById()).get(id)!;
	// What the dialog sends: its draft, loaded from the missed schedule, moved to a new time.
	const input = scheduleInputFromDraft({ ...draftFromSchedule(missed.schedule), date: "2099-06-01", time: "10:30" })!;
	assert.deepEqual(input.spec, { kind: "once", at: "2099-06-01T10:30" });
	const res = await api<{ workflow: Workflow }>("POST", `/api/workflows/${id}/schedule/reschedule`, input);
	assert.equal(res.status, 200);
	assert.equal(res.body.workflow.schedule?.state, "armed");
	assert.equal(res.body.workflow.nextRunAt, "2099-06-01T10:30:00.000Z");
	assert.equal(res.body.workflow.schedule?.seriesId, missed.schedule?.seriesId, "same series");

	const app = read("src/App.tsx");
	assert.match(app, /missed\s*\? await api\.rescheduleMissedSchedule\(workflow\.id, input\)\s*: await api\.setWorkflowSchedule/);
	assert.match(app, /onReschedule=\{\(workflow\) => void openRescheduleFromNotice\(workflow\)\}/);
	assert.match(app, /<ScheduleModal\s+open\s+workflow=\{rescheduleTarget\.workflow\}/);
	assert.match(read("src/views/ScheduleModal.tsx"), /"Reschedule missed run"/);
	assert.match(read("src/views/WorkflowDetail.tsx"), /onReschedule=\{\(\) => setScheduling\(true\)\}/);
});

test("Dismiss: gives up on the missed once — a normal workflow again, nothing run", async () => {
	const { id, notice } = await missedOnce();
	const res = await api<{ workflow: Workflow }>("POST", `/api/workflows/${id}/schedule/dismiss`);
	assert.equal(res.status, 200);
	assert.equal(isMissedOnce(res.body.workflow), false);
	assert.equal(hasLiveSchedule(res.body.workflow), false);
	assert.notEqual(res.body.workflow.status, "running");
	assert.equal(missedOnceFor(notice, await workflowsById()), null);

	const app = read("src/App.tsx");
	assert.match(app, /const handleDismissMissed = async \(workflow: Workflow\)[\s\S]*?api\.dismissMissedSchedule\(workflow\.id\)/);
	assert.match(app, /onDismiss=\{\(workflow\) => void handleDismissMissed\(workflow\)\}/);
	assert.match(read("src/api/client.ts"), /`\/api\/workflows\/\$\{id\}\/schedule\/dismiss`/);
});

test("the detail pane offers the same three choices on a missed once, gated on execute AND manage", () => {
	const detail = read("src/views/WorkflowDetail.tsx");
	assert.match(detail, /\{isMissedOnce\(workflow\) && scheduleMode\.mode !== "readonly" && \(/);
	assert.match(detail, /data-missed-once/);
	assert.match(detail, /<MissedOnceActions\s+canAct=\{canSchedule\}/);
	assert.match(detail, /onRunNow=\{onRunMissedNow\}/);
	assert.match(detail, /onDismiss=\{onDismissMissed\}/);
	const app = read("src/App.tsx");
	assert.match(app, /onRunMissedNow=\{\(\) => selectedWorkflow && void handleRunMissedNow\(selectedWorkflow\)\}/);
	assert.match(app, /onDismissMissed=\{\(\) => selectedWorkflow && void handleDismissMissed\(selectedWorkflow\)\}/);
	const actions = read("src/components/MissedOnceActions.tsx");
	for (const label of ["Run now", "Reschedule", "Dismiss"]) assert.match(actions, new RegExp(`>\\s*${label}\\s*<`), label);
	assert.match(actions, /const disabled = busy \|\| !canAct;/);
});
