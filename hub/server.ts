/**
 * HTTP listener for The Target Project hub: JSON API + the UI's static page.
 *
 * Routes:
 *   GET    /health                                   → liveness
 *   GET    /api/workflows                             → list (with progress %)
 *   POST   /api/workflows                             → create (admin token) — makes the awb hook too; optional templateId seeds its steps
 *   GET    /api/workflows/:id                          → detail + steps
 *   GET    /api/workflows/:id/session-info                → harness + session id + token usage of the current/last session
 *   POST   /api/workflows/:id/open-terminal              → spawn a local terminal resuming the current/last session (admin token)
 *   DELETE /api/workflows/:id                          → remove: deletes its awb hook + .md file + DB rows (admin token)
 *   PATCH  /api/workflows/:id/context                  → set the conversation context preamble (admin token)
 *   POST   /api/workflows/:id/steps                    → add a step (admin token)
 *   POST   /api/workflows/:id/steps/from-template       → append a template's steps (admin token)
 *   PATCH  /api/workflows/:id/steps/:stepId             → edit a step's description (admin token)
 *   DELETE /api/workflows/:id/steps/:stepId             → remove a pending step (admin token)
 *   POST   /api/workflows/:id/steps/:stepId/run         → run one step now, outside the sequential order (admin token)
 *   POST   /api/workflows/:id/steps/:stepId/abort        → abort a step stuck running, so it can be re-run (admin token)
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
 *   GET    /                                           → ui/index.html
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
	harnessResumeCommand,
	hookRuntime,
	PUBLISHABLE_PERMISSION_MODES,
	type PublishablePermissionMode,
	PUBLISHABLE_RUNNERS,
	type PublishableRunner,
} from "./awb.ts";
import type { HubConfig } from "./config.ts";
import {
	promoteQueuedToRunning,
	deleteTemplate,
	getNotificationSettings,
	getWorkflow,
	insertTemplate,
	getTemplate,
	latestStepSession,
	listSteps,
	listTemplates,
	listWorkflows,
	normalizeNotificationChannels,
	saveNotificationSettings,
	stepProgress,
	updateTemplate,
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
		conversationContext: workflow.conversationContext,
		contextInjected: workflow.contextInjected,
		createdAt: workflow.createdAt,
		updatedAt: workflow.updatedAt,
	};
}

function publicStep(step: Step, cfg: HubConfig): Record<string, unknown> {
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
		queuedAt: step.queuedAt,
		finishedAt: step.finishedAt,
		manualRun: step.manualRun,
		acceptanceCriteria: step.acceptanceCriteria,
		maxRetries: step.maxRetries,
		retryIntervalSeconds: step.retryIntervalSeconds,
		retryCount: step.retryCount,
		phase: step.phase,
		selected: step.selected,
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
					const workflow = createWorkflow(name, { workdir, permissionMode, runner });
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
		sendJson(res, 200, {
			sessionId,
			harness: runtime.harness,
			usage: sessionId && runtime.workdir ? readTokenUsage(runtime.workdir, sessionId) : null,
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
		const resumeCommand = harnessResumeCommand(runtime.harness, sessionId);
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
			try {
				const step = addStep(workflowId, description, readStepConfig(body));
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

	// --- /api/workflows/:id/steps/:stepId/abort (abort a step stuck running/queued) ---
	//
	// For a step whose dispatch never called back (a hung exec or judge) or
	// that's still queued on the workdir lock, this force-fails it so the
	// operator can re-run it via ▶ without restarting the whole workflow.
	// Preserves the step's session id, and kills the spawned process on the
	// broker (so an orphaned agent stops holding the workdir `flock`).
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
