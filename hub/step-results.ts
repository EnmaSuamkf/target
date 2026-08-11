/**
 * Writes every completed step's result to disk WHERE THE AGENT CAN READ IT:
 * `~/.target/steps/<agent name>/<NN>-<slug>.md`, one file per step, in order.
 *
 * Why this exists. A workflow reuses one conversation for every step, so the
 * agent's only memory of steps 1..N-1 is the conversation itself — and the
 * moment that conversation is compacted (which is not hypothetical; real
 * free-code sessions on this machine carry `"type":"compaction"` records) the
 * earlier turns are replaced by a summary and the details are gone. The step
 * results were already persisted twice over, and neither copy helped:
 *
 *  - `steps.result` in the hub's SQLite DB — the agent has no access to it;
 *  - `~/.target/<slug>-<id>.md`, the operator's progress file — truncated to
 *    500 chars per step and never named in any prompt.
 *
 * Why NOT the workdir. These files used to be written to
 * `<workdir>/.target/steps/`, because the workdir is mounted in every sandbox
 * mode and is therefore the one directory the agent is guaranteed to see. But
 * the workdir is usually a real project the hub was merely pointed at, and the
 * hub has no business leaving a directory of its own scratch notes inside
 * somebody else's repository — awb keeps its own workdir locks outside the
 * workdir for exactly that reason. So the files live under the hub's own
 * `TARGET_HOME` instead, next to `target.db`, the progress markdown and the
 * attachments, keyed by the workflow's agent name (the same key
 * `~/.target/sandboxes/<agent name>` already uses).
 *
 * That leaves the sandbox to solve, since `$HOME` is deliberately never mounted
 * into a container: `writeStepResults` adds the workflow's own results
 * directory — that one directory, not the hub home — to its hook's docker
 * mounts, so a containerised step opens the exact absolute path the prompt
 * names, the same way it does on the host.
 *
 * Writing is idempotent and best-effort. A read-only or full disk can refuse
 * the write, which is no reason to fail a step that has already succeeded, so
 * it's swallowed. The prompt says "read these files if they're there", never
 * "these files exist".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureHookMounts } from "./awb.ts";
import { targetDir } from "./config.ts";
import { type Step, slugify, type Workflow } from "./db.ts";

/** Where every workflow's step results live, relative to `TARGET_HOME`. */
export const STEP_RESULTS_SUBDIR = "steps";

/** Absolute path of the directory a workflow's step results are written to. */
export function stepResultsDir(agentName: string): string {
	return path.join(targetDir(), STEP_RESULTS_SUBDIR, agentName);
}

/**
 * Filename for one step: `<NN>-<slug>.md`.
 *
 * `NN` is the step's 1-based position zero-padded to two digits, so a plain
 * `ls` sorts the files into workflow order — the order the agent needs to read
 * them in. The slug comes from the step's description so the listing is
 * readable without opening anything, and is capped at 60 characters because a
 * step description can be a paragraph and a 4KB filename is not a filename.
 */
export function stepResultFileName(step: Step): string {
	const position = String(step.orderIndex + 1).padStart(2, "0");
	const slug = slugify(step.description).slice(0, 60).replace(/-+$/, "") || "step";
	return `${position}-${slug}.md`;
}

/** Absolute path of one step's result file. */
export function stepResultPath(agentName: string, step: Step): string {
	return path.join(stepResultsDir(agentName), stepResultFileName(step));
}

/**
 * The file's body: a short header saying which step this was and how it ended,
 * then the result verbatim. The header matters — an agent reading
 * `07-run-the-migration.md` after a compaction needs to know whether that step
 * passed its acceptance criterion or merely produced text.
 */
function stepResultDocument(workflow: Workflow, step: Step): string {
	const lines = [
		`# Step ${step.orderIndex + 1}: ${step.description}`,
		"",
		`- Workflow: ${workflow.name}`,
		`- Status: ${step.status}`,
	];
	if (step.acceptanceCriteria) lines.push(`- Acceptance criterion: ${step.acceptanceCriteria}`);
	if (step.finishedAt) lines.push(`- Finished: ${step.finishedAt}`);
	lines.push("", "## Result", "", step.result ?? "", "");
	return lines.join("\n");
}

/**
 * Writes the result files for every step of `workflow` that has one, and
 * returns the paths written.
 *
 * Rewrites rather than appends, so a re-run of a step overwrites its file with
 * what the step now says instead of leaving two contradictory answers in it.
 * Skips a file whose bytes are already identical, so the common case (this is
 * called from `writeStatusMd`, which runs on every state transition) doesn't
 * rewrite the whole directory on every transition.
 */
export function writeStepResults(workflow: Workflow, steps: Step[]): string[] {
	const dir = stepResultsDir(workflow.agentName);
	const written: string[] = [];
	// Task steps only. The hub-owned context step's "result" is a one-line
	// acknowledgement, and its order index is -1, so it would land as `00-….md` in
	// the very directory the prompt tells the agent to trust for "what earlier
	// steps actually produced" — noise at best, and at worst a file that reads like
	// a step-zero nobody wrote.
	const withResults = steps.filter(
		(step) => step.kind !== "context" && step.result !== null && step.result !== "",
	);
	if (withResults.length === 0) return [];
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		// Unwritable TARGET_HOME — nothing to write to.
		return [];
	}
	// After the mkdir, never before: docker replaces a bind-mount source that
	// doesn't exist with a root-owned directory the hub could no longer write to.
	// A no-op for host and remote hooks, and idempotent for the docker ones.
	ensureHookMounts(workflow.hookUrl, [dir]);
	for (const step of withResults) {
		const file = stepResultPath(workflow.agentName, step);
		const body = stepResultDocument(workflow, step);
		try {
			if (fs.readFileSync(file, "utf8") === body) continue;
		} catch {
			// Not there yet (or unreadable) — fall through and write it.
		}
		try {
			fs.writeFileSync(file, body);
			written.push(file);
		} catch {
			// Read-only mount, full disk, permissions: the step still succeeded, and
			// losing its on-disk copy must not turn that into a failure.
		}
	}
	return written;
}

/**
 * The sentence appended to every exec prompt telling the agent where the files
 * are. Naming the directory is the entire point of writing it: a file the agent
 * is never told about is exactly as useful as the DB row it can't reach.
 *
 * Always the absolute path, and always the host's: it is identical inside and
 * outside the container, because the hook bind-mounts that directory at its own
 * path (see `writeStepResults`).
 */
export function stepResultsNote(agentName: string): string {
	return (
		`\n\nPrior steps' results are on disk at \`${stepResultsDir(agentName)}/\` — one \`<NN>-<slug>.md\` file per ` +
		"completed step of this workflow, numbered in order, each holding that step's full result. This one conversation " +
		"is reused for every step and can be compacted at any time, which replaces its earlier turns with a summary: when " +
		"you need to know what an earlier step actually produced, read those files instead of relying on your memory of " +
		"this thread."
	);
}
