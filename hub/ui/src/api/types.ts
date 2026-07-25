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
