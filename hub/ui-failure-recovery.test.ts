/**
 * Failure recovery in the hub UI (hub/ui): the pure helpers behind the controls
 * are tested directly, and the components at source level — the same approach
 * as ui-workflow-filters.test.ts and canvas-view.test.ts (no DOM here).
 *
 * What is pinned: the "Recover on failure" toggle and "Max recoveries" field in
 * every step form (sent on save, loaded on edit, the number only enabled while
 * the toggle is on), the step card's recovery marker, the "Recovery model"
 * selector next to the Model, the `recovering` status everywhere a status is
 * drawn, step editing locked while it lasts, and the API types/calls.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const { parseMaxRecoveries, recoveryMarkerLabel } = await import("./ui/src/lib/recovery.ts");
const { isRecoveryNote } = await import("./ui/src/lib/stepTimeline.ts");
const { layoutWorkflow, focusNodeId } = await import("./ui/src/lib/canvasLayout.ts");
const { STATUS_ORDER, filterAndSort } = await import("./ui/src/lib/workflowFilter.ts");
const { startActionFor } = await import("./ui/src/api/types.ts");
const { workflowRunActive } = await import("./ui/src/lib/stepSelection.ts");

type CanvasStep = Parameters<typeof layoutWorkflow>[0][number];

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src");
const read = (rel: string): string => fs.readFileSync(path.join(uiDir, rel), "utf8");

// --- pure helpers ---

test("parseMaxRecoveries: integers ≥ 0 as typed; blank or invalid is the default 1", () => {
	assert.equal(parseMaxRecoveries("0"), 0);
	assert.equal(parseMaxRecoveries("2"), 2);
	assert.equal(parseMaxRecoveries(" 3 "), 3);
	assert.equal(parseMaxRecoveries("1.7"), 1, "a fraction is floored to an integer");
	assert.equal(parseMaxRecoveries("-4"), 0, "never below the minimum 0");
	assert.equal(parseMaxRecoveries(""), 1);
	assert.equal(parseMaxRecoveries("abc"), 1);
});

test("recoveryMarkerLabel: shown while the toggle is on, with the count once a recovery ran", () => {
	assert.equal(recoveryMarkerLabel({ recoverOnFailure: false, maxRecoveries: 1, recoveryCount: 0 }), null);
	assert.equal(recoveryMarkerLabel({}), null, "a step from an older hub has no marker");
	assert.equal(recoveryMarkerLabel({ recoverOnFailure: true, maxRecoveries: 1, recoveryCount: 0 }), "Recovery");
	assert.equal(recoveryMarkerLabel({ recoverOnFailure: true, maxRecoveries: 1, recoveryCount: 1 }), "Recovery 1/1");
	assert.equal(recoveryMarkerLabel({ recoverOnFailure: true, maxRecoveries: 3, recoveryCount: 2 }), "Recovery 2/3");
	assert.equal(
		recoveryMarkerLabel({ recoverOnFailure: false, maxRecoveries: 2, recoveryCount: 1 }),
		"Recovery 1/2",
		"a used budget stays visible after the toggle is turned off",
	);
});

test("isRecoveryNote: tags the notes Failure recovery writes, and only agent ones", () => {
	const agent = (content: string) => ({ content, source: "agent" as const });
	assert.ok(isRecoveryNote(agent("Recovery: description: a → b\nReason: inconsistent")));
	assert.ok(isRecoveryNote(agent("Recovery note: read the logs")));
	assert.ok(isRecoveryNote(agent("Recovery relaunched the workflow: fixed the criteria")));
	assert.ok(isRecoveryNote(agent("Recovery gave up: credentials missing")));
	assert.ok(!isRecoveryNote(agent("Recovered the file from git")));
	assert.ok(!isRecoveryNote({ content: "Recovery: typed by a person", source: "operator" }));
});

let seq = 0;
function step(over: Partial<CanvasStep> = {}): CanvasStep {
	const orderIndex = over.orderIndex ?? seq;
	return {
		id: `r${++seq}`,
		kind: "task",
		orderIndex,
		description: `step ${orderIndex + 1}`,
		status: "pending",
		acceptanceCriteria: null,
		manualReview: false,
		useSubagent: false,
		maxRetries: 0,
		retryCount: 0,
		selected: true,
		...over,
	};
}

test("canvas: the failed step a recovery works on draws as `recovering`, and the viewport follows it", () => {
	const failed = step({ status: "failed", recovering: true });
	const graph = layoutWorkflow([step({ status: "done", orderIndex: 0 }), { ...failed, orderIndex: 1 }]);
	const card = graph.nodes.find((n) => n.kind === "step" && n.stepId === failed.id);
	assert.equal(card?.state, "recovering");
	assert.equal(focusNodeId(graph.nodes), card?.id);
	const plain = layoutWorkflow([step({ status: "failed" })]).nodes.find((n) => n.kind === "step");
	assert.equal(plain?.state, "failed", "without a running recovery a failed step stays failed");
	const notFailed = layoutWorkflow([step({ status: "pending", recovering: true })]).nodes.find((n) => n.kind === "step");
	assert.equal(notFailed?.state, "pending", "only a failed step can be the one being recovered");
});

test("`recovering` is a workflow status of its own: listed, sorted with active work, no Start", () => {
	assert.equal(typeof STATUS_ORDER.recovering, "number");
	assert.ok(STATUS_ORDER.recovering < STATUS_ORDER.failed, "a recovering workflow sorts above failed ones");
	assert.equal(startActionFor("recovering"), null, "the recovery relaunches the workflow itself");
	assert.equal(workflowRunActive("recovering", []), true, "selection is not shrunk while it may relaunch");
	const wf = (id: string, status: string) =>
		({ id, name: id, agentName: id, status, origin: "local", archivedAt: null, updatedAt: "2026-01-01T00:00:00Z" }) as never;
	const all = [wf("a", "failed"), wf("b", "recovering"), wf("c", "completed")];
	assert.deepEqual(
		filterAndSort(all, "", "recovering", "all").map((w) => w.id),
		["b"],
		"the status filter can pick recovering workflows",
	);
	assert.deepEqual(filterAndSort(all, "", "all", "all").map((w) => w.id), ["b", "a", "c"], "recovering sorts first here");
});

// --- source level ---

test("api/types.ts carries the Failure recovery fields, the status and the Recovery shape", () => {
	const types = read("api/types.ts");
	assert.match(types, /export type WorkflowStatus = [^;]*"recovering"/);
	assert.match(types, /recoverOnFailure\?: boolean;/);
	assert.match(types, /maxRecoveries\?: number;/);
	assert.match(types, /recoveryCount\?: number;/);
	assert.match(types, /recoveryModel\?: string \| null;/);
	assert.match(types, /recovery\?: Recovery \| null;/);
	assert.match(types, /export interface Recovery \{/);
	// StepConfigInput (create + edit) and the create/clone payloads.
	const config = types.slice(types.indexOf("export interface StepConfigInput"));
	assert.match(config.slice(0, config.indexOf("\n}")), /recoverOnFailure\?: boolean;[\s\S]*maxRecoveries\?: number;/);
	const create = types.slice(types.indexOf("export interface CreateWorkflowInput"));
	assert.match(create.slice(0, create.indexOf("\n}")), /recoveryModel\?: string;/);
	const clone = types.slice(types.indexOf("export interface CloneWorkflowInput"));
	assert.match(clone.slice(0, clone.indexOf("\n}")), /recoveryModel\?: string;/);
});

test("api/client.ts calls the dev 1 recovery routes", () => {
	const client = read("api/client.ts");
	assert.match(client, /export async function updateWorkflowRecoveryModel\(/);
	assert.match(client, /`\/api\/workflows\/\$\{workflowId\}\/recovery-model`, \{\s*method: "PATCH"/);
	assert.match(client, /body: json\(\{ recoveryModel: recoveryModel === "" \? null : recoveryModel \}\)/);
	assert.match(client, /export async function reopenStep\(/);
	assert.match(client, /`\/api\/workflows\/\$\{workflowId\}\/steps\/\$\{stepId\}\/reopen`, \{\s*method: "POST"/);
	assert.match(client, /export async function listRecoveries\(/);
	assert.match(client, /`\/api\/workflows\/\$\{workflowId\}\/recoveries`/);
	assert.match(client, /export async function abortRecovery\(/);
	assert.match(client, /`\/api\/workflows\/\$\{workflowId\}\/recovery\/abort`, \{\s*method: "POST"/);
});

test("RecoveryFields: the toggle with its hint, and Max recoveries enabled only while it is on", () => {
	const fields = read("components/RecoveryFields.tsx");
	assert.match(fields, /<span className="label">Recover on failure<\/span>/);
	assert.match(fields, /If this step fails for good, an agent fixes the plan and relaunches the workflow\./);
	assert.match(fields, /label="Recover on failure"/);
	assert.match(fields, />\s*Max recoveries\s*</);
	assert.match(fields, /type="number"[\s\S]*min=\{0\}[\s\S]*step=\{1\}/);
	assert.match(fields, /disabled=\{disabled \|\| !recoverOnFailure\}/);
});

test("every step form shows RecoveryFields and sends both fields (default off / 1)", () => {
	for (const [file, label] of [
		["views/AddStepModal.tsx", "add-step dialog"],
		["views/WorkflowDetail.tsx", "add-step form under the list"],
	] as const) {
		const src = read(file);
		assert.match(src, /useState\(false\);[\s\S]{0,40}\n\s*const \[maxRecoveries, setMaxRecoveries\] = useState\("1"\);/, `${label}: off / 1 by default`);
		assert.match(src, /<RecoveryFields[\s\S]*recoverOnFailure=\{recoverOnFailure\}/, `${label}: renders the fields`);
		assert.match(src, /maxRecoveries: parseMaxRecoveries\(maxRecoveries\)/, `${label}: sends the budget`);
		assert.match(src, /recoverOnFailure[,}]/, `${label}: sends the toggle`);
	}
	const item = read("views/StepItem.tsx");
	assert.match(item, /useState\(step\.recoverOnFailure === true\)/, "the editor loads the stored toggle");
	assert.match(item, /useState\(String\(step\.maxRecoveries \?\? 1\)\)/, "the editor loads the stored budget");
	assert.equal(
		(item.match(/maxRecoveries: parseMaxRecoveries\(maxRecoveries\)/g) ?? []).length,
		2,
		"the editor sends both fields for agent and command steps",
	);
	assert.match(item, /<RecoveryFields[\s\S]*recoveryCount=\{step\.recoveryCount\}/);
});

test("the step card shows the recovery marker, and the recovering step its own badge and note", () => {
	const item = read("views/StepItem.tsx");
	assert.match(item, /<RecoveryMarker\s+recoverOnFailure=\{step\.recoverOnFailure\}/);
	assert.match(item, /const badgeStatus = recoveringThis \? "recovering"/);
	assert.match(item, /data-step-recovering/);
	const badge = read("components/Badge.tsx");
	assert.match(badge, /export function RecoveryMarker\(/);
	assert.match(badge, /className="badge badge--recovery"/);
	assert.match(badge, /status === "recovering"/, "the recovering badge carries a live dot");
	const css = read("styles/global.css");
	assert.match(css, /\.badge--recovering \{/);
	assert.match(css, /\.badge--recovery \{/);
	assert.match(read("styles/tokens.css"), /--recovery-700:/);
	assert.match(read("views/WorkflowCanvas.module.css"), /\.state_recovering \{/);
});

test("step editing is disabled while a recovery runs", () => {
	const item = read("views/StepItem.tsx");
	assert.match(item, /const editable = !running && !waiting && !recoveryLock;/);
	assert.match(item, /const removable = step\.status === "pending" && !recoveryLock;/);
	assert.match(item, /const canMoveUp = canMoveUpAllowed && canEdit && !recoveryLock;/);
	assert.match(item, /disabled=\{inFlight \|\| busy \|\| !canManage \|\| recoveryLock\}/);
	const detail = read("views/WorkflowDetail.tsx");
	assert.match(detail, /const recovering = workflow\.status === "recovering";/);
	assert.equal((detail.match(/workflowRecovering=\{stepRecoveryLock\}/g) ?? []).length, 2, "both step lists are locked");
	assert.match(detail, /locked=\{recovering\}/, "the add-step form is locked");
	assert.match(detail, /disabled=\{busy \|\| stepInFlight \|\| recovering \|\| !canManage\}/, "the status override too");
	assert.match(detail, /data-abort-recovery/, "the one thing an operator can do is stop it");
	assert.match(detail, /recoveringStepId=\{recoveryStepId\}/, "the canvas knows which card is being recovered");
});

test("WorkflowDetail has a Recovery model selector next to the Model, saved through the recovery-model route", () => {
	const detail = read("views/WorkflowDetail.tsx");
	const model = detail.indexOf("onSave={onSaveModel}");
	const recovery = detail.indexOf('kind="recovery"');
	assert.ok(model > 0 && recovery > model, "the Recovery model block follows the Model block");
	assert.ok(recovery - model < 400, "…right next to it");
	assert.match(detail, /onSave=\{onSaveRecoveryModel\}/);
	const fact = read("components/WorkflowModelFact.tsx");
	assert.match(fact, /const label = isRecovery \? "Recovery model" : "Model";/);
	assert.match(fact, /\(isRecovery \? workflow\.recoveryModel : workflow\.model\) \?\? ""/);
	assert.match(fact, /<option value="">CLI default<\/option>/);
	assert.match(fact, /caps\.runners\.find\(\(r\) => r\.id === workflow\.harness\)\?\.models/, "same source as the model picker");
	const app = read("App.tsx");
	assert.match(app, /api\.updateWorkflowRecoveryModel\(selectedWorkflow\.id, model\)/);
	assert.match(app, /onSaveRecoveryModel=\{handleSaveWorkflowRecoveryModel\}/);
	assert.match(app, /api\.abortRecovery\(selectedId\)/);
});

test("the workflow list and the filters know `recovering`", () => {
	assert.match(read("views/WorkflowFilters.tsx"), /recovering: "Recovering"/);
	// The rail card draws the workflow's own status through Badge → badge--recovering.
	assert.match(read("views/WorkflowList.tsx"), /<Badge status=\{workflow\.status\}/);
});
