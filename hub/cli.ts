#!/usr/bin/env node
/**
 * `target` — CLI for the target hub: create workflows, add steps, and drive
 * them without the web UI. Mutating calls attach the admin token straight
 * from ~/.target/config.json (same trust boundary as reading that file
 * directly) so there's no token to type locally.
 */
import { loadConfig } from "./config.ts";
import { startHub } from "./daemon.ts";

function usage(): void {
	console.log(`Usage: target <command> [args]

Commands:
  start                                 Run the hub (foreground)
  create <name> [--workdir <dir>]       Create a workflow (creates its agent + awb hook too)
  set-context <workflowId> "<text>"   Set (or clear with "") a workflow's conversation context
  add-step <workflowId> <description...>
                                         Append a step to a workflow
  templates                             List available workflow templates
  create-from-template <templateId> <workflowName> [--workdir <dir>]
                                         Create a workflow seeded with a template's steps
  list                                  List workflows with progress
  show <workflowId>                     Show a workflow's steps
  run <workflowId>                      Start (or continue) sequential dispatch
  pause <workflowId>                    Stop dispatching further steps
  resume <workflowId>                   Undo pause
  restart <workflowId>                  Reset every step to pending and start over
`);
}

function flagValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i === -1 || i === args.length - 1) return undefined;
	return args[i + 1];
}

interface WorkflowJson {
	id: string;
	name: string;
	status: string;
	progress: { total: number; done: number; failed: number; pct: number };
	agentName: string;
	lastSessionId: string | null;
	mdPath: string;
	conversationContext: string | null;
	contextInjected: boolean;
}

interface StepJson {
	id: string;
	orderIndex: number;
	description: string;
	status: string;
	error: string | null;
}

interface TemplateJson {
	id: string;
	name: string;
	tags: string[];
	steps: { description: string; acceptanceCriteria: string | null }[];
}

async function main(): Promise<void> {
	const [, , cmd, ...rest] = process.argv;

	if (!cmd || cmd === "-h" || cmd === "--help") {
		usage();
		return;
	}

	if (cmd === "start") {
		startHub();
		return;
	}

	const cfg = loadConfig();
	const apiBase = `http://${cfg.host}:${cfg.port}/api`;
	const authHeaders = { authorization: `Bearer ${cfg.adminToken}` };

	async function fail(res: Response): Promise<never> {
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		console.error(`Hub rejected the request: ${data.error ?? res.status}`);
		process.exit(1);
	}

	if (cmd === "create") {
		const name = rest.filter((a) => !a.startsWith("--"))[0];
		const workdir = flagValue(rest, "--workdir");
		const permissionMode = flagValue(rest, "--permission-mode");
		if (!name) {
			console.error(
				"Usage: target create <name> [--workdir <dir>] [--permission-mode <mode>] [--yes-bypass-risk]\n" +
					"  modes: acceptEdits, auto, manual, dontAsk, plan, bypassPermissions (needs --yes-bypass-risk)",
			);
			process.exitCode = 1;
			return;
		}
		const res = await fetch(`${apiBase}/workflows`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders },
			body: JSON.stringify({
				name,
				...(workdir ? { workdir } : {}),
				...(permissionMode ? { permissionMode } : {}),
				...(rest.includes("--yes-bypass-risk") ? { acceptBypassRisk: true } : {}),
			}),
		});
		if (!res.ok) await fail(res);
		const { workflow } = (await res.json()) as { workflow: WorkflowJson };
		console.log(`Workflow '${workflow.name}' created (${workflow.id}), agent '${workflow.agentName}'.`);
		console.log(`Status file: ${workflow.mdPath}`);
		console.log(`Add steps with: target add-step ${workflow.id} <description...>`);
		return;
	}

	if (cmd === "add-step") {
		const [workflowId, ...descParts] = rest;
		const description = descParts.join(" ").trim();
		if (!workflowId || !description) {
			console.error("Usage: target add-step <workflowId> <description...>");
			process.exitCode = 1;
			return;
		}
		const res = await fetch(`${apiBase}/workflows/${workflowId}/steps`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders },
			body: JSON.stringify({ description }),
		});
		if (!res.ok) await fail(res);
		const { step } = (await res.json()) as { step: StepJson };
		console.log(`Step ${step.orderIndex + 1} added: ${step.description}`);
		return;
	}

	if (cmd === "templates" || cmd === "list-templates") {
		const res = await fetch(`${apiBase}/templates`);
		if (!res.ok) await fail(res);
		const { templates } = (await res.json()) as { templates: TemplateJson[] };
		if (templates.length === 0) {
			console.log("No templates registered.");
			return;
		}
		for (const t of templates) {
			const tags = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
			console.log(`${t.id}  '${t.name}'  ${t.steps.length} step(s)${tags}`);
		}
		return;
	}

	if (cmd === "create-from-template") {
		const [templateId, name] = rest.filter((a) => !a.startsWith("--"));
		const workdir = flagValue(rest, "--workdir");
		const permissionMode = flagValue(rest, "--permission-mode");
		if (!templateId || !name) {
			console.error("Usage: target create-from-template <templateId> <workflowName> [--workdir <dir>] [--permission-mode <mode>]");
			process.exitCode = 1;
			return;
		}
		const createRes = await fetch(`${apiBase}/workflows`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders },
			body: JSON.stringify({
				name,
				templateId,
				...(workdir ? { workdir } : {}),
				...(permissionMode ? { permissionMode } : {}),
			}),
		});
		if (!createRes.ok) await fail(createRes);
		const { workflow } = (await createRes.json()) as { workflow: WorkflowJson };
		console.log(`Workflow '${workflow.name}' created from template '${templateId}' (${workflow.id}), agent '${workflow.agentName}'.`);
		console.log(`Status file: ${workflow.mdPath}`);
		return;
	}

	if (cmd === "list") {
		const res = await fetch(`${apiBase}/workflows`);
		const { workflows } = (await res.json()) as { workflows: WorkflowJson[] };
		if (workflows.length === 0) {
			console.log("No workflows yet. Use `target create <name>`.");
			return;
		}
		for (const w of workflows) {
			console.log(
				`${w.id}  '${w.name}'  ${w.status}  ${w.progress.done}/${w.progress.total} (${w.progress.pct}%)${w.progress.failed ? `  failed=${w.progress.failed}` : ""}`,
			);
		}
		return;
	}

	if (cmd === "show") {
		const workflowId = rest[0];
		if (!workflowId) {
			console.error("Usage: target show <workflowId>");
			process.exitCode = 1;
			return;
		}
		const res = await fetch(`${apiBase}/workflows/${workflowId}`);
		if (!res.ok) await fail(res);
		const { workflow, steps } = (await res.json()) as { workflow: WorkflowJson; steps: StepJson[] };
		console.log(`'${workflow.name}' (${workflow.id}) — ${workflow.status} — ${workflow.progress.pct}%`);
		if (workflow.conversationContext) {
			const preview = workflow.conversationContext.replace(/\s+/g, " ").trim().slice(0, 100);
			console.log(`Conversation context (injected: ${workflow.contextInjected ? "yes" : "no"}): ${preview}${workflow.conversationContext.length > 100 ? "…" : ""}`);
		}
		console.log("");
		for (const s of steps) {
			console.log(`  ${s.orderIndex + 1}. [${s.status}] ${s.description}${s.error ? ` — ${s.error}` : ""}`);
		}
		return;
	}

	if (cmd === "set-context") {
		const [workflowId, ...contextParts] = rest;
		const context = contextParts.join(" ");
		if (!workflowId) {
			console.error('Usage: target set-context <workflowId> "<text>"  (pass an empty string to clear)');
			process.exitCode = 1;
			return;
		}
		const res = await fetch(`${apiBase}/workflows/${workflowId}/context`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...authHeaders },
			body: JSON.stringify({ conversationContext: context }),
		});
		if (!res.ok) await fail(res);
		const { workflow } = (await res.json()) as { workflow: WorkflowJson };
		console.log(
			`Conversation context ${workflow.conversationContext ? "updated" : "cleared"} for '${workflow.name}'` +
				(workflow.conversationContext ? ` (injected: ${workflow.contextInjected ? "yes" : "no"}).` : "."),
		);
		return;
	}

	if (cmd === "run" || cmd === "pause" || cmd === "resume" || cmd === "restart") {
		const workflowId = rest[0];
		if (!workflowId) {
			console.error(`Usage: target ${cmd} <workflowId>`);
			process.exitCode = 1;
			return;
		}
		const action = cmd === "run" ? "start" : cmd;
		const res = await fetch(`${apiBase}/workflows/${workflowId}/${action}`, { method: "POST", headers: authHeaders });
		if (!res.ok) await fail(res);
		const { workflow } = (await res.json()) as { workflow: WorkflowJson };
		console.log(`Workflow '${workflow.name}' is now ${workflow.status} (${workflow.progress.pct}%).`);
		return;
	}

	usage();
	process.exitCode = 1;
}

main().catch((err) => {
	console.error(`Could not reach the hub. Is it running (\`target start\`)? ${String(err)}`);
	process.exitCode = 1;
});
