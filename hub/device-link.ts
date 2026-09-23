/**
 * Private local identity storage for the optional target-server device link.
 *
 * This module is deliberately backend-only. Its public-status functions return
 * safe metadata; the credential readers are for the signer/transport layer and
 * must never be passed through an HTTP route, log sink, report event or UI
 * serializer.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadReportConfig, loadSyncConfig, targetDir, ensureTargetDirSecure } from "./config.ts";
import { clearOwnerSnapshot } from "./owner-permissions.ts";

const IDENTITY_FILE = "device-link.json";
const CLEANUP_FILE = "device-link-cleanup.json";
const STORAGE_VERSION = 1;
const DEVICE_SCOPES = ["ingest:write", "sync:write"] as const;

export type DeviceScope = (typeof DEVICE_SCOPES)[number];
export type DeviceLinkState =
	| "local_unconfigured"
	| "awaiting_authorization"
	| "connected"
	| "temporarily_disconnected"
	| "relink_required"
	| "disconnected_locally";

interface StoredDeviceLink {
	version: 1;
	state: Exclude<DeviceLinkState, "local_unconfigured">;
	origin: string;
	deviceName: string;
	publicKey: string;
	privateKeyPem: string;
	idempotencyKey: string;
	requestId: string | null;
	pollingCredential: string | null;
	expiresAt: string | null;
	pollAfterSeconds: number | null;
	deviceId: string | null;
	deviceSecret: string | null;
	scopes: DeviceScope[];
	credentialVersion: number | null;
	createdAt: string;
	updatedAt: string;
	connectedAt: string | null;
	lastRemoteActivityAt?: string | null;
	lastRemoteReason?: "none" | "sync_registration_failed" | "remote_transport_unavailable";
}

/** Safe shape allowed to cross the hub HTTP/UI boundary. */
export interface DeviceLinkPublicStatus {
	state: DeviceLinkState;
	origin: string | null;
	deviceName: string | null;
	deviceId: string | null;
	scopes: DeviceScope[];
	credentialVersion: number | null;
	createdAt: string | null;
	connectedAt: string | null;
	lastRemoteActivityAt: string | null;
	legacy: { reportingConfigured: boolean; syncConfigured: boolean };
	remoteCleanupPending: boolean;
	/** A stable, non-secret code suitable for an operator-facing message. */
	reason: "none" | "local_identity_unavailable" | "sync_registration_failed" | "remote_transport_unavailable";
}

/** Input consumed only by the future linking transport, never serialised to UI. */
export interface DeviceLinkInitiation {
	origin: string;
	deviceName: string;
	publicKey: { algorithm: "ed25519"; value: string };
	requestedScopes: DeviceScope[];
	idempotencyKey: string;
}

/** Private credential consumed only by the signing transport. */
export interface DeviceCredential {
	origin: string;
	deviceId: string;
	deviceSecret: string;
	privateKeyPem: string;
	scopes: DeviceScope[];
	credentialVersion: number;
}

function identityFile(): string {
	return path.join(targetDir(), IDENTITY_FILE);
}
function cleanupFile(): string { return path.join(targetDir(), CLEANUP_FILE); }

function randomBase64Url(bytes: number): string {
	return crypto.randomBytes(bytes).toString("base64url");
}

function normalizeOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("invalid_server_origin");
	}
	if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw new Error("invalid_server_origin");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
	if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("server_origin_requires_https");
	return url.origin;
}

function normalizeName(value: string): string {
	const name = value.trim();
	if (!name || name.length > 128) throw new Error("invalid_device_name");
	return name;
}

function normalizeScopes(scopes: readonly string[]): DeviceScope[] {
	const unique = [...new Set(scopes)];
	if (unique.length === 0 || unique.some((scope) => !DEVICE_SCOPES.includes(scope as DeviceScope))) {
		throw new Error("invalid_device_scopes");
	}
	return unique as DeviceScope[];
}

function looksStored(value: unknown): value is StoredDeviceLink {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		item.version === STORAGE_VERSION &&
		(item.state === "awaiting_authorization" ||
			item.state === "connected" ||
			item.state === "temporarily_disconnected" ||
			item.state === "relink_required") &&
		typeof item.origin === "string" &&
		typeof item.deviceName === "string" &&
		typeof item.publicKey === "string" &&
		typeof item.privateKeyPem === "string" &&
		typeof item.idempotencyKey === "string" &&
		Array.isArray(item.scopes)
	);
}

/** Version 0 used the same private fields; upgrade it atomically in place. */
function migrateStoredV0(value: unknown): StoredDeviceLink | null {
	if (!value || typeof value !== "object") return null;
	if ((value as Record<string, unknown>).version !== 0) return null;
	const candidate = { ...(value as Record<string, unknown>), version: STORAGE_VERSION };
	return looksStored(candidate) ? candidate : null;
}

function quarantineCorruptIdentity(): void {
	const file = identityFile();
	if (!fs.existsSync(file)) return;
	try {
		const quarantined = `${file}.corrupt-${Date.now()}-${randomBase64Url(6)}`;
		fs.renameSync(file, quarantined);
		fs.chmodSync(quarantined, 0o600);
	} catch {
		// The caller still treats unreadable content as unusable and never sends it.
	}
}

function readStored(): { link: StoredDeviceLink | null; corrupted: boolean } {
	const file = identityFile();
	try {
		if (!fs.existsSync(file)) return { link: null, corrupted: false };
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		const migrated = migrateStoredV0(raw);
		if (!looksStored(raw) && !migrated) {
			quarantineCorruptIdentity();
			return { link: null, corrupted: true };
		}
		if (migrated) writeStored(migrated);
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			// Best effort on non-POSIX filesystems.
		}
		return { link: migrated ?? (raw as StoredDeviceLink), corrupted: false };
	} catch {
		quarantineCorruptIdentity();
		return { link: null, corrupted: true };
	}
}

function writeStored(link: StoredDeviceLink): void {
	ensureTargetDirSecure();
	const file = identityFile();
	const temporary = `${file}.${randomBase64Url(12)}.tmp`;
	const fd = fs.openSync(temporary, "wx", 0o600);
	try {
		fs.writeFileSync(fd, `${JSON.stringify(link)}\n`, "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.chmodSync(temporary, 0o600);
		fs.renameSync(temporary, file);
		fs.chmodSync(file, 0o600);
	} catch (err) {
		fs.rmSync(temporary, { force: true });
		throw err;
	}
}

function legacyStatus(): DeviceLinkPublicStatus["legacy"] {
	// Legacy values remain in their existing stores. They are intentionally not
	// copied into the device identity and never become a device credential.
	const report = loadReportConfig();
	const sync = loadSyncConfig();
	return {
		reportingConfigured: report.enabled && report.url !== "",
		syncConfigured: sync.enabled && sync.url !== "",
	};
}

function toPublic(link: StoredDeviceLink | null, corrupted = false): DeviceLinkPublicStatus {
	if (!link) {
		const cleanup = getPendingRemoteCleanup();
		return {
			state: corrupted ? "relink_required" : cleanup ? "disconnected_locally" : "local_unconfigured",
			origin: null,
			deviceName: null,
			deviceId: null,
			scopes: [],
			credentialVersion: null,
			createdAt: null,
			connectedAt: null,
			lastRemoteActivityAt: null,
			legacy: legacyStatus(),
			remoteCleanupPending: Boolean(cleanup),
			reason: corrupted ? "local_identity_unavailable" : "none",
		};
	}
	return {
		state: link.state,
		origin: link.origin,
		deviceName: link.deviceName,
		deviceId: link.deviceId,
		scopes: [...link.scopes],
		credentialVersion: link.credentialVersion,
		createdAt: link.createdAt,
		connectedAt: link.connectedAt,
		lastRemoteActivityAt: link.lastRemoteActivityAt ?? null,
		legacy: legacyStatus(),
		remoteCleanupPending: false,
		reason: link.lastRemoteReason ?? "none",
	};
}

/** Inspect the optional link without exposing the private key or either secret. */
export function getDeviceLinkStatus(): DeviceLinkPublicStatus {
	const { link, corrupted } = readStored();
	return toPublic(link, corrupted);
}

/** Record a safe remote-state transition without putting transport errors on disk. */
export function setDeviceLinkRemoteState(
	state: "temporarily_disconnected" | "relink_required",
	reason: DeviceLinkPublicStatus["reason"] = "none",
): DeviceLinkPublicStatus {
	const { link } = readStored();
	if (!link) return toPublic(null, state === "relink_required");
	link.state = state;
	link.lastRemoteReason =
		state === "temporarily_disconnected" && (reason === "sync_registration_failed" || reason === "remote_transport_unavailable")
			? reason
			: "none";
	// A failed/uncertain link credential must never survive for a later retry.
	if (state === "relink_required") {
		link.requestId = null;
		link.pollingCredential = null;
		link.expiresAt = null;
		link.pollAfterSeconds = null;
		link.deviceSecret = null;
		clearOwnerSnapshot();
	}
	link.updatedAt = new Date().toISOString();
	writeStored(link);
	return toPublic(link);
}

/**
 * Explicit, non-destructive legacy migration. It makes compatibility visible
 * while keeping pre-existing report/sync URLs and Bearer tokens in their
 * original stores. A device link is created only after the operator opts in.
 */
export function migrateLegacyRemoteConfiguration(): DeviceLinkPublicStatus {
	return getDeviceLinkStatus();
}

/** Generate the local Ed25519 identity and one CSPRNG idempotency key. */
export function beginDeviceLink(input: {
	origin: string;
	deviceName: string;
	requestedScopes?: readonly DeviceScope[];
}): DeviceLinkInitiation {
	const origin = normalizeOrigin(input.origin);
	const deviceName = normalizeName(input.deviceName);
	const scopes = normalizeScopes(input.requestedScopes ?? DEVICE_SCOPES);
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	const now = new Date().toISOString();
	const link: StoredDeviceLink = {
		version: STORAGE_VERSION,
		state: "awaiting_authorization",
		origin,
		deviceName,
		publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		idempotencyKey: randomBase64Url(32),
		requestId: null,
		pollingCredential: null,
		expiresAt: null,
		pollAfterSeconds: null,
		deviceId: null,
		deviceSecret: null,
		scopes,
		credentialVersion: null,
		createdAt: now,
		updatedAt: now,
		connectedAt: null,
		lastRemoteActivityAt: null,
	};
	writeStored(link);
	return {
		origin: link.origin,
		deviceName: link.deviceName,
		publicKey: { algorithm: "ed25519", value: link.publicKey },
		requestedScopes: [...link.scopes],
		idempotencyKey: link.idempotencyKey,
	};
}

/**
 * Store the server's short-lived pairing result. This value remains private to
 * the linking transport and is removed as soon as consume succeeds or the link
 * is cancelled/deleted.
 */
export function savePendingDeviceLink(input: {
	requestId: string;
	pollingCredential: string;
	expiresAt: string;
	pollAfterSeconds: number;
}): void {
	const { link } = readStored();
	if (!link || link.state !== "awaiting_authorization") throw new Error("no_pending_device_link");
	if (!input.requestId || !input.pollingCredential || !Number.isFinite(input.pollAfterSeconds) || input.pollAfterSeconds < 1) {
		throw new Error("invalid_pending_device_link");
	}
	link.requestId = input.requestId;
	link.pollingCredential = input.pollingCredential;
	link.expiresAt = input.expiresAt;
	link.pollAfterSeconds = input.pollAfterSeconds;
	link.updatedAt = new Date().toISOString();
	writeStored(link);
}

/** Read private pairing material exclusively for the link transport. */
export function getPendingDeviceLinkTransport(): (DeviceLinkInitiation & {
	requestId: string;
	pollingCredential: string;
	expiresAt: string;
	pollAfterSeconds: number;
}) | null {
	const { link } = readStored();
	if (!link || !link.requestId || !link.pollingCredential || !link.expiresAt || !link.pollAfterSeconds) return null;
	return {
		origin: link.origin,
		deviceName: link.deviceName,
		publicKey: { algorithm: "ed25519", value: link.publicKey },
		requestedScopes: [...link.scopes],
		idempotencyKey: link.idempotencyKey,
		requestId: link.requestId,
		pollingCredential: link.pollingCredential,
		expiresAt: link.expiresAt,
		pollAfterSeconds: link.pollAfterSeconds,
	};
}

/** Commit a server-issued credential atomically after a successful consume/rotation. */
export function activateDeviceCredential(input: {
	deviceId: string;
	deviceSecret: string;
	scopes: readonly DeviceScope[];
	credentialVersion: number;
}): DeviceLinkPublicStatus {
	const { link } = readStored();
	if (!link) throw new Error("no_device_link_identity");
	if (!input.deviceId || !input.deviceSecret || !Number.isInteger(input.credentialVersion) || input.credentialVersion < 1) {
		throw new Error("invalid_device_credential");
	}
	link.state = "connected";
	link.deviceId = input.deviceId;
	link.deviceSecret = input.deviceSecret;
	link.scopes = normalizeScopes(input.scopes);
	link.credentialVersion = input.credentialVersion;
	link.requestId = null;
	link.pollingCredential = null;
	link.expiresAt = null;
	link.pollAfterSeconds = null;
	link.updatedAt = new Date().toISOString();
	link.connectedAt = link.updatedAt;
	writeStored(link);
	return toPublic(link);
}

/** Safe timestamp only; called after a signed remote request is constructed. */
export function noteDeviceRemoteActivity(): void {
	const { link } = readStored();
	if (!link || (link.state !== "connected" && link.state !== "temporarily_disconnected")) return;
	link.lastRemoteActivityAt = new Date().toISOString();
	link.updatedAt = link.lastRemoteActivityAt;
	writeStored(link);
}

/** A successful signed request proves the retained device identity is usable again. */
export function markDeviceRemoteRecovered(): void {
	const { link } = readStored();
	if (!link || link.state !== "temporarily_disconnected") return;
	link.state = "connected";
	link.lastRemoteReason = "none";
	link.updatedAt = new Date().toISOString();
	writeStored(link);
}

/** Rotate the local key material before the caller requests the server rotation. */
export function rotateDeviceKey(): { publicKey: { algorithm: "ed25519"; value: string } } {
	const { link } = readStored();
	if (!link || link.state !== "connected" || !link.deviceId || !link.deviceSecret || !link.credentialVersion) {
		throw new Error("no_active_device_credential");
	}
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	link.publicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
	link.privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	link.updatedAt = new Date().toISOString();
	writeStored(link);
	return {
		publicKey: { algorithm: "ed25519", value: link.publicKey },
	};
}

/** Get signing material for a linked device. Never use this in an HTTP response. */
export function getDeviceCredential(): DeviceCredential | null {
	const { link } = readStored();
	if (!link || (link.state !== "connected" && link.state !== "temporarily_disconnected") || !link.deviceId || !link.deviceSecret || !link.credentialVersion) return null;
	return {
		origin: link.origin,
		deviceId: link.deviceId,
		deviceSecret: link.deviceSecret,
		privateKeyPem: link.privateKeyPem,
		scopes: [...link.scopes],
		credentialVersion: link.credentialVersion,
	};
}

export interface PendingRemoteCleanup {
	origin: string;
	deviceId: string;
	deviceSecret: string;
	privateKeyPem: string;
	attempts: number;
	nextAttemptAt: string;
}

/** The only retained material after a local disconnect; it cannot operate sync/reporting. */
export function getPendingRemoteCleanup(): PendingRemoteCleanup | null {
	try {
		const raw = JSON.parse(fs.readFileSync(cleanupFile(), "utf8")) as Partial<PendingRemoteCleanup>;
		if (typeof raw.origin !== "string" || typeof raw.deviceId !== "string" || typeof raw.deviceSecret !== "string" || typeof raw.privateKeyPem !== "string") return null;
		return { origin: raw.origin, deviceId: raw.deviceId, deviceSecret: raw.deviceSecret, privateKeyPem: raw.privateKeyPem, attempts: Number(raw.attempts) || 0, nextAttemptAt: typeof raw.nextAttemptAt === "string" ? raw.nextAttemptAt : new Date(0).toISOString() };
	} catch { return null; }
}

export function beginRemoteDisconnect(): DeviceLinkPublicStatus {
	clearOwnerSnapshot();
	const credential = getDeviceCredential();
	if (credential) {
		ensureTargetDirSecure();
		fs.writeFileSync(cleanupFile(), `${JSON.stringify({ ...credential, attempts: 0, nextAttemptAt: new Date().toISOString() })}\n`, { mode: 0o600 });
	}
	try { fs.rmSync(identityFile(), { force: true }); } catch {}
	return toPublic(null);
}

export function postponeRemoteCleanup(): void {
	const cleanup = getPendingRemoteCleanup();
	if (!cleanup) return;
	cleanup.attempts += 1;
	cleanup.nextAttemptAt = new Date(Date.now() + Math.min(300_000, 1_000 * 2 ** cleanup.attempts)).toISOString();
	fs.writeFileSync(cleanupFile(), `${JSON.stringify(cleanup)}\n`, { mode: 0o600 });
}

export function completeRemoteCleanup(): DeviceLinkPublicStatus {
	try { fs.rmSync(cleanupFile(), { force: true }); } catch {}
	return toPublic(null);
}

/** Remove all private pairing/device material. The caller may retain local workflows and queues. */
export function deleteDeviceLink(): DeviceLinkPublicStatus {
	clearOwnerSnapshot();
	try {
		fs.rmSync(identityFile(), { force: true });
	} catch {
		// A missing/unreadable identity is equivalent to an unlinked hub; no
		// caller should be blocked from local work because cleanup was best effort.
	}
	return toPublic(null);
}
