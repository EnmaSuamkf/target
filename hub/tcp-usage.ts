/**
 * Which workflows and templates reference an TCP pack or specific tools inside it.
 */
import { listTemplates, open } from "./db.ts";
import {
	parseStoredToolNames,
	selectionsAllTools,
	type TcpSelection,
} from "./tcp-selection.ts";
import { ensureTcpSchema, getTcp, type TcpTool } from "./tcp-store.ts";

export interface TcpUsageWorkflow {
	id: string;
	name: string;
	contextInjected: boolean;
	/** null = whole TCP (all tools); otherwise the explicit tool subset. */
	toolNames: string[] | null;
}

export interface TcpUsageTemplate {
	id: string;
	name: string;
	toolNames: string[] | null;
}

export interface TcpUsage {
	workflows: TcpUsageWorkflow[];
	templates: TcpUsageTemplate[];
}

function selectionUsesTcp(selection: TcpSelection, tcpId: string): boolean {
	return selection.tcpId === tcpId;
}

function selectionUsesAnyTool(selection: TcpSelection, toolNames: Set<string>): boolean {
	if (selectionsAllTools(selection)) return true;
	return (selection.toolNames ?? []).some((name) => toolNames.has(name));
}

function describeSelectionTools(selection: TcpSelection): string[] | null {
	if (selectionsAllTools(selection)) return null;
	return selection.toolNames ?? [];
}

/** Tool names present before an edit but absent after (removed or renamed away). */
export function tcpToolNamesAtRisk(before: TcpTool[], after: TcpTool[]): string[] {
	const afterNames = new Set(after.map((tool) => tool.name.trim()).filter((name) => name !== ""));
	return [...new Set(before.map((tool) => tool.name.trim()).filter((name) => name !== "" && !afterNames.has(name)))];
}

export function tcpUsageHasReferences(usage: TcpUsage): boolean {
	return usage.workflows.length > 0 || usage.templates.length > 0;
}

/** Lists workflows and templates that reference `tcpId`, optionally filtered to specific tools. */
export function getTcpUsage(tcpId: string, toolNames?: string[]): TcpUsage | null {
	ensureTcpSchema();
	if (!getTcp(tcpId)) return null;
	const toolFilter =
		toolNames && toolNames.length > 0
			? new Set(toolNames.map((name) => name.trim()).filter((name) => name !== ""))
			: undefined;

	const workflows: TcpUsageWorkflow[] = [];
	const rows = open()
		.prepare(
			`SELECT w.id, w.name, w.context_injected, wm.tool_names
			 FROM workflow_tcps wm
			 JOIN workflows w ON w.id = wm.workflow_id
			 WHERE wm.tcp_id = ?
			 ORDER BY w.name ASC, w.id ASC`,
		)
		.all(tcpId) as Record<string, unknown>[];
	for (const row of rows) {
		const selection: TcpSelection = {
			tcpId,
			toolNames: parseStoredToolNames(row.tool_names),
		};
		if (toolFilter && !selectionUsesAnyTool(selection, toolFilter)) continue;
		workflows.push({
			id: String(row.id),
			name: String(row.name),
			contextInjected: Number(row.context_injected ?? 0) === 1,
			toolNames: describeSelectionTools(selection),
		});
	}

	const templates: TcpUsageTemplate[] = [];
	for (const template of listTemplates()) {
		for (const selection of template.tcpSelections) {
			if (!selectionUsesTcp(selection, tcpId)) continue;
			if (toolFilter && !selectionUsesAnyTool(selection, toolFilter)) continue;
			templates.push({
				id: template.id,
				name: template.name,
				toolNames: describeSelectionTools(selection),
			});
			break;
		}
	}

	return { workflows, templates };
}
