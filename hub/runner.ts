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
 * delegated by imitation. Exactly one of the three instructions below is always
 * appended, so a step never has to be guessed about.
 *
 * The third one is the context-pressure override (see context-pressure.ts): an
 * inline step dispatched onto a session that is already more than 60% full is
 * delegated anyway, because pouring its working context into a crowded thread
 * is what degrades the agent's thinking for this step and every step after it.
 *
 * Two things here exist because that shared conversation is not permanent. It
 * gets COMPACTED — the harness drops the earlier turns and keeps a summary —
 * and when that happens the agent stops being able to see the steps before it.
 * So every exec prompt names the on-disk copy of the prior steps' results
 * (step-results.ts), and a dispatch onto a conversation that has been compacted
 * since we last used it re-states the workflow's conversation context
 * (compaction.ts), which the once-only `context_injected` guard would otherwise
 * never allow again short of a full restart.
 */
import { attachmentSection, listFieldAttachments } from "./attachments.ts";
import { hookRuntime } from "./awb.ts";
import { markContextReinjected, needsContextReinjection, observeCompaction } from "./compaction.ts";
import type { HubConfig } from "./config.ts";
import { CONTEXT_PRESSURE_PERCENT, shouldForceSubagent, workflowContextRatio } from "./context-pressure.ts";
import type { Attachment, Step, Workflow } from "./db.ts";
import { completeStep, markStepQueued } from "./db.ts";
import { stepResultsNote } from "./step-results.ts";

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

/**
 * The instruction for an inline step that context pressure has overridden. It
 * replaces INLINE_SUFFIX rather than being added to it — the agent must be told
 * one thing, not a configured preference and a contradiction of it — and it says
 * WHY the operator's choice was overridden, so the agent doesn't read it as a
 * mistake and "helpfully" honour the toggle it can still see in the UI.
 */
export const CONTEXT_PRESSURE_SUFFIX =
	`\n\nImportant: run this step by delegating the work to a subagent (the Task tool) instead of solving it yourself directly in this thread. This step was configured to run inline, but this session's context window is already more than ${CONTEXT_PRESSURE_PERCENT}% full, and doing the work here would crowd it further and degrade the quality of your thinking for this step and every step after it. The override is deliberate: delegate, and keep only the subagent's summary in this thread.`;

/**
 * The instruction appended to a step's exec input, per its subagent toggle —
 * unless `forced`, which is the context-pressure override taking the choice
 * away from an inline step (see context-pressure.ts). `forced` is meaningless
 * for a step that already delegates, so it's ignored when `useSubagent` is on.
 */
export function subagentInstruction(useSubagent: boolean, forced = false): string {
	if (useSubagent) return SUBAGENT_SUFFIX;
	return forced ? CONTEXT_PRESSURE_SUFFIX : INLINE_SUFFIX;
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
 *
 * `images` are the files attached to the acceptance-criteria field; they're
 * listed after the criterion so a criterion like "the panel must look like
 * this" actually has the "this" attached to it. With no criterion text and no
 * images this returns "" — an exec input with neither is byte-identical to what
 * it was before attachments existed.
 */
function criteriaNote(criteria: string | null | undefined, images: Attachment[] = []): string {
	const trimmed = (criteria ?? "").trim();
	const section = attachmentSection("attached to this step's acceptance criteria", images);
	if (!trimmed) {
		// Images pinned to the criteria field but no criterion written: still show
		// them rather than silently dropping what the operator attached, and say
		// what they are for so an unexplained image list isn't just noise.
		return section ? `\n\nThe result of this step MUST satisfy the acceptance criteria given by the attached image(s).${section}` : "";
	}
	return `\n\nThe result of this step MUST satisfy the following acceptance criterion, so aim explicitly to meet it: "${trimmed}".${section}`;
}

/**
 * Builds the conversation-context preamble prepended to the FIRST dispatch of
 * a fresh conversation (no session to resume yet). It's the workflow-level
 * background/constraints the operator wants every step to inherit. Injected
 * once: later steps resume the session, which already carries it in history,
 * so `dispatchStep` only prepends it when starting fresh AND the workflow's
 * `context_injected` guard is still false. Returns "" when there's no context.
 *
 * `images` are the files attached to the conversation-context field. They ride
 * the same once-only injection as the text: the preamble is what establishes the
 * shared background, so that's the turn the agent should be told to look at
 * them in. A context that is ONLY images (no text) still produces a preamble —
 * attaching a spec screenshot and writing nothing is a legitimate way to use
 * this, and returning "" there would throw the attachment away.
 */
function contextPreamble(context: string | null | undefined, images: Attachment[] = [], afterCompaction = false): string {
	const trimmed = (context ?? "").trim();
	const section = attachmentSection("attached to this workflow's conversation context", images);
	if (!trimmed && !section) return "";
	const body = trimmed || "(No background text — the background for this workflow is in the attached image(s) below.)";
	// A re-injection has to say it IS one. The agent may still be able to see a
	// summary of the original preamble in its compacted history, and an
	// unexplained second copy of the same background reads as either a mistake or
	// a new instruction. Saying why also tells it something true and useful: the
	// conversation it is in has lost detail, so it should trust the files on disk
	// over its recollection.
	const lead = afterCompaction
		? "This conversation was compacted, so its earlier turns have been replaced by a summary and detail has been lost. Restating the workflow's background in full — treat this as authoritative over anything you remember, and prefer re-reading the artifacts on disk over recalling them.\n\n"
		: "";
	return `${lead}Conversation context — this background applies to every step of this workflow:\n\n${body}${section}\n\n---\n\n`;
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
export function judgeInput(criteria: string, useSubagent = true, images: Attachment[] = []): string {
	const distrust = useSubagent
		? "do NOT trust your memory or the subagent's summary. The step's work was done by a subagent, so its real output may not be in this thread."
		: "do NOT trust your memory or what you said while doing the step. What this thread holds is your narration, not the real output.";
	// The images attached to the criteria are part of the criterion, so the judge
	// needs them as much as the exec pass did — grading "matches this mockup"
	// without the mockup in front of it is exactly the blind pass this prompt
	// otherwise works hard to prevent.
	const section = attachmentSection("attached to this step's acceptance criteria", images);
	return [
		"Evaluate whether the result of the previous step of this workflow meets the following acceptance criterion:",
		"",
		`"${criteria.trim()}"${section}`,
		"",
		`Important: ${distrust} Verify the criterion by inspecting the actual artifacts with your tools — read the files, run the commands, check the real state — BEFORE deciding.`,
		"",
		'Once you have verified, end your reply with a JSON object on its own final line, and nothing after it, in exactly this shape: {"ok": true|false, "reason": "<brief explanation>"}',
		'"ok" is true ONLY if you confirmed the result meets the criterion. If it does not meet it, or you could not verify it, set "ok": false and in "reason" explain concretely what is missing or what to fix. When in doubt, "ok": false.',
	].join("\n");
}

/**
 * Builds the exact string a dispatch would POST to the hook — the prompt the
 * agent receives — without sending anything.
 *
 * Split out of `dispatchStep` for two reasons. It's the one place where all
 * three attachment-bearing inputs (conversation context, task description,
 * acceptance criteria) come together, so it's what has to be asserted on to know
 * the images really reach the agent; and being side-effect free it doubles as a
 * dry run — you can ask "what would this step say?" for a workflow you have no
 * intention of running.
 *
 * `injectContext` is the caller's decision, not this function's: only
 * `dispatchStep` knows whether this dispatch starts a fresh conversation and
 * whether the workflow's once-only guard is still open.
 */
export function composeStepInput(
	step: Step,
	workflow: Workflow,
	options: {
		mode?: "exec" | "judge";
		/** Prepend the conversation-context preamble (and its images). */
		injectContext?: boolean;
		/**
		 * This injection is a RE-injection forced by a detected compaction, not the
		 * first one. Only changes the preamble's opening line — see
		 * `contextPreamble` — but that line is the difference between the agent
		 * reading a duplicate and reading an explanation.
		 */
		afterCompaction?: boolean;
		retryReason?: string;
		timedOut?: boolean;
		/**
		 * Context pressure overrode this step's inline toggle — delegate anyway.
		 * The caller's decision, not this function's: only `dispatchStep` knows
		 * which session this dispatch lands on, and it's that session's occupancy
		 * the rule is about.
		 */
		forceSubagent?: boolean;
	} = {},
): string {
	const acceptanceImages = listFieldAttachments(workflow.id, step.id, "acceptance");
	// What actually ran (or is about to): the toggle, unless pressure overrode it.
	const delegated = step.useSubagent || (options.forceSubagent ?? false);
	if ((options.mode ?? "exec") === "judge") {
		// The judge grades the exec pass, so it needs to know where that pass's
		// output really went. An overridden step's work went to a subagent even
		// though its toggle says inline — telling the judge to distrust "what you
		// said while doing the step" would point it at a thread that never held
		// the work.
		return judgeInput(step.acceptanceCriteria ?? "", delegated, acceptanceImages);
	}
	const preamble = options.injectContext
		? contextPreamble(
				workflow.conversationContext,
				listFieldAttachments(workflow.id, null, "context"),
				options.afterCompaction ?? false,
			)
		: "";
	// Straight after the description, so "do what this screenshot shows" reads as
	// one instruction rather than a task and an unrelated file list.
	const descriptionImages = attachmentSection(
		"attached to this step's task description",
		listFieldAttachments(workflow.id, step.id, "description"),
	);
	// Where the previous steps' results are on disk (see step-results.ts). On
	// EVERY exec prompt, not just the ones after a compaction: by the time the
	// hub notices a boundary the agent has already lost the history, so the
	// pointer has to have been given while the conversation was still intact.
	const priorResults = stepResultsNote(hookRuntime(workflow.hookUrl).workdir);
	return `${preamble}${step.description}${descriptionImages}${criteriaNote(
		step.acceptanceCriteria,
		acceptanceImages,
	)}${priorResults}${subagentInstruction(step.useSubagent, options.forceSubagent ?? false)}${
		options.retryReason ? retryNote(options.retryReason) : ""
	}${options.timedOut ? TIMEOUT_NOTE : ""}`;
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
	// Did the conversation we're about to resume get compacted since we last used
	// it? Read from the transcript, persisted on the workflow, and — for an exec
	// dispatch — answered by re-stating the conversation context, which the
	// once-only `context_injected` guard would otherwise never allow again. Only
	// exec: the judge is a single graded turn on a session it was just given, and
	// prefixing a workflow-wide preamble to a verdict prompt is noise.
	//
	// This costs a scan of a transcript that grows all workflow long, which is why
	// the context-pressure read below is careful to avoid one it doesn't need.
	// Paid here anyway, and unconditionally: it happens once per dispatched step,
	// and the alternative is not knowing that the agent has forgotten the workflow.
	const observed = mode === "exec" && sessionToResume ? observeCompaction(workflow, sessionToResume, log) : workflow;
	const afterCompaction = mode === "exec" && needsContextReinjection(observed);
	// The context-pressure override, measured on `sessionToResume` — the session
	// this dispatch is about to add to — and therefore only after it's known.
	// A fresh conversation has no session, so the ratio is null and the step's own
	// toggle stands: there is no pressure on a thread that doesn't exist yet.
	//
	// Only measured for a step that could be overridden. Reading it costs a full
	// scan of a transcript that grows all workflow long, and for a step already
	// delegating the answer changes nothing.
	const contextRatio = step.useSubagent ? null : workflowContextRatio(workflow, sessionToResume);
	const forceSubagent = shouldForceSubagent(step.useSubagent, contextRatio);
	// Worth a line only for the pass it actually redirects. The judge always runs
	// on this thread (its verdict has to come straight back), so there the flag
	// just keeps the prompt's wording honest about who produced the output.
	if (forceSubagent && mode === "exec") {
		log(
			`step ${step.id} (workflow ${workflow.id}) is configured inline, but session ${sessionToResume} is at ${(
				100 * (contextRatio ?? 0)
			).toFixed(1)}% context (> ${CONTEXT_PRESSURE_PERCENT}%) — delegating to a subagent anyway`,
			"warning",
		);
	}
	if (afterCompaction) {
		log(
			`step ${step.id} (workflow ${workflow.id}) resumes conversation ${sessionToResume}, which was compacted at ` +
				`${observed.lastCompactionAt} — re-injecting the workflow's conversation context`,
			"warning",
		);
	}
	const input = composeStepInput(step, observed, {
		mode,
		// Two independent reasons to inject: this is the conversation's first
		// dispatch and the guard is still open, or the conversation was compacted
		// and what was injected at the top of it is gone.
		injectContext: mode === "exec" && ((freshConversation && !workflow.contextInjected) || afterCompaction),
		afterCompaction,
		retryReason: options.retryReason,
		timedOut: options.timedOut,
		forceSubagent,
	});
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
			// The re-injected context is only "delivered" once the broker has taken
			// the input. A rejected or unreachable dispatch leaves the marker armed,
			// so the retry carries the preamble instead of silently dropping it.
			if (afterCompaction) markContextReinjected(observed);
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
