/**
 * The workflow filter toolbar's building blocks: the pure view-model helpers
 * (option counts, applied-filter list, badge count) are tested directly, and the
 * components at source level — same approach as ui-schedule-list.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Workflow, WorkflowSchedule } from "./ui/src/api/types.ts";

const { filterAndSort } = await import("./ui/src/lib/workflowFilter.ts");
const {
	appliedFilters,
	countFilterOptions,
	DEFAULT_FILTER_STATE,
	filtersButtonCount,
	withoutFilter,
} = await import("./ui/src/lib/workflowFilterView.ts");

const uiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const read = (rel: string): string => fs.readFileSync(path.join(uiRoot, rel), "utf8");

function schedule(overrides: Partial<WorkflowSchedule> = {}): WorkflowSchedule {
	return { seriesId: "s1", state: "armed", ...overrides } as WorkflowSchedule;
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

const ARCHIVED = "2026-09-20T00:00:00.000Z";
const fixtures: Workflow[] = [
	wf("run-1", { status: "running" }),
	wf("run-2", { status: "running", origin: "remote" }),
	wf("wait-1", { status: "waiting", origin: "remote" }),
	wf("done-1", { status: "completed" }),
	wf("fail-1", { status: "failed", origin: "remote" }),
	wf("armed-1", { schedule: schedule({ seriesId: "s1" }) }),
	wf("fired-1", { status: "completed", schedule: schedule({ seriesId: "s1", state: "fired" }) }),
	wf("old-1", { status: "completed", archivedAt: ARCHIVED }),
	wf("old-2", { status: "failed", origin: "remote", archivedAt: ARCHIVED, schedule: schedule({ seriesId: "s1", state: "fired" }) }),
];

test("with nothing applied, every count equals what picking that option shows", () => {
	const counts = countFilterOptions(fixtures, DEFAULT_FILTER_STATE);
	const n = (...args: Parameters<typeof filterAndSort>) => filterAndSort(...args).length;
	assert.equal(counts.status.all, n(fixtures, "", "all", "all", "active", "all"));
	assert.equal(counts.status.running, 2);
	assert.equal(counts.status.waiting, 1);
	assert.equal(counts.status.paused, 0, "a status with no workflows is counted as 0, not dropped");
	assert.equal(counts.archive.archived, 2);
	assert.equal(counts.archive.active, counts.status.all);
	assert.equal(counts.origin.local + counts.origin.remote, counts.origin.all);
	assert.equal(counts.origin.remote, 3);
	assert.equal(counts.schedule.scheduled, 1);
	assert.equal(counts.schedule.runs, 1, "the archived run is on the other side of the archive");
});

test("each count is computed with all OTHER filters applied and ignores its own dimension", () => {
	const state = { ...DEFAULT_FILTER_STATE, origin: "remote" as const };
	const counts = countFilterOptions(fixtures, state);
	// Status counts follow the origin filter…
	assert.equal(counts.status.running, 1);
	assert.equal(counts.status.completed, 0);
	assert.equal(counts.status.all, 3);
	// …but the origin counts ignore the origin filter itself.
	assert.equal(counts.origin.local, 4);
	assert.equal(counts.origin.remote, 3);
	assert.equal(counts.origin.all, 7);

	const runs = countFilterOptions(fixtures, { ...DEFAULT_FILTER_STATE, schedule: "runs" });
	assert.deepEqual([runs.status.all, runs.status.completed, runs.status.running], [1, 1, 0]);
	assert.equal(runs.schedule.scheduled, 1, "the schedule counts ignore the schedule filter");

	const searched = countFilterOptions(fixtures, { ...DEFAULT_FILTER_STATE, query: "run-" });
	assert.equal(searched.status.all, 2, "search narrows every count");
});

test("archive counts ignore the status filter, because switching archive side resets it", () => {
	const counts = countFilterOptions(fixtures, { ...DEFAULT_FILTER_STATE, status: "running" });
	assert.equal(counts.archive.archived, 2, "archived (completed/failed) is still 2 while 'running' is picked");
	assert.equal(counts.archive.active, 7);
});

test("on the archived side the counts follow that scope", () => {
	const counts = countFilterOptions(fixtures, { ...DEFAULT_FILTER_STATE, archive: "archived" });
	assert.equal(counts.status.all, 2);
	assert.equal(counts.status.running, 0);
	assert.equal(counts.status.failed, 1);
	assert.equal(counts.schedule.runs, 1);
	assert.equal(counts.schedule.scheduled, 0);
});

test("counting does not change the logic it calls", () => {
	const before = filterAndSort(fixtures, "", "all", "all", "active", "all").map((w) => w.id);
	countFilterOptions(fixtures, { ...DEFAULT_FILTER_STATE, origin: "remote", schedule: "runs" });
	assert.deepEqual(filterAndSort(fixtures, "", "all", "all", "active", "all").map((w) => w.id), before);
});

test("appliedFilters lists only non-default filters, in chip order", () => {
	assert.deepEqual(appliedFilters(DEFAULT_FILTER_STATE), []);
	assert.deepEqual(appliedFilters({ ...DEFAULT_FILTER_STATE, query: "   " }), [], "blank search is not applied");
	assert.deepEqual(
		appliedFilters({ query: " deploy ", status: "failed", origin: "remote", archive: "archived", schedule: "runs" }),
		[
			{ key: "query", label: "“deploy”" },
			{ key: "status", label: "Failed" },
			{ key: "archive", label: "Archived" },
			{ key: "origin", label: "Remote" },
			{ key: "schedule", label: "Past runs" },
		],
	);
	assert.deepEqual(appliedFilters({ ...DEFAULT_FILTER_STATE, origin: "local", schedule: "scheduled" }), [
		{ key: "origin", label: "Local" },
		{ key: "schedule", label: "Upcoming runs" },
	]);
});

test("withoutFilter resets exactly one dimension", () => {
	const state = { query: "x", status: "failed" as const, origin: "remote" as const, archive: "archived" as const, schedule: "runs" as const };
	assert.deepEqual(withoutFilter(state, "origin"), { ...state, origin: "all" });
	assert.deepEqual(withoutFilter(state, "archive"), { ...state, archive: "active" });
	assert.deepEqual(withoutFilter(state, "query"), { ...state, query: "" });
	let cleared = state;
	for (const a of appliedFilters(state)) cleared = withoutFilter(cleared, a.key);
	assert.deepEqual(cleared, DEFAULT_FILTER_STATE);
});

test("the Filters button counts non-default popover filters only; search never counts", () => {
	const page = { includeStatus: false };
	const rail = { includeStatus: true };
	assert.equal(filtersButtonCount(DEFAULT_FILTER_STATE, page), 0);
	assert.equal(filtersButtonCount({ ...DEFAULT_FILTER_STATE, query: "abc" }, rail), 0);
	const two = { ...DEFAULT_FILTER_STATE, origin: "remote" as const, schedule: "runs" as const };
	assert.equal(filtersButtonCount(two, page), 2);
	const withStatus = { ...two, status: "failed" as const };
	assert.equal(filtersButtonCount(withStatus, page), 2, "on the page the status tabs are visible, not in the popover");
	assert.equal(filtersButtonCount(withStatus, rail), 3);
	assert.equal(filtersButtonCount({ ...DEFAULT_FILTER_STATE, archive: "archived" }, page), 1);
});

test("the popover has exactly the three labeled sections, with the agreed copy and footer", () => {
	const src = read("src/views/WorkflowFilters.tsx");
	const copy = read("src/lib/workflowFilterView.ts");
	assert.match(copy, /show: \{ title: "Show", open: "Open", archived: "Archived" \}/);
	assert.match(copy, /created: \{ title: "Created", all: "Anywhere", local: "Local", remote: "Remote" \}/);
	assert.match(copy, /scheduling: \{ title: "Scheduling", all: "Any", scheduled: "Upcoming runs", runs: "Past runs" \}/);
	const popover = src.slice(src.indexOf("export function FiltersPopover("), src.indexOf("export function StatusSection"));
	assert.equal((popover.match(/<FilterSection</g) ?? []).length, 3, "Show, Created, Scheduling");
	for (const title of ["show.title", "created.title", "scheduling.title"]) assert.ok(popover.includes(`title={${title}}`), title);
	assert.match(popover, /Clear all\s*<\/button>/);
	assert.match(popover, /Done\s*<\/button>/);
	assert.match(popover, /ev\.key !== "Escape"/);
	assert.match(popover, /addEventListener\("mousedown"/);
	assert.match(popover, /anchor\?\.focus\(\)/, "focus returns to the trigger");
	// Radio semantics; zero-match options stay in the DOM, greyed, with (0).
	assert.match(src, /role="radiogroup"/);
	assert.match(src, /role="radio"/);
	assert.match(src, /aria-checked=\{selected\}/);
	assert.match(src, /\{`\(\$\{o\.count\}\)`\}/);
});

test("status tabs, the trigger badge and the applied row are wired as specified", () => {
	const src = read("src/views/WorkflowFilters.tsx");
	assert.match(src, /label="All" count=\{counts\.all\}/);
	assert.match(src, /disabled=\{counts\[s\] === 0 && value !== s\}/);
	assert.match(src, /\.sort\(\(a, b\) => STATUS_ORDER\[a\] - STATUS_ORDER\[b\]\)/);
	assert.match(src, /\{count > 0 && <span className=\{styles\.badge\}>\{`· \$\{count\}`\}<\/span>\}/);
	assert.match(src, /if \(applied\.length === 0\) return null/);
	assert.match(src, /Showing:/);
	const css = read("src/views/WorkflowFilters.module.css");
	assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.popover \{[^}]*position: fixed/, "bottom sheet on phones");
});

test("the rail shows search + Filters (status inside the popover); the page adds the status tabs; both show the applied row", () => {
	const list = read("src/views/WorkflowList.tsx");
	assert.match(list, /\{!isRail && <StatusTabs value=\{filter\} counts=\{counts\.status\} onChange=\{setFilter\} \/>\}/);
	assert.match(list, /leadingSection=\{isRail \? <StatusSection/);
	assert.match(list, /filtersButtonCount\(state, \{ includeStatus: isRail \}\)/);
	assert.match(list, /<AppliedRow filters=\{filters\} className=\{styles\.railApplied\} \/>/);
	assert.match(list, /<FilterToolbar \{\.\.\.filters\} variant="page" autoFocus \/>\s*<AppliedRow filters=\{filters\} \/>/);
	assert.equal((list.match(/<AppliedFilterChips/g) ?? []).length, 1, "one shared chips row");
});

test("the old chip groups and their copy are gone from the workflow list", () => {
	const list = read("src/views/WorkflowList.tsx");
	for (const gone of ["All origins", "All statuses", "Scheduled runs", "data-archive-filter", "data-schedule-filter", "Filter by origin", "Filter by schedule", "Filter by archive state"]) {
		assert.ok(!list.includes(gone), gone);
	}
	const css = read("src/views/WorkflowList.module.css");
	assert.ok(!/\.filters?\b|\.filterActive/.test(css), "dead chip-group CSS is removed");
	assert.match(read("src/lib/workflowFilter.ts"), /Open Filters and choose Show: Archived/);
});
