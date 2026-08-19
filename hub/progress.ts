/**
 * Progress watchdog: tells a step whose agent is HUNG from one that is simply
 * taking a long time.
 *
 * The hub never sees the agent while it works — awb's protocol only reports
 * `started` and, much later, the result — so a step used to be failed purely on
 * a wall clock (20 minutes), which killed perfectly healthy long runs. What the
 * hub *can* see is the trail the harness leaves on disk while it works:
 *
 * - **Claude Code** appends to `~/.claude/projects/<workdir-slug>/<session>.jsonl`
 *   and, because every step delegates its real work to a subagent (see
 *   runner.ts), to `<session>/subagents/*.jsonl`. Those files are touched
 *   constantly during a run.
 * - **free-code** appends to its session `.jsonl` (whose absolute path *is* the
 *   session id).
 * - Either way awb streams the run's output into
 *   `<awbDir>/logs/<agent>-<epoch>.log`.
 *
 * So "is it alive?" becomes "did any of those files change recently?" — a
 * `stat`, no parsing, no extra API calls. The whole project tree is watched
 * rather than one file because a resumed run reports its session id only in the
 * final callback: while the step is in flight we don't know which file it is.
 *
 * Everything here is best-effort and read-only: any fs error, a hook that isn't
 * local, or a harness whose layout we don't recognise yields `null`, and the
 * caller then falls back to the old wall-clock behaviour — never worse than
 * before.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { awbDir, hookRuntime } from "./awb.ts";
import type { HubConfig } from "./config.ts";
import type { Step, Workflow } from "./db.ts";
import { claudeProjectDir } from "./transcript.ts";

/** Which artifact a progress signal came from — persisted and shown, so a timeout can be diagnosed after the fact. */
export type ProgressKind = "transcript" | "session-file" | "run-log";

export interface ProgressSignal {
	/** Modification time of the freshest artifact, as an ISO timestamp. */
	at: string;
	kind: ProgressKind;
	/**
	 * Fingerprint of that artifact (`path|mtimeMs|size`). Progress is only
	 * recorded when this CHANGES, so a file that stops being written keeps the
	 * idle clock running even though it still exists.
	 */
	token: string;
	/** Absolute path observed, for logs. */
	source: string;
}

/**
 * Derived, display-only state of a `running` step. Deliberately NOT a new
 * `Step["status"]`: the DB enum drives the badge, the progress bar and the
 * workflow-status reconciliation, and splitting it would ripple through all of
 * them. These are computed from the timestamps instead.
 *
 * - `running-active` — progress seen within `stepIdleWarnMs`.
 * - `running-idle` — nothing for a while, but still under the idle timeout.
 *   Informational only; nothing acts on it.
 * - `stalled` — past `stepIdleTimeoutMs` with no progress. The sweep re-probes
 *   before believing this, and only then takes the timeout path.
 * - `timed-out-hard` — past `stepHardTimeoutMs` since the run started, however
 *   busy it looks.
 */
export type StepActivityState = "running-active" | "running-idle" | "stalled" | "timed-out-hard";

export interface StepActivity {
	state: StepActivityState;
	/** Last observed progress (falls back to the run start, which is when the clock is seeded). */
	lastProgressAt: string | null;
	lastProgressKind: ProgressKind | null;
	/** Seconds since `lastProgressAt`. */
	idleSeconds: number;
	/** Seconds since `started_at` — what the old wall clock measured. */
	elapsedSeconds: number;
}

/** Last time each step's artifacts were actually stat'd, so the sweep (which runs on every workflow GET) doesn't hit the filesystem every 2 seconds. */
const lastProbeAt = new Map<string, number>();

/** Drops a step's throttle entry — called the moment the sweep times a step out, so a re-run of the same id isn't throttled by the dead attempt's probe. */
export function forgetProbe(stepId: string): void {
	lastProbeAt.delete(stepId);
}

/**
 * Drops the throttle entries of every step that is no longer `running`. Called
 * by the sweep with the set of in-flight steps: a step that settled (done,
 * failed, aborted, restarted) will never be probed again, so keeping its entry
 * would leak one map slot per step the daemon has ever run.
 */
export function pruneProbes(runningStepIds: Set<string>): void {
	for (const stepId of lastProbeAt.keys()) {
		if (!runningStepIds.has(stepId)) lastProbeAt.delete(stepId);
	}
}

function statOf(file: string): { mtimeMs: number; size: number } | null {
	try {
		const st = fs.statSync(file);
		if (!st.isFile()) return null;
		return { mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return null;
	}
}

/** The most recently modified of `files`, ignoring the ones that don't exist. */
function freshest(files: string[]): { source: string; mtimeMs: number; size: number } | null {
	let best: { source: string; mtimeMs: number; size: number } | null = null;
	for (const file of files) {
		const st = statOf(file);
		if (!st) continue;
		if (!best || st.mtimeMs > best.mtimeMs) best = { source: file, mtimeMs: st.mtimeMs, size: st.size };
	}
	return best;
}

function listDir(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * Every transcript under a Claude Code project directory: the session files
 * themselves plus each session's subagent transcripts (`<session>/subagents/*.jsonl`),
 * which are what actually move while a step runs, since the step's real work is
 * delegated to a subagent.
 */
function claudeTranscripts(workdir: string): string[] {
	const dir = claudeProjectDir(workdir);
	const files: string[] = [];
	for (const entry of listDir(dir)) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(path.join(dir, entry.name));
			continue;
		}
		if (!entry.isDirectory()) continue;
		const subagents = path.join(dir, entry.name, "subagents");
		for (const sub of listDir(subagents)) {
			if (sub.isFile() && sub.name.endsWith(".jsonl")) files.push(path.join(subagents, sub.name));
		}
	}
	return files;
}

/** free-code keeps a hook's sessions under `<awbDir>/sessions/<agent>/`; a session id is one of those files' absolute path. */
function freeCodeSessions(agentName: string, sessionId: string | null): string[] {
	const files: string[] = [];
	if (sessionId && sessionId.endsWith(".jsonl") && path.isAbsolute(sessionId)) files.push(sessionId);
	const dir = path.join(awbDir(), "sessions", agentName);
	for (const entry of listDir(dir)) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(dir, entry.name));
	}
	return files;
}

/** Cursor chat store.db files for a session id — the store updates while a step runs. */
function cursorSessionFiles(sessionId: string | null): string[] {
	const root = path.join(os.homedir(), ".cursor", "chats");
	const files: string[] = [];
	let projects: fs.Dirent[];
	try {
		projects = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const chatDir = path.join(root, project.name, sessionId ?? "");
		if (!sessionId) continue;
		const store = path.join(chatDir, "store.db");
		try {
			if (fs.existsSync(store)) files.push(store);
		} catch {
			// Unreadable.
		}
	}
	return files;
}

/** awb's per-run logs for this agent (`<agent>-<epoch>.log`) — the harness-agnostic fallback. */
function runLogs(agentName: string): string[] {
	const dir = path.join(awbDir(), "logs");
	const prefix = `${agentName}-`;
	const files: string[] = [];
	for (const entry of listDir(dir)) {
		if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".log")) {
			files.push(path.join(dir, entry.name));
		}
	}
	return files;
}

/**
 * Looks for a sign that this step's agent did something, newest artifact wins.
 * Tries the harness's own transcripts first (the strongest signal: they move on
 * every model turn and every tool call) and falls back to awb's run log.
 *
 * Throttled to one filesystem sweep per `progressProbeThrottleMs` per step
 * unless `force` is set — the stale sweep forces a fresh probe before declaring
 * anything stalled, so a step is never failed on a cached reading. Returns null
 * when throttled OR when nothing was found; the caller treats both the same
 * (nothing new to record), and the "nothing found at all" case is what makes
 * the watchdog degrade to the old wall clock.
 */
export function probeStepProgress(
	workflow: Workflow,
	step: Step,
	cfg: HubConfig,
	force = false,
): ProgressSignal | null {
	const now = Date.now();
	if (!force) {
		const last = lastProbeAt.get(step.id) ?? 0;
		if (now - last < cfg.progressProbeThrottleMs) return null;
	}
	lastProbeAt.set(step.id, now);

	const runtime = hookRuntime(workflow.hookUrl);
	const sessionId = step.sessionId ?? workflow.lastSessionId;
	// free-code is detected by its session-id shape too, so a workflow whose hook
	// is gone (harness unknown) still resolves the right artifacts.
	const looksFreeCode =
		runtime.harness === "free-code" || (!!sessionId && sessionId.endsWith(".jsonl") && path.isAbsolute(sessionId));
	const looksCursor = runtime.harness === "cursor";

	if (looksFreeCode) {
		const best = freshest(freeCodeSessions(workflow.agentName, sessionId));
		if (best) return signal(best, "session-file");
	} else if (looksCursor) {
		const best = freshest(cursorSessionFiles(sessionId));
		if (best) return signal(best, "session-file");
	} else if (runtime.workdir) {
		const best = freshest(claudeTranscripts(runtime.workdir));
		if (best) return signal(best, "transcript");
	}

	const log = freshest(runLogs(workflow.agentName));
	return log ? signal(log, "run-log") : null;
}

function signal(best: { source: string; mtimeMs: number; size: number }, kind: ProgressKind): ProgressSignal {
	// Clamp to now: a file stamped in the future (clock skew, a copied tree)
	// would otherwise read as "progress forever" and disable the watchdog.
	const at = Math.min(best.mtimeMs, Date.now());
	return {
		at: new Date(at).toISOString(),
		kind,
		token: `${best.source}|${best.mtimeMs}|${best.size}`,
		source: best.source,
	};
}

function toMs(iso: string | null): number | null {
	if (!iso) return null;
	const ms = new Date(iso).getTime();
	return Number.isNaN(ms) ? null : ms;
}

/**
 * Derives a running step's activity state from its stored stamps — no
 * filesystem access, so it's safe to call on every API read. Returns null for a
 * step that isn't `running` (a `queued` step is waiting on the workdir lock and
 * has its own, much longer, clock).
 *
 * `last_progress_at` is seeded with the run start, so a step nobody has probed
 * yet reads as "active since it started" rather than "idle forever".
 */
export function stepActivity(step: Step, cfg: HubConfig, now = Date.now()): StepActivity | null {
	if (step.status !== "running") return null;
	const startedMs = toMs(step.startedAt);
	const progressMs = toMs(step.lastProgressAt) ?? startedMs;
	const idleSeconds = progressMs === null ? 0 : Math.max(0, Math.round((now - progressMs) / 1000));
	const elapsedSeconds = startedMs === null ? 0 : Math.max(0, Math.round((now - startedMs) / 1000));
	let state: StepActivityState = "running-active";
	if (startedMs !== null && now - startedMs >= cfg.stepHardTimeoutMs) state = "timed-out-hard";
	else if (progressMs !== null && now - progressMs >= cfg.stepIdleTimeoutMs) state = "stalled";
	else if (progressMs !== null && now - progressMs >= cfg.stepIdleWarnMs) state = "running-idle";
	return {
		state,
		lastProgressAt: step.lastProgressAt ?? step.startedAt,
		lastProgressKind: step.lastProgressKind,
		idleSeconds,
		elapsedSeconds,
	};
}

/** Human-readable duration for the timeout messages/logs (`7m`, `1h 4m`). */
export function humanizeSeconds(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}
