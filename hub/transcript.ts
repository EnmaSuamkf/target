/**
 * Reads what really happened in a session straight from the on-disk transcripts
 * the harness writes: token usage, the model the turns ran on, and any
 * compaction boundary. This is read-only and best-effort: if the file or a
 * line is unreadable, that just means a lower total, never an error.
 *
 * Three facts, one pass, because they all come off the same growing file:
 *
 * - **usage** — what the `/context` panel reports, plus the billed totals.
 * - **model** — because the context window is not a constant. It used to be
 *   hardcoded at 200k here; a real `claude-sonnet-5` session on this machine
 *   was measured at 370k context tokens in a single turn, so the window is
 *   looked up from the model instead (models.ts).
 * - **compaction** — the moment the harness threw the conversation's earlier
 *   history away and replaced it with a summary. A workflow reuses ONE
 *   conversation for all its steps, so that boundary is the point at which the
 *   agent stops remembering the steps before it, and the hub has to know.
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
import { contextWindowForModel } from "./models.ts";

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
 * One compaction boundary read out of a transcript: the moment the harness
 * replaced the conversation's earlier history with a summary.
 *
 * The two harnesses write completely different records for it, and only one of
 * them says anything about tokens, so everything except `at` is optional. `at`
 * is the whole signal — a boundary newer than the hub's last dispatch means the
 * history that dispatch relied on is gone.
 */
export interface CompactionBoundary {
	/** ISO timestamp the harness stamped on the boundary record. */
	at: string;
	/** Which harness's record this came from — worth surfacing, the two mean the same thing but look nothing alike. */
	format: "claude" | "free-code";
	/** claude's `compactMetadata.trigger` ("manual" | "auto"). free-code records none. */
	trigger: string | null;
	/** Context occupancy either side of the boundary, when the record carries it at all. Never required. */
	preTokens: number | null;
	postTokens: number | null;
}

export interface TokenUsage {
	/**
	 * Context occupancy at the main thread's last turn — input + cache creation +
	 * cache read of the latest assistant message. This is what the `/context`
	 * panel reports, and only the main session counts (subagents have their own).
	 */
	contextTokens: number;
	/**
	 * Derived from `model`, not assumed — see models.ts. Falls back to
	 * FALLBACK_CONTEXT_WINDOW_TOKENS when the transcript hasn't named a model
	 * yet (no assistant turn, no `model_change` record).
	 */
	contextWindow: number;
	/** Model id the last counted turn ran on, as written by the harness; null when the transcript never named one. */
	model: string | null;
	/** Timestamp of the most recent compaction boundary in the main transcript, or null if it was never compacted. */
	lastCompactionAt: string | null;
	/** How many compaction boundaries the main transcript carries. */
	compactions: number;
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
	/** Model id of the last turn / `model_change` record seen, for the window lookup. */
	lastModel: string | null;
	/** Latest compaction boundary in this file, and how many there were. */
	lastCompaction: CompactionBoundary | null;
	compactions: number;
}

/** Reads `key` off a record as a number, or null when it's absent or not a number. Every token field of every boundary record is optional. */
function optionalNumber(source: Record<string, unknown> | undefined, key: string): number | null {
	const value = source?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Claude Code's compaction record:
 * `{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":…,"preTokens":N,"postTokens":N,…},"timestamp":…}`
 * written into the SAME `.jsonl` under the SAME sessionId, which is why the
 * session id stays valid across a compaction and `--resume` keeps working.
 */
function claudeBoundary(obj: Record<string, unknown>): CompactionBoundary | null {
	if (obj.type !== "system" || obj.subtype !== "compact_boundary") return null;
	if (typeof obj.timestamp !== "string") return null;
	const meta = obj.compactMetadata as Record<string, unknown> | undefined;
	return {
		at: obj.timestamp,
		format: "claude",
		trigger: typeof meta?.trigger === "string" ? meta.trigger : null,
		preTokens: optionalNumber(meta, "preTokens"),
		postTokens: optionalNumber(meta, "postTokens"),
	};
}

/**
 * free-code's compaction record:
 * `{"type":"compaction","id":…,"parentId":…,"timestamp":…,"summary":"…"}`.
 *
 * It carries NO token metadata at all in the shape this has to support — only
 * a summary and the parentId chain — so the detection keys off the record's
 * presence and its timestamp, nothing else. (`tokensBefore` does show up on the
 * records this machine has; it's read opportunistically and is never required,
 * because a free-code build that omits it must still be detected.)
 */
function freeCodeBoundary(obj: Record<string, unknown>): CompactionBoundary | null {
	if (obj.type !== "compaction") return null;
	if (typeof obj.timestamp !== "string") return null;
	return {
		at: obj.timestamp,
		format: "free-code",
		trigger: null,
		preTokens: optionalNumber(obj, "tokensBefore"),
		postTokens: null,
	};
}

/**
 * One reader per transcript format, tried in turn. Exported so the format
 * contract can be pinned against REAL boundary records copied out of
 * `~/.claude/projects/` and `~/.agent-webhook-bridge/sessions/` rather than
 * against a shape we invented.
 */
export function compactionBoundaryOfLine(obj: Record<string, unknown>): CompactionBoundary | null {
	return claudeBoundary(obj) ?? freeCodeBoundary(obj);
}

/**
 * The model id a transcript line attributes its turn to, normalised across the
 * two harnesses. Claude Code stamps `message.model` on every assistant line;
 * free-code instead emits a standalone `{"type":"model_change",…,"modelId":…}`
 * record whenever the model changes, so the id has to be carried forward from
 * the last one seen. Null when the line says nothing about a model.
 */
function modelOfLine(obj: Record<string, unknown>): string | null {
	if (obj.type === "model_change" && typeof obj.modelId === "string" && obj.modelId !== "") return obj.modelId;
	const message = obj.message as Record<string, unknown> | undefined;
	const model = message?.model;
	// `<synthetic>` is Claude Code's marker for a turn it fabricated (an error
	// notice, say), not a model that ran — it would otherwise overwrite the real
	// model id with something no window can be looked up for.
	if (typeof model === "string" && model !== "" && model !== "<synthetic>") return model;
	return null;
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

/**
 * Sums the `usage` of every assistant message in one transcript file, deduped
 * by message id — and, in the SAME pass, picks up the two other things the file
 * is the only source of: the model the turns ran on (so the context window can
 * be derived instead of assumed) and any compaction boundary (so the hub can
 * tell that the conversation it has been resuming lost its history). All three
 * are per-line reads over a file that's already being streamed; splitting them
 * into separate passes would just read the same growing transcript three times.
 */
function accumulateUsage(file: string): RawUsage {
	const acc: RawUsage = {
		input: 0,
		cacheCreation: 0,
		cacheRead: 0,
		output: 0,
		turns: 0,
		lastContext: 0,
		lastModel: null,
		lastCompaction: null,
		compactions: 0,
	};
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
			const boundary = compactionBoundaryOfLine(obj);
			if (boundary) {
				acc.compactions += 1;
				// Last one wins: a long session can be compacted several times, and
				// what matters is whether the MOST RECENT one is newer than the last
				// dispatch. Transcripts are append-only, so file order is time order.
				acc.lastCompaction = boundary;
			}
			const model = modelOfLine(obj);
			if (model) acc.lastModel = model;
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
		// The window belongs to the MAIN thread's model: subagents can run on a
		// different one, and their transcripts are folded into the billed totals
		// only — `contextTokens` is the main thread's occupancy, so its denominator
		// has to be the main thread's window too.
		contextWindow: contextWindowForModel(main.lastModel),
		model: main.lastModel,
		lastCompactionAt: main.lastCompaction?.at ?? null,
		compactions: main.compactions,
		inputTokens: input,
		cacheCreationTokens: cacheCreation,
		cacheReadTokens: cacheRead,
		outputTokens: output,
		totalInputTokens: input + cacheCreation + cacheRead,
		turns,
		includesSubagents: subs.length > 0,
	};
}
