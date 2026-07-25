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

export interface HubConfig {
	host: string;
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

export function loadConfig(): HubConfig {
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
