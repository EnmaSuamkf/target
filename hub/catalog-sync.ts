/**
 * On-demand pull of the linked server's catalog (GET /api/sync/catalog).
 *
 * TCP and RCI are upserted first so template selections can resolve against
 * copies that arrived in the same response. Local rows with the same id are
 * never overwritten. Catalog-sourced copies the server no longer grants lose
 * the `catalog` source and are deleted, or marked revoked when a workflow
 * still references them.
 */
import { deviceHeaders, handleDeviceAuthResponse, remoteAuth } from "./device-auth.ts";
import { getDeviceLinkStatus } from "./device-link.ts";
import {
	catalogSyncSourceIncludes,
	deleteTemplate,
	dropCatalogSyncSource,
	getTemplate,
	listTemplates,
	open,
	setTemplateSyncMeta,
	upsertServerTemplate,
} from "./db.ts";
import {
	deleteResourceSet,
	getResourceSet,
	isResourceSetAttachedToWorkflow,
	listResourceSets,
	setResourceSetSyncMeta,
	upsertServerResourceSet,
} from "./rci-store.ts";
import { authHeaders, syncFetch, syncUrl, type FetchLike } from "./sync.ts";
import {
	deleteTcp,
	getTcp,
	isTcpAttachedToWorkflow,
	listTcps,
	setTcpSyncMeta,
	upsertServerTcp,
} from "./tcp-store.ts";

const CATALOG_SYNC_STATUS_KEY = "catalog_sync";
const CATALOG_PATH = "/api/sync/catalog";

export class CatalogSyncError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "CatalogSyncError";
		this.code = code;
	}
}

export interface CatalogSyncDomainResult {
	added: number;
	updated: number;
	removed: number;
	revoked: number;
	skipped: number;
	syncedAt: string;
}

export interface CatalogSyncResult {
	templates: CatalogSyncDomainResult;
	tcp_tools: CatalogSyncDomainResult;
	resource_sets: CatalogSyncDomainResult;
}

export interface CatalogSyncStatus {
	syncedAt: string | null;
	templates: CatalogSyncDomainResult | null;
	tcp_tools: CatalogSyncDomainResult | null;
	resource_sets: CatalogSyncDomainResult | null;
}

export interface CatalogSyncOptions {
	fetchImpl?: FetchLike;
}

interface CatalogItem {
	id: string;
	name: string;
	updatedAt?: string;
	data?: Record<string, unknown>;
}

interface CatalogResponse {
	allowed?: { templates?: boolean; tcp_tools?: boolean; resource_sets?: boolean };
	templates?: CatalogItem[];
	tcp_tools?: CatalogItem[];
	resource_sets?: CatalogItem[];
}

let catalogFetchOverride: FetchLike | null = null;

/** Test hook so HTTP route tests can stub the server catalog pull. */
export function setCatalogSyncFetchForTests(fetchImpl: FetchLike | null): void {
	catalogFetchOverride = fetchImpl;
}

function emptyDomain(syncedAt: string): CatalogSyncDomainResult {
	return { added: 0, updated: 0, removed: 0, revoked: 0, skipped: 0, syncedAt };
}

function asItems(value: unknown): CatalogItem[] {
	if (!Array.isArray(value)) return [];
	const out: CatalogItem[] = [];
	for (const raw of value) {
		if (raw == null || typeof raw !== "object") continue;
		const obj = raw as Record<string, unknown>;
		const id = typeof obj.id === "string" ? obj.id.trim() : "";
		const name = typeof obj.name === "string" ? obj.name : "";
		if (!id) continue;
		out.push({
			id,
			name,
			updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
			data: obj.data && typeof obj.data === "object" && !Array.isArray(obj.data) ? (obj.data as Record<string, unknown>) : {},
		});
	}
	return out;
}

function parseFlag(value: unknown): boolean | undefined {
	if (value === true) return true;
	if (value === false) return false;
	return undefined;
}

function parseCatalog(payload: unknown): CatalogResponse {
	if (payload == null || typeof payload !== "object") return {};
	const obj = payload as Record<string, unknown>;
	const allowedRaw = obj.allowed && typeof obj.allowed === "object" ? (obj.allowed as Record<string, unknown>) : {};
	return {
		allowed: {
			templates: parseFlag(allowedRaw.templates),
			tcp_tools: parseFlag(allowedRaw.tcp_tools),
			resource_sets: parseFlag(allowedRaw.resource_sets),
		},
		templates: asItems(obj.templates),
		tcp_tools: asItems(obj.tcp_tools),
		resource_sets: asItems(obj.resource_sets),
	};
}

function domainCameBack(allowed: boolean | undefined): boolean {
	return allowed === true || allowed === false;
}

export function getCatalogSyncStatus(): CatalogSyncStatus {
	const row = open().prepare("SELECT * FROM settings WHERE key = ?").get(CATALOG_SYNC_STATUS_KEY) as
		| Record<string, unknown>
		| undefined;
	if (!row) return { syncedAt: null, templates: null, tcp_tools: null, resource_sets: null };
	try {
		const value = JSON.parse(String(row.value)) as CatalogSyncResult;
		return {
			syncedAt: value.templates?.syncedAt ?? value.tcp_tools?.syncedAt ?? value.resource_sets?.syncedAt ?? null,
			templates: value.templates ?? null,
			tcp_tools: value.tcp_tools ?? null,
			resource_sets: value.resource_sets ?? null,
		};
	} catch {
		return { syncedAt: null, templates: null, tcp_tools: null, resource_sets: null };
	}
}

function saveCatalogSyncStatus(result: CatalogSyncResult): void {
	const now = new Date().toISOString();
	open()
		.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.run(CATALOG_SYNC_STATUS_KEY, JSON.stringify(result), now);
}

function upsertTcps(items: CatalogItem[], syncedAt: string): CatalogSyncDomainResult {
	const stats = emptyDomain(syncedAt);
	for (const item of items) {
		const existing = getTcp(item.id);
		if (existing?.origin === "local") {
			stats.skipped += 1;
			continue;
		}
		const wasServer = existing?.origin === "server";
		upsertServerTcp(
			item.id,
			{ name: item.name, tags: item.data?.tags, tools: item.data?.tools },
			"catalog",
		);
		if (wasServer) stats.updated += 1;
		else stats.added += 1;
	}
	return stats;
}

function upsertResourceSets(items: CatalogItem[], syncedAt: string): CatalogSyncDomainResult {
	const stats = emptyDomain(syncedAt);
	for (const item of items) {
		const existing = getResourceSet(item.id);
		if (existing?.origin === "local") {
			stats.skipped += 1;
			continue;
		}
		const wasServer = existing?.origin === "server";
		upsertServerResourceSet(
			item.id,
			{ name: item.name, tags: item.data?.tags, resources: item.data?.resources },
			"catalog",
		);
		if (wasServer) stats.updated += 1;
		else stats.added += 1;
	}
	return stats;
}

function upsertTemplates(items: CatalogItem[], syncedAt: string): CatalogSyncDomainResult {
	const tcpIds = new Set(listTcps().map((tcp) => tcp.id));
	const resourceSetIds = new Set(listResourceSets().map((set) => set.id));
	const stats = emptyDomain(syncedAt);
	for (const item of items) {
		const existing = getTemplate(item.id);
		if (existing?.origin === "local") {
			stats.skipped += 1;
			continue;
		}
		const data = item.data ?? {};
		const tcpSelections = Array.isArray(data.tcpSelections)
			? data.tcpSelections.filter(
					(selection) =>
						selection &&
						typeof selection === "object" &&
						tcpIds.has(String((selection as { tcpId?: unknown }).tcpId ?? "")),
				)
			: [];
		const resourceSelections = Array.isArray(data.resourceSelections)
			? data.resourceSelections.filter(
					(selection) =>
						selection &&
						typeof selection === "object" &&
						resourceSetIds.has(String((selection as { resourceSetId?: unknown }).resourceSetId ?? "")),
				)
			: [];
		const wasServer = existing?.origin === "server";
		upsertServerTemplate(
			item.id,
			{
				name: item.name,
				tags: data.tags,
				steps: data.steps,
				tcpSelections,
				resourceSelections,
			},
			"catalog",
		);
		if (wasServer) stats.updated += 1;
		else stats.added += 1;
	}
	return stats;
}

function pruneTcps(grantedIds: Set<string>, stats: CatalogSyncDomainResult): void {
	for (const tcp of listTcps()) {
		if (tcp.origin !== "server" || !catalogSyncSourceIncludes(tcp.syncSource, "catalog")) continue;
		if (grantedIds.has(tcp.id)) continue;
		const next = dropCatalogSyncSource(tcp.syncSource);
		if (next) {
			setTcpSyncMeta(tcp.id, { syncSource: next, revoked: tcp.revoked });
			continue;
		}
		if (isTcpAttachedToWorkflow(tcp.id)) {
			setTcpSyncMeta(tcp.id, { syncSource: null, revoked: true });
			stats.revoked += 1;
		} else {
			deleteTcp(tcp.id, { allowServerManaged: true });
			stats.removed += 1;
		}
	}
}

function pruneResourceSets(grantedIds: Set<string>, stats: CatalogSyncDomainResult): void {
	for (const set of listResourceSets()) {
		if (set.origin !== "server" || !catalogSyncSourceIncludes(set.syncSource, "catalog")) continue;
		if (grantedIds.has(set.id)) continue;
		const next = dropCatalogSyncSource(set.syncSource);
		if (next) {
			setResourceSetSyncMeta(set.id, { syncSource: next, revoked: set.revoked });
			continue;
		}
		if (isResourceSetAttachedToWorkflow(set.id)) {
			setResourceSetSyncMeta(set.id, { syncSource: null, revoked: true });
			stats.revoked += 1;
		} else {
			deleteResourceSet(set.id, { allowServerManaged: true });
			stats.removed += 1;
		}
	}
}

function pruneTemplates(grantedIds: Set<string>, stats: CatalogSyncDomainResult): void {
	for (const template of listTemplates()) {
		if (template.origin !== "server" || !catalogSyncSourceIncludes(template.syncSource, "catalog")) continue;
		if (grantedIds.has(template.id)) continue;
		const next = dropCatalogSyncSource(template.syncSource);
		if (next) {
			setTemplateSyncMeta(template.id, { syncSource: next, revoked: template.revoked });
			continue;
		}
		deleteTemplate(template.id, { allowServerManaged: true });
		stats.removed += 1;
	}
}

async function pullCatalog(fetchImpl: FetchLike): Promise<CatalogResponse> {
	const status = getDeviceLinkStatus();
	if (status.state !== "connected") throw new CatalogSyncError("not_linked");
	const auth = remoteAuth("sync:write");
	if (auth.kind !== "device") throw new CatalogSyncError("not_linked");
	const headers = authHeaders("", "GET", CATALOG_PATH);
	if (!deviceHeaders("GET", CATALOG_PATH, "")) {
		throw new CatalogSyncError("not_linked");
	}
	const res = await syncFetch(syncUrl(auth.origin, CATALOG_PATH), { headers }, fetchImpl);
	const errorBody = !res.ok ? await res.json().catch(() => null) : null;
	const errorCode = errorBody && typeof errorBody === "object" ? (errorBody as { error?: unknown }).error : undefined;
	handleDeviceAuthResponse(res.status, errorCode);
	if (res.status === 404) throw new CatalogSyncError("catalog_sync_unsupported");
	if (res.status === 403 && errorCode === "owner_required") throw new CatalogSyncError("owner_required");
	if (res.status === 401 || res.status === 403) throw new CatalogSyncError("forbidden");
	if (!res.ok) throw new CatalogSyncError(`catalog_sync_failed_${res.status}`);
	return parseCatalog(await res.json());
}

export async function syncServerCatalog(options: CatalogSyncOptions = {}): Promise<CatalogSyncResult> {
	const fetchImpl = options.fetchImpl ?? catalogFetchOverride ?? globalThis.fetch;
	const catalog = await pullCatalog(fetchImpl);
	const syncedAt = new Date().toISOString();
	const result: CatalogSyncResult = {
		templates: emptyDomain(syncedAt),
		tcp_tools: emptyDomain(syncedAt),
		resource_sets: emptyDomain(syncedAt),
	};
	const db = open();
	db.exec("BEGIN");
	try {
		if (domainCameBack(catalog.allowed?.tcp_tools)) {
			result.tcp_tools = upsertTcps(catalog.tcp_tools ?? [], syncedAt);
			pruneTcps(new Set((catalog.tcp_tools ?? []).map((item) => item.id)), result.tcp_tools);
		}
		if (domainCameBack(catalog.allowed?.resource_sets)) {
			result.resource_sets = upsertResourceSets(catalog.resource_sets ?? [], syncedAt);
			pruneResourceSets(new Set((catalog.resource_sets ?? []).map((item) => item.id)), result.resource_sets);
		}
		if (domainCameBack(catalog.allowed?.templates)) {
			result.templates = upsertTemplates(catalog.templates ?? [], syncedAt);
			pruneTemplates(new Set((catalog.templates ?? []).map((item) => item.id)), result.templates);
		}
		saveCatalogSyncStatus(result);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	return result;
}
