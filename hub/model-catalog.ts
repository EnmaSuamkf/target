/**
 * Which models can a workflow pick for its agent?
 *
 * Two layers (see the per-workflow model selection design): Settings holds an
 * ALLOWLIST of models per runner, and each workflow picks one of the enabled
 * ids (or the CLI default). This module owns the catalog behind the allowlist,
 * merged from three sources, and the allowlist's validation and filtering:
 *
 *   1. `seed`   — the hub's own tables: Claude aliases and the ids in
 *                 `models.ts` (Claude/Cursor/free-code/Copilot).
 *   2. `live`   — files the CLIs keep on this machine: Cursor's
 *                 `~/.cursor/cli-config.json` (modelParameters keys and
 *                 selectedModel), free-code's `~/.free-code/agent/models.json`.
 *                 Claude has no file, so only its aliases.
 *   3. `custom` — ids the operator typed into Settings. The only way to get a
 *                 Copilot id the seed doesn't know: listing Copilot's models
 *                 would spend premium requests, so it is never probed.
 *
 * Nothing here invents an id: every entry comes from a table, a file or the
 * operator.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COPILOT_MODEL_CONTEXT_WINDOWS, MODEL_CONTEXT_WINDOWS } from "./models.ts";

export type ModelSource = "seed" | "live" | "custom";

export interface CatalogModel {
	id: string;
	label: string;
	source: ModelSource;
}

/** What Settings stores for one runner. */
export interface RunnerModelAllowlist {
	/** Enabled catalog ids; `null` = never saved, so every seed/live id counts as enabled. */
	enabled: string[] | null;
	/** Operator-added ids. Always enabled: adding one is the act of enabling it. */
	custom: string[];
}

export type ModelAllowlist = Record<string, RunnerModelAllowlist>;

export const MODEL_RUNNERS = ["claude", "free-code", "cursor", "copilot"] as const;

const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "fable"];
const MAX_MODEL_ID_LENGTH = 200;

export class ModelSettingsError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ModelSettingsError";
		this.code = code;
	}
}

/** Ids are passed to a CLI as one argv entry: no whitespace or control characters. */
export function validModelId(raw: unknown): raw is string {
	return typeof raw === "string" && raw.length > 0 && raw.length <= MAX_MODEL_ID_LENGTH && !/[\s\x00-\x1f\x7f]/.test(raw) && !raw.startsWith("-");
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function labelOf(id: string): string {
	return id;
}

function seedModels(runner: string): CatalogModel[] {
	const ids: string[] = [];
	if (runner === "claude") {
		ids.push(...CLAUDE_ALIASES, ...Object.keys(MODEL_CONTEXT_WINDOWS).filter((id) => id.startsWith("claude-") && !id.endsWith("-thinking")));
	} else if (runner === "cursor") {
		ids.push(...Object.keys(MODEL_CONTEXT_WINDOWS).filter((id) => id.startsWith("composer-") || id.endsWith("-thinking") || id.startsWith("gpt-")));
	} else if (runner === "free-code") {
		ids.push(...Object.keys(MODEL_CONTEXT_WINDOWS).filter((id) => id.startsWith("accounts/")));
	} else if (runner === "copilot") {
		ids.push(...Object.keys(COPILOT_MODEL_CONTEXT_WINDOWS));
	}
	return ids.map((id) => ({ id, label: labelOf(id), source: "seed" as const }));
}

function cursorLiveModels(home: string): CatalogModel[] {
	const cfg = readJson(path.join(home, ".cursor", "cli-config.json"));
	if (!cfg) return [];
	const ids: string[] = [];
	const params = cfg.modelParameters;
	if (params && typeof params === "object") ids.push(...Object.keys(params as object).filter((id) => id !== "default"));
	for (const key of ["selectedModel", "model"]) {
		const entry = cfg[key] as { modelId?: unknown; displayName?: unknown } | undefined;
		if (entry && typeof entry.modelId === "string") ids.push(entry.modelId);
	}
	const displayNames = new Map<string, string>();
	const current = cfg.model as { modelId?: unknown; displayName?: unknown } | undefined;
	if (current && typeof current.modelId === "string" && typeof current.displayName === "string") displayNames.set(current.modelId, current.displayName);
	return ids.filter(validModelId).map((id) => ({ id, label: displayNames.get(id) ?? labelOf(id), source: "live" as const }));
}

function freeCodeLiveModels(home: string): CatalogModel[] {
	const cfg = readJson(path.join(home, ".free-code", "agent", "models.json"));
	if (!cfg) return [];
	// `provider/model` is how free-code's own `only` list spells a selectable
	// model. When the file has that list it is authoritative; otherwise fall back
	// to every model of every provider.
	const names = new Map<string, string>();
	const providers = (cfg.providers && typeof cfg.providers === "object" ? cfg.providers : {}) as Record<string, { models?: unknown }>;
	const all: string[] = [];
	for (const [provider, block] of Object.entries(providers)) {
		for (const m of Array.isArray(block?.models) ? (block.models as { id?: unknown; name?: unknown }[]) : []) {
			if (typeof m?.id !== "string") continue;
			const id = `${provider}/${m.id}`;
			all.push(id);
			if (typeof m.name === "string") {
				names.set(id, m.name);
				names.set(m.id, m.name);
			}
		}
	}
	const only = Array.isArray(cfg.only) ? (cfg.only as unknown[]).filter((x): x is string => typeof x === "string") : [];
	const ids = only.length > 0 ? only : all;
	return ids.filter(validModelId).map((id) => ({ id, label: names.get(id) ?? labelOf(id), source: "live" as const }));
}

function liveModels(runner: string, home: string): CatalogModel[] {
	if (runner === "cursor") return cursorLiveModels(home);
	if (runner === "free-code") return freeCodeLiveModels(home);
	return [];
}

/** seed ∪ live ∪ custom for one runner, first source wins on a duplicate id. */
export function runnerCatalog(runner: string, custom: string[] = [], home: string = os.homedir()): CatalogModel[] {
	const seen = new Set<string>();
	const out: CatalogModel[] = [];
	const add = (models: CatalogModel[]) => {
		for (const m of models) {
			if (seen.has(m.id)) continue;
			seen.add(m.id);
			out.push(m);
		}
	};
	add(seedModels(runner));
	add(liveModels(runner, home));
	add(custom.map((id) => ({ id, label: labelOf(id), source: "custom" as const })));
	return out;
}

export interface RunnerModelView {
	/** Every known id, with whether it is currently enabled. */
	models: (CatalogModel & { enabled: boolean })[];
	custom: string[];
}

/** The Settings view: the whole catalog per runner with enabled flags. */
export function modelSettingsView(allowlist: ModelAllowlist, home: string = os.homedir()): Record<string, RunnerModelView> {
	const view: Record<string, RunnerModelView> = {};
	for (const runner of MODEL_RUNNERS) {
		const entry = allowlist[runner] ?? { enabled: null, custom: [] };
		const enabled = entry.enabled ? new Set(entry.enabled) : null;
		const catalog = runnerCatalog(runner, entry.custom, home);
		view[runner] = {
			models: catalog.map((m) => ({ ...m, enabled: m.source === "custom" || enabled === null || enabled.has(m.id) })),
			custom: [...entry.custom],
		};
	}
	return view;
}

/** Enabled models for one runner — what pickers and the create/PATCH validation use. */
export function enabledModels(runner: string, allowlist: ModelAllowlist, home: string = os.homedir()): CatalogModel[] {
	const view = modelSettingsView(allowlist, home)[runner];
	return view ? view.models.filter((m) => m.enabled).map(({ id, label, source }) => ({ id, label, source })) : [];
}

/**
 * Validates a PUT body: `{ runners: { <runner>: { enabled: string[], custom: string[] } } }`.
 * A runner left out falls back to the default (everything known enabled). An
 * `enabled` id that is not in that runner's catalog is rejected rather than
 * stored, so the allowlist can never name a model nobody has vouched for.
 */
export function parseModelAllowlist(body: unknown, home: string = os.homedir()): ModelAllowlist {
	const runners = (body as { runners?: unknown } | null)?.runners;
	if (!runners || typeof runners !== "object" || Array.isArray(runners)) {
		throw new ModelSettingsError("invalid_models", "runners must be an object keyed by runner id");
	}
	const out: ModelAllowlist = {};
	for (const [runner, raw] of Object.entries(runners as Record<string, unknown>)) {
		if (!(MODEL_RUNNERS as readonly string[]).includes(runner)) {
			throw new ModelSettingsError("invalid_runner", `unknown runner: ${runner}`);
		}
		const entry = (raw ?? {}) as { enabled?: unknown; custom?: unknown };
		const list = (value: unknown, field: string): string[] => {
			if (value === undefined) return [];
			if (!Array.isArray(value)) throw new ModelSettingsError("invalid_models", `${runner}.${field} must be an array of model ids`);
			const ids: string[] = [];
			for (const item of value) {
				const id = typeof item === "string" ? item.trim() : item;
				if (!validModelId(id)) throw new ModelSettingsError("invalid_model_id", `invalid model id in ${runner}.${field}`);
				if (!ids.includes(id)) ids.push(id);
			}
			return ids;
		};
		const custom = list(entry.custom, "custom");
		const known = new Set(runnerCatalog(runner, custom, home).map((m) => m.id));
		const enabled = entry.enabled === undefined || entry.enabled === null ? null : list(entry.enabled, "enabled");
		for (const id of enabled ?? []) {
			if (!known.has(id)) throw new ModelSettingsError("unknown_model", `${id} is not a known ${runner} model; add it as a custom id first`);
		}
		out[runner] = { enabled, custom };
	}
	return out;
}
