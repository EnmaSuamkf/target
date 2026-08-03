/**
 * The operator's existing harness conversations, read straight off disk, so a
 * workflow can be created FROM one instead of starting from a blank context
 * box.
 *
 * The motivating case: you are already talking to `claude` (or `free-code`)
 * about a piece of work, you decide it should become a workflow, and you want
 * that conversation to be the background every step runs under. The hub already
 * has the delivery half of that — a workflow's `conversation_context` is
 * dispatched as its own `kind='context'` step before any real work (see
 * `reconcileContextStep` in workflow.ts). What was missing is the capture half,
 * which is what this module is.
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
 * ## Why a digest and not the transcript
 *
 * These files are big — megabytes each on this machine — and the hub's JSON body
 * limit is `maxInputBytes` (64 KiB, config.ts), which is the smaller problem.
 * The real one is that the context step is ONE turn on the workflow's shared
 * session, and `context-pressure.ts` exists precisely because that session's
 * occupancy is a finite resource the workflow spends on actual work. So the
 * transcript is condensed: tool calls, tool results, thinking blocks and
 * injected reminders are dropped (they are the bulk, and they describe machinery
 * the new workflow will redo anyway), leaving the human/agent prose, capped per
 * turn and fitted to a byte budget from both ends — the opening frames what the
 * conversation was for, the end is where it got to.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

export interface ConversationDigest {
	/** The condensed transcript, ready to be stored as a workflow's conversation context. */
	text: string;
	/** Prose turns found in the transcript. */
	turns: number;
	/** How many of them survived the budget. */
	includedTurns: number;
	/** True when turns were dropped from the middle, or a turn was cut short. */
	truncated: boolean;
}

/**
 * How much of the head of a transcript is read to label it. Enough to clear the
 * preamble records (mode, permissions, file-history snapshots) and reach the
 * first human turn, without reading megabytes per file just to draw a list.
 */
const HEAD_BYTES = 64 * 1024;

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
 * Default size of the condensed transcript, in characters. Comfortably inside
 * `maxInputBytes` (64 KiB) with room for the rest of the create body, and small
 * enough that the context step stays one modest turn rather than a large chunk
 * of the session's window.
 */
export const DEFAULT_DIGEST_BUDGET = 16 * 1024;

/** Per-turn cap, so one pasted file can't consume the whole budget. */
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
 * Reads the label for one transcript out of its first `HEAD_BYTES`: the workdir
 * (from any record's `cwd`) and a title (the first human turn). Both optional —
 * a transcript whose opening is one enormous line yields neither, and the caller
 * falls back to the file name.
 */
function readHead(file: string): { workdir: string | null; title: string | null } {
	let text: string;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buffer = Buffer.alloc(HEAD_BYTES);
			const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
			text = buffer.subarray(0, read).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return { workdir: null, title: null };
	}
	let workdir: string | null = null;
	let title: string | null = null;
	// The last line is normally cut mid-record by the byte cap; JSON.parse simply
	// fails on it, which is the same skip a malformed line gets.
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (!workdir && typeof obj.cwd === "string" && obj.cwd !== "") workdir = obj.cwd;
		if (!title) {
			const turn = turnOfLine(obj);
			if (turn?.role === "user") title = titleOf(turn.text);
		}
		if (workdir && title) break;
	}
	return { workdir, title };
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

/**
 * Fits rendered turns into `budget` characters by keeping both ends and
 * dropping the middle — the opening says what the conversation was for and the
 * end says where it got to, whereas the middle is the part a summary would have
 * compressed anyway.
 */
function fitToBudget(entries: string[], budget: number): { kept: string[]; omitted: number } {
	const SEPARATOR = 2; // the "\n\n" between turns
	const total = entries.reduce((sum, entry) => sum + entry.length + SEPARATOR, 0);
	if (total <= budget) return { kept: entries, omitted: 0 };
	// Reserve room for the elision marker itself, so the result cannot come out
	// over budget by adding the line that says it was trimmed.
	const usable = Math.max(0, budget - 80);
	const head: string[] = [];
	let used = 0;
	let first = 0;
	while (first < entries.length && used + entries[first].length + SEPARATOR <= Math.floor(usable / 2)) {
		head.push(entries[first]);
		used += entries[first].length + SEPARATOR;
		first += 1;
	}
	const tail: string[] = [];
	let last = entries.length - 1;
	while (last >= first && used + entries[last].length + SEPARATOR <= usable) {
		tail.unshift(entries[last]);
		used += entries[last].length + SEPARATOR;
		last -= 1;
	}
	const omitted = last - first + 1;
	if (omitted <= 0) return { kept: [...head, ...tail], omitted: 0 };
	return { kept: [...head, `[… ${omitted} turn(s) omitted from the middle of the conversation …]`, ...tail], omitted };
}

/** One turn as it appears in the digest, capped so no single message can dominate. */
function renderTurn(turn: Turn): { line: string; cut: boolean } {
	const speaker = turn.role === "user" ? "User" : "Assistant";
	if (turn.text.length <= MAX_TURN_CHARS) return { line: `${speaker}: ${turn.text}`, cut: false };
	return { line: `${speaker}: ${turn.text.slice(0, MAX_TURN_CHARS)}\n[… turn truncated …]`, cut: true };
}

/**
 * Condenses a conversation into the text a workflow will carry as its
 * conversation context — background for every step, delivered once by the
 * context step.
 *
 * The header is not decoration: the agent receiving this needs to know it is
 * reading a transcript of an earlier conversation rather than instructions
 * addressed to it, and that the transcript is incomplete. Without that framing
 * an imported conversation reads as a pile of contradictory orders.
 */
export function readConversationDigest(
	conversation: ConversationSummary,
	budget: number = DEFAULT_DIGEST_BUDGET,
): ConversationDigest {
	const turns = readTurns(conversation.path);
	const rendered = turns.map(renderTurn);
	const { kept, omitted } = fitToBudget(
		rendered.map((entry) => entry.line),
		budget,
	);
	const truncated = omitted > 0 || rendered.some((entry) => entry.cut);
	const header = [
		`This workflow was created from an existing ${conversation.runner} conversation. What follows is that conversation, condensed — it is background for every step of this workflow, not a task in itself.`,
		"",
		`Source: ${conversation.runner} session ${conversation.sessionId}`,
		conversation.workdir ? `Working directory of that conversation: ${conversation.workdir}` : null,
		`Last active: ${conversation.updatedAt}`,
		truncated
			? `Note: tool calls, tool results and internal reasoning were dropped, and the transcript was shortened — ${omitted > 0 ? `${omitted} turn(s) from the middle are missing` : "some long turns were cut"}. Treat it as a summary, not a complete record.`
			: "Note: tool calls, tool results and internal reasoning were dropped; the prose is complete.",
		"",
		"--- conversation ---",
	]
		.filter((line) => line !== null)
		.join("\n");
	// A conversation with no prose at all still produces a usable context: the
	// header alone says where the workflow came from, which beats a blank one.
	const body = kept.length > 0 ? kept.join("\n\n") : "(no prose turns found in this transcript)";
	return {
		text: `${header}\n\n${body}`,
		turns: turns.length,
		includedTurns: turns.length - omitted,
		truncated,
	};
}
