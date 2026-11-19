/**
 * Local TCP tools run on the hub machine (git clone), not via curl.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-tcp-local-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { executeLocalTcpTool, isLocalTcpTool, runSandboxedGit } = await import("./tcp-local.ts");
const { redactSecrets } = await import("./redact.ts");
const { insertWorkflow, insertStep, getStep, markStepRunning } = await import("./db.ts");
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
	tokens: {},
};

const pushTool = {
	name: "git_push",
	description: "Push branch",
	requestTemplate: "target://git-push",
	inputs: [
		{ name: "owner", placeholder: "$INPUT_OWNER", description: "Repository owner", required: true },
		{ name: "repo", placeholder: "$INPUT_REPO", description: "Repository name", required: true },
		{ name: "branch", placeholder: "$INPUT_BRANCH", description: "Branch", required: true },
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
		{ workdir, caller: "step" },
	);
	assert.equal(result.ok, true);
	assert.equal(result.status, 200);
	const body = JSON.parse(result.body ?? "{}") as { cloned: boolean; path: string; owner: string; repo: string };
	assert.equal(body.cloned, true);
	assert.equal(body.owner, "octocat");
	assert.equal(body.repo, "Hello-World");
	assert.equal(body.path, path.join(workdir, "Hello-World"));
	assert.ok(fs.existsSync(path.join(body.path, ".git")));
	assertPlainGithubOrigin(body.path);
});

test("executeLocalTcpTool refuses to clobber an existing directory", () => {
	const workdir = fs.mkdtempSync(path.join(tmpHome, "sandbox-dup-"));
	const dest = path.join(workdir, "Hello-World");
	fs.mkdirSync(dest, { recursive: true });
	const result = executeLocalTcpTool(
		cloneTool,
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World" } },
		{ workdir, caller: "step" },
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "already_exists");
});

test("executeLocalTcpTool needs a workdir when none is supplied", () => {
	const result = executeLocalTcpTool(
		cloneTool,
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World" } },
		{ workdir: null, caller: "operator" },
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "no_workdir");
});

test("isLocalTcpTool recognizes git-push templates", () => {
	assert.equal(isLocalTcpTool({ ...pushTool, requestTemplate: "target://git-push" }), true);
});

test("executeLocalTcpTool git_push validates git repo and branch", () => {
	const workdir = fs.mkdtempSync(path.join(tmpHome, "not-git-"));
	const result = executeLocalTcpTool(
		pushTool,
		{ toolName: "git_push", inputs: { owner: "o", repo: "r", branch: "main", workdir } },
		{ workdir, caller: "step" },
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "not_a_git_repo");
});

test("a step may clone into a subdirectory of its workflow workdir that does not exist yet", () => {
	const workdir = fs.mkdtempSync(path.join(tmpHome, "sandbox-sub-"));
	const sub = path.join(workdir, "not-yet");
	const result = executeLocalTcpTool(
		cloneTool,
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World", workdir: sub } },
		{ workdir, caller: "step" },
	);
	assert.equal(result.ok, true);
	const body = JSON.parse(result.body ?? "{}") as { path: string };
	assert.equal(body.path, path.join(sub, "Hello-World"));
	assert.ok(fs.existsSync(path.join(body.path, ".git")));
	assertPlainGithubOrigin(body.path);
});

test("a step caller cannot point workdir outside its workflow workdir", () => {
	const workdir = fs.mkdtempSync(path.join(tmpHome, "sandbox-bound-"));
	const elsewhere = fs.mkdtempSync(path.join(tmpHome, "elsewhere-"));
	const outsideLink = path.join(workdir, "escape");
	fs.symlinkSync(elsewhere, outsideLink);
	const danglingTarget = path.join(tmpHome, "dangling-target");
	const danglingLink = path.join(workdir, "dangling");
	fs.symlinkSync(danglingTarget, danglingLink);

	const cases = [
		elsewhere,
		path.join(elsewhere, "not-created-yet"),
		"../..",
		outsideLink,
		path.join(outsideLink, "nested"),
		danglingLink,
	];
	for (const attempted of cases) {
		const result = executeLocalTcpTool(
			pushTool,
			{ toolName: "git_push", inputs: { owner: "o", repo: "r", branch: "main", workdir: attempted } },
			{ workdir, caller: "step" },
		);
		assert.equal(result.ok, false, attempted);
		assert.equal(result.error, "workdir_outside_workflow", attempted);
	}
	assert.equal(fs.existsSync(path.join(elsewhere, ".git")), false);
	assert.equal(fs.existsSync(danglingTarget), false);

	const cloned = executeLocalTcpTool(
		cloneTool,
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World", workdir: elsewhere } },
		{ workdir, caller: "step" },
	);
	assert.equal(cloned.ok, false);
	assert.equal(cloned.error, "workdir_outside_workflow");
	assert.equal(fs.existsSync(path.join(elsewhere, "Hello-World")), false);
});

test("a clone destination symlink that points outside the workflow workdir is refused", () => {
	const workdir = fs.mkdtempSync(path.join(tmpHome, "sandbox-dest-"));
	const elsewhere = fs.mkdtempSync(path.join(tmpHome, "dest-elsewhere-"));
	fs.symlinkSync(elsewhere, path.join(workdir, "Hello-World"));
	const result = executeLocalTcpTool(
		cloneTool,
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World" } },
		{ workdir, caller: "step" },
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "workdir_outside_workflow");
	assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("repo names . and .. cannot escape the chosen directory", () => {
	const workdir = fs.mkdtempSync(path.join(tmpHome, "sandbox-dot-"));
	for (const repo of [".", ".."]) {
		const result = executeLocalTcpTool(
			cloneTool,
			{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo } },
			{ workdir, caller: "step" },
		);
		assert.equal(result.ok, false, repo);
		assert.equal(result.error, "invalid_inputs", repo);
	}
	const operator = executeLocalTcpTool(
		cloneTool,
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "..", workdir } },
		{ workdir: null, caller: "operator" },
	);
	assert.equal(operator.ok, false);
	assert.equal(operator.error, "invalid_inputs");
	assert.equal(fs.existsSync(path.join(workdir, ".git")), false);
	assert.equal(fs.existsSync(path.join(path.dirname(workdir), ".git")), false);
});

test("an operator may use a directory outside any workflow workdir", () => {
	const anywhere = fs.mkdtempSync(path.join(tmpHome, "operator-anywhere-"));
	const result = executeLocalTcpTool(
		pushTool,
		{ toolName: "git_push", inputs: { owner: "o", repo: "r", branch: "main", workdir: anywhere } },
		{ workdir: null, caller: "operator" },
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "not_a_git_repo");
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
	markStepRunning(step.id);

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
	assertPlainGithubOrigin(body.path);
});

test("POST /api/tcps/execute refuses a step workdir outside the workflow workdir", async () => {
	const cfg = loadConfig();
	const server = createServer(cfg, () => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	const workdir = fs.mkdtempSync(path.join(tmpHome, "http-bound-"));
	const elsewhere = fs.mkdtempSync(path.join(tmpHome, "http-elsewhere-"));
	const { hookUrl } = createAwbHook("push-agent", workdir, "do work");
	const tcp = insertTcp({ name: "github-push", tools: [pushTool] });
	const workflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "push via tcp",
		agentName: "push-agent",
		hookUrl,
		secret: "s",
		mdPath: path.join(tmpHome, "push.md"),
	});
	setWorkflowTcps(workflow.id, [tcp.id]);
	const step = getStep(insertStep(workflow.id, "push it").id)!;
	markStepRunning(step.id);

	const res = await fetch(`${baseUrl}/api/tcps/execute?stepId=${step.id}&token=${step.callbackToken}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			tcpId: tcp.id,
			toolName: "git_push",
			inputs: { owner: "o", repo: "r", branch: "main", workdir: elsewhere },
		}),
	});
	server.close();

	assert.equal(res.status, 200);
	const { result } = (await res.json()) as { result: { ok: boolean; error?: string } };
	assert.equal(result.ok, false);
	assert.equal(result.error, "workdir_outside_workflow");
	assert.equal(fs.existsSync(path.join(elsewhere, ".git")), false);
});

test("POST /api/tcps/execute lets an operator name any directory", async () => {
	const cfg = loadConfig();
	const server = createServer(cfg, () => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	const anywhere = fs.mkdtempSync(path.join(tmpHome, "http-operator-"));
	const tcp = insertTcp({ name: "github-operator", tools: [pushTool] });
	const res = await fetch(`${baseUrl}/api/tcps/execute`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` },
		body: JSON.stringify({
			tcpId: tcp.id,
			toolName: "git_push",
			inputs: { owner: "o", repo: "r", branch: "main", workdir: anywhere },
		}),
	});
	server.close();

	assert.equal(res.status, 200);
	const { result } = (await res.json()) as { result: { ok: boolean; error?: string } };
	assert.equal(result.ok, false);
	assert.equal(result.error, "not_a_git_repo");
});

function assertPlainGithubOrigin(repoDir: string) {
	const config = fs.readFileSync(path.join(repoDir, ".git", "config"), "utf8");
	assert.equal(config.includes("x-access-token"), false);
	assert.equal(config.includes("extraHeader"), false);
	assert.match(config, /^\[remote "origin"\]/m);
	assert.match(config, /^\turl = https:\/\/github\.com\/octocat\/Hello-World\.git$/m);
}

function gitOk(args: string[], cwd?: string) {
	const result = cp.spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result;
}

function writeExecutable(file: string, body: string) {
	fs.writeFileSync(file, body);
	fs.chmodSync(file, 0o755);
}

function fakeGitResult(stderr: string, status = 1): cp.SpawnSyncReturns<string> {
	return { pid: 0, output: [null, "", stderr], stdout: "", stderr, status, signal: null };
}

test("sandboxed git does not run pre-push hooks, a core.hooksPath hook, or an insteadOf rewrite", () => {
	const root = fs.mkdtempSync(path.join(tmpHome, "hooks-"));
	const repo = path.join(root, "repo");
	const bare = path.join(root, "bare.git");
	const stolen = path.join(root, "stolen.git");
	const marker = path.join(root, "marker");
	const evilHooks = path.join(root, "evil-hooks");
	fs.mkdirSync(evilHooks);
	gitOk(["init", "--bare", bare]);
	gitOk(["init", "--bare", stolen]);
	gitOk(["init", repo]);
	gitOk(["config", "user.email", "t@example.com"], repo);
	gitOk(["config", "user.name", "t"], repo);
	fs.writeFileSync(path.join(repo, "f.txt"), "hi\n");
	gitOk(["add", "f.txt"], repo);
	gitOk(["commit", "-m", "c"], repo);
	gitOk(["branch", "-M", "main"], repo);
	writeExecutable(path.join(repo, ".git", "hooks", "pre-push"), `#!/bin/sh\necho default >> "${marker}"\n`);
	writeExecutable(path.join(evilHooks, "pre-push"), `#!/bin/sh\necho hookspath >> "${marker}"\n`);
	gitOk(["config", "core.hooksPath", evilHooks], repo);

	const control = cp.spawnSync("git", ["push", bare, "HEAD:refs/heads/main"], { cwd: repo, encoding: "utf8" });
	assert.equal(control.status, 0, control.stderr);
	assert.match(fs.readFileSync(marker, "utf8"), /hookspath/);

	fs.rmSync(marker, { force: true });
	const bare2 = path.join(root, "bare2.git");
	gitOk(["init", "--bare", bare2]);
	// A local path is not rewritten; a file:// URL is. `file://` is the shortest
	// prefix, so this repo config would send every file URL at `stolen`.
	gitOk(["config", `url.${stolen}/.insteadof`, "file://"], repo);
	const fileUrl = `file://${bare2}`;
	const rewritten = cp.spawnSync("git", ["ls-remote", fileUrl], { cwd: repo, encoding: "utf8" });
	assert.notEqual(rewritten.status, 0);
	assert.match(rewritten.stderr, /stolen/);
	const sandboxed = runSandboxedGit(["push", fileUrl, "refs/heads/main:refs/heads/main"], {
		timeoutMs: 30_000,
		repoWorkdir: repo,
		extraConfig: [["protocol.file.allow", "always"]],
	});
	assert.equal(sandboxed.status, 0, sandboxed.stderr);
	assert.equal(fs.existsSync(marker), false);
	const source = gitOk(["rev-parse", "main"], repo).stdout.trim();
	const pushed = gitOk(["--git-dir", bare2, "rev-parse", "main"]).stdout.trim();
	assert.equal(pushed, source);
	assert.equal(fs.existsSync(path.join(stolen, "refs", "heads", "main")), false);
});

test("sandboxed git does not run a core.fsmonitor script", () => {
	const root = fs.mkdtempSync(path.join(tmpHome, "fsmonitor-"));
	const repo = path.join(root, "repo");
	const marker = path.join(root, "marker");
	const script = path.join(root, "fsmonitor");
	gitOk(["init", repo]);
	writeExecutable(script, `#!/bin/sh\necho ran >> "${marker}"\nprintf '\\n'\n`);
	gitOk(["config", "core.fsmonitor", script], repo);
	fs.writeFileSync(path.join(repo, "f.txt"), "hi\n");

	const control = cp.spawnSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" });
	assert.equal(control.status, 0, control.stderr);
	assert.match(fs.readFileSync(marker, "utf8"), /ran/);

	fs.rmSync(marker);
	const sandboxed = runSandboxedGit(["status", "--short"], { timeoutMs: 30_000, repoWorkdir: repo });
	assert.equal(sandboxed.status, 0, sandboxed.stderr);
	assert.equal(fs.existsSync(marker), false);
});

test("git argv and the cloned config do not contain the token", () => {
	const token = "local-git-token-9f3a2c7b";
	const root = fs.mkdtempSync(path.join(tmpHome, "token-argv-"));
	const repo = path.join(root, "repo");
	gitOk(["init", repo]);
	gitOk(["config", "user.email", "t@example.com"], repo);
	gitOk(["config", "user.name", "t"], repo);
	fs.writeFileSync(path.join(repo, "f.txt"), "hi\n");
	gitOk(["add", "f.txt"], repo);
	gitOk(["commit", "-m", "c"], repo);
	gitOk(["branch", "-M", "main"], repo);

	let pushArgs: string[] = [];
	const push = executeLocalTcpTool(
		pushToolWith(token),
		{ toolName: "git_push", inputs: { owner: "octocat", repo: "Hello-World", branch: "main" } },
		{
			workdir: repo,
			caller: "step",
			runGit: (args) => {
				pushArgs = args;
				return fakeGitResult("rejected");
			},
		},
	);
	assert.equal(push.ok, false);
	assert.equal(pushArgs.join("\n").includes(token), false);
	assert.ok(pushArgs.includes("https://github.com/octocat/Hello-World.git"));

	let cloneArgs: string[] = [];
	let cloneEnv: NodeJS.ProcessEnv = {};
	const clone = executeLocalTcpTool(
		cloneToolWith(token),
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World" } },
		{
			workdir: root,
			caller: "step",
			runGit: (args, options) => {
				cloneArgs = args;
				cloneEnv = options.env;
				return fakeGitResult("rejected");
			},
		},
	);
	assert.equal(clone.ok, false);
	assert.equal(cloneArgs.join("\n").includes(token), false);
	assert.ok(cloneArgs.includes("https://github.com/octocat/Hello-World.git"));
	assert.ok(Object.values(cloneEnv).includes(`Authorization: Bearer ${token}`));

	const bare = path.join(root, "bare.git");
	const dest = path.join(root, "cloned");
	gitOk(["init", "--bare", bare]);
	const cloned = runSandboxedGit(["clone", bare, dest], { timeoutMs: 30_000, token, extraConfig: [["protocol.file.allow", "always"]] });
	assert.equal(cloned.status, 0, cloned.stderr);
	const config = fs.readFileSync(path.join(dest, ".git", "config"), "utf8");
	assert.equal(config.includes(token), false);
	assert.equal(config.includes("extraHeader"), false);
	assert.equal(config.includes("Authorization"), false);
});

test("a git error that echoes the token is redacted before it is returned", () => {
	const token = "echoed-git-token-77aa11";
	const workdir = fs.mkdtempSync(path.join(tmpHome, "redact-"));
	const result = executeLocalTcpTool(
		cloneToolWith(token),
		{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World" } },
		{
			workdir,
			caller: "step",
			runGit: () => fakeGitResult(`fatal: Authentication failed for bearer ${token} at https://x-access-token:${token}@github.com/octocat/Hello-World.git`),
		},
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "clone_failed");
	assert.equal(result.message?.includes(token), false);
	assert.match(result.message ?? "", /\*\*\*/);
	assert.equal(redactSecrets(`log line ${token}`).includes(token), false);
});

test("a step cannot follow a .git file or symlink that points outside the workflow workdir", () => {
	const root = fs.mkdtempSync(path.join(tmpHome, "gitfile-"));
	const workdir = path.join(root, "work");
	const outside = path.join(root, "outside");
	const marker = path.join(root, "marker");
	fs.mkdirSync(workdir);
	gitOk(["init", outside]);
	gitOk(["config", "user.email", "t@example.com"], outside);
	gitOk(["config", "user.name", "t"], outside);
	fs.writeFileSync(path.join(outside, "secret.txt"), "x\n");
	gitOk(["add", "secret.txt"], outside);
	gitOk(["commit", "-m", "c"], outside);
	gitOk(["branch", "-M", "main"], outside);
	writeExecutable(path.join(outside, ".git", "hooks", "pre-push"), `#!/bin/sh\necho ran >> "${marker}"\n`);

	fs.writeFileSync(path.join(workdir, ".git"), `gitdir: ${path.join(outside, ".git")}\n`);
	const byFile = executeLocalTcpTool(
		pushTool,
		{ toolName: "git_push", inputs: { owner: "o", repo: "r", branch: "main" } },
		{
			workdir,
			caller: "step",
			runGit: () => {
				throw new Error("git must not start");
			},
		},
	);
	assert.equal(byFile.ok, false);
	assert.equal(byFile.error, "git_dir_outside_workflow");
	assert.equal(fs.existsSync(marker), false);

	fs.rmSync(path.join(workdir, ".git"));
	fs.writeFileSync(path.join(workdir, ".git"), "gitdir: ../outside/.git\n");
	const byRelative = executeLocalTcpTool(
		pushTool,
		{ toolName: "git_push", inputs: { owner: "o", repo: "r", branch: "main" } },
		{ workdir, caller: "step", runGit: () => { throw new Error("git must not start"); } },
	);
	assert.equal(byRelative.ok, false);
	assert.equal(byRelative.error, "git_dir_outside_workflow");

	fs.rmSync(path.join(workdir, ".git"));
	fs.symlinkSync(path.join(outside, ".git"), path.join(workdir, ".git"));
	const byLink = executeLocalTcpTool(
		pushTool,
		{ toolName: "git_push", inputs: { owner: "o", repo: "r", branch: "main" } },
		{ workdir, caller: "step", runGit: () => { throw new Error("git must not start"); } },
	);
	assert.equal(byLink.ok, false);
	assert.equal(byLink.error, "git_dir_outside_workflow");
	assert.equal(fs.existsSync(marker), false);
	// The symlink already points outside, so the alternate is not the first refusal.
	// A repository that itself stays inside the workdir, with only the alternate outside:
	const inside = path.join(workdir, "inside");
	gitOk(["init", inside]);
	fs.mkdirSync(path.join(inside, ".git", "objects", "info"), { recursive: true });
	const relativeOutside = path.relative(path.join(inside, ".git", "objects"), path.join(outside, ".git", "objects"));
	fs.writeFileSync(path.join(inside, ".git", "objects", "info", "alternates"), `${relativeOutside}\n`);
	const byAlternate = executeLocalTcpTool(
		pushTool,
		{ toolName: "git_push", inputs: { owner: "o", repo: "r", branch: "main", workdir: inside } },
		{ workdir, caller: "step", runGit: () => { throw new Error("git must not start"); } },
	);
	assert.equal(byAlternate.ok, false);
	assert.equal(byAlternate.error, "git_dir_outside_workflow");
});

test("an operator may push a workdir whose gitdir file points elsewhere", () => {
	const root = fs.mkdtempSync(path.join(tmpHome, "operator-gitfile-"));
	const named = path.join(root, "named");
	const real = path.join(root, "real");
	fs.mkdirSync(named);
	gitOk(["init", real]);
	fs.writeFileSync(path.join(named, ".git"), `gitdir: ${path.join(real, ".git")}\n`);
	let called = false;
	const result = executeLocalTcpTool(
		pushTool,
		{ toolName: "git_push", inputs: { owner: "o", repo: "r", branch: "main", workdir: named } },
		{
			workdir: null,
			caller: "operator",
			runGit: () => {
				called = true;
				return fakeGitResult("rejected");
			},
		},
	);
	assert.equal(called, true);
	assert.equal(result.error, "push_failed");
});

test("sandboxed git drops inherited GIT_DIR and program-selecting variables", () => {
	const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_ALTERNATE_OBJECT_DIRECTORIES"] as const;
	const previous = new Map<string, string | undefined>();
	for (const name of names) previous.set(name, process.env[name]);
	process.env.GIT_DIR = "/tmp/attacker-git";
	process.env.GIT_WORK_TREE = "/tmp/attacker-work";
	process.env.GIT_SSH_COMMAND = "touch /tmp/pwned";
	process.env.GIT_PROXY_COMMAND = "touch /tmp/pwned-proxy";
	process.env.GIT_EXTERNAL_DIFF = "/tmp/evil-diff";
	process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = "/tmp/other/objects";
	try {
		let env: NodeJS.ProcessEnv = {};
		executeLocalTcpTool(
			cloneToolWith("env-git-token-abc12345"),
			{ toolName: "clone_a_repo", inputs: { owner: "octocat", repo: "Hello-World" } },
			{
				workdir: fs.mkdtempSync(path.join(tmpHome, "env-drop-")),
				caller: "step",
				runGit: (_args, options) => {
					env = options.env;
					return fakeGitResult("no");
				},
			},
		);
		for (const name of names) assert.equal(env[name], undefined, name);
		assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

function cloneToolWith(token: string) {
	return { ...cloneTool, tokens: { GITHUB_TOKEN: token } };
}

function pushToolWith(token: string) {
	return { ...pushTool, tokens: { GITHUB_TOKEN: token } };
}

test.after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
});
