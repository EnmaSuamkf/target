/**
 * Failure recovery — the contract with target-server (workflow 2/2), and every
 * place a step or a workflow travels to besides the engine:
 *
 *  - templates (create from steps, edit, older rows), template bundles (export,
 *    import, older bundles), applying a template (local routes and the remote
 *    `workflow.apply_template`), and clone — `recoverOnFailure`, `maxRecoveries`
 *    and the workflow's `recoveryModel` survive every one of them;
 *  - the report stream: `workflow.plan` per step `recover_on_failure`,
 *    `max_recoveries`, `recovery_count` and the plan's `recovery_model`,
 *    `workflow.created` / `workflow.updated` with `recovery_model`,
 *    `workflow.status_changed` to `recovering`, `step.recovery` with `action`,
 *    `reason` and `changes`, and fresh plan snapshots when the fields change;
 *  - remote sync commands `step.add`, `step.edit` (omitted = kept),
 *    `workflow.create` / `workflow.create_with_steps` (with `recovery_model`).
 *
 * (The instance snapshot sync.ts announces — `schedule.instance_created` — is
 * covered in sync.test.ts next to the other announcement tests.)
 *
 * Hermetic: throwaway TARGET_HOME/AWB_HOME, a fake awb broker on a random port
 * that records POSTs and never calls back, the hub's real HTTP server on another
 * random port. Nothing reaches the live hub, broker or report server.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-recovery-contract-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");
for (const suffix of ["XOXC", "XOXD"]) {
	for (const prefix of ["TARGET_SLACK_", "SLACK_MCP_", "SLACK_"]) delete process.env[`${prefix}${suffix}_TOKEN`];
}

// --- the fake awb broker ---------------------------------------------------------
interface BrokerRequest {
	path: string;
	headers: http.IncomingHttpHeaders;
	body: { jobId?: string; input?: string };
}
const brokerRequests: BrokerRequest[] = [];
const broker = http.createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		let body = {};
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		} catch {
			body = {};
		}
		brokerRequests.push({ path: req.url ?? "", headers: req.headers, body });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
const brokerPort = (broker.address() as { port: number }).port;
fs.writeFileSync(path.join(tmpHome, "hooks.json"), JSON.stringify({ host: "127.0.0.1", port: brokerPort, hooks: {} }));

const db = await import("./db.ts");
const { getStep, getTemplate, getWorkflow, getWorkflowByRemoteId, listSteps, open, saveReportSettings, getRunningRecovery } = db;
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { buildTemplateBundle, importTemplateBundle } = await import("./template-bundle.ts");
const { executeSyncCommand, resetSyncExecutorState, pendingSyncEvents } = await import("./sync.ts");
type SyncCommand = import("./sync.ts").SyncCommand;
const { addStep, createWorkflow, onStepResult, startWorkflow } = await import("./workflow.ts");

const cfg = loadConfig();
const log = (_message: string) => {};
const server = createServer(cfg, log);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const hubPort = (server.address() as { port: number }).port;
cfg.port = hubPort;
const hub = `http://127.0.0.1:${hubPort}`;

// Reporting on (to an address nothing listens on): events land in report_events,
// which is what this suite reads. Delivery itself is reporter.ts's business.
saveReportSettings({ enabled: true, url: "http://127.0.0.1:9/ingest", token: "test", intervalMs: 60_000, includeConversations: "off" });

const workdirs: string[] = [];
test.after(() => {
	server.close();
	broker.close();
	for (const dir of workdirs) fs.rmSync(dir, { recursive: true, force: true });
});

function freshWorkdir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "target-recovery-contract-wd-"));
	workdirs.push(dir);
	return dir;
}

function admin(): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

async function api(method: string, url: string, body?: unknown, headers: Record<string, string> = admin()) {
	const res = await fetch(`${hub}${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
	const text = await res.text();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(text);
	} catch {
		json = { raw: text };
	}
	return { status: res.status, json };
}

/** Report events of a workflow, oldest first; the payload is the event's `data`. */
function events(workflowId: string, kind?: string): Record<string, unknown>[] {
	const rows = open()
		.prepare("SELECT kind, payload FROM report_events WHERE workflow_id = ? ORDER BY created_at, rowid")
		.all(workflowId) as { kind: string; payload: string }[];
	return rows.filter((r) => !kind || r.kind === kind).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function lastPlan(workflowId: string): Record<string, unknown> {
	const plans = events(workflowId, "workflow.plan");
	assert.ok(plans.length > 0, "a workflow.plan snapshot was reported");
	return plans[plans.length - 1]!;
}

function planStepOf(plan: Record<string, unknown>, stepId: string): Record<string, unknown> {
	const step = (plan.steps as Record<string, unknown>[]).find((s) => s.step_id === stepId);
	assert.ok(step, `step ${stepId} is in the plan`);
	return step;
}

function readHooks(): Record<string, Record<string, unknown>> {
	return (JSON.parse(fs.readFileSync(path.join(tmpHome, "hooks.json"), "utf8")) as { hooks: Record<string, Record<string, unknown>> }).hooks;
}

function taskSteps(workflowId: string) {
	return listSteps(workflowId).filter((s) => s.kind === "task");
}

function bearer(token: string): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

function tokenFromPrompt(prompt: string): string {
	const match = /Token: ([0-9a-f]{64})/.exec(prompt);
	assert.ok(match, "the prompt carries the recovery token");
	return match[1]!;
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

let remoteSeq = 0;
function command(type: string, payload: Record<string, unknown>, remoteId: string): SyncCommand {
	remoteSeq += 1;
	return { id: `cmd_contract_${remoteSeq}`, type, remote_id: remoteId, sequence: remoteSeq, payload, status: "delivered" };
}
function nextRemoteId(): string {
	remoteSeq += 1;
	return `rwf_recovery_contract_${remoteSeq}`;
}

const RECOVERY_STEPS = [
	{ description: "Recovers twice", acceptanceCriteria: "it is done", recoverOnFailure: true, maxRecoveries: 2 },
	{ description: "Never recovers", acceptanceCriteria: "it is done too" },
];

async function recoveryTemplate(name: string): Promise<{ id: string; steps: Record<string, unknown>[] }> {
	const created = await api("POST", "/api/templates", { name, tags: ["qa"], steps: RECOVERY_STEPS });
	assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created.json));
	return created.json.template as { id: string; steps: Record<string, unknown>[] };
}

// ---------------------------------------------------------------------------------
// Templates and bundles

test("templates: created from steps they keep recoverOnFailure / maxRecoveries; absent reads off / 1; an edit keeps them; an older row reads the defaults", async () => {
	const template = await recoveryTemplate("recovery template");
	assert.equal(template.steps[0]!.recoverOnFailure, true);
	assert.equal(template.steps[0]!.maxRecoveries, 2);
	assert.equal(template.steps[1]!.recoverOnFailure, false, "absent = off");
	assert.equal(template.steps[1]!.maxRecoveries, 1, "absent = the step default budget");

	// Editing: the steps round-trip through the editor (the UI sends them back whole).
	const edited = await api("PATCH", `/api/templates/${template.id}`, {
		name: "recovery template (edited)",
		steps: [{ ...template.steps[0], maxRecoveries: 3 }, template.steps[1]],
	});
	assert.equal(edited.status, 200, JSON.stringify(edited.json));
	const stored = getTemplate(template.id)!;
	assert.equal(stored.steps[0]!.recoverOnFailure, true);
	assert.equal(stored.steps[0]!.maxRecoveries, 3);
	assert.equal(stored.steps[1]!.recoverOnFailure, false);

	// Bad values coming from foreign data are coerced, never stored as garbage.
	const coerced = await api("POST", "/api/templates", {
		name: "coerced",
		tags: [],
		steps: [{ description: "x", recoverOnFailure: "yes", maxRecoveries: -4 }],
	});
	const coercedStep = (coerced.json.template as { steps: Record<string, unknown>[] }).steps[0]!;
	assert.equal(coercedStep.recoverOnFailure, false, "only a real true turns it on");
	assert.equal(coercedStep.maxRecoveries, 0, "clamped to ≥ 0");

	// A template row from before Failure recovery: its stored JSON lacks the keys.
	open()
		.prepare("UPDATE templates SET steps = ? WHERE id = ?")
		.run(JSON.stringify([{ description: "old step", acceptanceCriteria: null, manualReview: false, useSubagent: true, maxRetries: 0, retryIntervalSeconds: 0 }]), template.id);
	const legacy = getTemplate(template.id)!;
	assert.equal(legacy.steps[0]!.recoverOnFailure, false);
	assert.equal(legacy.steps[0]!.maxRecoveries, 1);
});

test("template bundles: export carries recoverOnFailure / maxRecoveries, import keeps them, an older bundle reads the defaults", async () => {
	const template = await recoveryTemplate("bundle source");
	const bundle = buildTemplateBundle([getTemplate(template.id)!]);
	const exported = bundle.templates[0]!.steps as unknown as Record<string, unknown>[];
	assert.equal(exported[0]!.recoverOnFailure, true);
	assert.equal(exported[0]!.maxRecoveries, 2);
	assert.equal(exported[1]!.recoverOnFailure, false);
	assert.equal(exported[1]!.maxRecoveries, 1);

	// Through JSON, as a downloaded file would be.
	const imported = importTemplateBundle(JSON.parse(JSON.stringify(bundle)));
	assert.equal(imported.templates.length, 1);
	const importedSteps = getTemplate(imported.templates[0]!.id)!.steps;
	assert.equal(importedSteps[0]!.recoverOnFailure, true);
	assert.equal(importedSteps[0]!.maxRecoveries, 2);
	assert.equal(importedSteps[1]!.recoverOnFailure, false);
	assert.equal(importedSteps[1]!.maxRecoveries, 1);

	// A version 1 bundle from a hub that predates Failure recovery.
	const older = importTemplateBundle({
		kind: "target.templates",
		schemaVersion: 1,
		exportedAt: new Date().toISOString(),
		templates: [
			{
				name: "older bundle",
				tags: [],
				steps: [{ description: "from an older hub", acceptanceCriteria: "ok", manualReview: false, useSubagent: true, maxRetries: 1, retryIntervalSeconds: 0 }],
				tcpIds: [],
				tcpSelections: [],
				resourceSelections: [],
			},
		],
	});
	const olderStep = getTemplate(older.templates[0]!.id)!.steps[0]!;
	assert.equal(olderStep.recoverOnFailure, false);
	assert.equal(olderStep.maxRecoveries, 1);
});

test("applying a template (create-from-template and add-steps-from-template) seeds the steps with recoverOnFailure / maxRecoveries", async () => {
	const template = await recoveryTemplate("apply source");

	const created = await api("POST", "/api/workflows", { name: "from template", workdir: freshWorkdir(), runner: "claude", templateId: template.id });
	assert.equal(created.status, 200, JSON.stringify(created.json));
	const fromTemplate = (created.json.workflow as { id: string }).id;
	const seeded = taskSteps(fromTemplate);
	assert.deepEqual(
		seeded.map((s) => [s.description, s.recoverOnFailure, s.maxRecoveries, s.recoveryCount]),
		[
			["Recovers twice", true, 2, 0],
			["Never recovers", false, 1, 0],
		],
	);

	const target = createWorkflow("append target", { workdir: freshWorkdir(), runner: "claude" });
	const appended = await api("POST", `/api/workflows/${target.id}/steps/from-template`, { templateId: template.id });
	assert.equal(appended.status, 200, JSON.stringify(appended.json));
	const steps = appended.json.steps as Record<string, unknown>[];
	const appendedTasks = steps.filter((s) => s.kind !== "context");
	assert.equal(appendedTasks[0]!.recoverOnFailure, true);
	assert.equal(appendedTasks[0]!.maxRecoveries, 2);
	assert.equal(appendedTasks[1]!.recoverOnFailure, false);
	assert.equal(appendedTasks[1]!.maxRecoveries, 1);
});

test("remote workflow.apply_template seeds the steps with recoverOnFailure / maxRecoveries", async () => {
	resetSyncExecutorState();
	const template = await recoveryTemplate("remote apply source");
	const remoteId = nextRemoteId();
	await executeSyncCommand(command("workflow.apply_template", { template_id: template.id, name: "remote from template" }, remoteId), cfg);
	const workflow = getWorkflowByRemoteId(remoteId)!;
	assert.ok(workflow);
	assert.deepEqual(
		taskSteps(workflow.id).map((s) => [s.recoverOnFailure, s.maxRecoveries]),
		[
			[true, 2],
			[false, 1],
		],
	);
});

test("clone copies each step's recoverOnFailure / maxRecoveries (not the used count) and the recoveryModel; an explicit null clears the model", async () => {
	const source = createWorkflow("clone source", { workdir: freshWorkdir(), runner: "claude", recoveryModel: "sonnet" });
	const on = addStep(source.id, "with recovery", { recoverOnFailure: true, maxRecoveries: 3 });
	addStep(source.id, "without recovery");
	db.incrementRecoveryCount(on.id);
	assert.equal(getStep(on.id)!.recoveryCount, 1);

	const cloned = await api("POST", `/api/workflows/${source.id}/clone`, {});
	assert.equal(cloned.status, 200, JSON.stringify(cloned.json));
	const clone = cloned.json.workflow as { id: string; recoveryModel: string | null; agentName: string };
	assert.equal(clone.recoveryModel, "sonnet");
	assert.equal(getWorkflow(clone.id)!.recoveryModel, "sonnet");
	assert.equal(readHooks()[`${clone.agentName}-recovery`]?.model, "sonnet", "the clone has its own recovery hook");
	assert.deepEqual(
		taskSteps(clone.id).map((s) => [s.recoverOnFailure, s.maxRecoveries, s.recoveryCount]),
		[
			[true, 3, 0],
			[false, 1, 0],
		],
	);

	const cleared = await api("POST", `/api/workflows/${source.id}/clone`, { recoveryModel: null });
	assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
	assert.equal((cleared.json.workflow as { recoveryModel: string | null }).recoveryModel, null);
});

// ---------------------------------------------------------------------------------
// The report stream (target-server's view)

test("report: workflow.created and workflow.updated carry recovery_model; plan snapshots carry the per-step fields and are refreshed when they change", async () => {
	const workflow = createWorkflow("reported", { workdir: freshWorkdir(), runner: "claude", recoveryModel: "sonnet" });
	const created = events(workflow.id, "workflow.created");
	assert.equal(created.length, 1);
	assert.equal(created[0]!.recovery_model, "sonnet");

	const plain = createWorkflow("reported plain", { workdir: freshWorkdir(), runner: "claude" });
	assert.equal(events(plain.id, "workflow.created")[0]!.recovery_model, null, "null = the CLI default");

	const step = addStep(workflow.id, "reported step", { acceptanceCriteria: "ok", recoverOnFailure: true, maxRecoveries: 2 });
	const other = addStep(workflow.id, "reported default step", { acceptanceCriteria: "ok" });
	let plan = lastPlan(workflow.id);
	assert.equal(plan.recovery_model, "sonnet");
	assert.deepEqual(
		[planStepOf(plan, step.id).recover_on_failure, planStepOf(plan, step.id).max_recoveries, planStepOf(plan, step.id).recovery_count],
		[true, 2, 0],
	);
	assert.deepEqual(
		[planStepOf(plan, other.id).recover_on_failure, planStepOf(plan, other.id).max_recoveries, planStepOf(plan, other.id).recovery_count],
		[false, 1, 0],
	);

	// Changing only a recovery field is a new plan (the digest covers it).
	const before = events(workflow.id, "workflow.plan").length;
	const edit = await api("PATCH", `/api/workflows/${workflow.id}/steps/${other.id}`, { description: "reported default step", recoverOnFailure: true, maxRecoveries: 4 });
	assert.equal(edit.status, 200, JSON.stringify(edit.json));
	assert.ok(events(workflow.id, "workflow.plan").length > before, "a fresh plan snapshot went out");
	plan = lastPlan(workflow.id);
	assert.equal(planStepOf(plan, other.id).recover_on_failure, true);
	assert.equal(planStepOf(plan, other.id).max_recoveries, 4);

	// The recovery model: a workflow.updated with the full metadata, and the plan follows.
	const set = await api("PATCH", `/api/workflows/${workflow.id}/recovery-model`, { recoveryModel: "opus" });
	assert.equal(set.status, 200, JSON.stringify(set.json));
	const updated = events(workflow.id, "workflow.updated");
	assert.equal(updated[updated.length - 1]!.recovery_model, "opus");
	assert.equal(lastPlan(workflow.id).recovery_model, "opus");
	const clear = await api("PATCH", `/api/workflows/${workflow.id}/recovery-model`, { recoveryModel: null });
	assert.equal(clear.status, 200, JSON.stringify(clear.json));
	const updatedAgain = events(workflow.id, "workflow.updated");
	assert.equal(updatedAgain[updatedAgain.length - 1]!.recovery_model, null);
	assert.equal(lastPlan(workflow.id).recovery_model, null);
});

test("report: a recovery reports workflow.status_changed → recovering, a recovering plan with recovery_count, and step.recovery started / relaunched / gave_up with action, reason and changes", async () => {
	const workflow = createWorkflow("reported recovery", {
		workdir: freshWorkdir(),
		runner: "claude",
		model: "haiku",
		permissionMode: "bypassPermissions",
		recoveryModel: "sonnet",
	});
	const step = addStep(workflow.id, "Write the word hello into the file out.txt in the working directory", {
		acceptanceCriteria: "out.txt contains exactly the word goodbye",
		maxRetries: 0,
		recoverOnFailure: true,
		maxRecoveries: 2,
	});

	// Exec + a rejecting judge; the fake broker never calls back, the test plays awb.
	const rejectOnce = async () => {
		await onStepResult(step.id, { ok: true, result: "wrote hello", sessionId: "session-main" }, cfg, log);
		await onStepResult(step.id, { ok: true, result: JSON.stringify({ ok: false, reason: "out.txt contains hello, not goodbye" }), sessionId: "session-main" }, cfg, log);
	};
	await startWorkflow(workflow.id, cfg, log, [step.id]);
	await rejectOnce();
	assert.equal(getWorkflow(workflow.id)!.status, "recovering");

	const toRecovering = events(workflow.id, "workflow.status_changed").find((e) => e.to === "recovering");
	assert.ok(toRecovering, "workflow.status_changed carries recovering");
	assert.equal(toRecovering.from, "running");
	// The latest snapshot while the recovery runs (the engine writes one as the
	// status flips and another once the attempt is counted, synchronously after).
	const recoveringPlan = lastPlan(workflow.id);
	assert.equal(recoveringPlan.status, "recovering", "a plan snapshot with status recovering");
	assert.equal(planStepOf(recoveringPlan, step.id).recovery_count, 1);
	assert.equal(planStepOf(recoveringPlan, step.id).status, "failed");

	const started = events(workflow.id, "step.recovery").filter((e) => e.action === "started");
	assert.equal(started.length, 1);
	assert.equal(started[0]!.step_id, step.id);
	assert.equal(typeof started[0]!.reason, "string");
	assert.match(String(started[0]!.reason), /out\.txt contains hello, not goodbye/);
	assert.equal(started[0]!.changes, "", "nothing changed yet: empty, never absent");

	// The recovery changes the plan through its API, then relaunches.
	const jobs = brokerRequests.filter((r) => r.path === `/hook/${workflow.agentName}-recovery`);
	const token = tokenFromPrompt(jobs[jobs.length - 1]!.body.input!);
	const patched = await api(
		"PATCH",
		`/api/recovery/${workflow.id}/steps/${step.id}`,
		{ reason: "make the criteria match the task", acceptanceCriteria: "out.txt contains exactly the word hello" },
		bearer(token),
	);
	assert.equal(patched.status, 200, JSON.stringify(patched.json));
	const relaunch = await api("POST", `/api/recovery/${workflow.id}/relaunch`, { summary: "criteria aligned with the task" }, bearer(token));
	assert.equal(relaunch.status, 200, JSON.stringify(relaunch.json));
	const relaunched = events(workflow.id, "step.recovery").find((e) => e.action === "relaunched");
	assert.ok(relaunched);
	assert.equal(typeof relaunched.reason, "string");
	assert.ok(String(relaunched.reason).length > 0);
	assert.match(String(relaunched.changes), /acceptanceCriteria: .*goodbye.* → .*hello/);
	assert.equal(lastPlan(workflow.id).status, "running");
	assert.equal(planStepOf(lastPlan(workflow.id), step.id).acceptance_criteria, "out.txt contains exactly the word hello");

	// It fails again; the second recovery gives up.
	assert.equal(getStep(step.id)?.status, "queued", "the relaunch dispatched the step again");
	await rejectOnce();
	assert.equal(getWorkflow(workflow.id)!.status, "recovering");
	assert.equal(planStepOf(lastPlan(workflow.id), step.id).recovery_count, 2);
	const second = brokerRequests.filter((r) => r.path === `/hook/${workflow.agentName}-recovery`);
	const secondToken = tokenFromPrompt(second[second.length - 1]!.body.input!);
	const gaveUp = await api("POST", `/api/recovery/${workflow.id}/give-up`, { reason: "the task cannot be met as written" }, bearer(secondToken));
	assert.equal(gaveUp.status, 200, JSON.stringify(gaveUp.json));
	assert.equal(getRunningRecovery(workflow.id), null);
	const gaveUpEvent = events(workflow.id, "step.recovery").find((e) => e.action === "gave_up");
	assert.ok(gaveUpEvent);
	assert.match(String(gaveUpEvent.reason), /cannot be met/);
	assert.equal(typeof gaveUpEvent.changes, "string");
	assert.deepEqual(
		events(workflow.id, "step.recovery").map((e) => e.action),
		["started", "relaunched", "started", "gave_up"],
	);
	const failed = events(workflow.id, "workflow.status_changed").filter((e) => e.from === "recovering");
	assert.deepEqual(failed.map((e) => e.to), ["running", "failed"]);
	assert.equal(lastPlan(workflow.id).status, "failed");
});

// ---------------------------------------------------------------------------------
// Remote sync commands

test("remote step.add accepts recover_on_failure / max_recoveries (absent = off / 1) and refuses invalid values", async () => {
	resetSyncExecutorState();
	const remoteId = nextRemoteId();
	await executeSyncCommand(command("workflow.create", { name: "remote steps" }, remoteId), cfg);
	const workflow = getWorkflowByRemoteId(remoteId)!;

	await executeSyncCommand(
		command("step.add", { step_key: "k_on", description: "with recovery", acceptance_criteria: "ok", recover_on_failure: true, max_recoveries: 2 }, remoteId),
		cfg,
	);
	await executeSyncCommand(command("step.add", { step_key: "k_off", description: "without", acceptance_criteria: "ok" }, remoteId), cfg);
	const [on, off] = taskSteps(workflow.id);
	assert.deepEqual([on!.recoverOnFailure, on!.maxRecoveries, on!.recoveryCount], [true, 2, 0]);
	assert.deepEqual([off!.recoverOnFailure, off!.maxRecoveries, off!.recoveryCount], [false, 1, 0]);

	await assert.rejects(
		executeSyncCommand(command("step.add", { step_key: "k_bad", description: "bad", max_recoveries: -1 }, remoteId), cfg),
		/max_recoveries/,
	);
	await assert.rejects(
		executeSyncCommand(command("step.add", { step_key: "k_bad2", description: "bad", max_recoveries: 1.5 }, remoteId), cfg),
		/max_recoveries/,
	);
	await assert.rejects(
		executeSyncCommand(command("step.add", { step_key: "k_bad3", description: "bad", recover_on_failure: "yes" }, remoteId), cfg),
		/recover_on_failure/,
	);
	assert.equal(taskSteps(workflow.id).length, 2, "a refused step.add adds nothing");
});

test("remote step.edit changes recover_on_failure / max_recoveries, and an edit that omits them keeps the stored values", async () => {
	resetSyncExecutorState();
	const remoteId = nextRemoteId();
	await executeSyncCommand(command("workflow.create", { name: "remote edits" }, remoteId), cfg);
	const workflow = getWorkflowByRemoteId(remoteId)!;
	await executeSyncCommand(command("step.add", { step_key: "k", description: "editable", acceptance_criteria: "ok" }, remoteId), cfg);
	const stepId = taskSteps(workflow.id)[0]!.id;

	await executeSyncCommand(command("step.edit", { step_key: "k", recover_on_failure: true, max_recoveries: 3 }, remoteId), cfg);
	assert.deepEqual([getStep(stepId)!.recoverOnFailure, getStep(stepId)!.maxRecoveries], [true, 3]);

	await executeSyncCommand(command("step.edit", { step_key: "k", description: "edited text only", max_retries: 2 }, remoteId), cfg);
	const kept = getStep(stepId)!;
	assert.equal(kept.description, "edited text only");
	assert.equal(kept.maxRetries, 2);
	assert.equal(kept.recoverOnFailure, true, "omitted → kept");
	assert.equal(kept.maxRecoveries, 3, "omitted → kept");

	await executeSyncCommand(command("step.edit", { step_key: "k", recover_on_failure: false }, remoteId), cfg);
	assert.deepEqual([getStep(stepId)!.recoverOnFailure, getStep(stepId)!.maxRecoveries], [false, 3], "only the field sent changes");

	await assert.rejects(executeSyncCommand(command("step.edit", { step_key: "k", max_recoveries: -2 }, remoteId), cfg), /max_recoveries/);
	assert.equal(getStep(stepId)!.maxRecoveries, 3);
});

test("remote workflow.create applies recovery_model (and reports it); create_with_steps accepts the step fields; an unknown model is refused", async () => {
	resetSyncExecutorState();
	const remoteId = nextRemoteId();
	await executeSyncCommand(command("workflow.create", { name: "remote recovery model", agent: "claude", recovery_model: "sonnet" }, remoteId), cfg);
	const workflow = getWorkflowByRemoteId(remoteId)!;
	assert.equal(workflow.recoveryModel, "sonnet");
	assert.equal(readHooks()[`${workflow.agentName}-recovery`]?.model, "sonnet", "the recovery hook is written");
	const announced = pendingSyncEvents().find((e) => e.type === "workflow.created" && e.remote_id === remoteId);
	assert.ok(announced);
	assert.equal(announced.payload.recovery_model, "sonnet");
	assert.equal(events(workflow.id, "workflow.created")[0]!.recovery_model, "sonnet");

	const plainId = nextRemoteId();
	await executeSyncCommand(command("workflow.create", { name: "remote no recovery model", recovery_model: null }, plainId), cfg);
	assert.equal(getWorkflowByRemoteId(plainId)!.recoveryModel, null);
	assert.equal(pendingSyncEvents().find((e) => e.type === "workflow.created" && e.remote_id === plainId)!.payload.recovery_model, null);

	const badId = nextRemoteId();
	await assert.rejects(
		executeSyncCommand(command("workflow.create", { name: "bad model", agent: "claude", recovery_model: "no-such-model-xyz" }, badId), cfg),
		/recovery_model/,
	);
	assert.equal(getWorkflowByRemoteId(badId), null, "nothing is created");

	const withStepsId = nextRemoteId();
	await executeSyncCommand(
		command(
			"workflow.create_with_steps",
			{
				name: "remote with steps",
				recovery_model: "sonnet",
				steps: [
					{ step_key: "a", description: "recovers", acceptance_criteria: "ok", recover_on_failure: true, max_recoveries: 2 },
					{ step_key: "b", description: "does not", acceptance_criteria: "ok" },
				],
			},
			withStepsId,
		),
		cfg,
	);
	const withSteps = getWorkflowByRemoteId(withStepsId)!;
	assert.equal(withSteps.recoveryModel, "sonnet");
	assert.deepEqual(
		taskSteps(withSteps.id).map((s) => [s.description, s.recoverOnFailure, s.maxRecoveries]),
		[
			["recovers", true, 2],
			["does not", false, 1],
		],
	);
});
