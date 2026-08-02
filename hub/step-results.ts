/**
 * Writes every completed step's result to disk WHERE THE AGENT CAN READ IT:
 * `<workdir>/.target/steps/<NN>-<slug>.md`, one file per step, in order.
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
 *    500 chars per step, never named in any prompt, and living under `$HOME`,
 *    which the docker sandbox deliberately never mounts (see
 *    vendor/agent-webhook-bridge/adapters/spawn-runner/sandbox.ts). Under
 *    `sandbox: docker` the agent cannot open it even if it knew it existed.
 *
 * The workdir, by contrast, is mounted in every sandbox mode — it's the one
 * directory the agent is guaranteed to see. So the agent-facing copy goes
 * there: no new mount, no change to the security posture, nothing the agent
 * couldn't already read. The operator-facing `~/.target/<slug>-<id>.md` is
 * untouched and stays truncated; these files are the untruncated ones, because
 * "read what step 3 actually produced" is useless if step 3's result stops at
 * 500 characters.
 *
 * Writing is idempotent and best-effort. A remote hook has no local workdir and
 * a read-only mount can refuse the write; neither is a reason to fail a step
 * that has already succeeded, so both are swallowed. The prompt says "read
 * these files if they're there", never "these files exist".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hookRuntime } from "./awb.ts";
import { type Step, slugify, type Workflow } from "./db.ts";

/**
 * Where the files live, relative to the workdir. `.target/` mirrors the hub's
 * own `~/.target` naming so it reads as "the hub's scratch space" inside a repo
 * the agent also works in, and a dot-directory keeps it out of the way of
 * whatever the workflow is actually building.
 */
export const STEP_RESULTS_SUBDIR = path.join(".target", "steps");

/** Absolute path of the directory a workflow's step results are written to. */
export function stepResultsDir(workdir: string): string {
	return path.join(workdir, STEP_RESULTS_SUBDIR);
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
export function stepResultPath(workdir: string, step: Step): string {
	return path.join(stepResultsDir(workdir), stepResultFileName(step));
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
 * churn the workdir's mtimes — progress.ts watches the workdir for signs of
 * life, and the hub touching files there would be the hub reporting itself as
 * the agent working.
 */
export function writeStepResults(workflow: Workflow, steps: Step[]): string[] {
	const workdir = hookRuntime(workflow.hookUrl).workdir;
	if (!workdir) return [];
	const written: string[] = [];
	const withResults = steps.filter((step) => step.result !== null && step.result !== "");
	if (withResults.length === 0) return [];
	try {
		fs.mkdirSync(stepResultsDir(workdir), { recursive: true });
	} catch {
		// No workdir on disk (never run, or removed under us) — nothing to write to.
		return [];
	}
	for (const step of withResults) {
		const file = stepResultPath(workdir, step);
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
 * is never told about is exactly as useful as the `~/.target` copy it can't
 * reach.
 *
 * Absolute when the hook is local (that's the path the agent will actually
 * type, and it's identical inside and outside the container — the sandbox
 * mounts the workdir at its own path), and workdir-relative otherwise, since a
 * remote hook's absolute path is not ours to guess.
 */
export function stepResultsNote(workdir: string | null): string {
	const dir = workdir ? stepResultsDir(workdir) : STEP_RESULTS_SUBDIR;
	return (
		`\n\nPrior steps' results are on disk at \`${dir}/\` — one \`<NN>-<slug>.md\` file per completed step of this ` +
		"workflow, numbered in order, each holding that step's full result. This one conversation is reused for every " +
		"step and can be compacted at any time, which replaces its earlier turns with a summary: when you need to know " +
		"what an earlier step actually produced, read those files instead of relying on your memory of this thread."
	);
}
