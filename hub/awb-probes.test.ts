/**
 * Tests for the availability probes in awb.ts. The runner and docker answers
 * are refreshed asynchronously and read back from a cache: the synchronous
 * readers (`availableRunners`, `availableSandboxes`, `dockerAvailable`) never
 * spawn, so a slow CLI can't stall the event loop under an HTTP request.
 *
 * Driven through awb's `_impl.spawn` and `_impl.adapterExists` seams with the
 * fakes in awb-probe-fakes.ts, so nothing here runs a real CLI or docker.
 *
 * Same throwaway-TARGET_HOME/AWB_HOME convention as the other suites.
 */
import * as assert from "node:assert/strict";
import type * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-awb-probes-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const {
	_impl,
	availableRunners,
	availableSandboxes,
	clearDockerProbe,
	dockerAvailable,
	probeCachedAt,
	refreshAvailableRunners,
	refreshDockerAvailable,
	runnerBinary,
} = await import("./awb.ts");
const { exitingWith, hangingChild, missingBinary } = await import("./awb-probe-fakes.ts");

/**
 * Swaps `_impl.spawn` for one that records every probe and answers it with
 * `answer`. The returned array is the record, so a test can clear and re-read
 * it. Restored when the test ends, and the cache is refreshed with the real
 * (test-setup) answers so the next test starts from a known state.
 */
function fakeSpawn(
	t: TestContext,
	answer: (bin: string, args: string[]) => cp.ChildProcess,
): { bin: string; args: string[] }[] {
	const original = _impl.spawn;
	const calls: { bin: string; args: string[] }[] = [];
	t.after(async () => {
		_impl.spawn = original;
		await refreshAvailableRunners();
		await refreshDockerAvailable(true);
	});
	_impl.spawn = ((bin: string, args: string[]) => {
		calls.push({ bin, args });
		return answer(bin, args);
	}) as unknown as typeof _impl.spawn;
	return calls;
}

test("concurrent runner refreshes share one probe per runner (single-flight)", async (t) => {
	const calls = fakeSpawn(t, () => exitingWith(0));
	const first = refreshAvailableRunners();
	const second = refreshAvailableRunners();
	assert.equal(first, second, "the second caller gets the in-flight promise back");
	await first;
	assert.equal(calls.length, 4, "one --version per runner, not one per caller");
});

test("concurrent docker refreshes share one `docker info` probe (single-flight)", async (t) => {
	clearDockerProbe();
	const calls = fakeSpawn(t, () => exitingWith(0));
	const first = refreshDockerAvailable(true);
	const second = refreshDockerAvailable(true);
	assert.equal(first, second, "the second caller gets the in-flight promise back");
	assert.equal(await first, true);
	assert.equal(calls.length, 1, "one docker probe, not one per caller");
	assert.deepEqual(calls[0]?.args, ["info", "--format", "{{.ServerVersion}}"]);
});

test("a CLI that never answers is reported not installed once the probe timeout passes", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	fakeSpawn(t, (bin) => (bin === runnerBinary("claude") ? hangingChild() : exitingWith(0)));
	const pending = refreshAvailableRunners();
	// Let the answering CLIs finish first, so only the hung probe's timer is left.
	await new Promise((resolve) => setImmediate(resolve));
	t.mock.timers.tick(5000);
	const runners = await pending;
	assert.equal(runners.find((r) => r.id === "claude")?.installed, false, "timed out → not installed");
	assert.equal(runners.find((r) => r.id === "cursor")?.installed, true, "the others are unaffected");
});

test("a binary that isn't on PATH is reported not installed, without throwing", async (t) => {
	fakeSpawn(t, (bin) => (bin === runnerBinary("copilot") ? missingBinary() : exitingWith(0)));
	const runners = await refreshAvailableRunners();
	assert.equal(runners.find((r) => r.id === "copilot")?.installed, false);
	assert.equal(runners.find((r) => r.id === "claude")?.installed, true);
});

test("a runner whose awb adapter is missing reads not installed, and is never probed", async (t) => {
	const originalAdapter = _impl.adapterExists;
	t.after(() => {
		_impl.adapterExists = originalAdapter;
	});
	_impl.adapterExists = (runner) => runner !== "cursor";
	const calls = fakeSpawn(t, () => exitingWith(0));
	const runners = await refreshAvailableRunners();
	assert.equal(runners.find((r) => r.id === "cursor")?.installed, false, "no adapter → not installed, even on PATH");
	assert.ok(!calls.some((c) => c.bin === runnerBinary("cursor")), "the CLI for a missing adapter is never spawned");
	assert.equal(runners.find((r) => r.id === "claude")?.installed, true);
});

test("the synchronous readers return the last refresh and never spawn", async (t) => {
	const calls = fakeSpawn(t, (bin) => (bin === runnerBinary("cursor") ? missingBinary() : exitingWith(0)));
	await refreshAvailableRunners();
	await refreshDockerAvailable(true);
	calls.length = 0;

	const runners = availableRunners();
	const sandboxes = availableSandboxes();
	assert.equal(dockerAvailable(), true);
	assert.equal(calls.length, 0, "reading the cache spawns nothing");

	assert.deepEqual(
		runners.map((r) => r.id),
		["claude", "free-code", "cursor", "copilot"],
	);
	assert.equal(runners.find((r) => r.id === "cursor")?.installed, false, "the last answer, not a fresh one");
	for (const runner of runners) assert.deepEqual(Object.keys(runner), ["id", "installed"]);
	assert.deepEqual(sandboxes, [
		{ id: "host", available: true },
		{ id: "docker", available: true },
	]);

	const { runners: runnersAt, docker: dockerAt } = probeCachedAt();
	assert.equal(typeof runnersAt, "number", "the runner answer carries when it was taken");
	assert.equal(typeof dockerAt, "number", "the docker answer carries when it was taken");
});

test("a fresh docker answer is reused inside its TTL, and `force` asks docker again", async (t) => {
	clearDockerProbe();
	const calls = fakeSpawn(t, () => exitingWith(0));
	assert.equal(await refreshDockerAvailable(), true);
	assert.equal(await refreshDockerAvailable(), true);
	assert.equal(calls.length, 1, "the second call inside the TTL reuses the first answer");
	assert.equal(await refreshDockerAvailable(true), true);
	assert.equal(calls.length, 2, "`force` bypasses the TTL");
});

test("until docker has answered, dockerAvailable reads unavailable — the same default as a failed probe", async (t) => {
	clearDockerProbe();
	fakeSpawn(t, () => exitingWith(0));
	assert.equal(dockerAvailable(), false);
	assert.equal(availableSandboxes().find((s) => s.id === "docker")?.available, false);
	assert.equal(await refreshDockerAvailable(true), true);
	assert.equal(dockerAvailable(), true);
});
