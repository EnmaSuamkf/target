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
	Attachment,
	AttachmentField,
	CreateWorkflowInput,
	DirListing,
	NotificationSettings,
	NotificationSettingsInput,
	OverridableStepStatus,
	OverridableWorkflowStatus,
	RunnerAvailability,
	SessionInfo,
	ShortcutSettings,
	ShortcutSettingsInput,
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

/** Which agent CLIs are installed on the host, so the create form can show only those. */
export async function listRunners(): Promise<RunnerAvailability[]> {
	const data = await request<{ runners: RunnerAvailability[] }>("/api/runners");
	return data.runners;
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

/**
 * Forces the workflow's status by hand — for when the engine's verdict is
 * wrong (a run that ran out of tokens, a callback that never landed). It
 * doesn't run anything; it only records the status, and the hub then leaves
 * that status alone until the workflow is run again. Refused (400) while a step
 * is still in flight.
 */
export async function setWorkflowStatus(id: string, status: OverridableWorkflowStatus): Promise<Workflow> {
	const data = await request<{ workflow: Workflow }>(`/api/workflows/${id}/status`, {
		method: "POST",
		admin: true,
		body: json({ status }),
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

/**
 * Appends a step, or — with `afterStepId` — threads one in directly after that
 * step, pushing the rest down. The second form is how a step is added from the
 * one held at its manual-review gate: the new step lands next in the run, so the
 * Continue that releases the gate dispatches it before whatever followed.
 */
export async function addStep(workflowId: string, input: StepConfigInput, afterStepId?: string): Promise<Step> {
	const data = await request<{ step: Step }>(`/api/workflows/${workflowId}/steps`, {
		method: "POST",
		admin: true,
		body: json(afterStepId ? { ...input, afterStepId } : input),
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

// No wrapper for POST /steps/:stepId/run: the endpoint still exists as an admin
// HTTP surface, but nothing in this UI dispatches a single step out of order any
// more — running is the workflow's Start acting on the checked steps.

/**
 * Releases a step held at its manual-review gate: it goes `done` and the
 * workflow resumes. Only a `waiting` step can be continued — anything else
 * answers 400, which is why the button only appears on that status.
 */
export async function continueStep(workflowId: string, stepId: string): Promise<Step> {
	const data = await request<{ step: Step }>(`/api/workflows/${workflowId}/steps/${stepId}/continue`, {
		method: "POST",
		admin: true,
	});
	return data.step;
}

/**
 * Forces one step's status by hand: "the agent did do this" (`done`), "it
 * didn't" (`failed`) or "put it back in the queue" (`pending`). Never
 * re-dispatches the step — a step corrected to `done` is not re-run, and one
 * put back to `pending` only runs on the next Start. Refused (400) while the
 * step has a job in flight; abort it first.
 */
export async function setStepStatus(
	workflowId: string,
	stepId: string,
	status: OverridableStepStatus,
): Promise<Step> {
	const data = await request<{ step: Step }>(`/api/workflows/${workflowId}/steps/${stepId}/status`, {
		method: "POST",
		admin: true,
		body: json({ status }),
	});
	return data.step;
}

/**
 * Opens a terminal resuming THIS step's own session, rather than the workflow's
 * most recent one — what "talk to the agent about this step" means when the step
 * is held for review and a newer session may already exist. Answers 400
 * `no_session_yet` for a step that never reported one.
 */
export function openStepTerminal(workflowId: string, stepId: string): Promise<unknown> {
	return request<unknown>(`/api/workflows/${workflowId}/steps/${stepId}/open-terminal`, {
		method: "POST",
		admin: true,
	});
}

/**
 * Force-fails a step whose dispatch never called back, preserving its session —
 * and, on a step held at its manual-review gate, refuses the result instead:
 * the step fails and the workflow stops with it. Same route either way; the
 * server decides from the step's status.
 */
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

// --- attachments (images pinned to a text input) ---

/**
 * Reads a `File` as the bare base64 the upload route wants.
 *
 * FileReader's `readAsDataURL` is the only way to get base64 out of a File
 * without hand-rolling a Uint8Array→base64 loop, so the `data:...;base64,`
 * prefix is stripped here rather than shipped (the server tolerates either, but
 * sending the bare payload keeps the request smaller and the intent obvious).
 */
function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new ApiError(0, `could not read ${file.name}`));
		reader.onload = () => {
			const result = String(reader.result ?? "");
			const comma = result.indexOf(",");
			resolve(comma === -1 ? result : result.slice(comma + 1));
		};
		reader.readAsDataURL(file);
	});
}

/**
 * Pins one image to a text input of a workflow.
 *
 * `stepId` must be omitted for `field: "context"` and given for the two
 * per-step fields — the server rejects the mismatch, since an attachment on the
 * wrong owner is one no prompt would ever read.
 */
export async function uploadAttachment(
	workflowId: string,
	input: { field: AttachmentField; stepId?: string | null; file: File },
): Promise<Attachment> {
	const data = await fileToBase64(input.file);
	const payload = await request<{ attachment: Attachment }>(`/api/workflows/${workflowId}/attachments`, {
		method: "POST",
		admin: true,
		body: json({
			field: input.field,
			...(input.stepId ? { stepId: input.stepId } : {}),
			filename: input.file.name || "image",
			// A pasted screenshot's File has the right type but an empty name, so the
			// mime has to come from the File rather than be guessed from the name.
			mime: input.file.type,
			data,
		}),
	});
	return payload.attachment;
}

export function deleteAttachment(id: string): Promise<{ ok: true }> {
	return request<{ ok: true }>(`/api/attachments/${id}`, { method: "DELETE", admin: true });
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

/** Keyboard-shortcut bindings: one key per action. */
export async function getShortcutSettings(): Promise<ShortcutSettings> {
	const data = await request<{ settings: ShortcutSettings }>("/api/settings/shortcuts");
	return data.settings;
}

/**
 * Replaces the stored bindings. The server refuses a set where two actions
 * share a key (400), so the Settings form checks for that clash inline first.
 */
export async function saveShortcutSettings(input: ShortcutSettingsInput): Promise<ShortcutSettings> {
	const data = await request<{ settings: ShortcutSettings }>("/api/settings/shortcuts", {
		method: "PUT",
		admin: true,
		body: json(input),
	});
	return data.settings;
}
