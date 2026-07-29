/**
 * Tests for the host install-check on POST /api/workflows: a host workflow
 * whose runner CLI isn't installed on this machine is refused with a clear
 * 400, while a docker workflow is accepted (the image ships its own binary,
 * so the host PATH is not the source of truth there).
 *
 * Both `claude` and `free-code` are installed on the dev/CI box, so the
 * uninstalled path can only be exercised by swapping awb's `_impl.spawnSync`
 * — the same indirection terminal.ts exposes for its spawn — to make a chosen
 * runner answer `--version` with a missing status. The server's host check
 * calls `availableRunners()`, which reads that seam, so the 400 is driven
 * through the real server wiring, not a stub of the route.
 *
 * Same throwaway-TARGET_HOME/AWB_HOME convention as the other suites.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-runner-install-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { _impl: awbImpl, availableRunners } = await import("./awb.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

/**
 * Swaps awb's spawnSync seam so `uninstalled` reads as not on PATH (a missing
 * binary surfaces as `status === null`) and every other runner as installed.
 * Restored when the test ends, so the real probe is back for the next one.
 */
function forceUninstalled(t: TestContext, uninstalled: string): void {
	const original = awbImpl.spawnSync;
	t.after(() => {
		awbImpl.spawnSync = original;
	});
	awbImpl.spawnSync = ((command: string) => ({
		status: command === uninstalled ? null : 0,
	})) as unknown as typeof awbImpl.spawnSync;
}

test("availableRunners reports a runner as not installed when its --version probe fails (the seam the host check relies on)", async (t) => {
	forceUninstalled(t, "free-code");
	const runners = availableRunners();
	assert.equal(runners.find((r) => r.id === "free-code")?.installed, false);
	assert.equal(runners.find((r) => r.id === "claude")?.installed, true);
});

test("GET /api/runners reflects the host probe — the create form's source of truth for which agents are selectable", async (t) => {
	forceUninstalled(t, "free-code");
	const res = await fetch(`${baseUrl}/api/runners`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { runners: { id: string; installed: boolean }[] };
	assert.equal(body.runners.find((r) => r.id === "free-code")?.installed, false);
	assert.equal(body.runners.find((r) => r.id === "claude")?.installed, true);
});

test("POST /api/workflows with a host sandbox and an uninstalled runner returns 400 with the install error", async (t) => {
	forceUninstalled(t, "free-code");

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "host free-code missing", runner: "free-code" }),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /runner 'free-code' is not installed on this host/);
	// The error points at the escape hatches (install it, or use docker).
	assert.match(body.error, /sandbox: docker/);

	// And it created nothing.
	const listRes = await fetch(`${baseUrl}/api/workflows`);
	const list = (await listRes.json()) as { workflows: { name: string }[] };
	assert.ok(!list.workflows.some((w) => w.name === "host free-code missing"));
});

test("POST /api/workflows with the default runner (claude) on host is refused when claude is uninstalled", async (t) => {
	forceUninstalled(t, "claude");

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "host default missing" }),
	});
	assert.equal(res.status, 400);
	assert.match(((await res.json()) as { error: string }).error, /runner 'claude' is not installed on this host/);
});

test("POST /api/workflows with sandbox docker is NOT rejected for a runner uninstalled on the host", async (t) => {
	forceUninstalled(t, "free-code");

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "docker free-code missing on host", runner: "free-code", sandbox: "docker" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { id: string; sandbox: string } };
	assert.equal(workflow.sandbox, "docker");
});

test("POST /api/workflows on host with an installed runner is still accepted (control)", async (t) => {
	// "__none__" never matches a real runner id, so both read as installed.
	forceUninstalled(t, "__none__");

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "host control", runner: "free-code" }),
	});
	assert.equal(res.status, 200);
});
