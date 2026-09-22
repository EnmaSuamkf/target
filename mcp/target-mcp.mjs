#!/usr/bin/env node
/**
 * Target MCP server — stdio JSON-RPC proxy to the Target hub API (full UI parity).
 * Env: TARGET_HUB_URL (default http://127.0.0.1:8893), TARGET_ADMIN_TOKEN.
 */
import * as readline from "node:readline";

const HUB = (process.env.TARGET_HUB_URL ?? "http://127.0.0.1:8893").replace(/\/+$/, "");
const TOKEN = process.env.TARGET_ADMIN_TOKEN ?? "";
const PROTOCOL = "2024-11-05";
const SERVER_VERSION = "0.3.0";

const RUNNERS = ["claude", "free-code", "cursor"];
const SANDBOXES = ["host", "docker"];
const PERMISSION_MODES = ["acceptEdits", "auto", "manual", "dontAsk", "plan", "bypassPermissions"];
const WORKFLOW_STATUSES = ["draft", "paused", "completed", "failed"];
const STEP_STATUSES = ["pending", "done", "failed"];

function send(msg) {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(payload) {
	return {
		content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
	};
}

function errorText(message, code = "target_error") {
	const text = typeof message === "string" ? message : JSON.stringify(message, null, 2);
	return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message: text }) }] };
}

async function hubFetch(method, path, body) {
	if (!TOKEN && path !== "/health") {
		return {
			ok: false,
			status: 401,
			body: JSON.stringify({ error: "missing_token", message: "TARGET_ADMIN_TOKEN is not set" }),
		};
	}
	const headers = { Accept: "application/json" };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
	let res;
	try {
		res = await fetch(`${HUB}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			status: 0,
			body: JSON.stringify({
				error: "target_hub_offline",
				message: `Target hub not reachable at ${HUB} — start with npm start. (${message})`,
			}),
		};
	}
	return { ok: res.ok, status: res.status, body: await res.text() };
}

async function hubJson(method, path, body) {
	const r = await hubFetch(method, path, body);
	if (!r.ok) {
		let parsed;
		try {
			parsed = JSON.parse(r.body || "{}");
		} catch {
			parsed = r.body;
		}
		return errorText(parsed, r.status === 0 ? "target_hub_offline" : "hub_error");
	}
	try {
		return textResult(r.body ? JSON.parse(r.body) : { ok: true });
	} catch {
		return textResult(r.body || { ok: true });
	}
}

function enc(value) {
	return encodeURIComponent(String(value ?? ""));
}

function argsObj(args) {
	return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}

function pickString(a, key, required = false) {
	if (a[key] === undefined || a[key] === null) {
		if (required) throw new Error(`missing_${key}`);
		return undefined;
	}
	return String(a[key]);
}

function pickInt(a, key) {
	if (a[key] === undefined || a[key] === null) return undefined;
	const n = Math.floor(Number(a[key]));
	return Number.isFinite(n) ? n : undefined;
}

function omitUndefined(obj) {
	return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function stepConfigBody(a, { requireDescription = false } = {}) {
	const body = {};
	if (requireDescription || a.description !== undefined) {
		body.description = String(a.description ?? "");
	}
	if ("acceptanceCriteria" in a) {
		body.acceptanceCriteria = a.acceptanceCriteria == null ? null : String(a.acceptanceCriteria);
	}
	if ("manualReview" in a) body.manualReview = a.manualReview === true;
	if ("useSubagent" in a) body.useSubagent = a.useSubagent !== false;
	const maxRetries = pickInt(a, "maxRetries");
	if (maxRetries !== undefined) body.maxRetries = maxRetries;
	const retryIntervalSeconds = pickInt(a, "retryIntervalSeconds");
	if (retryIntervalSeconds !== undefined) body.retryIntervalSeconds = retryIntervalSeconds;
	if (a.afterStepId) body.afterStepId = String(a.afterStepId);
	return body;
}

function createWorkflowBody(a) {
	const body = { name: pickString(a, "name", true) };
	const workdir = pickString(a, "workdir");
	if (workdir) body.workdir = workdir;
	const runner = pickString(a, "runner");
	if (runner) body.runner = runner;
	const sandbox = pickString(a, "sandbox");
	if (sandbox) body.sandbox = sandbox;
	const image = pickString(a, "image");
	if (image) body.image = image;
	const templateId = pickString(a, "templateId");
	if (templateId) body.templateId = templateId;
	const permissionMode = pickString(a, "permissionMode");
	if (permissionMode) body.permissionMode = permissionMode;
	if (a.acceptBypassRisk === true) body.acceptBypassRisk = true;
	const conversationNote = pickString(a, "conversationNote");
	if (conversationNote) body.conversationNote = conversationNote;
	if (a.conversation && typeof a.conversation === "object") {
		body.conversation = {
			runner: pickString(a.conversation, "runner", true),
			sessionId: pickString(a.conversation, "sessionId", true),
		};
	}
	return body;
}

function cloneWorkflowBody(a) {
	return omitUndefined({
		name: pickString(a, "name", true),
		workdir: a.workdir !== undefined ? String(a.workdir) : undefined,
		runner: pickString(a, "runner", true),
		sandbox: pickString(a, "sandbox", true),
		image: a.image !== undefined ? String(a.image) : undefined,
		permissionMode: a.permissionMode !== undefined ? String(a.permissionMode) : undefined,
		acceptBypassRisk: a.acceptBypassRisk === true ? true : undefined,
	});
}

const STEP_CONFIG_SCHEMA = {
	acceptanceCriteria: { type: "string", description: "Acceptance criterion judged after the step" },
	manualReview: { type: "boolean", description: "Pause workflow for operator review when step completes" },
	useSubagent: { type: "boolean", description: "Run step in a subagent (default true if omitted on create)" },
	maxRetries: { type: "integer", minimum: 0 },
	retryIntervalSeconds: { type: "integer", minimum: 0 },
};

/** @type {Array<{ name: string; description: string; inputSchema: object; run: (a: Record<string, unknown>) => Promise<unknown> }>} */
const TOOLS = [
	{
		name: "hub_health",
		description: "Check whether the Target hub is reachable (GET /health)",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => {
			const r = await hubFetch("GET", "/health");
			return r.ok ? textResult({ ok: true, hub: HUB }) : textResult(JSON.parse(r.body || "{}"));
		},
	},
	{
		name: "list_runners",
		description: "List installed agent runtimes and available sandboxes (GET /api/runners)",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => hubJson("GET", "/api/runners"),
	},
	{
		name: "list_workflows",
		description: "List all workflows with progress",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => hubJson("GET", "/api/workflows"),
	},
	{
		name: "get_workflow",
		description: "Get a workflow and its steps",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" } },
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("GET", `/api/workflows/${enc(a.workflowId)}`),
	},
	{
		name: "create_workflow",
		description: "Create a workflow (same fields as the New workflow form)",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				workdir: { type: "string" },
				runner: { type: "string", enum: RUNNERS },
				sandbox: { type: "string", enum: SANDBOXES },
				image: { type: "string" },
				templateId: { type: "string" },
				permissionMode: { type: "string", enum: PERMISSION_MODES },
				acceptBypassRisk: { type: "boolean" },
				conversationNote: { type: "string" },
				conversation: {
					type: "object",
					properties: {
						runner: { type: "string", enum: RUNNERS },
						sessionId: { type: "string" },
					},
					required: ["runner", "sessionId"],
				},
			},
			required: ["name"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", "/api/workflows", createWorkflowBody(a)),
	},
	{
		name: "clone_workflow",
		description: "Clone a workflow (new-workflow form fields; omit to inherit defaults)",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				name: { type: "string" },
				workdir: { type: "string" },
				runner: { type: "string", enum: RUNNERS },
				sandbox: { type: "string", enum: SANDBOXES },
				image: { type: "string" },
				permissionMode: { type: "string", enum: [...PERMISSION_MODES, ""] },
				acceptBypassRisk: { type: "boolean" },
			},
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) => {
			const id = enc(a.workflowId);
			if (a.name) return hubJson("POST", `/api/workflows/${id}/clone`, cloneWorkflowBody(a));
			return hubJson("POST", `/api/workflows/${id}/clone`);
		},
	},
	{
		name: "delete_workflow",
		description: "Delete a workflow, its hook, and steps",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" } },
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("DELETE", `/api/workflows/${enc(a.workflowId)}`),
	},
	{
		name: "rename_workflow",
		description: "Rename a workflow",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" }, name: { type: "string" } },
			required: ["workflowId", "name"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("PATCH", `/api/workflows/${enc(a.workflowId)}/name`, { name: String(a.name) }),
	},
	{
		name: "set_conversation_context",
		description: "Set workflow conversation context (only before first injection)",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				conversationContext: { type: "string", description: "Empty string clears" },
			},
			required: ["workflowId", "conversationContext"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("PATCH", `/api/workflows/${enc(a.workflowId)}/context`, {
				conversationContext: String(a.conversationContext),
			}),
	},
	{
		name: "set_workflow_status",
		description: "Force workflow status by hand",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				status: { type: "string", enum: WORKFLOW_STATUSES },
			},
			required: ["workflowId", "status"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/status`, { status: String(a.status) }),
	},
	{
		name: "get_session_info",
		description: "Session id, harness, token usage for a workflow",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" } },
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("GET", `/api/workflows/${enc(a.workflowId)}/session-info`),
	},
	{
		name: "open_workflow_terminal",
		description: "Spawn a local terminal resuming the workflow session",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" } },
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", `/api/workflows/${enc(a.workflowId)}/open-terminal`),
	},
	{
		name: "set_step_selection",
		description: "Sync which steps are ticked for the next run (PUT /selection)",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepIds: { type: "array", items: { type: "string" } },
			},
			required: ["workflowId", "stepIds"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("PUT", `/api/workflows/${enc(a.workflowId)}/selection`, {
				stepIds: Array.isArray(a.stepIds) ? a.stepIds.map(String) : [],
			}),
	},
	{
		name: "start_workflow",
		description: "Start sequential dispatch for selected steps",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepIds: { type: "array", items: { type: "string" }, description: "Empty runs nothing" },
			},
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/start`, {
				stepIds: Array.isArray(a.stepIds) ? a.stepIds.map(String) : [],
			}),
	},
	{
		name: "pause_workflow",
		description: "Pause workflow dispatch",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" } },
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", `/api/workflows/${enc(a.workflowId)}/pause`),
	},
	{
		name: "resume_workflow",
		description: "Resume a paused workflow",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepIds: { type: "array", items: { type: "string" } },
			},
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/resume`, {
				stepIds: Array.isArray(a.stepIds) ? a.stepIds.map(String) : [],
			}),
	},
	{
		name: "restart_workflow",
		description: "Reset all steps and start over",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepIds: { type: "array", items: { type: "string" } },
			},
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/restart`, {
				stepIds: Array.isArray(a.stepIds) ? a.stepIds.map(String) : [],
			}),
	},
	{
		name: "set_workflow_tcp_selections",
		description: "Attach TCP packs/tools to a workflow",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				tcpSelections: {
					type: "array",
					items: {
						type: "object",
						properties: {
							tcpId: { type: "string" },
							toolNames: { type: "array", items: { type: "string" }, nullable: true },
						},
						required: ["tcpId"],
					},
				},
				tcpIds: { type: "array", items: { type: "string" }, description: "Legacy: attach whole packs" },
			},
			required: ["workflowId"],
			additionalProperties: false,
		},
		run: async (a) => {
			const body =
				a.tcpSelections !== undefined
					? { tcpSelections: a.tcpSelections }
					: { tcpIds: Array.isArray(a.tcpIds) ? a.tcpIds.map(String) : [] };
			return hubJson("PATCH", `/api/workflows/${enc(a.workflowId)}/tcps`, body);
		},
	},
	{
		name: "set_workflow_resource_selections",
		description: "Attach Resource Sets (RCI) to a workflow",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				resourceSelections: {
					type: "array",
					items: {
						type: "object",
						properties: {
							resourceSetId: { type: "string" },
							resourceNames: { type: "array", items: { type: "string" }, nullable: true },
						},
						required: ["resourceSetId"],
					},
				},
			},
			required: ["workflowId", "resourceSelections"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("PATCH", `/api/workflows/${enc(a.workflowId)}/resourcesets`, {
				resourceSelections: a.resourceSelections,
			}),
	},
	{
		name: "add_step",
		description: "Add a step (full step form: description, acceptance, subagent, manual review, retries)",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				description: { type: "string" },
				afterStepId: { type: "string", description: "Insert after this step id" },
				...STEP_CONFIG_SCHEMA,
			},
			required: ["workflowId", "description"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/steps`, stepConfigBody(a, { requireDescription: true })),
	},
	{
		name: "edit_step",
		description: "Edit a pending step (same fields as the step editor)",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepId: { type: "string" },
				description: { type: "string" },
				...STEP_CONFIG_SCHEMA,
			},
			required: ["workflowId", "stepId", "description"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson(
				"PATCH",
				`/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}`,
				stepConfigBody(a, { requireDescription: true }),
			),
	},
	{
		name: "delete_step",
		description: "Delete a pending step",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" }, stepId: { type: "string" } },
			required: ["workflowId", "stepId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("DELETE", `/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}`),
	},
	{
		name: "move_step",
		description: "Move a pending step up or down",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepId: { type: "string" },
				direction: { type: "string", enum: ["up", "down"] },
			},
			required: ["workflowId", "stepId", "direction"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}/move`, {
				direction: String(a.direction),
			}),
	},
	{
		name: "continue_step",
		description: "Release a step waiting at manual review",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" }, stepId: { type: "string" } },
			required: ["workflowId", "stepId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", `/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}/continue`),
	},
	{
		name: "abort_step",
		description: "Abort a running step or reject one at manual review",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" }, stepId: { type: "string" } },
			required: ["workflowId", "stepId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", `/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}/abort`),
	},
	{
		name: "set_step_status",
		description: "Force a step status (pending, done, failed)",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepId: { type: "string" },
				status: { type: "string", enum: STEP_STATUSES },
			},
			required: ["workflowId", "stepId", "status"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}/status`, {
				status: String(a.status),
			}),
	},
	{
		name: "open_step_terminal",
		description: "Open terminal for this step's session",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" }, stepId: { type: "string" } },
			required: ["workflowId", "stepId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", `/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}/open-terminal`),
	},
	{
		name: "add_steps_from_template",
		description: "Append all steps from a template to a workflow",
		inputSchema: {
			type: "object",
			properties: { workflowId: { type: "string" }, templateId: { type: "string" } },
			required: ["workflowId", "templateId"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/steps/from-template`, {
				templateId: String(a.templateId),
			}),
	},
	{
		name: "add_step_note",
		description: "Add a sticky note on a step",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepId: { type: "string" },
				content: { type: "string" },
				theme: { type: "string" },
			},
			required: ["workflowId", "stepId", "content"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}/notes`, {
				content: String(a.content),
				...(a.theme ? { theme: String(a.theme) } : {}),
			}),
	},
	{
		name: "edit_step_note",
		description: "Edit a sticky note",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepId: { type: "string" },
				noteId: { type: "string" },
				content: { type: "string" },
				theme: { type: "string" },
			},
			required: ["workflowId", "stepId", "noteId", "content"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("PATCH", `/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}/notes/${enc(a.noteId)}`, {
				content: String(a.content),
				...(a.theme ? { theme: String(a.theme) } : {}),
			}),
	},
	{
		name: "delete_step_note",
		description: "Remove a sticky note",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				stepId: { type: "string" },
				noteId: { type: "string" },
			},
			required: ["workflowId", "stepId", "noteId"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("DELETE", `/api/workflows/${enc(a.workflowId)}/steps/${enc(a.stepId)}/notes/${enc(a.noteId)}`),
	},
	{
		name: "upload_attachment",
		description: "Upload a base64 image attachment to workflow context or a step field",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: { type: "string" },
				field: { type: "string", enum: ["context", "description", "acceptance"] },
				stepId: { type: "string", description: "Required unless field is context" },
				filename: { type: "string" },
				mime: { type: "string" },
				data: { type: "string", description: "Base64-encoded file bytes" },
			},
			required: ["workflowId", "field", "data"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", `/api/workflows/${enc(a.workflowId)}/attachments`, {
				field: String(a.field),
				data: String(a.data),
				filename: a.filename ? String(a.filename) : "image",
				mime: a.mime ? String(a.mime) : "application/octet-stream",
				...(a.stepId ? { stepId: String(a.stepId) } : {}),
			}),
	},
	{
		name: "delete_attachment",
		description: "Delete an attachment by id",
		inputSchema: {
			type: "object",
			properties: { attachmentId: { type: "string" } },
			required: ["attachmentId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("DELETE", `/api/attachments/${enc(a.attachmentId)}`),
	},
	{
		name: "list_dirs",
		description: "List subdirectories (and optionally files) on the hub machine",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Empty or ~ for home" },
				withFiles: { type: "boolean" },
			},
			additionalProperties: false,
		},
		run: async (a) => {
			const params = new URLSearchParams();
			if (a.path) params.set("path", String(a.path));
			if (a.withFiles === true) params.set("files", "1");
			const q = params.size ? `?${params}` : "";
			return hubJson("GET", `/api/fs/dirs${q}`);
		},
	},
	{
		name: "list_conversations",
		description: "List adoptable conversations for a runner",
		inputSchema: {
			type: "object",
			properties: { runner: { type: "string", enum: RUNNERS } },
			required: ["runner"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("GET", `/api/conversations?runner=${enc(a.runner)}`),
	},
	{
		name: "preview_conversation",
		description: "Preview a conversation before adopting it into a workflow",
		inputSchema: {
			type: "object",
			properties: {
				runner: { type: "string", enum: RUNNERS },
				sessionId: { type: "string" },
			},
			required: ["runner", "sessionId"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson(
				"GET",
				`/api/conversations/preview?runner=${enc(a.runner)}&sessionId=${enc(a.sessionId)}`,
			),
	},
	{
		name: "open_conversation_terminal",
		description: "Open a terminal on an existing conversation",
		inputSchema: {
			type: "object",
			properties: {
				runner: { type: "string", enum: RUNNERS },
				sessionId: { type: "string" },
			},
			required: ["runner", "sessionId"],
			additionalProperties: false,
		},
		run: async (a) =>
			hubJson("POST", "/api/conversations/open-terminal", {
				runner: String(a.runner),
				sessionId: String(a.sessionId),
			}),
	},
	{
		name: "list_templates",
		description: "List workflow templates",
		inputSchema: {
			type: "object",
			properties: { q: { type: "string", description: "Filter by name/tag" } },
			additionalProperties: false,
		},
		run: async (a) => {
			const q = a.q ? `?q=${enc(a.q)}` : "";
			return hubJson("GET", `/api/templates${q}`);
		},
	},
	{
		name: "get_template",
		description: "Get one workflow template by id",
		inputSchema: {
			type: "object",
			properties: { templateId: { type: "string" } },
			required: ["templateId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("GET", `/api/templates/${enc(a.templateId)}`),
	},
	{
		name: "create_template",
		description: "Create a workflow template",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				steps: { type: "array", items: { type: "object" } },
				tcpIds: { type: "array", items: { type: "string" } },
				tcpSelections: { type: "array", items: { type: "object" } },
				resourceSelections: { type: "array", items: { type: "object" } },
			},
			required: ["name", "tags", "steps"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", "/api/templates", a),
	},
	{
		name: "update_template",
		description: "Update a workflow template",
		inputSchema: {
			type: "object",
			properties: {
				templateId: { type: "string" },
				name: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				steps: { type: "array", items: { type: "object" } },
				tcpIds: { type: "array", items: { type: "string" } },
				tcpSelections: { type: "array", items: { type: "object" } },
				resourceSelections: { type: "array", items: { type: "object" } },
			},
			required: ["templateId"],
			additionalProperties: false,
		},
		run: async (a) => {
			const { templateId, ...body } = a;
			return hubJson("PATCH", `/api/templates/${enc(templateId)}`, body);
		},
	},
	{
		name: "delete_template",
		description: "Delete a template",
		inputSchema: {
			type: "object",
			properties: { templateId: { type: "string" } },
			required: ["templateId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("DELETE", `/api/templates/${enc(a.templateId)}`),
	},
	{
		name: "export_template",
		description: "Export one template as a bundle",
		inputSchema: {
			type: "object",
			properties: { templateId: { type: "string" } },
			required: ["templateId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("GET", `/api/templates/${enc(a.templateId)}/export`),
	},
	{
		name: "export_all_templates",
		description: "Export all templates",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => hubJson("GET", "/api/templates/export"),
	},
	{
		name: "import_templates",
		description: "Import a template bundle",
		inputSchema: {
			type: "object",
			properties: { bundle: { type: "object" } },
			required: ["bundle"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", "/api/templates/import", a.bundle),
	},
	{
		name: "list_tcps",
		description: "List TCP tool packs",
		inputSchema: {
			type: "object",
			properties: { q: { type: "string" } },
			additionalProperties: false,
		},
		run: async (a) => {
			const q = a.q ? `?q=${enc(a.q)}` : "";
			return hubJson("GET", `/api/tcps${q}`);
		},
	},
	{
		name: "get_tcp",
		description: "Get one TCP pack by id",
		inputSchema: {
			type: "object",
			properties: { tcpId: { type: "string" } },
			required: ["tcpId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("GET", `/api/tcps/${enc(a.tcpId)}`),
	},
	{
		name: "create_tcp",
		description: "Create a TCP pack",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				tools: { type: "array", items: { type: "object" } },
			},
			required: ["name"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", "/api/tcps", a),
	},
	{
		name: "update_tcp",
		description: "Update a TCP pack",
		inputSchema: {
			type: "object",
			properties: {
				tcpId: { type: "string" },
				name: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				tools: { type: "array", items: { type: "object" } },
			},
			required: ["tcpId"],
			additionalProperties: false,
		},
		run: async (a) => {
			const { tcpId, ...body } = a;
			return hubJson("PATCH", `/api/tcps/${enc(tcpId)}`, body);
		},
	},
	{
		name: "delete_tcp",
		description: "Delete a TCP pack",
		inputSchema: {
			type: "object",
			properties: { tcpId: { type: "string" } },
			required: ["tcpId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("DELETE", `/api/tcps/${enc(a.tcpId)}`),
	},
	{
		name: "get_tcp_usage",
		description: "List workflows/templates referencing a TCP pack",
		inputSchema: {
			type: "object",
			properties: {
				tcpId: { type: "string" },
				toolNames: { type: "array", items: { type: "string" } },
			},
			required: ["tcpId"],
			additionalProperties: false,
		},
		run: async (a) => {
			const tools =
				Array.isArray(a.toolNames) && a.toolNames.length > 0
					? `?tools=${encodeURIComponent(a.toolNames.join(","))}`
					: "";
			return hubJson("GET", `/api/tcps/${enc(a.tcpId)}/usage${tools}`);
		},
	},
	{
		name: "export_tcp",
		description: "Export one TCP pack",
		inputSchema: {
			type: "object",
			properties: { tcpId: { type: "string" } },
			required: ["tcpId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("GET", `/api/tcps/${enc(a.tcpId)}/export`),
	},
	{
		name: "export_all_tcps",
		description: "Export all TCP packs",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => hubJson("GET", "/api/tcps/export"),
	},
	{
		name: "import_tcps",
		description: "Import a TCP bundle",
		inputSchema: {
			type: "object",
			properties: { bundle: { type: "object" } },
			required: ["bundle"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", "/api/tcps/import", a.bundle),
	},
	{
		name: "list_resource_sets",
		description: "List RCI resource sets",
		inputSchema: {
			type: "object",
			properties: { q: { type: "string" } },
			additionalProperties: false,
		},
		run: async (a) => {
			const q = a.q ? `?q=${enc(a.q)}` : "";
			return hubJson("GET", `/api/resourcesets${q}`);
		},
	},
	{
		name: "get_resource_set",
		description: "Get one RCI resource set by id",
		inputSchema: {
			type: "object",
			properties: { resourceSetId: { type: "string" } },
			required: ["resourceSetId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("GET", `/api/resourcesets/${enc(a.resourceSetId)}`),
	},
	{
		name: "create_resource_set",
		description: "Create a resource set",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				resources: { type: "array", items: { type: "object" } },
			},
			required: ["name"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", "/api/resourcesets", a),
	},
	{
		name: "update_resource_set",
		description: "Update a resource set",
		inputSchema: {
			type: "object",
			properties: {
				resourceSetId: { type: "string" },
				name: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				resources: { type: "array", items: { type: "object" } },
			},
			required: ["resourceSetId"],
			additionalProperties: false,
		},
		run: async (a) => {
			const { resourceSetId, ...body } = a;
			return hubJson("PATCH", `/api/resourcesets/${enc(resourceSetId)}`, body);
		},
	},
	{
		name: "delete_resource_set",
		description: "Delete a resource set",
		inputSchema: {
			type: "object",
			properties: { resourceSetId: { type: "string" } },
			required: ["resourceSetId"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("DELETE", `/api/resourcesets/${enc(a.resourceSetId)}`),
	},
	{
		name: "get_resource_set_usage",
		description: "List workflows/templates referencing a resource set",
		inputSchema: {
			type: "object",
			properties: {
				resourceSetId: { type: "string" },
				resourceNames: { type: "array", items: { type: "string" } },
			},
			required: ["resourceSetId"],
			additionalProperties: false,
		},
		run: async (a) => {
			const resources =
				Array.isArray(a.resourceNames) && a.resourceNames.length > 0
					? `?resources=${encodeURIComponent(a.resourceNames.join(","))}`
					: "";
			return hubJson("GET", `/api/resourcesets/${enc(a.resourceSetId)}/usage${resources}`);
		},
	},
	{
		name: "scan_resources",
		description: "Scan a folder on the hub machine for importable resources",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
		run: async (a) => hubJson("POST", "/api/resourcesets/scan", { path: String(a.path) }),
	},
	{
		name: "get_notification_settings",
		description: "Read notification settings",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => hubJson("GET", "/api/settings/notifications"),
	},
	{
		name: "save_notification_settings",
		description: "Replace notification settings",
		inputSchema: { type: "object", properties: { settings: { type: "object" } }, required: ["settings"] },
		run: async (a) => hubJson("PUT", "/api/settings/notifications", a.settings),
	},
	{
		name: "get_shortcut_settings",
		description: "Read keyboard shortcut bindings",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => hubJson("GET", "/api/settings/shortcuts"),
	},
	{
		name: "save_shortcut_settings",
		description: "Replace keyboard shortcut bindings",
		inputSchema: { type: "object", properties: { settings: { type: "object" } }, required: ["settings"] },
		run: async (a) => hubJson("PUT", "/api/settings/shortcuts", a.settings),
	},
	{
		name: "get_report_settings",
		description: "Read activity report settings",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async () => hubJson("GET", "/api/settings/report"),
	},
	{
		name: "save_report_settings",
		description: "Replace activity report settings",
		inputSchema: { type: "object", properties: { settings: { type: "object" } }, required: ["settings"] },
		run: async (a) => hubJson("PUT", "/api/settings/report", a.settings),
	},
	{
		name: "hub_api",
		description:
			"Call any Target hub admin route directly (escape hatch). Path must start with /api/. Prefer named tools.",
		inputSchema: {
			type: "object",
			properties: {
				method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
				path: { type: "string", description: "e.g. /api/workflows/:id/steps/:stepId/run" },
				body: { type: "object" },
			},
			required: ["method", "path"],
			additionalProperties: false,
		},
		run: async (a) => {
			const path = String(a.path ?? "");
			if (!path.startsWith("/api/")) return errorText("path must start with /api/", "invalid_path");
			return hubJson(String(a.method), path, a.body);
		},
	},
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
const TOOL_DEFS = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

async function callTool(name, args) {
	const tool = TOOL_MAP.get(name);
	if (!tool) return errorText(`Unknown tool: ${name}`, "unknown_tool");
	try {
		return await tool.run(argsObj(args));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return errorText(message, "tool_error");
	}
}

async function handle(msg) {
	if (!msg || typeof msg !== "object") return;
	const { id, method, params } = msg;
	if (method === "notifications/initialized" || method === "notifications/cancelled") return;
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: PROTOCOL,
				capabilities: { tools: {} },
				serverInfo: { name: "target-mcp", version: SERVER_VERSION },
			},
		});
		return;
	}
	if (method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } });
		return;
	}
	if (method === "tools/call") {
		const result = await callTool(params?.name, params?.arguments);
		send({ jsonrpc: "2.0", id, result });
		return;
	}
	if (id !== undefined) {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
	}
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}
	void handle(msg);
});
