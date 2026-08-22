import type { Resource, ResourceSetUsage } from "./api/types.ts";

function formatResourceSelection(resourceNames: string[] | null): string {
	if (resourceNames === null) return "all resources";
	if (resourceNames.length === 0) return "no resources";
	return resourceNames.join(", ");
}

/** Workflows with context already injected are locked; only pending ones belong in alerts. */
export function filterResourceUsageForAlert(usage: ResourceSetUsage): ResourceSetUsage {
	return {
		workflows: usage.workflows.filter((workflow) => !workflow.contextInjected),
		templates: usage.templates,
	};
}

function usageLines(usage: ResourceSetUsage): string[] {
	const alertUsage = filterResourceUsageForAlert(usage);
	const lines: string[] = [];
	if (alertUsage.workflows.length > 0) {
		lines.push("Workflows:");
		for (const workflow of alertUsage.workflows) lines.push(`- ${workflow.name} (${formatResourceSelection(workflow.resourceNames)})`);
	}
	if (alertUsage.templates.length > 0) {
		lines.push("Templates:");
		for (const template of alertUsage.templates) lines.push(`- ${template.name} (${formatResourceSelection(template.resourceNames)})`);
	}
	return lines;
}

export function resourceUsageHasReferences(usage: ResourceSetUsage): boolean {
	const alertUsage = filterResourceUsageForAlert(usage);
	return alertUsage.workflows.length > 0 || alertUsage.templates.length > 0;
}

/** Same subset the Resource Set form submits — keeps before/after comparisons aligned. */
export function resourcesForComparison(resources: Resource[]): Resource[] {
	return resources.map((resource) => ({ ...resource, name: resource.name.trim() })).filter((resource) => resource.name !== "");
}

/** Resource names present before an edit but absent after (removed or renamed away). */
export function resourceNamesAtRisk(before: Resource[], after: Resource[]): string[] {
	const afterNames = new Set(resourcesForComparison(after).map((s) => s.name));
	return [...new Set(resourcesForComparison(before).map((s) => s.name).filter((name) => !afterNames.has(name)))];
}

export type ResourceUsageConfirmOptions = {
	title: string;
	description: string;
	confirmLabel: string;
	danger: true;
};

/** Confirm dialog for a delete or a resource removal; null when nothing references the set. */
export function resourceUsageConfirmOptions(
	setName: string,
	usage: ResourceSetUsage,
	kind: { type: "delete"; confirmLabel?: string } | { type: "resource-change"; resourceNames: string[]; confirmLabel: string },
): ResourceUsageConfirmOptions | null {
	if (!resourceUsageHasReferences(usage)) return null;
	if (kind.type === "delete") {
		return {
			title: `Delete "${setName}"?`,
			description: [
				"This Resource Set is referenced by workflows or templates. Deleting it will break those selections:",
				"",
				...usageLines(usage),
				"",
				"Continue anyway?",
			].join("\n"),
			confirmLabel: kind.confirmLabel ?? "Delete anyway",
			danger: true,
		};
	}
	const label =
		kind.resourceNames.length === 1 ? `"${kind.resourceNames[0]}"` : kind.resourceNames.map((n) => `"${n}"`).join(", ");
	return {
		title: `Removing resource ${label} from "${setName}"?`,
		description: ["Removing it would break references in:", "", ...usageLines(usage), "", "Continue anyway?"].join("\n"),
		confirmLabel: kind.confirmLabel,
		danger: true,
	};
}
