/**
 * Hub-local TCP tools — actions the hub performs on this machine instead of
 * proxying a curl template to a remote API.
 *
 * Local tools are identified solely by their request template prefix
 * (`target://<kind>`), never by tool name — the name is only for the agent
 * catalog. Kinds include `target://git-clone` (clone into the workdir) and
 * `target://git-push` (push a branch from the workdir without sending file
 * bytes through `/api/tcps/execute`).
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TcpExecuteRequest, TcpExecuteResult } from "./tcp-executor.ts";
import { normalizeInputs, validateInputs } from "./tcp-executor.ts";
import type { TcpTool } from "./tcp-store.ts";

export const LOCAL_TCP_PREFIX = "target://";
const GIT_CLONE_KIND = "git-clone";
const GIT_PUSH_KIND = "git-push";
const CLONE_TIMEOUT_MS = 5 * 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;

/** Shipped with the hub; merged into a TCP named "github" on startup when missing. */
export const GIT_PUSH_TOOL: TcpTool = {
	name: "git_push",
	description:
		"Push a local branch from the workflow workdir to GitHub. File contents stay on disk — only branch metadata goes through the hub API.",
	requestTemplate: "target://git-push",
	inputs: [
		{ name: "owner", placeholder: "$INPUT_OWNER", description: "Repository owner", required: true },
		{ name: "repo", placeholder: "$INPUT_REPO", description: "Repository name", required: true },
		{ name: "branch", placeholder: "$INPUT_BRANCH", description: "Local branch name to push", required: true },
		{
			name: "force",
			placeholder: "$INPUT_FORCE",
			description: "Set to true to pass --force-with-lease (recreate a deleted remote branch safely)",
			required: false,
		},
		{
			name: "workdir",
			placeholder: "$INPUT_WORKDIR",
			description: "Optional absolute path to the git repo (defaults to the workflow workdir)",
			required: false,
		},
	],
	tokens: {},
};

export interface TcpLocalContext {
	/** The workflow workdir when the call comes from a running step. */
	workdir: string | null;
}

export function isLocalTcpTool(tool: TcpTool): boolean {
	return tool.requestTemplate.trim().startsWith(LOCAL_TCP_PREFIX);
}

function localKind(tool: TcpTool): string {
	const template = tool.requestTemplate.trim();
	if (!template.startsWith(LOCAL_TCP_PREFIX)) return "";
	return template.slice(LOCAL_TCP_PREFIX.length).split(/[/?#]/)[0] ?? "";
}

function githubToken(tool: TcpTool): string | undefined {
	for (const key of ["GITHUB_TOKEN", "TOKEN_1"]) {
		const value = tool.tokens[key]?.trim();
		if (value) return value;
	}
	for (const value of Object.values(tool.tokens)) {
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function resolveWorkdir(provided: Record<string, string>, context: TcpLocalContext): string | null {
	const override = provided.workdir?.trim();
	if (override) return path.resolve(override);
	return context.workdir;
}

function cloneUrl(owner: string, repo: string, token?: string): string {
	const base = `https://github.com/${owner}/${repo}.git`;
	if (!token) return base;
	return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

function validateOwnerRepo(owner: string, repo: string): TcpExecuteResult | null {
	if (!owner || !repo) {
		return { ok: false, error: "invalid_inputs", message: "owner and repo are required" };
	}
	if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
		return { ok: false, error: "invalid_inputs", message: "owner and repo must be simple GitHub names" };
	}
	return null;
}

function requireWorkdir(provided: Record<string, string>, context: TcpLocalContext): string | TcpExecuteResult {
	const workdir = resolveWorkdir(provided, context);
	if (!workdir) {
		return {
			ok: false,
			error: "no_workdir",
			message:
				"No workflow workdir is available for this call. Run this tool from a workflow step so the hub knows which repo to use, or pass an explicit workdir input.",
		};
	}
	return workdir;
}

function runGit(args: string[], timeoutMs: number): cp.SpawnSyncReturns<string> {
	return cp.spawnSync("git", args, {
		encoding: "utf8",
		timeout: timeoutMs,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
}

function gitFailure(prefix: string, result: cp.SpawnSyncReturns<string>, durationMs: number): TcpExecuteResult {
	if (result.error) {
		const message = result.error instanceof Error ? result.error.message : String(result.error);
		return {
			ok: false,
			error: message.includes("ETIMEDOUT") || message.includes("abort") ? "timeout" : prefix,
			message,
			durationMs,
		};
	}
	const stderr = (result.stderr ?? "").trim();
	const stdout = (result.stdout ?? "").trim();
	const detail = stderr || stdout || `git exited with status ${result.status ?? "unknown"}`;
	return { ok: false, error: prefix, message: detail, durationMs };
}

function executeGitClone(tool: TcpTool, provided: Record<string, string>, context: TcpLocalContext): TcpExecuteResult {
	const owner = provided.owner?.trim() ?? "";
	const repo = provided.repo?.trim() ?? "";
	const invalid = validateOwnerRepo(owner, repo);
	if (invalid) return invalid;

	const workdirResult = requireWorkdir(provided, context);
	if (typeof workdirResult !== "string") return workdirResult;
	const workdir = workdirResult;

	fs.mkdirSync(workdir, { recursive: true });
	const dest = path.join(workdir, repo);
	if (fs.existsSync(dest)) {
		return {
			ok: false,
			error: "already_exists",
			message: `Destination already exists: ${dest}`,
		};
	}

	const started = Date.now();
	const result = runGit(["clone", "--depth", "1", cloneUrl(owner, repo, githubToken(tool)), dest], CLONE_TIMEOUT_MS);
	const durationMs = Date.now() - started;

	if (result.status !== 0) return gitFailure("clone_failed", result, durationMs);

	const body = JSON.stringify({
		cloned: true,
		owner,
		repo,
		path: dest,
		defaultBranch: readDefaultBranch(dest),
	});
	return { ok: true, status: 200, body, durationMs };
}

function executeGitPush(tool: TcpTool, provided: Record<string, string>, context: TcpLocalContext): TcpExecuteResult {
	const owner = provided.owner?.trim() ?? "";
	const repo = provided.repo?.trim() ?? "";
	const branch = provided.branch?.trim() ?? "";
	const invalid = validateOwnerRepo(owner, repo);
	if (invalid) return invalid;
	if (!branch) {
		return { ok: false, error: "invalid_inputs", message: "branch is required" };
	}
	if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) {
		return { ok: false, error: "invalid_inputs", message: "branch must be a simple git branch name" };
	}

	const workdirResult = requireWorkdir(provided, context);
	if (typeof workdirResult !== "string") return workdirResult;
	const workdir = workdirResult;

	if (!fs.existsSync(path.join(workdir, ".git"))) {
		return {
			ok: false,
			error: "not_a_git_repo",
			message: `No .git directory under ${workdir}`,
		};
	}

	const token = githubToken(tool);
	if (!token) {
		return {
			ok: false,
			error: "missing_token",
			message: "GitHub token is not configured on this TCP tool (GITHUB_TOKEN or TOKEN_1)",
		};
	}

	const force = provided.force?.trim().toLowerCase() === "true";
	const pushUrl = cloneUrl(owner, repo, token);
	const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
	const args = ["-C", workdir, "push", ...(force ? ["--force-with-lease"] : []), pushUrl, refspec];

	const started = Date.now();
	const result = runGit(args, PUSH_TIMEOUT_MS);
	const durationMs = Date.now() - started;

	if (result.status !== 0) return gitFailure("push_failed", result, durationMs);

	const body = JSON.stringify({
		pushed: true,
		owner,
		repo,
		branch,
		workdir,
		force,
	});
	return { ok: true, status: 200, body, durationMs };
}

export function executeLocalTcpTool(
	tool: TcpTool,
	request: TcpExecuteRequest,
	context: TcpLocalContext,
): TcpExecuteResult {
	const kind = localKind(tool);
	const provided = normalizeInputs(tool, request);
	const missing = validateInputs(tool, provided);
	if (missing.length > 0) {
		return {
			ok: false,
			error: "missing_inputs",
			message: `Missing required inputs: ${missing.join(", ")}`,
			missing,
		};
	}

	switch (kind) {
		case GIT_CLONE_KIND:
			return executeGitClone(tool, provided, context);
		case GIT_PUSH_KIND:
			return executeGitPush(tool, provided, context);
		default:
			return {
				ok: false,
				error: "unknown_local_tool",
				message: `Unsupported local TCP tool kind '${kind || "(empty)"}'`,
			};
	}
}

function readDefaultBranch(repoDir: string): string | null {
	const head = path.join(repoDir, ".git", "HEAD");
	if (!fs.existsSync(head)) return null;
	const content = fs.readFileSync(head, "utf8").trim();
	const refPrefix = "ref: refs/heads/";
	if (!content.startsWith(refPrefix)) return null;
	return content.slice(refPrefix.length);
}
