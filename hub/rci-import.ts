/**
 * Reading resources off disk so a Resource Set can take them in.
 *
 * A resource is a Markdown file the agent should have read: a skill, an
 * agent/subagent definition, or a plain reference document. The shapes this
 * accepts are the ones those things actually ship in — a folder whose SKILL.md
 * or AGENT.md makes it a bundle, a tree of those, a folder of loose `.md`
 * files, or one `.md` pointed at directly. Anything beside a bundle's entry
 * file comes along — references, evals, scripts — because that material is
 * exactly what a skill is useless without, and the whole point of RCI is that
 * the operator reads the folder in once instead of installing it into an agent.
 */
import fs from "node:fs";
import path from "node:path";
import type { Resource, ResourceFile, ResourceKind } from "./rci-store.ts";

/** One file over this is left behind; the rest of the folder still comes in. */
export const MAX_RESOURCE_FILE_BYTES = 256 * 1024;
/** Ceiling for one import, so a stray `node_modules` can't put a GB in SQLite. */
export const MAX_RESOURCE_SET_BYTES = 16 * 1024 * 1024;
/** How deep to look below the folder handed to us. */
export const MAX_SCAN_DEPTH = 4;
/** A folder of docs can hold thousands of `.md`; one import stops here. */
export const MAX_RESOURCES = 200;

/** Every Markdown flavour we accept as a resource body. */
export const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx", ".mdown", ".mkd"];

/**
 * The two filenames that make a *folder* one resource rather than a folder of
 * them. `AGENTS.md` is deliberately absent: it sits at the root of whole repos
 * as instructions-for-agents, and treating it as a bundle entry would swallow
 * the entire tree under it — it is imported as a single-file resource instead.
 */
const BUNDLE_ENTRIES: Array<{ file: string; kind: ResourceKind }> = [
	{ file: "skill.md", kind: "skill" },
	{ file: "agent.md", kind: "agent" },
];

/** Directory names that mark the files under them as agent definitions. */
const AGENT_DIRS = new Set(["agents", "subagents", ".agents", "agent"]);

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist", "build", ".next"]);

export class ResourceImportError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "ResourceImportError";
		this.code = code;
	}
}

export function isMarkdownFile(name: string): boolean {
	const lower = name.toLowerCase();
	return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isBinary(buf: Buffer): boolean {
	const window = buf.subarray(0, Math.min(buf.length, 4096));
	return window.includes(0);
}

/** Parses a `--- ... ---` YAML-ish header. Only the flat `key: value` pairs these files use. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) return { data: {}, body: text };
	const data: Record<string, string> = {};
	for (const line of (match[1] ?? "").split(/\r?\n/)) {
		const sep = line.indexOf(":");
		if (sep <= 0 || /^\s/.test(line)) continue;
		const key = line.slice(0, sep).trim();
		let value = line.slice(sep + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
			(value.startsWith("'") && value.endsWith("'") && value.length > 1)
		) {
			value = value.slice(1, -1);
		}
		if (key !== "") data[key] = value;
	}
	return { data, body: text.slice(match[0].length) };
}

/** Strips the Markdown extension from a file name, for use as a resource name. */
function baseName(file: string): string {
	const lower = file.toLowerCase();
	const ext = MARKDOWN_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
	return ext ? file.slice(0, -ext.length) : file;
}

/**
 * What kind of thing a loose `.md` is. Nothing here is authoritative — the
 * operator can change the kind in the editor — it only has to be right often
 * enough that importing a folder of agents doesn't leave every one of them
 * labelled a document.
 */
export function inferResourceKind(relDir: string, file: string, data: Record<string, string>): ResourceKind {
	const base = file.toLowerCase();
	if (base === "skill.md") return "skill";
	if (base === "agent.md" || base === "agents.md") return "agent";
	const segments = relDir.split("/").map((segment) => segment.toLowerCase());
	if (segments.some((segment) => AGENT_DIRS.has(segment))) return "agent";
	if (segments.some((segment) => segment === "skills")) return "skill";
	// A subagent's frontmatter names the tools and model it runs with; a skill's
	// and a doc's do not.
	if ("tools" in data || "model" in data) return "agent";
	return "doc";
}

function collectFiles(dir: string, prefix: string, skipEntry: string, out: ResourceFile[], budget: { left: number }): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
		const abs = path.join(dir, entry.name);
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			collectFiles(abs, rel, skipEntry, out, budget);
			continue;
		}
		if (!entry.isFile()) continue;
		if (rel === skipEntry) continue;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			continue;
		}
		if (stat.size > MAX_RESOURCE_FILE_BYTES || stat.size > budget.left) continue;
		let buf: Buffer;
		try {
			buf = fs.readFileSync(abs);
		} catch {
			continue;
		}
		if (isBinary(buf)) continue;
		budget.left -= stat.size;
		out.push({ path: rel, content: buf.toString("utf8") });
	}
}

/** One thing found on disk, before it is read in. */
interface Candidate {
	dir: string;
	/** File name of the body, relative to `dir`. */
	entry: string;
	/** Path of `dir` relative to the import root — what the kind is inferred from. */
	relDir: string;
	kind: ResourceKind | null;
	/** True when the whole folder travels with the entry file. */
	bundle: boolean;
}

/**
 * Walks the tree looking for resources. A folder with a SKILL.md or AGENT.md
 * *is* one resource and is not descended into — everything below it is that
 * resource's own material. Any other folder contributes its loose `.md` files
 * and is walked further down.
 */
function findCandidates(root: string, relDir: string, depth: number, out: Candidate[]): void {
	if (depth > MAX_SCAN_DEPTH || out.length >= MAX_RESOURCES) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	const files = entries.filter((entry) => entry.isFile());
	const bundle = BUNDLE_ENTRIES.map(({ file, kind }) => {
		const found = files.find((entry) => entry.name.toLowerCase() === file);
		return found ? { entry: found.name, kind } : null;
	}).find((found) => found !== null);
	if (bundle) {
		out.push({ dir: root, entry: bundle.entry, relDir, kind: bundle.kind, bundle: true });
		return;
	}

	for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
		if (out.length >= MAX_RESOURCES) return;
		if (entry.name.startsWith(".") || !isMarkdownFile(entry.name)) continue;
		out.push({ dir: root, entry: entry.name, relDir, kind: null, bundle: false });
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
		const childRel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
		findCandidates(path.join(root, entry.name), childRel, depth + 1, out);
	}
}

function readResource(candidate: Candidate, budget: { left: number }): Resource | null {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(candidate.dir, candidate.entry), "utf8");
	} catch {
		return null;
	}
	if (raw.length > budget.left) return null;
	budget.left -= raw.length;
	const { data } = parseFrontmatter(raw);
	const fallbackName = candidate.bundle ? path.basename(candidate.dir) : baseName(candidate.entry);
	const name = (data.name ?? "").trim() || fallbackName;
	const files: ResourceFile[] = [];
	// Only a bundle owns the folder around it. A loose `.md` sitting beside other
	// loose `.md` files must not claim its siblings — each of them is a resource
	// in its own right.
	if (candidate.bundle) collectFiles(candidate.dir, "", candidate.entry, files, budget);
	return {
		name,
		description: (data.description ?? "").trim(),
		kind: candidate.kind ?? inferResourceKind(candidate.relDir, candidate.entry, data),
		entryFile: candidate.entry,
		// The full file, frontmatter included: the header carries the resource's
		// own description and trigger wording, which is what tells the agent when
		// the injected block applies.
		content: raw,
		files,
	};
}

/** Keeps names unique inside a set — selections address a resource by name. */
function uniqueName(name: string, kind: ResourceKind, taken: Set<string>): string {
	if (!taken.has(name)) return name;
	const withKind = `${name} (${kind})`;
	if (!taken.has(withKind)) return withKind;
	for (let n = 2; n < 1000; n++) {
		const candidate = `${withKind} ${n}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${withKind} ${crypto.randomUUID().slice(0, 8)}`;
}

export interface ResourceFolderImport {
	/** Suggested set name — the folder the operator pointed at. */
	suggestedName: string;
	resources: Resource[];
}

/**
 * Reads resources off disk. Accepts a tree of them, one skill/agent folder, or
 * a single Markdown file — picking the file means "just this one", where
 * picking its parent would have swept up every sibling too. A folder with a
 * SKILL.md or AGENT.md is read whole, because a SKILL.md without its
 * references/ and evals/ is half a skill.
 *
 * Throws `ResourceImportError` with a code the API hands straight back, so the
 * UI can say which thing went wrong (no such path, a file that isn't Markdown,
 * nothing importable inside).
 */
export function importResourcesFromFolder(target: string): ResourceFolderImport {
	const resolved = path.resolve(target.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		throw new ResourceImportError("folder_not_found");
	}

	if (stat.isFile()) {
		const file = path.basename(resolved);
		if (!isMarkdownFile(file)) throw new ResourceImportError("not_a_markdown_file");
		const dir = path.dirname(resolved);
		const lower = file.toLowerCase();
		const bundle = BUNDLE_ENTRIES.find((entry) => entry.file === lower);
		const resource = readResource(
			{
				dir,
				entry: file,
				// The folder it sits in is what its kind is read from — an
				// `agents/reviewer.md` picked directly is still an agent.
				relDir: path.basename(dir),
				kind: bundle?.kind ?? null,
				bundle: bundle !== undefined,
			},
			{ left: MAX_RESOURCE_SET_BYTES },
		);
		if (!resource) throw new ResourceImportError("no_resources_found");
		return { suggestedName: resource.name, resources: [resource] };
	}
	if (!stat.isDirectory()) throw new ResourceImportError("not_a_directory");

	const candidates: Candidate[] = [];
	findCandidates(resolved, "", 0, candidates);
	if (candidates.length === 0) throw new ResourceImportError("no_resources_found");

	const budget = { left: MAX_RESOURCE_SET_BYTES };
	const resources: Resource[] = [];
	const taken = new Set<string>();
	for (const candidate of candidates) {
		const resource = readResource(candidate, budget);
		if (!resource) continue;
		// Two files can carry the same `name:` — a skill and the agent that drives
		// it, most often. Both are kept, disambiguated, rather than one silently
		// winning.
		const name = uniqueName(resource.name, resource.kind, taken);
		taken.add(name);
		resources.push({ ...resource, name });
	}
	if (resources.length === 0) throw new ResourceImportError("no_resources_found");

	return { suggestedName: path.basename(resolved) || "Resources", resources };
}
