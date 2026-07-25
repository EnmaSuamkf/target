/**
 * Reads real token usage for a session straight from the on-disk transcripts
 * the harness writes. This is read-only and best-effort: if the file or a
 * line is unreadable, that just means a lower total, never an error.
 *
 * Two harnesses, two layouts:
 *
 * - **Claude Code** — `~/.claude/projects/<slug>/<sessionId>.jsonl`, where the
 *   slug is the absolute workdir with every character that isn't
 *   a-z/A-Z/0-9/- replaced by '-' (verified against real sessions:
 *   "/home/lenovo/.target/sandboxes/x" → "-home-lenovo--target-sandboxes-x",
 *   the doubled dash coming from "/."). Usage lives in
 *   `message.usage.{input_tokens,cache_creation_input_tokens,…}`.
 * - **free-code** — the session id IS the transcript's absolute `.jsonl` path
 *   (awb's free-code adapter keeps it under
 *   `~/.agent-webhook-bridge/sessions/<hook>/`), so no directory convention
 *   applies. Usage lives in `message.usage.{input,output,cacheRead,cacheWrite}`
 *   on assistant messages.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Directory Claude Code keeps a workdir's session transcripts in. Exported for
 * progress.ts, which watches that whole tree (not one session file) to tell a
 * working agent from a hung one.
 */
export function claudeProjectDir(workdir: string): string {
	const slug = workdir.replace(/[^a-zA-Z0-9-]/g, "-");
	return path.join(os.homedir(), ".claude", "projects", slug);
}

export function transcriptPath(workdir: string, sessionId: string): string {
	return path.join(claudeProjectDir(workdir), `${sessionId}.jsonl`);
}

/**
 * Default context window (tokens) for the Claude 4.x models awb spawns. Only
 * used to express occupancy as a percentage; the raw token counts are exact.
 */
export const CONTEXT_WINDOW_TOKENS = 200_000;

export interface TokenUsage {
	/**
	 * Context occupancy at the main thread's last turn — input + cache creation +
	 * cache read of the latest assistant message. This is what the `/context`
	 * panel reports, and only the main session counts (subagents have their own).
	 */
	contextTokens: number;
	contextWindow: number;
	/** Billed totals below fold in every subagent transcript, since a step's real work runs there. */
	inputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
	/** input + cache creation + cache read across every counted turn. */
	totalInputTokens: number;
	/** Assistant turns counted (deduped by message id). */
	turns: number;
	/** Whether any subagent transcript was found and folded into the totals. */
	includesSubagents: boolean;
}

interface RawUsage {
	input: number;
	cacheCreation: number;
	cacheRead: number;
	output: number;
	turns: number;
	/** Occupancy (input+cache) at the last turn seen in this file. */
	lastContext: number;
}

/**
 * Reads one usage record out of a parsed transcript line, normalising the two
 * harnesses' shapes to the same fields. Claude Code writes
 * `usage.input_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens`;
 * free-code writes `usage.input`/`cacheWrite`/`cacheRead`. Returns null when
 * the line carries no usage (non-message events, user messages, …).
 */
function usageOfLine(obj: Record<string, unknown>): { id: string | null; input: number; cacheCreation: number; cacheRead: number; output: number } | null {
	const message = obj.message as Record<string, unknown> | undefined;
	const usage = message?.usage as Record<string, number> | undefined;
	if (!usage) return null;
	// free-code only records usage on assistant messages, but claude transcripts
	// can carry usage on other roles' duplicates — keep claude's behaviour and
	// only skip non-assistant roles when the shape is free-code's.
	const isFreeCodeShape = usage.input_tokens === undefined && usage.input !== undefined;
	if (isFreeCodeShape && message?.role !== "assistant") return null;
	const id =
		(typeof message?.id === "string" && message.id) ||
		(typeof obj.requestId === "string" && obj.requestId) ||
		(typeof obj.id === "string" && obj.id) ||
		null;
	return {
		id,
		input: usage.input_tokens ?? usage.input ?? 0,
		cacheCreation: usage.cache_creation_input_tokens ?? usage.cacheWrite ?? 0,
		cacheRead: usage.cache_read_input_tokens ?? usage.cacheRead ?? 0,
		output: usage.output_tokens ?? usage.output ?? 0,
	};
}

/** Sums the `usage` of every assistant message in one transcript file, deduped by message id. */
function accumulateUsage(file: string): RawUsage {
	const acc: RawUsage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, turns: 0, lastContext: 0 };
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return acc;
	}
	const seen = new Set<string>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as Record<string, unknown>;
			const rec = usageOfLine(obj);
			if (!rec) continue;
			// Claude Code can write the same assistant message more than once (e.g. a
			// streamed then finalized copy); key on the message id so its tokens are
			// counted once.
			const id = rec.id ?? line;
			if (seen.has(id)) continue;
			seen.add(id);
			acc.input += rec.input;
			acc.cacheCreation += rec.cacheCreation;
			acc.cacheRead += rec.cacheRead;
			acc.output += rec.output;
			acc.turns += 1;
			acc.lastContext = rec.input + rec.cacheCreation + rec.cacheRead;
		} catch {
			// Skip a malformed/partial line — a partially-written last line while
			// the process is still running is expected, not an error.
		}
	}
	return acc;
}

/** Absolute paths of a session's subagent transcripts (`<session>/subagents/*.jsonl`); empty if none. */
function subagentFiles(workdir: string, sessionId: string): string[] {
	const dir = path.join(claudeProjectDir(workdir), sessionId, "subagents");
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(dir, f));
	} catch {
		return [];
	}
}

/**
 * Reads real token usage for a session straight from the transcripts Claude
 * Code writes, so no extra API calls. `contextTokens` is the main thread's
 * occupancy at its last turn (what the `/context` panel shows); the billed
 * totals also fold in every subagent transcript, since each step delegates
 * its real work to a subagent. All-zero if the session's transcript doesn't
 * exist yet.
 */
export function readTokenUsage(workdir: string, sessionId: string): TokenUsage {
	// free-code sessions ARE .jsonl paths — read the transcript directly; there
	// is no per-workdir project folder and no subagent-transcript convention.
	const isFreeCodeSession = sessionId.endsWith(".jsonl") && path.isAbsolute(sessionId);
	const main = accumulateUsage(isFreeCodeSession ? sessionId : transcriptPath(workdir, sessionId));
	const subs = isFreeCodeSession ? [] : subagentFiles(workdir, sessionId);
	let { input, cacheCreation, cacheRead, output, turns } = main;
	for (const file of subs) {
		const sub = accumulateUsage(file);
		input += sub.input;
		cacheCreation += sub.cacheCreation;
		cacheRead += sub.cacheRead;
		output += sub.output;
		turns += sub.turns;
	}
	return {
		contextTokens: main.lastContext,
		contextWindow: CONTEXT_WINDOW_TOKENS,
		inputTokens: input,
		cacheCreationTokens: cacheCreation,
		cacheReadTokens: cacheRead,
		outputTokens: output,
		totalInputTokens: input + cacheCreation + cacheRead,
		turns,
		includesSubagents: subs.length > 0,
	};
}
