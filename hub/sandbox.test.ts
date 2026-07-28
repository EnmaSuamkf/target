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

const { createAwbHook, DEFAULT_SANDBOX_IMAGE, harnessResumeCommand, hookRuntime, PUBLISHABLE_SANDBOXES } = await import("./awb.ts");
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
	assert.deepEqual(hookRuntime(hookUrl).sandbox, { kind: "docker", image: DEFAULT_SANDBOX_IMAGE });
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

	const listRes = await fetch(`${baseUrl}/api/workflows`);
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

	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/session-info`);
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
