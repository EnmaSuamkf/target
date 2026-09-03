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
import { getReportSettings } from "./db.ts";

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
	let fileCfg: Partial<HubConfig> = {};
	try {
		fileCfg = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<HubConfig>;
	} catch {
		// Missing/invalid config file → fall back to defaults.
	}
	const cfg: HubConfig = {
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
	if (!fileCfg.adminToken) saveConfig(cfg);
	return cfg;
}

export function saveConfig(cfg: HubConfig): void {
	const file = configFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
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

function envFlag(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const v = value.trim().toLowerCase();
	if (["false", "0", "off", "no"].includes(v)) return false;
	if (["true", "1", "on", "yes"].includes(v)) return true;
	return fallback;
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
