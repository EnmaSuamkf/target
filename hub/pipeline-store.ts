/**
 * Persistence for pipelines: the catalog entity a `command` step runs
 * (docs/pipelines.md, "Data model", "Trust", "Loading a pipeline").
 *
 * The YAML text is the source of truth. `name` is copied out of it on every
 * save, and `source_hash` is the SHA-256 of the text. Trust is a separate column,
 * `trusted_hash`: a pipeline runs only while it equals `source_hash`, so any edit
 * to the text drops trust until an operator approves the new text.
 *
 * Who may approve is decided by the caller (the server route), not here. This
 * module only takes an `approve` flag and checks that the hash it was given is
 * current. That keeps the rule "approval needs the browser session" in one place,
 * the HTTP layer, where the session is known.
 */

import * as crypto from "node:crypto";
import {
	catalogSyncSourceIncludes,
	dropCatalogSyncSource,
	mergeCatalogSyncSources,
	open,
	type CatalogSyncSource,
	type TemplateStep,
} from "./db.ts";
import { parsePipeline, sourceHash, type PipelineError, type PipelineSpec } from "./pipeline-yaml.ts";

export type PipelineOrigin = "local" | "server";

export interface Pipeline {
	id: string;
	name: string;
	tags: string[];
	/** The YAML text as written, comments included. */
	source: string;
	sourceHash: string;
	/** `sourceHash` at the moment an operator approved it. Null = never approved. */
	trustedHash: string | null;
	/** `server` copies are pushed by sync (phase 2) and are read-only locally. */
	origin: PipelineOrigin;
	syncSource: string | null;
	syncedAt: string | null;
	revoked: boolean;
	createdAt: string;
	updatedAt: string;
}

export type PipelineStoreErrorCode =
	| "invalid_pipeline"
	| "stale_hash"
	| "in_use"
	| "server_managed"
	| "invalid_bundle"
	| "unsupported_schema_version";

export class PipelineStoreError extends Error {
	readonly code: PipelineStoreErrorCode;
	/** Validator errors, for `invalid_pipeline`: every line the operator must fix. */
	readonly errors: PipelineError[];
	/** What still refers to the pipeline, for `in_use`, e.g. `step <id>` or `template <name>`. */
	readonly references: string[];

	constructor(code: PipelineStoreErrorCode, detail: { errors?: PipelineError[]; references?: string[] } = {}) {
		super(code);
		this.name = "PipelineStoreError";
		this.code = code;
		this.errors = detail.errors ?? [];
		this.references = detail.references ?? [];
	}
}

/**
 * A pipeline runs only when an operator has approved exactly this text. The
 * comparison is on the hash, so an approval never covers text the operator has
 * not seen.
 */
export function isTrusted(pipeline: Pipeline): boolean {
	return pipeline.trustedHash !== null && pipeline.trustedHash === pipeline.sourceHash;
}

function normalizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	return [...new Set(tags.map((t) => String(t).trim()).filter((t) => t !== ""))];
}

function rowToPipeline(row: Record<string, unknown>): Pipeline {
	return {
		id: String(row.id),
		name: String(row.name),
		tags: parseTags(row.tags),
		source: String(row.source),
		sourceHash: String(row.source_hash),
		trustedHash: row.trusted_hash == null ? null : String(row.trusted_hash),
		origin: row.origin === "server" ? "server" : "local",
		syncSource: row.sync_source == null ? null : String(row.sync_source),
		syncedAt: row.synced_at == null ? null : String(row.synced_at),
		revoked: Number(row.revoked ?? 0) === 1,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function parseTags(value: unknown): string[] {
	try {
		const parsed: unknown = JSON.parse(String(value ?? "[]"));
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

/** Validates the text and returns its parsed spec, or throws with every validator error. */
function requireValidSpec(source: string): PipelineSpec {
	const parsed = parsePipeline(source);
	if (!parsed.ok) throw new PipelineStoreError("invalid_pipeline", { errors: parsed.errors });
	return parsed.pipeline;
}

export function getPipeline(id: string): Pipeline | null {
	const row = open().prepare("SELECT * FROM pipelines WHERE id = ?").get(id);
	return row ? rowToPipeline(row as Record<string, unknown>) : null;
}

export function listPipelines(): Pipeline[] {
	const rows = open().prepare("SELECT * FROM pipelines ORDER BY created_at DESC, rowid DESC").all();
	return (rows as Record<string, unknown>[]).map(rowToPipeline);
}

/**
 * Creates a pipeline from its YAML text. The name comes from the text. It is
 * trusted only when `approve` is set, which the caller sets for a browser
 * session and never for a bearer token (see docs/pipelines.md, "Trust").
 */
export function insertPipeline(input: { source: string; tags?: unknown; approve?: boolean }): Pipeline {
	const spec = requireValidSpec(input.source);
	const hash = sourceHash(input.source);
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	open()
		.prepare(
			`INSERT INTO pipelines (id, name, tags, source, source_hash, trusted_hash, origin, sync_source, synced_at, revoked, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'local', NULL, NULL, 0, ?, ?)`,
		)
		.run(
			id,
			spec.name,
			JSON.stringify(normalizeTags(input.tags)),
			input.source,
			hash,
			input.approve === true ? hash : null,
			now,
			now,
		);
	return getPipeline(id)!;
}

/**
 * Saves a new text and/or tags. Changing the text changes its hash, so trust is
 * dropped unless this save approves the new text. Saving the same text keeps an
 * earlier approval, so re-saving tags does not make an operator approve again.
 * A `server` copy is read-only (phase 2 writes those through sync).
 */
export function updatePipeline(
	id: string,
	input: { source?: string; tags?: unknown; approve?: boolean },
): Pipeline | null {
	const existing = getPipeline(id);
	if (!existing) return null;
	if (existing.origin === "server") throw new PipelineStoreError("server_managed");

	let source = existing.source;
	let name = existing.name;
	let hash = existing.sourceHash;
	if (input.source !== undefined) {
		const spec = requireValidSpec(input.source);
		source = input.source;
		name = spec.name;
		hash = sourceHash(source);
	}
	const tags = input.tags !== undefined ? normalizeTags(input.tags) : existing.tags;
	const textChanged = hash !== existing.sourceHash;
	const trustedHash = input.approve === true ? hash : textChanged ? null : existing.trustedHash;
	const updatedAt = new Date().toISOString();
	open()
		.prepare("UPDATE pipelines SET name = ?, tags = ?, source = ?, source_hash = ?, trusted_hash = ?, updated_at = ? WHERE id = ?")
		.run(name, JSON.stringify(tags), source, hash, trustedHash, updatedAt, id);
	return getPipeline(id);
}

/**
 * Records an operator's approval of a pipeline's text. The caller passes the
 * hash the operator looked at, and it must still be current: if the text was
 * edited in between, the approval is refused rather than applied to text the
 * operator did not see.
 */
export function approvePipeline(id: string, approvedHash: string): Pipeline | null {
	const existing = getPipeline(id);
	if (!existing) return null;
	if (approvedHash !== existing.sourceHash) throw new PipelineStoreError("stale_hash");
	open()
		.prepare("UPDATE pipelines SET trusted_hash = ?, updated_at = ? WHERE id = ?")
		.run(existing.sourceHash, new Date().toISOString(), id);
	return getPipeline(id);
}

/**
 * What refers to a pipeline: the command steps that run it (by step id) and the
 * templates whose steps name it (by template name). Both empty means nothing
 * uses it and it can be deleted.
 */
export function pipelineUsage(id: string): { steps: string[]; templates: string[] } {
	const database = open();
	const steps = (database.prepare("SELECT id FROM steps WHERE pipeline_id = ?").all(id) as Record<string, unknown>[]).map(
		(row) => String(row.id),
	);
	const templates: string[] = [];
	const rows = database.prepare("SELECT name, steps FROM templates").all() as Record<string, unknown>[];
	for (const row of rows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(row.steps ?? "[]"));
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;
		if (parsed.some((s) => (s as Partial<TemplateStep> | null)?.pipelineId === id)) templates.push(String(row.name));
	}
	return { steps, templates };
}

/** `pipelineUsage` as the labels a refusal reports: `step <id>` and `template <name>`. */
export function pipelineReferences(id: string): string[] {
	const usage = pipelineUsage(id);
	return [...usage.steps.map((s) => `step ${s}`), ...usage.templates.map((t) => `template ${t}`)];
}

/**
 * Deletes a pipeline. Refused, with what still refers to it, while any step or
 * template uses it. A `server` copy is refused too, unless sync is the caller
 * (`allowServerManaged`), because the server owns it.
 */
export function deletePipeline(id: string, options: { allowServerManaged?: boolean } = {}): boolean {
	const existing = getPipeline(id);
	if (!existing) return false;
	if (existing.origin === "server" && !options.allowServerManaged) throw new PipelineStoreError("server_managed");
	const references = pipelineReferences(id);
	if (references.length > 0) throw new PipelineStoreError("in_use", { references });
	return open().prepare("DELETE FROM pipelines WHERE id = ?").run(id).changes > 0;
}

/**
 * Checks a command step's inputs against the pipeline's declaration. Returns
 * the problems, empty when the inputs are acceptable. A declared input that is
 * required and has no default must be given; an input the pipeline does not
 * declare is always an error, so a typo is never silently dropped.
 */
export function pipelineInputProblems(spec: PipelineSpec, inputs: Record<string, string>): string[] {
	const problems: string[] = [];
	for (const key of Object.keys(inputs)) {
		if (!Object.hasOwn(spec.inputs, key)) problems.push(`unknown input "${key}"`);
	}
	for (const [name, declared] of Object.entries(spec.inputs)) {
		if (declared.required && declared.default === null && !Object.hasOwn(inputs, name)) {
			problems.push(`missing input "${name}"`);
		}
	}
	return problems;
}

/** The parsed spec of a stored pipeline. Null only for a row whose text no longer validates (hand-edited DB). */
export function pipelineSpec(pipeline: Pipeline): PipelineSpec | null {
	const parsed = parsePipeline(pipeline.source);
	return parsed.ok ? parsed.pipeline : null;
}

// --- Catalog sync (docs/pipelines.md, "Catalog sync") ----------------------------
//
// A server copy is written only by sync. Its trust follows the same hash rule as
// every other pipeline: `trusted_hash` is never touched by the upsert, so an
// unchanged text keeps the operator's approval, and a changed text (a new
// `source_hash`) is untrusted until an operator approves it from the browser.

/** What a sync did to one pipeline row. `hashMismatch` is set when the server's hash is not the hub's. */
export interface ServerPipelineUpsert {
	pipeline: Pipeline;
	hashMismatch: boolean;
}

/**
 * Stores a server copy. The hash is always recomputed from the received text,
 * and a server-sent hash that disagrees is reported (the computed one wins). A
 * text that does not validate is still stored, untrusted: dispatch refuses it
 * with "pipeline does not validate" (see workflow.ts `startCommandStep`), so the
 * operator sees the copy and its name rather than a silently missing pipeline.
 * Returns null, and writes nothing, when `id` is a local pipeline.
 */
export function upsertServerPipeline(
	id: string,
	input: { name: string; tags?: unknown; source: string; serverHash?: unknown },
	syncSource: CatalogSyncSource,
): ServerPipelineUpsert | null {
	const existing = getPipeline(id);
	if (existing?.origin === "local") return null;
	const hash = sourceHash(input.source);
	const parsed = parsePipeline(input.source);
	const name = parsed.ok ? parsed.pipeline.name : input.name.trim() || id;
	const now = new Date().toISOString();
	const merged = mergeCatalogSyncSources(existing?.syncSource, syncSource);
	// Insert: untrusted. Update: `trusted_hash` is deliberately left out of the SET,
	// so the earlier approval is kept, and it stops matching once the hash moves.
	open()
		.prepare(
			`INSERT INTO pipelines (id, name, tags, source, source_hash, trusted_hash, origin, sync_source, synced_at, revoked, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, NULL, 'server', ?, ?, 0, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   tags = excluded.tags,
			   source = excluded.source,
			   source_hash = excluded.source_hash,
			   origin = 'server',
			   sync_source = excluded.sync_source,
			   synced_at = excluded.synced_at,
			   revoked = 0,
			   updated_at = excluded.updated_at`,
		)
		.run(id, name, JSON.stringify(normalizeTags(input.tags)), input.source, hash, merged, now, now, now);
	const pipeline = getPipeline(id)!;
	return { pipeline, hashMismatch: typeof input.serverHash === "string" && input.serverHash !== hash };
}

/** Sets a server copy's sync state: which sources still grant it, and whether it is revoked. */
export function setPipelineSyncMeta(id: string, input: { syncSource: string | null; revoked: boolean }): void {
	open()
		.prepare("UPDATE pipelines SET sync_source = ?, revoked = ?, updated_at = ? WHERE id = ?")
		.run(input.syncSource, input.revoked ? 1 : 0, new Date().toISOString(), id);
}

/** Whether a server pipeline with this sync source still counts as granted by the catalog. */
export function pipelineGrantedByCatalog(pipeline: Pipeline): boolean {
	return pipeline.origin === "server" && catalogSyncSourceIncludes(pipeline.syncSource, "catalog");
}

/** Drops the catalog source from a server copy that is no longer granted. Returns the remaining source, or null. */
export function ungrantCatalogSource(pipeline: Pipeline): string | null {
	return dropCatalogSyncSource(pipeline.syncSource);
}

// --- Bundles ----------------------------------------------------------------
//
// Same envelope as the TCP and template bundles: a kind, a schema version and
// the entries. An entry carries the YAML text, because the text is the pipeline.
// No trust, no hashes, no ids and no secret values: an import always arrives
// untrusted, and the operator approves it from the browser.

export const PIPELINE_BUNDLE_KIND = "target.pipelines";
export const PIPELINE_BUNDLE_SCHEMA_VERSION = 1;

export interface PipelineBundleEntry {
	name: string;
	tags: string[];
	source: string;
}

export interface PipelineBundle {
	kind: typeof PIPELINE_BUNDLE_KIND;
	schemaVersion: number;
	exportedAt: string;
	pipelines: PipelineBundleEntry[];
}

export function pipelineBundle(pipelines: Pipeline[]): PipelineBundle {
	return {
		kind: PIPELINE_BUNDLE_KIND,
		schemaVersion: PIPELINE_BUNDLE_SCHEMA_VERSION,
		exportedAt: new Date().toISOString(),
		pipelines: pipelines.map((p) => ({ name: p.name, tags: p.tags, source: p.source })),
	};
}

/**
 * Reads a bundle back. Every entry's text must validate, so a bad file is
 * refused whole rather than half-imported.
 */
export function parsePipelineBundle(input: unknown): PipelineBundleEntry[] {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new PipelineStoreError("invalid_bundle");
	}
	const envelope = input as Record<string, unknown>;
	if (envelope.kind !== PIPELINE_BUNDLE_KIND) throw new PipelineStoreError("invalid_bundle");
	const version = envelope.schemaVersion;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		throw new PipelineStoreError("invalid_bundle");
	}
	if (version > PIPELINE_BUNDLE_SCHEMA_VERSION) throw new PipelineStoreError("unsupported_schema_version");
	if (!Array.isArray(envelope.pipelines)) throw new PipelineStoreError("invalid_bundle");
	if (envelope.pipelines.length === 0) throw new PipelineStoreError("invalid_bundle");
	const entries: PipelineBundleEntry[] = [];
	const errors: PipelineError[] = [];
	envelope.pipelines.forEach((raw, index) => {
		const obj = (raw ?? {}) as Record<string, unknown>;
		if (typeof obj.source !== "string") {
			errors.push({ line: null, path: `pipelines[${index}].source`, message: "must be the pipeline's YAML text" });
			return;
		}
		const parsed = parsePipeline(obj.source);
		if (!parsed.ok) {
			for (const e of parsed.errors) errors.push({ ...e, path: `pipelines[${index}]${e.path ? `.${e.path}` : ""}` });
			return;
		}
		entries.push({ name: parsed.pipeline.name, tags: normalizeTags(obj.tags), source: obj.source });
	});
	if (errors.length > 0) throw new PipelineStoreError("invalid_pipeline", { errors });
	return entries;
}

/**
 * Imports bundle entries as NEW local pipelines with fresh ids, so an import can
 * never overwrite an existing row (the TCP rule). Every import is untrusted.
 * Names are not made unique: the name lives inside the text, and renaming it
 * would change the text the operator is asked to approve.
 */
export function importPipelines(entries: PipelineBundleEntry[]): Pipeline[] {
	return entries.map((entry) => insertPipeline({ source: entry.source, tags: entry.tags, approve: false }));
}
