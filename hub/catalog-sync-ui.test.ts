import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hub = path.dirname(fileURLToPath(import.meta.url));
const ui = path.join(hub, "ui", "src");

const settings = fs.readFileSync(path.join(ui, "views", "SettingsView.tsx"), "utf8");
const app = fs.readFileSync(path.join(ui, "App.tsx"), "utf8");
const badge = fs.readFileSync(path.join(ui, "components", "Badge.tsx"), "utf8");
const templates = fs.readFileSync(path.join(ui, "views", "TemplatesView.tsx"), "utf8");
const tcps = fs.readFileSync(path.join(ui, "views", "TcpsView.tsx"), "utf8");
const rci = fs.readFileSync(path.join(ui, "views", "ResourceSetsView.tsx"), "utf8");
const createModal = fs.readFileSync(path.join(ui, "views", "CreateWorkflowModal.tsx"), "utf8");
const workflowDetail = fs.readFileSync(path.join(ui, "views", "WorkflowDetail.tsx"), "utf8");
const tcpEditor = fs.readFileSync(path.join(ui, "views", "TcpSelectionEditor.tsx"), "utf8");
const rciEditor = fs.readFileSync(path.join(ui, "views", "ResourceSelectionEditor.tsx"), "utf8");
const tcpPicker = fs.readFileSync(path.join(ui, "views", "TcpToolPickerModal.tsx"), "utf8");
const rciPicker = fs.readFileSync(path.join(ui, "views", "ResourcePickerModal.tsx"), "utf8");

test("Settings Sync resources is gated on enforced mode and a catalog sync permission", () => {
	assert.match(settings, /Sync resources/);
	assert.match(settings, /mode === "enforced"/);
	assert.match(settings, /client\.templates\.sync/);
	assert.match(settings, /client\.tcp-tools\.sync/);
	assert.match(settings, /client\.rci\.sync/);
	assert.match(settings, /Last synced/);
	assert.match(settings, /Syncing…/);
	assert.match(settings, /The server does not support resource sync/);
	assert.match(settings, /Pull the templates, TCP tools and RCI resources your role is allowed to sync from/);
});

test("catalog status rides the existing 2s permissions tick", () => {
	assert.match(app, /getCatalogSyncStatus/);
	assert.match(app, /setCatalogSyncStatusSnapshot/);
	assert.match(app, /POLL_INTERVAL_MS = 2000/);
});

test("SyncedBadge and UsagePill titles distinguish permission vs revoked", () => {
	assert.match(badge, /export function SyncedBadge/);
	assert.match(badge, /Pulled from the Target server; read-only on this hub/);
	assert.match(badge, /export function UsagePill/);
	assert.match(badge, /Requires a workflow create\/edit permission/);
	assert.match(badge, /Access revoked by the server/);
});

test("catalog lists filter All / Own / Synced and open server copies read-only", () => {
	for (const source of [templates, tcps, rci]) {
		assert.match(source, /Filter by origin/);
		assert.match(source, /"All"/);
		assert.match(source, /"Own"/);
		assert.match(source, /"Synced"/);
		assert.match(source, /CatalogCopyBadges/);
		assert.match(source, /read-only on this hub/);
	}
});

test("template pickers suffix unusable server copies with Disabled", () => {
	assert.match(createModal, /templateOptionLabel/);
	assert.match(createModal, /disabled=\{!isUsableCopy\(template\)\}/);
	assert.match(workflowDetail, /templateOptionLabel/);
	assert.match(workflowDetail, /disabled=\{!isUsableCopy\(template\)\}/);
	const helper = fs.readFileSync(path.join(ui, "lib", "catalogCopy.ts"), "utf8");
	assert.match(helper, /— Disabled/);
});

test("TCP and RCI pickers disable unusable server rows unless already selected", () => {
	assert.match(tcpEditor, /UsagePill/);
	assert.match(tcpEditor, /unusable && !attached/);
	assert.match(rciEditor, /UsagePill/);
	assert.match(rciEditor, /unusable && !attached/);
	assert.match(tcpPicker, /UsagePill/);
	assert.match(tcpPicker, /unusable && !isToolSelected/);
	assert.match(rciPicker, /UsagePill/);
	assert.match(rciPicker, /unusable && !isResourceSelected/);
});
