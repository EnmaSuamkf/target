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
 * Four harnesses, four layouts. Callers pass the workflow's harness
 * (`hookRuntime(...).harness`) to `readTokenUsage`, which then dispatches on it.
 * Shape-sniffing the session id is only the fallback for an unknown harness,
 * and it is unsafe on its own: Claude, Cursor and Copilot session ids are all
 * bare uuids, so nothing in the id says which tree to look in.
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
 * - **Cursor Agent** — `~/.cursor/projects/.../agent-transcripts/<chatId>/`
 *   JSONL for turns, but those lines carry no per-message usage. Each headless
 *   `agent -p` run instead writes a one-line JSON result (with `usage.inputTokens`,
 *   `cacheReadTokens`, …) into the awb run log under
 *   `~/.agent-webhook-bridge/logs/`; that is what the hub sums. That usage is
 *   CUMULATIVE over every API round of the run, so occupancy can only be
 *   estimated — from the run's round count in the agent-transcript (see
 *   `estimateCursorOccupancy`) — and is flagged as such (`contextEstimated`).
 *   Neither the result nor the transcript names the model on this machine, so
 *   it comes from the run's `--model` flag when there is one, else from
 *   Cursor's own tracking database (`cursorModelFromTracking`); the window is
 *   the size the run or the CLI config states for it, else `models.ts`.
 * - **GitHub Copilot CLI** — `~/.copilot/session-state/<id>/events.jsonl`
 *   (read from the tail only; see `readCopilotUsage`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { awbDir } from "./awb.ts";
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

/** Cursor agent-transcript JSONL for a chat id, when one exists on this machine. */
export function cursorTranscriptPath(sessionId: string): string | null {
	const projectsRoot = path.join(os.homedir(), ".cursor", "projects");
	let projects: fs.Dirent[];
	try {
		projects = fs.readdirSync(projectsRoot, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const dir = path.join(projectsRoot, project.name, "agent-transcripts", sessionId);
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".jsonl")) return path.join(dir, entry.name);
			}
			const nested = path.join(dir, sessionId);
			for (const entry of fs.readdirSync(nested, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".jsonl")) return path.join(nested, entry.name);
			}
		} catch {
			// No transcript for this project.
		}
	}
	return null;
}

/** `~/.cursor/chats/<projectHash>/<chatId>/` when that chat exists on disk. */
export function cursorChatDir(sessionId: string): string | null {
	const root = path.join(os.homedir(), ".cursor", "chats");
	let projectDirs: fs.Dirent[];
	try {
		projectDirs = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const project of projectDirs) {
		if (!project.isDirectory()) continue;
		const chatDir = path.join(root, project.name, sessionId);
		try {
			if (fs.statSync(chatDir).isDirectory()) return chatDir;
		} catch {
			// Not under this project hash.
		}
	}
	return null;
}

/**
 * One compaction boundary read out of a transcript: the moment the harness
 * replaced the conversation's earlier history with a summary.
 *
 * The three harnesses write completely different records for it, and only some
 * of them say anything about tokens, so everything except `at` is optional. `at`
 * is the whole signal — a boundary newer than the hub's last dispatch means the
 * history that dispatch relied on is gone.
 */
export interface CompactionBoundary {
	/** ISO timestamp the harness stamped on the boundary record. */
	at: string;
	/** Which harness's record this came from — worth surfacing, they mean the same thing but look nothing alike. */
	format: "claude" | "free-code" | "copilot";
	/**
	 * claude's `compactMetadata.trigger` ("manual" | "auto"); Copilot's
	 * `session.compaction_complete.data.trigger` ("manual" | "threshold", the same
	 * value its `compaction_start` carries). free-code records none.
	 */
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
	 * True when `contextTokens` is an estimate rather than a reading the harness
	 * wrote down. Only Cursor sets it: its headless runs report usage summed over
	 * every API round, never the occupancy of the last one (see
	 * `estimateCursorOccupancy`). The UI says so instead of presenting the number
	 * as exact, because it can and does differ from Cursor's own `/context` bar.
	 */
	contextEstimated: boolean;
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
	/**
	 * Session cost in USD as the RUNNER itself recorded it, summed over the same
	 * turns as the token buckets — or null when the runner records none. Never
	 * derived from token counts here: pricing is the report server's job. See
	 * `costOfTurns`.
	 */
	costUsd: number | null;
}

interface RawUsage {
	input: number;
	cacheCreation: number;
	cacheRead: number;
	output: number;
	turns: number;
	/** Occupancy (input+cache) at the last turn seen in this file. */
	lastContext: number;
	/**
	 * The last few occupancy readings, oldest first, so the caller can fall back
	 * to an earlier one when the newest is impossible against the model's window
	 * (which is only known once the whole file has been read). Kept short: this
	 * is a "what did the previous turn say" buffer, not a history.
	 */
	recentContexts: number[];
	/** Cursor-only: every headless `agent -p` result for the session, oldest first (for the occupancy estimate). */
	cursorRuns: CursorRunUsage[];
	/** Cursor-only: a window the run itself declared (`--model 'x[context=1m]'`), or null. See `contextWindowForModel`'s `stated`. */
	statedContextWindow: number | null;
	/** Harness whose model table the window lookup should prefer (`"copilot"`: its ids overlap other harnesses'). */
	windowHarness: string | null;
	/** Model id of the last turn / `model_change` record seen, for the window lookup. */
	lastModel: string | null;
	/** Latest compaction boundary in this file, and how many there were. */
	lastCompaction: CompactionBoundary | null;
	compactions: number;
	/** Runner-recorded cost of this file's turns (see `costOfTurns`); null when not authoritative. */
	costUsd: number | null;
}

function emptyRawUsage(): RawUsage {
	return {
		input: 0,
		cacheCreation: 0,
		cacheRead: 0,
		output: 0,
		turns: 0,
		lastContext: 0,
		recentContexts: [],
		cursorRuns: [],
		statedContextWindow: null,
		windowHarness: null,
		lastModel: null,
		lastCompaction: null,
		compactions: 0,
		costUsd: null,
	};
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
 * Copilot CLI's compaction record, written into the session's `events.jsonl`:
 * `{"type":"session.compaction_complete","data":{"success":true,"preCompactionTokens":N,
 * "postCompactionTokens":N,"trigger":"manual"|"threshold",…},"timestamp":…}`.
 * A boundary ONLY when `data.success === true`: a failed compaction (seen for
 * automatic ones) threw nothing away. The token figures count the conversation
 * only, not the system prompt or tool definitions. `session.compaction_start`
 * is not a boundary — the work may still fail.
 */
function copilotBoundary(obj: Record<string, unknown>): CompactionBoundary | null {
	if (obj.type !== "session.compaction_complete") return null;
	if (typeof obj.timestamp !== "string") return null;
	const data = obj.data as Record<string, unknown> | undefined;
	if (!data || data.success !== true) return null;
	return {
		at: obj.timestamp,
		format: "copilot",
		trigger: typeof data.trigger === "string" ? data.trigger : null,
		preTokens: optionalNumber(data, "preCompactionTokens"),
		postTokens: optionalNumber(data, "postCompactionTokens"),
	};
}

/**
 * One reader per transcript format, tried in turn. Exported so the format
 * contract can be pinned against REAL boundary records copied out of
 * `~/.claude/projects/`, `~/.agent-webhook-bridge/sessions/` and
 * `~/.copilot/session-state/` rather than
 * against a shape we invented.
 */
export function compactionBoundaryOfLine(obj: Record<string, unknown>): CompactionBoundary | null {
	return claudeBoundary(obj) ?? freeCodeBoundary(obj) ?? copilotBoundary(obj);
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
function usageOfLine(obj: Record<string, unknown>): { id: string | null; input: number; cacheCreation: number; cacheRead: number; output: number; cost: number | null } | null {
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
		cost: isFreeCodeShape ? freeCodeTurnCost(usage) : null,
	};
}

/**
 * free-code stamps the cost it computed for each assistant turn on the turn's
 * usage block (`usage.cost.total`, USD). Null when the turn has none. Claude
 * Code transcripts carry no per-turn cost (its `cost-state` records are per
 * process, so they reset on every resume — not a session figure).
 */
function freeCodeTurnCost(usage: Record<string, unknown>): number | null {
	const total = (usage.cost as Record<string, unknown> | undefined)?.total;
	return typeof total === "number" && Number.isFinite(total) ? total : null;
}

/**
 * Sums the runner-recorded cost of the turns just read, deduped like the token
 * buckets. Authoritative only when EVERY turn that spent tokens carries a
 * positive cost: free-code reports `cost.total: 0` for a model it has no price
 * for (kimi-k3, glm-5p2 here), and a 0 on a session that used millions of tokens
 * is not "free", it is unknown — so that session stays null and the server
 * prices it by (agent, model). A turn that spent nothing (an aborted turn) may
 * cost 0.
 */
function costOfTurns(turns: Iterable<{ input: number; cacheCreation: number; cacheRead: number; output: number; cost: number | null }>): number | null {
	let total = 0;
	let any = false;
	for (const turn of turns) {
		const spent = turn.input + turn.cacheCreation + turn.cacheRead + turn.output > 0;
		if (turn.cost === null) {
			if (spent) return null;
			continue;
		}
		if (spent && turn.cost <= 0) return null;
		total += turn.cost;
		any = any || spent;
	}
	return any ? total : null;
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
	const acc = emptyRawUsage();
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return acc;
	}
	/** Per-message billed totals; replaced when a later line carries the same id. */
	const seen = new Map<string, { input: number; cacheCreation: number; cacheRead: number; output: number; cost: number | null }>();
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
			// Claude Code can write the same assistant message more than once (a
			// streamed then finalized copy). The first copy can carry cumulative
			// totals that make `lastContext` look like `totalInputTokens` until the
			// finalized line lands — so the LAST copy wins, same as compaction above.
			const id = rec.id ?? line;
			const prev = seen.get(id);
			if (prev) {
				acc.input -= prev.input;
				acc.cacheCreation -= prev.cacheCreation;
				acc.cacheRead -= prev.cacheRead;
				acc.output -= prev.output;
			} else {
				acc.turns += 1;
			}
			const billed = { input: rec.input, cacheCreation: rec.cacheCreation, cacheRead: rec.cacheRead, output: rec.output, cost: rec.cost };
			seen.set(id, billed);
			acc.input += billed.input;
			acc.cacheCreation += billed.cacheCreation;
			acc.cacheRead += billed.cacheRead;
			acc.output += billed.output;
			// Occupancy comes ONLY from a turn that actually sent a prompt.
			//
			// Both harnesses write turns that carry a `usage` block of all zeros for a
			// turn that never reached the model: Claude Code's `<synthetic>` error
			// notices, and free-code's aborted turns (`"stopReason":"aborted"`, empty
			// content — one such line was appended to a real judged session here on
			// 2026-08-19, right after a questionnaire was cancelled). Those bill
			// nothing, so they belong in the totals above, but they say NOTHING about
			// how full the window is. Letting one set `lastContext` made the meter
			// read `0 / 200k · 0.0%` on a conversation that was 43% full, until the
			// next real turn landed and it jumped back — the "context does something
			// odd and then corrects itself" this guard exists to stop.
			const occupancy = billed.input + billed.cacheCreation + billed.cacheRead;
			if (occupancy > 0) {
				acc.lastContext = occupancy;
				acc.recentContexts.push(occupancy);
				if (acc.recentContexts.length > 8) acc.recentContexts.shift();
			}
		} catch {
			// Skip a malformed/partial line — a partially-written last line while
			// the process is still running is expected, not an error.
		}
	}
	acc.costUsd = costOfTurns(seen.values());
	return acc;
}

/** Normalises a Cursor model label from JSON (`Composer 2.5 Fast`) to a lookup id. */
function normalizeCursorModelId(model: string): string {
	return model
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-");
}

/**
 * Reads the model Cursor stamped on assistant turns in the agent-transcript
 * JSONL (`providerOptions.cursor.modelName`), since headless `agent -p` result
 * JSON often omits it.
 */
export function cursorModelFromTranscript(sessionId: string): string | null {
	const file = cursorTranscriptPath(sessionId);
	if (!file) return null;
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	let last: string | null = null;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as Record<string, unknown>;
			const message = obj.message as Record<string, unknown> | undefined;
			const content = message?.content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const provider = (part as Record<string, unknown>).providerOptions as Record<string, unknown> | undefined;
				const cursor = provider?.cursor as Record<string, unknown> | undefined;
				const modelName = cursor?.modelName;
				if (typeof modelName === "string" && modelName !== "") last = normalizeCursorModelId(modelName);
			}
		} catch {
			// Skip malformed lines.
		}
	}
	return last;
}

/** One headless `agent -p` result: the run's usage SUMMED over all its API rounds, plus the text it answered with. */
export interface CursorRunUsage {
	input: number;
	cacheCreation: number;
	cacheRead: number;
	output: number;
	/** The result's `result` text — how the run is found again in the agent-transcript. */
	resultText: string;
}

/** One user prompt and the assistant turns that answered it, as the Cursor agent-transcript records them. */
export interface CursorTranscriptRun {
	/** API rounds this run made — see `cursorTranscriptRuns` for how it is counted. */
	rounds: number;
	/** The run's last non-empty text block, for matching it against a result. */
	lastText: string;
}

/**
 * Cursor redacts its reasoning in the transcript as a literal `[REDACTED]`,
 * sometimes inside a text block, and the result text never carries it; the two
 * only compare equal once that marker is gone and whitespace is collapsed.
 */
function normalizeCursorText(text: string): string {
	return text.replaceAll("[REDACTED]", " ").replace(/\s+/g, " ").trim();
}

/**
 * Splits a Cursor agent-transcript into runs (one per `user` line) and counts
 * each run's API rounds.
 *
 * A round is an `assistant` line — tool calls the model makes in parallel share
 * one line — plus one when the run's LAST line still calls tools, because the
 * tool results had to be sent back for the final answer, whose round left no
 * text of its own. This is a floor, not an exact count: Cursor can fold
 * sequential tool-only rounds into one line. Measured over 867 real runs on
 * this machine, it is still the count that keeps a session's per-run readings
 * most consistent (5% of consecutive readings drop by >15%, against 24% when
 * every tool call is counted as its own round).
 */
export function cursorTranscriptRuns(file: string): CursorTranscriptRun[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const runs: (CursorTranscriptRun & { lastHasTool: boolean })[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as Record<string, unknown>;
			if (obj.role === "user") {
				runs.push({ rounds: 0, lastText: "", lastHasTool: false });
				continue;
			}
			const run = runs[runs.length - 1];
			if (obj.role !== "assistant" || !run) continue;
			run.rounds += 1;
			const content = (obj.message as Record<string, unknown> | undefined)?.content;
			let tools = 0;
			for (const part of Array.isArray(content) ? content : []) {
				const p = part as Record<string, unknown>;
				if (p.type === "tool_use") tools += 1;
				if (p.type === "text" && typeof p.text === "string" && normalizeCursorText(p.text)) run.lastText = p.text;
			}
			run.lastHasTool = tools > 0;
		} catch {
			// Malformed/partial line — skip.
		}
	}
	return runs.map(({ rounds, lastText, lastHasTool }) => ({ rounds: rounds + (lastHasTool ? 1 : 0), lastText }));
}

/**
 * Pairs each result with its run in the transcript, in order: a result matches
 * the first not-yet-used run whose last text block its own text ends with.
 * The transcript also holds runs the awb logs don't (the operator's own CLI
 * prompts, `/context` checks), which is why this matches on content and not on
 * position. Unmatched results get null.
 */
function matchCursorRuns(runs: CursorRunUsage[], transcript: CursorTranscriptRun[]): (number | null)[] {
	let next = 0;
	return runs.map((run) => {
		const result = normalizeCursorText(run.resultText);
		if (!result) return null;
		for (let i = next; i < transcript.length; i++) {
			const last = normalizeCursorText(transcript[i]?.lastText ?? "");
			if (last && result.endsWith(last.slice(-300))) {
				next = i + 1;
				return transcript[i]?.rounds ?? null;
			}
		}
		return null;
	});
}

/**
 * Estimated context occupancy at the end of a Cursor session's latest run.
 *
 * Cursor's headless JSON result is the only usage it writes, and it is the SUM
 * over every API round of the run: a run that made 20 rounds reports roughly 20
 * times its context in `cacheReadTokens`. Publishing that as occupancy (or
 * clamping it to the window, which is what this used to do) is what made the
 * meter fill up while a step was being judged — during a judge pass the latest
 * finished run is the long, tool-heavy exec run, and its billed total read as
 * 100% until the short judge run replaced it. Measured over 390 judge passes:
 * 46% showed >=95% during the judge, with a mean swing of 31 points.
 *
 * With `S` the run's summed input and `n` its rounds (`cursorTranscriptRuns`):
 *
 * - `n = 1` → `S` is the round's occupancy, exactly;
 * - otherwise the context grew from `C_first` to `C_last` across the rounds,
 *   so `S/n` (the mean) is a floor on `C_last`, and assuming linear growth
 *   `C_last = 2·S/n − C_first`, with `C_first` at least the previous reading
 *   (0 for a session's first run: a fresh conversation starts nearly empty,
 *   and anchoring it on its own mean instead read a real 55k run as 38k).
 *   That extrapolation overshoots when growth isn't linear, the mean
 *   undershoots, so the estimate is their midpoint. On the one run here with a
 *   reading from Cursor's own `/context` bar (79.8k), it says 69k; the mean
 *   alone said 51k, the old formula 80k only because it was fitted to that run.
 *
 * When a run can't be estimated — no transcript, no matching run, or an
 * estimate the window couldn't hold — the previous reading stands. The very
 * first run of a session is usually the single-round context step, so with no
 * reading yet its `S` is taken when it fits the window. Nothing here is ever
 * clamped to the window: a clamp is exactly the "100% full" that isn't true.
 */
export function estimateCursorOccupancy(
	runs: CursorRunUsage[],
	transcript: CursorTranscriptRun[] | null,
	contextWindow: number,
): number {
	const rounds = transcript ? matchCursorRuns(runs, transcript) : runs.map(() => null);
	const fits = (value: number): boolean => contextWindow <= 0 || value <= contextWindow;
	let reading: number | null = null;
	runs.forEach((run, i) => {
		const summed = run.input + run.cacheCreation + run.cacheRead;
		const n = rounds[i] ?? null;
		let estimate: number | null = null;
		if (n === 1 || (n === null && reading === null)) {
			estimate = summed;
		} else if (n !== null) {
			const mean = summed / n;
			const linear = Math.min(summed, Math.max(mean, 2 * mean - (reading ?? 0)));
			estimate = (mean + linear) / 2;
		}
		if (estimate !== null && estimate > 0 && fits(estimate)) reading = estimate;
	});
	return Math.round(reading ?? 0);
}

/**
 * `"1m"` / `"272k"` / `"200000"` → tokens, as Cursor writes a context size in
 * its CLI config and in `--model 'x[context=1m]'`; null for anything else.
 */
export function parseCursorContextSize(value: string): number | null {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(value);
	if (!match) return null;
	const n = Number(match[1]) * ({ k: 1_000, m: 1_000_000 }[match[2]!.toLowerCase() as "k" | "m"] ?? 1);
	return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * The model a logged `agent -p` command line asked for, and the window it
 * declared with it, if any.
 *
 * awb writes the spawned command as the log's `$ …` line, the prompt as a JSON
 * string. The prompt is skipped before looking for `--model`, because prompts
 * routinely QUOTE command lines (this machine's logs have hundreds of
 * `--model claude-3-5-haiku…` inside prompts that were never a flag). Cursor's
 * parameterised form `--model 'claude-opus-4-8[context=1m,effort=high]'`
 * yields the bare id plus the stated window.
 *
 * awb's Cursor adapter doesn't pass `--model` today, so for awb's own runs
 * this finds nothing and the model comes from Cursor's tracking database
 * instead (`cursorModelFromTracking`); it is read first because a flag on the
 * run's own command line is the most direct record there can be.
 */
export function cursorModelFromCommandLine(commandLine: string): { model: string; statedWindow: number | null } | null {
	let rest = commandLine;
	const promptAt = commandLine.indexOf(' -p "');
	if (promptAt >= 0) {
		let i = promptAt + 5;
		for (; i < commandLine.length; i++) {
			if (commandLine[i] === "\\") i++;
			else if (commandLine[i] === '"') break;
		}
		rest = commandLine.slice(i + 1);
	}
	const flag = /(?:^|\s)--model(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(rest);
	const raw = flag ? (flag[1] ?? flag[2] ?? flag[3] ?? "").trim() : "";
	if (!raw) return null;
	const bracket = raw.indexOf("[");
	const model = normalizeCursorModelId(bracket >= 0 ? raw.slice(0, bracket) : raw);
	let statedWindow: number | null = null;
	if (bracket >= 0) {
		const close = raw.lastIndexOf("]");
		for (const param of raw.slice(bracket + 1, close > bracket ? close : undefined).split(",")) {
			const [key, value] = param.split("=").map((part) => part.trim());
			if (key?.toLowerCase() === "context" && value) statedWindow = parseCursorContextSize(value);
		}
	}
	return model ? { model, statedWindow } : null;
}

/**
 * The `$ …` command line at the top of an awb run log (after any MCP warm-up
 * block), or null when it isn't within the first `maxBytes` — a prompt can be
 * long, and a line cut short could hide the flags that follow it.
 */
function loggedCommandLine(file: string, maxBytes = 1024 * 1024): string | null {
	let head: string;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(Math.min(maxBytes, fs.fstatSync(fd).size));
			fs.readSync(fd, buf, 0, buf.length, 0);
			head = buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
	for (const line of head.split("\n")) {
		if (line.startsWith("$ ") && line.includes(" -p ")) return line;
	}
	return null;
}

/** Cached by stat so the hub's polling doesn't re-query on every call — the database only changes when Cursor writes code. */
let trackingCache: { key: string; sessions: Map<string, string | null> } | null = null;

/**
 * The model Cursor itself recorded for a conversation, from its own AI code
 * tracking database (`~/.cursor/ai-tracking/ai-code-tracking.db`, table
 * `ai_code_hashes`: `conversationId`, `model`, `timestamp` per change the
 * agent made). It is the only per-session record of the model Cursor keeps on
 * this machine: the headless result JSON and the agent-transcripts never name
 * it, and awb doesn't pass `--model`, so a run uses whatever the CLI had
 * selected at the time — which `cli-config.json` only knows for NOW. Verified
 * 2026-10-01: session a8abe85e → composer-2.5, dd9f5248 → grok-4.6, both
 * matching what those workflows ran on.
 *
 * Only runs that changed files leave a row, so a session that never wrote
 * anything has no record here (null); the latest row wins when the model was
 * switched mid-conversation.
 */
export function cursorModelFromTracking(sessionId: string): string | null {
	const db = path.join(os.homedir(), ".cursor", "ai-tracking", "ai-code-tracking.db");
	let key: string;
	try {
		// The WAL is where fresh rows land first, so it is part of the key.
		const main = fs.statSync(db);
		let wal = "";
		try {
			wal = String(fs.statSync(`${db}-wal`).mtimeMs);
		} catch {
			// No WAL file: everything is in the main database.
		}
		key = `${main.mtimeMs}:${main.size}:${wal}`;
	} catch {
		return null;
	}
	if (!trackingCache || trackingCache.key !== key) trackingCache = { key, sessions: new Map() };
	const cached = trackingCache.sessions.get(sessionId);
	if (cached !== undefined) return cached;
	let model: string | null = null;
	try {
		const conn = new DatabaseSync(db, { readOnly: true });
		try {
			const row = conn
				.prepare(
					"SELECT model FROM ai_code_hashes WHERE conversationId = ? AND model IS NOT NULL AND model != '' ORDER BY timestamp DESC LIMIT 1",
				)
				.get(sessionId) as { model?: unknown } | undefined;
			if (typeof row?.model === "string") model = normalizeCursorModelId(row.model);
		} finally {
			conn.close();
		}
	} catch {
		// Missing table, locked or foreign database — no record, not an error.
	}
	trackingCache.sessions.set(sessionId, model);
	return model;
}

/**
 * The context size the Cursor CLI is configured to run `model` at, from
 * `~/.cursor/cli-config.json` → `modelParameters[model]` → `{id:"context"}`
 * (e.g. `gpt-5.6-terra: context=272k` here). Several Cursor models are
 * offered at more than one size, so this is what tells a 272k run from a 1M
 * one; null when the CLI sets no size for that model.
 */
let cliConfigCache: { key: string; parsed: Record<string, unknown> | null } | null = null;

function cursorCliConfig(): Record<string, unknown> | null {
	const file = path.join(os.homedir(), ".cursor", "cli-config.json");
	let key: string;
	try {
		const st = fs.statSync(file);
		key = `${st.mtimeMs}:${st.size}:${st.ino}`;
	} catch {
		return null;
	}
	if (!cliConfigCache || cliConfigCache.key !== key) {
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			// Half-written or not JSON — no configured size this time.
		}
		cliConfigCache = { key, parsed };
	}
	return cliConfigCache.parsed;
}

/**
 * The model a flag-less `agent -p` runs on: `~/.cursor/cli-config.json` →
 * `model.modelId`. Last resort for a session nothing else names (awb passes no
 * `--model`, and the tracking database only has rows for sessions that edited
 * files). It is the CLI's setting NOW, not a per-session record, so it is only
 * consulted after every per-session source came up empty.
 */
export function cursorDefaultModel(): string | null {
	const model = (cursorCliConfig()?.model as Record<string, unknown> | undefined)?.modelId;
	return typeof model === "string" && model !== "" ? normalizeCursorModelId(model) : null;
}

export function cursorConfiguredContext(model: string): number | null {
	const params = (cursorCliConfig()?.modelParameters as Record<string, unknown> | undefined)?.[model];
	if (!Array.isArray(params)) return null;
	for (const param of params) {
		const p = param as Record<string, unknown>;
		if (p.id === "context" && typeof p.value === "string") return parseCursorContextSize(p.value);
	}
	return null;
}

/** Normalises Cursor Agent's JSON `usage` block from a headless run result. */
function cursorUsageOfResult(obj: Record<string, unknown>): {
	input: number;
	cacheCreation: number;
	cacheRead: number;
	output: number;
	model: string | null;
} | null {
	if (obj.type !== "result") return null;
	const usage = obj.usage as Record<string, number> | undefined;
	if (!usage || usage.inputTokens === undefined) return null;
	let model: string | null = null;
	if (typeof obj.model === "string" && obj.model !== "") model = normalizeCursorModelId(obj.model);
	const modelUsage = obj.modelUsage as Record<string, Record<string, unknown>> | undefined;
	if (modelUsage) {
		const ids = Object.keys(modelUsage);
		if (ids.length > 0) model = ids[ids.length - 1] ?? model;
	}
	return {
		input: usage.inputTokens ?? 0,
		cacheCreation: usage.cacheWriteTokens ?? 0,
		cacheRead: usage.cacheReadTokens ?? 0,
		output: usage.outputTokens ?? 0,
		model,
	};
}

/**
 * Sums usage from every awb run log whose JSON result names `sessionId`. Cursor
 * headless runs write one result object per step at the tail of the log; only
 * the end of each file is read so a large logs directory stays fast.
 */
function accumulateCursorUsageFromLogs(sessionId: string): RawUsage {
	const acc = emptyRawUsage();
	const logDir = path.join(awbDir(), "logs");
	let files: string[];
	try {
		files = fs
			.readdirSync(logDir)
			.filter((name) => name.endsWith(".log"))
			.map((name) => path.join(logDir, name));
	} catch {
		return acc;
	}
	files.sort((a, b) => {
		try {
			return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
		} catch {
			return 0;
		}
	});
	const tailBytes = 128 * 1024;
	for (const file of files) {
		let raw: string;
		try {
			const stat = fs.statSync(file);
			if (stat.size === 0) continue;
			const start = Math.max(0, stat.size - tailBytes);
			const length = stat.size - start;
			const fd = fs.openSync(file, "r");
			try {
				const buf = Buffer.alloc(length);
				fs.readSync(fd, buf, 0, length, start);
				raw = buf.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			continue;
		}
		if (!raw.includes(sessionId) || !raw.includes('"type":"result"')) continue;
		// The flags this run was spawned with — read once per log that holds a
		// result for this session, and only consulted when the result itself
		// doesn't name a model.
		let commandModel: ReturnType<typeof cursorModelFromCommandLine> | undefined;
		for (const line of raw.split("\n")) {
			if (!line.includes('"type":"result"') || !line.includes(sessionId)) continue;
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				if (obj.session_id !== sessionId) continue;
				const rec = cursorUsageOfResult(obj);
				if (!rec) continue;
				acc.input += rec.input;
				acc.cacheCreation += rec.cacheCreation;
				acc.cacheRead += rec.cacheRead;
				acc.output += rec.output;
				acc.turns += 1;
				acc.cursorRuns.push({
					input: rec.input,
					cacheCreation: rec.cacheCreation,
					cacheRead: rec.cacheRead,
					output: rec.output,
					resultText: typeof obj.result === "string" ? obj.result : "",
				});
				if (rec.model) {
					acc.lastModel = normalizeCursorModelId(rec.model);
					acc.statedContextWindow = null;
				} else {
					if (commandModel === undefined) {
						const commandLine = loggedCommandLine(file);
						commandModel = commandLine ? cursorModelFromCommandLine(commandLine) : null;
					}
					if (commandModel) {
						acc.lastModel = commandModel.model;
						acc.statedContextWindow = commandModel.statedWindow;
					}
				}
			} catch {
				// Malformed/partial line in a growing log — skip.
			}
		}
	}
	return acc;
}

/**
 * The newest occupancy reading that a window that size could actually hold.
 *
 * A turn cannot occupy more of the window than the window has: a reading above
 * it is not occupancy at all, it's a billing total or a half-written line that
 * the harness has not finalised yet. The hub polls a transcript WHILE the agent
 * writes it — most visibly during a judge pass, which appends turns to a
 * conversation the operator is watching — so one such line would otherwise be
 * published as "the session is full", and the meter (whose fill is clamped at
 * 100%) would paint a completely full bar until the next turn corrected it.
 *
 * Falling back to the previous reading is deliberate: occupancy moves by a turn
 * at a time, so the last plausible one is a far better answer than a number that
 * is impossible on its face. When nothing in the buffer fits — a genuinely
 * unmeasurable file — the window itself is the honest ceiling.
 */
function plausibleOccupancy(recent: number[], last: number, contextWindow: number): number {
	if (contextWindow <= 0 || last <= contextWindow) return last;
	for (let i = recent.length - 1; i >= 0; i--) {
		const value = recent[i] ?? 0;
		if (value <= contextWindow) return value;
	}
	return contextWindow;
}

/**
 * `cursor` is set for a Cursor session — carrying its agent-transcript runs, or
 * null when there is no transcript on this machine — and switches occupancy to
 * the estimate; Claude Code and free-code pass null and read it off the turns.
 */
function tokenUsageFromRaw(
	main: RawUsage,
	subs: RawUsage[],
	cursor: { transcript: CursorTranscriptRun[] | null } | null,
): TokenUsage {
	let { input, cacheCreation, cacheRead, output, turns } = main;
	for (const sub of subs) {
		input += sub.input;
		cacheCreation += sub.cacheCreation;
		cacheRead += sub.cacheRead;
		output += sub.output;
		turns += sub.turns;
	}
	const contextWindow = contextWindowForModel(main.lastModel, main.statedContextWindow, main.windowHarness);
	const contextTokens = cursor
		? estimateCursorOccupancy(main.cursorRuns, cursor.transcript, contextWindow)
		: plausibleOccupancy(main.recentContexts, main.lastContext, contextWindow);
	return {
		contextTokens,
		contextEstimated: cursor !== null,
		contextWindow,
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
		// Subagent transcripts are only folded into the token totals; their cost is
		// not read, so a figure that left them out would under-report.
		costUsd: subs.length > 0 ? null : main.costUsd,
	};
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
/**
 * True when `readTokenUsage` can resolve a transcript for this session id.
 * `harness` is the runner the workflow's hook reports (`hookRuntime(...).harness`);
 * null/unknown falls back to sniffing the id's shape.
 */
export function canReadTokenUsage(workdir: string | null, sessionId: string, harness?: string | null): boolean {
	if (!sessionId) return false;
	switch (harness) {
		case "free-code":
			return true;
		case "copilot":
			// Looked up by session id under the Copilot state dir; no workdir slug.
			return true;
		case "claude":
		case "cursor":
			return Boolean(workdir);
	}
	// free-code sessions ARE absolute .jsonl paths — no workdir slug applies.
	if (sessionId.endsWith(".jsonl") && path.isAbsolute(sessionId)) return true;
	return Boolean(workdir);
}

/** The all-zero usage: what a session with no readable transcript reports. */
function emptyTokenUsage(): TokenUsage {
	return tokenUsageFromRaw(emptyRawUsage(), [], null);
}

/** free-code: the session id IS the `.jsonl` path; no project folder, no subagent convention. */
function readFreeCodeUsage(sessionId: string): TokenUsage {
	const raw = accumulateUsage(sessionId);
	raw.windowHarness = "free-code";
	return tokenUsageFromRaw(raw, [], null);
}

/**
 * Base directory the Copilot CLI keeps its state in: `COPILOT_HOME` when set
 * (the CLI honours it too), else `~/.copilot`. One function so tests can point
 * every Copilot reader at a temp dir.
 */
export function copilotHome(): string {
	return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

/** `<copilot home>/session-state/<sessionId>/events.jsonl` when it is a regular file; null otherwise (ids with path separators never resolve). */
export function copilotEventsPath(sessionId: string): string | null {
	if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) return null;
	const file = path.join(copilotHome(), "session-state", sessionId, "events.jsonl");
	try {
		return fs.statSync(file).isFile() ? file : null;
	} catch {
		return null;
	}
}

/** What the tail of a Copilot `events.jsonl` says about a session. */
interface CopilotTailReading {
	model: string | null;
	/** `data` of the LAST `session.shutdown`, or null while the session has none yet. */
	shutdown: Record<string, unknown> | null;
}

const COPILOT_TAIL_START_BYTES = 1024 * 1024;
/** A session that never wrote a shutdown stops growing the read here rather than re-reading a huge file. */
const COPILOT_TAIL_MAX_BYTES = 64 * 1024 * 1024;
const COPILOT_CACHE_MAX_ENTRIES = 32;
const copilotReadingCache = new Map<string, { mtimeMs: number; size: number; reading: CopilotTailReading }>();

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

/** Reads the last `bytes` bytes of `file` (all of it when shorter) and whether that reaches the file start. */
function readFileTail(file: string, size: number, bytes: number): { text: string; atStart: boolean } {
	const start = Math.max(0, size - bytes);
	const length = size - start;
	const buf = Buffer.alloc(length);
	const fd = fs.openSync(file, "r");
	try {
		let read = 0;
		while (read < length) {
			const n = fs.readSync(fd, buf, read, length - read, start + read);
			if (n <= 0) break;
			read += n;
		}
		return { text: buf.toString("utf8", 0, read), atStart: start === 0 };
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Scans the tail of a Copilot events file for the last shutdown and the model.
 * Lines are classified by their leading `"type"` (always the first key) before
 * any JSON.parse: the file is dominated by encrypted reasoning blobs and
 * snapshots, and only a handful of lines are worth parsing.
 *
 * The read starts at 1 MiB and doubles until a shutdown is found (it carries
 * the cumulative totals) or the file start is reached. Without a shutdown (a
 * running or crashed session) it also keeps growing until a model is found.
 */
function scanCopilotEvents(file: string, size: number): CopilotTailReading {
	let bytes = COPILOT_TAIL_START_BYTES;
	for (;;) {
		const { text, atStart } = readFileTail(file, size, bytes);
		const lines = text.split("\n");
		// Without the file start, the first line is cut mid-record.
		if (!atStart) lines.shift();
		let shutdown: Record<string, unknown> | null = null;
		let mainModel: string | null = null;
		let anyModel: string | null = null;
		let changedModel: string | null = null;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line) continue;
			const head = line.slice(0, 64);
			const isShutdown = shutdown === null && head.includes('"session.shutdown"');
			const isMessage = mainModel === null && head.includes('"assistant.message"');
			const isChange = changedModel === null && head.includes('"session.model_change"');
			if (!isShutdown && !isMessage && !isChange) continue;
			let event: Record<string, unknown> | null;
			try {
				event = asRecord(JSON.parse(line));
			} catch {
				continue; // a torn line (the agent was mid-write)
			}
			const data = asRecord(event?.data);
			if (!data) continue;
			if (isShutdown) shutdown = data;
			else if (isMessage) {
				const model = nonEmptyString(data.model);
				if (!model) continue;
				// A subagent's message (it has a parent tool call) may name a cheaper model than the main thread's.
				if (data.parentToolCallId === undefined || data.parentToolCallId === null) mainModel = model;
				else anyModel ??= model;
			} else changedModel = nonEmptyString(data.newModel);
			if (shutdown !== null && mainModel !== null) break;
		}
		const model = mainModel ?? anyModel ?? changedModel ?? (shutdown ? nonEmptyString(shutdown.currentModel) : null);
		if (atStart || bytes >= COPILOT_TAIL_MAX_BYTES || shutdown !== null || model !== null) return { model, shutdown };
		bytes *= 2;
	}
}

/** `scanCopilotEvents` cached by (path, mtime, size): the UI polls this every couple of seconds. */
function copilotReading(file: string): CopilotTailReading | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return null;
	}
	const cached = copilotReadingCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.reading;
	let reading: CopilotTailReading;
	try {
		reading = scanCopilotEvents(file, stat.size);
	} catch {
		return null;
	}
	if (copilotReadingCache.size >= COPILOT_CACHE_MAX_ENTRIES) {
		const oldest = copilotReadingCache.keys().next().value;
		if (oldest !== undefined) copilotReadingCache.delete(oldest);
	}
	copilotReadingCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, reading });
	return reading;
}

/**
 * Every successful compaction in a Copilot `events.jsonl`, over the WHOLE
 * history. The usage reader only looks at the file's tail, but a compaction can
 * be megabytes back and the boundary count has to be right regardless.
 *
 * Cheap by construction: lines are only substring-searched, and only the few
 * that contain `session.compaction_complete` are parsed. The scan is
 * incremental — the cache remembers how far it got (the end of the last
 * complete line), so a growing file is read from there, not from the start; a
 * file that shrank is read again from zero.
 */
interface CopilotCompactions {
	/** Byte offset just past the last newline scanned. */
	offset: number;
	count: number;
	last: CompactionBoundary | null;
}

const copilotCompactionCache = new Map<string, CopilotCompactions>();
const COPILOT_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

function copilotCompactions(file: string): CopilotCompactions {
	let size: number;
	try {
		size = fs.statSync(file).size;
	} catch {
		return { offset: 0, count: 0, last: null };
	}
	let state = copilotCompactionCache.get(file) ?? { offset: 0, count: 0, last: null };
	if (state.offset > size) state = { offset: 0, count: 0, last: null };
	if (state.offset === size) return state;
	let { offset, count, last } = state;
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return state;
	}
	try {
		let carry: Buffer = Buffer.alloc(0);
		let position = offset;
		const chunk = Buffer.alloc(COPILOT_SCAN_CHUNK_BYTES);
		while (position < size) {
			const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
			if (n <= 0) break;
			position += n;
			const data: Buffer = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : Buffer.from(chunk.subarray(0, n));
			const end = data.lastIndexOf(10);
			if (end < 0) {
				carry = data;
				continue;
			}
			for (const line of data.toString("utf8", 0, end).split("\n")) {
				if (!line.includes('"session.compaction_complete"')) continue;
				try {
					const boundary = compactionBoundaryOfLine(JSON.parse(line) as Record<string, unknown>);
					if (boundary) {
						count += 1;
						last = boundary;
					}
				} catch {
					// not a record we can read: a torn or foreign line
				}
			}
			offset += end + 1;
			carry = Buffer.from(data.subarray(end + 1));
		}
	} catch {
		return state;
	} finally {
		fs.closeSync(fd);
	}
	state = { offset, count, last };
	copilotCompactionCache.set(file, state);
	return state;
}

function numberOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * GitHub Copilot CLI: usage from `session.shutdown`, written at EVERY process
 * exit with metrics that are CUMULATIVE for the whole session (across resumes),
 * so only the last one is read. Its `modelMetrics` already include subagents.
 *
 * `usage.inputTokens` is the TOTAL input and already contains `cacheReadTokens`
 * and `cacheWriteTokens`, whereas the hub's `totalInputTokens` is
 * input + cacheCreation + cacheRead. So the hub's uncached bucket is
 * `inputTokens - cacheRead - cacheWrite`, which keeps `totalInputTokens` equal
 * to Copilot's own `inputTokens` instead of double counting the cache.
 * `currentTokens` is the exact occupancy, not an estimate. Compactions come from a
 * second, whole-file pass (`copilotCompactions`) because they can be far from the tail. A session with no
 * shutdown yet (running, or crashed) has no totals: zero tokens, but still the model.
 */
function readCopilotUsage(sessionId: string): TokenUsage {
	const file = copilotEventsPath(sessionId);
	if (!file) return emptyTokenUsage();
	const reading = copilotReading(file);
	if (!reading) return emptyTokenUsage();
	const raw = emptyRawUsage();
	raw.lastModel = reading.model;
	raw.windowHarness = "copilot";
	const compactions = copilotCompactions(file);
	raw.compactions = compactions.count;
	raw.lastCompaction = compactions.last;
	const shutdown = reading.shutdown;
	if (shutdown) {
		const metrics = asRecord(shutdown.modelMetrics) ?? {};
		for (const entry of Object.values(metrics)) {
			const metric = asRecord(entry);
			if (!metric) continue;
			const usage = asRecord(metric.usage) ?? {};
			const cacheRead = numberOr0(usage.cacheReadTokens);
			const cacheWrite = numberOr0(usage.cacheWriteTokens);
			raw.input += Math.max(0, numberOr0(usage.inputTokens) - cacheRead - cacheWrite);
			raw.cacheRead += cacheRead;
			raw.cacheCreation += cacheWrite;
			raw.output += numberOr0(usage.outputTokens);
			raw.turns += numberOr0(asRecord(metric.requests)?.count);
		}
		raw.lastContext = numberOr0(shutdown.currentTokens);
		raw.recentContexts = [raw.lastContext];
	}
	const usage = tokenUsageFromRaw(raw, [], null);
	// The spike's decision: modelMetrics are the sum of main + every subagent, so
	// the totals include subagents whether or not one ran in this session.
	usage.includesSubagents = true;
	// Copilot accounts report premium requests / AI credits, not USD, and the
	// report server prices by agent + model, so no cost is claimed here.
	usage.costUsd = null;
	// `currentTokens` is exact, so it is quoted as-is, not clamped to a window the hub may know less well.
	usage.contextTokens = raw.lastContext;
	usage.contextEstimated = false;
	return usage;
}

/** Claude Code: the main transcript plus every subagent transcript. */
function readClaudeUsage(workdir: string, sessionId: string, claudeFile: string): TokenUsage {
	const main = accumulateUsage(claudeFile);
	main.windowHarness = "claude";
	const subs = subagentFiles(workdir, sessionId).map((file) => accumulateUsage(file));
	// The main thread ran no real turn (only a `<synthetic>` notice, say) but its
	// subagents did: they are billed in these totals, so their model is the one.
	if (!main.lastModel) main.lastModel = subs.map((sub) => sub.lastModel).findLast((m) => m !== null) ?? null;
	return tokenUsageFromRaw(main, subs, null);
}

/** Cursor Agent: awb run-log results, then the agent-transcript as a fallback. */
function readCursorUsage(
	sessionId: string,
	cursorTranscript: string | null,
	cursorLogs: RawUsage | null,
): TokenUsage {
	const main =
		cursorLogs && cursorLogs.turns > 0
			? cursorLogs
			: cursorTranscript
				? accumulateUsage(cursorTranscript)
				: (cursorLogs ?? emptyRawUsage());
	main.windowHarness = "cursor";
	// Neither the result nor the command line named the model (awb's own
	// runs, today): Cursor's tracking database, then the transcript, then the
	// CLI's default model (a session that edited nothing has no tracking rows).
	if (!main.lastModel) {
		main.lastModel = cursorModelFromTracking(sessionId) ?? cursorModelFromTranscript(sessionId) ?? cursorDefaultModel();
	}
	// No size on the command line: the size the CLI is configured to run that
	// model at, when it sets one.
	if (main.lastModel && main.statedContextWindow === null) main.statedContextWindow = cursorConfiguredContext(main.lastModel);
	return tokenUsageFromRaw(main, [], { transcript: cursorTranscript ? cursorTranscriptRuns(cursorTranscript) : null });
}

/**
 * `harness` is the runner the workflow's hook reports (`hookRuntime(...).harness`).
 * When given and known it decides the reader outright; null/undefined/unknown
 * keeps the shape-sniffing below, which is only a fallback: Claude, Cursor and
 * Copilot session ids are all bare uuids, so the id alone cannot say whose it is.
 */
export function readTokenUsage(workdir: string, sessionId: string, harness?: string | null): TokenUsage {
	switch (harness) {
		case "free-code":
			return readFreeCodeUsage(sessionId);
		case "copilot":
			return readCopilotUsage(sessionId);
		case "claude":
			return readClaudeUsage(workdir, sessionId, transcriptPath(workdir, sessionId));
		case "cursor": {
			const cursorTranscript = cursorTranscriptPath(sessionId);
			return readCursorUsage(sessionId, cursorTranscript, accumulateCursorUsageFromLogs(sessionId));
		}
	}

	// free-code sessions ARE .jsonl paths — read the transcript directly.
	if (sessionId.endsWith(".jsonl") && path.isAbsolute(sessionId)) return readFreeCodeUsage(sessionId);

	const claudeFile = transcriptPath(workdir, sessionId);
	const claudeExists = (() => {
		try {
			return fs.statSync(claudeFile).isFile();
		} catch {
			return false;
		}
	})();

	const cursorTranscript = cursorTranscriptPath(sessionId);
	const cursorChat = cursorChatDir(sessionId);
	const cursorLogs = !claudeExists ? accumulateCursorUsageFromLogs(sessionId) : null;
	const isCursorSession =
		!claudeExists &&
		(cursorTranscript !== null || cursorChat !== null || (cursorLogs?.turns ?? 0) > 0);

	if (isCursorSession) return readCursorUsage(sessionId, cursorTranscript, cursorLogs);
	// Only a Copilot session dir that exists, with no Claude/Cursor artefact above, counts.
	if (!claudeExists && copilotEventsPath(sessionId)) return readCopilotUsage(sessionId);
	return readClaudeUsage(workdir, sessionId, claudeFile);
}

/**
 * How full the main thread's context window was at its last turn, as a
 * percentage. Zero when no window is known (nothing has run yet), which reads
 * as "empty" rather than dividing by zero.
 *
 * This is the number the operator's own client shows next to the context bar
 * ("20.2%"), and it is computed here so the hub and its report server quote the
 * same figure instead of each rounding their own.
 */
export function contextPercent(usage: TokenUsage): number {
	return usage.contextWindow > 0 ? (100 * usage.contextTokens) / usage.contextWindow : 0;
}

/**
 * The wire shape of a `usage.snapshot` report event
 * (docs/report-server.es.html §7.2), built from one `TokenUsage`.
 *
 * The point of this function is `input_tokens`. It is the SUM of every input
 * field — new input + cache creation + cache read — because that is what the
 * operator's client counts as "in", and a dashboard that disagrees with the
 * client about the same session is worse than no dashboard. Reporting only the
 * bare `input_tokens` field (what this used to do) reads as a rounding error
 * once prompt caching is on: a real session measured here billed 416 uncached
 * input tokens against 16,015,192 total, because 14.4M of it was cache reads.
 *
 * The components are kept alongside it (`input_tokens_uncached`,
 * `cache_creation`, `cache_read`) so the total stays auditable and the server
 * can still price the three rates apart — nothing is lost by leading with the
 * total, only by leading with a part of it.
 *
 * `agent` is the runner id (`claude` | `free-code` | `cursor`) the session ran
 * on. A transcript can't say which runner wrote it, so the caller passes it in;
 * when it doesn't know, the field is omitted rather than guessed. The server
 * prices a session by (agent, model), so it needs both on the same event.
 */
export function usageSnapshot(usage: TokenUsage, agent?: string | null): {
	agent?: string;
	input_tokens: number;
	output_tokens: number;
	input_tokens_uncached: number;
	cache_creation: number;
	cache_read: number;
	context_tokens: number;
	context_window: number;
	context_pct: number;
	context_estimated: boolean;
	model: string | null;
	turns: number;
	includes_subagents: boolean;
	compacted: boolean;
	cost_usd: number | null;
} {
	return {
		...(agent ? { agent } : {}),
		// The headline the dashboard tiles show — the same total the client's
		// "in 16.0M" is.
		input_tokens: usage.totalInputTokens,
		output_tokens: usage.outputTokens,
		// …and its parts, so the headline can be checked against them.
		input_tokens_uncached: usage.inputTokens,
		cache_creation: usage.cacheCreationTokens,
		cache_read: usage.cacheReadTokens,
		// Context occupancy: the client shows a bar, not a total, and a server that
		// only has totals cannot tell a session that is about to compact from one
		// that has barely started.
		context_tokens: usage.contextTokens,
		context_window: usage.contextWindow,
		context_pct: Number(contextPercent(usage).toFixed(1)),
		// Cursor occupancy is an estimate (see estimateCursorOccupancy); the server
		// gets the same number the panel shows and is told what kind it is.
		context_estimated: usage.contextEstimated,
		model: usage.model,
		turns: usage.turns,
		// Whether subagent transcripts were folded in — the client says "incl.
		// subagents" for exactly this, and without it the totals are unexplainable
		// (a step's real work runs in a subagent).
		includes_subagents: usage.includesSubagents,
		compacted: usage.compactions > 0,
		// The runner's own figure (free-code only today), or null — never computed
		// here. When null the server prices the session by (agent, model).
		cost_usd: usage.costUsd,
	};
}
