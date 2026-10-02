/**
 * Sync Target skills and MCP config into each detected agent harness home directory.
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	PUBLISHABLE_RUNNERS,
	RUNNER_BINARIES,
	type PublishableRunner,
} from "./awb.ts";
import { loadConfig, targetDir, type HubConfig } from "./config.ts";
import { expandUserPath, readJsonFile, repoRoot, writeJsonFile } from "./repo-paths.ts";
import { TARGET_VERSION } from "./version.ts";

export const TARGET_SKILL_VERSION = "5";
export const TARGET_MCP_MANAGED_STAMP = "managedBy";
export const TARGET_MCP_MANAGED_VALUE = "target";

export interface SyncAction {
	harness: string;
	action: "synced" | "skipped" | "removed" | "unchanged" | "failed";
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

function skillsRoot(repoDir: string): string {
	return path.join(repoDir, "skills");
}

// Copilot's home is fixed at `~/.copilot` here: it honours COPILOT_HOME, but
// neither this table nor the manifest's `dest` supports a per-harness home
// override, so an operator who relocates it must sync by hand.
const SKILL_DEST_DIR: Record<PublishableRunner, string> = {
	cursor: ".cursor/skills-cursor",
	claude: ".claude/skills",
	"free-code": ".free-code/skills",
	copilot: ".copilot/skills",
};

export interface BundledSkill {
	name: string;
	source: string;
}

/** Every `skills/<name>/SKILL.md` shipped with the repo. */
export function listBundledSkills(repoDir: string): BundledSkill[] {
	const root = skillsRoot(repoDir);
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => ({
			name: entry.name,
			source: path.join(root, entry.name, "SKILL.md"),
		}))
		.filter((skill) => fs.existsSync(skill.source))
		.sort((a, b) => a.name.localeCompare(b.name));
}

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
	const skills = listBundledSkills(repoDir);
	if (skills.length === 0) {
		throw new Error(`missing_skill_source:${skillsRoot(repoDir)}`);
	}
	const actions: SyncAction[] = [];

	for (const runner of PUBLISHABLE_RUNNERS) {
		const destDir = path.join(home, SKILL_DEST_DIR[runner]);
		const harness = runner;
		if (!runnerInstalled(runner)) {
			actions.push({ harness, action: "skipped", path: destDir, detail: "runner_not_installed" });
			continue;
		}
		for (const skill of skills) {
			const dest = path.join(destDir, skill.name, "SKILL.md");
			if (options.remove) {
				if (fs.existsSync(dest)) {
					if (!options.dryRun) fs.rmSync(path.dirname(dest), { recursive: true, force: true });
					actions.push({ harness, action: "removed", path: dest });
				} else {
					actions.push({ harness, action: "unchanged", path: dest });
				}
				continue;
			}
			const content = stampSkillContent(fs.readFileSync(skill.source, "utf8"));
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
			.replace(/\{\{TARGET_MCP_ENTRY\}\}/g, mcpEntry)
			.replace(/\{\{NODE\}\}/g, process.execPath);
	return {
		description: manifest.server.description,
		command: replace(manifest.server.command),
		args: manifest.server.args.map(replace),
		env: Object.fromEntries(Object.entries(manifest.server.env).map(([k, v]) => [k, replace(v)])),
		[TARGET_MCP_MANAGED_STAMP]: TARGET_MCP_MANAGED_VALUE,
		manifestVersion: manifest.manifestVersion,
		targetVersion: TARGET_VERSION,
	};
}

/** Missing file starts empty; an existing file that is not a JSON object yields null so callers never overwrite it. */
function readDestJson(file: string): Record<string, unknown> | null {
	if (!fs.existsSync(file)) return { mcpServers: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// fall through
	}
	return null;
}

/** Re-read a written destination and return a failure detail when the target entry is not what we meant to write. */
function verifyDest(file: string, pointer: string, serverKey: string, expected: unknown): string | null {
	const doc = readDestJson(file);
	if (!doc) return "verify_unreadable";
	const servers = doc[pointer];
	const actual = servers && typeof servers === "object" ? (servers as Record<string, unknown>)[serverKey] : undefined;
	if (expected === undefined ? actual !== undefined : !isDeepStrictEqual(actual, expected)) return "verify_mismatch";
	return null;
}

/** Legacy Target stamped entries in ~/.claude/settings.json (never read by Claude Code); drop only that key. */
function removeLegacyClaudeSettings(home: string, pointer: string, serverKey: string, dryRun: boolean): SyncAction | null {
	const file = path.join(home, ".claude", "settings.json");
	if (!fs.existsSync(file)) return null;
	const doc = readDestJson(file);
	if (!doc) return null;
	const servers = doc[pointer];
	if (!servers || typeof servers !== "object") return null;
	const entry = (servers as Record<string, unknown>)[serverKey] as Record<string, unknown> | undefined;
	if (!entry || typeof entry !== "object" || entry[TARGET_MCP_MANAGED_STAMP] !== TARGET_MCP_MANAGED_VALUE) return null;
	delete (servers as Record<string, unknown>)[serverKey];
	if (!dryRun) {
		writeJsonFile(file, doc);
		const bad = verifyDest(file, pointer, serverKey, undefined);
		if (bad) return { harness: "claude-code", action: "failed", path: file, detail: bad };
	}
	return { harness: "claude-code", action: "removed", path: file, detail: "legacy_settings_entry" };
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
			const legacy = key === "claude-code" ? removeLegacyClaudeSettings(home, harness.dest.pointer, serverKey, !!options.dryRun) : null;
			if (legacy) actions.push(legacy);
			if (!fs.existsSync(destFile)) {
				actions.push({ harness: key, action: "unchanged", path: destFile });
				continue;
			}
			const doc = readDestJson(destFile);
			if (!doc) {
				actions.push({ harness: key, action: "skipped", path: destFile, detail: "unreadable_config" });
				continue;
			}
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

		if (key === "claude-code") {
			const legacy = removeLegacyClaudeSettings(home, harness.dest.pointer, serverKey, !!options.dryRun);
			if (legacy) actions.push(legacy);
		}
		const doc = readDestJson(destFile);
		if (!doc) {
			actions.push({ harness: key, action: "skipped", path: destFile, detail: "unreadable_config" });
			continue;
		}
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
			const bad = verifyDest(destFile, pointer, serverKey, serverBlock);
			if (bad) {
				actions.push({ harness: key, action: "failed", path: destFile, detail: bad });
				continue;
			}
			if (harness.postSync?.includes("enableInFreeCodeMcpStatus")) {
				enableFreeCodeMcpStatus(home, serverKey, false);
			}
		}
		actions.push({
			harness: key,
			action: "synced",
			path: destFile,
			...(key === "claude-desktop" ? { detail: "restart Claude Desktop to load it" } : {}),
		});
	}
	return actions;
}

export function printSyncActions(label: string, actions: SyncAction[]): void {
	for (const a of actions) {
		const where = a.path || "(n/a)";
		const log = a.action === "failed" ? console.error : console.log;
		log(`${label} ${a.harness}: ${a.action} → ${where}${a.detail ? ` (${a.detail})` : ""}`);
	}
}
