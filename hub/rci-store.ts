/**
 * Persistence for RCI (Resources Context Injection): Resource Sets and their
 * workflow attachments.
 *
 * A Resource Set is a named group of resources — skills, agent definitions and
 * reference documents, all of them Markdown. A skill or an agent is usually a
 * whole folder as it ships on disk (its SKILL.md or AGENT.md plus everything
 * beside it: references, evals, scripts); a document is often a single `.md`.
 * Either way it is carried here as data rather than installed into the agent:
 * nothing lands in `~/.claude/skills` or `~/.claude/agents`, and the set is
 * materialised and quoted into the conversation only when a workflow that
 * attached it actually runs. See `rci-catalog.ts` for that half.
 */
import { open } from "./db.ts";
import {
	type ResourceSelection,
	mergeResourceSelections,
	normalizeResourceSelections,
	parseStoredResourceNames,
	selectionsAllResources,
	selectionsToResourceSetIds,
	resourceSetIdsToSelections,
} from "./rci-selection.ts";

export type { ResourceSelection } from "./rci-selection.ts";
export {
	normalizeResourceSelections,
	sameResourceSelections,
	selectionsAllResources,
	selectionsToResourceSetIds,
	resourceSetIdsToSelections,
} from "./rci-selection.ts";

/** One file that travels with a resource, path relative to the resource's own folder. */
export interface ResourceFile {
	path: string;
	content: string;
}

/**
 * What a resource is, which is only ever a labelling question: all three are
 * Markdown injected the same way. The kind decides how the injected block is
 * introduced to the agent — "here is a skill" reads differently from "here is
 * an agent definition" — and gives the operator something to sort by.
 */
export type ResourceKind = "skill" | "agent" | "doc";

export const RESOURCE_KINDS: ResourceKind[] = ["skill", "agent", "doc"];

export interface Resource {
	name: string;
	description: string;
	kind: ResourceKind;
	/**
	 * File name the body is written back as when materialised — `SKILL.md`,
	 * `AGENT.md`, `code-reviewer.md`. Kept from the import because a subagent
	 * definition is identified by its file name, so renaming it to a generic
	 * `AGENT.md` would lose which agent it is.
	 */
	entryFile: string;
	/** The body of the Markdown file — what actually gets injected. */
	content: string;
	/** Everything else in the folder: references/, evals/, scripts/, assets. */
	files: ResourceFile[];
}

export interface ResourceSet {
	id: string;
	name: string;
	tags: string[];
	resources: Resource[];
	createdAt: string;
	updatedAt: string;
}


export function ensureRciSchema(): void {
	const db = open();
	// Tables written under the feature's earlier name (SCI — Skills Sets) are
	// carried over rather than left orphaned beside the new ones: an imported
	// skill folder is the expensive thing here, and a rename is no reason to
	// make the operator import it twice. Same shape, so a rename is all it takes.
	const tables = new Set(
		(
			db
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'table'
					 AND name IN ('skill_sets', 'resource_sets', 'workflow_skill_sets', 'workflow_resource_sets')`,
				)
				.all() as Record<string, unknown>[]
		).map((row) => String(row.name)),
	);
	if (tables.has("skill_sets") && !tables.has("resource_sets")) {
		db.exec(`
			ALTER TABLE skill_sets RENAME TO resource_sets;
			ALTER TABLE resource_sets RENAME COLUMN skills TO resources;
		`);
	}
	if (tables.has("workflow_skill_sets") && !tables.has("workflow_resource_sets")) {
		db.exec(`
			ALTER TABLE workflow_skill_sets RENAME TO workflow_resource_sets;
			ALTER TABLE workflow_resource_sets RENAME COLUMN skill_set_id TO resource_set_id;
			ALTER TABLE workflow_resource_sets RENAME COLUMN skill_names TO resource_names;
		`);
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS resource_sets (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '[]',
			resources TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS workflow_resource_sets (
			workflow_id TEXT NOT NULL,
			resource_set_id TEXT NOT NULL,
			resource_names TEXT,
			order_index INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (workflow_id, resource_set_id)
		);
	`);
}

function normalizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	return tags.map((t) => String(t).trim()).filter((t) => t !== "");
}

function normalizeResourceFiles(files: unknown): ResourceFile[] {
	if (!Array.isArray(files)) return [];
	const seen = new Set<string>();
	const out: ResourceFile[] = [];
	for (const raw of files) {
		const obj = (raw ?? {}) as Record<string, unknown>;
		const path = typeof obj.path === "string" ? normalizeRelativePath(obj.path) : "";
		if (path === "" || seen.has(path)) continue;
		seen.add(path);
		out.push({ path, content: typeof obj.content === "string" ? obj.content : String(obj.content ?? "") });
	}
	return out;
}

/**
 * Keeps a bundled file's path inside its resource folder. A bundle is a file an
 * operator can hand-edit and re-import, so `../../.ssh/authorized_keys` is a
 * path this has to refuse rather than trust — materialisation writes these to
 * disk.
 */
export function normalizeRelativePath(raw: string): string {
	const cleaned = String(raw).trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (cleaned === "") return "";
	const parts: string[] = [];
	for (const segment of cleaned.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") return "";
		parts.push(segment);
	}
	return parts.join("/");
}

/** Filesystem-safe folder or file name for a set or resource. */
export function resourceSlug(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "resource" : slug;
}

/** Anything unrecognised is a skill — that is what every set held before kinds existed. */
export function normalizeResourceKind(raw: unknown): ResourceKind {
	const value = String(raw ?? "").trim().toLowerCase();
	return (RESOURCE_KINDS as string[]).includes(value) ? (value as ResourceKind) : "skill";
}

/**
 * The file name a resource's body is written back as. Reduced to a bare name —
 * it is joined onto the materialisation directory, so a path here would be a
 * write outside the resource's folder — and given a Markdown default when the
 * caller has none, which is the case for every set stored before RCI carried
 * agents and docs.
 */
export function normalizeEntryFile(raw: unknown, kind: ResourceKind, name: string): string {
	const base = String(raw ?? "")
		.trim()
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
		.pop();
	if (base && /\.(md|markdown|mdx|mdown|mkd)$/i.test(base)) return base;
	return kind === "skill" ? "SKILL.md" : `${resourceSlug(name)}.md`;
}

export function normalizeResources(resources: unknown): Resource[] {
	if (!Array.isArray(resources)) return [];
	const seen = new Set<string>();
	const out: Resource[] = [];
	for (const raw of resources) {
		const obj = (raw ?? {}) as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		const content = typeof obj.content === "string" ? obj.content : "";
		if (name === "" || seen.has(name)) continue;
		seen.add(name);
		const kind = normalizeResourceKind(obj.kind);
		out.push({
			name,
			description: typeof obj.description === "string" ? obj.description.trim() : "",
			kind,
			entryFile: normalizeEntryFile(obj.entryFile, kind, name),
			content,
			files: normalizeResourceFiles(obj.files),
		});
	}
	return out;
}

function rowToResourceSet(row: Record<string, unknown>): ResourceSet {
	let tags: string[] = [];
	try {
		const parsed = JSON.parse(String(row.tags ?? "[]"));
		if (Array.isArray(parsed)) tags = parsed.map((t) => String(t));
	} catch {
		// tolerate malformed data
	}
	let resources: Resource[] = [];
	try {
		resources = normalizeResources(JSON.parse(String(row.resources ?? "[]")));
	} catch {
		// tolerate malformed data
	}
	return {
		id: String(row.id),
		name: String(row.name),
		tags,
		resources,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export function insertResourceSet(input: { name: string; tags?: unknown; resources?: unknown }): ResourceSet {
	ensureRciSchema();
	const now = new Date().toISOString();
	const set: ResourceSet = {
		id: crypto.randomUUID(),
		name: input.name.trim(),
		tags: normalizeTags(input.tags),
		resources: normalizeResources(input.resources),
		createdAt: now,
		updatedAt: now,
	};
	open()
		.prepare(`INSERT INTO resource_sets (id, name, tags, resources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(set.id, set.name, JSON.stringify(set.tags), JSON.stringify(set.resources), set.createdAt, set.updatedAt);
	return set;
}

export function getResourceSet(id: string): ResourceSet | null {
	ensureRciSchema();
	const row = open().prepare("SELECT * FROM resource_sets WHERE id = ?").get(id);
	return row ? rowToResourceSet(row as Record<string, unknown>) : null;
}

export function listResourceSets(): ResourceSet[] {
	ensureRciSchema();
	const rows = open().prepare("SELECT * FROM resource_sets ORDER BY created_at DESC, rowid DESC").all();
	return (rows as Record<string, unknown>[]).map(rowToResourceSet);
}

export function updateResourceSet(id: string, input: { name?: string; tags?: unknown; resources?: unknown }): ResourceSet | null {
	const existing = getResourceSet(id);
	if (!existing) return null;
	const name = input.name !== undefined ? input.name.trim() : existing.name;
	const tags = input.tags !== undefined ? normalizeTags(input.tags) : existing.tags;
	const resources = input.resources !== undefined ? normalizeResources(input.resources) : existing.resources;
	const updatedAt = new Date().toISOString();
	open()
		.prepare("UPDATE resource_sets SET name = ?, tags = ?, resources = ?, updated_at = ? WHERE id = ?")
		.run(name, JSON.stringify(tags), JSON.stringify(resources), updatedAt, id);
	return { ...existing, name, tags, resources, updatedAt };
}

export function deleteResourceSet(id: string): boolean {
	ensureRciSchema();
	open().prepare("DELETE FROM workflow_resource_sets WHERE resource_set_id = ?").run(id);
	return open().prepare("DELETE FROM resource_sets WHERE id = ?").run(id).changes > 0;
}

export function listWorkflowResourceSelections(workflowId: string): ResourceSelection[] {
	ensureRciSchema();
	const rows = open()
		.prepare(
			"SELECT resource_set_id, resource_names FROM workflow_resource_sets WHERE workflow_id = ? ORDER BY order_index ASC, rowid ASC",
		)
		.all(workflowId) as Record<string, unknown>[];
	return rows.map((row) => ({
		resourceSetId: String(row.resource_set_id),
		resourceNames: parseStoredResourceNames(row.resource_names),
	}));
}

export function listWorkflowResourceSetIds(workflowId: string): string[] {
	return selectionsToResourceSetIds(listWorkflowResourceSelections(workflowId));
}

export function resolveResources(set: ResourceSet, selection: ResourceSelection): Resource[] {
	if (selectionsAllResources(selection)) return set.resources;
	const allowed = new Set(selection.resourceNames ?? []);
	return set.resources.filter((resource) => allowed.has(resource.name));
}

export function listWorkflowResourceSelectionsResolved(workflowId: string): Array<{ set: ResourceSet; resources: Resource[] }> {
	const out: Array<{ set: ResourceSet; resources: Resource[] }> = [];
	for (const selection of listWorkflowResourceSelections(workflowId)) {
		const set = getResourceSet(selection.resourceSetId);
		if (!set) continue;
		const resources = resolveResources(set, selection);
		if (resources.length === 0) continue;
		out.push({ set, resources });
	}
	return out;
}

export function listWorkflowResourceSets(workflowId: string): ResourceSet[] {
	return listWorkflowResourceSelectionsResolved(workflowId).map((entry) => entry.set);
}

function validateSelections(selections: ResourceSelection[]): ResourceSelection[] {
	const normalized = normalizeResourceSelections(selections);
	const out: ResourceSelection[] = [];
	for (const selection of normalized) {
		const set = getResourceSet(selection.resourceSetId);
		if (!set) throw new Error(`unknown_resource_set:${selection.resourceSetId}`);
		if (selectionsAllResources(selection)) {
			out.push({ resourceSetId: selection.resourceSetId, resourceNames: null });
			continue;
		}
		const resourceNames = (selection.resourceNames ?? []).filter((name) => set.resources.some((resource) => resource.name === name));
		if (resourceNames.length === 0) continue;
		out.push({
			resourceSetId: selection.resourceSetId,
			resourceNames: resourceNames.length === set.resources.length ? null : resourceNames,
		});
	}
	return out;
}

export function setWorkflowResourceSelections(workflowId: string, selections: ResourceSelection[]): ResourceSelection[] {
	ensureRciSchema();
	const valid = validateSelections(selections);
	const db = open();
	db.prepare("DELETE FROM workflow_resource_sets WHERE workflow_id = ?").run(workflowId);
	const insert = db.prepare(
		"INSERT INTO workflow_resource_sets (workflow_id, resource_set_id, resource_names, order_index) VALUES (?, ?, ?, ?)",
	);
	valid.forEach((selection, index) => {
		const namesJson =
			selectionsAllResources(selection) || !selection.resourceNames ? null : JSON.stringify(selection.resourceNames);
		insert.run(workflowId, selection.resourceSetId, namesJson, index);
	});
	return valid;
}

/** Adds a template's resource selections to a workflow, merging resource subsets. */
export function applyTemplateResourcesToWorkflow(workflowId: string, templateSelections: ResourceSelection[]): ResourceSelection[] {
	const incoming = validateSelections(templateSelections);
	if (incoming.length === 0) return listWorkflowResourceSelections(workflowId);
	return setWorkflowResourceSelections(
		workflowId,
		mergeResourceSelections(listWorkflowResourceSelections(workflowId), incoming),
	);
}
