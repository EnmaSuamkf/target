/**
 * The pipeline executor (docs/pipelines.md, "Where a pipeline runs", "Execution
 * and failure", "Secrets", "Expressions").
 *
 * It runs one pipeline as a sequence of job steps on the host, in the workflow's
 * workdir, the way a CI job runs. It knows nothing about workflows, the database
 * or the HTTP layer: everything it needs is an argument, so it can be tested with
 * real shell commands and no hub. The workflow engine calls it, persists the job
 * step states it reports, and turns the run's conclusion into a step result.
 *
 * Three rules shape the file:
 *  - Every byte that reaches the log or the in-memory tail has passed through
 *    `redactSecrets`. Output is split into whole lines first, so a secret cut in
 *    two by a read boundary is still caught.
 *  - Each job step is its own process group, so a timeout or an abort kills the
 *    whole tree it started, not only the shell.
 *  - Nothing starts until every secret, input and working directory is resolved
 *    and checked. A bad one ends the run before the first command runs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets, registerSecret } from "./redact.ts";
import type { PipelineJobStep, PipelineShell, PipelineSpec } from "./pipeline-yaml.ts";

/** A runaway command cannot fill the disk: the log stops at this size, with a marker. */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
/** How many trailing lines of each job step are kept in memory for the report. */
export const TAIL_LINES = 80;
/** Time between SIGTERM and SIGKILL when a process group is asked to stop. */
export const KILL_GRACE_MS = 5000;

export type JobStepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface JobStepState {
	idx: number;
	name: string;
	status: JobStepStatus;
	exitCode: number | null;
	startedAt: string | null;
	finishedAt: string | null;
	/** Byte offset of this job step's section (its header line) in the log file. */
	logOffset: number;
	/** Bytes this section occupies, header included. 0 when nothing was written. */
	logLength: number;
	report: boolean;
	continueOnError: boolean;
	/** The last lines of output, redacted, for the agent's report. */
	tail: string;
	/** Why the step failed, when it did not simply exit non-zero. */
	error?: string;
}

export interface PipelineRunResult {
	sourceHash: string;
	conclusion: "success" | "failure";
	/** True when the run was stopped by an abort or by the pipeline's own timeout. */
	cancelled: boolean;
	error?: string;
	steps: JobStepState[];
}

export interface RunPipelineOptions {
	spec: PipelineSpec;
	sourceHash: string;
	/** The command step's values, keyed by the pipeline's input names. */
	inputs: Record<string, string>;
	workflow: { id: string; name: string; workdir: string };
	/** The workflow's step-results directory (`${{ step.results_dir }}`). */
	resultsDir: string;
	/** Where the redacted log is written. Its directory is created if needed. */
	logPath: string;
	/**
	 * Returns the values for the named secrets, or throws. A throw ends the run
	 * before any job step starts, with the thrown message as the run's error.
	 */
	resolveSecrets: (names: string[]) => Record<string, string>;
	/** Aborting it kills the running job step's process group and cancels the run. */
	signal?: AbortSignal;
	/** Called on every status change of every job step, with a copy of its state. */
	onJobStep?: (step: JobStepState) => void;
}

/** A problem the run cannot start with: reported as the run's error, never thrown out of `runPipeline`. */
class PipelineRunError extends Error {}

const EXPR_RE = /\$\{\{([\s\S]*?)\}\}/g;
const INPUT_EXPR = /^inputs\.([A-Za-z][A-Za-z0-9_-]*)$/;
const SECRET_EXPR = /^secrets\.([A-Za-z_][A-Za-z0-9_]*)$/;

// --- Expressions ------------------------------------------------------------

interface ExpressionContext {
	inputs: Record<string, string>;
	secrets: Record<string, string>;
	workflow: { id: string; name: string; workdir: string };
	resultsDir: string;
}

/** Replaces every `${{ … }}` in a value. The validator already allowed only the documented forms. */
function expand(text: string, ctx: ExpressionContext): string {
	return text.replace(EXPR_RE, (_whole, inner: string) => {
		const expr = inner.trim();
		const input = INPUT_EXPR.exec(expr);
		if (input) {
			if (!Object.hasOwn(ctx.inputs, input[1])) throw new PipelineRunError(`input "${input[1]}" is not declared`);
			return ctx.inputs[input[1]];
		}
		const secret = SECRET_EXPR.exec(expr);
		if (secret) {
			if (!Object.hasOwn(ctx.secrets, secret[1])) throw new PipelineRunError(`missing secret: ${secret[1]}`);
			return ctx.secrets[secret[1]];
		}
		switch (expr) {
			case "workflow.workdir":
				return ctx.workflow.workdir;
			case "workflow.id":
				return ctx.workflow.id;
			case "workflow.name":
				return ctx.workflow.name;
			case "step.results_dir":
				return ctx.resultsDir;
			default:
				throw new PipelineRunError(`expression "${expr}" is not supported`);
		}
	});
}

/** Every secret name a pipeline refers to, from the places a secret may appear. */
function secretNamesOf(spec: PipelineSpec): string[] {
	const names = new Set<string>();
	const scan = (text: string) => {
		for (const m of text.matchAll(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) names.add(m[1]);
	};
	for (const value of Object.values(spec.env)) scan(value);
	for (const step of spec.steps) {
		for (const value of Object.values(step.env)) scan(value);
	}
	return [...names];
}

// --- Inputs and paths -------------------------------------------------------

/** `INPUT_<NAME>` as a script reads it: upper-case, `-` become `_`. */
export function inputEnvName(name: string): string {
	return `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * The values the run uses: what the command step gave, else the declared
 * default, else an error for a required input. A value for an undeclared input is
 * an error here too, in case a stored step predates a change to the pipeline.
 */
function resolveInputValues(spec: PipelineSpec, provided: Record<string, string>): Record<string, string> {
	for (const key of Object.keys(provided)) {
		if (!Object.hasOwn(spec.inputs, key)) throw new PipelineRunError(`input "${key}" is not declared`);
	}
	const values: Record<string, string> = {};
	for (const [name, declared] of Object.entries(spec.inputs)) {
		const value = Object.hasOwn(provided, name) ? provided[name] : declared.default;
		if (value === null || value === undefined) {
			if (declared.required) throw new PipelineRunError(`missing input "${name}"`);
			values[name] = "";
		} else {
			values[name] = value;
		}
	}
	return values;
}

/**
 * The real path nearest to `p`: resolves symlinks in every part that exists, so a
 * link inside the workdir that points outside it is seen for what it is.
 */
function realpathLoose(p: string): string {
	let current = path.resolve(p);
	const rest: string[] = [];
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		rest.unshift(path.basename(current));
		current = parent;
	}
	let real: string;
	try {
		real = fs.realpathSync(current);
	} catch {
		real = current;
	}
	return path.join(real, ...rest);
}

/** True when `target` is `root` or lies beneath it. Both must already be real paths. */
function isInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	if (rel === "") return true;
	if (path.isAbsolute(rel)) return false;
	return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * Resolves each job step's working directory and refuses one that lands outside
 * the workdir. Checked for every step before any runs, so a bad path cannot
 * surface halfway through a pipeline.
 */
function resolveWorkingDirectories(spec: PipelineSpec, ctx: ExpressionContext): Map<number, string> {
	const realWorkdir = realpathLoose(ctx.workflow.workdir);
	const out = new Map<number, string>();
	for (const step of spec.steps) {
		const raw = expand(step.workingDirectory, ctx);
		const resolved = path.resolve(ctx.workflow.workdir, raw);
		if (!isInside(realWorkdir, realpathLoose(resolved))) {
			throw new PipelineRunError(
				`working-directory "${raw}" of "${step.name}" is outside the workflow's workdir`,
			);
		}
		out.set(step.index, resolved);
	}
	return out;
}

// --- The run ----------------------------------------------------------------

/** The command line for one job step's shell, as the doc specifies. */
export function shellCommand(shell: PipelineShell, run: string): { cmd: string; args: string[] } {
	switch (shell) {
		case "bash":
			return { cmd: "bash", args: ["--noprofile", "--norc", "-eo", "pipefail", "-c", run] };
		case "sh":
			return { cmd: "sh", args: ["-e", "-c", run] };
		case "pwsh":
			return { cmd: "pwsh", args: ["-NoProfile", "-Command", run] };
	}
}

/** Sends a signal to the whole process group a job step started. A group that is already gone is not an error. */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		// ESRCH: every member has already exited.
	}
}

/** Appends to the log, byte-counted, and stops at the cap with one marker line. */
class LogFile {
	private fd: number;
	private size = 0;
	private truncated = false;

	constructor(logPath: string) {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		this.fd = fs.openSync(logPath, "w", 0o600);
	}

	get bytes(): number {
		return this.size;
	}

	/** Writes text, or the cap marker once when the text would pass the cap. Returns false when nothing was written. */
	write(text: string): boolean {
		if (this.truncated) return false;
		const length = Buffer.byteLength(text, "utf8");
		if (this.size + length > MAX_LOG_BYTES) {
			const marker = `\n[log truncated: the run's output passed ${MAX_LOG_BYTES / (1024 * 1024)} MiB]\n`;
			fs.writeSync(this.fd, marker);
			this.size += Buffer.byteLength(marker, "utf8");
			this.truncated = true;
			return false;
		}
		fs.writeSync(this.fd, text);
		this.size += length;
		return true;
	}

	close(): void {
		fs.closeSync(this.fd);
	}
}

/** Keeps the last `TAIL_LINES` complete lines. The input is already redacted. */
class Tail {
	private lines: string[] = [];

	push(line: string): void {
		this.lines.push(line);
		if (this.lines.length > TAIL_LINES) this.lines.shift();
	}

	text(): string {
		return this.lines.join("\n");
	}
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineRunResult> {
	const { spec, sourceHash, workflow, resultsDir, logPath, onJobStep } = options;
	const steps: JobStepState[] = spec.steps.map((step) => ({
		idx: step.index,
		name: step.name,
		status: "pending",
		exitCode: null,
		startedAt: null,
		finishedAt: null,
		logOffset: 0,
		logLength: 0,
		report: step.report,
		continueOnError: step.continueOnError,
		tail: "",
	}));
	const notify = (state: JobStepState) => onJobStep?.({ ...state });

	// Everything that can stop a run before it starts is resolved here: secrets,
	// inputs, working directories. Any failure ends the run with every job step
	// skipped and nothing spawned.
	let inputs: Record<string, string>;
	let secrets: Record<string, string>;
	let workingDirs: Map<number, string>;
	try {
		inputs = resolveInputValues(spec, options.inputs);
		const names = secretNamesOf(spec);
		secrets = names.length > 0 ? options.resolveSecrets(names) : {};
		for (const value of Object.values(secrets)) registerSecret(value);
		const ctx: ExpressionContext = { inputs, secrets, workflow, resultsDir };
		workingDirs = resolveWorkingDirectories(spec, ctx);
	} catch (err) {
		for (const s of steps) {
			s.status = "skipped";
			notify(s);
		}
		return {
			sourceHash,
			conclusion: "failure",
			cancelled: false,
			error: err instanceof Error ? err.message : String(err),
			steps,
		};
	}
	const ctx: ExpressionContext = { inputs, secrets, workflow, resultsDir };

	// The run's own signal: the caller's abort, or the pipeline's timeout. Both
	// cancel the run the same way, so a job step only ever sees one kind of stop.
	const runAbort = new AbortController();
	let runTimedOut = false;
	const onExternalAbort = () => runAbort.abort();
	if (options.signal?.aborted) runAbort.abort();
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });
	const runTimer = setTimeout(() => {
		runTimedOut = true;
		runAbort.abort();
	}, spec.timeoutMinutes * 60_000);

	const log = new LogFile(logPath);
	let failedUntolerated = false;
	let firstError: string | undefined;
	try {
		for (const step of spec.steps) {
			const state = steps[step.index];
			const cancelled = runAbort.signal.aborted;

			// GitHub Actions conditions. A cancelled run runs nothing further, not even
			// `always()`, because the caller asked for the run to stop.
			const shouldRun =
				!cancelled &&
				(step.if === "always()" || (step.if === "failure()" ? failedUntolerated : !failedUntolerated));
			if (!shouldRun) {
				state.status = "skipped";
				notify(state);
				continue;
			}

			const result = await runJobStep({
				step,
				state,
				cwd: workingDirs.get(step.index) ?? workflow.workdir,
				env: buildEnv(spec, step, inputs, ctx),
				log,
				runAbort,
				notify,
			});
			if (result.status === "failed" && !step.continueOnError) {
				failedUntolerated = true;
				firstError ??= result.error ?? `step "${step.name}" failed`;
			}
		}
	} finally {
		clearTimeout(runTimer);
		options.signal?.removeEventListener("abort", onExternalAbort);
		log.close();
	}

	const cancelled = runAbort.signal.aborted;
	let error: string | undefined;
	if (cancelled) {
		error = runTimedOut ? "the pipeline's timeout-minutes was reached" : "aborted";
	} else if (failedUntolerated) {
		error = firstError;
	}
	return {
		sourceHash,
		conclusion: failedUntolerated || cancelled ? "failure" : "success",
		cancelled,
		...(error !== undefined ? { error } : {}),
		steps,
	};
}

/** Environment for one job step: the process's, then the pipeline's, then the step's, then the inputs. */
function buildEnv(
	spec: PipelineSpec,
	step: PipelineJobStep,
	inputs: Record<string, string>,
	ctx: ExpressionContext,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(spec.env)) env[key] = expand(value, ctx);
	for (const [key, value] of Object.entries(step.env)) env[key] = expand(value, ctx);
	for (const [name, value] of Object.entries(inputs)) env[inputEnvName(name)] = value;
	return env;
}

interface JobStepOutcome {
	status: "success" | "failed";
	error?: string;
}

/**
 * Runs one job step to its end: spawns the shell in its own process group,
 * streams its output through the redactor into the log, and stops the group on a
 * step timeout or a run cancellation.
 */
function runJobStep(args: {
	step: PipelineJobStep;
	state: JobStepState;
	cwd: string;
	env: NodeJS.ProcessEnv;
	log: LogFile;
	runAbort: AbortController;
	notify: (state: JobStepState) => void;
}): Promise<JobStepOutcome> {
	const { step, state, cwd, env, log, runAbort, notify } = args;
	const tail = new Tail();

	// The section starts with a header line, so `?step=<idx>` can read it on its own.
	state.logOffset = log.bytes;
	const header = `=== [${step.index}] ${step.name} ===\n`;
	log.write(redactSecrets(header));
	state.status = "running";
	state.startedAt = new Date().toISOString();
	notify(state);

	const { cmd, args: argv } = shellCommand(step.shell, step.run);
	let child: ChildProcess;
	try {
		child = spawn(cmd, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		return Promise.resolve(finishJobStep(state, log, { status: "failed", exitCode: null, error: messageOf(err) }, tail, notify));
	}

	return new Promise<JobStepOutcome>((resolve) => {
		let killReason: "timeout" | "cancelled" | null = null;
		let escalation: NodeJS.Timeout | undefined;
		let settled = false;

		const stop = (reason: "timeout" | "cancelled") => {
			if (killReason !== null) return;
			killReason = reason;
			signalGroup(child.pid, "SIGTERM");
			escalation = setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
		};
		const stepTimer = setTimeout(() => stop("timeout"), step.timeoutMinutes * 60_000);
		const onRunAbort = () => stop("cancelled");
		runAbort.signal.addEventListener("abort", onRunAbort, { once: true });
		if (runAbort.signal.aborted) stop("cancelled");

		const finish = (exitCode: number | null, error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(stepTimer);
			clearTimeout(escalation);
			runAbort.signal.removeEventListener("abort", onRunAbort);
			const reason = killReason;
			const failure: { status: "failed"; exitCode: number | null; error?: string } = {
				status: "failed",
				exitCode,
				error:
					reason === "timeout"
						? `timed out after ${step.timeoutMinutes} minute(s)`
						: reason === "cancelled"
							? "aborted"
							: error,
			};
			const outcome =
				reason === null && exitCode === 0
					? finishJobStep(state, log, { status: "success", exitCode: 0 }, tail, notify)
					: finishJobStep(state, log, failure, tail, notify);
			resolve(outcome);
		};

		// Output is split into whole lines before it is redacted and written, so a
		// secret that a read boundary cuts in two is still one line and still masked.
		const lineStreams: Array<{ buffer: string }> = [{ buffer: "" }, { buffer: "" }];
		const emit = (line: string) => {
			const redacted = redactSecrets(line);
			tail.push(redacted);
			log.write(`${redacted}\n`);
		};
		const attach = (stream: NodeJS.ReadableStream | null, which: number) => {
			if (!stream) return;
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				const holder = lineStreams[which];
				holder.buffer += chunk;
				let newline = holder.buffer.indexOf("\n");
				while (newline !== -1) {
					emit(holder.buffer.slice(0, newline));
					holder.buffer = holder.buffer.slice(newline + 1);
					newline = holder.buffer.indexOf("\n");
				}
			});
		};
		attach(child.stdout, 0);
		attach(child.stderr, 1);

		child.on("error", (err) => {
			finish(null, messageOf(err));
		});
		// `close` fires after the process has exited and its output has been read,
		// so the log holds all of it before the section ends.
		child.on("close", (code) => {
			for (const holder of lineStreams) {
				if (holder.buffer !== "") emit(holder.buffer);
				holder.buffer = "";
			}
			finish(code, code === null ? "terminated by a signal" : undefined);
		});
	});
}

/** Records a job step's end: its status, timestamps and log length, then reports it. */
function finishJobStep(
	state: JobStepState,
	log: LogFile,
	outcome: { status: "success" | "failed" | "skipped"; exitCode: number | null; error?: string },
	tail: Tail,
	notify: (state: JobStepState) => void,
): JobStepOutcome {
	state.status = outcome.status;
	state.exitCode = outcome.exitCode;
	state.finishedAt = new Date().toISOString();
	state.logLength = log.bytes - state.logOffset;
	state.tail = tail.text();
	if (outcome.error !== undefined) state.error = outcome.error;
	notify(state);
	return outcome.status === "success" ? { status: "success" } : { status: "failed", error: outcome.error };
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
