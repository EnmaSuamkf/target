/**
 * UI catalog nav: header tab filtering when TCP/RCI catalogs are hidden.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const { filterCatalogNavViews, NAV_VIEWS } = await import("./ui/src/lib/catalogNav.ts");

const uiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");

test("filterCatalogNavViews shows all tabs by default", () => {
	assert.deepEqual(filterCatalogNavViews(true, true), NAV_VIEWS);
});

test("filterCatalogNavViews hides TCP when showTcpCatalog is false", () => {
	const tabs = filterCatalogNavViews(false, true);
	assert.ok(!tabs.includes("tcps"));
	assert.ok(tabs.includes("rci"));
	assert.ok(tabs.includes("workflows"));
});

test("filterCatalogNavViews hides RCI when showRciCatalog is false", () => {
	const tabs = filterCatalogNavViews(true, false);
	assert.ok(tabs.includes("tcps"));
	assert.ok(!tabs.includes("rci"));
});

test("filterCatalogNavViews hides both catalog tabs when both flags are false", () => {
	const tabs = filterCatalogNavViews(false, false);
	assert.deepEqual(tabs, ["workflows", "templates", "settings"]);
});

test("WorkflowDetail and TemplatesView hide TCP/RCI panels when catalog flags are off", () => {
	const workflowDetail = fs.readFileSync(path.join(uiRoot, "src/views/WorkflowDetail.tsx"), "utf8");
	const templates = fs.readFileSync(path.join(uiRoot, "src/views/TemplatesView.tsx"), "utf8");
	assert.match(workflowDetail, /showTcpCatalog && <TcpPanel/);
	assert.match(workflowDetail, /showRciCatalog &&/);
	assert.match(templates, /showTcpCatalog &&/);
	assert.match(templates, /showRciCatalog &&/);
});

test("Header uses filterCatalogNavViews for desktop and mobile nav", () => {
	const header = fs.readFileSync(path.join(uiRoot, "src/components/Header.tsx"), "utf8");
	assert.match(header, /filterCatalogNavViews\(showTcpCatalog, showRciCatalog\)/);
	assert.match(header, /tabs\.map/);
	const maps = header.match(/tabs\.map/g) ?? [];
	assert.equal(maps.length, 2, "desktop tabs and mobile bottom nav should both map over filtered tabs");
});
