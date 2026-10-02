/**
 * Tests for the free-code runner support: a workflow can be created with
 * `runner: "free-code"`, which makes its awb hook spawn the free-code CLI
 * instead of Claude Code. Everything downstream (dispatch, session chaining,
 * callbacks) is runtime-agnostic — these tests pin the pieces that DO differ:
 *
 *  - the hook's `consumers` list (`spawn:free-code` vs `spawn:claude`)
 *  - the harness reported by `hookRuntime` / the public workflow
 *  - the resume command offered by "Open conversation"
 *  - token usage read from a free-code transcript (usage shape + .jsonl-path
 *    session ids)
 *  - the create route's `runner` validation
 *
 * Same throwaway-TARGET_HOME/AWB_HOME convention as the other suites.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-runner-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { _impl: awbImpl, availableRunners, createAwbHook, harnessResumeCommand, harnessResumeEnv, hookRuntime, runnerAdapterExists } = await import("./awb.ts");
const { readTokenUsage } = await import("./transcript.ts");
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

test("createAwbHook without a runner still writes spawn:claude (unchanged default)", () => {
	createAwbHook("default-runner-hook", path.join(tmpHome, "wd-default"), "{{payload}}");
	assert.deepEqual(hooksJson()["default-runner-hook"].consumers, ["spawn:claude"]);
});

test("createAwbHook with runner free-code writes spawn:free-code", () => {
	const { hookUrl } = createAwbHook("fc-hook", path.join(tmpHome, "wd-fc"), "{{payload}}", { runner: "free-code" });
	assert.deepEqual(hooksJson()["fc-hook"].consumers, ["spawn:free-code"]);
	assert.equal(hookRuntime(hookUrl).harness, "free-code");
});

test("createAwbHook with runner copilot writes spawn:copilot", () => {
	const { hookUrl } = createAwbHook("copilot-hook", path.join(tmpHome, "wd-copilot"), "{{payload}}", { runner: "copilot" });
	assert.deepEqual(hooksJson()["copilot-hook"].consumers, ["spawn:copilot"]);
	assert.equal(hookRuntime(hookUrl).harness, "copilot");
});

test("createAwbHook with runner cursor writes spawn:cursor", () => {
	const { hookUrl } = createAwbHook("cursor-hook", path.join(tmpHome, "wd-cursor"), "{{payload}}", { runner: "cursor" });
	assert.deepEqual(hooksJson()["cursor-hook"].consumers, ["spawn:cursor"]);
	assert.equal(hookRuntime(hookUrl).harness, "cursor");
});

test("harnessResumeCommand knows all harnesses and quotes the session id", () => {
	assert.equal(harnessResumeCommand("claude", "sess-1"), "claude --resume 'sess-1'");
	// The resume loads the full extension set (no `--no-extensions`, like the
	// headless steps), and `--no-rag-server` skips the 90s wait for a RAG
	// server the resume image doesn't have. The exact flag list is pinned
	// against a throwaway HOME in sandbox.test.ts.
	assert.match(
		harnessResumeCommand("free-code", "/home/u/.agent-webhook-bridge/sessions/h/a.jsonl") ?? "",
		/^free-code --session '\/home\/u\/\.agent-webhook-bridge\/sessions\/h\/a\.jsonl' --no-rag-server$/,
	);
	assert.equal(
		harnessResumeCommand("cursor", "chat-1", null, "/repo"),
		"agent --resume 'chat-1' --trust --approve-mcps --workspace '/repo'",
	);
	assert.equal(harnessResumeCommand("cursor", "chat-1", null, null), null);
	assert.equal(harnessResumeCommand("unknown-harness", "sess-1"), null);
	assert.equal(harnessResumeCommand(null, "sess-1"), null);
	assert.equal(harnessResumeCommand("claude", null), null);
});

test("harnessResumeCommand resumes a copilot session by bare uuid, with or without a workdir", () => {
	assert.equal(harnessResumeCommand("copilot", "abc", null, null), "copilot --resume='abc'");
	assert.equal(harnessResumeCommand("copilot", "abc", null, "/repo"), "copilot --resume='abc'");
	assert.deepEqual(harnessResumeEnv("copilot"), { COPILOT_AUTO_UPDATE: "false" });
});

test("a copilot resume under a docker sandbox mounts ~/.copilot and ~/.cache/copilot and pins the env", (t) => {
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-copilot-home-"));
	fs.mkdirSync(path.join(fakeHome, ".copilot"));
	fs.mkdirSync(path.join(fakeHome, ".cache", "copilot"), { recursive: true });
	const originalHome = process.env.HOME;
	process.env.HOME = fakeHome;
	t.after(() => {
		process.env.HOME = originalHome;
		fs.rmSync(fakeHome, { recursive: true, force: true });
	});
	const command = harnessResumeCommand("copilot", "abc", { kind: "docker", image: "target-agent-copilot:latest" }, "/home/u/repo") ?? "";
	assert.match(command, /^docker run --rm -it /);
	assert.ok(command.includes(`-v '${fakeHome}/.copilot:${fakeHome}/.copilot'`), command);
	assert.ok(command.includes(`-v '${fakeHome}/.cache/copilot:${fakeHome}/.cache/copilot'`), command);
	assert.ok(command.includes("-e 'COPILOT_AUTO_UPDATE=false'"), command);
	assert.ok(command.endsWith(" 'target-agent-copilot:latest' copilot --resume='abc'"), command);
});

test("a copilot docker resume always forwards the token variable by NAME only (the terminal supplies the value)", (t) => {
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-copilot-home-"));
	const originalHome = process.env.HOME;
	const originalToken = process.env.COPILOT_GITHUB_TOKEN;
	process.env.HOME = fakeHome;
	t.after(() => {
		process.env.HOME = originalHome;
		if (originalToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
		else process.env.COPILOT_GITHUB_TOKEN = originalToken;
		fs.rmSync(fakeHome, { recursive: true, force: true });
	});
	const sandbox = { kind: "docker" as const, image: "target-agent-copilot:latest" };
	const id = "11111111-2222-3333-4444-555555555555";

	delete process.env.COPILOT_GITHUB_TOKEN;
	const without = harnessResumeCommand("copilot", id, sandbox, "/home/u/repo") ?? "";
	assert.match(without, /^docker run --rm -it /);
	assert.ok(/ -e COPILOT_GITHUB_TOKEN /.test(without), "forwarded by name even when unset here: the terminal sets it or prints a hint");
	assert.ok(!without.includes("COPILOT_GITHUB_TOKEN="), without);
	assert.ok(without.endsWith(` 'target-agent-copilot:latest' copilot --resume='${id}'`), without);

	process.env.COPILOT_GITHUB_TOKEN = "dummy-not-a-token";
	const withToken = harnessResumeCommand("copilot", id, sandbox, "/home/u/repo") ?? "";
	assert.ok(/ -e COPILOT_GITHUB_TOKEN /.test(withToken), withToken);
	assert.ok(!withToken.includes("COPILOT_GITHUB_TOKEN="), "the name, never NAME=value");
	assert.ok(!withToken.includes("dummy-not-a-token"), "the value never reaches the command line");
	assert.ok(withToken.includes("-e 'COPILOT_AUTO_UPDATE=false'"), withToken);
	assert.ok(withToken.endsWith(` 'target-agent-copilot:latest' copilot --resume='${id}'`), withToken);

	// A hook that names the variable forwards it too — once, not twice.
	const hooked = harnessResumeCommand("copilot", id, { ...sandbox, env: ["COPILOT_GITHUB_TOKEN"] }, "/home/u/repo") ?? "";
	assert.equal(hooked.match(/-e COPILOT_GITHUB_TOKEN /g)?.length, 1, hooked);
	// Other harnesses are unaffected by the copilot variable.
	const claude = harnessResumeCommand("claude", "sess", { kind: "docker", image: "target-agent:latest" }, "/home/u/repo") ?? "";
	assert.ok(!claude.includes("COPILOT_GITHUB_TOKEN"), claude);
});

test("availableRunners reads a runner as not installed when its awb adapter file is missing", (t) => {
	// The suite's setup stubs the adapter probe to true; put the real one back
	// for this test and point AWB_DIR at a checkout we control.
	const awbDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-awb-adapters-"));
	const originalDir = process.env.AWB_DIR;
	const originalProbe = awbImpl.adapterExists;
	process.env.AWB_DIR = awbDir;
	awbImpl.adapterExists = runnerAdapterExists;
	t.after(() => {
		process.env.AWB_DIR = originalDir;
		if (originalDir === undefined) delete process.env.AWB_DIR;
		awbImpl.adapterExists = originalProbe;
		fs.rmSync(awbDir, { recursive: true, force: true });
	});
	const copilot = () => availableRunners().find((r) => r.id === "copilot")?.installed;
	assert.equal(copilot(), false, "no adapter file: the broker would hang the step");
	fs.mkdirSync(path.join(awbDir, "adapters", "spawn-runner"), { recursive: true });
	fs.writeFileSync(path.join(awbDir, "adapters", "spawn-runner", "copilot.ts"), "");
	assert.equal(copilot(), true);
	assert.equal(availableRunners().find((r) => r.id === "cursor")?.installed, false, "still missing cursor.ts");
});

test("POST /api/workflows with runner free-code creates a free-code workflow (harness surfaces in the public shape)", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "fc workflow", runner: "free-code" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { id: string; agentName: string; harness: string } };
	assert.equal(workflow.harness, "free-code");
	assert.deepEqual(hooksJson()[workflow.agentName].consumers, ["spawn:free-code"]);
});

test("POST /api/workflows without a runner keeps claude (unchanged default)", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "default workflow" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { harness: string } };
	assert.equal(workflow.harness, "claude");
});

test("POST /api/workflows rejects an unknown runner and creates nothing", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "bad runner workflow", runner: "codex" }),
	});
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.match(body.error, /invalid runner/);
	assert.match(body.error, /allowed: claude, free-code, cursor, copilot/);

	const listRes = await fetch(`${baseUrl}/api/workflows`, { headers: adminHeaders() });
	const list = (await listRes.json()) as { workflows: { name: string }[] };
	assert.ok(!list.workflows.some((w) => w.name === "bad runner workflow"));
});

test("readTokenUsage reads a free-code transcript when the session id is a .jsonl path", (t) => {
	const file = path.join(tmpHome, "sessions", "hook", "fc-session.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
	const lines = [
		// session header + a user message: no usage, must be skipped.
		JSON.stringify({ type: "session", version: 3, id: "abc", cwd: "/tmp" }),
		JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
		// two assistant turns in free-code's usage shape.
		JSON.stringify({
			type: "message",
			id: "m2",
			message: { role: "assistant", usage: { input: 1000, output: 50, cacheRead: 200, cacheWrite: 300 } },
		}),
		JSON.stringify({
			type: "message",
			id: "m3",
			message: { role: "assistant", usage: { input: 2000, output: 80, cacheRead: 400, cacheWrite: 0 } },
		}),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);

	const usage = readTokenUsage("/irrelevant/workdir", file);
	assert.equal(usage.turns, 2);
	assert.equal(usage.inputTokens, 3000);
	assert.equal(usage.cacheCreationTokens, 300);
	assert.equal(usage.cacheReadTokens, 600);
	assert.equal(usage.outputTokens, 130);
	assert.equal(usage.totalInputTokens, 3900);
	// Occupancy is the last turn's input + cache.
	assert.equal(usage.contextTokens, 2400);
	assert.equal(usage.includesSubagents, false);
});

test("GET /api/workflows/:id/session-info reads usage off a free-code .jsonl session", async (t) => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "fc session-info", runner: "free-code" }),
	});
	const { workflow } = (await createRes.json()) as { workflow: { id: string } };

	const file = path.join(tmpHome, "sessions", "fc-session-info", "s1.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
	fs.writeFileSync(
		file,
		`${JSON.stringify({
			type: "message",
			id: "m1",
			message: { role: "assistant", usage: { input: 500, output: 20, cacheRead: 100, cacheWrite: 50 } },
		})}\n`,
	);
	setWorkflowSessionId(workflow.id, file);

	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/session-info`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		sessionId: string;
		harness: string;
		usage: { turns: number; totalInputTokens: number; outputTokens: number };
	};
	assert.equal(body.sessionId, file);
	assert.equal(body.harness, "free-code");
	assert.equal(body.usage.turns, 1);
	assert.equal(body.usage.totalInputTokens, 650);
	assert.equal(body.usage.outputTokens, 20);
});

test("readTokenUsage reads cursor usage from awb run logs when the session id is a chat uuid", (t) => {
	const sessionId = "cursor-chat-001";
	const logsDir = path.join(tmpHome, "logs");
	fs.mkdirSync(logsDir, { recursive: true });
	t.after(() => fs.rmSync(logsDir, { recursive: true, force: true }));
	const lines = [
		JSON.stringify({
			type: "result",
			subtype: "success",
			session_id: sessionId,
			usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 2000, cacheWriteTokens: 100 },
		}),
		JSON.stringify({
			type: "result",
			subtype: "success",
			session_id: sessionId,
			usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 8000, cacheWriteTokens: 0 },
		}),
	];
	fs.writeFileSync(path.join(logsDir, "wf-1.log"), `${lines.join("\n")}\n`);

	const usage = readTokenUsage("/irrelevant/workdir", sessionId);
	assert.equal(usage.turns, 2);
	assert.equal(usage.inputTokens, 1500);
	assert.equal(usage.cacheCreationTokens, 100);
	assert.equal(usage.cacheReadTokens, 10000);
	assert.equal(usage.outputTokens, 70);
	assert.equal(usage.totalInputTokens, 11600);
	// Occupancy is an estimate for Cursor (cursor-occupancy.test.ts has the real
	// cases). With no agent-transcript there is no round count to estimate the
	// second run from, so the first run's reading (its whole input, the only
	// thing known) stands rather than the second run's summed billing.
	assert.equal(usage.contextTokens, 3100);
	assert.equal(usage.contextEstimated, true);
	assert.equal(usage.contextWindow, 200_000);
	assert.equal(usage.includesSubagents, false);
});

test("readTokenUsage never publishes a Cursor run's summed billing as a full window", (t) => {
	const sessionId = "cursor-chat-cumulative";
	const logsDir = path.join(tmpHome, "logs");
	fs.mkdirSync(logsDir, { recursive: true });
	t.after(() => fs.rmSync(logsDir, { recursive: true, force: true }));
	fs.writeFileSync(
		path.join(logsDir, "wf-heavy.log"),
		`${JSON.stringify({
			type: "result",
			subtype: "success",
			session_id: sessionId,
			model: "Composer 2.5 Fast",
			usage: { inputTokens: 59230, outputTokens: 6953, cacheReadTokens: 761920, cacheWriteTokens: 0 },
		})}\n`,
	);

	const usage = readTokenUsage("/irrelevant/workdir", sessionId);
	assert.equal(usage.contextWindow, 200_000);
	// 821k summed over the run's rounds is four windows: not occupancy, and with
	// no transcript and no earlier reading there is nothing to estimate from.
	// Unmeasured reads as 0 — the old code clamped it to 200k, a full bar.
	assert.equal(usage.contextTokens, 0);
	assert.equal(usage.contextEstimated, true);
	assert.equal(usage.includesSubagents, false);
});

test("GET /api/workflows/:id/session-info reads usage off a cursor session from awb logs", async (t) => {
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "cursor session-info", runner: "cursor" }),
	});
	const { workflow } = (await createRes.json()) as { workflow: { id: string } };

	const sessionId = "cursor-chat-api-001";
	const logsDir = path.join(tmpHome, "logs");
	fs.mkdirSync(logsDir, { recursive: true });
	t.after(() => fs.rmSync(logsDir, { recursive: true, force: true }));
	fs.writeFileSync(
		path.join(logsDir, "wf-api.log"),
		`${JSON.stringify({
			type: "result",
			subtype: "success",
			session_id: sessionId,
			usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 50 },
		})}\n`,
	);
	setWorkflowSessionId(workflow.id, sessionId);

	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/session-info`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		sessionId: string;
		harness: string;
		usage: { turns: number; totalInputTokens: number; outputTokens: number; contextTokens: number };
	};
	assert.equal(body.sessionId, sessionId);
	assert.equal(body.harness, "cursor");
	assert.equal(body.usage.turns, 1);
	assert.equal(body.usage.totalInputTokens, 650);
	assert.equal(body.usage.outputTokens, 20);
	assert.equal(body.usage.contextTokens, 650);
});

test("POST /api/workflows/:id/open-terminal on a free-code workflow spawns free-code --session <path>", async (t) => {
	const { _impl: terminalImpl } = await import("./terminal.ts");
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "fc open-terminal", runner: "free-code" }),
	});
	const { workflow } = (await createRes.json()) as { workflow: { id: string } };
	const sessionFile = path.join(tmpHome, "sessions", "fc-open", "s1.jsonl");
	setWorkflowSessionId(workflow.id, sessionFile);

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
	// The resume env (profile pinned to default, so the reopened conversation
	// doesn't stop on free-code's profile picker) is set by the terminal's
	// shell, not baked into the command string.
	assert.match(
		shellCmd,
		/^cd '.*' && FREE_CODE_STARTUP_PROFILE='default' free-code --session '.*s1\.jsonl' --no-rag-server; exec bash$/,
	);
});

test("harnessResumeEnv pins free-code's startup profile and leaves claude alone", () => {
	assert.deepEqual(harnessResumeEnv("free-code"), { FREE_CODE_STARTUP_PROFILE: "default" });
	assert.deepEqual(harnessResumeEnv("claude"), {});
	assert.deepEqual(harnessResumeEnv(null), {});
});

test("POST /api/workflows with runner copilot creates a copilot workflow", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "copilot workflow", runner: "copilot" }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { harness: string; agentName: string } };
	assert.equal(workflow.harness, "copilot");
	assert.deepEqual(hooksJson()[workflow.agentName].consumers, ["spawn:copilot"]);
});

test("GET /api/runners lists copilot", async () => {
	const res = await fetch(`${baseUrl}/api/runners`, { headers: adminHeaders() });
	const body = (await res.json()) as { runners: { id: string; installed: boolean }[] };
	assert.equal(body.runners.find((r) => r.id === "copilot")?.installed, true);
});

test("session-info and open-terminal on a copilot workflow resume with copilot --resume=<id>", async (t) => {
	const { _impl: terminalImpl } = await import("./terminal.ts");
	const createRes = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "copilot open-terminal", runner: "copilot" }),
	});
	const { workflow } = (await createRes.json()) as { workflow: { id: string } };
	const sessionId = "11111111-2222-3333-4444-555555555555";
	setWorkflowSessionId(workflow.id, sessionId);

	// Usage for copilot sessions is not read yet: only the harness and session
	// id are pinned here (the reopen command is pinned via open-terminal below).
	const infoRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}/session-info`, { headers: adminHeaders() });
	assert.equal(infoRes.status, 200);
	const info = (await infoRes.json()) as { harness: string; sessionId: string };
	assert.equal(info.harness, "copilot");
	assert.equal(info.sessionId, sessionId);

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
	assert.match(
		calls[0].args.at(-1) ?? "",
		new RegExp(`^cd '.*' && COPILOT_AUTO_UPDATE='false' copilot --resume='${sessionId}'; exec bash$`),
	);
});
