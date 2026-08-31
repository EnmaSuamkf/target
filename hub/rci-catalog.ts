/**
 * Turning a workflow's attached Resource Sets into conversation context.
 *
 * This is the half of RCI that gives the feature its name. TCP injects a
 * *catalog* — a list of tools the agent asks the hub to run. Resources are not
 * callable, they are prose the agent has to have read, so injection here means
 * the Markdown bodies — a SKILL.md, an agent definition, a reference doc — go
 * into the prompt verbatim.
 *
 * Their bundled material (references, evals, scripts) can't go in the prompt —
 * it's far too large and mostly unneeded — so it is written to a per-workflow
 * folder under the target home and cited by absolute path. That is the whole
 * trick: the resource is available to the agent for this conversation without ever
 * being installed into it, and it disappears from the agent's world as soon as
 * the workflow stops attaching it.
 */
import fs from "node:fs";
import path from "node:path";
import { targetDir } from "./config.ts";
import {
	listWorkflowResourceSelectionsResolved,
	normalizeEntryFile,
	normalizeRelativePath,
	resourceSlug,
	type Resource,
	type ResourceKind,
	type ResourceSet,
} from "./rci-store.ts";

export { resourceSlug } from "./rci-store.ts";

/** How each kind is introduced to the agent in its injected block. */
const KIND_LABELS: Record<ResourceKind, string> = {
	skill: "Skill",
	agent: "Agent",
	doc: "Document",
};

/** Root of the materialised resources for one workflow. */
export function workflowResourcesDir(workflowId: string): string {
	return path.join(targetDir(), "resources", workflowId);
}

/**
 * Writes the selected resources to disk and returns where each one landed.
 * The workflow's folder is rebuilt from scratch each time so a resource dropped
 * from the selection stops existing rather than lingering as a stale copy the
 * agent might still read.
 */
export function materializeWorkflowResources(
	workflowId: string,
	entries: Array<{ set: ResourceSet; resources: Resource[] }>,
): Array<{ set: ResourceSet; resource: Resource; dir: string }> {
	const root = workflowResourcesDir(workflowId);
	fs.rmSync(root, { recursive: true, force: true });
	const out: Array<{ set: ResourceSet; resource: Resource; dir: string }> = [];
	for (const { set, resources } of entries) {
		for (const resource of resources) {
			const dir = path.join(root, resourceSlug(set.name), resourceSlug(resource.name));
			fs.mkdirSync(dir, { recursive: true });
			// Written under its own file name: an agent definition is identified by
			// the file it lives in, and a skill's own material refers to "SKILL.md".
			const entryFile = normalizeEntryFile(resource.entryFile, resource.kind, resource.name);
			fs.writeFileSync(path.join(dir, entryFile), resource.content, "utf8");
			for (const file of resource.files) {
				const rel = normalizeRelativePath(file.path);
				if (rel === "") continue;
				const target = path.join(dir, rel);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, file.content, "utf8");
			}
			out.push({ set, resource, dir });
		}
	}
	return out;
}

function resourceBlock(set: ResourceSet, resource: Resource, dir: string): string {
	const lines = [`### ${KIND_LABELS[resource.kind]}: ${resource.name}  ·  Resource Set "${set.name}"`, ""];
	if (resource.description) lines.push(`_${resource.description}_`, "");
	lines.push(resource.content.trim(), "");
	if (resource.files.length > 0) {
		lines.push(`Supporting material (read it with Read when this resource calls for it):`, `  Folder: ${dir}`);
		for (const file of resource.files) lines.push(`  - ${path.join(dir, file.path)}`);
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Text block injected into the agent prompt carrying the attached resources.
 * Empty string when nothing is attached, so the caller can concatenate blindly.
 */
export function resourcesCatalogPreamble(workflowId: string): string {
	const entries = listWorkflowResourceSelectionsResolved(workflowId);
	if (entries.length === 0) return "";
	const materialized = materializeWorkflowResources(workflowId, entries);
	if (materialized.length === 0) return "";
	const header = [
		"Resources available to this workflow (RCI — Resources Context Injection). They are not installed in the agent: their content is handed to you here, in the conversation. A skill describes how to do something, an agent describes a role you can adopt, and a document is reference material. Apply them when the situation they describe comes up; when one does not apply, ignore it.",
		"",
	];
	const blocks = materialized.map(({ set, resource, dir }) => resourceBlock(set, resource, dir));
	return `${header.join("\n")}${blocks.join("\n")}\n---\n\n`;
}

/** Drops a workflow's materialised resources — used when the workflow is deleted. */
export function clearWorkflowResources(workflowId: string): void {
	fs.rmSync(workflowResourcesDir(workflowId), { recursive: true, force: true });
}
