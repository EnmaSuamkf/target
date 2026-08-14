/**
 * Tests for how a step's RESOLUTION is displayed: the result it reports when it
 * succeeds, and the error it carries when it fails.
 *
 * Both are written by an agent, and agents write Markdown — `## What changed`,
 * `**1. Canvas**`, `- ` bullets, backticked paths. The step card used to print
 * that into a `<pre>`, so the operator read the markers instead of the structure
 * they encode. The rendering path is now parse-then-build-elements:
 * ui/src/lib/markdown.ts turns the text into blocks, and ui/src/components/
 * Markdown.tsx turns those blocks into React elements.
 *
 * What's covered here:
 *
 *  1. **The parser** — the subset agents actually emit (headings, bold/italic,
 *     inline code, fenced code, bullet/ordered/nested lists, links, quotes,
 *     rules, paragraphs), including a real result of the shape that prompted
 *     this, which has to come out as many blocks and not one wall of text.
 *  2. **The safety rule** — the reason this is a parser and not a
 *     string-of-HTML renderer: an agent's text is untrusted, so `<script>` stays
 *     characters and a `javascript:` target never becomes a link. Pinned on the
 *     data AND on the source, because a later `dangerouslySetInnerHTML` would
 *     pass every behavioural test in this file while undoing all of it.
 *  3. **The wiring** — that BOTH panes in StepItem render through the component,
 *     that the failure is visually distinct from the success, and that the
 *     collapse/"Show more" behaviour and the scrolling expanded box survived.
 *
 * Pure functions and source reads, like canvas-view.test.ts: no DOM, and no
 * TARGET_HOME, since nothing here touches the hub's storage.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const { parseInline, parseMarkdown } = await import("./ui/src/lib/markdown.ts");

type Block = ReturnType<typeof parseMarkdown>[number];
type InlineNode = ReturnType<typeof parseInline>[number];

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src");
const read = (rel: string): string => fs.readFileSync(path.join(uiDir, rel), "utf8");

/** Flattens a block's rendered text, the way a reader would see it. */
function textOf(nodes: InlineNode[]): string {
	return nodes
		.map((node) => {
			switch (node.kind) {
				case "text":
				case "code":
					return node.text;
				default:
					return textOf(node.children);
			}
		})
		.join("");
}

/** Every inline node in a tree, at any depth. */
function allInline(nodes: InlineNode[]): InlineNode[] {
	return nodes.flatMap((node) => (node.kind === "text" || node.kind === "code" ? [node] : [node, ...allInline(node.children)]));
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

test("headings keep their level and their text, without the hashes", () => {
	const blocks = parseMarkdown("# One\n## Two\n###### Six\n#NotAHeading");

	assert.deepEqual(
		blocks.map((b) => (b.kind === "heading" ? `${b.level}:${textOf(b.children)}` : b.kind)),
		["1:One", "2:Two", "6:Six", "paragraph"],
	);
});

test("bold, italic and inline code are marked up, and code wins over the rest", () => {
	const nodes = parseInline("**bold** and *italic* and `**not bold**`");

	assert.deepEqual(
		nodes.map((n) => n.kind),
		["strong", "text", "em", "text", "code"],
	);
	const code = nodes[4];
	assert.equal(code?.kind === "code" && code.text, "**not bold**");
});

test("snake_case survives: an underscore inside a word is not italics", () => {
	const nodes = parseInline("run step_results.ts now");

	assert.deepEqual(nodes, [{ kind: "text", text: "run step_results.ts now" }]);
});

test("a paragraph keeps the line breaks the agent typed", () => {
	const blocks = parseMarkdown("first line\nsecond line\n\nnext paragraph");

	assert.equal(blocks.length, 2);
	assert.equal(blocks[0]?.kind, "paragraph");
	assert.equal(blocks[0]?.kind === "paragraph" && textOf(blocks[0].children), "first line\nsecond line");
});

test("bullet and ordered lists become lists, and an ordered one keeps its first number", () => {
	const blocks = parseMarkdown("- one\n- two\n\n3. three\n4. four");

	assert.deepEqual(
		blocks.map((b) => b.kind),
		["list", "list"],
	);
	const [bullets, numbers] = blocks;
	assert.equal(bullets?.kind === "list" && bullets.ordered, false);
	assert.deepEqual(bullets?.kind === "list" && bullets.items.map((i) => textOf(i.children)), ["one", "two"]);
	assert.equal(numbers?.kind === "list" && numbers.ordered, true);
	assert.equal(numbers?.kind === "list" && numbers.start, 3);
});

test("an indented item nests under the item above it instead of flattening", () => {
	const blocks = parseMarkdown("- parent\n  - child\n  - sibling\n- second parent");
	const list = blocks[0];

	assert.equal(list?.kind, "list");
	if (list?.kind !== "list") return;
	assert.deepEqual(list.items.map((i) => textOf(i.children)), ["parent", "second parent"]);
	assert.deepEqual(list.items[0]?.list?.items.map((i) => textOf(i.children)), ["child", "sibling"]);
	assert.equal(list.items[1]?.list, null);
});

test("a fenced code block keeps its language and its text verbatim", () => {
	const blocks = parseMarkdown("before\n```ts\nconst a = 1;\n\n  const b = 2;\n```\nafter");

	assert.deepEqual(
		blocks.map((b) => b.kind),
		["paragraph", "code", "paragraph"],
	);
	const code = blocks[1];
	assert.equal(code?.kind === "code" && code.language, "ts");
	assert.equal(code?.kind === "code" && code.text, "const a = 1;\n\n  const b = 2;");
});

test("a fence that is never closed still renders what it contained", () => {
	const blocks = parseMarkdown("```\ntruncated output");

	assert.equal(blocks.length, 1);
	assert.equal(blocks[0]?.kind === "code" && blocks[0].text, "truncated output");
});

test("markers inside a fenced block stay literal", () => {
	const blocks = parseMarkdown("```\n## not a heading\n- not a bullet\n```");

	assert.equal(blocks.length, 1);
	assert.equal(blocks[0]?.kind === "code" && blocks[0].text, "## not a heading\n- not a bullet");
});

test("quotes and rules are their own blocks", () => {
	const blocks = parseMarkdown("> quoted\n> still quoted\n\n---\n\ntail");

	assert.deepEqual(
		blocks.map((b) => b.kind),
		["quote", "rule", "paragraph"],
	);
	assert.equal(blocks[0]?.kind === "quote" && textOf(blocks[0].children), "quoted\nstill quoted");
});

test("links carry their target, and a bare URL becomes one too", () => {
	const nodes = allInline(parseInline("see [the PR](https://example.com/pr/1) or https://example.com/x"));
	const links = nodes.filter((n) => n.kind === "link");

	assert.deepEqual(
		links.map((n) => (n.kind === "link" ? [n.href, textOf(n.children)] : [])),
		[
			["https://example.com/pr/1", "the PR"],
			["https://example.com/x", "https://example.com/x"],
		],
	);
});

test("a real agent result comes out as structure, not one block of text", () => {
	const result = [
		"## What changed",
		"",
		"**1. Canvas** — the start view now opens on the graph.",
		"",
		"- `hub/ui/src/views/WorkflowCanvas.tsx` — zoom control",
		"- `hub/ui/src/lib/canvasLayout.ts` — subagent boxes",
		"",
		"## Verification",
		"",
		"1. `npm test` — all green",
		"2. `npm run typecheck` — clean",
	].join("\n");

	const blocks = parseMarkdown(result);

	assert.deepEqual(
		blocks.map((b) => b.kind),
		["heading", "paragraph", "list", "heading", "list"],
	);
	// The `**1. Canvas**` lead-in is bold text, not a numbered list.
	assert.equal(blocks[1]?.kind === "paragraph" && blocks[1].children[0]?.kind, "strong");
	// The paths are code spans, so they read as paths.
	const bullets = blocks[2];
	assert.equal(
		bullets?.kind === "list" && allInline(bullets.items[0]?.children ?? []).some((n) => n.kind === "code"),
		true,
	);
	assert.equal(blocks[4]?.kind === "list" && blocks[4].ordered, true);
});

test("plain text with no markers is still rendered, as one paragraph", () => {
	const blocks = parseMarkdown("Step aborted by the operator.");

	assert.deepEqual(blocks, [{ kind: "paragraph", children: [{ kind: "text", text: "Step aborted by the operator." }] }]);
});

// ---------------------------------------------------------------------------
// The safety rule
// ---------------------------------------------------------------------------

test("HTML in an agent's text stays text — it is never a node of its own", () => {
	const blocks = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');

	assert.deepEqual(
		blocks.map((b) => (b.kind === "paragraph" ? textOf(b.children) : b.kind)),
		["<script>alert(1)</script>", "<img src=x onerror=alert(1)>"],
	);
});

test("a javascript: or data: target is refused and left as the text it was", () => {
	for (const source of ["[click](javascript:alert(1))", "[click](data:text/html,<script>)", "[click](vbscript:x)"]) {
		const nodes = allInline(parseInline(source));
		assert.equal(
			nodes.some((n) => n.kind === "link"),
			false,
			`${source} must not produce a link`,
		);
		assert.equal(textOf(nodes), source, `${source} must survive as its own text`);
	}
});

test("nothing on the display path builds HTML from the agent's text", () => {
	// The `=` is what makes these uses rather than the prose explaining why the
	// path avoids them.
	for (const file of ["lib/markdown.ts", "components/Markdown.tsx", "views/StepItem.tsx"]) {
		assert.doesNotMatch(read(file), /dangerouslySetInnerHTML\s*=|\.innerHTML\s*=/, `${file} must not inject HTML`);
	}
});

test("links open in a new tab without handing it the opener", () => {
	const source = read("components/Markdown.tsx");

	assert.match(source, /target="_blank"/);
	assert.match(source, /rel="noopener noreferrer"/);
});

// ---------------------------------------------------------------------------
// The wiring in the step card
// ---------------------------------------------------------------------------

test("both the result and the error render through the Markdown component", () => {
	const source = read("views/StepItem.tsx");

	assert.match(source, /import \{ Markdown \} from "\.\.\/components\/Markdown\.tsx"/);
	// The result, and no longer a <pre> full of raw text.
	assert.match(source, /<Markdown\s+text=\{step\.result[^}]*\}/);
	assert.doesNotMatch(source, /<pre[^>]*resultBody/);
	// The failure path, which is the half that used to be forgotten.
	assert.match(source, /<Markdown\s+text=\{step\.error\}/);
	// Still announced as an alert.
	assert.match(source, /className=\{styles\.error\} role="alert"/);
});

test("the collapse toggle survived on both panes, and each has its own state", () => {
	const source = read("views/StepItem.tsx");
	const toggles = source.match(/Show less" : "Show more"/g) ?? [];

	assert.equal(toggles.length, 2, "result and error each offer the toggle");
	assert.match(source, /setExpanded\(\(v\) => !v\)/);
	assert.match(source, /setErrorExpanded\(\(v\) => !v\)/);
	// The expanded pane is the one that scrolls, and both panes reuse it.
	const expanded = source.match(/styles\.resultExpanded/g) ?? [];
	assert.equal(expanded.length, 2);
});

test("the failed pane is the same box in the danger palette", () => {
	const css = read("views/StepItem.module.css");
	const errorBody = /\.errorBody \{([^}]*)\}/.exec(css)?.[1] ?? "";

	assert.match(errorBody, /--danger-500/);
	assert.match(errorBody, /--danger-50\b/);
	assert.match(errorBody, /--danger-700/);
	// Sizing/clamping stays in one place: .errorBody only re-colours .resultBody.
	assert.doesNotMatch(errorBody, /max-height/);
	assert.match(read("views/StepItem.tsx"), /styles\.resultBody\} \$\{styles\.errorBody\}/);
});

test("the pane still clamps its height, fades the cut and scrolls once expanded", () => {
	const css = read("views/StepItem.module.css");
	const body = /\.resultBody \{([^}]*)\}/.exec(css)?.[1] ?? "";
	const expanded = /\.resultExpanded \{([^}]*)\}/.exec(css)?.[1] ?? "";

	assert.match(body, /max-height:/);
	assert.match(body, /mask-image:/);
	assert.match(expanded, /overflow-y: auto/);
});
