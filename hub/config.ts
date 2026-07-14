/**
 * Persisted configuration for the target hub.
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
	/** A step's job still pending/running after this long is marked failed. */
	stepTimeoutMs: number;
	maxInputBytes: number;
}

// Port kept away from awb's default (8890) and agentmesh-hub's (8892) so all
// three can share the machine without overrides.
const DEFAULTS: Omit<HubConfig, "adminToken"> = {
	host: "127.0.0.1",
	port: 8893,
	stepTimeoutMs: 10 * 60 * 1000,
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
	};
	if (!fileCfg.adminToken) saveConfig(cfg);
	return cfg;
}

export function saveConfig(cfg: HubConfig): void {
	const file = configFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}
