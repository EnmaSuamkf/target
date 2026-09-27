/** Shared helpers for catalog copies pulled onto this hub. */

export type CatalogOriginFilter = "all" | "own" | "synced";

export function isServerCopy(item: { origin?: string }): boolean {
	return item.origin === "server";
}

export function isUsableCopy(item: { origin?: string; usable?: boolean }): boolean {
	return !isServerCopy(item) || item.usable !== false;
}

export function matchesOriginFilter(item: { origin?: string }, filter: CatalogOriginFilter): boolean {
	if (filter === "all") return true;
	if (filter === "synced") return isServerCopy(item);
	return !isServerCopy(item);
}

export function templateOptionLabel(template: { name: string; steps: { length: number }; origin?: string; usable?: boolean }): string {
	const base = `${template.name} (${template.steps.length} step${template.steps.length === 1 ? "" : "s"})`;
	return isUsableCopy(template) ? base : `${base} — Disabled`;
}
