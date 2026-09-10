/**
 * Agent skill + MCP sync.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { repoRoot } from "./repo-paths.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-agent-sync-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
fs.mkdirSync(process.env.TARGET_HOME, { recursive: true });
fs.writeFileSync(
	path.join(process.env.TARGET_HOME, "config.json"),
	`${JSON.stringify({ host: "127.0.0.1", port: 8893, adminToken: "sync-test-token" })}\n`,
);

// Stub runner CLIs so sync tests do not depend on host-installed agents (CI has none).
const mockBin = fs.mkdtempSync(path.join(os.tmpdir(), "target-mock-runners-"));
for (const name of ["agent", "claude", "free-code"]) {
	fs.writeFileSync(path.join(mockBin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
process.env.PATH = `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`;

const { syncSkills, syncMcp, TARGET_SKILL_VERSION } = await import("./agent-sync.ts");

test("syncSkills writes skill files for installed runners", () => {
	const actions = syncSkills({ homeDir: tmpHome, repoDir: repoRoot(), force: true });
	assert.ok(actions.some((a) => a.harness === "cursor" && a.action === "synced"));
	const skillPath = path.join(tmpHome, ".cursor/skills-cursor/target-workflows/SKILL.md");
	assert.ok(fs.existsSync(skillPath));
	assert.match(fs.readFileSync(skillPath, "utf8"), new RegExp(`TARGET_SKILL_VERSION: "${TARGET_SKILL_VERSION}"`));
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
