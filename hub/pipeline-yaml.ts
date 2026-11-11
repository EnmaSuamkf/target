/**
 * Pipeline YAML: parsing, validation and the in-memory shape of a pipeline.
 *
 * A pipeline is a subset of a GitHub Actions job (docs/pipelines.md, "YAML
 * schema"). This module is pure: no database, no filesystem, no network. The
 * store saves the raw text, the trust check compares its hash, and the executor
 * runs the spec this module returns. The UI never parses YAML itself; it calls
 * the same validator through POST /api/pipelines/validate, so the errors an
 * operator sees while typing are exactly the errors a run would give.
 *
 * Validation returns every error it finds, each with a 1-based source line and a
 * JSON-ish path (`steps[2].run`). A pipeline is saved or run only when the list
 * is empty, so a partially valid spec never leaves this module.
 */

import { createHash } from "node:crypto";
import {
	isAlias,
	isMap,
	isScalar,
	isSeq,
	parseAllDocuments,
	visit,
} from "yaml";

/** The document size cap, in bytes of UTF-8. Checked before parsing. */
export const MAX_PIPELINE_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 360;

const SHELLS = ["bash", "sh", "pwsh"] as const;
export type PipelineShell = (typeof SHELLS)[number];

const CONDITIONS = ["success()", "failure()", "always()"] as const;
export type PipelineCondition = (typeof CONDITIONS)[number];

export interface PipelineError {
	/** 1-based source line, or null when the problem is not tied to a line. */
	line: number | null;
	/** JSON-ish path such as `steps[2].run`. Empty for the whole document. */
	path: string;
	message: string;
}

export interface PipelineInput {
	description: string | null;
	required: boolean;
	/** The value used when a command step does not give one. Null = none. */
	default: string | null;
}

export interface PipelineJobStep {
	/** Position in the pipeline's `steps:` list. */
	index: number;
	/** Explicit `name:`, or the first line of `run:` when none is given. */
	name: string;
	id: string | null;
	/** The script exactly as written. It never contains `${{ }}`. */
	run: string;
	shell: PipelineShell;
	/** Relative to the workflow's workdir. May still hold `${{ }}`, resolved at run time. */
	workingDirectory: string;
	/**
	 * This step's own `env:` only. The executor merges the pipeline-level env
	 * under it, so the step's keys win.
	 */
	env: Record<string, string>;
	if: PipelineCondition;
	continueOnError: boolean;
	/** Own limit. Defaults to the pipeline's timeout when the step has none. */
	timeoutMinutes: number;
	/** Target only: whether the output goes to the agent. */
	report: boolean;
}

export interface PipelineSpec {
	name: string;
	description: string | null;
	inputs: Record<string, PipelineInput>;
	/** Pipeline-level env, merged under every job step's env. */
	env: Record<string, string>;
	timeoutMinutes: number;
	defaults: {
		run: { shell: PipelineShell; workingDirectory: string };
	};
	runsOn: "host";
	steps: PipelineJobStep[];
}

export type ParsePipelineResult =
	| { ok: true; pipeline: PipelineSpec; errors: [] }
	| { ok: false; errors: PipelineError[] };

/**
 * Keys of the GitHub Actions job schema that Target recognises and refuses.
 * They get their own message, because a pasted workflow file uses them and the
 * operator needs to know why it does not validate, not that the key is unknown.
 */
const GITHUB_ONLY_KEYS = [
	"on",
	"jobs",
	"needs",
	"strategy",
	"matrix",
	"services",
	"container",
	"uses",
	"with",
	"outputs",
];

const TOP_KEYS = [
	"name",
	"description",
	"inputs",
	"env",
	"timeout-minutes",
	"defaults",
	"runs-on",
	"steps",
];
const DEFAULTS_KEYS = ["run"];
const DEFAULTS_RUN_KEYS = ["shell", "working-directory"];
const INPUT_KEYS = ["description", "required", "default"];
const STEP_KEYS = [
	"name",
	"id",
	"run",
	"shell",
	"working-directory",
	"env",
	"if",
	"continue-on-error",
	"timeout-minutes",
	"report",
];

const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STEP_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** `${{ expr }}`, non-greedy, so two expressions on one line stay two matches. */
const EXPR_RE = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * The only expressions a pipeline may use outside `run:`. Anything else is a
 * validation error, so a typo in an expression never reaches the shell silently.
 */
const INPUT_EXPR = /^inputs\.([A-Za-z][A-Za-z0-9_-]*)$/;
const SECRET_EXPR = /^secrets\.([A-Za-z_][A-Za-z0-9_]*)$/;
const FIXED_EXPRS = new Set([
	"workflow.workdir",
	"workflow.id",
	"workflow.name",
	"step.results_dir",
]);

const RUN_EXPRESSION_MESSAGE =
	'${{ }} is not allowed in "run": the value would be written into the shell script, ' +
	"which allows shell injection. Pass the value through env instead, for example " +
	'env: { VALUE: ${{ inputs.x }} }, and read "$VALUE" in the script.';

/** The YAML parser settings: 1.2 semantics, duplicate keys are errors. */
const PARSE_OPTIONS = {
	version: "1.2" as const,
	uniqueKeys: true,
	prettyErrors: false,
};

interface Ctx {
	source: string;
	lineStarts: number[];
	errors: PipelineError[];
}

interface Field {
	key: string;
	keyLine: number | null;
	value: unknown;
	path: string;
}

export function sourceHash(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Parses and validates a pipeline. Returns the spec with defaults applied, or
 * every error found. Never throws on bad input.
 */
export function parsePipeline(source: string): ParsePipelineResult {
	const bytes = Buffer.byteLength(source, "utf8");
	if (bytes > MAX_PIPELINE_BYTES) {
		return failure([
			{
				line: null,
				path: "",
				message: `the pipeline is ${bytes} bytes; the limit is ${MAX_PIPELINE_BYTES / 1024} KiB`,
			},
		]);
	}

	const ctx: Ctx = { source, lineStarts: lineStartsOf(source), errors: [] };
	const docs = parseAllDocuments(source, PARSE_OPTIONS);

	// Syntax errors make the tree unreliable, so they are returned on their own.
	for (const doc of docs) {
		for (const e of doc.errors) {
			fail(ctx, e.linePos?.[0]?.line ?? null, "", e.message);
		}
	}
	if (docs.length > 1) {
		fail(
			ctx,
			rangeLine(ctx, docs[1]),
			"",
			"a pipeline must be one YAML document; remove the extra '---' separator",
		);
	}
	if (ctx.errors.length > 0) return failure(ctx.errors);
	if (docs.length === 0) {
		return failure([{ line: null, path: "", message: "the pipeline is empty" }]);
	}

	const doc = docs[0];
	checkNoAnchorsOrAliases(ctx, doc);
	// An alias stands for a value the document does not spell out, so every
	// schema check after it would report noise. Only the alias errors are returned.
	if (ctx.errors.length > 0) return failure(ctx.errors);

	const root = doc.contents;
	if (root === null || root === undefined) {
		fail(ctx, null, "", "the pipeline is empty");
		return failure(ctx.errors);
	}
	if (!isMap(root)) {
		fail(
			ctx,
			rangeLine(ctx, root),
			"",
			"the pipeline must be a mapping with keys such as name: and steps:",
		);
		return failure(ctx.errors);
	}

	const pipeline = buildPipeline(ctx, root);
	if (ctx.errors.length > 0) return failure(ctx.errors);
	return { ok: true, pipeline, errors: [] };
}

function failure(errors: PipelineError[]): ParsePipelineResult {
	return { ok: false, errors };
}

// --- Aliases and anchors ----------------------------------------------------

/**
 * Anchors and aliases are rejected outright. This keeps the document a plain
 * tree (no alias-expansion blow-up) and keeps what the operator sees identical
 * to what runs.
 */
function checkNoAnchorsOrAliases(ctx: Ctx, doc: unknown): void {
	visit(doc as never, {
		Alias(_key, node) {
			fail(
				ctx,
				rangeLine(ctx, node),
				"",
				"aliases (*name) are not allowed; write the value out in full",
			);
		},
		Node(_key, node) {
			if (!isAlias(node) && (node as { anchor?: string }).anchor) {
				fail(
					ctx,
					rangeLine(ctx, node),
					"",
					"anchors (&name) are not allowed; write the value out in full",
				);
			}
		},
	});
}

// --- Building the spec ------------------------------------------------------

function buildPipeline(ctx: Ctx, root: unknown): PipelineSpec {
	const rootLine = rangeLine(ctx, root);
	const top = fieldsOfMap(ctx, root as never, "", TOP_KEYS);
	const by = indexFields(top);

	const name = requireString(ctx, by, "name", rootLine);
	const description = optionalString(ctx, by.get("description"));
	const inputs = parseInputs(ctx, by.get("inputs"));
	const inputNames = new Set(Object.keys(inputs));
	const env = parseEnv(ctx, by.get("env"), inputNames);
	const timeoutMinutes =
		timeoutField(ctx, by.get("timeout-minutes"), MAX_TIMEOUT_MINUTES) ??
		DEFAULT_TIMEOUT_MINUTES;
	const runDefaults = parseDefaults(ctx, by.get("defaults"), inputNames);
	const runsOn = runsOnField(ctx, by.get("runs-on"));
	const steps = parseSteps(
		ctx,
		by.get("steps"),
		rootLine,
		runDefaults,
		timeoutMinutes,
		inputNames,
	);

	return {
		name: name ?? "",
		description: description ?? null,
		inputs,
		env,
		timeoutMinutes,
		defaults: { run: runDefaults },
		runsOn: runsOn ?? "host",
		steps,
	};
}

function parseInputs(
	ctx: Ctx,
	f: Field | undefined,
): Record<string, PipelineInput> {
	const out: Record<string, PipelineInput> = {};
	for (const inp of childFields(ctx, f, undefined)) {
		if (!INPUT_NAME.test(inp.key)) {
			fail(
				ctx,
				inp.keyLine,
				inp.path,
				'input names start with a letter and contain only letters, digits, "-" and "_"',
			);
			continue;
		}
		const sub = childFields(ctx, inp, INPUT_KEYS);
		const idx = indexFields(sub);
		out[inp.key] = {
			description: optionalString(ctx, idx.get("description")) ?? null,
			required: optionalBoolean(ctx, idx.get("required")) ?? false,
			default: optionalString(ctx, idx.get("default")) ?? null,
		};
	}
	return out;
}

function parseEnv(
	ctx: Ctx,
	f: Field | undefined,
	inputs: ReadonlySet<string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of childFields(ctx, f, undefined)) {
		if (!ENV_NAME.test(e.key)) {
			fail(
				ctx,
				e.keyLine,
				e.path,
				'environment names use letters, digits and "_" and do not start with a digit',
			);
			continue;
		}
		const value = stringValue(ctx, e);
		if (value === undefined) continue;
		checkExpressions(ctx, value, fieldLine(ctx, e), e.path, inputs);
		out[e.key] = value;
	}
	return out;
}

interface RunDefaults {
	shell: PipelineShell;
	workingDirectory: string;
}

function parseDefaults(
	ctx: Ctx,
	f: Field | undefined,
	inputs: ReadonlySet<string>,
): RunDefaults {
	const out: RunDefaults = { shell: "bash", workingDirectory: "." };
	const defaults = childFields(ctx, f, DEFAULTS_KEYS);
	const runField = indexFields(defaults).get("run");
	const runFields = childFields(ctx, runField, DEFAULTS_RUN_KEYS);
	const idx = indexFields(runFields);
	const shell = shellField(ctx, idx.get("shell"));
	if (shell !== undefined) out.shell = shell;
	const wd = workingDirectoryField(ctx, idx.get("working-directory"), inputs);
	if (wd !== undefined) out.workingDirectory = wd;
	return out;
}

function runsOnField(ctx: Ctx, f: Field | undefined): "host" | undefined {
	const value = stringValue(ctx, f);
	if (value === undefined) return undefined;
	if (value !== "host") {
		fail(
			ctx,
			fieldLine(ctx, f as Field),
			(f as Field).path,
			`runs-on "${value}" is not supported in this version; the only accepted value is "host"`,
		);
		return undefined;
	}
	return "host";
}

function parseSteps(
	ctx: Ctx,
	f: Field | undefined,
	rootLine: number | null,
	defaults: RunDefaults,
	pipelineTimeout: number,
	inputs: ReadonlySet<string>,
): PipelineJobStep[] {
	const steps: PipelineJobStep[] = [];
	if (!f) {
		fail(ctx, rootLine, "steps", '"steps" is required');
		return steps;
	}
	const node = f.value;
	if (!isSeq(node)) {
		fail(ctx, fieldLine(ctx, f), f.path, "must be a list of job steps");
		return steps;
	}
	if (node.items.length === 0) {
		fail(ctx, fieldLine(ctx, f), f.path, "must contain at least one job step");
		return steps;
	}

	const seenIds = new Map<string, number>();
	node.items.forEach((item, index) => {
		const path = `steps[${index}]`;
		if (!isMap(item)) {
			fail(
				ctx,
				rangeLine(ctx, item),
				path,
				"a job step must be a mapping with at least a run: key",
			);
			return;
		}
		steps.push(
			parseJobStep(
				ctx,
				item,
				index,
				path,
				defaults,
				pipelineTimeout,
				inputs,
				seenIds,
			),
		);
	});
	return steps;
}

function parseJobStep(
	ctx: Ctx,
	item: unknown,
	index: number,
	path: string,
	defaults: RunDefaults,
	pipelineTimeout: number,
	inputs: ReadonlySet<string>,
	seenIds: Map<string, number>,
): PipelineJobStep {
	const by = indexFields(fieldsOfMap(ctx, item as never, path, STEP_KEYS));

	let run = "";
	const runField = by.get("run");
	if (!runField) {
		fail(ctx, rangeLine(ctx, item), path, '"run" is required');
	} else {
		const value = stringValue(ctx, runField);
		if (value !== undefined) {
			if (value.trim() === "") {
				fail(ctx, fieldLine(ctx, runField), runField.path, "must not be empty");
			}
			if (value.includes("${{")) {
				fail(
					ctx,
					runExpressionLine(ctx, runField),
					runField.path,
					RUN_EXPRESSION_MESSAGE,
				);
			}
			run = value;
		}
	}

	const id = optionalStepId(ctx, by.get("id"), seenIds, index);

	return {
		index,
		name: optionalString(ctx, by.get("name")) ?? firstLine(run),
		id: id ?? null,
		run,
		shell: shellField(ctx, by.get("shell")) ?? defaults.shell,
		workingDirectory:
			workingDirectoryField(ctx, by.get("working-directory"), inputs) ??
			defaults.workingDirectory,
		env: parseEnv(ctx, by.get("env"), inputs),
		if: conditionField(ctx, by.get("if")) ?? "success()",
		continueOnError: optionalBoolean(ctx, by.get("continue-on-error")) ?? false,
		timeoutMinutes:
			timeoutField(ctx, by.get("timeout-minutes"), MAX_TIMEOUT_MINUTES) ??
			pipelineTimeout,
		report: optionalBoolean(ctx, by.get("report")) ?? true,
	};
}

function optionalStepId(
	ctx: Ctx,
	f: Field | undefined,
	seenIds: Map<string, number>,
	index: number,
): string | undefined {
	const value = stringValue(ctx, f);
	if (value === undefined || f === undefined) return undefined;
	if (!STEP_ID.test(value)) {
		fail(
			ctx,
			fieldLine(ctx, f),
			f.path,
			'id starts with a letter or "_" and contains only letters, digits, "-" and "_"',
		);
		return undefined;
	}
	const first = seenIds.get(value);
	if (first !== undefined) {
		fail(
			ctx,
			fieldLine(ctx, f),
			f.path,
			`duplicate id "${value}" (already used by steps[${first}])`,
		);
		return undefined;
	}
	seenIds.set(value, index);
	return value;
}

// --- Scalar fields ----------------------------------------------------------

function requireString(
	ctx: Ctx,
	by: Map<string, Field>,
	key: string,
	parentLine: number | null,
): string | undefined {
	const f = by.get(key);
	if (!f) {
		fail(ctx, parentLine, key, `"${key}" is required`);
		return undefined;
	}
	const value = stringValue(ctx, f);
	if (value !== undefined && value.trim() === "") {
		fail(ctx, fieldLine(ctx, f), f.path, "must not be empty");
		return undefined;
	}
	return value;
}

function optionalString(ctx: Ctx, f: Field | undefined): string | undefined {
	return stringValue(ctx, f);
}

function stringValue(ctx: Ctx, f: Field | undefined): string | undefined {
	if (!f) return undefined;
	const node = f.value;
	if (isScalar(node) && typeof node.value === "string") return node.value;
	fail(ctx, fieldLine(ctx, f), f.path, "must be a string");
	return undefined;
}

function optionalBoolean(ctx: Ctx, f: Field | undefined): boolean | undefined {
	if (!f) return undefined;
	const node = f.value;
	if (isScalar(node) && typeof node.value === "boolean") return node.value;
	// YAML 1.2 keeps `yes`/`on` as strings, so they land here with a clear hint.
	fail(ctx, fieldLine(ctx, f), f.path, "must be true or false");
	return undefined;
}

function timeoutField(
	ctx: Ctx,
	f: Field | undefined,
	max: number,
): number | undefined {
	if (!f) return undefined;
	const node = f.value;
	const value = isScalar(node) ? node.value : undefined;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > max
	) {
		fail(
			ctx,
			fieldLine(ctx, f),
			f.path,
			`must be a whole number of minutes from 1 to ${max}`,
		);
		return undefined;
	}
	return value;
}

function shellField(ctx: Ctx, f: Field | undefined): PipelineShell | undefined {
	const value = stringValue(ctx, f);
	if (value === undefined || f === undefined) return undefined;
	if (!(SHELLS as readonly string[]).includes(value)) {
		fail(
			ctx,
			fieldLine(ctx, f),
			f.path,
			`shell must be one of ${SHELLS.join(", ")}; got "${value}"`,
		);
		return undefined;
	}
	return value as PipelineShell;
}

function conditionField(
	ctx: Ctx,
	f: Field | undefined,
): PipelineCondition | undefined {
	const value = stringValue(ctx, f);
	if (value === undefined || f === undefined) return undefined;
	// The `${{ }}` wrapper is optional: `if: always()` and `if: ${{ always() }}`
	// both mean the same thing.
	const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(value.trim());
	const inner = (wrapped ? wrapped[1] : value).replace(/\s+/g, "");
	if ((CONDITIONS as readonly string[]).includes(inner)) {
		return inner as PipelineCondition;
	}
	fail(
		ctx,
		fieldLine(ctx, f),
		f.path,
		"if must be success(), failure() or always() (the ${{ }} wrapper is optional)",
	);
	return undefined;
}

/**
 * A working directory is relative to the workflow's workdir and must not leave
 * it. A value with `${{ }}` cannot be checked here; the executor checks the
 * resolved path again before it starts the job step.
 */
function workingDirectoryField(
	ctx: Ctx,
	f: Field | undefined,
	inputs: ReadonlySet<string>,
): string | undefined {
	const value = stringValue(ctx, f);
	if (value === undefined || f === undefined) return undefined;
	const line = fieldLine(ctx, f);
	if (value.trim() === "") {
		fail(
			ctx,
			line,
			f.path,
			'must not be empty; use "." for the workdir itself',
		);
		return undefined;
	}
	if (value.includes("${{")) {
		checkExpressions(ctx, value, line, f.path, inputs);
		return value;
	}
	if (/^([\/\\]|[A-Za-z]:)/.test(value)) {
		fail(
			ctx,
			line,
			f.path,
			"must be relative to the workflow's workdir, not an absolute path",
		);
		return undefined;
	}
	let depth = 0;
	for (const segment of value.split(/[\/\\]+/)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			depth--;
			if (depth < 0) {
				fail(
					ctx,
					line,
					f.path,
					'must stay inside the workflow\'s workdir; ".." leaves it',
				);
				return undefined;
			}
		} else {
			depth++;
		}
	}
	return value;
}

// --- Expressions ------------------------------------------------------------

/**
 * Checks each `${{ }}` in a value that is allowed to have them (env,
 * working-directory). Reports an unterminated `${{` as well, so a typo does
 * not reach the run as literal text.
 */
function checkExpressions(
	ctx: Ctx,
	text: string,
	line: number | null,
	path: string,
	inputs: ReadonlySet<string>,
): void {
	const opened = text.split("${{").length - 1;
	let closed = 0;
	for (const match of text.matchAll(EXPR_RE)) {
		closed++;
		const problem = expressionProblem(match[1].trim(), inputs);
		if (problem) fail(ctx, line, path, problem);
	}
	if (opened !== closed) {
		fail(ctx, line, path, "unterminated ${{ expression; close it with }}");
	}
}

function expressionProblem(
	expr: string,
	inputs: ReadonlySet<string>,
): string | null {
	const input = INPUT_EXPR.exec(expr);
	if (input) {
		return inputs.has(input[1])
			? null
			: `input "${input[1]}" is not declared in inputs`;
	}
	if (SECRET_EXPR.test(expr) || FIXED_EXPRS.has(expr)) return null;
	return (
		`expression "${expr}" is not supported; allowed: inputs.<name>, ` +
		"secrets.<NAME>, workflow.workdir, workflow.id, workflow.name, step.results_dir"
	);
}

// --- Maps and keys ----------------------------------------------------------

/**
 * The entries of a mapping, with their paths. When `allowed` is given, unknown
 * keys are reported here, with a did-you-mean hint or the GitHub Actions
 * message, so every mapping is checked the same way.
 */
function fieldsOfMap(
	ctx: Ctx,
	map: { items: { key: unknown; value: unknown }[] },
	parentPath: string,
	allowed?: readonly string[],
): Field[] {
	const out: Field[] = [];
	for (const pair of map.items) {
		const keyNode = pair.key;
		const keyValue = isScalar(keyNode) ? keyNode.value : undefined;
		if (typeof keyValue !== "string") {
			fail(
				ctx,
				rangeLine(ctx, keyNode),
				parentPath,
				"keys must be text (quote a key that looks like a number or boolean)",
			);
			continue;
		}
		out.push({
			key: keyValue,
			keyLine: rangeLine(ctx, keyNode),
			value: pair.value,
			path: childPath(parentPath, keyValue),
		});
	}
	if (allowed) {
		for (const f of out) {
			if (allowed.includes(f.key)) continue;
			if (GITHUB_ONLY_KEYS.includes(f.key)) {
				fail(
					ctx,
					f.keyLine,
					f.path,
					`"${f.key}" is a GitHub Actions key that is not supported in this version: ` +
						"a pipeline is a list of run: steps, with env, working-directory, if, " +
						"continue-on-error, timeout-minutes and report. Remove it",
				);
			} else {
				const suggestion = suggestKey(f.key, allowed);
				fail(
					ctx,
					f.keyLine,
					f.path,
					`unknown key "${f.key}"` +
						(suggestion ? ` (did you mean "${suggestion}"?)` : ""),
				);
			}
		}
	}
	return out;
}

/**
 * Fields of a mapping-valued field. A missing or empty (`key:`) value is an
 * empty mapping; any other non-mapping value is an error.
 */
function childFields(
	ctx: Ctx,
	f: Field | undefined,
	allowed: readonly string[] | undefined,
): Field[] {
	if (!f || isNullValue(f.value)) return [];
	if (!isMap(f.value)) {
		fail(ctx, fieldLine(ctx, f), f.path, "must be a mapping");
		return [];
	}
	return fieldsOfMap(ctx, f.value, f.path, allowed);
}

function indexFields(fields: Field[]): Map<string, Field> {
	return new Map(fields.map((f) => [f.key, f]));
}

function isNullValue(node: unknown): boolean {
	return node === null || (isScalar(node) && node.value === null);
}

function childPath(parent: string, key: string): string {
	return parent === "" ? key : `${parent}.${key}`;
}

function suggestKey(key: string, candidates: readonly string[]): string | undefined {
	// `continue_on_error` is the most common slip. Underscores for hyphens is an
	// exact match, so it is suggested before any edit-distance search runs.
	const normalized = key.replace(/_/g, "-").toLowerCase();
	if (candidates.includes(normalized)) return normalized;
	let best: string | undefined;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const d = editDistance(normalized, candidate);
		if (d < bestDistance) {
			best = candidate;
			bestDistance = d;
		}
	}
	return bestDistance <= 2 ? best : undefined;
}

/** Levenshtein distance. Small inputs only (keys), so the plain DP is fine. */
export function editDistance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur: number[] = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(
				prev[j] + 1,
				cur[j - 1] + 1,
				prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = cur;
	}
	return prev[b.length];
}

// --- Lines ------------------------------------------------------------------

function lineStartsOf(source: string): number[] {
	const starts = [0];
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

function lineOfOffset(ctx: Ctx, offset: number): number {
	// Binary search for the last line start at or before the offset.
	let lo = 0;
	let hi = ctx.lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (ctx.lineStarts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

function rangeLine(ctx: Ctx, node: unknown): number | null {
	const range = (node as { range?: readonly number[] } | null | undefined)
		?.range;
	return range ? lineOfOffset(ctx, range[0]) : null;
}

function fieldLine(ctx: Ctx, f: Field): number | null {
	return rangeLine(ctx, f.value) ?? f.keyLine;
}

/**
 * The line of the first `${{` inside a scalar. A multi-line run block can have
 * the expression several lines down, so the scalar's first line would point at
 * the wrong place.
 */
function runExpressionLine(ctx: Ctx, f: Field): number | null {
	const range = (f.value as { range?: readonly number[] } | null)?.range;
	if (!range) return fieldLine(ctx, f);
	const at = ctx.source.slice(range[0], range[1]).indexOf("${{");
	return at >= 0 ? lineOfOffset(ctx, range[0] + at) : fieldLine(ctx, f);
}

function fail(
	ctx: Ctx,
	line: number | null,
	path: string,
	message: string,
): void {
	ctx.errors.push({ line, path, message });
}

function firstLine(run: string): string {
	return run.trim().split("\n")[0].trim();
}
