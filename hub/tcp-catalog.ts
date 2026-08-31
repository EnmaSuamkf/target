import { defaultToolInputs, type TcpExecuteRequest } from "./tcp-executor.ts";
import { getTcp, listWorkflowTcpToolSelections, type Tcp } from "./tcp-store.ts";

function formatTool(tool: Tcp["tools"][number], tcp: Tcp): string {
	const inputs = defaultToolInputs(tool);
	const inputLines =
		inputs.length === 0
			? "     Inputs: (none)"
			: inputs
					.map(
						(i) =>
							`     - ${i.name}${i.required === false ? " (optional)" : " (required)"}: ${i.description || i.placeholder}`,
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
		`     Body: { "tcpId": "${tcp.id}", "toolName": "${tool.name}"${
			example.inputs ? `, "inputs": ${JSON.stringify(example.inputs)}` : ""
		} }`,
	].join("\n");
}

/**
 * Text block injected into the agent prompt listing attached TCP tools.
 *
 * `executeUrl` is the endpoint the agent actually POSTs to — the hub's own
 * `/api/tcps/execute`, carrying the running step's credential. It is what makes
 * this catalog callable rather than decorative: the hub never reads the agent's
 * output, so a tool call has to be an HTTP request the agent makes itself.
 * Omitted (tests, previews) the tools are still listed with the exact body they
 * take, but the block does not claim they can be run from here.
 */
export function tcpCatalogPreamble(workflowId: string, executeUrl?: string): string {
	const entries = listWorkflowTcpToolSelections(workflowId);
	if (entries.length === 0) return "";
	const lines = executeUrl
		? [
				"TCP tools available — run one by POSTing its body to the hub, which performs the HTTP request and answers with the result:",
				"",
				`  POST ${executeUrl}`,
				"  Content-Type: application/json",
				"",
			]
		: ["TCP tools available — the hub runs these; the endpoint to POST to is supplied with the step that may use them:", ""];
	for (const { tcp, tools } of entries) {
		for (const tool of tools) lines.push(formatTool(tool, tcp));
	}
	if (executeUrl) {
		const [{ tcp, tools }] = entries;
		lines.push(
			"",
			"For example:",
			`  curl -sS -X POST '${executeUrl}' -H 'content-type: application/json' \\`,
			`    -d '{"tcpId":"${tcp.id}","toolName":"${tools[0]?.name ?? ""}"}'`,
			"",
			"The reply is JSON: `{ \"result\": { \"ok\": true, \"status\": 200, \"body\": \"…\" } }`, or `ok: false` with a `message` saying what failed.",
		);
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
