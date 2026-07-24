/**
 * HTTP listener for the target hub: JSON API + the UI's static page.
 *
 * Routes:
 *   GET    /health                                   → liveness
 *   GET    /api/workflows                             → list (with progress %)
 *   POST   /api/workflows                             → create (admin token) — makes the awb hook too; optional templateId seeds its steps
 *   GET    /api/workflows/:id                          → detail + steps
 *   GET    /api/workflows/:id/transcript                → harness + live conversation of the current/last session
 *   DELETE /api/workflows/:id                          → remove: deletes its awb hook + .md file + DB rows (admin token)
 *   POST   /api/workflows/:id/steps                    → add a step (admin token)
 *   POST   /api/workflows/:id/steps/from-template       → append a template's steps (admin token)
 *   PATCH  /api/workflows/:id/steps/:stepId             → edit a step's description (admin token)
 *   DELETE /api/workflows/:id/steps/:stepId             → remove a pending step (admin token)
 *   POST   /api/workflows/:id/steps/:stepId/run         → run one step now, outside the sequential order (admin token)
 *   POST   /api/workflows/:id/start                    → begin/continue sequential dispatch (admin token)
 *   POST   /api/workflows/:id/pause                    → stop dispatching further steps (admin token)
 *   POST   /api/workflows/:id/resume                   → undo pause (admin token)
 *   POST   /api/workflows/:id/restart                  → reset all steps, start over (admin token)
 *   POST   /api/steps/:id/result                       → awb's result callback (?token=<per-step token>)
 *   GET    /api/templates                              → list templates (optional ?q= filters by name/tag)
 *   POST   /api/templates                               → create a template (admin token)
 *   GET    /api/templates/:id                            → template detail
 *   PATCH  /api/templates/:id                            → update a template (admin token)
 *   DELETE /api/templates/:id                            → remove a template (admin token)
 *   GET    /                                           → ui/index.html
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { harnessResumeCommand, hookRuntime, PUBLISHABLE_PERMISSION_MODES, type PublishablePermissionMode } from "./awb.ts";
import type { HubConfig } from "./config.ts";
import {
	deleteTemplate,
	getWorkflow,
	insertTemplate,
	getTemplate,
	latestStepSession,
	listSteps,
	listTemplates,
	listWorkflows,
	stepProgress,
	updateTemplate,
	type Step,
	type Template,
	type Workflow,
} from "./db.ts";
import type { Logger } from "./runner.ts";
import { readTokenUsage, readTranscript } from "./transcript.ts";
import {
	addStep,
	createWorkflow,
	editStep,
	expireStale,
	onStepResult,
	pauseWorkflow,
	removeStep,
	removeWorkflow,
	restartWorkflow,
	resumeWorkflow,
	runStep,
	startWorkflow,
	WorkflowError,
} from "./workflow.ts";
import { getStep } from "./db.ts";

const UI_FILE = path.join(import.meta.dirname, "ui", "index.html");

function timingSafeEqualStr(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

function bearerToken(headers: http.IncomingHttpHeaders): string {
	return String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

function isAdmin(cfg: HubConfig, headers: http.IncomingHttpHeaders): boolean {
	const provided = bearerToken(headers);
	return provided.length > 0 && timingSafeEqualStr(provided, cfg.adminToken);
}

function publicWorkflow(workflow: Workflow): Record<string, unknown> {
	const runtime = hookRuntime(workflow.hookUrl);
	return {
		id: workflow.id,
		name: workflow.name,
		agentName: workflow.agentName,
		status: workflow.status,
		lastSessionId: workflow.lastSessionId,
		mdPath: workflow.mdPath,
		workdir: runtime.workdir,
		harness: runtime.harness,
		progress: stepProgress(workflow.id),
		createdAt: workflow.createdAt,
		updatedAt: workflow.updatedAt,
	};
}

function publicStep(step: Step): Record<string, unknown> {
	return {
		id: step.id,
		workflowId: step.workflowId,
		orderIndex: step.orderIndex,
		description: step.description,
		status: step.status,
		result: step.result,
		error: step.error,
		sessionId: step.sessionId,
		createdAt: step.createdAt,
		startedAt: step.startedAt,
		finishedAt: step.finishedAt,
		manualRun: step.manualRun,
		acceptanceCriteria: step.acceptanceCriteria,
		maxRetries: step.maxRetries,
		retryIntervalSeconds: step.retryIntervalSeconds,
		retryCount: step.retryCount,
		phase: step.phase,
		selected: step.selected,
	};
}

function publicTemplate(template: Template): Record<string, unknown> {
	return {
		id: template.id,
		name: template.name,
		tags: template.tags,
		steps: template.steps,
		createdAt: template.createdAt,
		updatedAt: template.updatedAt,
	};
}

/** Reads the optional judge config (acceptance criteria + retry budget + retry wait) from a step create/edit body. */
function readStepConfig(body: Record<string, unknown>): {
	acceptanceCriteria?: string | null;
	maxRetries?: number;
	retryIntervalSeconds?: number;
} {
	const config: { acceptanceCriteria?: string | null; maxRetries?: number; retryIntervalSeconds?: number } = {};
	if ("acceptanceCriteria" in body) {
		config.acceptanceCriteria = typeof body.acceptanceCriteria === "string" ? body.acceptanceCriteria : null;
	}
	if (body.maxRetries != null && Number.isFinite(Number(body.maxRetries))) {
		config.maxRetries = Math.max(0, Math.floor(Number(body.maxRetries)));
	}
	if (body.retryIntervalSeconds != null && Number.isFinite(Number(body.retryIntervalSeconds))) {
		config.retryIntervalSeconds = Math.max(0, Math.floor(Number(body.retryIntervalSeconds)));
	}
	return config;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

function readJsonBody(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	maxBytes: number,
	onBody: (body: Record<string, unknown>) => void,
): void {
	const chunks: Buffer[] = [];
	let size = 0;
	let aborted = false;
	req.on("data", (chunk: Buffer) => {
		if (aborted) return;
		size += chunk.length;
		if (size > maxBytes) {
			aborted = true;
			sendJson(res, 413, { error: "payload_too_large" });
			req.destroy();
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => {
		if (aborted) return;
		try {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			if (typeof body !== "object" || body === null) throw new Error("not an object");
			onBody(body as Record<string, unknown>);
		} catch {
			sendJson(res, 400, { error: "invalid_json" });
		}
	});
	req.on("error", () => {
		if (!aborted) sendJson(res, 400, { error: "bad_request" });
	});
}

export function createServer(cfg: HubConfig, log: Logger): http.Server {
	return http.createServer((req, res) => {
		try {
			handleRequest(cfg, log, req, res);
		} catch (err) {
			log(`request handler error: ${String(err)}`, "error");
			if (!res.headersSent) sendJson(res, 400, { error: "bad_request" });
			else res.end();
		}
	});
}

function handleRequest(cfg: HubConfig, log: Logger, req: http.IncomingMessage, res: http.ServerResponse): void {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const parts = url.pathname.split("/").filter(Boolean);

	if (req.method === "GET" && url.pathname === "/health") {
		sendJson(res, 200, { ok: true, workflows: listWorkflows().length });
		return;
	}

	if (req.method === "GET" && url.pathname === "/") {
		try {
			const html = fs.readFileSync(UI_FILE);
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(html);
		} catch {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end("target-hub is running. The web UI isn't built yet — use the API.");
		}
		return;
	}

	if (parts[0] !== "api") {
		sendJson(res, 404, { error: "not_found" });
		return;
	}

	// --- /api/steps/:id/result (awb callback; per-step token, no admin) ---

	if (parts[1] === "steps" && parts[2] && parts[3] === "result" && req.method === "POST") {
		const step = getStep(parts[2]);
		const token = url.searchParams.get("token") ?? "";
		if (!step || !token || !timingSafeEqualStr(token, step.callbackToken)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		readJsonBody(req, res, 4 * 1024 * 1024, (body) => {
			const ok = body.ok === true;
			const result =
				body.result == null
					? undefined
					: typeof body.result === "string"
						? body.result
						: JSON.stringify(body.result);
			const error = ok
				? undefined
				: String(body.error ?? (body.exitCode != null ? `exit ${body.exitCode}` : "run failed"));
			void onStepResult(
				step.id,
				{ ok, result, error, sessionId: typeof body.session_id === "string" ? body.session_id : undefined },
				cfg,
				log,
			);
			log(`step ${step.id} ${ok ? "done" : `failed (${error})`}`);
			sendJson(res, 200, { ok: true });
		});
		return;
	}

	// --- /api/templates ---

	if (parts[1] === "templates") {
		if (!parts[2]) {
			if (req.method === "GET") {
				const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
				let templates = listTemplates();
				if (q) {
					templates = templates.filter(
						(t) => t.name.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q)),
					);
				}
				sendJson(res, 200, { templates: templates.map(publicTemplate) });
				return;
			}
			if (req.method === "POST") {
				if (!isAdmin(cfg, req.headers)) {
					sendJson(res, 401, { error: "unauthorized" });
					return;
				}
				readJsonBody(req, res, cfg.maxInputBytes, (body) => {
					const name = typeof body.name === "string" ? body.name.trim() : "";
					if (!name) {
						sendJson(res, 400, { error: "name is required" });
						return;
					}
					const template = insertTemplate({ name, tags: body.tags, steps: body.steps });
					log(`template '${template.name}' (${template.id}) created`);
					sendJson(res, 200, { template: publicTemplate(template) });
				});
				return;
			}
			sendJson(res, 404, { error: "not_found" });
			return;
		}

		const templateId = parts[2];

		if (!parts[3] && req.method === "GET") {
			const template = getTemplate(templateId);
			if (!template) {
				sendJson(res, 404, { error: "unknown_template" });
				return;
			}
			sendJson(res, 200, { template: publicTemplate(template) });
			return;
		}

		if (!parts[3] && (req.method === "PATCH" || req.method === "PUT")) {
			if (!isAdmin(cfg, req.headers)) {
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}
			readJsonBody(req, res, cfg.maxInputBytes, (body) => {
				const input: { name?: string; tags?: unknown; steps?: unknown } = {};
				if (typeof body.name === "string") {
					const trimmed = body.name.trim();
					if (!trimmed) {
						sendJson(res, 400, { error: "name is required" });
						return;
					}
					input.name = trimmed;
				}
				if ("tags" in body) input.tags = body.tags;
				if ("steps" in body) input.steps = body.steps;
				const template = updateTemplate(templateId, input);
				if (!template) {
					sendJson(res, 404, { error: "unknown_template" });
					return;
				}
				sendJson(res, 200, { template: publicTemplate(template) });
			});
			return;
		}

		if (!parts[3] && req.method === "DELETE") {
			if (!isAdmin(cfg, req.headers)) {
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}
			const removed = deleteTemplate(templateId);
			if (!removed) {
				sendJson(res, 404, { error: "unknown_template" });
				return;
			}
			log(`template ${templateId} deleted`);
			sendJson(res, 200, { ok: true });
			return;
		}

		sendJson(res, 404, { error: "not_found" });
		return;
	}

	if (parts[1] !== "workflows") {
		sendJson(res, 404, { error: "not_found" });
		return;
	}

	// --- /api/workflows ---

	if (!parts[2]) {
		if (req.method === "GET") {
			expireStale(cfg, log);
			sendJson(res, 200, { workflows: listWorkflows().map(publicWorkflow) });
			return;
		}
		if (req.method === "POST") {
			if (!isAdmin(cfg, req.headers)) {
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}
			readJsonBody(req, res, cfg.maxInputBytes, (body) => {
				const name = typeof body.name === "string" ? body.name : "";
				const workdir =
					typeof body.workdir === "string" && body.workdir.trim() !== ""
						? body.workdir.trim().replace(/^~(?=\/|$)/, os.homedir())
						: undefined;
				let permissionMode: PublishablePermissionMode | undefined;
				if (typeof body.permissionMode === "string" && body.permissionMode !== "") {
					if (!PUBLISHABLE_PERMISSION_MODES.includes(body.permissionMode as PublishablePermissionMode)) {
						sendJson(res, 400, {
							error: `invalid permissionMode (allowed: ${PUBLISHABLE_PERMISSION_MODES.join(", ")})`,
						});
						return;
					}
					// bypassPermissions gives every step of this workflow arbitrary
					// command execution on this machine; it must be opted into
					// explicitly, not just selected.
					if (body.permissionMode === "bypassPermissions" && body.acceptBypassRisk !== true) {
						sendJson(res, 400, {
							error:
								"bypassPermissions disables every permission check for this workflow's steps. Send acceptBypassRisk: true to confirm you want that.",
						});
						return;
					}
					permissionMode = body.permissionMode as PublishablePermissionMode;
				}
				// Optional: seed the new workflow with a template's steps (same order,
				// same judge config), leaving the template itself untouched — a
				// template's name/tags never carry over, only its steps.
				let template: Template | null = null;
				if (typeof body.templateId === "string" && body.templateId !== "") {
					template = getTemplate(body.templateId);
					if (!template) {
						sendJson(res, 404, { error: "unknown_template" });
						return;
					}
				}
				try {
					const workflow = createWorkflow(name, { workdir, permissionMode });
					if (template) {
						for (const step of template.steps) {
							addStep(workflow.id, step.description, {
								acceptanceCriteria: step.acceptanceCriteria,
								maxRetries: step.maxRetries,
								retryIntervalSeconds: step.retryIntervalSeconds,
							});
						}
					}
					log(`workflow '${workflow.name}' (${workflow.id}) created — agent '${workflow.agentName}'`);
					sendJson(res, 200, { workflow: publicWorkflow(workflow) });
				} catch (err) {
					sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
				}
			});
			return;
		}
	}

	const workflowId = parts[2];

	if (workflowId && !parts[3] && req.method === "GET") {
		expireStale(cfg, log);
		const workflow = getWorkflow(workflowId);
		if (!workflow) {
			sendJson(res, 404, { error: "unknown_workflow" });
			return;
		}
		sendJson(res, 200, { workflow: publicWorkflow(workflow), steps: listSteps(workflowId).map(publicStep) });
		return;
	}

	if (workflowId && !parts[3] && req.method === "DELETE") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		try {
			removeWorkflow(workflowId);
			log(`workflow ${workflowId} deleted`);
			sendJson(res, 200, { ok: true });
		} catch (err) {
			sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
		}
		return;
	}

	// --- /api/workflows/:id/transcript ---
	//
	// Shows the actual Claude conversation of whichever step ran most recently
	// — not just each step's final result. That's the shared session for a
	// sequential run, but for an on-demand ▶ run it's that run's own fresh
	// session (which `lastSessionId` never tracks), so we resolve it from the
	// steps rather than only from `lastSessionId`. Only readable once a session
	// id exists: a step still on its first run doesn't have one yet, because awb
	// only reports it in the completion callback.

	if (workflowId && parts[3] === "transcript" && !parts[4] && req.method === "GET") {
		const workflow = getWorkflow(workflowId);
		if (!workflow) {
			sendJson(res, 404, { error: "unknown_workflow" });
			return;
		}
		const runtime = hookRuntime(workflow.hookUrl);
		const sessionId = latestStepSession(workflowId) ?? workflow.lastSessionId;
		if (!sessionId || !runtime.workdir) {
			sendJson(res, 200, {
				sessionId,
				harness: runtime.harness,
				resumeCommand: harnessResumeCommand(runtime.harness, sessionId),
				entries: [],
				usage: null,
				note:
					sessionId == null
						? "No session yet: the id is only known once a step finishes running."
						: undefined,
			});
			return;
		}
		sendJson(res, 200, {
			sessionId,
			harness: runtime.harness,
			resumeCommand: harnessResumeCommand(runtime.harness, sessionId),
			entries: readTranscript(runtime.workdir, sessionId),
			usage: readTokenUsage(runtime.workdir, sessionId),
		});
		return;
	}

	// --- /api/workflows/:id/steps ---

	if (workflowId && parts[3] === "steps" && !parts[4] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		readJsonBody(req, res, cfg.maxInputBytes, (body) => {
			const description = typeof body.description === "string" ? body.description : "";
			try {
				const step = addStep(workflowId, description, readStepConfig(body));
				sendJson(res, 200, { step: publicStep(step) });
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		});
		return;
	}

	// --- /api/workflows/:id/steps/from-template (append a template's steps to an existing workflow) ---

	if (workflowId && parts[3] === "steps" && parts[4] === "from-template" && !parts[5] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const workflow = getWorkflow(workflowId);
		if (!workflow) {
			sendJson(res, 404, { error: "unknown_workflow" });
			return;
		}
		readJsonBody(req, res, cfg.maxInputBytes, (body) => {
			const templateId = typeof body.templateId === "string" ? body.templateId : "";
			const template = getTemplate(templateId);
			if (!template) {
				sendJson(res, 404, { error: "unknown_template" });
				return;
			}
			try {
				const existingDescriptions = new Set(listSteps(workflowId).map((step) => step.description));
				let added = 0;
				let skipped = 0;
				for (const step of template.steps) {
					if (existingDescriptions.has(step.description)) {
						skipped++;
						continue;
					}
					addStep(workflowId, step.description, {
						acceptanceCriteria: step.acceptanceCriteria,
						maxRetries: step.maxRetries,
						retryIntervalSeconds: step.retryIntervalSeconds,
					});
					existingDescriptions.add(step.description);
					added++;
				}
				sendJson(res, 200, {
					workflow: publicWorkflow(getWorkflow(workflowId) as Workflow),
					steps: listSteps(workflowId).map(publicStep),
					added,
					skipped,
				});
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		});
		return;
	}

	if (workflowId && parts[3] === "steps" && parts[4] && req.method === "PATCH") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		readJsonBody(req, res, cfg.maxInputBytes, (body) => {
			const description = typeof body.description === "string" ? body.description : "";
			try {
				const step = editStep(workflowId, parts[4], description, readStepConfig(body));
				sendJson(res, 200, { step: publicStep(step) });
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		});
		return;
	}

	if (workflowId && parts[3] === "steps" && parts[4] && req.method === "DELETE") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		try {
			removeStep(workflowId, parts[4]);
			sendJson(res, 200, { ok: true });
		} catch (err) {
			sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
		}
		return;
	}

	// --- /api/workflows/:id/steps/:stepId/run (run this step now, outside the sequential order) ---

	if (workflowId && parts[3] === "steps" && parts[4] && parts[5] === "run" && !parts[6] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const stepId = parts[4];
		(async () => {
			try {
				await runStep(workflowId, stepId, cfg, log);
				const step = getStep(stepId);
				if (!step) {
					sendJson(res, 404, { error: "unknown_step" });
					return;
				}
				sendJson(res, 200, { step: publicStep(step) });
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		})();
		return;
	}

	// --- /api/workflows/:id/{start,pause,resume,restart} ---

	if (workflowId && ["start", "pause", "resume", "restart"].includes(parts[3]) && !parts[4] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const action = parts[3] as "start" | "pause" | "resume" | "restart";
		// Start/resume/restart may carry a `stepIds` selection: run only those
		// steps. Pause ignores the body. An empty/missing selection = run none
		// (see `setStepSelection` in db.ts).
		readJsonBody(req, res, cfg.maxInputBytes, (body) => {
			const stepIds = Array.isArray(body.stepIds)
				? body.stepIds.filter((id): id is string => typeof id === "string")
				: [];
			(async () => {
				try {
					const workflow =
						action === "start"
							? await startWorkflow(workflowId, cfg, log, stepIds)
							: action === "pause"
								? pauseWorkflow(workflowId)
								: action === "resume"
									? await resumeWorkflow(workflowId, cfg, log, stepIds)
									: await restartWorkflow(workflowId, cfg, log, stepIds);
					sendJson(res, 200, { workflow: publicWorkflow(workflow) });
				} catch (err) {
					sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
				}
			})();
		});
		return;
	}

	sendJson(res, 404, { error: "not_found" });
}
