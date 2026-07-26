/**
 * Client-side mirror of the shapes `hub/server.ts` actually serialises
 * (`publicWorkflow`, `publicStep`, `publicTemplate`) — not of the DB rows in
 * `hub/db.ts`. The difference matters: the public workflow drops `secret` and
 * `hookUrl` and adds `workdir`, `harness` and `progress`, so mirroring the DB
 * type here would describe fields that never reach the browser.
 */

export type WorkflowStatus = "draft" | "running" | "paused" | "completed" | "failed";
export type StepStatus = "pending" | "queued" | "running" | "done" | "failed";

/**
 * Which job a `running` step is waiting on: its own execution (`exec`) or the
 * self-evaluation that follows (`judge`). Meaningless while not running — the
 * UI only uses it to show "judging" instead of "running".
 */
export type StepPhase = "exec" | "judge";

/** Permission modes the create-workflow form may send (server-validated). */
export const PERMISSION_MODES = ["acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Runtimes a workflow's hook can spawn (server-validated). Both share the
 * same step protocol; only the spawned CLI and the session-id shape differ
 * (a claude uuid vs. a free-code `.jsonl` path).
 */
export const RUNNERS = ["claude", "free-code"] as const;
export type Runner = (typeof RUNNERS)[number];

export interface Progress {
	done: number;
	total: number;
	pct: number;
	failed: boolean;
}

export interface Workflow {
	id: string;
	name: string;
	agentName: string;
	status: WorkflowStatus;
	lastSessionId: string | null;
	mdPath: string;
	/** Resolved from the awb hook, so it can be absent if the hook is gone. */
	workdir: string | null;
	harness: string | null;
	progress: Progress;
	conversationContext: string | null;
	contextInjected: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Step {
	id: string;
	workflowId: string;
	orderIndex: number;
	description: string;
	status: StepStatus;
	result: string | null;
	error: string | null;
	sessionId: string | null;
	createdAt: string;
	startedAt: string | null;
	/** When the step was accepted by the broker as `queued` (awaiting the workdir lock / its `started` callback). Null once it has started or for steps never dispatched. */
	queuedAt: string | null;
	finishedAt: string | null;
	manualRun: boolean;
	acceptanceCriteria: string | null;
	maxRetries: number;
	retryIntervalSeconds: number;
	retryCount: number;
	phase: StepPhase;
	selected: boolean;
	/** When the step's agent was last seen doing something (mtime of the freshest artifact its harness wrote). Null unless it has run. */
	lastProgressAt: string | null;
	/** Which artifact that signal came from. */
	lastProgressKind: ProgressKind | null;
	/** Derived watchdog state — null for anything that isn't `running`. */
	activity: StepActivity | null;
}

/** Where the hub saw the agent's last sign of life (see the hub's progress.ts). */
export type ProgressKind = "transcript" | "session-file" | "run-log";

/**
 * How alive a `running` step looks. Deliberately separate from `StepStatus`:
 * the badge/progress bar still key off the DB status, and this only adds the
 * "is it actually doing anything?" dimension the old wall-clock timeout lacked.
 */
export type StepActivityState = "running-active" | "running-idle" | "stalled" | "timed-out-hard";

export interface StepActivity {
	state: StepActivityState;
	lastProgressAt: string | null;
	lastProgressKind: ProgressKind | null;
	idleSeconds: number;
	elapsedSeconds: number;
}

export interface TemplateStep {
	description: string;
	acceptanceCriteria: string | null;
	maxRetries: number;
	retryIntervalSeconds: number;
}

export interface Template {
	id: string;
	name: string;
	tags: string[];
	steps: TemplateStep[];
	createdAt: string;
	updatedAt: string;
}

/**
 * Per-channel notification config, keyed by channel id.
 *
 * Slack is the only channel that's been specified, so it's the only one here —
 * the remaining ways to receive notifications were asked for but never
 * described, and inventing their fields would put controls on the page that
 * save nothing. A new channel is a new key (here and in the hub's db.ts).
 */
export interface NotificationChannels {
	slack: { username: string };
}

export interface NotificationSettings {
	/** Master switch: false means the user wants no notifications at all. */
	enabled: boolean;
	channels: NotificationChannels;
	/** Null until the settings have been saved at least once. */
	updatedAt: string | null;
}

/** Payload accepted by PUT /api/settings/notifications (a full replace). */
export interface NotificationSettingsInput {
	enabled: boolean;
	channels: NotificationChannels;
}

/** Token usage for the workflow's session, read off the harness transcript. */
export interface TokenUsage {
	turns: number;
	contextTokens: number;
	contextWindow: number;
	totalInputTokens: number;
	outputTokens: number;
	includesSubagents: boolean;
}

export interface SessionInfo {
	sessionId: string | null;
	harness: string | null;
	usage: TokenUsage | null;
}

/** One level of the server-side directory listing (GET /api/fs/dirs). */
export interface DirListing {
	/** Absolute, resolved path of the listed directory. */
	path: string;
	/** Absolute parent path, or null at the filesystem root. */
	parent: string | null;
	/** The hub user's home directory (for the picker's "Home" shortcut). */
	home: string;
	/** Subdirectory names (visible first, then hidden, both sorted). */
	dirs: string[];
}

/** Payload accepted by POST /api/workflows. */
export interface CreateWorkflowInput {
	name: string;
	workdir?: string;
	permissionMode?: PermissionMode;
	/** Which CLI the workflow's hook spawns; the server defaults to "claude". */
	runner?: Runner;
	templateId?: string;
	/** Required confirmation when permissionMode is "bypassPermissions". */
	acceptBypassRisk?: boolean;
}

/** The judge config shared by step create and step edit. */
export interface StepConfigInput {
	description: string;
	acceptanceCriteria?: string;
	maxRetries?: number;
	retryIntervalSeconds?: number;
}

export interface TemplateInput {
	name: string;
	tags: string[];
	steps: TemplateStep[];
}

/**
 * Engine action the single Start button maps to, given a workflow's status.
 * The endpoints are unchanged — this only spares the operator from knowing
 * which one applies (`start` refuses a completed/failed workflow, `resume`
 * only fits a paused one).
 */
export type StartAction = "start" | "resume" | "restart";

export function startActionFor(status: WorkflowStatus): StartAction | null {
	if (status === "draft") return "start";
	if (status === "paused") return "resume";
	if (status === "completed" || status === "failed") return "restart";
	return null;
}
