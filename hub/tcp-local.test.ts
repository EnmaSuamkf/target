/**
 * Local TCP tools run on the hub machine (git clone), not via curl.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-tcp-local-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { executeLocalTcpTool, isLocalTcpTool } = await import("./tcp-local.ts");
const { insertWorkflow, insertStep, getStep } = await import("./db.ts");
const { insertTcp, setWorkflowTcps } = await import("./tcp-store.ts");
const { createAwbHook } = await import("./awb.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cloneTool = {
	name: "clone_a_repo",
	description: "Clone a GitHub repository into the workflow workdir",
	requestTemplate: "target://git-clone",
	inputs: [
		{ name: "owner", placeholder: "$INPUT_OWNER", description: "Repository owner", required: true },
		{ name: "repo", placeholder: "$INPUT_REPO", description: "Repository name", required: true },
	],
	tokens: { GITHUB_TOKEN: "test-token" },
};

test("isLocalTcpTool is driven only by the request template prefix, not the tool name", () => {
	assert.equal(isLocalTcpTool(cloneTool), true);
	assert.equal(isLocalTcpTool({ ...cloneTool, name: "totally_different_name" }), true);
	assert.equal(isLocalTcpTool({ ...cloneTool, requestTemplate: "curl https://example.com" }), false);
});

test("executeLocalTcpTool clones into the workflow workdir", () => {
	const workdir = fs.mkdtempSync(path.join(tmpHome, "sandbox-"));
	const result = executeLocalTcpTool(
		cloneTool,
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World" } },
		{ workdir },
	);
	assert.equal(result.ok, true);
	assert.equal(result.status, 200);
	const body = JSON.parse(result.body ?? "{}") as { cloned: boolean; path: string; owner: string; repo: string };
	assert.equal(body.cloned, true);
	assert.equal(body.owner, "octocat");
	assert.equal(body.repo, "Hello-World");
	assert.equal(body.path, path.join(workdir, "Hello-World"));
	assert.ok(fs.existsSync(path.join(body.path, ".git")));
});

test("executeLocalTcpTool refuses to clobber an existing directory", () => {
	const workdir = fs.mkdtempSync(path.join(tmpHome, "sandbox-dup-"));
	const dest = path.join(workdir, "Hello-World");
	fs.mkdirSync(dest, { recursive: true });
	const result = executeLocalTcpTool(
		cloneTool,
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World" } },
		{ workdir },
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "already_exists");
});

test("executeLocalTcpTool needs a workdir when none is supplied", () => {
	const result = executeLocalTcpTool(
		cloneTool,
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World" } },
		{ workdir: null },
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "no_workdir");
});

test("POST /api/tcps/execute runs a target://git-clone tool into the calling workflow's workdir", async () => {
	const cfg = loadConfig();
	const server = createServer(cfg, () => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	const workdir = fs.mkdtempSync(path.join(tmpHome, "http-sandbox-"));
	const { hookUrl } = createAwbHook("clone-agent", workdir, "do work");
	const tcp = insertTcp({ name: "github", tools: [cloneTool] });
	const workflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "clone via tcp",
		agentName: "clone-agent",
		hookUrl,
		secret: "s",
		mdPath: path.join(tmpHome, "clone.md"),
	});
	setWorkflowTcps(workflow.id, [tcp.id]);
	const step = getStep(insertStep(workflow.id, "clone it").id)!;

	const res = await fetch(
		`${baseUrl}/api/tcps/execute?stepId=${step.id}&token=${step.callbackToken}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				tcpId: tcp.id,
				toolName: "clone_a_repo",
				inputs: { owner: "octocat", repo: "Hello-World" },
			}),
		},
	);
	server.close();

	assert.equal(res.status, 200);
	const { result } = (await res.json()) as { result: { ok: boolean; body: string } };
	assert.equal(result.ok, true);
	const body = JSON.parse(result.body) as { path: string };
	assert.ok(fs.existsSync(path.join(body.path, ".git")));
});

test.after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
});
