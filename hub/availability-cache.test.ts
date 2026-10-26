/**
 * Tests for how the HTTP surface reads the availability cache:
 *
 *  - GET /api/runners answers from the cache, so a probe that is still running
 *    (a slow CLI, a hung docker) never delays the create form.
 *  - The create route's host and docker checks use the cache when it already
 *    says installed, and otherwise probe only the one runner or docker the
 *    request selected, never the others.
 *  - The 400 answers for an unavailable runner or docker are unchanged.
 *
 * Driven through awb's `_impl.spawn` seam with the fakes in awb-probe-fakes.ts,
 * against a real server on an ephemeral port. Same throwaway-TARGET_HOME/AWB_HOME
 * convention as the other suites.
 */
import * as assert from "node:assert/strict";
import type * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-availability-cache-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { _impl: awbImpl, refreshAvailableRunners, refreshDockerAvailable, runnerBinary } = await import("./awb.ts");
const { exitingWith, missingBinary, slowExit } = await import("./awb-probe-fakes.ts");
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

type SpawnCall = { bin: string; args: string[] };

/**
 * Swaps `_impl.spawn` for one that records each probe and answers it with
 * `answer()`, read at call time, so a test can change the machine's state
 * between two requests. Restored when the test ends, and the cache is
 * refreshed back to the real answers.
 */
function fakeMachine(
	t: TestContext,
	answer: (bin: string) => cp.ChildProcess,
): { calls: SpawnCall[]; answer: typeof answer } {
	const original = awbImpl.spawn;
	const calls: SpawnCall[] = [];
	const machine = { calls, answer };
	t.after(async () => {
		awbImpl.spawn = original;
		await refreshAvailableRunners();
		await refreshDockerAvailable(true);
	});
	awbImpl.spawn = ((bin: string, args: string[]) => {
		calls.push({ bin, args });
		return machine.answer(bin);
	}) as unknown as typeof awbImpl.spawn;
	return machine;
}

const freeCodeBinary = runnerBinary("free-code");

test("GET /api/runners answers from the cache while a probe is still running", async (t) => {
	const machine = fakeMachine(t, () => slowExit(1500, 0));
	const refreshing = refreshAvailableRunners();
	assert.ok(machine.calls.length > 0, "the slow probe is running");

	const started = performance.now();
	const res = await fetch(`${baseUrl}/api/runners`, { headers: adminHeaders() });
	const elapsed = performance.now() - started;
	assert.equal(res.status, 200);
	assert.ok(elapsed < 100, `answered in ${elapsed.toFixed(0)} ms while the probe was still running`);

	const body = (await res.json()) as {
		runners: { id: string; installed: boolean; models: unknown[] }[];
		sandboxes: { id: string; available: boolean }[];
	};
	assert.ok(body.runners.length > 0, "the runner half is unchanged");
	assert.ok(body.runners.every((r) => Array.isArray(r.models)), "models still come from enabledModels() per request");
	assert.ok(body.sandboxes.some((s) => s.id === "docker"));
	await refreshing;
});

test("creating a host workflow probes only the selected runner, and only because the cache says it is missing", async (t) => {
	const machine = fakeMachine(t, (bin) => (bin === freeCodeBinary ? missingBinary() : exitingWith(0)));
	await refreshAvailableRunners();
	assert.equal((await fetchRunners()).find((r) => r.id === "free-code")?.installed, false);

	// free-code is installed now; the cache is still stale until the create probes it.
	machine.answer = () => exitingWith(0);
	machine.calls.length = 0;
	const res = await createWorkflow({ name: "host free-code installed since refresh", runner: "free-code" });
	assert.equal(res.status, 200);
	assert.deepEqual(
		machine.calls.map((c) => c.bin),
		[freeCodeBinary],
		"one probe, for the selected runner only",
	);
	assert.equal((await fetchRunners()).find((r) => r.id === "free-code")?.installed, true, "the answer updates the cache");
});

test("creating a host workflow whose runner the cache already lists as installed probes nothing", async (t) => {
	const machine = fakeMachine(t, () => exitingWith(0));
	await refreshAvailableRunners();
	machine.calls.length = 0;
	const res = await createWorkflow({ name: "host claude cached", runner: "claude" });
	assert.equal(res.status, 200);
	assert.equal(machine.calls.length, 0, "the cache answered; nothing spawned");
});

test("the host runner check still refuses an unavailable runner with the same 400", async (t) => {
	const machine = fakeMachine(t, (bin) => (bin === freeCodeBinary ? missingBinary() : exitingWith(0)));
	await refreshAvailableRunners();
	machine.calls.length = 0;
	const res = await createWorkflow({ name: "host free-code missing", runner: "free-code" });
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /^runner 'free-code' is not installed on this host \(install it or use sandbox: docker/);
	assert.deepEqual(
		machine.calls.map((c) => c.bin),
		[freeCodeBinary],
		"the refused runner was probed once; the others were not probed at all",
	);
});

test("creating a docker workflow picks up a daemon started since the last refresh", async (t) => {
	const machine = fakeMachine(t, (bin) => (bin === "docker" ? missingBinary() : exitingWith(0)));
	await refreshDockerAvailable(true);
	machine.answer = () => exitingWith(0);
	machine.calls.length = 0;
	const res = await createWorkflow({ name: "docker started since refresh", sandbox: "docker" });
	assert.equal(res.status, 200);
	assert.deepEqual(
		machine.calls.map((c) => c.bin),
		["docker"],
		"one `docker info`, and no runner was probed",
	);
});

test("the docker check still refuses with the same 400 when docker is down now too", async (t) => {
	const machine = fakeMachine(t, () => missingBinary());
	await refreshDockerAvailable(true);
	machine.calls.length = 0;
	const res = await createWorkflow({ name: "docker still down", sandbox: "docker" });
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /^docker is not available on this host \(no docker on PATH, or the daemon isn't running\)/);
	assert.deepEqual(
		machine.calls.map((c) => c.bin),
		["docker"],
		"docker was probed; no runner was probed",
	);
});

async function createWorkflow(body: Record<string, unknown>): Promise<Response> {
	return fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify(body),
	});
}

async function fetchRunners(): Promise<{ id: string; installed: boolean }[]> {
	const res = await fetch(`${baseUrl}/api/runners`, { headers: adminHeaders() });
	return ((await res.json()) as { runners: { id: string; installed: boolean }[] }).runners;
}
