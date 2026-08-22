/**
 * Which resources from a Resource Set are attached to a workflow or template.
 * `resourceNames` absent, null, or empty means the whole set (all resources).
 *
 * Deliberately the same shape as `tcp-selection.ts`: RCI is TCP's sibling —
 * one attaches HTTP tools, the other attaches resource folders — and keeping the
 * selection algebra identical is what lets the two panels, the two pickers and
 * the two template columns behave the same way without a shared abstraction
 * neither of them would fit cleanly.
 */
export interface ResourceSelection {
	resourceSetId: string;
	resourceNames?: string[] | null;
}

export function selectionsAllResources(selection: ResourceSelection): boolean {
	return !selection.resourceNames || selection.resourceNames.length === 0;
}

export function normalizeResourceSelections(input: unknown): ResourceSelection[] {
	if (!Array.isArray(input)) return [];
	const out: ResourceSelection[] = [];
	for (const raw of input) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const obj = raw as Record<string, unknown>;
		// `skillSetId`/`skillNames` is the same selection under the names the
		// feature shipped with before it grew past skills. Rows and exported
		// bundles written then are still out there, and dropping them silently
		// would detach a template from its set rather than fail loudly.
		const rawId = obj.resourceSetId ?? obj.skillSetId;
		const rawNames = obj.resourceNames ?? obj.skillNames;
		const resourceSetId = typeof rawId === "string" ? rawId.trim() : "";
		if (resourceSetId === "") continue;
		let resourceNames: string[] | null = null;
		if (rawNames != null) {
			if (!Array.isArray(rawNames)) continue;
			const names = [...new Set(rawNames.map((n) => String(n).trim()).filter((n) => n !== ""))];
			resourceNames = names.length === 0 ? null : names;
		}
		out.push({ resourceSetId, resourceNames });
	}
	return out;
}

/** Legacy/plain id lists imply all resources in the set. */
export function resourceSetIdsToSelections(ids: string[]): ResourceSelection[] {
	return ids.map((resourceSetId) => ({ resourceSetId }));
}

export function selectionsToResourceSetIds(selections: ResourceSelection[]): string[] {
	return selections.map((s) => s.resourceSetId);
}

export function resourceSelectionsKey(selections: ResourceSelection[]): string {
	return JSON.stringify(
		selections
			.map((s) => ({
				resourceSetId: s.resourceSetId,
				resourceNames: selectionsAllResources(s) ? null : [...(s.resourceNames ?? [])].sort(),
			}))
			.sort((a, b) => a.resourceSetId.localeCompare(b.resourceSetId)),
	);
}

export function sameResourceSelections(a: ResourceSelection[], b: ResourceSelection[]): boolean {
	return resourceSelectionsKey(a) === resourceSelectionsKey(b);
}

function mergeResourceNames(a: string[] | null | undefined, b: string[] | null | undefined): string[] | null {
	if (!a || a.length === 0 || !b || b.length === 0) return null;
	return [...new Set([...a, ...b])];
}

export function mergeResourceSelections(existing: ResourceSelection[], incoming: ResourceSelection[]): ResourceSelection[] {
	const map = new Map<string, ResourceSelection>();
	for (const sel of existing) map.set(sel.resourceSetId, sel);
	for (const sel of incoming) {
		const prev = map.get(sel.resourceSetId);
		if (!prev) {
			map.set(sel.resourceSetId, sel);
			continue;
		}
		map.set(sel.resourceSetId, {
			resourceSetId: sel.resourceSetId,
			resourceNames: mergeResourceNames(prev.resourceNames, sel.resourceNames),
		});
	}
	return [...map.values()];
}

export function parseStoredResourceNames(raw: unknown): string[] | null {
	if (raw == null || raw === "") return null;
	try {
		const parsed = JSON.parse(String(raw));
		if (!Array.isArray(parsed)) return null;
		const names = [...new Set(parsed.map((n) => String(n).trim()).filter((n) => n !== ""))];
		return names.length === 0 ? null : names;
	} catch {
		return null;
	}
}
