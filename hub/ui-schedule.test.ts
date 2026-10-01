/**
 * UI scheduling: the ScheduleModal and the WorkflowDetail "Schedule" action.
 *
 * Same approach as ui-archive.test.ts: the form's logic lives in
 * ui/src/lib/scheduleForm.ts (no React/CSS) and is tested directly; what the
 * form SENDS is sent to a throwaway hub, so create / edit / cancel / preview are
 * checked against the real API the dialog talks to; and the views are checked
 * at source level for the wiring that can't be exercised without a browser.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { SchedulePreview, Step, Workflow } from "./ui/src/api/types.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-ui-schedule-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const {
	ADOPTED_REASON,
	browserTimeZone,
	describeSpec,
	draftErrorsFromServer,
	draftFromSchedule,
	filterTimeZones,
	hasLiveSchedule,
	manualReviewWarning,
	previewLines,
	scheduleAvailability,
	scheduleInputFromDraft,
	SERVER_MANAGED_REASON,
	timeZoneOptions,
	toggleDay,
	validateDraft,
} = await import("./ui/src/lib/scheduleForm.ts");
const { insertStep, insertWorkflow, open } = await import("./db.ts");
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

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

async function api<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
	const res = await fetch(`${baseUrl}${route}`, {
		method,
		headers: adminHeaders(),
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: res.status, body: (await res.json()) as T };
}

let seq = 0;
/** A draft workflow with task steps; `manualReview` marks the second one gated. */
function seedWorkflow(options: { manualReview?: boolean } = {}): string {
	seq += 1;
	const id = `wf-ui-sched-${seq}`;
	insertWorkflow({
		id,
		name: `Nightly ${seq}`,
		agentName: `ui-sched-agent-${seq}`,
		hookUrl: `http://127.0.0.1:1/hook/${id}`,
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	insertStep(id, "collect");
	insertStep(id, "review", { manualReview: options.manualReview ?? false });
	return id;
}

const getWorkflow = async (id: string) => (await api<{ workflow: Workflow }>("GET", `/api/workflows/${id}`)).body.workflow;

// --- the form's logic --------------------------------------------------------------

test("a new schedule defaults to once, tomorrow 09:00, the browser's timezone, previous-run reference on", () => {
	const now = new Date("2026-09-30T12:00:00.000Z");
	const draft = draftFromSchedule(null, { now, timezone: "Europe/Madrid" });
	assert.deepEqual(
		{ kind: draft.kind, date: draft.date, time: draft.time, timezone: draft.timezone, includePrevious: draft.includePrevious },
		{ kind: "once", date: "2026-10-01", time: "09:00", timezone: "Europe/Madrid", includePrevious: true },
	);
	// Without an explicit zone the default is Intl's own — what the modal uses.
	assert.equal(draftFromSchedule(null).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
	assert.equal(browserTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("the draft builds each kind's spec, and refuses what the hub would refuse", () => {
	const base = draftFromSchedule(null, { timezone: "UTC" });
	assert.deepEqual(scheduleInputFromDraft({ ...base, kind: "once", date: "2030-01-02", time: "07:30" }), {
		spec: { kind: "once", at: "2030-01-02T07:30" },
		timezone: "UTC",
		includePrevious: true,
	});
	assert.deepEqual(scheduleInputFromDraft({ ...base, kind: "daily", time: "23:05", includePrevious: false })?.spec, {
		kind: "daily",
		time: "23:05",
	});
	assert.deepEqual(scheduleInputFromDraft({ ...base, kind: "weekly", days: [5, 1, 1], time: "09:00" })?.spec, {
		kind: "weekly",
		days: [1, 5],
		time: "09:00",
	});
	assert.deepEqual(validateDraft({ ...base, kind: "weekly", days: [] }), { days: "Pick at least one day." });
	assert.equal(scheduleInputFromDraft({ ...base, kind: "weekly", days: [] }), null);
	assert.ok(validateDraft({ ...base, time: "25:00" }).time);
	assert.ok(validateDraft({ ...base, kind: "once", date: "" }).date);
	assert.deepEqual(toggleDay([1, 3], 3), [1]);
	assert.deepEqual(toggleDay([3], 0), [0, 3]);
	assert.deepEqual(draftErrorsFromServer([{ field: "at", message: "the scheduled time must be in the future" }]), {
		date: "the scheduled time must be in the future",
	});
});

test("the timezone list is searchable and always contains the zone in use", () => {
	const zones = timeZoneOptions("Europe/Madrid");
	assert.ok(zones.includes("Europe/Madrid") && zones.includes("UTC"));
	assert.ok(zones.length > 100, "the runtime's full IANA list");
	assert.deepEqual(filterTimeZones(zones, "new york"), ["America/New_York"]);
	assert.deepEqual(filterTimeZones(zones, "eur mad"), ["Europe/Madrid"]);
	assert.equal(filterTimeZones(zones, "").length, zones.length);
	assert.ok(timeZoneOptions("Asia/Calcutta").includes("Asia/Calcutta"), "a link reported by a browser stays selectable");
});

test("describeSpec summarises a schedule for the read-only view", () => {
	assert.equal(describeSpec({ kind: "once", at: "2026-10-01T09:00" }, "UTC"), "Once on 2026-10-01 at 09:00 (UTC)");
	assert.equal(describeSpec({ kind: "daily", time: "06:15" }, "Europe/Madrid"), "Every day at 06:15 (Europe/Madrid)");
	assert.equal(describeSpec({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" }, null), "Every weekday at 09:00");
	assert.equal(describeSpec({ kind: "weekly", days: [1, 3], time: "09:00" }, null), "Every Mon, Wed at 09:00");
});

// --- create / edit / cancel against the real API ----------------------------------------

test("create: the modal's input schedules the workflow; the detail then offers Edit", async () => {
	const id = seedWorkflow();
	const before = await getWorkflow(id);
	assert.deepEqual(scheduleAvailability(before), { mode: "create" });
	assert.equal(hasLiveSchedule(before), false);

	const input = scheduleInputFromDraft({ ...draftFromSchedule(before.schedule, { timezone: "Europe/Madrid" }), kind: "daily", time: "09:00" });
	assert.ok(input);
	const put = await api<{ workflow: Workflow }>("PUT", `/api/workflows/${id}/schedule`, input);
	assert.equal(put.status, 200);
	const saved = put.body.workflow;
	assert.equal(saved.schedule?.state, "armed");
	assert.equal(saved.schedule?.managedBy, "local");
	assert.deepEqual(saved.schedule?.spec, { kind: "daily", time: "09:00" });
	assert.equal(saved.schedule?.timezone, "Europe/Madrid");
	assert.equal(saved.schedule?.includePrevious, true);
	assert.ok(saved.nextRunAt);
	assert.deepEqual(scheduleAvailability(saved), { mode: "edit" });
	assert.equal(hasLiveSchedule(saved), true);
});

test("edit: an existing schedule loads into the form and saving changes it in place", async () => {
	const id = seedWorkflow();
	const created = await api<{ workflow: Workflow }>("PUT", `/api/workflows/${id}/schedule`, {
		spec: { kind: "weekly", days: [1, 3], time: "08:30" },
		timezone: "America/New_York",
		includePrevious: false,
	});
	const seriesId = created.body.workflow.schedule!.seriesId;

	const draft = draftFromSchedule(created.body.workflow.schedule);
	assert.equal(draft.kind, "weekly");
	assert.deepEqual(draft.days, [1, 3]);
	assert.equal(draft.time, "08:30");
	assert.equal(draft.timezone, "America/New_York", "the stored zone wins over the browser's");
	assert.equal(draft.includePrevious, false);

	const edited = scheduleInputFromDraft({ ...draft, days: toggleDay(draft.days, 5), includePrevious: true });
	const put = await api<{ workflow: Workflow }>("PUT", `/api/workflows/${id}/schedule`, edited);
	assert.equal(put.status, 200);
	assert.deepEqual(put.body.workflow.schedule?.spec, { kind: "weekly", days: [1, 3, 5], time: "08:30" });
	assert.equal(put.body.workflow.schedule?.includePrevious, true);
	assert.equal(put.body.workflow.schedule?.seriesId, seriesId, "editing keeps the series");

	const invalid = await api<{ error: string; message: string; fields: { field: "at"; message: string }[] }>(
		"PUT",
		`/api/workflows/${id}/schedule`,
		{ spec: { kind: "once", at: "2020-01-01T09:00" }, timezone: "UTC", includePrevious: true },
	);
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.error, "invalid_schedule");
	assert.ok(draftErrorsFromServer(invalid.body.fields).date, "the hub's field error lands on the Date field");
});

test("cancel: Cancel schedule turns it back into a normal workflow", async () => {
	const id = seedWorkflow();
	await api("PUT", `/api/workflows/${id}/schedule`, { spec: { kind: "daily", time: "10:00" }, timezone: "UTC", includePrevious: true });
	const del = await api<{ workflow: Workflow }>("DELETE", `/api/workflows/${id}/schedule`);
	assert.equal(del.status, 200);
	assert.equal(del.body.workflow.schedule?.state, "cancelled");
	assert.equal(del.body.workflow.nextRunAt, null);
	assert.equal(hasLiveSchedule(del.body.workflow), false);
	assert.deepEqual(scheduleAvailability(del.body.workflow), { mode: "create" }, "it can be scheduled again");
});

// --- preview ----------------------------------------------------------------------------

test("preview: the next 3 runs come from the hub and render as local times", async () => {
	const draft = { ...draftFromSchedule(null, { timezone: "Europe/Madrid" }), kind: "daily" as const, time: "09:00" };
	const input = scheduleInputFromDraft(draft)!;
	const res = await api<SchedulePreview>("POST", "/api/schedule/preview", { spec: input.spec, timezone: input.timezone });
	assert.equal(res.status, 200);
	const lines = previewLines(res.body, draft.kind);
	assert.equal(lines.length, 3);
	for (const line of lines) assert.match(line, /^\d{4}-\d{2}-\d{2} 09:00$/);

	const past = await api<SchedulePreview>("POST", "/api/schedule/preview", {
		spec: { kind: "once", at: "2020-01-01T09:00" },
		timezone: "UTC",
	});
	assert.deepEqual(previewLines(past.body, "once"), ["That time has already passed — pick one in the future."]);
	assert.deepEqual(previewLines(null, "daily"), []);
});

test("preview: the modal asks the hub (debounced) and renders previewLines in its Next runs box", () => {
	const src = read("src/views/ScheduleModal.tsx");
	assert.match(src, /previewSchedule\(spec, draft\.timezone\)/);
	assert.match(src, /PREVIEW_DEBOUNCE_MS/);
	assert.match(src, /data-schedule-preview/);
	assert.match(src, /previewLines\(preview, draft\.kind\)\.map/);
	const client = read("src/api/client.ts");
	assert.match(client, /"\/api\/schedule\/preview"/);
});

// --- manual-review warning ------------------------------------------------------------------

test("manual-review warning: shown when any task step has manual review, not otherwise", async () => {
	const steps = (id: string) => api<{ steps: Step[] }>("GET", `/api/workflows/${id}`).then((r) => r.body.steps);
	const gated = await steps(seedWorkflow({ manualReview: true }));
	assert.match(manualReviewWarning(gated) ?? "", /1 step has manual review enabled.*waits until someone presses Continue/);
	assert.equal(manualReviewWarning(await steps(seedWorkflow())), null);
	assert.match(
		manualReviewWarning([
			{ kind: "task", manualReview: true, description: "a" },
			{ kind: "task", manualReview: true, description: "b" },
			{ kind: "context", manualReview: true, description: "ctx" },
		]) ?? "",
		/^2 steps have/,
		"the hub-owned context step never counts",
	);
	const src = read("src/views/ScheduleModal.tsx");
	assert.match(src, /const warning = manualReviewWarning\(steps\)/);
	assert.match(src, /data-manual-review-warning/);
});

// --- read-only / disabled ------------------------------------------------------------------------

test("server-managed series: read-only view, local edits refused with 409 server_managed", async () => {
	const id = seedWorkflow();
	await api("PUT", `/api/workflows/${id}/schedule`, { spec: { kind: "daily", time: "09:00" }, timezone: "UTC", includePrevious: true });
	open().prepare("UPDATE workflows SET managed_by = 'server' WHERE id = ?").run(id);
	const wf = await getWorkflow(id);
	assert.deepEqual(scheduleAvailability(wf), { mode: "readonly", reason: SERVER_MANAGED_REASON });

	const put = await api<{ error: string }>("PUT", `/api/workflows/${id}/schedule`, {
		spec: { kind: "daily", time: "10:00" },
		timezone: "UTC",
		includePrevious: true,
	});
	assert.equal(put.status, 409);
	assert.equal(put.body.error, "server_managed");
	assert.equal((await api<{ error: string }>("DELETE", `/api/workflows/${id}/schedule`)).status, 409);

	const src = read("src/views/ScheduleModal.tsx");
	assert.match(src, /readOnly = availability\.mode === "readonly"/);
	assert.match(src, /data-schedule-readonly/);
	assert.match(src, /\{!readOnly && \(\s*<button\s+type="submit"/, "no Save in the read-only view");
	assert.match(src, /\{editing && \(/, "Cancel schedule only when editing — never read-only");
	assert.match(src, /const locked = readOnly \|\|/, "every field is disabled read-only");
});

test("adopted conversations can't be scheduled: explained in the dialog and on the disabled button", () => {
	const wf = {
		schedule: null,
		adoptedSessionId: "sess-1",
		status: "draft",
		archivedAt: null,
	} as unknown as Workflow;
	assert.deepEqual(scheduleAvailability(wf), { mode: "disabled", reason: ADOPTED_REASON });
	assert.equal(
		scheduleAvailability({ ...wf, adoptedSessionId: null, status: "running" } as Workflow).mode,
		"disabled",
		"nor can a workflow in progress",
	);
	const modal = read("src/views/ScheduleModal.tsx");
	assert.match(modal, /availability\.mode === "disabled"/);
	assert.match(modal, /data-schedule-disabled/);
	const detail = read("src/views/WorkflowDetail.tsx");
	assert.match(detail, /Boolean\(workflow\.adoptedSessionId\)/);
	assert.match(detail, /adopted conversation, so it can't be scheduled/);
});

// --- wiring -----------------------------------------------------------------------------------

test("WorkflowDetail has the Schedule action opening ScheduleModal, gated on execute AND manage", () => {
	const detail = read("src/views/WorkflowDetail.tsx");
	assert.match(detail, /data-schedule-workflow/);
	assert.match(detail, /hasLiveSchedule\(workflow\) \? "Edit schedule" : "Schedule"/);
	assert.match(detail, /<ScheduleModal[\s\S]*open=\{scheduling\}/);
	assert.match(detail, /const canSchedule = canExecute && canManage/);
	const app = read("src/App.tsx");
	assert.match(app, /onSaveSchedule=\{handleSaveSchedule\}/);
	assert.match(app, /onCancelSchedule=\{handleCancelSchedule\}/);
	const client = read("src/api/client.ts");
	for (const fn of ["getWorkflowSchedule", "setWorkflowSchedule", "cancelWorkflowSchedule", "previewSchedule"]) {
		assert.match(client, new RegExp(`export async function ${fn}\\(`), fn);
	}
	assert.match(client, /method: "PUT",[\s\S]*?body: json\(input\)/);
	assert.match(client, /method: "DELETE"/);
});

test("ScheduleModal has every field: kind, date, time, weekdays, timezone search, previous-run toggle", () => {
	const src = read("src/views/ScheduleModal.tsx");
	assert.match(src, /SCHEDULE_KINDS\.map/);
	assert.match(src, /type="date"/);
	assert.match(src, /type="time"/);
	assert.match(src, /WEEKDAYS\.map/);
	assert.match(src, /placeholder="Search timezones…"/);
	assert.match(src, /filterTimeZones\(zones, zoneQuery\)/);
	assert.match(src, /Include a reference to the previous run/);
	assert.match(src, /import \{ Field \} from "\.\.\/components\/Field\.tsx"/);
	assert.match(src, /import \{ Modal \} from "\.\.\/components\/Modal\.tsx"/);
	assert.match(src, /import styles from "\.\/ScheduleModal\.module\.css"/);
	assert.match(read("src/lib/scheduleForm.ts"), /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
});
