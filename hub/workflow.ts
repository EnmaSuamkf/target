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
	completeIsolatedRun,
	completeStep,
	deleteStep,
	deleteWorkflow,
	expireStaleSteps,
	getStep,
	getWorkflow,
	insertStep,
	insertWorkflow,
	listSteps,
	nextPendingStep,
	resetSteps,
	setWorkflowSessionId,
	setWorkflowStatus,
	slugify,
	startIsolatedRun,
	stepProgress,
	updateStepDescription,
	type Step,
	type Workflow,
} from "./db.ts";
import { dispatchStep, dispatchStepIsolated, type Logger } from "./runner.ts";

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
		lines.push(`${step.orderIndex + 1}. [${statusMark(step.status)}] ${step.description} — **${step.status}**`);
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
	const promptTemplate = `Sos el agente de un workflow de Target llamado "${trimmed}". Esta sesión se reutiliza en orden para cada step del workflow. Step actual:\n\n{{payload}}\n\nRealizá el step y respondé con el resultado final de ese step.`;
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

export function addStep(workflowId: string, description: string): Step {
	const trimmed = description.trim();
	if (!trimmed) throw new WorkflowError("description is required");
	if (!getWorkflow(workflowId)) throw new WorkflowError("unknown workflow");
	const step = insertStep(workflowId, trimmed);
	writeStatusMd(workflowId);
	return step;
}

export function editStep(workflowId: string, stepId: string, description: string): Step {
	const trimmed = description.trim();
	if (!trimmed) throw new WorkflowError("description is required");
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	if (step.status === "running") throw new WorkflowError("cannot edit a step while its job is running");
	updateStepDescription(stepId, trimmed);
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
	writeStatusMd(workflowId);
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

/**
 * Applies a step's job outcome (called from the /api/steps/:id/result
 * callback route) and, if the workflow is still running, dispatches the next
 * step. A failed step stops the workflow (`status: failed`) instead of
 * silently skipping ahead.
 */
export async function onStepResult(
	stepId: string,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
	cfg: HubConfig,
	log: Logger,
): Promise<void> {
	const step = getStep(stepId);
	if (!step) return;
	completeStep(stepId, outcome);
	if (outcome.ok && outcome.sessionId) setWorkflowSessionId(step.workflowId, outcome.sessionId);
	writeStatusMd(step.workflowId);
	if (!outcome.ok) {
		setWorkflowStatus(step.workflowId, "failed");
		writeStatusMd(step.workflowId);
		log(`workflow ${step.workflowId} failed at step ${stepId}: ${outcome.error}`, "error");
		return;
	}
	await advance(step.workflowId, cfg, log);
}

/**
 * Runs a single step's job in isolation — a fresh Claude session, dispatched
 * to the same agent/hook, but completely outside the sequential engine: it
 * never calls `advance()`, never touches `workflow.status` or
 * `lastSessionId`. Meant for "try this step" without committing it to the
 * workflow's real history.
 */
export async function runStepIsolated(workflowId: string, stepId: string, cfg: HubConfig, log: Logger): Promise<void> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	const token = startIsolatedRun(stepId);
	if (!token) throw new WorkflowError("an isolated run is already in progress for this step");
	await dispatchStepIsolated(step, workflow, token, cfg, log);
}

/**
 * Applies an isolated run's outcome (from /api/steps/:id/isolated-result).
 * Deliberately minimal compared to `onStepResult`: no `advance()`, no
 * workflow status change, no progress markdown rewrite — the .md file is the
 * sequential engine's, isolated runs don't belong in it.
 */
export function onIsolatedStepResult(
	stepId: string,
	outcome: { ok: boolean; result?: string; error?: string; sessionId?: string },
	log: Logger,
): void {
	const step = getStep(stepId);
	if (!step) return;
	completeIsolatedRun(stepId, outcome);
	log(`isolated run of step ${stepId} ${outcome.ok ? "done" : `failed (${outcome.error})`}`);
}
