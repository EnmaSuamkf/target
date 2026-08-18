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
	/** Extra host paths the hook bind-mounts on top of the workdir and the harness state. */
	mounts?: string[];
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
	/**
	 * Permission mode the hook spawns its runs with, or null when it doesn't set
	 * one (awb's own default applies). Read back so a workflow can be recreated
	 * with the permissions it was created with — see `cloneWorkflow`
	 * (workflow.ts), which has no other record of them: the hub stores the choice
	 * in the hook, never on the workflow row.
	 */
	permissionMode: PublishablePermissionMode | null;
}

/**
 * How the hook runs its jobs. Only answerable for hooks on this machine's
 * broker; remote hooks (phase 2) come back all-null. The workdir is a local
 * path, which is fine to expose while the hub is local-only.
 */
export function hookRuntime(hookUrl: string): HookRuntime {
	const info = inspectLocalHook(hookUrl);
	if (!info.local || !info.found || !info.name) return { harness: null, workdir: null, sandbox: null, permissionMode: null };
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
	const block = hook?.sandbox as { kind?: unknown; image?: unknown; mounts?: unknown } | undefined;
	const sandbox =
		block?.kind === "docker" && typeof block.image === "string" && block.image !== ""
			? {
					kind: "docker" as const,
					image: block.image,
					mounts: Array.isArray(block.mounts) ? block.mounts.filter((m) => typeof m === "string") : [],
				}
			: null;
	// Only the modes the hub is allowed to publish come back as themselves; a
	// hook carrying anything else reads as "not set", so a clone of it falls back
	// to the default rather than replaying a mode this hub would refuse to create.
	const mode = hook?.permissionMode;
	const permissionMode =
		typeof mode === "string" && PUBLISHABLE_PERMISSION_MODES.includes(mode as PublishablePermissionMode)
			? (mode as PublishablePermissionMode)
			: null;
	return { harness, workdir, sandbox, permissionMode };
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
	// `--no-rag-server` skips the auto-start of the local Python RAG server
	// (free-code-rag on :8085). In the docker resume image that server is not
	// installed, so without this flag free-code blocks up to 90s waiting for
	// it ("RAG: server did not become ready … within 90s") and the reopened
	// conversation only paints after that delay — i.e. an apparently empty
	// terminal. The RAG server is not used by these workflow sessions, so
	// disabling it loses nothing and makes the conversation appear at once.
	// Unlike the steps (awb's adapter keeps `--no-extensions` so an untrusted
	// workdir can't plant extensions on a headless run), this terminal is the
	// operator's own interactive session, so it loads the full extension set —
	// the same toolset they'd get running free-code by hand in that directory.
	"free-code": (sessionId) => `free-code --session ${shellQuote(sessionId)} --no-rag-server`,
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
	const mounts = [workdir, ...harnessStateMounts(), ...existingPaths(sandbox.mounts ?? [])];
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
//
// `spawn` is the same seam for the one long-running command in here: the
// on-demand `docker build` of a missing sandbox image (`ensureSandboxImage`),
// which is async precisely because it takes minutes and must not block the
// hub's event loop the way the synchronous probes can afford to.
export const _impl = { spawnSync: cp.spawnSync, spawn: cp.spawn };

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

/**
 * How long a docker probe answer is reused. Docker availability is not static
 * — the operator can start Docker Desktop, or the daemon can die, while the
 * hub keeps running — so the answer expires instead of being resolved once at
 * boot. A minute is long enough that the create form and the create route
 * don't shell out per request, and short enough that starting the daemon shows
 * up without restarting the hub.
 */
const DOCKER_PROBE_TTL_MS = 60_000;

let dockerProbe: { available: boolean; at: number } | null = null;

/**
 * Forgets the cached probe, so the next `dockerAvailable()` asks docker again.
 * Exported for the tests that swap `_impl.spawnSync` — a cached answer from an
 * earlier test would otherwise outlive the seam it was measured through.
 */
export function clearDockerProbe(): void {
	dockerProbe = null;
}

/**
 * Whether this host can actually run a `sandbox: "docker"` workflow.
 *
 * Probed with `docker info`, not `docker --version`: the binary being on PATH
 * proves nothing, since a `docker run` against a stopped daemon fails just as
 * hard as a missing docker (`Cannot connect to the Docker daemon`). `info` is
 * the cheapest command that only succeeds when the CLI can reach a daemon, so
 * it answers the question the create form is really asking.
 *
 * Same `spawnSync` seam and same "can't answer → unavailable" default as
 * `availableRunners` above: a missing binary surfaces as `status === null`,
 * and so does a daemon that hangs past the timeout. The timeout is longer than
 * the runners' because `info` talks to the daemon over its socket, and on a
 * cold Docker Desktop that round-trip is not instant.
 */
export function dockerAvailable(): boolean {
	const now = Date.now();
	if (dockerProbe && now - dockerProbe.at < DOCKER_PROBE_TTL_MS) return dockerProbe.available;
	const result = _impl.spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
	});
	const available = result.status === 0;
	dockerProbe = { available, at: now };
	return available;
}

/**
 * Which sandboxes this host can actually offer, shaped like
 * `availableRunners` because the create form consumes them the same way: it
 * builds its selector from what comes back, so an unavailable sandbox is never
 * offered rather than being offered and failing at the first step's spawn.
 *
 * `host` is unconditionally available — it is the hub running as itself, which
 * is what asked the question.
 */
export function availableSandboxes(): { id: PublishableSandbox; available: boolean }[] {
	return PUBLISHABLE_SANDBOXES.map((id) => ({ id, available: id === "docker" ? dockerAvailable() : true }));
}

/**
 * The images this repo can build itself, and the Dockerfile each comes from —
 * the same two names `DEFAULT_SANDBOX_IMAGES` resolves to. Both the installer
 * (scripts/install.ts, which builds them up front) and `ensureSandboxImage`
 * below (which builds a missing one at dispatch time) read this list, so the
 * tag→Dockerfile mapping exists once.
 *
 * Order matters: the free-code image is `FROM target-agent:latest`, so the
 * base has to be built first — which is also why it names its `base`.
 */
export interface BuildableImage {
	tag: string;
	/** Path relative to the repo root — `docker build -f <dockerfile>`. */
	dockerfile: string;
	runner: PublishableRunner;
	/** The image this one is `FROM`, when that image is also ours to build. */
	base: string | null;
}

export const BUILDABLE_SANDBOX_IMAGES: BuildableImage[] = [
	{ tag: DEFAULT_SANDBOX_IMAGES.claude, dockerfile: "Dockerfile", runner: "claude", base: null },
	{
		tag: DEFAULT_SANDBOX_IMAGES["free-code"],
		dockerfile: "Dockerfile.free-code",
		runner: "free-code",
		base: DEFAULT_SANDBOX_IMAGES.claude,
	},
];

/** The buildable spec for `image`, or null when it isn't one of ours (a registry image, or the operator's own). */
export function buildableImage(image: string): BuildableImage | null {
	return BUILDABLE_SANDBOX_IMAGES.find((spec) => spec.tag === image) ?? null;
}

/** This repo's root, from `hub/` — where the Dockerfiles and the build context live. */
const REPO_DIR = path.resolve(import.meta.dirname, "..");

/**
 * `--build-arg AGENT_UID/AGENT_GID`, so the ids baked into the image are the
 * operator's own: the broker runs the container as `--user <uid>:<gid>`, and
 * files the agent writes into the bind-mounted repo have to come back owned by
 * the operator rather than by root (or by a uid that doesn't exist in the
 * image). Empty on Windows, where node has no getuid/getgid and the
 * Dockerfiles' 1000 default is as good an answer as any.
 */
function imageBuildArgs(): string[] {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (uid === undefined || gid === undefined) return [];
	return ["--build-arg", `AGENT_UID=${uid}`, "--build-arg", `AGENT_GID=${gid}`];
}

/** The exact `docker build` the installer and the on-demand build both run — one definition, so they can't drift apart. */
export function imageBuildCommand(spec: BuildableImage): { cmd: string; args: string[]; cwd: string } {
	return {
		cmd: "docker",
		args: ["build", "-t", spec.tag, "-f", spec.dockerfile, ...imageBuildArgs(), "."],
		cwd: REPO_DIR,
	};
}

/** Whether the docker daemon already has `image`. Same `spawnSync` seam (and same "can't answer → no" default) as the probes above. */
export function sandboxImageExists(image: string): boolean {
	const result = _impl.spawnSync("docker", ["image", "inspect", image], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
	});
	return result.status === 0;
}

/**
 * Hard cap on one `docker build`. Generous on purpose — the base image installs
 * from apt and npm and the free-code one clones and compiles a repo, so minutes
 * are normal — but not unbounded: the dispatch that triggered the build is
 * awaiting it, and a build wedged forever would hold a step `pending` forever.
 */
const IMAGE_BUILD_TIMEOUT_MS = 30 * 60_000;

/** In-flight builds by tag, so N steps dispatched at once trigger one build and all wait on it rather than racing N `docker build`s of the same tag. */
const buildsInFlight = new Map<string, Promise<EnsureImageResult>>();

export type EnsureImageResult = { ok: true; built: boolean } | { ok: false; error: string };

type BuildLogger = (message: string, type?: "info" | "warning" | "error") => void;

function runImageBuild(spec: BuildableImage): Promise<{ ok: boolean; output: string }> {
	const { cmd, args, cwd } = imageBuildCommand(spec);
	return new Promise((resolve) => {
		const child = _impl.spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: IMAGE_BUILD_TIMEOUT_MS });
		// Only the tail is kept: a full build log is megabytes of layer chatter,
		// and what has to reach the operator is the line the build died on.
		let tail = "";
		const keep = (chunk: unknown): void => {
			tail = `${tail}${String(chunk)}`.slice(-4000);
		};
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		child.on("error", (err: Error) => resolve({ ok: false, output: String(err.message ?? err) }));
		child.on("close", (code: number | null) => resolve({ ok: code === 0, output: tail }));
	});
}

function lastLines(output: string, count = 12): string {
	return output.split(/\r?\n/).filter((line) => line.trim() !== "").slice(-count).join("\n");
}

/**
 * Makes sure the image a docker step is about to run actually exists, building
 * it when it doesn't and we know how.
 *
 * This is the fix for the failure the operator actually hit: the hub writes the
 * default image NAME into the hook, but nothing ever built it, so the first
 * step died with docker's `Unable to find image 'target-agent:latest' locally`
 * / `pull access denied … may require 'docker login'` — a registry error for an
 * image that only ever exists locally. The installer now builds both images up
 * front (scripts/install.ts), and this is the runtime half of the same
 * guarantee: a machine that skipped that step, or an operator who pruned their
 * images, gets the build here instead of a dead end.
 *
 * An image that isn't one of ours is left alone: it may genuinely live in a
 * registry (`python:3.12`, a private base), where docker's own pull is exactly
 * the right behaviour and there is no Dockerfile to build from anyway. Those
 * failures are still made readable, by `explainRunError`.
 *
 * Never throws: the caller is a dispatch, and a build problem has to settle the
 * step with a message, not blow up the engine.
 */
export async function ensureSandboxImage(image: string, log: BuildLogger = () => {}): Promise<EnsureImageResult> {
	const spec = buildableImage(image);
	if (!spec) return { ok: true, built: false };
	if (sandboxImageExists(image)) return { ok: true, built: false };
	const running = buildsInFlight.get(image);
	if (running) return await running;
	const build = (async (): Promise<EnsureImageResult> => {
		// A stopped daemon answers `image inspect` exactly like a missing image, so
		// without this the operator would be told the build failed when the truth
		// is that docker isn't running — and the build's own error ("Cannot connect
		// to the Docker daemon") would be buried under a paragraph about
		// Dockerfiles. The workflow was created when docker WAS available; it can
		// be again, and the step can be retried.
		if (!dockerAvailable()) {
			return {
				ok: false,
				error: `docker is not available on this host (no docker on PATH, or the daemon isn't running), so this workflow's containerised step can't run. Start Docker and retry the step, or recreate the workflow on the host sandbox.`,
			};
		}
		// `FROM target-agent:latest` can't be resolved from a registry either, so
		// the parent is ensured first — otherwise building the free-code image on
		// a fresh machine reproduces the very error this function exists to stop.
		if (spec.base) {
			const base = await ensureSandboxImage(spec.base, log);
			if (!base.ok) return base;
		}
		const dockerfile = path.join(REPO_DIR, spec.dockerfile);
		if (!fs.existsSync(dockerfile)) {
			return {
				ok: false,
				error: `the docker image '${spec.tag}' is not on this machine and ${dockerfile} isn't there to build it from. Name an image that exists with the workflow's image field, or run this hub from a full checkout of the repo.`,
			};
		}
		log(`docker image '${spec.tag}' is missing — building it from ${spec.dockerfile}; this takes a few minutes the first time`, "warning");
		const result = await runImageBuild(spec);
		if (!result.ok) {
			const { cmd, args, cwd } = imageBuildCommand(spec);
			return {
				ok: false,
				error:
					`could not build the docker image '${spec.tag}' from ${spec.dockerfile}, so this ${spec.runner} docker workflow has no image to run in. ` +
					`Fix the build and retry the step, or build it by hand with \`${cmd} ${args.join(" ")}\` in ${cwd}.` +
					`\n\ndocker build said:\n${lastLines(result.output) || "(no output)"}`,
			};
		}
		log(`docker image '${spec.tag}' built`);
		return { ok: true, built: true };
	})();
	buildsInFlight.set(image, build);
	try {
		return await build;
	} finally {
		buildsInFlight.delete(image);
	}
}

/**
 * Which of our images (if any) a docker failure is about. The tag is looked for
 * first, then the bare repository name, because docker names the image both
 * ways in the same breath: `Unable to find image 'target-agent:latest' locally`
 * and then `pull access denied for target-agent, repository does not exist`.
 * The repository match is bounded so `target-agent` doesn't claim a message
 * about `target-agent-freecode`.
 */
function mentionedBuildableImage(error: string): BuildableImage | null {
	const tagged = BUILDABLE_SANDBOX_IMAGES.find((spec) => error.includes(spec.tag));
	if (tagged) return tagged;
	return (
		BUILDABLE_SANDBOX_IMAGES.find((spec) => {
			const repo = (spec.tag.split(":")[0] ?? spec.tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(^|[^\\w./-])${repo}([^\\w.-]|$)`).test(error);
		}) ?? null
	);
}

/**
 * Advice appended to the docker failures whose own text names no fix. The
 * broker forwards the CLI's stderr verbatim (see the result route in
 * server.ts), and docker's answer to an image it can't resolve is `Unable to
 * find image … locally` followed by `pull access denied … may require 'docker
 * login'` — which sends the operator to a registry login for something that,
 * for the default images, is only ever built locally.
 *
 * The dispatch-time build above means a default image should never get this
 * far; this is the net under it (a build that raced, an image deleted between
 * the check and the run, a hook written by hand).
 *
 * Two different fixes, so two branches. A failure naming one of OUR images
 * means the local build never ran (or was pruned): the way out is the
 * installer, or the `docker build` it runs — never a login. Any other image is
 * the operator's own, and there the registry reading is the right one, so the
 * note only says which half of it to check.
 */
export function explainRunError(error: string): string {
	if (!/pull access denied|Unable to find image|manifest unknown|manifest for .* not found/i.test(error)) return error;
	const mine = mentionedBuildableImage(error);
	if (mine) {
		const { cmd, args } = imageBuildCommand(mine);
		return `${error}\n\n'${mine.tag}' is built on this machine, never pulled from a registry, so \`docker login\` is not the fix — the build simply hasn't run here. Re-run \`npm run target:install\` (it builds the default agent images), or build it by hand: \`${cmd} ${args.join(" ")}\` from the repo root.`;
	}
	return `${error}\n\nThis workflow names an image that isn't on this machine and couldn't be pulled. Build or pull it on this host (or point the workflow at an image that exists) — the hub only builds its own default images, ${BUILDABLE_SANDBOX_IMAGES.map((spec) => spec.tag).join(" and ")}.`;
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
 * Adds `mounts` to a hook's sandbox block, so a containerised run can open a
 * host path the hub needs it to reach — today the workflow's step-results
 * directory, which lives under the hub's own TARGET_HOME (see step-results.ts)
 * and would otherwise be invisible inside the container, since `$HOME` is
 * never mounted.
 *
 * Only docker hooks are touched: on the host there is no boundary to punch
 * through, and a remote hook's filesystem is not ours to describe. Existing
 * mounts are kept and duplicates skipped, so this is idempotent and safe to
 * call on every step transition; hooks.json is only rewritten when something
 * actually changed. Best-effort — a missing hook or an unwritable hooks.json
 * comes back `false` rather than failing the step that triggered it.
 */
export function ensureHookMounts(hookUrl: string, mounts: string[]): boolean {
	try {
		const info = inspectLocalHook(hookUrl);
		if (!info.local || !info.found || !info.name) return false;
		const cfg = loadAwbConfig();
		const sandbox = cfg.hooks[info.name]?.sandbox as { kind?: unknown; mounts?: unknown } | undefined;
		if (!sandbox || sandbox.kind !== "docker") return false;
		const current = Array.isArray(sandbox.mounts) ? (sandbox.mounts as string[]) : [];
		const missing = mounts.filter((mount) => !current.includes(mount));
		if (missing.length === 0) return false;
		sandbox.mounts = [...current, ...missing];
		const file = awbConfigFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
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
