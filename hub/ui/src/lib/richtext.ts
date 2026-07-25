/**
 * Markdown ⇄ HTML conversion for the rich-text popup editor.
 *
 * Every value in Target is ultimately plain text handed to an agent, so the
 * editor stores Markdown, not HTML. The popup renders that Markdown as real
 * formatting (bold, italic, lists, headings) in a contentEditable surface and
 * converts back on save. The subset is deliberately small — exactly what the
 * toolbar can produce — so the round trip is lossless for anything the editor
 * itself created.
 */

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline markdown (bold/italic) on an already HTML-escaped line. */
function inlineHtml(text: string): string {
	let out = escapeHtml(text);
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>");
	return out;
}

/** Renders the Markdown subset the editor understands into HTML. */
export function markdownToHtml(text: string): string {
	const lines = text.split("\n");
	const html: string[] = [];
	let list: "ul" | "ol" | null = null;

	const closeList = (): void => {
		if (list) {
			html.push(`</${list}>`);
			list = null;
		}
	};

	for (const line of lines) {
		const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
		const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		const heading = /^(#{1,3})\s+(.*)$/.exec(line);

		if (bullet) {
			if (list !== "ul") {
				closeList();
				html.push("<ul>");
				list = "ul";
			}
			html.push(`<li>${inlineHtml(bullet[1] ?? "")}</li>`);
		} else if (ordered) {
			if (list !== "ol") {
				closeList();
				html.push("<ol>");
				list = "ol";
			}
			html.push(`<li>${inlineHtml(ordered[1] ?? "")}</li>`);
		} else if (heading) {
			closeList();
			const level = heading[1]?.length ?? 1;
			html.push(`<h${level}>${inlineHtml(heading[2] ?? "")}</h${level}>`);
		} else if (line.trim() === "") {
			closeList();
			html.push("<div><br></div>");
		} else {
			closeList();
			html.push(`<div>${inlineHtml(line)}</div>`);
		}
	}
	closeList();
	return html.join("");
}

/** Inline serialization: text with bold/italic markers, <br> as newline. */
function collectInline(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return (node.textContent ?? "").replace(/\u00a0/g, " ");
	}
	if (!(node instanceof HTMLElement)) return "";
	const inner = Array.from(node.childNodes).map(collectInline).join("");
	const tag = node.tagName;
	if (tag === "BR") return "\n";
	if (tag === "STRONG" || tag === "B") return inner.trim() === "" ? inner : `**${inner}**`;
	if (tag === "EM" || tag === "I") return inner.trim() === "" ? inner : `*${inner}*`;
	return inner;
}

/**
 * Serializes the contentEditable DOM back to the Markdown subset.
 *
 * contentEditable output varies by browser (divs vs <br>, nested spans with
 * style attributes, &nbsp;), so this walks the DOM rather than regexing
 * innerHTML: block elements become lines, lists become `- ` / `1. ` prefixes,
 * strong/em become `**`/`*`, and everything unknown falls through to its text.
 */
export function htmlToMarkdown(root: HTMLElement): string {
	const lines: string[] = [];
	let buffer = "";

	const flush = (): void => {
		lines.push(buffer);
		buffer = "";
	};

	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			buffer += (node.textContent ?? "").replace(/\u00a0/g, " ");
			return;
		}
		if (!(node instanceof HTMLElement)) return;
		const tag = node.tagName;

		if (tag === "BR") {
			flush();
			return;
		}
		if (tag === "STRONG" || tag === "B" || tag === "EM" || tag === "I") {
			buffer += collectInline(node);
			return;
		}
		if (tag === "UL" || tag === "OL") {
			if (buffer.trim() !== "") flush();
			else buffer = "";
			let index = 1;
			for (const item of Array.from(node.children)) {
				if (item.tagName !== "LI") continue;
				const text = collectInline(item).replace(/\n/g, " ").trim();
				lines.push((tag === "UL" ? "- " : `${index++}. `) + text);
			}
			return;
		}
		if (/^H[1-6]$/.test(tag)) {
			if (buffer.trim() !== "") flush();
			else buffer = "";
			const level = Math.min(3, parseInt(tag.slice(1), 10) || 1);
			lines.push(`${"#".repeat(level)} ${collectInline(node).replace(/\n/g, " ").trim()}`);
			return;
		}
		if (tag === "DIV" || tag === "P") {
			if (buffer.trim() !== "") flush();
			else buffer = "";
			for (const child of Array.from(node.childNodes)) walk(child);
			if (buffer !== "") flush();
			return;
		}
		// Unknown inline container (span, u, font…): keep its content.
		for (const child of Array.from(node.childNodes)) walk(child);
	};

	for (const child of Array.from(root.childNodes)) walk(child);
	if (buffer !== "") flush();

	return lines
		.join("\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
