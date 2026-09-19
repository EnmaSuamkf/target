/**
 * Select the remote-service configuration without ever materializing a device
 * secret. A device link owns remote routing while it exists; legacy Bearer
 * configuration is a fallback only for hubs that have never been linked.
 */
import { loadReportConfig, loadSyncConfig, type ReportConfig, type SyncConfig } from "./config.ts";
import { getDeviceCredential, getDeviceLinkStatus, type DeviceScope } from "./device-link.ts";

function linkedConfig<T extends { enabled: boolean; url: string; token: string }>(
	legacy: T,
	scope: DeviceScope,
	path: string,
): T {
	const status = getDeviceLinkStatus();
	if (status.state === "local_unconfigured") return legacy;

	const credential = getDeviceCredential();
	if (!credential || !credential.scopes.includes(scope)) {
		// A pending, revoked, disconnected, or under-scoped link intentionally
		// blocks the legacy endpoint rather than silently falling back to it.
		return { ...legacy, enabled: false, url: "", token: "" };
	}
	return { ...legacy, enabled: true, url: `${credential.origin}${path}`, token: "" };
}

/** Effective reporting endpoint: an active `ingest:write` link wins over `.env`. */
export function loadEffectiveReportConfig(): ReportConfig {
	const config = linkedConfig(loadReportConfig(), "ingest:write", "/ingest");
	// Linking is explicit consent for the scopes that target-server granted.
	// Local legacy privacy/off preferences never weaken a linked capability.
	return getDeviceLinkStatus().state === "local_unconfigured"
		? config
		: { ...config, includeConversations: "full" };
}

/** Effective sync endpoint: an active `sync:write` link wins over `.env`. */
export function loadEffectiveSyncConfig(): SyncConfig {
	const config = linkedConfig(loadSyncConfig(), "sync:write", "");
	return config;
}
