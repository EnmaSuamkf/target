/**
 * The block a finished command step hands to the agent (docs/pipelines.md,
 * "What the agent receives"). Pure: no database, no filesystem. The engine
 * stores the text on the step and writes it to the step-results directory; the
 * tests and step 7 build it through this same function.
 *
 * Why a plain text block rather than structured data: the agent reads it as
 * part of its prompt, and the same text is what `<NN>-<slug>.md` keeps for
 * compaction recovery. The shape is fixed so a reader can scan it: one header
 * line, one line per job step, then the log tails that matter.
 */
import * as path from "node:path";
import type { Step } from "./db.ts";
import type { JobStepState } from "./pipeline-runner.ts";
import { stepResultFileName, stepResultsDir } from "./step-results.ts";

/** The whole block is capped at this size. Sized so a few command steps still leave room in a prompt. */
export const REPORT_MAX_BYTES = 16 * 1024;

const TRUNCATED_NOTE = "\n[… report truncated to fit 16 KiB; the full log has everything]\n";

export interface PipelineReportInput {
	pipelineName: string;
	conclusion: "success" | "failure";
	cancelled: boolean;
	/** The run-level error (timeout, missing secret, …), when there is one that no job step explains. */
	error?: string;
	steps: JobStepState[];
	/** Absolute path of the full redacted log. */
	logPath: string;
}

function durationMs(step: JobStepState): number | null {
	if (!step.startedAt || !step.finishedAt) return null;
	const ms = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
	return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Whole seconds, the way a human scans a CI job list. Sub-second steps read as `0s`. */
function formatDuration(step: JobStepState): string {
	const ms = durationMs(step);
	return ms == null ? "" : `${Math.round(ms / 1000)}s`;
}

/**
 * Where a command step's full log goes: `<NN>-<slug>.log`, next to its
 * `<NN>-<slug>.md`, so the two files of one step sort together.
 */
export function commandLogPath(agentName: string, step: Step): string {
	return path.join(stepResultsDir(agentName), stepResultFileName(step).replace(/\.md$/, ".log"));
}

function marker(status: JobStepState["status"]): string {
	if (status === "success") return "✓";
	if (status === "failed") return "✗";
	return "–";
}

/** The `Tests exit 1` column: the exit code for a failure, the reason otherwise. */
function outcomeText(step: JobStepState): string {
	if (step.status !== "failed") return "";
	if (step.error) return step.error;
	return step.exitCode == null ? "failed" : `exit ${step.exitCode}`;
}

/** Non-empty lines in a tail. */
function lineCount(text: string): number {
	return text.split("\n").filter((l) => l !== "").length;
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
function cutToBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
	// A split multi-byte character decodes to U+FFFD at the very end; drop it.
	return cut.replace(/�+$/, "");
}

export function buildPipelineReport(input: PipelineReportInput): string {
	const failed = input.steps.filter((s) => s.status === "failed");
	const tolerated = failed.filter((s) => s.continueOnError).length;

	const headerParts: string[] = [input.conclusion];
	if (input.cancelled) headerParts.push("cancelled");
	const suffix =
		tolerated > 0 ? ` (${tolerated} tolerated failure${tolerated === 1 ? "" : "s"})` : "";
	const lines: string[] = [
		`The hub ran the pipeline "${input.pipelineName}" before this step: ${headerParts.join(", ")}${suffix}.`,
	];
	// A run-level error that no job step explains (a timeout, a missing secret)
	// would otherwise be invisible to the agent.
	if (input.error && failed.length === 0) lines.push(`Error: ${input.error}`);
	lines.push("");

	const nameWidth = Math.max(0, ...input.steps.map((s) => s.name.length));
	const outcomeWidth = Math.max(0, ...input.steps.map((s) => outcomeText(s).length));
	for (const step of input.steps) {
		const continued = step.continueOnError && step.status === "failed" ? " (continue-on-error)" : "";
		const line = `  ${marker(step.status)} ${step.name.padEnd(nameWidth)}  ${outcomeText(step).padEnd(outcomeWidth)}  ${formatDuration(step)}${continued}`;
		lines.push(line.replace(/\s+$/, ""));
	}

	// The log section: every failed job step, and every job step that asked for
	// its output (`report` is true by default). Steps that never ran have no tail.
	const sections: string[] = [];
	for (const step of input.steps) {
		if (!step.tail) continue;
		if (step.status !== "failed" && !step.report) continue;
		const heading =
			step.status === "failed"
				? `--- ${step.name}: last ${lineCount(step.tail)} ${lineCount(step.tail) === 1 ? "line" : "lines"} ---`
				: `--- ${step.name} ---`;
		sections.push(`${heading}\n${step.tail.replace(/\n+$/, "")}`);
	}
	if (sections.length > 0) lines.push("", sections.join("\n"));

	const footer = `\n\nFull log: ${input.logPath}`;
	const body = lines.join("\n");
	const room = REPORT_MAX_BYTES - Buffer.byteLength(footer, "utf8");
	if (Buffer.byteLength(body, "utf8") <= room) return body + footer;
	// Over the cap: keep the header and as much of the log as fits, then say so.
	return cutToBytes(body, room - Buffer.byteLength(TRUNCATED_NOTE, "utf8")) + TRUNCATED_NOTE.replace(/\n$/, "") + footer;
}

/** Per job step, for the events: name, status and duration only. Never log text. */
export function jobStepSummaries(steps: JobStepState[]): { name: string; status: string; duration_ms: number | null }[] {
	return steps.map((s) => ({ name: s.name, status: s.status, duration_ms: durationMs(s) }));
}
