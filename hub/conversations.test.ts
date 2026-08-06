/**
 * Tests for creating a workflow FROM a conversation the operator is already
 * having (hub/conversations.ts + the `/api/conversations` routes + the
 * `conversation` field on POST /api/workflows).
 *
 * The end-to-end guarantee this file exists for is the last test: posting a
 * conversation to POST /api/workflows produces a workflow whose conversation
 * context IS that conversation and whose context step is already sitting at
 * order -1, ready to be dispatched before step 1. Everything above it pins the
 * pieces that failure would be silent in:
 *
 *  - the two harnesses' completely different on-disk layouts, and the session id
 *    each of them resumes by (a uuid vs. an absolute .jsonl path);
 *  - which lines are conversation and which are machinery — a digest that
 *    carried tool results and system reminders would blow the budget on content
 *    the new workflow doesn't need, and one that carried a subagent's sidechain
 *    would attribute things to the operator they never said;
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

const { findConversation, listConversations, readConversationDigest } = await import("./conversations.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { _impl: terminalImpl } = await import("./terminal.ts");

const CLAUDE_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const claudeDir = path.join(tmpHome, ".claude", "projects", "-home-u-proj");
const claudeFile = path.join(claudeDir, `${CLAUDE_SESSION}.jsonl`);
const freeCodeDir = path.join(tmpHome, ".free-code", "agent", "sessions", "--home-u-proj--");
const freeCodeFile = path.join(freeCodeDir, "2026-08-01T10-00-00-000Z_bbbbbbbb-5555.jsonl");

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
			cwd: "/home/u/proj",
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
		{ type: "session", version: 3, id: "bbbbbbbb-5555", timestamp: "2026-08-01T10:00:00.000Z", cwd: "/home/u/proj" },
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
	assert.equal(conversation.workdir, "/home/u/proj");
	assert.equal(conversation.title, "Necesito un workflow para el release");
});

test("a free-code conversation is listed under its .jsonl path, which is what --session takes", () => {
	const { conversations: found } = listConversations("free-code");
	assert.equal(found.length, 1, "the sibling subagents/ directory is excluded by name");
	const [conversation] = found;
	assert.equal(conversation.sessionId, freeCodeFile, "the session id IS the path for free-code");
	assert.equal(conversation.workdir, "/home/u/proj");
	assert.equal(conversation.title, "Arregla el bug del login");
});

test("the two harnesses' conversations are separate lists — picking the agent IS the filter", () => {
	const claude = listConversations("claude").conversations.map((c) => c.sessionId);
	const freeCode = listConversations("free-code").conversations.map((c) => c.sessionId);
	assert.deepEqual(claude, [CLAUDE_SESSION]);
	assert.deepEqual(freeCode, [freeCodeFile]);
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
				cwd: "/home/u/proj",
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

test("the digest keeps the prose and drops the machinery", () => {
	const conversation = findConversation("claude", CLAUDE_SESSION);
	assert.ok(conversation);
	const digest = readConversationDigest(conversation);

	assert.match(digest.text, /Necesito un workflow para el release/);
	assert.match(digest.text, /Podemos hacerlo en tres pasos\./);
	assert.match(digest.text, /Y el segundo paso\?/);

	// Everything below would either blow the budget or misattribute words to the
	// operator, and none of it is background the new workflow needs.
	assert.doesNotMatch(digest.text, /PENSAMIENTO PRIVADO/, "thinking blocks are not part of the conversation");
	assert.doesNotMatch(digest.text, /SALIDA DE LA HERRAMIENTA/, "tool results are dropped");
	assert.doesNotMatch(digest.text, /CHARLA DEL SUBAGENTE/, "a sidechain is a subagent, not the operator");
	assert.doesNotMatch(digest.text, /RECORDATORIO INYECTADO/, "injected reminders are not things the human typed");

	// The framing matters as much as the content: without it the agent reads the
	// transcript as a stack of orders addressed to it.
	assert.match(digest.text, /created from an existing claude conversation/);
	assert.match(digest.text, new RegExp(CLAUDE_SESSION));
	assert.equal(digest.turns, 3);
});

test("an oversized conversation is cut from the middle, keeping both ends and saying so", () => {
	const noisy = path.join(claudeDir, "cccccccc-9999.jsonl");
	const lines: unknown[] = [
		{ type: "user", cwd: "/home/u/proj", message: { role: "user", content: "PRIMER MENSAJE" } },
	];
	for (let i = 0; i < 400; i += 1) {
		lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `relleno ${i} ${"x".repeat(300)}` }] } });
	}
	lines.push({ type: "user", message: { role: "user", content: "ULTIMO MENSAJE" } });
	write(noisy, lines, 1_800_000_500);

	const conversation = findConversation("claude", "cccccccc-9999");
	assert.ok(conversation);
	const digest = readConversationDigest(conversation, 4000);

	assert.equal(digest.truncated, true);
	assert.ok(digest.text.length <= 4000 + 600, `digest stayed near the budget (was ${digest.text.length})`);
	assert.match(digest.text, /PRIMER MENSAJE/, "the opening says what the conversation was for");
	assert.match(digest.text, /ULTIMO MENSAJE/, "the end says where it got to");
	assert.match(digest.text, /turn\(s\) omitted from the middle/, "the agent is told the record is incomplete");
	assert.ok(digest.includedTurns < digest.turns);

	fs.rmSync(noisy);
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
		write(file, [{ type: "user", cwd: "/home/u/proj", message: { role: "user", content: `conversacion ${i}` } }], 1_700_000_000 + i);
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
	write(file, [{ type: "user", cwd: "/home/u/proj", message: { role: "user", content: "acabo de crear esto" } }], 1_900_000_000);

	const after = listConversations("claude");
	assert.equal(after.total, before + 1);
	assert.equal(after.conversations[0].title, "acabo de crear esto", "and it sorts to the top, being the newest");

	fs.rmSync(file);
});

test("GET /api/conversations/preview shows exactly what would be imported", async () => {
	const query = `runner=claude&sessionId=${encodeURIComponent(CLAUDE_SESSION)}`;
	const res = await fetch(`${baseUrl}/api/conversations/preview?${query}`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { digest: { text: string; turns: number } };
	assert.match(body.digest.text, /Necesito un workflow para el release/);

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
	assert.equal(body.workdir, "/home/u/proj");

	assert.equal(calls.length, 1);
	const shellCommand = calls[0].args.at(-1) ?? "";
	assert.match(shellCommand, /cd '\/home\/u\/proj'/);
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

test("a workflow can be created FROM a conversation: it arrives with that conversation as its context step", async () => {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "desde la conversacion",
			conversation: { runner: "claude", sessionId: CLAUDE_SESSION },
		}),
	});
	assert.equal(res.status, 200);
	const created = (await res.json()) as { workflow: { id: string; conversationContext: string | null } };

	// 1. The conversation is the workflow's background.
	assert.ok(created.workflow.conversationContext, "the new workflow has a conversation context");
	assert.match(created.workflow.conversationContext, /Necesito un workflow para el release/);
	assert.match(created.workflow.conversationContext, /Y el segundo paso\?/);
	assert.doesNotMatch(created.workflow.conversationContext, /SALIDA DE LA HERRAMIENTA/);

	// 2. It is already materialised as the hub-owned context step, pinned before
	//    every step the operator will add — the same delivery a context typed into
	//    the panel afterwards would get, so it runs once, first, on the shared
	//    session. Without this the context would sit in a column nobody dispatches.
	const detail = (await (await fetch(`${baseUrl}/api/workflows/${created.workflow.id}`, { headers: adminHeaders() })).json()) as {
		steps: { kind: string; orderIndex: number; status: string; description: string }[];
	};
	const contextSteps = detail.steps.filter((step) => step.kind === "context");
	assert.equal(contextSteps.length, 1, "exactly one context step");
	assert.equal(contextSteps[0].orderIndex, -1, "sorts before every step the operator adds");
	assert.equal(contextSteps[0].status, "pending", "it hasn't run yet — it runs when the workflow starts");
	assert.match(contextSteps[0].description, /Necesito un workflow para el release/);
});

test("an operator note frames the import, above the transcript", async () => {
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
	const created = (await res.json()) as { workflow: { conversationContext: string } };
	const note = created.workflow.conversationContext.indexOf("Responde siempre en espanol.");
	const transcript = created.workflow.conversationContext.indexOf("Arregla el bug del login");
	assert.ok(note >= 0 && transcript >= 0);
	assert.ok(note < transcript, "what the operator wrote for THIS workflow comes first");
});

test("importing a conversation is the ONLY context a workflow can be born with (acceptance #8 holds)", async () => {
	// The escape hatch this feature needed is a REFERENCE to a real transcript,
	// resolved and condensed by the server — not a free-text field. A bare
	// conversationContext at creation is still ignored, and a note without a
	// conversation to frame is ignored with it, so the only way to give a
	// workflow arbitrary prose is still PATCH /api/workflows/:id/context.
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
