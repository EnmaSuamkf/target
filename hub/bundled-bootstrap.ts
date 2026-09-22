/**
 * Idempotent import of bundled TCP packs and RCI resource sets shipped with Target.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { HubConfig } from "./config.ts";
import { insertResourceSet, listResourceSets, updateResourceSet, type ResourceSet } from "./rci-store.ts";
import { GIT_PUSH_TOOL } from "./tcp-local.ts";
import {
	findTcpByName,
	insertTcp,
	parseTcpBundle,
	updateTcp,
	type Tcp,
	type TcpTool,
} from "./tcp-store.ts";

export const BUNDLED_TCP_NAME = "Target Management";
export const BUNDLED_RESOURCE_SET_NAME = "target-workflows";
export const BUNDLED_RESOURCE_SKILL_NAME = "target-workflows";
export const BUNDLED_CREATE_WORKFLOW_SKILL_NAME = "create-workflow";

function bundledDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled");
}

function skillsRoot(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

function skillDescription(content: string, fallback: string): string {
	const folded = content.match(/^description:\s*>-?\s*\n((?:[ \t]+.+\n)+)/m);
	if (folded?.[1]) return folded[1].replace(/^[ \t]+/gm, " ").replace(/\s+/g, " ").trim();
	const single = content.match(/^description:\s*(.+)$/m);
	return single?.[1]?.trim() || fallback;
}

function bundledSkillResources(): Array<{
	name: string;
	kind: "skill";
	description: string;
	entryFile: string;
	content: string;
	files: [];
}> {
	const root = skillsRoot();
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.flatMap((entry) => {
			const file = path.join(root, entry.name, "SKILL.md");
			if (!fs.existsSync(file)) return [];
			const content = fs.readFileSync(file, "utf8");
			return [
				{
					name: entry.name,
					kind: "skill" as const,
					description: skillDescription(content, entry.name),
					entryFile: "SKILL.md",
					content,
					files: [] as [],
				},
			];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function injectAdminToken(tools: TcpTool[], adminToken: string): TcpTool[] {
	return tools.map((tool) => ({
		...tool,
		tokens: { ...tool.tokens, TOKEN_1: adminToken },
	}));
}

export function ensureBundledTcp(adminToken: string): Tcp {
	const raw = JSON.parse(fs.readFileSync(path.join(bundledDir(), "target-management.tcp.json"), "utf8"));
	const [entry] = parseTcpBundle(raw);
	const tools = injectAdminToken(entry.tools, adminToken);
	const existing = findTcpByName(BUNDLED_TCP_NAME);
	if (existing) {
		const updated = updateTcp(existing.id, { tags: entry.tags, tools });
		if (!updated) throw new Error("failed_to_update_bundled_tcp");
		return updated;
	}
	return insertTcp({ name: BUNDLED_TCP_NAME, tags: entry.tags, tools });
}

export function ensureBundledResourceSet(): ResourceSet {
	const resources = bundledSkillResources();
	if (resources.length === 0) throw new Error("missing_bundled_skills");
	const existing = listResourceSets().find((s) => s.name === BUNDLED_RESOURCE_SET_NAME);
	if (existing) {
		const updated = updateResourceSet(existing.id, {
			tags: ["target", "workflows"],
			resources,
		});
		if (!updated) throw new Error("failed_to_update_bundled_resource_set");
		return updated;
	}
	return insertResourceSet({
		name: BUNDLED_RESOURCE_SET_NAME,
		tags: ["target", "workflows"],
		resources,
	});
}

/** Adds `git_push` (`target://git-push`) to an existing TCP named "github" when absent. */
export function ensureGitHubGitPushTool(): void {
	const github = findTcpByName("github");
	if (!github) return;
	if (github.tools.some((tool) => tool.name === GIT_PUSH_TOOL.name)) return;
	const tokenSource = github.tools.find((tool) =>
		Object.values(tool.tokens).some((value) => value.trim()),
	);
	const tokens = tokenSource ? { ...tokenSource.tokens } : {};
	updateTcp(github.id, { tools: [...github.tools, { ...GIT_PUSH_TOOL, tokens }] });
}

/** Import bundled catalog entries if missing or refresh token on TCP tools. */
export function ensureBundledCatalog(cfg: HubConfig): { tcp: Tcp; resourceSet: ResourceSet } {
	ensureGitHubGitPushTool();
	return {
		tcp: ensureBundledTcp(cfg.adminToken),
		resourceSet: ensureBundledResourceSet(),
	};
}
