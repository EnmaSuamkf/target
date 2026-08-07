/**
 * Workflow engine: a workflow is N sequential steps, each dispatched as a job
 * to the ONE awb hook/agent created for that workflow. Steps run one at a
 * time, in order, resuming the same Claude session across steps
 * (see runner.ts). This module owns the state machine (draft → running →
 * paused/waiting/completed/failed) and the ~/.target/<name>-<id>.md progress
 * file. `waiting` is the manual-review gate: a step flagged for it holds the
 * whole run until a human continues it (see "manual review gate" below).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	listFieldAttachments,
	listStepAttachments,
	removeStepAttachments,
	removeWorkflowAttachments,
	saveAttachment,
} from "./attachments.ts";
import {
	createAwbHook,
	deleteAwbHook,
	abortAwbRun,
	hookRuntime,
	PUBLISHABLE_RUNNERS,
	type HookOptions,
	type PublishablePermissionMode,
	type PublishableRunner,
	type PublishableSandbox,
} from "./awb.ts";
import { targetDir, type HubConfig } from "./config.ts";
import {
	beginRetry,
	claimWorkflowCompletionNotice,
	clearCompactionMarkers,
	completeStep,
	CONTEXT_STEP_ORDER_INDEX,
	deleteStep,
	deleteWorkflow,
	failRunningStep,
	failTimedOutStep,
	findTimeoutCandidates,
	finishStepDone,
	getContextStep,
	getStep,
	getWorkflow,
	insertStep,
	insertWorkflow,
	listRunningSteps,
	listSteps,
	listWorkflows,
	markStepJudging,
	markStepWaiting,
	nextPendingStep,
	overrideStepStatus,
	OVERRIDABLE_STEP_STATUSES,
	OVERRIDABLE_WORKFLOW_STATUSES,
	recordStepProgress,
	rejectWaitingStep,
	releaseWaitingStep,
	resetSteps,
	setContextInjected,
	setWorkflowConversationContext,
	setWorkflowName,
	setStatusBeforeReview,
	setStepSelection,
	setWorkflowSessionId,
	setWorkflowStatus,
	slugify,
	startManualRun,
	stepProgress,
	swapStepOrder,
	takeStatusBeforeReview,
	updateStepConfig,
	updateStepDescription,
	type Attachment,
	type OverridableStepStatus,
	type OverridableWorkflowStatus,
	type Step,
	type TimeoutReason,
	type Workflow,
	type WorkflowStatus,
} from "./db.ts";
import { sendManualReviewNotification, sendWorkflowCompletedNotification } from "./notifier.ts";
import { forgetProbe, humanizeSeconds, probeStepProgress, pruneProbes, stepActivity } from "./progress.ts";
import { dispatchStep, type Logger } from "./runner.ts";
import { writeStepResults } from "./step-results.ts";

export class WorkflowError extends Error {}

/**
 * Refreshes the progress clock of every in-flight step from the artifacts its
 * harness is writing (see progress.ts). Throttled per step, so running this on
 * every workflow read (~every 2s with the UI open) costs at most one `readdir`
 * per running step per `progressProbeThrottleMs`. This is what makes the UI
 * able to say "active 4s ago" instead of only finding out at the deadline.
 */
function refreshProgress(cfg: HubConfig): void {
	const running = listRunningSteps();
	// The throttle is keyed by step id and this is the only place that knows
	// which steps are still in flight, so it's also where the entries of settled
	// steps are dropped — otherwise the map would grow by one slot per step the
	// daemon has ever run.
	pruneProbes(new Set(running.map((step) => step.id)));
	for (const step of running) {
		const workflow = getWorkflow(step.workflowId);
		if (workflow) recordFreshSignal(step, workflow, cfg);
	}
}

/**
 * Probes one step and records the signal if it's genuinely newer than what we
 * already had. Two guards matter: an UNCHANGED fingerprint is not progress (the
 * file still existing must never reset the clock), and a signal older than the
 * one already stored is ignored (a stale run log must not drag the clock
 * backwards). Returns the step as it now stands.
 */
function recordFreshSignal(step: Step, workflow: Workflow, cfg: HubConfig, force = false): Step {
	const signal = probeStepProgress(workflow, step, cfg, force);
	if (!signal || signal.token === step.lastProgressToken) return step;
	const known = step.lastProgressAt ? Date.parse(step.lastProgressAt) : Number.NEGATIVE_INFINITY;
	if (Date.parse(signal.at) <= known) return step;
	if (!recordStepProgress(step.id, signal)) return step;
	return getStep(step.id) ?? step;
}

/** The `error` a timed-out step is failed with — it must say WHY, since "timeout" alone is exactly what made this bug so hard to read. */
function timeoutError(step: Step, reason: TimeoutReason, cfg: HubConfig): string {
	if (reason === "queued") return "timeout (queued: the run never started)";
	const activity = stepActivity(step, cfg);
	if (reason === "hard") {
		return `timeout (hard cap: ${humanizeSeconds(activity?.elapsedSeconds ?? 0)} running)`;
	}
	const since = step.lastProgressAt ?? step.startedAt ?? "unknown";
	const kind = step.lastProgressKind ?? "no signal";
	return `timeout (no progress for ${humanizeSeconds(activity?.idleSeconds ?? 0)}; last signal: ${kind} at ${since})`;
}

/**
 * Fails any step the progress watchdog considers stuck. Two phases, on purpose:
 *
 * 1. `findTimeoutCandidates` (a pure SQL read) lists the steps whose clocks have
 *    run out — no activity for `stepIdleTimeoutMs`, `stepHardTimeoutMs` of
 *    wall time, or a queue wait past `queuedTimeoutMs`.
 * 2. Each `idle` candidate is then RE-PROBED against the filesystem, and one
 *    whose agent demonstrably wrote something recently is left alone.
 *
 * That second phase is the fix for the original bug: a step used to be failed
 * purely because 20 minutes had passed, even while the agent was mid-task. Now
 * only silence fails it. A candidate with no artifacts at all (unknown harness,
 * remote hook, deleted transcripts) finds no signal and times out on the idle
 * clock exactly as the old wall clock did — the watchdog degrades, never
 * blocks.
 *
 * From there the behaviour is unchanged: a timed-out step with retry budget
 * left (`retryCount < maxRetries`) is NOT terminal — it consumes one retry and
 * is re-dispatched (mirroring the judge-reject retry path). Only when the budget
 * is spent (or was never granted) does the timeout fail the step for good —
 * and, for a still-`running` workflow that owned it, fail the workflow too,
 * otherwise it would sit stuck forever with no step left to dispatch.
 */
export function expireStale(cfg: HubConfig, log: Logger): void {
	refreshProgress(cfg);
	const candidates = findTimeoutCandidates({
		idleTimeoutMs: cfg.stepIdleTimeoutMs,
		hardTimeoutMs: cfg.stepHardTimeoutMs,
		queuedTimeoutMs: cfg.queuedTimeoutMs,
	});
	const failedWorkflowIds = new Set<string>();
	for (const candidate of candidates) {
		const { stepId, workflowId } = candidate;
		const workflow = getWorkflow(workflowId);
		let step = getStep(stepId);
		if (!step || !workflow) continue;

		// Phase 2: an idle candidate gets one last, unthrottled look at the
		// harness's artifacts before we believe it's hung.
		if (candidate.reason === "idle") {
			step = recordFreshSignal(step, workflow, cfg, true);
			const activity = stepActivity(step, cfg);
			if (activity && activity.state !== "stalled" && activity.state !== "timed-out-hard") {
				log(
					`step ${stepId} is still active (${step.lastProgressKind ?? "signal"} ${humanizeSeconds(activity.idleSeconds)} ago) — not timing it out`,
				);
				continue;
			}
		}

		const error = timeoutError(step, candidate.reason, cfg);
		// The run may have answered while we were probing — then it's already
		// settled and this sweep has nothing to do.
		if (!failTimedOutStep(stepId, error)) continue;
		forgetProbe(stepId);
		log(`step ${stepId} timed out — ${error}`, "warning");

		if (step.retryCount < step.maxRetries) {
			// Retry budget left → consume one retry and re-run the step instead of
			// failing the workflow. `beginRetry` runs synchronously here so the
			// step is back to `pending` (and the heal below leaves the workflow
			// alone) before this sweep returns; the re-dispatch itself is
			// fire-and-forget so a read-path caller isn't blocked by the retry
			// interval or the dispatch round-trip.
			beginRetry(stepId); // status → pending, retry_count++, keeps is_manual_run
			writeStatusMd(workflowId);
			log(`step ${stepId} retrying after the timeout (${step.retryCount + 1}/${step.maxRetries})`, "warning");
			const retried = getStep(stepId);
			if (retried) void retryTimedOutStep(retried, workflow, cfg, log);
			continue;
		}
		failedWorkflowIds.add(workflowId);
	}
	for (const workflowId of failedWorkflowIds) {
		const workflow = getWorkflow(workflowId);
		if (workflow?.status === "running") {
			setWorkflowStatus(workflowId, "failed");
			log(`workflow ${workflowId} failed: a step timed out`, "error");
		}
		writeStatusMd(workflowId);
	}
	healSettledStatuses(log);
}

/**
 * Re-dispatches a step whose previous attempt timed out (its retry was
 * already consumed by `expireStale`, which put it back to `pending`).
 * Best-effort kills the timed-out run on the broker first — the old process
 * may still be hung, holding the workdir `flock`, and the retry would
 * otherwise just queue behind that zombie until it too timed out. Honors the
 * step's `retryIntervalSeconds` like a judge-reject retry, then re-reads the
 * step and only dispatches if it's still `pending` (an abort/restart/manual
 * ▶ run in the meantime wins). The re-run resumes the workflow's shared
 * session and carries a note that the previous attempt timed out, so the
 * agent continues from partial progress instead of starting over blind.
 */
async function retryTimedOutStep(step: Step, workflow: Workflow, cfg: HubConfig, log: Logger): Promise<void> {
	await abortAwbRun(workflow.hookUrl, workflow.secret, step.id, log);
	if (step.retryIntervalSeconds > 0) {
		log(`step ${step.id} waiting ${step.retryIntervalSeconds}s before the timeout retry`);
		await wait(step.retryIntervalSeconds);
	}
	const current = getStep(step.id);
	if (!current || current.status !== "pending") return; // resolved another way meanwhile
	await dispatchStep(current, workflow, cfg, log, {
		resumeSession: true,
		manual: current.manualRun,
		timedOut: true,
	});
	if (current.manualRun) {
		// A manual ▶ run stays outside the sequential engine: a dead dispatch
		// already marked the step failed, so just reconcile; otherwise refresh.
		if (getStep(step.id)?.status === "failed") settleManual(step.workflowId, log);
		else writeStatusMd(step.workflowId);
	} else {
		failWorkflowIfDispatchDied(step.id, step.workflowId, "timeout retry", log);
	}
}

// --- manual review gate ------------------------------------------------
//
// A step may be flagged `manualReview`. Where the engine would normally accept
// a finished, verified step and move on, a flagged step stops: it goes
// `waiting`, its workflow goes `waiting`, and nothing else happens until a
// human presses Continue (`continueStep`), which completes the step and
// advances exactly as the engine would have. The gate is per STEP — it's an
// extra verification of that step's result, alongside its acceptance criterion
// — so it hooks in at the two places a step is accepted: the no-judge exec
// path and the judge's `ok` verdict.
//
// It applies to on-demand ▶ runs too. Those sit outside the sequential engine,
// so at first glance there is nothing to "hold back" — but the gate is a
// property of the STEP, not of the engine: it says this step's result needs a
// human before it counts as done, however the step was started. Skipping ▶ runs
// would make the toggle look broken for anyone who runs their steps one at a
// time. The difference is only in what Continue does afterwards: an engine step
// resumes the run, a ▶ run just settles back into the status it interrupted
// (see `continueStep`).

/** What the notification tells the human to look at — the acceptance criterion when there is one, otherwise the result itself. */
function manualReviewReason(step: Step): string {
	const base = "this step has Manual review enabled, so its result needs your approval before the workflow moves on";
	return step.acceptanceCriteria
		? `${base}. Check it satisfies its acceptance criterion: "${step.acceptanceCriteria}"`
		: `${base}. Check that the work it reports is what you wanted`;
}

/**
 * Tries to notify the user that a step is waiting on them. Purely advisory: the
 * step is ALREADY `waiting` by the time this runs, `sendManualReviewNotification`
 * never throws, and every outcome (notifications off, no username configured,
 * no Slack MCP, a send that failed) is only logged — see notifier.ts for the
 * five cases. The engine's state must never depend on a message getting out.
 */
async function notifyManualReview(step: Step, workflow: Workflow, log: Logger): Promise<void> {
	const outcome = await sendManualReviewNotification({
		workflowName: workflow.name,
		stepNumber: step.orderIndex + 1,
		stepDescription: step.description,
		reason: manualReviewReason(step),
	});
	log(
		outcome.sent
			? `manual-review notification sent for step ${step.id}`
			: `manual-review notification not sent for step ${step.id} (${outcome.reason})`,
	);
}

/**
 * Holds an accepted step at its manual-review gate: step → `waiting`, workflow
 * → `waiting`, then a best-effort notification. Returns whether the hold took;
 * false means the step was no longer `running`/`queued` (aborted, restarted,
 * timed out while its callback was in flight), in which case the caller settles
 * it normally and the gate simply doesn't apply anymore.
 */
async function holdForManualReview(
	step: Step,
	outcome: { result?: string; sessionId?: string },
	log: Logger,
): Promise<boolean> {
	if (!markStepWaiting(step.id, outcome)) return false;
	// Stash what the badge said before the hold, so releasing a ▶ run can hand it
	// back (an engine step always resumes `running`, so it ignores this).
	const before = getWorkflow(step.workflowId)?.status;
	setStatusBeforeReview(step.workflowId, before === undefined || before === "waiting" ? null : before);
	setWorkflowStatus(step.workflowId, "waiting");
	writeStatusMd(step.workflowId);
	log(`step ${step.id} is waiting for a manual review — workflow ${step.workflowId} paused`, "warning");
	const workflow = getWorkflow(step.workflowId);
	if (workflow) await notifyManualReview(step, workflow, log);
	return true;
}

/**
 * Releases a step from its manual-review hold (the UI's "Continue" button): the
 * step completes and the workflow picks up exactly where the gate stopped it —
 * next step dispatched, or `completed` if that was the last one. Only a
 * `waiting` step can be continued; anything else throws and changes nothing, so
 * a stale button click (the poll is 2s behind) can't corrupt a step that has
 * since moved on.
 */
export async function continueStep(workflowId: string, stepId: string, cfg: HubConfig, log: Logger): Promise<Step> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	// Belt and braces: the context step never carries the manual-review gate, so it
	// can never be `waiting` — but saying so here keeps the rule in one place.
	refuseContextStep(step);
	if (step.status !== "waiting") throw new WorkflowError("only a step waiting for its manual review can be continued");
	if (!releaseWaitingStep(stepId)) throw new WorkflowError("only a step waiting for its manual review can be continued");
	const stashed = takeStatusBeforeReview(workflowId);
	log(`step ${stepId} released by its manual review`);
	if (step.manualRun) {
		// An on-demand ▶ run never drove the workflow and must not start driving it
		// now: releasing it puts back the status the hold interrupted and settles
		// the badge from the steps, exactly like any other ▶ run finishing. It must
		// NOT advance — dispatching the next pending step is something only Start
		// ever does.
		if (stashed) setWorkflowStatus(workflowId, stashed);
		settleManual(workflowId, log);
	} else {
		// The gate was the only thing holding the run, so the workflow goes back to
		// `running` before advancing — `advance()` acts on nothing else, and it's
		// what turns the last step's release into `completed`.
		setWorkflowStatus(workflowId, "running");
		writeStatusMd(workflowId);
		await advance(workflowId, cfg, log);
	}
	const updated = getStep(stepId);
	if (!updated) throw new WorkflowError("step disappeared");
	return updated;
}

// --- manual status override ------------------------------------------------
//
// Every status in this engine is otherwise derived: a step's from its run's
// callback, a workflow's from its steps. That's right almost always and wrong in
// one recurring case — the agent DID the work, but the run was cut short (out of
// tokens) or its result callback never arrived, so the step is `failed` and the
// workflow reads `failed` with it. There was no way to say otherwise; these two
// functions are it.
//
// The semantics, in full, because "force a status" invites more than it should:
//
//  - **Nothing is dispatched, ever.** An override records a verdict; it does not
//    run, re-run or resume anything. Correcting a failed step to `done` cannot
//    re-fire it (`nextPendingStep` only ever returns a `pending` step) and
//    cannot advance the workflow (only `advance()` dispatches, and only Start /
//    Continue / a callback reach it).
//  - **A job in flight is off limits.** A `running`/`queued` step still has a
//    callback coming; overwriting its status would either be undone by that
//    callback or leave a live agent writing into a step that says it's finished.
//    Abort it first — that's exactly what Abort is for — then override it.
//  - **A step override still reconciles the workflow.** Fixing the last failed
//    step of a workflow should make the workflow stop saying `failed` without a
//    second action, so the normal derivation runs afterwards. It's the ordinary
//    one, so it leaves a `running` workflow and a manually-pinned one alone.
//  - **A workflow override is sticky, but not permanent.** It's pinned against
//    re-derivation (`reconcileStatus`) until the engine authors a status again —
//    Start, Stop, Resume, Start over, or any step callback. An override survives
//    reads, polls and hub restarts; it does not survive a re-run, because after a
//    re-run the steps are telling the truth again.

/**
 * Forces one step's status by hand (see the block above). Only the settled
 * statuses are offered (`OVERRIDABLE_STEP_STATUSES`) and only when no job is in
 * flight for that step. Rewrites the .md and re-derives the workflow's badge,
 * so progress %, the status file and the list all agree the moment it returns.
 */
export function forceStepStatus(
	workflowId: string,
	stepId: string,
	status: OverridableStepStatus,
	log: Logger,
): Step {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	refuseContextStep(step);
	if (!OVERRIDABLE_STEP_STATUSES.includes(status)) {
		throw new WorkflowError(`a step's status can only be set to ${OVERRIDABLE_STEP_STATUSES.join(", ")}`);
	}
	if (step.status === "running" || step.status === "queued") {
		throw new WorkflowError("this step still has a job in flight — abort it first, then set its status");
	}
	if (!overrideStepStatus(stepId, status)) throw new WorkflowError("step disappeared");
	log(`step ${stepId} status set manually to ${status}`);
	// The workflow's badge is a function of its steps, so it has to follow. This
	// is the ordinary derivation: it leaves a `running` workflow to the engine and
	// a manually-pinned one to whoever pinned it.
	reconcileStatus(workflowId, log);
	writeStatusMd(workflowId);
	const updated = getStep(stepId);
	if (!updated) throw new WorkflowError("step disappeared");
	return updated;
}

/**
 * Forces the workflow's own status by hand (see the block above) and pins it
 * against re-derivation until the engine next authors a status. Refused while a
 * step is actually in flight: that step's callback is about to write a status of
 * its own, so an override there would be silently overwritten seconds later.
 */
export function forceWorkflowStatus(workflowId: string, status: OverridableWorkflowStatus, log: Logger): Workflow {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (!OVERRIDABLE_WORKFLOW_STATUSES.includes(status)) {
		throw new WorkflowError(`a workflow's status can only be set to ${OVERRIDABLE_WORKFLOW_STATUSES.join(", ")}`);
	}
	const inFlight = listSteps(workflowId).find((s) => s.status === "running" || s.status === "queued");
	if (inFlight) {
		throw new WorkflowError("a step is still in flight — stop or abort it first, then set the workflow's status");
	}
	setWorkflowStatus(workflowId, status, { manual: true });
	writeStatusMd(workflowId);
	log(`workflow ${workflowId} status set manually to ${status}`);
	const updated = getWorkflow(workflowId);
	if (!updated) throw new WorkflowError("workflow disappeared");
	return updated;
}

/**
 * Read-path self-heal, run on every workflow GET (via `expireStale`): any
 * workflow whose steps are ALL settled (none pending, none running) must show
 * the status those steps add up to — `failed` if any step is failed, else
 * `completed` (or `draft` for a running workflow left with zero steps). This
 * recomputes the badge after events the engine never gets a callback for
 * (deleting the remaining pending steps of a `running` workflow, DB states
 * written by older buggy versions), so stale rows like "running at 100%" or
 * "completed with a red bar" fix themselves on the next read instead of
 * sticking forever.
 *
 * One pending case is healed too: a `running` workflow with NOTHING in flight
 * and no live retry wait is stranded — the engine is idle and no callback will
 * ever arrive (rows written by the pre-settle engine, or a ▶ run's settle,
 * which never advances). Left alone it would show `running` forever with Start
 * disabled. Every OTHER workflow with pending/running steps is left strictly
 * alone: the engine (or the operator's next Start) owns those, and addStep's
 * deliberate terminal→draft reset must survive a read.
 */
function healSettledStatuses(log: Logger): void {
	for (const workflow of listWorkflows()) {
		const steps = listSteps(workflow.id);
		if (steps.some((s) => s.status === "running" || s.status === "queued" || s.status === "waiting")) continue;
		const pending = steps.filter((s) => s.status === "pending");
		if (pending.length > 0) {
			// A pending step that has consumed retries is mid-retry-wait: its
			// re-dispatch is already scheduled (the retry path dispatches
			// directly, never through advance()), so the engine IS about to
			// act. Only a genuinely idle `running` workflow may be healed.
			const liveRetryWait = pending.some((s) => s.retryCount > 0);
			if (workflow.status !== "running" || liveRetryWait) continue;
		}
		if (reconcileStatus(workflow.id, log)) writeStatusMd(workflow.id);
	}
}

function statusMark(status: Step["status"]): string {
	return { pending: " ", queued: ".", running: "~", waiting: "?", done: "x", failed: "!" }[status];
}

/** Truncates the conversation context for the one-line summary in the progress .md. */
function truncateMd(s: string, n = 120): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Rewrites the workflow's whole progress file — cheap enough to do on every
 * state change — and, in the same breath, the agent-facing copies of each
 * step's result under `<workdir>/.target/steps/` (see step-results.ts).
 *
 * The two files serve different readers and neither replaces the other: this
 * one is the operator's view (every step, truncated results, statuses, under
 * `~/.target`), those are the agent's (one full result per step, inside the
 * workdir so a sandboxed run can actually open them). They're written together
 * because this function is the single choke point every step transition already
 * passes through — hanging the agent-facing write off any one of the six
 * done-paths would mean the seventh silently not having it.
 */
export function writeStatusMd(workflowId: string): void {
	const workflow = getWorkflow(workflowId);
	if (!workflow) return;
	const allSteps = listSteps(workflowId);
	writeStepResults(workflow, allSteps);
	// The hub-owned context step is reported on its own line above the list rather
	// than numbered into it: `orderIndex + 1` would print it as "0." and it isn't
	// one of the N steps the operator wrote.
	const contextStep = allSteps.find((s) => s.kind === "context") ?? null;
	const steps = allSteps.filter((s) => s.kind === "task");
	const progress = stepProgress(workflowId);
	const lines: string[] = [
		`# Workflow: ${workflow.name}`,
		"",
		`- ID: ${workflow.id}`,
		`- Status: ${workflow.status}${workflow.statusManual ? ` (set manually${workflow.statusManualAt ? ` at ${workflow.statusManualAt}` : ""})` : ""}`,
		`- Progress: ${progress.done}/${progress.total} steps done (${progress.pct}%)${progress.failed ? `, ${progress.failed} failed` : ""}`,
		`- Agent: ${workflow.agentName}`,
		`- Session: ${workflow.lastSessionId ?? "(none yet)"}`,
		`- Conversation context: ${workflow.conversationContext ? truncateMd(workflow.conversationContext) : "(none)"}${workflow.conversationContext ? ` — injected: ${workflow.contextInjected ? "yes" : "no"}` : ""}`,
		// Which mechanism actually delivers that background, and where it got to.
		// Without this line a workflow with a context step looks identical to one
		// still on the legacy prepend, and the two fail in completely different ways.
		...(contextStep
			? [
					`- Conversation context step: [${statusMark(contextStep.status)}] delivered as its own turn before every other step — **${contextStep.status}**`,
				]
			: []),
		// Only when it happened: a line saying "never compacted" on every workflow
		// would bury the one workflow where it did. `pending` is the honest state
		// between observing a boundary and the next dispatch re-stating the context.
		...(workflow.lastCompactionAt
			? [
					`- Conversation compacted: ${workflow.lastCompactionAt} — earlier history replaced by a summary (context re-injection: ${
						workflow.compactionHandledAt === workflow.lastCompactionAt ? "done" : "pending"
					})`,
				]
			: []),
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
		// Only the non-default choice is worth a line: every step used to run
		// through a subagent, so "inline" is the thing that explains why this
		// step's work shows up in the conversation itself.
		if (!step.useSubagent) {
			// "configured" rather than "runs": context pressure can override this at
			// dispatch time (see context-pressure.ts), and this file is written from
			// the step's configuration, which doesn't know what the session's
			// occupancy will be when the step is actually sent.
			lines.push("   - Subagent: off — this step is configured to run inline in the conversation");
		}
		// The gate is worth stating in the file too: it explains, without the UI,
		// why a workflow is sitting at `waiting` instead of moving on.
		if (step.manualReview) {
			lines.push(
				step.status === "waiting"
					? "   - Manual review: WAITING for a human to continue this step"
					: "   - Manual review: required before the workflow advances past this step",
			);
		}
		if (step.startedAt) lines.push(`   - Started: ${step.startedAt}`);
		// Last sign of life from the agent, so a timeout (or a long-but-healthy
		// run) can be diagnosed from the progress file alone.
		if (step.status === "running" && step.lastProgressAt) {
			lines.push(`   - Last activity: ${step.lastProgressAt} (${step.lastProgressKind ?? "run start"})`);
		}
		if (step.finishedAt) lines.push(`   - Finished: ${step.finishedAt}`);
		// A status nobody's run produced has to say so, or this file reads as
		// evidence of something that never happened.
		if (step.statusManual) {
			lines.push(`   - Status set manually${step.statusManualAt ? ` at ${step.statusManualAt}` : ""}`);
		}
		if (step.result) lines.push(`   - Result: ${step.result.slice(0, 500)}${step.result.length > 500 ? "…" : ""}`);
		if (step.error) lines.push(`   - Error: ${step.error}`);
		lines.push("");
	}
	fs.mkdirSync(path.dirname(workflow.mdPath), { recursive: true });
	fs.writeFileSync(workflow.mdPath, `${lines.join("\n")}\n`);
}

/**
 * Creates the workflow's dedicated agent: an awb hook with its own sandbox
 * workdir, so its harness session is isolated per workflow (mirrors
 * agentmesh's "dedicated sandbox" security default). `runner` picks which
 * CLI the hook spawns — Claude Code (default) or free-code; both chain the
 * workflow's steps on one shared session. `sandbox` picks where that CLI
 * runs — on the host (default, unchanged) or in a container built from
 * `image` — which is the only thing that makes the workdir a real boundary
 * rather than a naming convention. Steps are added afterwards, one at a time,
 * from the Workflow section's "+ step" button.
 *
 * `conversationContext` is the background every step of this workflow runs
 * under, set at creation because that's when it's known: the workflow was
 * created FROM an existing conversation (see conversations.ts and
 * `POST /api/workflows`), so there is no moment at which the workflow exists
 * and its background doesn't. It's stored on the row and immediately
 * materialised as the hub-owned context step, so an imported conversation is
 * delivered by exactly the same path as one typed into the context panel
 * afterwards — one turn, before any real step, exactly once.
 */
export function createWorkflow(
	name: string,
	options: {
		workdir?: string;
		permissionMode?: HookOptions["permissionMode"];
		runner?: HookOptions["runner"];
		sandbox?: HookOptions["sandbox"];
		image?: HookOptions["image"];
		conversationContext?: string | null;
	} = {},
): Workflow {
	const trimmed = name.trim();
	if (!trimmed) throw new WorkflowError("name is required");
	const id = crypto.randomUUID();
	const shortId = id.slice(0, 8);
	const slug = slugify(trimmed);
	const agentName = `${slug}-${shortId}`;
	const workdir = options.workdir?.trim() || path.join(targetDir(), "sandboxes", agentName);
	const promptTemplate = `You are the agent of a workflow in The Target Project named "${trimmed}". This session is reused in order for every step of the workflow. Current step:\n\n{{payload}}\n\nCarry out the step and respond with the final result of that step.`;
	const hook = createAwbHook(agentName, workdir, promptTemplate, {
		permissionMode: options.permissionMode,
		runner: options.runner,
		sandbox: options.sandbox,
		image: options.image,
	});
	const mdPath = path.join(targetDir(), `${slug}-${shortId}.md`);
	const workflow = insertWorkflow({
		id,
		name: trimmed,
		agentName,
		hookUrl: hook.hookUrl,
		secret: hook.secret,
		mdPath,
		conversationContext: options.conversationContext ?? null,
	});
	// Before writeStatusMd, so a workflow created with a context has that step in
	// its progress file from the first write rather than only after the next edit.
	reconcileContextStep(workflow.id);
	writeStatusMd(workflow.id);
	return workflow;
}

/**
 * Renames a workflow — the label, and only the label.
 *
 * What deliberately does NOT move with it: the awb hook's name, the hook URL,
 * the agent name and the `.md` path, all of which were slugged from the name at
 * creation. They are this workflow's identity on the machine — a live URL bound
 * to a secret, a file the agent may already have been told to read — so renaming
 * is a display change, not a re-registration, and a running workflow can be
 * renamed without disturbing the step in flight. (The hook's prompt template
 * still names the workflow as it was created; it introduces the session, and
 * rewriting it mid-conversation would rename the workflow the agent believes it
 * is working on.)
 *
 * Renaming to exactly what it already says is a no-op rather than an error, so
 * a Save on an unchanged field doesn't bump `updated_at` or rewrite the file.
 */
export function renameWorkflow(workflowId: string, name: string): Workflow {
	const trimmed = name.trim();
	if (!trimmed) throw new WorkflowError("name is required");
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (trimmed === workflow.name) return workflow;
	setWorkflowName(workflowId, trimmed);
	// The progress file leads with `# Workflow: <name>`, so it would otherwise
	// keep announcing the old one until the next step landed.
	writeStatusMd(workflowId);
	const renamed = getWorkflow(workflowId);
	if (!renamed) throw new WorkflowError("workflow disappeared");
	return renamed;
}

/** What a clone is called by default: the original's name behind a fixed marker, so a copy is one in the list too. */
const CLONE_NAME_PREFIX = "Clone - ";

/** The name a clone of `workflow` is proposed under — what the clone form starts from. */
export function cloneName(name: string): string {
	return `${CLONE_NAME_PREFIX}${name}`;
}

/**
 * The working directory an OPERATOR chose for this workflow, as opposed to the
 * per-agent sandbox it fell back to. Null means "none was chosen": the agent
 * works in `~/.target/sandboxes/<its own name>`, a directory that belongs to
 * that agent alone and must never be handed to a second one.
 *
 * This is the difference a clone turns on (see `cloneWorkflow`) and the value
 * the clone form seeds its workdir field from, so it lives here rather than
 * being re-derived by each caller.
 */
export function operatorWorkdir(workdir: string | null, agentName: string): string | null {
	const ownSandbox = path.join(targetDir(), "sandboxes", agentName);
	return workdir && workdir !== ownSandbox ? workdir : null;
}

/**
 * What a clone may be told to do differently from the workflow it copies —
 * everything the new-workflow form asks for, since the clone dialog IS that
 * form (see CreateWorkflowModal, opened in clone mode).
 *
 * Three-valued on purpose, because "leave it alone" and "make it the default"
 * are different answers and the form can produce either:
 *
 * - **absent** — inherit the source's, which is what an API caller that sends
 *   nothing but a name gets.
 * - **`null`** — explicitly the default: its own sandbox, awb's own permission
 *   mode, claude, host, the default image. This is what clearing the field in
 *   the dialog means, and it's why these aren't plain optionals.
 * - **a value** — use it.
 *
 * Steps and context are deliberately not overridable: copying them is the
 * whole point of a clone.
 */
export interface CloneOverrides {
	name?: string;
	workdir?: string | null;
	permissionMode?: PublishablePermissionMode | null;
	runner?: PublishableRunner | null;
	sandbox?: PublishableSandbox | null;
	image?: string | null;
}

/**
 * Copies one attachment onto another owner. Best-effort by design: an image
 * whose file has gone missing (or which the store now refuses) must cost the
 * clone that image, not its steps.
 */
function copyAttachment(attachment: Attachment, workflowId: string, stepId: string | null): void {
	try {
		saveAttachment({
			workflowId,
			stepId,
			field: attachment.field,
			filename: attachment.filename,
			mime: attachment.mime,
			data: fs.readFileSync(attachment.path),
		});
	} catch {
		// Nothing to do about it here, and nothing worth failing the clone over.
	}
}

/**
 * Clones a workflow: a second workflow, with its own agent, that is the
 * original's DEFINITION and none of its history.
 *
 * Copied (what the operator wrote): every task step, in order, with its
 * acceptance criteria, manual-review gate, subagent toggle and retry budget;
 * the conversation context; the images pinned to any of those fields; and the
 * runtime the original runs under (runner, sandbox/image, permission mode),
 * which lives in the awb hook rather than on the row and is read back from it.
 *
 * Not copied (what a RUN produced): status, session id, step results, errors,
 * retry counters, timestamps, compaction markers and the "context injected"
 * flag. The clone comes out of `createWorkflow`/`addStep` exactly as a
 * hand-typed workflow does — `draft`, every step `pending` — because it is built
 * through them rather than by duplicating rows. That is the whole reason this
 * is written as a re-creation and not as an `INSERT ... SELECT`: run state has
 * no way in.
 *
 * The clone gets a brand-new agent + hook (its own secret, its own session) from
 * `createWorkflow`. Its workdir is the original's only when that was a directory
 * the operator chose — the work itself, a repo checkout, where a copy that ran
 * anywhere else would be a copy of nothing. A workflow left on the default
 * per-agent sandbox gets its own instead: that directory belongs to the agent
 * whose name it carries, and pointing a second agent at it would put two
 * independent runs in one place.
 *
 * All of that is only the PROPOSAL. `overrides` — what the clone dialog collects
 * on the new-workflow form — replaces any of it field by field, so a clone can
 * be renamed, pointed at another checkout, moved into a container or given
 * different permissions on its way out. What is never overridable is the steps
 * and the context: copying those is what makes this a clone.
 */
export function cloneWorkflow(workflowId: string, overrides: CloneOverrides = {}): Workflow {
	const source = getWorkflow(workflowId);
	if (!source) throw new WorkflowError("unknown workflow");
	const runtime = hookRuntime(source.hookUrl);
	// `pick` is what makes the three-valued override work: an absent key inherits,
	// an explicit null means "the default" (undefined, which createWorkflow reads
	// as an omitted field), and a value wins.
	const pick = <T>(override: T | null | undefined, inherited: T | undefined): T | undefined =>
		override === undefined ? inherited : (override ?? undefined);
	// `harness` is whatever the hook's `spawn:` consumer says; anything this hub
	// wouldn't publish falls back to the default, exactly like an omitted field on
	// the create form.
	const sourceRunner = PUBLISHABLE_RUNNERS.includes(runtime.harness as PublishableRunner)
		? (runtime.harness as PublishableRunner)
		: undefined;
	const workdir = pick(overrides.workdir, operatorWorkdir(runtime.workdir, source.agentName) ?? undefined);
	const runner = pick(overrides.runner, sourceRunner);
	const permissionMode = pick(overrides.permissionMode, runtime.permissionMode ?? undefined);
	const sandbox = pick(overrides.sandbox, runtime.sandbox ? ("docker" as const) : undefined);
	// The image only means anything to a docker sandbox: a clone moved onto the
	// host must not carry the original's image into a hook that won't use it.
	const image = sandbox === "docker" ? pick(overrides.image, runtime.sandbox?.image) : undefined;
	const clone = createWorkflow(overrides.name ?? cloneName(source.name), {
		...(workdir ? { workdir } : {}),
		...(runner ? { runner } : {}),
		...(permissionMode ? { permissionMode } : {}),
		...(sandbox ? { sandbox } : {}),
		...(image ? { image } : {}),
		conversationContext: source.conversationContext,
	});
	// The context's images come across before the steps so the hub-owned context
	// step is reconciled once, with everything it delivers already in place — an
	// images-only context has no text for `createWorkflow` to have seen.
	for (const attachment of listFieldAttachments(workflowId, null, "context")) {
		copyAttachment(attachment, clone.id, null);
	}
	reconcileContextStep(clone.id);
	// `listSteps` is ordered, and `addStep` appends, so the clone's steps come out
	// in the original's order. The context step is skipped: it is hub-owned and
	// was just re-materialised from the copied context above.
	for (const step of listSteps(workflowId)) {
		if (step.kind === "context") continue;
		const copy = addStep(clone.id, step.description, {
			acceptanceCriteria: step.acceptanceCriteria,
			manualReview: step.manualReview,
			useSubagent: step.useSubagent,
			maxRetries: step.maxRetries,
			retryIntervalSeconds: step.retryIntervalSeconds,
		});
		for (const attachment of listStepAttachments(step.id)) copyAttachment(attachment, clone.id, copy.id);
	}
	writeStatusMd(clone.id);
	// Re-read: `addStep` moved `updated_at` (and nothing else) on since the insert.
	return getWorkflow(clone.id) ?? clone;
}

/**
 * Records a session id onto the workflow (chaining the next dispatch to it)
 * and, the first time a session is established, marks the conversation context
 * as injected — the guard that keeps the preamble from being re-injected on
 * later steps. No-op when there's no session to chain.
 */
function chainSession(workflowId: string, sessionId: string | undefined | null): void {
	if (!sessionId) return;
	setWorkflowSessionId(workflowId, sessionId);
	// The first session establishes the conversation the context preamble was
	// injected into — mark it injected so it's never re-injected on later steps.
	// Only tracked when there IS a context: with an empty context nothing was
	// injected, so the flag stays false (the tracker stays honest / irrelevant).
	const workflow = getWorkflow(workflowId);
	// A context that is only images (no text) was still injected — the preamble
	// was built and the image paths were handed to the agent — so the guard has to
	// close for it too, or the preamble would be re-injected and the UI would keep
	// offering to edit a context the agent is already running under.
	const hasContext =
		!!workflow &&
		(!!workflow.conversationContext || listFieldAttachments(workflowId, null, "context").length > 0);
	if (workflow && hasContext && !workflow.contextInjected) setContextInjected(workflowId, true);
}

// --- the conversation context, as its own step ---------------------------
//
// The workflow's conversation context is background that applies to EVERY step.
// It used to be delivered by prepending it to whatever step happened to be
// dispatched first, which made the background and that step's task arrive as one
// indivisible instruction. It is now delivered as its own step — its own turn on
// the shared session, before any work — materialised as a real row so it reuses
// the entire dispatch/callback/timeout/abort pipeline instead of inventing a
// parallel one.
//
// The row is hub-owned: nobody types it, nobody edits it, and the three
// functions below are the only things that create, refresh or delete it. It sits
// at `CONTEXT_STEP_ORDER_INDEX` (-1) so it sorts first without renumbering any
// step the operator wrote (see that constant in db.ts).

/**
 * What the context step's `description` holds. Normally the context text itself,
 * so the row is self-describing in the UI and the status file. An images-only
 * context (a pinned screenshot and no prose — a legitimate way to use this,
 * mirroring `contextPreamble`'s own images-only case) has no text to show, so it
 * gets a fixed marker instead of an empty description, which `insertStep` would
 * otherwise store as a blank row.
 *
 * Note this string is NOT what the agent receives: the payload is built by
 * `composeStepInput` from `contextPreamble`, off the workflow's live columns.
 * This is the operator-facing label.
 */
const CONTEXT_STEP_IMAGES_ONLY_DESCRIPTION = "Conversation context (attached image(s))";

function contextStepDescription(workflow: Workflow): string {
	return workflow.conversationContext?.trim() || CONTEXT_STEP_IMAGES_ONLY_DESCRIPTION;
}

/** Whether the workflow has any background at all to deliver — text or images. */
function workflowHasContext(workflow: Workflow): boolean {
	return (
		!!workflow.conversationContext?.trim() ||
		listFieldAttachments(workflow.id, null, "context").length > 0
	);
}

/**
 * Creates, refreshes or removes the workflow's context step so it always agrees
 * with the workflow's conversation context. Idempotent — calling it twice, or on
 * every Start, changes nothing the second time. Returns the step, or null when
 * the workflow shouldn't have one.
 *
 * Three rules, in order:
 *
 *  1. **No context → no step.** Any PENDING context step is deleted; one that
 *     already ran is history and stays, because it did happen and its result is
 *     part of the conversation.
 *  2. **Already injected → hands off.** `context_injected` means this
 *     conversation is already operating under the background (that's also why
 *     editing it is frozen). Creating a pending step now would deliver it a
 *     second time; fabricating a `done` one would invent a run that never
 *     happened. This is the rule that makes the change safe for workflows that
 *     were mid-run when it landed — they keep the legacy prepend they already
 *     got, and gain a context step the next time they're restarted (which resets
 *     the flag and starts a fresh conversation anyway).
 *  3. **Otherwise** ensure exactly one pending `kind='context'` row at
 *     `CONTEXT_STEP_ORDER_INDEX`, with its description refreshed from the
 *     current text.
 */
export function reconcileContextStep(workflowId: string): Step | null {
	const workflow = getWorkflow(workflowId);
	if (!workflow) return null;
	const existing = getContextStep(workflowId);
	if (!workflowHasContext(workflow)) {
		if (existing && existing.status === "pending") {
			deleteStep(existing.id);
			return null;
		}
		return existing;
	}
	if (workflow.contextInjected) return existing;
	if (existing) {
		// Only a step that hasn't run yet may be reworded: once it has been
		// dispatched, its description is the label on a turn the agent actually
		// received, and rewriting it would make the UI describe something else.
		const wanted = contextStepDescription(workflow);
		if (existing.status === "pending" && existing.description !== wanted) {
			updateStepDescription(existing.id, wanted);
			return getStep(existing.id);
		}
		return existing;
	}
	return insertStep(workflowId, contextStepDescription(workflow), {
		kind: "context",
		orderIndex: CONTEXT_STEP_ORDER_INDEX,
		// No criterion (nothing to verify: "the agent received it" is what the
		// result callback already proves, and a judge pass would burn a second turn
		// grading a paragraph of prose), no gate (holding a human on the delivery of
		// background text would stall every run for no decision), no retries (there
		// is no judge, so no reject-and-retry cycle exists), and never delegated —
		// see CONTEXT_STEP_SUFFIX in runner.ts.
		acceptanceCriteria: null,
		manualReview: false,
		useSubagent: false,
		maxRetries: 0,
		retryIntervalSeconds: 0,
	});
}

/**
 * Guard for the operator-facing step mutators. The context step is the hub's,
 * not the operator's: editing its text, removing it, re-running it on demand or
 * forcing its status would all desynchronise it from the workflow column it
 * mirrors. Abort is deliberately NOT guarded — a context dispatch that hangs has
 * to be recoverable like any other.
 */
function refuseContextStep(step: Step): void {
	if (step.kind === "context") {
		throw new WorkflowError("the conversation-context step is managed by the hub — edit the workflow's conversation context instead");
	}
}

/**
 * Updates a workflow's conversation context — the preamble injected before
 * the first step of a fresh conversation (see runner.ts). The context is
 * editable only BEFORE it's been injected: once `context_injected` is true
 * the agent is already operating under it, so this throws
 * `context already injected` (the UI locks the field and disables Save, and
 * the PATCH route returns 400). To change an injected context, restart the
 * workflow first — restart resets the flag and starts a fresh conversation.
 * Pass an empty string / null to clear it (while still editable).
 */
export function setConversationContext(workflowId: string, context: string | null): Workflow {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	// Once the context has been injected into the conversation, it's frozen:
	// the agent is already operating under it, so changing it mid-conversation
	// would be silently inconsistent. To edit it, restart the workflow first
	// (restart resets `context_injected` and starts a fresh conversation).
	if (workflow.contextInjected) throw new WorkflowError("context already injected");
	setWorkflowConversationContext(workflowId, context);
	// Saved text creates (or refreshes) the step that will deliver it; cleared text
	// removes it. Before writeStatusMd, so the status file it writes already shows
	// the step rather than describing a state one save behind.
	reconcileContextStep(workflowId);
	writeStatusMd(workflowId);
	const updated = getWorkflow(workflowId);
	if (!updated) throw new WorkflowError("workflow disappeared");
	return updated;
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
	// Its attached images live in ~/.target/attachments/<id>/ — delete the rows
	// and the directory, or a removed workflow would leak both forever.
	removeWorkflowAttachments(workflowId);
	deleteWorkflow(workflowId);
}

/**
 * Appends a step to the workflow — or, with `afterStepId`, threads one in
 * directly after an existing step instead.
 *
 * The insert-after path exists for the step sitting at its manual-review gate:
 * the human looked at the result, it needs a correction first, and the fix has
 * to run BEFORE whatever came next. Adding it at the end and reordering by hand
 * isn't something the UI can do, so the position is chosen here. The new step is
 * `pending` and selected by default, so the Continue that releases the gate
 * dispatches it as the next step of the run — which is the whole point.
 *
 * Selection, in full: the engine dispatches only selected steps
 * (`nextPendingStep`), and the checkboxes are the operator's statement of what
 * that set is. A step appended WHILE the workflow is mid-run (`running`, or
 * `waiting` at a review gate — both states where the engine can dispatch
 * without a fresh selection being sent) therefore lands UNSELECTED: nobody
 * ticked it, the UI renders its box unchecked, and selected-by-default here was
 * exactly the reported bug — "I added a step while it was running and it
 * executed even though it wasn't selected". The insert-after-the-gate step is
 * the deliberate exception above. In every other status the next
 * Start/Resume/Restart rewrites every flag from the checkboxes anyway
 * (`setStepSelection`), so the historical selected-by-default is kept there for
 * the workflows that never open the selection.
 */
export function addStep(
	workflowId: string,
	description: string,
	options: {
		acceptanceCriteria?: string | null;
		manualReview?: boolean;
		/** Delegate this step to a subagent. Omitted = true, the default behaviour (see runner.ts). */
		useSubagent?: boolean;
		maxRetries?: number;
		retryIntervalSeconds?: number;
		/** Insert directly after this step instead of appending at the end. */
		afterStepId?: string | null;
	} = {},
): Step {
	const trimmed = description.trim();
	if (!trimmed) throw new WorkflowError("description is required");
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	// The anchor is resolved (and checked to belong to THIS workflow) here rather
	// than in db.ts, which doesn't validate ownership — otherwise a step id from
	// another workflow would silently renumber this one's steps.
	let afterOrderIndex: number | null = null;
	if (options.afterStepId) {
		const anchor = getStep(options.afterStepId);
		if (!anchor || anchor.workflowId !== workflowId) throw new WorkflowError("unknown step");
		// Anchoring on the context step would compute -1 + 1 = 0 and shift every
		// task step down a slot — precisely the renumbering (and the orphaned
		// `<NN>-<slug>.md` files that come with it) that pinning it at -1 exists to
		// prevent. "After the background" is "at the front", which is what omitting
		// the anchor already means.
		refuseContextStep(anchor);
		afterOrderIndex = anchor.orderIndex;
	}
	// See the docblock: a mid-run append is nobody's selection; the
	// insert-after-the-gate step is the one deliberate exception.
	const selected =
		afterOrderIndex != null ? true : workflow.status !== "running" && workflow.status !== "waiting";
	const step = insertStep(workflowId, trimmed, {
		acceptanceCriteria: options.acceptanceCriteria ?? null,
		manualReview: options.manualReview === true,
		useSubagent: options.useSubagent !== false,
		maxRetries: options.maxRetries ?? 0,
		retryIntervalSeconds: options.retryIntervalSeconds ?? 0,
		afterOrderIndex,
		selected,
	});
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
	options: {
		acceptanceCriteria?: string | null;
		manualReview?: boolean;
		useSubagent?: boolean;
		maxRetries?: number;
		retryIntervalSeconds?: number;
	} = {},
): Step {
	const trimmed = description.trim();
	if (!trimmed) throw new WorkflowError("description is required");
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	refuseContextStep(step);
	if (step.status === "running" || step.status === "queued") throw new WorkflowError("cannot edit a step while its job is running");
	// A step held at its gate has already produced the result the human is
	// reviewing — editing the task under them (or switching the gate off from
	// beneath the hold) would make that review meaningless. Continue it first.
	if (step.status === "waiting") throw new WorkflowError("cannot edit a step while it waits for its manual review");
	updateStepDescription(stepId, trimmed);
	// Only touch the verification config when the caller actually sent fields — a
	// plain description edit shouldn't silently wipe an existing criterion (or
	// clear the manual-review gate).
	if (
		options.acceptanceCriteria !== undefined ||
		options.manualReview !== undefined ||
		options.useSubagent !== undefined ||
		options.maxRetries !== undefined ||
		options.retryIntervalSeconds !== undefined
	) {
		updateStepConfig(stepId, {
			acceptanceCriteria: options.acceptanceCriteria ?? step.acceptanceCriteria,
			manualReview: options.manualReview ?? step.manualReview,
			useSubagent: options.useSubagent ?? step.useSubagent,
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
	// The context step is removed by clearing the workflow's conversation context,
	// which is the thing it mirrors — deleting the row directly would leave a
	// context that says it will be delivered and nothing to deliver it.
	refuseContextStep(step);
	if (step.status !== "pending") throw new WorkflowError("only a pending step can be removed");
	// The step's own attached images go with it (the workflow's context ones stay).
	removeStepAttachments(stepId);
	deleteStep(stepId);
	reconcileStatus(workflowId);
	writeStatusMd(workflowId);
}

/** Which way a step is moved by `moveStep`: earlier in the run, or later. */
export type StepMoveDirection = "up" | "down";

/**
 * Moves a step one place earlier (`up`) or later (`down`) in the workflow.
 *
 * A step used to land wherever it was created — appended at the end, or (from a
 * manual-review gate) directly after the step being reviewed — and nothing could
 * change its mind afterwards. This is the "actually, that runs before this one"
 * edit, done as a SWAP with the neighbouring step rather than a drag-and-drop
 * reorder: one press, one place, and the number in the row is the whole
 * feedback.
 *
 * Two rules, both about not rewriting history:
 *
 * - Only a `pending` step moves, and only past another `pending` one. A step
 *   that has already run owns its position in the record — its result was
 *   written to `.target/steps/<NN>-<slug>.md` under the index it had, and the
 *   sequential run reached it in that order — so renumbering it would make the
 *   list disagree with what happened. In practice this is also exactly the
 *   restriction that matters: only work that hasn't run yet can still be
 *   reordered in any meaningful sense.
 * - The context step is not in the ordering at all (it's pinned at
 *   `CONTEXT_STEP_ORDER_INDEX`, before everything), so it neither moves nor is
 *   moved past. Only `task` steps are considered as neighbours.
 */
export function moveStep(workflowId: string, stepId: string, direction: StepMoveDirection): Step {
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	refuseContextStep(step);
	if (step.status !== "pending") throw new WorkflowError("only a pending step can be moved");
	const tasks = listSteps(workflowId).filter((s) => s.kind !== "context");
	const at = tasks.findIndex((s) => s.id === stepId);
	const neighbour = tasks[direction === "up" ? at - 1 : at + 1];
	if (!neighbour) {
		throw new WorkflowError(direction === "up" ? "this step is already first" : "this step is already last");
	}
	if (neighbour.status !== "pending") {
		throw new WorkflowError(
			`cannot move this step past a step that is ${neighbour.status} — only pending steps can be reordered`,
		);
	}
	swapStepOrder(step.id, neighbour.id);
	writeStatusMd(workflowId);
	const moved = getStep(stepId);
	if (!moved) throw new WorkflowError("step disappeared");
	return moved;
}

// --- the "workflow finished" notification -------------------------------
//
// When a workflow's last step lands and it becomes `completed`, the user gets a
// Slack DM naming the workflow and quoting the result it ended on — the point
// being that they don't have to keep the UI open to find out.
//
// The hazard this section exists to solve is DUPLICATE delivery, not delivery.
// A workflow sits `completed` forever, and the UI polls the hub every ~2s
// through read paths that call `expireStale` → `healSettledStatuses` →
// `reconcileStatus`. A hook that asked "is this workflow completed?" would
// therefore answer yes on every poll and DM the user every two seconds, for as
// long as the workflow exists. So the trigger is not the STATE, it's the
// TRANSITION, and the transition is claimed once in the database
// (`claimWorkflowCompletionNotice`) rather than remembered in this process —
// otherwise a hub restart would re-announce every workflow that finished before
// it went down.
//
// There are exactly two places a workflow's status becomes `completed`:
// `advance()` (the engine reaching the end of the run, which is also what
// `continueStep` triggers when it releases the last gated step) and
// `reconcileStatus()` (the read-path heal, and the ▶-run settle that goes
// through it). Both call in here; the claim is what makes "both" safe.

/** How much of the last step's result the chat message carries. Longer than the .md's inline preview would be unreadable in a DM; shorter would stop being an answer. */
const COMPLETION_RESULT_CHARS = 600;

/**
 * Best-effort "this workflow finished" notification. Must be called at the
 * moment a workflow's status BECOMES `completed`, and it is safe to call it
 * more often than that: the first call after each completion wins the claim and
 * every other one returns having done nothing.
 *
 * Purely advisory, exactly like the manual-review notification: the workflow is
 * already `completed` before this runs, `sendWorkflowCompletedNotification`
 * never throws, and all five outcomes (notifications off, no username, no Slack
 * MCP, sent, send failed) are only logged. The workflow's state must never
 * depend on a message getting out.
 *
 * Note the claim happens BEFORE the first `await`, so a caller that can only
 * fire-and-forget this (the synchronous `reconcileStatus`) still gets the
 * once-only guarantee at the instant of the transition.
 */
async function notifyWorkflowCompleted(workflowId: string, log?: Logger): Promise<void> {
	if (!claimWorkflowCompletionNotice(workflowId)) return;
	const workflow = getWorkflow(workflowId);
	if (!workflow) return;
	// Task steps only: the hub-owned context step is not work the operator asked
	// for, so counting it would inflate "N steps" in the DM by one. (`at(-1)` was
	// already safe — the context step sorts to the FRONT — but the count was not.)
	const steps = listSteps(workflowId).filter((s) => s.kind === "task");
	// The workflow's "result" is the last step's — it's the one whose output the
	// run ended on, and every earlier step's result is already folded into it by
	// the shared session. A completed workflow with no steps at all (starting an
	// empty draft) has neither, and the message says so rather than lying.
	const last = steps.at(-1);
	const outcome = await sendWorkflowCompletedNotification({
		workflowName: workflow.name,
		stepCount: steps.length,
		lastStepDescription: last?.description ?? "",
		result: truncateText(last?.result ?? "", COMPLETION_RESULT_CHARS),
	});
	log?.(
		outcome.sent
			? `workflow-completed notification sent for workflow ${workflowId}`
			: `workflow-completed notification not sent for workflow ${workflowId} (${outcome.reason})`,
	);
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
 * attempt of each step counts. A `running` workflow is normally `advance()`'s
 * own job — but a workflow can be left `running` with its engine permanently
 * idle: no step in flight and no pending step left at all (e.g. the pending
 * steps were removed after the others finished). No callback will ever arrive
 * to settle that, so it IS reconciled here instead of sitting stuck at 100%
 * `running` forever. A `running` workflow is also reconciled when its engine
 * is permanently idle WITH pending steps left — rows written by the pre-2026
 * engine (which never settled a drained selection), or a ▶ run's settle on a
 * `running` workflow (manual runs never advance). Those would otherwise show
 * `running` forever with Start disabled. The only pending case left strictly
 * alone is a LIVE retry wait: a pending step that has consumed retries
 * (`retryCount > 0`, set by `beginRetry`) has its re-dispatch already
 * scheduled — the retry path waits out its interval and dispatches directly,
 * never through `advance()` — so the engine is about to act and the badge is
 * telling the truth. In the normal engine flow the drain is settled by
 * `advance()` itself the moment the in-flight callback arrives; this heal is
 * the backstop for rows that callback never came for. Never downgrades a
 * deliberate `paused` to `draft`. Returns whether it actually changed the
 * status, so read-path callers know to rewrite the .md.
 */
function reconcileStatus(workflowId: string, log?: Logger): boolean {
	const workflow = getWorkflow(workflowId);
	if (!workflow) return false;
	// A status a HUMAN asserted outranks the one the steps add up to, and stays
	// asserted until the engine legitimately authors a status again (see
	// `setWorkflowStatus`'s `manual` option). Without this the whole override
	// feature would be undone by the next poll: this function runs on every read.
	if (workflow.statusManual) return false;
	// A step held at its manual-review gate owns the badge: the workflow is
	// `waiting` until a human releases it, whatever the other steps add up to.
	// Without this the heal would "settle" a workflow whose only unfinished step
	// is one waiting on a person.
	if (listSteps(workflowId).some((s) => s.status === "waiting")) return false;
	if (workflow.status === "running") {
		const steps = listSteps(workflowId);
		// A step in flight — its callback will settle things; hands off.
		if (steps.some((s) => s.status === "running" || s.status === "queued")) return false;
		// A pending step that has consumed retries is mid-retry-wait: its
		// re-dispatch is already scheduled outside advance(), so the engine is
		// about to act — hands off. Any OTHER pending step with nothing in
		// flight means the run is stranded: fall through and derive.
		if (steps.some((s) => s.status === "pending" && s.retryCount > 0)) return false;
	}
	const progress = stepProgress(workflowId);
	if (progress.total === 0) {
		// Every step was deleted out from under a running-but-idle workflow —
		// there is nothing left to run, so `running` would be a lie forever.
		if (workflow.status === "running") {
			setWorkflowStatus(workflowId, "draft");
			log?.(`workflow ${workflowId} draft`);
			return true;
		}
		return false;
	}
	const derived: WorkflowStatus =
		progress.failed > 0 ? "failed" : progress.done === progress.total ? "completed" : "draft";
	if (derived === workflow.status) return false;
	if (derived === "draft" && workflow.status === "paused") return false;
	setWorkflowStatus(workflowId, derived);
	log?.(`workflow ${workflowId} ${derived}`);
	// A real completion transition — the badge was something else a statement
	// ago. This is the path a ▶ run finishing the last outstanding step takes
	// (via `settleManual`), so it has to notify like any other completion.
	// Fire-and-forget because this function is synchronous and sits on read
	// paths: a Slack round trip must not be something a workflow GET waits on,
	// and the claim above has already been won synchronously, so a later poll
	// cannot duplicate it. `notifyWorkflowCompleted` never rejects.
	if (derived === "completed") void notifyWorkflowCompleted(workflowId, log);
	return true;
}

/**
 * Dispatches the next pending step if the workflow is running and nothing is
 * currently in flight; marks the workflow completed once every step is done.
 * Called after create/start/resume/restart and after every step callback —
 * it's the only place that decides "what runs next", so pause is just
 * refusing to call this until resume.
 *
 * `nextPendingStep` only ever returns a *selected* step, so a run whose
 * selected steps have all finished returns null here while unselected pending
 * steps remain — that must NOT be read as "the workflow is done", and it must
 * NOT stay `running` either: nothing is in flight, no callback will ever
 * arrive, and a `running` badge disables Start (a mid-run untick that drained
 * the selection used to strand the workflow exactly like that — ticking steps
 * again couldn't relaunch it). The run is over, so the badge settles to what
 * the steps add up to, same derivation as `reconcileStatus`: any failed step →
 * `failed`, otherwise `draft` — "anything left to run → back to draft so Start
 * picks up where it left off". We only mark `completed` when there is truly
 * no pending work left at all (selected or not).
 */
async function advance(workflowId: string, cfg: HubConfig, log: Logger): Promise<void> {
	const workflow = getWorkflow(workflowId);
	if (!workflow || workflow.status !== "running") return;
	const steps = listSteps(workflowId);
	if (steps.some((s) => s.status === "running" || s.status === "queued")) return; // a step is already in flight (running or queued on the workdir lock)
	// A step held at its manual-review gate stops the run just as firmly as one
	// in flight: only Continue may move it, and only Continue may advance past
	// it. (Belt and braces — such a workflow is `waiting`, not `running`, so the
	// status check above already returned.)
	if (steps.some((s) => s.status === "waiting")) return;
	const next = nextPendingStep(workflowId);
	if (!next) {
		if (steps.some((s) => s.status === "pending")) {
			// Only UNSELECTED steps are pending (nextPendingStep would have
			// returned a selected one). The selected run has drained: settle
			// instead of sitting `running` forever with nothing in flight.
			// `stepProgress` counts the real (task) steps only, like every
			// other badge decision; pending remain, so it's failed-or-draft.
			const progress = stepProgress(workflowId);
			const settled: WorkflowStatus = progress.failed > 0 ? "failed" : "draft";
			setWorkflowStatus(workflowId, settled);
			writeStatusMd(workflowId);
			log(
				`workflow ${workflowId} ${settled} (run selection drained, ${progress.total - progress.done - progress.failed} unselected step(s) left)`,
				settled === "failed" ? "error" : "info",
			);
			return;
		}
		// Every step has run. The terminal badge must agree with the progress
		// bar: a step still `failed` (e.g. an old failure left outside a re-run
		// selection) makes the workflow `failed`, not `completed` — only
		// all-done reads as done.
		const terminal: WorkflowStatus = steps.some((s) => s.status === "failed") ? "failed" : "completed";
		setWorkflowStatus(workflowId, terminal);
		writeStatusMd(workflowId);
		log(`workflow ${workflowId} ${terminal}`, terminal === "failed" ? "error" : "info");
		// The main completion path: the engine ran out of work. Only `completed`
		// notifies — a run that ended `failed` is a different message nobody asked
		// for, and shipping it "because the branch is right here" would be inventing
		// a feature. Awaited (unlike the `reconcileStatus` call) because this is
		// already an async engine path and nothing is blocked by it.
		if (terminal === "completed") await notifyWorkflowCompleted(workflowId, log);
		return;
	}
	await dispatchStep(next, workflow, cfg, log);
	writeStatusMd(workflowId);
}

export async function startWorkflow(
	workflowId: string,
	cfg: HubConfig,
	log: Logger,
	stepIds: string[] = [],
): Promise<Workflow> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (workflow.status === "completed" || workflow.status === "failed") {
		throw new WorkflowError(`workflow is ${workflow.status} — use restart instead`);
	}
	// A workflow stopped at a manual-review gate is resumed by continuing that
	// step, not by starting the run again: Start would flip it back to `running`
	// while the step still sits `waiting`, so nothing would ever dispatch.
	if (workflow.status === "waiting") {
		throw new WorkflowError("workflow is waiting for a manual review — continue that step instead");
	}
	// Persist the run selection so the sequential engine (which advances across
	// async job callbacks) only ever dispatches the chosen steps. Empty = none.
	setStepSelection(workflowId, stepIds);
	// Belt and braces for a workflow whose context was set before this feature
	// existed (or through a path that didn't reconcile): the step is materialised
	// here, at the last moment before anything is dispatched, so the background
	// still leads the run. No-op when it already exists or must not exist.
	reconcileContextStep(workflowId);
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

export async function resumeWorkflow(
	workflowId: string,
	cfg: HubConfig,
	log: Logger,
	stepIds: string[] = [],
): Promise<Workflow> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (workflow.status !== "paused") throw new WorkflowError("only a paused workflow can be resumed");
	setStepSelection(workflowId, stepIds);
	// A resume mid-run finds the context step already `done` and leaves it alone —
	// the session being resumed is the one it primed. Rule 2 also declines here for
	// anything already injected, so this only ever acts on a run that never started.
	reconcileContextStep(workflowId);
	setWorkflowStatus(workflowId, "running");
	writeStatusMd(workflowId);
	await advance(workflowId, cfg, log);
	const updated = getWorkflow(workflowId);
	if (!updated) throw new WorkflowError("workflow disappeared");
	return updated;
}

/**
 * Syncs the run selection with the checkboxes exactly as they stand RIGHT NOW
 * — the UI calls this on every toggle, so a step unticked (or ticked) while a
 * run is in flight takes effect at the next dispatch decision instead of
 * waiting for the next Start/Resume/Restart. Before this existed the flags
 * only ever changed at those three entry points, so a mid-run untick stayed
 * browser-local and the engine dispatched the step anyway — the other half of
 * "the step ran even though it wasn't selected" (the first half is `addStep`'s
 * mid-run default).
 *
 * Semantics are `setStepSelection`'s own, unchanged: the listed steps (plus the
 * hub-owned context step) are selected, the rest are not, and an empty list
 * selects NOTHING — never read as "run everything". No status is written and
 * nothing is dispatched or reconciled here: the selection only governs what a
 * FUTURE dispatch decision picks up, and a step already in flight always
 * finishes on its own. When it does and nothing selected is left, `advance()`
 * settles the badge to draft/failed — so unticking everything mid-run ends
 * the run cleanly instead of stranding the workflow `running`.
 */
export function setWorkflowStepSelection(workflowId: string, stepIds: string[]): Step[] {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	setStepSelection(workflowId, stepIds);
	return listSteps(workflowId);
}

/**
 * Resets the selected steps to pending and drops session chaining, then starts
 * over. With a subset chosen it re-runs only those, leaving the rest
 * untouched; with nothing selected, nothing is reset and nothing runs.
 */
export async function restartWorkflow(
	workflowId: string,
	cfg: HubConfig,
	log: Logger,
	stepIds: string[] = [],
): Promise<Workflow> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (workflow.status === "running") throw new WorkflowError("pause the workflow before restarting it");
	// Selection first, so resetSteps only wipes the chosen steps.
	setStepSelection(workflowId, stepIds);
	resetSteps(workflowId);
	setWorkflowSessionId(workflowId, null);
	// A restart starts a brand-new conversation, so the conversation context
	// (if any) must be injected again on the new first step — reset the guard.
	setContextInjected(workflowId, false);
	// …and the compaction that happened in the OLD conversation is not something
	// the new one has to recover from. Clearing both markers together keeps
	// "compaction pending" from surviving into a session that never had one, which
	// would re-inject the preamble twice on the very first step.
	clearCompactionMarkers(workflowId);
	// AFTER the guard is reset, not before: rule 2 declines while `context_injected`
	// is still true. `resetSteps` above has already put the existing context step
	// back to `pending` (it is always selected — see `setStepSelection`), so this is
	// what materialises one for a workflow that didn't have it, and what refreshes
	// its text now that the context is editable again.
	reconcileContextStep(workflowId);
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
	// A step only awaits a result callback while it's `running` or `queued`. If
	// it's neither it was already resolved another way — aborted via the
	// "Abort" action (`failRunningStep`), timed out by the stale-step sweep
	// (`expireStale`), or reset by a restart. Drop the late callback so it
	// can't corrupt the step's new state (e.g. a stale judge verdict landing on
	// a step that's since been re-run). A `queued` step accepting its result
	// here means the broker's `started` callback was lost in flight (the run
	// began and finished without us hearing the start); `completeStep`/
	// `markStepJudging` both accept `queued`, so we settle it directly rather
	// than dropping it — losing the start is not a reason to lose the result.
	if (step.status !== "running" && step.status !== "queued") return;

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
		// Chain the session even on the failure path. A failed run still HAPPENED:
		// it started (or resumed) a conversation, said things in it, and
		// `completeStep` stores its id on the step row. Leaving the workflow's
		// `lastSessionId` behind made the hub's two answers to "which session is
		// this workflow on" disagree — the next dispatch reads
		// `workflow.lastSessionId` (runner.ts) while the UI's "Open conversation"
		// reads `latestStepSession()` (server.ts), so after a failure the operator
		// was shown one conversation and the retry resumed a different, older one.
		chainSession(step.workflowId, outcome.sessionId);
		completeStep(stepId, outcome);
		setWorkflowStatus(step.workflowId, "failed");
		writeStatusMd(step.workflowId);
		log(`workflow ${step.workflowId} failed at step ${stepId}: ${outcome.error}`, "error");
		return;
	}
	// Chain the session now — the judge (and any retry) resumes this same one.
	chainSession(step.workflowId, outcome.sessionId);

	// No acceptance criteria → no judge; accept the result as before.
	if (!step.acceptanceCriteria) {
		// …unless the step is gated: this is exactly the moment it would have gone
		// `done` and the engine would have advanced, so it holds here instead.
		if (step.manualReview && (await holdForManualReview(step, { result: outcome.result, sessionId: outcome.sessionId }, log))) {
			return;
		}
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
	chainSession(step.workflowId, outcome.sessionId);
	// No acceptance criteria → no judge; record the result as-is (unchanged)…
	if (!step.acceptanceCriteria) {
		// …unless the step is gated, in which case it holds here for its human
		// instead of being recorded done — same rule as the engine path.
		if (step.manualReview && (await holdForManualReview(step, { result: outcome.result, sessionId: outcome.sessionId }, log))) {
			return;
		}
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
	chainSession(step.workflowId, outcome.sessionId);

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
		// Judged good, but a gated step still needs a human on top of that.
		if (step.manualReview && (await holdForManualReview(step, {}, log))) return;
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
	chainSession(step.workflowId, outcome.sessionId);

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
		// The judge verified it, but a gated step needs a human on top of that:
		// hold instead of finishing. Its result is already stored (markStepJudging),
		// so the hold has nothing new to carry.
		if (step.manualReview && (await holdForManualReview(step, {}, log))) return;
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
	// A ▶ on the context step would deliver the background as a one-off manual run
	// outside the sequential engine, which is neither what "before every other
	// step" means nor something the operator can undo. Restart re-primes it.
	refuseContextStep(step);
	if (listSteps(workflowId).some((s) => s.status === "running" || s.status === "queued")) {
		throw new WorkflowError("a step is already running for this workflow");
	}
	// A ▶ re-run would wipe the result the human was asked to review and drop the
	// hold silently — Continue is the only way out of the gate.
	if (step.status === "waiting") {
		throw new WorkflowError("this step is waiting for its manual review — continue it instead");
	}
	if (!startManualRun(stepId)) throw new WorkflowError("this step is already running");
	writeStatusMd(workflowId);
	await dispatchStep(step, workflow, cfg, log, { manual: true });
	writeStatusMd(workflowId);
}

/**
 * Aborts a step stuck `running` or `queued` (a dispatch whose awb callback
 * never came back — e.g. a hung judge, or a run still queued on the workdir
 * lock). Marks it `failed` with `error = "aborted"` while preserving its
 * session id, so the conversation it established is still reachable and the
 * operator can re-run the step via the ▶ button once it's no longer
 * `running`/`queued`. Mirrors `onStepResult`'s failure path: a failed step
 * fails the workflow, and a later successful ▶ re-run reconciles it back out
 * of `failed`. Any late awb callback for the aborted step is ignored by the
 * status guard in `onStepResult`. Only a `running`/`queued` step can be
 * aborted; aborting a step in any other state throws.
 *
 * ALSO kills the spawned process on the broker (the fix for the original
 * bug: the step showed `failed` but the orphaned agent kept running for hours,
 * holding the workdir `flock` and blocking every other workflow on that repo).
 * `abortAwbRun` POSTs the hook's `/abort` endpoint with `{ jobId }`; the broker
 * SIGTERM/SIGKILLs the whole process group. Best-effort: a broker that's down
 * or a run that already finished just log a warning — the DB settling must not
 * be blocked by the kill, since the operator wants the step failed now either
 * way. Async because the kill is a network call.
 *
 * A step held at its manual-review gate is the second thing this answers for,
 * and it's a different job under the same word: nothing is stuck there, the run
 * finished and its result is sitting in front of a human who has decided it's
 * wrong. Abort on a `waiting` step therefore means "no, and stop" — see the
 * branch below. Every other status still throws.
 */
export async function abortStep(workflowId: string, stepId: string, log?: Logger): Promise<Workflow> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new WorkflowError("unknown step");
	// Rejecting a manual review, rather than unsticking a hung dispatch. The gate
	// was the only thing holding the run, so refusing it ends the run: the step is
	// recorded `failed` (with the result and session preserved, so the operator
	// can still read what was rejected and talk to the agent about it) and the
	// workflow fails with it — the same shape a failed step always gives the
	// workflow, and one a later ▶ re-run reconciles back out of `failed`.
	// Nothing is killed on the broker because nothing is running; the hold's
	// stashed status is consumed so it can't leak into a later hold.
	if (step.status === "waiting") {
		if (!rejectWaitingStep(stepId, "aborted")) {
			throw new WorkflowError("this step is no longer waiting for its manual review");
		}
		takeStatusBeforeReview(workflowId);
		setWorkflowStatus(workflowId, "failed");
		writeStatusMd(workflowId);
		log?.(`step ${stepId} rejected at its manual review — workflow ${workflowId} stopped`, "warning");
		const stopped = getWorkflow(workflowId);
		if (!stopped) throw new WorkflowError("workflow disappeared");
		return stopped;
	}
	if (step.status !== "running" && step.status !== "queued") throw new WorkflowError("only a running step can be aborted");
	if (!failRunningStep(stepId, "aborted")) throw new WorkflowError("only a running step can be aborted");
	setWorkflowStatus(workflowId, "failed");
	writeStatusMd(workflowId);
	// Kill the spawned process on the broker so it stops holding the workdir
	// `flock`. Fire after the DB is settled so the operator sees `failed` first;
	// never let a broker error undo the abort (best-effort).
	if (log) await abortAwbRun(workflow.hookUrl, workflow.secret, stepId, log);
	const updated = getWorkflow(workflowId);
	if (!updated) throw new WorkflowError("workflow disappeared");
	return updated;
}
