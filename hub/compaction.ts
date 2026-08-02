/**
 * Noticing that the workflow's one shared conversation was compacted, and
 * putting the agent back on its feet when it was.
 *
 * The problem this closes. Every step of a workflow resumes the SAME session,
 * so the conversation only ever grows; when it hits the model's limit the
 * harness compacts it — earlier turns are dropped and replaced by a summary.
 * The session id survives (verified against real transcripts: Claude Code
 * writes the boundary into the same `.jsonl` under the same sessionId), so
 * `--resume` keeps working and nothing looks broken. What silently stops being
 * true is everything the hub established in that conversation ONCE, at the top:
 * the workflow's conversation-context preamble, injected before the first step
 * and never again because `context_injected` was closed forever by
 * `chainSession`. After a compaction the agent is running under a workflow
 * whose stated background it can no longer see, and no operator is told.
 *
 * The fix has two halves, and they're deliberately separate:
 *
 *  - **Observation** (`observeCompaction`) is read-only and cheap-ish: it scans
 *    the transcript the hub already scans for token usage (transcript.ts, one
 *    pass, one reader per harness format) and persists the newest boundary
 *    timestamp on the workflow. Called from the dispatch path and from the
 *    session-info read the UI polls, so an operator sees the compaction whether
 *    or not another step ever runs.
 *  - **Recovery** (`needsContextReinjection` → `markContextReinjected`) is the
 *    reaction: the next exec dispatch re-injects the conversation context, and
 *    only once per boundary. This is the part that had to work WITHOUT
 *    `restartWorkflow` — restart is the existing way to get a fresh preamble and
 *    it discards every step's progress, which is a terrible trade for "the
 *    conversation got long".
 *
 * Both halves are best-effort by construction. No transcript, a remote hook
 * with no local workdir, an unreadable file: `boundaryFor` returns null and the
 * hub behaves exactly as it did before any of this existed.
 */
import { hookRuntime } from "./awb.ts";
import { getWorkflow, markCompactionHandled, recordCompaction, type Workflow } from "./db.ts";
import type { Logger } from "./runner.ts";
import { readTokenUsage } from "./transcript.ts";

/**
 * Timestamp of the newest compaction boundary in `sessionId`'s transcript, or
 * null when there is none / it can't be read.
 *
 * Both harness formats are handled by transcript.ts's per-format readers, and
 * the free-code one carries no token metadata at all — the signal is the
 * record's presence and its timestamp, nothing else. That's the whole reason
 * this returns a timestamp rather than, say, a drop in occupancy: a
 * token-derived signal would work for claude and be undetectable for free-code,
 * which is precisely the harness where compaction has already been observed in
 * the wild.
 */
export function boundaryFor(workdir: string | null, sessionId: string | null): string | null {
	if (!workdir || !sessionId) return null;
	return readTokenUsage(workdir, sessionId).lastCompactionAt;
}

/**
 * Reads `sessionId`'s transcript, persists any compaction boundary newer than
 * the one already on the workflow, and returns the workflow as it now stands.
 *
 * Returns the passed-in workflow untouched when there's nothing new, so callers
 * can use the result unconditionally. Logs only on a boundary the hub hadn't
 * seen before — `recordCompaction` answers that question in SQL, so re-reading
 * the same transcript every two seconds doesn't produce a log line every two
 * seconds.
 */
export function observeCompaction(workflow: Workflow, sessionId: string | null, log?: Logger): Workflow {
	const at = boundaryFor(hookRuntime(workflow.hookUrl).workdir, sessionId);
	if (!at) return workflow;
	if (!recordCompaction(workflow.id, at)) return workflow;
	log?.(
		`workflow ${workflow.id}: conversation ${sessionId} was compacted at ${at} — its earlier history is now a summary; ` +
			"the conversation context will be re-injected on the next step",
		"warning",
	);
	return getWorkflow(workflow.id) ?? workflow;
}

/**
 * Whether the next exec dispatch has to re-state the conversation context.
 *
 * True exactly when a boundary has been observed that hasn't been recovered
 * from yet. Comparing the two timestamps rather than keeping a boolean is what
 * makes a SECOND compaction — the normal case in a long workflow — arm the
 * recovery again after the first one was handled.
 */
export function needsContextReinjection(workflow: Workflow): boolean {
	return workflow.lastCompactionAt !== null && workflow.lastCompactionAt !== workflow.compactionHandledAt;
}

/**
 * Closes the loop for the boundary currently on the workflow: this dispatch
 * carried the re-injected context, so nothing more is owed until the next
 * compaction.
 *
 * Called even when the workflow has no conversation context to re-inject. There
 * is nothing to re-state in that case, but leaving the marker armed would make
 * every subsequent dispatch re-decide the same "nothing to do" forever, and
 * would keep telling the operator about a compaction that has already been
 * accounted for.
 */
export function markContextReinjected(workflow: Workflow): void {
	markCompactionHandled(workflow.id, workflow.lastCompactionAt);
}
