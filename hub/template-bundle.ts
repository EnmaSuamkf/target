/**
 * Portable template bundles (docs/pipelines.md, "Templates"; design in
 * docs/portable-template-bundles-plan.md).
 *
 * A command step names its pipeline by `pipelineId`, a UUID that only exists on
 * the machine that made it, so a template exported to another hub used to arrive
 * with a dead reference. A version 2 bundle therefore carries the YAML of every
 * pipeline its command steps use. On import each one is resolved by its CONTENT
 * hash: identical local text is reused (keeping its approval), anything else is
 * created UNTRUSTED, and the step is rewired to the local id.
 *
 * This module imports both `db.ts` and `pipeline-store.ts`. That is why it is a
 * module of its own: `pipeline-store.ts` imports `db.ts`, so `db.ts` must not
 * import the pipeline store back.
 */
import {
	type Template,
	type TemplateBundle,
	type TemplateBundlePipeline,
	TEMPLATE_BUNDLE_KIND,
	TEMPLATE_BUNDLE_SCHEMA_VERSION,
	TemplateBundleError,
	importTemplates,
	parseTemplateBundle,
	withTransaction,
} from "./db.ts";
import {
	type PipelineBundleEntry,
	type PipelineImportResult,
	PipelineStoreError,
	findPipelineByHash,
	getPipeline,
	importPipelines,
	listPipelines,
} from "./pipeline-store.ts";
import { type PipelineError, parsePipeline, sourceHash } from "./pipeline-yaml.ts";

/**
 * A pipeline from `pipelines[]`, after the file's own text has been validated
 * and its hash recomputed. `ref` is the file-local name the steps point at.
 */
interface BundlePipelineEntry {
	ref: string;
	entry: PipelineBundleEntry;
}

/** A pipeline of the import, reported with the `ref` its steps used. */
export interface BundlePipelineImport extends PipelineImportResult {
	ref: string;
}

/**
 * Something the import did not do exactly as written, but did not refuse.
 *  - `pipeline_name_conflict`: a local pipeline has the same NAME but different
 *    text. The bundle's text is still created as its own pipeline, because a
 *    template must run the exact text that was exported.
 *  - `unresolved_pipeline`: a command step has no pipeline it can be bound to.
 *    The template is imported anyway, with `pipelineId: null`. `stepIndex` is
 *    the step's position in the bundle's `steps` array.
 */
export type TemplateImportWarning =
	| { code: "pipeline_name_conflict"; ref: string; name: string }
	| {
			code: "unresolved_pipeline";
			template: string;
			stepIndex: number;
			reason: "missing_ref" | "unknown_id";
	  };

export interface TemplateBundleImportResult {
	templates: Template[];
	pipelines: BundlePipelineImport[];
	warnings: TemplateImportWarning[];
}

/**
 * Wraps templates in a version 2 export. Every command step's pipeline is
 * embedded once, however many steps use it, and the step carries `pipelineRef`
 * instead of `pipelineId`. A step whose pipeline is gone locally gets neither,
 * so the local id never leaves the machine, and the import reports the step.
 */
export function buildTemplateBundle(templates: Template[]): TemplateBundle {
	const embedded: TemplateBundlePipeline[] = [];
	// Keyed by content hash: two local rows with the same text are the same pipeline in the file.
	const refByHash = new Map<string, string>();
	return {
		kind: TEMPLATE_BUNDLE_KIND,
		schemaVersion: TEMPLATE_BUNDLE_SCHEMA_VERSION,
		exportedAt: new Date().toISOString(),
		templates: templates.map((template) => ({
			name: template.name,
			tags: template.tags,
			steps: template.steps.map((step) => {
				const { pipelineId, ...rest } = step;
				if (step.kind !== "command" || pipelineId === null) return rest;
				const pipeline = getPipeline(pipelineId);
				if (!pipeline) return rest;
				// Recomputed rather than read from the row: the file's hash is only a label, and this
				// keeps the exported `sourceHash` and `source` in agreement with each other.
				const hash = sourceHash(pipeline.source);
				let ref = refByHash.get(hash);
				if (ref === undefined) {
					ref = `p${embedded.length + 1}`;
					refByHash.set(hash, ref);
					embedded.push({
						ref,
						name: pipeline.name,
						tags: pipeline.tags,
						source: pipeline.source,
						sourceHash: hash,
					});
				}
				return { ...rest, pipelineRef: ref };
			}),
			tcpIds: template.tcpIds,
			tcpSelections: template.tcpSelections,
			resourceSelections: template.resourceSelections,
		})),
		pipelines: embedded,
	};
}

/**
 * Reads `pipelines[]`, validating every entry's text before anything is written.
 * One invalid entry refuses the whole bundle with every error listed, so nothing
 * is created. A missing `pipelines` is an empty list (a version 1 file has none).
 */
function readBundlePipelines(raw: unknown): BundlePipelineEntry[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new TemplateBundleError("invalid_bundle");
	const parsed: BundlePipelineEntry[] = [];
	const refs = new Set<string>();
	const errors: PipelineError[] = [];
	raw.forEach((item, index) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new TemplateBundleError("invalid_bundle");
		}
		const obj = item as Record<string, unknown>;
		// A duplicate ref would make two pipelines answer to one name, which is a broken file, not a
		// pipeline problem, so it refuses the bundle like any other malformed envelope.
		if (typeof obj.ref !== "string" || obj.ref.trim() === "" || refs.has(obj.ref)) {
			throw new TemplateBundleError("invalid_bundle");
		}
		refs.add(obj.ref);
		if (typeof obj.source !== "string") {
			errors.push({ line: null, path: `pipelines[${index}].source`, message: "must be the pipeline's YAML text" });
			return;
		}
		const result = parsePipeline(obj.source);
		if (!result.ok) {
			for (const e of result.errors) errors.push({ ...e, path: `pipelines[${index}]${e.path ? `.${e.path}` : ""}` });
			return;
		}
		// The name and the hash come from the text the hub parsed, never from the file's own fields.
		parsed.push({
			ref: obj.ref,
			entry: {
				name: result.pipeline.name,
				tags: Array.isArray(obj.tags) ? obj.tags.map(String) : [],
				source: obj.source,
			},
		});
	});
	if (errors.length > 0) throw new PipelineStoreError("invalid_pipeline", { errors });
	return parsed;
}

/**
 * Resolves every embedded pipeline to a local one, reusing by hash and creating
 * untrusted otherwise. A name conflict is decided BEFORE the import writes
 * anything, against the pipelines that were already here, so a pipeline the
 * import itself just created cannot make a later entry look conflicted.
 */
function resolveBundlePipelines(entries: BundlePipelineEntry[]): {
	imports: BundlePipelineImport[];
	conflicts: TemplateImportWarning[];
} {
	const local = listPipelines().filter((p) => !p.revoked);
	const conflictsBefore = entries.map(({ entry }) => {
		const hash = sourceHash(entry.source);
		return findPipelineByHash(hash) === null && local.some((p) => p.name === entry.name && p.sourceHash !== hash);
	});
	const results = importPipelines(entries.map((e) => e.entry));
	const imports: BundlePipelineImport[] = results.map((result, i) => ({ ...result, ref: entries[i].ref }));
	const conflicts: TemplateImportWarning[] = [];
	imports.forEach((result, i) => {
		if (result.action === "created" && conflictsBefore[i]) {
			conflicts.push({ code: "pipeline_name_conflict", ref: result.ref, name: result.pipeline.name });
		}
	});
	return { imports, conflicts };
}

interface StepReferenceProblem {
	/** Index into the raw `templates` array, which is also the index into the parsed entries. */
	template: number;
	stepIndex: number;
	reason: "missing_ref" | "unknown_id";
}

/**
 * Rewrites every command step's reference to a local `pipelineId`, on a copy of
 * the raw input, before the template parser sees it. A `pipelineRef` is looked up
 * in the resolved pipelines. A version 1 `pipelineId` is kept only if that row
 * exists here, and is never matched by name (names are not unique, and a v1 step
 * carries none). Everything that cannot be bound becomes `null` and is reported.
 */
function bindCommandSteps(
	rawTemplates: unknown[],
	localIdByRef: Map<string, string>,
	problems: StepReferenceProblem[],
): unknown[] {
	return rawTemplates.map((raw, template) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
		const obj = raw as Record<string, unknown>;
		if (!Array.isArray(obj.steps)) return raw;
		const steps = obj.steps.map((step, stepIndex) => {
			if (step === null || typeof step !== "object" || Array.isArray(step)) return step;
			const s = step as Record<string, unknown>;
			if (s.kind !== "command") return step;
			const { pipelineRef, ...rest } = s;
			let pipelineId: string | null = null;
			if (pipelineRef !== undefined) {
				pipelineId = typeof pipelineRef === "string" ? (localIdByRef.get(pipelineRef) ?? null) : null;
				if (pipelineId === null) problems.push({ template, stepIndex, reason: "missing_ref" });
			} else if (typeof s.pipelineId === "string" && s.pipelineId.trim() !== "") {
				const id = s.pipelineId.trim();
				if (getPipeline(id)) pipelineId = id;
				else problems.push({ template, stepIndex, reason: "unknown_id" });
			} else {
				problems.push({ template, stepIndex, reason: "missing_ref" });
			}
			return { ...rest, pipelineId };
		});
		return { ...obj, steps };
	});
}

/** The same envelope test `parseTemplateBundle` makes: anything with a `kind` or `templates` is one. */
function isEnvelope(input: unknown): input is Record<string, unknown> {
	return input !== null && typeof input === "object" && !Array.isArray(input) && ("templates" in input || "kind" in input);
}

/**
 * Imports a bundle of any supported version, in ONE transaction: the embedded
 * pipelines and the templates land together or not at all. An invalid embedded
 * pipeline refuses the whole bundle before anything is written. A template that
 * fails the normal template checks rolls the pipelines back too.
 */
export function importTemplateBundle(input: unknown): TemplateBundleImportResult {
	const embedded = readBundlePipelines(isEnvelope(input) ? input.pipelines : undefined);
	return withTransaction(() => {
		const { imports, conflicts } = resolveBundlePipelines(embedded);
		const localIdByRef = new Map<string, string>(imports.map((i): [string, string] => [i.ref, i.pipeline.id]));
		const problems: StepReferenceProblem[] = [];
		const bound = bindRawInput(input, localIdByRef, problems);
		const entries = parseTemplateBundle(bound);
		const templates = importTemplates(entries);
		const unresolved: TemplateImportWarning[] = problems.map((p): TemplateImportWarning => ({
			code: "unresolved_pipeline",
			template: templates[p.template].name,
			stepIndex: p.stepIndex,
			reason: p.reason,
		}));
		return { templates, pipelines: imports, warnings: [...conflicts, ...unresolved] };
	});
}

/** `bindCommandSteps` applied to whichever shape the input has: envelope, bare array, or bare template. */
function bindRawInput(input: unknown, localIdByRef: Map<string, string>, problems: StepReferenceProblem[]): unknown {
	if (isEnvelope(input)) {
		if (!Array.isArray(input.templates)) return input;
		return { ...input, templates: bindCommandSteps(input.templates, localIdByRef, problems) };
	}
	if (Array.isArray(input)) return bindCommandSteps(input, localIdByRef, problems);
	if (input === null || typeof input !== "object") return input;
	// A bare single template: the same one-element treatment the parser gives it.
	return bindCommandSteps([input], localIdByRef, problems)[0];
}
