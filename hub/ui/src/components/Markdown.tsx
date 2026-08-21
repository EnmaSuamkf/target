import { useMemo } from "react";
import type { Block, InlineNode, ListBlock } from "../lib/markdown.ts";
import { parseMarkdown } from "../lib/markdown.ts";
import styles from "./Markdown.module.css";

/**
 * Renders Markdown text as real formatting.
 *
 * Used for the parts of the UI whose text an agent wrote — a step's result and
 * the error it failed with — where the source is Markdown and showing it raw
 * meant the operator read `## What changed` instead of a heading.
 *
 * Everything is built as React elements from the block data in lib/markdown.ts:
 * no HTML string is ever produced, so an agent that writes `<script>` into its
 * result gets the characters `<script>` on screen, and the app has no
 * `dangerouslySetInnerHTML` on this path to be careless with. Links are limited
 * to http/https/mailto by the parser, and open in a new tab with `noopener`.
 *
 * `className` lands on the root beside the module's own class, so the caller
 * keeps owning the box — StepItem passes the collapsing, scrolling result pane
 * it already had, and this only decides what the text inside it looks like.
 */
// `className` is optional-or-undefined rather than merely optional, so a caller
// can pass a CSS-module class straight through (those are typed `string |
// undefined` under noUncheckedIndexedAccess) without wrapping it in a template.
export function Markdown({
	text,
	className,
}: { text: string; className?: string | undefined }): React.JSX.Element {
	const blocks = useMemo(() => parseMarkdown(text), [text]);
	return (
		<div className={className ? `${styles.markdown} ${className}` : styles.markdown}>
			{blocks.map((block, index) => renderBlock(block, index))}
		</div>
	);
}

function renderInline(nodes: InlineNode[]): React.ReactNode {
	return nodes.map((node, index) => {
		switch (node.kind) {
			case "text":
				return node.text;
			case "code":
				return (
					<code key={index} className={styles.code}>
						{node.text}
					</code>
				);
			case "strong":
				return <strong key={index}>{renderInline(node.children)}</strong>;
			case "em":
				return <em key={index}>{renderInline(node.children)}</em>;
			case "link":
				return (
					<a key={index} className={styles.link} href={node.href} target="_blank" rel="noopener noreferrer">
						{renderInline(node.children)}
					</a>
				);
		}
	});
}

function renderList(list: ListBlock, key: number): React.JSX.Element {
	const items = list.items.map((item, index) => (
		<li key={index}>
			{renderInline(item.children)}
			{item.list && renderList(item.list, 0)}
		</li>
	));
	return list.ordered ? (
		<ol key={key} className={styles.list} start={list.start}>
			{items}
		</ol>
	) : (
		<ul key={key} className={styles.list}>
			{items}
		</ul>
	);
}

function renderBlock(block: Block, key: number): React.JSX.Element {
	switch (block.kind) {
		case "heading": {
			// The card this sits in is deep in the page's outline, so an agent's
			// `#` is not a document h1: levels are pushed down to h3…h6 for the
			// outline, and the class — not the tag — carries the size.
			const Tag = `h${Math.min(6, block.level + 2)}` as "h3" | "h4" | "h5" | "h6";
			return (
				<Tag key={key} className={`${styles.heading} ${styles[`h${Math.min(4, block.level)}`] ?? ""}`}>
					{renderInline(block.children)}
				</Tag>
			);
		}
		case "paragraph":
			return (
				<p key={key} className={styles.paragraph}>
					{renderInline(block.children)}
				</p>
			);
		case "code":
			return (
				<pre key={key} className={styles.codeBlock} data-language={block.language ?? undefined}>
					<code>{block.text}</code>
				</pre>
			);
		case "quote":
			return (
				<blockquote key={key} className={styles.quote}>
					{renderInline(block.children)}
				</blockquote>
			);
		case "rule":
			return <hr key={key} className={styles.rule} />;
		case "list":
			return renderList(block, key);
	}
}
