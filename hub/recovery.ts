/**
 * The Failure recovery API: what a recovery agent may read and change, and how
 * it proves it is that agent. The engine half (when a recovery starts, how it
 * settles) lives in workflow.ts, "Failure recovery".
 *
 * Authentication: `Authorization: Bearer <recovery token>`. The token is minted
 * when a recovery starts, handed to the agent in its prompt, and stored only as
 * a SHA-256 hash on the recovery row. It is accepted only for the workflow that
 * recovery belongs to and only while that recovery is `running`, so it expires
 * the moment the recovery relaunches, gives up or is aborted. The admin token
 * and the login session are NOT accepted here (these routes sit above the
 * operator gate and check nothing else), and a recovery token is accepted
 * nowhere else.
 *
 * Scope (decision 3): the failed step and any pending step of ITS OWN workflow
 * may be edited; steps may be added; pending steps deleted or moved; notes
 * added. Done steps, other workflows, the conversation context, a step's kind
 * and its pipeline are out of reach. Every change leaves a "Recovery:" step
 * note with before → after and the reason, and is appended to the recovery's
 * `changes` (the `step.recovery` events carry their summary).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type * as http from "node:http";
import { hookRuntime } from "./awb.ts";
import { readConversationPreview } from "./conversations.ts";
import {
	getRecovery,
	getRunningRecovery,
	getStep,
	getWorkflow,
	insertStepNote,
	listStepNotes,
	listSteps,
	type Recovery,
	type Step,
} from "./db.ts";
import { getPipeline, pipelineSpec } from "./pipeline-store.ts";
import { transcriptPath } from "./transcript.ts";
import { addStep, editStep, moveStep, recordRecoveryChange, removeStep, reopenStep, WorkflowError } from "./workflow.ts";
import type { Logger } from "./runner.ts";
import type { PublishableRunner } from "./awb.ts";

/** A refusal of the recovery API, with the HTTP status it answers with. */
export class RecoveryApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message?: string) {
		super(message ?? code);
		this.status = status;
		this.code = code;
	}
}

function hashToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Who is calling: the running recovery of `workflowId` whose token is in the
 * Authorization header. Missing token → 401; any other mismatch (a wrong token,
 * another workflow's, the admin token, one of a recovery that already ended) →
 * 403, with the same answer for all of them.
 */
export function authenticateRecovery(workflowId: string, headers: http.IncomingHttpHeaders): Recovery {
	const header = String(headers.authorization ?? "");
	const token = header.replace(/^Bearer\s+/i, "").trim();
	if (!/^Bearer\s+/i.test(header) || token === "") {
		throw new RecoveryApiError(401, "recovery_token_required", "send the recovery token as 'Authorization: Bearer <token>'");
	}
	const recovery = getRunningRecovery(workflowId);
	if (!recovery || !timingSafeEqualHex(hashToken(token), recovery.tokenHash)) {
		throw new RecoveryApiError(403, "invalid_recovery_token", "this token is not valid for a running recovery of this workflow");
	}
	return recovery;
}

/** Re-reads the recovery; refuses once it is no longer running (it settled mid-request). */
function stillRunning(recovery: Recovery): Recovery {
	const current = getRecovery(recovery.id);
	if (!current || current.status !== "running") throw new RecoveryApiError(403, "invalid_recovery_token", "this recovery has ended");
	return current;
}

function stepOf(recovery: Recovery, stepId: string): Step {
	const step = getStep(stepId);
	if (!step || step.workflowId !== recovery.workflowId) throw new RecoveryApiError(404, "unknown_step");
	if (step.kind === "context") throw new RecoveryApiError(403, "out_of_scope", "the conversation context step is out of a recovery's reach");
	return step;
}

/** The failed step (whatever its status now) and every pending step are a recovery's to edit. */
function editableStep(recovery: Recovery, stepId: string): Step {
	const step = stepOf(recovery, stepId);
	if (step.id === recovery.stepId) return step;
	if (step.status !== "pending") {
		throw new RecoveryApiError(403, "out_of_scope", `step ${step.orderIndex + 1} is ${step.status}: a recovery may change only the failed step and pending steps`);
	}
	return step;
}

function requireReason(body: Record<string, unknown>): string {
	const reason = typeof body.reason === "string" ? body.reason.trim() : "";
	if (reason === "") throw new RecoveryApiError(400, "reason_required", "every change needs a non-empty \"reason\"");
	return reason;
}

const SHOWN_CHARS = 200;

/** A value as a note shows it: strings quoted and clipped, null as (none), objects as JSON. */
export function showValue(value: unknown): string {
	if (value === null || value === undefined || value === "") return "(none)";
	if (typeof value === "string") {
		const flat = value.replace(/\s+/g, " ").trim();
		return `"${flat.length > SHOWN_CHARS ? `${flat.slice(0, SHOWN_CHARS)}…` : flat}"`;
	}
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

/** Writes the "Recovery:" note on a step and records each change line on the recovery. */
function traceChanges(recovery: Recovery, step: Step, lines: string[], reason: string): void {
	if (lines.length === 0) return;
	const content = `${lines.map((l) => `Recovery: ${l}`).join("\n")}\nReason: ${reason}`;
	insertStepNote(step.id, step.workflowId, content, "neutral", "agent");
	for (const line of lines) recordRecoveryChange(recovery.id, `step ${step.orderIndex + 1} ${line}`);
}

// --- read ------------------------------------------------------------------------

const TRANSCRIPT_TURNS = 8;
const TRANSCRIPT_CHARS = 8_000;

/** The tail of the conversation the failed step ran in, when this machine has it. Best-effort. */
function transcriptExcerpt(step: Step, hookUrl: string, lastSessionId: string | null): string | null {
	try {
		const runtime = hookRuntime(hookUrl);
		const sessionId = step.sessionId ?? lastSessionId;
		if (!sessionId || !runtime.workdir) return null;
		const file = sessionId.startsWith("/") ? sessionId : transcriptPath(runtime.workdir, sessionId);
		if (!fs.existsSync(file)) return null;
		const preview = readConversationPreview(
			{
				runner: (runtime.harness ?? "claude") as PublishableRunner,
				sessionId,
				path: file,
				workdir: runtime.workdir,
				title: "",
				updatedAt: "",
				sizeBytes: 0,
			} as Parameters<typeof readConversationPreview>[0],
			TRANSCRIPT_TURNS,
		);
		const text = preview.text;
		return text.length > TRANSCRIPT_CHARS ? `…${text.slice(text.length - TRANSCRIPT_CHARS)}` : text;
	} catch {
		return null;
	}
}

/** The judge's own words, cut out of the hub's "rejected by the judge after N retry(ies): <reason>" error. */
function judgeReason(recovery: Recovery): string | null {
	if (recovery.failureKind !== "judge_rejected") return null;
	const match = /^rejected by the judge after \d+ retry\(ies\): ([\s\S]*)$/.exec(recovery.reason);
	return match ? match[1]! : recovery.reason;
}

function stepView(step: Step, recovery: Recovery): Record<string, unknown> {
	const pipeline = step.pipelineId ? getPipeline(step.pipelineId) : null;
	const spec = pipeline ? pipelineSpec(pipeline) : null;
	return {
		id: step.id,
		number: step.orderIndex + 1,
		kind: step.kind,
		status: step.status,
		isFailedStep: step.id === recovery.stepId,
		editable: step.id === recovery.stepId || step.status === "pending",
		description: step.description,
		acceptanceCriteria: step.acceptanceCriteria,
		result: step.result,
		error: step.error,
		maxRetries: step.maxRetries,
		retryIntervalSeconds: step.retryIntervalSeconds,
		retryCount: step.retryCount,
		useSubagent: step.useSubagent,
		manualReview: step.manualReview,
		recoverOnFailure: step.recoverOnFailure,
		maxRecoveries: step.maxRecoveries,
		recoveryCount: step.recoveryCount,
		...(step.kind === "command"
			? {
					pipelineId: step.pipelineId,
					pipelineName: pipeline?.name ?? null,
					pipelineDeclaredInputs: spec
						? Object.fromEntries(
								Object.entries(spec.inputs).map(([name, i]) => [name, { description: i.description, required: i.required, default: i.default }]),
							)
						: null,
					pipelineInputs: step.pipelineInputs,
					onSuccessTask: step.onSuccessTask,
					onFailureTask: step.onFailureTask,
				}
			: {}),
		notes: listStepNotes(step.id).map((n) => ({ content: n.content, source: n.source, createdAt: n.createdAt })),
	};
}

/** GET /api/recovery/:workflowId */
export function recoveryView(recovery: Recovery): Record<string, unknown> {
	const workflow = getWorkflow(recovery.workflowId);
	if (!workflow) throw new RecoveryApiError(404, "unknown_workflow");
	const steps = listSteps(workflow.id);
	const failed = steps.find((s) => s.id === recovery.stepId) ?? null;
	return {
		ok: true,
		recovery: {
			id: recovery.id,
			stepId: recovery.stepId,
			failureKind: recovery.failureKind,
			reason: recovery.reason,
			startedAt: recovery.startedAt,
			changes: recovery.changes,
		},
		workflow: {
			id: workflow.id,
			name: workflow.name,
			status: workflow.status,
			conversationContext: workflow.conversationContext,
			recoveryModel: workflow.recoveryModel,
		},
		failedStep: failed
			? {
					id: failed.id,
					number: failed.orderIndex + 1,
					status: failed.status,
					result: failed.result,
					error: failed.error ?? recovery.reason,
					judgeReason: judgeReason(recovery),
					notes: listStepNotes(failed.id).map((n) => ({ content: n.content, source: n.source, createdAt: n.createdAt })),
					transcriptExcerpt: transcriptExcerpt(failed, workflow.hookUrl, workflow.lastSessionId),
				}
			: null,
		steps: steps.filter((s) => s.kind !== "context").map((s) => stepView(s, recovery)),
	};
}

// --- edits -------------------------------------------------------------------------

/** The fields a recovery may set on a step, each with its type check. */
const EDITABLE_FIELDS = [
	"description",
	"acceptanceCriteria",
	"maxRetries",
	"retryIntervalSeconds",
	"useSubagent",
	"manualReview",
	"recoverOnFailure",
	"maxRecoveries",
	"pipelineInputs",
	"onSuccessTask",
	"onFailureTask",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

const COMMAND_ONLY: readonly EditableField[] = ["pipelineInputs", "onSuccessTask", "onFailureTask"];

interface StepFields {
	description?: string;
	acceptanceCriteria?: string | null;
	maxRetries?: number;
	retryIntervalSeconds?: number;
	useSubagent?: boolean;
	manualReview?: boolean;
	recoverOnFailure?: boolean;
	maxRecoveries?: number;
	pipelineInputs?: Record<string, string>;
	onSuccessTask?: string | null;
	onFailureTask?: string | null;
}

function badField(field: string, expected: string): never {
	throw new RecoveryApiError(400, "invalid_field", `${field} must be ${expected}`);
}

/** Reads the step fields of a body, strictly: unknown keys and wrong types are 400s. */
function readFields(body: Record<string, unknown>, allowed: readonly string[]): StepFields {
	const out: StepFields = {};
	for (const key of Object.keys(body)) {
		if (!allowed.includes(key)) throw new RecoveryApiError(400, "field_not_allowed", `a recovery cannot set "${key}"`);
	}
	const has = (k: string) => k in body && body[k] !== undefined;
	if (has("description")) {
		if (typeof body.description !== "string" || body.description.trim() === "") badField("description", "a non-empty string");
		out.description = body.description;
	}
	if (has("acceptanceCriteria")) {
		if (body.acceptanceCriteria !== null && typeof body.acceptanceCriteria !== "string") badField("acceptanceCriteria", "a string or null");
		out.acceptanceCriteria = body.acceptanceCriteria as string | null;
	}
	for (const key of ["maxRetries", "retryIntervalSeconds", "maxRecoveries"] as const) {
		if (!has(key)) continue;
		const value = body[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 0) badField(key, "an integer ≥ 0");
		out[key] = value;
	}
	for (const key of ["useSubagent", "manualReview", "recoverOnFailure"] as const) {
		if (!has(key)) continue;
		if (typeof body[key] !== "boolean") badField(key, "a boolean");
		out[key] = body[key] as boolean;
	}
	if (has("pipelineInputs")) {
		const value = body.pipelineInputs;
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Object.values(value as Record<string, unknown>).some((v) => typeof v !== "string")
		) {
			badField("pipelineInputs", "an object whose values are strings");
		}
		out.pipelineInputs = { ...(value as Record<string, string>) };
	}
	for (const key of ["onSuccessTask", "onFailureTask"] as const) {
		if (!has(key)) continue;
		const value = body[key];
		if (value !== null && typeof value !== "string") badField(key, "a string or null");
		out[key] = typeof value === "string" && value.trim() !== "" ? value : null;
	}
	return out;
}

function fieldValue(step: Step, field: EditableField): unknown {
	return (step as unknown as Record<string, unknown>)[field] ?? null;
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** "field: before → after" for every field whose stored value changed. */
function diffLines(before: Step, after: Step): string[] {
	const lines: string[] = [];
	for (const field of EDITABLE_FIELDS) {
		const a = fieldValue(before, field);
		const b = fieldValue(after, field);
		if (!sameValue(a, b)) lines.push(`${field}: ${showValue(a)} → ${showValue(b)}`);
	}
	return lines;
}

/** Turns an engine refusal into a 400 the agent can read. */
function engine<T>(fn: () => T): T {
	try {
		return fn();
	} catch (err) {
		if (err instanceof WorkflowError) throw new RecoveryApiError(400, "refused", err.message);
		throw err;
	}
}

/** PATCH /api/recovery/:workflowId/steps/:stepId */
export function recoveryEditStep(recovery: Recovery, stepId: string, body: Record<string, unknown>): Record<string, unknown> {
	const live = stillRunning(recovery);
	const reason = requireReason(body);
	const { reason: _ignored, ...rest } = body;
	const before = editableStep(live, stepId);
	const fields = readFields(rest, EDITABLE_FIELDS);
	if (before.kind !== "command" && COMMAND_ONLY.some((f) => f in fields)) {
		throw new RecoveryApiError(400, "field_not_allowed", "pipelineInputs, onSuccessTask and onFailureTask belong to command steps");
	}
	if (Object.keys(fields).length === 0) throw new RecoveryApiError(400, "nothing_to_change", "send at least one field to change");
	engine(() =>
		editStep(live.workflowId, stepId, fields.description ?? before.description, {
			// editStep reads a null criterion as "unchanged"; an empty one clears it.
			...(fields.acceptanceCriteria !== undefined ? { acceptanceCriteria: fields.acceptanceCriteria ?? "" } : {}),
			...(fields.maxRetries !== undefined ? { maxRetries: fields.maxRetries } : {}),
			...(fields.retryIntervalSeconds !== undefined ? { retryIntervalSeconds: fields.retryIntervalSeconds } : {}),
			...(fields.useSubagent !== undefined ? { useSubagent: fields.useSubagent } : {}),
			...(fields.manualReview !== undefined ? { manualReview: fields.manualReview } : {}),
			...(fields.recoverOnFailure !== undefined ? { recoverOnFailure: fields.recoverOnFailure } : {}),
			...(fields.maxRecoveries !== undefined ? { maxRecoveries: fields.maxRecoveries } : {}),
			...(fields.pipelineInputs !== undefined ? { pipelineInputs: fields.pipelineInputs } : {}),
			...(fields.onSuccessTask !== undefined ? { onSuccessTask: fields.onSuccessTask } : {}),
			...(fields.onFailureTask !== undefined ? { onFailureTask: fields.onFailureTask } : {}),
			actor: "recovery",
		}),
	);
	const after = getStep(stepId) ?? before;
	const changes = diffLines(before, after);
	traceChanges(live, after, changes, reason);
	return { ok: true, step: stepView(after, live), changes };
}

/** POST /api/recovery/:workflowId/steps */
export function recoveryAddStep(recovery: Recovery, body: Record<string, unknown>): Record<string, unknown> {
	const live = stillRunning(recovery);
	const reason = requireReason(body);
	const { reason: _r, afterStepId: rawAfter, kind: rawKind, pipelineId: rawPipeline, ...rest } = body;
	const kind = rawKind === undefined ? "task" : rawKind;
	if (kind !== "task" && kind !== "command") throw new RecoveryApiError(400, "invalid_field", 'kind must be "task" or "command"');
	const afterStepId = typeof rawAfter === "string" && rawAfter !== "" ? rawAfter : null;
	if (afterStepId) stepOf(live, afterStepId);
	const fields = readFields(rest, EDITABLE_FIELDS);
	if (kind === "task" && COMMAND_ONLY.some((f) => f in fields)) {
		throw new RecoveryApiError(400, "field_not_allowed", "pipelineInputs, onSuccessTask and onFailureTask belong to command steps");
	}
	if (kind === "task" && !fields.description) throw new RecoveryApiError(400, "invalid_field", "description must be a non-empty string");
	const pipelineId = typeof rawPipeline === "string" && rawPipeline !== "" ? rawPipeline : null;
	const step = engine(() =>
		addStep(live.workflowId, fields.description ?? "", {
			kind,
			...(kind === "command" ? { pipelineId, pipelineInputs: fields.pipelineInputs ?? {} } : {}),
			acceptanceCriteria: fields.acceptanceCriteria ?? null,
			...(fields.maxRetries !== undefined ? { maxRetries: fields.maxRetries } : {}),
			...(fields.retryIntervalSeconds !== undefined ? { retryIntervalSeconds: fields.retryIntervalSeconds } : {}),
			...(fields.useSubagent !== undefined ? { useSubagent: fields.useSubagent } : {}),
			...(fields.manualReview !== undefined ? { manualReview: fields.manualReview } : {}),
			...(fields.recoverOnFailure !== undefined ? { recoverOnFailure: fields.recoverOnFailure } : {}),
			...(fields.maxRecoveries !== undefined ? { maxRecoveries: fields.maxRecoveries } : {}),
			...(fields.onSuccessTask !== undefined ? { onSuccessTask: fields.onSuccessTask } : {}),
			...(fields.onFailureTask !== undefined ? { onFailureTask: fields.onFailureTask } : {}),
			afterStepId,
			actor: "recovery",
		}),
	);
	const line = `added step ${step.orderIndex + 1}: (none) → ${showValue(step.description)}`;
	insertStepNote(step.id, step.workflowId, `Recovery: ${line}\nReason: ${reason}`, "neutral", "agent");
	recordRecoveryChange(live.id, line);
	return { ok: true, step: stepView(getStep(step.id) ?? step, live), changes: [line] };
}

/** DELETE /api/recovery/:workflowId/steps/:stepId */
export function recoveryDeleteStep(recovery: Recovery, stepId: string, body: Record<string, unknown>): Record<string, unknown> {
	const live = stillRunning(recovery);
	const reason = requireReason(body);
	const step = stepOf(live, stepId);
	if (step.id === live.stepId) throw new RecoveryApiError(403, "out_of_scope", "the failed step cannot be deleted: edit it instead");
	if (step.status !== "pending") throw new RecoveryApiError(403, "out_of_scope", "only a pending step can be deleted");
	engine(() => removeStep(live.workflowId, stepId, { actor: "recovery" }));
	const line = `deleted step ${step.orderIndex + 1}: ${showValue(step.description)} → (none)`;
	// The deleted step's own notes go with it, so the trace lives on the failed step.
	if (getStep(live.stepId)) insertStepNote(live.stepId, live.workflowId, `Recovery: ${line}\nReason: ${reason}`, "neutral", "agent");
	recordRecoveryChange(live.id, line);
	return { ok: true, deletedStepId: stepId, changes: [line] };
}

/** POST /api/recovery/:workflowId/steps/:stepId/move */
export function recoveryMoveStep(recovery: Recovery, stepId: string, body: Record<string, unknown>): Record<string, unknown> {
	const live = stillRunning(recovery);
	const reason = requireReason(body);
	const direction = body.direction;
	if (direction !== "up" && direction !== "down") throw new RecoveryApiError(400, "invalid_field", 'direction must be "up" or "down"');
	const step = stepOf(live, stepId);
	if (step.status !== "pending") throw new RecoveryApiError(403, "out_of_scope", "only a pending step can be moved");
	const moved = engine(() => moveStep(live.workflowId, stepId, direction, { actor: "recovery" }));
	const line = `position: ${step.orderIndex + 1} → ${moved.orderIndex + 1}`;
	traceChanges(live, moved, [line], reason);
	return { ok: true, step: stepView(moved, live), changes: [`step ${moved.orderIndex + 1} ${line}`] };
}

/** POST /api/recovery/:workflowId/steps/:stepId/notes */
export function recoveryAddNote(recovery: Recovery, stepId: string, body: Record<string, unknown>): Record<string, unknown> {
	const live = stillRunning(recovery);
	const content = typeof body.content === "string" ? body.content.trim() : "";
	if (content === "") throw new RecoveryApiError(400, "invalid_field", "content must be a non-empty string");
	const step = stepOf(live, stepId);
	const note = insertStepNote(step.id, step.workflowId, `Recovery note: ${content}`, "neutral", "agent");
	return { ok: true, note: { id: note.id, content: note.content } };
}

/** POST /api/recovery/:workflowId/steps/:stepId/reopen */
export function recoveryReopenStep(recovery: Recovery, stepId: string, body: Record<string, unknown>, log: Logger): Record<string, unknown> {
	const live = stillRunning(recovery);
	const reason = requireReason(body);
	const step = stepOf(live, stepId);
	if (step.id !== live.stepId) throw new RecoveryApiError(403, "out_of_scope", "a recovery may reopen only the step that failed");
	if (step.status !== "failed") throw new RecoveryApiError(400, "refused", `the step is ${step.status}, not failed`);
	const reopened = engine(() => reopenStep(live.workflowId, stepId, log, { actor: "recovery" }));
	const lines = [`status: failed → pending`, `retryCount: ${step.retryCount} → 0`];
	traceChanges(live, reopened, lines, reason);
	return { ok: true, step: stepView(reopened, live), changes: lines };
}
