/**
 * HTTP listener for The Target Project hub: JSON API + the UI's static page.
 *
 * Routes:
 *   GET    /health                                   → liveness
 *   GET    /api/workflows                             → list (with progress %)
 *   GET    /api/runners                               → which agent CLIs (claude/free-code) are installed on this host, for the create form
 *   POST   /api/workflows                             → create (admin token) — makes the awb hook too; optional templateId seeds its steps
 *   GET    /api/workflows/:id                          → detail + steps
 *   GET    /api/workflows/:id/session-info                → harness + session id + token usage of the current/last session
 *   POST   /api/workflows/:id/open-terminal              → spawn a local terminal resuming the current/last session (admin token)
 *   DELETE /api/workflows/:id                          → remove: deletes its awb hook + .md file + DB rows (admin token)
 *   PATCH  /api/workflows/:id/context                  → set the conversation context preamble (admin token)
 *   POST   /api/workflows/:id/steps                    → add a step (admin token); optional afterStepId inserts it right after that step
 *   POST   /api/workflows/:id/steps/from-template       → append a template's steps (admin token)
 *   PATCH  /api/workflows/:id/steps/:stepId             → edit a step's description (admin token)
 *   DELETE /api/workflows/:id/steps/:stepId             → remove a pending step (admin token)
 *   POST   /api/workflows/:id/steps/:stepId/run         → run one step now, outside the sequential order (admin token)
 *   POST   /api/workflows/:id/steps/:stepId/abort        → abort a step stuck running, or reject one waiting for its review (admin token)
 *   POST   /api/workflows/:id/steps/:stepId/open-terminal  → spawn a local terminal resuming THIS step's session (admin token)
 *   POST   /api/workflows/:id/steps/:stepId/continue      → release a step waiting for its manual review (admin token)
 *   POST   /api/workflows/:id/steps/:stepId/status        → force a step's status by hand (admin token)
 *   POST   /api/workflows/:id/status                    → force the workflow's status by hand (admin token)
 *   POST   /api/workflows/:id/start                    → begin/continue sequential dispatch (admin token)
 *   POST   /api/workflows/:id/pause                    → stop dispatching further steps (admin token)
 *   POST   /api/workflows/:id/resume                   → undo pause (admin token)
 *   POST   /api/workflows/:id/restart                  → reset all steps, start over (admin token)
 *   POST   /api/steps/:id/result                       → awb's result callback (?token=<per-step token>)
 *   GET    /api/templates                              → list templates (optional ?q= filters by name/tag)
 *   POST   /api/templates                               → create a template (admin token)
 *   GET    /api/templates/:id                            → template detail
 *   GET    /api/fs/dirs?path=<dir>                        → list subdirectories (admin token; for the UI's directory picker)
 *   PATCH  /api/templates/:id                            → update a template (admin token)
 *   DELETE /api/templates/:id                            → remove a template (admin token)
 *   GET    /api/settings/notifications                     → notification preferences (master switch + per-channel config)
 *   PUT    /api/settings/notifications                     → replace the notification preferences (admin token)
 *   GET    /api/settings/shortcuts                        → keyboard-shortcut bindings (key per action)
 *   PUT    /api/settings/shortcuts                        → replace the shortcut bindings (admin token)
 *   GET    /                                           → ui/index.html
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
	AttachmentError,
	getAttachment,
	listFieldAttachments,
	listStepAttachments,
	listWorkflowAttachments,
	MAX_ATTACHMENT_BYTES,
	removeAttachment,
	saveAttachment,
} from "./attachments.ts";
import {
	availableRunners,
	harnessResumeCommand,
	hookRuntime,
	PUBLISHABLE_PERMISSION_MODES,
	type PublishablePermissionMode,
	PUBLISHABLE_RUNNERS,
	PUBLISHABLE_SANDBOXES,
	type PublishableRunner,
	type PublishableSandbox,
} from "./awb.ts";
import { needsContextReinjection, observeCompaction } from "./compaction.ts";
import type { HubConfig } from "./config.ts";
import { findConversation, listConversations, readConversationDigest } from "./conversations.ts";
import {
	promoteQueuedToRunning,
	deleteTemplate,
	getNotificationSettings,
	getShortcutSettings,
	getWorkflow,
	insertTemplate,
	getTemplate,
	latestStepSession,
	listSteps,
	listTemplates,
	listWorkflows,
	normalizeNotificationChannels,
	normalizeShortcutBindings,
	OVERRIDABLE_STEP_STATUSES,
	OVERRIDABLE_WORKFLOW_STATUSES,
	saveNotificationSettings,
	saveShortcutSettings,
	stepProgress,
	updateTemplate,
	type Attachment,
	type AttachmentField,
	ATTACHMENT_FIELDS,
	type OverridableStepStatus,
	type OverridableWorkflowStatus,
	type ShortcutAction,
	type Step,
	type Template,
	type Workflow,
} from "./db.ts";
import { stepActivity } from "./progress.ts";
import type { Logger } from "./runner.ts";
import { openResumeTerminal } from "./terminal.ts";
import { readTokenUsage } from "./transcript.ts";
import {
	abortStep,
	addStep,
	continueStep,
	createWorkflow,
	editStep,
	expireStale,
	forceStepStatus,
	forceWorkflowStatus,
	onStepResult,
	pauseWorkflow,
	reconcileContextStep,
	removeStep,
	removeWorkflow,
	restartWorkflow,
	resumeWorkflow,
	runStep,
	setConversationContext,
	startWorkflow,
	WorkflowError,
} from "./workflow.ts";
import { getStep } from "./db.ts";

/**
 * The UI is a React app (hub/ui) built by Vite into hub/ui/dist. The hub only
 * ever serves those built files — it has no bundler and no build step of its
 * own, so `npm run target:install` is what produces this directory.
 */
const UI_DIR = path.join(import.meta.dirname, "ui", "dist");
const UI_FILE = path.join(UI_DIR, "index.html");

/**
 * Body limit for the attachment upload route. The image arrives base64-encoded
 * inside JSON, which inflates it by 4/3, so this is the real per-file ceiling
 * (`MAX_ATTACHMENT_BYTES`) plus that overhead plus room for the surrounding
 * fields. `attachments.ts` still enforces the true limit on the DECODED bytes —
 * this only stops the server buffering an absurd request before it can.
 */
const MAX_ATTACHMENT_BODY_BYTES = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

/**
 * Serves a file from the built UI directory, or returns false when there's
 * nothing to serve.
 *
 * The resolved path is checked to still be inside `UI_DIR`, so a crafted
 * `/assets/../../..` can't read outside the build output. Vite fingerprints
 * asset filenames, so everything under `/assets/` is immutable and cached hard
 * while `index.html` is never cached (it's what points at the current hashes).
 */
function serveStatic(res: http.ServerResponse, pathname: string): boolean {
	const relative = pathname.replace(/^\/+/, "");
	if (relative === "") return false;

	const resolved = path.resolve(UI_DIR, relative);
	if (resolved !== UI_DIR && !resolved.startsWith(UI_DIR + path.sep)) return false;

	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		return false;
	}
	if (!stat.isFile()) return false;

	const immutable = pathname.startsWith("/assets/");
	res.writeHead(200, {
		"content-type": CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
		"content-length": stat.size,
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	});
	fs.createReadStream(resolved).pipe(res);
	return true;
}

// A small "target" bullseye served as the page favicon (see /favicon.svg).
// Recoloured for the light UI — the old near-black tile was drawn for the
// previous dark theme and looked like a hole punched in the tab strip.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#4f46e5"/>
  <circle cx="16" cy="16" r="9.5" fill="none" stroke="#ffffff" stroke-width="2.4"/>
  <circle cx="16" cy="16" r="4.5" fill="none" stroke="#ffffff" stroke-width="2.4"/>
  <circle cx="16" cy="16" r="1.6" fill="#ffffff"/>
</svg>`;

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

/**
 * How an attachment reaches the browser. `path` is the absolute file on this
 * machine — the same string composed into the agent's prompt, shown in the UI so
 * an operator can see exactly what the agent was given — and `url` is where the
 * thumbnail is fetched from.
 */
function publicAttachment(attachment: Attachment): Record<string, unknown> {
	return {
		id: attachment.id,
		workflowId: attachment.workflowId,
		stepId: attachment.stepId,
		field: attachment.field,
		filename: attachment.filename,
		mime: attachment.mime,
		size: attachment.size,
		path: attachment.path,
		url: `/api/attachments/${attachment.id}/content`,
		createdAt: attachment.createdAt,
	};
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
		// "host" rather than null when there's no sandbox block: the UI shows a
		// containment badge, and "unknown" would read as a warning where the
		// honest answer is "the default, on this machine".
		sandbox: runtime.sandbox?.kind ?? "host",
		image: runtime.sandbox?.image ?? null,
		progress: stepProgress(workflow.id),
		conversationContext: workflow.conversationContext,
		contextInjected: workflow.contextInjected,
		// Images pinned to the conversation-context field (field always "context";
		// a step's own attachments ride on the step, see publicStep).
		attachments: listFieldAttachments(workflow.id, null, "context").map(publicAttachment),
		// Whether this status was forced by a human rather than derived from the
		// steps — the UI marks it, and it's why the badge doesn't move on the next
		// poll (see `reconcileStatus`).
		statusManual: workflow.statusManual,
		statusManualAt: workflow.statusManualAt,
		createdAt: workflow.createdAt,
		updatedAt: workflow.updatedAt,
	};
}

function publicStep(step: Step, cfg: HubConfig): Record<string, unknown> {
	return {
		id: step.id,
		workflowId: step.workflowId,
		// "task" (what the operator wrote) or "context" (the hub-owned step that
		// delivers the workflow's background before everything else). The UI needs
		// it to pin that row, drop it from the selection maths and hide the actions
		// the server would refuse anyway.
		kind: step.kind,
		orderIndex: step.orderIndex,
		description: step.description,
		status: step.status,
		result: step.result,
		error: step.error,
		sessionId: step.sessionId,
		createdAt: step.createdAt,
		startedAt: step.startedAt,
		queuedAt: step.queuedAt,
		finishedAt: step.finishedAt,
		manualRun: step.manualRun,
		manualReview: step.manualReview,
		// Whether this step's work is delegated to a subagent (default) or run
		// inline on the shared session.
		useSubagent: step.useSubagent,
		acceptanceCriteria: step.acceptanceCriteria,
		// Images pinned to this step's two text inputs, in one list discriminated by
		// `field` ("description" | "acceptance") — the UI filters it per textarea.
		attachments: listStepAttachments(step.id).map(publicAttachment),
		maxRetries: step.maxRetries,
		retryIntervalSeconds: step.retryIntervalSeconds,
		retryCount: step.retryCount,
		phase: step.phase,
		selected: step.selected,
		// Set by the manual status override, so the UI can mark a status a person
		// asserted rather than one a run reported.
		statusManual: step.statusManual,
		statusManualAt: step.statusManualAt,
		// Progress watchdog (see progress.ts): when the agent was last seen doing
		// something and what the derived activity state is. `activity` is null for
		// anything that isn't `running` — there's nothing to watch.
		lastProgressAt: step.lastProgressAt,
		lastProgressKind: step.lastProgressKind,
		activity: stepActivity(step, cfg),
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

/** Reads the optional run config (acceptance criteria + manual-review gate + subagent toggle + retry budget + retry wait) from a step create/edit body. */
function readStepConfig(body: Record<string, unknown>): {
	acceptanceCriteria?: string | null;
	manualReview?: boolean;
	useSubagent?: boolean;
	maxRetries?: number;
	retryIntervalSeconds?: number;
} {
	const config: {
		acceptanceCriteria?: string | null;
		manualReview?: boolean;
		useSubagent?: boolean;
		maxRetries?: number;
		retryIntervalSeconds?: number;
	} = {};
	if ("acceptanceCriteria" in body) {
		config.acceptanceCriteria = typeof body.acceptanceCriteria === "string" ? body.acceptanceCriteria : null;
	}
	// Only when the client actually sent the field — an edit that omits it must
	// leave the gate as it was, never silently clear it (see `editStep`).
	if ("manualReview" in body) config.manualReview = body.manualReview === true;
	// Same "only when actually sent" rule, mirrored: absent leaves the stored
	// toggle alone, and since the toggle defaults to ON only an explicit `false`
	// makes a step run inline.
	if ("useSubagent" in body) config.useSubagent = body.useSubagent !== false;
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
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			res.end(html);
		} catch {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end(
				"target-hub is running, but the web UI isn't built.\n\nBuild it with:\n  npm run target:install\n\n(or, from hub/ui: npm install && npm run build)\n\nThe API is available meanwhile.",
			);
		}
		return;
	}

	// Favicon — a small "target" bullseye. The page links to /favicon.svg
	// explicitly; /favicon.ico is served as 204 to silence the default request
	// browsers make (otherwise it 404s and clutters the console/network tab).
	if (req.method === "GET" && url.pathname === "/favicon.svg") {
		res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" });
		res.end(FAVICON_SVG);
		return;
	}
	if (req.method === "GET" && url.pathname === "/favicon.ico") {
		res.writeHead(204, { "content-type": "image/x-icon" });
		res.end();
		return;
	}

	// Built UI assets (/assets/... plus anything else Vite emitted). Checked
	// before the catch-all 404 so the single-page app can load its own bundle.
	if (req.method === "GET" && parts[0] !== "api" && serveStatic(res, url.pathname)) {
		return;
	}

	if (parts[0] !== "api") {
		sendJson(res, 404, { error: "not_found" });
		return;
	}

	// --- /api/steps/:id/started (awb callback; per-step token, no admin) ---
	//
	// The broker POSTs `{started: true}` here the instant the run actually
	// begins (after the workdir `flock` is acquired). That flips a `queued` step
	// to `running` and starts its timeout clock at the true run start — so a
	// step queued behind another on the same workdir isn't timed out while
	// still waiting its turn. Authenticated with the same per-step token as the
	// result callback. A late/extra `started` for a step that's no longer
	// `queued` (already running, done, aborted, etc.) is a no-op. Best-effort:
	// if this callback is lost, the result callback still settles the step
	// (see `onStepResult`'s `queued` branch) and the `queuedTimeoutMs` safety
	// net eventually fails it.

	if (parts[1] === "steps" && parts[2] && parts[3] === "started" && req.method === "POST") {
		const step = getStep(parts[2]);
		const token = url.searchParams.get("token") ?? "";
		if (!step || !token || !timingSafeEqualStr(token, step.callbackToken)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const promoted = promoteQueuedToRunning(step.id);
		if (promoted) log(`step ${step.id} started (queued -> running)`);
		sendJson(res, 200, { ok: true, promoted });
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

	// --- /api/attachments/:id/content (serve an attached image) ---
	//
	// Deliberately NOT admin-gated, like every other read route here (GET
	// /api/workflows/:id is open too): the UI shows these as <img> thumbnails, and
	// an <img> tag cannot carry an Authorization header, so gating this would mean
	// no thumbnails at all. Only the bytes of a file the operator themselves
	// uploaded are served, and only by opaque uuid — never an arbitrary path.
	if (parts[1] === "attachments" && parts[2] && parts[3] === "content" && !parts[4] && req.method === "GET") {
		const attachment = getAttachment(parts[2]);
		if (!attachment) {
			sendJson(res, 404, { error: "unknown_attachment" });
			return;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(attachment.path);
		} catch {
			// Row without a file: the upload half-failed or someone cleaned
			// ~/.target by hand. Say so rather than serving an empty 200.
			sendJson(res, 410, { error: "attachment_file_missing" });
			return;
		}
		res.writeHead(200, {
			"content-type": attachment.mime,
			"content-length": stat.size,
			// Immutable: an attachment's bytes never change — a new image is a new id.
			"cache-control": "private, max-age=31536000, immutable",
			"content-disposition": `inline; filename="${attachment.filename.replace(/"/g, "")}"`,
		});
		fs.createReadStream(attachment.path).pipe(res);
		return;
	}

	// --- /api/attachments/:id (remove an attached image) ---

	if (parts[1] === "attachments" && parts[2] && !parts[3] && req.method === "DELETE") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		// Read the row BEFORE deleting it: removing the last context image can leave
		// a workflow with no background at all, and the context step then has to go
		// with it — but afterwards there's nothing left to say which workflow that
		// was, or that this was a context attachment in the first place.
		const doomed = getAttachment(parts[2]);
		if (!removeAttachment(parts[2])) {
			sendJson(res, 404, { error: "unknown_attachment" });
			return;
		}
		if (doomed?.field === "context") reconcileContextStep(doomed.workflowId);
		log(`attachment ${parts[2]} deleted`);
		sendJson(res, 200, { ok: true });
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

	// --- /api/settings/notifications ---
	//
	// The notification preferences behind the UI's Settings view: one master
	// switch plus the per-channel config it gates (see `NotificationChannels` in
	// db.ts — Slack is the only channel specified so far). Reading is open, like
	// GET /api/templates; the PUT replaces the whole object and is admin-gated
	// like every other mutating route.
	//
	// Enabling notifications with no Slack username is rejected rather than
	// stored: "on, but with nowhere to deliver" is a half-saved state the UI
	// would then show back as valid.

	if (parts[1] === "settings" && parts[2] === "notifications" && !parts[3]) {
		if (req.method === "GET") {
			sendJson(res, 200, { settings: getNotificationSettings() });
			return;
		}
		if (req.method === "PUT" || req.method === "PATCH") {
			if (!isAdmin(cfg, req.headers)) {
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}
			readJsonBody(req, res, cfg.maxInputBytes, (body) => {
				const enabled = body.enabled === true;
				// Omitting `channels` keeps whatever is stored, so a client that only
				// flips the switch can't silently wipe the configured username.
				const channels =
					"channels" in body ? normalizeNotificationChannels(body.channels) : getNotificationSettings().channels;
				if (enabled && channels.slack.username === "") {
					sendJson(res, 400, { error: "slack username is required when notifications are enabled" });
					return;
				}
				const settings = saveNotificationSettings({ enabled, channels });
				log(`notification settings updated (notifications ${enabled ? "enabled" : "disabled"})`);
				sendJson(res, 200, { settings });
			});
			return;
		}
		sendJson(res, 404, { error: "not_found" });
		return;
	}

	// --- /api/settings/shortcuts ---
	//
	// The keyboard-shortcut bindings behind the UI's Settings view: one key per
	// action (focus the first workflow, toggle dictation, open the create-workflow
	// modal, press a held step's Continue, press the workflow's Start). The
	// modifier is still Alt or Shift — only the letter is stored.
	// Reading is open, like the notification preferences; the PUT replaces the
	// whole binding set and is admin-gated like every other mutating route.
	//
	// Two actions on the same key is rejected rather than stored: whichever fired
	// would be ambiguous, and the Settings form shows the clash inline first, but
	// the route guards it too so a hand-rolled PUT can't land an ambiguous set.

	if (parts[1] === "settings" && parts[2] === "shortcuts" && !parts[3]) {
		if (req.method === "GET") {
			sendJson(res, 200, { settings: getShortcutSettings() });
			return;
		}
		if (req.method === "PUT" || req.method === "PATCH") {
			if (!isAdmin(cfg, req.headers)) {
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}
			readJsonBody(req, res, cfg.maxInputBytes, (body) => {
				// Omitting `bindings` keeps whatever is stored, so a client that only
				// flips one key can't silently wipe the others.
				const bindings =
					"bindings" in body
						? normalizeShortcutBindings(body.bindings)
						: getShortcutSettings().bindings;
				const keys = new Set<string>();
				for (const action of [
					"focusWorkflow",
					"toggleDictation",
					"createWorkflow",
					"continueStep",
					"startWorkflow",
				] as ShortcutAction[]) {
					const key = bindings[action].key;
					if (keys.has(key)) {
						sendJson(res, 400, {
							error: `two shortcuts share the key "${key}" — each action needs its own key`,
						});
						return;
					}
					keys.add(key);
				}
				const settings = saveShortcutSettings({ bindings });
				log(`shortcut settings updated (${Object.entries(settings.bindings)
					.map(([action, binding]) => `${action}=${binding.key}`)
					.join(", ")})`);
				sendJson(res, 200, { settings });
			});
			return;
		}
		sendJson(res, 404, { error: "not_found" });
		return;
	}

	// --- /api/fs/dirs (directory picker for the create-workflow form) ---
	//
	// Lists the subdirectories of a path on the hub's machine so the UI can
	// offer a click-through directory browser instead of forcing the operator
	// to type the workdir by hand. Exposes filesystem structure, so it's
	// admin-gated like every other route that touches the operator's machine.
	// `~` expands to the hub user's home; an empty/missing path starts there.

	if (parts[1] === "fs" && parts[2] === "dirs" && !parts[3] && req.method === "GET") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const raw = (url.searchParams.get("path") ?? "").trim();
		const expanded = raw === "" ? os.homedir() : raw.replace(/^~(?=\/|$)/, os.homedir());
		const resolved = path.resolve(expanded);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(resolved, { withFileTypes: true });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			sendJson(res, 400, {
				error:
					code === "ENOENT"
						? `no such directory: ${resolved}`
						: code === "ENOTDIR"
							? `not a directory: ${resolved}`
							: code === "EACCES"
								? `permission denied: ${resolved}`
								: `cannot read directory: ${resolved}`,
			});
			return;
		}
		const dirs = entries
			.filter((entry) => {
				if (entry.isDirectory()) return true;
				if (!entry.isSymbolicLink()) return false;
				// Follow symlinks only far enough to know they point at a directory.
				try {
					return fs.statSync(path.join(resolved, entry.name)).isDirectory();
				} catch {
					return false;
				}
			})
			.map((entry) => entry.name)
			.sort((a, b) => {
				// Hidden directories after visible ones, both alphabetically.
				const aHidden = a.startsWith(".");
				const bHidden = b.startsWith(".");
				if (aHidden !== bHidden) return aHidden ? 1 : -1;
				return a.localeCompare(b);
			});
		const parent = path.dirname(resolved);
		sendJson(res, 200, {
			path: resolved,
			parent: parent === resolved ? null : parent,
			home: os.homedir(),
			dirs,
		});
		return;
	}

	// Which runners are installed on this host, so the create form can show
	// only the agents the operator can actually run. Read-only and ungated
	// (no admin token): it reports nothing the browser doesn't already know
	// about the machine it's running on, and the form needs it before any
	// admin action is even possible.
	if (parts[1] === "runners" && !parts[2] && req.method === "GET") {
		sendJson(res, 200, { runners: availableRunners() });
		return;
	}

	// --- /api/conversations ---
	//
	// The harness conversations already on this machine, so a workflow can be
	// created FROM one (see conversations.ts). Three routes, matching the three
	// things the create form does with them: list the ones belonging to the
	// selected agent, show what would actually be imported, and reopen one in a
	// real terminal so the operator can confirm by eye that it's the right
	// conversation before committing to it.
	//
	// All three are admin-gated, unlike GET /api/runners next to them: that route
	// reports which CLIs are installed, these return the CONTENT of the
	// operator's conversations (and the third spawns a process on their desktop).

	if (parts[1] === "conversations") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		// Which harness's conversations. Required on the two read routes and
		// validated against the same list a workflow's runner is, because it selects
		// the on-disk layout to walk and the resume command to build. (The POST
		// below takes it from the body instead, like every other mutating route.)
		const runner = (url.searchParams.get("runner") ?? "").trim() as PublishableRunner;
		if (req.method === "GET" && !PUBLISHABLE_RUNNERS.includes(runner)) {
			sendJson(res, 400, { error: `invalid runner (allowed: ${PUBLISHABLE_RUNNERS.join(", ")})` });
			return;
		}

		if (!parts[2] && req.method === "GET") {
			// `no-store`, unlike every other GET here: this list changes whenever the
			// operator says anything to any agent, and the whole point of reopening
			// the form is to see the conversation you just had. A cached response —
			// the browser may heuristically reuse one, since this has no validator —
			// would answer "your new conversation isn't there" with stale bytes.
			res.setHeader("cache-control", "no-store");
			const { conversations, total } = listConversations(runner);
			sendJson(res, 200, { conversations, total });
			return;
		}

		// What the workflow would actually be given: the condensed transcript, so
		// the operator sees the import before it happens rather than after.
		if (parts[2] === "preview" && !parts[3] && req.method === "GET") {
			const sessionId = url.searchParams.get("sessionId") ?? "";
			const conversation = findConversation(runner, sessionId);
			if (!conversation) {
				sendJson(res, 404, { error: "unknown_conversation" });
				return;
			}
			const digest = readConversationDigest(conversation);
			sendJson(res, 200, { conversation, digest });
			return;
		}

		// Reopens the conversation in a terminal on this machine — the same
		// mechanism as a workflow's "Open conversation" button (terminal.ts), but
		// pointed at a conversation that has no workflow yet. `cd`'d into the
		// conversation's OWN workdir, which for claude is what makes `--resume`
		// find the transcript at all.
		if (parts[2] === "open-terminal" && !parts[3] && req.method === "POST") {
			readJsonBody(req, res, cfg.maxInputBytes, (body) => {
				const bodyRunner = typeof body.runner === "string" ? body.runner : "";
				if (!PUBLISHABLE_RUNNERS.includes(bodyRunner as PublishableRunner)) {
					sendJson(res, 400, { error: `invalid runner (allowed: ${PUBLISHABLE_RUNNERS.join(", ")})` });
					return;
				}
				const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
				// Resolved through the index rather than trusted: a free-code session
				// id is an absolute path, so this is what stops an arbitrary one being
				// handed to the terminal launcher.
				const conversation = findConversation(bodyRunner as PublishableRunner, sessionId);
				if (!conversation) {
					sendJson(res, 404, { error: "unknown_conversation" });
					return;
				}
				const command = harnessResumeCommand(conversation.runner, conversation.sessionId);
				if (!command) {
					sendJson(res, 400, { error: "unknown_harness" });
					return;
				}
				// No workdir in the transcript (an old or truncated one): fall back to
				// home rather than refusing. For free-code the session id is an absolute
				// path so the resume still finds it; for claude the resume may miss,
				// which the harness reports in the terminal the operator is watching.
				const workdir = conversation.workdir ?? os.homedir();
				void (async () => {
					try {
						await openResumeTerminal(workdir, command);
						sendJson(res, 200, { ok: true, sessionId: conversation.sessionId, workdir });
					} catch (err) {
						sendJson(res, 500, { error: String((err as Error).message ?? err) });
					}
				})();
			});
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
				// Optional: which CLI this workflow's hook spawns. Validated against
				// the runners awb actually ships adapters for; unset means claude.
				let runner: PublishableRunner | undefined;
				if (typeof body.runner === "string" && body.runner !== "") {
					if (!PUBLISHABLE_RUNNERS.includes(body.runner as PublishableRunner)) {
						sendJson(res, 400, { error: `invalid runner (allowed: ${PUBLISHABLE_RUNNERS.join(", ")})` });
						return;
					}
					runner = body.runner as PublishableRunner;
				}
				// Optional: where that CLI runs — on the host (default, unchanged) or
				// in a container. Orthogonal to the runner, so it's validated the same
				// way and against its own list.
				let sandbox: PublishableSandbox | undefined;
				if (typeof body.sandbox === "string" && body.sandbox !== "") {
					if (!PUBLISHABLE_SANDBOXES.includes(body.sandbox as PublishableSandbox)) {
						sendJson(res, 400, { error: `invalid sandbox (allowed: ${PUBLISHABLE_SANDBOXES.join(", ")})` });
						return;
					}
					sandbox = body.sandbox as PublishableSandbox;
				}
				// Host sandbox: the runner's CLI has to actually be installed on THIS
				// machine, because the broker — which runs here in phase 1 — later
				// execs that binary directly; a runner not on PATH is doomed to fail at
				// the first step's spawn with an opaque "run failed" (the real
				// `spawn <binary> ENOENT` stays buried in the broker log). Skipped for
				// `sandbox: "docker"`: the image ships its own binary, so probing the
				// host PATH would wrongly block a valid container workflow. The
				// effective runner is the one the hook will spawn — `runner` when set,
				// claude otherwise (the default the form would have selected).
				const effectiveRunner: PublishableRunner = runner ?? "claude";
				if ((sandbox ?? "host") !== "docker") {
					const installed = availableRunners().find((r) => r.id === effectiveRunner)?.installed ?? false;
					if (!installed) {
						sendJson(res, 400, {
							error: `runner '${effectiveRunner}' is not installed on this host (install it or use sandbox: docker with an image that ships it)`,
						});
						return;
					}
				}
				// The image is only meaningful for a docker sandbox; it's a hook field
				// (a docker tag / name), never a path or a command, so it's taken as
				// an opaque trimmed string.
				const image = typeof body.image === "string" && body.image.trim() !== "" ? body.image.trim() : undefined;
				// Optional: create the workflow FROM an existing harness conversation.
				// The named transcript is condensed here (conversations.ts) and stored
				// as the workflow's conversation context, which `createWorkflow` then
				// materialises as the hub-owned context step — so the background is
				// delivered by the machinery that already exists for it: before any
				// real step, on the shared session, exactly once.
				//
				// This is the ONE way a workflow may be born with a context, and it is
				// deliberately not a free-text field: `conversationContext` in a create
				// body is still ignored (acceptance criterion #8 — a context is set on
				// an existing workflow, via PATCH). What's accepted here is a REFERENCE
				// to a transcript that exists on this machine, which the server resolves
				// and condenses itself. `conversationNote` rides along as the operator's
				// own framing of the import and is meaningless without it; it goes
				// FIRST, because it is what they wrote for THIS workflow, with the
				// transcript as reference material underneath.
				let conversationContext: string | undefined;
				const source = body.conversation as { runner?: unknown; sessionId?: unknown } | null | undefined;
				if (source && typeof source === "object") {
					const note =
						typeof body.conversationNote === "string" && body.conversationNote.trim() !== ""
							? body.conversationNote.trim()
							: null;
					const sourceRunner = typeof source.runner === "string" ? source.runner : "";
					if (!PUBLISHABLE_RUNNERS.includes(sourceRunner as PublishableRunner)) {
						sendJson(res, 400, {
							error: `invalid conversation.runner (allowed: ${PUBLISHABLE_RUNNERS.join(", ")})`,
						});
						return;
					}
					const sessionId = typeof source.sessionId === "string" ? source.sessionId : "";
					// Same index-resolution guard as the /api/conversations routes: a
					// free-code session id is an absolute path, so it is never trusted
					// as one.
					const conversation = findConversation(sourceRunner as PublishableRunner, sessionId);
					if (!conversation) {
						sendJson(res, 404, { error: "unknown_conversation" });
						return;
					}
					const digest = readConversationDigest(conversation);
					conversationContext = note ? `${note}\n\n${digest.text}` : digest.text;
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
					const workflow = createWorkflow(name, {
						workdir,
						permissionMode,
						runner,
						sandbox,
						image,
						conversationContext,
					});
					if (template) {
						for (const step of template.steps) {
							addStep(workflow.id, step.description, {
								acceptanceCriteria: step.acceptanceCriteria,
								manualReview: step.manualReview,
								useSubagent: step.useSubagent,
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
		sendJson(res, 200, { workflow: publicWorkflow(workflow), steps: listSteps(workflowId).map((s) => publicStep(s, cfg)) });
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

	// --- /api/workflows/:id/context ---
	//
	// Edits a workflow's conversation context — the preamble injected before
	// the first step of a fresh conversation (see runner.ts). The context is
	// editable only BEFORE it's been injected: once `context_injected` is true
	// the agent is already operating under it, so editing is rejected (the UI
	// locks the field and disables Save). To change it, restart the workflow
	// first (restart resets the flag and starts a fresh conversation). Send an
	// empty string to clear it (only while still editable).

	if (workflowId && parts[3] === "context" && !parts[4] && (req.method === "PATCH" || req.method === "PUT")) {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		readJsonBody(req, res, cfg.maxInputBytes, (body) => {
			const context = typeof body.conversationContext === "string" ? body.conversationContext : null;
			try {
				const workflow = setConversationContext(workflowId, context);
				log(`workflow ${workflowId} conversation context updated`);
				sendJson(res, 200, { workflow: publicWorkflow(workflow) });
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		});
		return;
	}

	// --- /api/workflows/:id/attachments ---
	//
	// Pins an image to one of the three text inputs of this workflow: its
	// conversation context (`field: "context"`, no stepId), or a step's task
	// description / acceptance criteria (`field: "description" | "acceptance"`
	// plus that step's `stepId`).
	//
	// Base64 in a JSON body rather than multipart: every other route here speaks
	// JSON through `readJsonBody`, and multipart would mean a parser this server
	// doesn't have. The cost is the 4/3 inflation, which is why this route gets its
	// own body limit instead of `cfg.maxInputBytes` (64 KiB — smaller than any real
	// screenshot). `data` accepts a bare base64 string or a full
	// `data:image/png;base64,...` URL, since that's what the browser's FileReader
	// hands back.
	if (workflowId && parts[3] === "attachments" && !parts[4] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const workflow = getWorkflow(workflowId);
		if (!workflow) {
			sendJson(res, 404, { error: "unknown_workflow" });
			return;
		}
		readJsonBody(req, res, MAX_ATTACHMENT_BODY_BYTES, (body) => {
			const field = String(body.field ?? "");
			if (!ATTACHMENT_FIELDS.includes(field as AttachmentField)) {
				sendJson(res, 400, { error: `invalid field (allowed: ${ATTACHMENT_FIELDS.join(", ")})` });
				return;
			}
			const stepId = typeof body.stepId === "string" && body.stepId !== "" ? body.stepId : null;
			if (stepId !== null) {
				// The step must exist AND belong to this workflow — otherwise an
				// attachment could be hung off another workflow's step, where no prompt
				// would ever read it.
				const step = getStep(stepId);
				if (!step || step.workflowId !== workflowId) {
					sendJson(res, 404, { error: "unknown_step" });
					return;
				}
			}
			// Same freeze as editing the context text (see setConversationContext):
			// once the preamble has been injected the agent is already running under
			// it, so a newly attached image would never reach it. Refusing is honest;
			// storing it would look like it worked.
			if (field === "context" && workflow.contextInjected) {
				sendJson(res, 400, { error: "context already injected" });
				return;
			}
			const raw = typeof body.data === "string" ? body.data : "";
			// Tolerate a full data URL, and take the mime from it when the caller
			// didn't send one explicitly.
			const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(raw.trim());
			const base64 = (dataUrl ? dataUrl[2] : raw).replace(/\s+/g, "");
			const mime = typeof body.mime === "string" && body.mime !== "" ? body.mime : (dataUrl?.[1] ?? "");
			if (base64 === "") {
				sendJson(res, 400, { error: "data is required (base64 image bytes)" });
				return;
			}
			let data: Buffer;
			try {
				data = Buffer.from(base64, "base64");
			} catch {
				sendJson(res, 400, { error: "data is not valid base64" });
				return;
			}
			try {
				const attachment = saveAttachment({
					workflowId,
					stepId,
					field: field as AttachmentField,
					filename: typeof body.filename === "string" ? body.filename : "image",
					mime,
					data,
				});
				// An images-only conversation context is a real context (see
				// `contextPreamble`), so pinning the first context image is what brings
				// the context step into existence — the text path can't be the only
				// trigger or that workflow's background would never be delivered.
				if (field === "context") reconcileContextStep(workflowId);
				log(
					`attachment ${attachment.id} (${attachment.mime}, ${attachment.size}B) pinned to ${field}${
						stepId ? ` of step ${stepId}` : ""
					} of workflow ${workflowId} -> ${attachment.path}`,
				);
				sendJson(res, 200, { attachment: publicAttachment(attachment) });
			} catch (err) {
				sendJson(res, err instanceof AttachmentError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		});
		return;
	}

	// --- /api/workflows/:id/attachments (list, for a client that wants them all at once) ---

	if (workflowId && parts[3] === "attachments" && !parts[4] && req.method === "GET") {
		const workflow = getWorkflow(workflowId);
		if (!workflow) {
			sendJson(res, 404, { error: "unknown_workflow" });
			return;
		}
		sendJson(res, 200, { attachments: listWorkflowAttachments(workflowId).map(publicAttachment) });
		return;
	}

	// --- /api/workflows/:id/session-info ---
	//
	// Read-only summary (harness, session id, token usage) for the "Open
	// conversation" block — no admin token needed, same as GET
	// /api/workflows/:id, since nothing here mutates state or launches a
	// process on the operator's machine.

	if (workflowId && parts[3] === "session-info" && !parts[4] && req.method === "GET") {
		const workflow = getWorkflow(workflowId);
		if (!workflow) {
			sendJson(res, 404, { error: "unknown_workflow" });
			return;
		}
		const runtime = hookRuntime(workflow.hookUrl);
		const sessionId = latestStepSession(workflowId) ?? workflow.lastSessionId;
		// The UI polls this route, so it's also where a compaction gets noticed
		// without waiting for another step to be dispatched — an operator watching
		// a long-running workflow should see the boundary the moment it lands, not
		// on the next dispatch. `observeCompaction` only writes when the boundary is
		// newer than the stored one, so polling this doesn't write on every poll.
		const observed = observeCompaction(workflow, sessionId, log);
		sendJson(res, 200, {
			sessionId,
			harness: runtime.harness,
			sandbox: runtime.sandbox?.kind ?? "host",
			image: runtime.sandbox?.image ?? null,
			usage: sessionId && runtime.workdir ? readTokenUsage(runtime.workdir, sessionId) : null,
			lastCompactionAt: observed.lastCompactionAt,
			/** True between observing a boundary and the next dispatch re-stating the conversation context. */
			compactionPending: needsContextReinjection(observed),
		});
		return;
	}

	// --- /api/workflows/:id/open-terminal ---
	//
	// Spawns a terminal emulator on this machine (see terminal.ts), already
	// `cd`'d into the workdir of whichever step ran most recently, running that
	// harness's resume command. That's the shared session for a sequential run,
	// but for an on-demand ▶ run it's that run's own fresh session (which
	// `lastSessionId` never tracks), so we resolve it from the steps rather
	// than only from `lastSessionId`. Only possible once a session id exists: a
	// step still on its first run doesn't have one yet, because awb only
	// reports it in the completion callback. This launches a real OS process on
	// the operator's desktop, so it's admin-gated like every other mutating
	// action even though nothing in the DB changes.

	if (workflowId && parts[3] === "open-terminal" && !parts[4] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const workflow = getWorkflow(workflowId);
		if (!workflow) {
			sendJson(res, 404, { error: "unknown_workflow" });
			return;
		}
		const runtime = hookRuntime(workflow.hookUrl);
		const sessionId = latestStepSession(workflowId) ?? workflow.lastSessionId;
		if (!sessionId) {
			sendJson(res, 400, { error: "no_session_yet" });
			return;
		}
		if (!runtime.workdir) {
			sendJson(res, 400, { error: "unknown_workdir" });
			return;
		}
		// The sandbox is carried into the resume command: a workflow whose steps
		// ran in a container has its session inside that container's view of the
		// world, so the terminal has to enter the same one.
		const resumeCommand = harnessResumeCommand(runtime.harness, sessionId, runtime.sandbox, runtime.workdir);
		if (!resumeCommand) {
			sendJson(res, 400, { error: "unknown_harness" });
			return;
		}
		const workdir = runtime.workdir;
		(async () => {
			try {
				await openResumeTerminal(workdir, resumeCommand);
				sendJson(res, 200, { ok: true, sessionId, workdir });
			} catch (err) {
				sendJson(res, 500, { error: String((err as Error).message ?? err) });
			}
		})();
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
			// `afterStepId` inserts the new step directly after that one instead of
			// appending it at the end — the "add a step after the one I'm reviewing"
			// path, so the fix runs next rather than last. Omitted = append, which is
			// what every other caller does.
			const afterStepId = typeof body.afterStepId === "string" && body.afterStepId !== "" ? body.afterStepId : null;
			try {
				const step = addStep(workflowId, description, { ...readStepConfig(body), afterStepId });
				sendJson(res, 200, { step: publicStep(step, cfg) });
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
				// Task steps only. The context step's description holds the workflow's
				// conversation-context text, which could coincide with a template step's
				// wording — and a template step silently skipped as a "duplicate" of the
				// background would never run.
				const existingDescriptions = new Set(
					listSteps(workflowId)
						.filter((step) => step.kind === "task")
						.map((step) => step.description),
				);
				let added = 0;
				let skipped = 0;
				for (const step of template.steps) {
					if (existingDescriptions.has(step.description)) {
						skipped++;
						continue;
					}
					addStep(workflowId, step.description, {
						acceptanceCriteria: step.acceptanceCriteria,
						manualReview: step.manualReview,
						useSubagent: step.useSubagent,
						maxRetries: step.maxRetries,
						retryIntervalSeconds: step.retryIntervalSeconds,
					});
					existingDescriptions.add(step.description);
					added++;
				}
				sendJson(res, 200, {
					workflow: publicWorkflow(getWorkflow(workflowId) as Workflow),
					steps: listSteps(workflowId).map((s) => publicStep(s, cfg)),
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
				sendJson(res, 200, { step: publicStep(step, cfg) });
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
				sendJson(res, 200, { step: publicStep(step, cfg) });
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		})();
		return;
	}

	// --- /api/workflows/:id/steps/:stepId/continue (release a step held by its manual review) ---
	//
	// The "Continue" button on a step sitting in `waiting`: its work finished and
	// its judge (if any) accepted it, but the step carries the Manual review gate,
	// so the engine stopped there. This is the only way past it — the step goes
	// `done` and the workflow resumes (next step dispatched, or `completed`).
	// Admin-gated like every other mutating action. Async because releasing the
	// gate advances the workflow, which dispatches the next step.

	if (workflowId && parts[3] === "steps" && parts[4] && parts[5] === "continue" && !parts[6] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		(async () => {
			try {
				const step = await continueStep(workflowId, parts[4], cfg, log);
				log(`workflow ${workflowId} step ${parts[4]} continued past its manual review`);
				sendJson(res, 200, { step: publicStep(step, cfg) });
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		})();
		return;
	}

	// --- /api/workflows/:id/steps/:stepId/abort (abort a stuck step, or reject a held one) ---
	//
	// For a step whose dispatch never called back (a hung exec or judge) or
	// that's still queued on the workdir lock, this force-fails it so the
	// operator can re-run it via ▶ without restarting the whole workflow.
	// Preserves the step's session id, and kills the spawned process on the
	// broker (so an orphaned agent stops holding the workdir `flock`).
	//
	// On a step `waiting` at its manual-review gate the same route means the
	// other half of that decision: Continue approves the result, Abort refuses it
	// and stops the workflow (see `abortStep`). One route because it's one button
	// on the step, and because which of the two applies is a fact about the
	// step's status, not something the caller should have to know.
	// Admin-gated (mutating). Async because the broker kill is a network call.

	if (workflowId && parts[3] === "steps" && parts[4] && parts[5] === "abort" && !parts[6] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		(async () => {
			try {
				const workflow = await abortStep(workflowId, parts[4], log);
				log(`workflow ${workflowId} step ${parts[4]} aborted`);
				sendJson(res, 200, { workflow: publicWorkflow(workflow) });
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		})();
		return;
	}

	// --- /api/workflows/:id/steps/:stepId/open-terminal (talk to THIS step's agent) ---
	//
	// The workflow-level "Open conversation" resumes whichever session ran most
	// recently. That's the right answer from the header, and the wrong one from a
	// step held at its manual-review gate: the operator is looking at one step's
	// result and wants to talk to the agent about THAT — and by the time they
	// press it, another step may well have produced a newer session. So this
	// resolves the session from the step itself and is otherwise identical to the
	// workflow route (same runtime, same sandbox, same resume command). A step
	// that never reported a session (never run, or still on its first dispatch —
	// awb only reports one in the completion callback) answers `no_session_yet`.
	// Admin-gated: it launches a real process on the operator's desktop.

	if (workflowId && parts[3] === "steps" && parts[4] && parts[5] === "open-terminal" && !parts[6] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const workflow = getWorkflow(workflowId);
		if (!workflow) {
			sendJson(res, 404, { error: "unknown_workflow" });
			return;
		}
		const step = getStep(parts[4]);
		if (!step || step.workflowId !== workflowId) {
			sendJson(res, 404, { error: "unknown_step" });
			return;
		}
		if (!step.sessionId) {
			sendJson(res, 400, { error: "no_session_yet" });
			return;
		}
		const runtime = hookRuntime(workflow.hookUrl);
		if (!runtime.workdir) {
			sendJson(res, 400, { error: "unknown_workdir" });
			return;
		}
		const resumeCommand = harnessResumeCommand(runtime.harness, step.sessionId, runtime.sandbox, runtime.workdir);
		if (!resumeCommand) {
			sendJson(res, 400, { error: "unknown_harness" });
			return;
		}
		const workdir = runtime.workdir;
		const sessionId = step.sessionId;
		(async () => {
			try {
				await openResumeTerminal(workdir, resumeCommand);
				sendJson(res, 200, { ok: true, sessionId, workdir });
			} catch (err) {
				sendJson(res, 500, { error: String((err as Error).message ?? err) });
			}
		})();
		return;
	}

	// --- /api/workflows/:id/steps/:stepId/status (force a step's status by hand) ---
	//
	// The correction path for a step the engine got wrong: the agent did the work
	// but the run was cut short or its callback never landed, so the step reads
	// `failed`. Body: {"status": "done" | "failed" | "pending"}. Never dispatches
	// anything — see the manual-override block in workflow.ts for the full
	// semantics. Synchronous: it's a DB write plus the .md rewrite.

	if (workflowId && parts[3] === "steps" && parts[4] && parts[5] === "status" && !parts[6] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		const stepId = parts[4];
		readJsonBody(req, res, cfg.maxInputBytes, (body) => {
			const status = String(body.status ?? "") as OverridableStepStatus;
			if (!OVERRIDABLE_STEP_STATUSES.includes(status)) {
				sendJson(res, 400, { error: `status must be one of: ${OVERRIDABLE_STEP_STATUSES.join(", ")}` });
				return;
			}
			try {
				const step = forceStepStatus(workflowId, stepId, status, log);
				sendJson(res, 200, { step: publicStep(step, cfg) });
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		});
		return;
	}

	// --- /api/workflows/:id/status (force the workflow's status by hand) ---
	//
	// Same idea one level up, for the workflow badge itself. Body:
	// {"status": "completed" | "failed" | "paused" | "draft"}. The status is
	// pinned against re-derivation until the engine next writes one of its own.
	// Declared before the {start,pause,resume,restart} block only for symmetry
	// with the step route above; the paths don't overlap.

	if (workflowId && parts[3] === "status" && !parts[4] && req.method === "POST") {
		if (!isAdmin(cfg, req.headers)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}
		readJsonBody(req, res, cfg.maxInputBytes, (body) => {
			const status = String(body.status ?? "") as OverridableWorkflowStatus;
			if (!OVERRIDABLE_WORKFLOW_STATUSES.includes(status)) {
				sendJson(res, 400, { error: `status must be one of: ${OVERRIDABLE_WORKFLOW_STATUSES.join(", ")}` });
				return;
			}
			try {
				const workflow = forceWorkflowStatus(workflowId, status, log);
				sendJson(res, 200, { workflow: publicWorkflow(workflow) });
			} catch (err) {
				sendJson(res, err instanceof WorkflowError ? 400 : 500, { error: String((err as Error).message ?? err) });
			}
		});
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
