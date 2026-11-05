/**
 * Step note `source` over HTTP: POST accepts an optional source (default
 * operator, 400 invalid_source otherwise), PATCH never changes it, the step
 * payload carries it, and the step.note.added / step.note.modified report
 * events carry it in their data.
 *
 * Same throwaway-TARGET_HOME/AWB_HOME convention as step-notes.test.ts.
 */
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-step-note-routes-source-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.TARGET_REPORT_URL = "https://ingest.example.com/report";
process.env.TARGET_REPORT_TOKEN = "test-token";

const { insertWorkflow, insertStep, open, pendingReportEvents } = await import("./db.ts");
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

function makeWorkflow() {
	const id = crypto.randomUUID();
	const workflow = insertWorkflow({
		id,
		name: "source wf",
		agentName: `agent-${id.slice(0, 8)}`,
		hookUrl: "http://127.0.0.1:1/hook",
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	const step = insertStep(workflow.id, "a step");
	return { workflow, step };
}

function notesUrl(workflowId: string, stepId: string): string {
	return `${baseUrl}/api/workflows/${workflowId}/steps/${stepId}/notes`;
}

async function postNote(workflowId: string, stepId: string, body: Record<string, unknown>) {
	return fetch(notesUrl(workflowId, stepId), {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify(body),
	});
}

async function stepNotesFromPayload(workflowId: string, stepId: string) {
	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}`, { headers: adminHeaders() });
	const body = (await res.json()) as {
		steps: { id: string; notes: { id: string; source?: string; createdAt: string; updatedAt: string }[] }[];
	};
	return body.steps.find((s) => s.id === stepId)?.notes ?? [];
}

/** The data of the report event of `kind` for `noteId`, parsed from its stored payload. */
function eventData(kind: string, noteId: string): Record<string, unknown> | undefined {
	const event = pendingReportEvents(1000).find((e) => {
		if (e.kind !== kind) return false;
		return (JSON.parse(e.payload) as { note_id?: string }).note_id === noteId;
	});
	return event ? (JSON.parse(event.payload) as Record<string, unknown>) : undefined;
}

test("POST with source agent stores an agent note and reports it as agent", async () => {
	clearEvents();
	const { workflow, step } = makeWorkflow();

	const res = await postNote(workflow.id, step.id, { content: "agent says hi", theme: "success", source: "agent" });
	assert.equal(res.status, 200);
	const { note } = (await res.json()) as { note: { id: string; source: string } };
	assert.equal(note.source, "agent");

	const added = eventData("step.note.added", note.id);
	assert.ok(added, "step.note.added is reported for the note");
	assert.equal(added.source, "agent");
	assert.equal(added.content, "agent says hi");
});

test("POST without source stores an operator note and reports it as operator", async () => {
	clearEvents();
	const { workflow, step } = makeWorkflow();

	const res = await postNote(workflow.id, step.id, { content: "typed by hand" });
	assert.equal(res.status, 200);
	const { note } = (await res.json()) as { note: { id: string; source: string } };
	assert.equal(note.source, "operator");
	assert.equal(eventData("step.note.added", note.id)?.source, "operator");
});

test("POST with source operator explicitly stores an operator note", async () => {
	const { workflow, step } = makeWorkflow();
	const res = await postNote(workflow.id, step.id, { content: "explicit", source: "operator" });
	assert.equal(res.status, 200);
	const { note } = (await res.json()) as { note: { source: string } };
	assert.equal(note.source, "operator");
});

test("POST with an invalid source is refused with 400 invalid_source and stores nothing", async () => {
	const { workflow, step } = makeWorkflow();
	for (const bad of ["system", "Agent", "", null, 1, ["agent"]]) {
		const res = await postNote(workflow.id, step.id, { content: "should not land", source: bad });
		assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
		assert.deepEqual(await res.json(), { error: "invalid_source" });
	}
	assert.equal((await stepNotesFromPayload(workflow.id, step.id)).length, 0);
});

test("PATCH does not change the source of an agent note", async () => {
	clearEvents();
	const { workflow, step } = makeWorkflow();
	const created = await postNote(workflow.id, step.id, { content: "original", source: "agent" });
	const { note } = (await created.json()) as { note: { id: string } };

	const patchRes = await fetch(`${notesUrl(workflow.id, step.id)}/${note.id}`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ content: "edited", theme: "warning", source: "operator" }),
	});
	assert.equal(patchRes.status, 200);
	const patched = (await patchRes.json()) as { note: { content: string; source: string } };
	assert.equal(patched.note.content, "edited");
	assert.equal(patched.note.source, "agent");

	const payloadNote = (await stepNotesFromPayload(workflow.id, step.id)).find((n) => n.id === note.id);
	assert.equal(payloadNote?.source, "agent");
	assert.equal(eventData("step.note.modified", note.id)?.source, "agent");
});

test("the step payload notes include source, createdAt and updatedAt for each note", async () => {
	const { workflow, step } = makeWorkflow();
	await postNote(workflow.id, step.id, { content: "from the operator" });
	await postNote(workflow.id, step.id, { content: "from the agent", source: "agent" });

	const notes = await stepNotesFromPayload(workflow.id, step.id);
	assert.deepEqual(
		notes.map((n) => n.source),
		["operator", "agent"],
	);
	for (const note of notes) {
		assert.equal(typeof note.createdAt, "string");
		assert.equal(typeof note.updatedAt, "string");
	}
});

test("step.note.modified event data carries source for an operator note too", async () => {
	clearEvents();
	const { workflow, step } = makeWorkflow();
	const created = await postNote(workflow.id, step.id, { content: "mine" });
	const { note } = (await created.json()) as { note: { id: string } };

	const patchRes = await fetch(`${notesUrl(workflow.id, step.id)}/${note.id}`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ content: "mine, edited" }),
	});
	assert.equal(patchRes.status, 200);
	assert.equal(eventData("step.note.modified", note.id)?.source, "operator");
});
