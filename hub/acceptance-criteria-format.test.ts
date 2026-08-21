/**
 * Tests for how a step's ACCEPTANCE CRITERIA are displayed in the step card.
 *
 * The criteria are written by the operator, in an editor whose toolbar is bold,
 * italic, bullet/ordered lists and headings — and which saves what it produces
 * as Markdown ("Format with the toolbar — bold, lists and headings are saved as
 * Markdown", AddStepModal/StepItem's expandable editor). The card printed that
 * text into a single `<p>`, so HTML collapsed every newline into a space and a
 * criterion typed as
 *
 *     1. implementation should follow plan.md
 *     2. transition, depending on what is available:
 *     - epic should be in status IN AI DEVELOPMENT
 *     - stories should be in status IN DEV
 *
 * came back on screen as one unbroken run of text — while the task description
 * directly above it, the same kind of operator-written text, kept its shape.
 *
 * The fix routes the field through the renderer the result and error panes
 * already use (ui/src/lib/markdown.ts → ui/src/components/Markdown.tsx), which
 * covers both kinds of stored text: Markdown structure becomes real lists and
 * headings, and plain multi-line text keeps its breaks because a Markdown
 * paragraph is `white-space: pre-wrap`.
 *
 * Pure functions and source reads, like step-result-format.test.ts: no DOM, and
 * no TARGET_HOME, since nothing here touches the hub's storage.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const { parseMarkdown } = await import("./ui/src/lib/markdown.ts");

type Block = ReturnType<typeof parseMarkdown>[number];

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src");
const read = (rel: string): string => fs.readFileSync(path.join(uiDir, rel), "utf8");

/** Flattens a block's text the way a reader would see it. */
function textOf(block: Block): string {
	if (block.kind === "code") return block.text;
	if (block.kind === "rule") return "";
	if (block.kind === "list") return block.items.map((item) => flatten(item.children)).join("\n");
	return flatten(block.children);
}

function flatten(nodes: { kind: string; text?: string; children?: unknown }[]): string {
	return nodes
		.map((node) =>
			node.kind === "text" || node.kind === "code"
				? (node.text ?? "")
				: flatten((node.children ?? []) as { kind: string; text?: string }[]),
		)
		.join("");
}

// ---------------------------------------------------------------------------
// The text the operator actually types
// ---------------------------------------------------------------------------

test("the criteria from the report come out as structure, not one line", () => {
	const criteria = [
		"1. implamentation should be done follow plan .md",
		"2. transition,  this depend of available transitions:",
		"   - epic should be in status IN AI DEVELOPMENT",
		"   - stories should be in status IN DEV",
	].join("\n");

	const blocks = parseMarkdown(criteria);

	// Not a single paragraph: the numbered steps are a list.
	const ordered = blocks.find((block) => block.kind === "list" && block.ordered);
	assert.ok(ordered, "the numbered criteria parse as an ordered list");
	assert.equal(ordered.kind === "list" ? ordered.items.length : 0, 2);

	// And the two statuses are a nested list under the second item, not text
	// glued onto the end of it.
	const nested = ordered.kind === "list" ? ordered.items[1].list : null;
	assert.ok(nested, "the two transition statuses nest under criterion 2");
	assert.equal(nested.ordered, false);
	assert.deepEqual(
		nested.items.map((item) => flatten(item.children)),
		["epic should be in status IN AI DEVELOPMENT", "stories should be in status IN DEV"],
	);
});

test("plain multi-line criteria keep their line breaks", () => {
	// No Markdown markers at all — the breaks are the only structure there is,
	// and they have to survive, which is what the old single <p> lost.
	const blocks = parseMarkdown("must build clean\nmust pass the smoke test");

	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].kind, "paragraph");
	assert.equal(textOf(blocks[0]), "must build clean\nmust pass the smoke test");

	// The break is only visible because the paragraph is preformatted-wrapping.
	const css = read("components/Markdown.module.css");
	const paragraph = /\.paragraph \{([^}]*)\}/.exec(css)?.[1] ?? "";
	assert.match(paragraph, /white-space:\s*pre-wrap/);
});

test("a heading and bold from the editor's toolbar survive to the card", () => {
	const blocks = parseMarkdown("## Done when\n\n**all** tests green");

	assert.equal(blocks[0].kind, "heading");
	assert.equal(textOf(blocks[0]), "Done when");
	const strong = blocks[1].kind === "paragraph" ? blocks[1].children.find((n) => n.kind === "strong") : undefined;
	assert.ok(strong, "bold from the toolbar stays bold");
});

// ---------------------------------------------------------------------------
// The wiring in the step card
// ---------------------------------------------------------------------------

test("the step card renders the criteria through the Markdown component", () => {
	const source = read("views/StepItem.tsx");

	assert.match(source, /import \{ Markdown \} from "\.\.\/components\/Markdown\.tsx"/);
	assert.match(source, /<Markdown\s+text=\{step\.acceptanceCriteria\}/);
	// The old shape: the field interpolated straight into the criteria <p>,
	// which is what collapsed the newlines.
	assert.doesNotMatch(source, /<p className=\{styles\.criteria\}>/);
	assert.doesNotMatch(source, /criteriaLabel\}>Accepts if:<\/span> \{step\.acceptanceCriteria\}/);
});

test('the "Accepts if:" label is kept, on its own line above the text', () => {
	const source = read("views/StepItem.tsx");
	const css = read("views/StepItem.module.css");

	assert.match(source, /<span className=\{styles\.criteriaLabel\}>Accepts if:<\/span>/);
	// A run-in label would push a leading list or heading off the left edge.
	const label = /\.criteriaLabel \{([^}]*)\}/.exec(css)?.[1] ?? "";
	assert.match(label, /display:\s*block/);
	assert.match(label, /font-weight:\s*6/);
});

test("the criteria box keeps its rail and sunken background", () => {
	const css = read("views/StepItem.module.css");
	const criteria = /\.criteria \{([^}]*)\}/.exec(css)?.[1] ?? "";

	assert.match(criteria, /border-left:\s*2px solid/);
	assert.match(criteria, /background:\s*var\(--surface-sunken\)/);
	// Size and colour still come from the box, which is why Markdown.module.css
	// sets neither at its root.
	assert.match(criteria, /font-size:\s*var\(--text-xs\)/);
	const markdownRoot = /\.markdown \{([^}]*)\}/.exec(read("components/Markdown.module.css"))?.[1] ?? "";
	assert.doesNotMatch(markdownRoot, /font-size/);
});
