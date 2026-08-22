/**
 * Which workflows and templates reference a Resource Set, or specific resources
 * inside it. Same contract as `tcp-usage.ts`: the UI asks before a destructive
 * edit so "delete this set" can say what it would break.
 */
import { listTemplates, open } from "./db.ts";
import { parseStoredResourceNames, selectionsAllResources, type ResourceSelection } from "./rci-selection.ts";
import { ensureRciSchema, getResourceSet, type Resource } from "./rci-store.ts";

export interface ResourceSetUsageWorkflow {
	id: string;
	name: string;
	contextInjected: boolean;
	/** null = whole set (all resources); otherwise the explicit subset. */
	resourceNames: string[] | null;
}

export interface ResourceSetUsageTemplate {
	id: string;
	name: string;
	resourceNames: string[] | null;
}

export interface ResourceSetUsage {
	workflows: ResourceSetUsageWorkflow[];
	templates: ResourceSetUsageTemplate[];
}

function selectionUsesAnyResource(selection: ResourceSelection, names: Set<string>): boolean {
	if (selectionsAllResources(selection)) return true;
	return (selection.resourceNames ?? []).some((name) => names.has(name));
}

function describeSelectionResources(selection: ResourceSelection): string[] | null {
	if (selectionsAllResources(selection)) return null;
	return selection.resourceNames ?? [];
}

/** Resource names present before an edit but absent after (removed or renamed away). */
export function resourceNamesAtRisk(before: Resource[], after: Resource[]): string[] {
	const afterNames = new Set(after.map((s) => s.name.trim()).filter((n) => n !== ""));
	return [...new Set(before.map((s) => s.name.trim()).filter((n) => n !== "" && !afterNames.has(n)))];
}

export function resourceSetUsageHasReferences(usage: ResourceSetUsage): boolean {
	return usage.workflows.length > 0 || usage.templates.length > 0;
}

export function getResourceSetUsage(resourceSetId: string, resourceNames?: string[]): ResourceSetUsage | null {
	ensureRciSchema();
	if (!getResourceSet(resourceSetId)) return null;
	const filter =
		resourceNames && resourceNames.length > 0
			? new Set(resourceNames.map((n) => n.trim()).filter((n) => n !== ""))
			: undefined;

	const workflows: ResourceSetUsageWorkflow[] = [];
	const rows = open()
		.prepare(
			`SELECT w.id, w.name, w.context_injected, ws.resource_names
			 FROM workflow_resource_sets ws
			 JOIN workflows w ON w.id = ws.workflow_id
			 WHERE ws.resource_set_id = ?
			 ORDER BY w.name ASC, w.id ASC`,
		)
		.all(resourceSetId) as Record<string, unknown>[];
	for (const row of rows) {
		const selection: ResourceSelection = { resourceSetId, resourceNames: parseStoredResourceNames(row.resource_names) };
		if (filter && !selectionUsesAnyResource(selection, filter)) continue;
		workflows.push({
			id: String(row.id),
			name: String(row.name),
			contextInjected: Number(row.context_injected ?? 0) === 1,
			resourceNames: describeSelectionResources(selection),
		});
	}

	const templates: ResourceSetUsageTemplate[] = [];
	for (const template of listTemplates()) {
		for (const selection of template.resourceSelections) {
			if (selection.resourceSetId !== resourceSetId) continue;
			if (filter && !selectionUsesAnyResource(selection, filter)) continue;
			templates.push({ id: template.id, name: template.name, resourceNames: describeSelectionResources(selection) });
			break;
		}
	}

	return { workflows, templates };
}
