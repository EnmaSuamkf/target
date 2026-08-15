/**
 * Registry of workflows + their steps (SQLite via node:sqlite, same
 * zero-native-deps approach as agentmesh's hub). A workflow owns exactly one
 * dedicated agent (one awb hook): every step of that workflow is dispatched
 * as a job to that same hook, resuming the same Claude session
 * (`lastSessionId`) so the whole workflow runs as one continuous
 * conversation, one step at a time.
 *
 * Step expiry is lazy, same rationale as agentmesh: every read path first
 * fails any running step older than the configured timeout, instead of a
 * timer per step. That survives hub restarts for free.
 */
import * as crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { dbFile } from "./config.ts";
import type { ProgressKind } from "./progress.ts";

/**
 * `waiting` is the manual-review hold: a step of the workflow finished its work
 * and passed its judge, but carries the per-step "Manual review" gate, so the
 * engine stopped there instead of advancing. It is not terminal and not an
 * error — only a human pressing Continue (or a restart) moves it on.
 */
export type WorkflowStatus = "draft" | "running" | "paused" | "waiting" | "completed" | "failed";
/** `waiting`: the step's work is done and verified, but its manual-review gate is holding it (see WorkflowStatus). */
export type StepStatus = "pending" | "queued" | "running" | "waiting" | "done" | "failed";
/**
 * Which job a `running` step is currently waiting on: its own execution
 * (`exec`) or the self-evaluation that runs afterwards (`judge`). Both come
 * back through the same result callback, so the phase is what tells
 * `onStepResult` how to interpret the payload. Meaningless while not running.
 */
export type StepPhase = "exec" | "judge";

/**
 * What a step row IS.
 *
 *  - `task` — a step the operator wrote. Everything that existed before this
 *    column did, which is why it is the DEFAULT: an upgraded DB reads every
 *    pre-existing row as a task, and a workflow that never uses a conversation
 *    context never sees any other kind.
 *  - `context` — the workflow's conversation context, materialised as its own
 *    step so the background is delivered as its own turn on the shared session
 *    BEFORE any real work. Hub-owned, not operator-authored: it is created,
 *    refreshed and deleted by `reconcileContextStep` (workflow.ts), pinned at
 *    `CONTEXT_STEP_ORDER_INDEX`, and refused by every operator-facing mutator.
 *
 * The distinction is load-bearing for every read path that COUNTS steps
 * (`stepProgress`, the completion notification, the on-disk `<NN>-<slug>.md`
 * files): a context step is plumbing, not work, and must not show up as either.
 */
export type StepKind = "task" | "context";

/**
 * Where the hub-owned context step sits: BEFORE the first operator step, at a
 * negative index rather than at 0.
 *
 * This is the detail the whole design rests on. `ORDER BY order_index` (and so
 * `listSteps` and `nextPendingStep`) puts it first for free, while renumbering
 * NOTHING — every task step keeps the index it already had, so
 * `stepResultFileName` keeps emitting the same `01-….md`, `02-….md` names, no
 * orphaned duplicates are left behind in the step-results directory (which never
 * deletes), and `steps.at(-1)` still means "the last real step". At index 0 all
 * of that would have had to be migrated exactly once, and could not be rolled
 * back.
 */
export const CONTEXT_STEP_ORDER_INDEX = -1;

/**
 * Statuses a HUMAN may force a step into (see `overrideStepStatus`).
 *
 * Deliberately only the settled ones. `running`/`queued` are owned by the
 * engine — they mean "a job is in flight", and asserting them without a
 * dispatch would leave a step no callback will ever settle — and `waiting` is
 * produced by the manual-review gate, which has its own Continue. What an
 * operator actually needs is to say "this DID work" (`done`), "this did not"
 * (`failed`) or "put it back in the queue" (`pending`).
 */
export const OVERRIDABLE_STEP_STATUSES = ["pending", "done", "failed"] as const;
export type OverridableStepStatus = (typeof OVERRIDABLE_STEP_STATUSES)[number];

/**
 * Statuses a HUMAN may force a workflow into (see `setWorkflowStatus`'s
 * `manual` option). `running` is the engine's own — it means "a dispatch is
 * happening", which a status write can't make true — and `waiting` belongs to
 * the manual-review gate.
 */
export const OVERRIDABLE_WORKFLOW_STATUSES = ["draft", "paused", "completed", "failed"] as const;
export type OverridableWorkflowStatus = (typeof OVERRIDABLE_WORKFLOW_STATUSES)[number];

export interface Workflow {
	id: string;
	name: string;
	/** awb hook / agent name this workflow's steps dispatch to. */
	agentName: string;
	hookUrl: string;
	/** X-Webhook-Secret for the awb hook. Never returned by the public API. */
	secret: string;
	status: WorkflowStatus;
	/** Claude session the last completed step produced; chained into the next dispatch. */
	lastSessionId: string | null;
	/**
	 * The operator's own conversation this workflow was created to CONTINUE, when
	 * it was created from one (see conversations.ts). Set once at creation and
	 * never rewritten: `lastSessionId` moves with whatever the harness reports and
	 * is cleared by a restart, so it cannot answer "which conversation is this
	 * workflow's" after the first step — this can, which is what lets a restart
	 * go back to the adopted conversation instead of starting a blank one.
	 *
	 * Null for every workflow that started from nothing, which is still the
	 * default.
	 */
	adoptedSessionId: string | null;
	/** Absolute path of the progress markdown file under ~/.target. */
	mdPath: string;
	/**
	 * Optional preamble injected before the first step of a fresh conversation
	 * (see runner.ts). It's prepended to the very first dispatch's input and
	 * then lives in the resumed session's history, so it's never re-injected on
	 * later steps — the resumed session already carries it.
	 */
	conversationContext: string | null;
	/**
	 * Whether `conversationContext` has been injected into the workflow's
	 * conversation (session) yet — the guard that keeps it from being injected
	 * twice. Set true when the first session is established, reset to false by
	 * restart (a fresh conversation) and by editing the context.
	 */
	contextInjected: boolean;
	/**
	 * Timestamp of the most recent compaction boundary observed in this
	 * workflow's conversation, or null if it has never been compacted. Written
	 * from the transcript (see compaction.ts) — the harness's own timestamp, not
	 * the hub's clock, so it can be compared against anything else the transcript
	 * says.
	 */
	lastCompactionAt: string | null;
	/**
	 * The boundary whose recovery the hub has already performed. When it differs
	 * from `lastCompactionAt` there is a compaction the conversation hasn't been
	 * re-primed for yet, and the next exec dispatch re-injects the conversation
	 * context. Kept as the boundary's own timestamp rather than a boolean so a
	 * SECOND compaction after the first was handled is detected too.
	 */
	compactionHandledAt: string | null;
	/**
	 * Whether the CURRENT status was forced by a human rather than derived from
	 * the steps. It's what makes an override stick: `reconcileStatus` (which runs
	 * on every read) refuses to re-derive a status a person asserted, so a
	 * workflow corrected to `completed` doesn't flip back to `failed` two seconds
	 * later. Cleared automatically by every engine status write — see
	 * `setWorkflowStatus`.
	 */
	statusManual: boolean;
	/** When that override was made; null when the status is the engine's own. */
	statusManualAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Step {
	id: string;
	workflowId: string;
	/**
	 * What this row is: an operator-authored `task`, or the hub-owned `context`
	 * step (see `StepKind`). Defaults to `task` everywhere it's absent — an old
	 * DB row, a template, an API body that never heard of it — so nothing that
	 * predates this column changes meaning.
	 */
	kind: StepKind;
	orderIndex: number;
	description: string;
	status: StepStatus;
	result: string | null;
	error: string | null;
	/** Claude session this step's run produced, reported by awb's callback. */
	sessionId: string | null;
	/** Per-step token that authenticates awb's POST to /api/steps/:id/result. */
	callbackToken: string;
	createdAt: string;
	startedAt: string | null;
	/** When the step was accepted by the broker as `queued` (awaiting the workdir lock / its `started` callback). Null once it has started (`startedAt` takes over) or for steps never dispatched. */
	queuedAt: string | null;
	finishedAt: string | null;
	/** Whether the current/last run was triggered on demand (the ▶ button) rather than by the sequential engine. */
	manualRun: boolean;
	/**
	 * Acceptance criteria the agent self-evaluates its result against after
	 * running this step. Empty/null means no judge — the step is accepted as
	 * soon as it runs, exactly like before this feature existed.
	 */
	acceptanceCriteria: string | null;
	/**
	 * Whether this step is gated on a HUMAN before the workflow may advance.
	 * With it on, a step that finished and passed its judge doesn't go `done` —
	 * it (and its workflow) go `waiting` until someone presses Continue. Off by
	 * default, so a workflow that never touches this feature runs exactly as
	 * before.
	 *
	 * Not to be confused with `manualRun`, which is about WHO started the step
	 * (the ▶ button vs. the engine); this is about who ends it.
	 */
	manualReview: boolean;
	/**
	 * Whether this step's work is delegated to a subagent (the Task tool) instead
	 * of being solved inline on the shared session. On by default — that's the
	 * behaviour every workflow had before this flag existed, and it's what keeps
	 * the reused session light (see runner.ts). Turned off, the step carries the
	 * opposite instruction: solve it directly in this thread, spawn nothing.
	 *
	 * Defaults to true wherever it's absent (old DB rows, old templates, an API
	 * body that never heard of it), so nothing silently changes runtime behaviour.
	 */
	useSubagent: boolean;
	/** How many times the judge may reject this step and re-run it before the workflow is failed. 0 = no retries (one shot, then fail if rejected). */
	maxRetries: number;
	/** Seconds to wait before each re-run after a judge reject. 0 = retry immediately. */
	retryIntervalSeconds: number;
	/** Retries already consumed on the current attempt cycle; reset by restart. */
	retryCount: number;
	/**
	 * Last moment this step's agent was observed doing something — the mtime of
	 * the freshest artifact its harness wrote (see progress.ts). Seeded with the
	 * run start when the step goes `running`, so the idle clock always has a
	 * reference. This is what the stale sweep measures instead of the old wall
	 * clock: a step that keeps writing is never timed out for being slow.
	 */
	lastProgressAt: string | null;
	/** Which artifact that signal came from (`transcript`, `session-file`, `run-log`) — kept for diagnosing a timeout after the fact. */
	lastProgressKind: ProgressKind | null;
	/** Fingerprint of the observed artifact; progress is only recorded when it changes, so an untouched file can't keep a hung step alive. */
	lastProgressToken: string | null;
	/** Which job the step's in-flight callback belongs to (see StepPhase). */
	phase: StepPhase;
	/**
	 * Whether this step is part of the current run selection. The sequential
	 * engine only ever dispatches selected steps, so Start/Resume/Restart run
	 * exactly the chosen subset. New steps default to selected (so workflows
	 * that never use this feature keep running everything), with one exception:
	 * a step appended while the workflow is mid-run lands UNSELECTED (see
	 * `addStep` in workflow.ts), because nobody ticked it and the engine must
	 * not dispatch it the moment the in-flight step finishes. An explicit
	 * empty selection via `setStepSelection` marks every step unselected —
	 * "select nothing" means nothing runs, not "run everything".
	 *
	 * A step that reaches `done` clears its own flag (see `DESELECT_ON_DONE`):
	 * the selection is what the NEXT run should do, and finished work isn't it.
	 */
	selected: boolean;
	/**
	 * Whether the CURRENT status was forced by a human (`overrideStepStatus`)
	 * rather than reported by a run. Purely a marker — the status itself is a
	 * normal one, so progress %, the .md file and the sequential engine all read
	 * it exactly as they would a status the engine wrote. Cleared the moment the
	 * step runs again (any dispatch/reset re-authors the status).
	 */
	statusManual: boolean;
	/** When that override was made; null when the status came from a run. */
	statusManualAt: string | null;
}

/**
 * A single step within a `Template`, mirroring the fields the "+ Add step"
 * form on a workflow collects (see `insertStep`'s options) — a template just
 * stores them ahead of time so they can seed those same fields when the
 * template is used to create real steps later. Templates never execute, so
 * unlike `Step` there's no status/retry/session tracking here.
 */
export interface TemplateStep {
	description: string;
	acceptanceCriteria: string | null;
	/** Seeds `Step.manualReview` — a template that encodes "a human signs this step off" would be useless if the flag were dropped on use. */
	manualReview: boolean;
	/** Seeds `Step.useSubagent`; absent (a template saved before the toggle existed) reads as true, the historical behaviour. */
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

let db: DatabaseSync | null = null;

/**
 * Exported for `account.ts`, which owns the auth/sessions tables the same way
 * this module owns workflows/steps/templates. Nothing else should reach for it.
 */
export function open(): DatabaseSync {
	if (db) return db;
	const file = dbFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	db = new DatabaseSync(file);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS workflows (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			agent_name TEXT NOT NULL UNIQUE,
			hook_url TEXT NOT NULL,
			secret TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			last_session_id TEXT,
			adopted_session_id TEXT,
			md_path TEXT NOT NULL,
			conversation_context TEXT,
			context_injected INTEGER NOT NULL DEFAULT 0,
			last_compaction_at TEXT,
			compaction_handled_at TEXT,
			completion_notified INTEGER NOT NULL DEFAULT 0,
			status_manual INTEGER NOT NULL DEFAULT 0,
			status_manual_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS steps (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			kind TEXT NOT NULL DEFAULT 'task',
			order_index INTEGER NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			error TEXT,
			session_id TEXT,
			callback_token TEXT NOT NULL,
			created_at TEXT NOT NULL,
			started_at TEXT,
			queued_at TEXT,
			finished_at TEXT,
			is_manual_run INTEGER NOT NULL DEFAULT 0,
			manual_review INTEGER NOT NULL DEFAULT 0,
			use_subagent INTEGER NOT NULL DEFAULT 1,
			acceptance_criteria TEXT,
			max_retries INTEGER NOT NULL DEFAULT 0,
			retry_interval_seconds INTEGER NOT NULL DEFAULT 0,
			retry_count INTEGER NOT NULL DEFAULT 0,
			phase TEXT NOT NULL DEFAULT 'exec',
			selected INTEGER NOT NULL DEFAULT 1,
			last_progress_at TEXT,
			last_progress_kind TEXT,
			last_progress_token TEXT,
			status_manual INTEGER NOT NULL DEFAULT 0,
			status_manual_at TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_steps_workflow ON steps(workflow_id, order_index);
		CREATE TABLE IF NOT EXISTS templates (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '',
			steps TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS attachments (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			step_id TEXT,
			field TEXT NOT NULL,
			filename TEXT NOT NULL,
			mime TEXT NOT NULL,
			size INTEGER NOT NULL,
			path TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(workflow_id, step_id, field);
		-- The single-user access layer (see account.ts / plan in usershandler.html).
		-- auth is a SINGLETON: the CHECK (id = 1) constraint makes a second row
		-- impossible, so the row's existence doubles as the "setup completed" flag
		-- and a raced double-setup loses to a constraint violation (mapped to 409).
		-- sessions stores only SHA-256 hashes of the opaque cookie tokens — a DB
		-- read cannot mint a session.
		CREATE TABLE IF NOT EXISTS auth (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			display_name TEXT,
			password_hash TEXT NOT NULL,
			password_salt TEXT NOT NULL,
			recovery_token_hash TEXT NOT NULL,
			recovery_token_set_at TEXT NOT NULL,
			failed_logins INTEGER NOT NULL DEFAULT 0,
			locked_until TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS sessions (
			token_hash TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		);
		-- Durable outbound queue for activity reporting (see reporter.ts /
		-- docs/report-server.es.html section 5). Append-only: emit() INSERTs, the
		-- daemon's flusher marks rows delivered or schedules a retry. The id column
		-- is the event's own uuid, so the server can dedupe a re-sent batch.
		-- Surviving restarts and offline periods is the whole point of persisting
		-- it rather than buffering in memory.
		CREATE TABLE IF NOT EXISTS report_events (
			id           TEXT PRIMARY KEY,
			kind         TEXT NOT NULL,
			workflow_id  TEXT,
			session_id   TEXT,
			payload      TEXT NOT NULL,
			created_at   TEXT NOT NULL,
			delivered_at TEXT,
			attempts     INTEGER NOT NULL DEFAULT 0,
			next_try_at  TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_report_pending ON report_events(delivered_at, next_try_at);
	`);
	// `CREATE TABLE IF NOT EXISTS` above is a no-op on a `steps` table that
	// already existed before these columns were added — add any that are missing
	// here so upgrades don't need a fresh DB. (Older DBs may still carry
	// now-unused isolated_* columns from an earlier iteration of this feature;
	// harmless to leave.)
	const database = db;
	const existingColumns = new Set(
		(database.prepare("PRAGMA table_info(steps)").all() as Record<string, unknown>[]).map((c) => String(c.name)),
	);
	const addColumn = (name: string, ddl: string) => {
		if (!existingColumns.has(name)) database.exec(`ALTER TABLE steps ADD COLUMN ${ddl};`);
	};
	addColumn("is_manual_run", "is_manual_run INTEGER NOT NULL DEFAULT 0");
	addColumn("manual_review", "manual_review INTEGER NOT NULL DEFAULT 0");
	// DEFAULT 1: every step written before the toggle existed ran through a
	// subagent, so that's what an upgraded row has to keep saying.
	addColumn("use_subagent", "use_subagent INTEGER NOT NULL DEFAULT 1");
	addColumn("acceptance_criteria", "acceptance_criteria TEXT");
	addColumn("max_retries", "max_retries INTEGER NOT NULL DEFAULT 0");
	addColumn("retry_interval_seconds", "retry_interval_seconds INTEGER NOT NULL DEFAULT 0");
	addColumn("retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
	addColumn("phase", "phase TEXT NOT NULL DEFAULT 'exec'");
	addColumn("selected", "selected INTEGER NOT NULL DEFAULT 1");
	addColumn("queued_at", "queued_at TEXT");
	addColumn("last_progress_at", "last_progress_at TEXT");
	addColumn("last_progress_kind", "last_progress_kind TEXT");
	addColumn("last_progress_token", "last_progress_token TEXT");
	addColumn("status_manual", "status_manual INTEGER NOT NULL DEFAULT 0");
	addColumn("status_manual_at", "status_manual_at TEXT");
	// DEFAULT 'task': every step that exists is one the operator wrote, so an
	// upgraded row has to keep saying exactly that. This is a pure ADD COLUMN with
	// a non-null default — no row is rewritten, no table is recreated, and a
	// workflow that is MID-RUN while the upgrade happens is untouched: an older
	// process still reading this DB sees `SELECT *` gain a column it ignores, and
	// its INSERTs name their columns explicitly, so the default fills this one in.
	addColumn("kind", "kind TEXT NOT NULL DEFAULT 'task'");
	// Same upgrade safety for the `workflows` table: `conversation_context` and
	// `context_injected` were added after launch, so an older DB won't have them.
	const existingWorkflowColumns = new Set(
		(database.prepare("PRAGMA table_info(workflows)").all() as Record<string, unknown>[]).map((c) => String(c.name)),
	);
	const addWorkflowColumn = (name: string, ddl: string) => {
		if (!existingWorkflowColumns.has(name)) database.exec(`ALTER TABLE workflows ADD COLUMN ${ddl};`);
	};
	addWorkflowColumn("conversation_context", "conversation_context TEXT");
	// Nullable with no default: an existing DB upgrades to "this workflow adopted
	// no conversation", which is what every workflow created before this existed
	// did.
	addWorkflowColumn("adopted_session_id", "adopted_session_id TEXT");
	addWorkflowColumn("context_injected", "context_injected INTEGER NOT NULL DEFAULT 0");
	// Compaction bookkeeping. Both nullable with no default, so an existing DB
	// upgrades to "never compacted, nothing to re-inject" — which is exactly what
	// a workflow that ran before the hub could see compactions should read as.
	addWorkflowColumn("last_compaction_at", "last_compaction_at TEXT");
	addWorkflowColumn("compaction_handled_at", "compaction_handled_at TEXT");
	addWorkflowColumn("status_before_review", "status_before_review TEXT");
	addWorkflowColumn("completion_notified", "completion_notified INTEGER NOT NULL DEFAULT 0");
	addWorkflowColumn("status_manual", "status_manual INTEGER NOT NULL DEFAULT 0");
	addWorkflowColumn("status_manual_at", "status_manual_at TEXT");
	return db;
}

/** Filesystem/URL-safe slug used as the awb hook name (e.g. "release-notes"). */
export function slugify(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "workflow";
}

function rowToWorkflow(row: Record<string, unknown>): Workflow {
	return {
		id: String(row.id),
		name: String(row.name),
		agentName: String(row.agent_name),
		hookUrl: String(row.hook_url),
		secret: String(row.secret),
		status: row.status as WorkflowStatus,
		lastSessionId: row.last_session_id == null ? null : String(row.last_session_id),
		adoptedSessionId: row.adopted_session_id == null ? null : String(row.adopted_session_id),
		mdPath: String(row.md_path),
		conversationContext: row.conversation_context == null ? null : String(row.conversation_context),
		contextInjected: Number(row.context_injected ?? 0) === 1,
		lastCompactionAt: row.last_compaction_at == null ? null : String(row.last_compaction_at),
		compactionHandledAt: row.compaction_handled_at == null ? null : String(row.compaction_handled_at),
		statusManual: Number(row.status_manual ?? 0) === 1,
		statusManualAt: row.status_manual_at == null ? null : String(row.status_manual_at),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export function insertWorkflow(input: {
	id: string;
	name: string;
	agentName: string;
	hookUrl: string;
	secret: string;
	mdPath: string;
	conversationContext?: string | null;
	/**
	 * The conversation this workflow continues. It seeds `lastSessionId` as well
	 * as `adoptedSessionId`, which is what makes the very first dispatch a
	 * `--resume` of that conversation rather than a fresh one.
	 */
	adoptedSessionId?: string | null;
}): Workflow {
	const now = new Date().toISOString();
	const conversationContext = input.conversationContext?.trim() || null;
	const adoptedSessionId = input.adoptedSessionId?.trim() || null;
	const workflow: Workflow = {
		id: input.id,
		name: input.name,
		agentName: input.agentName,
		hookUrl: input.hookUrl,
		secret: input.secret,
		status: "draft",
		lastSessionId: adoptedSessionId,
		adoptedSessionId,
		mdPath: input.mdPath,
		conversationContext,
		contextInjected: false,
		lastCompactionAt: null,
		compactionHandledAt: null,
		statusManual: false,
		statusManualAt: null,
		createdAt: now,
		updatedAt: now,
	};
	open()
		.prepare(
			`INSERT INTO workflows (id, name, agent_name, hook_url, secret, status, last_session_id, adopted_session_id, md_path, conversation_context, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			workflow.id,
			workflow.name,
			workflow.agentName,
			workflow.hookUrl,
			workflow.secret,
			workflow.status,
			workflow.lastSessionId,
			workflow.adoptedSessionId,
			workflow.mdPath,
			workflow.conversationContext,
			workflow.createdAt,
			workflow.updatedAt,
		);
	return workflow;
}

export function getWorkflow(id: string): Workflow | null {
	const row = open().prepare("SELECT * FROM workflows WHERE id = ?").get(id);
	return row ? rowToWorkflow(row as Record<string, unknown>) : null;
}

export function listWorkflows(): Workflow[] {
	// `rowid DESC` is the tiebreaker: `created_at` is an ISO string with only
	// millisecond precision, so two rows created in the same millisecond compare
	// equal and would otherwise come back in an arbitrary (insertion) order.
	const rows = open().prepare("SELECT * FROM workflows ORDER BY created_at DESC, rowid DESC").all();
	return (rows as Record<string, unknown>[]).map(rowToWorkflow);
}

/**
 * Writes a workflow's status.
 *
 * `manual` is the whole of the human-override feature at this level: it records
 * that THIS status was asserted by a person, which `reconcileStatus`
 * (workflow.ts) reads as "don't re-derive me from the steps". Every other
 * caller in the codebase omits it and therefore CLEARS the marker — that's
 * deliberate, and it's what bounds the override in time: the moment the engine
 * legitimately authors a status again (start/pause/resume/restart, a step
 * callback, a heal), the workflow goes back to being engine-owned. An override
 * survives reads and restarts; it does not survive a re-run.
 */
export function setWorkflowStatus(id: string, status: WorkflowStatus, options: { manual?: boolean } = {}): void {
	const manual = options.manual === true;
	// Any status that ISN'T `completed` re-arms the "workflow finished" notice
	// (see `claimWorkflowCompletionNotice`). This is what makes a restart — or an
	// "+ step" that pushes a terminal workflow back to `draft` — notify again on
	// the NEXT completion: leaving `completed` means the completion that was
	// already announced is over, and whatever finishes later is a new one.
	// Writing `completed` itself deliberately leaves the marker alone, so a
	// status re-write on an already-completed workflow can't re-arm it.
	const now = new Date().toISOString();
	open()
		.prepare(
			`UPDATE workflows SET status = ?, updated_at = ?,
			 completion_notified = CASE WHEN ? = 'completed' THEN completion_notified ELSE 0 END,
			 status_manual = ?, status_manual_at = ?
			 WHERE id = ?`,
		)
		.run(status, now, status, manual ? 1 : 0, manual ? now : null, id);
}

/**
 * Claims the right to send this workflow's "it finished" notification, and
 * answers whether the claim was won.
 *
 * This is the whole once-only guarantee, and it lives in SQL on purpose. The UI
 * polls the hub every ~2s and those reads run `expireStale`/`reconcileStatus`,
 * so any check of the shape "is it completed? then notify" would fire a Slack DM
 * on every poll forever. A single conditional UPDATE is atomic: the first caller
 * after a completion flips 0 → 1 and gets true, every later one matches no row
 * and gets false — including a caller racing on another request.
 *
 * Deliberately does NOT touch `updated_at`: this is delivery bookkeeping, not a
 * change to the workflow the operator should see. The marker is reset by
 * `setWorkflowStatus` whenever the workflow leaves `completed`.
 */
export function claimWorkflowCompletionNotice(id: string): boolean {
	return (
		open()
			.prepare("UPDATE workflows SET completion_notified = 1 WHERE id = ? AND completion_notified = 0")
			.run(id).changes > 0
	);
}

/**
 * Remembers what a workflow's status was just before a manual-review hold set
 * it to `waiting`, so releasing the hold can put it back.
 *
 * Only an on-demand ▶ run needs this. A step the ENGINE dispatched was, by
 * definition, part of a `running` workflow, and Continue resumes exactly that.
 * A ▶ run is different: it happens outside the engine, on a workflow that may
 * be `draft`, `completed`, `failed` or deliberately `paused`, and the gate must
 * hand that status back untouched rather than inventing one — a `paused`
 * workflow that silently became `draft` because someone re-ran one step would
 * be a state nobody asked for.
 */
export function setStatusBeforeReview(id: string, status: WorkflowStatus | null): void {
	open().prepare("UPDATE workflows SET status_before_review = ? WHERE id = ?").run(status, id);
}

/** Reads back the status stashed by `setStatusBeforeReview` AND clears it — a hold's stash is consumed exactly once, by the Continue that releases it. */
export function takeStatusBeforeReview(id: string): WorkflowStatus | null {
	const row = open().prepare("SELECT status_before_review AS s FROM workflows WHERE id = ?").get(id) as
		| Record<string, unknown>
		| undefined;
	const stashed = row?.s == null ? null : (String(row.s) as WorkflowStatus);
	if (stashed !== null) setStatusBeforeReview(id, null);
	return stashed;
}

/**
 * Renames a workflow. Only the display name moves: `agent_name`, `hook_url` and
 * `md_path` are the workflow's identity on this machine (an awb hook keyed by
 * name, a live URL its secret is bound to, a file the agent may already have
 * been told about), so they keep the slug they were born with. Called only via
 * `renameWorkflow`, which validates the name and rewrites the status file.
 */
export function setWorkflowName(id: string, name: string): void {
	open().prepare("UPDATE workflows SET name = ?, updated_at = ? WHERE id = ?").run(name, new Date().toISOString(), id);
}

export function setWorkflowSessionId(id: string, sessionId: string | null): void {
	open()
		.prepare("UPDATE workflows SET last_session_id = ?, updated_at = ? WHERE id = ?")
		.run(sessionId, new Date().toISOString(), id);
}

/**
 * Sets whether the workflow's conversation context has been injected into its
 * conversation (session) yet — the guard that keeps the preamble from being
 * injected twice. Set true when the first session is established (workflow.ts),
 * reset to false by restart (a fresh conversation) and by editing the context.
 */
export function setContextInjected(id: string, value: boolean): void {
	open()
		.prepare("UPDATE workflows SET context_injected = ?, updated_at = ? WHERE id = ?")
		.run(value ? 1 : 0, new Date().toISOString(), id);
}

/**
 * Records that this workflow's conversation was compacted at `at` (the
 * harness's own timestamp, read from the transcript).
 *
 * Guarded in SQL rather than in the caller: the write only lands when `at` is
 * strictly newer than what's stored, so re-observing the same boundary on every
 * dispatch and every UI poll is a no-op, and an older boundary (a stale read of
 * a transcript that has since been replaced) can never walk the marker
 * backwards. Returns whether it actually recorded something — that's the signal
 * "this is a compaction we hadn't seen", which is the one worth logging.
 *
 * Deliberately leaves `updated_at` alone: observing a compaction is the hub
 * noticing a fact about the outside world, not the operator changing the
 * workflow.
 */
export function recordCompaction(id: string, at: string): boolean {
	return (
		open()
			.prepare("UPDATE workflows SET last_compaction_at = ? WHERE id = ? AND (last_compaction_at IS NULL OR last_compaction_at < ?)")
			.run(at, id, at).changes > 0
	);
}

/**
 * Marks the compaction at `at` as recovered from — i.e. the conversation
 * context has been re-injected on a dispatch that followed it. A later
 * compaction writes a newer `last_compaction_at`, which makes them differ again
 * and arms the next re-injection.
 */
export function markCompactionHandled(id: string, at: string | null): void {
	open().prepare("UPDATE workflows SET compaction_handled_at = ? WHERE id = ?").run(at, id);
}

/**
 * Forgets both compaction markers. Only a restart does this: it abandons the
 * conversation the compaction happened in, so both "it was compacted" and "we
 * recovered from that" stop being statements about the session the workflow is
 * now on.
 */
export function clearCompactionMarkers(id: string): void {
	open().prepare("UPDATE workflows SET last_compaction_at = NULL, compaction_handled_at = NULL WHERE id = ?").run(id);
}

/**
 * Low-level setter for a workflow's conversation context — the preamble
 * injected before the first step of a fresh conversation (see runner.ts).
 * Called only via `setConversationContext`, which locks the context once it's
 * been injected, so this is only reached while the context is still editable
 * (i.e. `context_injected` is false). It stores the (trimmed) value and
 * leaves the flag untouched; the flag is set to true by `chainSession` on the
 * first session and reset to false by `restartWorkflow`. Pass null/empty to
 * clear it.
 */
export function setWorkflowConversationContext(id: string, context: string | null): void {
	const trimmed = context?.trim() || null;
	open()
		.prepare("UPDATE workflows SET conversation_context = ?, updated_at = ? WHERE id = ?")
		.run(trimmed, new Date().toISOString(), id);
}

export function deleteWorkflow(id: string): boolean {
	const database = open();
	database.prepare("DELETE FROM steps WHERE workflow_id = ?").run(id);
	return database.prepare("DELETE FROM workflows WHERE id = ?").run(id).changes > 0;
}

function rowToStep(row: Record<string, unknown>): Step {
	return {
		id: String(row.id),
		workflowId: String(row.workflow_id),
		// Absent column / NULL (a row written before the kind existed) is a task —
		// which is what every row written before this feature actually was.
		kind: (row.kind as StepKind) ?? "task",
		orderIndex: Number(row.order_index),
		description: String(row.description),
		status: row.status as StepStatus,
		result: row.result == null ? null : String(row.result),
		error: row.error == null ? null : String(row.error),
		sessionId: row.session_id == null ? null : String(row.session_id),
		callbackToken: String(row.callback_token),
		createdAt: String(row.created_at),
		startedAt: row.started_at == null ? null : String(row.started_at),
		queuedAt: row.queued_at == null ? null : String(row.queued_at),
		finishedAt: row.finished_at == null ? null : String(row.finished_at),
		manualRun: Number(row.is_manual_run ?? 0) === 1,
		manualReview: Number(row.manual_review ?? 0) === 1,
		// Absent column / NULL (a row migrated from before the toggle) reads as on.
		useSubagent: Number(row.use_subagent ?? 1) === 1,
		acceptanceCriteria: row.acceptance_criteria == null ? null : String(row.acceptance_criteria),
		maxRetries: Number(row.max_retries ?? 0),
		retryIntervalSeconds: Number(row.retry_interval_seconds ?? 0),
		retryCount: Number(row.retry_count ?? 0),
		lastProgressAt: row.last_progress_at == null ? null : String(row.last_progress_at),
		lastProgressKind: row.last_progress_kind == null ? null : (String(row.last_progress_kind) as ProgressKind),
		lastProgressToken: row.last_progress_token == null ? null : String(row.last_progress_token),
		phase: (row.phase as StepPhase) ?? "exec",
		selected: Number(row.selected ?? 1) === 1,
		statusManual: Number(row.status_manual ?? 0) === 1,
		statusManualAt: row.status_manual_at == null ? null : String(row.status_manual_at),
	};
}

export function insertStep(
	workflowId: string,
	description: string,
	options: {
		acceptanceCriteria?: string | null;
		manualReview?: boolean;
		/** Delegate the step to a subagent. Omitted = true (the historical behaviour). */
		useSubagent?: boolean;
		maxRetries?: number;
		retryIntervalSeconds?: number;
		/**
		 * Where the new step lands. Omitted (the usual case) appends it after the
		 * last one; a number threads it in directly AFTER that order index instead,
		 * pushing every later step down a slot. The caller resolves which step that
		 * index belongs to — db.ts stays a storage layer and only does the
		 * arithmetic.
		 */
		afterOrderIndex?: number | null;
		/** What the row IS (see `StepKind`). Omitted = `task`, the only kind an operator can author. */
		kind?: StepKind;
		/**
		 * Writes this exact `order_index` instead of computing one. The escape
		 * hatch for the hub-owned context step, which has to land at
		 * `CONTEXT_STEP_ORDER_INDEX` (-1) WITHOUT the append/insert-after
		 * arithmetic — that arithmetic exists to make room by shifting later rows
		 * down, and shifting is the one thing this row must never cause. Wins over
		 * `afterOrderIndex` when both are given.
		 */
		orderIndex?: number;
		/**
		 * Whether the step joins the run selection. Omitted = true, the
		 * historical column default (a workflow whose steps were all just
		 * created runs everything on Start). `addStep` passes false when the
		 * workflow is mid-run: the operator never ticked that box, so the
		 * engine must not pick the step up on the next dispatch decision.
		 */
		selected?: boolean;
	} = {},
): Step {
	const database = open();
	let orderIndex: number;
	if (options.orderIndex != null) {
		orderIndex = options.orderIndex;
	} else if (options.afterOrderIndex == null) {
		const maxRow = database
			.prepare("SELECT COALESCE(MAX(order_index), -1) AS maxIdx FROM steps WHERE workflow_id = ?")
			.get(workflowId) as Record<string, unknown>;
		orderIndex = Number(maxRow.maxIdx) + 1;
	} else {
		orderIndex = options.afterOrderIndex + 1;
		// Free the slot by moving everything from it downwards one place. Done
		// before the INSERT so the new row never collides with an existing index;
		// a crash between the two would only leave a gap, which nothing reads —
		// `order_index` is an ordering, not an identity (steps are keyed by id).
		database
			.prepare("UPDATE steps SET order_index = order_index + 1 WHERE workflow_id = ? AND order_index >= ?")
			.run(workflowId, orderIndex);
	}
	const acceptanceCriteria = options.acceptanceCriteria?.trim() || null;
	// The gate is opt-in: a step nobody configured never holds the workflow.
	const manualReview = options.manualReview === true;
	// The subagent is opt-OUT: only an explicit `false` runs the step inline.
	const useSubagent = options.useSubagent !== false;
	const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 0));
	const retryIntervalSeconds = Math.max(0, Math.floor(options.retryIntervalSeconds ?? 0));
	const step: Step = {
		id: crypto.randomUUID(),
		workflowId,
		kind: options.kind ?? "task",
		orderIndex,
		description,
		status: "pending",
		result: null,
		error: null,
		sessionId: null,
		callbackToken: crypto.randomBytes(24).toString("hex"),
		createdAt: new Date().toISOString(),
		startedAt: null,
		queuedAt: null,
		finishedAt: null,
		manualRun: false,
		manualReview,
		useSubagent,
		acceptanceCriteria,
		maxRetries,
		retryIntervalSeconds,
		retryCount: 0,
		lastProgressAt: null,
		lastProgressKind: null,
		lastProgressToken: null,
		phase: "exec",
		selected: options.selected !== false,
		statusManual: false,
		statusManualAt: null,
	};
	database
		.prepare(
			`INSERT INTO steps (id, workflow_id, kind, order_index, description, status, callback_token, created_at, acceptance_criteria, manual_review, use_subagent, max_retries, retry_interval_seconds, selected)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			step.id,
			step.workflowId,
			step.kind,
			step.orderIndex,
			step.description,
			step.status,
			step.callbackToken,
			step.createdAt,
			step.acceptanceCriteria,
			step.manualReview ? 1 : 0,
			step.useSubagent ? 1 : 0,
			step.maxRetries,
			step.retryIntervalSeconds,
			step.selected ? 1 : 0,
		);
	return step;
}

export function getStep(id: string): Step | null {
	const row = open().prepare("SELECT * FROM steps WHERE id = ?").get(id);
	return row ? rowToStep(row as Record<string, unknown>) : null;
}

/**
 * The workflow's hub-owned conversation-context step, if it has one. At most
 * one ever exists per workflow — `reconcileContextStep` (workflow.ts) is the
 * only writer and it is idempotent — but the query is ordered and limited
 * anyway so a duplicate written by a future bug degrades to "the first one"
 * instead of throwing on a read path the whole UI polls.
 */
export function getContextStep(workflowId: string): Step | null {
	const row = open()
		.prepare("SELECT * FROM steps WHERE workflow_id = ? AND kind = 'context' ORDER BY order_index LIMIT 1")
		.get(workflowId);
	return row ? rowToStep(row as Record<string, unknown>) : null;
}

export function listSteps(workflowId: string): Step[] {
	const rows = open()
		.prepare("SELECT * FROM steps WHERE workflow_id = ? ORDER BY order_index")
		.all(workflowId);
	return (rows as Record<string, unknown>[]).map(rowToStep);
}

/**
 * Every step currently `running` across all workflows — the set the progress
 * watchdog keeps an eye on. Usually zero or one (steps run one at a time per
 * workflow), so the sweep's per-step filesystem probe stays cheap.
 */
export function listRunningSteps(): Step[] {
	const rows = open().prepare("SELECT * FROM steps WHERE status = 'running'").all();
	return (rows as Record<string, unknown>[]).map(rowToStep);
}

export function nextPendingStep(workflowId: string): Step | null {
	const row = open()
		.prepare("SELECT * FROM steps WHERE workflow_id = ? AND status = 'pending' AND selected = 1 ORDER BY order_index LIMIT 1")
		.get(workflowId);
	return row ? rowToStep(row as Record<string, unknown>) : null;
}

/**
 * Session id of the step that ran most recently (by `started_at`) and produced
 * a session — i.e. the conversation the user most likely wants to watch. Every
 * step, sequential or on-demand, now shares the one session, so this equals
 * `workflow.lastSessionId`; it stays a step-level lookup so a session surfaces
 * the instant a step reports one. Null if no step has produced a session yet.
 */
export function latestStepSession(workflowId: string): string | null {
	const row = open()
		.prepare(
			`SELECT session_id FROM steps
			 WHERE workflow_id = ? AND session_id IS NOT NULL
			 ORDER BY started_at DESC LIMIT 1`,
		)
		.get(workflowId) as Record<string, unknown> | undefined;
	return row?.session_id == null ? null : String(row.session_id);
}

export function updateStepDescription(id: string, description: string): void {
	open().prepare("UPDATE steps SET description = ? WHERE id = ?").run(description, id);
}

/** Updates a step's run config (acceptance criteria + manual-review gate + subagent toggle + retry budget + retry wait). Editing a step is the only place these change after creation. */
export function updateStepConfig(
	id: string,
	config: {
		acceptanceCriteria: string | null;
		manualReview: boolean;
		useSubagent: boolean;
		maxRetries: number;
		retryIntervalSeconds: number;
	},
): void {
	open()
		.prepare(
			"UPDATE steps SET acceptance_criteria = ?, manual_review = ?, use_subagent = ?, max_retries = ?, retry_interval_seconds = ? WHERE id = ?",
		)
		.run(
			config.acceptanceCriteria?.trim() || null,
			config.manualReview ? 1 : 0,
			config.useSubagent ? 1 : 0,
			Math.max(0, Math.floor(config.maxRetries)),
			Math.max(0, Math.floor(config.retryIntervalSeconds)),
			id,
		);
}

export function deleteStep(id: string): boolean {
	return open().prepare("DELETE FROM steps WHERE id = ?").run(id).changes > 0;
}

/**
 * Exchanges the `order_index` of two steps — the storage half of "move this step
 * up/down one place" (see `moveStep` in workflow.ts, which decides WHICH two).
 *
 * A swap rather than a renumber of the whole list, because that is the smallest
 * write that reorders anything: every other row keeps the index it had, so the
 * `<NN>-<slug>.md` result files of the steps that DIDN'T move keep matching
 * their step. `order_index` is an ordering, not an identity (steps are keyed by
 * id), and there is no uniqueness constraint on it, so the two UPDATEs can run
 * as they are — but they run in one transaction anyway: a crash between them
 * would leave both steps sharing an index, which `ORDER BY order_index` would
 * then break ties on arbitrarily.
 */
export function swapStepOrder(aId: string, bId: string): void {
	const database = open();
	const read = database.prepare("SELECT order_index FROM steps WHERE id = ?");
	const a = read.get(aId) as Record<string, unknown> | undefined;
	const b = read.get(bId) as Record<string, unknown> | undefined;
	if (!a || !b) return;
	const update = database.prepare("UPDATE steps SET order_index = ? WHERE id = ?");
	database.exec("BEGIN");
	try {
		update.run(Number(b.order_index), aId);
		update.run(Number(a.order_index), bId);
		database.exec("COMMIT");
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

export function markStepRunning(id: string, manual = false): void {
	// `manual` is set on a re-dispatch of an on-demand ▶ run's retry: it comes
	// through here as a `pending` step (beginRetry put it there) and must stay
	// flagged manual, or its next callback would be mistaken for a sequential
	// run. A normal engine dispatch passes false and clears the flag.
	//
	// The idle clock is seeded with the run start (and its fingerprint cleared,
	// since any artifact this step saw belonged to a previous attempt): until the
	// first probe lands, "last progress" is "it just started".
	const now = new Date().toISOString();
	open()
		.prepare(
			`UPDATE steps SET status = 'running', started_at = ?, is_manual_run = ?, phase = 'exec',
			 last_progress_at = ?, last_progress_kind = NULL, last_progress_token = NULL,
			 status_manual = 0, status_manual_at = NULL
			 WHERE id = ? AND status = 'pending'`,
		)
		.run(now, manual ? 1 : 0, now, id);
}

/**
 * Records that a step's agent was observed doing something (progress.ts probes
 * the harness's own artifacts). Only writes when the artifact fingerprint
 * CHANGED — a file that merely still exists must not keep resetting the idle
 * clock, or a hung run would look alive forever. Only touches a `running` step;
 * returns whether the clock actually moved.
 */
export function recordStepProgress(
	id: string,
	signal: { at: string; kind: string; token: string },
): boolean {
	return (
		open()
			.prepare(
				`UPDATE steps SET last_progress_at = ?, last_progress_kind = ?, last_progress_token = ?
				 WHERE id = ? AND status = 'running' AND (last_progress_token IS NULL OR last_progress_token <> ?)`,
			)
			.run(signal.at, signal.kind, signal.token, id, signal.token).changes > 0
	);
}

/**
 * Marks a freshly-dispatched step `queued` — the broker accepted the POST but
	 * the run hasn't started yet (it's waiting on the workdir `flock` behind
	 * another run, or just hasn't sent its `started` callback). The step's
	 * timeout clock does NOT start here: `started_at` stays null while queued (and
	 * the idle-watchdog stamps are cleared), so `findTimeoutCandidates` — whose
	 * `running` arms key on `started_at`/`last_progress_at` — leaves it alone
	 * until the broker's `started` callback flips it to `running` via
	 * `promoteQueuedToRunning`. A separate `queuedTimeoutMs` safety net covers a
	 * dead broker that never calls back. Only acts on a `pending` step — a
	 * judge-phase dispatch (the step is already `running`) is a no-op here, so
	 * the judge stays `running` throughout (its `started` callback just refreshes
	 * `started_at`). Mirrors `markStepRunning`'s guard.
	 */
export function markStepQueued(id: string, manual = false): void {
	open()
		.prepare(
			`UPDATE steps SET status = 'queued', queued_at = ?, started_at = NULL, is_manual_run = ?, phase = 'exec',
			 last_progress_at = NULL, last_progress_kind = NULL, last_progress_token = NULL,
			 status_manual = 0, status_manual_at = NULL
			 WHERE id = ? AND status = 'pending'`,
		)
		.run(new Date().toISOString(), manual ? 1 : 0, id);
}

/**
 * Promotes a `queued` step to `running` and starts its timeout clock — called
	 * when the broker's `started` callback arrives (the run actually began) or
	 * when a result callback lands on a still-`queued` step (the `started`
	 * callback was lost, so settle from the result directly). Only acts on a
	 * `queued` step; any other state is left alone (a late `started` for a step
	 * already done/aborted is ignored). Returns whether a row was promoted.
	 */
export function promoteQueuedToRunning(id: string): boolean {
	// Seeds the idle clock too — the run starts here, so "last progress" starts
	// here (see markStepRunning).
	const now = new Date().toISOString();
	return (
		open()
			.prepare(
				`UPDATE steps SET status = 'running', started_at = ?, last_progress_at = ?,
				 last_progress_kind = NULL, last_progress_token = NULL
				 WHERE id = ? AND status = 'queued'`,
			)
			.run(now, now, id).changes > 0
	);
}

/**
 * Records an exec run's successful result but keeps the step `running` (or
 * `queued`, if the `started` callback was lost and the result arrived first)
 * and flips it into the `judge` phase — the self-evaluation job is about to be
 * dispatched, and its verdict (not this result) decides whether the step is
 * finally `done`. `started_at` is reset so the stale-step timeout is measured
 * against the judge run now in flight, not the exec run that already answered —
 * and the idle clock is re-seeded with it, so the judge doesn't inherit the exec
 * run's inactivity (nor its artifact fingerprint, which the judge's own writes
 * will now supersede).
 */
export function markStepJudging(id: string, outcome: { result?: string; sessionId?: string }): void {
	const now = new Date().toISOString();
	open()
		.prepare(
			`UPDATE steps SET result = ?, session_id = ?, phase = 'judge', started_at = ?, error = NULL,
			 last_progress_at = ?, last_progress_kind = NULL, last_progress_token = NULL
			 WHERE id = ? AND status IN ('running', 'queued')`,
		)
		.run(outcome.result ?? null, outcome.sessionId ?? null, now, now, id);
}

/**
 * Puts a verified step into the manual-review hold: its work finished and (if
 * it had one) its judge accepted it, but the step carries the `manual_review`
 * gate, so it becomes `waiting` instead of `done` and the engine stops there.
 *
 * `finished_at` is deliberately NOT set — the step hasn't finished, it's held —
 * and neither is the timeout clock touched: `findTimeoutCandidates` only looks
 * at `running`/`queued` steps, so a step can sit `waiting` for a human as long
 * as it takes without any watchdog failing it. The exec result is carried
 * through so nothing is lost while it waits (the judge path already stored it
 * via `markStepJudging`, hence the COALESCE rather than a plain overwrite).
 * Only acts on a step still `running`/`queued`; returns whether it took.
 */
export function markStepWaiting(id: string, outcome: { result?: string; sessionId?: string } = {}): boolean {
	return (
		open()
			.prepare(
				`UPDATE steps SET status = 'waiting', result = COALESCE(?, result), session_id = COALESCE(?, session_id), error = NULL
				 WHERE id = ? AND status IN ('running', 'queued')`,
			)
			.run(outcome.result ?? null, outcome.sessionId ?? null, id).changes > 0
	);
}

/**
 * Appended to every statement that settles a step as `done`: finishing takes the
 * step OUT of the run selection, so its checkbox clears the moment it succeeds.
 *
 * The checkbox answers "what runs when I press Start", and a step that is done
 * is not something the next Start should re-run — leaving every finished step
 * ticked meant the selection slowly became "all of them" again, which is the
 * opposite of what the operator chose. Nothing is lost by clearing it: the
 * checkbox is still there, so re-running a finished step is one click away, and
 * Start/Resume/Restart all call `setStepSelection` with the boxes as they stand
 * at that moment (see `setStepSelection`), so a re-ticked step runs normally.
 *
 * Only `done` does this. A `failed` step stays selected on purpose — that IS the
 * step the next run should pick up.
 *
 * The hub-owned context step is exempt, and that exemption is load-bearing:
 * `nextPendingStep` only ever returns a SELECTED step, so a context step
 * deselected when it went `done` would never be dispatched again after a
 * compaction put it back to `pending`, and the run would carry on with its
 * background silently missing. It has no checkbox either, so there is nothing to
 * clear for it in the first place.
 */
const DESELECT_ON_DONE = "selected = CASE WHEN kind = 'context' THEN selected ELSE 0 END";

/**
 * The same rule as `DESELECT_ON_DONE` for the statements whose target status is a
 * bound parameter rather than a literal `'done'` — bind the status again where
 * the `?` sits.
 */
const DESELECT_IF_STATUS_DONE = "selected = CASE WHEN ? = 'done' AND kind <> 'context' THEN 0 ELSE selected END";

/**
 * Releases a step from the manual-review hold: the human pressed Continue, so
 * it finally becomes `done` exactly as it would have without the gate, and the
 * engine can advance. Only acts on a `waiting` step — Continue on anything else
 * is a caller error (see `continueStep` in workflow.ts), not a silent no-op that
 * would leave the workflow in a state nobody asked for. Returns whether a row
 * changed.
 */
export function releaseWaitingStep(id: string): boolean {
	return (
		open()
			.prepare(`UPDATE steps SET status = 'done', finished_at = ?, ${DESELECT_ON_DONE} WHERE id = ? AND status = 'waiting'`)
			.run(new Date().toISOString(), id).changes > 0
	);
}

/** Marks a judge-accepted step `done`, preserving the exec result already stored by `markStepJudging`. */
export function finishStepDone(id: string): void {
	open()
		.prepare(
			`UPDATE steps SET status = 'done', finished_at = ?, ${DESELECT_ON_DONE}
			 WHERE id = ? AND status IN ('running', 'queued')`,
		)
		.run(new Date().toISOString(), id);
}

/**
 * Puts a judge-rejected step back to `pending` for another exec attempt and
 * bumps its retry counter, clearing the prior result/error. The next dispatch
 * re-runs it (with the judge's feedback) exactly like a first run.
 */
export function beginRetry(id: string): void {
	open()
		.prepare(
			`UPDATE steps SET status = 'pending', phase = 'exec', retry_count = retry_count + 1,
			 result = NULL, error = NULL, session_id = NULL, started_at = NULL, finished_at = NULL,
			 last_progress_at = NULL, last_progress_kind = NULL, last_progress_token = NULL,
			 status_manual = 0, status_manual_at = NULL
			 WHERE id = ?`,
		)
		.run(id);
}

/**
 * Settles a step with its run's outcome.
 *
 * `session_id` is COALESCEd rather than overwritten, for the same reason
 * `markStepWaiting` does it and `chainSession` does it at the workflow level: an
 * outcome that names no session is "I have nothing to add", not "there was no
 * conversation". Every judge-phase failure lands here with no session in hand —
 * the verdict couldn't run, couldn't be parsed, or rejected the step out of its
 * retries — and a plain overwrite wiped the id `markStepJudging` had just
 * stored, so the one step an operator most wants to read had a dead "Open
 * conversation" (the route answers `no_session_yet` off `step.sessionId`) while
 * the workflow itself still knew the session perfectly well. Nothing is lost by
 * keeping it: the two statements that legitimately drop a session (`beginRetry`,
 * `startManualRun`) both null it explicitly before the next dispatch.
 */
export function completeStep(
	id: string,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
): void {
	const status = outcome.ok ? "done" : "failed";
	open()
		.prepare(
			`UPDATE steps SET status = ?, result = ?, error = ?, session_id = COALESCE(?, session_id), finished_at = ?,
			 ${DESELECT_IF_STATUS_DONE}
			 WHERE id = ? AND status IN ('pending', 'queued', 'running')`,
		)
		.run(
			status,
			outcome.result ?? null,
			outcome.error ?? null,
			outcome.sessionId ?? null,
			new Date().toISOString(),
			status, // again, for the deselect CASE
			id,
		);
}

/**
 * Starts an on-demand run (the ▶ button): marks the step `queued` right
 * now regardless of its position in the queue or its previous outcome
 * (pending/done/failed all qualify — this doubles as "rerun this step"),
 * clearing any prior result/error. The dispatch that follows is accepted by
 * the broker and the run begins when the workdir lock is free; the broker's
 * `started` callback then promotes `queued → running` (`promoteQueuedToRunning`),
 * so the timeout clock starts at the real run start just like a sequential
 * step. No-op (returns false) if it's already `running` OR `queued`, so the
 * caller doesn't double-dispatch it — or if it's `waiting` on its manual
 * review, which only Continue may release: a ▶ re-run would otherwise silently
 * discard the gate the operator asked for.
 */
export function startManualRun(stepId: string): boolean {
	const now = new Date().toISOString();
	const changes = open()
		.prepare(
			`UPDATE steps SET status = 'queued', result = NULL, error = NULL, session_id = NULL,
			 queued_at = ?, started_at = NULL, finished_at = NULL, is_manual_run = 1, phase = 'exec', retry_count = 0,
			 last_progress_at = NULL, last_progress_kind = NULL, last_progress_token = NULL,
			 status_manual = 0, status_manual_at = NULL
			 WHERE id = ? AND status NOT IN ('running', 'queued', 'waiting')`,
		)
		.run(now, stepId).changes;
	return changes > 0;
}

/**
 * Aborts a step that is stuck `running` or `queued` (a dispatch whose awb
 * callback never came back, or one still waiting on the workdir lock): marks
 * it `failed` with the given error and a `finished_at`, but PRESERVES
 * `session_id`/`result`/`phase` so the conversation it established is still
 * reachable ("Open conversation") and the operator can inspect what happened.
 * Only acts on a `running` or `queued` step (mirrors `startManualRun`'s guard);
 * returns whether a row was changed. The operator can then re-run the step
 * via the ▶ button (`startManualRun`), which reconciles the workflow back out
 * of `failed` once it passes. Also makes the result callback path ignore any
 * late awb callback for this step (see the `status` guard in `onStepResult`).
 */
export function failRunningStep(stepId: string, error: string): boolean {
	return (
		open()
			.prepare(
				`UPDATE steps SET status = 'failed', error = ?, finished_at = ?
				 WHERE id = ? AND status IN ('running', 'queued')`,
			)
			.run(error, new Date().toISOString(), stepId).changes > 0
	);
}

/**
 * The other half of Abort, for a step held at its manual-review gate: the human
 * read the result and it's wrong, so instead of releasing the step it's recorded
 * `failed` with the given error. Nothing was in flight — the run finished, which
 * is why the step is holding at all — so unlike `failRunningStep` there's no
 * callback to fence off; the point here is purely that the operator's verdict is
 * written down. `result`, `session_id` and `phase` are preserved for the same
 * reason as there: the rejected work is still worth reading and the conversation
 * it established is still worth talking to. Only acts on a `waiting` step (a
 * stale button click on a step the operator already continued must change
 * nothing); returns whether a row was changed.
 */
export function rejectWaitingStep(stepId: string, error: string): boolean {
	return (
		open()
			.prepare(
				`UPDATE steps SET status = 'failed', error = ?, finished_at = ?
				 WHERE id = ? AND status = 'waiting'`,
			)
			.run(error, new Date().toISOString(), stepId).changes > 0
	);
}

/**
 * Forces a step's status by hand, and records that a human did it.
 *
 * This is the correction path for the case the engine can't see: the agent
 * really did the work, but the run was cut short (out of tokens) or its result
 * callback never landed, so the step — and with it the whole workflow — reads
 * `failed`. Nothing about the run is invented: the stored result/session/
 * retry-count are all left exactly as they are, so the transcript still tells
 * the true story. Only the verdict changes, and it's stamped as a human's.
 *
 * The `finished_at` bookkeeping follows the status so the derived views stay
 * honest: settling a step stamps a finish time (keeping any earlier one — the
 * run really did end then), while putting it back to `pending` clears the
 * finish time, because a step that is going to run again has not finished. A
 * step forced to `done` also drops its `error`: keeping a red error body under a
 * green badge is the contradiction this feature exists to remove — and it leaves
 * the run selection exactly as a step that finished on its own does
 * (`DESELECT_IF_STATUS_DONE`), because "this step is done" means the same thing
 * however it was decided. A `failed`
 * override with no error of its own gets one that says who set it, so the UI is
 * never blank about why.
 *
 * Deliberately NOT guarded on the current status — unlike every other setter
 * here, an override is the operator overruling the engine, and the caller
 * (`overrideStepStatus` in workflow.ts) is what enforces the one state it must
 * not touch: a step with a job actually in flight. Returns whether a row changed.
 */
export function overrideStepStatus(id: string, status: OverridableStepStatus): boolean {
	const now = new Date().toISOString();
	return (
		open()
			.prepare(
				`UPDATE steps SET status = ?,
				 finished_at = CASE WHEN ? = 'pending' THEN NULL ELSE COALESCE(finished_at, ?) END,
				 error = CASE WHEN ? = 'done' THEN NULL
				              WHEN ? = 'pending' THEN NULL
				              ELSE COALESCE(error, 'Marked failed manually.') END,
				 status_manual = 1, status_manual_at = ?,
				 ${DESELECT_IF_STATUS_DONE}
				 WHERE id = ?`,
			)
			.run(status, status, now, status, status, now, status, id).changes > 0
	);
}

/** Why a step showed up in the timeout sweep: no sign of activity, the absolute ceiling, or a queue wait that never started. */
export type TimeoutReason = "idle" | "hard" | "queued";

export interface TimeoutCandidate {
	stepId: string;
	workflowId: string;
	reason: TimeoutReason;
}

/**
 * Phase 1 of the stale sweep: lists the steps that MIGHT have to time out. It
 * only reads — nothing is failed here, because the decision needs a fresh
 * filesystem probe the DB can't do (see `expireStale` in workflow.ts, which
 * re-probes each candidate and drops the ones whose agent is demonstrably still
 * working). That split is the whole point of the change: the old version failed
 * every step past a wall clock in the same statement, which is what killed long
 * but healthy runs.
 *
 * Three clocks:
 * - `idle` — a `running` step whose last observed progress (or, until the first
 *   probe lands, its run start) is older than `idleTimeoutMs`.
 * - `hard` — a `running` step older than `hardTimeoutMs` since `started_at`,
 *   however active it looks. Takes precedence over `idle` when both apply.
 * - `queued` — unchanged: a step still waiting on the workdir lock past
 *   `queuedTimeoutMs` (a dead broker that never sent `started`). `queued_at`
 *   being null for non-queued steps keeps them out of that arm.
 */
export function findTimeoutCandidates(limits: {
	idleTimeoutMs: number;
	hardTimeoutMs: number;
	queuedTimeoutMs: number;
}): TimeoutCandidate[] {
	const now = Date.now();
	const idleCutoff = new Date(now - limits.idleTimeoutMs).toISOString();
	const hardCutoff = new Date(now - limits.hardTimeoutMs).toISOString();
	const queuedCutoff = new Date(now - limits.queuedTimeoutMs).toISOString();
	const rows = open()
		.prepare(
			`SELECT id, workflow_id,
			        CASE WHEN status = 'queued' THEN 'queued'
			             WHEN started_at < ? THEN 'hard'
			             ELSE 'idle' END AS reason
			 FROM steps
			 WHERE (status = 'running' AND (COALESCE(last_progress_at, started_at) < ? OR started_at < ?))
			    OR (status = 'queued' AND queued_at < ?)`,
		)
		.all(hardCutoff, idleCutoff, hardCutoff, queuedCutoff) as Record<string, unknown>[];
	return rows.map((r) => ({
		stepId: String(r.id),
		workflowId: String(r.workflow_id),
		reason: String(r.reason) as TimeoutReason,
	}));
}

/**
 * Phase 2: actually fails a step the sweep decided is stuck, with a message
 * that says WHY (idle for how long, since which signal — or the hard cap). Same
 * shape as `failRunningStep`, kept separate so a timeout reads differently from
 * an operator abort in the logs and the UI. Only acts on a step still
 * `running`/`queued`, so a run that answered while we were probing wins.
 */
export function failTimedOutStep(stepId: string, error: string): boolean {
	return failRunningStep(stepId, error);
}

/**
 * Records which steps a run should dispatch. An empty selection means "run
 * nothing" — every step is flagged UNSELECTED, so the sequential engine
 * (`nextPendingStep` only returns a selected step) dispatches nothing at all.
 * Otherwise only the listed steps are selected and the rest are skipped. Ids
 * that don't belong to the workflow are ignored.
 *
 * The one exception is the hub-owned context step. The UI sends an explicit id
 * list built from the step checkboxes, and that list can never contain the
 * context step (it isn't offered as a checkbox), so the plain CASE would
 * deselect it — and `nextPendingStep` only ever returns a SELECTED step, so the
 * workflow would then run perfectly with its background silently missing. That's
 * the worst failure this feature could have, so the kind is forced selected here
 * rather than trusted to every caller. Only in the non-empty branch: "select
 * nothing" still means nothing runs, context included.
 *
 * Note this only governs runs that actually call this function (Start/Resume/
 * Restart). Brand-new steps still default to `selected = 1` at the column
 * level (see `insertStep`/the `selected` column default), so existing
 * workflows nobody has touched with this feature keep running exactly as
 * before.
 */
export function setStepSelection(workflowId: string, stepIds: string[]): void {
	const database = open();
	if (stepIds.length === 0) {
		database.prepare("UPDATE steps SET selected = 0 WHERE workflow_id = ?").run(workflowId);
		return;
	}
	const placeholders = stepIds.map(() => "?").join(", ");
	database
		.prepare(
			`UPDATE steps SET selected = CASE WHEN id IN (${placeholders}) OR kind = 'context' THEN 1 ELSE 0 END WHERE workflow_id = ?`,
		)
		.run(...stepIds, workflowId);
}

/**
 * Resets the workflow's *selected* steps back to pending, wiping prior results
 * — used by restart. Only selected steps are touched, so restarting with a
 * subset chosen leaves the unselected steps' results intact and re-runs just
 * the chosen ones. With nothing selected (see `setStepSelection`), no step is
 * selected, so this resets nothing at all.
 *
 * The context step rides along because `setStepSelection` always selects it
 * (unless the selection is empty), and that pairing is deliberate: a restart
 * also resets `context_injected` and drops the session, so a context step left
 * `done` from the OLD conversation would mean nothing ever re-primes the NEW
 * one — and the legacy prepend, which used to cover that, is now disabled for
 * workflows that have a context step. Selected-and-reset is what keeps the two
 * halves of a restart in agreement.
 */
export function resetSteps(workflowId: string): void {
	open()
		.prepare(
			`UPDATE steps SET status = 'pending', result = NULL, error = NULL, session_id = NULL,
			 started_at = NULL, finished_at = NULL, is_manual_run = 0, phase = 'exec', retry_count = 0,
			 last_progress_at = NULL, last_progress_kind = NULL, last_progress_token = NULL,
			 status_manual = 0, status_manual_at = NULL
			 WHERE workflow_id = ? AND selected = 1`,
		)
		.run(workflowId);
}

export interface Progress {
	total: number;
	done: number;
	failed: number;
	pct: number;
}

/**
 * Progress over the workflow's REAL work only — `kind = 'task'`. The hub-owned
 * context step is plumbing, not a step the operator asked for: counting it would
 * make a 2-step workflow read "0/3", stall the bar at 66% when everything the
 * operator wrote is finished, and put a third step in the completion DM.
 */
export function stepProgress(workflowId: string): Progress {
	const row = open()
		.prepare(
			`SELECT COUNT(*) AS total,
			        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
			        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
			 FROM steps WHERE workflow_id = ? AND kind = 'task'`,
		)
		.get(workflowId) as Record<string, unknown>;
	const total = Number(row.total ?? 0);
	const done = Number(row.done ?? 0);
	const failed = Number(row.failed ?? 0);
	return { total, done, failed, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

// --- Templates --------------------------------------------------------
//
// A template is a saved (name, tags, ordered step list) triple that seeds the
// same fields as the workflow "+ Add step" form, so a user doesn't have to
// re-type the same steps for every new workflow. Templates never execute —
// no status, no dispatch, no awb hook — so the whole step list is stored as
// one JSON column rather than a child table like `steps`.

function normalizeTemplateTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	return tags.map((t) => String(t).trim()).filter((t) => t !== "");
}

function normalizeTemplateSteps(steps: unknown): TemplateStep[] {
	if (!Array.isArray(steps)) return [];
	return steps
		.map((s) => {
			const obj = (s ?? {}) as Record<string, unknown>;
			const description = typeof obj.description === "string" ? obj.description.trim() : "";
			const acceptanceCriteria =
				typeof obj.acceptanceCriteria === "string" && obj.acceptanceCriteria.trim() !== ""
					? obj.acceptanceCriteria.trim()
					: null;
			// Opt-in, exactly like `insertStep`: a template stored before this field
			// existed (or one that simply doesn't want the gate) reads as false.
			const manualReview = obj.manualReview === true;
			// Opt-out, exactly like `insertStep`: a template stored before this field
			// existed keeps delegating to a subagent, which is what it used to do.
			const useSubagent = obj.useSubagent !== false;
			const maxRetries = Math.max(0, Math.floor(Number(obj.maxRetries ?? 0)) || 0);
			const retryIntervalSeconds = Math.max(0, Math.floor(Number(obj.retryIntervalSeconds ?? 0)) || 0);
			return { description, acceptanceCriteria, manualReview, useSubagent, maxRetries, retryIntervalSeconds };
		})
		.filter((s) => s.description !== "");
}

function rowToTemplate(row: Record<string, unknown>): Template {
	let tags: string[] = [];
	try {
		const parsed = JSON.parse(String(row.tags ?? "[]"));
		if (Array.isArray(parsed)) tags = parsed.map((t) => String(t));
	} catch {
		// Tolerate malformed/legacy data rather than blow up the whole list.
	}
	let steps: TemplateStep[] = [];
	try {
		const parsed = JSON.parse(String(row.steps ?? "[]"));
		if (Array.isArray(parsed)) steps = normalizeTemplateSteps(parsed);
	} catch {
		// Tolerate malformed/legacy data rather than blow up the whole list.
	}
	return {
		id: String(row.id),
		name: String(row.name),
		tags,
		steps,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export function insertTemplate(input: { name: string; tags?: unknown; steps?: unknown }): Template {
	const now = new Date().toISOString();
	const template: Template = {
		id: crypto.randomUUID(),
		name: input.name,
		tags: normalizeTemplateTags(input.tags),
		steps: normalizeTemplateSteps(input.steps),
		createdAt: now,
		updatedAt: now,
	};
	open()
		.prepare(`INSERT INTO templates (id, name, tags, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(
			template.id,
			template.name,
			JSON.stringify(template.tags),
			JSON.stringify(template.steps),
			template.createdAt,
			template.updatedAt,
		);
	return template;
}

export function getTemplate(id: string): Template | null {
	const row = open().prepare("SELECT * FROM templates WHERE id = ?").get(id);
	return row ? rowToTemplate(row as Record<string, unknown>) : null;
}

export function listTemplates(): Template[] {
	// See listWorkflows: `rowid DESC` keeps same-millisecond rows newest-first.
	const rows = open().prepare("SELECT * FROM templates ORDER BY created_at DESC, rowid DESC").all();
	return (rows as Record<string, unknown>[]).map(rowToTemplate);
}

/** Partial update — only the fields present in `input` are changed. Returns null if the template doesn't exist. */
export function updateTemplate(
	id: string,
	input: { name?: string; tags?: unknown; steps?: unknown },
): Template | null {
	const existing = getTemplate(id);
	if (!existing) return null;
	const name = input.name !== undefined ? input.name : existing.name;
	const tags = input.tags !== undefined ? normalizeTemplateTags(input.tags) : existing.tags;
	const steps = input.steps !== undefined ? normalizeTemplateSteps(input.steps) : existing.steps;
	const updatedAt = new Date().toISOString();
	open()
		.prepare("UPDATE templates SET name = ?, tags = ?, steps = ?, updated_at = ? WHERE id = ?")
		.run(name, JSON.stringify(tags), JSON.stringify(steps), updatedAt, id);
	return { ...existing, name, tags, steps, updatedAt };
}

export function deleteTemplate(id: string): boolean {
	return open().prepare("DELETE FROM templates WHERE id = ?").run(id).changes > 0;
}

// --- Template export / import -----------------------------------------
//
// A template is already pure, portable data: no filesystem paths, no secrets,
// no session/agent ids, no attachments, no foreign keys — and it never
// executes, it only seeds the "+ Add step" form. So moving one between machines
// is moving JSON, with no environment fixup at either end. All this layer adds
// is an envelope and the rules for reading a foreign one back.
//
// The envelope is versioned from the start, mirroring REPORT_SCHEMA_VERSION in
// reporter.ts. The step shape has already grown twice (`manualReview`,
// `useSubagent`) and both times `normalizeTemplateSteps`'s defaults-on-absence
// behaviour absorbed it silently; an explicit version is what makes the growth
// that CAN'T be absorbed cheap to detect, instead of a file from a future hub
// importing as quietly-wrong data.

/** Marks a file as ours, so a stray JSON dropped on the import control is refused rather than half-read. */
export const TEMPLATE_BUNDLE_KIND = "target.templates";

/** Version of the bundle envelope. Bump when a change can NOT be absorbed by the normalizers' defaults. */
export const TEMPLATE_BUNDLE_SCHEMA_VERSION = 1;

/**
 * One template inside a bundle. Deliberately WITHOUT the id and the
 * created/updated stamps: those describe a row on the machine that exported it,
 * not the template itself. Carrying the id across would let an import collide
 * with (or silently claim to be) an unrelated local template — see
 * `importTemplates`, which mints a fresh one instead.
 */
export interface TemplateBundleEntry {
	name: string;
	tags: string[];
	steps: TemplateStep[];
}

export interface TemplateBundle {
	kind: typeof TEMPLATE_BUNDLE_KIND;
	schemaVersion: number;
	exportedAt: string;
	templates: TemplateBundleEntry[];
}

/** Thrown by `parseTemplateBundle`; `code` is the wire error string the route answers with. */
export class TemplateBundleError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "TemplateBundleError";
		this.code = code;
	}
}

/** Wraps templates in the export envelope. Used for one template and for the whole list alike. */
export function templateBundle(templates: Template[]): TemplateBundle {
	return {
		kind: TEMPLATE_BUNDLE_KIND,
		schemaVersion: TEMPLATE_BUNDLE_SCHEMA_VERSION,
		exportedAt: new Date().toISOString(),
		templates: templates.map((t) => ({ name: t.name, tags: t.tags, steps: t.steps })),
	};
}

/**
 * Reads an untrusted bundle into entries ready for `importTemplates`, or throws
 * a `TemplateBundleError` naming what's wrong with it.
 *
 * The canonical shape is the envelope, but a bare array of templates and a bare
 * single template are accepted too — someone hand-editing a file, or pasting
 * one template out of a bundle, shouldn't be told "invalid" for a shape whose
 * meaning is unambiguous. Everything below the entry level goes through
 * `normalizeTemplateTags`/`normalizeTemplateSteps`, the same functions the CRUD
 * already runs on API input: they coerce types, clamp the retry numbers, drop
 * empty-description steps and default the newer flags when a step from an older
 * hub omits them. A second validation layer here would only be a second place
 * for the two to disagree.
 */
export function parseTemplateBundle(input: unknown): TemplateBundleEntry[] {
	if (input === null || typeof input !== "object") throw new TemplateBundleError("invalid_bundle");

	let rawTemplates: unknown;
	if (Array.isArray(input)) {
		// A bare array of templates.
		rawTemplates = input;
	} else if ("templates" in (input as Record<string, unknown>) || "kind" in (input as Record<string, unknown>)) {
		// An envelope — anything claiming to be one is held to all of its rules.
		const envelope = input as Record<string, unknown>;
		if (envelope.kind !== TEMPLATE_BUNDLE_KIND) throw new TemplateBundleError("unknown_kind");
		// Absent reads as "version 1": the field is required going forward, but a
		// file that predates nothing at all can only be the first version.
		const version = envelope.schemaVersion === undefined ? TEMPLATE_BUNDLE_SCHEMA_VERSION : envelope.schemaVersion;
		if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
			throw new TemplateBundleError("invalid_bundle");
		}
		// Only a NEWER version is refused. An older one is exactly the case the
		// normalizers already handle, so it stays importable.
		if (version > TEMPLATE_BUNDLE_SCHEMA_VERSION) throw new TemplateBundleError("unsupported_schema_version");
		if (!Array.isArray(envelope.templates)) throw new TemplateBundleError("invalid_bundle");
		rawTemplates = envelope.templates;
	} else {
		// A bare single template.
		rawTemplates = [input];
	}

	const entries: TemplateBundleEntry[] = [];
	for (const raw of rawTemplates as unknown[]) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TemplateBundleError("invalid_bundle");
		const obj = raw as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		// A nameless template is unusable — it would land in the list as a blank
		// row nobody can identify — and it's the clearest sign the file isn't one
		// of ours, so it fails the whole import rather than being skipped quietly.
		if (name === "") throw new TemplateBundleError("invalid_bundle");
		entries.push({ name, tags: normalizeTemplateTags(obj.tags), steps: normalizeTemplateSteps(obj.steps) });
	}
	if (entries.length === 0) throw new TemplateBundleError("empty_bundle");
	return entries;
}

/**
 * The prefix a copy of something is proposed under ("Clone - release
 * checklist"). It lives here rather than in workflow.ts (whose `cloneName`
 * still owns the workflow half of it) because template import needs the same
 * convention: one prefix for "this is a copy of that", not two.
 */
export const CLONE_NAME_PREFIX = "Clone - ";

/**
 * A name that isn't already `taken`. An import of a template whose name is free
 * keeps it — that's the common case, importing onto a machine that has never
 * seen it — and only a genuine collision is disambiguated, with the same
 * "Clone - " prefix the workflow clone uses. The numeric suffix is for the
 * third copy onwards, where the prefix alone would collide again.
 */
function uniqueTemplateName(name: string, taken: Set<string>): string {
	if (!taken.has(name)) return name;
	const cloned = `${CLONE_NAME_PREFIX}${name}`;
	if (!taken.has(cloned)) return cloned;
	for (let n = 2; ; n += 1) {
		const candidate = `${cloned} (${n})`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * Stores parsed bundle entries as new templates, newest last, and returns them.
 *
 * Every one gets a fresh id from `insertTemplate` — an import is a copy, never
 * a restore over the top of an existing row, so it can't overwrite or shadow a
 * local template that happens to share the exported one's id.
 */
export function importTemplates(entries: TemplateBundleEntry[]): Template[] {
	// Seeded once and grown as we go, so two same-named templates inside ONE
	// bundle disambiguate against each other too, not just against the DB.
	const taken = new Set(listTemplates().map((t) => t.name));
	const created: Template[] = [];
	for (const entry of entries) {
		const name = uniqueTemplateName(entry.name, taken);
		taken.add(name);
		created.push(insertTemplate({ name, tags: entry.tags, steps: entry.steps }));
	}
	return created;
}

// --- Settings ---------------------------------------------------------
//
// Hub-wide preferences, stored as one JSON blob per key in `settings` (same
// "the whole shape is one column" approach as a template's step list — these
// are read and written whole, never queried by field). Only the notification
// preferences and the keyboard-shortcut bindings live here so far; a future
// setting adds a key, not a table.

/** The single `settings` row the notification preferences live in. */
const NOTIFICATION_SETTINGS_KEY = "notifications";

/** The single `settings` row the keyboard-shortcut bindings live in. */
const SHORTCUT_SETTINGS_KEY = "shortcuts";

/**
 * Per-channel delivery config, keyed by channel id.
 *
 * Slack is the only channel that's been specified (the user asked for four ways
 * to receive notifications but only described this one), so the rest are
 * deliberately absent rather than invented with made-up fields. Adding one is a
 * new key here plus its normalisation below.
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

/** What a hub with no saved preferences reports: notifications off, nothing configured. */
export function defaultNotificationSettings(): NotificationSettings {
	return { enabled: false, channels: { slack: { username: "" } }, updatedAt: null };
}

/**
 * Coerces whatever a client sent into the channel shape, trimming each value.
 * An absent/malformed channel becomes its empty config rather than an error —
 * the "is this enough to enable notifications?" judgement belongs to the route
 * (see server.ts), not to storage.
 */
export function normalizeNotificationChannels(channels: unknown): NotificationChannels {
	const obj = (channels ?? {}) as Record<string, unknown>;
	const slack = (obj.slack ?? {}) as Record<string, unknown>;
	return { slack: { username: typeof slack.username === "string" ? slack.username.trim() : "" } };
}

export function getNotificationSettings(): NotificationSettings {
	const row = open().prepare("SELECT * FROM settings WHERE key = ?").get(NOTIFICATION_SETTINGS_KEY) as
		| Record<string, unknown>
		| undefined;
	if (!row) return defaultNotificationSettings();
	try {
		const parsed = JSON.parse(String(row.value)) as Record<string, unknown>;
		return {
			enabled: parsed.enabled === true,
			channels: normalizeNotificationChannels(parsed.channels),
			updatedAt: row.updated_at == null ? null : String(row.updated_at),
		};
	} catch {
		// Tolerate malformed/legacy data rather than break the settings page
		// (same rationale as rowToTemplate).
		return defaultNotificationSettings();
	}
}

/** Replaces the stored preferences wholesale and returns what was written. */
export function saveNotificationSettings(input: { enabled: boolean; channels: NotificationChannels }): NotificationSettings {
	const settings: NotificationSettings = {
		enabled: input.enabled,
		channels: normalizeNotificationChannels(input.channels),
		updatedAt: new Date().toISOString(),
	};
	open()
		.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.run(
			NOTIFICATION_SETTINGS_KEY,
			JSON.stringify({ enabled: settings.enabled, channels: settings.channels }),
			settings.updatedAt,
		);
	return settings;
}

// --- Keyboard shortcut bindings -----------------------------------------
//
// The five hub shortcuts (focus the first workflow, toggle dictation, open the
// create-workflow modal, press a held step's Continue button, press the open
// workflow's Start button) are configurable from the Settings view: the
// operator picks the letter each one fires on. The
// modifier is still Alt or Shift (the hook honours either, never both — see
// useKeyboardShortcuts), so only the key is stored, one per action. Stored the
// same way as the notification preferences: one JSON blob in the `settings`
// table.

/** The actions a shortcut can be bound to — the five the hub ships with. */
export type ShortcutAction =
	| "focusWorkflow"
	| "toggleDictation"
	| "createWorkflow"
	| "continueStep"
	| "startWorkflow";

/** A single binding: which letter fires the action (lowercased on the way in). */
export interface ShortcutBinding {
	key: string;
}

export interface ShortcutSettings {
	bindings: Record<ShortcutAction, ShortcutBinding>;
	/** Null until the bindings have been saved at least once. */
	updatedAt: string | null;
}

/**
 * The defaults the hub ships with: W, R, N — C for the manual-review Continue,
 * and S for the workflow's Start button.
 */
export function defaultShortcutSettings(): ShortcutSettings {
	return {
		bindings: {
			focusWorkflow: { key: "w" },
			toggleDictation: { key: "r" },
			createWorkflow: { key: "n" },
			continueStep: { key: "c" },
			startWorkflow: { key: "s" },
		},
		updatedAt: null,
	};
}

const SHORTCUT_KEYS: readonly ShortcutAction[] = [
	"focusWorkflow",
	"toggleDictation",
	"createWorkflow",
	"continueStep",
	"startWorkflow",
];

/**
 * Coerces a single binding a client sent: a single a–z letter, lowercased.
 * Anything else (a number, punctuation, a multi-char string, the wrong type)
 * falls back to that action's default key rather than throwing — the route
 * decides whether a full binding set is valid (e.g. no two actions on the same
 * key), storage just keeps the shape sane.
 */
function normalizeShortcutBinding(action: ShortcutAction, raw: unknown): ShortcutBinding {
	if (typeof raw === "string" && /^[a-z]$/.test(raw)) return { key: raw };
	if (typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).key === "string") {
		const key = ((raw as Record<string, unknown>).key as string).trim().toLowerCase();
		if (/^[a-z]$/.test(key)) return { key };
	}
	return { key: defaultShortcutSettings().bindings[action].key };
}

/**
 * Coerces a whole binding set into shape, falling back per action as above.
 * Absent actions keep their default key, so a client that only sends one
 * binding can't silently blank the others — which is also what makes adding an
 * action (continueStep, then startWorkflow) safe for a hub whose stored blob
 * predates it: the new action reads back on its default key.
 */
export function normalizeShortcutBindings(bindings: unknown): Record<ShortcutAction, ShortcutBinding> {
	const obj = (bindings ?? {}) as Record<string, unknown>;
	const out = {} as Record<ShortcutAction, ShortcutBinding>;
	for (const action of SHORTCUT_KEYS) {
		out[action] = normalizeShortcutBinding(action, obj[action]);
	}
	return out;
}

export function getShortcutSettings(): ShortcutSettings {
	const row = open().prepare("SELECT * FROM settings WHERE key = ?").get(SHORTCUT_SETTINGS_KEY) as
		| Record<string, unknown>
		| undefined;
	if (!row) return defaultShortcutSettings();
	try {
		const parsed = JSON.parse(String(row.value)) as Record<string, unknown>;
		return {
			bindings: normalizeShortcutBindings(parsed.bindings),
			updatedAt: row.updated_at == null ? null : String(row.updated_at),
		};
	} catch {
		// Tolerate malformed/legacy data rather than break the settings page
		// (same rationale as getNotificationSettings).
		return defaultShortcutSettings();
	}
}

/** Replaces the stored bindings wholesale and returns what was written. */
export function saveShortcutSettings(input: {
	bindings: Record<ShortcutAction, ShortcutBinding>;
}): ShortcutSettings {
	const settings: ShortcutSettings = {
		bindings: normalizeShortcutBindings(input.bindings),
		updatedAt: new Date().toISOString(),
	};
	open()
		.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.run(
			SHORTCUT_SETTINGS_KEY,
			JSON.stringify({ bindings: settings.bindings }),
			settings.updatedAt,
		);
	return settings;
}

// --- Attachments ------------------------------------------------------
//
// Images the operator pinned to one of the three text inputs a workflow is
// written in: the workflow-level conversation context, and each step's task
// description and acceptance criteria. Only the METADATA lives here — the bytes
// are files under ~/.target/attachments/<workflow_id>/ (see attachments.ts),
// because the whole point of the feature is that the agent can `Read` them from
// a real absolute path, which a BLOB in SQLite could never give it.
//
// `step_id` is NULL for a conversation-context attachment (it belongs to the
// workflow, not to any step) and set for the two per-step fields; `field` says
// which of the three inputs it hangs off. That pair is what the prompt composer
// queries when it builds each labelled image section.

/** Which of the three text inputs an attachment is pinned to. */
export type AttachmentField = "context" | "description" | "acceptance";

export const ATTACHMENT_FIELDS: readonly AttachmentField[] = ["context", "description", "acceptance"];

export interface Attachment {
	id: string;
	workflowId: string;
	/** Null for a conversation-context attachment — that one belongs to the workflow itself. */
	stepId: string | null;
	field: AttachmentField;
	/** Original (sanitised) name, shown in the UI and used to build the on-disk name. */
	filename: string;
	mime: string;
	size: number;
	/** Absolute path of the stored file — this is what reaches the agent's prompt. */
	path: string;
	createdAt: string;
}

function rowToAttachment(row: Record<string, unknown>): Attachment {
	return {
		id: String(row.id),
		workflowId: String(row.workflow_id),
		stepId: row.step_id == null ? null : String(row.step_id),
		field: String(row.field) as AttachmentField,
		filename: String(row.filename),
		mime: String(row.mime),
		size: Number(row.size ?? 0),
		path: String(row.path),
		createdAt: String(row.created_at),
	};
}

export function insertAttachment(input: {
	id: string;
	workflowId: string;
	stepId: string | null;
	field: AttachmentField;
	filename: string;
	mime: string;
	size: number;
	path: string;
}): Attachment {
	const createdAt = new Date().toISOString();
	open()
		.prepare(
			`INSERT INTO attachments (id, workflow_id, step_id, field, filename, mime, size, path, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.workflowId,
			input.stepId,
			input.field,
			input.filename,
			input.mime,
			input.size,
			input.path,
			createdAt,
		);
	return { ...input, createdAt };
}

export function getAttachment(id: string): Attachment | null {
	const row = open().prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
	return row ? rowToAttachment(row) : null;
}

/** Every attachment of a workflow, both its own and its steps', oldest first. */
export function listWorkflowAttachments(workflowId: string): Attachment[] {
	return (
		open()
			.prepare("SELECT * FROM attachments WHERE workflow_id = ? ORDER BY created_at, id")
			.all(workflowId) as Record<string, unknown>[]
	).map(rowToAttachment);
}

/**
 * The attachments of ONE input: pass `stepId: null` for the workflow's
 * conversation context, or a step id for that step's description/acceptance
 * criteria. This is the query the prompt composer uses, so its ordering
 * (oldest first) is the order the paths appear in the agent's prompt.
 */
export function listFieldAttachments(workflowId: string, stepId: string | null, field: AttachmentField): Attachment[] {
	const sql = `SELECT * FROM attachments WHERE workflow_id = ? AND field = ? AND step_id IS ${
		stepId === null ? "NULL" : "?"
	} ORDER BY created_at, id`;
	const statement = open().prepare(sql);
	const rows = (stepId === null ? statement.all(workflowId, field) : statement.all(workflowId, field, stepId)) as Record<
		string,
		unknown
	>[];
	return rows.map(rowToAttachment);
}

export function listStepAttachments(stepId: string): Attachment[] {
	return (
		open().prepare("SELECT * FROM attachments WHERE step_id = ? ORDER BY created_at, id").all(stepId) as Record<
			string,
			unknown
		>[]
	).map(rowToAttachment);
}

export function deleteAttachment(id: string): boolean {
	return open().prepare("DELETE FROM attachments WHERE id = ?").run(id).changes > 0;
}

export function deleteStepAttachments(stepId: string): void {
	open().prepare("DELETE FROM attachments WHERE step_id = ?").run(stepId);
}

export function deleteWorkflowAttachments(workflowId: string): void {
	open().prepare("DELETE FROM attachments WHERE workflow_id = ?").run(workflowId);
}

// ---------------------------------------------------------------------------
// Activity reporting: durable event queue + instance identity.
// The reporter (reporter.ts) owns the semantics; these are the raw persistence
// primitives it and the daemon build on. See docs/report-server.es.html §5–§7.
// ---------------------------------------------------------------------------

/** One queued activity event, as stored (payload still a JSON string). */
export interface ReportEventRow {
	id: string;
	kind: string;
	workflowId: string | null;
	sessionId: string | null;
	/** JSON string — the event's `data` object as written by emit(). */
	payload: string;
	createdAt: string;
	attempts: number;
}

/** What emit() supplies to enqueue one event. */
export interface NewReportEvent {
	kind: string;
	workflowId?: string | null;
	sessionId?: string | null;
	/** Structured, JSON-serialisable payload; stored verbatim. */
	data: unknown;
}

const INSTANCE_ID_SETTING = "report:instance_id";

/**
 * The stable id this instance reports under. An operator-pinned
 * `TARGET_INSTANCE_ID` always wins (and is persisted so it's stable even if the
 * env later disappears); otherwise one is generated once and reused forever.
 */
export function getOrCreateInstanceId(pinned?: string | null): string {
	const db = open();
	if (pinned && pinned.trim().length > 0) {
		const id = pinned.trim();
		db.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		).run(INSTANCE_ID_SETTING, id, new Date().toISOString());
		return id;
	}
	const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(INSTANCE_ID_SETTING) as
		| { value: string }
		| undefined;
	if (row?.value) return row.value;
	const id = crypto.randomUUID();
	db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
		INSTANCE_ID_SETTING,
		id,
		new Date().toISOString(),
	);
	return id;
}

/** Append one event to the outbound queue. Returns its generated id. */
export function enqueueReportEvent(event: NewReportEvent): string {
	const id = crypto.randomUUID();
	open()
		.prepare(
			`INSERT INTO report_events (id, kind, workflow_id, session_id, payload, created_at, attempts)
			 VALUES (?, ?, ?, ?, ?, ?, 0)`,
		)
		.run(
			id,
			event.kind,
			event.workflowId ?? null,
			event.sessionId ?? null,
			JSON.stringify(event.data ?? {}),
			new Date().toISOString(),
		);
	return id;
}

/**
 * Undelivered events that are due (no `next_try_at`, or it's in the past),
 * oldest first, capped at `limit`. This is the flusher's read.
 */
export function pendingReportEvents(limit: number): ReportEventRow[] {
	const rows = open()
		.prepare(
			`SELECT id, kind, workflow_id, session_id, payload, created_at, attempts
			 FROM report_events
			 WHERE delivered_at IS NULL AND (next_try_at IS NULL OR next_try_at <= ?)
			 ORDER BY created_at, id
			 LIMIT ?`,
		)
		.all(new Date().toISOString(), limit) as Record<string, unknown>[];
	return rows.map((r) => ({
		id: String(r.id),
		kind: String(r.kind),
		workflowId: r.workflow_id == null ? null : String(r.workflow_id),
		sessionId: r.session_id == null ? null : String(r.session_id),
		payload: String(r.payload),
		createdAt: String(r.created_at),
		attempts: Number(r.attempts ?? 0),
	}));
}

/** Number of events still waiting to be delivered (for the heartbeat gauge). */
export function pendingReportCount(): number {
	const row = open().prepare("SELECT COUNT(*) AS n FROM report_events WHERE delivered_at IS NULL").get() as {
		n: number;
	};
	return Number(row?.n ?? 0);
}

/** Mark a set of events delivered (idempotent: a re-marked row just updates its timestamp). */
export function markReportEventsDelivered(ids: string[]): void {
	if (ids.length === 0) return;
	const now = new Date().toISOString();
	const db = open();
	const stmt = db.prepare("UPDATE report_events SET delivered_at = ? WHERE id = ?");
	for (const id of ids) stmt.run(now, id);
}

/**
 * A delivery attempt failed: bump the attempt counter and schedule the next try.
 * Applied to a whole batch at once — the transport failed for all of them.
 */
export function markReportEventsRetry(ids: string[], nextTryAt: string): void {
	if (ids.length === 0) return;
	const db = open();
	const stmt = db.prepare("UPDATE report_events SET attempts = attempts + 1, next_try_at = ? WHERE id = ?");
	for (const id of ids) stmt.run(nextTryAt, id);
}

/**
 * Permanently drop events the server rejected as malformed (a 4xx/schema
 * error): retrying an event the ingest will never accept is a poison loop. We
 * delete rather than keep them around forever.
 */
export function dropReportEvents(ids: string[]): void {
	if (ids.length === 0) return;
	const db = open();
	const stmt = db.prepare("DELETE FROM report_events WHERE id = ?");
	for (const id of ids) stmt.run(id);
}

/** Purge delivered events older than the cutoff, so the table can't grow without bound. */
export function purgeDeliveredReportEvents(olderThanIso: string): number {
	return open()
		.prepare("DELETE FROM report_events WHERE delivered_at IS NOT NULL AND delivered_at < ?")
		.run(olderThanIso).changes as number;
}
