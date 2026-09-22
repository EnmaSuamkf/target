/**
 * Bundled Target Management TCP + resource set bootstrap.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-bundled-"));
process.env.TARGET_HOME = tmpHome;

const {
	ensureBundledCatalog,
	ensureGitHubGitPushTool,
	BUNDLED_TCP_NAME,
	BUNDLED_RESOURCE_SET_NAME,
	BUNDLED_RESOURCE_SKILL_NAME,
	BUNDLED_CREATE_WORKFLOW_SKILL_NAME,
} = await import("./bundled-bootstrap.ts");
const { findTcpByName, insertTcp } = await import("./tcp-store.ts");
const { listResourceSets } = await import("./rci-store.ts");
const { executeTcpTool } = await import("./tcp-executor.ts");

test("ensureBundledCatalog creates TCP and resource set", () => {
	const { tcp, resourceSet } = ensureBundledCatalog({
		host: "127.0.0.1",
		port: 8893,
		adminToken: "test-admin-token",
		stepTimeoutMs: 1,
		stepIdleTimeoutMs: 1,
		stepIdleWarnMs: 1,
		stepHardTimeoutMs: 1,
		progressProbeThrottleMs: 1,
		queuedTimeoutMs: 1,
		maxInputBytes: 1024,
	});
	assert.equal(tcp.name, BUNDLED_TCP_NAME);
	assert.ok(tcp.tools.some((t) => t.name === "list_workflows"));
	assert.equal(tcp.tools[0]?.tokens.TOKEN_1, "test-admin-token");
	assert.equal(resourceSet.name, BUNDLED_RESOURCE_SET_NAME);
	const resourceNames = resourceSet.resources.map((r) => r.name);
	assert.ok(resourceNames.includes(BUNDLED_RESOURCE_SKILL_NAME));
	assert.ok(resourceNames.includes(BUNDLED_CREATE_WORKFLOW_SKILL_NAME));
});

test("ensureBundledCatalog is idempotent and refreshes admin token on TCP", () => {
	ensureBundledCatalog({
		host: "127.0.0.1",
		port: 8893,
		adminToken: "token-a",
		stepTimeoutMs: 1,
		stepIdleTimeoutMs: 1,
		stepIdleWarnMs: 1,
		stepHardTimeoutMs: 1,
		progressProbeThrottleMs: 1,
		queuedTimeoutMs: 1,
		maxInputBytes: 1024,
	});
	const first = findTcpByName(BUNDLED_TCP_NAME);
	assert.ok(first);
	ensureBundledCatalog({
		host: "127.0.0.1",
		port: 8893,
		adminToken: "token-b",
		stepTimeoutMs: 1,
		stepIdleTimeoutMs: 1,
		stepIdleWarnMs: 1,
		stepHardTimeoutMs: 1,
		progressProbeThrottleMs: 1,
		queuedTimeoutMs: 1,
		maxInputBytes: 1024,
	});
	const second = findTcpByName(BUNDLED_TCP_NAME);
	assert.equal(first?.id, second?.id);
	assert.equal(second?.tools[0]?.tokens.TOKEN_1, "token-b");
	assert.equal(listResourceSets().filter((s) => s.name === BUNDLED_RESOURCE_SET_NAME).length, 1);
});

test("ensureGitHubGitPushTool adds git_push to an existing github TCP", () => {
	insertTcp({
		name: "github",
		tools: [
			{
				name: "get_me",
				description: "me",
				requestTemplate: "curl https://api.github.com/user",
				inputs: [],
				tokens: { TOKEN_1: "gh-test" },
			},
		],
	});
	ensureGitHubGitPushTool();
	const github = findTcpByName("github");
	assert.ok(github?.tools.some((t) => t.name === "git_push"));
	const gitPush = github?.tools.find((t) => t.name === "git_push");
	assert.equal(gitPush?.requestTemplate, "target://git-push");
	assert.equal(gitPush?.tokens.TOKEN_1, "gh-test");
	ensureGitHubGitPushTool();
	assert.equal(github?.tools.filter((t) => t.name === "git_push").length, 1);
});

test("list_workflows TCP tool template carries bearer token placeholder", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let seenAuth = "";
	globalThis.fetch = async (_url, init) => {
		seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
		return new Response(JSON.stringify([]), { status: 200 });
	};
	const tcp = findTcpByName(BUNDLED_TCP_NAME)!;
	const tool = tcp.tools.find((x) => x.name === "list_workflows")!;
	const result = await executeTcpTool(tool, { toolName: "list_workflows" });
	assert.equal(result.ok, true);
	assert.match(seenAuth, new RegExp(`Bearer ${tool.tokens.TOKEN_1}`));
});
