import { defaultToolInputs, type TcpExecuteRequest } from "./tcp-executor.ts";
import { getTcp, listWorkflowTcpToolSelections, type Tcp } from "./tcp-store.ts";

function formatTool(tool: Tcp["tools"][number], tcp: Tcp): string {
	const inputs = defaultToolInputs(tool);
	const inputLines =
		inputs.length === 0
			? "     Entradas: (ninguna)"
			: inputs
					.map(
						(i) =>
							`     - ${i.name}${i.required === false ? " (opcional)" : " (obligatoria)"}: ${i.description || i.placeholder}`,
					)
					.join("\n");
	const example: TcpExecuteRequest = {
		toolName: tool.name,
		inputs: Object.fromEntries(inputs.map((i) => [i.name, `<${i.name}>`])),
	};
	if (inputs.length === 0) delete example.inputs;
	return [
		`  - ${tool.name} (TCP "${tcp.name}"): ${tool.description}`,
		inputLines,
		`     Invocación: { "tcpExecute": { "tcpId": "${tcp.id}", "toolName": "${tool.name}"${
			example.inputs ? `, "inputs": ${JSON.stringify(example.inputs)}` : ""
		} } }`,
	].join("\n");
}

/** Text block injected into the agent prompt listing attached TCP tools. */
export function tcpCatalogPreamble(workflowId: string): string {
	const entries = listWorkflowTcpToolSelections(workflowId);
	if (entries.length === 0) return "";
	const lines = ["Herramientas TCP disponibles — solicita ejecución con un bloque JSON `tcpExecute`; el hub ejecuta la petición y devuelve el resultado:", ""];
	for (const { tcp, tools } of entries) {
		for (const tool of tools) lines.push(formatTool(tool, tcp));
	}
	return `${lines.join("\n")}\n\n---\n\n`;
}

export function findTcpTool(tcpId: string, toolName: string) {
	const tcp = getTcp(tcpId);
	if (!tcp) return null;
	const tool = tcp.tools.find((t) => t.name === toolName);
	if (!tool) return null;
	return { tcp, tool };
}
