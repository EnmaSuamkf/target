/**
 * Dispatches one workflow step to its workflow's awb hook. Same async
 * contract as agentmesh's runner: the hook answers `{ok:true}` immediately
 * (the Claude run happens in the background), so a successful POST only
 * means "accepted" → step goes `running`. The outcome arrives later on
 * `POST /api/steps/:id/result` via the `callbackUrl` we send in the event
 * body.
 *
 * Every step of a workflow shares one hook and, from the second step on,
 * resumes the same Claude session (`workflow.lastSessionId`) — that's what
 * makes the whole workflow read as one continuous conversation instead of N
 * unrelated runs. Because that session is reused turn after turn, the input
 * always appends an explicit instruction to do the step's work through a
 * subagent (the Task tool) rather than inline: that keeps each step's own
 * working context out of the resumed session, which only accumulates the
 * subagent's final summaries.
 */
import type { HubConfig } from "./config.ts";
import type { Step, Workflow } from "./db.ts";
import { completeStep, markStepRunning } from "./db.ts";

export type Logger = (message: string, type?: "info" | "warning" | "error") => void;

const DISPATCH_TIMEOUT_MS = 10_000;

const SUBAGENT_SUFFIX =
	"\n\nImportante: ejecutá este step delegando el trabajo a un subagente (herramienta Task) en lugar de resolverlo vos directamente en este hilo — esta misma sesión se reutiliza secuencialmente para todos los steps del workflow, y delegar mantiene el hilo principal liviano.";

/**
 * Dispatches one workflow step to its workflow's awb hook. By default it
 * resumes `workflow.lastSessionId` (the sequential engine's case — every
 * step after the first continues the same Claude session). An on-demand run
 * (workflow.ts's `runStep`) passes `resumeSession: false` so it always starts
 * a fresh session instead of forking the shared one.
 */
export async function dispatchStep(
	step: Step,
	workflow: Workflow,
	cfg: HubConfig,
	log: Logger,
	options: { resumeSession?: boolean } = {},
): Promise<void> {
	const resumeSession = options.resumeSession ?? true;
	const callbackUrl = `http://${cfg.host}:${cfg.port}/api/steps/${step.id}/result?token=${step.callbackToken}`;
	const input = `${step.description}${SUBAGENT_SUFFIX}`;
	try {
		const res = await fetch(workflow.hookUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-webhook-secret": workflow.secret,
				// awb resumes that Claude session (`claude --resume`) instead of
				// starting fresh whenever the workflow already has one — i.e. every
				// step after the first.
				...(resumeSession && workflow.lastSessionId ? { sessionid: workflow.lastSessionId } : {}),
			},
			body: JSON.stringify({ jobId: step.id, input, callbackUrl }),
			signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
		});
		if (res.ok) {
			markStepRunning(step.id);
			log(`step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' accepted`);
		} else {
			completeStep(step.id, { ok: false, error: `hook answered ${res.status}` });
			log(`step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' rejected (${res.status})`, "error");
		}
	} catch (err) {
		completeStep(step.id, { ok: false, error: `hook unreachable: ${String(err)}` });
		log(`step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' unreachable: ${String(err)}`, "error");
	}
}
