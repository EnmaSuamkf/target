#!/usr/bin/env node
/**
 * `target` — CLI for The Target Project hub: create workflows, add steps, and drive
 * them without the web UI. Mutating calls attach the admin token straight
 * from ~/.target/config.json (same trust boundary as reading that file
 * directly) so there's no token to type locally.
 */
import * as cp from "node:child_process";
import { loadConfig } from "./config.ts";
import { startHub } from "./daemon.ts";

function usage(): void {
	console.log(`Usage: target <command> [args]

Commands:
  start                                 Run the hub (foreground)
  create <name> [--workdir <dir>] [--runner <claude|free-code>] [--sandbox <host|docker>] [--image <name>] [--force]
                                         Create a workflow (creates its agent + awb hook too)
  set-context <workflowId> "<text>"   Set (or clear with "") a workflow's conversation context
  add-step <workflowId> <description...>
                                         Append a step to a workflow
  templates                             List available workflow templates
  create-from-template <templateId> <workflowName> [--workdir <dir>] [--runner <claude|free-code>] [--sandbox <host|docker>] [--image <name>] [--force]
                                         Create a workflow seeded with a template's steps
  list                                  List workflows with progress
  show <workflowId>                     Show a workflow's steps (and their ids)
  set-status <workflowId> <draft|paused|completed|failed>
                                         Force a workflow's status by hand
  set-step-status <workflowId> <stepId> <pending|done|failed>
                                         Force one step's status by hand
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

/**
 * Whether `runner`'s CLI is installed on the host, for the create commands'
 * fast-fail before the POST. Prefers the hub's GET /api/runners (the same
 * authoritative probe the server's host install-check uses); if the hub can't
 * be reached, falls back to a local `<runner> --version` probe. Always answers
 * a boolean so callers never special-case "unknown".
 */
async function runnerInstalledOnHost(runner: string, apiBase: string): Promise<boolean> {
	try {
		const res = await fetch(`${apiBase}/runners`);
		if (res.ok) {
			const { runners } = (await res.json()) as { runners: { id: string; installed: boolean }[] };
			const found = runners.find((r) => r.id === runner);
			if (found) return found.installed;
		}
	} catch {
		// Hub unreachable — fall back to a local probe below.
	}
	const result = cp.spawnSync(runner, ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
	return result.status === 0;
}

/**
 * Pre-flight check for `target create` / `create-from-template`: verifies the
 * chosen runner's CLI is installed on the host before POSTing, mirroring the
 * server's host install-check so the operator fails fast here instead of after
 * the first step's spawn. A docker sandbox ships its own binary in the image,
 * so a host-missing runner only warns there; on the host it's refused unless
 * `force` downgrades it to a warning (the hub still has the final say and will
 * 400 a host runner it can't find). Returns whether creation should proceed.
 */
async function ensureRunnerInstalled(
	runner: string,
	sandbox: string | undefined,
	apiBase: string,
	force: boolean,
): Promise<boolean> {
	if (sandbox === "docker") {
		if (!(await runnerInstalledOnHost(runner, apiBase))) {
			console.error(
				`note: runner '${runner}' is not installed on this host, but --sandbox docker ships its own binary; proceeding.`,
			);
		}
		return true;
	}
	if (await runnerInstalledOnHost(runner, apiBase)) return true;
	if (force) {
		console.error(`warning: runner '${runner}' is not installed on this host; --force given, proceeding anyway.`);
		return true;
	}
	console.error(
		`runner '${runner}' is not installed on this host. Install it, use --sandbox docker with an image that ships it, or pass --force to proceed anyway.`,
	);
	return false;
}

interface WorkflowJson {
	id: string;
	name: string;
	status: string;
	progress: { total: number; done: number; failed: number; pct: number };
	agentName: string;
	lastSessionId: string | null;
	mdPath: string;
	/** True when the status was forced by a human rather than derived from the steps. */
	statusManual?: boolean;
	conversationContext: string | null;
	contextInjected: boolean;
	/** Where the workflow's agent runs: "host" (default) or "docker". */
	sandbox: string;
	/** Image backing a "docker" sandbox; null on the host. */
	image: string | null;
}

interface StepJson {
	id: string;
	/** "context" is the hub-owned step that delivers the workflow's background; everything else is "task". */
	kind?: "task" | "context";
	orderIndex: number;
	description: string;
	status: string;
	error: string | null;
	/** True when the status was forced by a human rather than reported by a run. */
	statusManual?: boolean;
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
		const runner = flagValue(rest, "--runner");
		const sandbox = flagValue(rest, "--sandbox");
		const image = flagValue(rest, "--image");
		const force = rest.includes("--force");
		if (!name) {
			console.error(
				"Usage: target create <name> [--workdir <dir>] [--permission-mode <mode>] [--runner <claude|free-code>]\n" +
					"                        [--sandbox <host|docker>] [--image <name>] [--yes-bypass-risk] [--force]\n" +
					"  modes: acceptEdits, auto, manual, dontAsk, plan, bypassPermissions (needs --yes-bypass-risk)\n" +
					"  --sandbox docker runs every step inside a container (default host = directly on this machine);\n" +
					"  --image names the image to use, defaulting to the one built from this repo's Dockerfile",
			);
			process.exitCode = 1;
			return;
		}
		// Verify the agent CLI is installed on the host before POSTing, mirroring
		// the server's host install-check so the operator fails fast here instead
		// of after the first step's spawn. See `ensureRunnerInstalled` for the
		// docker/--force leeway.
		const effectiveRunner = runner ?? "claude";
		if (!(await ensureRunnerInstalled(effectiveRunner, sandbox, apiBase, force))) {
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
				...(runner ? { runner } : {}),
				...(sandbox ? { sandbox } : {}),
				...(image ? { image } : {}),
				...(rest.includes("--yes-bypass-risk") ? { acceptBypassRisk: true } : {}),
			}),
		});
		if (!res.ok) await fail(res);
		const { workflow } = (await res.json()) as { workflow: WorkflowJson };
		console.log(`Workflow '${workflow.name}' created (${workflow.id}), agent '${workflow.agentName}'.`);
		console.log(`Sandbox: ${workflow.sandbox}${workflow.image ? ` (${workflow.image})` : ""}`);
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
		const runner = flagValue(rest, "--runner");
		const sandbox = flagValue(rest, "--sandbox");
		const image = flagValue(rest, "--image");
		const force = rest.includes("--force");
		if (!templateId || !name) {
			console.error(
				"Usage: target create-from-template <templateId> <workflowName> [--workdir <dir>] [--permission-mode <mode>]\n" +
					"                                     [--runner <claude|free-code>] [--sandbox <host|docker>] [--image <name>] [--force]",
			);
			process.exitCode = 1;
			return;
		}
		// Same host install-check as `target create` — see there for the rationale.
		const effectiveRunner = runner ?? "claude";
		if (!(await ensureRunnerInstalled(effectiveRunner, sandbox, apiBase, force))) {
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
				...(runner ? { runner } : {}),
				...(sandbox ? { sandbox } : {}),
				...(image ? { image } : {}),
			}),
		});
		if (!createRes.ok) await fail(createRes);
		const { workflow } = (await createRes.json()) as { workflow: WorkflowJson };
		console.log(`Workflow '${workflow.name}' created from template '${templateId}' (${workflow.id}), agent '${workflow.agentName}'.`);
		console.log(`Sandbox: ${workflow.sandbox}${workflow.image ? ` (${workflow.image})` : ""}`);
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
			// The context step is the hub's, not one of the N the operator wrote: it
			// sits at order index -1, so numbering it would print "0.", and none of the
			// per-step commands accept it anyway.
			if (s.kind === "context") {
				console.log(`  ctx. [${s.status}] Conversation context — delivered before every other step\n     ${s.id}`);
				continue;
			}
			// The id is printed because `set-step-status` needs it and this is the
			// only command that shows it.
			console.log(
				`  ${s.orderIndex + 1}. [${s.status}${s.statusManual ? " (manual)" : ""}] ${s.description}${s.error ? ` — ${s.error}` : ""}\n     ${s.id}`,
			);
		}
		return;
	}

	// Manual status override: say what really happened when the engine got it
	// wrong (a run that ran out of tokens, a callback that never landed). Neither
	// command runs anything — see the manual-override block in hub/workflow.ts.

	if (cmd === "set-status") {
		const [workflowId, status] = rest;
		if (!workflowId || !status) {
			console.error("Usage: target set-status <workflowId> <draft|paused|completed|failed>");
			process.exitCode = 1;
			return;
		}
		const res = await fetch(`${apiBase}/workflows/${workflowId}/status`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders },
			body: JSON.stringify({ status }),
		});
		if (!res.ok) await fail(res);
		const { workflow } = (await res.json()) as { workflow: WorkflowJson };
		console.log(`Workflow '${workflow.name}' is now ${workflow.status} (set manually).`);
		return;
	}

	if (cmd === "set-step-status") {
		const [workflowId, stepId, status] = rest;
		if (!workflowId || !stepId || !status) {
			console.error("Usage: target set-step-status <workflowId> <stepId> <pending|done|failed>");
			console.error("  (`target show <workflowId>` lists the step ids)");
			process.exitCode = 1;
			return;
		}
		const res = await fetch(`${apiBase}/workflows/${workflowId}/steps/${stepId}/status`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders },
			body: JSON.stringify({ status }),
		});
		if (!res.ok) await fail(res);
		const { step } = (await res.json()) as { step: StepJson };
		console.log(`Step ${step.orderIndex + 1} is now ${step.status} (set manually).`);
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
