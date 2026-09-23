/**
 * Remote-sync agent — client side of the hybrid push/pull protocol (see
 * target-server/docs/remote-sync.md).
 *
 * On each interval tick: register (when needed), heartbeat, poll commands,
 * apply them via the local workflow engine, ack results, and push events for
 * remote-origin workflow state changes.
 */
import * as crypto from "node:crypto";
import * as os from "node:os";
import {
	availableRunners,
	PUBLISHABLE_RUNNERS,
	type PublishableRunner,
	type PublishableSandbox,
} from "./awb.ts";
import { type HubConfig, type SyncConfig } from "./config.ts";
import { deviceHeaders, handleDeviceAuthResponse, remoteAuth } from "./device-auth.ts";
import { getDeviceLinkStatus, markDeviceRemoteRecovered, setDeviceLinkRemoteState } from "./device-link.ts";
import { recordOwnerSnapshot } from "./owner-permissions.ts";
import { loadEffectiveSyncConfig } from "./remote-config.ts";
import {
	clearAppliedSyncCommands,
	deleteSyncStepMap,
	getAppliedSyncCommand,
	getOrCreateInstanceId,
	getStep,
	getSyncStepMap,
	getTemplate,
	getWorkflowByRemoteId,
	listSteps,
	listWorkflows,
	markSyncCommandApplied,
	saveSyncCredentials,
	saveSyncStepMap,
	setSyncStepKey,
	setWorkflowRemoteMeta,
	type OverridableStepStatus,
	type OverridableWorkflowStatus,
	normalizeTemplateStepNotes,
	type Workflow,
} from "./db.ts";
import { normalizeResourceSelections } from "./rci-selection.ts";
import {
	applyTemplateResourcesToWorkflow,
	deleteResourceSet,
	setWorkflowResourceSelections,
	upsertServerResourceSet,
} from "./rci-store.ts";
import { normalizeTcpSelections } from "./tcp-selection.ts";
import {
	applyTemplateTcpsToWorkflow,
	deleteTcp,
	setWorkflowTcpSelections,
	upsertServerTcp,
} from "./tcp-store.ts";
import { TARGET_VERSION } from "./version.ts";
import {
	addStep,
	abortStep,
	continueStep,
	createWorkflow,
	editStep,
	forceStepStatus,
	forceWorkflowStatus,
	moveStep,
	operatorWorkdir,
	pauseWorkflow,
	removeStep,
	removeWorkflow,
	renameWorkflow,
	restartWorkflow,
	resumeWorkflow,
	runStep,
	setConversationContext,
	startWorkflow,
	type StepMoveDirection,
	WorkflowError,
} from "./workflow.ts";

/** A command returned by GET /api/sync/commands. */
export interface SyncCommand {
	id: string;
	type: string;
	remote_id: string;
	sequence: number;
	payload: Record<string, unknown>;
	status: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SyncTickOptions {
	config?: SyncConfig;
	hubConfig?: HubConfig;
	fetchImpl?: FetchLike;
	log?: (message: string, level?: "info" | "warning" | "error") => void;
}

const SYNC_TIMEOUT_MS = 15_000;
const workflowStatusCache = new Map<string, string>();
const stepStatusCache = new Map<string, string>();
const pendingEvents: SyncOutboundEvent[] = [];

/** Command types the executor understands (mirrors target-server blueprint). */
export const SYNC_COMMAND_TYPES = [
	"workflow.create",
	"workflow.create_with_steps",
	"workflow.apply_template",
	"workflow.delete",
	"workflow.rename",
	"workflow.set_context",
	"workflow.start",
	"workflow.pause",
	"workflow.resume",
	"workflow.restart",
	"workflow.set_selection",
	"workflow.set_status",
	"step.add",
	"step.edit",
	"step.remove",
	"step.move",
	"step.run",
	"step.abort",
	"step.continue",
	"step.set_status",
	"tcp-tool.upsert",
	"tcp-tool.delete",
	"resource-set.upsert",
	"resource-set.delete",
] as const;

export type SyncCommandType = (typeof SYNC_COMMAND_TYPES)[number];

export interface CommandApplyResult {
	localId?: string;
	/** True when this command_id was already applied — handler was not re-run. */
	noop: boolean;
}

type CommandHandler = (
	command: SyncCommand,
	hubConfig: HubConfig,
	log: SyncTickOptions["log"],
) => Promise<{ localId?: string }> | { localId?: string };

interface SyncOutboundEvent {
	id: string;
	type: string;
	remote_id?: string;
	payload: Record<string, unknown>;
	created_at: string;
}

function logMessage(
	log: SyncTickOptions["log"],
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	log?.(message, level);
}

function syncUrl(base: string, path: string): string {
	return `${base.replace(/\/$/, "")}${path}`;
}

async function syncFetch(
	url: string,
	init: RequestInit,
	fetchImpl: FetchLike,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function authHeaders(token: string, method: string, path: string, body = ""): Record<string, string> {
	const signed = remoteAuth("sync:write").kind === "device" ? deviceHeaders(method, path, body) : null;
	return {
		...(signed ?? { authorization: `Bearer ${token}` }),
		"content-type": "application/json",
	};
}

function queueEvent(event: Omit<SyncOutboundEvent, "id" | "created_at">): void {
	pendingEvents.push({
		id: crypto.randomUUID(),
		created_at: new Date().toISOString(),
		...event,
	});
}

function parseRunner(agent: unknown): PublishableRunner | undefined {
	if (typeof agent !== "string" || !agent.trim()) return undefined;
	const value = agent.trim();
	if ((PUBLISHABLE_RUNNERS as readonly string[]).includes(value)) return value as PublishableRunner;
	throw new WorkflowError(`unknown agent '${value}'`);
}

function parseSandbox(sandbox: unknown): PublishableSandbox | undefined {
	if (typeof sandbox !== "string" || !sandbox.trim()) return undefined;
	const value = sandbox.trim();
	if (value === "host" || value === "docker") return value;
	throw new WorkflowError(`unknown sandbox '${value}'`);
}

/** remote_id → local workflow id (null when not mapped yet). */
export function resolveLocalWorkflowId(remoteId: string): string | null {
	return getWorkflowByRemoteId(remoteId)?.id ?? null;
}

function resolveLocalWorkflow(remoteId: string): Workflow {
	const workflow = getWorkflowByRemoteId(remoteId);
	if (!workflow) throw new WorkflowError(`remote workflow '${remoteId}' is not mapped locally`);
	return workflow;
}

function resolveStepId(remoteId: string, stepKey: string): string {
	const map = getSyncStepMap(remoteId);
	const stepId = map[stepKey];
	if (!stepId) throw new WorkflowError(`unknown step_key '${stepKey}' for remote '${remoteId}'`);
	return stepId;
}

type SyncLogger = (message: string) => void;

/** Pick start/resume/restart — Start only runs pending steps; done steps need a restart. */
async function runSelectedSteps(
	workflow: Workflow,
	stepIds: string[],
	hubConfig: HubConfig,
	log: SyncLogger,
): Promise<Workflow> {
	const selected = listSteps(workflow.id).filter((s) => stepIds.includes(s.id));
	const hasNonPending = selected.some((s) => s.status !== "pending");
	if (workflow.status === "paused") {
		if (hasNonPending) return restartWorkflow(workflow.id, hubConfig, log, stepIds);
		return resumeWorkflow(workflow.id, hubConfig, log, stepIds);
	}
	if (workflow.status === "completed" || workflow.status === "failed" || hasNonPending) {
		return restartWorkflow(workflow.id, hubConfig, log, stepIds);
	}
	return startWorkflow(workflow.id, hubConfig, log, stepIds);
}

/** Map operator step_keys to local step ids (required for run commands). */
function resolveRunStepIds(remoteId: string, payload: Record<string, unknown>): string[] {
	if (!Array.isArray(payload.step_keys)) {
		throw new WorkflowError("step_keys required — select steps on the server dashboard");
	}
	const keys = payload.step_keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0);
	if (!keys.length) throw new WorkflowError("step_keys must include at least one step");
	return keys.map((k) => resolveStepId(remoteId, k));
}

function moveStepToIndex(workflowId: string, stepId: string, targetIndex: number): void {
	for (;;) {
		const step = listSteps(workflowId).find((s) => s.id === stepId);
		if (!step) throw new WorkflowError("step disappeared");
		if (step.orderIndex === targetIndex) return;
		const direction: StepMoveDirection = step.orderIndex > targetIndex ? "up" : "down";
		moveStep(workflowId, stepId, direction);
	}
}

/** Runner inventory the server uses to populate the remote-workflow agent picker. */
function syncRunnerCapabilities(): { runners: ReturnType<typeof availableRunners> } {
	return { runners: availableRunners() };
}

/** Capabilities advertised on register and heartbeat (sync/v2 resource commands). */
export function syncClientCapabilities() {
	return {
		commands: [...SYNC_COMMAND_TYPES],
		...syncRunnerCapabilities(),
		resources: { version: 2 as const, tcp_tools: true, resource_sets: true },
	};
}

function parseResourceEnvelope(payload: Record<string, unknown>): {
	id: string;
	name: string;
	data: Record<string, unknown>;
} {
	const raw = payload.resource;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new WorkflowError("resource is required");
	}
	const resource = raw as Record<string, unknown>;
	const id = typeof resource.id === "string" ? resource.id.trim() : "";
	const name = typeof resource.name === "string" ? resource.name.trim() : "";
	if (!id || !name) throw new WorkflowError("resource id and name are required");
	const data =
		resource.data && typeof resource.data === "object" && !Array.isArray(resource.data)
			? (resource.data as Record<string, unknown>)
			: {};
	return { id, name, data };
}

function parseResourceId(payload: Record<string, unknown>): string {
	const id = typeof payload.resource_id === "string" ? payload.resource_id.trim() : "";
	if (!id) throw new WorkflowError("resource_id is required");
	return id;
}

async function ensureRegistered(
	config: SyncConfig,
	fetchImpl: FetchLike,
	log?: SyncTickOptions["log"],
): Promise<string> {
	const device = remoteAuth("sync:write").kind === "device";
	if (!device && config.token.length > 0) return config.token;
	const instanceId = getOrCreateInstanceId(process.env.TARGET_INSTANCE_ID ?? null);
	const body = JSON.stringify({
		name: osHostname(),
		instance_id: instanceId,
		version: TARGET_VERSION,
		capabilities: syncClientCapabilities(),
	});
	let res: Response;
	try {
		res = await syncFetch(
			syncUrl(config.url, "/api/sync/register"),
			{
				method: "POST",
				headers: device ? authHeaders("", "POST", "/api/sync/register", body) : { "content-type": "application/json" },
				body,
			},
			fetchImpl,
		);
	} catch {
		if (device) setDeviceLinkRemoteState("temporarily_disconnected", "remote_transport_unavailable");
		logMessage(log, "remote sync registration failed at /api/sync/register (transport)", "warning");
		throw new Error("sync register transport failed");
	}
	const errorBody = !res.ok ? await res.json().catch(() => null) : null;
	const errorCode = errorBody && typeof errorBody === "object" ? (errorBody as { error?: unknown }).error : undefined;
	handleDeviceAuthResponse(res.status, errorCode);
	if (!res.ok) {
		if (device && res.status >= 500) setDeviceLinkRemoteState("temporarily_disconnected", "remote_transport_unavailable");
		logMessage(log, `remote sync registration failed at /api/sync/register (${res.status})`, "warning");
		throw new Error(`sync register failed (${res.status})`);
	}
	const response = (await res.json()) as { client_id?: string; client_token?: string; owner?: unknown };
	if (!response.client_id) throw new Error("sync register returned no client id");
	const link = getDeviceLinkStatus();
	recordOwnerSnapshot(response.owner, link.deviceId ?? "", link.origin ?? config.url);
	if (device) {
		markDeviceRemoteRecovered();
		logMessage(log, `remote sync registered as device client ${response.client_id}`);
		return "";
	}
	if (!response.client_token) throw new Error("sync register returned no token");
	saveSyncCredentials(response.client_id, response.client_token);
	logMessage(log, `remote sync registered as client ${response.client_id}`);
	return response.client_token;
}

function osHostname(): string {
	try {
		return os.hostname();
	} catch {
		return "target-client";
	}
}

function clientAvailability(): "idle" | "busy" {
	const busy = listWorkflows().some((w) => w.status === "running" || w.status === "waiting");
	return busy ? "busy" : "idle";
}

async function sendHeartbeat(
	config: SyncConfig,
	token: string,
	fetchImpl: FetchLike,
): Promise<void> {
	const activeRemoteIds = listWorkflows()
		.filter((w) => w.origin === "remote" && w.remoteId && (w.status === "running" || w.status === "waiting"))
		.map((w) => w.remoteId as string);
	const body = JSON.stringify({
		status: clientAvailability(),
		version: TARGET_VERSION,
		instance_id: getOrCreateInstanceId(process.env.TARGET_INSTANCE_ID ?? null),
		active_remote_ids: activeRemoteIds,
		capabilities: syncClientCapabilities(),
	});
	const res = await syncFetch(
		syncUrl(config.url, "/api/sync/heartbeat"),
		{
			method: "POST",
			headers: authHeaders(token, "POST", "/api/sync/heartbeat", body),
			body,
		},
		fetchImpl,
	);
	handleDeviceAuthResponse(res.status);
	if (!res.ok) {
		throw new Error(`sync heartbeat failed (${res.status})`);
	}
	let payload: unknown = null;
	try {
		payload = await res.json();
	} catch {
		return;
	}
	try {
		const owner =
			payload && typeof payload === "object" && "owner" in payload
				? (payload as { owner?: unknown }).owner
				: undefined;
		const link = getDeviceLinkStatus();
		recordOwnerSnapshot(owner, link.deviceId ?? "", link.origin ?? config.url);
	} catch {
		// A missing or malformed owner field must not fail the tick.
	}
}

async function pollCommands(
	config: SyncConfig,
	token: string,
	fetchImpl: FetchLike,
): Promise<SyncCommand[]> {
	const res = await syncFetch(
		syncUrl(config.url, "/api/sync/commands"),
		{ headers: authHeaders(token, "GET", "/api/sync/commands") },
		fetchImpl,
	);
	handleDeviceAuthResponse(res.status);
	if (!res.ok) {
		throw new Error(`sync poll failed (${res.status})`);
	}
	const body = (await res.json()) as { commands?: SyncCommand[] };
	return body.commands ?? [];
}

async function ackCommand(
	config: SyncConfig,
	token: string,
	command: SyncCommand,
	result: { status: "applied" | "failed"; localId?: string; error?: string },
	fetchImpl: FetchLike,
): Promise<void> {
	const body: Record<string, unknown> = { status: result.status };
	if (result.localId) body.local_id = result.localId;
	if (command.remote_id) body.remote_id = command.remote_id;
	if (result.error) body.error = { message: result.error };
	const encoded = JSON.stringify(body);
	const path = `/api/sync/commands/${command.id}/ack`;
	const res = await syncFetch(
		syncUrl(config.url, `/api/sync/commands/${command.id}/ack`),
		{ method: "POST", headers: authHeaders(token, "POST", path, encoded), body: encoded },
		fetchImpl,
	);
	handleDeviceAuthResponse(res.status);
	if (!res.ok) {
		throw new Error(`sync ack failed (${res.status})`);
	}
	queueEvent({
		type: "command.ack",
		remote_id: command.remote_id,
		payload: {
			command_id: command.id,
			status: result.status === "applied" ? "acked" : "failed",
			...(result.error ? { error: { message: result.error } } : {}),
		},
	});
}

async function pushEvents(
	config: SyncConfig,
	token: string,
	fetchImpl: FetchLike,
): Promise<void> {
	collectLocalStateEvents();
	if (pendingEvents.length === 0) return;
	const batch = pendingEvents.splice(0, 100);
	const body = JSON.stringify({
		batch_id: crypto.randomUUID(),
		events: batch.map((e) => ({
			id: e.id,
			type: e.type,
			remote_id: e.remote_id,
			payload: e.payload,
			created_at: e.created_at,
		})),
	});
	const res = await syncFetch(
		syncUrl(config.url, "/api/sync/events"),
		{
			method: "POST",
			headers: authHeaders(token, "POST", "/api/sync/events", body),
			body,
		},
		fetchImpl,
	);
	handleDeviceAuthResponse(res.status);
	if (!res.ok) {
		pendingEvents.unshift(...batch);
		throw new Error(`sync events push failed (${res.status})`);
	}
}

function collectLocalStateEvents(): void {
	for (const workflow of listWorkflows()) {
		if (workflow.origin !== "remote" || !workflow.remoteId) continue;
		const prev = workflowStatusCache.get(workflow.id);
		if (prev !== workflow.status) {
			if (prev !== undefined) {
				queueEvent({
					type: "workflow.status_changed",
					remote_id: workflow.remoteId,
					payload: { from: prev, to: workflow.status },
				});
			}
			workflowStatusCache.set(workflow.id, workflow.status);
		}
		const stepMap = getSyncStepMap(workflow.remoteId);
		for (const [stepKey, stepId] of Object.entries(stepMap)) {
			const step = listSteps(workflow.id).find((s) => s.id === stepId);
			if (!step || step.kind !== "task") continue;
			const cacheKey = `${workflow.remoteId}:${stepKey}`;
			const prevStep = stepStatusCache.get(cacheKey);
			if (prevStep === step.status) continue;
			if (prevStep !== undefined) {
				queueEvent({
					type: "step.status_changed",
					remote_id: workflow.remoteId,
					payload: { step_key: stepKey, from: prevStep, to: step.status },
				});
			}
			stepStatusCache.set(cacheKey, step.status);
		}
	}
}

function createRemoteWorkflow(
	remoteId: string,
	payload: Record<string, unknown>,
): Workflow {
	const existing = getWorkflowByRemoteId(remoteId);
	if (existing) return existing;

	const name = typeof payload.name === "string" ? payload.name : "";
	if (!name.trim()) throw new WorkflowError("name is required");
	const workdir = typeof payload.workdir === "string" ? payload.workdir : undefined;
	const runner = parseRunner(payload.agent);
	const sandbox = parseSandbox(payload.sandbox);
	const conversationContext =
		typeof payload.conversation_context === "string" ? payload.conversation_context : undefined;

	const workflow = createWorkflow(name, {
		workdir,
		runner,
		sandbox,
		conversationContext: conversationContext ?? null,
	});
	const now = new Date().toISOString();
	const updated = setWorkflowRemoteMeta(workflow.id, {
		origin: "remote",
		remoteId,
		remoteSyncedAt: now,
	});
	if (!updated) throw new WorkflowError("workflow disappeared after create");
	const reportedWorkdir = operatorWorkdir(workdir ?? null, updated.agentName);
	queueEvent({
		type: "workflow.created",
		remote_id: remoteId,
		payload: {
			name: updated.name,
			origin: "remote",
			...(reportedWorkdir ? { workdir: reportedWorkdir } : {}),
		},
	});
	workflowStatusCache.set(updated.id, updated.status);
	return updated;
}

const COMMAND_HANDLERS: Record<SyncCommandType, CommandHandler> = {
	"workflow.create": (command) => {
		const workflow = createRemoteWorkflow(command.remote_id, command.payload);
		return { localId: workflow.id };
	},
	"workflow.create_with_steps": (command) => {
		const remoteId = command.remote_id;
		const workflow = createRemoteWorkflow(remoteId, command.payload);
		const steps = Array.isArray(command.payload.steps) ? command.payload.steps : [];
		for (const raw of steps) {
			if (!raw || typeof raw !== "object") continue;
			const step = raw as Record<string, unknown>;
			const stepKey = typeof step.step_key === "string" ? step.step_key : "";
			const description = typeof step.description === "string" ? step.description : "";
			if (!stepKey || !description.trim()) continue;
			const added = addStep(workflow.id, description, {
				acceptanceCriteria:
					typeof step.acceptance_criteria === "string" ? step.acceptance_criteria : null,
				manualReview: step.manual_review === true,
				useSubagent: step.use_subagent !== false,
				maxRetries: typeof step.max_retries === "number" ? step.max_retries : 0,
				retryIntervalSeconds:
					typeof step.retry_interval_seconds === "number" ? step.retry_interval_seconds : 0,
			});
			setSyncStepKey(remoteId, stepKey, added.id);
			if (typeof step.order_index === "number") {
				moveStepToIndex(workflow.id, added.id, step.order_index);
			}
		}
		return { localId: workflow.id };
	},
	"workflow.apply_template": (command) => {
		const remoteId = command.remote_id;
		const payload = command.payload;
		const templateId = typeof payload.template_id === "string" ? payload.template_id : "";
		const template = getTemplate(templateId);
		if (!template) throw new WorkflowError("unknown template");
		const name =
			(typeof payload.name === "string" && payload.name.trim()) || template.name || "From template";
		const workflow = createRemoteWorkflow(remoteId, { ...payload, name });
		for (const step of template.steps) {
			addStep(workflow.id, step.description, {
				acceptanceCriteria: step.acceptanceCriteria,
				manualReview: step.manualReview,
				useSubagent: step.useSubagent,
				maxRetries: step.maxRetries,
				retryIntervalSeconds: step.retryIntervalSeconds,
				templateNotes: step.notes,
			});
		}
		if (template.tcpSelections.length > 0) applyTemplateTcpsToWorkflow(workflow.id, template.tcpSelections);
		if (template.resourceSelections.length > 0) {
			applyTemplateResourcesToWorkflow(workflow.id, template.resourceSelections);
		}
		return { localId: workflow.id };
	},
	"workflow.delete": (command) => {
		const remoteId = command.remote_id;
		const workflow = getWorkflowByRemoteId(remoteId);
		if (!workflow) {
			// Already removed on this client (or never synced) — treat as success so
			// the server drops its remote-workflow row instead of reverting to draft.
			deleteSyncStepMap(remoteId);
			return { localId: undefined };
		}
		const localId = workflow.id;
		removeWorkflow(localId);
		deleteSyncStepMap(remoteId);
		workflowStatusCache.delete(localId);
		return { localId };
	},
	"workflow.rename": (command) => {
		const workflow = resolveLocalWorkflow(command.remote_id);
		const name = typeof command.payload.name === "string" ? command.payload.name : "";
		return { localId: renameWorkflow(workflow.id, name).id };
	},
	"workflow.set_context": (command) => {
		const workflow = resolveLocalWorkflow(command.remote_id);
		const context =
			typeof command.payload.conversation_context === "string"
				? command.payload.conversation_context
				: null;
		return { localId: setConversationContext(workflow.id, context).id };
	},
	"workflow.start": async (command, hubConfig, log) => {
		const workflow = resolveLocalWorkflow(command.remote_id);
		const stepIds = resolveRunStepIds(command.remote_id, command.payload);
		const updated = await runSelectedSteps(workflow, stepIds, hubConfig, (m) => logMessage(log, m));
		workflowStatusCache.set(updated.id, updated.status);
		return { localId: updated.id };
	},
	"workflow.pause": (command) => {
		const workflow = resolveLocalWorkflow(command.remote_id);
		const updated = pauseWorkflow(workflow.id);
		workflowStatusCache.set(updated.id, updated.status);
		return { localId: updated.id };
	},
	"workflow.resume": async (command, hubConfig, log) => {
		const workflow = resolveLocalWorkflow(command.remote_id);
		const stepIds = resolveRunStepIds(command.remote_id, command.payload);
		const updated = await resumeWorkflow(workflow.id, hubConfig, (m) => logMessage(log, m), stepIds);
		workflowStatusCache.set(updated.id, updated.status);
		return { localId: updated.id };
	},
	"workflow.restart": async (command, hubConfig, log) => {
		const workflow = resolveLocalWorkflow(command.remote_id);
		const stepIds = resolveRunStepIds(command.remote_id, command.payload);
		const updated = await restartWorkflow(workflow.id, hubConfig, (m) => logMessage(log, m), stepIds);
		workflowStatusCache.set(updated.id, updated.status);
		return { localId: updated.id };
	},
	"workflow.set_selection": (command) => {
		const workflow = resolveLocalWorkflow(command.remote_id);
		const payload = command.payload;
		if (payload.tcp_selections != null) {
			setWorkflowTcpSelections(workflow.id, normalizeTcpSelections(payload.tcp_selections));
		}
		if (payload.resource_selections != null) {
			setWorkflowResourceSelections(workflow.id, normalizeResourceSelections(payload.resource_selections));
		}
		return { localId: workflow.id };
	},
	"workflow.set_status": (command, _hubConfig, log) => {
		const workflow = resolveLocalWorkflow(command.remote_id);
		const status = typeof command.payload.status === "string" ? command.payload.status : "";
		const updated = forceWorkflowStatus(
			workflow.id,
			status as OverridableWorkflowStatus,
			(m) => logMessage(log, m),
		);
		workflowStatusCache.set(updated.id, updated.status);
		return { localId: updated.id };
	},
	"step.add": (command) => {
		const remoteId = command.remote_id;
		const payload = command.payload;
		const workflow = resolveLocalWorkflow(remoteId);
		const stepKey = typeof payload.step_key === "string" ? payload.step_key : "";
		const description = typeof payload.description === "string" ? payload.description : "";
		const added = addStep(workflow.id, description, {
			acceptanceCriteria:
				typeof payload.acceptance_criteria === "string" ? payload.acceptance_criteria : null,
			manualReview: payload.manual_review === true,
			useSubagent: payload.use_subagent !== false,
			maxRetries: typeof payload.max_retries === "number" ? payload.max_retries : 0,
			retryIntervalSeconds:
				typeof payload.retry_interval_seconds === "number" ? payload.retry_interval_seconds : 0,
			templateNotes: Array.isArray(payload.notes) ? normalizeTemplateStepNotes(payload.notes) : undefined,
		});
		setSyncStepKey(remoteId, stepKey, added.id);
		if (typeof payload.order_index === "number") {
			moveStepToIndex(workflow.id, added.id, payload.order_index);
		}
		return { localId: workflow.id };
	},
	"step.edit": (command) => {
		const remoteId = command.remote_id;
		const payload = command.payload;
		const workflow = resolveLocalWorkflow(remoteId);
		const stepId = resolveStepId(remoteId, String(payload.step_key ?? ""));
		const existing = getStep(stepId);
		if (!existing) throw new WorkflowError("unknown step");
		const description =
			typeof payload.description === "string" ? payload.description : existing.description;
		editStep(workflow.id, stepId, description, {
			acceptanceCriteria:
				typeof payload.acceptance_criteria === "string" ? payload.acceptance_criteria : undefined,
			manualReview: typeof payload.manual_review === "boolean" ? payload.manual_review : undefined,
			useSubagent: typeof payload.use_subagent === "boolean" ? payload.use_subagent : undefined,
			maxRetries: typeof payload.max_retries === "number" ? payload.max_retries : undefined,
			retryIntervalSeconds:
				typeof payload.retry_interval_seconds === "number" ? payload.retry_interval_seconds : undefined,
		});
		return { localId: workflow.id };
	},
	"step.remove": (command) => {
		const remoteId = command.remote_id;
		const payload = command.payload;
		const workflow = resolveLocalWorkflow(remoteId);
		const stepId = resolveStepId(remoteId, String(payload.step_key ?? ""));
		removeStep(workflow.id, stepId);
		const map = getSyncStepMap(remoteId);
		delete map[String(payload.step_key ?? "")];
		saveSyncStepMap(remoteId, map);
		return { localId: workflow.id };
	},
	"step.move": (command) => {
		const remoteId = command.remote_id;
		const payload = command.payload;
		const workflow = resolveLocalWorkflow(remoteId);
		const stepId = resolveStepId(remoteId, String(payload.step_key ?? ""));
		if (typeof payload.to_index !== "number") throw new WorkflowError("to_index is required");
		moveStepToIndex(workflow.id, stepId, payload.to_index);
		return { localId: workflow.id };
	},
	"step.run": async (command, hubConfig, log) => {
		const remoteId = command.remote_id;
		const workflow = resolveLocalWorkflow(remoteId);
		const stepId = resolveStepId(remoteId, String(command.payload.step_key ?? ""));
		await runStep(workflow.id, stepId, hubConfig, (m) => logMessage(log, m));
		return { localId: workflow.id };
	},
	"step.abort": async (command, _hubConfig, log) => {
		const remoteId = command.remote_id;
		const workflow = resolveLocalWorkflow(remoteId);
		const stepId = resolveStepId(remoteId, String(command.payload.step_key ?? ""));
		const updated = await abortStep(workflow.id, stepId, (m) => logMessage(log, m));
		return { localId: updated.id };
	},
	"step.continue": async (command, hubConfig, log) => {
		const remoteId = command.remote_id;
		const workflow = resolveLocalWorkflow(remoteId);
		const stepId = resolveStepId(remoteId, String(command.payload.step_key ?? ""));
		await continueStep(workflow.id, stepId, hubConfig, (m) => logMessage(log, m));
		return { localId: workflow.id };
	},
	"step.set_status": (command, _hubConfig, log) => {
		const remoteId = command.remote_id;
		const workflow = resolveLocalWorkflow(remoteId);
		const stepId = resolveStepId(remoteId, String(command.payload.step_key ?? ""));
		const status = typeof command.payload.status === "string" ? command.payload.status : "";
		forceStepStatus(workflow.id, stepId, status as OverridableStepStatus, (m) => logMessage(log, m));
		return { localId: workflow.id };
	},
	"tcp-tool.upsert": (command) => {
		const resource = parseResourceEnvelope(command.payload);
		const tcp = upsertServerTcp(resource.id, {
			name: resource.name,
			tags: resource.data.tags,
			tools: resource.data.tools,
		});
		queueEvent({
			type: "tcp-tool.upserted",
			payload: { resource: { id: tcp.id, name: tcp.name, data: { tags: tcp.tags, tools: tcp.tools } } },
		});
		return {};
	},
	"tcp-tool.delete": (command) => {
		const resourceId = parseResourceId(command.payload);
		deleteTcp(resourceId, { allowServerManaged: true });
		queueEvent({
			type: "tcp-tool.deleted",
			payload: { resource_id: resourceId },
		});
		return {};
	},
	"resource-set.upsert": (command) => {
		const resource = parseResourceEnvelope(command.payload);
		const set = upsertServerResourceSet(resource.id, {
			name: resource.name,
			tags: resource.data.tags,
			resources: resource.data.resources,
		});
		queueEvent({
			type: "resource-set.upserted",
			payload: {
				resource: { id: set.id, name: set.name, data: { tags: set.tags, resources: set.resources } },
			},
		});
		return {};
	},
	"resource-set.delete": (command) => {
		const resourceId = parseResourceId(command.payload);
		deleteResourceSet(resourceId, { allowServerManaged: true });
		queueEvent({
			type: "resource-set.deleted",
			payload: { resource_id: resourceId },
		});
		return {};
	},
};

async function dispatchCommand(
	command: SyncCommand,
	hubConfig: HubConfig,
	log: SyncTickOptions["log"],
): Promise<{ localId?: string }> {
	const handler = COMMAND_HANDLERS[command.type as SyncCommandType];
	if (!handler) throw new WorkflowError(`unsupported command type '${command.type}'`);
	return handler(command, hubConfig, log);
}

/**
 * Apply one sync command with idempotency: a duplicate command_id is a no-op
 * (the handler is not re-run; the prior local_id is returned).
 */
export async function executeSyncCommand(
	command: SyncCommand,
	hubConfig: HubConfig,
	log?: SyncTickOptions["log"],
): Promise<CommandApplyResult> {
	const prior = getAppliedSyncCommand(command.id);
	if (prior) {
		const localId = prior.localId ?? resolveLocalWorkflowId(command.remote_id) ?? undefined;
		return { localId, noop: true };
	}
	const result = await dispatchCommand(command, hubConfig, log);
	markSyncCommandApplied(command.id, {
		localId: result.localId,
		remoteId: command.remote_id,
		type: command.type,
	});
	return { ...result, noop: false };
}

/**
 * One remote-sync cycle: register, heartbeat, poll/apply/ack commands, push events.
 */
export async function runSyncTick(options: SyncTickOptions = {}): Promise<void> {
	const config = options.config ?? loadEffectiveSyncConfig();
	if (!config.enabled) return;
	if (remoteAuth("sync:write").kind === "blocked") return;
	const fetchImpl = options.fetchImpl ?? fetch;
	const log = options.log;
	const hubConfig = options.hubConfig;
	if (!hubConfig) throw new Error("runSyncTick requires hubConfig");

	let token = config.token;
	if (remoteAuth("sync:write").kind === "device") token = await ensureRegistered(config, fetchImpl, log);
	else if (!token) token = await ensureRegistered(config, fetchImpl, log);

	await sendHeartbeat(config, token, fetchImpl);

	const commands = await pollCommands(config, token, fetchImpl);
	for (const command of commands) {
		try {
			const result = await executeSyncCommand(command, hubConfig, log);
			await ackCommand(config, token, command, { status: "applied", localId: result.localId }, fetchImpl);
			if (!result.noop) {
				logMessage(log, `sync applied ${command.type} for remote ${command.remote_id}`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logMessage(log, `sync command ${command.id} failed: ${message}`, "warning");
			await ackCommand(config, token, command, { status: "failed", error: message }, fetchImpl);
		}
	}

	await pushEvents(config, token, fetchImpl);
}

/** Seed status cache for workflows already on disk (daemon startup). */
export function initSyncStateCache(): void {
	for (const workflow of listWorkflows()) {
		workflowStatusCache.set(workflow.id, workflow.status);
		if (workflow.origin !== "remote" || !workflow.remoteId) continue;
		const stepMap = getSyncStepMap(workflow.remoteId);
		for (const [stepKey, stepId] of Object.entries(stepMap)) {
			const step = listSteps(workflow.id).find((s) => s.id === stepId);
			if (!step) continue;
			stepStatusCache.set(`${workflow.remoteId}:${stepKey}`, step.status);
		}
	}
}

/** Reset in-memory sync state and the applied-command ledger (tests). */
export function resetSyncExecutorState(): void {
	workflowStatusCache.clear();
	stepStatusCache.clear();
	pendingEvents.length = 0;
	clearAppliedSyncCommands();
}
