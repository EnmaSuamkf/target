/**
 * How big is the context window the workflow's agent is actually running with?
 *
 * Everything the hub says about context pressure is a fraction — "this session
 * is 63% full" — so the denominator has to be right or every threshold built on
 * it is wrong. It used to be a single hardcoded 200_000, and that number is
 * measurably false on this machine: real `claude-sonnet-5` transcripts under
 * `~/.claude/projects/` carry single turns of 370k context tokens, i.e. 185% of
 * the "window" the hub assumed. At that point the 60% delegation gate fires
 * from the first step and the UI meter is permanently red, which is the same as
 * having no meter at all.
 *
 * So the window is derived from the model that actually produced the turns
 * (transcript.ts reads the model id per harness: `message.model` on claude's
 * assistant lines, the `model_change` record's `modelId` on free-code's), and
 * looked up here. Three layers, in order:
 *
 *   1. the operator's `modelContextWindows` override in ~/.target/config.json,
 *   2. this table (exact id, then longest matching id prefix, so a dated
 *      variant like `claude-sonnet-5-20260101` resolves to `claude-sonnet-5`),
 *   3. `FALLBACK_CONTEXT_WINDOW_TOKENS` for a model nobody has told us about.
 *
 * The override layer is the point of the exercise: a new model ships, its
 * window is whatever it is, and an operator can correct the hub in a config
 * file instead of waiting for a code change that reintroduces a literal.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { targetDir } from "./config.ts";

/**
 * The window assumed for a model that is in neither the override map nor the
 * table below.
 *
 * Deliberately the SMALLEST window any model these harnesses spawn has ever
 * shipped with, not an average and not a guess at the newest tier. The error is
 * asymmetric: too small a denominator over-reports pressure, whose worst
 * outcome is delegating a step to a subagent that didn't strictly need it (a
 * cheap, reversible, already-supported behaviour); too large a denominator
 * under-reports it, and the failure mode there is the one this whole branch
 * exists to fix — a conversation quietly filling up and getting compacted with
 * the hub reporting "42% full" the whole way. So an unknown model errs toward
 * crying wolf.
 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Effective context window (tokens) per model id.
 *
 * Every entry is either the model's published window or, where a real
 * transcript on this machine was measured ABOVE that published window, the
 * extended tier it must therefore be running in. The measurements are the max
 * `input + cache_creation + cache_read` of any single turn found under
 * `~/.claude/projects/` and `~/.agent-webhook-bridge/sessions/` on 2026-08-02,
 * and they're quoted per entry on purpose: a future reader can tell which
 * numbers are evidence and which are documentation.
 *
 * Match is exact first, then longest id prefix — `claude-opus-5-20260430`
 * resolves through `claude-opus-5`. Not exhaustive by design; anything missing
 * lands on FALLBACK_CONTEXT_WINDOW_TOKENS and can be corrected from config.
 */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
	// Measured 245,912 — above the 200k tier, so this session was running the
	// 1M extended window.
	"claude-opus-5": 1_000_000,
	// Measured 370,543.
	"claude-sonnet-5": 1_000_000,
	// Measured 415,362 — the largest single turn seen on this machine.
	"claude-fable-5": 1_000_000,
	// Measured 236,715.
	"claude-opus-4-8": 1_000_000,
	// No local transcript to measure; the published small-model window.
	"claude-haiku-5": 200_000,
	// free-code's non-Anthropic model here. Measured 219,145, so its window is
	// at least that; 256k is the tier it's published at.
	"accounts/fireworks/models/glm-5p2": 256_000,
	// Cursor Agent Composer models — the CLI /context bar uses a 200k window for
	// these (e.g. "Composer 2.5 Fast · 39.9%" reads as 79.8k / 200k). Prefix
	// matching covers dated ids like `composer-2.5-fast`.
	"composer-2.5": 200_000,
	"composer-2": 200_000,
	// Cursor-branded models with an explicit 1M tier in the picker name.
	"claude-opus-5-thinking": 1_000_000,
	"claude-sonnet-5-thinking": 1_000_000,
	"claude-fable-5-thinking": 1_000_000,
	"gpt-5.6-sol": 1_000_000,
	"gpt-5.6-luna": 1_000_000,
	// Claude Code sometimes writes the bare alias instead of the full id (e.g.
	// on synthetic turns). Same windows as the ids they stand for.
	opus: 1_000_000,
	sonnet: 1_000_000,
	fable: 1_000_000,
	haiku: 200_000,
};

/**
 * Reads the operator's per-model overrides out of ~/.target/config.json.
 *
 * Deliberately NOT via `loadConfig()`: that mints and WRITES an admin token
 * when the file is missing, which is a real side effect for something on the
 * read path of a token meter. This only wants two optional keys, so it reads
 * the file itself and treats every failure (absent, unparseable, wrong shape)
 * as "no overrides" — an unreadable config must never make the hub stop
 * reporting context at all.
 */
function configuredWindows(): { windows: Record<string, number>; fallback: number } {
	const empty = { windows: {}, fallback: FALLBACK_CONTEXT_WINDOW_TOKENS };
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(targetDir(), "config.json"), "utf8")) as Record<string, unknown>;
	} catch {
		return empty;
	}
	const raw = parsed.modelContextWindows;
	const windows: Record<string, number> = {};
	if (raw && typeof raw === "object") {
		for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
			// Only positive finite numbers: a typo'd "200k" or a 0 would otherwise
			// silently become a window that makes every ratio meaningless.
			if (typeof value === "number" && Number.isFinite(value) && value > 0) windows[model.toLowerCase()] = value;
		}
	}
	const fallbackRaw = parsed.fallbackContextWindowTokens;
	const fallback =
		typeof fallbackRaw === "number" && Number.isFinite(fallbackRaw) && fallbackRaw > 0
			? fallbackRaw
			: FALLBACK_CONTEXT_WINDOW_TOKENS;
	return { windows, fallback };
}

/**
 * The context window to measure `model` against. `null`/unknown → the
 * documented fallback, never a throw: a missing model id is a transcript that
 * hasn't got an assistant turn yet, which is normal, not an error.
 *
 * Lookup order is override → exact table entry → longest matching table prefix
 * → fallback. The prefix step is what keeps dated model ids
 * (`claude-sonnet-5-20260101`) working without an entry each.
 */
export function contextWindowForModel(model: string | null | undefined): number {
	const { windows, fallback } = configuredWindows();
	if (!model) return fallback;
	const id = model.trim().toLowerCase();
	if (!id || id === "<synthetic>") return fallback;
	if (windows[id] !== undefined) return windows[id];
	const table: Record<string, number> = { ...MODEL_CONTEXT_WINDOWS, ...windows };
	if (table[id] !== undefined) return table[id];
	// Longest prefix wins, so `claude-opus-4-8-2026…` prefers `claude-opus-4-8`
	// over a hypothetical shorter `claude-opus-4` entry.
	let best: number | null = null;
	let bestLength = 0;
	for (const [key, value] of Object.entries(table)) {
		if (id.startsWith(key) && key.length > bestLength) {
			best = value;
			bestLength = key.length;
		}
	}
	return best ?? fallback;
}
