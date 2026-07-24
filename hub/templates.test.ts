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

const { deleteTemplate, getTemplate, insertTemplate, listTemplates, updateTemplate } = await import("./db.ts");

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
