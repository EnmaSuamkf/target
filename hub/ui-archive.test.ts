/**
 * UI archiving: list filtering (rail + All workflows page), the ArchivedBadge,
 * WorkflowDetail's Archive/Unarchive and run-control gating, the Settings
 * auto-archive field, and the client calls behind them.
 *
 * Pure logic is imported from ui/src/lib (no React/CSS), the views are checked
 * at source level (same approach as ui-catalog-nav.test.ts), and the settings
 * endpoint the UI talks to is exercised against a throwaway hub (same approach
 * as ui-settings.test.ts).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Workflow } from "./ui/src/api/types.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-ui-archive-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { emptyListMessage, filterAndSort, isArchivable, isArchived, presentStatuses, scopeByArchive } = await import(
	"./ui/src/lib/workflowFilter.ts"
);
const { parseArchiveAfterDays } = await import("./ui/src/lib/archiveSettings.ts");
const { normalizeArchiveAfterDays } = await import("./db.ts");
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

function wf(id: string, overrides: Partial<Workflow> = {}): Workflow {
	return {
		id,
		name: `wf ${id}`,
		agentName: `agent-${id}`,
		status: "completed",
		origin: "local",
		archivedAt: null,
		updatedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	} as Workflow;
}

const fixtures: Workflow[] = [
	wf("a", { status: "running" }),
	wf("b", { status: "completed" }),
	wf("c", { status: "completed", archivedAt: "2026-09-20T00:00:00.000Z" }),
	wf("d", { status: "failed", archivedAt: "2026-09-21T00:00:00.000Z" }),
	wf("e", { status: "draft" }),
];

// --- list filtering (shared by the rail and the All workflows page) ---

test("archived workflows are hidden by default", () => {
	const ids = filterAndSort(fixtures, "", "all", "all").map((w) => w.id);
	assert.deepEqual(ids.sort(), ["a", "b", "e"]);
	assert.ok(!ids.includes("c") && !ids.includes("d"));
});

test("the Archived filter shows only archived workflows", () => {
	const ids = filterAndSort(fixtures, "", "all", "all", "archived").map((w) => w.id);
	assert.deepEqual(ids.sort(), ["c", "d"]);
	assert.deepEqual(scopeByArchive(fixtures, "archived").map((w) => w.id), ["c", "d"]);
	assert.deepEqual(scopeByArchive(fixtures, "active").map((w) => w.id), ["a", "b", "e"]);
});

test("search and status filters compose with the archive scope", () => {
	assert.deepEqual(filterAndSort(fixtures, "wf d", "all", "all", "archived").map((w) => w.id), ["d"]);
	assert.deepEqual(filterAndSort(fixtures, "wf d", "all", "all", "active"), []);
	assert.deepEqual(filterAndSort(fixtures, "", "failed", "all", "archived").map((w) => w.id), ["d"]);
	// Status chips offered follow the scope: archived work is only completed/failed.
	assert.deepEqual(presentStatuses(scopeByArchive(fixtures, "archived")), ["failed", "completed"]);
});

test("empty states distinguish no archived / no active / no matches", () => {
	assert.equal(emptyListMessage(0, 0, "active"), null);
	assert.equal(emptyListMessage(3, 0, "archived")?.title, "No archived workflows");
	assert.equal(emptyListMessage(2, 0, "active")?.title, "No active workflows");
	assert.equal(emptyListMessage(5, 3, "active")?.title, "No matches");
});

test("isArchived / isArchivable mirror the hub's rules", () => {
	assert.equal(isArchived(wf("x")), false);
	assert.equal(isArchived(wf("x", { archivedAt: "2026-09-01T00:00:00.000Z" })), true);
	for (const status of ["completed", "failed"] as const) assert.equal(isArchivable(wf("x", { status })), true);
	for (const status of ["draft", "running", "paused", "waiting"] as const) assert.equal(isArchivable(wf("x", { status })), false);
});

test("the rail and the All workflows page both go through the archive-aware filter hook", () => {
	const list = read("src/views/WorkflowList.tsx");
	const hookCalls = list.match(/useWorkflowFilters\(workflows\)/g) ?? [];
	assert.equal(hookCalls.length, 2, "rail and page should each own their filter state");
	assert.match(list, /filterAndSort\(workflows, query, filter, originFilter, archive\)/);
	// Archived toggle uses the same button-group pattern as the origin filter.
	assert.match(list, /role="group" aria-label="Filter by archive state"/);
	assert.match(list, /onClick=\{\(\) => setArchive\("archived"\)\}/);
	assert.match(list, /aria-pressed=\{archive === "archived"\}/);
	// The rail uses the shared toolbar instead of its own copy.
	assert.match(list, /<FilterToolbar \{\.\.\.filters\} \/>/);
	assert.match(list, /<FilterToolbar \{\.\.\.filters\} autoFocus \/>/);
});

test("the app shell fetches archived workflows too so the filter and selection work", () => {
	const app = read("src/App.tsx");
	assert.match(app, /api\.listWorkflows\(\{ archived: "include" \}\)/);
	const client = read("src/api/client.ts");
	assert.match(client, /`\/api\/workflows\$\{query\}`/);
	assert.match(client, /\?archived=\$\{encodeURIComponent\(options\.archived\)\}/);
});

// --- ArchivedBadge ---

test("ArchivedBadge renders only for archived workflows and is shown on WorkflowCard", () => {
	const badge = read("src/components/Badge.tsx");
	assert.match(badge, /export function ArchivedBadge\(\{ archivedAt \}/);
	assert.match(badge, /if \(!archivedAt\) return null;/);
	assert.match(badge, /className="badge badge--archived"/);
	const css = read("src/styles/global.css");
	assert.match(css, /\.badge--archived \{/);
	const list = read("src/views/WorkflowList.tsx");
	assert.match(list, /<ArchivedBadge archivedAt=\{workflow\.archivedAt\} \/>/);
});

// --- WorkflowDetail ---

test("WorkflowDetail offers Archive/Unarchive and blocks runs on archived workflows", () => {
	const detail = read("src/views/WorkflowDetail.tsx");
	assert.match(detail, /<ArchivedBadge archivedAt=\{workflow\.archivedAt\} \/>/);
	assert.match(detail, /data-archive-workflow/);
	assert.match(detail, /data-unarchive-workflow/);
	assert.match(detail, /disabled=\{busy \|\| !canManage \|\| !archivable\}/);
	assert.match(detail, /Only completed or failed workflows can be archived\./);
	// Start / Resume / Start over is one button; an archived workflow gets no start action.
	assert.match(detail, /canExecute && !archived \? startActionFor\(workflow\.status\) : null/);
	assert.match(detail, /unarchive it to run it again/);
	// Step Retry (POST .../run) is gated too.
	assert.match(detail, /archived=\{archived\}/);
	const stepItem = read("src/views/StepItem.tsx");
	assert.match(stepItem, /disabled=\{busy \|\| !canExecute \|\| archived\}/);
	const app = read("src/App.tsx");
	assert.match(app, /api\.archiveWorkflow\(workflow\.id\)/);
	assert.match(app, /api\.unarchiveWorkflow\(workflow\.id\)/);
	const client = read("src/api/client.ts");
	assert.match(client, /`\/api\/workflows\/\$\{id\}\/archive`/);
	assert.match(client, /`\/api\/workflows\/\$\{id\}\/unarchive`/);
});

// --- Settings: archive_after_days ---

test("parseArchiveAfterDays accepts non-negative integers only (0 disables)", () => {
	assert.deepEqual(parseArchiveAfterDays("0"), { ok: true, value: 0 });
	assert.deepEqual(parseArchiveAfterDays(" 30 "), { ok: true, value: 30 });
	for (const bad of ["", "-1", "1.5", "abc", "1e3", "99999999999999999999"]) {
		assert.equal(parseArchiveAfterDays(bad).ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("parseArchiveAfterDays agrees with the hub's normalizeArchiveAfterDays", () => {
	for (const raw of ["0", "1", "30", "365", "-1", "1.5", "abc", "99999999999999999999"]) {
		const ui = parseArchiveAfterDays(raw);
		const hub = normalizeArchiveAfterDays(raw);
		assert.equal(ui.ok, hub !== null, `disagreement on ${raw}`);
		if (ui.ok) assert.equal(ui.value, hub);
	}
});

test("SettingsView has the archive_after_days field wired to the archive settings API", () => {
	const settings = read("src/views/SettingsView.tsx");
	assert.match(settings, /data-archive-after-days/);
	assert.match(settings, /useState\(String\(archiveSettings\.archive_after_days\)\)/);
	assert.match(settings, /parseArchiveAfterDays\(archiveAfterDays\)/);
	assert.match(settings, /onSaveArchive\(\{ archive_after_days: parsed\.value \}\)/);
	assert.match(settings, /0 to turn auto-archiving off/);
	const app = read("src/App.tsx");
	assert.match(app, /api\.getArchiveSettings\(\)/);
	assert.match(app, /api\.saveArchiveSettings\(input\)/);
	assert.match(app, /archiveSettings=\{archiveSettings\}/);
	const client = read("src/api/client.ts");
	assert.match(client, /request<\{ settings: ArchiveSettings \}>\("\/api\/settings\/archive"\)/);
	assert.match(client, /request<\{ settings: ArchiveSettings \}>\("\/api\/settings\/archive", \{\s*method: "PUT",\s*admin: true,/);
});

test("GET/PUT /api/settings/archive round-trips the value the Settings field saves", async () => {
	const initial = await fetch(`${baseUrl}/api/settings/archive`, { headers: adminHeaders() });
	assert.equal(initial.status, 200);
	const initialBody = (await initial.json()) as { settings: { archive_after_days: number; updatedAt: string | null } };
	assert.equal(initialBody.settings.archive_after_days, 30);

	const put = await fetch(`${baseUrl}/api/settings/archive`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ archive_after_days: 0 }),
	});
	assert.equal(put.status, 200);
	const putBody = (await put.json()) as { settings: { archive_after_days: number; updatedAt: string | null } };
	assert.equal(putBody.settings.archive_after_days, 0);
	assert.ok(putBody.settings.updatedAt);

	const bad = await fetch(`${baseUrl}/api/settings/archive`, {
		method: "PUT",
		headers: adminHeaders(),
		body: JSON.stringify({ archive_after_days: -1 }),
	});
	assert.equal(bad.status, 400);

	const unauth = await fetch(`${baseUrl}/api/settings/archive`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ archive_after_days: 7 }),
	});
	assert.equal(unauth.status, 401);
});
