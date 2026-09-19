/** Shared contract-v1 device authentication for reporting and Remote Sync. */
import * as crypto from "node:crypto";
import {
	getDeviceCredential,
	getDeviceLinkStatus,
	noteDeviceRemoteActivity,
	setDeviceLinkRemoteState,
	type DeviceScope,
} from "./device-link.ts";

export type RemoteAuth = { kind: "device"; origin: string } | { kind: "legacy" } | { kind: "blocked" };

/** A linked/relinking device must never silently downgrade to a legacy Bearer token. */
export function remoteAuth(requiredScope?: DeviceScope): RemoteAuth {
	const credential = getDeviceCredential();
	if (credential) {
		if (requiredScope && !credential.scopes.includes(requiredScope)) return { kind: "blocked" };
		return { kind: "device", origin: credential.origin };
	}
	const state = getDeviceLinkStatus().state;
	return state === "local_unconfigured" ? { kind: "legacy" } : { kind: "blocked" };
}

export function deviceHeaders(method: string, path: string, exactBody: string): Record<string, string> | null {
	const credential = getDeviceCredential();
	if (!credential) return null;
	const date = new Date().toISOString();
	const nonce = crypto.randomBytes(16).toString("base64url");
	const bodyHash = crypto.createHash("sha256").update(exactBody, "utf8").digest("hex");
	const canonical = ["target-device-v1", method.toUpperCase(), path, bodyHash, date, nonce, credential.deviceId].join("\n");
	const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), credential.privateKeyPem).toString("base64url");
	noteDeviceRemoteActivity();
	return {
		authorization: `Target-Device v1 ${credential.deviceId}.${credential.deviceSecret}`,
		"x-target-date": date,
		"x-target-nonce": nonce,
		"x-target-signature": signature,
	};
}

/** Only server-declared revocation/invalid-secret is terminal; auth errors can be deployment/transient. */
export function handleDeviceAuthResponse(status: number, code?: unknown): boolean {
	if (status !== 401 && status !== 403) return false;
	if (remoteAuth().kind !== "device") return false;
	if (code === "device_revoked" || code === "invalid_device_secret") {
		setDeviceLinkRemoteState("relink_required");
		return true;
	}
	setDeviceLinkRemoteState("temporarily_disconnected", "sync_registration_failed");
	return false;
}
