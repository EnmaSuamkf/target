/**
 * Copilot CLI conversations and progress: the picker over
 * `<COPILOT_HOME>/session-state/<uuid>/` (conversations.ts), the
 * `/api/conversations` routes with runner `copilot`, and the progress watchdog's
 * signal for a Copilot workflow (progress.ts).
 *
 * Everything lives under a throwaway HOME and COPILOT_HOME; the operator's real
 * `~/.copilot` is never read. Event lines are real-shaped (`type`/`data`/`id`/
 * `timestamp`, a subagent's events carrying an envelope `agentId`), without the
 * reasoning blobs.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-copilot-conv-"));
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");
const copilotDir = path.join(tmpHome, "copilot");
process.env.COPILOT_HOME = copilotDir;

const { adoptability, findConversation, listConversations, readConversationPreview, turnOfLine } = await import("./conversations.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { _impl: terminalImpl } = await import("./terminal.ts");
const { createAwbHook } = await import("./awb.ts");
const { insertStep, insertWorkflow, markStepRunning, getStep } = await import("./db.ts");
const { probeStepProgress } = await import("./progress.ts");

const projDir = path.join(tmpHome, "proj");
fs.mkdirSync(projDir, { recursive: true });

let seq = 0;
function ev(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
	seq += 1;
	return { type, data, ...extra, id: `e${seq}`, timestamp: "2026-10-01T20:00:00.000Z", parentId: `e${seq - 1}` };
}
const startEv = (cwd: string): Record<string, unknown> => ev("session.start", { sessionId: "x", selectedModel: "claude-haiku-4.5", contextTier: null, context: { cwd } });
const user = (content: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
	ev("user.message", { content, transformedContent: `<current_datetime>2026</current_datetime>\n${content}`, messageId: "m", parentAgentTaskId: "t" }, extra);
const assistant = (content: string, toolRequests: unknown[] = [], data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> =>
	ev("assistant.message", { messageId: "m", model: "claude-haiku-4.5", content, toolRequests, ...data }, extra);

/** Writes a session dir; `yaml` null = no workspace.yaml, `events` null = no events.jsonl. */
function session(id: string, opts: { events: Record<string, unknown>[] | null; yaml?: string | null; mtime: number }): string {
	const dir = path.join(copilotDir, "session-state", id);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "events.jsonl");
	if (opts.events) {
		fs.writeFileSync(file, opts.events.length ? `${opts.events.map((e) => JSON.stringify(e)).join("\n")}\n` : "");
		fs.utimesSync(file, opts.mtime, opts.mtime);
	}
	if (opts.yaml) fs.writeFileSync(path.join(dir, "workspace.yaml"), opts.yaml);
	return file;
}

const S_QUOTED = "aaaaaaaa-0000-4000-8000-000000000001";
const S_PLAIN = "aaaaaaaa-0000-4000-8000-000000000002";
const S_NOYAML = "aaaaaaaa-0000-4000-8000-000000000003";
const S_NOEVENTS = "aaaaaaaa-0000-4000-8000-000000000004";
const S_EMPTY = "aaaaaaaa-0000-4000-8000-000000000005";
const S_NOCWD = "aaaaaaaa-0000-4000-8000-000000000006";

session(S_QUOTED, {
	mtime: 1_800_000_100,
	yaml: `id: ${S_QUOTED}\ncwd: ${projDir}\nclient_name: github/cli\nname: 'Reply with exactly the word: pong'\nuser_named: false\n`,
	events: [
		startEv("/elsewhere"),
		user("Reply with exactly the word: pong"),
		assistant("", [{ toolCallId: "t1", name: "view", arguments: {} }]),
		assistant("pong"),
		user(""),
		assistant("I'll delegate", [], { parentToolCallId: "toolu_1" }, { agentId: "sub-1" }),
		user("subagent prompt", { agentId: "sub-1", source: "agent-x" }),
	],
});
session(S_PLAIN, {
	mtime: 1_800_000_300,
	yaml: `cwd: ${projDir}\nname: "It's a \\"double\\" name"\n`,
	events: [startEv(projDir), user("Newest question"), assistant("Newest answer")],
});
// No workspace.yaml: workdir from session.start, title from the first user turn.
session(S_NOYAML, {
	mtime: 1_800_000_200,
	yaml: null,
	events: [startEv(projDir), user("First real turn\nsecond line"), assistant("ok")],
});
// A real-looking session dir that only has a workspace.yaml.
session(S_NOEVENTS, { mtime: 0, events: null, yaml: `cwd: ${projDir}\nname: 'no events'\n` });
// A zero-byte events.jsonl never said anything.
session(S_EMPTY, { mtime: 1_800_000_400, events: [], yaml: `cwd: ${projDir}\nname: 'empty'\n` });
// Nothing records where it ran.
session(S_NOCWD, { mtime: 1_800_000_050, yaml: null, events: [ev("session.start", { sessionId: "x" }), user("where am I")] });

test("listConversations(copilot): only non-empty events.jsonl, newest first, with the total", () => {
	const { conversations, total } = listConversations("copilot");
	assert.equal(total, 4);
	assert.deepEqual(
		conversations.map((c) => c.sessionId),
		[S_PLAIN, S_NOYAML, S_QUOTED, S_NOCWD],
	);
	assert.ok(conversations.every((c) => c.runner === "copilot" && c.path.endsWith("events.jsonl")));
	assert.equal(conversations[0]!.updatedAt, new Date(1_800_000_300 * 1000).toISOString());
});

test("title and workdir come from workspace.yaml, with quoting handled", () => {
	const { conversations } = listConversations("copilot");
	const byId = new Map(conversations.map((c) => [c.sessionId, c]));
	const quoted = byId.get(S_QUOTED)!;
	assert.equal(quoted.title, "Reply with exactly the word: pong");
	assert.equal(quoted.workdir, projDir, "workspace.yaml cwd wins over session.start's");
	assert.equal(byId.get(S_PLAIN)!.title, `It's a "double" name`);
});

test("without workspace.yaml: workdir from session.start, title from the first user turn; a bare id when neither", () => {
	const { conversations } = listConversations("copilot");
	const byId = new Map(conversations.map((c) => [c.sessionId, c]));
	assert.equal(byId.get(S_NOYAML)!.workdir, projDir);
	assert.equal(byId.get(S_NOYAML)!.title, "First real turn");
	assert.equal(byId.get(S_NOCWD)!.workdir, null);
	assert.equal(byId.get(S_NOCWD)!.title, "where am I");
});

test("a doubled single quote in a quoted name is unescaped", () => {
	const id = "aaaaaaaa-0000-4000-8000-0000000000a1";
	session(id, { mtime: 1_800_000_500, yaml: `cwd: ${projDir}\nname: 'it''s fine'\n`, events: [startEv(projDir), user("x")] });
	assert.equal(findConversation("copilot", id)?.title, "it's fine");
	fs.rmSync(path.join(copilotDir, "session-state", id), { recursive: true });
});

test("findConversation resolves only enumerated session ids", () => {
	assert.equal(findConversation("copilot", S_QUOTED)?.sessionId, S_QUOTED);
	assert.equal(findConversation("copilot", S_NOEVENTS), null, "a dir without events.jsonl is not a conversation");
	assert.equal(findConversation("copilot", "../../etc/passwd"), null);
	assert.equal(findConversation("copilot", "/etc/passwd"), null);
	assert.equal(findConversation("claude", S_QUOTED), null, "another harness does not see Copilot sessions");
});

test("preview keeps prose turns only: no empty, tool-only or subagent messages", () => {
	const conversation = findConversation("copilot", S_QUOTED)!;
	const preview = readConversationPreview(conversation);
	assert.equal(preview.turns, 2);
	assert.equal(preview.text, "User: Reply with exactly the word: pong\n\nAssistant: pong");
	assert.doesNotMatch(preview.text, /current_datetime|delegate|subagent prompt/);
});

test("turnOfLine reads user.message / assistant.message content and nothing else", () => {
	assert.deepEqual(turnOfLine(user("hi")), { role: "user", text: "hi" });
	assert.deepEqual(turnOfLine(assistant("yo")), { role: "assistant", text: "yo" });
	assert.equal(turnOfLine(assistant("")), null);
	assert.equal(turnOfLine(user("   ")), null);
	assert.equal(turnOfLine(assistant("x", [], { parentToolCallId: "t" })), null);
	assert.equal(turnOfLine(ev("tool.execution_complete", { content: "out" })), null);
	assert.equal(turnOfLine(ev("system.message", { role: "system", content: "sys" })), null);
});

test("adoptability: a workdir is required, and it is the conversation's own", () => {
	assert.deepEqual(adoptability(findConversation("copilot", S_QUOTED)!), { ok: true, workdir: projDir, reason: null });
	const noCwd = adoptability(findConversation("copilot", S_NOCWD)!);
	assert.equal(noCwd.ok, false);
	assert.equal(noCwd.workdir, null);
	assert.match(String(noCwd.reason), /directory it ran in/);
});

// --- HTTP routes ---

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
test.after(() => server.close());
const adminHeaders = () => ({ "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` });

test("GET /api/conversations?runner=copilot lists the picker rows", async () => {
	const res = await fetch(`${baseUrl}/api/conversations?runner=copilot`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { conversations: { sessionId: string; title: string }[]; total: number };
	assert.equal(body.total, 4);
	assert.equal(body.conversations[0]!.sessionId, S_PLAIN);
});

test("GET /api/conversations/preview?runner=copilot returns the tail and adoptability", async () => {
	const res = await fetch(`${baseUrl}/api/conversations/preview?runner=copilot&sessionId=${S_QUOTED}`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { preview: { text: string }; adoptable: { ok: boolean; workdir: string } };
	assert.match(body.preview.text, /Assistant: pong/);
	assert.equal(body.adoptable.ok, true);
	assert.equal(body.adoptable.workdir, projDir);
	const missing = await fetch(`${baseUrl}/api/conversations/preview?runner=copilot&sessionId=nope`, { headers: adminHeaders() });
	assert.equal(missing.status, 404);
});

test("POST /api/conversations/open-terminal for copilot builds `copilot --resume=<id>` in the conversation's directory", async (t) => {
	const calls: { bin: string; args: string[] }[] = [];
	const original = { spawn: terminalImpl.spawn, platform: terminalImpl.platform };
	t.after(() => {
		terminalImpl.spawn = original.spawn;
		terminalImpl.platform = original.platform;
	});
	terminalImpl.platform = () => "linux";
	terminalImpl.spawn = ((bin: string, args: string[]) => {
		calls.push({ bin, args });
		return {
			once(event: string, cb: () => void) {
				if (event === "spawn") cb();
			},
			unref() {},
		};
	}) as unknown as typeof terminalImpl.spawn;

	const res = await fetch(`${baseUrl}/api/conversations/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ runner: "copilot", sessionId: S_QUOTED }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workdir: string; sessionId: string };
	assert.equal(body.sessionId, S_QUOTED);
	assert.equal(body.workdir, projDir);
	assert.equal(calls.length, 1);
	const shellCommand = calls[0]!.args.at(-1) ?? "";
	assert.match(shellCommand, new RegExp(`cd '${projDir}'`));
	assert.ok(shellCommand.includes(`copilot --resume='${S_QUOTED}'`) || shellCommand.includes(`copilot --resume=${S_QUOTED}`), shellCommand);

	const unknown = await fetch(`${baseUrl}/api/conversations/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ runner: "copilot", sessionId: S_NOEVENTS }),
	});
	assert.equal(unknown.status, 404);
	assert.equal(calls.length, 1);
});

// --- progress ---

function makeRunningCopilotStep(sessionId: string | null) {
	const n = ++seq;
	const id = `cpw-${n}`;
	const agentName = `copilot-progress-${n}`;
	const workdir = path.join(tmpHome, "sandboxes", agentName);
	const hook = createAwbHook(agentName, workdir, "{{payload}}", { runner: "copilot" });
	const workflow = insertWorkflow({
		id,
		name: `progress ${id}`,
		agentName,
		hookUrl: hook.hookUrl,
		secret: hook.secret,
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const step = insertStep(id, "long step");
	markStepRunning(step.id);
	return { workflow: { ...workflow, lastSessionId: sessionId }, step: getStep(step.id)!, agentName };
}

function touch(file: string, mtime: Date): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{}\n");
	fs.utimesSync(file, mtime, mtime);
	return file;
}

test("a copilot workflow with a session id is probed through events.jsonl (session-file), ahead of a fresher run log", () => {
	const { workflow, step, agentName } = makeRunningCopilotStep(S_PLAIN);
	const events = path.join(copilotDir, "session-state", S_PLAIN, "events.jsonl");
	const when = new Date(Date.now() - 60_000);
	fs.utimesSync(events, when, when);
	touch(path.join(String(process.env.AWB_HOME), "logs", `${agentName}-1785003818744.log`), new Date());
	const signal = probeStepProgress(workflow, step, cfg, true);
	assert.equal(signal?.kind, "session-file");
	assert.equal(signal?.source, events);
	assert.ok(Math.abs(Date.parse(String(signal?.at)) - when.getTime()) < 2_000);
});

test("with no session id yet (first step) it falls back to awb's run log", () => {
	const { workflow, step, agentName } = makeRunningCopilotStep(null);
	const log = touch(path.join(String(process.env.AWB_HOME), "logs", `${agentName}-1785003818744.log`), new Date());
	const signal = probeStepProgress(workflow, step, cfg, true);
	assert.equal(signal?.kind, "run-log");
	assert.equal(signal?.source, log);
});

test("a session id whose events.jsonl does not exist also falls back to the run log, and to nothing without one", () => {
	const { workflow, step, agentName } = makeRunningCopilotStep("bbbbbbbb-0000-4000-8000-00000000dead");
	assert.equal(probeStepProgress(workflow, step, cfg, true), null);
	const log = touch(path.join(String(process.env.AWB_HOME), "logs", `${agentName}-1785003818745.log`), new Date());
	assert.equal(probeStepProgress(workflow, step, cfg, true)?.source, log);
});

/** Writes a throwaway session, reads its summary, then removes it so the shared fixtures' counts hold. */
function titleOfSession(id: string, yaml: string, events: Record<string, unknown>[]): { title: string; workdir: string | null } {
	session(id, { mtime: 1_800_000_600, yaml, events });
	try {
		const found = findConversation("copilot", id);
		assert.ok(found);
		return { title: found.title, workdir: found.workdir };
	} finally {
		fs.rmSync(path.join(copilotDir, "session-state", id), { recursive: true });
	}
}

test("a name of '{}' is not a title: the first user turn names the session instead", () => {
	const got = titleOfSession("aaaaaaaa-0000-4000-8000-0000000000b1", `cwd: ${projDir}\nname: '{}'\n`, [
		startEv(projDir),
		user("Summarise the release notes"),
	]);
	assert.equal(got.title, "Summarise the release notes");
});

test("a |- block scalar holding JSON becomes one readable line", () => {
	const yaml = `cwd: ${projDir}\nname: |-\n  {\n    "task": "Remember the secret word"\n  }\nuser_named: false\n`;
	const got = titleOfSession("aaaaaaaa-0000-4000-8000-0000000000b2", yaml, [startEv(projDir), user("ignored")]);
	assert.equal(got.title, '{ "task": "Remember the secret word" }');
	assert.equal(got.workdir, projDir, "the keys after the block scalar still parse");
});

test("a first prompt of bare JSON braces collapses to one line; nothing readable falls back to the directory", () => {
	const json = titleOfSession("aaaaaaaa-0000-4000-8000-0000000000b3", `cwd: ${projDir}\nname: '{}'\n`, [
		startEv(projDir),
		user('{\n  "a": 1\n}'),
	]);
	assert.equal(json.title, '{ "a": 1 }');
	const bare = titleOfSession("aaaaaaaa-0000-4000-8000-0000000000b4", `cwd: ${projDir}\nname: '{}'\n`, [startEv(projDir), user("{}")]);
	assert.equal(bare.title, `Session in ${path.basename(projDir)}`);
});

test("a normal title is untouched, and the workflow prompt still reads as the workflow name", () => {
	const normal = titleOfSession("aaaaaaaa-0000-4000-8000-0000000000b5", `cwd: ${projDir}\nname: 'Troubleshoot Models'\n`, [startEv(projDir), user("x")]);
	assert.equal(normal.title, "Troubleshoot Models");
	const wf = titleOfSession("aaaaaaaa-0000-4000-8000-0000000000b6", `cwd: ${projDir}\nname: 'You are the agent of a workflow in The Target Project named "demo". More text'\n`, [startEv(projDir), user("x")]);
	assert.equal(wf.title, 'Workflow "demo"');
});
