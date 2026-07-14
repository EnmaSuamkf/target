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
import { completeIsolatedRun, completeStep, markStepRunning } from "./db.ts";

export type Logger = (message: string, type?: "info" | "warning" | "error") => void;

const DISPATCH_TIMEOUT_MS = 10_000;

const SUBAGENT_SUFFIX =
	"\n\nImportante: ejecutá este step delegando el trabajo a un subagente (herramienta Task) en lugar de resolverlo vos directamente en este hilo — esta misma sesión se reutiliza secuencialmente para todos los steps del workflow, y delegar mantiene el hilo principal liviano.";

export async function dispatchStep(step: Step, workflow: Workflow, cfg: HubConfig, log: Logger): Promise<void> {
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
				...(workflow.lastSessionId ? { sessionid: workflow.lastSessionId } : {}),
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

/**
 * Dispatches a step's job in isolation: same hook/agent, but never the
 * `sessionid` header (isolated runs always start a fresh Claude session, no
 * resume) and a different callback route so the outcome never touches the
 * step's normal status/result/error/sessionId. Unlike `dispatchStep`, the
 * caller (workflow.ts) already flipped the isolated run to `running` via
 * `startIsolatedRun` before calling this, so on rejection/unreachable we
 * revert that here — same pattern `dispatchStep` uses for its own row.
 */
export async function dispatchStepIsolated(
	step: Step,
	workflow: Workflow,
	callbackToken: string,
	cfg: HubConfig,
	log: Logger,
): Promise<boolean> {
	const callbackUrl = `http://${cfg.host}:${cfg.port}/api/steps/${step.id}/isolated-result?token=${callbackToken}`;
	const input = `${step.description}${SUBAGENT_SUFFIX}`;
	try {
		const res = await fetch(workflow.hookUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-webhook-secret": workflow.secret,
				// Deliberately no `sessionid` header: an isolated run never resumes
				// the workflow's shared session.
			},
			body: JSON.stringify({ jobId: step.id, input, callbackUrl }),
			signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
		});
		if (res.ok) {
			log(`isolated run of step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' accepted`);
			return true;
		}
		completeIsolatedRun(step.id, { ok: false, error: `hook answered ${res.status}` });
		log(`isolated run of step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' rejected (${res.status})`, "error");
		return false;
	} catch (err) {
		completeIsolatedRun(step.id, { ok: false, error: `hook unreachable: ${String(err)}` });
		log(`isolated run of step ${step.id} (workflow ${workflow.id}) -> '${workflow.agentName}' unreachable: ${String(err)}`, "error");
		return false;
	}
}
