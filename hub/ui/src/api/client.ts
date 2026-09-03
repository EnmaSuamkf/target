/**
 * Thin typed wrapper over the hub's HTTP API (`hub/server.ts`).
 *
 * Two things it centralises, because getting them wrong is the main source of
 * confusing UI bugs:
 *
 * - **Auth.** Mutating routes accept either `Authorization: Bearer <adminToken>`
 *   or the login session cookie. When a token is stored in localStorage under
 *   `targetAdminToken` it is sent as Bearer (automation / legacy path); otherwise
 *   the session cookie from setup/login is used (desktop and browser after login).
 * - **Errors.** Every failure is normalised into `ApiError` carrying the
 *   server's `error` string, so callers show the real reason ("context already
 *   injected", "no_session_yet") instead of a bare status code.
 */
import type {
	Account,
	Adoptability,
	Attachment,
	AttachmentField,
	AuthStatus,
	CloneWorkflowInput,
	Conversation,
	ConversationPreview,
	CreateWorkflowInput,
	DirListing,
	HostCapabilities,
	NotificationSettings,
	NotificationSettingsInput,
	ReportSettings,
	ReportSettingsInput,
	OverridableStepStatus,
	OverridableWorkflowStatus,
	Runner,
	SessionInfo,
	ShortcutSettings,
	ShortcutSettingsInput,
	Step,
	StepConfigInput,
	StepNote,
	StepNoteInput,
	Resource,
	ResourceSelection,
	ResourceSet,
	ResourceSetInput,
	ResourceSetUsage,
	Tcp,
	TcpBundle,
	TcpInput,
	TcpSelection,
	TcpUsage,
	Template,
	TemplateBundle,
	TemplateInput,
	Workflow,
} from "./types.ts";

const TOKEN_KEY = "targetAdminToken";

export class ApiError extends Error {
	readonly status: number;
	/** The server's parsed body, when there was one — some errors carry more than the `error` string (e.g. `retryAfterSec` on a 429). */
	readonly payload: unknown;
	constructor(status: number, message: string, payload?: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.payload = payload;
	}
	/** True when the call failed only because the admin token is missing/wrong. */
	get isAuth(): boolean {
		return this.status === 401;
	}
	/** Seconds the server asked us to wait before retrying (429 answers). */
	get retryAfterSec(): number | null {
		if (this.status !== 429 || !this.payload || typeof this.payload !== "object") return null;
		const value = (this.payload as { retryAfterSec?: unknown }).retryAfterSec;
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	}
}

/**
 * Called when any request is answered `401 login_required` — the session
 * expired (or was killed by a password reset in another browser) while the app
 * was open. App.tsx registers its "back to the login screen" transition here;
 * without it, an expired session would just look like every action failing.
 */
let authLostHandler: (() => void) | null = null;

export function setAuthLostHandler(handler: () => void): void {
	authLostHandler = handler;
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
		// Bearer when present; otherwise rely on the login session cookie
		// (credentials: "same-origin" below). Server isAdmin() accepts either.
		if (token) finalHeaders.set("authorization", `Bearer ${token}`);
	}

	let res: Response;
	try {
		// credentials made explicit: the login session rides a cookie, and the
		// default (same-origin) is exactly right — stated so it survives refactors.
		res = await fetch(path, {
			...rest,
			headers: finalHeaders,
			credentials: "same-origin",
			...(body !== undefined ? { body } : {}),
		});
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
		if (res.status === 401 && message === "login_required" && authLostHandler) authLostHandler();
		throw new ApiError(res.status, message, payload);
	}
	return payload as T;
}

const json = (value: unknown): string => JSON.stringify(value);

// --- workflows ---

export async function listWorkflows(): Promise<Workflow[]> {
	const data = await request<{ workflows: Workflow[] }>("/api/workflows");
	return data.workflows;
}

/**
 * What this host can actually run — which agent CLIs are installed, and which
 * sandboxes are usable — so the create form offers only those. One request for
 * both: the form needs them together and neither is useful on its own.
 */
export async function listHostCapabilities(): Promise<HostCapabilities> {
	return await request<HostCapabilities>("/api/runners");
}

// --- conversations (the source a workflow can be created from) ---
//
// Admin-gated, unlike listHostCapabilities above: these return the CONTENT of the
// operator's own conversations, and the last one spawns a terminal on their
// desktop.

/**
 * This machine's `runner` conversations, newest first, with `total` — how many
 * exist, so the form can say when the list it's showing is not all of them.
 */
export function listConversations(runner: Runner): Promise<{ conversations: Conversation[]; total: number }> {
	return request<{ conversations: Conversation[]; total: number }>(
		`/api/conversations?runner=${encodeURIComponent(runner)}`,
		{ admin: true },
	);
}

/**
 * The tail of a conversation, so the operator can check where it got to before
 * committing a workflow to carrying on from there — plus whether it can be
 * carried on at all. Identification only: the workflow resumes the real session.
 */
export function previewConversation(
	runner: Runner,
	sessionId: string,
): Promise<{ conversation: Conversation; preview: ConversationPreview; adoptable: Adoptability }> {
	const query = `runner=${encodeURIComponent(runner)}&sessionId=${encodeURIComponent(sessionId)}`;
	return request<{ conversation: Conversation; preview: ConversationPreview; adoptable: Adoptability }>(
		`/api/conversations/preview?${query}`,
		{ admin: true },
	);
}

/**
 * Reopens the conversation in a terminal on this machine, so the operator can
 * see with their own eyes that it's the one they meant before creating a
 * workflow from it.
 */
export function openConversationTerminal(
	runner: Runner,
	sessionId: string,
): Promise<{ ok: true; sessionId: string; workdir: string }> {
	return request<{ ok: true; sessionId: string; workdir: string }>("/api/conversations/open-terminal", {
		method: "POST",
		admin: true,
		body: json({ runner, sessionId }),
	});
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
 * Copies the workflow — every step in order, its context, its images — into a
 * new workflow with an agent of its own. Nothing a run produced comes across:
 * the clone is a draft with every step pending. Returns the clone, so the
 * caller can open it.
 *
 * `input` is what the clone dialog collected on the new-workflow form; it is
 * sent whole, empty fields included, because the endpoint reads an absent key
 * as "inherit the source's" and an empty one as "make it the default". Omit it
 * entirely to clone as-is, under "Clone - <name>".
 */
export async function cloneWorkflow(id: string, input?: CloneWorkflowInput): Promise<Workflow> {
	const data = await request<{ workflow: Workflow; steps: Step[] }>(`/api/workflows/${id}/clone`, {
		method: "POST",
		admin: true,
		...(input ? { body: json(input) } : {}),
	});
	return data.workflow;
}

/** Renames the workflow. Its agent, hook and status file keep the name they were created with. */
export async function renameWorkflow(id: string, name: string): Promise<Workflow> {
	const data = await request<{ workflow: Workflow }>(`/api/workflows/${id}/name`, {
		method: "PATCH",
		admin: true,
		body: json({ name }),
	});
	return data.workflow;
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

/**
 * Syncs the run selection with the checkboxes as they stand right now — called
 * on every toggle, so a step unticked mid-run is really skipped by the engine
 * (and a pending one ticked mid-run is really picked up). Writes the flags and
 * nothing else: it never starts, stops or re-derives anything.
 */
export async function setStepSelection(id: string, stepIds: string[]): Promise<Step[]> {
	const data = await request<{ steps: Step[] }>(`/api/workflows/${id}/selection`, {
		method: "PUT",
		admin: true,
		body: json({ stepIds }),
	});
	return data.steps;
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

export async function addStepNote(
	workflowId: string,
	stepId: string,
	input: StepNoteInput,
): Promise<StepNote> {
	const data = await request<{ note: StepNote }>(`/api/workflows/${workflowId}/steps/${stepId}/notes`, {
		method: "POST",
		admin: true,
		body: json(input),
	});
	return data.note;
}

export async function editStepNote(
	workflowId: string,
	stepId: string,
	noteId: string,
	input: StepNoteInput,
): Promise<StepNote> {
	const data = await request<{ note: StepNote }>(`/api/workflows/${workflowId}/steps/${stepId}/notes/${noteId}`, {
		method: "PATCH",
		admin: true,
		body: json(input),
	});
	return data.note;
}

export function removeStepNote(workflowId: string, stepId: string, noteId: string): Promise<{ ok: true }> {
	return request<{ ok: true }>(`/api/workflows/${workflowId}/steps/${stepId}/notes/${noteId}`, {
		method: "DELETE",
		admin: true,
	});
}

export function removeStep(workflowId: string, stepId: string): Promise<{ ok: true }> {
	return request<{ ok: true }>(`/api/workflows/${workflowId}/steps/${stepId}`, { method: "DELETE", admin: true });
}

/**
 * Moves a step one place earlier (`up`) or later (`down`), swapping it with its
 * neighbour. Only a pending step can move, and only past another pending one —
 * anything else answers 400, which is why the arrows are disabled rather than
 * hidden on a step that has already run. Returns the whole reordered list,
 * since a swap changes two rows.
 */
export async function moveStep(workflowId: string, stepId: string, direction: "up" | "down"): Promise<Step[]> {
	const data = await request<{ steps: Step[] }>(`/api/workflows/${workflowId}/steps/${stepId}/move`, {
		method: "POST",
		admin: true,
		body: json({ direction }),
	});
	return data.steps;
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

/** Appends all of a template's steps, whether or not the workflow already has steps worded the same way. */
export function addStepsFromTemplate(
	workflowId: string,
	templateId: string,
): Promise<{ workflow: Workflow; steps: Step[]; added: number }> {
	return request<{ workflow: Workflow; steps: Step[]; added: number }>(
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
 *
 * `withFiles` adds the directory's regular files — what RCI's resource picker
 * needs to show a SKILL.md, and what the workdir picker has no use for.
 */
export function listDirs(path?: string, withFiles = false): Promise<DirListing> {
	const params = new URLSearchParams();
	if (path && path.trim() !== "") params.set("path", path.trim());
	if (withFiles) params.set("files", "1");
	const query = params.size > 0 ? `?${params.toString()}` : "";
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

/**
 * The export bundle for one template. Fetched as JSON rather than linked to
 * directly: the route is behind the login session, and it's the caller that
 * turns the bundle into a downloaded file (see `downloadJson` in TemplatesView),
 * so the same call also serves anything that just wants to look at the shape.
 */
export function exportTemplate(id: string): Promise<TemplateBundle> {
	return request<TemplateBundle>(`/api/templates/${id}/export`);
}

/** The same envelope, holding every template on this hub. */
export function exportAllTemplates(): Promise<TemplateBundle> {
	return request<TemplateBundle>("/api/templates/export");
}

/**
 * Stores a bundle's templates as new ones and returns what was created — with
 * fresh ids, and with a colliding name disambiguated by the hub, so the result
 * is what to tell the operator they actually got. `bundle` is whatever was
 * parsed out of the chosen file: the hub validates it and answers 400 with the
 * reason (`unknown_kind`, `unsupported_schema_version`, `invalid_bundle`).
 */
export async function importTemplates(bundle: unknown): Promise<Template[]> {
	const data = await request<{ templates: Template[] }>("/api/templates/import", {
		method: "POST",
		admin: true,
		body: json(bundle),
	});
	return data.templates;
}

// --- tcps ---

export async function listTcps(q?: string): Promise<Tcp[]> {
	const query = q && q.trim() !== "" ? `?q=${encodeURIComponent(q.trim())}` : "";
	const data = await request<{ tcps: Tcp[] }>(`/api/tcps${query}`);
	return data.tcps;
}

export async function createTcp(input: TcpInput): Promise<Tcp> {
	const data = await request<{ tcp: Tcp }>("/api/tcps", { method: "POST", admin: true, body: json(input) });
	return data.tcp;
}

export async function updateTcp(id: string, input: TcpInput): Promise<Tcp> {
	const data = await request<{ tcp: Tcp }>(`/api/tcps/${id}`, { method: "PATCH", admin: true, body: json(input) });
	return data.tcp;
}

export async function getTcpUsage(id: string, toolNames?: string[]): Promise<TcpUsage> {
	const query =
		toolNames && toolNames.length > 0 ? `?tools=${encodeURIComponent(toolNames.join(","))}` : "";
	const data = await request<{ usage: TcpUsage }>(`/api/tcps/${id}/usage${query}`);
	return data.usage;
}

export function deleteTcp(id: string): Promise<{ ok: true }> {
	return request<{ ok: true }>(`/api/tcps/${id}`, { method: "DELETE", admin: true });
}

export function exportTcp(id: string): Promise<TcpBundle> {
	return request<TcpBundle>(`/api/tcps/${id}/export`);
}

export function exportAllTcps(): Promise<TcpBundle> {
	return request<TcpBundle>("/api/tcps/export");
}

export async function importTcps(bundle: unknown): Promise<Tcp[]> {
	const data = await request<{ tcps: Tcp[] }>("/api/tcps/import", { method: "POST", admin: true, body: json(bundle) });
	return data.tcps;
}

export async function setWorkflowTcpSelections(workflowId: string, tcpSelections: TcpSelection[]): Promise<Workflow> {
	const data = await request<{ workflow: Workflow }>(`/api/workflows/${workflowId}/tcps`, {
		method: "PATCH",
		admin: true,
		body: json({ tcpSelections }),
	});
	return data.workflow;
}

/** @deprecated Sends whole-pack selections only. Prefer setWorkflowTcpSelections. */
export async function setWorkflowTcps(workflowId: string, tcpIds: string[]): Promise<Workflow> {
	const data = await request<{ workflow: Workflow }>(`/api/workflows/${workflowId}/tcps`, {
		method: "PATCH",
		admin: true,
		body: json({ tcpIds }),
	});
	return data.workflow;
}

// --- resource sets (RCI) ---

export async function listResourceSets(q?: string): Promise<ResourceSet[]> {
	const query = q ? `?q=${encodeURIComponent(q)}` : "";
	const data = await request<{ resourceSets: ResourceSet[] }>(`/api/resourcesets${query}`);
	return data.resourceSets;
}

export async function createResourceSet(input: ResourceSetInput): Promise<ResourceSet> {
	const data = await request<{ resourceSet: ResourceSet }>("/api/resourcesets", { method: "POST", admin: true, body: json(input) });
	return data.resourceSet;
}

export async function updateResourceSet(id: string, input: ResourceSetInput): Promise<ResourceSet> {
	const data = await request<{ resourceSet: ResourceSet }>(`/api/resourcesets/${id}`, {
		method: "PATCH",
		admin: true,
		body: json(input),
	});
	return data.resourceSet;
}

export async function getResourceSetUsage(id: string, resourceNames?: string[]): Promise<ResourceSetUsage> {
	const query = resourceNames && resourceNames.length > 0 ? `?resources=${encodeURIComponent(resourceNames.join(","))}` : "";
	const data = await request<{ usage: ResourceSetUsage }>(`/api/resourcesets/${id}/usage${query}`);
	return data.usage;
}

export function deleteResourceSet(id: string): Promise<{ ok: true }> {
	return request<{ ok: true }>(`/api/resourcesets/${id}`, { method: "DELETE", admin: true });
}

/**
 * Reads resources off the hub's machine — a folder of resources, one resource folder, or
 * a SKILL.md — and returns them without storing anything. The set editor merges
 * what comes back into the set it is editing; saving that set is the only write.
 */
export async function scanResources(path: string): Promise<{ suggestedName: string; resources: Resource[] }> {
	return request<{ suggestedName: string; resources: Resource[] }>("/api/resourcesets/scan", {
		method: "POST",
		admin: true,
		body: json({ path }),
	});
}

export async function setWorkflowResourceSelections(
	workflowId: string,
	resourceSelections: ResourceSelection[],
): Promise<Workflow> {
	const data = await request<{ workflow: Workflow }>(`/api/workflows/${workflowId}/resourcesets`, {
		method: "PATCH",
		admin: true,
		body: json({ resourceSelections }),
	});
	return data.workflow;
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

/** Activity-reporting preferences: ingest URL and related knobs. */
export async function getReportSettings(): Promise<ReportSettings> {
	const data = await request<{ settings: ReportSettings }>("/api/settings/report");
	return data.settings;
}

/**
 * Replaces the stored activity-reporting preferences. The server refuses
 * `enabled: true` with an empty URL (400).
 */
export async function saveReportSettings(input: ReportSettingsInput): Promise<ReportSettings> {
	const data = await request<{ settings: ReportSettings }>("/api/settings/report", {
		method: "PUT",
		admin: true,
		body: json(input),
	});
	return data.settings;
}

// --- auth (the single-user access layer) ---
//
// None of these take `admin: true`: setup/login/reset are open by design (they
// are how a session comes to exist), and me/logout authenticate with the
// session cookie itself, which `request` already sends (same-origin default).

/** Whether the one account exists yet — drives landing-vs-login on load. */
export async function getAuthStatus(): Promise<AuthStatus> {
	return await request<AuthStatus>("/api/auth/status");
}

/**
 * First-run setup. The response carries the recovery token IN THE CLEAR — the
 * only time it ever crosses the wire — so the caller must hand it to the
 * save-your-token screen and then drop it. Answers 409 once the account exists.
 */
export async function setupAccount(input: {
	password: string;
	displayName?: string;
}): Promise<{ account: Account; recoveryToken: string }> {
	return await request<{ account: Account; recoveryToken: string }>("/api/auth/setup", {
		method: "POST",
		body: json(input),
	});
}

/** Password-only login (single-user: there is nothing a username could select). */
export async function login(password: string): Promise<{ account: Account }> {
	return await request<{ account: Account }>("/api/auth/login", { method: "POST", body: json({ password }) });
}

export async function logout(): Promise<{ ok: true }> {
	return await request<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

/** The account behind the current session cookie; 401 login_required when there isn't one. */
export async function getAccount(): Promise<{ account: Account }> {
	return await request<{ account: Account }>("/api/auth/me");
}

/**
 * The forgot-password path: the saved recovery token stands in for an e-mail
 * channel. On success the response carries the ROTATED token in the clear (the
 * old one is dead) and the user is already signed in (every other session was
 * killed by the reset).
 */
export async function resetPassword(input: {
	recoveryToken: string;
	newPassword: string;
}): Promise<{ account: Account; recoveryToken: string }> {
	return await request<{ account: Account; recoveryToken: string }>("/api/auth/password/reset", {
		method: "POST",
		body: json(input),
	});
}
