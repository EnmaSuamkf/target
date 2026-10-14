/**
 * The interruption note: the first attempt after an operator abort carries
 * ABORT_NOTE so the agent re-checks the workdir instead of trusting its memory.
 * Absent on first runs, timeout retries and judge-reject retries.
 *
 * Same throwaway-TARGET_HOME + fake-awb-hook convention as abort.test.ts; the
 * fake hook records every dispatch body so the real `input` can be inspected.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-abort-note-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { insertStep, insertWorkflow, getStep } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { startWorkflow, abortStep, runStep, restartWorkflow } = await import("./workflow.ts");
const { dispatchStep } = await import("./runner.ts");

const cfg = loadConfig();
const silent = () => {};
const MARKER = "interrupted by the operator";
let seq = 0;

async function startFakeHook() {
	const inputs: string[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			try {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: string };
				if (typeof body.input === "string") inputs.push(body.input);
			} catch {
				// not a dispatch body
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
	test.after(() => server.close());
	return { inputs, url: `http://127.0.0.1:${addr.port}/hook/agent` };
}

function makeWorkflow(url: string) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl: url,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	return { workflow, step: insertStep(id, "do the thing") };
}

test("first run carries no abort note", async () => {
	const { inputs, url } = await startFakeHook();
	const { workflow, step } = makeWorkflow(url);
	await startWorkflow(workflow.id, cfg, silent, [step.id]);
	assert.equal(inputs.length, 1);
	assert.ok(!inputs[0].includes(MARKER));
});

test("▶ re-run after an abort carries the note", async () => {
	const { inputs, url } = await startFakeHook();
	const { workflow, step } = makeWorkflow(url);
	await startWorkflow(workflow.id, cfg, silent, [step.id]);
	await abortStep(workflow.id, step.id, silent);
	await runStep(workflow.id, step.id, cfg, silent);
	assert.equal(inputs.length, 2);
	assert.ok(inputs[1].includes(MARKER), "re-run prompt has the abort note");
	assert.ok(inputs[1].endsWith("do not assume earlier edits were completed or reverted."));
});

test("restart after an abort carries the note (restart clears `error`, the marker survives)", async () => {
	const { inputs, url } = await startFakeHook();
	const { workflow, step } = makeWorkflow(url);
	await startWorkflow(workflow.id, cfg, silent, [step.id]);
	await abortStep(workflow.id, step.id, silent);
	await restartWorkflow(workflow.id, cfg, silent, [step.id]);
	assert.equal(inputs.length, 2);
	assert.ok(inputs[1].includes(MARKER));
});

test("the note is consumed: the attempt after the re-run has none", async () => {
	const { inputs, url } = await startFakeHook();
	const { workflow, step } = makeWorkflow(url);
	await startWorkflow(workflow.id, cfg, silent, [step.id]);
	await abortStep(workflow.id, step.id, silent);
	await runStep(workflow.id, step.id, cfg, silent);
	await abortStep(workflow.id, step.id, silent);
	// Re-armed by the second abort, so present again…
	await runStep(workflow.id, step.id, cfg, silent);
	assert.ok(inputs[2].includes(MARKER));
	// …but a dispatch with nothing armed is clean.
	const fresh = getStep(step.id)!;
	await dispatchStep(fresh, workflow, cfg, silent, { resumeSession: true });
	assert.ok(!inputs[3].includes(MARKER));
});

test("timeout retry keeps TIMEOUT_NOTE and gets no abort note", async () => {
	const { inputs, url } = await startFakeHook();
	const { workflow, step } = makeWorkflow(url);
	await startWorkflow(workflow.id, cfg, silent, [step.id]);
	await dispatchStep(getStep(step.id)!, workflow, cfg, silent, { resumeSession: true, timedOut: true });
	assert.ok(inputs[1].includes("timed out before finishing"));
	assert.ok(!inputs[1].includes(MARKER));
});

test("judge-reject retry keeps its reason and gets no abort note", async () => {
	const { inputs, url } = await startFakeHook();
	const { workflow, step } = makeWorkflow(url);
	await startWorkflow(workflow.id, cfg, silent, [step.id]);
	await dispatchStep(getStep(step.id)!, workflow, cfg, silent, { resumeSession: true, retryReason: "missing tests" });
	assert.ok(inputs[1].includes("missing tests"));
	assert.ok(!inputs[1].includes(MARKER));
});
