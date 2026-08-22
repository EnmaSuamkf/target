/**
 * What kinds of resource RCI carries, and what counts as one on disk.
 *
 * Mirrors `hub/rci-import.ts`: the browser decides which files are offerable in
 * the import picker, the hub decides what it actually reads, and the two have
 * to agree or the picker shows files the import then refuses.
 */
import type { ResourceKind } from "./api/types.ts";

export const RESOURCE_KINDS: ResourceKind[] = ["skill", "agent", "doc"];

export const KIND_LABELS: Record<ResourceKind, string> = {
	skill: "Skill",
	agent: "Agent",
	doc: "Doc",
};

export const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx", ".mdown", ".mkd"];

export function isMarkdownFile(name: string): boolean {
	const lower = name.toLowerCase();
	return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Same rule as the hub's `normalizeEntryFile`, so the editor shows what will be stored. */
export function defaultEntryFile(kind: ResourceKind, name: string): string {
	if (kind === "skill") return "SKILL.md";
	const slug =
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "resource";
	return `${slug}.md`;
}
