/**
 * Bridge to the local agent-webhook-bridge install: the hub creates hooks by
 * writing awb's hooks.json directly — the broker re-reads that file on every
 * request, so a hook registered here is live immediately, no restart. Same
 * file format `awb add` writes (agent-webhook-bridge/broker/config.ts); the
 * hub only ever adds "trigger" hooks with the fields the mesh needs.
 *
 * This only works while hub and broker share a machine (phase 1). Remote
 * nodes in phase 2 will register their own hooks and use the "existing hook"
 * path instead.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cp from "node:child_process";

interface AwbConfig {
	host: string;
	port: number;
	maxBodyBytes: number;
	publicBaseUrl: string | null;
	hooks: Record<string, Record<string, unknown>>;
}

// Mirrors awb's own defaults so a machine where the broker has never saved
// its config yet still gets a valid hooks.json.
const AWB_DEFAULTS: Omit<AwbConfig, "hooks"> = {
	host: "127.0.0.1",
	port: 8890,
	maxBodyBytes: 1024 * 1024,
	publicBaseUrl: null,
};

/**
 * awb's home directory (`~/.agent-webhook-bridge`, or `AWB_HOME`). Exported
 * because progress.ts reads the run logs and free-code session files awb keeps
 * under it to tell whether a step's agent is still doing anything.
 */
export function awbDir(): string {
	return process.env.AWB_HOME ?? path.join(os.homedir(), ".agent-webhook-bridge");
}

function awbConfigFile(): string {
	return path.join(awbDir(), "hooks.json");
}

function loadAwbConfig(): AwbConfig {
	let fileCfg: Partial<AwbConfig> = {};
	try {
		fileCfg = JSON.parse(fs.readFileSync(awbConfigFile(), "utf8")) as Partial<AwbConfig>;
	} catch {
		// Missing/invalid config file → fall back to defaults.
	}
	return { ...AWB_DEFAULTS, ...fileCfg, hooks: { ...(fileCfg.hooks ?? {}) } };
}

export class HookExistsError extends Error {}

export interface LocalHookInfo {
	/** false when the URL doesn't point at this machine's awb broker. */
	local: boolean;
	found?: boolean;
	name?: string;
	hasWorkdir?: boolean;
}

/**
 * Looks a hook URL up in the local awb config, so registration can warn
 * about hooks that don't exist or lack a workdir (a workdir-less hook runs
 * in whatever folder the broker was started from, which moves its Claude
 * sessions — and its project context — across broker restarts). Remote URLs
 * come back `local: false` and are never judged: phase 2 nodes manage their
 * own hooks.
 */
export function inspectLocalHook(hookUrl: string): LocalHookInfo {
	let url: URL;
	try {
		url = new URL(hookUrl);
	} catch {
		return { local: false };
	}
	const cfg = loadAwbConfig();
	const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
	if (!loopback.has(url.hostname) || Number(url.port || 80) !== cfg.port) return { local: false };
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts[0] !== "hook" || !parts[1]) return { local: false };
	const name = decodeURIComponent(parts[1]);
	const hook = cfg.hooks[name];
	if (!hook) return { local: true, found: false, name };
	return { local: true, found: true, name, hasWorkdir: typeof hook.workdir === "string" && hook.workdir !== "" };
}

/** The docker half of a hook's `sandbox` block, as awb's broker/config.ts writes it. */
export interface HookSandbox {
	kind: "docker";
	image: string;
}

export interface HookRuntime {
	/** Harness the hook spawns, from its `consumers` list (`spawn:claude` → "claude"). */
	harness: string | null;
	/** Directory the harness runs in — where its sessions can be resumed from. */
	workdir: string | null;
	/**
	 * The hook's containment: null when its agent runs straight on the host
	 * (every hook written before the sandbox choice existed, and every
	 * `sandbox: "host"` one since). Orthogonal to `harness` — the harness says
	 * WHICH CLI runs, this says WHERE.
	 */
	sandbox: HookSandbox | null;
}

/**
 * How the hook runs its jobs. Only answerable for hooks on this machine's
 * broker; remote hooks (phase 2) come back all-null. The workdir is a local
 * path, which is fine to expose while the hub is local-only.
 */
export function hookRuntime(hookUrl: string): HookRuntime {
	const info = inspectLocalHook(hookUrl);
	if (!info.local || !info.found || !info.name) return { harness: null, workdir: null, sandbox: null };
	const hook = loadAwbConfig().hooks[info.name];
	const consumers = Array.isArray(hook?.consumers) ? (hook.consumers as unknown[]) : [];
	let harness: string | null = null;
	for (const consumer of consumers) {
		if (typeof consumer === "string" && consumer.startsWith("spawn:")) {
			harness = consumer.slice("spawn:".length);
			break;
		}
	}
	const workdir = typeof hook?.workdir === "string" && hook.workdir !== "" ? hook.workdir : null;
	const block = hook?.sandbox as { kind?: unknown; image?: unknown } | undefined;
	const sandbox =
		block?.kind === "docker" && typeof block.image === "string" && block.image !== ""
			? { kind: "docker" as const, image: block.image }
			: null;
	return { harness, workdir, sandbox };
}

/**
 * POSIX single-quoting, escaping an embedded `'` as `'\''` — shared by every
 * caller that drops a DB-derived value (workdir, sessionId) into a shell
 * command. Those values aren't attacker input here, but the hub now actually
 * executes this string (terminal.ts spawns it in a real shell), not just
 * displays it, so it's quoted as if it might be.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell command that reopens a harness session in a terminal, keyed by the
 * harness name `hookRuntime` reports. awb ships the `spawn:claude` and
 * `spawn:free-code` adapters (broker/dispatch.ts); their resume mechanics
 * differ — claude resumes by session uuid, free-code by the session's .jsonl
 * path (`--session <path>`) — but both reopen the exact conversation the
 * workflow's steps have been chaining.
 */
const HARNESS_RESUME_COMMANDS: Record<string, (sessionId: string) => string> = {
	claude: (sessionId) => `claude --resume ${shellQuote(sessionId)}`,
	"free-code": (sessionId) => `free-code --session ${shellQuote(sessionId)}`,
};

/**
 * Resource caps and mount list mirroring awb's
 * `adapters/spawn-runner/sandbox.ts`, the same way `AWB_DEFAULTS` above
 * mirrors awb's config defaults. The hub can't import from the broker's tree
 * (they're separate installs), and this only has to agree with it well enough
 * that the terminal the operator opens lands in the SAME container shape the
 * steps ran in — above all the identical `-v`/`-w` paths, without which the
 * resumed session simply isn't there.
 */
const SANDBOX_LIMITS = { memory: "4g", cpus: "2", pidsLimit: 512 } as const;

function existingPaths(paths: string[]): string[] {
	return paths.filter((p) => {
		try {
			return fs.existsSync(p);
		} catch {
			return false;
		}
	});
}

/**
 * Host paths holding a harness's own state, mirroring awb's
 * `harnessStateMounts()` in `adapters/spawn-runner/sandbox.ts`. Each is mounted
 * at its own absolute path, so the session the steps built is the same session
 * this terminal reopens:
 *
 *  - `~/.claude` — Claude Code's config, credentials and `projects/<slug>/`
 *    transcripts.
 *  - `~/.claude.json` — Claude Code's top-level config file.
 *  - `~/.free-code` — free-code's config, credentials, models and profiles.
 *    Not optional: `runMigrations()` runs on every start and `mkdir`s
 *    `agent/themes/bundled` under `$HOME` before anything else, so without this
 *    mount "Open conversation" on a free-code docker workflow dies with
 *    `EACCES … mkdir '$HOME/.free-code/agent/themes/bundled'` instead of
 *    opening. `$HOME` itself is deliberately never mounted (that would hand the
 *    container the operator's whole home), and the `$HOME` docker synthesises
 *    to hold these mounts is root-owned, so every directory the harness writes
 *    to has to be named here.
 *  - `<awbDir>/sessions` — free-code resumes by absolute `.jsonl` path, so that
 *    path has to resolve inside the container too. Only the sessions
 *    subdirectory: the awb dir itself holds `hooks.json`, i.e. every hook's
 *    shared secret.
 *
 * Not conditioned on the workflow's harness, for the same reason awb doesn't
 * condition it: one symmetric list beats a half-measure per runner.
 *
 * Paths missing on the host are skipped — bind-mounting a missing source makes
 * docker create a root-owned directory in its place, which is worse than not
 * mounting it.
 */
function harnessStateMounts(): string[] {
	return existingPaths([
		path.join(os.homedir(), ".claude"),
		path.join(os.homedir(), ".claude.json"),
		path.join(os.homedir(), ".free-code"),
		path.join(awbDir(), "sessions"),
	]);
}

/**
 * `docker run …` up to and including the image, for an interactive resume in
 * a real terminal (hence `-it`, which the broker's own headless runs don't
 * use). Every path is mounted at its own absolute path — that identity is the
 * whole reason the session the steps built is findable from in here.
 */
function dockerResumePrefix(sandbox: HookSandbox, workdir: string): string {
	const mounts = [workdir, ...harnessStateMounts()];
	const parts = [
		"docker run --rm -it",
		`--user ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
		`--memory ${SANDBOX_LIMITS.memory}`,
		`--cpus ${SANDBOX_LIMITS.cpus}`,
		`--pids-limit ${SANDBOX_LIMITS.pidsLimit}`,
		...mounts.map((m) => `-v ${shellQuote(`${m}:${m}`)}`),
		`-e ${shellQuote(`HOME=${os.homedir()}`)}`,
		`-w ${shellQuote(workdir)}`,
		shellQuote(sandbox.image),
	];
	return parts.join(" ");
}

/**
 * The command to resume `sessionId` under `harness`, or null when either is
 * unknown — callers must hide the offer rather than show a command that would
 * fail (or resume the wrong conversation) if pasted or run.
 *
 * A workflow whose steps ran in a container gets the containerised form of
 * the same command: running the bare `claude --resume <id>` on the host would
 * appear to work while reaching a different install with a different
 * toolchain, so the sandbox is carried through instead. That needs the
 * workdir (it's the mount and the `-w`), so a docker hook with no resolvable
 * workdir answers null rather than a command that would start the wrong
 * conversation.
 */
export function harnessResumeCommand(
	harness: string | null,
	sessionId: string | null,
	sandbox: HookSandbox | null = null,
	workdir: string | null = null,
): string | null {
	if (!harness || !sessionId) return null;
	const command = HARNESS_RESUME_COMMANDS[harness]?.(sessionId);
	if (!command) return null;
	if (!sandbox) return command;
	if (!workdir) return null;
	return `${dockerResumePrefix(sandbox, workdir)} ${command}`;
}

/**
 * Permission modes the hub is willing to write into a hook — the full awb
 * list. `bypassPermissions` lets anyone who can submit a job run arbitrary
 * Bash on the operator's machine, so the publish endpoint only accepts it
 * together with an explicit `acceptBypassRisk: true` (the UI asks for a
 * confirmation before sending it) — never a silent default.
 */
export const PUBLISHABLE_PERMISSION_MODES = ["acceptEdits", "auto", "manual", "dontAsk", "plan", "bypassPermissions"] as const;
export type PublishablePermissionMode = (typeof PUBLISHABLE_PERMISSION_MODES)[number];

/**
 * Runtimes a workflow's hook can spawn. The hub writes `spawn:<runner>` into
 * the hook's `consumers` list; awb's dispatch selects the matching adapter.
 * Both share the same hook protocol (secret, `callbackUrl`, `sessionId`), so
 * the hub, the runner, and the step callbacks stay runtime-agnostic — only
 * the spawned binary and the session-id shape differ (a claude uuid vs. a
 * free-code `.jsonl` path).
 */
export const PUBLISHABLE_RUNNERS = ["claude", "free-code"] as const;
export type PublishableRunner = (typeof PUBLISHABLE_RUNNERS)[number];

/**
 * Which runners are actually installed on the broker's host. The hub writes
 * `spawn:<runner>` into a hook and the broker — which runs on this same
 * machine in phase 1 — later execs that binary; a runner not on PATH is
 * doomed to fail at the first step's spawn with an opaque "run failed" (the
 * real `spawn <binary> ENOENT` stays buried in the broker log). This probe is
 * what lets the create form show only the agents the operator can actually
 * run, instead of offering both unconditionally.
 *
 * Probed with `<binary> --version`, which both CLIs ship and which exits 0
 * with no side effects; `spawnSync` keeps it local and synchronous so the
 * route handler can call it inline. A missing binary surfaces as an `ENOENT`
 * error with `status === null`, and a hung one is killed after the timeout
 * (also `status === null`) — both read as "not installed", the safe default
 * for something that can't answer `--version`.
 */
// Indirection so tests can force a runner to read as uninstalled without
// uninstalling a real CLI — both are installed on the dev/CI box, so the
// host install-check in POST /api/workflows (which calls `availableRunners`)
// can only be exercised against an uninstalled runner by swapping this. Same
// seam shape terminal.ts uses for its spawn.
export const _impl = { spawnSync: cp.spawnSync };

export function availableRunners(): { id: PublishableRunner; installed: boolean }[] {
	return PUBLISHABLE_RUNNERS.map((id) => {
		const result = _impl.spawnSync(id, ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		return { id, installed: result.status === 0 };
	});
}

/**
 * Where a workflow's agent runs. Deliberately orthogonal to the runner: the
 * runner picks WHICH CLI a step spawns, the sandbox picks WHERE it spawns, so
 * both runners get containment from the same awb code path.
 *
 * `host` is the default and is exactly today's behaviour — the CLI runs as
 * the operator, on the operator's filesystem, which is why
 * `bypassPermissions` currently means "anything you can do". `docker` runs
 * the same invocation inside `docker run --rm`, with the workflow's workdir
 * and the harness's own state bind-mounted at their real paths (the broker
 * stays on the host; see awb's adapters/spawn-runner/sandbox.ts).
 */
export const PUBLISHABLE_SANDBOXES = ["host", "docker"] as const;
export type PublishableSandbox = (typeof PUBLISHABLE_SANDBOXES)[number];

/**
 * Image used when a workflow asks for `sandbox: "docker"` without naming one.
 * The image is a per-hook field on purpose — a Python repo and a Node repo
 * want different toolchains — this is only the fallback, built from the
 * Dockerfiles at the root of this repo.
 *
 * The fallback is per RUNNER, not global, because the broker passes the
 * runner's binary as the container command (`docker run … <image> free-code
 * …`): an image that doesn't ship that binary can't exec it, and the step
 * dies with `exit 127` before an agent ever exists. `Dockerfile` only ships
 * `claude`, so a free-code workflow has to default to the derived image from
 * `Dockerfile.free-code` — otherwise picking "free-code" + "docker" without
 * also typing an image name is a guaranteed failure.
 */
export const DEFAULT_SANDBOX_IMAGES: Record<PublishableRunner, string> = {
	claude: "target-agent:latest",
	"free-code": "target-agent-freecode:latest",
};

/** Back-compat alias for the claude default; prefer `defaultSandboxImage(runner)`. */
export const DEFAULT_SANDBOX_IMAGE = DEFAULT_SANDBOX_IMAGES.claude;

/** The image a docker workflow gets when it doesn't name one, given its runner. */
export function defaultSandboxImage(runner: PublishableRunner = "claude"): string {
	return DEFAULT_SANDBOX_IMAGES[runner] ?? DEFAULT_SANDBOX_IMAGES.claude;
}

export interface HookOptions {
	/** Custom shared secret; autogenerated when omitted. */
	secret?: string;
	permissionMode?: PublishablePermissionMode;
	/** Which CLI the hook spawns. Defaults to `"claude"`. */
	runner?: PublishableRunner;
	/** Where that CLI runs. Defaults to `"host"`, which writes no sandbox block at all. */
	sandbox?: PublishableSandbox;
	/** Image for `sandbox: "docker"`; defaults to the runner's `defaultSandboxImage`. Ignored on the host. */
	image?: string;
}

/**
 * Registers a new trigger hook in awb and returns what the hub needs to
 * point an agent at it. Creates the workdir if it doesn't exist yet.
 */
export function createAwbHook(
	name: string,
	workdir: string,
	promptTemplate: string,
	options: HookOptions = {},
): { hookUrl: string; secret: string } {
	const cfg = loadAwbConfig();
	if (cfg.hooks[name]) throw new HookExistsError(`awb hook '${name}' already exists`);

	const secret = options.secret ?? crypto.randomBytes(24).toString("hex");
	const runner = options.runner ?? "claude";
	fs.mkdirSync(workdir, { recursive: true });
	cfg.hooks[name] = {
		mode: "trigger",
		consumers: [`spawn:${runner}`],
		secret,
		promptTemplate,
		workdir,
		...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
		// No block at all for the host default: an unsandboxed hook stays
		// byte-for-byte the hook the hub has always written, so nothing about
		// the existing spawn path is even re-read.
		...(options.sandbox === "docker" ? { sandbox: { kind: "docker", image: options.image || defaultSandboxImage(runner) } } : {}),
	};
	const file = awbConfigFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);

	return { hookUrl: `http://${cfg.host}:${cfg.port}/hook/${encodeURIComponent(name)}`, secret };
}

/**
 * Removes a hook from awb's hooks.json, e.g. when its owning workflow is
 * deleted. Best-effort: never throws, just reports whether it found (and
 * removed) the hook, so a workflow whose hook is already gone can still be
 * deleted cleanly.
 */
export function deleteAwbHook(name: string): boolean {
	try {
		const cfg = loadAwbConfig();
		if (!cfg.hooks[name]) return false;
		delete cfg.hooks[name];
		const file = awbConfigFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Best-effort abort of an in-flight run on the local awb broker: POSTs the
 * hook's `/abort` endpoint with `{ jobId }`, authenticated with the hook's
 * shared secret. The broker looks up the run's process-group leader (the row
 * it registered at spawn time) and SIGTERMs/SIGKILLs the whole group — flock,
 * the bash shim, and the agent binary — which is what actually frees the
 * workdir `flock` for the next run.
 *
 * Called from `hub/workflow.ts` `abortStep` so aborting a stuck step also
 * kills the spawned process that's still holding the workdir, not just the
 * DB row (which was the old bug: the step showed `failed` but the orphaned
 * agent kept running for hours, blocking everything else on that repo).
 *
 * Never throws — a broker that's down, a hook that's gone, or a run that
 * already finished on its own all resolve to a logged warning, since none of
 * them should block the abort from settling the step in the DB. Returns
 * whether the broker acknowledged the kill (true = a live run was signalled,
 * false = nothing to kill / broker unreachable). `cfg` is only used for the
 * `AWB_HOME` directory lookup in `inspectLocalHook`, not for any secret.
 */
export async function abortAwbRun(hookUrl: string, secret: string, jobId: string, log: (msg: string, type?: "info" | "warning" | "error") => void): Promise<boolean> {
	const info = inspectLocalHook(hookUrl);
	if (!info.local || !info.found || !info.name) {
		log(`abort: hook not local/found, skipping broker kill`, "warning");
		return false;
	}
	// Build the /abort URL from the hook URL: same origin + /hook/<name>/abort.
	const abortUrl = new URL(hookUrl);
	abortUrl.pathname = `/hook/${encodeURIComponent(info.name)}/abort`;
	try {
		const res = await fetch(abortUrl, {
			method: "POST",
			headers: { "content-type": "application/json", "x-webhook-secret": secret },
			body: JSON.stringify({ jobId }),
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) {
			log(`abort: broker /abort answered ${res.status}`, "warning");
			return false;
		}
		const body = (await res.json()) as { killed?: boolean };
		log(`abort: broker killed=${body.killed === true}`);
		return body.killed === true;
	} catch (err) {
		log(`abort: broker /abort unreachable: ${String(err)}`, "warning");
		return false;
	}
}
