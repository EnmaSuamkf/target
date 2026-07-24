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

export type WorkflowStatus = "draft" | "running" | "paused" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "done" | "failed";
/**
 * Which job a `running` step is currently waiting on: its own execution
 * (`exec`) or the self-evaluation that runs afterwards (`judge`). Both come
 * back through the same result callback, so the phase is what tells
 * `onStepResult` how to interpret the payload. Meaningless while not running.
 */
export type StepPhase = "exec" | "judge";

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
	/** Claude session this step's run produced, reported by awb's callback. */
	sessionId: string | null;
	/** Per-step token that authenticates awb's POST to /api/steps/:id/result. */
	callbackToken: string;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	/** Whether the current/last run was triggered on demand (the ▶ button) rather than by the sequential engine. */
	manualRun: boolean;
	/**
	 * Acceptance criteria the agent self-evaluates its result against after
	 * running this step. Empty/null means no judge — the step is accepted as
	 * soon as it runs, exactly like before this feature existed.
	 */
	acceptanceCriteria: string | null;
	/** How many times the judge may reject this step and re-run it before the workflow is failed. 0 = no retries (one shot, then fail if rejected). */
	maxRetries: number;
	/** Seconds to wait before each re-run after a judge reject. 0 = retry immediately. */
	retryIntervalSeconds: number;
	/** Retries already consumed on the current attempt cycle; reset by restart. */
	retryCount: number;
	/** Which job the step's in-flight callback belongs to (see StepPhase). */
	phase: StepPhase;
	/**
	 * Whether this step is part of the current run selection. The sequential
	 * engine only ever dispatches selected steps, so Start/Resume/Restart run
	 * exactly the chosen subset. New steps default to selected (so workflows
	 * that never use this feature keep running everything), but an explicit
	 * empty selection via `setStepSelection` marks every step unselected —
	 * "select nothing" means nothing runs, not "run everything".
	 */
	selected: boolean;
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

function open(): DatabaseSync {
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
			md_path TEXT NOT NULL,
			conversation_context TEXT,
			context_injected INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS steps (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			order_index INTEGER NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			error TEXT,
			session_id TEXT,
			callback_token TEXT NOT NULL,
			created_at TEXT NOT NULL,
			started_at TEXT,
			finished_at TEXT,
			is_manual_run INTEGER NOT NULL DEFAULT 0,
			acceptance_criteria TEXT,
			max_retries INTEGER NOT NULL DEFAULT 0,
			retry_interval_seconds INTEGER NOT NULL DEFAULT 0,
			retry_count INTEGER NOT NULL DEFAULT 0,
			phase TEXT NOT NULL DEFAULT 'exec',
			selected INTEGER NOT NULL DEFAULT 1
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
	addColumn("acceptance_criteria", "acceptance_criteria TEXT");
	addColumn("max_retries", "max_retries INTEGER NOT NULL DEFAULT 0");
	addColumn("retry_interval_seconds", "retry_interval_seconds INTEGER NOT NULL DEFAULT 0");
	addColumn("retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
	addColumn("phase", "phase TEXT NOT NULL DEFAULT 'exec'");
	addColumn("selected", "selected INTEGER NOT NULL DEFAULT 1");
	// Same upgrade safety for the `workflows` table: `conversation_context` and
	// `context_injected` were added after launch, so an older DB won't have them.
	const existingWorkflowColumns = new Set(
		(database.prepare("PRAGMA table_info(workflows)").all() as Record<string, unknown>[]).map((c) => String(c.name)),
	);
	const addWorkflowColumn = (name: string, ddl: string) => {
		if (!existingWorkflowColumns.has(name)) database.exec(`ALTER TABLE workflows ADD COLUMN ${ddl};`);
	};
	addWorkflowColumn("conversation_context", "conversation_context TEXT");
	addWorkflowColumn("context_injected", "context_injected INTEGER NOT NULL DEFAULT 0");
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
		mdPath: String(row.md_path),
		conversationContext: row.conversation_context == null ? null : String(row.conversation_context),
		contextInjected: Number(row.context_injected ?? 0) === 1,
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
}): Workflow {
	const now = new Date().toISOString();
	const conversationContext = input.conversationContext?.trim() || null;
	const workflow: Workflow = {
		id: input.id,
		name: input.name,
		agentName: input.agentName,
		hookUrl: input.hookUrl,
		secret: input.secret,
		status: "draft",
		lastSessionId: null,
		mdPath: input.mdPath,
		conversationContext,
		contextInjected: false,
		createdAt: now,
		updatedAt: now,
	};
	open()
		.prepare(
			`INSERT INTO workflows (id, name, agent_name, hook_url, secret, status, last_session_id, md_path, conversation_context, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			workflow.id,
			workflow.name,
			workflow.agentName,
			workflow.hookUrl,
			workflow.secret,
			workflow.status,
			workflow.lastSessionId,
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
	const rows = open().prepare("SELECT * FROM workflows ORDER BY created_at DESC").all();
	return (rows as Record<string, unknown>[]).map(rowToWorkflow);
}

export function setWorkflowStatus(id: string, status: WorkflowStatus): void {
	open()
		.prepare("UPDATE workflows SET status = ?, updated_at = ? WHERE id = ?")
		.run(status, new Date().toISOString(), id);
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
		orderIndex: Number(row.order_index),
		description: String(row.description),
		status: row.status as StepStatus,
		result: row.result == null ? null : String(row.result),
		error: row.error == null ? null : String(row.error),
		sessionId: row.session_id == null ? null : String(row.session_id),
		callbackToken: String(row.callback_token),
		createdAt: String(row.created_at),
		startedAt: row.started_at == null ? null : String(row.started_at),
		finishedAt: row.finished_at == null ? null : String(row.finished_at),
		manualRun: Number(row.is_manual_run ?? 0) === 1,
		acceptanceCriteria: row.acceptance_criteria == null ? null : String(row.acceptance_criteria),
		maxRetries: Number(row.max_retries ?? 0),
		retryIntervalSeconds: Number(row.retry_interval_seconds ?? 0),
		retryCount: Number(row.retry_count ?? 0),
		phase: (row.phase as StepPhase) ?? "exec",
		selected: Number(row.selected ?? 1) === 1,
	};
}

export function insertStep(
	workflowId: string,
	description: string,
	options: { acceptanceCriteria?: string | null; maxRetries?: number; retryIntervalSeconds?: number } = {},
): Step {
	const database = open();
	const maxRow = database
		.prepare("SELECT COALESCE(MAX(order_index), -1) AS maxIdx FROM steps WHERE workflow_id = ?")
		.get(workflowId) as Record<string, unknown>;
	const orderIndex = Number(maxRow.maxIdx) + 1;
	const acceptanceCriteria = options.acceptanceCriteria?.trim() || null;
	const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 0));
	const retryIntervalSeconds = Math.max(0, Math.floor(options.retryIntervalSeconds ?? 0));
	const step: Step = {
		id: crypto.randomUUID(),
		workflowId,
		orderIndex,
		description,
		status: "pending",
		result: null,
		error: null,
		sessionId: null,
		callbackToken: crypto.randomBytes(24).toString("hex"),
		createdAt: new Date().toISOString(),
		startedAt: null,
		finishedAt: null,
		manualRun: false,
		acceptanceCriteria,
		maxRetries,
		retryIntervalSeconds,
		retryCount: 0,
		phase: "exec",
		selected: true,
	};
	database
		.prepare(
			`INSERT INTO steps (id, workflow_id, order_index, description, status, callback_token, created_at, acceptance_criteria, max_retries, retry_interval_seconds)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			step.id,
			step.workflowId,
			step.orderIndex,
			step.description,
			step.status,
			step.callbackToken,
			step.createdAt,
			step.acceptanceCriteria,
			step.maxRetries,
			step.retryIntervalSeconds,
		);
	return step;
}

export function getStep(id: string): Step | null {
	const row = open().prepare("SELECT * FROM steps WHERE id = ?").get(id);
	return row ? rowToStep(row as Record<string, unknown>) : null;
}

export function listSteps(workflowId: string): Step[] {
	const rows = open()
		.prepare("SELECT * FROM steps WHERE workflow_id = ? ORDER BY order_index")
		.all(workflowId);
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

/** Updates a step's judge config (acceptance criteria + retry budget + retry wait). Editing a step is the only place these change after creation. */
export function updateStepConfig(
	id: string,
	config: { acceptanceCriteria: string | null; maxRetries: number; retryIntervalSeconds: number },
): void {
	open()
		.prepare("UPDATE steps SET acceptance_criteria = ?, max_retries = ?, retry_interval_seconds = ? WHERE id = ?")
		.run(
			config.acceptanceCriteria?.trim() || null,
			Math.max(0, Math.floor(config.maxRetries)),
			Math.max(0, Math.floor(config.retryIntervalSeconds)),
			id,
		);
}

export function deleteStep(id: string): boolean {
	return open().prepare("DELETE FROM steps WHERE id = ?").run(id).changes > 0;
}

export function markStepRunning(id: string, manual = false): void {
	// `manual` is set on a re-dispatch of an on-demand ▶ run's retry: it comes
	// through here as a `pending` step (beginRetry put it there) and must stay
	// flagged manual, or its next callback would be mistaken for a sequential
	// run. A normal engine dispatch passes false and clears the flag.
	open()
		.prepare(
			"UPDATE steps SET status = 'running', started_at = ?, is_manual_run = ?, phase = 'exec' WHERE id = ? AND status = 'pending'",
		)
		.run(new Date().toISOString(), manual ? 1 : 0, id);
}

/**
 * Records an exec run's successful result but keeps the step `running` and
 * flips it into the `judge` phase — the self-evaluation job is about to be
 * dispatched, and its verdict (not this result) decides whether the step is
 * finally `done`. `started_at` is reset so the stale-step timeout is measured
 * against the judge run now in flight, not the exec run that already answered.
 */
export function markStepJudging(id: string, outcome: { result?: string; sessionId?: string }): void {
	open()
		.prepare(
			`UPDATE steps SET result = ?, session_id = ?, phase = 'judge', started_at = ?, error = NULL
			 WHERE id = ? AND status = 'running'`,
		)
		.run(outcome.result ?? null, outcome.sessionId ?? null, new Date().toISOString(), id);
}

/** Marks a judge-accepted step `done`, preserving the exec result already stored by `markStepJudging`. */
export function finishStepDone(id: string): void {
	open()
		.prepare("UPDATE steps SET status = 'done', finished_at = ? WHERE id = ? AND status = 'running'")
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
			 result = NULL, error = NULL, session_id = NULL, started_at = NULL, finished_at = NULL
			 WHERE id = ?`,
		)
		.run(id);
}

export function completeStep(
	id: string,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
): void {
	open()
		.prepare(
			`UPDATE steps SET status = ?, result = ?, error = ?, session_id = ?, finished_at = ?
			 WHERE id = ? AND status IN ('pending', 'running')`,
		)
		.run(
			outcome.ok ? "done" : "failed",
			outcome.result ?? null,
			outcome.error ?? null,
			outcome.sessionId ?? null,
			new Date().toISOString(),
			id,
		);
}

/**
 * Starts an on-demand run (the ▶ button): marks the step `running` right
 * now regardless of its position in the queue or its previous outcome
 * (pending/done/failed all qualify — this doubles as "rerun this step"),
 * clearing any prior result/error. No-op (returns false) if it's already
 * `running`, so the caller doesn't double-dispatch it.
 */
export function startManualRun(stepId: string): boolean {
	const now = new Date().toISOString();
	const changes = open()
		.prepare(
			`UPDATE steps SET status = 'running', result = NULL, error = NULL, session_id = NULL,
			 started_at = ?, finished_at = NULL, is_manual_run = 1, phase = 'exec', retry_count = 0
			 WHERE id = ? AND status != 'running'`,
		)
		.run(now, stepId).changes;
	return changes > 0;
}

/** Fails any step stuck `running` past the timeout; returns the distinct workflow ids affected, so the caller can fail the workflow too instead of leaving it stuck. */
export function expireStaleSteps(timeoutMs: number): string[] {
	const cutoff = new Date(Date.now() - timeoutMs).toISOString();
	const rows = open()
		.prepare(`SELECT DISTINCT workflow_id FROM steps WHERE status = 'running' AND started_at < ?`)
		.all(cutoff) as Record<string, unknown>[];
	open()
		.prepare(
			`UPDATE steps SET status = 'failed', error = 'timeout', finished_at = ?
			 WHERE status = 'running' AND started_at < ?`,
		)
		.run(new Date().toISOString(), cutoff);
	return rows.map((r) => String(r.workflow_id));
}

/**
 * Records which steps a run should dispatch. An empty selection means "run
 * nothing" — every step is flagged UNSELECTED, so the sequential engine
 * (`nextPendingStep` only returns a selected step) dispatches nothing at all.
 * Otherwise only the listed steps are selected and the rest are skipped. Ids
 * that don't belong to the workflow are ignored.
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
			`UPDATE steps SET selected = CASE WHEN id IN (${placeholders}) THEN 1 ELSE 0 END WHERE workflow_id = ?`,
		)
		.run(...stepIds, workflowId);
}

/**
 * Resets the workflow's *selected* steps back to pending, wiping prior results
 * — used by restart. Only selected steps are touched, so restarting with a
 * subset chosen leaves the unselected steps' results intact and re-runs just
 * the chosen ones. With nothing selected (see `setStepSelection`), no step is
 * selected, so this resets nothing at all.
 */
export function resetSteps(workflowId: string): void {
	open()
		.prepare(
			`UPDATE steps SET status = 'pending', result = NULL, error = NULL, session_id = NULL,
			 started_at = NULL, finished_at = NULL, is_manual_run = 0, phase = 'exec', retry_count = 0
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

export function stepProgress(workflowId: string): Progress {
	const row = open()
		.prepare(
			`SELECT COUNT(*) AS total,
			        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
			        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
			 FROM steps WHERE workflow_id = ?`,
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
			const maxRetries = Math.max(0, Math.floor(Number(obj.maxRetries ?? 0)) || 0);
			const retryIntervalSeconds = Math.max(0, Math.floor(Number(obj.retryIntervalSeconds ?? 0)) || 0);
			return { description, acceptanceCriteria, maxRetries, retryIntervalSeconds };
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
	const rows = open().prepare("SELECT * FROM templates ORDER BY created_at DESC").all();
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
