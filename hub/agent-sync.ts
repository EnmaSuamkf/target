/**
 * Sync Target skills and MCP config into each detected agent harness home directory.
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	PUBLISHABLE_RUNNERS,
	RUNNER_BINARIES,
	type PublishableRunner,
} from "./awb.ts";
import { loadConfig, targetDir, type HubConfig } from "./config.ts";
import { expandUserPath, readJsonFile, repoRoot, writeJsonFile } from "./repo-paths.ts";
import { TARGET_VERSION } from "./version.ts";

export const TARGET_SKILL_VERSION = "2";
export const TARGET_MCP_MANAGED_STAMP = "managedBy";
export const TARGET_MCP_MANAGED_VALUE = "target";

export interface SyncAction {
	harness: string;
	action: "synced" | "skipped" | "removed" | "unchanged";
	path: string;
	detail?: string;
}

export interface SyncOptions {
	dryRun?: boolean;
	remove?: boolean;
	force?: boolean;
	homeDir?: string;
	repoDir?: string;
	cfg?: HubConfig;
}

interface McpManifest {
	manifestVersion: number;
	serverKey: string;
	server: {
		description: string;
		command: string;
		args: string[];
		env: Record<string, string>;
	};
	harnesses: Record<
		string,
		{
			runnerId?: PublishableRunner;
			optional?: boolean;
			detect?: { binary?: string; probe?: string[]; configMustExist?: boolean };
			dest: { file: string | Record<string, string>; pointer: string };
			postSync?: string[];
		}
	>;
}

interface McpSyncOverrides {
	hubUrl?: string;
	harnesses?: Record<string, boolean>;
}

function skillSource(repoDir: string): string {
	return path.join(repoDir, "skills", "target-workflows", "SKILL.md");
}

const SKILL_DEST: Record<PublishableRunner, string> = {
	cursor: ".cursor/skills-cursor/target-workflows/SKILL.md",
	claude: ".claude/skills/target-workflows/SKILL.md",
	"free-code": ".free-code/skills/target-workflows/SKILL.md",
};

function runnerInstalled(runner: PublishableRunner): boolean {
	const binary = RUNNER_BINARIES[runner];
	const result = cp.spawnSync(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
	return result.status === 0;
}

function readSkillVersion(content: string): string | null {
	const m = content.match(/^TARGET_SKILL_VERSION:\s*"([^"]+)"/m);
	return m?.[1] ?? null;
}

function stampSkillContent(content: string): string {
	if (content.includes("TARGET_SKILL_VERSION:")) return content;
	return content.replace(/^---\n/m, `---\nTARGET_SKILL_VERSION: "${TARGET_SKILL_VERSION}"\n`);
}

export function syncSkills(options: SyncOptions = {}): SyncAction[] {
	const home = options.homeDir ?? os.homedir();
	const repoDir = options.repoDir ?? repoRoot();
	const source = skillSource(repoDir);
	if (!fs.existsSync(source)) {
		throw new Error(`missing_skill_source:${source}`);
	}
	const content = stampSkillContent(fs.readFileSync(source, "utf8"));
	const actions: SyncAction[] = [];

	for (const runner of PUBLISHABLE_RUNNERS) {
		const rel = SKILL_DEST[runner];
		const dest = path.join(home, rel);
		const harness = runner;
		if (!runnerInstalled(runner)) {
			actions.push({ harness, action: "skipped", path: dest, detail: "runner_not_installed" });
			continue;
		}
		if (options.remove) {
			if (fs.existsSync(dest)) {
				if (!options.dryRun) fs.rmSync(path.dirname(dest), { recursive: true, force: true });
				actions.push({ harness, action: "removed", path: dest });
			} else {
				actions.push({ harness, action: "unchanged", path: dest });
			}
			continue;
		}
		if (fs.existsSync(dest) && !options.force) {
			try {
				const existing = fs.readFileSync(dest, "utf8");
				if (readSkillVersion(existing) === TARGET_SKILL_VERSION) {
					actions.push({ harness, action: "unchanged", path: dest });
					continue;
				}
			} catch {
				// rewrite
			}
		}
		if (!options.dryRun) {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, content, "utf8");
		}
		actions.push({ harness, action: "synced", path: dest });
	}
	return actions;
}

function loadManifest(repoDir: string): McpManifest {
	return readJsonFile<McpManifest>(path.join(repoDir, "mcp", "runners.manifest.json"));
}

function loadMcpOverrides(): McpSyncOverrides {
	const file = path.join(targetDir(), "mcp-sync.json");
	if (!fs.existsSync(file)) return {};
	try {
		return readJsonFile<McpSyncOverrides>(file);
	} catch {
		return {};
	}
}

function resolveDestFile(destSpec: string | Record<string, string>, home: string): string | null {
	if (typeof destSpec === "string") return expandUserPath(destSpec, home);
	const platform = process.platform;
	const raw = destSpec[platform];
	if (!raw) return null;
	return expandUserPath(raw, home);
}

function resolveServerBlock(manifest: McpManifest, cfg: HubConfig, repoDir: string) {
	const hub = loadMcpOverrides().hubUrl ?? `http://${cfg.host}:${cfg.port}`;
	const mcpEntry = path.join(repoDir, "mcp", "target-mcp.mjs");
	const replace = (s: string) =>
		s
			.replace(/\{\{HUB_ORIGIN\}\}/g, hub)
			.replace(/\{\{ADMIN_TOKEN\}\}/g, cfg.adminToken)
			.replace(/\{\{TARGET_MCP_ENTRY\}\}/g, mcpEntry);
	return {
		description: manifest.server.description,
		command: manifest.server.command,
		args: manifest.server.args.map(replace),
		env: Object.fromEntries(Object.entries(manifest.server.env).map(([k, v]) => [k, replace(v)])),
		[TARGET_MCP_MANAGED_STAMP]: TARGET_MCP_MANAGED_VALUE,
		manifestVersion: manifest.manifestVersion,
		targetVersion: TARGET_VERSION,
	};
}

function readDestJson(file: string): Record<string, unknown> {
	if (!fs.existsSync(file)) return { mcpServers: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		// fall through
	}
	return { mcpServers: {} };
}

function enableFreeCodeMcpStatus(home: string, serverKey: string, dryRun: boolean): void {
	const statusFile = path.join(home, ".free-code", "agent", "mcp-status.json");
	let status: { servers?: Record<string, string> } = { servers: {} };
	if (fs.existsSync(statusFile)) {
		try {
			status = JSON.parse(fs.readFileSync(statusFile, "utf8")) as { servers?: Record<string, string> };
		} catch {
			status = { servers: {} };
		}
	}
	if (!status.servers) status.servers = {};
	if (status.servers[serverKey] === "enabled") return;
	status.servers[serverKey] = "enabled";
	if (!dryRun) writeJsonFile(statusFile, status);
}

function harnessShouldSync(key: string, harness: McpManifest["harnesses"][string], overrides: McpSyncOverrides): boolean {
	if (overrides.harnesses && overrides.harnesses[key] === false) return false;
	if (harness.runnerId && !runnerInstalled(harness.runnerId)) return false;
	if (harness.detect?.configMustExist) {
		return true;
	}
	if (harness.detect?.binary) {
		const result = cp.spawnSync(harness.detect.binary, harness.detect.probe ?? ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		return result.status === 0;
	}
	return false;
}

export function syncMcp(options: SyncOptions = {}): SyncAction[] {
	const home = options.homeDir ?? os.homedir();
	const repoDir = options.repoDir ?? repoRoot();
	const cfg = options.cfg ?? loadConfig();
	const manifest = loadManifest(repoDir);
	const overrides = loadMcpOverrides();
	const serverKey = manifest.serverKey;
	const serverBlock = resolveServerBlock(manifest, cfg, repoDir);
	const actions: SyncAction[] = [];

	for (const [key, harness] of Object.entries(manifest.harnesses)) {
		const destFile = resolveDestFile(harness.dest.file, home);
		if (!destFile) {
			actions.push({ harness: key, action: "skipped", path: "", detail: "unsupported_platform" });
			continue;
		}
		if (harness.detect?.configMustExist && !fs.existsSync(destFile)) {
			actions.push({ harness: key, action: "skipped", path: destFile, detail: "config_not_present" });
			continue;
		}
		if (!harnessShouldSync(key, harness, overrides)) {
			actions.push({ harness: key, action: "skipped", path: destFile, detail: "runner_not_installed" });
			continue;
		}

		if (options.remove) {
			if (!fs.existsSync(destFile)) {
				actions.push({ harness: key, action: "unchanged", path: destFile });
				continue;
			}
			const doc = readDestJson(destFile);
			const servers = (doc[harness.dest.pointer] ?? {}) as Record<string, unknown>;
			if (!(serverKey in servers)) {
				actions.push({ harness: key, action: "unchanged", path: destFile });
				continue;
			}
			delete servers[serverKey];
			doc[harness.dest.pointer] = servers;
			if (!options.dryRun) writeJsonFile(destFile, doc);
			actions.push({ harness: key, action: "removed", path: destFile });
			continue;
		}

		const doc = readDestJson(destFile);
		const pointer = harness.dest.pointer;
		if (!doc[pointer] || typeof doc[pointer] !== "object") doc[pointer] = {};
		const servers = doc[pointer] as Record<string, unknown>;
		const existing = servers[serverKey] as Record<string, unknown> | undefined;
		if (
			existing &&
			!options.force &&
			existing[TARGET_MCP_MANAGED_STAMP] === TARGET_MCP_MANAGED_VALUE &&
			existing.manifestVersion === manifest.manifestVersion &&
			existing.targetVersion === TARGET_VERSION
		) {
			actions.push({ harness: key, action: "unchanged", path: destFile });
			continue;
		}
		servers[serverKey] = serverBlock;
		doc[pointer] = servers;
		if (!options.dryRun) {
			writeJsonFile(destFile, doc);
			if (harness.postSync?.includes("enableInFreeCodeMcpStatus")) {
				enableFreeCodeMcpStatus(home, serverKey, false);
			}
		}
		actions.push({ harness: key, action: "synced", path: destFile });
	}
	return actions;
}

export function printSyncActions(label: string, actions: SyncAction[]): void {
	for (const a of actions) {
		const where = a.path || "(n/a)";
		console.log(`${label} ${a.harness}: ${a.action} → ${where}${a.detail ? ` (${a.detail})` : ""}`);
	}
}
