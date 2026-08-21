/**
 * Which tools from an TCP pack are attached to a workflow or template.
 * `toolNames` absent, null, or empty means the whole TCP (all tools).
 */
export interface TcpSelection {
	tcpId: string;
	toolNames?: string[] | null;
}

export function selectionsAllTools(selection: TcpSelection): boolean {
	return !selection.toolNames || selection.toolNames.length === 0;
}

export function normalizeTcpSelections(input: unknown): TcpSelection[] {
	if (!Array.isArray(input)) return [];
	const out: TcpSelection[] = [];
	for (const raw of input) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const obj = raw as Record<string, unknown>;
		const tcpId =
			typeof obj.tcpId === "string"
				? obj.tcpId.trim()
				: typeof obj.mtpId === "string"
					? obj.mtpId.trim()
					: "";
		if (tcpId === "") continue;
		let toolNames: string[] | null = null;
		if (obj.toolNames != null) {
			if (!Array.isArray(obj.toolNames)) continue;
			const names = [...new Set(obj.toolNames.map((n) => String(n).trim()).filter((n) => n !== ""))];
			toolNames = names.length === 0 ? null : names;
		}
		out.push({ tcpId, toolNames });
	}
	return out;
}

/** Legacy template/workflow rows that only stored tcp ids imply all tools. */
export function tcpIdsToSelections(tcpIds: string[]): TcpSelection[] {
	return tcpIds.map((tcpId) => ({ tcpId }));
}

export function selectionsToTcpIds(selections: TcpSelection[]): string[] {
	return selections.map((s) => s.tcpId);
}

export function selectionsKey(selections: TcpSelection[]): string {
	return JSON.stringify(
		selections
			.map((s) => ({
				tcpId: s.tcpId,
				toolNames: selectionsAllTools(s) ? null : [...(s.toolNames ?? [])].sort(),
			}))
			.sort((a, b) => a.tcpId.localeCompare(b.tcpId)),
	);
}

export function sameTcpSelections(a: TcpSelection[], b: TcpSelection[]): boolean {
	return selectionsKey(a) === selectionsKey(b);
}

function mergeToolNames(
	a: string[] | null | undefined,
	b: string[] | null | undefined,
): string[] | null {
	if (!a || a.length === 0 || !b || b.length === 0) return null;
	return [...new Set([...a, ...b])];
}

export function mergeTcpSelections(existing: TcpSelection[], incoming: TcpSelection[]): TcpSelection[] {
	const map = new Map<string, TcpSelection>();
	for (const sel of existing) map.set(sel.tcpId, sel);
	for (const sel of incoming) {
		const prev = map.get(sel.tcpId);
		if (!prev) {
			map.set(sel.tcpId, sel);
			continue;
		}
		map.set(sel.tcpId, { tcpId: sel.tcpId, toolNames: mergeToolNames(prev.toolNames, sel.toolNames) });
	}
	return [...map.values()];
}

export function parseStoredToolNames(raw: unknown): string[] | null {
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
