import type { ResourceSelection } from "./api/types.ts";

export function selectionAllResources(selection: ResourceSelection): boolean {
	return !selection.resourceNames || selection.resourceNames.length === 0;
}

export function resourceSelectionsKey(selections: ResourceSelection[]): string {
	return JSON.stringify(
		selections
			.map((s) => ({
				resourceSetId: s.resourceSetId,
				resourceNames: selectionAllResources(s) ? null : [...(s.resourceNames ?? [])].sort(),
			}))
			.sort((a, b) => a.resourceSetId.localeCompare(b.resourceSetId)),
	);
}

export function sameResourceSelections(a: ResourceSelection[], b: ResourceSelection[]): boolean {
	return resourceSelectionsKey(a) === resourceSelectionsKey(b);
}

function findSelection(selections: ResourceSelection[], id: string): ResourceSelection | undefined {
	return selections.find((s) => s.resourceSetId === id);
}

export function isSetFullySelected(selections: ResourceSelection[], id: string): boolean {
	const sel = findSelection(selections, id);
	return sel !== undefined && selectionAllResources(sel);
}

export function isSetPartiallySelected(selections: ResourceSelection[], id: string): boolean {
	const sel = findSelection(selections, id);
	return sel !== undefined && !selectionAllResources(sel);
}

export function isResourceSelected(selections: ResourceSelection[], id: string, resourceName: string): boolean {
	const sel = findSelection(selections, id);
	if (!sel) return false;
	if (selectionAllResources(sel)) return true;
	return (sel.resourceNames ?? []).includes(resourceName);
}

export function toggleSetAll(selections: ResourceSelection[], id: string): ResourceSelection[] {
	if (isSetFullySelected(selections, id) || isSetPartiallySelected(selections, id)) {
		return selections.filter((s) => s.resourceSetId !== id);
	}
	return [...selections, { resourceSetId: id }];
}

export function describeResourceSelection(
	selections: ResourceSelection[],
	id: string,
	totalResources: number,
): { attached: boolean; allResources: boolean; count: number } {
	const sel = findSelection(selections, id);
	if (!sel) return { attached: false, allResources: false, count: 0 };
	if (selectionAllResources(sel)) return { attached: true, allResources: true, count: totalResources };
	return { attached: true, allResources: false, count: sel.resourceNames?.length ?? 0 };
}

export function attachSetAllResources(selections: ResourceSelection[], id: string): ResourceSelection[] {
	if (isSetFullySelected(selections, id)) return selections;
	const without = selections.filter((s) => s.resourceSetId !== id);
	return [...without, { resourceSetId: id }];
}

export function detachSet(selections: ResourceSelection[], id: string): ResourceSelection[] {
	return selections.filter((s) => s.resourceSetId !== id);
}

export function toggleResource(
	selections: ResourceSelection[],
	id: string,
	resourceName: string,
	allResourceNames: string[],
): ResourceSelection[] {
	const sel = findSelection(selections, id);
	if (!sel) {
		return [...selections, { resourceSetId: id, resourceNames: [resourceName] }];
	}
	if (selectionAllResources(sel)) {
		const remaining = allResourceNames.filter((name) => name !== resourceName);
		if (remaining.length === 0) return selections.filter((s) => s.resourceSetId !== id);
		if (remaining.length === allResourceNames.length) return selections;
		return selections.map((s) => (s.resourceSetId === id ? { resourceSetId: id, resourceNames: remaining } : s));
	}
	const current = new Set(sel.resourceNames ?? []);
	if (current.has(resourceName)) current.delete(resourceName);
	else current.add(resourceName);
	if (current.size === 0) return selections.filter((s) => s.resourceSetId !== id);
	if (current.size === allResourceNames.length) {
		return selections.map((s) => (s.resourceSetId === id ? { resourceSetId: id } : s));
	}
	const resourceNames = allResourceNames.filter((name) => current.has(name));
	return selections.map((s) => (s.resourceSetId === id ? { resourceSetId: id, resourceNames } : s));
}
