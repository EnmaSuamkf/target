/**
 * Regression tests for "only the selected steps run" — the two ways the engine
 * used to dispatch a step nobody had ticked:
 *
 *  1. **A step added mid-run executed even though it was never selected.**
 *     `insertStep` wrote `selected = 1` for every new step (the column
 *     default), so a step appended while the workflow was `running` (or held
 *     `waiting` at a review gate) was dispatched by `advance()` the moment the
 *     in-flight step finished — while the UI was showing its box UNCHECKED
 *     (the page's selection is seeded when the workflow opens and only ever
 *     shrinks, so a step added with it open is never ticked). `addStep` now
 *     lands such appends unselected; only the insert-after-the-gate step stays
 *     selected, because its whole point is that Continue dispatches it next.
 *
 *  2. **A step unticked mid-run executed anyway.** The server only learned the
 *     selection at Start/Resume/Restart, so a mid-run toggle stayed
 *     browser-local and the DB flag the engine reads still said selected. The
 *     new selection-sync entry point (`setWorkflowStepSelection`, reached over
 *     PUT /api/workflows/:id/selection) is what every checkbox toggle now
 *     pushes to, so the engine's next dispatch decision sees it.
 *
 * Same throwaway-TARGET_HOME + fake-awb-hook convention as manual-review.test.ts:
 * the fake hook answers `{ok:true}` and never calls back, so a dispatched step
 * stays `queued` — which is exactly what "the engine dispatched it" looks like —
 * and `onStepResult` accepts a callback for a `queued` step.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-run-selection-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { getStep, getWorkflow, insertStep, insertWorkflow } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { addStep, continueStep, onStepResult, setWorkflowStepSelection, startWorkflow } = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

/** A fake awb hook that swallows dispatches (answers ok, never calls back). */
function startFakeHook() {
	const server = http.createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	return new Promise<{ server: http.Server; url: string }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
			resolve({ server, url: `http://127.0.0.1:${addr.port}/hook/agent` });
		});
	});
}

/** A running fake hook, closed when the test ends. */
async function hook(t: { after: (fn: () => void) => void }): Promise<string> {
	const { server, url } = await startFakeHook();
	t.after(() => server.close());
	return url;
}

/** A workflow with `count` pending steps, wired to the given hook. */
function makeWorkflow(hookUrl: string, count: number, options: { manualReview?: number[] } = {}) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	const steps = Array.from({ length: count }, (_, i) =>
		insertStep(id, `step ${i + 1}`, { manualReview: options.manualReview?.includes(i) === true }),
	);
	return { workflow, steps };
}

const finishOk = (stepId: string) => onStepResult(stepId, { ok: true, result: "the work" }, cfg, silent);

// --- scenario 1: the selection the run was started with -----------------

test("Start with only the first of two steps selected never dispatches the second", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 2);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	assert.equal(getStep(steps[0].id)?.status, "queued"); // dispatched

	await finishOk(steps[0].id);

	assert.equal(getStep(steps[0].id)?.status, "done");
	// Unselected means untouched: still pending, and the workflow is NOT left
	// running — the selected run has drained, so the badge settles to draft
	// (neither "running" with nothing in flight, nor a false "done").
	assert.equal(getStep(steps[1].id)?.status, "pending");
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
});

test("a step unticked MID-RUN is not dispatched when the in-flight step finishes", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 2);

	// Started with BOTH ticked — the step in flight proves the run is real.
	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	assert.equal(getStep(steps[0].id)?.status, "queued");

	// The operator unticks step 2 while step 1 runs: the toggle lands on the
	// server through the selection-sync entry point, not through a new Start.
	setWorkflowStepSelection(workflow.id, [steps[0].id]);

	await finishOk(steps[0].id);

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(getStep(steps[1].id)?.status, "pending"); // skipped, not dispatched
	// Nothing selected remains → the run is over, and the badge says so:
	// draft, with Start ready to pick the step up if it's ticked again.
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
});

test("a pending step ticked MID-RUN is picked up when the in-flight step finishes", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 2);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	assert.equal(getStep(steps[0].id)?.status, "queued");

	// The operator ticks step 2 while step 1 runs — the sync is also how a
	// pending step joins the run without stopping it first.
	setWorkflowStepSelection(workflow.id, [steps[0].id, steps[1].id]);

	await finishOk(steps[0].id);

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(getStep(steps[1].id)?.status, "queued"); // dispatched by advance()
	assert.equal(getWorkflow(workflow.id)?.status, "running");
});

// --- scenario 2: a step added while the run is in flight ----------------

test("a step added mid-run is unselected and is NOT dispatched when the in-flight step finishes", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 1);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	assert.equal(getStep(steps[0].id)?.status, "queued"); // the run is in flight

	// "+ step" while it runs. The UI renders this box unchecked (it only seeds
	// the selection when a workflow opens), so the flag must agree.
	const added = addStep(workflow.id, "added while it was running");
	assert.equal(added.selected, false);
	assert.equal(getStep(added.id)?.selected, false);

	await finishOk(steps[0].id);

	assert.equal(getStep(steps[0].id)?.status, "done");
	// The reported bug dispatched it here. Untouched now — and the workflow
	// settles to draft instead of completing over a step it never ran (or
	// sitting running forever with nothing in flight).
	assert.equal(getStep(added.id)?.status, "pending");
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
});

test("a step appended while the workflow waits at a review gate is unselected and survives Continue", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 1, { manualReview: [0] });

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await finishOk(steps[0].id); // accepted, but gated: held for the human
	assert.equal(getStep(steps[0].id)?.status, "waiting");
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");

	// A plain append while the gate holds is nobody's selection either —
	// Continue must not dispatch it on its way past the gate.
	const added = addStep(workflow.id, "appended at the gate");
	assert.equal(added.selected, false);

	await continueStep(workflow.id, steps[0].id, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(getStep(added.id)?.status, "pending");
	// Nothing selected past the gate → the run is over → draft, not running.
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
});

test("the insert-after-the-gate step stays selected, so Continue dispatches it next", async (t) => {
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 1, { manualReview: [0] });

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await finishOk(steps[0].id);
	assert.equal(getStep(steps[0].id)?.status, "waiting");

	// The gate-correction feature: the human reviews the result, wants a fix
	// BEFORE anything else, and the Continue that releases the gate runs it.
	// That only works because this step — unlike a plain append — IS selected.
	const correction = addStep(workflow.id, "the fix the review asked for", { afterStepId: steps[0].id });
	assert.equal(correction.selected, true);

	await continueStep(workflow.id, steps[0].id, cfg, silent);

	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(getStep(correction.id)?.status, "queued"); // dispatched, exactly as the feature promises
	assert.equal(getWorkflow(workflow.id)?.status, "running");
});

test("when the selected steps finish with unselected ones left, the workflow leaves running and can be launched again", async (t) => {
	// The exact reported flow: two steps started selected; mid-run the second
	// is unticked and a third is added; when the first finishes the workflow
	// must not sit `running` (Start disabled) — it settles to draft, and the
	// operator can tick the second step and launch again.
	const url = await hook(t);
	const { workflow, steps } = makeWorkflow(url, 2);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	assert.equal(getStep(steps[0].id)?.status, "queued"); // step 1 in flight

	// Mid-run: untick step 2, add step 3 (lands unselected).
	setWorkflowStepSelection(workflow.id, [steps[0].id]);
	const added = addStep(workflow.id, "added mid-run");
	assert.equal(added.selected, false);

	await finishOk(steps[0].id);

	// The selected run is over: step 1 done, step 2 and the new step pending,
	// and the badge settles to draft — the state where Start exists.
	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(getStep(steps[1].id)?.status, "pending");
	assert.equal(getStep(added.id)?.status, "pending");
	assert.equal(getWorkflow(workflow.id)?.status, "draft");

	// Re-tick step 2 and launch again: Start must work from here.
	await startWorkflow(workflow.id, cfg, silent, [steps[1].id]);
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	assert.equal(getStep(steps[1].id)?.status, "queued"); // dispatched
	assert.equal(getStep(added.id)?.status, "pending"); // still nobody's selection

	await finishOk(steps[1].id);
	assert.equal(getWorkflow(workflow.id)?.status, "draft"); // drained again

	// And ticking the added step launches it too, to a real completion.
	await startWorkflow(workflow.id, cfg, silent, [added.id]);
	assert.equal(getStep(added.id)?.status, "queued");
	await finishOk(added.id);
	assert.equal(getWorkflow(workflow.id)?.status, "completed"); // no pending left at all
});

// --- the states where the historical default is kept ---------------------

test("a step added to a draft workflow keeps the selected-by-default behavior", async (t) => {
	const url = await hook(t);
	const { workflow } = makeWorkflow(url, 1);

	// draft: the next Start rewrites every flag from the checkboxes anyway, and
	// workflows that never touch the selection keep running everything.
	const added = addStep(workflow.id, "added before the first run");
	assert.equal(added.selected, true);
});

test("setWorkflowStepSelection throws on an unknown workflow", () => {
	assert.throws(() => setWorkflowStepSelection("no-such-workflow", []), /unknown workflow/);
});
