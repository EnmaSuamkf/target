/**
 * Markdown → data, for text the hub did not write.
 *
 * A step's resolution — the result it reports, or the error it failed with — is
 * written by an agent, and agents write Markdown: `## What changed`, `**1.
 * Canvas**`, `- ` bullets, backticked paths. Shown as preformatted text that
 * read as a wall of `##` and `**`, which is the opposite of what the markers are
 * for. This turns that text into blocks the UI can render as real formatting.
 *
 * It is a parser, not a renderer: it returns plain data and never HTML, so the
 * component consuming it (components/Markdown.tsx) builds React elements and
 * React does the escaping. There is no `dangerouslySetInnerHTML` anywhere on
 * this path — an agent's result is untrusted text, and the one rule that makes
 * it safe to display is that no part of it is ever parsed as HTML. Link targets
 * are the other half of that rule: only http/https/mailto survive as links (see
 * `safeHref`), so a `javascript:` URL degrades to the literal text it was.
 *
 * The subset is what agents actually emit — headings, bold/italic, inline code,
 * fenced code, bullet and ordered lists (nested), links, block quotes, rules and
 * paragraphs. Tables and reference links are deliberately out: unsupported
 * syntax falls through as its own text, which is exactly what the raw `<pre>`
 * used to show for everything.
 *
 * Kept separate from lib/richtext.ts on purpose. That one round-trips the
 * rich-text editor's own output through a contentEditable DOM and is bounded by
 * what its toolbar can produce; this one has to survive arbitrary agent prose
 * and has no DOM at all — which is also why it is unit-testable from the hub's
 * node:test suite (see hub/step-result-format.test.ts).
 */

export type InlineNode =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "strong"; children: InlineNode[] }
	| { kind: "em"; children: InlineNode[] }
	| { kind: "link"; href: string; children: InlineNode[] };

export type ListItem = {
	children: InlineNode[];
	/** A nested list under this item, if the source indented one below it. */
	list: ListBlock | null;
};

export type ListBlock = {
	kind: "list";
	ordered: boolean;
	/** The first number of an ordered list, so `3.` doesn't renumber to `1.`. */
	start: number;
	items: ListItem[];
};

export type Block =
	| { kind: "heading"; level: number; children: InlineNode[] }
	| { kind: "paragraph"; children: InlineNode[] }
	| { kind: "code"; language: string | null; text: string }
	| { kind: "quote"; children: InlineNode[] }
	| { kind: "rule" }
	| ListBlock;

/**
 * One pass over a line of text, matching whichever inline construct comes
 * first. Order inside the alternation is precedence: code spans win over
 * everything (so `**` inside backticks stays literal), `**bold**` is tried
 * before `*italic*`, and a bare URL is the last resort.
 */
const INLINE_SOURCE = [
	// Code span: N backticks, closed by the same count.
	"(?<ticks>`+)(?<code>[\\s\\S]*?)\\k<ticks>",
	"\\*\\*(?<strong>[^\\n]+?)\\*\\*",
	"__(?<strongAlt>[^_\\n]+?)__",
	"\\*(?<em>[^*\\n]+?)\\*",
	// `_italic_` only between non-word characters, so snake_case_names survive.
	"(?<![A-Za-z0-9_])_(?<emAlt>[^_\\n]+?)_(?![A-Za-z0-9_])",
	// Inline link, with the optional title CommonMark allows dropped.
	"!?\\[(?<linkText>[^\\]\\n]*)\\]\\((?<linkHref>[^()\\s]*)(?:\\s+\"[^\"\\n]*\")?\\)",
	"<(?<angle>[A-Za-z][A-Za-z0-9+.-]*:[^>\\s]+)>",
	// Bare URL, not swallowing the sentence punctuation that follows it.
	"(?<bare>https?://[^\\s<>\"'`]*[^\\s<>\"'`.,;:!?)\\]}])",
].join("|");

/**
 * The link allow-list. Anything that isn't a plain web or mail address comes
 * back null and is rendered as the text it was written as: `javascript:` and
 * `data:` are the injection vectors, and a relative path in an agent's result is
 * a file on disk, not a page this app can open.
 */
function safeHref(raw: string): string | null {
	const href = raw.trim();
	if (!/^(?:https?|mailto):/i.test(href)) return null;
	// Control characters can smuggle a scheme past the test above once a browser
	// strips them out of the attribute.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(href)) return null;
	return href;
}

/** Appends `text` to the trailing text node, or starts one, skipping empties. */
function pushText(nodes: InlineNode[], text: string): void {
	if (text === "") return;
	const last = nodes[nodes.length - 1];
	if (last && last.kind === "text") last.text += text;
	else nodes.push({ kind: "text", text });
}

/** Parses the inline markers inside one block's text. */
export function parseInline(text: string): InlineNode[] {
	const nodes: InlineNode[] = [];
	let cursor = 0;
	// A fresh matcher per call: this function recurses into the text it just
	// matched (bold inside a link, code inside bold), and a shared `g` regex
	// would have its `lastIndex` reset under the caller by its own callee.
	const scanner = new RegExp(INLINE_SOURCE, "g");

	for (let match = scanner.exec(text); match; match = scanner.exec(text)) {
		const groups = match.groups ?? {};
		const raw = match[0];
		pushText(nodes, text.slice(cursor, match.index));
		cursor = match.index + raw.length;

		if (groups.code !== undefined) {
			// CommonMark strips one padding space each side, so `` ` `` renders.
			nodes.push({ kind: "code", text: groups.code.replace(/^ (.*) $/s, "$1") });
			continue;
		}
		const strong = groups.strong ?? groups.strongAlt;
		if (strong !== undefined) {
			nodes.push({ kind: "strong", children: parseInline(strong) });
			continue;
		}
		const em = groups.em ?? groups.emAlt;
		if (em !== undefined) {
			nodes.push({ kind: "em", children: parseInline(em) });
			continue;
		}
		if (groups.linkText !== undefined && groups.linkHref !== undefined) {
			const href = safeHref(groups.linkHref);
			// A refused target keeps the source text visible rather than silently
			// dropping either half of it.
			if (href === null) pushText(nodes, raw);
			else nodes.push({ kind: "link", href, children: parseInline(groups.linkText || groups.linkHref) });
			continue;
		}
		const url = groups.angle ?? groups.bare;
		if (url !== undefined) {
			const href = safeHref(url);
			if (href === null) pushText(nodes, raw);
			else nodes.push({ kind: "link", href, children: [{ kind: "text", text: url }] });
			continue;
		}
	}

	pushText(nodes, text.slice(cursor));
	return nodes;
}

/** A list line as read off the source, before nesting is worked out. */
type RawItem = { indent: number; ordered: boolean; start: number; text: string };

const BULLET = /^(\s*)[-*+][ \t]+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)[ \t]*([^\s`]*)[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * Folds the flat list lines into nested lists by indent, starting at `from` and
 * returning the index of the first line that belongs to an outer level. A
 * deeper item hangs off the item above it; a shallower one, or one that switches
 * between bulleted and numbered, ends this list.
 */
function buildList(items: RawItem[], from: number): [ListBlock, number] {
	const first = items[from] as RawItem;
	const list: ListBlock = { kind: "list", ordered: first.ordered, start: first.start, items: [] };
	let at = from;

	while (at < items.length) {
		const item = items[at] as RawItem;
		if (item.indent < first.indent) break;
		if (item.indent > first.indent) {
			const [nested, next] = buildList(items, at);
			const parent = list.items[list.items.length - 1];
			if (parent) parent.list = nested;
			else list.items.push({ children: [], list: nested });
			at = next;
			continue;
		}
		if (item.ordered !== first.ordered) break;
		list.items.push({ children: parseInline(item.text), list: null });
		at += 1;
	}

	return [list, at];
}

/** Reads one line as a list item, or null when it isn't one. */
function readItem(line: string): RawItem | null {
	const ordered = ORDERED.exec(line);
	if (ordered) {
		return {
			indent: (ordered[1] ?? "").length,
			ordered: true,
			start: parseInt(ordered[2] ?? "1", 10) || 1,
			text: ordered[3] ?? "",
		};
	}
	const bullet = BULLET.exec(line);
	if (bullet) return { indent: (bullet[1] ?? "").length, ordered: false, start: 1, text: bullet[2] ?? "" };
	return null;
}

/**
 * Splits text into blocks. Anything the subset doesn't recognise ends up in a
 * paragraph, whose own line breaks are preserved (agents lay out their results
 * with them, and a hard-wrapped result reflowed into one run of prose loses
 * information the writer put there).
 */
export function parseMarkdown(text: string): Block[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let paragraph: string[] = [];
	let at = 0;

	const flush = (): void => {
		if (paragraph.length === 0) return;
		const joined = paragraph.join("\n").trim();
		paragraph = [];
		if (joined !== "") blocks.push({ kind: "paragraph", children: parseInline(joined) });
	};

	while (at < lines.length) {
		const line = lines[at] ?? "";

		const fence = FENCE.exec(line);
		if (fence) {
			flush();
			const marker = fence[1] as string;
			const body: string[] = [];
			at += 1;
			const closing = new RegExp(`^ {0,3}${marker}[ \\t]*$`);
			while (at < lines.length && !closing.test(lines[at] ?? "")) {
				body.push(lines[at] ?? "");
				at += 1;
			}
			// Past the closing fence, or past the end for a block never closed —
			// a truncated result must still render everything it did contain.
			at += 1;
			blocks.push({ kind: "code", language: fence[2] || null, text: body.join("\n") });
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			blocks.push({
				kind: "heading",
				level: (heading[1] ?? "#").length,
				children: parseInline((heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "")),
			});
			at += 1;
			continue;
		}

		if (RULE.test(line)) {
			flush();
			blocks.push({ kind: "rule" });
			at += 1;
			continue;
		}

		const quote = QUOTE.exec(line);
		if (quote) {
			flush();
			const quoted: string[] = [quote[1] ?? ""];
			at += 1;
			for (let next = QUOTE.exec(lines[at] ?? ""); next && at < lines.length; next = QUOTE.exec(lines[at] ?? "")) {
				quoted.push(next[1] ?? "");
				at += 1;
			}
			blocks.push({ kind: "quote", children: parseInline(quoted.join("\n").trim()) });
			continue;
		}

		if (readItem(line)) {
			flush();
			const raws: RawItem[] = [];
			while (at < lines.length) {
				const current = lines[at] ?? "";
				const item = readItem(current);
				if (item) {
					raws.push(item);
					at += 1;
					continue;
				}
				// A blank line inside a list is only a break if the list really
				// ended; peek at the next line to tell the two apart.
				if (current.trim() === "" && readItem(lines[at + 1] ?? "")) {
					at += 1;
					continue;
				}
				// An indented line under an item continues that item's text.
				const last = raws[raws.length - 1];
				if (last && current.trim() !== "" && /^\s{2,}/.test(current)) {
					last.text += ` ${current.trim()}`;
					at += 1;
					continue;
				}
				break;
			}
			let cursor = 0;
			while (cursor < raws.length) {
				const [list, next] = buildList(raws, cursor);
				blocks.push(list);
				cursor = next > cursor ? next : cursor + 1;
			}
			continue;
		}

		if (line.trim() === "") {
			flush();
			at += 1;
			continue;
		}

		paragraph.push(line);
		at += 1;
	}

	flush();
	return blocks;
}
