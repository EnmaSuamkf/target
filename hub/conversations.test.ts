/**
 * Tests for creating a workflow that RUNS ON a conversation the operator is
 * already having (hub/conversations.ts + the `/api/conversations` routes + the
 * `conversation` field on POST /api/workflows).
 *
 * The end-to-end guarantee this file exists for is the dispatch test near the
 * bottom: a workflow created from a conversation dispatches its first step with
 * that conversation's session id, i.e. the agent resumes the real thread with
 * its whole history instead of being handed a summary of it. Everything above it
 * pins the pieces that failure would be silent in:
 *
 *  - the two harnesses' completely different on-disk layouts, and the session id
 *    each of them resumes by (a uuid vs. an absolute .jsonl path) — get this
 *    wrong and the harness quietly opens a NEW session instead of resuming;
 *  - the two things adoption fixes rather than asks for (runner and workdir),
 *    since a workflow running anywhere else cannot find the session at all;
 *  - the index-resolution guard, which is the only thing standing between a
 *    free-code "session id" (an absolute path, straight off the wire) and
 *    reading — or opening a terminal on — an arbitrary file.
 *
 * A throwaway HOME with hand-written transcripts, because the point is the exact
 * record shapes the two CLIs write; those are pinned here against the forms
 * documented in transcript.ts and observed on real sessions.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-conversations-"));
// os.homedir() reads $HOME on POSIX, which is what conversations.ts resolves the
// session roots from — so this is what keeps the suite off the real machine's
// ~/.claude and ~/.free-code.
process.env.HOME = tmpHome;
process.env.TARGET_HOME = path.join(tmpHome, ".target");
// Isolate awb: this suite POSTs to /api/workflows (the real create path →
// createAwbHook), which would otherwise write test hooks into the operator's
// real ~/.agent-webhook-bridge/hooks.json. Same convention as server.test.ts.
process.env.AWB_HOME = path.join(tmpHome, ".agent-webhook-bridge");

const { adoptability, findConversation, listConversations, readConversationPreview } = await import("./conversations.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { _impl: terminalImpl } = await import("./terminal.ts");
const { getWorkflow, insertStep, getStep, setWorkflowSessionId } = await import("./db.ts");
const { dispatchStep } = await import("./runner.ts");
const { restartWorkflow } = await import("./workflow.ts");

/**
 * The directory the fixture conversations ran in. A REAL one, under the
 * throwaway HOME, because adopting a conversation pins the workflow's agent to
 * it — the create path makes the hook's workdir this directory and awb creates
 * it — so an imaginary `/home/u/proj` would fail at mkdir rather than testing
 * anything.
 */
const projDir = path.join(tmpHome, "proj");
fs.mkdirSync(projDir, { recursive: true });

const CLAUDE_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const claudeDir = path.join(tmpHome, ".claude", "projects", "-home-u-proj");
const claudeFile = path.join(claudeDir, `${CLAUDE_SESSION}.jsonl`);
const freeCodeDir = path.join(tmpHome, ".free-code", "agent", "sessions", "--home-u-proj--");
const freeCodeFile = path.join(freeCodeDir, "2026-08-01T10-00-00-000Z_bbbbbbbb-5555.jsonl");

const CURSOR_SESSION = "cccccccc-dddd-eeee-ffff-111111111111";
const cursorProjectHash = "390743aa0f12298f4c0ec413e047fd56";
const cursorChatDir = path.join(tmpHome, ".cursor", "chats", cursorProjectHash, CURSOR_SESSION);
const cursorTranscriptDir = path.join(
	tmpHome,
	".cursor",
	"projects",
	"home-u-proj",
	"agent-transcripts",
	CURSOR_SESSION,
);
const cursorTranscriptFile = path.join(cursorTranscriptDir, `${CURSOR_SESSION}.jsonl`);

function write(file: string, lines: unknown[], mtimeSeconds: number): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
}

// --- a Claude Code conversation, in the record shapes claude actually writes ---
write(
	claudeFile,
	[
		// Preamble records the reader has to skip past to find the first human turn.
		{ type: "mode", sessionId: CLAUDE_SESSION },
		{ type: "file-history-snapshot" },
		{
			type: "user",
			cwd: projDir,
			timestamp: "2026-08-01T09:00:00.000Z",
			message: { role: "user", content: "Necesito un workflow para el release" },
		},
		{
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PENSAMIENTO PRIVADO" },
					{ type: "text", text: "Podemos hacerlo en tres pasos." },
					{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
				],
			},
		},
		// A tool result: a `user` record with no prose at all.
		{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "SALIDA DE LA HERRAMIENTA" }] } },
		// A subagent's turn, which the operator never said.
		{ type: "user", isSidechain: true, message: { role: "user", content: "CHARLA DEL SUBAGENTE" } },
		{
			type: "user",
			message: { role: "user", content: "<system-reminder>RECORDATORIO INYECTADO</system-reminder>Y el segundo paso?" },
		},
	],
	1_800_000_200,
);

// Claude nests subagent transcripts one level deeper, under the session id.
write(path.join(claudeDir, CLAUDE_SESSION, "subagents", "sub-1.jsonl"), [{ type: "user", message: { role: "user", content: "no soy una conversacion" } }], 1_800_000_300);

// --- a free-code conversation ---
write(
	freeCodeFile,
	[
		{ type: "session", version: 3, id: "bbbbbbbb-5555", timestamp: "2026-08-01T10:00:00.000Z", cwd: projDir },
		{ type: "model_change", id: "m1", parentId: null, modelId: "some/model" },
		{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Arregla el bug del login" }] } },
		{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Hecho, era el token." }] } },
	],
	1_800_000_100,
);

// free-code keeps ITS subagent sessions in a sibling directory of the session
// dirs, so that one has to be excluded by name rather than by depth.
write(
	path.join(tmpHome, ".free-code", "agent", "sessions", "subagents", "sub-2.jsonl"),
	[{ type: "message", message: { role: "user", content: [{ type: "text", text: "tampoco soy una conversacion" }] } }],
	1_800_000_400,
);

// --- a Cursor Agent conversation (role at top level, cwd in meta.json) ---
fs.mkdirSync(cursorChatDir, { recursive: true });
fs.writeFileSync(
	path.join(cursorChatDir, "meta.json"),
	JSON.stringify({ schemaVersion: 1, cwd: projDir, title: "Arregla el picker de cursor" }),
);
fs.writeFileSync(path.join(cursorChatDir, "store.db"), "placeholder");
write(
	cursorTranscriptFile,
	[
		{
			role: "user",
			message: {
				content: [{ type: "text", text: "<timestamp>2026</timestamp>\n<user_query>\nArregla el picker de cursor\n</user_query>" }],
			},
		},
		{
			role: "assistant",
			message: { content: [{ type: "text", text: "Hecho." }] },
		},
	],
	1_800_000_150,
);

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

test("a claude conversation is listed under its resume uuid, titled by the first thing the human said", () => {
	const { conversations: found } = listConversations("claude");
	assert.equal(found.length, 1, "the subagent transcript under <session>/subagents/ is not a conversation");
	const [conversation] = found;
	// `claude --resume` takes the uuid, so that — not the path — is the handle.
	assert.equal(conversation.sessionId, CLAUDE_SESSION);
	assert.equal(conversation.path, claudeFile);
	// Read from the records' own `cwd`: the directory name is a lossy slug of it.
	assert.equal(conversation.workdir, projDir);
	assert.equal(conversation.title, "Necesito un workflow para el release");
});

test("a free-code conversation is listed under its .jsonl path, which is what --session takes", () => {
	const { conversations: found } = listConversations("free-code");
	assert.equal(found.length, 1, "the sibling subagents/ directory is excluded by name");
	const [conversation] = found;
	assert.equal(conversation.sessionId, freeCodeFile, "the session id IS the path for free-code");
	assert.equal(conversation.workdir, projDir);
	assert.equal(conversation.title, "Arregla el bug del login");
});

test("a cursor conversation is listed under its chat uuid, with workdir from meta.json and title from the transcript", () => {
	const { conversations: found } = listConversations("cursor");
	assert.equal(found.length, 1);
	const [conversation] = found;
	assert.equal(conversation.sessionId, CURSOR_SESSION);
	assert.equal(conversation.path, cursorTranscriptFile);
	assert.equal(conversation.workdir, projDir);
	assert.equal(conversation.title, "Arregla el picker de cursor");
	assert.deepEqual(adoptability(conversation), { ok: true, workdir: projDir, reason: null });
});

test("the two harnesses' conversations are separate lists — picking the agent IS the filter", () => {
	const claude = listConversations("claude").conversations.map((c) => c.sessionId);
	const freeCode = listConversations("free-code").conversations.map((c) => c.sessionId);
	const cursor = listConversations("cursor").conversations.map((c) => c.sessionId);
	assert.deepEqual(claude, [CLAUDE_SESSION]);
	assert.deepEqual(freeCode, [freeCodeFile]);
	assert.deepEqual(cursor, [CURSOR_SESSION]);
	assert.equal(
		claude.some((id) => freeCode.includes(id)),
		false,
	);
});

test("a previous workflow's session is titled by the workflow, not by the prompt template", () => {
	// Every session a workflow ran opens with the hub's own promptTemplate, so
	// without this every such row in the picker reads identically.
	const file = path.join(claudeDir, "dddddddd-7777.jsonl");
	write(
		file,
		[
			{
				type: "user",
				cwd: projDir,
				message: {
					role: "user",
					content:
						'You are the agent of a workflow in The Target Project named "release notes". This session is reused in order for every step of the workflow. Current step:\n\nescribe el changelog',
				},
			},
		],
		1_800_000_600,
	);

	const conversation = findConversation("claude", "dddddddd-7777");
	assert.ok(conversation);
	assert.equal(conversation.title, 'Workflow "release notes"');

	fs.rmSync(file);
});

test("the preview keeps the prose and drops the machinery", () => {
	const conversation = findConversation("claude", CLAUDE_SESSION);
	assert.ok(conversation);
	const preview = readConversationPreview(conversation);

	assert.match(preview.text, /Necesito un workflow para el release/);
	assert.match(preview.text, /Podemos hacerlo en tres pasos\./);
	assert.match(preview.text, /Y el segundo paso\?/);

	// The preview is for recognising a conversation, so it shows what was SAID.
	// (None of this is a fidelity question for the workflow: the workflow resumes
	// the transcript itself, tool calls and all.)
	assert.doesNotMatch(preview.text, /PENSAMIENTO PRIVADO/, "thinking blocks are not part of the conversation");
	assert.doesNotMatch(preview.text, /SALIDA DE LA HERRAMIENTA/, "tool results are dropped");
	assert.doesNotMatch(preview.text, /CHARLA DEL SUBAGENTE/, "a sidechain is a subagent, not the operator");
	assert.doesNotMatch(preview.text, /RECORDATORIO INYECTADO/, "injected reminders are not things the human typed");
	assert.equal(preview.turns, 3);
});

test("a long conversation previews its tail — where it got to is what you check before continuing it", () => {
	const noisy = path.join(claudeDir, "cccccccc-9999.jsonl");
	const lines: unknown[] = [
		{ type: "user", cwd: projDir, message: { role: "user", content: "PRIMER MENSAJE" } },
	];
	for (let i = 0; i < 400; i += 1) {
		lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `relleno ${i} ${"x".repeat(300)}` }] } });
	}
	lines.push({ type: "user", message: { role: "user", content: "ULTIMO MENSAJE" } });
	write(noisy, lines, 1_800_000_500);

	const conversation = findConversation("claude", "cccccccc-9999");
	assert.ok(conversation);
	const preview = readConversationPreview(conversation, 5);

	assert.equal(preview.turns, 402);
	assert.equal(preview.shownTurns, 5);
	assert.match(preview.text, /ULTIMO MENSAJE/, "the end is what identifies where to carry on from");
	assert.doesNotMatch(preview.text, /PRIMER MENSAJE/, "the opening is 400 turns back");
	// Said out loud, or the operator reads a 5-turn panel as the whole history
	// the workflow is about to work from.
	assert.match(preview.text, /earlier turn\(s\) not shown/);
	assert.match(preview.text, /resumes this conversation in full/);

	fs.rmSync(noisy);
});

test("a conversation with no recorded directory cannot be continued by a workflow", () => {
	// The harness resumes a session relative to the directory it ran in (claude
	// derives ~/.claude/projects/<slug> from the cwd), so without one there is
	// nowhere to pick it up. Refused rather than guessed: the guess would be found
	// out at step 1, inside the operator's real conversation.
	const file = path.join(claudeDir, "eeeeeeee-0000.jsonl");
	write(file, [{ type: "user", message: { role: "user", content: "sin directorio" } }], 1_800_000_700);

	const conversation = findConversation("claude", "eeeeeeee-0000");
	assert.ok(conversation);
	assert.equal(conversation.workdir, null);
	const verdict = adoptability(conversation);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.workdir, null);
	assert.match(String(verdict.reason), /directory/);

	// …and one that does record it is adoptable, in exactly that directory.
	const usable = findConversation("claude", CLAUDE_SESSION);
	assert.ok(usable);
	assert.deepEqual(adoptability(usable), { ok: true, workdir: projDir, reason: null });

	fs.rmSync(file);
});

test("a huge opening turn doesn't hide the directory the conversation ran in", () => {
	// Observed on a real transcript: three screenshots pasted into the first
	// message make that ONE record ~170 KB, with its `cwd` at the end — past any
	// fixed head read. Reported as "no directory recorded", the picker refuses to
	// build a workflow on a conversation that is perfectly adoptable, so the head
	// read keeps going until it has an answer rather than stopping at a chunk edge.
	const file = path.join(claudeDir, "ffffffff-1111.jsonl");
	const pasted = "x".repeat(300_000);
	write(
		file,
		[
			{ type: "mode", mode: "normal" },
			{ type: "file-history-snapshot", messageId: "m0", snapshot: {} },
			// Content first, cwd last: the field order the harness actually writes.
			{ type: "user", message: { role: "user", content: `mira estas capturas\n${pasted}` }, cwd: projDir },
			{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "vale" }] } },
		],
		1_800_000_800,
	);

	const conversation = findConversation("claude", "ffffffff-1111");
	assert.ok(conversation);
	assert.equal(conversation.workdir, projDir);
	assert.equal(conversation.title, "mira estas capturas", "and the row is titled by the turn, not by the uuid");
	assert.deepEqual(adoptability(conversation), { ok: true, workdir: projDir, reason: null });

	fs.rmSync(file);
});

test("a session id that isn't one of this harness's transcripts resolves to nothing", () => {
	// free-code session ids are absolute paths and arrive straight off the wire,
	// so this is the guard that stops one naming a file outside the session roots.
	const outsider = path.join(tmpHome, "secreto.jsonl");
	fs.writeFileSync(outsider, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "secreto" }] } })}\n`);
	assert.equal(findConversation("free-code", outsider), null);
	assert.equal(findConversation("free-code", "/etc/passwd"), null);
	// …and a claude uuid is not a free-code session either.
	assert.equal(findConversation("free-code", CLAUDE_SESSION), null);
});

test("GET /api/conversations filters by agent, and refuses an unknown one", async () => {
	const res = await fetch(`${baseUrl}/api/conversations?runner=claude`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { conversations: { sessionId: string; title: string; runner: string }[] };
	assert.deepEqual(
		body.conversations.map((c) => c.sessionId),
		[CLAUDE_SESSION],
	);
	assert.equal(body.conversations[0].runner, "claude");

	const bad = await fetch(`${baseUrl}/api/conversations?runner=gpt`, { headers: adminHeaders() });
	assert.equal(bad.status, 400);
});

test("GET /api/conversations needs the operator's credentials — it returns the operator's own conversations", async () => {
	// Deliberately NO admin token and no session: the access gate answers 401
	// login_required before the route is even reached.
	const res = await fetch(`${baseUrl}/api/conversations?runner=claude`);
	assert.equal(res.status, 401);
	assert.equal(((await res.json()) as { error: string }).error, "login_required");
});

test("every conversation is listed, not just a fixed first page, and the total is reported", async () => {
	// This was a real bug: the list was hard-capped at 100 with nothing saying so,
	// which on a working machine hid most of what was there (291 of 391 claude
	// transcripts on the machine this was found on) — a picker silently missing
	// the conversation you are looking for.
	const extra = 140;
	const made: string[] = [];
	for (let i = 0; i < extra; i += 1) {
		const file = path.join(claudeDir, `bulk-${String(i).padStart(3, "0")}.jsonl`);
		// Ascending mtimes, all OLDER than the original fixture, so a cap that kept
		// only the newest N would drop the oldest of these.
		write(file, [{ type: "user", cwd: projDir, message: { role: "user", content: `conversacion ${i}` } }], 1_700_000_000 + i);
		made.push(file);
	}

	const { conversations, total } = listConversations("claude");
	assert.equal(total, extra + 1, "total counts every transcript on disk");
	assert.equal(conversations.length, total, "and every one of them is returned");
	// The oldest — exactly what the old cap threw away — is reachable.
	assert.ok(
		conversations.some((c) => c.title === "conversacion 0"),
		"the oldest conversation is still listed",
	);

	const res = await fetch(`${baseUrl}/api/conversations?runner=claude`, { headers: adminHeaders() });
	const body = (await res.json()) as { conversations: unknown[]; total: number };
	assert.equal(body.total, extra + 1, "the route reports the total too");
	assert.equal(body.conversations.length, extra + 1);

	for (const file of made) fs.rmSync(file);
});

test("the conversation list is never served from cache", async () => {
	// The list changes whenever the operator says anything to any agent, and the
	// reason to reopen the form is usually the conversation you just had. A
	// heuristically-cached response would answer that with stale bytes.
	const res = await fetch(`${baseUrl}/api/conversations?runner=claude`, { headers: adminHeaders() });
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.equal(res.headers.get("content-type"), "application/json", "the normal JSON headers survive");
});

test("a conversation created after the first listing shows up on the next one", async () => {
	const before = listConversations("claude").total;
	const file = path.join(claudeDir, "recien-creada.jsonl");
	// Newer than every fixture above (whose mtimes are pinned, not wall-clock).
	write(file, [{ type: "user", cwd: projDir, message: { role: "user", content: "acabo de crear esto" } }], 1_900_000_000);

	const after = listConversations("claude");
	assert.equal(after.total, before + 1);
	assert.equal(after.conversations[0].title, "acabo de crear esto", "and it sorts to the top, being the newest");

	fs.rmSync(file);
});

test("GET /api/conversations/preview shows where the conversation got to, and whether it can be continued", async () => {
	const query = `runner=claude&sessionId=${encodeURIComponent(CLAUDE_SESSION)}`;
	const res = await fetch(`${baseUrl}/api/conversations/preview?${query}`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		preview: { text: string; turns: number };
		adoptable: { ok: boolean; workdir: string | null };
	};
	assert.match(body.preview.text, /Necesito un workflow para el release/);
	assert.deepEqual(body.adoptable.ok, true);
	assert.equal(body.adoptable.workdir, projDir, "the directory the workflow will be pinned to");

	const missing = await fetch(`${baseUrl}/api/conversations/preview?runner=claude&sessionId=nope`, {
		headers: adminHeaders(),
	});
	assert.equal(missing.status, 404);
});

test("POST /api/conversations/open-terminal reopens THAT conversation, in its own directory", async (t) => {
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
		body: JSON.stringify({ runner: "claude", sessionId: CLAUDE_SESSION }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workdir: string; sessionId: string };
	assert.equal(body.sessionId, CLAUDE_SESSION);
	// The conversation's own cwd, not the hub's: for claude that's what makes
	// `--resume` find the transcript at all.
	assert.equal(body.workdir, projDir);

	assert.equal(calls.length, 1);
	const shellCommand = calls[0].args.at(-1) ?? "";
	assert.match(shellCommand, new RegExp(`cd '${projDir}'`));
	assert.match(shellCommand, new RegExp(`claude --resume '${CLAUDE_SESSION}'`));

	// A path that isn't one of this harness's transcripts must not reach the
	// terminal launcher at all.
	const outsider = await fetch(`${baseUrl}/api/conversations/open-terminal`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ runner: "free-code", sessionId: "/etc/passwd" }),
	});
	assert.equal(outsider.status, 404);
	assert.equal(calls.length, 1, "no terminal was spawned for the unresolvable id");
});

test("POST /api/conversations/open-terminal for cursor passes workdir into agent --resume", async (t) => {
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
		body: JSON.stringify({ runner: "cursor", sessionId: CURSOR_SESSION }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workdir: string; sessionId: string };
	assert.equal(body.sessionId, CURSOR_SESSION);
	assert.equal(body.workdir, projDir);

	assert.equal(calls.length, 1);
	const shellCommand = calls[0].args.at(-1) ?? "";
	assert.match(shellCommand, new RegExp(`cd '${projDir}'`));
	assert.match(shellCommand, new RegExp(`agent --resume '${CURSOR_SESSION}' --trust --approve-mcps --workspace '${projDir}'`));
});

test("a workflow created from a conversation ADOPTS it: same session, same directory, no summary", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "desde la conversacion",
			conversation: { runner: "claude", sessionId: CLAUDE_SESSION },
		}),
	});
	assert.equal(res.status, 200);
	const created = (await res.json()) as {
		workflow: {
			id: string;
			conversationContext: string | null;
			adoptedSessionId: string | null;
			lastSessionId: string | null;
			workdir: string | null;
			harness: string | null;
		};
	};

	// 1. The workflow continues that conversation. `lastSessionId` is what the
	//    dispatcher resumes, and it is already the conversation's — before a
	//    single step has run.
	assert.equal(created.workflow.adoptedSessionId, CLAUDE_SESSION);
	assert.equal(created.workflow.lastSessionId, CLAUDE_SESSION, "the first step will resume it, not start fresh");

	// 2. Pinned to the conversation's own runtime, which is not a preference: the
	//    harness looks a session up relative to its directory, and a claude uuid
	//    means nothing to free-code.
	assert.equal(created.workflow.workdir, projDir);
	assert.equal(created.workflow.harness, "claude");

	// 3. Nothing is copied. No digest of the transcript, and so no context step to
	//    deliver one — the agent will have the conversation itself.
	assert.equal(created.workflow.conversationContext, null, "the conversation is resumed, not summarised");
	const detail = (await (await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() })).json()) as {
		steps: { kind: string }[];
	};
	assert.equal(detail.steps.filter((step) => step.kind === "context").length, 0);
});

test("an operator note is delivered as one turn inside the adopted conversation", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "con nota",
			conversationNote: "Responde siempre en espanol.",
			conversation: { runner: "free-code", sessionId: freeCodeFile },
		}),
	});
	assert.equal(res.status, 200);
	const created = (await res.json()) as {
		workflow: { id: string; conversationContext: string; adoptedSessionId: string | null };
	};
	assert.equal(created.workflow.adoptedSessionId, freeCodeFile);
	// The note, and ONLY the note: the transcript it would once have been prefixed
	// to is the session the workflow is now running in.
	assert.equal(created.workflow.conversationContext, "Responde siempre en espanol.");
	assert.doesNotMatch(created.workflow.conversationContext, /Arregla el bug del login/);

	// It rides the machinery that already delivers a workflow's background: the
	// hub-owned context step, one turn, before any real step.
	const detail = (await (await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() })).json()) as {
		steps: { kind: string; orderIndex: number; status: string; description: string }[];
	};
	const contextSteps = detail.steps.filter((step) => step.kind === "context");
	assert.equal(contextSteps.length, 1);
	assert.equal(contextSteps[0].orderIndex, -1);
	assert.equal(contextSteps[0].status, "pending");
	assert.match(contextSteps[0].description, /Responde siempre en espanol\./);
});

test("the runner and the directory belong to the conversation — a request that contradicts them is refused", async () => {
	// Silently overriding either would produce a workflow running somewhere the
	// operator didn't choose, or on a harness that cannot resume the session at
	// all — both discovered at step 1, in the operator's real conversation.
	const wrongRunner = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "runner equivocado",
			runner: "free-code",
			conversation: { runner: "claude", sessionId: CLAUDE_SESSION },
		}),
	});
	assert.equal(wrongRunner.status, 400);
	assert.match(((await wrongRunner.json()) as { error: string }).error, /has to be claude/);

	const wrongDir = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "directorio equivocado",
			workdir: "/tmp/otro-sitio",
			conversation: { runner: "claude", sessionId: CLAUDE_SESSION },
		}),
	});
	assert.equal(wrongDir.status, 400);
	// The error names the one directory that WOULD work, so it's actionable.
	assert.ok(((await wrongDir.json()) as { error: string }).error.includes(projDir));

	// Asking for exactly what the conversation says is fine — it agrees.
	const agreeing = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "de acuerdo",
			runner: "claude",
			workdir: projDir,
			conversation: { runner: "claude", sessionId: CLAUDE_SESSION },
		}),
	});
	assert.equal(agreeing.status, 200);
});

test("a conversation with no recorded directory is refused at create, not adopted into nowhere", async () => {
	const file = path.join(claudeDir, "ffffffff-1111.jsonl");
	write(file, [{ type: "user", message: { role: "user", content: "sin cwd" } }], 1_800_000_800);

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "sin sitio", conversation: { runner: "claude", sessionId: "ffffffff-1111" } }),
	});
	assert.equal(res.status, 400);
	assert.match(((await res.json()) as { error: string }).error, /can't be continued/);

	fs.rmSync(file);
});

test("the first step of an adopted workflow dispatches as a RESUME of that conversation", async (t) => {
	// The whole feature, end to end: awb receives the conversation's own session
	// id in the `sessionid` header, which is what makes it run `claude --resume
	// <uuid>` instead of starting a fresh one. Without this the workflow would
	// begin talking to an agent that has never heard of the conversation.
	const dispatched: { sessionId: string | null; input: string }[] = [];
	const broker = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += String(chunk);
		});
		req.on("end", () => {
			dispatched.push({
				sessionId: typeof req.headers.sessionid === "string" ? req.headers.sessionid : null,
				input: (JSON.parse(body) as { input: string }).input,
			});
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
	const brokerAddress = broker.address();
	if (!brokerAddress || typeof brokerAddress === "string") throw new Error("fake broker did not bind");
	t.after(() => broker.close());

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "reanuda la conversacion",
			conversation: { runner: "claude", sessionId: CLAUDE_SESSION },
		}),
	});
	assert.equal(res.status, 200);
	const { workflow: created } = (await res.json()) as { workflow: { id: string } };
	const workflow = getWorkflow(created.id);
	assert.ok(workflow);
	const step = getStep(insertStep(workflow.id, "el primer paso").id);
	assert.ok(step);

	// Point the dispatch at the fake broker instead of the real awb port.
	await dispatchStep(step, { ...workflow, hookUrl: workflow.hookUrl.replace(/:\d+\//, `:${brokerAddress.port}/`) }, cfg, silent);

	assert.equal(dispatched.length, 1);
	assert.equal(dispatched[0].sessionId, CLAUDE_SESSION, "the first step resumes the operator's conversation");
});

test("restarting an adopted workflow goes back to the conversation, not to a blank session", async () => {
	// A restart drops session chaining so the run starts over — but "over" for
	// this workflow is the conversation it was created to continue. Starting it
	// blank would quietly turn it into a different workflow: its steps were
	// written to continue a thread.
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "reinicia",
			conversation: { runner: "claude", sessionId: CLAUDE_SESSION },
		}),
	});
	assert.equal(res.status, 200);
	const { workflow: created } = (await res.json()) as { workflow: { id: string } };
	insertStep(created.id, "un paso");

	// A run has moved the session on (the harness reports its own id back).
	setWorkflowSessionId(created.id, "una-sesion-posterior");
	await restartWorkflow(created.id, cfg, silent);

	const after = getWorkflow(created.id);
	assert.equal(after?.lastSessionId, CLAUDE_SESSION, "the restart resumes the adopted conversation");
	assert.equal(after?.adoptedSessionId, CLAUDE_SESSION, "and it stays recorded for the next restart");
});

test("adopting a conversation is the ONLY context a workflow can be born with (acceptance #8 holds)", async () => {
	// What create accepts is a REFERENCE to a real transcript, which the server
	// resolves and then RUNS ON. A bare conversationContext at creation is still
	// ignored, and a note without a conversation to say it in is ignored with it,
	// so the only way to give a workflow arbitrary prose is still
	// PATCH /api/workflows/:id/context.
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "solo texto",
			conversationContext: "deberia ser ignorado",
			conversationNote: "esto tambien",
		}),
	});
	assert.equal(res.status, 200);
	const created = (await res.json()) as { workflow: { conversationContext: string | null } };
	assert.equal(created.workflow.conversationContext, null);
});

test("POST /api/workflows rejects a conversation that doesn't exist rather than creating a contextless workflow", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "fantasma", conversation: { runner: "claude", sessionId: "no-such-session" } }),
	});
	assert.equal(res.status, 404);
	assert.equal(((await res.json()) as { error: string }).error, "unknown_conversation");

	const badRunner = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "fantasma", conversation: { runner: "gpt", sessionId: CLAUDE_SESSION } }),
	});
	assert.equal(badRunner.status, 400);
});

test("a workflow created without a conversation still has no context step (unchanged behaviour)", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "sin conversacion" }),
	});
	assert.equal(res.status, 200);
	const created = (await res.json()) as { workflow: { id: string; conversationContext: string | null } };
	assert.equal(created.workflow.conversationContext, null);
	const detail = (await (await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() })).json()) as {
		steps: { kind: string }[];
	};
	assert.equal(detail.steps.filter((step) => step.kind === "context").length, 0);
});
