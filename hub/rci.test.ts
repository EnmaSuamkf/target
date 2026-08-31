import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-rci-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const {
	deleteResourceSet,
	getResourceSet,
	insertResourceSet,
	listWorkflowResourceSelections,
	setWorkflowResourceSelections,
	updateResourceSet,
} = await import("./rci-store.ts");
const { insertWorkflow, insertTemplate, updateTemplate } = await import("./db.ts");
const { importResourcesFromFolder, parseFrontmatter, ResourceImportError } = await import("./rci-import.ts");
const { resourcesCatalogPreamble, workflowResourcesDir } = await import("./rci-catalog.ts");
const { getResourceSetUsage } = await import("./rci-usage.ts");

function newWorkflow(name: string): { id: string } {
	return insertWorkflow({
		id: crypto.randomUUID(),
		name,
		agentName: `agent-${name}`,
		hookUrl: "http://x/h",
		secret: "s",
		mdPath: path.join(tmpHome, `${name}.md`),
	});
}

/** Writes a resources tree like the ones that ship on disk: folders with a SKILL.md and material beside it. */
function writeResourcesTree(root: string): string {
	fs.mkdirSync(path.join(root, "brainstorming", "references"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "brainstorming", "SKILL.md"),
		"---\nname: brainstorming\ndescription: Generate options before deciding\n---\n\n# Brainstorming\n\nDiverge, then converge.\n",
	);
	fs.writeFileSync(path.join(root, "brainstorming", "references", "prompts.md"), "# Prompts\n");
	fs.mkdirSync(path.join(root, "user-research", "evals"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "user-research", "SKILL.md"),
		"---\nname: user-research\ndescription: Talk to users\n---\n\n# User research\n",
	);
	fs.writeFileSync(path.join(root, "user-research", "evals", "cases.json"), "[]\n");
	return root;
}

test("insertResourceSet stores resources with their bundled files", () => {
	const set = insertResourceSet({
		name: "product",
		tags: ["team"],
		resources: [
			{
				name: "brainstorming",
				description: "options first",
				content: "# Brainstorming",
				files: [{ path: "references/prompts.md", content: "# Prompts" }],
			},
		],
	});
	assert.equal(set.resources.length, 1);
	assert.equal(set.resources[0]?.files[0]?.path, "references/prompts.md");
	assert.equal(getResourceSet(set.id)?.name, "product");
});

test("normalization drops nameless and contentless resources, and de-duplicates by name", () => {
	const set = insertResourceSet({
		name: "noisy",
		resources: [
			{ name: "a", description: "", content: "body", files: [] },
			{ name: "  ", description: "", content: "body", files: [] },
			{ name: "a", description: "dup", content: "other", files: [] },
		],
	});
	assert.deepEqual(
		set.resources.map((s) => s.name),
		["a"],
	);
});

test("a bundled file path cannot escape its resource folder", () => {
	const set = insertResourceSet({
		name: "escape",
		resources: [
			{
				name: "s",
				description: "",
				content: "body",
				files: [
					{ path: "../../etc/passwd", content: "nope" },
					{ path: "/absolute.md", content: "ok" },
					{ path: "refs/./fine.md", content: "ok" },
				],
			},
		],
	});
	assert.deepEqual(
		set.resources[0]?.files.map((f) => f.path),
		["absolute.md", "refs/fine.md"],
	);
});

test("importResourcesFromFolder reads a folder of skills with their material", () => {
	const root = writeResourcesTree(fs.mkdtempSync(path.join(tmpHome, "resources-")));
	const imported = importResourcesFromFolder(root);
	assert.deepEqual(
		imported.resources.map((s) => s.name).sort(),
		["brainstorming", "user-research"],
	);
	const brainstorming = imported.resources.find((s) => s.name === "brainstorming");
	assert.equal(brainstorming?.description, "Generate options before deciding");
	assert.equal(brainstorming?.kind, "skill");
	assert.equal(brainstorming?.entryFile, "SKILL.md");
	assert.deepEqual(
		brainstorming?.files.map((f) => f.path),
		["references/prompts.md"],
	);
	// The SKILL.md is carried whole, frontmatter included.
	assert.ok(brainstorming?.content.startsWith("---\nname: brainstorming"));
});

test("importResourcesFromFolder also accepts a single resource folder, and reports what went wrong", () => {
	const root = writeResourcesTree(fs.mkdtempSync(path.join(tmpHome, "resources-one-")));
	const one = importResourcesFromFolder(path.join(root, "brainstorming"));
	assert.deepEqual(
		one.resources.map((s) => s.name),
		["brainstorming"],
	);

	assert.throws(() => importResourcesFromFolder(path.join(tmpHome, "nope")), (err: unknown) => {
		assert.ok(err instanceof ResourceImportError);
		assert.equal(err.code, "folder_not_found");
		return true;
	});

	const empty = fs.mkdtempSync(path.join(tmpHome, "empty-"));
	assert.throws(() => importResourcesFromFolder(empty), /no_resources_found/);
});

test("a SKILL.md can be pointed at directly, and brings its own folder's material", () => {
	const root = writeResourcesTree(fs.mkdtempSync(path.join(tmpHome, "resources-file-")));
	const one = importResourcesFromFolder(path.join(root, "brainstorming", "SKILL.md"));
	// Picking the file means this resource only — the sibling resource stays behind,
	// which is the whole difference from picking the folder above it.
	assert.deepEqual(
		one.resources.map((s) => s.name),
		["brainstorming"],
	);
	assert.equal(one.suggestedName, "brainstorming");
	assert.deepEqual(
		one.resources[0]?.files.map((f) => f.path),
		["references/prompts.md"],
	);
});

test("pointing at a file that isn't Markdown is refused", () => {
	const root = writeResourcesTree(fs.mkdtempSync(path.join(tmpHome, "resources-bad-file-")));
	assert.throws(
		() => importResourcesFromFolder(path.join(root, "user-research", "evals", "cases.json")),
		/not_a_markdown_file/,
	);
});

/**
 * A tree holding every shape RCI has to read: skill bundles, an agent bundle,
 * loose agent definitions, and documents in the other Markdown extensions.
 */
function writeMixedTree(root: string): string {
	writeResourcesTree(root);
	fs.mkdirSync(path.join(root, "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "agents", "code-reviewer.md"),
		"---\nname: code-reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: sonnet\n---\n\nYou review code.\n",
	);
	// No frontmatter at all, and nothing but its folder to go on.
	fs.writeFileSync(path.join(root, "agents", "release-captain.md"), "You drive releases.\n");
	fs.mkdirSync(path.join(root, "release-agent"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "release-agent", "AGENT.md"),
		"---\nname: release-agent\ndescription: Cuts releases\n---\n\n# Release agent\n",
	);
	fs.writeFileSync(path.join(root, "release-agent", "checklist.md"), "# Checklist\n");
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(path.join(root, "docs", "architecture.markdown"), "# Architecture\n");
	fs.writeFileSync(path.join(root, "docs", "glossary.mdx"), "# Glossary\n");
	fs.writeFileSync(path.join(root, "README.md"), "# Read me\n");
	// A repo-root AGENTS.md is instructions, not a bundle root: importing it must
	// not turn the whole tree into one resource.
	fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agent instructions\n");
	return root;
}

test("any .md file is importable — skills, agents and documents, in every Markdown extension", () => {
	const root = writeMixedTree(fs.mkdtempSync(path.join(tmpHome, "mixed-")));
	const imported = importResourcesFromFolder(root);
	const byName = new Map(imported.resources.map((r) => [r.name, r]));

	// No frontmatter `name:` means the file's own name — "AGENTS.md" imports as
	// "AGENTS", which the operator can rename in the editor.
	assert.deepEqual(
		[...byName.keys()].sort(),
		[
			"AGENTS",
			"README",
			"architecture",
			"brainstorming",
			"code-reviewer",
			"glossary",
			"release-agent",
			"release-captain",
			"user-research",
		],
	);

	// Kinds: a SKILL.md folder is a skill, an AGENT.md folder and anything under
	// agents/ is an agent, and plain prose is a document.
	assert.equal(byName.get("brainstorming")?.kind, "skill");
	assert.equal(byName.get("release-agent")?.kind, "agent");
	assert.equal(byName.get("code-reviewer")?.kind, "agent");
	assert.equal(byName.get("release-captain")?.kind, "agent");
	assert.equal(byName.get("architecture")?.kind, "doc");
	assert.equal(byName.get("glossary")?.kind, "doc");
	assert.equal(byName.get("README")?.kind, "doc");
	assert.equal(byName.get("AGENTS")?.kind, "agent");
	// AGENTS.md at the root did not swallow the tree: everything below it was
	// still read as resources of its own.
	assert.deepEqual(byName.get("AGENTS")?.files, []);

	// Each keeps the file name it was read from, so materialisation writes it back
	// as itself rather than as a generic SKILL.md.
	assert.equal(byName.get("code-reviewer")?.entryFile, "code-reviewer.md");
	assert.equal(byName.get("architecture")?.entryFile, "architecture.markdown");
	assert.equal(byName.get("glossary")?.entryFile, "glossary.mdx");
	assert.equal(byName.get("release-agent")?.entryFile, "AGENT.md");

	// Names and descriptions come from frontmatter when there is any, and from the
	// file's own heading-free name when there isn't.
	assert.equal(byName.get("code-reviewer")?.description, "Reviews diffs");
	assert.equal(byName.get("release-captain")?.description, "");
	assert.equal(byName.get("release-captain")?.content, "You drive releases.\n");

	// A bundle owns its folder; a loose .md owns nothing — its neighbours are
	// resources in their own right, not its material.
	assert.deepEqual(
		byName.get("release-agent")?.files.map((f) => f.path),
		["checklist.md"],
	);
	assert.deepEqual(byName.get("code-reviewer")?.files, []);
	assert.deepEqual(byName.get("architecture")?.files, []);
});

test("a single .md of any name can be pointed at directly", () => {
	const root = writeMixedTree(fs.mkdtempSync(path.join(tmpHome, "mixed-one-")));

	const agent = importResourcesFromFolder(path.join(root, "agents", "code-reviewer.md"));
	assert.equal(agent.resources.length, 1);
	assert.equal(agent.resources[0]?.name, "code-reviewer");
	assert.equal(agent.resources[0]?.kind, "agent");
	assert.equal(agent.suggestedName, "code-reviewer");

	const doc = importResourcesFromFolder(path.join(root, "docs", "architecture.markdown"));
	assert.equal(doc.resources[0]?.kind, "doc");
	assert.equal(doc.resources[0]?.content, "# Architecture\n");

	// The reference material inside a skill folder is a document on its own when
	// that is what the operator picked.
	const reference = importResourcesFromFolder(path.join(root, "brainstorming", "references", "prompts.md"));
	assert.equal(reference.resources[0]?.name, "prompts");
	assert.deepEqual(reference.resources[0]?.files, []);
});

test("two resources carrying the same name are both kept, disambiguated by kind", () => {
	const root = fs.mkdtempSync(path.join(tmpHome, "dup-"));
	fs.mkdirSync(path.join(root, "review"), { recursive: true });
	fs.writeFileSync(path.join(root, "review", "SKILL.md"), "---\nname: review\n---\n\n# Review skill\n");
	fs.mkdirSync(path.join(root, "agents"), { recursive: true });
	fs.writeFileSync(path.join(root, "agents", "review.md"), "---\nname: review\n---\n\n# Review agent\n");

	const imported = importResourcesFromFolder(root);
	assert.deepEqual(
		imported.resources.map((r) => r.name).sort(),
		["review", "review (skill)"],
	);
	// Both survive with their own kind — neither silently wins the name.
	assert.deepEqual(
		imported.resources.map((r) => r.kind).sort(),
		["agent", "skill"],
	);
});

test("parseFrontmatter reads flat keys and leaves the body alone", () => {
	const { data, body } = parseFrontmatter("---\nname: a\ndescription: \"b: c\"\n---\n# Title\n");
	assert.equal(data.name, "a");
	assert.equal(data.description, "b: c");
	assert.equal(body, "# Title\n");
	// No frontmatter at all is not an error — the whole file is the body.
	assert.equal(parseFrontmatter("# Just markdown").body, "# Just markdown");
});

test("workflow attachment stores a resource subset and validates it against the set", () => {
	const set = insertResourceSet({
		name: "attach",
		resources: [
			{ name: "a", description: "", content: "A", files: [] },
			{ name: "b", description: "", content: "B", files: [] },
		],
	});
	const wf = newWorkflow("attach-wf");

	setWorkflowResourceSelections(wf.id, [{ resourceSetId: set.id, resourceNames: ["a"] }]);
	assert.deepEqual(listWorkflowResourceSelections(wf.id), [{ resourceSetId: set.id, resourceNames: ["a"] }]);

	// Naming every resource means the whole set, stored as null rather than a list
	// that would silently stop covering a resource added later.
	setWorkflowResourceSelections(wf.id, [{ resourceSetId: set.id, resourceNames: ["a", "b"] }]);
	assert.deepEqual(listWorkflowResourceSelections(wf.id), [{ resourceSetId: set.id, resourceNames: null }]);

	// A name that isn't in the set is dropped; a set id that doesn't exist is refused.
	setWorkflowResourceSelections(wf.id, [{ resourceSetId: set.id, resourceNames: ["a", "ghost"] }]);
	assert.deepEqual(listWorkflowResourceSelections(wf.id), [{ resourceSetId: set.id, resourceNames: ["a"] }]);
	assert.throws(() => setWorkflowResourceSelections(wf.id, [{ resourceSetId: "nope" }]), /unknown_resource_set:nope/);
});

test("the injected preamble carries the SKILL.md and materialises the files on disk", () => {
	const set = insertResourceSet({
		name: "inject me",
		resources: [
			{
				name: "brainstorming",
				description: "options first",
				content: "# Brainstorming\n\nDiverge, then converge.",
				files: [{ path: "references/prompts.md", content: "# Prompts" }],
			},
			{ name: "unselected", description: "", content: "# Nope", files: [] },
		],
	});
	const wf = newWorkflow("inject-wf");
	setWorkflowResourceSelections(wf.id, [{ resourceSetId: set.id, resourceNames: ["brainstorming"] }]);

	const preamble = resourcesCatalogPreamble(wf.id);
	assert.match(preamble, /Diverge, then converge/);
	assert.match(preamble, /options first/);
	// Only what was selected — the point of a subset is that the rest stays out.
	assert.doesNotMatch(preamble, /# Nope/);

	const resourceDir = path.join(workflowResourcesDir(wf.id), "inject-me", "brainstorming");
	assert.equal(fs.readFileSync(path.join(resourceDir, "SKILL.md"), "utf8"), "# Brainstorming\n\nDiverge, then converge.");
	assert.equal(fs.readFileSync(path.join(resourceDir, "references", "prompts.md"), "utf8"), "# Prompts");
	// The preamble points at the material by absolute path rather than quoting it.
	assert.match(preamble, new RegExp(path.join(resourceDir, "references", "prompts.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	// Detaching everything both empties the preamble and clears the folder, so a
	// dropped resource stops existing instead of lingering for the agent to read.
	setWorkflowResourceSelections(wf.id, []);
	assert.equal(resourcesCatalogPreamble(wf.id), "");
});

test("a workflow with nothing attached injects nothing", () => {
	const wf = newWorkflow("bare-wf");
	assert.equal(resourcesCatalogPreamble(wf.id), "");
});

test("agents and documents inject beside skills, each under its own file name", () => {
	const set = insertResourceSet({
		name: "mixed",
		resources: [
			{ name: "brainstorming", description: "", content: "# Brainstorming", files: [] },
			{
				name: "code-reviewer",
				description: "Reviews diffs",
				kind: "agent",
				entryFile: "code-reviewer.md",
				content: "---\nname: code-reviewer\n---\n\nYou review code.",
				files: [],
			},
			{ name: "architecture", description: "", kind: "doc", entryFile: "architecture.markdown", content: "# Architecture", files: [] },
		],
	});
	const wf = newWorkflow("mixed-wf");
	setWorkflowResourceSelections(wf.id, [{ resourceSetId: set.id }]);

	const preamble = resourcesCatalogPreamble(wf.id);
	// Each block says what kind of thing the agent is being handed.
	assert.match(preamble, /### Skill: brainstorming/);
	assert.match(preamble, /### Agent: code-reviewer/);
	assert.match(preamble, /### Document: architecture/);
	assert.match(preamble, /You review code\./);

	const root = path.join(workflowResourcesDir(wf.id), "mixed");
	assert.ok(fs.existsSync(path.join(root, "brainstorming", "SKILL.md")));
	assert.ok(fs.existsSync(path.join(root, "code-reviewer", "code-reviewer.md")));
	assert.ok(fs.existsSync(path.join(root, "architecture", "architecture.markdown")));
});

test("a resource stored before kinds existed reads back as a skill", () => {
	// What every row written by the first cut of the feature looks like: no kind,
	// no entryFile. It has to keep meaning "a skill in a SKILL.md".
	const set = insertResourceSet({
		name: "legacy",
		resources: [{ name: "brainstorming", description: "", content: "# Brainstorming", files: [] }],
	});
	assert.equal(set.resources[0]?.kind, "skill");
	assert.equal(set.resources[0]?.entryFile, "SKILL.md");

	// An entry file that tries to climb out of its folder is reduced to a name.
	const escaped = insertResourceSet({
		name: "escaping entry",
		resources: [
			{ name: "a", description: "", kind: "agent", entryFile: "../../etc/passwd.md", content: "body", files: [] },
			{ name: "b", description: "", kind: "agent", entryFile: "not-markdown.txt", content: "body", files: [] },
		],
	});
	assert.equal(escaped.resources[0]?.entryFile, "passwd.md");
	assert.equal(escaped.resources[1]?.entryFile, "b.md");
});

test("usage reports the workflows and templates referencing a set, and delete detaches it", () => {
	const set = insertResourceSet({
		name: "referenced",
		resources: [
			{ name: "a", description: "", content: "A", files: [] },
			{ name: "b", description: "", content: "B", files: [] },
		],
	});
	const wf = newWorkflow("usage-wf");
	setWorkflowResourceSelections(wf.id, [{ resourceSetId: set.id, resourceNames: ["a"] }]);
	const template = insertTemplate({ name: "usage-tpl", resourceSelections: [{ resourceSetId: set.id }] });

	const usage = getResourceSetUsage(set.id);
	assert.deepEqual(usage?.workflows.map((w) => w.name), ["usage-wf"]);
	assert.deepEqual(usage?.workflows[0]?.resourceNames, ["a"]);
	assert.deepEqual(usage?.templates.map((t) => t.name), ["usage-tpl"]);
	// A whole-set attachment reports null rather than an enumeration.
	assert.equal(usage?.templates[0]?.resourceNames, null);

	// Filtering by a resource nobody selected finds only the whole-set references.
	const filtered = getResourceSetUsage(set.id, ["b"]);
	assert.equal(filtered?.workflows.length, 0);
	assert.equal(filtered?.templates.length, 1);

	assert.equal(getResourceSetUsage("nope"), null);

	assert.equal(deleteResourceSet(set.id), true);
	assert.deepEqual(listWorkflowResourceSelections(wf.id), []);
	assert.equal(getResourceSet(set.id), null);
	assert.equal(deleteResourceSet(set.id), false);
	// The template keeps its row; a selection pointing at a deleted set simply
	// resolves to nothing when the workflow is seeded from it.
	assert.equal(updateTemplate(template.id, {})?.resourceSelections.length, 1);
});

test("updateResourceSet replaces only the fields it is given", () => {
	const set = insertResourceSet({
		name: "partial",
		tags: ["one"],
		resources: [{ name: "a", description: "", content: "A", files: [] }],
	});
	const renamed = updateResourceSet(set.id, { name: "partial renamed" });
	assert.equal(renamed?.name, "partial renamed");
	assert.deepEqual(renamed?.tags, ["one"]);
	assert.equal(renamed?.resources.length, 1);
	assert.equal(updateResourceSet("nope", { name: "x" }), null);
});

test("a selection stored under the old skillSetId/skillNames keys still resolves", () => {
	// What rows and exported bundles written by the first cut of the feature look
	// like. The set they point at is unchanged, so they have to keep attaching it.
	const set = insertResourceSet({
		name: "legacy keys",
		resources: [
			{ name: "a", description: "", content: "A", files: [] },
			{ name: "b", description: "", content: "B", files: [] },
		],
	});
	const template = insertTemplate({
		name: "legacy-tpl",
		resourceSelections: [{ skillSetId: set.id, skillNames: ["a"] }],
	});
	assert.deepEqual(template.resourceSelections, [{ resourceSetId: set.id, resourceNames: ["a"] }]);

	const wf = newWorkflow("legacy-keys-wf");
	setWorkflowResourceSelections(wf.id, [{ skillSetId: set.id, skillNames: ["b"] }] as never);
	assert.deepEqual(listWorkflowResourceSelections(wf.id), [{ resourceSetId: set.id, resourceNames: ["b"] }]);
});

test("template resource selections survive a round-trip through the templates table", () => {
	const set = insertResourceSet({ name: "tpl-set", resources: [{ name: "a", description: "", content: "A", files: [] }] });
	const template = insertTemplate({ name: "tpl", resourceSelections: [{ resourceSetId: set.id, resourceNames: ["a"] }] });
	assert.deepEqual(template.resourceSelections, [{ resourceSetId: set.id, resourceNames: ["a"] }]);
	// Omitting the field on update leaves the stored selection untouched.
	assert.deepEqual(updateTemplate(template.id, { name: "tpl2" })?.resourceSelections, [
		{ resourceSetId: set.id, resourceNames: ["a"] },
	]);
	assert.deepEqual(updateTemplate(template.id, { resourceSelections: [] })?.resourceSelections, []);
});
