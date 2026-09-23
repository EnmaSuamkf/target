import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hub = path.dirname(fileURLToPath(import.meta.url));
const settings = fs.readFileSync(path.join(hub, "ui", "src", "views", "SettingsView.tsx"), "utf8");
const remoteConfig = fs.readFileSync(path.join(hub, "remote-config.ts"), "utf8");
const workflow = fs.readFileSync(path.join(hub, "workflow.ts"), "utf8");

test("linked consent UI warns before connection and hides local remote-service controls", () => {
	assert.match(settings, /explicitly allow this server to receive Activity and full conversation text/);
	assert.match(settings, /aria-describedby=\{`\$\{linkId\}-consent`\}/);
	assert.match(settings, /\{linkStatus\?\.state !== "connected" && <form className=\{styles\.section\} aria-labelledby=\{`\$\{reportId\}-section`\}/);
	assert.doesNotMatch(settings, /setSyncEnabled|saveSyncSettings/);
	assert.match(settings, /label="Remote Sync"/);
});

test("linked ingest forces full prose payload and ignores legacy privacy/off preferences", () => {
	assert.match(remoteConfig, /includeConversations: "full"/);
	assert.match(workflow, /const rc = loadEffectiveReportConfig\(\)/);
	assert.match(workflow, /Number\.MAX_SAFE_INTEGER/);
	assert.match(workflow, /data\.text = preview\.text/);
	assert.match(workflow, /tool calls, hidden thinking and transport records/);
});
