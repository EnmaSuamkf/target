/**
 * UI scheduling in the lists and the detail pane: the schedule badges, the
 * run gate on an armed instance, the rail's / All workflows page's schedule
 * filter, and the series panel.
 *
 * Same approach as ui-archive.test.ts: pure logic from ui/src/lib (no
 * React/CSS) is tested directly, the views at source level, and the data the
 * lists and the panel read comes from a throwaway hub's real API.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Workflow, WorkflowSchedule, WorkflowScheduleDetail } from "./ui/src/api/types.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-ui-schedule-list-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const {
	filterBySchedule,
	formatInZone,
	isArmedInstance,
	isScheduledRun,
	presentScheduleFilters,
	relativeFuture,
	SCHEDULED_ARMED_TITLE,
	scheduleBadge,
	seriesPanelRows,
} = await import("./ui/src/lib/scheduleView.ts");
const { filterAndSort } = await import("./ui/src/lib/workflowFilter.ts");
const { insertStep, insertWorkflow, updateWorkflowSchedule } = await import("./db.ts");
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

test.after(() => {
	server.close();
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

const NOW = new Date("2026-09-30T06:00:00.000Z");

function schedule(overrides: Partial<WorkflowSchedule> = {}): WorkflowSchedule {
	return {
		seriesId: "series-1",
		seriesName: "Nightly audit",
		spec: { kind: "daily", time: "09:00" },
		timezone: "Europe/Madrid",
		includePrevious: true,
		state: "armed",
		scheduledFor: "2026-09-30T07:00:00.000Z",
		nextRunAt: "2026-09-30T07:00:00.000Z",
		previousInstanceId: null,
		previousRunBlock: null,
		managedBy: "local",
		announcedAt: null,
		...overrides,
	};
}

function wf(id: string, overrides: Partial<Workflow> = {}): Workflow {
	return {
		id,
		name: `wf ${id}`,
		agentName: `agent-${id}`,
		status: "draft",
		origin: "local",
		archivedAt: null,
		schedule: null,
		nextRunAt: null,
		updatedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	} as Workflow;
}

// --- badges ----------------------------------------------------------------------

test("armed badge: 'Scheduled · next <relative>' with the absolute time and zone in the tooltip", () => {
	const badge = scheduleBadge(wf("a", { schedule: schedule() }), NOW)!;
	assert.equal(badge.tone, "scheduled");
	assert.equal(badge.label, "Scheduled · next in 1h");
	assert.match(badge.title, /2026-09-30 09:00 \(Europe\/Madrid\)/, "07:00Z is 09:00 in Madrid (CEST)");
	assert.equal(relativeFuture("2026-09-30T06:10:00.000Z", NOW), "in 10m");
	assert.equal(relativeFuture("2026-10-02T06:00:00.000Z", NOW), "in 2d");
	assert.equal(relativeFuture("2026-09-30T05:00:00.000Z", NOW), "due now");
});

test("fired badge: 'Run of <series_name> · <scheduled_for>' in the schedule's zone", () => {
	const badge = scheduleBadge(
		wf("b", { name: "Nightly audit · 2026-09-29 09:00", schedule: schedule({ state: "fired", nextRunAt: null, scheduledFor: "2026-09-29T07:00:00.000Z" }) }),
		NOW,
	)!;
	assert.equal(badge.tone, "run");
	assert.equal(badge.label, "Run of Nightly audit · 2026-09-29 09:00");
	assert.equal(formatInZone("2026-09-29T07:00:00.000Z", "America/New_York"), "2026-09-29 03:00");
});

test("missed and broken badges use the warning style; outside a series or cancelled, no badge", () => {
	const missed = scheduleBadge(wf("c", { schedule: schedule({ state: "missed", nextRunAt: null }) }), NOW)!;
	assert.equal(missed.tone, "warning");
	assert.equal(missed.label, "Missed run");
	assert.match(missed.title, /Run now, Reschedule or Dismiss/);
	const broken = scheduleBadge(wf("d", { schedule: schedule({ state: "broken", nextRunAt: null }) }), NOW)!;
	assert.equal(broken.tone, "warning");
	assert.equal(broken.label, "Schedule broken");
	assert.match(broken.title, /No further runs happen until it is rescheduled/);
	assert.equal(scheduleBadge(wf("e"), NOW), null);
	assert.equal(scheduleBadge(wf("f", { schedule: schedule({ state: "cancelled" }) }), NOW), null);
});

test("ScheduleBadge renders the tone as a badge class, and is shown on WorkflowCard and in the detail header", () => {
	const badge = read("src/components/Badge.tsx");
	assert.match(badge, /export function ScheduleBadge/);
	assert.match(badge, /className=\{`badge badge--schedule-\$\{info\.tone\}`\} title=\{info\.title\}/);
	const css = read("src/styles/global.css");
	for (const tone of ["scheduled", "run", "warning"]) assert.match(css, new RegExp(`\\.badge--schedule-${tone} \\{`), tone);
	assert.match(css, /\.badge--schedule-warning \{\s*background: var\(--attention-50\)/, "warning borrows the attention colours");
	const list = read("src/views/WorkflowList.tsx");
	assert.match(list, /function WorkflowCard[\s\S]*<ScheduleBadge workflow=\{workflow\} \/>/);
	assert.match(read("src/views/WorkflowDetail.tsx"), /<ScheduleBadge workflow=\{workflow\} \/>/);
});

// --- run gate on armed instances ------------------------------------------------------

test("armed instances: Start/Restart and Run step are disabled with 'Scheduled — runs automatically'", () => {
	assert.equal(SCHEDULED_ARMED_TITLE, "Scheduled — runs automatically");
	assert.equal(isArmedInstance(wf("a", { schedule: schedule() })), true);
	assert.equal(isArmedInstance(wf("b", { schedule: schedule({ state: "fired" }) })), false, "a fired run is a normal workflow");
	const detail = read("src/views/WorkflowDetail.tsx");
	assert.match(detail, /const scheduledArmed = isArmedInstance\(workflow\)/);
	// No start action → the one run control (Start / Resume / Restart) is disabled.
	assert.match(detail, /const startAction = scheduledArmed \? null : canExecute && !archived \? startActionFor/);
	assert.match(detail, /disabled=\{!startAction \|\|/);
	assert.match(detail, /: scheduledArmed\s*\? SCHEDULED_ARMED_TITLE/);
	assert.equal((detail.match(/scheduledArmed=\{scheduledArmed\}/g) ?? []).length, 2, "both step lists pass the gate");
	const step = read("src/views/StepItem.tsx");
	// Retry on an armed instance: rendered disabled with the tooltip; the live one never renders there.
	assert.match(step, /\{failed && !isContext && scheduledArmed && \(\s*<button[^>]*disabled title=\{SCHEDULED_ARMED_TITLE\}/);
	assert.match(step, /\{failed && !isContext && !scheduledArmed && \(\s*<button[\s\S]*?onClick=\{\(\) => onRunStep\(step\.id\)\}/);
});

// --- the schedule filter ---------------------------------------------------------------

const listFixtures: Workflow[] = [
	wf("armed-1", { schedule: schedule({ seriesId: "s1" }) }),
	// A list refreshed mid-fire may hold two armed instances of one series for a moment.
	wf("armed-1b", { schedule: schedule({ seriesId: "s1" }), updatedAt: "2026-08-01T00:00:00.000Z" }),
	wf("armed-2", { schedule: schedule({ seriesId: "s2" }) }),
	wf("run-1", { status: "completed", schedule: schedule({ seriesId: "s1", state: "fired" }) }),
	wf("run-2", { status: "failed", schedule: schedule({ seriesId: "s1", state: "broken" }) }),
	wf("run-archived", {
		status: "completed",
		archivedAt: "2026-09-20T00:00:00.000Z",
		schedule: schedule({ seriesId: "s2", state: "fired" }),
	}),
	wf("plain"),
	wf("plain-archived", { status: "completed", archivedAt: "2026-09-20T00:00:00.000Z" }),
];

const ids = (list: Workflow[]) => list.map((w) => w.id).sort();

test("'Scheduled' shows armed instances only, one per series; 'Scheduled runs' shows fired ones", () => {
	assert.deepEqual(ids(filterAndSort(listFixtures, "", "all", "all", "active", "scheduled")), ["armed-1", "armed-2"]);
	assert.deepEqual(ids(filterAndSort(listFixtures, "", "all", "all", "active", "runs")), ["run-1", "run-2"]);
	assert.equal(filterAndSort(listFixtures, "", "all", "all", "active", "all").length, 6, "'All' leaves the list alone");
	assert.ok(isScheduledRun(listFixtures[3]!) && !isScheduledRun(listFixtures[0]!));
});

test("the schedule filter composes with the Archived filter, status and search", () => {
	assert.deepEqual(ids(filterAndSort(listFixtures, "", "all", "all", "archived", "runs")), ["run-archived"]);
	assert.deepEqual(ids(filterAndSort(listFixtures, "", "all", "all", "archived", "scheduled")), []);
	assert.deepEqual(ids(filterAndSort(listFixtures, "", "failed", "all", "active", "runs")), ["run-2"]);
	assert.deepEqual(ids(filterAndSort(listFixtures, "run-1", "all", "all", "active", "runs")), ["run-1"]);
	assert.deepEqual(presentScheduleFilters(listFixtures), ["scheduled", "runs"]);
	assert.deepEqual(presentScheduleFilters([wf("x")]), [], "no group when nothing is scheduled");
	assert.deepEqual(filterBySchedule([wf("x")], "scheduled"), []);
});

test("the Scheduling section is in the shared toolbar, so the rail AND the All workflows page get it", () => {
	const list = read("src/views/WorkflowList.tsx");
	const popover = read("src/views/WorkflowFilters.tsx");
	assert.match(popover, /<FilterSection<ScheduleFilter>[\s\S]*title=\{scheduling\.title\}/);
	assert.match(read("src/lib/workflowFilterView.ts"), /scheduling: \{ title: "Scheduling", all: "Any", scheduled: "Upcoming runs", runs: "Past runs" \}/);
	// The logic module keeps its own labels; the toolbar uses the plain-language ones.
	assert.match(read("src/lib/scheduleView.ts"), /scheduled: "Scheduled",\s*runs: "Scheduled runs"/);
	assert.match(list, /filterBySchedule\(filterAndSort\(workflows, query, filter, originFilter, archive\), scheduleFilter\)/);
	// Both surfaces own their filter state and render the same toolbar from it.
	assert.equal((list.match(/const filters = useWorkflowFilters\(workflows\)/g) ?? []).length, 2);
	assert.match(list, /export function WorkflowList[\s\S]*<FilterToolbar \{\.\.\.filters\} variant="rail" \/>/);
	assert.match(list, /export function AllWorkflowsPage[\s\S]*<FilterToolbar \{\.\.\.filters\} variant="page" autoFocus \/>/);
	// The page returns to page 1 when the schedule filter changes, like every other filter.
	assert.match(list, /\[query, filter, originFilter, archive, scheduleFilter\]/);
});

test("the list the shell fetches carries the schedule the filters and badges read", async () => {
	insertWorkflow({
		id: "wf-list-sched",
		name: "Listed nightly",
		agentName: "list-sched-agent",
		hookUrl: "http://127.0.0.1:1/hook/wf-list-sched",
		secret: "s",
		mdPath: path.join(tmpHome, "wf-list-sched.md"),
	});
	insertStep("wf-list-sched", "collect");
	const put = await api("PUT", "/api/workflows/wf-list-sched/schedule", {
		spec: { kind: "daily", time: "09:00" },
		timezone: "UTC",
		includePrevious: true,
	});
	assert.equal(put.status, 200);
	const list = (await api<{ workflows: Workflow[] }>("GET", "/api/workflows?archived=include")).body.workflows;
	const scheduled = filterAndSort(list, "", "all", "all", "active", "scheduled");
	assert.deepEqual(scheduled.map((w) => w.id), ["wf-list-sched"]);
	assert.match(scheduleBadge(scheduled[0]!)!.label, /^Scheduled · next in \d+[mhd]$/);
});

// --- series panel -----------------------------------------------------------------------

test("series panel rows: newest first, the next run marked, the open one marked", () => {
	const detail: Pick<WorkflowScheduleDetail, "instances" | "schedule"> = {
		schedule: schedule(),
		instances: [
			{ id: "first", name: "Nightly audit", status: "completed", scheduleState: "fired", scheduledFor: "2026-09-28T07:00:00.000Z" },
			{ id: "next", name: "Nightly audit · 2026-10-01 09:00", status: "draft", scheduleState: "armed", scheduledFor: "2026-10-01T07:00:00.000Z" },
			{ id: "second", name: "Nightly audit · 2026-09-29 09:00", status: "failed", scheduleState: "fired", scheduledFor: "2026-09-29T07:00:00.000Z" },
		],
	};
	const rows = seriesPanelRows(detail, "second");
	assert.deepEqual(rows.map((r) => r.id), ["next", "second", "first"]);
	assert.deepEqual(rows.map((r) => r.marker), ["next", "this", null]);
	assert.deepEqual(rows.map((r) => r.when), ["2026-10-01 09:00", "2026-09-29 09:00", "2026-09-28 09:00"]);
	assert.deepEqual(rows.map((r) => r.status), ["draft", "failed", "completed"]);
});

test("series panel reads the series from the hub, including a past run", async () => {
	insertWorkflow({
		id: "wf-series-armed",
		name: "Series panel",
		agentName: "series-armed-agent",
		hookUrl: "http://127.0.0.1:1/hook/wf-series-armed",
		secret: "s",
		mdPath: path.join(tmpHome, "wf-series-armed.md"),
	});
	insertStep("wf-series-armed", "collect");
	const put = await api<{ workflow: Workflow }>("PUT", "/api/workflows/wf-series-armed/schedule", {
		spec: { kind: "daily", time: "09:00" },
		timezone: "UTC",
		includePrevious: true,
	});
	const seriesId = put.body.workflow.schedule!.seriesId;
	// A past run of the same series, as the scheduler leaves one behind.
	insertWorkflow({
		id: "wf-series-past",
		name: "Series panel · 2026-09-29 09:00",
		agentName: "series-past-agent",
		hookUrl: "http://127.0.0.1:1/hook/wf-series-past",
		secret: "s",
		mdPath: path.join(tmpHome, "wf-series-past.md"),
	});
	updateWorkflowSchedule("wf-series-past", {
		seriesId,
		seriesName: "Series panel",
		schedule: { kind: "daily", time: "09:00" },
		scheduleTimezone: "UTC",
		scheduleState: "fired",
		scheduledFor: "2026-09-29T09:00:00.000Z",
	});

	const detail = (await api<WorkflowScheduleDetail>("GET", "/api/workflows/wf-series-past/schedule")).body;
	const rows = seriesPanelRows(detail, "wf-series-past");
	assert.deepEqual(rows.map((r) => r.id), ["wf-series-armed", "wf-series-past"]);
	assert.deepEqual(rows.map((r) => r.marker), ["next", "this"]);
	assert.equal(rows[1]!.when, "2026-09-29 09:00");
});

test("SeriesPanel lists instances with status badges and links, and WorkflowDetail shows it", () => {
	const panel = read("src/views/SeriesPanel.tsx");
	assert.match(panel, /getWorkflowSchedule\(workflow\.id\)/);
	assert.match(panel, /seriesPanelRows\(detail, workflow\.id\)/);
	assert.match(panel, /href=\{`#\/w\/\$\{row\.id\}`\}/, "each instance links to it (the shell selects #/w/<id>)");
	assert.match(panel, /<Badge status=\{row\.status\} \/>/);
	assert.match(panel, /if \(!seriesId\) return null;/, "nothing outside a series");
	assert.match(panel, /data-series-panel/);
	assert.match(read("src/views/WorkflowDetail.tsx"), /<SeriesPanel workflow=\{workflow\} \/>/);
});
