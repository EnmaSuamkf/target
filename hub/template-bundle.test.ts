/**
 * Tests for portable template bundles (template-bundle.ts; design in
 * docs/portable-template-bundles-plan.md, sections 2 and 5). A bundle carries
 * the YAML of every pipeline its command steps use, and an import resolves each
 * one by content hash: identical text is reused with its trust kept, anything
 * else is created UNTRUSTED. Cases 1–11 of plan section 5 are the numbered tests.
 *
 * Every test works on its own pipeline and template names, because all tests in
 * this file share one throwaway DB. Same TARGET_HOME convention as templates.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-template-bundle-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { deleteTemplate, getTemplate, insertTemplate, listTemplates, TEMPLATE_BUNDLE_KIND, TemplateBundleError } = await import(
	"./db.ts"
);
const { buildTemplateBundle, importTemplateBundle } = await import("./template-bundle.ts");
const { deletePipeline, findPipelineByHash, getPipeline, insertPipeline, isTrusted, listPipelines, PipelineStoreError } =
	await import("./pipeline-store.ts");
const { sourceHash } = await import("./pipeline-yaml.ts");

/** A valid pipeline text; the name is in the YAML, so the name and the text change together. */
function pipelineText(name: string, command = `echo ${name}`): string {
	return `name: ${name}\nsteps:\n  - run: ${command}\n`;
}

/** A command step as a template stores it (local id). */
function storedCommandStep(pipelineId: string) {
	return { description: "run it", kind: "command" as const, pipelineId, pipelineInputs: {} };
}

/** A command step as a v2 bundle file carries it (`pipelineRef`). */
function refCommandStep(description: string, pipelineRef: string | null) {
	return {
		description,
		kind: "command",
		...(pipelineRef === null ? {} : { pipelineRef }),
		pipelineInputs: {},
		onSuccessTask: null,
		onFailureTask: null,
		acceptanceCriteria: null,
		manualReview: false,
		useSubagent: false,
		maxRetries: 0,
		retryIntervalSeconds: 0,
	};
}

/** A bundle file, built by hand so each test states exactly what the file says. */
function bundleDoc(templates: unknown[], pipelines?: unknown[], schemaVersion = 2): Record<string, unknown> {
	return {
		kind: TEMPLATE_BUNDLE_KIND,
		schemaVersion,
		exportedAt: "2026-11-13T12:00:00.000Z",
		templates,
		...(pipelines === undefined ? {} : { pipelines }),
	};
}

function fileTemplate(name: string, steps: unknown[]) {
	return { name, tags: [], steps, tcpIds: [], tcpSelections: [], resourceSelections: [] };
}

function embedded(ref: string, name: string, source: string, claimedHash = "0".repeat(64)) {
	return { ref, name, tags: [], source, sourceHash: claimedHash };
}

/** How many local rows carry this text's hash. */
function rowsWithHash(text: string): number {
	return listPipelines().filter((p) => p.sourceHash === sourceHash(text)).length;
}

/** Runs an import that must fail, and returns the error it threw. */
function thrownBy(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error("expected the import to throw");
}

// Case 1 — export shape.
test("1. export: a command step carries pipelineRef and no pipelineId; pipelines[] holds the YAML and the hash", () => {
	const source = pipelineText("tb-export");
	const pipeline = insertPipeline({ source, tags: ["ci"], approve: true });
	const template = insertTemplate({ name: "tb export", steps: [storedCommandStep(pipeline.id)] });

	const out = buildTemplateBundle([template]);

	assert.equal(out.schemaVersion, 2);
	assert.equal(out.kind, TEMPLATE_BUNDLE_KIND);
	const step = out.templates[0].steps[0] as Record<string, unknown>;
	assert.equal(step.pipelineRef, "p1");
	assert.ok(!("pipelineId" in step), "the local id does not travel");
	assert.deepEqual(out.pipelines, [{ ref: "p1", name: "tb-export", tags: ["ci"], source, sourceHash: sourceHash(source) }]);
	const serialized = JSON.stringify(out);
	assert.ok(!serialized.includes(pipeline.id), "no hub id anywhere in the bundle");
	assert.ok(!serialized.includes("trusted"), "no trust state in the bundle");
});

test("1b. export: a step whose pipeline is missing locally carries neither pipelineRef nor pipelineId", () => {
	const template = insertTemplate({ name: "tb export gone", steps: [storedCommandStep("no-such-pipeline-id")] });

	const out = buildTemplateBundle([template]);

	const step = out.templates[0].steps[0] as Record<string, unknown>;
	assert.ok(!("pipelineRef" in step));
	assert.ok(!("pipelineId" in step));
	assert.deepEqual(out.pipelines, []);
});

// Case 2 — dedupe in pipelines[].
test("2. export: two templates and several steps using one pipeline list it once, under one ref", () => {
	const pipeline = insertPipeline({ source: pipelineText("tb-shared"), approve: true });
	const first = insertTemplate({ name: "tb shared one", steps: [storedCommandStep(pipeline.id)] });
	const second = insertTemplate({
		name: "tb shared two",
		steps: [storedCommandStep(pipeline.id), storedCommandStep(pipeline.id)],
	});

	const out = buildTemplateBundle([first, second]);

	assert.equal(out.pipelines?.length, 1, "one entry however many steps use it");
	const refs = out.templates.flatMap((t) => t.steps.map((s) => (s as { pipelineRef?: string }).pipelineRef));
	assert.deepEqual(refs, ["p1", "p1", "p1"]);
});

// Case 3 — round trip onto a hub that does not have the pipeline.
test("3. round trip on a hub without the pipeline: created untrusted, the step points at the new id", () => {
	const source = pipelineText("tb-roundtrip");
	const pipeline = insertPipeline({ source, approve: true });
	const template = insertTemplate({ name: "tb roundtrip", steps: [storedCommandStep(pipeline.id)] });
	const exported = JSON.parse(JSON.stringify(buildTemplateBundle([template])));
	// This hub stops having the pipeline: the template and the pipeline are removed.
	assert.equal(deleteTemplate(template.id), true);
	assert.equal(deletePipeline(pipeline.id), true);
	assert.equal(findPipelineByHash(sourceHash(source)), null);

	const result = importTemplateBundle(exported);

	assert.equal(result.pipelines.length, 1);
	assert.equal(result.pipelines[0].action, "created");
	const created = result.pipelines[0].pipeline;
	assert.notEqual(created.id, pipeline.id, "a new row, never the old id");
	assert.equal(created.source, source);
	assert.equal(isTrusted(created), false, "created untrusted");
	assert.equal(rowsWithHash(source), 1);
	const imported = result.templates[0];
	assert.equal(imported.steps[0].pipelineId, created.id);
	assert.deepEqual(result.warnings, []);
	// The stored template keeps the local id and never the bundle-only reference.
	const stored = getTemplate(imported.id)!;
	assert.equal(stored.steps[0].pipelineId, created.id);
	assert.ok(!JSON.stringify(stored).includes("pipelineRef"));
});

// Case 4 — identical trusted pipeline already here.
test("4. identical trusted pipeline already here: no new row, step points at it, trust kept, reported reused", () => {
	const source = pipelineText("tb-reuse");
	const pipeline = insertPipeline({ source, approve: true });
	const template = insertTemplate({ name: "tb reuse origin", steps: [storedCommandStep(pipeline.id)] });
	const exported = JSON.parse(JSON.stringify(buildTemplateBundle([template])));
	const before = listPipelines().length;

	const result = importTemplateBundle(exported);

	assert.equal(listPipelines().length, before, "no new pipeline row");
	assert.equal(result.pipelines[0].action, "reused");
	assert.equal(result.pipelines[0].pipeline.id, pipeline.id);
	assert.equal(result.templates[0].steps[0].pipelineId, pipeline.id);
	assert.equal(isTrusted(getPipeline(pipeline.id)!), true, "the approval is kept");
	assert.deepEqual(result.warnings, []);
});

// Case 5 — same name, different source.
test("5. same name, different text locally: a new pipeline is created and pipeline_name_conflict is reported", () => {
	const local = insertPipeline({ source: pipelineText("tb-conflict", "echo local"), approve: true });
	const bundleText = pipelineText("tb-conflict", "echo from-the-bundle");
	const doc = bundleDoc(
		[fileTemplate("tb conflict", [refCommandStep("run it", "p1")])],
		[embedded("p1", "tb-conflict", bundleText)],
	);

	const result = importTemplateBundle(doc);

	assert.equal(result.pipelines[0].action, "created");
	const created = result.pipelines[0].pipeline;
	assert.notEqual(created.id, local.id, "never bound to the local text");
	assert.equal(created.source, bundleText, "the exact exported text runs");
	assert.equal(isTrusted(created), false);
	assert.equal(result.templates[0].steps[0].pipelineId, created.id);
	assert.deepEqual(result.warnings, [{ code: "pipeline_name_conflict", ref: "p1", name: "tb-conflict" }]);
});

// Case 6 — the same bundle twice.
test("6. importing the same bundle twice: the second reuses the pipeline and the template gets a Clone name", () => {
	const text = pipelineText("tb-twice");
	const doc = bundleDoc([fileTemplate("tb twice", [refCommandStep("run it", "p1")])], [embedded("p1", "tb-twice", text)]);

	const first = importTemplateBundle(doc);
	const second = importTemplateBundle(doc);

	assert.equal(first.pipelines[0].action, "created");
	assert.equal(second.pipelines[0].action, "reused");
	assert.equal(second.pipelines[0].pipeline.id, first.pipelines[0].pipeline.id);
	assert.equal(rowsWithHash(text), 1, "no duplicate pipeline");
	assert.equal(first.templates[0].name, "tb twice");
	assert.equal(second.templates[0].name, "Clone - tb twice");
	assert.equal(isTrusted(second.pipelines[0].pipeline), false, "still untrusted: an import never approves");
});

// Case 7 — tampered sourceHash.
test("7. a tampered sourceHash in the file is ignored: the recomputed hash is used", () => {
	const text = pipelineText("tb-tampered");
	const doc = bundleDoc(
		[fileTemplate("tb tampered", [refCommandStep("run it", "p1")])],
		[embedded("p1", "tb-tampered", text, "f".repeat(64))],
	);

	const result = importTemplateBundle(doc);

	assert.equal(result.pipelines[0].action, "created");
	assert.equal(result.pipelines[0].pipeline.sourceHash, sourceHash(text));
	assert.equal(result.templates[0].steps[0].pipelineId, result.pipelines[0].pipeline.id);
});

test("7b. a file claiming another pipeline's hash does not get that pipeline: the text decides", () => {
	const trusted = insertPipeline({ source: pipelineText("tb-claim-a"), approve: true });
	const otherText = pipelineText("tb-claim-b");
	const doc = bundleDoc(
		[fileTemplate("tb claim", [refCommandStep("run it", "p1")])],
		[embedded("p1", "tb-claim-b", otherText, trusted.sourceHash)],
	);

	const result = importTemplateBundle(doc);

	assert.equal(result.pipelines[0].action, "created", "not reused on the strength of the claimed hash");
	assert.notEqual(result.pipelines[0].pipeline.id, trusted.id);
	assert.equal(result.pipelines[0].pipeline.sourceHash, sourceHash(otherText));
	assert.equal(isTrusted(getPipeline(trusted.id)!), true, "the trusted original is untouched");
});

// Case 8 — invalid YAML refuses the whole bundle.
test("8. invalid embedded YAML: invalid_pipeline with per-entry errors, and NOTHING is created", () => {
	const validText = pipelineText("tb-refused-good");
	const pipelinesBefore = listPipelines().length;
	const templatesBefore = listTemplates().length;
	const doc = bundleDoc(
		[fileTemplate("tb refused", [refCommandStep("run it", "p1")])],
		[
			embedded("p1", "tb-refused-good", validText),
			embedded("p2", "tb-refused-bad", "name: tb-refused-bad\nsteps: []\n"),
		],
	);

	const err = thrownBy(() => importTemplateBundle(doc));

	assert.ok(err instanceof PipelineStoreError);
	assert.equal(err.code, "invalid_pipeline");
	assert.ok(err.errors.some((e) => e.path.startsWith("pipelines[1]")), "the error names the bad entry");
	assert.equal(listPipelines().length, pipelinesBefore, "no pipeline created, not even the valid one");
	assert.equal(listTemplates().length, templatesBefore, "no template created");
	assert.equal(findPipelineByHash(sourceHash(validText)), null);
	assert.ok(!listTemplates().some((t) => t.name === "tb refused"));
});

// Case 9 — a pipelineRef that is not in pipelines[].
test("9. a pipelineRef missing from pipelines[]: the template is imported, the step is null, unresolved_pipeline/missing_ref", () => {
	const doc = bundleDoc(
		[fileTemplate("tb missing ref", [fileStepPlain(), refCommandStep("run it", "p9")])],
		[],
	);

	const result = importTemplateBundle(doc);

	assert.equal(result.templates.length, 1, "the template is imported anyway");
	const steps = result.templates[0].steps;
	assert.equal(steps[1].pipelineId, null);
	assert.deepEqual(result.warnings, [
		{ code: "unresolved_pipeline", template: "tb missing ref", stepIndex: 1, reason: "missing_ref" },
	]);
	assert.equal(result.pipelines.length, 0);
});

function fileStepPlain() {
	return { description: "a plain agent step", kind: "task", useSubagent: true, maxRetries: 0, retryIntervalSeconds: 0 };
}

// Case 10 — version 1 bundles.
test("10. a v1 bundle: a pipelineId that exists here is kept; an unknown one is null with unknown_id", () => {
	const known = insertPipeline({ source: pipelineText("tb-v1-known"), approve: true });
	const doc = bundleDoc(
		[
			fileTemplate("tb v1", [
				{ ...storedCommandStep(known.id) },
				{ ...storedCommandStep("00000000-0000-4000-8000-000000000000") },
			]),
		],
		undefined,
		1,
	);

	const result = importTemplateBundle(doc);

	assert.equal(result.templates[0].steps[0].pipelineId, known.id, "same-machine round trip keeps the id");
	assert.equal(result.templates[0].steps[1].pipelineId, null);
	assert.deepEqual(result.warnings, [{ code: "unresolved_pipeline", template: "tb v1", stepIndex: 1, reason: "unknown_id" }]);
	assert.equal(result.pipelines.length, 0, "a v1 bundle embeds no pipelines");
});

// Case 11 — too new.
test("11. schemaVersion 3 is refused with unsupported_schema_version, and nothing is created", () => {
	const templatesBefore = listTemplates().length;
	const doc = bundleDoc([fileTemplate("tb too new", [])], [embedded("p1", "tb-too-new", pipelineText("tb-too-new"))], 3);

	const err = thrownBy(() => importTemplateBundle(doc));

	assert.ok(err instanceof TemplateBundleError);
	assert.equal(err.code, "unsupported_schema_version");
	assert.equal(listTemplates().length, templatesBefore);
	assert.equal(findPipelineByHash(sourceHash(pipelineText("tb-too-new"))), null);
});

// Transaction: a failure after the pipelines were written rolls them back.
test("a bundle that fails after its pipelines were written leaves no pipeline behind (one transaction)", () => {
	const text = pipelineText("tb-rollback");
	const doc = bundleDoc([], [embedded("p1", "tb-rollback", text)]);

	const err = thrownBy(() => importTemplateBundle(doc));

	assert.ok(err instanceof TemplateBundleError);
	assert.equal(err.code, "empty_bundle");
	assert.equal(findPipelineByHash(sourceHash(text)), null, "the pipeline was rolled back with the failed import");
});

test("a pipeline created by an import of new text is never trusted", () => {
	const doc = bundleDoc(
		[fileTemplate("tb twin", [refCommandStep("run it", "p1")])],
		[embedded("p1", "tb-twin", pipelineText("tb-twin"))],
	);
	const result = importTemplateBundle(doc);
	assert.equal(isTrusted(result.pipelines[0].pipeline), false);
});

