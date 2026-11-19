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
import * as os from "node:os";
import * as path from "node:path";
import type { TcpExecuteRequest, TcpExecuteResult } from "./tcp-executor.ts";
import { normalizeInputs, validateInputs } from "./tcp-executor.ts";
import { redactSecrets, registerSecret } from "./redact.ts";
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
			description:
				"Optional absolute path to the git repo (defaults to the workflow workdir). A step may only use a path inside that workflow workdir.",
			required: false,
		},
	],
	tokens: {},
};

/**
 * Who is running a local TCP tool.
 *
 * `step` — a running workflow step whose step credential was accepted.
 * `workdir` is that workflow's own directory and is the boundary: the
 * optional `workdir` input and the clone destination must both realpath
 * inside it (symlinks followed, including a path that does not exist yet).
 * Anything else is `workdir_outside_workflow` and git is not started.
 *
 * `operator` — the hub operator (admin bearer or a logged-in session), not a
 * step. The operator may name any directory the hub user can reach via the
 * `workdir` input. There is no workflow boundary on this call: the operator
 * already has the hub process's filesystem access, and `workdir` on the
 * context is null. Repository names `.` and `..` are still refused for both
 * callers — they are not GitHub repository names, and they would write on
 * or above the chosen directory.
 */
export type TcpLocalCaller = "step" | "operator";

export interface GitSpawnOptions {
	env: NodeJS.ProcessEnv;
	cwd: string;
	timeoutMs: number;
}

/** Spawns git. Tests replace it to inspect argv and environment without a real push. */
export type GitRunner = (args: string[], options: GitSpawnOptions) => cp.SpawnSyncReturns<string>;

export interface TcpLocalContext {
	/** The workflow workdir when the call comes from a running step. Null for an operator call. */
	workdir: string | null;
	caller: TcpLocalCaller;
	/** Test seam. Production omits this and the hub spawns git itself. */
	runGit?: GitRunner;
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
	return context.workdir ? path.resolve(context.workdir) : null;
}

/**
 * Absolute path `candidate` will actually use, following symlinks for every
 * component that exists. A missing suffix (a directory the clone has not
 * created yet) is joined lexically onto the realpath of the longest existing
 * ancestor. Returns null when the path cannot be resolved (a symlink loop,
 * a non-directory in the middle, or no permission to stat it).
 */
function resolveWithinFilesystem(candidate: string, depth = 0): string | null {
	// A symlink loop must fail closed. 40 matches the usual kernel symlink limit.
	if (depth > 40) return null;
	const abs = path.resolve(candidate);
	const root = path.parse(abs).root;
	const parts = abs.slice(root.length).split(path.sep).filter((part) => part.length > 0);
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		const next = path.join(current, parts[i]!);
		let listed: fs.Stats;
		try {
			listed = fs.lstatSync(next);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") return null;
			// Nothing here yet (and not a dangling symlink — lstat would have
			// succeeded). The rest cannot redirect the path.
			return path.resolve(current, ...parts.slice(i));
		}
		if (listed.isSymbolicLink()) {
			let target: string;
			try {
				target = fs.readlinkSync(next);
			} catch {
				return null;
			}
			if (!path.isAbsolute(target)) target = path.resolve(current, target);
			const rest = parts.slice(i + 1);
			const combined = rest.length === 0 ? target : path.resolve(target, ...rest);
			return resolveWithinFilesystem(combined, depth + 1);
		}
		if (!listed.isDirectory()) {
			if (i !== parts.length - 1) return null;
			return next;
		}
		current = next;
	}
	return current;
}

function isInside(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Null when `candidate` is inside the workflow workdir. An error when it is not, or when that workdir cannot be resolved. */
function outsideWorkflow(workflowWorkdir: string | null, candidate: string): TcpExecuteResult | null {
	if (!workflowWorkdir) {
		return {
			ok: false,
			error: "no_workdir",
			message:
				"No workflow workdir is available for this call. Run this tool from a workflow step so the hub knows which repo to use.",
		};
	}
	let root: string;
	try {
		root = fs.realpathSync(workflowWorkdir);
		if (!fs.statSync(root).isDirectory()) {
			return {
				ok: false,
				error: "no_workdir",
				message: "The workflow workdir is not a directory, so this step cannot use a directory.",
			};
		}
	} catch {
		return {
			ok: false,
			error: "no_workdir",
			message: "The workflow workdir does not exist, so this step cannot use a directory.",
		};
	}
	const resolved = resolveWithinFilesystem(candidate);
	if (resolved === null || !isInside(root, resolved)) {
		return {
			ok: false,
			error: "workdir_outside_workflow",
			message: `Refusing ${candidate}: a step can only clone into or push from its own workflow workdir (${workflowWorkdir}).`,
		};
	}
	return null;
}

function githubCloneUrl(owner: string, repo: string): string {
	return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Settings forced on every git the hub runs.
 *
 * Single-valued keys are set through `GIT_CONFIG_*`, which overrides repo,
 * global, and system config. `credential.helper` set to the empty string
 * clears the helper list (git's own reset rule). `url.*.insteadOf` and
 * `include.path` are multi-valued and cannot be cleared that way — a repo
 * value would still rewrite the URL — so push does not read the repo's
 * config at all (a sanitized git dir), and clone runs from a directory that
 * is not inside any repository. System and global config are not read.
 *
 * `protocol.file.allow` stays `never` here. A test that pushes to a local
 * bare repo passes a later pair that sets it to `always`; the hub's own
 * clone and push URLs are https only.
 */
function forcedGitConfig(hooksDir: string, directories: string[]): Array<[string, string]> {
	return [
		["core.hooksPath", hooksDir],
		["core.fsmonitor", ""],
		["core.sshCommand", "ssh"],
		["credential.helper", ""],
		["protocol.allow", "never"],
		["protocol.https.allow", "always"],
		["protocol.http.allow", "never"],
		["protocol.file.allow", "never"],
		["protocol.ext.allow", "never"],
		["protocol.git.allow", "never"],
		["protocol.ssh.allow", "never"],
		["http.proxy", ""],
		["http.followRedirects", "initial"],
		["http.sslVerify", "true"],
		...directories.map((directory): [string, string] => ["safe.directory", directory]),
	];
}

function authorizationHeader(token: string): string {
	return `Authorization: Bearer ${token}`;
}

function redactText(text: string, token?: string): string {
	let out = redactSecrets(text);
	if (token && token.length > 0) out = out.split(token).join("***");
	return out;
}

function tokenProblem(token: string | undefined): TcpExecuteResult | null {
	if (token && /[\r\n\0]/.test(token)) {
		return { ok: false, error: "invalid_token", message: "GitHub token contains a control character" };
	}
	return null;
}

interface GitSandbox {
	root: string;
	hooks: string;
	globalConfig: string;
	cwd: string;
}

function createGitSandbox(): GitSandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "target-git-"));
	const hooks = path.join(root, "hooks");
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(hooks);
	fs.mkdirSync(cwd);
	const globalConfig = path.join(root, "global.gitconfig");
	fs.writeFileSync(globalConfig, "");
	return { root, hooks, globalConfig, cwd };
}

function readGitdirPointer(file: string): string | null {
	const text = fs.readFileSync(file, "utf8").trim();
	const match = /^gitdir:\s*(.+)$/i.exec(text);
	if (!match?.[1]) return null;
	return fs.realpathSync(path.resolve(path.dirname(file), match[1].trim()));
}

function resolveGitDir(workdir: string): string | null {
	const dot = path.join(workdir, ".git");
	let listed: fs.Stats;
	try {
		listed = fs.lstatSync(dot);
	} catch {
		return null;
	}
	try {
		if (listed.isSymbolicLink()) {
			const target = fs.realpathSync(dot);
			const st = fs.statSync(target);
			if (st.isDirectory()) return target;
			if (!st.isFile()) return null;
			return readGitdirPointer(target);
		}
		if (listed.isDirectory()) return fs.realpathSync(dot);
		if (!listed.isFile()) return null;
		return readGitdirPointer(dot);
	} catch {
		return null;
	}
}

function resolveCommonDir(gitDir: string): string {
	const file = path.join(gitDir, "commondir");
	if (!fs.existsSync(file)) return gitDir;
	const rel = fs.readFileSync(file, "utf8").trim();
	if (!rel) return gitDir;
	try {
		return fs.realpathSync(path.resolve(gitDir, rel));
	} catch {
		return gitDir;
	}
}

/** A git dir the agent cannot configure: their objects and refs, none of their config or hooks. */
function prepareSafeGitDir(sandboxRoot: string, workdir: string): { gitDir: string; workTree: string } | null {
	const gitDir = resolveGitDir(workdir);
	if (!gitDir) return null;
	const common = resolveCommonDir(gitDir);
	const safe = path.join(sandboxRoot, "gitdir");
	fs.mkdirSync(path.join(safe, "objects", "info"), { recursive: true });
	fs.mkdirSync(path.join(safe, "hooks"));
	const headFrom = fs.existsSync(path.join(gitDir, "HEAD")) ? path.join(gitDir, "HEAD") : path.join(common, "HEAD");
	if (!fs.existsSync(headFrom)) return null;
	fs.copyFileSync(headFrom, path.join(safe, "HEAD"));
	const index = path.join(gitDir, "index");
	if (fs.existsSync(index) && fs.statSync(index).isFile()) fs.copyFileSync(index, path.join(safe, "index"));
	const refsSrc = path.join(common, "refs");
	if (fs.existsSync(refsSrc)) fs.cpSync(refsSrc, path.join(safe, "refs"), { recursive: true });
	else fs.mkdirSync(path.join(safe, "refs"));
	for (const name of ["packed-refs", "shallow"]) {
		const src = path.join(common, name);
		if (fs.existsSync(src) && fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(safe, name));
	}
	let objectsReal: string;
	try {
		objectsReal = fs.realpathSync(path.join(common, "objects"));
	} catch {
		return null;
	}
	const alternates = [objectsReal];
	const existing = path.join(objectsReal, "info", "alternates");
	if (fs.existsSync(existing)) {
		for (const line of fs.readFileSync(existing, "utf8").split("\n")) {
			const trimmed = line.trim();
			// Git resolves a relative alternate from the objects directory. The
			// sandbox git dir is elsewhere, so store the absolute path.
			if (trimmed && !trimmed.startsWith("#")) alternates.push(path.resolve(objectsReal, trimmed));
		}
	}
	fs.writeFileSync(path.join(safe, "objects", "info", "alternates"), `${alternates.join("\n")}\n`);
	fs.writeFileSync(path.join(safe, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n");
	return { gitDir: safe, workTree: workdir };
}

/**
 * A step's `.git` (directory, `gitdir:` file, or symlink), its common dir,
 * its object store, and any object alternates must realpath inside the
 * workflow workdir. Otherwise the hub would push whatever repository the
 * agent pointed at, using the hub's GitHub token. An operator call is not
 * checked: the operator already named the directory and may be using a
 * linked worktree whose git dir lives outside it.
 */
function gitDirOutsideWorkflow(workflowWorkdir: string | null, repoWorkdir: string): TcpExecuteResult | null {
	const gitDir = resolveGitDir(repoWorkdir);
	if (!gitDir) {
		return { ok: false, error: "not_a_git_repo", message: `No .git directory under ${repoWorkdir}` };
	}
	const common = resolveCommonDir(gitDir);
	const candidates = [gitDir, common];
	try {
		candidates.push(fs.realpathSync(path.join(common, "objects")));
	} catch {
		return { ok: false, error: "not_a_git_repo", message: `No .git directory under ${repoWorkdir}` };
	}
	for (const candidate of candidates) {
		if (outsideWorkflow(workflowWorkdir, candidate)) {
			return {
				ok: false,
				error: "git_dir_outside_workflow",
				message: `Refusing ${candidate}: a step's .git must stay inside its workflow workdir (${workflowWorkdir}).`,
			};
		}
	}
	const alternatesFile = path.join(common, "objects", "info", "alternates");
	if (!fs.existsSync(alternatesFile)) return null;
	for (const line of fs.readFileSync(alternatesFile, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		// Same rule git uses: a relative alternate is relative to the objects directory.
		const resolved = path.resolve(path.join(common, "objects"), trimmed);
		if (outsideWorkflow(workflowWorkdir, resolved)) {
			return {
				ok: false,
				error: "git_dir_outside_workflow",
				message: `Refusing object alternate ${trimmed}: a step's .git must stay inside its workflow workdir (${workflowWorkdir}).`,
			};
		}
	}
	return null;
}

function sandboxedEnv(sandbox: GitSandbox, directories: string[], token: string | undefined, extraConfig: ReadonlyArray<readonly [string, string]>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		// The hub process may have been started with git variables. They must not
		// redirect this command: GIT_DIR would select another repository,
		// GIT_SSH_COMMAND and GIT_EXTERNAL_DIFF would run a program, and
		// GIT_ALTERNATE_OBJECT_DIRECTORIES would read objects from elsewhere.
		if (
			key === "GIT_CONFIG" ||
			key === "GIT_CONFIG_COUNT" ||
			key === "GIT_CONFIG_PARAMETERS" ||
			key === "GIT_DIR" ||
			key === "GIT_WORK_TREE" ||
			key === "GIT_OBJECT_DIRECTORY" ||
			key === "GIT_COMMON_DIR" ||
			key === "GIT_NAMESPACE" ||
			key === "GIT_SSH" ||
			key === "GIT_SSH_COMMAND" ||
			key === "GIT_EXTERNAL_DIFF" ||
			key === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
			key === "GIT_PROXY_COMMAND" ||
			/^GIT_CONFIG_KEY_\d+$/.test(key) ||
			/^GIT_CONFIG_VALUE_\d+$/.test(key)
		) {
			continue;
		}
		env[key] = value;
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_SYSTEM = "/dev/null";
	env.GIT_CONFIG_GLOBAL = sandbox.globalConfig;
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_PAGER = "cat";
	env.GIT_ASKPASS = "/bin/true";
	env.GIT_EDITOR = "/bin/true";
	const pairs: Array<[string, string]> = [
		...forcedGitConfig(sandbox.hooks, directories),
		...extraConfig.map((pair) => [pair[0], pair[1]] as [string, string]),
	];
	if (token) pairs.push(["http.extraHeader", authorizationHeader(token)]);
	env.GIT_CONFIG_COUNT = String(pairs.length);
	pairs.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

function failedSpawn(message: string): cp.SpawnSyncReturns<string> {
	return { pid: 0, output: [null, "", message], stdout: "", stderr: message, status: 1, signal: null };
}

export interface SandboxedGitOptions {
	timeoutMs: number;
	token?: string;
	/** Push and other commands in this working tree use a sanitized copy of its git dir. */
	repoWorkdir?: string;
	runGit?: GitRunner;
	/** Appended after the forced keys. Tests use this to allow a local bare remote. */
	extraConfig?: ReadonlyArray<readonly [string, string]>;
}

function defaultRunGit(args: string[], options: GitSpawnOptions): cp.SpawnSyncReturns<string> {
	return cp.spawnSync("git", args, {
		encoding: "utf8",
		timeout: options.timeoutMs,
		env: options.env,
		cwd: options.cwd,
	});
}

/** Runs git with repo-controlled hooks and config neutralized. The token, when set, is only an Authorization header in the environment. */
export function runSandboxedGit(args: string[], options: SandboxedGitOptions): cp.SpawnSyncReturns<string> {
	if (options.token) registerSecret(options.token);
	const sandbox = createGitSandbox();
	try {
		const directories: string[] = [];
		let gitArgs = args;
		if (options.repoWorkdir) {
			const safe = prepareSafeGitDir(sandbox.root, options.repoWorkdir);
			if (!safe) return failedSpawn(`No .git directory under ${options.repoWorkdir}`);
			directories.push(safe.workTree, safe.gitDir);
			gitArgs = ["--git-dir", safe.gitDir, "--work-tree", safe.workTree, ...args];
		}
		const env = sandboxedEnv(sandbox, directories, options.token, options.extraConfig ?? []);
		return (options.runGit ?? defaultRunGit)(gitArgs, { env, cwd: sandbox.cwd, timeoutMs: options.timeoutMs });
	} finally {
		fs.rmSync(sandbox.root, { recursive: true, force: true });
	}
}

function validateOwnerRepo(owner: string, repo: string): TcpExecuteResult | null {
	if (!owner || !repo) {
		return { ok: false, error: "invalid_inputs", message: "owner and repo are required" };
	}
	// `.` and `..` match the character class below and would make the clone
	// destination the chosen directory or its parent. They are not repository names.
	if (
		owner === "." ||
		owner === ".." ||
		repo === "." ||
		repo === ".." ||
		!/^[A-Za-z0-9_.-]+$/.test(owner) ||
		!/^[A-Za-z0-9_.-]+$/.test(repo)
	) {
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
	// Operator calls are not confined: see `TcpLocalCaller`. Step calls are.
	if (context.caller === "step") {
		const outside = outsideWorkflow(context.workdir, workdir);
		if (outside) return outside;
	}
	return workdir;
}

function gitFailure(prefix: string, result: cp.SpawnSyncReturns<string>, durationMs: number, token?: string): TcpExecuteResult {
	if (result.error) {
		const message = result.error instanceof Error ? result.error.message : String(result.error);
		return {
			ok: false,
			error: message.includes("ETIMEDOUT") || message.includes("abort") ? "timeout" : prefix,
			message: redactText(message, token),
			durationMs,
		};
	}
	const stderr = (result.stderr ?? "").trim();
	const stdout = (result.stdout ?? "").trim();
	const detail = stderr || stdout || `git exited with status ${result.status ?? "unknown"}`;
	return { ok: false, error: prefix, message: redactText(detail, token), durationMs };
}

function executeGitClone(tool: TcpTool, provided: Record<string, string>, context: TcpLocalContext): TcpExecuteResult {
	const owner = provided.owner?.trim() ?? "";
	const repo = provided.repo?.trim() ?? "";
	const invalid = validateOwnerRepo(owner, repo);
	if (invalid) return invalid;

	const workdirResult = requireWorkdir(provided, context);
	if (typeof workdirResult !== "string") return workdirResult;
	const workdir = workdirResult;
	const dest = path.join(workdir, repo);
	// The repo name is a single path segment, but the destination can still
	// leave the workflow workdir through a symlink that already sits there.
	// Checked before mkdir and before git, so a refusal starts no process.
	if (context.caller === "step") {
		const outside = outsideWorkflow(context.workdir, dest);
		if (outside) return outside;
	}

	fs.mkdirSync(workdir, { recursive: true });
	if (fs.existsSync(dest)) {
		return {
			ok: false,
			error: "already_exists",
			message: `Destination already exists: ${dest}`,
		};
	}

	const token = githubToken(tool);
	const badToken = tokenProblem(token);
	if (badToken) return badToken;
	const url = githubCloneUrl(owner, repo);

	const started = Date.now();
	const result = runSandboxedGit(["clone", "--depth", "1", url, dest], {
		timeoutMs: CLONE_TIMEOUT_MS,
		token,
		runGit: context.runGit,
	});
	const durationMs = Date.now() - started;

	if (result.status !== 0) return gitFailure("clone_failed", result, durationMs, token);

	const body = redactText(
		JSON.stringify({
			cloned: true,
			owner,
			repo,
			path: dest,
			defaultBranch: readDefaultBranch(dest),
		}),
		token,
	);
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
	if (context.caller === "step") {
		const escaped = gitDirOutsideWorkflow(context.workdir, workdir);
		if (escaped) return escaped;
	}

	const token = githubToken(tool);
	if (!token) {
		return {
			ok: false,
			error: "missing_token",
			message: "GitHub token is not configured on this TCP tool (GITHUB_TOKEN or TOKEN_1)",
		};
	}
	const badToken = tokenProblem(token);
	if (badToken) return badToken;

	const force = provided.force?.trim().toLowerCase() === "true";
	const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
	const args = ["push", ...(force ? ["--force-with-lease"] : []), githubCloneUrl(owner, repo), refspec];

	const started = Date.now();
	const result = runSandboxedGit(args, {
		timeoutMs: PUSH_TIMEOUT_MS,
		token,
		repoWorkdir: workdir,
		runGit: context.runGit,
	});
	const durationMs = Date.now() - started;

	if (result.status !== 0) return gitFailure("push_failed", result, durationMs, token);

	const body = redactText(JSON.stringify({ pushed: true, owner, repo, branch, workdir, force }), token);
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
