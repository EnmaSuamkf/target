/**
 * Tests for the per-step "Use subagent" toggle.
 *
 * Until this existed, EVERY step's input ended with the same fixed instruction:
 * delegate this work to a subagent (the Task tool). That's still the default —
 * the shared session is reused turn after turn, and delegating is what keeps it
 * light — but it's now a per-step choice. Off, the step carries the opposite
 * instruction instead of nothing at all: the session's earlier turns are full of
 * "delegate this", so an unqualified step would very likely be delegated by
 * imitation (see runner.ts).
 *
 * What's pinned here:
 *
 *  - the flag defaults to ON everywhere it can be absent — an old DB row, an
 *    insert that doesn't mention it, an API body that doesn't send it, a
 *    template saved before the toggle existed — so upgrading changes nothing;
 *  - the dispatched input carries exactly one of the two instructions, and the
 *    right one;
 *  - both states survive create → read → edit → read, over the HTTP API too;
 *  - and the acceptance case: ONE workflow, step A delegated and step B inline,
 *    run through the engine, checked on the conversation it actually produced.
 *
 * Same throwaway-TARGET_HOME + fake-awb-hook convention as manual-review.test.ts,
 * except this file's fake hook RECORDS the request bodies: the `input` it
 * receives is verbatim the turn awb feeds into the workflow's Claude session, so
 * those recordings are the conversation this feature is about.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-subagent-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

/**
 * Seeds the DB with a `steps` table as it looked BEFORE `use_subagent` existed,
 * so importing db.ts below runs the real upgrade path (`addColumn`) instead of
 * the fresh-install one. The migration isn't a special case here, it's the setup.
 */
const legacyDbFile = path.join(tmpHome, "target.db");
{
	fs.mkdirSync(path.dirname(legacyDbFile), { recursive: true });
	const legacy = new DatabaseSync(legacyDbFile);
	legacy.exec(`
		CREATE TABLE steps (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			order_index INTEGER NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			error TEXT,
			session_id TEXT,
			callback_token TEXT NOT NULL,
			created_at TEXT NOT NULL,
			started_at TEXT,
			finished_at TEXT
		);
	`);
	legacy
		.prepare("INSERT INTO steps (id, workflow_id, order_index, description, callback_token, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.run("legacy-step", "legacy-wf", 0, "a step from before the toggle existed", "tok", new Date().toISOString());
	legacy.close();
}

const { getStep, insertStep, insertWorkflow, listSteps } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { INLINE_SUFFIX, SUBAGENT_SUFFIX, judgeInput } = await import("./runner.ts");
const { hookRuntime } = await import("./awb.ts");
// Every exec prompt now names the on-disk copies of the prior steps' results
// (step-results.ts). The byte-for-byte assertions below keep being byte-for-byte
// by spelling that note out too.
const { stepResultsNote } = await import("./step-results.ts");
const { getWorkflow } = await import("./db.ts");
/** The prior-results pointer as it appears in this workflow's prompts. */
const priorResults = (workflowId: string) => stepResultsNote(hookRuntime(getWorkflow(workflowId)!.hookUrl).workdir);
const { addStep, editStep, onStepResult, startWorkflow, writeStatusMd } = await import("./workflow.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

interface Dispatch {
	jobId: string;
	input: string;
	/** The session the dispatch asked awb to resume — null on the first turn. */
	sessionId: string | null;
}

/**
 * A fake awb hook that answers `{ok:true}` and never calls back (so a dispatched
 * step stays `queued`, exactly like manual-review.test.ts) while recording every
 * dispatch. `dispatches` is, in order, the conversation the workflow sent into
 * its session.
 */
function startRecordingHook(): Promise<{ server: http.Server; url: string; dispatches: Dispatch[] }> {
	const dispatches: Dispatch[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += String(chunk);
		});
		req.on("end", () => {
			try {
				const parsed = JSON.parse(body) as { jobId: string; input: string };
				dispatches.push({
					jobId: parsed.jobId,
					input: parsed.input,
					sessionId: typeof req.headers.sessionid === "string" ? req.headers.sessionid : null,
				});
			} catch {
				// A body we can't parse is a test bug, and the assertions will say so.
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
			resolve({ server, url: `http://127.0.0.1:${addr.port}/hook/agent`, dispatches });
		});
	});
}

/** A running recording hook, closed when the test ends. */
async function hook(t: { after: (fn: () => void) => void }): Promise<{ url: string; dispatches: Dispatch[] }> {
	const { server, url, dispatches } = await startRecordingHook();
	t.after(() => server.close());
	return { url, dispatches };
}

interface StepOptions {
	acceptanceCriteria?: string | null;
	useSubagent?: boolean;
}

/** A workflow whose steps are described one options-object each, in order. */
function makeWorkflow(hookUrl: string, stepOptions: StepOptions[]) {
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
	const steps = stepOptions.map((options, i) => insertStep(id, `step ${i + 1}`, options));
	return { workflow, steps };
}

// --- the migration ------------------------------------------------------

test("the use_subagent column is added to a DB created without it, and old rows read as ON", () => {
	// The pre-toggle row survived the ALTER TABLE and defaults to delegating —
	// an upgraded hub must not silently start running old steps inline.
	const legacy = getStep("legacy-step");
	assert.ok(legacy, "the pre-migration step is still readable");
	assert.equal(legacy?.useSubagent, true);
	assert.equal(legacy?.description, "a step from before the toggle existed");
});

// --- persistence --------------------------------------------------------

test("useSubagent survives insert → read, and defaults to on", () => {
	const { steps } = makeWorkflow("http://127.0.0.1:1/hook", [{}, { useSubagent: false }, { useSubagent: true }]);
	assert.equal(getStep(steps[0].id)?.useSubagent, true); // absent = on
	assert.equal(getStep(steps[1].id)?.useSubagent, false); // only an explicit false turns it off
	assert.equal(getStep(steps[2].id)?.useSubagent, true);
	// Also on the object insertStep returns, not just on a re-read.
	assert.equal(steps[1].useSubagent, false);
});

test("addStep defaults the toggle to on and honours an explicit false", () => {
	const { workflow } = makeWorkflow("http://127.0.0.1:1/hook", []);
	const withDefault = addStep(workflow.id, "delegated by default");
	const inline = addStep(workflow.id, "inline please", { useSubagent: false });
	assert.equal(getStep(withDefault.id)?.useSubagent, true);
	assert.equal(getStep(inline.id)?.useSubagent, false);
});

test("an edit that omits useSubagent keeps it, and toggling it on/off persists", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", [{ useSubagent: false }]);
	// A plain description edit must not silently switch the step back to delegating.
	editStep(workflow.id, steps[0].id, "a different task");
	assert.equal(getStep(steps[0].id)?.useSubagent, false);
	// An edit that only sends the criteria mustn't touch it either.
	editStep(workflow.id, steps[0].id, "a different task", { acceptanceCriteria: "must be X" });
	assert.equal(getStep(steps[0].id)?.useSubagent, false);
	// And an explicit change sticks, both ways.
	editStep(workflow.id, steps[0].id, "a different task", { useSubagent: true });
	assert.equal(getStep(steps[0].id)?.useSubagent, true);
	editStep(workflow.id, steps[0].id, "a different task", { useSubagent: false });
	assert.equal(getStep(steps[0].id)?.useSubagent, false);
});

// --- what the agent is actually told -------------------------------------

test("a step with the toggle ON is dispatched with the subagent-delegation instruction", async (t) => {
	const { url, dispatches } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ useSubagent: true }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);

	assert.equal(dispatches.length, 1);
	assert.ok(dispatches[0].input.includes(SUBAGENT_SUFFIX), "the delegation instruction is there");
	assert.ok(!dispatches[0].input.includes(INLINE_SUFFIX), "and not the inline one");
	assert.match(dispatches[0].input, /delegating the work to a subagent \(the Task tool\)/);
});

test("a step with the toggle OFF is dispatched with the inline instruction and NOT the subagent one", async (t) => {
	const { url, dispatches } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ useSubagent: false }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);

	assert.equal(dispatches.length, 1);
	assert.ok(!dispatches[0].input.includes(SUBAGENT_SUFFIX), "the delegation instruction is gone");
	assert.ok(dispatches[0].input.includes(INLINE_SUFFIX), "replaced by the inline one");
	assert.match(dispatches[0].input, /do NOT delegate it to a subagent/);
});

test("a step that never mentions the toggle is dispatched exactly as before the feature", async (t) => {
	const { url, dispatches } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{}]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);

	// The whole input, byte for byte, is what the old unconditional code built.
	assert.equal(dispatches[0].input, `step 1${priorResults(workflow.id)}${SUBAGENT_SUFFIX}`);
});

test("the toggle doesn't disturb the criteria note or its ordering", async (t) => {
	const { url, dispatches } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ useSubagent: false, acceptanceCriteria: "must be X" }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);

	assert.equal(
		dispatches[0].input,
		`step 1\n\nThe result of this step MUST satisfy the following acceptance criterion, so aim explicitly to meet it: "must be X".${priorResults(
			workflow.id,
		)}${INLINE_SUFFIX}`,
	);
});

test("the judge prompt stops blaming a subagent for an inline step's output", () => {
	// Delegated (the default): the thread only holds the subagent's summary.
	assert.match(judgeInput("must be X"), /The step's work was done by a subagent/);
	assert.match(judgeInput("must be X", true), /The step's work was done by a subagent/);
	// Inline: there was no subagent, so it's the agent's own narration it must
	// not trust. Either way it's told to go and verify the real artifacts.
	const inline = judgeInput("must be X", false);
	assert.ok(!inline.includes("subagent"), "no subagent is invented for an inline step");
	assert.match(inline, /do NOT trust your memory or what you said while doing the step/);
	assert.match(inline, /inspecting the actual artifacts with your tools/);
});

test("the judge pass itself never carries either instruction (its verdict must come back on this thread)", async (t) => {
	const { url, dispatches } = await hook(t);
	const { workflow, steps } = makeWorkflow(url, [{ useSubagent: false, acceptanceCriteria: "must be X" }]);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "did it", sessionId: "sess-judge" }, cfg, silent);

	assert.equal(dispatches.length, 2, "exec then judge");
	assert.ok(!dispatches[1].input.includes(SUBAGENT_SUFFIX));
	assert.ok(!dispatches[1].input.includes(INLINE_SUFFIX));
});

// --- the progress .md ----------------------------------------------------

test("the progress file names the inline steps and stays quiet about the default", () => {
	const { workflow, steps } = makeWorkflow("http://127.0.0.1:1/hook", [{ useSubagent: true }, { useSubagent: false }]);
	writeStatusMd(workflow.id);
	const md = fs.readFileSync(workflow.mdPath, "utf8");
	assert.equal(md.match(/Subagent: off/g)?.length, 1, "only the step that opted out is called out");
	const lines = md.split("\n");
	const inlineNote = lines.findIndex((l) => l.includes("Subagent: off"));
	assert.ok(inlineNote > lines.findIndex((l) => l.includes(`2. [ ] ${steps[1].description}`)), "under step 2");
});

// --- the HTTP API --------------------------------------------------------

const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;
test.after(() => server.close());

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

async function apiWorkflow(name: string): Promise<string> {
	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { id: string } };
	return workflow.id;
}

test("POST /api/workflows/:id/steps round-trips the toggle, defaulting to on", async () => {
	const workflowId = await apiWorkflow("api toggle");
	const post = async (body: Record<string, unknown>) => {
		const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps`, {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify(body),
		});
		assert.equal(res.status, 200);
		return ((await res.json()) as { step: { id: string; useSubagent: boolean } }).step;
	};

	assert.equal((await post({ description: "no field at all" })).useSubagent, true);
	assert.equal((await post({ description: "explicitly on", useSubagent: true })).useSubagent, true);
	const inline = await post({ description: "explicitly off", useSubagent: false });
	assert.equal(inline.useSubagent, false);

	// And it's in the detail read the UI polls, not just the create response.
	const detail = await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() });
	const { steps } = (await detail.json()) as { steps: { id: string; useSubagent: boolean }[] };
	assert.deepEqual(
		steps.map((s) => s.useSubagent),
		[true, true, false],
	);

	// PATCH toggles it back on, and a PATCH that omits it leaves it alone.
	const patch = async (stepId: string, body: Record<string, unknown>) => {
		const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${stepId}`, {
			method: "PATCH",
			headers: adminHeaders(),
			body: JSON.stringify(body),
		});
		assert.equal(res.status, 200);
		return ((await res.json()) as { step: { useSubagent: boolean } }).step;
	};
	assert.equal((await patch(inline.id, { description: "explicitly off" })).useSubagent, false);
	assert.equal((await patch(inline.id, { description: "explicitly off", useSubagent: true })).useSubagent, true);
});

test("a template carries the toggle onto the steps it creates", async () => {
	const created = await fetch(`${baseUrl}/api/templates`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name: "mixed template",
			tags: [],
			steps: [
				{ description: "delegated step" }, // no field: reads as on
				{ description: "inline step", useSubagent: false },
			],
		}),
	});
	assert.equal(created.status, 200);
	const { template } = (await created.json()) as { template: { id: string; steps: { useSubagent: boolean }[] } };
	assert.deepEqual(
		template.steps.map((s) => s.useSubagent),
		[true, false],
	);

	const workflowId = await apiWorkflow("from template");
	const applied = await fetch(`${baseUrl}/api/workflows/${workflowId}/steps/from-template`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ templateId: template.id }),
	});
	assert.equal(applied.status, 200);
	const { steps } = (await applied.json()) as { steps: { useSubagent: boolean }[] };
	assert.deepEqual(
		steps.map((s) => s.useSubagent),
		[true, false],
	);
});

// --- the acceptance case -------------------------------------------------
//
// "Create a workflow with two steps, one selecting WITH subagent and the other
// WITHOUT, and verify in the conversation that that's what happened."
//
// One workflow, one hook, one session: step A delegated, step B inline. The
// recorded dispatches ARE the conversation's user turns, in order, so this is
// that verification at the level the hub controls — what each step told the
// agent to do.

test("acceptance: a two-step workflow sends the delegation instruction for step 1 and the inline one for step 2", async (t) => {
	const { url, dispatches } = await hook(t);
	const workflowId = "wf-acceptance";
	const workflow = insertWorkflow({
		id: workflowId,
		name: "subagent toggle acceptance",
		agentName: "agent-acceptance",
		hookUrl: url,
		secret: "s3cret",
		mdPath: path.join(tmpHome, "acceptance.md"),
		conversationContext: null,
	});
	// Step 1: "with subagent" (the toggle left at its default ON).
	const stepA = addStep(workflow.id, "Step A: the one that must run through a subagent");
	// Step 2: "without subagent".
	const stepB = addStep(workflow.id, "Step B: the one that must run inline", { useSubagent: false });
	assert.equal(getStep(stepA.id)?.useSubagent, true);
	assert.equal(getStep(stepB.id)?.useSubagent, false);

	// Run it: start dispatches step A; A's result chains the session and the
	// engine dispatches step B on that same session.
	await startWorkflow(workflow.id, cfg, silent, [stepA.id, stepB.id]);
	await onStepResult(stepA.id, { ok: true, result: "A done", sessionId: "shared-session" }, cfg, silent);

	assert.equal(dispatches.length, 2, "both steps reached the agent");

	const [turnA, turnB] = dispatches;
	assert.equal(turnA.jobId, stepA.id);
	assert.equal(turnB.jobId, stepB.id);
	// One conversation: step B resumed the session step A produced.
	assert.equal(turnA.sessionId, null);
	assert.equal(turnB.sessionId, "shared-session");

	// Step A was told to delegate…
	assert.ok(turnA.input.includes(SUBAGENT_SUFFIX));
	assert.ok(!turnA.input.includes(INLINE_SUFFIX));
	// …and step B, in that same conversation, was told the opposite.
	assert.ok(turnB.input.includes(INLINE_SUFFIX));
	assert.ok(!turnB.input.includes(SUBAGENT_SUFFIX));

	// Spelled out, since this is the assertion the feature exists for:
	assert.equal(
		turnA.input,
		`Step A: the one that must run through a subagent${priorResults(
			workflow.id,
		)}\n\nImportant: run this step by delegating the work to a subagent (the Task tool) instead of solving it yourself directly in this thread — this same session is reused sequentially for every step of the workflow, and delegating keeps the main thread lightweight.`,
	);
	assert.equal(
		turnB.input,
		`Step B: the one that must run inline${priorResults(
			workflow.id,
		)}\n\nImportant: run this step yourself, directly in this thread — do NOT delegate it to a subagent (do not use the Task tool for it). This step was explicitly configured to run inline, so its work belongs in this conversation.`,
	);

	// The workflow's own progress file agrees on which step was which.
	const md = fs.readFileSync(workflow.mdPath, "utf8");
	assert.ok(!md.includes("1. [.] Step A: the one that must run through a subagent — **queued**\n   - Subagent: off"));
	assert.match(md, /Step B: the one that must run inline[\s\S]*?- Subagent: off/);
	assert.equal(listSteps(workflow.id).length, 2);
});
