/**
 * Sticky notes on workflow steps — persistence, API wiring, and report events.
 */
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-step-notes-test-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.TARGET_REPORT_URL = "https://ingest.example.com/report";
process.env.TARGET_REPORT_TOKEN = "test-token";

const { insertWorkflow, insertStep, insertTemplate, open, pendingReportEvents } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

function clearEvents(): void {
	open().prepare("DELETE FROM report_events").run();
}

function makeWorkflow(description = "do the thing") {
	const id = crypto.randomUUID();
	const workflow = insertWorkflow({
		id,
		name: "notes wf",
		agentName: `agent-${id.slice(0, 8)}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const step = insertStep(workflow.id, description);
	return { workflow, step };
}

test("POST/PATCH/DELETE step notes persist and emit report events", async () => {
	clearEvents();
	const { workflow, step } = makeWorkflow();

	const createRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps/${step.id}/notes`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ content: "Check the logs", theme: "warning" }),
	});
	assert.equal(createRes.status, 200);
	const created = (await createRes.json()) as { note: { id: string; content: string; theme: string } };
	assert.equal(created.note.content, "Check the logs");
	assert.equal(created.note.theme, "warning");

	const detail = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers: adminHeaders() });
	const body = (await detail.json()) as { steps: { id: string; notes: { content: string }[] }[] };
	const row = body.steps.find((s) => s.id === step.id);
	assert.ok(row?.notes?.length === 1);
	assert.equal(row.notes[0].content, "Check the logs");

	const events = pendingReportEvents(10);
	assert.equal(events.some((e) => e.kind === "step.note.added"), true);
	assert.equal(JSON.parse(events.find((e) => e.kind === "step.note.added")!.payload).content, "Check the logs");

	const patchRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps/${step.id}/notes/${created.note.id}`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ content: "Updated reminder", theme: "success" }),
	});
	assert.equal(patchRes.status, 200);
	assert.equal(pendingReportEvents(10).some((e) => e.kind === "step.note.modified"), true);

	const delRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}/steps/${step.id}/notes/${created.note.id}`, {
		method: "DELETE",
		headers: adminHeaders(),
	});
	assert.equal(delRes.status, 200);
	assert.equal(pendingReportEvents(10).some((e) => e.kind === "step.note.deleted"), true);

	const after = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers: adminHeaders() });
	const afterBody = (await after.json()) as { steps: { id: string; notes: unknown[] }[] };
	assert.equal(afterBody.steps.find((s) => s.id === step.id)?.notes.length, 0);
});

test("template step notes copy onto workflow steps when seeded", async () => {
	const template = insertTemplate({
		name: "with notes",
		tags: [],
		steps: [
			{
				description: "first",
				acceptanceCriteria: null,
				manualReview: false,
				useSubagent: true,
				maxRetries: 0,
				retryIntervalSeconds: 0,
				notes: [{ id: "n1", content: "from template", theme: "neutral" }],
			},
		],
	});

	const res = await fetch(`${baseUrl}/api/workflows`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ name: "from template", templateId: template.id }),
	});
	assert.equal(res.status, 200);
	const { workflow } = (await res.json()) as { workflow: { id: string } };

	const detail = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers: adminHeaders() });
	const body = (await detail.json()) as { steps: { description: string; notes: { content: string }[] }[] };
	const task = body.steps.find((s) => s.description === "first");
	assert.ok(task);
	assert.equal(task.notes.length, 1);
	assert.equal(task.notes[0].content, "from template");
});
