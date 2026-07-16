/**
 * Tests for how a workflow's status is derived from its steps. The badge is a
 * function of the CURRENT state of every step — the last attempt of each one —
 * so a step that failed and is then re-run (the ▶ button) until it succeeds
 * must stop holding the whole workflow at `failed`.
 *
 * Everything runs against a throwaway TARGET_HOME (its own SQLite file and
 * progress .md files), so nothing here touches the operator's real ~/.target.
 * Steps are driven through `onStepResult` — the same callback awb posts to
 * /api/steps/:id/result — with `startManualRun` standing in for the ▶ dispatch,
 * which keeps the hook out of the test.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-"));
process.env.TARGET_HOME = tmpHome;

const { getWorkflow, insertStep, insertWorkflow, startManualRun } = await import("./db.ts");
const { onStepResult } = await import("./workflow.ts");
const { loadConfig } = await import("./config.ts");

const cfg = loadConfig();
const silent = () => {};

let seq = 0;

/** A workflow with `count` pending steps, wired straight into the DB (no awb hook involved). */
function makeWorkflow(count: number) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const steps = Array.from({ length: count }, (_, i) => insertStep(id, `step ${i + 1}`));
	return { workflow, steps };
}

/** Runs a step's exec job to the given outcome, exactly as awb's callback would. */
async function finishStep(stepId: string, ok: boolean) {
	await onStepResult(stepId, ok ? { ok: true, result: "fine" } : { ok: false, error: "boom" }, cfg, silent);
}

test("a failed step re-run successfully takes the workflow out of failed", async () => {
	const { workflow, steps } = makeWorkflow(1);

	await finishStep(steps[0].id, false);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");

	// The ▶ button: re-run that same step, this time successfully.
	assert.ok(startManualRun(steps[0].id));
	await finishStep(steps[0].id, true);

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
});

test("re-running one failed step of many leaves the workflow ready to continue", async () => {
	const { workflow, steps } = makeWorkflow(3);

	await finishStep(steps[0].id, true);
	await finishStep(steps[1].id, false);
	assert.equal(getWorkflow(workflow.id)?.status, "failed");

	assert.ok(startManualRun(steps[1].id));
	await finishStep(steps[1].id, true);

	// Step 3 never ran, so there's still work to do: back to draft, not completed.
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
});

test("a step that fails again keeps the workflow failed", async () => {
	const { workflow, steps } = makeWorkflow(2);

	await finishStep(steps[0].id, false);
	assert.ok(startManualRun(steps[0].id));
	await finishStep(steps[0].id, false);

	assert.equal(getWorkflow(workflow.id)?.status, "failed");
});

test("a re-run that fails a step of a completed workflow fails the workflow", async () => {
	const { workflow, steps } = makeWorkflow(1);

	assert.ok(startManualRun(steps[0].id));
	await finishStep(steps[0].id, true);
	assert.equal(getWorkflow(workflow.id)?.status, "completed");

	assert.ok(startManualRun(steps[0].id));
	await finishStep(steps[0].id, false);

	assert.equal(getWorkflow(workflow.id)?.status, "failed");
});
