/**
 * Thin typed wrapper over the hub's HTTP API (`hub/server.ts`).
 *
 * Two things it centralises, because getting them wrong is the main source of
 * confusing UI bugs:
 *
 * - **Auth.** Mutating routes are gated on `Authorization: Bearer <adminToken>`
 *   and answer `401 {"error":"unauthorized"}` without it. The token lives in
 *   localStorage under `targetAdminToken` (the key the previous UI used, so an
 *   existing browser keeps working after the rewrite).
 * - **Errors.** Every failure is normalised into `ApiError` carrying the
 *   server's `error` string, so callers show the real reason ("context already
 *   injected", "no_session_yet") instead of a bare status code.
 */
import type {
	CreateWorkflowInput,
	DirListing,
	NotificationSettings,
	NotificationSettingsInput,
	SessionInfo,
	Step,
	StepConfigInput,
	Template,
	TemplateInput,
	Workflow,
} from "./types.ts";

const TOKEN_KEY = "targetAdminToken";

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
	/** True when the call failed only because the admin token is missing/wrong. */
	get isAuth(): boolean {
		return this.status === 401;
	}
}

export function getAdminToken(): string {
	try {
		return (localStorage.getItem(TOKEN_KEY) ?? "").trim();
	} catch {
		// Private mode / storage disabled — the app still works, it just has to
		// ask for the token again on every mutating action.
		return "";
	}
}

export function setAdminToken(token: string): void {
	try {
		localStorage.setItem(TOKEN_KEY, token.trim());
	} catch {
		// Non-fatal, see getAdminToken.
	}
}

export function clearAdminToken(): void {
	try {
		localStorage.removeItem(TOKEN_KEY);
	} catch {
		// Non-fatal, see getAdminToken.
	}
}

async function request<T>(path: string, init: RequestInit & { admin?: boolean } = {}): Promise<T> {
	const { admin = false, headers, body, ...rest } = init;
	const finalHeaders = new Headers(headers);
	if (body !== undefined) finalHeaders.set("content-type", "application/json");
	if (admin) {
		const token = getAdminToken();
		// Fail fast rather than firing a request we know the server rejects —
		// the caller turns this into the "enter your admin token" prompt.
		if (!token) throw new ApiError(401, "unauthorized");
		finalHeaders.set("authorization", `Bearer ${token}`);
	}

	let res: Response;
	try {
		res = await fetch(path, { ...rest, headers: finalHeaders, ...(body !== undefined ? { body } : {}) });
	} catch (err) {
		// Network-level failure (hub down, connection reset) never has a status.
		throw new ApiError(0, err instanceof Error ? err.message : String(err));
	}

	if (res.status === 204) return undefined as T;

	const payload = (await res.json().catch(() => null)) as unknown;
	if (!res.ok) {
		const message =
			payload && typeof payload === "object" && "error" in payload
				? String((payload as { error: unknown }).error)
				: `request failed (${res.status})`;
		throw new ApiError(res.status, message);
	}
	return payload as T;
}

const json = (value: unknown): string => JSON.stringify(value);

// --- workflows ---

export async function listWorkflows(): Promise<Workflow[]> {
	const data = await request<{ workflows: Workflow[] }>("/api/workflows");
	return data.workflows;
}

export function getWorkflow(id: string): Promise<{ workflow: Workflow; steps: Step[] }> {
	return request<{ workflow: Workflow; steps: Step[] }>(`/api/workflows/${id}`);
}

export async function createWorkflow(input: CreateWorkflowInput): Promise<Workflow> {
	const data = await request<{ workflow: Workflow }>("/api/workflows", {
		method: "POST",
		admin: true,
		body: json(input),
	});
	return data.workflow;
}

export function deleteWorkflow(id: string): Promise<{ ok: true }> {
	return request<{ ok: true }>(`/api/workflows/${id}`, { method: "DELETE", admin: true });
}

/**
 * `start` / `resume` / `restart` carry the step selection; `pause` ignores it.
 * An empty `stepIds` means "run nothing" — a deliberate no-op, not "run
 * everything" (see `setStepSelection` in hub/db.ts).
 */
export async function runWorkflowAction(
	id: string,
	action: "start" | "pause" | "resume" | "restart",
	stepIds: string[] = [],
): Promise<Workflow> {
	const data = await request<{ workflow: Workflow }>(`/api/workflows/${id}/${action}`, {
		method: "POST",
		admin: true,
		body: json({ stepIds }),
	});
	return data.workflow;
}

/** Editable only until it's been injected; the server answers 400 after that. */
export async function setConversationContext(id: string, conversationContext: string): Promise<Workflow> {
	const data = await request<{ workflow: Workflow }>(`/api/workflows/${id}/context`, {
		method: "PATCH",
		admin: true,
		body: json({ conversationContext }),
	});
	return data.workflow;
}

export function getSessionInfo(id: string): Promise<SessionInfo> {
	return request<SessionInfo>(`/api/workflows/${id}/session-info`);
}

/** Spawns a real terminal on the operator's machine — hence admin-gated. */
export function openTerminal(id: string): Promise<unknown> {
	return request<unknown>(`/api/workflows/${id}/open-terminal`, { method: "POST", admin: true });
}

// --- steps ---

export async function addStep(workflowId: string, input: StepConfigInput): Promise<Step> {
	const data = await request<{ step: Step }>(`/api/workflows/${workflowId}/steps`, {
		method: "POST",
		admin: true,
		body: json(input),
	});
	return data.step;
}

export async function editStep(workflowId: string, stepId: string, input: StepConfigInput): Promise<Step> {
	const data = await request<{ step: Step }>(`/api/workflows/${workflowId}/steps/${stepId}`, {
		method: "PATCH",
		admin: true,
		body: json(input),
	});
	return data.step;
}

export function removeStep(workflowId: string, stepId: string): Promise<{ ok: true }> {
	return request<{ ok: true }>(`/api/workflows/${workflowId}/steps/${stepId}`, { method: "DELETE", admin: true });
}

/** Runs one step now, outside the sequential order, on its own fresh session. */
export async function runStep(workflowId: string, stepId: string): Promise<Step> {
	const data = await request<{ step: Step }>(`/api/workflows/${workflowId}/steps/${stepId}/run`, {
		method: "POST",
		admin: true,
	});
	return data.step;
}

/** Force-fails a step whose dispatch never called back, preserving its session. */
export async function abortStep(workflowId: string, stepId: string): Promise<Workflow> {
	const data = await request<{ workflow: Workflow }>(`/api/workflows/${workflowId}/steps/${stepId}/abort`, {
		method: "POST",
		admin: true,
	});
	return data.workflow;
}

/** Appends a template's steps, skipping descriptions the workflow already has. */
export function addStepsFromTemplate(
	workflowId: string,
	templateId: string,
): Promise<{ workflow: Workflow; steps: Step[]; added: number; skipped: number }> {
	return request<{ workflow: Workflow; steps: Step[]; added: number; skipped: number }>(
		`/api/workflows/${workflowId}/steps/from-template`,
		{ method: "POST", admin: true, body: json({ templateId }) },
	);
}

// --- filesystem (directory picker) ---

/**
 * Lists the subdirectories of `path` on the hub's machine. Empty path (or
 * "~") starts at the hub user's home. Admin-gated: it exposes filesystem
 * structure, so it needs the same token as every mutating route.
 */
export function listDirs(path?: string): Promise<DirListing> {
	const query = path && path.trim() !== "" ? `?path=${encodeURIComponent(path.trim())}` : "";
	return request<DirListing>(`/api/fs/dirs${query}`, { admin: true });
}

// --- templates ---

/**
 * `q` filters server-side on name and tags. The templates view still filters
 * locally as you type (instant, no round-trip) and only uses this for the
 * initial load, but the parameter is here because the API supports it.
 */
export async function listTemplates(q?: string): Promise<Template[]> {
	const query = q && q.trim() !== "" ? `?q=${encodeURIComponent(q.trim())}` : "";
	const data = await request<{ templates: Template[] }>(`/api/templates${query}`);
	return data.templates;
}

export async function createTemplate(input: TemplateInput): Promise<Template> {
	const data = await request<{ template: Template }>("/api/templates", {
		method: "POST",
		admin: true,
		body: json(input),
	});
	return data.template;
}

export async function updateTemplate(id: string, input: TemplateInput): Promise<Template> {
	const data = await request<{ template: Template }>(`/api/templates/${id}`, {
		method: "PATCH",
		admin: true,
		body: json(input),
	});
	return data.template;
}

export function deleteTemplate(id: string): Promise<{ ok: true }> {
	return request<{ ok: true }>(`/api/templates/${id}`, { method: "DELETE", admin: true });
}

// --- settings ---

/** Notification preferences: the master switch plus the config it gates. */
export async function getNotificationSettings(): Promise<NotificationSettings> {
	const data = await request<{ settings: NotificationSettings }>("/api/settings/notifications");
	return data.settings;
}

/**
 * Replaces the stored preferences. The server refuses `enabled: true` with an
 * empty Slack username (400), so the Settings form validates that inline first
 * rather than relying on the round-trip to say no.
 */
export async function saveNotificationSettings(input: NotificationSettingsInput): Promise<NotificationSettings> {
	const data = await request<{ settings: NotificationSettings }>("/api/settings/notifications", {
		method: "PUT",
		admin: true,
		body: json(input),
	});
	return data.settings;
}
