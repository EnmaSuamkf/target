/**
 * The copilot + docker token flow after the hub started writing the token into
 * the hook (`COPILOT_GITHUB_TOKEN=<value>`): hooks.json mode, refresh before
 * dispatch, and the guarantee that the value never leaves hooks.json.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-copilot-flow-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { createAwbHook, deleteAwbHook, ensureHookTokenEnv, hookRuntime, harnessResumeSecretEnv, harnessResumeCommand } = await import("./awb.ts");
const { redactSecrets, resolveCopilotToken } = await import("./copilot-token.ts");
const { clearCopilotToken, getStep, getWorkflow, insertStep, insertWorkflow, completeStep } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { dispatchStep } = await import("./runner.ts");
const { createServer } = await import("./server.ts");
const { openResumeTerminal, _impl: terminalImpl } = await import("./terminal.ts");

const TOKEN = "gho_dummyDummyDummyDummyDummyDummy1234";
const TOKEN2 = "gho_dummyDummyDummyDummyRotated0000005";
const ENV_NAMES = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const hooksFile = path.join(tmpHome, "hooks.json");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
test.after(() => server.close());

const adminHeaders = () => ({ "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` });

/** The only token in the hub's reach is `value` (or none), restored after the test. */
function withToken(t: TestContext, value: string | undefined): void {
	const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
	t.after(() => {
		for (const n of ENV_NAMES) {
			if (saved[n] === undefined) delete process.env[n];
			else process.env[n] = saved[n];
		}
		clearCopilotToken();
	});
	for (const n of ENV_NAMES) delete process.env[n];
	clearCopilotToken();
	if (value !== undefined) process.env.COPILOT_GITHUB_TOKEN = value;
}

function hooksJson(): Record<string, { sandbox?: { env?: string[] } }> {
	return (JSON.parse(fs.readFileSync(hooksFile, "utf8")) as { hooks: Record<string, { sandbox?: { env?: string[] } }> }).hooks;
}
const mode = () => fs.statSync(hooksFile).mode & 0o777;

function dockerHook(name: string, runner: "copilot" | "claude" = "copilot") {
	return createAwbHook(name, path.join(tmpHome, `wd-${name}`), "{{payload}}", { sandbox: "docker", runner });
}

test("a copilot docker hook gets COPILOT_GITHUB_TOKEN=<value>; claude docker and copilot host hooks have no env", (t) => {
	withToken(t, TOKEN);
	dockerHook("flow-copilot");
	dockerHook("flow-claude", "claude");
	createAwbHook("flow-host", path.join(tmpHome, "wd-flow-host"), "{{payload}}", { runner: "copilot" });
	assert.deepEqual(hooksJson()["flow-copilot"]!.sandbox!.env, [`COPILOT_GITHUB_TOKEN=${TOKEN}`]);
	assert.equal("env" in hooksJson()["flow-claude"]!.sandbox!, false);
	assert.equal("sandbox" in hooksJson()["flow-host"]!, false);
});

test("hooks.json is 0600 after create, refresh and delete (even over an older, looser file)", (t) => {
	withToken(t, TOKEN);
	fs.writeFileSync(hooksFile, fs.readFileSync(hooksFile), { mode: 0o644 });
	fs.chmodSync(hooksFile, 0o644);
	const { hookUrl } = dockerHook("flow-mode");
	assert.equal(mode(), 0o600, "create");
	fs.chmodSync(hooksFile, 0o644);
	assert.equal(ensureHookTokenEnv(hookUrl, "COPILOT_GITHUB_TOKEN", TOKEN2), true);
	assert.equal(mode(), 0o600, "refresh");
	fs.chmodSync(hooksFile, 0o644);
	assert.equal(deleteAwbHook("flow-mode"), true);
	assert.equal(mode(), 0o600, "delete");
	assert.ok(!fs.readFileSync(hooksFile, "utf8").includes(TOKEN2), "removed with the hook");
});

test("ensureHookTokenEnv rewrites only when the value changed and keeps other env entries", (t) => {
	withToken(t, undefined);
	const { hookUrl } = dockerHook("flow-ensure");
	const file = JSON.parse(fs.readFileSync(hooksFile, "utf8")) as { hooks: Record<string, { sandbox: { env?: string[] } }> };
	file.hooks["flow-ensure"]!.sandbox.env = ["OTHER=keep", "COPILOT_GITHUB_TOKEN"];
	fs.writeFileSync(hooksFile, JSON.stringify(file));

	assert.equal(ensureHookTokenEnv(hookUrl, "COPILOT_GITHUB_TOKEN", TOKEN), true, "bare NAME -> NAME=value");
	assert.deepEqual(hooksJson()["flow-ensure"]!.sandbox!.env, ["OTHER=keep", `COPILOT_GITHUB_TOKEN=${TOKEN}`]);

	const before = fs.statSync(hooksFile).mtimeMs;
	fs.utimesSync(hooksFile, new Date(1000), new Date(1000));
	assert.equal(ensureHookTokenEnv(hookUrl, "COPILOT_GITHUB_TOKEN", TOKEN), false, "same value: no rewrite");
	assert.equal(fs.statSync(hooksFile).mtimeMs, 1000);
	void before;

	assert.equal(ensureHookTokenEnv(hookUrl, "COPILOT_GITHUB_TOKEN", TOKEN2), true, "rotation");
	assert.deepEqual(hooksJson()["flow-ensure"]!.sandbox!.env, ["OTHER=keep", `COPILOT_GITHUB_TOKEN=${TOKEN2}`]);
});

test("ensureHookTokenEnv leaves hooks that are not copilot docker alone, and never throws", (t) => {
	withToken(t, undefined);
	const claude = dockerHook("flow-ensure-claude", "claude");
	const host = createAwbHook("flow-ensure-host", path.join(tmpHome, "wd-ensure-host"), "{{payload}}", { runner: "copilot" });
	const before = fs.readFileSync(hooksFile, "utf8");
	assert.equal(ensureHookTokenEnv(claude.hookUrl, "COPILOT_GITHUB_TOKEN", TOKEN), false);
	assert.equal(ensureHookTokenEnv(host.hookUrl, "COPILOT_GITHUB_TOKEN", TOKEN), false);
	assert.equal(ensureHookTokenEnv("http://127.0.0.1:1/hook/nope", "COPILOT_GITHUB_TOKEN", TOKEN), false);
	assert.equal(ensureHookTokenEnv("not a url", "COPILOT_GITHUB_TOKEN", TOKEN), false);
	assert.equal(fs.readFileSync(hooksFile, "utf8"), before);
});

test("redactSecrets masks every token shape and the resolved token itself", (t) => {
	const text = `a ${TOKEN} b github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwx c ghp_dummyDummyDummyDummyClassic000006 d ghu_abcdefghij1234 e ghs_abcdefghij1234`;
	const out = redactSecrets(text);
	assert.equal(out, "a *** b *** c *** d *** e ***");
	assert.equal(redactSecrets("nothing secret here, ghost_town"), "nothing secret here, ghost_town");
	// An odd-shaped value is masked once the hub has resolved it.
	withToken(t, "oddShapedDummyToken-0000-xyz");
	assert.equal(redactSecrets("echo oddShapedDummyToken-0000-xyz"), "echo oddShapedDummyToken-0000-xyz", "not known yet");
	resolveCopilotToken();
	assert.equal(redactSecrets("echo oddShapedDummyToken-0000-xyz"), "echo ***");
});

test("hookRuntime, the workflow API, session-info, the progress .md and the DB never contain the token", async (t) => {
	withToken(t, TOKEN);
	const created = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "flow leak audit", runner: "copilot", sandbox: "docker" }),
	});
	assert.equal(created.status, 200);
	const createdText = await created.text();
	const { workflow } = JSON.parse(createdText) as { workflow: { id: string; agentName: string } };
	assert.ok(hooksJson()[workflow.agentName]!.sandbox!.env!.includes(`COPILOT_GITHUB_TOKEN=${TOKEN}`), "the hook does hold it");

	const stored = getWorkflow(workflow.id)!;
	const texts = [
		createdText,
		JSON.stringify(hookRuntime(stored.hookUrl)),
		await (await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers: adminHeaders() })).text(),
		await (await fetch(`${baseUrl}/api/workflows`, { headers: adminHeaders() })).text(),
		await (await fetch(`${baseUrl}/api/workflows/${workflow.id}/session-info`, { headers: adminHeaders() })).text(),
		fs.readFileSync(stored.mdPath, "utf8"),
	];
	const clone = await fetch(`${baseUrl}/api/workflows/${workflow.id}/clone`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "flow leak audit clone" }),
	});
	texts.push(await clone.text());
	for (const [i, text] of texts.entries()) assert.equal(text.includes(TOKEN), false, `surface #${i} leaked the token`);

	// Everything the hub persisted (steps, progress, report queue, settings): not there either.
	for (const f of fs.readdirSync(tmpHome)) {
		if (f === "hooks.json" || !fs.statSync(path.join(tmpHome, f)).isFile()) continue;
		assert.equal(fs.readFileSync(path.join(tmpHome, f)).includes(TOKEN), false, `${f} holds the token`);
	}
});

test("an agent that echoes the token in its failure has it masked in the stored step", () => {
	const wf = insertWorkflow({
		id: "wf-flow-redact",
		name: "redact",
		agentName: "none",
		hookUrl: "http://127.0.0.1:1/hook/none",
		secret: "s",
		mdPath: path.join(tmpHome, "redact.md"),
		conversationContext: null,
	});
	const step = insertStep(wf.id, "do it");
	completeStep(step.id, { ok: false, error: `env dump: COPILOT_GITHUB_TOKEN=${TOKEN}`, result: `also ${TOKEN}` });
	const row = getStep(step.id)!;
	assert.equal(`${row.error}${row.result}`.includes(TOKEN), false);
	assert.match(row.error ?? "", /COPILOT_GITHUB_TOKEN=\*\*\*/);
});

test("dispatch refreshes the hook token BEFORE posting to the hook", async (t) => {
	withToken(t, TOKEN);
	const { hookUrl } = dockerHook("flow-dispatch");
	// Hook was created with TOKEN; the operator rotates it before the next step.
	process.env.COPILOT_GITHUB_TOKEN = TOKEN2;
	const wf = insertWorkflow({
		id: "wf-flow-dispatch",
		name: "dispatch",
		agentName: "flow-dispatch",
		hookUrl,
		secret: "s",
		mdPath: path.join(tmpHome, "dispatch.md"),
		conversationContext: null,
	});
	const step = insertStep(wf.id, "say hi");
	const realFetch = globalThis.fetch;
	let envAtPost: string[] | undefined;
	globalThis.fetch = (async (input: unknown, init?: unknown) => {
		if (String(input) === hookUrl) {
			envAtPost = hooksJson()["flow-dispatch"]!.sandbox!.env;
			return new Response("{}", { status: 200 });
		}
		return realFetch(input as string, init as RequestInit);
	}) as typeof fetch;
	t.after(() => void (globalThis.fetch = realFetch));
	await dispatchStep(step, wf, cfg, silent);
	assert.deepEqual(envAtPost, [`COPILOT_GITHUB_TOKEN=${TOKEN2}`]);
	assert.equal(getStep(step.id)!.status, "queued");
});

test("dispatch fails the step at once with an actionable message when no token resolves", async (t) => {
	withToken(t, undefined);
	const { hookUrl } = dockerHook("flow-dispatch-none");
	const wf = insertWorkflow({
		id: "wf-flow-dispatch-none",
		name: "dispatch none",
		agentName: "flow-dispatch-none",
		hookUrl,
		secret: "s",
		mdPath: path.join(tmpHome, "dispatch-none.md"),
		conversationContext: null,
	});
	const step = insertStep(wf.id, "say hi");
	const realFetch = globalThis.fetch;
	let posted = false;
	globalThis.fetch = (async () => {
		posted = true;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	t.after(() => void (globalThis.fetch = realFetch));
	await dispatchStep(step, wf, cfg, silent);
	assert.equal(posted, false, "nothing was sent to the hook");
	const row = getStep(step.id)!;
	assert.equal(row.status, "failed");
	assert.match(row.error ?? "", /gh auth login/);
	assert.match(row.error ?? "", /Settings/);
	assert.equal((row.error ?? "").includes(TOKEN), false);
});

test("a docker resume forwards the token by NAME; the value travels in the terminal's environment only", async (t) => {
	withToken(t, TOKEN);
	const sandbox = { kind: "docker" as const, image: "target-agent-copilot:latest" };
	const command = harnessResumeCommand("copilot", "11111111-2222-3333-4444-555555555555", sandbox, "/home/u/repo") ?? "";
	assert.match(command, / -e COPILOT_GITHUB_TOKEN /);
	assert.equal(command.includes(TOKEN), false);
	assert.deepEqual(harnessResumeSecretEnv("copilot", sandbox), { COPILOT_GITHUB_TOKEN: TOKEN });
	assert.deepEqual(harnessResumeSecretEnv("copilot", null), {});
	assert.deepEqual(harnessResumeSecretEnv("claude", sandbox), {});

	const realSpawn = terminalImpl.spawn;
	const realPlatform = terminalImpl.platform;
	t.after(() => {
		terminalImpl.spawn = realSpawn;
		terminalImpl.platform = realPlatform;
	});
	terminalImpl.platform = () => "linux";
	let seen: { args: string[]; env?: NodeJS.ProcessEnv } | undefined;
	terminalImpl.spawn = ((_bin: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
		seen = { args, env: options.env };
		const handlers: Record<string, () => void> = {};
		setImmediate(() => handlers.spawn?.());
		return { once: (ev: string, fn: () => void) => void (handlers[ev] = fn), unref: () => {} };
	}) as unknown as typeof terminalImpl.spawn;
	await openResumeTerminal("/home/u/repo", command, {}, harnessResumeSecretEnv("copilot", sandbox));
	assert.equal(seen!.env?.COPILOT_GITHUB_TOKEN, TOKEN, "in the launcher's environment");
	assert.equal(seen!.args.join(" ").includes(TOKEN), false, "never on its command line");

	// Nothing resolved: no env value, and the shell prints a hint instead of failing silently.
	await openResumeTerminal("/home/u/repo", command, {}, { COPILOT_GITHUB_TOKEN: "" });
	assert.equal(seen!.env, undefined);
	assert.match(seen!.args.join(" "), /COPILOT_GITHUB_TOKEN is not set in this terminal/);
});
