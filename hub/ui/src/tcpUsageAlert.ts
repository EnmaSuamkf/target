import type { TcpTool } from "./api/types.ts";
import type { TcpUsage } from "./api/types.ts";

function formatToolSelection(toolNames: string[] | null): string {
	if (toolNames === null) return "all tools";
	if (toolNames.length === 0) return "no tools";
	return toolNames.join(", ");
}

/** Workflows with context already injected are locked; only pending ones belong in alerts. */
export function filterUsageForAlert(usage: TcpUsage): TcpUsage {
	return {
		workflows: usage.workflows.filter((workflow) => !workflow.contextInjected),
		templates: usage.templates,
	};
}

function usageLines(usage: TcpUsage): string[] {
	const alertUsage = filterUsageForAlert(usage);
	const lines: string[] = [];
	if (alertUsage.workflows.length > 0) {
		lines.push("Workflows:");
		for (const workflow of alertUsage.workflows) {
			lines.push(`- ${workflow.name} (${formatToolSelection(workflow.toolNames)})`);
		}
	}
	if (alertUsage.templates.length > 0) {
		lines.push("Templates:");
		for (const template of alertUsage.templates) {
			lines.push(`- ${template.name} (${formatToolSelection(template.toolNames)})`);
		}
	}
	return lines;
}

export function tcpUsageHasReferences(usage: TcpUsage): boolean {
	const alertUsage = filterUsageForAlert(usage);
	return alertUsage.workflows.length > 0 || alertUsage.templates.length > 0;
}

/** Same subset the TCP form submits — keeps before/after comparisons aligned. */
export function tcpToolsForComparison(tools: TcpTool[]): TcpTool[] {
	return tools
		.map((tool) => ({
			...tool,
			name: tool.name.trim(),
			requestTemplate: tool.requestTemplate.trim(),
		}))
		.filter((tool) => tool.name !== "" && tool.requestTemplate !== "");
}

/** Tool names present before an edit but absent after (removed or renamed away). */
export function tcpToolNamesAtRisk(before: TcpTool[], after: TcpTool[]): string[] {
	const afterNames = new Set(tcpToolsForComparison(after).map((tool) => tool.name));
	return [...new Set(tcpToolsForComparison(before).map((tool) => tool.name).filter((name) => !afterNames.has(name)))];
}

/** Whether at-risk tools were renamed in place vs removed outright. */
export function tcpToolChangeAction(before: TcpTool[], after: TcpTool[]): "rename" | "remove" | null {
	const beforeNorm = tcpToolsForComparison(before);
	const afterNorm = tcpToolsForComparison(after);
	const atRisk = tcpToolNamesAtRisk(beforeNorm, afterNorm);
	if (atRisk.length === 0) return null;

	if (beforeNorm.length === afterNorm.length) {
		for (let i = 0; i < beforeNorm.length; i++) {
			const oldName = beforeNorm[i]?.name ?? "";
			const newName = afterNorm[i]?.name ?? "";
			if (oldName !== "" && oldName !== newName && atRisk.includes(oldName)) return "rename";
		}
	}

	const beforeNames = new Set(beforeNorm.map((tool) => tool.name));
	const newNames = afterNorm.map((tool) => tool.name).filter((name) => !beforeNames.has(name));
	if (newNames.length > 0 && newNames.length === atRisk.length) return "rename";

	return "remove";
}

export type TcpUsageConfirmOptions = {
	title: string;
	description: string;
	confirmLabel: string;
	danger: true;
};

/** Build a confirm dialog for delete or tool changes; null when nothing needs alerting. */
export function tcpUsageConfirmOptions(
	tcpName: string,
	usage: TcpUsage,
	kind:
		| { type: "delete"; confirmLabel?: string }
		| { type: "tool-change"; toolNames: string[]; action: "remove" | "rename"; confirmLabel: string },
): TcpUsageConfirmOptions | null {
	if (!tcpUsageHasReferences(usage)) return null;
	if (kind.type === "delete") {
		return {
			...formatTcpDeleteUsage(tcpName, usage),
			confirmLabel: kind.confirmLabel ?? "Delete anyway",
			danger: true,
		};
	}
	return {
		...formatTcpToolChangeUsage(tcpName, kind.toolNames, usage, kind.action),
		confirmLabel: kind.confirmLabel,
		danger: true,
	};
}

export function formatTcpDeleteUsage(tcpName: string, usage: TcpUsage): { title: string; description: string } {
	return {
		title: `Delete "${tcpName}"?`,
		description: [
			"This TCP is referenced by workflows or templates. Deleting it will break those selections:",
			"",
			...usageLines(usage),
			"",
			"Continue anyway?",
		].join("\n"),
	};
}

export function formatTcpToolChangeUsage(
	tcpName: string,
	toolNames: string[],
	usage: TcpUsage,
	action: "remove" | "rename",
): { title: string; description: string } {
	const toolLabel = toolNames.length === 1 ? `"${toolNames[0]}"` : toolNames.map((name) => `"${name}"`).join(", ");
	const verb = action === "rename" ? "Renaming" : "Removing";
	return {
		title: `${verb} tool ${toolLabel} from "${tcpName}"?`,
		description: [
			`${verb} this tool would break references in:`,
			"",
			...usageLines(usage),
			"",
			"Continue anyway?",
		].join("\n"),
	};
}
