/**
 * The context-pressure override: when the shared session is already mostly
 * full, a step runs in a subagent even if its own "Use subagent" toggle says
 * inline.
 *
 * Why it exists: every step of a workflow resumes the SAME Claude session, so
 * the conversation only ever grows. An inline step pours its whole working
 * context — every file it read, every command it ran — into that thread, and
 * once the window is crowded the agent's reasoning degrades (and the next
 * steps inherit the degraded thread). Delegating leaves only the subagent's
 * final summary behind, so it's the escape hatch that keeps the shared session
 * usable.
 *
 * The rule is deliberately one-way: pressure can only turn delegation ON. A
 * step whose toggle is already ON is unaffected, and nothing here can ever make
 * a delegated step run inline. Below the threshold the operator's toggle is
 * honoured exactly as before, so a workflow that never fills its window behaves
 * identically to one from before this existed.
 *
 * Measurement is the same read-only transcript scan the `/context` meter in the
 * UI uses (see transcript.ts): no API call, no extra state, just the occupancy
 * of the session's last turn. When it can't be measured — no session yet, a
 * remote hook with no local workdir, a transcript that doesn't exist — the
 * answer is "not pressured", so an unmeasurable session never silently
 * overrides what the operator asked for.
 */
import { hookRuntime } from "./awb.ts";
import type { Workflow } from "./db.ts";
import { readTokenUsage } from "./transcript.ts";

/**
 * Fraction of the context window above which delegation becomes mandatory.
 * 0.6 = the operator's "over 60%" rule. The comparison is strictly greater, so
 * a session sitting exactly at 60.0% still runs the step as configured.
 */
export const CONTEXT_PRESSURE_RATIO = 0.6;

/** The threshold as a whole-number percentage, for prompts and log lines. */
export const CONTEXT_PRESSURE_PERCENT = Math.round(CONTEXT_PRESSURE_RATIO * 100);

/**
 * Context occupancy of `sessionId` as a fraction of its window (0–1), or null
 * when it can't be measured: no session to resume (a fresh conversation starts
 * empty), no local workdir to find the transcript in, or a transcript with no
 * turns yet. Null is not zero — it means "unknown", and every caller treats
 * unknown as "no override".
 */
export function sessionContextRatio(workdir: string | null, sessionId: string | null): number | null {
	if (!workdir || !sessionId) return null;
	const usage = readTokenUsage(workdir, sessionId);
	// turns === 0 is a missing/empty transcript; a non-positive window would make
	// the division meaningless. Either way we know nothing about occupancy.
	if (usage.turns === 0 || usage.contextWindow <= 0) return null;
	return usage.contextTokens / usage.contextWindow;
}

/** Same, for the session a workflow's next dispatch would resume — resolves the workdir from its hook. */
export function workflowContextRatio(workflow: Workflow, sessionId: string | null): number | null {
	return sessionContextRatio(hookRuntime(workflow.hookUrl).workdir, sessionId);
}

/** Whether a measured ratio is over the threshold. An unmeasurable ratio (null) is never pressure. */
export function isContextPressured(ratio: number | null): boolean {
	return ratio !== null && ratio > CONTEXT_PRESSURE_RATIO;
}

/**
 * The decision itself: should this dispatch be delegated to a subagent even
 * though the step is configured to run inline?
 *
 * Only ever asked about a step whose toggle is OFF — for a step that already
 * delegates there is nothing to override — which is why this returns false the
 * moment `useSubagent` is true, rather than reading the transcript for nothing.
 */
export function shouldForceSubagent(useSubagent: boolean, ratio: number | null): boolean {
	return !useSubagent && isContextPressured(ratio);
}
