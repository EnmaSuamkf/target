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
 * appends by default an explicit instruction to do the step's work through a
 * subagent (the Task tool) rather than inline: that keeps each step's own
 * working context out of the resumed session, which only accumulates the
 * subagent's final summaries.
 *
 * That's a per-step choice (`step.useSubagent`, on by default). A step with the
 * toggle OFF gets the opposite instruction instead — solve it here, in this
 * thread, spawn nothing — because leaving the input bare would make the
 * behaviour depend on the agent's mood: the session's earlier turns are full of
 * "delegate this" instructions, and an unqualified step would very likely be
 * delegated by imitation. Exactly one of the two instructions is always
 * appended, so a step never has to be guessed about.
 */
import type { HubConfig } from "./config.ts";
import type { Step, Workflow } from "./db.ts";
import { completeStep, markStepQueued } from "./db.ts";

export type Logger = (message: string, type?: "info" | "warning" | "error") => void;

const DISPATCH_TIMEOUT_MS = 10_000;

export const SUBAGENT_SUFFIX =
	"\n\nImportant: run this step by delegating the work to a subagent (the Task tool) instead of solving it yourself directly in this thread — this same session is reused sequentially for every step of the workflow, and delegating keeps the main thread lightweight.";

/**
 * The counter-instruction for a step whose subagent toggle is OFF. It has to be
 * explicit for the reason given in the module header: earlier turns of this very
 * session told the agent to delegate, so silence would read as "same as before".
 * It also says why (the operator wants this step's work visible in the
 * conversation), so the agent doesn't treat it as an arbitrary restriction and
 * "helpfully" delegate anyway.
 */
export const INLINE_SUFFIX =
	"\n\nImportant: run this step yourself, directly in this thread — do NOT delegate it to a subagent (do not use the Task tool for it). This step was explicitly configured to run inline, so its work belongs in this conversation.";

/** The instruction appended to a step's exec input, per its subagent toggle. */
export function subagentInstruction(useSubagent: boolean): string {
	return useSubagent ? SUBAGENT_SUFFIX : INLINE_SUFFIX;
}

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
 * Note appended to the re-run of a step whose previous attempt timed out.
 * The retry resumes the same session, so partial progress from the timed-out
 * run may already exist — the agent should continue, not start from scratch.
 */
const TIMEOUT_NOTE =
	"\n\nNote: the previous attempt at this step timed out before finishing. Continue from any partial progress already made and complete the step.";

/**
 * Appends the acceptance criterion to the exec input so the agent aims for it
 * from the start. Without this the criterion only surfaced in the judge phase —
 * the agent did the work never knowing what it would be graded against, so an
 * honest self-evaluation could only pass by luck.
 */
function criteriaNote(criteria: string | null | undefined): string {
	const trimmed = (criteria ?? "").trim();
	if (!trimmed) return "";
	return `\n\nThe result of this step MUST satisfy the following acceptance criterion, so aim explicitly to meet it: "${trimmed}".`;
}

/**
 * Builds the conversation-context preamble prepended to the FIRST dispatch of
 * a fresh conversation (no session to resume yet). It's the workflow-level
 * background/constraints the operator wants every step to inherit. Injected
 * once: later steps resume the session, which already carries it in history,
 * so `dispatchStep` only prepends it when starting fresh AND the workflow's
 * `context_injected` guard is still false. Returns "" when there's no context.
 */
function contextPreamble(context: string | null | undefined): string {
	const trimmed = (context ?? "").trim();
	if (!trimmed) return "";
	return `Conversation context — this background applies to every step of this workflow:\n\n${trimmed}\n\n---\n\n`;
}

/**
 * Builds the input for the self-evaluation ("judge") pass: the same agent,
 * resuming the same session, is asked to grade its own previous result against
 * the step's acceptance criteria and answer with a strict JSON verdict.
 * Deliberately omits SUBAGENT_SUFFIX — the verdict must come straight back on
 * this thread, not from a subagent whose summary we'd then have to parse.
 *
 * The prompt insists on ACTUAL verification: judging from memory is exactly how
 * a clearly-unmet criterion used to slip through as "ok". So it must re-inspect
 * the real state (read the files, run the commands) with its tools before
 * ruling, and default to a rejection whenever it cannot confirm the criterion
 * holds. `useSubagent` only changes WHY memory is untrustworthy: a delegated
 * step left nothing here but the subagent's summary, while an inline step's own
 * narration is still just narration, not the artifacts.
 */
export function judgeInput(criteria: string, useSubagent = true): string {
	const distrust = useSubagent
		? "do NOT trust your memory or the subagent's summary. The step's work was done by a subagent, so its real output may not be in this thread."
		: "do NOT trust your memory or what you said while doing the step. What this thread holds is your narration, not the real output.";
	return [
		"Evaluate whether the result of the previous step of this workflow meets the following acceptance criterion:",
		"",
		`"${criteria.trim()}"`,
		"",
		`Important: ${distrust} Verify the criterion by inspecting the actual artifacts with your tools — read the files, run the commands, check the real state — BEFORE deciding.`,
		"",
		'Once you have verified, end your reply with a JSON object on its own final line, and nothing after it, in exactly this shape: {"ok": true|false, "reason": "<brief explanation>"}',
		'"ok" is true ONLY if you confirmed the result meets the criterion. If it does not meet it, or you could not verify it, set "ok": false and in "reason" explain concretely what is missing or what to fix. When in doubt, "ok": false.',
	].join("\n");
}

/**
 * Dispatches one workflow step to its workflow's awb hook. It resumes
 * `workflow.lastSessionId` whenever the workflow has one — the whole workflow,
 * whether driven by the sequential engine or the on-demand ▶ button, shares
 * that single Claude session, so every step reads as one continuous
 * conversation. The very first dispatch (no session yet) starts fresh and its
 * callback persists the session id the workflow then reuses. `resumeSession:
 * false` forces a fresh session regardless.
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
	options: {
		resumeSession?: boolean;
		mode?: "exec" | "judge";
		retryReason?: string;
		/** The previous attempt timed out — append TIMEOUT_NOTE so the re-run continues the partial work. */
		timedOut?: boolean;
		manual?: boolean;
	} = {},
): Promise<void> {
	const mode = options.mode ?? "exec";
	// Which Claude session (if any) awb should `--resume` for this dispatch.
	// The judge resumes the very run it is grading (the step's own `sessionId`,
	// set by markStepJudging — equal to `workflow.lastSessionId` once the shared
	// session exists); an exec dispatch resumes the shared session unless the
	// caller forces a fresh one with `resumeSession: false`.
	const sessionToResume =
		mode === "judge"
			? (step.sessionId ?? workflow.lastSessionId)
			: (options.resumeSession ?? true)
				? workflow.lastSessionId
				: null;
	const callbackUrl = `http://${cfg.host}:${cfg.port}/api/steps/${step.id}/result?token=${step.callbackToken}`;
	// The broker POSTs `{started: true}` here the instant the run actually
	// begins (after the workdir `flock` is acquired — see awb's runHidden).
	// That flips the step `queued → running` and starts its timeout clock at the
	// true run start, so a step queued behind another on the same workdir isn't
	// timed out while still waiting its turn.
	const startedCallbackUrl = `http://${cfg.host}:${cfg.port}/api/steps/${step.id}/started?token=${step.callbackToken}`;
	// Inject the conversation context ONLY on the first dispatch of a fresh
	// conversation: exec mode, no session to resume (awb starts a fresh
	// `claude`), and the workflow's `context_injected` guard still false. Later
	// steps resume the session, which already carries the preamble in history —
	// re-injecting would duplicate it. A failed first dispatch that produced no
	// session leaves the guard false, so the next attempt re-injects cleanly.
	const freshConversation = sessionToResume === null;
	const preamble =
		mode === "exec" && freshConversation && !workflow.contextInjected
			? contextPreamble(workflow.conversationContext)
			: "";
	const input =
		mode === "judge"
			? judgeInput(step.acceptanceCriteria ?? "", step.useSubagent)
			: `${preamble}${step.description}${criteriaNote(step.acceptanceCriteria)}${subagentInstruction(step.useSubagent)}${
					options.retryReason ? retryNote(options.retryReason) : ""
				}${options.timedOut ? TIMEOUT_NOTE : ""}`;
	try {
		const res = await fetch(workflow.hookUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-webhook-secret": workflow.secret,
				// awb resumes that Claude session (`claude --resume`) instead of
				// starting fresh whenever we have one to resume — i.e. every step
				// after the first, and every judge pass.
				...(sessionToResume ? { sessionid: sessionToResume } : {}),
			},
			body: JSON.stringify({ jobId: step.id, input, callbackUrl, startedCallbackUrl }),
			signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
		});
		if (res.ok) {
			// In judge mode the step is already `running` in its judge phase, so
			// this is a no-op (it only acts on a `pending` step) — the exec dispatch
			// is what it's really for. Mark the step `queued` (NOT `running`): the
			// broker accepted the POST, but the run hasn't started yet — it may be
			// waiting on the workdir `flock` behind another run. The broker's
			// `started` callback flips it to `running` and starts the timeout clock
			// at the real run start (fair to queued steps).
			markStepQueued(step.id, options.manual ?? false);
			log(`step ${step.id} (workflow ${workflow.id}, ${mode}) -> '${workflow.agentName}' accepted (queued)`);
		} else {
			completeStep(step.id, { ok: false, error: `hook answered ${res.status}` });
			log(`step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' rejected (${res.status})`, "error");
		}
	} catch (err) {
		completeStep(step.id, { ok: false, error: `hook unreachable: ${String(err)}` });
		log(`step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' unreachable: ${String(err)}`, "error");
	}
}
