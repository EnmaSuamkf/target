/**
 * Device-owner permissions mirrored from target-server register/heartbeat.
 *
 * The server already sends `{ id, permissions, catalog, granted }` as `owner`.
 * This module is the hub's cache of that payload: in-memory, plus a settings
 * row so a restart still knows the last role. Enforcement and the UI live
 * elsewhere; this file only records, expires, and answers "what is allowed".
 */
import { loadSyncConfig } from "./config.ts";
import {
	clearOwnerPermissionsJson,
	getOwnerPermissionsJson,
	saveOwnerPermissionsJson,
} from "./db.ts";
import { getDeviceLinkStatus } from "./device-link.ts";

export interface PermissionGroup {
	id: string;
	scope: string;
	label: string;
	description: string;
	permissions: Array<{ id: string; label: string; description: string }>;
}

export interface OwnerSnapshot {
	ownerId: string;
	permissions: string[];
	granted: { groups: PermissionGroup[] };
	deviceId: string;
	origin: string;
	receivedAt: string;
}

export type PermissionMode =
	| { mode: "unrestricted"; reason: "not_linked" }
	| { mode: "enforced"; permissions: Set<string>; snapshot: OwnerSnapshot }
	| { mode: "read_only"; reason: "stale" | "no_owner" | "relink_required" | "awaiting_authorization" };

/** Floor matching D2: 3 × default sync interval (10s → 30s). */
const MIN_GRACE_MS = 30_000;

let loaded = false;
/** True only after a live register/heartbeat in this process. Disk loads start stale. */
let live = false;
let memory: OwnerSnapshot | null = null;

function graceMs(): number {
	return Math.max(MIN_GRACE_MS, 3 * loadSyncConfig().intervalMs);
}

function parsePermissionEntry(raw: unknown): { id: string; label: string; description: string } | null {
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as Record<string, unknown>;
	if (typeof entry.id !== "string" || entry.id.length === 0) return null;
	return {
		id: entry.id,
		label: typeof entry.label === "string" ? entry.label : entry.id,
		description: typeof entry.description === "string" ? entry.description : "",
	};
}

function parseGroup(raw: unknown): PermissionGroup | null {
	if (!raw || typeof raw !== "object") return null;
	const group = raw as Record<string, unknown>;
	if (typeof group.id !== "string" || typeof group.label !== "string") return null;
	const permissions = Array.isArray(group.permissions)
		? group.permissions.map(parsePermissionEntry).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
		: [];
	return {
		id: group.id,
		scope: typeof group.scope === "string" ? group.scope : "",
		label: group.label,
		description: typeof group.description === "string" ? group.description : "",
		permissions,
	};
}

function parseGranted(raw: unknown): { groups: PermissionGroup[] } {
	if (!raw || typeof raw !== "object") return { groups: [] };
	const groups = (raw as { groups?: unknown }).groups;
	if (!Array.isArray(groups)) return { groups: [] };
	return { groups: groups.map(parseGroup).filter((group): group is PermissionGroup => group !== null) };
}

function parsePersistedSnapshot(raw: unknown): OwnerSnapshot | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.ownerId !== "string" || obj.ownerId.length === 0) return null;
	if (!Array.isArray(obj.permissions)) return null;
	if (typeof obj.deviceId !== "string" || typeof obj.origin !== "string" || typeof obj.receivedAt !== "string") {
		return null;
	}
	return {
		ownerId: obj.ownerId,
		permissions: obj.permissions.filter((id): id is string => typeof id === "string" && id.length > 0),
		granted: parseGranted(obj.granted),
		deviceId: obj.deviceId,
		origin: obj.origin,
		receivedAt: obj.receivedAt,
	};
}

function parseIncomingOwner(raw: unknown, deviceId: string, origin: string): OwnerSnapshot | null | undefined {
	if (raw === undefined) return undefined;
	if (raw === null) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const ownerId = typeof obj.id === "string" ? obj.id.trim() : "";
	if (!ownerId) return undefined;
	if (!Array.isArray(obj.permissions)) return undefined;
	return {
		ownerId,
		permissions: obj.permissions.filter((id): id is string => typeof id === "string" && id.length > 0),
		granted: parseGranted(obj.granted),
		deviceId,
		origin,
		receivedAt: new Date().toISOString(),
	};
}

function persist(snapshot: OwnerSnapshot | null): void {
	if (!snapshot) {
		clearOwnerPermissionsJson();
		return;
	}
	saveOwnerPermissionsJson(JSON.stringify(snapshot));
}

function ensureLoaded(): void {
	if (loaded) return;
	loaded = true;
	live = false;
	try {
		const json = getOwnerPermissionsJson();
		if (!json) {
			memory = null;
			return;
		}
		memory = parsePersistedSnapshot(JSON.parse(json) as unknown);
	} catch {
		memory = null;
	}
}

function snapshotIsStale(snapshot: OwnerSnapshot): boolean {
	if (!live) return true;
	const received = Date.parse(snapshot.receivedAt);
	if (!Number.isFinite(received)) return true;
	return Date.now() - received > graceMs();
}

function dropIfIdentityChanged(deviceId: string | null, ownerId?: string): void {
	if (!memory) return;
	if (deviceId !== null && memory.deviceId !== deviceId) {
		memory = null;
		live = false;
		persist(null);
		return;
	}
	if (ownerId !== undefined && memory.ownerId !== ownerId) {
		memory = null;
		live = false;
		persist(null);
	}
}

/** Store a server `owner` payload. Missing or malformed input is ignored. */
export function recordOwnerSnapshot(raw: unknown, deviceId: string, origin: string): void {
	try {
		ensureLoaded();
		const parsed = parseIncomingOwner(raw, deviceId, origin);
		if (parsed === undefined) return;
		if (parsed === null) {
			memory = null;
			live = true;
			persist(null);
			return;
		}
		dropIfIdentityChanged(parsed.deviceId, parsed.ownerId);
		memory = parsed;
		live = true;
		persist(parsed);
	} catch {
		// Register/heartbeat must keep going if the owner field is garbage.
	}
}

export function resolvePermissionMode(): PermissionMode {
	ensureLoaded();
	const status = getDeviceLinkStatus();
	if (status.state === "local_unconfigured") {
		return { mode: "unrestricted", reason: "not_linked" };
	}
	if (status.state === "relink_required") {
		return { mode: "read_only", reason: "relink_required" };
	}
	if (status.state === "awaiting_authorization") {
		return { mode: "read_only", reason: "awaiting_authorization" };
	}

	dropIfIdentityChanged(status.deviceId ?? "");
	if (!memory) {
		return { mode: "read_only", reason: "no_owner" };
	}
	if (snapshotIsStale(memory)) {
		return { mode: "read_only", reason: "stale" };
	}
	return {
		mode: "enforced",
		permissions: new Set(memory.permissions),
		snapshot: memory,
	};
}

/** True when any of the ids is granted. Unrestricted hubs allow every id. */
export function hasPermission(...ids: string[]): boolean {
	const mode = resolvePermissionMode();
	if (mode.mode === "unrestricted") return true;
	if (mode.mode !== "enforced") return false;
	return ids.some((id) => mode.permissions.has(id));
}

export function clearOwnerSnapshot(): void {
	try {
		loaded = true;
		live = false;
		memory = null;
		persist(null);
	} catch {
		loaded = true;
		live = false;
		memory = null;
	}
}
