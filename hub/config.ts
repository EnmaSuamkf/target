/**
 * Persisted configuration for The Target Project hub.
 *
 * File: ~/.target/config.json (override the directory with TARGET_HOME,
 * useful for tests). The admin token is generated on first load and stored
 * here — it authorizes every mutation over the HTTP API; the `target` CLI
 * talks to the database directly and doesn't need it. The same directory
 * also holds mesh.db and every workflow's progress markdown file
 * (<workflow_name>-<id>.md), per the user's requirement that those live in
 * ~/.target.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getDockerFriendlySettings, getReportSettings, getSlackDeliverySettings, getSyncCredentials } from "./db.ts";
import { dockerHostAddress } from "./sandbox-net.ts";

export interface HubConfig {
	host: string;
	/**
	 * Address a step running in a docker sandbox should use to reach this hub.
	 * Unset, it's worked out from the docker bridge — see sandbox-net.ts. Set it
	 * for anything that can't be guessed: rootless docker, a custom bridge,
	 * podman, or a hub reached through a hostname. Ignored by steps that run on
	 * the host, which keep using `host`.
	 */
	sandboxHost?: string;
	/**
	 * Hub-managed marker: `sandboxHost` was set by the operator, not by
	 * `TARGET_HUB_DOCKER_FRIENDLY`. When the env flag is off, that host is kept.
	 */
	sandboxHostManual?: boolean;
	/**
	 * Hub-managed marker: `host` / `sandboxHost` were last applied from
	 * `TARGET_HUB_DOCKER_FRIENDLY=true`. Cleared when the flag is turned off.
	 */
	dockerNetworkingFromEnv?: boolean;
	port: number;
	/** Bearer token required by every mutating /api route. */
	adminToken: string;
	/**
	 * Legacy wall-clock step timeout. Kept for compatibility: a config file that
	 * still sets it (and doesn't set `stepIdleTimeoutMs`) has that value used as
	 * the idle timeout instead, so an operator's explicit choice isn't silently
	 * discarded. Nothing reads it as a wall clock anymore — a running step is now
	 * failed for INACTIVITY (`stepIdleTimeoutMs`) or by the hard cap
	 * (`stepHardTimeoutMs`), never just for taking long while working.
	 */
	stepTimeoutMs: number;
	/**
	 * A `running` step whose agent has shown NO sign of progress for this long is
	 * declared stalled and taken down the timeout path (retry budget first, see
	 * workflow.ts). Progress is observed from the artifacts the harness itself
	 * writes — see progress.ts. This is the number that distinguishes "hung" from
	 * "still working on a long task", which a wall clock never could.
	 */
	stepIdleTimeoutMs: number;
	/** How long without progress before a running step is *shown* as idle (UI/log only — no action taken). Purely a warning threshold. */
	stepIdleWarnMs: number;
	/** Absolute ceiling for a `running` step, measured from `started_at` regardless of activity. Safety net for an agent that keeps writing forever; deliberately far above any legitimate step. */
	stepHardTimeoutMs: number;
	/** Minimum gap between two progress probes of the same step. The stale sweep runs on every workflow GET (~every 2s with the UI open), so the filesystem probe is throttled to stay cheap. */
	progressProbeThrottleMs: number;
	/** A step still `queued` (accepted by the broker but not yet started — waiting on the workdir lock behind another run) after this long is marked failed. Safety net so a dead broker (which never sends the `started` callback) can't leave a step queued forever; well above any real queue wait. */
	queuedTimeoutMs: number;
	maxInputBytes: number;
}

// Port kept away from awb's default (8890) and agentmesh-hub's (8892) so all
// three can share the machine without overrides.
const DEFAULTS: Omit<HubConfig, "adminToken"> = {
	host: "127.0.0.1",
	port: 8893,
	stepTimeoutMs: 20 * 60 * 1000,
	// Ten minutes with the agent writing NOTHING — no transcript line, no
	// subagent output, no run log — is a hang, not thinking. A step doing real
	// work touches its transcript far more often than that, so this can be well
	// below the old 20-minute wall clock while being much harder to trip by
	// accident.
	stepIdleTimeoutMs: 10 * 60 * 1000,
	stepIdleWarnMs: 3 * 60 * 1000,
	// Six hours of a step that never stops (a runaway loop that keeps producing
	// output would never look idle) — aligned with queuedTimeoutMs.
	stepHardTimeoutMs: 6 * 60 * 60 * 1000,
	progressProbeThrottleMs: 5_000,
	// Six hours: a genuinely-queued step starts as soon as the run ahead of it
	// on the same workdir finishes (minutes, not hours), so this only ever trips
	// when the broker died and never sent `started` — exactly the case the
	// operator should see failed (and abortable) instead of stuck forever.
	queuedTimeoutMs: 6 * 60 * 60 * 1000,
	maxInputBytes: 64 * 1024,
};

export function targetDir(): string {
	return process.env.TARGET_HOME ?? path.join(os.homedir(), ".target");
}

/**
 * The hub directory contains the local admin token, SQLite database and device
 * credentials. Keep it private even when an older installation created it
 * through a permissive umask. Callers still handle missing/unwritable homes as
 * their own operational error.
 */
export function ensureTargetDirSecure(): string {
	const dir = targetDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// A filesystem that does not implement POSIX modes (for example some
		// mounted Windows volumes) still gets the safest mode it supports.
	}
	return dir;
}

function configFile(): string {
	return path.join(targetDir(), "config.json");
}

export function dbFile(): string {
	return path.join(targetDir(), "target.db");
}

/**
 * Load a `.env` into `process.env` before anything reads it. Node ≥ 20.12/24
 * ships `process.loadEnvFile`, so no dependency is needed. `TARGET_HOME/.env`
 * wins over the repo-root `.env` (an operator's per-instance file overrides the
 * checked-out template); a missing or malformed file is ignored — reporting is
 * optional and must never block startup. Idempotent enough for repeated calls:
 * `loadEnvFile` only sets keys, and the first file found wins.
 */
export function loadEnvFile(): void {
	// The repo root, resolved from THIS file (hub/config.ts → ..), not from the
	// cwd: `npm start` spawns the daemon with cwd=hub/, so a cwd-relative lookup
	// never finds the checked-out repo's `.env` that the docs tell users to create.
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const candidates = [path.join(targetDir(), ".env"), path.join(repoRoot, ".env"), path.join(process.cwd(), ".env")];
	for (const file of candidates) {
		if (!fs.existsSync(file)) continue;
		try {
			process.loadEnvFile(file);
		} catch {
			// Malformed .env → ignore and carry on with the environment as-is.
		}
		return;
	}
}

export function loadConfig(): HubConfig {
	loadEnvFile();
	ensureTargetDirSecure();
	let fileCfg: Partial<HubConfig> = {};
	try {
		fileCfg = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<HubConfig>;
		try {
			fs.chmodSync(configFile(), 0o600);
		} catch {
			// Best effort on filesystems without POSIX permission bits.
		}
	} catch {
		// Missing/invalid config file → fall back to defaults.
	}
	let cfg: HubConfig = {
		...DEFAULTS,
		adminToken: fileCfg.adminToken ?? crypto.randomBytes(24).toString("hex"),
		...fileCfg,
		// Compatibility: a config written before the idle watchdog existed only
		// carries `stepTimeoutMs`. That number was the operator's answer to "how
		// long may a step take without me worrying", which is exactly what the
		// idle timeout now means — so honour it instead of silently overriding it
		// with the new default. An explicit `stepIdleTimeoutMs` always wins.
		stepIdleTimeoutMs:
			fileCfg.stepIdleTimeoutMs ?? fileCfg.stepTimeoutMs ?? DEFAULTS.stepIdleTimeoutMs,
	};
	const synced = syncDockerFriendlyNetworking(cfg, fileCfg);
	cfg = synced.cfg;
	if (!fileCfg.adminToken || synced.changed) saveConfig(cfg);
	return cfg;
}

export function saveConfig(cfg: HubConfig): void {
	const file = configFile();
	ensureTargetDirSecure();
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// See ensureTargetDirSecure.
	}
}

/** How much of each conversation is allowed off the machine (see report-server.es.html §8). */
export type ConversationReportMode = "off" | "digest" | "full";

/**
 * Activity-reporting settings, derived from the environment (the `.env`) rather
 * than config.json, so the destination URL and secret live only in the
 * git-ignored `.env`. Read fresh each call — it's a handful of env lookups, and
 * keeping it stateless means a test can flip a variable and see the effect
 * without a reload dance.
 */
export interface ReportConfig {
	/** True only when a URL is set AND the off-switch isn't thrown. Gate for every emit/flush. */
	enabled: boolean;
	/** Ingest endpoint; empty string means "not configured". */
	url: string;
	/** Bearer token for the ingest endpoint. */
	token: string;
	/** Flush cadence in ms (floored so a typo can't busy-loop the daemon). */
	intervalMs: number;
	/** Conversation privacy mode. */
	includeConversations: ConversationReportMode;
	/** Operator-pinned instance id, or null to let the DB generate+persist one. */
	instanceId: string | null;
}

const DEFAULT_REPORT_INTERVAL_MS = 30_000;
const MIN_REPORT_INTERVAL_MS = 1_000;

/** Loopback bind used when docker-friendly env mode is off. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Bind/listen values applied when `TARGET_HUB_DOCKER_FRIENDLY` is true. */
export const DOCKER_FRIENDLY_HOST = "0.0.0.0";
export const DOCKER_FRIENDLY_PORT = 8893;
export const DOCKER_FRIENDLY_SANDBOX_HOST_DEFAULT = "172.17.0.1";

function envFlag(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const v = value.trim().toLowerCase();
	if (["false", "0", "off", "no"].includes(v)) return false;
	if (["true", "1", "on", "yes"].includes(v)) return true;
	return fallback;
}

/**
 * Whether docker-friendly hub networking is on.
 *
 * Precedence: Settings win after the first save; until then the
 * `TARGET_HUB_DOCKER_FRIENDLY` env flag applies (default false). Changing the
 * preference requires a hub restart — bind address / sandboxHost are applied
 * only during loadConfig() → syncDockerFriendlyNetworking().
 */
export function dockerFriendlyHubEnabled(): boolean {
	const stored = getDockerFriendlySettings();
	if (stored.updatedAt != null) {
		return stored.dockerFriendlyHub;
	}
	return envFlag(process.env.TARGET_HUB_DOCKER_FRIENDLY, false);
}

function sandboxHostForDockerFriendlyEnv(): string {
	return dockerHostAddress() ?? DOCKER_FRIENDLY_SANDBOX_HOST_DEFAULT;
}

/**
 * Merge docker-friendly networking into cfg from the effective enablement flag
 * (`dockerFriendlyHubEnabled()` — Settings after first save, else
 * `TARGET_HUB_DOCKER_FRIENDLY`).
 *
 * When enabled is **true**, overrides `host`, `port`, and `sandboxHost` on
 * every startup. When **false**, forces loopback `host` and removes
 * env/Settings-managed `sandboxHost`; an operator-owned `sandboxHost` (present
 * while the flag was off, or marked `sandboxHostManual`) is preserved.
 *
 * Listen address changes take effect only after a hub restart (this runs inside
 * loadConfig() at process start).
 */
export function syncDockerFriendlyNetworking(
	cfg: HubConfig,
	fileCfg: Partial<HubConfig>,
): { cfg: HubConfig; changed: boolean } {
	const enabled = dockerFriendlyHubEnabled();
	const next: HubConfig = { ...cfg };
	let changed = false;

	const touch = <K extends keyof HubConfig>(key: K, value: HubConfig[K]) => {
		if (next[key] !== value) {
			next[key] = value;
			changed = true;
		}
	};

	if (enabled) {
		touch("host", DOCKER_FRIENDLY_HOST);
		touch("port", DOCKER_FRIENDLY_PORT);
		touch("sandboxHost", sandboxHostForDockerFriendlyEnv());
		touch("dockerNetworkingFromEnv", true);
		if (next.sandboxHostManual) {
			delete next.sandboxHostManual;
			changed = true;
		}
	} else {
		touch("host", LOOPBACK_HOST);
		const fromEnv = fileCfg.dockerNetworkingFromEnv === true;
		const manual =
			fileCfg.sandboxHostManual === true || (!fromEnv && fileCfg.sandboxHost != null && fileCfg.sandboxHost !== "");
		if (fromEnv) {
			if (next.dockerNetworkingFromEnv) {
				delete next.dockerNetworkingFromEnv;
				changed = true;
			}
			if (next.sandboxHost !== undefined) {
				delete next.sandboxHost;
				changed = true;
			}
		} else if (manual) {
			const host = typeof fileCfg.sandboxHost === "string" ? fileCfg.sandboxHost : next.sandboxHost;
			if (host != null && host !== "") touch("sandboxHost", host);
			touch("sandboxHostManual", true);
		} else if (next.sandboxHost !== undefined) {
			delete next.sandboxHost;
			changed = true;
		}
	}

	return { cfg: next, changed };
}

/** Activity-reporting values read from the environment (legacy `.env` path). */
export function loadReportConfigFromEnv(): ReportConfig {
	const url = (process.env.TARGET_REPORT_URL ?? "").trim();
	const token = (process.env.TARGET_REPORT_TOKEN ?? "").trim();
	const enabled = url.length > 0 && envFlag(process.env.TARGET_REPORT_ENABLED, true);

	const rawInterval = Number.parseInt(process.env.TARGET_REPORT_INTERVAL_MS ?? "", 10);
	const intervalMs = Number.isFinite(rawInterval)
		? Math.max(MIN_REPORT_INTERVAL_MS, rawInterval)
		: DEFAULT_REPORT_INTERVAL_MS;

	const rawMode = (process.env.TARGET_REPORT_INCLUDE_CONVERSATIONS ?? "digest").trim().toLowerCase();
	const includeConversations: ConversationReportMode =
		rawMode === "off" || rawMode === "full" ? rawMode : "digest";

	const pinnedId = (process.env.TARGET_INSTANCE_ID ?? "").trim();

	return { enabled, url, token, intervalMs, includeConversations, instanceId: pinnedId.length > 0 ? pinnedId : null };
}

/**
 * Effective activity-reporting config. Settings saved from the UI win; until
 * the operator saves at least once, the `.env` values (if any) still apply so
 * existing installs keep working without migration.
 */
export function loadReportConfig(): ReportConfig {
	const stored = getReportSettings();
	if (stored.updatedAt != null) {
		const url = stored.url.trim();
		const token = stored.token.trim();
		const enabled = stored.enabled && url.length > 0;
		const pinnedId = (process.env.TARGET_INSTANCE_ID ?? "").trim();
		return {
			enabled,
			url,
			token,
			intervalMs: stored.intervalMs,
			includeConversations: stored.includeConversations,
			instanceId: pinnedId.length > 0 ? pinnedId : null,
		};
	}
	return loadReportConfigFromEnv();
}

/**
 * Slack web-client tokens (`xoxc` / `xoxd`) used for direct delivery.
 * Three env name families are accepted (same order as notifier.ts): TARGET_*,
 * SLACK_MCP_*, then bare SLACK_*.
 */
export interface SlackDeliveryTokens {
	xoxc: string;
	xoxd: string;
}

const SLACK_XOXC_ENV_VARS = ["TARGET_SLACK_XOXC_TOKEN", "SLACK_MCP_XOXC_TOKEN", "SLACK_XOXC_TOKEN"] as const;
const SLACK_XOXD_ENV_VARS = ["TARGET_SLACK_XOXD_TOKEN", "SLACK_MCP_XOXD_TOKEN", "SLACK_XOXD_TOKEN"] as const;

function firstNonEmptyEnv(names: readonly string[]): string {
	for (const name of names) {
		const value = (process.env[name] ?? "").trim();
		if (value !== "") return value;
	}
	return "";
}

/** Slack delivery tokens read from the environment (legacy `.env` path). */
export function loadSlackDeliveryTokensFromEnv(): SlackDeliveryTokens {
	return {
		xoxc: firstNonEmptyEnv(SLACK_XOXC_ENV_VARS),
		xoxd: firstNonEmptyEnv(SLACK_XOXD_ENV_VARS),
	};
}

/**
 * Effective Slack delivery tokens. Settings saved from the UI win; until the
 * operator saves at least once, the `.env` values (if any) still apply so
 * existing installs keep working without migration.
 */
export function loadSlackDeliveryTokens(): SlackDeliveryTokens {
	const stored = getSlackDeliverySettings();
	if (stored.updatedAt != null) {
		return { xoxc: stored.xoxcToken, xoxd: stored.xoxdToken };
	}
	return loadSlackDeliveryTokensFromEnv();
}

/** True when the URL is a non-loopback plaintext http:// endpoint (worth a startup warning). */
export function isInsecureReportUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.protocol !== "http:") return false;
		return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
	} catch {
		return false;
	}
}

/**
 * Remote-sync settings from ~/.target/.env (TARGET_SYNC_URL, TARGET_SYNC_TOKEN,
 * TARGET_SYNC_ENABLED). Read fresh each call — same pattern as reporting.
 */
export interface SyncConfig {
	/** True when a server URL is set and the feature is not explicitly off. */
	enabled: boolean;
	/** Server base URL, e.g. http://127.0.0.1:8900 (no trailing slash). */
	url: string;
	/** Bearer client token; may be empty until the first register succeeds. */
	token: string;
	/**
	 * Poll/heartbeat cadence in ms (floored so a typo can't busy-loop).
	 * Default 10s; target-server online TTL is expected to be ~3× this (30s).
	 */
	intervalMs: number;
}

/** Default sync/heartbeat tick (10s). Server presence TTL should stay ~3× this. */
const DEFAULT_SYNC_INTERVAL_MS = 10_000;
const MIN_SYNC_INTERVAL_MS = 5_000;

/** Remote-sync values read from the environment. */
export function loadSyncConfigFromEnv(): SyncConfig {
	const url = (process.env.TARGET_SYNC_URL ?? "").trim().replace(/\/$/, "");
	const envToken = (process.env.TARGET_SYNC_TOKEN ?? "").trim();
	const enabled = url.length > 0 && envFlag(process.env.TARGET_SYNC_ENABLED, true);
	const rawInterval = Number.parseInt(process.env.TARGET_SYNC_INTERVAL_MS ?? "", 10);
	const intervalMs = Number.isFinite(rawInterval)
		? Math.max(MIN_SYNC_INTERVAL_MS, rawInterval)
		: DEFAULT_SYNC_INTERVAL_MS;
	return { enabled, url, token: envToken, intervalMs };
}

/**
 * Effective remote-sync config: env token wins; otherwise the token persisted
 * after register is used. `enabled` only requires a URL — registration fills
 * in the token on the first tick when none is configured.
 */
export function loadSyncConfig(): SyncConfig {
	loadEnvFile();
	const fromEnv = loadSyncConfigFromEnv();
	if (fromEnv.token.length > 0) return fromEnv;
	const stored = getSyncCredentials();
	return { ...fromEnv, token: stored.token ?? "" };
}
