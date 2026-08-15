/**
 * The operator's existing harness conversations, read straight off disk, so a
 * workflow can be created to RUN ON one instead of starting from a blank
 * context box.
 *
 * The motivating case: you are already talking to `claude` (or `free-code`)
 * about a piece of work, you decide it should become a workflow, and you want
 * the workflow to carry on in that same conversation.
 *
 * ## Adoption, not import
 *
 * This module used to condense the transcript into a workflow's
 * `conversation_context` — a summary of a conversation, delivered as one turn to
 * a brand-new session. That was always a lossy copy of something the machine
 * already had: the conversation itself, which both harnesses can resume. So the
 * workflow now ADOPTS the session instead (`adoptedSessionId` in db.ts, seeded
 * into `lastSessionId` at creation), and its very first step dispatches with
 * that session id — i.e. `claude --resume <uuid>` / `free-code --session
 * <path>`, the same mechanism every step after the first has always used to
 * chain onto the previous one. The agent therefore starts the workflow with the
 * conversation's full history, exactly as the operator left it, with nothing
 * truncated and no context step spent restating it.
 *
 * What adoption costs, and why the constraints below exist: the workflow writes
 * into the operator's own conversation. That is the point — reopening it shows
 * the workflow's steps continuing the thread — but it means the runner and the
 * working directory are no longer free choices. They are the conversation's:
 *
 *  - the RUNNER must be the harness that wrote the transcript (a claude uuid
 *    means nothing to free-code, and vice versa);
 *  - the WORKDIR must be the conversation's own, because that is where the
 *    harness looks the session up (claude derives its `projects/<slug>` from the
 *    cwd, so `--resume` from anywhere else simply doesn't find it) and because
 *    the work continues in the repo it was about.
 *
 * `adoptability` below answers, for one conversation, whether those hold — the
 * server refuses a create that can't satisfy them, rather than producing a
 * workflow that dies at step 1 or silently opens a fresh session.
 *
 * Two harnesses, two on-disk layouts — the same split transcript.ts documents,
 * but walked in the opposite direction (there: workdir + session id → file;
 * here: enumerate the files and report what's in them):
 *
 * - **Claude Code** — `~/.claude/projects/<slug>/<sessionId>.jsonl`. The slug is
 *   a lossy encoding of the workdir (every non `a-zA-Z0-9-` char becomes `-`),
 *   so the workdir is read from the records' own `cwd` field rather than
 *   decoded from the directory name. The session id is the file's basename,
 *   which is exactly what `claude --resume` takes.
 * - **free-code** — `~/.free-code/agent/sessions/<slug>/<stamp>_<uuid>.jsonl`,
 *   plus the copies awb's adapter keeps under
 *   `~/.agent-webhook-bridge/sessions/<hook>/`. Here the session id IS the
 *   absolute path (that's what `free-code --session` takes), so no slug is
 *   involved at all.
 *
 * Only depth 2 is walked (a session dir's `.jsonl` children), which is also what
 * keeps subagent transcripts out: claude nests those at
 * `<sessionId>/subagents/*.jsonl` and free-code keeps a whole `subagents/` tree,
 * and neither is a conversation the operator ever had.
 *
 * ## The preview is for identification only
 *
 * `readConversationPreview` renders the tail of a transcript so the operator can
 * confirm, by eye, that this is the conversation they mean. It is deliberately
 * NOT what the workflow receives — the workflow receives the conversation — so
 * it drops tool calls, results and thinking (the bulk of a file that runs to
 * megabytes) and keeps only the last few prose turns. Nothing about it is on the
 * workflow's critical path: get it wrong and a preview looks odd, not a workflow
 * runs on the wrong history.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { PublishableRunner } from "./awb.ts";

/** One conversation the operator can pick as the source for a new workflow. */
export interface ConversationSummary {
	/** Which CLI produced it — the same identifier a workflow's `runner` takes. */
	runner: PublishableRunner;
	/**
	 * What the harness resumes by, and the only handle the API accepts: a uuid
	 * for claude, the transcript's absolute path for free-code. Deliberately the
	 * same value `harnessResumeCommand` wants, so "open this conversation in a
	 * terminal" needs no second lookup.
	 */
	sessionId: string;
	/** Absolute path of the transcript file (equal to `sessionId` for free-code). */
	path: string;
	/** Directory the conversation ran in, read from the records; null when none said. */
	workdir: string | null;
	/** First real thing the human said, one line — what makes the list readable. */
	title: string;
	/** Transcript mtime: when the conversation was last spoken in. */
	updatedAt: string;
	sizeBytes: number;
}

/**
 * The tail of a conversation, for the operator to recognise it by. See "The
 * preview is for identification only" above: this is never given to an agent.
 */
export interface ConversationPreview {
	/** The rendered turns, newest last, as shown in the picker. */
	text: string;
	/** Prose turns found in the transcript. */
	turns: number;
	/** How many of them the preview shows. */
	shownTurns: number;
}

/**
 * Whether a workflow can be created to run ON a conversation, and — when it
 * can't — the sentence the operator gets instead. See "Adoption, not import".
 */
export interface Adoptability {
	ok: boolean;
	/** The workdir the workflow must use; null exactly when `ok` is false for that reason. */
	workdir: string | null;
	/** Why not, in the operator's terms. Null when `ok`. */
	reason: string | null;
}

/**
 * How much of the head of a transcript is read at a time to label it. Enough to
 * clear the preamble records (mode, permissions, file-history snapshots) and
 * reach the first human turn in one read, without pulling megabytes per file
 * just to draw a list.
 */
const HEAD_CHUNK_BYTES = 64 * 1024;

/**
 * How far `readHead` will keep reading when one chunk didn't answer both
 * questions.
 *
 * This used to be a single 64 KB read, and a record can be much bigger than the
 * whole chunk: paste three screenshots into your first message and that one turn
 * runs to ~170 KB, with the record's `cwd` at the END of it. The head then held
 * nothing but the preamble plus a truncated line that `JSON.parse` throws away,
 * so a conversation that recorded its directory perfectly well was reported as
 * having none — and `adoptability` turns that into a refusal to build a workflow
 * on it ("nowhere to resume it from"), which is a hard stop for the operator,
 * not a cosmetic one. It also fell back to the file name for the title, i.e. a
 * row in the picker labelled with a bare uuid.
 *
 * So the read continues chunk by chunk until both answers are in hand. The
 * ceiling is what keeps a pathological file from being read end to end for a
 * label; normal transcripts still cost exactly one chunk, since the loop stops
 * as soon as it has what it came for.
 */
const HEAD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Safety ceiling on how many conversations one listing returns, newest first.
 *
 * This used to be 100, which on a working machine silently hid most of what was
 * there — 291 of 391 claude transcripts, here — with nothing in the response to
 * say so. A picker that quietly omits your conversation is worse than a slow
 * one, so the ceiling is now high enough not to bite in practice, and when it
 * does bite the count comes back alongside the list (`total`) so the UI can say
 * what it isn't showing. Listing all 391 costs ~100ms, which is the head-read of
 * each file; this is a local single-user tool, so that is a fine trade.
 */
const MAX_CONVERSATIONS = 1000;

/**
 * How many trailing prose turns the preview shows. Enough to recognise where a
 * conversation got to — which is the only question it answers — without
 * rendering a megabyte into the form.
 */
export const DEFAULT_PREVIEW_TURNS = 12;

/** Per-turn cap in the preview, so one pasted file doesn't fill the panel. */
const MAX_TURN_CHARS = 2000;

/** Longest title shown in the picker. */
const MAX_TITLE_CHARS = 160;

/** Where each harness keeps its session transcripts, in the order they're searched. */
function sessionRoots(runner: PublishableRunner): string[] {
	const home = os.homedir();
	if (runner === "claude") return [path.join(home, ".claude", "projects")];
	return [
		path.join(home, ".free-code", "agent", "sessions"),
		// awb's free-code adapter writes the sessions IT spawned here — including
		// every existing workflow's — so they're offered too: "turn that run into a
		// new workflow" is the same operation.
		path.join(home, ".agent-webhook-bridge", "sessions"),
	];
}

interface FileEntry {
	file: string;
	mtimeMs: number;
	size: number;
}

/**
 * Every transcript directly inside a session directory of `root`. Depth 2 only:
 * anything deeper is a subagent transcript (claude's `<id>/subagents/`) or an
 * artifact directory, neither of which is a conversation.
 */
function transcriptFiles(root: string): string[] {
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		// No such harness on this machine — an empty list, never an error.
		return [];
	}
	const files: string[] = [];
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		// free-code keeps its subagent sessions in a sibling directory rather than
		// under the parent session, so it has to be excluded by name.
		if (dir.name === "subagents") continue;
		const full = path.join(root, dir.name);
		try {
			for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(full, entry.name));
			}
		} catch {
			// Unreadable session dir: skip it, keep listing the rest.
		}
	}
	return files;
}

/** The transcripts for `runner`, newest first, capped. */
function indexFiles(runner: PublishableRunner): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const root of sessionRoots(runner)) {
		for (const file of transcriptFiles(root)) {
			try {
				const stat = fs.statSync(file);
				// A zero-byte transcript is a session that never said anything; it has
				// no context to import and resuming it shows an empty window.
				if (!stat.isFile() || stat.size === 0) continue;
				entries.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
			} catch {
				// Vanished between readdir and stat — fine, it's just not listed.
			}
		}
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return entries;
}

/** The handle the API and the resume command use for a transcript. */
function sessionIdOf(runner: PublishableRunner, file: string): string {
	return runner === "claude" ? path.basename(file, ".jsonl") : file;
}

/**
 * Wrappers the harnesses inject into a user turn that are not things the human
 * typed: reminders the CLI appends, the echo of a slash command's expansion,
 * and the stdout of a local command. Left in, they'd dominate both the titles
 * and the digest with machinery.
 */
const NOISE_PATTERNS = [
	/<system-reminder>[\s\S]*?<\/system-reminder>/g,
	/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
	/<command-message>[\s\S]*?<\/command-message>/g,
	/<command-args>[\s\S]*?<\/command-args>/g,
	/<command-name>[\s\S]*?<\/command-name>/g,
];

function stripNoise(text: string): string {
	let out = text;
	for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, "");
	return out.trim();
}

/**
 * The prose of a message's content. Both harnesses use the same block shape,
 * and everything that isn't a `text` block — `tool_use`, `tool_result`,
 * `thinking`, images — is deliberately dropped: it's the bulk of the file and
 * it describes work the new workflow is going to do again anyway.
 */
function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as Record<string, unknown>;
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.join("\n");
}

interface Turn {
	role: "user" | "assistant";
	text: string;
}

/**
 * One conversation turn out of a parsed transcript line, or null when the line
 * carries no prose (a tool result, a mode change, an all-thinking assistant
 * turn, a sidechain's message).
 *
 * The two harnesses disagree only on where the role lives: claude puts it in the
 * record's `type`, free-code wraps every message in `type:"message"` and puts
 * the role on the message.
 */
export function turnOfLine(obj: Record<string, unknown>): Turn | null {
	// Sidechain = a subagent's conversation, not the one the operator had. Meta =
	// something the CLI injected into the thread on the user's behalf.
	if (obj.isSidechain === true || obj.isMeta === true) return null;
	const message = obj.message as Record<string, unknown> | undefined;
	if (!message) return null;
	const role = obj.type === "user" || obj.type === "assistant" ? obj.type : message.role;
	if (role !== "user" && role !== "assistant") return null;
	const text = stripNoise(textOfContent(message.content));
	if (!text) return null;
	return { role, text };
}

/** First non-empty line of `text`, trimmed to `max` with an ellipsis. */
function oneLine(text: string, max: number): string {
	const line = text.split("\n").find((candidate) => candidate.trim() !== "")?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The hub's own `promptTemplate` (see `createWorkflow`), which is the first
 * "user" turn of every session a workflow ever ran. Those sessions are listed —
 * turning a previous run into a new workflow is a real thing to want — but
 * titled by their first turn they all read "You are the agent of a workflow in
 * The Target Project named …", i.e. a list of identical rows. The hub wrote that
 * sentence, so it can recognise it and show the workflow's name instead.
 */
const WORKFLOW_PROMPT = /^You are the agent of a workflow in The Target Project named "(.+?)"\./;

/** Title for a conversation, from the first thing said in it. */
function titleOf(text: string): string {
	const workflow = WORKFLOW_PROMPT.exec(text);
	if (workflow) return oneLine(`Workflow "${workflow[1]}"`, MAX_TITLE_CHARS);
	return oneLine(text, MAX_TITLE_CHARS);
}

/**
 * Reads the label for one transcript off the head of the file: the workdir (from
 * any record's `cwd`) and a title (the first human turn). Reads a chunk at a
 * time and stops as soon as it has both, or at `HEAD_MAX_BYTES` — see there for
 * why it doesn't stop at the first chunk. Both are still optional: a transcript
 * that genuinely never says where it ran yields no workdir (which is what makes
 * it unadoptable), and the caller falls back to the file name for the title.
 */
function readHead(file: string): { workdir: string | null; title: string | null } {
	const head: { workdir: string | null; title: string | null } = { workdir: null, title: null };
	const take = (line: string): void => {
		if (!line.trim()) return;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// A malformed line is simply skipped — as is the final one at the ceiling,
			// which is cut mid-record by the byte cap rather than by the writer.
			return;
		}
		if (!head.workdir && typeof obj.cwd === "string" && obj.cwd !== "") head.workdir = obj.cwd;
		if (!head.title) {
			const turn = turnOfLine(obj);
			if (turn?.role === "user") head.title = titleOf(turn.text);
		}
	};
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return head;
	}
	try {
		const buffer = Buffer.alloc(HEAD_CHUNK_BYTES);
		// Chunk boundaries fall wherever they fall: mid-character, which is what the
		// decoder carries across, and mid-record, which is what `pending` carries —
		// a line is only parsed once a newline has completed it, or at EOF, where
		// the file may simply end without one.
		const decoder = new StringDecoder("utf8");
		let pending = "";
		let read = 0;
		while (read < HEAD_MAX_BYTES && !(head.workdir && head.title)) {
			const got = fs.readSync(fd, buffer, 0, Math.min(buffer.length, HEAD_MAX_BYTES - read), read);
			if (got === 0) {
				take(pending + decoder.end());
				break;
			}
			read += got;
			const lines = (pending + decoder.write(buffer.subarray(0, got))).split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) take(line);
		}
	} catch {
		// Whatever was read before the failure still labels the row.
	} finally {
		fs.closeSync(fd);
	}
	return head;
}

function summarize(runner: PublishableRunner, entry: FileEntry): ConversationSummary {
	const head = readHead(entry.file);
	return {
		runner,
		sessionId: sessionIdOf(runner, entry.file),
		path: entry.file,
		workdir: head.workdir,
		title: head.title || path.basename(entry.file, ".jsonl"),
		updatedAt: new Date(entry.mtimeMs).toISOString(),
		sizeBytes: entry.size,
	};
}

/**
 * This harness's conversations on this machine, newest first, with `total`
 * saying how many exist.
 *
 * `total` is not decoration: when the ceiling clips the list, the caller has to
 * be able to say so rather than present a partial list as the whole truth —
 * "your conversation isn't here" and "your conversation is here but I didn't
 * show it" are very different answers for whoever is looking for one.
 */
export function listConversations(runner: PublishableRunner): {
	conversations: ConversationSummary[];
	total: number;
} {
	const entries = indexFiles(runner);
	return {
		conversations: entries.slice(0, MAX_CONVERSATIONS).map((entry) => summarize(runner, entry)),
		total: entries.length,
	};
}

/**
 * The conversation `sessionId` names, or null if this harness has no such
 * transcript.
 *
 * Resolving through the index rather than trusting the id is what makes the id
 * safe to take from a request: a free-code session id is an absolute path, so
 * without this an arbitrary path could be handed to the digest reader or to the
 * terminal launcher. Only files actually enumerated under the harness's own
 * session roots can be named.
 */
export function findConversation(runner: PublishableRunner, sessionId: string): ConversationSummary | null {
	const entry = indexFiles(runner).find((candidate) => sessionIdOf(runner, candidate.file) === sessionId);
	return entry ? summarize(runner, entry) : null;
}

/** Every prose turn of a transcript, in order. */
function readTurns(file: string): Turn[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const turns: Turn[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const turn = turnOfLine(JSON.parse(line) as Record<string, unknown>);
			if (turn) turns.push(turn);
		} catch {
			// Malformed / half-written line: skip it, like transcript.ts does.
		}
	}
	return turns;
}

/** One turn as it appears in the preview, capped so no single message dominates. */
function renderTurn(turn: Turn): string {
	const speaker = turn.role === "user" ? "User" : "Assistant";
	if (turn.text.length <= MAX_TURN_CHARS) return `${speaker}: ${turn.text}`;
	return `${speaker}: ${turn.text.slice(0, MAX_TURN_CHARS)}\n[… turn truncated in this preview …]`;
}

/**
 * The last `tailTurns` prose turns of a conversation, for the operator to
 * confirm they picked the right one.
 *
 * The tail rather than the head, because what you check before continuing a
 * conversation is where it GOT TO. This never reaches an agent — the workflow
 * resumes the real transcript — so trimming here loses nothing.
 */
export function readConversationPreview(
	conversation: ConversationSummary,
	tailTurns: number = DEFAULT_PREVIEW_TURNS,
): ConversationPreview {
	const turns = readTurns(conversation.path);
	const shown = turns.slice(Math.max(0, turns.length - tailTurns));
	const omitted = turns.length - shown.length;
	const lines = shown.map(renderTurn);
	const body = lines.length > 0 ? lines.join("\n\n") : "(no prose turns found in this transcript)";
	const head =
		omitted > 0
			? `[… ${omitted} earlier turn(s) not shown. The workflow resumes this conversation in full — this is only the tail, so you can check it's the right one …]\n\n`
			: "";
	return { text: `${head}${body}`, turns: turns.length, shownTurns: shown.length };
}

/**
 * Whether a workflow can be created to run on `conversation`, and with which
 * working directory.
 *
 * The one hard requirement is the workdir: the workflow's agent must run where
 * the conversation ran, or the harness won't find the session to resume (claude
 * derives `~/.claude/projects/<slug>` from the cwd) and the work would continue
 * in the wrong repo. A transcript that never recorded a `cwd` therefore cannot
 * be adopted — the alternative is guessing a directory and finding out at step
 * 1, on the operator's real conversation.
 *
 * The runner is not checked here because it isn't a question: the conversation
 * knows which harness wrote it, and the caller takes it from `conversation.runner`
 * rather than offering a choice.
 */
export function adoptability(conversation: ConversationSummary): Adoptability {
	if (!conversation.workdir) {
		return {
			ok: false,
			workdir: null,
			reason:
				"this conversation's transcript doesn't record the directory it ran in, so the workflow has nowhere to resume it from",
		};
	}
	return { ok: true, workdir: conversation.workdir, reason: null };
}
