/**
 * Persistence for TCP (Tool Context Protocol) definitions and workflow attachments.
 */
import { open } from "./db.ts";
import {
	type TcpSelection,
	mergeTcpSelections,
	tcpIdsToSelections,
	normalizeTcpSelections,
	parseStoredToolNames,
	selectionsAllTools,
	selectionsToTcpIds,
} from "./tcp-selection.ts";

export type { TcpSelection } from "./tcp-selection.ts";
export {
	tcpIdsToSelections,
	normalizeTcpSelections,
	sameTcpSelections,
	selectionsAllTools,
	selectionsToTcpIds,
} from "./tcp-selection.ts";

export interface TcpToolInput {
	name: string;
	placeholder: string;
	description: string;
	required?: boolean;
}

export interface TcpTool {
	name: string;
	description: string;
	requestTemplate: string;
	inputs: TcpToolInput[];
	tokens: Record<string, string>;
}

export interface Tcp {
	id: string;
	name: string;
	tags: string[];
	tools: TcpTool[];
	createdAt: string;
	updatedAt: string;
}

export interface TcpBundleEntry {
	name: string;
	tags: string[];
	tools: TcpTool[];
}

export interface TcpBundle {
	kind: typeof TCP_BUNDLE_KIND;
	schemaVersion: number;
	exportedAt: string;
	tcps: TcpBundleEntry[];
}

export const TCP_BUNDLE_KIND = "target.tcps";
export const TCP_BUNDLE_SCHEMA_VERSION = 1;

export class TcpBundleError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "TcpBundleError";
		this.code = code;
	}
}

export function ensureTcpSchema(): void {
	const db = open();
	const tables = new Set(
		(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Record<string, unknown>[]).map((row) =>
			String(row.name),
		),
	);
	if (tables.has("mtps") && !tables.has("tcps")) db.exec("ALTER TABLE mtps RENAME TO tcps;");
	if (tables.has("workflow_mtps") && !tables.has("workflow_tcps")) db.exec("ALTER TABLE workflow_mtps RENAME TO workflow_tcps;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS tcps (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '[]',
			tools TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS workflow_tcps (
			workflow_id TEXT NOT NULL,
			tcp_id TEXT NOT NULL,
			tool_names TEXT,
			order_index INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (workflow_id, tcp_id)
		);
	`);
	const cols = new Set(
		(db.prepare("PRAGMA table_info(workflow_tcps)").all() as Record<string, unknown>[]).map((c) => String(c.name)),
	);
	if (!cols.has("tool_names")) db.exec("ALTER TABLE workflow_tcps ADD COLUMN tool_names TEXT;");
	const wfCols = new Set(
		(db.prepare("PRAGMA table_info(workflow_tcps)").all() as Record<string, unknown>[]).map((c) => String(c.name)),
	);
	if (wfCols.has("mtp_id") && !wfCols.has("tcp_id")) db.exec("ALTER TABLE workflow_tcps RENAME COLUMN mtp_id TO tcp_id;");
}

function normalizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	return tags.map((t) => String(t).trim()).filter((t) => t !== "");
}

function normalizeToolInputs(inputs: unknown): TcpToolInput[] {
	if (!Array.isArray(inputs)) return [];
	const out: TcpToolInput[] = [];
	for (const raw of inputs) {
		const obj = (raw ?? {}) as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		const placeholder = typeof obj.placeholder === "string" ? obj.placeholder.trim() : "";
		const description = typeof obj.description === "string" ? obj.description.trim() : "";
		if (name === "" || placeholder === "") continue;
		out.push({
			name,
			placeholder: placeholder.startsWith("$") ? placeholder : `$${placeholder}`,
			description,
			required: obj.required === false ? false : true,
		});
	}
	return out;
}

function normalizeTokens(tokens: unknown): Record<string, string> {
	if (tokens == null || typeof tokens !== "object" || Array.isArray(tokens)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
		const k = String(key).trim();
		if (k === "") continue;
		out[k] = typeof value === "string" ? value : String(value ?? "");
	}
	return out;
}

export function normalizeTcpTools(tools: unknown): TcpTool[] {
	if (!Array.isArray(tools)) return [];
	return tools
		.map((raw) => {
			const obj = (raw ?? {}) as Record<string, unknown>;
			const name = typeof obj.name === "string" ? obj.name.trim() : "";
			const description = typeof obj.description === "string" ? obj.description.trim() : "";
			const requestTemplate = typeof obj.requestTemplate === "string" ? obj.requestTemplate.trim() : "";
			if (name === "" || requestTemplate === "") return null;
			return {
				name,
				description,
				requestTemplate,
				inputs: normalizeToolInputs(obj.inputs),
				tokens: normalizeTokens(obj.tokens),
			} satisfies TcpTool;
		})
		.filter((v): v is TcpTool => v !== null);
}

function rowToTcp(row: Record<string, unknown>): Tcp {
	let tags: string[] = [];
	try {
		const parsed = JSON.parse(String(row.tags ?? "[]"));
		if (Array.isArray(parsed)) tags = parsed.map((t) => String(t));
	} catch {
		// tolerate malformed data
	}
	let tools: TcpTool[] = [];
	try {
		const parsed = JSON.parse(String(row.tools ?? "[]"));
		tools = normalizeTcpTools(parsed);
	} catch {
		// tolerate malformed data
	}
	return {
		id: String(row.id),
		name: String(row.name),
		tags,
		tools,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export function insertTcp(input: { name: string; tags?: unknown; tools?: unknown }): Tcp {
	ensureTcpSchema();
	const now = new Date().toISOString();
	const tcp: Tcp = {
		id: crypto.randomUUID(),
		name: input.name.trim(),
		tags: normalizeTags(input.tags),
		tools: normalizeTcpTools(input.tools),
		createdAt: now,
		updatedAt: now,
	};
	open()
		.prepare(`INSERT INTO tcps (id, name, tags, tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(tcp.id, tcp.name, JSON.stringify(tcp.tags), JSON.stringify(tcp.tools), tcp.createdAt, tcp.updatedAt);
	return tcp;
}

export function getTcp(id: string): Tcp | null {
	ensureTcpSchema();
	const row = open().prepare("SELECT * FROM tcps WHERE id = ?").get(id);
	return row ? rowToTcp(row as Record<string, unknown>) : null;
}

export function listTcps(): Tcp[] {
	ensureTcpSchema();
	const rows = open().prepare("SELECT * FROM tcps ORDER BY created_at DESC, rowid DESC").all();
	return (rows as Record<string, unknown>[]).map(rowToTcp);
}

export function updateTcp(id: string, input: { name?: string; tags?: unknown; tools?: unknown }): Tcp | null {
	const existing = getTcp(id);
	if (!existing) return null;
	const name = input.name !== undefined ? input.name.trim() : existing.name;
	const tags = input.tags !== undefined ? normalizeTags(input.tags) : existing.tags;
	const tools = input.tools !== undefined ? normalizeTcpTools(input.tools) : existing.tools;
	const updatedAt = new Date().toISOString();
	open()
		.prepare("UPDATE tcps SET name = ?, tags = ?, tools = ?, updated_at = ? WHERE id = ?")
		.run(name, JSON.stringify(tags), JSON.stringify(tools), updatedAt, id);
	return { ...existing, name, tags, tools, updatedAt };
}

export function deleteTcp(id: string): boolean {
	ensureTcpSchema();
	open().prepare("DELETE FROM workflow_tcps WHERE tcp_id = ?").run(id);
	return open().prepare("DELETE FROM tcps WHERE id = ?").run(id).changes > 0;
}

export function tcpBundle(tcps: Tcp[]): TcpBundle {
	return {
		kind: TCP_BUNDLE_KIND,
		schemaVersion: TCP_BUNDLE_SCHEMA_VERSION,
		exportedAt: new Date().toISOString(),
		tcps: tcps.map((m) => ({
			name: m.name,
			tags: m.tags,
			tools: m.tools.map((tool) => ({
				...tool,
				tokens: Object.fromEntries(Object.keys(tool.tokens).map((k) => [k, ""])),
			})),
		})),
	};
}

export function parseTcpBundle(input: unknown): TcpBundleEntry[] {
	if (input === null || typeof input !== "object") throw new TcpBundleError("invalid_bundle");
	let rawTcps: unknown;
	if (Array.isArray(input)) {
		rawTcps = input;
	} else if ("tcps" in (input as Record<string, unknown>) || "mtps" in (input as Record<string, unknown>) || "kind" in (input as Record<string, unknown>)) {
		const envelope = input as Record<string, unknown>;
		const kind = envelope.kind;
		if (kind !== TCP_BUNDLE_KIND && kind !== "target.mtps") throw new TcpBundleError("unknown_kind");
		const version = envelope.schemaVersion === undefined ? TCP_BUNDLE_SCHEMA_VERSION : envelope.schemaVersion;
		if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new TcpBundleError("invalid_bundle");
		if (version > TCP_BUNDLE_SCHEMA_VERSION) throw new TcpBundleError("unsupported_schema_version");
		const raw = envelope.tcps ?? envelope.mtps;
		if (!Array.isArray(raw)) throw new TcpBundleError("invalid_bundle");
		rawTcps = raw;
	} else {
		rawTcps = [input];
	}
	const entries: TcpBundleEntry[] = [];
	for (const raw of rawTcps as unknown[]) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TcpBundleError("invalid_bundle");
		const obj = raw as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		if (name === "") throw new TcpBundleError("invalid_bundle");
		entries.push({ name, tags: normalizeTags(obj.tags), tools: normalizeTcpTools(obj.tools) });
	}
	if (entries.length === 0) throw new TcpBundleError("empty_bundle");
	return entries;
}

function uniqueTcpName(name: string, taken: Set<string>): string {
	if (!taken.has(name)) return name;
	const cloned = `Clone - ${name}`;
	if (!taken.has(cloned)) return cloned;
	for (let n = 2; ; n += 1) {
		const candidate = `${cloned} (${n})`;
		if (!taken.has(candidate)) return candidate;
	}
}

export function importTcps(entries: TcpBundleEntry[]): Tcp[] {
	const taken = new Set(listTcps().map((m) => m.name));
	const created: Tcp[] = [];
	for (const entry of entries) {
		const name = uniqueTcpName(entry.name, taken);
		taken.add(name);
		created.push(insertTcp({ name, tags: entry.tags, tools: entry.tools }));
	}
	return created;
}

export function listWorkflowTcpSelections(workflowId: string): TcpSelection[] {
	ensureTcpSchema();
	const rows = open()
		.prepare("SELECT tcp_id, tool_names FROM workflow_tcps WHERE workflow_id = ? ORDER BY order_index ASC, rowid ASC")
		.all(workflowId) as Record<string, unknown>[];
	return rows.map((row) => ({
		tcpId: String(row.tcp_id),
		toolNames: parseStoredToolNames(row.tool_names),
	}));
}

export function listWorkflowTcpIds(workflowId: string): string[] {
	return selectionsToTcpIds(listWorkflowTcpSelections(workflowId));
}

export function resolveTcpTools(tcp: Tcp, selection: TcpSelection): TcpTool[] {
	if (selectionsAllTools(selection)) return tcp.tools;
	const allowed = new Set(selection.toolNames ?? []);
	return tcp.tools.filter((tool) => allowed.has(tool.name));
}

export function listWorkflowTcpToolSelections(workflowId: string): Array<{ tcp: Tcp; tools: TcpTool[] }> {
	const out: Array<{ tcp: Tcp; tools: TcpTool[] }> = [];
	for (const selection of listWorkflowTcpSelections(workflowId)) {
		const tcp = getTcp(selection.tcpId);
		if (!tcp) continue;
		const tools = resolveTcpTools(tcp, selection);
		if (tools.length === 0) continue;
		out.push({ tcp, tools });
	}
	return out;
}

export function listWorkflowTcps(workflowId: string): Tcp[] {
	return listWorkflowTcpToolSelections(workflowId).map((entry) => entry.tcp);
}

function validateSelections(selections: TcpSelection[]): TcpSelection[] {
	const normalized = normalizeTcpSelections(selections);
	const out: TcpSelection[] = [];
	for (const selection of normalized) {
		const tcp = getTcp(selection.tcpId);
		if (!tcp) throw new Error(`unknown_tcp:${selection.tcpId}`);
		if (selectionsAllTools(selection)) {
			out.push({ tcpId: selection.tcpId, toolNames: null });
			continue;
		}
		const toolNames = (selection.toolNames ?? []).filter((name) => tcp.tools.some((tool) => tool.name === name));
		if (toolNames.length === 0) continue;
		out.push({
			tcpId: selection.tcpId,
			toolNames: toolNames.length === tcp.tools.length ? null : toolNames,
		});
	}
	return out;
}

export function setWorkflowTcpSelections(workflowId: string, selections: TcpSelection[]): TcpSelection[] {
	ensureTcpSchema();
	const valid = validateSelections(selections);
	const db = open();
	db.prepare("DELETE FROM workflow_tcps WHERE workflow_id = ?").run(workflowId);
	const insert = db.prepare(
		"INSERT INTO workflow_tcps (workflow_id, tcp_id, tool_names, order_index) VALUES (?, ?, ?, ?)",
	);
	valid.forEach((selection, index) => {
		const toolNamesJson =
			selectionsAllTools(selection) || !selection.toolNames ? null : JSON.stringify(selection.toolNames);
		insert.run(workflowId, selection.tcpId, toolNamesJson, index);
	});
	return valid;
}

/** @deprecated Use setWorkflowTcpSelections — every id means all tools in that TCP. */
export function setWorkflowTcps(workflowId: string, tcpIds: string[]): string[] {
	return selectionsToTcpIds(setWorkflowTcpSelections(workflowId, tcpIdsToSelections(tcpIds)));
}

/** Adds template TCP selections to a workflow, merging tool subsets. */
export function applyTemplateTcpsToWorkflow(workflowId: string, templateSelections: TcpSelection[]): TcpSelection[] {
	const incoming = validateSelections(templateSelections);
	if (incoming.length === 0) return listWorkflowTcpSelections(workflowId);
	return setWorkflowTcpSelections(workflowId, mergeTcpSelections(listWorkflowTcpSelections(workflowId), incoming));
}

/** @deprecated Use applyTemplateTcpsToWorkflow with selections. */
export function applyTemplateTcpIdsToWorkflow(workflowId: string, templateTcpIds: string[]): string[] {
	return selectionsToTcpIds(applyTemplateTcpsToWorkflow(workflowId, tcpIdsToSelections(templateTcpIds)));
}
