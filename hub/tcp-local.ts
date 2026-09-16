/**
 * Hub-local TCP tools — actions the hub performs on this machine instead of
 * proxying a curl template to a remote API.
 *
 * Local tools are identified solely by their request template prefix
 * (`target://<kind>`), never by tool name — the name is only for the agent
 * catalog. Today the only kind is `target://git-clone`, which clones a GitHub
 * repo into the calling workflow's workdir.
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TcpExecuteRequest, TcpExecuteResult } from "./tcp-executor.ts";
import { normalizeInputs, validateInputs } from "./tcp-executor.ts";
import type { TcpTool } from "./tcp-store.ts";

export const LOCAL_TCP_PREFIX = "target://";
const GIT_CLONE_KIND = "git-clone";
const CLONE_TIMEOUT_MS = 5 * 60_000;

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

export function executeLocalTcpTool(
	tool: TcpTool,
	request: TcpExecuteRequest,
	context: TcpLocalContext,
): TcpExecuteResult {
	const kind = localKind(tool);
	if (kind !== GIT_CLONE_KIND) {
		return {
			ok: false,
			error: "unknown_local_tool",
			message: `Unsupported local TCP tool kind '${kind || "(empty)"}'`,
		};
	}

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

	const owner = provided.owner?.trim() ?? "";
	const repo = provided.repo?.trim() ?? "";
	if (!owner || !repo) {
		return { ok: false, error: "invalid_inputs", message: "owner and repo are required" };
	}
	if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
		return { ok: false, error: "invalid_inputs", message: "owner and repo must be simple GitHub names" };
	}

	const workdir = resolveWorkdir(provided, context);
	if (!workdir) {
		return {
			ok: false,
			error: "no_workdir",
			message:
				"No workflow workdir is available for this call. Run this tool from a workflow step so the hub knows where to clone, or pass an explicit workdir input.",
		};
	}

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
	const result = cp.spawnSync(
		"git",
		["clone", "--depth", "1", cloneUrl(owner, repo, githubToken(tool)), dest],
		{
			encoding: "utf8",
			timeout: CLONE_TIMEOUT_MS,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		},
	);
	const durationMs = Date.now() - started;

	if (result.error) {
		const message = result.error instanceof Error ? result.error.message : String(result.error);
		return {
			ok: false,
			error: message.includes("ETIMEDOUT") || message.includes("abort") ? "timeout" : "clone_failed",
			message,
			durationMs,
		};
	}
	if (result.status !== 0) {
		const stderr = (result.stderr ?? "").trim();
		const stdout = (result.stdout ?? "").trim();
		const detail = stderr || stdout || `git clone exited with status ${result.status ?? "unknown"}`;
		return { ok: false, error: "clone_failed", message: detail, durationMs };
	}

	const body = JSON.stringify({
		cloned: true,
		owner,
		repo,
		path: dest,
		defaultBranch: readDefaultBranch(dest),
	});
	return { ok: true, status: 200, body, durationMs };
}

function readDefaultBranch(repoDir: string): string | null {
	const head = path.join(repoDir, ".git", "HEAD");
	if (!fs.existsSync(head)) return null;
	const content = fs.readFileSync(head, "utf8").trim();
	const refPrefix = "ref: refs/heads/";
	if (!content.startsWith(refPrefix)) return null;
	return content.slice(refPrefix.length);
}
