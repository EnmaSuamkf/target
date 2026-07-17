/**
 * Reads the on-disk transcript Claude Code writes for a session — the same
 * file `claude --resume <sessionId>` reads from — so the hub can show the
 * actual conversation happening inside a workflow's steps, not just the
 * final result of each job. This is read-only and best-effort: if the file
 * or a line is unreadable, that just means fewer entries, never an error.
 *
 * Project folder naming matches Claude Code's own convention: the absolute
 * workdir with every character that isn't a-z/A-Z/0-9/- replaced by '-'
 * (verified against real sessions: "/home/lenovo/.target/sandboxes/x" →
 * "-home-lenovo--target-sandboxes-x", the doubled dash coming from "/.").
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TranscriptEntry =
	| { kind: "prompt"; text: string; timestamp?: string }
	| { kind: "thinking"; timestamp?: string }
	| { kind: "text"; text: string; timestamp?: string }
	| { kind: "tool_use"; name: string; summary: string; timestamp?: string }
	| { kind: "tool_result"; summary: string; timestamp?: string };

function claudeProjectDir(workdir: string): string {
	const slug = workdir.replace(/[^a-zA-Z0-9-]/g, "-");
	return path.join(os.homedir(), ".claude", "projects", slug);
}

export function transcriptPath(workdir: string, sessionId: string): string {
	return path.join(claudeProjectDir(workdir), `${sessionId}.jsonl`);
}

function truncate(text: string, max = 600): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function summarizeToolInput(name: string, input: unknown): string {
	if (input == null || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	// The Task/Agent tool is the one steps are asked to delegate through — its
	// `description`/`prompt` are the useful bits, everything else is noise.
	if (name === "Agent" || name === "Task") {
		const description = typeof obj.description === "string" ? obj.description : "";
		const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
		return [description, prompt].filter(Boolean).map((s) => truncate(s, 300)).join(" — ");
	}
	return truncate(JSON.stringify(obj), 300);
}

function summarizeToolResultContent(content: unknown): string {
	if (typeof content === "string") return truncate(content);
	if (Array.isArray(content)) {
		return truncate(
			content
				.map((block) => (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string" ? String((block as Record<string, unknown>).text) : ""))
				.filter(Boolean)
				.join("\n"),
		);
	}
	return "";
}

/** Parses one already-JSON.parsed transcript line into zero or more display entries. */
function parseLine(raw: Record<string, unknown>): TranscriptEntry[] {
	const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : undefined;
	const message = raw.message as Record<string, unknown> | undefined;
	if (!message) return []; // queue-operation, attachment, ai-title, last-prompt, mode — not conversation turns

	const role = message.role;
	const content = message.content;

	if (role === "user") {
		if (typeof content === "string") return [{ kind: "prompt", text: truncate(content, 800), timestamp }];
		if (Array.isArray(content)) {
			return content
				.filter((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result")
				.map((block) => ({
					kind: "tool_result" as const,
					summary: summarizeToolResultContent((block as Record<string, unknown>).content),
					timestamp,
				}));
		}
		return [];
	}

	if (role === "assistant" && Array.isArray(content)) {
		const entries: TranscriptEntry[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type === "thinking") entries.push({ kind: "thinking", timestamp });
			else if (b.type === "text" && typeof b.text === "string") entries.push({ kind: "text", text: truncate(b.text), timestamp });
			else if (b.type === "tool_use" && typeof b.name === "string") {
				entries.push({ kind: "tool_use", name: b.name, summary: summarizeToolInput(b.name, b.input), timestamp });
			}
		}
		return entries;
	}

	return [];
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
			const message = obj.message as Record<string, unknown> | undefined;
			const usage = message?.usage as Record<string, number> | undefined;
			if (!usage) continue;
			// Claude Code can write the same assistant message more than once (e.g. a
			// streamed then finalized copy); key on the message id so its tokens are
			// counted once.
			const id = (typeof message?.id === "string" && message.id) || (typeof obj.requestId === "string" && obj.requestId) || line;
			if (seen.has(id)) continue;
			seen.add(id);
			const input = usage.input_tokens ?? 0;
			const cacheCreation = usage.cache_creation_input_tokens ?? 0;
			const cacheRead = usage.cache_read_input_tokens ?? 0;
			acc.input += input;
			acc.cacheCreation += cacheCreation;
			acc.cacheRead += cacheRead;
			acc.output += usage.output_tokens ?? 0;
			acc.turns += 1;
			acc.lastContext = input + cacheCreation + cacheRead;
		} catch {
			// Skip a malformed/partial line, same as readTranscript.
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
 * Code writes — the same files `readTranscript` parses, so no extra API calls.
 * `contextTokens` is the main thread's occupancy at its last turn (what the
 * `/context` panel shows); the billed totals also fold in every subagent
 * transcript, since each step delegates its real work to a subagent. All-zero
 * if the session's transcript doesn't exist yet.
 */
export function readTokenUsage(workdir: string, sessionId: string): TokenUsage {
	const main = accumulateUsage(transcriptPath(workdir, sessionId));
	const subs = subagentFiles(workdir, sessionId);
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

/** Reads the last `limit` conversation entries of a session; empty array if the transcript doesn't exist yet. */
export function readTranscript(workdir: string, sessionId: string, limit = 200): TranscriptEntry[] {
	const file = transcriptPath(workdir, sessionId);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries: TranscriptEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(...parseLine(JSON.parse(line)));
		} catch {
			// Skip a malformed line — a partially-written last line while the
			// process is still running is expected, not an error.
		}
	}
	return entries.slice(-limit);
}
