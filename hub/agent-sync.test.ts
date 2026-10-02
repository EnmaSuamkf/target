/**
 * Agent skill + MCP sync.
 */
import * as assert from "node:assert/strict";
import fsDefault from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import * as cp from "node:child_process";
import { repoRoot, writeJsonFile } from "./repo-paths.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-agent-sync-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
fs.mkdirSync(process.env.TARGET_HOME, { recursive: true });
fs.writeFileSync(
	path.join(process.env.TARGET_HOME, "config.json"),
	`${JSON.stringify({ host: "127.0.0.1", port: 8893, adminToken: "sync-test-token" })}\n`,
);

// Real `claude` binary (if any), resolved before the stubs below shadow it on PATH.
const realClaude = (process.env.PATH ?? "")
	.split(path.delimiter)
	.map((dir) => path.join(dir, "claude"))
	.find((candidate) => {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return fs.statSync(candidate).isFile();
		} catch {
			return false;
		}
	});

// Stub runner CLIs so sync tests do not depend on host-installed agents (CI has none).
const mockBin = fs.mkdtempSync(path.join(os.tmpdir(), "target-mock-runners-"));
for (const name of ["agent", "claude", "free-code", "copilot"]) {
	fs.writeFileSync(path.join(mockBin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
process.env.PATH = `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`;

const { syncSkills, syncMcp, TARGET_SKILL_VERSION } = await import("./agent-sync.ts");

test("syncSkills writes skill files for installed runners", () => {
	const actions = syncSkills({ homeDir: tmpHome, repoDir: repoRoot(), force: true });
	assert.ok(actions.some((a) => a.harness === "cursor" && a.action === "synced"));
	const workflowsPath = path.join(tmpHome, ".cursor/skills-cursor/target-workflows/SKILL.md");
	const createPath = path.join(tmpHome, ".cursor/skills-cursor/create-workflow/SKILL.md");
	assert.ok(fs.existsSync(workflowsPath));
	assert.ok(fs.existsSync(createPath));
	assert.match(fs.readFileSync(workflowsPath, "utf8"), new RegExp(`TARGET_SKILL_VERSION: "${TARGET_SKILL_VERSION}"`));
	assert.match(fs.readFileSync(createPath, "utf8"), /name: create-workflow/);
});

test("syncSkills installs skills for copilot under ~/.copilot/skills", () => {
	const actions = syncSkills({ homeDir: tmpHome, repoDir: repoRoot(), force: true });
	assert.ok(actions.some((a) => a.harness === "copilot" && a.action === "synced"));
	const createPath = path.join(tmpHome, ".copilot/skills/create-workflow/SKILL.md");
	assert.ok(fs.existsSync(createPath));
	assert.match(fs.readFileSync(createPath, "utf8"), /name: create-workflow/);
});

test("syncSkills skip when version matches", () => {
	syncSkills({ homeDir: tmpHome, repoDir: repoRoot(), force: true });
	const second = syncSkills({ homeDir: tmpHome, repoDir: repoRoot() });
	assert.ok(second.some((a) => a.harness === "cursor" && a.action === "unchanged"));
});

test("syncMcp merges target server into cursor mcp.json", () => {
	const mcpFile = path.join(tmpHome, ".cursor/mcp.json");
	fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
	fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { other: { command: "echo" } } }, null, 2));
	const actions = syncMcp({
		homeDir: tmpHome,
		repoDir: repoRoot(),
		cfg: {
			host: "127.0.0.1",
			port: 8893,
			adminToken: "sync-test-token",
			stepTimeoutMs: 1,
			stepIdleTimeoutMs: 1,
			stepIdleWarnMs: 1,
			stepHardTimeoutMs: 1,
			progressProbeThrottleMs: 1,
			queuedTimeoutMs: 1,
			maxInputBytes: 1024,
		},
		force: true,
	});
	assert.ok(actions.some((a) => a.harness === "cursor" && a.action === "synced"));
	const parsed = JSON.parse(fs.readFileSync(mcpFile, "utf8")) as {
		mcpServers: Record<string, { env?: Record<string, string>; managedBy?: string }>;
	};
	assert.ok(parsed.mcpServers.target);
	assert.equal(parsed.mcpServers.target.env?.TARGET_ADMIN_TOKEN, "sync-test-token");
	assert.equal(parsed.mcpServers.target.managedBy, "target");
	assert.ok(parsed.mcpServers.other);
});

test("syncMcp merges target server into copilot mcp-config.json under mcpServers", () => {
	const mcpFile = path.join(tmpHome, ".copilot/mcp-config.json");
	fs.rmSync(mcpFile, { force: true });
	const actions = syncMcp({
		homeDir: tmpHome,
		repoDir: repoRoot(),
		cfg: {
			host: "127.0.0.1",
			port: 8893,
			adminToken: "sync-test-token",
			stepTimeoutMs: 1,
			stepIdleTimeoutMs: 1,
			stepIdleWarnMs: 1,
			stepHardTimeoutMs: 1,
			progressProbeThrottleMs: 1,
			queuedTimeoutMs: 1,
			maxInputBytes: 1024,
		},
		force: true,
	});
	assert.ok(actions.some((a) => a.harness === "copilot" && a.action === "synced"));
	const parsed = JSON.parse(fs.readFileSync(mcpFile, "utf8")) as {
		mcpServers: Record<string, { env?: Record<string, string> }>;
	};
	assert.equal(parsed.mcpServers.target.env?.TARGET_ADMIN_TOKEN, "sync-test-token");
});

test("syncMcp enables free-code mcp status when configured", () => {
	const mcpFile = path.join(tmpHome, ".free-code/agent/mcp.json");
	fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
	fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }, null, 2));
	syncMcp({
		homeDir: tmpHome,
		repoDir: repoRoot(),
		cfg: {
			host: "127.0.0.1",
			port: 8893,
			adminToken: "sync-test-token",
			stepTimeoutMs: 1,
			stepIdleTimeoutMs: 1,
			stepIdleWarnMs: 1,
			stepHardTimeoutMs: 1,
			progressProbeThrottleMs: 1,
			queuedTimeoutMs: 1,
			maxInputBytes: 1024,
		},
		force: true,
	});
	const status = JSON.parse(
		fs.readFileSync(path.join(tmpHome, ".free-code/agent/mcp-status.json"), "utf8"),
	) as { servers: Record<string, string> };
	assert.equal(status.servers.target, "enabled");
});

test("syncMcp remove drops only target server entry", () => {
	const mcpFile = path.join(tmpHome, ".cursor/mcp-remove.json");
	fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
	fs.writeFileSync(
		mcpFile,
		JSON.stringify({ mcpServers: { target: { managedBy: "target" }, keep: { command: "x" } } }, null, 2),
	);
	// Patch manifest dest temporarily by writing to standard cursor path used in prior test
	const cursorFile = path.join(tmpHome, ".cursor/mcp.json");
	fs.copyFileSync(mcpFile, cursorFile);
	syncMcp({
		homeDir: tmpHome,
		repoDir: repoRoot(),
		remove: true,
		cfg: {
			host: "127.0.0.1",
			port: 8893,
			adminToken: "sync-test-token",
			stepTimeoutMs: 1,
			stepIdleTimeoutMs: 1,
			stepIdleWarnMs: 1,
			stepHardTimeoutMs: 1,
			progressProbeThrottleMs: 1,
			queuedTimeoutMs: 1,
			maxInputBytes: 1024,
		},
	});
	const parsed = JSON.parse(fs.readFileSync(cursorFile, "utf8")) as { mcpServers: Record<string, unknown> };
	assert.equal(parsed.mcpServers.target, undefined);
	assert.ok(parsed.mcpServers.keep);
});

test("writeJsonFile writes atomically and preserves file mode", () => {
	const file = path.join(tmpHome, "mode-check", "state.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{}\n");
	fs.chmodSync(file, 0o600);
	writeJsonFile(file, { a: 1 });
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
	assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
});

test("syncMcp skips an unparseable destination without touching it", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-agent-sync-bad-"));
	const bad = "{ not json";
	const cursorFile = path.join(home, ".cursor/mcp.json");
	fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
	fs.writeFileSync(cursorFile, bad);
	for (const remove of [false, true]) {
		const actions = syncMcp({ homeDir: home, repoDir: repoRoot(), force: true, remove });
		const a = actions.find((x) => x.harness === "cursor");
		assert.equal(a?.action, "skipped");
		assert.equal(a?.detail, "unreadable_config");
		assert.equal(fs.readFileSync(cursorFile, "utf8"), bad);
	}
});

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("syncMcp registers claude-code in ~/.claude.json and migrates the legacy settings entry", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-agent-sync-claude-"));
	const claudeJson = path.join(home, ".claude.json");
	const settings = path.join(home, ".claude", "settings.json");
	const before = {
		numStartups: 7,
		projects: { "/x": { allowedTools: ["a"], history: [1, 2] } },
		history: ["one"],
		mcpServers: { other: { command: "echo", args: ["hi"] } },
	};
	writeJson(claudeJson, before);
	fs.chmodSync(claudeJson, 0o600);
	writeJson(settings, {
		theme: "dark",
		mcpServers: { target: { managedBy: "target", command: "node" }, "mcp-github": { command: "gh" } },
	});

	const actions = syncMcp({ homeDir: home, repoDir: repoRoot() });
	assert.ok(actions.some((a) => a.harness === "claude-code" && a.action === "synced" && a.path === claudeJson));
	const after = readJson(claudeJson);
	assert.ok(path.isAbsolute(after.mcpServers.target.command));
	assert.equal(after.mcpServers.target.command, process.execPath);
	const { target, ...otherServers } = after.mcpServers;
	assert.ok(target);
	assert.deepEqual({ ...after, mcpServers: otherServers }, before);
	assert.equal(fs.statSync(claudeJson).mode & 0o777, 0o600);

	const migrated = readJson(settings);
	assert.equal(migrated.mcpServers.target, undefined);
	assert.deepEqual(migrated.mcpServers["mcp-github"], { command: "gh" });
	assert.equal(migrated.theme, "dark");

	const second = syncMcp({ homeDir: home, repoDir: repoRoot() });
	assert.ok(second.some((a) => a.harness === "claude-code" && a.action === "unchanged" && a.path === claudeJson));

	const removed = syncMcp({ homeDir: home, repoDir: repoRoot(), remove: true });
	assert.ok(removed.some((a) => a.harness === "claude-code" && a.action === "removed" && a.path === claudeJson));
	assert.equal(readJson(claudeJson).mcpServers.target, undefined);
	assert.ok(readJson(claudeJson).mcpServers.other);
});

test("syncMcp leaves an unmanaged legacy target entry alone and --remove cleans both files", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-agent-sync-claude2-"));
	const settings = path.join(home, ".claude", "settings.json");
	const mine = { command: "mine" };
	writeJson(settings, { mcpServers: { target: mine } });
	syncMcp({ homeDir: home, repoDir: repoRoot() });
	assert.deepEqual(readJson(settings).mcpServers.target, mine);

	writeJson(settings, { mcpServers: { target: { managedBy: "target" }, keep: { command: "k" } } });
	syncMcp({ homeDir: home, repoDir: repoRoot() });
	assert.equal(readJson(settings).mcpServers.target, undefined);

	writeJson(settings, { mcpServers: { target: { managedBy: "target" }, keep: { command: "k" } } });
	syncMcp({ homeDir: home, repoDir: repoRoot(), remove: true });
	assert.equal(readJson(settings).mcpServers.target, undefined);
	assert.ok(readJson(settings).mcpServers.keep);
	assert.equal(readJson(path.join(home, ".claude.json")).mcpServers.target, undefined);
});

test("syncMcp tells claude-desktop users to restart it", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-agent-sync-desktop-"));
	const desktop: Record<string, string> = {
		linux: path.join(home, ".config/Claude/claude_desktop_config.json"),
		darwin: path.join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
		win32: path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude/claude_desktop_config.json"),
	};
	const file = desktop[process.platform];
	if (!file) return;
	writeJson(file, { mcpServers: {} });
	const a = syncMcp({ homeDir: home, repoDir: repoRoot() }).find((x) => x.harness === "claude-desktop");
	assert.equal(a?.action, "synced");
	assert.equal(a?.detail, "restart Claude Desktop to load it");
});

test("syncMcp writes claude-code to .claude.json and never creates .claude/settings.json", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-agent-sync-dest-"));
	const actions = syncMcp({ homeDir: home, repoDir: repoRoot() });
	const a = actions.find((x) => x.harness === "claude-code" && x.action === "synced");
	assert.equal(a?.path, path.join(home, ".claude.json"));
	assert.ok(readJson(path.join(home, ".claude.json")).mcpServers.target);
	assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
});

test("syncMcp reports failed when the written entry does not read back", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-agent-sync-verify-"));
	const dest = path.join(home, ".claude.json");
	const realRead = fsDefault.readFileSync;
	// Simulate a destination that silently loses our entry after the write.
	(fsDefault as any).readFileSync = (file: any, ...rest: any[]) => {
		const out = (realRead as any)(file, ...rest);
		if (file === dest && typeof out === "string" && out.includes('"managedBy"')) {
			const doc = JSON.parse(out);
			delete doc.mcpServers.target;
			return JSON.stringify(doc);
		}
		return out;
	};
	syncBuiltinESMExports();
	try {
		const actions = syncMcp({ homeDir: home, repoDir: repoRoot() });
		const a = actions.find((x) => x.harness === "claude-code");
		assert.equal(a?.action, "failed");
		assert.equal(a?.detail, "verify_mismatch");
	} finally {
		(fsDefault as any).readFileSync = realRead;
		syncBuiltinESMExports();
	}
});

test("claude mcp list shows the synced target server as Connected", { skip: realClaude ? false : "claude binary not installed" }, () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-agent-sync-claude-cli-"));
	syncMcp({ homeDir: home, repoDir: repoRoot() });
	const out = cp.spawnSync(realClaude as string, ["mcp", "list"], {
		env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config") },
		cwd: home,
		encoding: "utf8",
		timeout: 90_000,
	});
	const text = `${out.stdout}${out.stderr}`;
	assert.match(text, /target:/);
	assert.match(text, /Connected/);
});
