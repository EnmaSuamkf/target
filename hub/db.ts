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
export type IsolatedStatus = "running" | "done" | "failed";

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
	/**
	 * One-off "try this step now" run, fully separate from the sequential
	 * engine's status/result/error/sessionId above: it never touches those,
	 * never resumes the workflow's session, and never advances the workflow.
	 * `null` until the step has been run in isolation at least once.
	 */
	isolated: IsolatedRun | null;
}

export interface IsolatedRun {
	status: IsolatedStatus;
	result: string | null;
	error: string | null;
	sessionId: string | null;
	/** Token that authenticates awb's POST to /api/steps/:id/isolated-result. */
	callbackToken: string | null;
	startedAt: string | null;
	finishedAt: string | null;
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
			isolated_status TEXT,
			isolated_result TEXT,
			isolated_error TEXT,
			isolated_session_id TEXT,
			isolated_callback_token TEXT,
			isolated_started_at TEXT,
			isolated_finished_at TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_steps_workflow ON steps(workflow_id, order_index);
	`);
	// `CREATE TABLE IF NOT EXISTS` above is a no-op on a `steps` table that
	// already existed before the isolated_* columns were added (any DB from
	// before this feature) — add them here so upgrades don't need a fresh DB.
	const existingColumns = new Set(
		(db.prepare("PRAGMA table_info(steps)").all() as Record<string, unknown>[]).map((c) => String(c.name)),
	);
	for (const column of [
		"isolated_status",
		"isolated_result",
		"isolated_error",
		"isolated_session_id",
		"isolated_callback_token",
		"isolated_started_at",
		"isolated_finished_at",
	]) {
		if (!existingColumns.has(column)) db.exec(`ALTER TABLE steps ADD COLUMN ${column} TEXT;`);
	}
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
}): Workflow {
	const now = new Date().toISOString();
	const workflow: Workflow = {
		id: input.id,
		name: input.name,
		agentName: input.agentName,
		hookUrl: input.hookUrl,
		secret: input.secret,
		status: "draft",
		lastSessionId: null,
		mdPath: input.mdPath,
		createdAt: now,
		updatedAt: now,
	};
	open()
		.prepare(
			`INSERT INTO workflows (id, name, agent_name, hook_url, secret, status, last_session_id, md_path, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
		isolated:
			row.isolated_status == null
				? null
				: {
						status: row.isolated_status as IsolatedStatus,
						result: row.isolated_result == null ? null : String(row.isolated_result),
						error: row.isolated_error == null ? null : String(row.isolated_error),
						sessionId: row.isolated_session_id == null ? null : String(row.isolated_session_id),
						callbackToken: row.isolated_callback_token == null ? null : String(row.isolated_callback_token),
						startedAt: row.isolated_started_at == null ? null : String(row.isolated_started_at),
						finishedAt: row.isolated_finished_at == null ? null : String(row.isolated_finished_at),
					},
	};
}

export function insertStep(workflowId: string, description: string): Step {
	const database = open();
	const maxRow = database
		.prepare("SELECT COALESCE(MAX(order_index), -1) AS maxIdx FROM steps WHERE workflow_id = ?")
		.get(workflowId) as Record<string, unknown>;
	const orderIndex = Number(maxRow.maxIdx) + 1;
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
		isolated: null,
	};
	database
		.prepare(
			`INSERT INTO steps (id, workflow_id, order_index, description, status, callback_token, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(step.id, step.workflowId, step.orderIndex, step.description, step.status, step.callbackToken, step.createdAt);
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
		.prepare("SELECT * FROM steps WHERE workflow_id = ? AND status = 'pending' ORDER BY order_index LIMIT 1")
		.get(workflowId);
	return row ? rowToStep(row as Record<string, unknown>) : null;
}

export function updateStepDescription(id: string, description: string): void {
	open().prepare("UPDATE steps SET description = ? WHERE id = ?").run(description, id);
}

export function deleteStep(id: string): boolean {
	return open().prepare("DELETE FROM steps WHERE id = ?").run(id).changes > 0;
}

export function markStepRunning(id: string): void {
	open()
		.prepare("UPDATE steps SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'")
		.run(new Date().toISOString(), id);
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
 * Starts a one-off isolated run for a step: generates a fresh callback token,
 * marks it `running`, and clears any prior isolated result/error. No-op if an
 * isolated run is already `running` for this step. Returns the new token, or
 * `null` if the no-op guard fired (the DB is the source of truth for "is one
 * already in flight", so the caller doesn't need to inspect raw SQL results).
 */
export function startIsolatedRun(stepId: string): string | null {
	const token = crypto.randomBytes(24).toString("hex");
	const now = new Date().toISOString();
	const changes = open()
		.prepare(
			`UPDATE steps SET isolated_status = 'running', isolated_result = NULL, isolated_error = NULL,
			 isolated_session_id = NULL, isolated_callback_token = ?, isolated_started_at = ?, isolated_finished_at = NULL
			 WHERE id = ? AND (isolated_status IS NULL OR isolated_status != 'running')`,
		)
		.run(token, now, stepId).changes;
	return changes > 0 ? token : null;
}

/** Records the outcome of an isolated run; only applies while it's still `running` (mirrors completeStep). */
export function completeIsolatedRun(
	stepId: string,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
): void {
	open()
		.prepare(
			`UPDATE steps SET isolated_status = ?, isolated_result = ?, isolated_error = ?, isolated_session_id = ?, isolated_finished_at = ?
			 WHERE id = ? AND isolated_status = 'running'`,
		)
		.run(
			outcome.ok ? "done" : "failed",
			outcome.result ?? null,
			outcome.error ?? null,
			outcome.sessionId ?? null,
			new Date().toISOString(),
			stepId,
		);
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

/** Resets every step of a workflow back to pending, wiping prior results — used by restart. */
export function resetSteps(workflowId: string): void {
	open()
		.prepare(
			`UPDATE steps SET status = 'pending', result = NULL, error = NULL, session_id = NULL,
			 started_at = NULL, finished_at = NULL WHERE workflow_id = ?`,
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
