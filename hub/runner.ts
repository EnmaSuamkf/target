/**
 * Dispatches one workflow step to its workflow's awb hook. Same async
 * contract as agentmesh's runner: the hook answers `{ok:true}` immediately
 * (the Claude run happens in the background), so a successful POST only
 * means "accepted" → step goes `running`. The outcome arrives later on
 * `POST /api/steps/:id/result` via the `callbackUrl` we send in the event
 * body.
 *
 * Every step of a workflow shares one hook and, from the second step on,
 * resumes the same Claude session (`workflow.lastSessionId`) — that's what
 * makes the whole workflow read as one continuous conversation instead of N
 * unrelated runs. Because that session is reused turn after turn, the input
 * always appends an explicit instruction to do the step's work through a
 * subagent (the Task tool) rather than inline: that keeps each step's own
 * working context out of the resumed session, which only accumulates the
 * subagent's final summaries.
 */
import type { HubConfig } from "./config.ts";
import type { Step, Workflow } from "./db.ts";
import { completeStep, markStepRunning } from "./db.ts";

export type Logger = (message: string, type?: "info" | "warning" | "error") => void;

const DISPATCH_TIMEOUT_MS = 10_000;

const SUBAGENT_SUFFIX =
	"\n\nImportant: run this step by delegating the work to a subagent (the Task tool) instead of solving it yourself directly in this thread — this same session is reused sequentially for every step of the workflow, and delegating keeps the main thread lightweight.";

/**
 * Builds the input for a re-run of a step the judge rejected: the same task
 * plus the judge's reason, so the agent knows what to fix instead of blindly
 * repeating itself.
 */
function retryNote(reason: string): string {
	const trimmed = reason.trim();
	return `\n\nNote: a previous attempt at this step did not pass the acceptance evaluation${
		trimmed ? `. Reason: "${trimmed}"` : ""
	}. Fix that and redo the step so it meets the criterion.`;
}

/**
 * Builds the input for the self-evaluation ("judge") pass: the same agent,
 * resuming the same session, is asked to grade its own previous result against
 * the step's acceptance criteria and answer with a strict JSON verdict.
 * Deliberately omits SUBAGENT_SUFFIX — the verdict must come straight back on
 * this thread, not from a subagent whose summary we'd then have to parse.
 */
export function judgeInput(criteria: string): string {
	return [
		"Evaluate your own result from the previous step of this workflow against the following acceptance criterion:",
		"",
		`"${criteria.trim()}"`,
		"",
		'Respond ONLY with a JSON object on a single line, with no other text, in exactly this shape: {"ok": true|false, "reason": "<brief explanation>"}',
		'"ok" is true only if the result meets the criterion. If it does not, set "ok": false and in "reason" explain concretely what is missing or what to fix.',
	].join("\n");
}

/**
 * Dispatches one workflow step to its workflow's awb hook. By default it
 * resumes `workflow.lastSessionId` (the sequential engine's case — every
 * step after the first continues the same Claude session). An on-demand run
 * (workflow.ts's `runStep`) passes `resumeSession: false` so it always starts
 * a fresh session instead of forking the shared one.
 *
 * `mode: "judge"` dispatches the self-evaluation pass instead of the step's
 * work: it always resumes the session (the agent must remember what it just
 * did), sends the verdict prompt, and does NOT flip the step's phase/status
 * (workflow.ts already moved it into the judge phase before calling this).
 * A rejected step's retry passes `retryReason` so the re-run carries the
 * judge's feedback.
 */
export async function dispatchStep(
	step: Step,
	workflow: Workflow,
	cfg: HubConfig,
	log: Logger,
	options: { resumeSession?: boolean; mode?: "exec" | "judge"; retryReason?: string } = {},
): Promise<void> {
	const mode = options.mode ?? "exec";
	// The judge must always see what it produced, so it resumes regardless of
	// the caller's preference.
	const resumeSession = mode === "judge" ? true : (options.resumeSession ?? true);
	const callbackUrl = `http://${cfg.host}:${cfg.port}/api/steps/${step.id}/result?token=${step.callbackToken}`;
	const input =
		mode === "judge"
			? judgeInput(step.acceptanceCriteria ?? "")
			: `${step.description}${SUBAGENT_SUFFIX}${options.retryReason ? retryNote(options.retryReason) : ""}`;
	try {
		const res = await fetch(workflow.hookUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-webhook-secret": workflow.secret,
				// awb resumes that Claude session (`claude --resume`) instead of
				// starting fresh whenever the workflow already has one — i.e. every
				// step after the first.
				...(resumeSession && workflow.lastSessionId ? { sessionid: workflow.lastSessionId } : {}),
			},
			body: JSON.stringify({ jobId: step.id, input, callbackUrl }),
			signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
		});
		if (res.ok) {
			// In judge mode the step is already `running` in its judge phase, so
			// this is a no-op (it only fires on a `pending` step) — the exec dispatch
			// is what it's really for.
			markStepRunning(step.id);
			log(`step ${step.id} (workflow ${workflow.id}, ${mode}) -> '${workflow.agentName}' accepted`);
		} else {
			completeStep(step.id, { ok: false, error: `hook answered ${res.status}` });
			log(`step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' rejected (${res.status})`, "error");
		}
	} catch (err) {
		completeStep(step.id, { ok: false, error: `hook unreachable: ${String(err)}` });
		log(`step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' unreachable: ${String(err)}`, "error");
	}
}
