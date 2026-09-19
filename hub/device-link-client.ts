/**
 * Contract-v1 device-link transport. It is intentionally separate from the
 * HTTP/UI layer: only safe outcomes leave this module, while pairing and device
 * credentials stay in device-link.ts and request headers.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import {
	activateDeviceCredential,
	beginDeviceLink,
	deleteDeviceLink,
	beginRemoteDisconnect,
	completeRemoteCleanup,
	getPendingRemoteCleanup,
	getDeviceLinkStatus,
	getPendingDeviceLinkTransport,
	savePendingDeviceLink,
	postponeRemoteCleanup,
	setDeviceLinkRemoteState,
	type DeviceLinkPublicStatus,
	type DeviceScope,
} from "./device-link.ts";
import { TARGET_VERSION } from "./version.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type BrowserOpener = (url: string) => void;

export interface LinkFlowOutcome {
	status: DeviceLinkPublicStatus;
	code:
		| "browser_opened"
		| "open_browser_manually"
		| "waiting_for_approval"
		| "connected"
		| "approval_denied"
		| "approval_expired"
		| "cancelled"
		| "server_unavailable"
		| "relink_required";
	/** Browser URLs contain only the opaque request id, never a credential. */
	browserUrl?: string;
}

const TIMEOUT_MS = 15_000;
const MAX_POLL_ATTEMPTS = 60;

function endpoint(origin: string, suffix: string): string {
	return `${origin}${suffix}`;
}

function safeOpenBrowser(url: string): void {
	const child =
		process.platform === "darwin"
			? spawn("open", [url], { detached: true, stdio: "ignore" })
			: process.platform === "win32"
				? spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" })
				: spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
	child.unref();
}

async function call(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
	return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function validBrowserUrl(value: unknown, origin: string): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		// The contract's approval URL is an opaque request-id path. Reject every
		// query/hash, not merely suspicious parameter names, so a compromised or
		// incompatible server can never smuggle a credential into browser history.
		if (url.origin !== origin || !/^\/link\/device\/[^/]+$/.test(url.pathname) || url.search || url.hash) return null;
		return url.toString();
	} catch {
		return null;
	}
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function json(response: Response): Promise<Record<string, unknown> | null> {
	return object(await response.json().catch(() => null));
}

/**
 * Create a server request and open the human-approval page. No pairing value is
 * returned to the caller or embedded in the browser URL.
 */
export async function startDeviceLink(
	input: { origin: string; deviceName: string; requestedScopes?: readonly DeviceScope[] },
	options: { fetchImpl?: FetchLike; openBrowser?: BrowserOpener } = {},
): Promise<LinkFlowOutcome> {
	const initiation = beginDeviceLink(input);
	const fetchImpl = options.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await call(fetchImpl, endpoint(initiation.origin, "/api/device-links/requests"), {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": initiation.idempotencyKey },
			body: JSON.stringify({
				contract_version: "device-link/v1",
				device_name: initiation.deviceName,
				hub_version: TARGET_VERSION,
				public_key: initiation.publicKey,
				requested_scopes: initiation.requestedScopes,
			}),
		});
	} catch {
		return { status: setDeviceLinkRemoteState("temporarily_disconnected"), code: "server_unavailable" };
	}
	const body = await json(response);
	const requestId = typeof body?.request_id === "string" ? body.request_id : "";
	const pollingCredential = typeof body?.polling_credential === "string" ? body.polling_credential : "";
	const expiresAt = typeof body?.expires_at === "string" ? body.expires_at : "";
	const pollAfterSeconds = typeof body?.poll_after_seconds === "number" ? body.poll_after_seconds : 0;
	const browserUrl = validBrowserUrl(body?.browser_url, initiation.origin);
	if (!response.ok || !requestId || !pollingCredential || !expiresAt || !browserUrl || pollAfterSeconds < 1) {
		return { status: setDeviceLinkRemoteState("relink_required"), code: "relink_required" };
	}
	savePendingDeviceLink({ requestId, pollingCredential, expiresAt, pollAfterSeconds });
	try {
		(options.openBrowser ?? safeOpenBrowser)(browserUrl);
		return { status: getDeviceLinkStatus(), code: "browser_opened", browserUrl };
	} catch {
		return { status: getDeviceLinkStatus(), code: "open_browser_manually", browserUrl };
	}
}

/** Poll once; callers may schedule it with the server-provided cadence. */
export async function pollDeviceLink(options: { fetchImpl?: FetchLike } = {}): Promise<LinkFlowOutcome> {
	const pending = getPendingDeviceLinkTransport();
	if (!pending) return { status: getDeviceLinkStatus(), code: "relink_required" };
	let response: Response;
	try {
		response = await call(options.fetchImpl ?? fetch, endpoint(pending.origin, `/api/device-links/requests/${encodeURIComponent(pending.requestId)}/poll`), {
			method: "POST",
			headers: { authorization: `Target-Link ${pending.pollingCredential}`, "content-type": "application/json" },
			body: "{}",
		});
	} catch {
		return { status: setDeviceLinkRemoteState("temporarily_disconnected"), code: "server_unavailable" };
	}
	const body = await json(response);
	const state = typeof body?.state === "string" ? body.state : "";
	if (!response.ok) return { status: setDeviceLinkRemoteState("relink_required"), code: "relink_required" };
	if (state === "pending") return { status: getDeviceLinkStatus(), code: "waiting_for_approval" };
	if (state === "denied") {
		deleteDeviceLink();
		return { status: getDeviceLinkStatus(), code: "approval_denied" };
	}
	if (state === "expired") {
		deleteDeviceLink();
		return { status: getDeviceLinkStatus(), code: "approval_expired" };
	}
	if (state !== "approved") return { status: setDeviceLinkRemoteState("relink_required"), code: "relink_required" };
	try {
		response = await call(options.fetchImpl ?? fetch, endpoint(pending.origin, `/api/device-links/requests/${encodeURIComponent(pending.requestId)}/consume`), {
			method: "POST",
			headers: { authorization: `Target-Link ${pending.pollingCredential}`, "content-type": "application/json" },
			body: "{}",
		});
	} catch {
		return { status: setDeviceLinkRemoteState("temporarily_disconnected"), code: "server_unavailable" };
	}
	const consumed = await json(response);
	const device = object(consumed?.device);
	const secret = typeof consumed?.device_secret === "string" ? consumed.device_secret : "";
	if (!response.ok || !device || typeof device.id !== "string" || !secret || !Array.isArray(device.scopes) || typeof device.credential_version !== "number") {
		return { status: setDeviceLinkRemoteState("relink_required"), code: "relink_required" };
	}
	const status = activateDeviceCredential({
		deviceId: device.id,
		deviceSecret: secret,
		scopes: device.scopes as DeviceScope[],
		credentialVersion: device.credential_version,
	});
	return { status, code: "connected" };
}

/** Bounded, cancellable convenience loop; no aggressive polling. */
export async function waitForDeviceApproval(
	options: { fetchImpl?: FetchLike; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LinkFlowOutcome> {
	const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
		if (options.signal?.aborted) {
			deleteDeviceLink();
			return { status: getDeviceLinkStatus(), code: "cancelled" };
		}
		const outcome = await pollDeviceLink(options);
		if (outcome.code !== "waiting_for_approval") return outcome;
		const pending = getPendingDeviceLinkTransport();
		await sleep(Math.max(1_000, (pending?.pollAfterSeconds ?? 3) * 1_000));
	}
	return { status: setDeviceLinkRemoteState("relink_required"), code: "relink_required" };
}

export function cancelDeviceLink(): LinkFlowOutcome {
	return { status: deleteDeviceLink(), code: "cancelled" };
}

function cleanupHeaders(cleanup: NonNullable<ReturnType<typeof getPendingRemoteCleanup>>): Record<string, string> {
	const body = "";
	const date = new Date().toISOString();
	const nonce = crypto.randomBytes(16).toString("base64url");
	const hash = crypto.createHash("sha256").update(body).digest("hex");
	const canonical = ["target-device-v1", "DELETE", `/api/device-links/devices/${cleanup.deviceId}`, hash, date, nonce, cleanup.deviceId].join("\n");
	return {
		authorization: `Target-Device v1 ${cleanup.deviceId}.${cleanup.deviceSecret}`,
		"x-target-date": date,
		"x-target-nonce": nonce,
		"x-target-signature": crypto.sign(null, Buffer.from(canonical), cleanup.privateKeyPem).toString("base64url"),
	};
}

/** Stop local traffic first, then best-effort archive only this remote device. */
export async function disconnectDeviceLink(options: { fetchImpl?: FetchLike } = {}): Promise<LinkFlowOutcome> {
	beginRemoteDisconnect();
	return await retryRemoteDisconnect({ ...options, force: true });
}

export async function retryRemoteDisconnect(options: { fetchImpl?: FetchLike; force?: boolean; now?: () => number } = {}): Promise<LinkFlowOutcome> {
	const cleanup = getPendingRemoteCleanup();
	if (!cleanup) return { status: getDeviceLinkStatus(), code: "cancelled" };
	if (!options.force && Date.parse(cleanup.nextAttemptAt) > (options.now ?? Date.now)()) {
		return { status: getDeviceLinkStatus(), code: "server_unavailable" };
	}
	try {
		const response = await call(options.fetchImpl ?? fetch, endpoint(cleanup.origin, `/api/device-links/devices/${encodeURIComponent(cleanup.deviceId)}`), {
			method: "DELETE",
			headers: cleanupHeaders(cleanup),
		});
		// Server archives are idempotent: 2xx, already gone, or previously revoked
		// all prove this identity can no longer appear as operational.
		if (response.ok || response.status === 404 || response.status === 410) {
			return { status: completeRemoteCleanup(), code: "cancelled" };
		}
		if (response.status === 401 || response.status === 403) return { status: completeRemoteCleanup(), code: "cancelled" };
	} catch {
		// Offline/timeout: retained only in the cleanup file for a later retry.
	}
	postponeRemoteCleanup();
	return { status: getDeviceLinkStatus(), code: "server_unavailable" };
}
