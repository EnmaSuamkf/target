/**
 * The create-workflow skill and the docs must describe the model feature, and
 * must not claim the hub never passes `--model`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

test("the create-workflow skill asks for the model right after the agent, from list_runners models[]", () => {
	const skill = read("skills/create-workflow/SKILL.md");
	assert.match(skill, /models\[\]/);
	assert.match(skill, /CLI default/);
	assert.match(skill, /1\. Which agent[^\n]*\n2\. Which model\?/);
	assert.match(skill, /Never invent or guess a model id/);
});

test("README and docs/runners.md describe the allowlist, the picker, CLI default and editing after create", () => {
	for (const file of ["README.md", "docs/runners.md"]) {
		const text = read(file);
		assert.match(text, /Agent models/, file);
		assert.match(text, /CLI default/, file);
		assert.match(text, /\/model/, `${file} should mention PATCH /api/workflows/:id/model`);
		assert.doesNotMatch(text, /hub passes no `--model`/, file);
	}
});
