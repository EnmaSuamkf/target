/**
 * Tests for treating docker as an OPTIONAL capability of the host, rather than
 * assuming it: the hub probes for it, reports it next to the runner probe, and
 * refuses a docker workflow it knows can't run.
 *
 * The defect this pins: `sandbox: "docker"` was offered unconditionally and
 * resolved to an image nobody had built, so the first step died with docker's
 * own `Unable to find image 'target-agent:latest' locally` / `pull access
 * denied … may require 'docker login'` — a registry-login error for an image
 * that is only ever built locally, which sends the operator exactly the wrong
 * way. Three guards, tested here:
 *
 *  - the probe (`dockerAvailable`), which asks `docker info` rather than
 *    `docker --version`, so a stopped daemon reads as unavailable
 *  - `GET /api/runners`, which now reports sandboxes too — the create form's
 *    source of truth for which options to render at all
 *  - the create route, which rejects a docker workflow with a clear 400
 *    instead of leaving the UI as the only gate
 *
 *  - `ensureSandboxImage`, which BUILDS a missing default image at dispatch
 *    time instead of letting the broker's `docker run` try to pull one that
 *    was never published
 *
 * plus `explainRunError`, which rewrites that docker text on its way into a
 * step's stored error.
 *
 * Docker is installed on the dev box and absent on CI, so neither answer can
 * be taken from the real machine: every test drives awb's `_impl.spawnSync`
 * seam — the same one runner-install.test.ts uses — and clears the probe cache
 * around itself, since a cached answer would otherwise outlive the seam it was
 * measured through.
 *
 * Same throwaway-TARGET_HOME/AWB_HOME convention as the other suites.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-docker-sandbox-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const {
	_impl: awbImpl,
	availableSandboxes,
	clearDockerProbe,
	DEFAULT_SANDBOX_IMAGES,
	dockerAvailable,
	ensureSandboxImage,
	explainRunError,
} = await import("./awb.ts");
const { getStep, getWorkflow, insertStep, insertWorkflow, listSteps, markStepRunning } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { dispatchStep } = await import("./runner.ts");
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
 * Makes the docker probe answer `available`, and records what it was asked.
 * A missing binary and an unreachable daemon both surface as a non-zero /
 * null status, which is the whole point of probing with `info`.
 */
function forceDocker(t: TestContext, available: boolean): { calls: { cmd: string; args: string[] }[] } {
	const original = awbImpl.spawnSync;
	const calls: { cmd: string; args: string[] }[] = [];
	clearDockerProbe();
	t.after(() => {
		awbImpl.spawnSync = original;
		clearDockerProbe();
	});
	awbImpl.spawnSync = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		if (cmd !== "docker") return { status: 0 };
		return { status: available ? 0 : null };
	}) as unknown as typeof awbImpl.spawnSync;
	return { calls };
}

let seq = 0;

/** A workflow with one running step, ready to receive a result callback. */
function makeRunningStep() {
	const id = `ds-wf-${++seq}`;
	insertWorkflow({
		id,
		name: `docker sandbox ${id}`,
		agentName: `ds-agent-${seq}`,
		hookUrl: "http://127.0.0.1:9/hook/none",
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	const step = insertStep(id, "the step");
	markStepRunning(step.id);
	return getStep(step.id)!;
}

// --- 1. the probe ----------------------------------------------------------

test("dockerAvailable probes `docker info`, not `docker --version` — a binary with no daemon behind it is not availability", (t) => {
	const { calls } = forceDocker(t, true);
	assert.equal(dockerAvailable(), true);
	const probe = calls.find((c) => c.cmd === "docker");
	assert.ok(probe, "it actually asked docker");
	assert.equal(probe.args[0], "info");
	assert.ok(!probe.args.includes("--version"), "`--version` would answer a different, useless question");
});

test("dockerAvailable is false when the probe can't answer (no binary, or a daemon that never replies)", (t) => {
	forceDocker(t, false);
	assert.equal(dockerAvailable(), false);
});

test("the probe answer is cached — the create form and the create route must not shell out per request", (t) => {
	const { calls } = forceDocker(t, true);
	assert.equal(dockerAvailable(), true);
	assert.equal(dockerAvailable(), true);
	assert.equal(dockerAvailable(), true);
	assert.equal(calls.filter((c) => c.cmd === "docker").length, 1, "three questions, one probe");
});

test("clearDockerProbe forgets the cached answer, so starting the daemon can be noticed without restarting the hub", (t) => {
	forceDocker(t, false);
	assert.equal(dockerAvailable(), false);
	// The operator starts Docker; the next probe after expiry has to see it.
	awbImpl.spawnSync = (() => ({ status: 0 })) as unknown as typeof awbImpl.spawnSync;
	assert.equal(dockerAvailable(), false, "still the cached answer");
	clearDockerProbe();
	assert.equal(dockerAvailable(), true);
});

test("availableSandboxes always offers the host, and gates only docker", (t) => {
	forceDocker(t, false);
	const boxes = availableSandboxes();
	assert.equal(boxes.find((s) => s.id === "host")?.available, true, "the host is the hub itself — always available");
	assert.equal(boxes.find((s) => s.id === "docker")?.available, false);
});

// --- 2. what the create form is told ---------------------------------------

test("GET /api/runners reports sandboxes alongside runners — one round trip for the whole create form", async (t) => {
	forceDocker(t, true);
	const res = await fetch(`${baseUrl}/api/runners`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		runners: { id: string; installed: boolean }[];
		sandboxes: { id: string; available: boolean }[];
	};
	assert.ok(body.runners.length > 0, "the runner half is unchanged");
	assert.equal(body.sandboxes.find((s) => s.id === "docker")?.available, true);
	assert.equal(body.sandboxes.find((s) => s.id === "host")?.available, true);
});

test("GET /api/runners reports docker as unavailable when it is — this is what stops the UI offering it", async (t) => {
	forceDocker(t, false);
	const res = await fetch(`${baseUrl}/api/runners`, { headers: adminHeaders() });
	const body = (await res.json()) as { sandboxes: { id: string; available: boolean }[] };
	assert.equal(body.sandboxes.find((s) => s.id === "docker")?.available, false);
	assert.equal(body.sandboxes.find((s) => s.id === "host")?.available, true, "the host option never disappears");
});

// --- 3. the server refuses what it can't run -------------------------------

test("POST /api/workflows with sandbox docker is refused with a clear 400 when docker is unavailable", async (t) => {
	forceDocker(t, false);

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "docker without docker", sandbox: "docker" }),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /docker is not available on this host/);
	// It names both halves of the real cause, and a way out.
	assert.match(body.error, /daemon/);
	assert.match(body.error, /host sandbox/);

	// And it created nothing: the UI is not the only gate, but it must not be
	// half a gate either.
	const listRes = await fetch(`${baseUrl}/api/workflows`, { headers: adminHeaders() });
	const list = (await listRes.json()) as { workflows: { name: string }[] };
	assert.ok(!list.workflows.some((w) => w.name === "docker without docker"));
});

test("POST /api/workflows on the host sandbox is unaffected by a machine with no docker", async (t) => {
	forceDocker(t, false);

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "host without docker" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { sandbox: string } };
	assert.equal(workflow.sandbox, "host");
});

test("POST /api/workflows with sandbox docker is still accepted when docker is available (control)", async (t) => {
	forceDocker(t, true);

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "docker with docker", sandbox: "docker" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { sandbox: string } };
	assert.equal(workflow.sandbox, "docker");
});

// --- 4. the error the operator actually saw --------------------------------

test("explainRunError turns docker's registry-login error into the thing that fixes it", () => {
	const raw =
		"Unable to find image 'target-agent:latest' locally\ndocker: Error response from daemon: pull access denied for target-agent, repository does not exist or may require 'docker login'";
	const explained = explainRunError(raw);
	assert.ok(explained.startsWith(raw), "docker's own words are kept — they say which image");
	assert.match(explained, /npm run target:install/, "the one command that builds it");
	assert.match(explained, /docker build -t target-agent:latest/, "and the by-hand equivalent");
	assert.match(explained, /never pulled from a registry/, "says why `docker login` is the wrong road");
});

test("explainRunError does NOT send the installer after an image the repo doesn't build", () => {
	const raw = "Unable to find image 'my-python-repo:3.12' locally\ndocker: Error response from daemon: pull access denied for my-python-repo";
	const explained = explainRunError(raw);
	assert.ok(explained.startsWith(raw));
	assert.ok(!/npm run target:install/.test(explained), "the installer builds the defaults, not the operator's own image");
	assert.match(explained, /couldn't be pulled/, "for that one the registry reading is the right one");
});

test("explainRunError leaves every other failure exactly as the CLI wrote it", () => {
	for (const raw of ["exit 137", "API Error: prompt is too long: 412345 tokens > 200000 maximum", "run failed"]) {
		assert.equal(explainRunError(raw), raw);
	}
});

test("a step that failed on a missing image stores the advice, not just docker's dead end", async () => {
	const step = makeRunningStep();
	await fetch(`${baseUrl}/api/steps/${step.id}/result?token=${step.callbackToken}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			ok: false,
			exitCode: 125,
			error: "docker: Error response from daemon: pull access denied for target-agent, repository does not exist or may require 'docker login'",
		}),
	});

	const settled = getStep(step.id)!;
	assert.equal(settled.status, "failed");
	assert.match(String(settled.error), /pull access denied/, "docker's own text still reaches the operator");
	assert.match(String(settled.error), /npm run target:install/, "with the fix attached to it");
});

// --- 5. the image is BUILT, not pulled -------------------------------------
//
// The advice above is the last resort. The real fix is that a default image
// that isn't on the machine gets built — by the installer up front, and by the
// dispatch itself when that never happened — so the broker's `docker run` never
// reaches for a registry that has never held these images.

/**
 * Makes `docker image inspect` report the images in `missing` as absent, and
 * every `docker build` exit with `buildExitCode` after writing `buildOutput`.
 *
 * The build seam is driven with a REAL child process (a one-line node), so the
 * async plumbing under test — the stdout/stderr capture and the close handler —
 * is the plumbing that runs in production rather than a stub of it. Nothing
 * here ever shells out to docker.
 */
function forceImages(
	t: TestContext,
	options: { missing: string[]; buildExitCode?: number; buildOutput?: string },
): { builds: string[][] } {
	const originalSpawnSync = awbImpl.spawnSync;
	const originalSpawn = awbImpl.spawn;
	const builds: string[][] = [];
	clearDockerProbe();
	t.after(() => {
		awbImpl.spawnSync = originalSpawnSync;
		awbImpl.spawn = originalSpawn;
		clearDockerProbe();
	});
	awbImpl.spawnSync = ((cmd: string, args: string[]) => {
		if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
			return { status: options.missing.includes(args[2] ?? "") ? 1 : 0 };
		}
		return { status: 0 };
	}) as unknown as typeof awbImpl.spawnSync;
	awbImpl.spawn = ((cmd: string, args: string[]) => {
		builds.push([cmd, ...args]);
		const script = `process.stderr.write(${JSON.stringify(options.buildOutput ?? "")}); process.exit(${options.buildExitCode ?? 0});`;
		return cp.spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
	}) as unknown as typeof awbImpl.spawn;
	return { builds };
}

test("a missing default image is BUILT from this repo's Dockerfile — never pulled", async (t) => {
	const { builds } = forceImages(t, { missing: [DEFAULT_SANDBOX_IMAGES.claude] });

	const result = await ensureSandboxImage(DEFAULT_SANDBOX_IMAGES.claude);
	assert.deepEqual(result, { ok: true, built: true });
	assert.equal(builds.length, 1);
	const [cmd, ...args] = builds[0]!;
	assert.equal(cmd, "docker");
	assert.equal(args[0], "build", "`build`, not `pull`: this image exists in no registry");
	assert.ok(args.includes("-t") && args.includes(DEFAULT_SANDBOX_IMAGES.claude));
	assert.ok(args.includes("-f") && args.includes("Dockerfile"));
	// The container runs as the operator, so the ids baked into the image are
	// theirs — otherwise everything the agent writes into the mounted repo comes
	// back owned by someone else.
	if (process.getuid) assert.ok(args.some((a) => a === `AGENT_UID=${process.getuid?.()}`), args.join(" "));
});

test("an image already on the machine is left alone — no build on every dispatch", async (t) => {
	const { builds } = forceImages(t, { missing: [] });

	assert.deepEqual(await ensureSandboxImage(DEFAULT_SANDBOX_IMAGES.claude), { ok: true, built: false });
	assert.equal(builds.length, 0);
});

test("an image the repo doesn't own is left to docker — it may legitimately live in a registry", async (t) => {
	const { builds } = forceImages(t, { missing: ["my-python-repo:3.12"] });

	assert.deepEqual(await ensureSandboxImage("my-python-repo:3.12"), { ok: true, built: false });
	assert.equal(builds.length, 0, "there is no Dockerfile for someone else's image, and pulling it is correct");
});

test("the free-code image builds its base first — `FROM target-agent:latest` can't be pulled either", async (t) => {
	const { builds } = forceImages(t, {
		missing: [DEFAULT_SANDBOX_IMAGES.claude, DEFAULT_SANDBOX_IMAGES["free-code"]],
	});

	assert.deepEqual(await ensureSandboxImage(DEFAULT_SANDBOX_IMAGES["free-code"]), { ok: true, built: true });
	assert.equal(builds.length, 2);
	assert.ok(builds[0]!.includes(DEFAULT_SANDBOX_IMAGES.claude), "the base first");
	assert.ok(builds[1]!.includes(DEFAULT_SANDBOX_IMAGES["free-code"]));
});

test("two dispatches racing for the same missing image share one build", async (t) => {
	const { builds } = forceImages(t, { missing: [DEFAULT_SANDBOX_IMAGES.claude] });

	const [a, b] = await Promise.all([
		ensureSandboxImage(DEFAULT_SANDBOX_IMAGES.claude),
		ensureSandboxImage(DEFAULT_SANDBOX_IMAGES.claude),
	]);
	assert.deepEqual(a, { ok: true, built: true });
	assert.deepEqual(b, { ok: true, built: true });
	assert.equal(builds.length, 1, "one `docker build`, both waiters");
});

test("a step whose daemon died since creation says THAT, not that the build failed", async (t) => {
	const { builds } = forceImages(t, { missing: [DEFAULT_SANDBOX_IMAGES.claude] });
	// The daemon stops: `docker info` fails, and so does `image inspect` — which
	// on its own is indistinguishable from an image that was never built.
	const inspectOnly = awbImpl.spawnSync;
	awbImpl.spawnSync = ((cmd: string, args: string[]) => {
		if (cmd === "docker" && args[0] === "info") return { status: null };
		return (inspectOnly as unknown as (c: string, a: string[]) => { status: number | null })(cmd, args);
	}) as unknown as typeof awbImpl.spawnSync;
	clearDockerProbe();

	const result = await ensureSandboxImage(DEFAULT_SANDBOX_IMAGES.claude);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /daemon isn't running/);
	assert.equal(builds.length, 0, "building against a dead daemon only produces a worse error");
});

test("a failed build reports docker's own words and the command that reproduces it", async (t) => {
	forceImages(t, {
		missing: [DEFAULT_SANDBOX_IMAGES.claude],
		buildExitCode: 1,
		buildOutput: "#8 ERROR: failed to solve: process \"/bin/sh -c npm install -g ...\" did not complete successfully\n",
	});

	const result = await ensureSandboxImage(DEFAULT_SANDBOX_IMAGES.claude);
	assert.equal(result.ok, false);
	const error = result.ok ? "" : result.error;
	assert.match(error, /could not build the docker image 'target-agent:latest'/);
	assert.match(error, /failed to solve/, "the line the build actually died on");
	assert.match(error, /docker build -t target-agent:latest -f Dockerfile/, "and how to reproduce it by hand");
});

test("a docker step whose image can't be built fails with that, and is never dispatched", async (t) => {
	forceImages(t, {
		missing: [DEFAULT_SANDBOX_IMAGES.claude],
		buildExitCode: 1,
		buildOutput: "#8 ERROR: failed to solve: apt-get update exited 100\n",
	});

	const created = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "docker image build fails", sandbox: "docker" }),
	});
	assert.equal(created.status, 200);
	const { workflow } = (await created.json()) as { workflow: { id: string } };
	await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "do the thing" }),
	});
	const step = listSteps(workflow.id)[0]!;

	await dispatchStep(step, getWorkflow(workflow.id)!, cfg, silent);

	const settled = getStep(step.id)!;
	assert.equal(settled.status, "failed");
	assert.match(String(settled.error), /could not build the docker image/);
	assert.ok(!/hook/.test(String(settled.error)), "it never even reached the broker");
});

test("a docker step whose image is present dispatches as it always did", async (t) => {
	const { builds } = forceImages(t, { missing: [] });

	const created = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "docker image present", sandbox: "docker" }),
	});
	const { workflow } = (await created.json()) as { workflow: { id: string } };
	await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ description: "do the thing" }),
	});
	const step = listSteps(workflow.id)[0]!;

	await dispatchStep(step, getWorkflow(workflow.id)!, cfg, silent);

	assert.equal(builds.length, 0, "an existing image is not rebuilt on the way to the broker");
	// Whatever the (unreachable, in this suite) broker answered, the step must
	// not have died on the image check.
	const settled = getStep(step.id)!;
	assert.ok(!/could not build the docker image/.test(String(settled.error ?? "")), settled.error ?? "");
});

// --- 6. the form itself ----------------------------------------------------
//
// Everything above is the server half. The requirement is also that the option
// never APPEARS on a machine that can't run it, and that lives in the modal.
// There's no DOM here (no jsdom, and the component imports CSS Modules), so the
// source is read instead — the same crude-but-load-bearing seam
// start-shortcut.test.ts uses for its button.

test("the New-workflow form builds its sandbox options from the probe, never from the static list", () => {
	const source = fs.readFileSync(path.join(import.meta.dirname, "ui", "src", "views", "CreateWorkflowModal.tsx"), "utf8");

	assert.match(source, /listHostCapabilities\(\)/, "it asks the host what it can run");
	assert.match(source, /availableSandboxOptions\.map\(/, "and renders that answer");
	assert.ok(
		!source.includes("SANDBOX_OPTIONS.map("),
		"rendering the static list is the bug: it is what offered Docker on a machine with no docker",
	);
	// Fail closed. Before the probe lands (and if it ever answers a sandbox this
	// UI doesn't know), nothing is offered rather than everything.
	assert.match(source, /\?\.available \?\? false/, "an unknown/unanswered sandbox is not available");
});
