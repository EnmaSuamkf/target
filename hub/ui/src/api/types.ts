/**
 * Client-side mirror of the shapes `hub/server.ts` actually serialises
 * (`publicWorkflow`, `publicStep`, `publicTemplate`) — not of the DB rows in
 * `hub/db.ts`. The difference matters: the public workflow drops `secret` and
 * `hookUrl` and adds `workdir`, `harness` and `progress`, so mirroring the DB
 * type here would describe fields that never reach the browser.
 */

/**
 * `waiting` is the manual-review hold: a step with the gate on finished its work
 * and passed its judge, so the engine stopped there instead of advancing. It's
 * not terminal and not an error — only the step's Continue button moves it on,
 * which is why it's rendered in the same warning orange as `paused`.
 */
export type WorkflowStatus = "draft" | "running" | "paused" | "waiting" | "completed" | "failed";
export type StepStatus = "pending" | "queued" | "running" | "waiting" | "done" | "failed";

// --- single-user access layer (mirrors hub/account.ts's PublicAccount) ---

/** What GET /api/auth/status returns — open, and the only thing the landing page needs to choose its call to action. */
export interface AuthStatus {
	setupCompleted: boolean;
}

/** The one account on this machine, as the API returns it. No hashes ever cross the wire. */
export interface Account {
	displayName: string | null;
	recoveryTokenSetAt: string;
	createdAt: string;
}

/**
 * The statuses a human may force by hand, mirroring the server's
 * `OVERRIDABLE_*_STATUSES` (hub/db.ts). Only the settled ones: `running` and
 * `queued` mean "a job is in flight", which no status write can make true, and
 * `waiting` belongs to the manual-review gate and its Continue button. The
 * server validates these again and answers 400, so these arrays only decide
 * what the pickers offer.
 */
export const OVERRIDABLE_STEP_STATUSES = ["done", "failed", "pending"] as const;
export type OverridableStepStatus = (typeof OVERRIDABLE_STEP_STATUSES)[number];

export const OVERRIDABLE_WORKFLOW_STATUSES = ["completed", "failed", "paused", "draft"] as const;
export type OverridableWorkflowStatus = (typeof OVERRIDABLE_WORKFLOW_STATUSES)[number];

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

/** Whether each runner's CLI is installed on the host (from `GET /api/runners`). */
export interface RunnerAvailability {
	id: Runner;
	installed: boolean;
}

/**
 * One conversation already on this machine, from `GET /api/conversations`
 * (hub/conversations.ts) — the conversation a workflow can be created to
 * continue.
 *
 * `sessionId` is the harness's own handle (a uuid for claude, the transcript's
 * absolute path for free-code) and is the only field the API takes back; the
 * rest is what makes the list readable. `workdir` doubles as whether the
 * conversation can be continued at all: the workflow has to run where the
 * conversation ran, so a transcript that never recorded one can't be adopted.
 */
export interface Conversation {
	runner: Runner;
	sessionId: string;
	path: string;
	workdir: string | null;
	title: string;
	updatedAt: string;
	sizeBytes: number;
}

/**
 * The tail of a conversation, for recognising it. NOT what the workflow
 * receives — the workflow resumes the conversation itself, in full.
 */
export interface ConversationPreview {
	text: string;
	turns: number;
	shownTurns: number;
}

/** Whether a workflow can be created to run on a conversation, and why not. */
export interface Adoptability {
	ok: boolean;
	workdir: string | null;
	reason: string | null;
}

/**
 * Where a workflow's agent runs (server-validated). Orthogonal to the runner:
 * `host` is the historical behaviour — the CLI runs as you, on your
 * filesystem — while `docker` runs the same invocation in a container whose
 * only mounts are the workflow's workdir and the harness's own state.
 */
export const SANDBOXES = ["host", "docker"] as const;
export type Sandbox = (typeof SANDBOXES)[number];

/**
 * Whether each sandbox can actually run here (from `GET /api/runners`, which
 * reports both halves of the host's capabilities). `docker` is available only
 * when the hub found a docker binary AND reached its daemon — an unreachable
 * daemon fails a `docker run` exactly as hard as no docker at all.
 */
export interface SandboxAvailability {
	id: Sandbox;
	available: boolean;
}

/** The host capabilities the create form needs before it can render: which agent CLIs, and which sandboxes. */
export interface HostCapabilities {
	runners: RunnerAvailability[];
	sandboxes: SandboxAvailability[];
}

export interface Progress {
	done: number;
	total: number;
	pct: number;
	failed: boolean;
}

/**
 * Which of the three text inputs an image is pinned to: the workflow's
 * conversation context, or a step's task description / acceptance criteria.
 * Mirrors the hub's `AttachmentField`.
 */
export type AttachmentField = "context" | "description" | "acceptance";

/** The image formats the hub accepts — used to filter the file picker and paste/drop. */
export const ATTACHMENT_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** Per-file ceiling the hub enforces (5 MiB); checked client-side so the error is instant. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * An image attached to one of a workflow's text inputs, as `publicAttachment`
 * serialises it.
 */
export interface Attachment {
	id: string;
	workflowId: string;
	/** Null for a conversation-context attachment. */
	stepId: string | null;
	field: AttachmentField;
	filename: string;
	mime: string;
	size: number;
	/**
	 * Absolute path of the file on the hub's machine — the very string composed
	 * into the agent's prompt, shown in the UI so it's clear what the agent gets.
	 */
	path: string;
	/** Where to fetch the bytes for a thumbnail (`/api/attachments/:id/content`). */
	url: string;
	createdAt: string;
}

export interface Workflow {
	id: string;
	name: string;
	agentName: string;
	status: WorkflowStatus;
	lastSessionId: string | null;
	/**
	 * The operator's own conversation this workflow continues, when it was created
	 * to run on one; null for a workflow that started from nothing. Its steps are
	 * turns in a thread that predates them.
	 */
	adoptedSessionId: string | null;
	mdPath: string;
	/** Resolved from the awb hook, so it can be absent if the hook is gone. */
	workdir: string | null;
	/**
	 * The directory an operator chose, or null when this workflow runs in its
	 * agent's own sandbox under ~/.target/sandboxes/. What the clone dialog seeds
	 * its workdir field from — `workdir` above belongs to this agent alone.
	 */
	chosenWorkdir: string | null;
	harness: string | null;
	/** "host" for an uncontained agent (the default), "docker" when its steps run in a container. */
	sandbox: Sandbox;
	/** Image backing a docker sandbox; null on the host. */
	image: string | null;
	/** Permission mode its hook spawns with; null means awb's own default (read-only). */
	permissionMode: string | null;
	progress: Progress;
	conversationContext: string | null;
	contextInjected: boolean;
	/** Images pinned to the conversation context (every `field` is "context"). */
	attachments: Attachment[];
	/**
	 * True when this status was forced by a human instead of derived from the
	 * steps. It's also why the badge stays put: the hub stops re-deriving a
	 * status a person asserted until the engine runs again.
	 */
	statusManual: boolean;
	statusManualAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * What a step row IS. `task` is one the operator wrote — everything the UI has
 * ever shown. `context` is the hub-owned step that delivers the workflow's
 * conversation context as its own turn before every other step: it's pinned
 * above the list, kept out of the run selection and the progress count, and
 * every mutating action on it is refused by the server.
 */
export type StepKind = "task" | "context";

export interface Step {
	id: string;
	workflowId: string;
	/** See `StepKind`. Absent on a server that predates it, hence the default at every read site. */
	kind: StepKind;
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
	/** The per-step gate: when on, the step holds at `waiting` once its work is accepted, until a human presses Continue. */
	manualReview: boolean;
	/** On (the default): the step's work is delegated to a subagent. Off: it runs inline in the shared conversation. */
	useSubagent: boolean;
	acceptanceCriteria: string | null;
	/** Images pinned to this step's two inputs; filter by `field` to split them. */
	attachments: Attachment[];
	maxRetries: number;
	retryIntervalSeconds: number;
	retryCount: number;
	phase: StepPhase;
	selected: boolean;
	/** True when this status was forced by a human rather than reported by a run. */
	statusManual: boolean;
	statusManualAt: string | null;
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
	/** Seeds the same flag on the real steps this template creates. */
	manualReview: boolean;
	/** Seeds the subagent toggle on the real steps this template creates. */
	useSubagent: boolean;
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
 * The file a template export downloads and an import reads back (the hub's
 * `templateBundle` / `parseTemplateBundle` in db.ts).
 *
 * No id and no timestamps per template: those describe a row on the machine
 * that exported it, and the importing hub mints its own. `schemaVersion` is
 * what lets a future field be added without a file from an older hub becoming
 * unreadable — the hub refuses only a version NEWER than the one it knows.
 */
export interface TemplateBundleEntry {
	name: string;
	tags: string[];
	steps: TemplateStep[];
}

export interface TemplateBundle {
	kind: "target.templates";
	schemaVersion: number;
	exportedAt: string;
	templates: TemplateBundleEntry[];
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

/** The actions a hub shortcut can be bound to — the five the hub ships with. */
export type ShortcutAction =
	| "focusWorkflow"
	| "toggleDictation"
	| "createWorkflow"
	| "continueStep"
	| "startWorkflow";

/** A single shortcut binding: the letter that fires the action (lowercased). */
export interface ShortcutBinding {
	key: string;
}

export interface ShortcutSettings {
	bindings: Record<ShortcutAction, ShortcutBinding>;
	/** Null until the bindings have been saved at least once. */
	updatedAt: string | null;
}

/** Payload accepted by PUT /api/settings/shortcuts (a full replace). */
export interface ShortcutSettingsInput {
	bindings: Record<ShortcutAction, ShortcutBinding>;
}

/** Token usage for the workflow's session, read off the harness transcript. */
export interface TokenUsage {
	turns: number;
	contextTokens: number;
	/** Derived from `model`, not a constant — see hub/models.ts. */
	contextWindow: number;
	/** Model id the last turn ran on, as the harness wrote it; null before the first turn. */
	model: string | null;
	totalInputTokens: number;
	outputTokens: number;
	includesSubagents: boolean;
	/** ISO timestamp of the last compaction of this conversation, or null if it was never compacted. */
	lastCompactionAt: string | null;
	compactions: number;
}

export interface SessionInfo {
	sessionId: string | null;
	harness: string | null;
	sandbox: Sandbox;
	image: string | null;
	usage: TokenUsage | null;
	/** Latest compaction boundary the hub has recorded for this workflow. */
	lastCompactionAt: string | null;
	/** A compaction the next step hasn't re-injected the conversation context for yet. */
	compactionPending: boolean;
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
	/** Where that CLI runs; the server defaults to "host" (and writes no sandbox block at all). */
	sandbox?: Sandbox;
	/** Image for a docker sandbox; the server falls back to its own default image. */
	image?: string;
	templateId?: string;
	/**
	 * Create the workflow to RUN ON this existing conversation: the server adopts
	 * that session, so the workflow's first step resumes it and the agent starts
	 * with the conversation's full history. Sending this also fixes `runner` and
	 * `workdir` to the conversation's own — the server refuses a request that
	 * asks for different ones rather than overriding them silently.
	 */
	conversation?: { runner: Runner; sessionId: string };
	/**
	 * The operator's own framing of the adoption ("from here on, do X"), delivered
	 * as the context step's turn inside the adopted conversation. Only meaningful
	 * together with `conversation` — a workflow still cannot be created with a
	 * free-text context (that's PATCH /api/workflows/:id/context).
	 */
	conversationNote?: string;
	/** Required confirmation when permissionMode is "bypassPermissions". */
	acceptBypassRisk?: boolean;
}

/**
 * What POST /api/workflows/:id/clone accepts: the new-workflow form's runtime
 * fields, minus the two that decide where a workflow's steps and context come
 * from. A clone's come from the workflow it copies, which is what a clone is —
 * so `templateId` and `conversation` have no meaning here.
 *
 * The clone dialog sends every one of these keys, empty string included,
 * because absent and empty mean different things to that endpoint: absent
 * inherits the source's value, empty is an explicit "make it the default".
 * That's what lets a field be CLEARED in the dialog.
 */
export interface CloneWorkflowInput {
	name: string;
	/** Empty means "give the clone its own sandbox" rather than the source's directory. */
	workdir: string;
	runner: Runner;
	sandbox: Sandbox;
	/** Empty means the runner's default image. Only read for a docker sandbox. */
	image: string;
	/** Empty means read-only — awb's own default — not "whatever the source had". */
	permissionMode: "" | PermissionMode;
	/** Required confirmation when permissionMode is "bypassPermissions". */
	acceptBypassRisk?: boolean;
}

/**
 * Images picked in an add-step form, held until the step exists.
 *
 * A step's attachments hang off its id, and an add-step form has no step yet —
 * so the files are staged here and uploaded straight after the create POST
 * returns. Keyed by which of the step's two inputs they belong to.
 */
export interface StagedStepImages {
	description: File[];
	acceptance: File[];
}

/** The verification config shared by step create and step edit. */
export interface StepConfigInput {
	description: string;
	acceptanceCriteria?: string;
	/** Omitting it leaves the stored gate untouched; the forms always send it, so a toggle-off really turns it off. */
	manualReview?: boolean;
	/** Same rule for the subagent toggle: omitted leaves it as stored, and the forms always send it (default true). */
	useSubagent?: boolean;
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
	// `running` and `waiting` have no Start: the engine owns the first, and the
	// second is released by the held step's own Continue button (the server
	// refuses a Start on a workflow waiting for a manual review).
	return null;
}
