/**
 * Workflow engine: a workflow is N sequential steps, each dispatched as a job
 * to the ONE awb hook/agent created for that workflow. Steps run one at a
 * time, in order, resuming the same Claude session across steps
 * (see runner.ts). This module owns the state machine (draft → running →
 * paused/completed/failed) and the ~/.target/<name>-<id>.md progress file.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAwbHook, deleteAwbHook, type HookOptions } from "./awb.ts";
import { targetDir, type HubConfig } from "./config.ts";
import {
	beginRetry,
	completeStep,
	deleteStep,
	deleteWorkflow,
	expireStaleSteps,
	finishStepDone,
	getStep,
	getWorkflow,
	insertStep,
	insertWorkflow,
	listSteps,
	markStepJudging,
	nextPendingStep,
	resetSteps,
	setWorkflowSessionId,
	setWorkflowStatus,
	slugify,
	startManualRun,
	stepProgress,
	updateStepConfig,
	updateStepDescription,
	type Step,
	type Workflow,
	type WorkflowStatus,
} from "./db.ts";
import { dispatchStep, type Logger } from "./runner.ts";

export class WorkflowError extends Error {}

/** Fails any step stuck past its timeout and, for a still-`running` workflow that owned one, fails the workflow too — otherwise it would sit stuck forever with no step left to dispatch. */
export function expireStale(cfg: HubConfig, log: Logger): void {
	const affected = expireStaleSteps(cfg.stepTimeoutMs);
	for (const workflowId of affected) {
		const workflow = getWorkflow(workflowId);
		if (workflow?.status === "running") {
			setWorkflowStatus(workflowId, "failed");
			log(`workflow ${workflowId} failed: a step timed out`, "error");
		}
		writeStatusMd(workflowId);
	}
}

function statusMark(status: Step["status"]): string {
	return { pending: " ", running: "~", done: "x", failed: "!" }[status];
}

/** Rewrites the workflow's whole progress file — cheap enough to do on every state change. */
export function writeStatusMd(workflowId: string): void {
	const workflow = getWorkflow(workflowId);
	if (!workflow) return;
	const steps = listSteps(workflowId);
	const progress = stepProgress(workflowId);
	const lines: string[] = [
		`# Workflow: ${workflow.name}`,
		"",
		`- ID: ${workflow.id}`,
		`- Status: ${workflow.status}`,
		`- Progress: ${progress.done}/${progress.total} steps done (${progress.pct}%)${progress.failed ? `, ${progress.failed} failed` : ""}`,
		`- Agent: ${workflow.agentName}`,
		`- Session: ${workflow.lastSessionId ?? "(none yet)"}`,
		`- Last updated: ${new Date().toISOString()}`,
		"",
		"## Steps",
		"",
	];
	if (steps.length === 0) {
		lines.push("_No steps yet._");
	}
	for (const step of steps) {
		const phaseNote = step.status === "running" && step.phase === "judge" ? " _(judging)_" : "";
		lines.push(`${step.orderIndex + 1}. [${statusMark(step.status)}] ${step.description} — **${step.status}**${phaseNote}`);
		if (step.acceptanceCriteria) {
			lines.push(`   - Acceptance criterion: ${step.acceptanceCriteria}`);
			lines.push(`   - Retries: ${step.retryCount}/${step.maxRetries}`);
		}
		if (step.startedAt) lines.push(`   - Started: ${step.startedAt}`);
		if (step.finishedAt) lines.push(`   - Finished: ${step.finishedAt}`);
		if (step.result) lines.push(`   - Result: ${step.result.slice(0, 500)}${step.result.length > 500 ? "…" : ""}`);
		if (step.error) lines.push(`   - Error: ${step.error}`);
		lines.push("");
	}
	fs.mkdirSync(path.dirname(workflow.mdPath), { recursive: true });
	fs.writeFileSync(workflow.mdPath, `${lines.join("\n")}\n`);
}

/**
 * Creates the workflow's dedicated agent: an awb hook with its own sandbox
 * workdir, so its Claude session is isolated per workflow (mirrors
 * agentmesh's "dedicated sandbox" security default). Steps are added
 * afterwards, one at a time, from the Workflow section's "+ step" button.
 */
export function createWorkflow(
	name: string,
	options: { workdir?: string; permissionMode?: HookOptions["permissionMode"] } = {},
): Workflow {
	const trimmed = name.trim();
	if (!trimmed) throw new WorkflowError("name is required");
	const id = crypto.randomUUID();
	const shortId = id.slice(0, 8);
	const slug = slugify(trimmed);
	const agentName = `${slug}-${shortId}`;
	const workdir = options.workdir?.trim() || path.join(targetDir(), "sandboxes", agentName);
	const promptTemplate = `You are the agent of a Target workflow named "${trimmed}". This session is reused in order for every step of the workflow. Current step:\n\n{{payload}}\n\nCarry out the step and respond with the final result of that step.`;
	const hook = createAwbHook(agentName, workdir, promptTemplate, { permissionMode: options.permissionMode });
	const mdPath = path.join(targetDir(), `${slug}-${shortId}.md`);
	const workflow = insertWorkflow({ id, name: trimmed, agentName, hookUrl: hook.hookUrl, secret: hook.secret, mdPath });
	writeStatusMd(workflow.id);
	return workflow;
}

/**
 * Tears down a workflow entirely: its awb hook (so it doesn't linger in
 * hooks.json pointing at a workdir nobody uses anymore), its progress
 * markdown file, and finally its DB rows. db.ts stays a pure storage layer —
 * this orchestration lives here, not there.
 */
export function removeWorkflow(workflowId: string): void {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	deleteAwbHook(workflow.agentName);
	fs.rmSync(workflow.mdPath, { force: true });
	deleteWorkflow(workflowId);
}

export function addStep(
	workflowId: string,
	description: string,
	options: { acceptanceCriteria?: string | null; maxRetries?: number; retryIntervalSeconds?: number } = {},
): Step {
	const trimmed = description.trim();
	if (!trimmed) throw new WorkflowError("description is required");
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	const step = insertStep(workflowId, trimmed, options);
	// A workflow that had already reached a terminal state gets a fresh
	// pending step here — back to draft so the badge/progress stay honest and
	// "Start" dispatches just the new step, instead of leaving it stuck
	// "completed"/"failed" forever (advance() only ever runs while `running`).
	if (workflow.status === "completed" || workflow.status === "failed") setWorkflowStatus(workflowId, "draft");
	writeStatusMd(workflowId);
	return step;
}

export function editStep(
	workflowId: string,
	stepId: string,
	description: string,
	options: { acceptanceCriteria?: string | null; maxRetries?: number; retryIntervalSeconds?: number } = {},
): Step {
	const trimmed = description.trim();
	if (!trimmed) throw new WorkflowError("description is required");
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	if (step.status === "running") throw new WorkflowError("cannot edit a step while its job is running");
	updateStepDescription(stepId, trimmed);
	// Only touch the judge config when the caller actually sent fields — a plain
	// description edit shouldn't silently wipe an existing criterion.
	if (
		options.acceptanceCriteria !== undefined ||
		options.maxRetries !== undefined ||
		options.retryIntervalSeconds !== undefined
	) {
		updateStepConfig(stepId, {
			acceptanceCriteria: options.acceptanceCriteria ?? step.acceptanceCriteria,
			maxRetries: options.maxRetries ?? step.maxRetries,
			retryIntervalSeconds: options.retryIntervalSeconds ?? step.retryIntervalSeconds,
		});
	}
	writeStatusMd(workflowId);
	const updated = getStep(stepId);
	if (!updated) throw new WorkflowError("step disappeared");
	return updated;
}

export function removeStep(workflowId: string, stepId: string): void {
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	if (step.status !== "pending") throw new WorkflowError("only a pending step can be removed");
	deleteStep(stepId);
	reconcileStatus(workflowId);
	writeStatusMd(workflowId);
}

/**
 * Derives a non-`running` workflow's status from the CURRENT state of its
 * steps: every step `done` → `completed`, any step still `failed` → `failed`,
 * anything left to run → back to `draft` so "Start" picks up where it left off.
 * Steps change outside `advance()` (on-demand ▶ runs deliberately don't touch
 * workflow status, and removing a step doesn't either), so this is the one
 * place that reconciles it after the fact instead of duplicating the check at
 * every call site. Nothing here is sticky: re-running a step that had failed
 * until it succeeds clears the workflow's `failed` badge, since only the last
 * attempt of each step counts. Leaves `running` alone (that's `advance()`'s own
 * job) and never downgrades a deliberate `paused` to `draft`.
 */
function reconcileStatus(workflowId: string, log?: Logger): void {
	const workflow = getWorkflow(workflowId);
	if (!workflow || workflow.status === "running") return;
	const progress = stepProgress(workflowId);
	if (progress.total === 0) return;
	const derived: WorkflowStatus =
		progress.failed > 0 ? "failed" : progress.done === progress.total ? "completed" : "draft";
	if (derived === workflow.status) return;
	if (derived === "draft" && workflow.status === "paused") return;
	setWorkflowStatus(workflowId, derived);
	log?.(`workflow ${workflowId} ${derived}`);
}

/**
 * Dispatches the next pending step if the workflow is running and nothing is
 * currently in flight; marks the workflow completed once every step is done.
 * Called after create/start/resume/restart and after every step callback —
 * it's the only place that decides "what runs next", so pause is just
 * refusing to call this until resume.
 */
async function advance(workflowId: string, cfg: HubConfig, log: Logger): Promise<void> {
	const workflow = getWorkflow(workflowId);
	if (!workflow || workflow.status !== "running") return;
	const steps = listSteps(workflowId);
	if (steps.some((s) => s.status === "running")) return; // a step is already in flight
	const next = nextPendingStep(workflowId);
	if (!next) {
		setWorkflowStatus(workflowId, "completed");
		writeStatusMd(workflowId);
		log(`workflow ${workflowId} completed`);
		return;
	}
	await dispatchStep(next, workflow, cfg, log);
	writeStatusMd(workflowId);
}

export async function startWorkflow(workflowId: string, cfg: HubConfig, log: Logger): Promise<Workflow> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (workflow.status === "completed" || workflow.status === "failed") {
		throw new WorkflowError(`workflow is ${workflow.status} — use restart instead`);
	}
	if (workflow.status !== "running") {
		setWorkflowStatus(workflowId, "running");
		writeStatusMd(workflowId);
	}
	await advance(workflowId, cfg, log);
	const updated = getWorkflow(workflowId);
	if (!updated) throw new WorkflowError("workflow disappeared");
	return updated;
}

export function pauseWorkflow(workflowId: string): Workflow {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (workflow.status !== "running") throw new WorkflowError("only a running workflow can be paused");
	setWorkflowStatus(workflowId, "paused");
	writeStatusMd(workflowId);
	const updated = getWorkflow(workflowId);
	if (!updated) throw new WorkflowError("workflow disappeared");
	return updated;
}

export async function resumeWorkflow(workflowId: string, cfg: HubConfig, log: Logger): Promise<Workflow> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (workflow.status !== "paused") throw new WorkflowError("only a paused workflow can be resumed");
	setWorkflowStatus(workflowId, "running");
	writeStatusMd(workflowId);
	await advance(workflowId, cfg, log);
	const updated = getWorkflow(workflowId);
	if (!updated) throw new WorkflowError("workflow disappeared");
	return updated;
}

/** Resets every step to pending and drops session chaining, then starts over from step 1. */
export async function restartWorkflow(workflowId: string, cfg: HubConfig, log: Logger): Promise<Workflow> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (workflow.status === "running") throw new WorkflowError("pause the workflow before restarting it");
	resetSteps(workflowId);
	setWorkflowSessionId(workflowId, null);
	setWorkflowStatus(workflowId, "running");
	writeStatusMd(workflowId);
	log(`workflow ${workflowId} restarted`);
	await advance(workflowId, cfg, log);
	const updated = getWorkflow(workflowId);
	if (!updated) throw new WorkflowError("workflow disappeared");
	return updated;
}

function truncateText(s: string | undefined, n = 200): string {
	const t = String(s ?? "");
	return t.length > n ? `${t.slice(0, n)}…` : t;
}

function wait(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Extracts the judge's verdict from its free-form answer. The prompt asks it to
 * end with a bare `{"ok": bool, "reason": string}`, but now that the judge
 * narrates its verification first, the JSON is the LAST thing rather than the
 * only thing. So we try, in order: the whole text (pure JSON), then each
 * flat `{...}` block scanned from the end (the final one is the verdict), then
 * a greedy `{...}` as a last resort for a nested shape. Also accepts a
 * `{"verdict": "ok"|"fail"}` shape. Returns null when nothing parses — the
 * caller treats that as "can't evaluate" and fails the workflow rather than
 * looping on a guess.
 */
function parseJudgeVerdict(text: string | undefined): { ok: boolean; reason: string } | null {
	if (!text) return null;
	const candidates = [text];
	// Flat (non-nested) objects, last first — the verdict is the closing line.
	const flat = text.match(/\{[^{}]*\}/g);
	if (flat) candidates.push(...flat.reverse());
	const greedy = text.match(/\{[\s\S]*\}/);
	if (greedy) candidates.push(greedy[0]);
	for (const candidate of candidates) {
		try {
			const obj = JSON.parse(candidate) as Record<string, unknown>;
			if (obj && typeof obj === "object") {
				const reason = typeof obj.reason === "string" ? obj.reason : "";
				if (typeof obj.ok === "boolean") return { ok: obj.ok, reason };
				if (typeof obj.verdict === "string") {
					return { ok: /^(ok|pass|passed|true|approv)/i.test(obj.verdict.trim()), reason };
				}
			}
		} catch {
			// try the next candidate
		}
	}
	return null;
}

/** Fails a workflow at a step with a message, keeping the .md and log in sync. Used by every judge-path dead end. */
function failWorkflowAt(stepId: string, workflowId: string, error: string, log: Logger): void {
	completeStep(stepId, { ok: false, error });
	setWorkflowStatus(workflowId, "failed");
	writeStatusMd(workflowId);
	log(`workflow ${workflowId} failed at step ${stepId}: ${error}`, "error");
}

/**
 * Re-reads a step right after dispatching it and, if the dispatch failed
 * synchronously (hook rejected/unreachable → `dispatchStep` already marked the
 * step `failed`), fails the workflow instead of leaving it stuck `running`
 * with nothing in flight.
 */
function failWorkflowIfDispatchDied(stepId: string, workflowId: string, what: string, log: Logger): void {
	const after = getStep(stepId);
	if (after?.status === "failed") {
		setWorkflowStatus(workflowId, "failed");
		log(`workflow ${workflowId} failed: ${what} for step ${stepId} could not be dispatched (${after.error})`, "error");
	}
	writeStatusMd(workflowId);
}

/**
 * Applies a step's job outcome (called from the /api/steps/:id/result
 * callback route). Three shapes of callback land here:
 *
 *  - on-demand ▶ runs (`manualRun`): stay outside the sequential engine for
 *    status (they never touch workflow status beyond a reconcile, and never
 *    advance), but share its one Claude session and are still judged when the
 *    step has acceptance criteria — routed to `onManualRun`.
 *  - the `judge` phase: the payload is a self-evaluation verdict, not a
 *    result — routed to `onJudgeVerdict`.
 *  - the `exec` phase (a normal sequential step's work): on failure the
 *    workflow stops; on success it chains the session and then either runs the
 *    judge (if the step has acceptance criteria) or, with no criteria, behaves
 *    exactly as before — mark done and `advance()` to the next step.
 */
export async function onStepResult(
	stepId: string,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
	cfg: HubConfig,
	log: Logger,
): Promise<void> {
	const step = getStep(stepId);
	if (!step) return;

	// On-demand ▶ run: outside the sequential engine, but still judged if the
	// step carries acceptance criteria.
	if (step.manualRun) {
		await onManualRun(step, outcome, cfg, log);
		return;
	}

	// This callback is the self-evaluation verdict, not the step's result.
	if (step.phase === "judge") {
		await onJudgeVerdict(step, outcome, cfg, log);
		return;
	}

	// --- exec phase: the step's actual work finished ---
	if (!outcome.ok) {
		completeStep(stepId, outcome);
		setWorkflowStatus(step.workflowId, "failed");
		writeStatusMd(step.workflowId);
		log(`workflow ${step.workflowId} failed at step ${stepId}: ${outcome.error}`, "error");
		return;
	}
	// Chain the session now — the judge (and any retry) resumes this same one.
	if (outcome.sessionId) setWorkflowSessionId(step.workflowId, outcome.sessionId);

	// No acceptance criteria → no judge; accept the result as before.
	if (!step.acceptanceCriteria) {
		completeStep(stepId, outcome);
		writeStatusMd(step.workflowId);
		await advance(step.workflowId, cfg, log);
		return;
	}

	// Keep the result, move into the judge phase, and dispatch the self-eval.
	markStepJudging(stepId, { result: outcome.result, sessionId: outcome.sessionId });
	writeStatusMd(step.workflowId);
	const workflow = getWorkflow(step.workflowId);
	const judging = getStep(stepId);
	if (!workflow || !judging) return;
	log(`step ${stepId} done, dispatching judge`);
	await dispatchStep(judging, workflow, cfg, log, { mode: "judge" });
	failWorkflowIfDispatchDied(stepId, step.workflowId, "judge", log);
}

/** Terminal bookkeeping for an on-demand ▶ run: reconcile the workflow badge from the steps and rewrite the .md. A manual run never sets the workflow to running, so this is all it ever does to workflow status. */
function settleManual(workflowId: string, log: Logger): void {
	reconcileStatus(workflowId, log);
	writeStatusMd(workflowId);
}

/**
 * Handles an on-demand ▶ run's callback. It stays out of the sequential engine
 * (never advances, never sets the workflow `running`/`failed` — only a
 * reconcile at the end), but a step WITH acceptance criteria is still judged,
 * and a rejected verdict retries the same step up to its budget — exactly like
 * the engine, on the workflow's one shared session. A step without criteria is
 * recorded as-is.
 */
async function onManualRun(
	step: Step,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
	cfg: HubConfig,
	log: Logger,
): Promise<void> {
	// The callback is this manual run's self-evaluation verdict, not its result.
	if (step.phase === "judge") {
		await onManualJudgeVerdict(step, outcome, cfg, log);
		return;
	}

	// --- exec phase: the manual run's actual work finished ---
	if (!outcome.ok) {
		completeStep(step.id, outcome);
		log(`step ${step.id} (on-demand run) failed (${outcome.error})`);
		settleManual(step.workflowId, log);
		return;
	}
	// Chain the shared session now — the judge (and any retry) resumes this same
	// one, and a later step or ▶ run continues the same conversation.
	if (outcome.sessionId) setWorkflowSessionId(step.workflowId, outcome.sessionId);
	// No acceptance criteria → no judge; record the result as-is (unchanged).
	if (!step.acceptanceCriteria) {
		completeStep(step.id, outcome);
		log(`step ${step.id} (on-demand run) done`);
		settleManual(step.workflowId, log);
		return;
	}
	// Keep the result and judge it, resuming this run's OWN session (markStepJudging
	// stores it, and dispatchStep's judge mode resumes the step's sessionId).
	markStepJudging(step.id, { result: outcome.result, sessionId: outcome.sessionId });
	writeStatusMd(step.workflowId);
	const workflow = getWorkflow(step.workflowId);
	const judging = getStep(step.id);
	if (!workflow || !judging) return;
	log(`step ${step.id} (on-demand run) done, dispatching judge`);
	await dispatchStep(judging, workflow, cfg, log, { mode: "judge" });
	// If the judge dispatch died synchronously it already marked the step failed;
	// otherwise it's `running` in its judge phase and we just refresh the .md.
	if (getStep(step.id)?.status === "failed") settleManual(step.workflowId, log);
	else writeStatusMd(step.workflowId);
}

/**
 * The judge verdict for an on-demand ▶ run: accept (done), or re-run the same
 * step with the judge's feedback until the retry budget is spent, then fail —
 * without ever failing the whole workflow. The judge's session is chained back
 * onto the workflow and the retry resumes it, so the on-demand run stays on the
 * same shared conversation as the rest of the workflow.
 */
async function onManualJudgeVerdict(
	step: Step,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
	cfg: HubConfig,
	log: Logger,
): Promise<void> {
	if (outcome.sessionId) setWorkflowSessionId(step.workflowId, outcome.sessionId);

	// The judge job itself couldn't run — we can't evaluate, so mark it failed.
	if (!outcome.ok) {
		completeStep(step.id, { ok: false, error: `judge run failed: ${outcome.error ?? "unknown"}` });
		log(`step ${step.id} (on-demand run) judge could not run: ${outcome.error ?? "unknown"}`, "error");
		settleManual(step.workflowId, log);
		return;
	}
	const verdict = parseJudgeVerdict(outcome.result);
	if (!verdict) {
		completeStep(step.id, { ok: false, error: `judge verdict unparseable: ${truncateText(outcome.result)}` });
		log(`step ${step.id} (on-demand run) judge verdict unparseable`, "error");
		settleManual(step.workflowId, log);
		return;
	}
	if (verdict.ok) {
		finishStepDone(step.id);
		log(`step ${step.id} (on-demand run) passed the judge`);
		settleManual(step.workflowId, log);
		return;
	}

	// Rejected. Out of retries → fail; otherwise re-run the same manual step.
	if (step.retryCount >= step.maxRetries) {
		completeStep(step.id, {
			ok: false,
			error: `rejected by the judge after ${step.retryCount} retry(ies): ${verdict.reason || "(no reason given)"}`,
		});
		log(`step ${step.id} (on-demand run) failed: rejected by the judge`, "error");
		settleManual(step.workflowId, log);
		return;
	}

	beginRetry(step.id); // status → pending, retry_count++, keeps is_manual_run
	writeStatusMd(step.workflowId);
	log(`step ${step.id} (on-demand run) rejected by judge (retry ${step.retryCount + 1}/${step.maxRetries}): ${verdict.reason}`);
	if (step.retryIntervalSeconds > 0) {
		log(`step ${step.id} waiting ${step.retryIntervalSeconds}s before the retry`);
		await wait(step.retryIntervalSeconds);
	}
	const workflow = getWorkflow(step.workflowId);
	const retried = getStep(step.id);
	if (!workflow || !retried) return;
	// Resume the shared session (now equal to the judge's session we just chained).
	await dispatchStep(retried, workflow, cfg, log, { manual: true, resumeSession: true, retryReason: verdict.reason });
	// A dead dispatch already marked the step failed; otherwise it's running again.
	if (getStep(step.id)?.status === "failed") settleManual(step.workflowId, log);
	else writeStatusMd(step.workflowId);
}

/**
 * Handles the self-evaluation verdict for a step in its `judge` phase: accept
 * and advance, or re-run the same step with the judge's feedback until its
 * retry budget is spent, then fail. The judge's own session is chained so the
 * conversation stays continuous into the next step or the retry.
 */
async function onJudgeVerdict(
	step: Step,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
	cfg: HubConfig,
	log: Logger,
): Promise<void> {
	if (outcome.sessionId) setWorkflowSessionId(step.workflowId, outcome.sessionId);

	// The judge job itself couldn't run — we can't evaluate, so stop.
	if (!outcome.ok) {
		failWorkflowAt(step.id, step.workflowId, `judge run failed: ${outcome.error ?? "unknown"}`, log);
		return;
	}

	const verdict = parseJudgeVerdict(outcome.result);
	if (!verdict) {
		failWorkflowAt(step.id, step.workflowId, `judge verdict unparseable: ${truncateText(outcome.result)}`, log);
		return;
	}

	if (verdict.ok) {
		finishStepDone(step.id);
		writeStatusMd(step.workflowId);
		log(`step ${step.id} passed the judge`);
		await advance(step.workflowId, cfg, log);
		return;
	}

	// Rejected. Out of retries → fail; otherwise re-run the same step with feedback.
	if (step.retryCount >= step.maxRetries) {
		failWorkflowAt(
			step.id,
			step.workflowId,
			`rejected by the judge after ${step.retryCount} retry(ies): ${verdict.reason || "(no reason given)"}`,
			log,
		);
		return;
	}

	beginRetry(step.id);
	writeStatusMd(step.workflowId);
	log(`step ${step.id} rejected by judge (retry ${step.retryCount + 1}/${step.maxRetries}): ${verdict.reason}`);
	// The step is back to `pending` with no `started_at` while we wait, so the
	// stale-step sweep can't time it out mid-interval.
	if (step.retryIntervalSeconds > 0) {
		log(`step ${step.id} waiting ${step.retryIntervalSeconds}s before the retry`);
		await wait(step.retryIntervalSeconds);
	}
	const workflow = getWorkflow(step.workflowId);
	const retried = getStep(step.id);
	if (!workflow || !retried) return;
	await dispatchStep(retried, workflow, cfg, log, { resumeSession: true, retryReason: verdict.reason });
	failWorkflowIfDispatchDied(step.id, step.workflowId, "retry", log);
}

/**
 * Runs a single step's job right now (the ▶ button) instead of waiting for
 * the sequential engine to reach it in order: dispatched to the same
 * agent/hook and resuming the workflow's shared Claude session, so an
 * on-demand run continues the same conversation as the rest of the workflow
 * (its callback persists the session id back onto the workflow, exactly like a
 * sequential step). Blocked while any step of the workflow is already running,
 * sequential or on-demand, since they'd otherwise fight over the same
 * hook/session.
 *
 * If the step has acceptance criteria, its callback is still routed through the
 * judge (see `onManualRun`), retries and all. It stays OUT of the sequential
 * engine for status/ordering (never advances, never sets the workflow
 * running/failed — only a reconcile), but shares the one session.
 */
export async function runStep(workflowId: string, stepId: string, cfg: HubConfig, log: Logger): Promise<void> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	if (listSteps(workflowId).some((s) => s.status === "running")) {
		throw new WorkflowError("a step is already running for this workflow");
	}
	if (!startManualRun(stepId)) throw new WorkflowError("this step is already running");
	writeStatusMd(workflowId);
	await dispatchStep(step, workflow, cfg, log, { manual: true });
	writeStatusMd(workflowId);
}
