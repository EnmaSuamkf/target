/**
 * Permission-mode table: unlinked, linked without owner, grace then stale,
 * and a running workflow is not aborted when the role is lost.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-permission-mode-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { getWorkflow, insertStep, insertWorkflow, setWorkflowStatus } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const {
	activateDeviceCredential,
	beginDeviceLink,
	deleteDeviceLink,
} = await import("./device-link.ts");
const {
	recordOwnerSnapshot,
	resolvePermissionMode,
} = await import("./owner-permissions.ts");
const { expireStale } = await import("./workflow.ts");

const ORIGIN = "https://server.example";
const cfg = loadConfig();
const silent = (): void => {};

function owner(permissions: string[]): unknown {
	return { id: "owner_mode", permissions, granted: { groups: [] } };
}

function link(deviceId = "dev_mode"): void {
	deleteDeviceLink();
	beginDeviceLink({ origin: ORIGIN, deviceName: "mode" });
	activateDeviceCredential({
		deviceId,
		deviceSecret: "secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
}

test("an unlinked hub is unrestricted", () => {
	deleteDeviceLink();
	const mode = resolvePermissionMode();
	assert.equal(mode.mode, "unrestricted");
	if (mode.mode === "unrestricted") assert.equal(mode.reason, "not_linked");
});

test("linked with owner: null is read_only", () => {
	link();
	recordOwnerSnapshot(null, "dev_mode", ORIGIN);
	const mode = resolvePermissionMode();
	assert.equal(mode.mode, "read_only");
	if (mode.mode === "read_only") assert.equal(mode.reason, "no_owner");
});

test("a live heartbeat has grace, then the mode becomes read_only", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
	link();
	recordOwnerSnapshot(owner(["remote.read", "remote.workflows.execute"]), "dev_mode", ORIGIN);
	assert.equal(resolvePermissionMode().mode, "enforced");
	t.mock.timers.tick(30_000);
	assert.equal(resolvePermissionMode().mode, "enforced");
	t.mock.timers.tick(1);
	const mode = resolvePermissionMode();
	assert.equal(mode.mode, "read_only");
	if (mode.mode === "read_only") assert.equal(mode.reason, "stale");
});

test("a workflow already running is not aborted when the permission is lost", () => {
	link();
	recordOwnerSnapshot(owner(["remote.read", "remote.workflows.execute"]), "dev_mode", ORIGIN);
	const workflow = insertWorkflow({
		id: "wf-running",
		name: "already running",
		agentName: "agent-run",
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, "wf-running.md"),
	});
	insertStep(workflow.id, "in flight");
	setWorkflowStatus(workflow.id, "running");
	assert.equal(getWorkflow(workflow.id)?.status, "running");

	recordOwnerSnapshot(owner(["remote.read"]), "dev_mode", ORIGIN);
	assert.equal(resolvePermissionMode().mode, "enforced");
	expireStale(cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "running");

	recordOwnerSnapshot(null, "dev_mode", ORIGIN);
	assert.equal(resolvePermissionMode().mode, "read_only");
	expireStale(cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "running");
});
