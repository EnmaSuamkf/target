/**
 * Tests for the templates CRUD in db.ts. A template is a saved (name, tags,
 * ordered step list) triple that seeds a workflow's "+ Add step" fields later
 * — it never executes, so there's no engine/hook involved here, just the DB
 * layer. Same throwaway-TARGET_HOME convention as workflow.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-templates-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;

const {
	deleteTemplate,
	getTemplate,
	importTemplates,
	insertTemplate,
	listTemplates,
	parseTemplateBundle,
	templateBundle,
	TemplateBundleError,
	TEMPLATE_BUNDLE_KIND,
	TEMPLATE_BUNDLE_SCHEMA_VERSION,
	updateTemplate,
} = await import("./db.ts");

test("insertTemplate stores name, tags and steps and getTemplate reads them back", () => {
	const template = insertTemplate({
		name: "release checklist",
		tags: ["release", "docs"],
		steps: [
			{ description: "bump version" },
			{ description: "write changelog", acceptanceCriteria: "mentions every merged PR", maxRetries: 2, retryIntervalSeconds: 30 },
		],
	});

	assert.equal(template.name, "release checklist");
	assert.deepEqual(template.tags, ["release", "docs"]);
	assert.equal(template.steps.length, 2);
	assert.equal(template.steps[0].description, "bump version");
	assert.equal(template.steps[0].acceptanceCriteria, null);
	assert.equal(template.steps[0].maxRetries, 0);
	assert.equal(template.steps[1].acceptanceCriteria, "mentions every merged PR");
	assert.equal(template.steps[1].maxRetries, 2);
	assert.equal(template.steps[1].retryIntervalSeconds, 30);

	const fetched = getTemplate(template.id);
	assert.deepEqual(fetched, template);
});

test("listTemplates returns every template, most recently created first", () => {
	const a = insertTemplate({ name: "template a", tags: [], steps: [{ description: "step" }] });
	const b = insertTemplate({ name: "template b", tags: [], steps: [{ description: "step" }] });

	const ids = listTemplates().map((t) => t.id);
	assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
});

test("insertTemplate drops steps with an empty/missing description", () => {
	const template = insertTemplate({
		name: "sparse",
		steps: [{ description: "" }, { description: "  " }, { description: "keep me" }, {}],
	});
	assert.equal(template.steps.length, 1);
	assert.equal(template.steps[0].description, "keep me");
});

test("insertTemplate tolerates missing tags/steps", () => {
	const template = insertTemplate({ name: "bare" });
	assert.deepEqual(template.tags, []);
	assert.deepEqual(template.steps, []);
});

test("updateTemplate replaces only the fields provided, leaving the rest untouched", () => {
	const template = insertTemplate({ name: "original", tags: ["x"], steps: [{ description: "one" }] });

	const renamedOnly = updateTemplate(template.id, { name: "renamed" });
	assert.equal(renamedOnly?.name, "renamed");
	assert.deepEqual(renamedOnly?.tags, ["x"]);
	assert.equal(renamedOnly?.steps.length, 1);

	const newSteps = updateTemplate(template.id, {
		steps: [{ description: "one" }, { description: "two" }],
	});
	assert.equal(newSteps?.name, "renamed"); // untouched by this call
	assert.equal(newSteps?.steps.length, 2);
	assert.equal(newSteps?.steps[1].description, "two");

	// Persisted, not just returned in-memory.
	assert.deepEqual(getTemplate(template.id), newSteps);
});

test("updateTemplate on an unknown id returns null and touches nothing", () => {
	assert.equal(updateTemplate("does-not-exist", { name: "x" }), null);
});

test("deleteTemplate removes it and reports true, false on a repeat delete", () => {
	const template = insertTemplate({ name: "to delete", steps: [{ description: "step" }] });
	assert.equal(deleteTemplate(template.id), true);
	assert.equal(getTemplate(template.id), null);
	assert.equal(deleteTemplate(template.id), false);
});

// --- export / import --------------------------------------------------
//
// A bundle is the whole portability story: templates carry no ids, paths or
// timestamps across, so the only things worth pinning are the envelope, what a
// foreign/older/malformed file does on the way back in, and that an import is a
// COPY (fresh id, non-colliding name) rather than a restore over the top.

test("templateBundle wraps templates in the versioned envelope, without ids or timestamps", () => {
	const template = insertTemplate({
		name: "bundle me",
		tags: ["ops"],
		steps: [{ description: "do it", acceptanceCriteria: "it is done", manualReview: true, maxRetries: 3 }],
	});

	const bundle = templateBundle([template]);
	assert.equal(bundle.kind, TEMPLATE_BUNDLE_KIND);
	assert.equal(bundle.schemaVersion, TEMPLATE_BUNDLE_SCHEMA_VERSION);
	assert.ok(!Number.isNaN(Date.parse(bundle.exportedAt)));
	assert.equal(bundle.templates.length, 1);
	assert.deepEqual(Object.keys(bundle.templates[0] ?? {}).sort(), [
		"name",
		"resourceSelections",
		"steps",
		"tags",
		"tcpIds",
		"tcpSelections",
	]);
	assert.equal(bundle.templates[0]?.name, "bundle me");
	assert.deepEqual(bundle.templates[0]?.tags, ["ops"]);
	assert.equal(bundle.templates[0]?.steps[0]?.acceptanceCriteria, "it is done");
});

test("export → import round-trips name, tags and every step field", () => {
	const source = insertTemplate({
		name: "round trip",
		tags: ["release", "docs"],
		steps: [
			{ description: "first", acceptanceCriteria: "checked", manualReview: true, useSubagent: false, maxRetries: 2, retryIntervalSeconds: 45 },
			{ description: "second" },
		],
	});

	const [imported] = importTemplates(parseTemplateBundle(templateBundle([source])));
	assert.ok(imported);
	assert.deepEqual(imported.tags, source.tags);
	assert.deepEqual(imported.steps, source.steps);
});

test("import mints a fresh id and never reuses the exported one", () => {
	const source = insertTemplate({ name: "fresh id", steps: [{ description: "step" }] });
	// Even a hand-written bundle that DOES carry an id can't claim it: the id
	// isn't read at all, so an import can never overwrite or shadow a local row.
	const [imported] = importTemplates(
		parseTemplateBundle({
			kind: TEMPLATE_BUNDLE_KIND,
			schemaVersion: 1,
			templates: [{ id: source.id, name: "fresh id copy", tags: [], steps: [{ description: "step" }] }],
		}),
	);
	assert.ok(imported);
	assert.notEqual(imported.id, source.id);
	// The original is untouched, both rows are there.
	assert.equal(getTemplate(source.id)?.name, "fresh id");
	assert.equal(getTemplate(imported.id)?.name, "fresh id copy");
});

test("import of a step missing the newer fields fills the same defaults as the CRUD", () => {
	// A bundle written by a hub from before `manualReview`/`useSubagent` existed:
	// off and on respectively, which is what that hub actually did.
	const [imported] = importTemplates(
		parseTemplateBundle({
			kind: TEMPLATE_BUNDLE_KIND,
			schemaVersion: 1,
			exportedAt: "2024-01-01T00:00:00.000Z",
			templates: [{ name: "legacy", tags: ["old"], steps: [{ description: "just a description" }] }],
		}),
	);
	assert.ok(imported);
	const step = imported.steps[0];
	assert.equal(step?.description, "just a description");
	assert.equal(step?.acceptanceCriteria, null);
	assert.equal(step?.manualReview, false);
	assert.equal(step?.useSubagent, true);
	assert.equal(step?.maxRetries, 0);
	assert.equal(step?.retryIntervalSeconds, 0);
});

test("import re-uses the normalizers: bad types are coerced and empty steps dropped", () => {
	const [imported] = importTemplates(
		parseTemplateBundle({
			kind: TEMPLATE_BUNDLE_KIND,
			schemaVersion: 1,
			templates: [
				{
					name: "untrusted",
					tags: ["keep", "  ", 7],
					steps: [{ description: "  " }, { description: "kept", maxRetries: -5, retryIntervalSeconds: "12" }],
				},
			],
		}),
	);
	assert.ok(imported);
	assert.deepEqual(imported.tags, ["keep", "7"]);
	assert.equal(imported.steps.length, 1);
	assert.equal(imported.steps[0]?.maxRetries, 0);
	assert.equal(imported.steps[0]?.retryIntervalSeconds, 12);
});

test("importing onto a machine that already has that name disambiguates with the clone prefix", () => {
	insertTemplate({ name: "collide", steps: [{ description: "step" }] });
	const bundle = { kind: TEMPLATE_BUNDLE_KIND, schemaVersion: 1, templates: [{ name: "collide", steps: [{ description: "step" }] }] };

	const [first] = importTemplates(parseTemplateBundle(bundle));
	assert.equal(first?.name, "Clone - collide");
	// A third copy can't take the same name either.
	const [second] = importTemplates(parseTemplateBundle(bundle));
	assert.equal(second?.name, "Clone - collide (2)");

	// A free name is kept as-is — the common case is importing onto a machine
	// that has never seen this template.
	const [fresh] = importTemplates(parseTemplateBundle({ ...bundle, templates: [{ name: "no collision here", steps: [{ description: "step" }] }] }));
	assert.equal(fresh?.name, "no collision here");
});

test("two same-named templates inside ONE bundle disambiguate against each other", () => {
	const created = importTemplates(
		parseTemplateBundle({
			kind: TEMPLATE_BUNDLE_KIND,
			schemaVersion: 1,
			templates: [
				{ name: "twin", steps: [{ description: "a" }] },
				{ name: "twin", steps: [{ description: "b" }] },
			],
		}),
	);
	assert.deepEqual(
		created.map((t) => t.name),
		["twin", "Clone - twin"],
	);
});

test("parseTemplateBundle accepts a bare array and a bare single template", () => {
	const fromArray = parseTemplateBundle([{ name: "bare array", tags: [], steps: [{ description: "step" }] }]);
	assert.equal(fromArray.length, 1);
	assert.equal(fromArray[0]?.name, "bare array");

	const fromObject = parseTemplateBundle({ name: "bare object", tags: ["t"], steps: [{ description: "step" }] });
	assert.equal(fromObject.length, 1);
	assert.deepEqual(fromObject[0]?.tags, ["t"]);
});

test("parseTemplateBundle rejects a malformed, foreign or too-new bundle with a named code", () => {
	const codeOf = (input: unknown): string => {
		try {
			parseTemplateBundle(input);
			return "no_error";
		} catch (err) {
			return err instanceof TemplateBundleError ? err.code : "wrong_error_type";
		}
	};

	assert.equal(codeOf("not json at all"), "invalid_bundle");
	assert.equal(codeOf(null), "invalid_bundle");
	// Someone else's export file that happens to have a `kind`.
	assert.equal(codeOf({ kind: "other.tool", schemaVersion: 1, templates: [] }), "unknown_kind");
	// A file from a future hub, whose extra meaning we'd silently drop.
	assert.equal(codeOf({ kind: TEMPLATE_BUNDLE_KIND, schemaVersion: 99, templates: [{ name: "x", steps: [] }] }), "unsupported_schema_version");
	assert.equal(codeOf({ kind: TEMPLATE_BUNDLE_KIND, schemaVersion: 1, templates: "nope" }), "invalid_bundle");
	assert.equal(codeOf({ kind: TEMPLATE_BUNDLE_KIND, schemaVersion: 1, templates: [{ steps: [] }] }), "invalid_bundle");
	assert.equal(codeOf({ kind: TEMPLATE_BUNDLE_KIND, schemaVersion: 1, templates: [] }), "empty_bundle");
	assert.equal(codeOf([]), "empty_bundle");
});

test("a template with no steps at all still exports and imports", () => {
	// Nothing about an empty step list is invalid — it's a named placeholder the
	// operator will fill in — so it must survive the round trip.
	const source = insertTemplate({ name: "empty but named", tags: [] });
	const [imported] = importTemplates(parseTemplateBundle(templateBundle([source])));
	assert.equal(imported?.name, "Clone - empty but named");
	assert.deepEqual(imported?.steps, []);
});
