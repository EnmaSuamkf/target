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
 * resolves through `claude-opus-5`. A prefix only counts at a version boundary
 * (see `matchesAtBoundary`): `claude-opus-5.5` must NOT resolve through
 * `claude-opus-5`. Not exhaustive by design; anything missing
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
	// free-code's default model here (2026-10-01). Fireworks' model page
	// (fireworks.ai/models/fireworks/kimi-k3): "1,048,576 tokens, which Moonshot
	// describes as a 1-million-token window". Consistent with what was measured:
	// across 1,434 kimi-k3 turns the largest was 191,734 and the provider never
	// rejected one for length. Note free-code itself assumes 128,000 for it
	// (model-registry.js gives any models.json entry without `contextWindow`
	// 128k) and compacts at ~112k on that basis — set `contextWindow` in
	// ~/.free-code/agent/models.json if its own bar should agree with this one.
	"accounts/fireworks/models/kimi-k3": 1_048_576,
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
 * GitHub Copilot CLI model ids (dotted: `claude-haiku-4.5`, `gpt-5.4`), with the
 * denominator chosen in docs/copilot-runner-spike.md section 4: Copilot's
 * `max_prompt_tokens`, NOT `max_context_window_tokens`. The CLI compacts against
 * it (`compaction_start.tokenLimit` equals it on both measured models) and the
 * hub's occupancy, `session.shutdown.currentTokens`, is a prompt-side figure.
 *
 * No runtime source of the limit exists for a plain headless run, so these are
 * static. Evidence is quoted per group; "inferred" means NOT measured.
 *
 * Some Copilot ids are spelled exactly like an id another harness already has
 * in MODEL_CONTEXT_WINDOWS with a different meaning (`claude-opus-5` is Claude
 * Code's 1M window, `gpt-5.6-sol` is Cursor's 1M tier). A Copilot session looks
 * this table up FIRST (`contextWindowForModel`'s `harness`); a caller without a
 * harness sees the main table first and falls to this one only for ids the main
 * table does not know.
 *
 * Long-context tier: `--context long_context` is recorded in
 * `session.start.data.contextTier` / `session.resume.data.contextTier`
 * (`"long_context"`, else null), but on 2026-10-01 it changed no limit: gpt-5.4
 * reported 1050000/922000 on both tiers and haiku ignored the flag. So the tier is
 * detectable but deliberately NOT plumbed into `stated`; the table value stays
 * the denominator. If a model is later seen with a larger limit under that tier,
 * the operator override is the escape hatch.
 */
export const COPILOT_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
	// OBSERVED 2026-10-01 on CLI 1.0.91: `model.turn_ended.modelInfo` 144000 window /
	// 128000 max_prompt, and compaction `tokenLimit` 128000. The docs' "1M in CLI"
	// claim for Haiku 4.5 was falsified (`--context long_context` ignored).
	"claude-haiku-4.5": 128_000,
	// OBSERVED 2026-10-01: modelInfo 1050000 window / 922000 max_prompt, identical on
	// the default and long_context tiers; compaction `tokenLimit` 922000.
	"gpt-5.4": 922_000,
	// OBSERVED earlier in an interactive session (spike section 4): 400000 window /
	// 272000 max_prompt. Rejected by `--model` on this account on 2026-10-01.
	"gpt-5.4-nano": 272_000,
	// OBSERVED earlier in an interactive session: 128000 window / 64000 max_prompt
	// (reported as the dated `gpt-4o-mini-2024-07-18`, which the prefix match covers).
	"gpt-4o-mini": 64_000,
	// INFERRED, not measured: ids seen in events (gpt-5-mini, gpt-5.4-mini,
	// claude-sonnet-4.6, mai-code-1.1-flash) whose limits were never captured, and the
	// ids the GitHub docs list for the Copilot CLI (docs.github.com, "Supported AI
	// models in GitHub Copilot", read 2026-10-01; it states no limits) that were
	// rejected or not probed on this account. The id spellings below follow the
	// docs' display names. The value is the spike's conservative figure: the one
	// measured Claude model is 128000 and the docs' 1M claims proved wrong for it, and
	// a too-small denominator only over-reports pressure. Override per model in
	// ~/.target/config.json once a real limit is known.
	"gpt-5-mini": 128_000,
	"gpt-5.3-codex": 128_000,
	"gpt-5.4-mini": 128_000,
	"gpt-5.5": 128_000,
	"gpt-5.6-luna": 128_000,
	"gpt-5.6-sol": 128_000,
	"gpt-5.6-terra": 128_000,
	"gpt-6-astra": 128_000,
	"gpt-6-luna": 128_000,
	"gpt-6-sol": 128_000,
	"gpt-6.1-sol": 128_000,
	"claude-sonnet-4.6": 128_000,
	"claude-sonnet-5": 128_000,
	"claude-sonnet-5.5": 128_000,
	"claude-opus-4.7": 128_000,
	"claude-opus-4.8": 128_000,
	"claude-opus-5": 128_000,
	"claude-opus-5.5": 128_000,
	"claude-fable-5": 128_000,
	"claude-fable-5.1": 128_000,
	"gemini-3.5-flash": 128_000,
	"gemini-3.6-flash": 128_000,
	"gemini-3.7-flash": 128_000,
	"gemini-3.8-flash": 128_000,
	"grok-4.5": 128_000,
	"grok-4.6": 128_000,
	"grok-4.7": 128_000,
	"kimi-k2.7-code": 128_000,
	"kimi-k3": 128_000,
	"mai-code-1.1-flash": 128_000,
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
interface ConfiguredWindows {
	windows: Record<string, number>;
	fallback: number;
}

/**
 * The last parse of config.json, keyed by what `stat` says about the file.
 * `contextWindowForModel` runs on every /session-info poll (several per second
 * with a few tabs open), and re-reading and re-parsing the whole config each
 * time is wasted work for a file that changes by hand, rarely. A `stat` is
 * enough to notice an edit: mtime + size + inode change on any save, including
 * an editor's write-then-rename. `null` key = the file was absent last time.
 */
let windowsCache: { key: string | null; value: ConfiguredWindows } | null = null;

function configStatKey(file: string): string | null {
	try {
		const st = fs.statSync(file);
		return `${st.mtimeMs}:${st.size}:${st.ino}`;
	} catch {
		return null;
	}
}

function configuredWindows(): ConfiguredWindows {
	const file = path.join(targetDir(), "config.json");
	const key = configStatKey(file);
	if (windowsCache && windowsCache.key === key) return windowsCache.value;
	const value = parseConfiguredWindows(file);
	windowsCache = { key, value };
	return value;
}

/** Test seam: how many times config.json was actually read and parsed. */
export const _stats = { configReads: 0 };

function parseConfiguredWindows(file: string): ConfiguredWindows {
	const empty = { windows: {}, fallback: FALLBACK_CONTEXT_WINDOW_TOKENS };
	let parsed: Record<string, unknown>;
	_stats.configReads += 1;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
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
 * Whether `key` is a prefix of `id` that ends where a version ends. A key that
 * ends in a digit must not be followed by another digit or a dot, so
 * `claude-opus-5.5` and `claude-opus-5.1` do not resolve through `claude-opus-5`
 * (a different model with its own window), while `claude-opus-5-20260430` does.
 */
function matchesAtBoundary(id: string, key: string): boolean {
	if (!id.startsWith(key)) return false;
	if (id.length === key.length) return true;
	return !(/[0-9]$/.test(key) && /[0-9.]/.test(id[key.length] ?? ""));
}

/**
 * The context window to measure `model` against. `null`/unknown → the
 * documented fallback, never a throw: a missing model id is a transcript that
 * hasn't got an assistant turn yet, which is normal, not an error.
 *
 * Lookup order is override → `stated` → exact table entry → longest matching
 * table prefix → fallback. The prefix step is what keeps dated model ids
 * (`claude-sonnet-5-20260101`) working without an entry each.
 *
 * `stated` is a window the harness itself declared for this run — Cursor's
 * `--model 'x[context=1m]'` or the `context` parameter its CLI config sets for
 * a model (see transcript.ts). It beats the table because it is what the run
 * actually used (the same model id can run at 272k or 1M), but not the
 * operator, whose override is the escape hatch for every source being wrong.
 *
 * `harness` (`"copilot"`) makes COPILOT_MODEL_CONTEXT_WINDOWS win over the main
 * table for ids both spell; any other named harness ignores the Copilot table;
 * with none (a bare lookup) the main table wins and the Copilot one only fills
 * ids the main table lacks.
 */
export function contextWindowForModel(model: string | null | undefined, stated?: number | null, harness?: string | null): number {
	const { windows, fallback } = configuredWindows();
	const id = model ? model.trim().toLowerCase() : "";
	if (id && windows[id] !== undefined) return windows[id];
	if (typeof stated === "number" && Number.isFinite(stated) && stated > 0) return stated;
	if (!id || id === "<synthetic>") return fallback;
	const table: Record<string, number> =
		harness === "copilot"
			? { ...MODEL_CONTEXT_WINDOWS, ...COPILOT_MODEL_CONTEXT_WINDOWS, ...windows }
			: harness
				? // Another named harness never inherits Copilot's ids: an id only Copilot knows is the fallback for it.
					{ ...MODEL_CONTEXT_WINDOWS, ...windows }
				: { ...COPILOT_MODEL_CONTEXT_WINDOWS, ...MODEL_CONTEXT_WINDOWS, ...windows };
	if (table[id] !== undefined) return table[id];
	// Longest prefix wins, so `claude-opus-4-8-2026…` prefers `claude-opus-4-8`
	// over a hypothetical shorter `claude-opus-4` entry.
	let best: number | null = null;
	let bestLength = 0;
	for (const [key, value] of Object.entries(table)) {
		if (matchesAtBoundary(id, key) && key.length > bestLength) {
			best = value;
			bestLength = key.length;
		}
	}
	return best ?? fallback;
}
