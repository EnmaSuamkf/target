/**
 * Tests for the per-workflow sandbox choice: a workflow can be created with
 * `sandbox: "docker"`, which makes its awb hook carry a `sandbox` block and
 * makes awb's spawn adapters run the very same agent invocation inside
 * `docker run --rm` instead of on the host.
 *
 * The choice is orthogonal to `runner` (which CLI runs) and is threaded the
 * same way, so what's pinned here is the same set of seams:
 *
 *  - the hook's `sandbox` block — including its ABSENCE for the host default,
 *    which is the regression that matters: an unsandboxed hook must stay
 *    byte-for-byte the hook the hub has always written
 *  - the sandbox reported by `hookRuntime` / the public workflow
 *  - the resume command offered by "Open conversation", which for a docker
 *    workflow has to enter the same container the steps ran in
 *  - the create route's `sandbox` validation
 *
 * The argv the broker actually spawns is asserted on the awb side
 * (vendor/agent-webhook-bridge/adapters/spawn-runner/sandbox.test.ts); this
 * file covers the hub's half of the contract — writing the block, reading it
 * back, and keeping the paths identical inside and outside the container.
 *
 * Same throwaway-TARGET_HOME/AWB_HOME convention as the other suites.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-sandbox-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { createAwbHook, DEFAULT_SANDBOX_IMAGE, DEFAULT_SANDBOX_IMAGES, defaultSandboxImage, harnessResumeCommand, hookRuntime, PUBLISHABLE_SANDBOXES } =
	await import("./awb.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { setWorkflowSessionId } = await import("./db.ts");

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

function hooksJson(): Record<string, Record<string, unknown>> {
	return (JSON.parse(fs.readFileSync(path.join(tmpHome, "hooks.json"), "utf8")) as { hooks: Record<string, Record<string, unknown>> })
		.hooks;
}

test("createAwbHook without a sandbox writes no sandbox block at all (unchanged host hook)", () => {
	const { hookUrl } = createAwbHook("host-hook", path.join(tmpHome, "wd-host"), "{{payload}}");
	const hook = hooksJson()["host-hook"];
	assert.ok(!("sandbox" in hook), "a host hook must not gain a sandbox key");
	assert.equal(hookRuntime(hookUrl).sandbox, null);
});

test('sandbox: "host" is the explicit form of the same thing — still no block', () => {
	const { hookUrl } = createAwbHook("explicit-host-hook", path.join(tmpHome, "wd-host2"), "{{payload}}", { sandbox: "host" });
	assert.ok(!("sandbox" in hooksJson()["explicit-host-hook"]));
	assert.equal(hookRuntime(hookUrl).sandbox, null);
});

test("createAwbHook with sandbox docker writes the block, defaulting the image", () => {
	const { hookUrl } = createAwbHook("docker-hook", path.join(tmpHome, "wd-docker"), "{{payload}}", { sandbox: "docker" });
	assert.deepEqual(hooksJson()["docker-hook"].sandbox, { kind: "docker", image: DEFAULT_SANDBOX_IMAGE });
	assert.deepEqual(hookRuntime(hookUrl).sandbox, { kind: "docker", image: DEFAULT_SANDBOX_IMAGE, mounts: [] });
});

// The regression that produced `exit 127` in the field: the broker passes the
// runner's binary as the CONTAINER COMMAND (`docker run … <image> free-code
// …`), and the default image built from ./Dockerfile only ships `claude`. A
// free-code workflow that didn't type an image name therefore launched an
// image with nothing to exec, and died before an agent existed. The default
// has to follow the runner.
test("the default docker image follows the runner — free-code gets the image that has the free-code binary", () => {
	const { hookUrl } = createAwbHook("docker-freecode-default", path.join(tmpHome, "wd-fc-default"), "{{payload}}", {
		sandbox: "docker",
		runner: "free-code",
	});
	const image = DEFAULT_SANDBOX_IMAGES["free-code"];
	assert.notEqual(image, DEFAULT_SANDBOX_IMAGES.claude, "free-code must not fall back to the claude-only image");
	assert.deepEqual(hooksJson()["docker-freecode-default"].sandbox, { kind: "docker", image });
	assert.deepEqual(hookRuntime(hookUrl).sandbox, { kind: "docker", image, mounts: [] });
});

test("defaultSandboxImage maps every publishable runner to a distinct image, claude when unspecified", () => {
	assert.equal(defaultSandboxImage(), DEFAULT_SANDBOX_IMAGES.claude);
	assert.equal(defaultSandboxImage("claude"), "target-agent:latest");
	assert.equal(defaultSandboxImage("free-code"), "target-agent-freecode:latest");
});

test("createAwbHook honours a per-workflow image, and leaves the runner alone", () => {
	const { hookUrl } = createAwbHook("docker-img-hook", path.join(tmpHome, "wd-img"), "{{payload}}", {
		sandbox: "docker",
		image: "my-python-repo:3.12",
		runner: "free-code",
	});
	const hook = hooksJson()["docker-img-hook"];
	assert.deepEqual(hook.sandbox, { kind: "docker", image: "my-python-repo:3.12" });
	// Sandbox and runner are independent axes: the consumer is untouched.
	assert.deepEqual(hook.consumers, ["spawn:free-code"]);
	const runtime = hookRuntime(hookUrl);
	assert.equal(runtime.harness, "free-code");
	assert.equal(runtime.sandbox?.image, "my-python-repo:3.12");
});

test("a malformed sandbox block reads back as no sandbox rather than a half-built container", () => {
	const { hookUrl } = createAwbHook("broken-sandbox-hook", path.join(tmpHome, "wd-broken"), "{{payload}}");
	const file = path.join(tmpHome, "hooks.json");
	const cfgJson = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, Record<string, unknown>> };
	cfgJson.hooks["broken-sandbox-hook"].sandbox = { kind: "docker" };
	fs.writeFileSync(file, JSON.stringify(cfgJson, null, 2));
	assert.equal(hookRuntime(hookUrl).sandbox, null);
});

test("harnessResumeCommand is unchanged for a host workflow", () => {
	assert.equal(harnessResumeCommand("claude", "sess-1"), "claude --resume 'sess-1'");
	assert.equal(harnessResumeCommand("claude", "sess-1", null, "/home/u/repo"), "claude --resume 'sess-1'");
});

test("harnessResumeCommand for a docker workflow enters the same container, with identical paths", () => {
	const workdir = "/home/u/repos/demo";
	const command = harnessResumeCommand("claude", "sess-1", { kind: "docker", image: "target-agent:latest" }, workdir);
	assert.ok(command, "a docker workflow with a workdir must still get a command");
	// Interactive, disposable, and running as the operator (so nothing it
	// writes into the repo comes back root-owned).
	assert.match(command, /^docker run --rm -it /);
	assert.ok(command.includes(`--user ${process.getuid?.()}:${process.getgid?.()}`));
	// Resource caps, so a resumed conversation can't take the machine down either.
	assert.ok(command.includes("--memory 4g"));
	assert.ok(command.includes("--cpus 2"));
	assert.ok(command.includes("--pids-limit 512"));
	// The rule the whole feature rests on: the workdir is mounted at its own
	// path AND is the working directory, so the session's transcripts are at
	// the same path the hub reads them from.
	assert.ok(command.includes(`-v '${workdir}:${workdir}'`));
	assert.ok(command.includes(`-w '${workdir}'`));
	// The harness's own home has to come along, or there's no session to resume.
	const claudeHome = path.join(os.homedir(), ".claude");
	if (fs.existsSync(claudeHome)) assert.ok(command.includes(`-v '${claudeHome}:${claudeHome}'`));
	assert.ok(command.includes(`-e 'HOME=${os.homedir()}'`));
	// …and the agent command itself is the last thing on the line.
	assert.ok(command.endsWith(" 'target-agent:latest' claude --resume 'sess-1'"), command);
});

// The regression behind `EACCES: permission denied, mkdir
// '$HOME/.free-code/agent/themes/bundled'` on "Open conversation": the resume
// prefix mounted `~/.claude` but not `~/.free-code`, so `$HOME` inside the
// container was a directory docker had synthesised to hold the OTHER mounts —
// root-owned — and free-code's `runMigrations()`, which mkdirs under `$HOME`
// before it does anything else, could not start. Every harness state dir awb
// mounts for the step run has to be mounted for the resume too.
test("the docker resume mounts every harness state dir, ~/.free-code included", (t) => {
	// os.homedir() reads $HOME on POSIX, so a scratch home makes this
	// deterministic instead of dependent on what the box happens to have.
	const realHome = process.env.HOME;
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-home-"));
	t.after(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		fs.rmSync(fakeHome, { recursive: true, force: true });
	});
	process.env.HOME = fakeHome;
	fs.mkdirSync(path.join(fakeHome, ".claude"));
	fs.mkdirSync(path.join(fakeHome, ".free-code"));
	fs.writeFileSync(path.join(fakeHome, ".claude.json"), "{}");
	const sessionsDir = path.join(tmpHome, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

	const workdir = "/home/u/repos/demo";
	const sessionFile = path.join(sessionsDir, "wf", "run.jsonl");
	const command = harnessResumeCommand("free-code", sessionFile, { kind: "docker", image: "target-agent-freecode:latest" }, workdir);
	assert.ok(command);
	for (const entry of [".claude", ".claude.json", ".free-code"]) {
		const p = path.join(fakeHome, entry);
		assert.ok(command.includes(`-v '${p}:${p}'`), `${entry} must be mounted at its own path: ${command}`);
	}
	assert.ok(command.includes(`-v '${sessionsDir}:${sessionsDir}'`), command);
	// $HOME itself is never mounted — that would hand the container the whole home.
	assert.ok(!command.includes(`-v '${fakeHome}:${fakeHome}'`), command);
	assert.ok(command.includes(`-e 'HOME=${fakeHome}'`), command);
	// free-code resumes by absolute .jsonl path, which only resolves because the
	// sessions dir above is mounted at its own path.
	assert.ok(command.includes(` 'target-agent-freecode:latest' free-code --session '${sessionFile}'`), command);
});

test("a free-code resume runs with --no-extensions, so it opens the conversation and not the profile picker", (t) => {
	// free-code's bundled profile-manager extension opens a blocking
	// "Select session profile" picker on every startup with a UI. The steps run
	// with --no-extensions and never see it; a terminal that omitted the flag
	// would stop on that prompt instead of reopening the conversation.
	const realHome = process.env.HOME;
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-fchome-"));
	t.after(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		fs.rmSync(fakeHome, { recursive: true, force: true });
	});
	process.env.HOME = fakeHome;

	// Host resume: the flags are not a sandbox concern, so they are there either way.
	assert.equal(
		harnessResumeCommand("free-code", "/s/x.jsonl"),
		"free-code --session '/s/x.jsonl' --no-extensions --no-rag-server",
	);
	// claude has no such picker and must keep the command it has always had.
	assert.equal(harnessResumeCommand("claude", "sess-1"), "claude --resume 'sess-1'");

	// The subagent widget is loaded back by absolute path once it exists, so a
	// conversation that used subagent_create reopens with those tools.
	const extDir = path.join(fakeHome, ".free-code", "agent", "extensions");
	fs.mkdirSync(extDir, { recursive: true });
	const widget = path.join(extDir, "subagent-widget.ts");
	fs.writeFileSync(widget, "");
	assert.equal(
		harnessResumeCommand("free-code", "/s/x.jsonl"),
		`free-code --session '/s/x.jsonl' --no-extensions -e '${widget}' --no-rag-server`,
	);

	// Inside the container the same absolute path resolves, because ~/.free-code
	// is mounted at its own path.
	const docker = harnessResumeCommand("free-code", "/s/x.jsonl", { kind: "docker", image: "img" }, "/home/u/repos/demo");
	assert.ok(docker);
	assert.ok(docker.endsWith(`free-code --session '/s/x.jsonl' --no-extensions -e '${widget}' --no-rag-server`), docker);
});

test("harness state dirs that don't exist on the host are skipped, not mounted", (t) => {
	// A bind mount of a missing source makes docker create a root-owned
	// directory in its place — worse than not mounting it at all.
	const realHome = process.env.HOME;
	const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-emptyhome-"));
	t.after(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		fs.rmSync(emptyHome, { recursive: true, force: true });
	});
	process.env.HOME = emptyHome;

	const workdir = "/home/u/repos/demo";
	const command = harnessResumeCommand("free-code", "/s/x.jsonl", { kind: "docker", image: "img" }, workdir);
	assert.ok(command);
	assert.ok(!command.includes(path.join(emptyHome, ".free-code")), command);
	assert.ok(!command.includes(path.join(emptyHome, ".claude")), command);
	// The workdir is still mounted and is still the working directory.
	assert.ok(command.includes(`-v '${workdir}:${workdir}'`), command);
});

test("harnessResumeCommand refuses a docker workflow with no resolvable workdir", () => {
	// Without the workdir there's no mount and no -w, so any command we could
	// offer would open a DIFFERENT conversation. Better to offer none.
	assert.equal(harnessResumeCommand("claude", "sess-1", { kind: "docker", image: "img" }, null), null);
});

test("POST /api/workflows with sandbox docker creates a contained workflow and writes the hook block", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "docker workflow", sandbox: "docker", image: "target-agent:latest" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { id: string; agentName: string; sandbox: string; image: string | null } };
	assert.equal(workflow.sandbox, "docker");
	assert.equal(workflow.image, "target-agent:latest");
	assert.deepEqual(hooksJson()[workflow.agentName].sandbox, { kind: "docker", image: "target-agent:latest" });
});

test("POST /api/workflows with runner free-code + sandbox docker and NO image picks the free-code image", async () => {
	// The exact shape the UI sends when you choose "free-code" + "Docker
	// container" and leave the image box empty — the path that used to produce
	// a hook pointing at the claude-only image, i.e. `exit 127` on every step.
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "free-code docker workflow", runner: "free-code", sandbox: "docker" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { agentName: string; sandbox: string; image: string | null } };
	assert.equal(workflow.sandbox, "docker");
	assert.equal(workflow.image, "target-agent-freecode:latest");
	const hook = hooksJson()[workflow.agentName];
	assert.deepEqual(hook.consumers, ["spawn:free-code"]);
	assert.deepEqual(hook.sandbox, { kind: "docker", image: "target-agent-freecode:latest" });
});

test("an explicit image still wins over the runner default", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "free-code custom image", runner: "free-code", sandbox: "docker", image: "my-freecode:dev" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { agentName: string; image: string | null } };
	assert.equal(workflow.image, "my-freecode:dev");
	assert.deepEqual(hooksJson()[workflow.agentName].sandbox, { kind: "docker", image: "my-freecode:dev" });
});

test("POST /api/workflows without a sandbox stays on the host (unchanged default)", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "host workflow" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { agentName: string; sandbox: string; image: string | null } };
	assert.equal(workflow.sandbox, "host");
	assert.equal(workflow.image, null);
	assert.ok(!("sandbox" in hooksJson()[workflow.agentName]));
});

test("POST /api/workflows rejects an unknown sandbox and creates nothing", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "bad sandbox workflow", sandbox: "firejail" }),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /invalid sandbox/);
	assert.match(body.error, new RegExp(PUBLISHABLE_SANDBOXES.join(", ")));

	const listRes = await fetch(`${baseUrl}/api/workflows`, { headers: adminHeaders() });
	const list = (await listRes.json()) as { workflows: { name: string }[] };
	assert.ok(!list.workflows.some((w) => w.name === "bad sandbox workflow"));
});

test("GET /api/workflows/:id/session-info reports the sandbox and its image", async () => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "docker session-info", sandbox: "docker", image: "img:1" }),
	});
	const { workflow } = (await createRes.json()) as { workflow: { id: string } };
	setWorkflowSessionId(workflow.id, "sess-info-1");

	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/session-info`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { sandbox: string; image: string | null; harness: string };
	assert.equal(body.sandbox, "docker");
	assert.equal(body.image, "img:1");
	assert.equal(body.harness, "claude");
});

test("POST /api/workflows/:id/open-terminal on a docker workflow runs the resume inside the container", async (t) => {
	const { _impl: terminalImpl } = await import("./terminal.ts");
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "docker open-terminal", sandbox: "docker", image: "target-agent:latest" }),
	});
	const { workflow } = (await createRes.json()) as { workflow: { id: string; agentName: string } };
	setWorkflowSessionId(workflow.id, "sess-docker-1");

	const calls: { bin: string; args: string[] }[] = [];
	const originalSpawn = terminalImpl.spawn;
	t.after(() => {
		terminalImpl.spawn = originalSpawn;
	});
	terminalImpl.spawn = ((bin: string, args: string[]) => {
		calls.push({ bin, args });
		return {
			once(event: string, cb: () => void) {
				if (event === "spawn") cb();
			},
			unref() {},
		};
	}) as unknown as typeof terminalImpl.spawn;

	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
	});
	assert.equal(res.status, 200);
	assert.equal(calls.length, 1);
	const shellCmd = calls[0].args.at(-1) ?? "";
	const workdir = path.join(tmpHome, "sandboxes", workflow.agentName);
	// cd'd to the workdir on the HOST (that's where the terminal opens), then
	// into the container at that same path.
	assert.ok(shellCmd.startsWith(`cd '${workdir}' && docker run --rm -it `), shellCmd);
	assert.ok(shellCmd.includes(`-v '${workdir}:${workdir}'`), shellCmd);
	assert.ok(shellCmd.includes(`-w '${workdir}'`), shellCmd);
	assert.ok(shellCmd.endsWith(`'target-agent:latest' claude --resume 'sess-docker-1'; exec bash`), shellCmd);
});
