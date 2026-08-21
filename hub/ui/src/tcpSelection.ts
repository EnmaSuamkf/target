import type { TcpSelection } from "./api/types.ts";

export function selectionAllTools(selection: TcpSelection): boolean {
	return !selection.toolNames || selection.toolNames.length === 0;
}

export function selectionsKey(selections: TcpSelection[]): string {
	return JSON.stringify(
		selections
			.map((s) => ({
				tcpId: s.tcpId,
				toolNames: selectionAllTools(s) ? null : [...(s.toolNames ?? [])].sort(),
			}))
			.sort((a, b) => a.tcpId.localeCompare(b.tcpId)),
	);
}

export function sameTcpSelections(a: TcpSelection[], b: TcpSelection[]): boolean {
	return selectionsKey(a) === selectionsKey(b);
}

function findSelection(selections: TcpSelection[], tcpId: string): TcpSelection | undefined {
	return selections.find((s) => s.tcpId === tcpId);
}

export function isTcpFullySelected(selections: TcpSelection[], tcpId: string): boolean {
	const sel = findSelection(selections, tcpId);
	return sel !== undefined && selectionAllTools(sel);
}

export function isTcpPartiallySelected(selections: TcpSelection[], tcpId: string): boolean {
	const sel = findSelection(selections, tcpId);
	return sel !== undefined && !selectionAllTools(sel);
}

export function isToolSelected(selections: TcpSelection[], tcpId: string, toolName: string): boolean {
	const sel = findSelection(selections, tcpId);
	if (!sel) return false;
	if (selectionAllTools(sel)) return true;
	return (sel.toolNames ?? []).includes(toolName);
}

export function toggleTcpAll(selections: TcpSelection[], tcpId: string): TcpSelection[] {
	if (isTcpFullySelected(selections, tcpId) || isTcpPartiallySelected(selections, tcpId)) {
		return selections.filter((s) => s.tcpId !== tcpId);
	}
	return [...selections, { tcpId }];
}

export function describeTcpSelection(
	selections: TcpSelection[],
	tcpId: string,
	totalTools: number,
): { attached: boolean; allTools: boolean; count: number } {
	const sel = findSelection(selections, tcpId);
	if (!sel) return { attached: false, allTools: false, count: 0 };
	if (selectionAllTools(sel)) return { attached: true, allTools: true, count: totalTools };
	return { attached: true, allTools: false, count: sel.toolNames?.length ?? 0 };
}

export function attachTcpAllTools(selections: TcpSelection[], tcpId: string): TcpSelection[] {
	if (isTcpFullySelected(selections, tcpId)) return selections;
	const without = selections.filter((s) => s.tcpId !== tcpId);
	return [...without, { tcpId }];
}

export function detachTcp(selections: TcpSelection[], tcpId: string): TcpSelection[] {
	return selections.filter((s) => s.tcpId !== tcpId);
}

export function toggleTcpTool(
	selections: TcpSelection[],
	tcpId: string,
	toolName: string,
	allToolNames: string[],
): TcpSelection[] {
	const sel = findSelection(selections, tcpId);
	if (!sel) {
		return [...selections, { tcpId, toolNames: [toolName] }];
	}
	if (selectionAllTools(sel)) {
		const remaining = allToolNames.filter((name) => name !== toolName);
		if (remaining.length === 0) return selections.filter((s) => s.tcpId !== tcpId);
		if (remaining.length === allToolNames.length) return selections;
		return selections.map((s) => (s.tcpId === tcpId ? { tcpId, toolNames: remaining } : s));
	}
	const current = new Set(sel.toolNames ?? []);
	if (current.has(toolName)) current.delete(toolName);
	else current.add(toolName);
	if (current.size === 0) return selections.filter((s) => s.tcpId !== tcpId);
	if (current.size === allToolNames.length) {
		return selections.map((s) => (s.tcpId === tcpId ? { tcpId } : s));
	}
	const toolNames = allToolNames.filter((name) => current.has(name));
	return selections.map((s) => (s.tcpId === tcpId ? { tcpId, toolNames } : s));
}
