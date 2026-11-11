/**
 * Records of command-step runs: one `pipeline_runs` row per attempt, and one
 * `pipeline_run_steps` row per job step (docs/pipelines.md, "Data model").
 *
 * This module stores and reads the records. It does not run anything; the
 * executor (a later step of the phase) calls these as a run progresses. Logs are
 * kept on disk, and the row only points at them through `log_path`, so a long
 * log never lives in the database.
 */

import * as fs from "node:fs";
import { open } from "./db.ts";

export type PipelineRunConclusion = "success" | "failure";
export type PipelineRunStepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface PipelineRunStep {
	runId: string;
	/** Position in the pipeline's `steps:` list. */
	index: number;
	name: string;
	status: PipelineRunStepStatus;
	exitCode: number | null;
	startedAt: string | null;
	finishedAt: string | null;
	/** Byte offset and length of this job step's section within the run's log file. */
	logOffset: number;
	logLength: number;
}

export interface PipelineRun {
	id: string;
	stepId: string;
	workflowId: string;
	/** 1 for the first run of a command step, 2 after a retry or a Restart, and so on. */
	attempt: number;
	pipelineId: string;
	/** The `source_hash` the run executed. A later edit does not change what this run did. */
	sourceHash: string;
	conclusion: PipelineRunConclusion | null;
	cancelled: boolean;
	error: string | null;
	startedAt: string;
	finishedAt: string | null;
	logPath: string | null;
	/** Job steps in pipeline order. */
	steps: PipelineRunStep[];
}

function rowToRunStep(row: Record<string, unknown>): PipelineRunStep {
	return {
		runId: String(row.run_id),
		index: Number(row.idx),
		name: String(row.name),
		status: String(row.status) as PipelineRunStepStatus,
		exitCode: row.exit_code == null ? null : Number(row.exit_code),
		startedAt: row.started_at == null ? null : String(row.started_at),
		finishedAt: row.finished_at == null ? null : String(row.finished_at),
		logOffset: Number(row.log_offset ?? 0),
		logLength: Number(row.log_length ?? 0),
	};
}

function rowToRun(row: Record<string, unknown>, steps: PipelineRunStep[]): PipelineRun {
	return {
		id: String(row.id),
		stepId: String(row.step_id),
		workflowId: String(row.workflow_id),
		attempt: Number(row.attempt),
		pipelineId: String(row.pipeline_id),
		sourceHash: String(row.source_hash),
		conclusion: row.conclusion == null ? null : (String(row.conclusion) as PipelineRunConclusion),
		cancelled: Number(row.cancelled ?? 0) === 1,
		error: row.error == null ? null : String(row.error),
		startedAt: String(row.started_at),
		finishedAt: row.finished_at == null ? null : String(row.finished_at),
		logPath: row.log_path == null ? null : String(row.log_path),
		steps,
	};
}

function stepsOf(runId: string): PipelineRunStep[] {
	const rows = open()
		.prepare("SELECT * FROM pipeline_run_steps WHERE run_id = ? ORDER BY idx")
		.all(runId) as Record<string, unknown>[];
	return rows.map(rowToRunStep);
}

export function getPipelineRun(id: string): PipelineRun | null {
	const row = open().prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
	return row ? rowToRun(row, stepsOf(id)) : null;
}

/**
 * Starts a run: writes the run row and one `pending` row per job step, in one
 * transaction, so a crash never leaves a run with some of its steps missing.
 */
export function insertPipelineRun(input: {
	stepId: string;
	workflowId: string;
	attempt: number;
	pipelineId: string;
	sourceHash: string;
	logPath: string | null;
	steps: { index: number; name: string }[];
}): PipelineRun {
	const database = open();
	const id = crypto.randomUUID();
	const startedAt = new Date().toISOString();
	database.exec("BEGIN");
	try {
		database
			.prepare(
				`INSERT INTO pipeline_runs (id, step_id, workflow_id, attempt, pipeline_id, source_hash, conclusion, cancelled, error, started_at, finished_at, log_path)
				 VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, NULL, ?)`,
			)
			.run(id, input.stepId, input.workflowId, input.attempt, input.pipelineId, input.sourceHash, startedAt, input.logPath);
		const insertStep = database.prepare(
			"INSERT INTO pipeline_run_steps (run_id, idx, name, status, exit_code, started_at, finished_at, log_offset, log_length) VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, 0, 0)",
		);
		for (const step of input.steps) insertStep.run(id, step.index, step.name);
		database.exec("COMMIT");
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
	return getPipelineRun(id)!;
}

export function updatePipelineRunStep(
	runId: string,
	index: number,
	patch: Partial<Pick<PipelineRunStep, "status" | "exitCode" | "startedAt" | "finishedAt" | "logOffset" | "logLength">>,
): void {
	const current = stepsOf(runId).find((s) => s.index === index);
	if (!current) return;
	const next = { ...current, ...patch };
	open()
		.prepare(
			"UPDATE pipeline_run_steps SET status = ?, exit_code = ?, started_at = ?, finished_at = ?, log_offset = ?, log_length = ? WHERE run_id = ? AND idx = ?",
		)
		.run(next.status, next.exitCode, next.startedAt, next.finishedAt, next.logOffset, next.logLength, runId, index);
}

export function finishPipelineRun(
	runId: string,
	outcome: { conclusion: PipelineRunConclusion; cancelled?: boolean; error?: string | null },
): void {
	open()
		.prepare("UPDATE pipeline_runs SET conclusion = ?, cancelled = ?, error = ?, finished_at = ? WHERE id = ?")
		.run(outcome.conclusion, outcome.cancelled === true ? 1 : 0, outcome.error ?? null, new Date().toISOString(), runId);
}

/** Every attempt of one command step, oldest first, each with its job steps. */
export function listPipelineRunsForStep(stepId: string): PipelineRun[] {
	const rows = open()
		.prepare("SELECT * FROM pipeline_runs WHERE step_id = ? ORDER BY attempt, started_at")
		.all(stepId) as Record<string, unknown>[];
	return rows.map((row) => rowToRun(row, stepsOf(String(row.id))));
}

/**
 * Removes every run of a workflow: its log files first, then the rows. A log
 * file that is already gone is not an error. Returns the number of runs removed.
 */
export function deletePipelineRunsForWorkflow(workflowId: string): number {
	const database = open();
	const rows = database
		.prepare("SELECT id, log_path FROM pipeline_runs WHERE workflow_id = ?")
		.all(workflowId) as Record<string, unknown>[];
	for (const row of rows) {
		if (row.log_path != null) fs.rmSync(String(row.log_path), { force: true });
	}
	database
		.prepare("DELETE FROM pipeline_run_steps WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workflow_id = ?)")
		.run(workflowId);
	database.prepare("DELETE FROM pipeline_runs WHERE workflow_id = ?").run(workflowId);
	return rows.length;
}
