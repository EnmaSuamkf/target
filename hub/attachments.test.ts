/**
 * Tests for image attachments on the three text inputs a workflow is written in:
 * the workflow-level **conversation context**, and each step's **task
 * description** and **acceptance criteria**.
 *
 * The point of the feature is that the agent can actually LOOK at the images, and
 * the only way a Claude Code session can is to `Read` a file. So the assertion
 * that matters most here is the last group: the string dispatched to the hook —
 * the prompt — must contain the ABSOLUTE PATH of every attached image, for all
 * three fields. Everything above it (upload, persistence, the read endpoints)
 * only exists to get to that point, and is tested through the real HTTP server so
 * the wiring in server.ts is covered too.
 *
 * Same throwaway-TARGET_HOME + AWB_HOME convention as the other suites (see
 * server.test.ts for why awb has to be isolated as well).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-attachments-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { getContextStep, getStep, insertStep, insertWorkflow, getWorkflow, setContextInjected } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { composeStepInput, dispatchStep } = await import("./runner.ts");
const { attachmentSection, MAX_ATTACHMENT_BYTES, saveAttachment, sanitizeFilename } = await import("./attachments.ts");
// Every exec prompt now points at the on-disk copies of the prior steps'
// results (step-results.ts), so the "exactly as before" assertions below spell
// it out rather than dropping to a looser `includes`.
const { stepResultsNote } = await import("./step-results.ts");
const { removeStep, removeWorkflow } = await import("./workflow.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

function adminHeaders(): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

/**
 * The smallest valid PNG: a 1x1 image. Real bytes rather than a stub, so the
 * mime allowlist, the size accounting and the byte-for-byte round trip through
 * the content route are all tested against something a browser would actually
 * produce.
 */
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

let seq = 0;

/** A workflow row + one step, straight into the DB (no awb hook needed for the read/compose paths). */
function makeWorkflow(options: { context?: string | null; criteria?: string | null; hookUrl?: string } = {}) {
	const id = `wf-att-${++seq}`;
	insertWorkflow({
		id,
		name: `attachments ${id}`,
		agentName: `agent-${id}`,
		hookUrl: options.hookUrl ?? `http://127.0.0.1:1/hook/${id}`,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: options.context ?? null,
	});
	const step = insertStep(id, "do the thing", { acceptanceCriteria: options.criteria ?? null });
	return { workflow: getWorkflow(id)!, step };
}

/** POSTs one image to the upload route. `data` defaults to the 1x1 PNG. */
async function upload(
	workflowId: string,
	body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, any> }> {
	const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/attachments`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({ filename: "shot.png", mime: "image/png", data: PNG_BASE64, ...body }),
	});
	return { status: res.status, json: (await res.json()) as Record<string, any> };
}

// --- upload + persistence ---------------------------------------------

test("uploading an image writes the bytes under ~/.target/attachments/<workflow> and returns its metadata", async () => {
	const { workflow } = makeWorkflow();
	const { status, json } = await upload(workflow.id, { field: "context" });
	assert.equal(status, 200);
	const a = json.attachment;
	assert.equal(a.field, "context");
	assert.equal(a.stepId, null);
	assert.equal(a.mime, "image/png");
	assert.equal(a.size, PNG_BYTES.length);
	assert.equal(a.filename, "shot.png");
	// Stored inside the hub's own state dir, keyed by workflow — not somewhere invented.
	assert.equal(path.dirname(a.path), path.join(tmpHome, "attachments", workflow.id));
	assert.ok(path.isAbsolute(a.path), "the recorded path is absolute — that's what the agent is given");
	// And the bytes really are on disk, unchanged.
	assert.deepEqual(fs.readFileSync(a.path), PNG_BYTES);
	assert.equal(a.url, `/api/attachments/${a.id}/content`);
});

test("a data: URL is accepted and its mime is used when none is sent explicitly", async () => {
	const { workflow, step } = makeWorkflow();
	const { status, json } = await upload(workflow.id, {
		field: "description",
		stepId: step.id,
		mime: undefined,
		data: `data:image/webp;base64,${PNG_BASE64}`,
	});
	assert.equal(status, 200);
	assert.equal(json.attachment.mime, "image/webp");
});

test("the upload route is admin-gated", async () => {
	const { workflow } = makeWorkflow();
	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/attachments`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ field: "context", filename: "a.png", mime: "image/png", data: PNG_BASE64 }),
	});
	assert.equal(res.status, 401);
});

// --- validation -------------------------------------------------------

test("a non-image mime type is refused", async () => {
	const { workflow } = makeWorkflow();
	const { status, json } = await upload(workflow.id, { field: "context", mime: "application/pdf" });
	assert.equal(status, 400);
	assert.match(String(json.error), /unsupported image type/);
});

test("an SVG is refused too — it is a script container, not a raster image", async () => {
	const { workflow } = makeWorkflow();
	const { status } = await upload(workflow.id, { field: "context", mime: "image/svg+xml" });
	assert.equal(status, 400);
});

test("an image over the size limit is refused", async () => {
	const { workflow } = makeWorkflow();
	const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x41).toString("base64");
	const { status, json } = await upload(workflow.id, { field: "context", data: oversized });
	assert.equal(status, 400);
	assert.match(String(json.error), /too large/);
});

test("an empty body is refused", async () => {
	const { workflow } = makeWorkflow();
	const { status } = await upload(workflow.id, { field: "context", data: "" });
	assert.equal(status, 400);
});

test("an unknown field is refused", async () => {
	const { workflow } = makeWorkflow();
	const { status, json } = await upload(workflow.id, { field: "notes" });
	assert.equal(status, 400);
	assert.match(String(json.error), /invalid field/);
});

test("a step field without a stepId, and a context field with one, are both refused", async () => {
	const { workflow, step } = makeWorkflow();
	assert.equal((await upload(workflow.id, { field: "description" })).status, 400);
	assert.equal((await upload(workflow.id, { field: "acceptance" })).status, 400);
	const withStep = await upload(workflow.id, { field: "context", stepId: step.id });
	assert.equal(withStep.status, 400);
	assert.match(String(withStep.json.error), /belongs to the workflow/);
});

test("attaching to a step of another workflow is refused", async () => {
	const a = makeWorkflow();
	const b = makeWorkflow();
	const { status, json } = await upload(a.workflow.id, { field: "description", stepId: b.step.id });
	assert.equal(status, 404);
	assert.equal(json.error, "unknown_step");
});

test("attaching to an unknown workflow is refused", async () => {
	const { status, json } = await upload("nope", { field: "context" });
	assert.equal(status, 404);
	assert.equal(json.error, "unknown_workflow");
});

test("a context image is refused once the context has been injected — the agent would never see it", async () => {
	const { workflow } = makeWorkflow({ context: "background" });
	setContextInjected(workflow.id, true);
	const { status, json } = await upload(workflow.id, { field: "context" });
	assert.equal(status, 400);
	assert.equal(json.error, "context already injected");
});

test("filenames are reduced to something safe to put in a path", () => {
	assert.equal(sanitizeFilename("../../etc/passwd", "image/png"), "passwd.png");
	assert.equal(sanitizeFilename("my shot (2).PNG", "image/png"), "my_shot_2_.PNG");
	// A pasted screenshot has no name at all.
	assert.equal(sanitizeFilename("", "image/png"), "image.png");
	assert.equal(sanitizeFilename("noext", "image/jpeg"), "noext.jpg");
});

// --- read endpoints ---------------------------------------------------

test("GET /api/workflows/:id returns the context attachments on the workflow and the step ones on the step", async () => {
	const { workflow, step } = makeWorkflow({ criteria: "looks right" });
	const ctx = (await upload(workflow.id, { field: "context", filename: "ctx.png" })).json.attachment;
	const desc = (await upload(workflow.id, { field: "description", stepId: step.id, filename: "desc.png" })).json
		.attachment;
	const acc = (await upload(workflow.id, { field: "acceptance", stepId: step.id, filename: "acc.png" })).json
		.attachment;

	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { workflow: Record<string, any>; steps: Record<string, any>[] };

	assert.deepEqual(
		body.workflow.attachments.map((a: any) => a.id),
		[ctx.id],
		"the workflow carries only its context images",
	);
	// By id, not by position: uploading a context image materialises the workflow's
	// hub-owned context step, which sorts FIRST (order_index -1), so `steps[0]` is
	// no longer the step this test is about.
	const taskStep = body.steps.find((s: any) => s.id === step.id);
	assert.ok(taskStep, "the task step is still in the list, behind the context step");
	assert.equal(taskStep.kind, "task");
	assert.equal(body.steps[0].kind, "context", "the context step leads the list");
	const stepAttachments = taskStep.attachments as any[];
	assert.deepEqual(
		stepAttachments.map((a) => a.id).sort(),
		[desc.id, acc.id].sort(),
		"the step carries both of its fields' images",
	);
	// Discriminated by `field`, which is how the UI splits them per textarea.
	assert.equal(stepAttachments.find((a) => a.id === desc.id).field, "description");
	assert.equal(stepAttachments.find((a) => a.id === acc.id).field, "acceptance");
	// The absolute path is exposed, since it's what the agent is told to read.
	assert.ok(path.isAbsolute(stepAttachments[0].path));
});

test("GET /api/workflows/:id/attachments lists every attachment of the workflow at once", async () => {
	const { workflow, step } = makeWorkflow();
	const ctx = (await upload(workflow.id, { field: "context" })).json.attachment;
	const desc = (await upload(workflow.id, { field: "description", stepId: step.id })).json.attachment;
	const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/attachments`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { attachments: { id: string }[] };
	assert.deepEqual(body.attachments.map((a) => a.id).sort(), [ctx.id, desc.id].sort());
});

test("GET /api/attachments/:id/content serves the exact bytes with the right content type", async () => {
	const { workflow } = makeWorkflow();
	const a = (await upload(workflow.id, { field: "context" })).json.attachment;
	// Ungated on purpose: an <img> tag can't send an Authorization header.
	const res = await fetch(`${baseUrl}/api/attachments/${a.id}/content`, { headers: adminHeaders() });
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "image/png");
	assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG_BYTES);
});

test("GET /api/attachments/:id/content 404s for an unknown id and 410s when the file is gone", async () => {
	const { workflow } = makeWorkflow();
	assert.equal((await fetch(`${baseUrl}/api/attachments/nope/content`, { headers: adminHeaders() })).status, 404);
	const a = (await upload(workflow.id, { field: "context" })).json.attachment;
	fs.rmSync(a.path);
	const res = await fetch(`${baseUrl}/api/attachments/${a.id}/content`, { headers: adminHeaders() });
	assert.equal(res.status, 410);
});

// --- deletion ---------------------------------------------------------

test("DELETE /api/attachments/:id removes the row and the file, and is admin-gated", async () => {
	const { workflow } = makeWorkflow();
	const a = (await upload(workflow.id, { field: "context" })).json.attachment;

	assert.equal((await fetch(`${baseUrl}/api/attachments/${a.id}`, { method: "DELETE" })).status, 401);
	assert.ok(fs.existsSync(a.path), "the un-authorised attempt changed nothing");

	const res = await fetch(`${baseUrl}/api/attachments/${a.id}`, { method: "DELETE", headers: adminHeaders() });
	assert.equal(res.status, 200);
	assert.equal(fs.existsSync(a.path), false, "the file is gone from disk");
	assert.equal((await fetch(`${baseUrl}/api/attachments/${a.id}/content`, { headers: adminHeaders() })).status, 404);
	// And it's no longer reported by the workflow read.
	const detail = (await (await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers: adminHeaders() })).json()) as {
		workflow: { attachments: unknown[] };
	};
	assert.deepEqual(detail.workflow.attachments, []);
});

test("removing a step takes its images with it and leaves the workflow's context image alone", async () => {
	const { workflow, step } = makeWorkflow();
	const ctx = (await upload(workflow.id, { field: "context" })).json.attachment;
	const desc = (await upload(workflow.id, { field: "description", stepId: step.id })).json.attachment;

	removeStep(workflow.id, step.id);

	assert.equal(fs.existsSync(desc.path), false, "the step's image is gone");
	assert.ok(fs.existsSync(ctx.path), "the workflow's context image stays");
});

test("removing a workflow deletes its whole attachment directory", async () => {
	const { workflow, step } = makeWorkflow();
	const ctx = (await upload(workflow.id, { field: "context" })).json.attachment;
	const desc = (await upload(workflow.id, { field: "description", stepId: step.id })).json.attachment;
	const dir = path.join(tmpHome, "attachments", workflow.id);
	assert.ok(fs.existsSync(dir));

	removeWorkflow(workflow.id);

	assert.equal(fs.existsSync(ctx.path), false);
	assert.equal(fs.existsSync(desc.path), false);
	assert.equal(fs.existsSync(dir), false, "the directory itself is cleaned up too");
});

// --- the prompt: what the agent actually receives ---------------------
//
// The whole feature exists for these.

test("the composed step prompt carries the absolute paths of all three fields' images", async () => {
	const { workflow, step } = makeWorkflow({ context: "we are building a dashboard", criteria: "matches the mockup" });
	const ctx = (await upload(workflow.id, { field: "context", filename: "ctx.png" })).json.attachment;
	const desc = (await upload(workflow.id, { field: "description", stepId: step.id, filename: "desc.png" })).json
		.attachment;
	const acc = (await upload(workflow.id, { field: "acceptance", stepId: step.id, filename: "acc.png" })).json
		.attachment;

	const input = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, { injectContext: true });

	// The three paths are all there, absolute.
	assert.ok(input.includes(ctx.path), "the conversation-context image path is in the prompt");
	assert.ok(input.includes(desc.path), "the task-description image path is in the prompt");
	assert.ok(input.includes(acc.path), "the acceptance-criteria image path is in the prompt");
	// Each under a section that says which input it belongs to, and tells the
	// agent to Read it — a bare path list is something an agent skims past.
	assert.match(input, /attached to this workflow's conversation context/);
	assert.match(input, /attached to this step's task description/);
	assert.match(input, /attached to this step's acceptance criteria/);
	assert.equal((input.match(/with the Read tool/g) ?? []).length, 3, "one Read instruction per field");
	// The description's image is attached to the description, not floating at the
	// end: it appears before the acceptance-criterion sentence.
	assert.ok(
		input.indexOf(desc.path) < input.indexOf("MUST satisfy the following acceptance criterion"),
		"the description's image sits with the description",
	);
});

test("several images on one field are all listed, oldest first", async () => {
	const { workflow, step } = makeWorkflow();
	const first = (await upload(workflow.id, { field: "description", stepId: step.id, filename: "one.png" })).json
		.attachment;
	const second = (await upload(workflow.id, { field: "description", stepId: step.id, filename: "two.png" })).json
		.attachment;
	const input = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, {});
	assert.ok(input.includes(first.path) && input.includes(second.path));
	assert.ok(input.indexOf(first.path) < input.indexOf(second.path), "in upload order");
	assert.match(input, /Attached images/, "plural when there are several");
});

test("a step with no attachments composes exactly what it did before the feature existed", () => {
	const { workflow, step } = makeWorkflow({ criteria: "must be X" });
	const input = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, {});
	assert.equal(
		input,
		'do the thing\n\nThe result of this step MUST satisfy the following acceptance criterion, so aim explicitly to meet it: "must be X".' +
			stepResultsNote(getWorkflow(workflow.id)!.agentName) +
			"\n\nImportant: run this step by delegating the work to a subagent (the Task tool) instead of solving it yourself directly in this thread — this same session is reused sequentially for every step of the workflow, and delegating keeps the main thread lightweight.",
		"no attachments means no extra sections at all",
	);
});

test("the judge pass also gets the acceptance-criteria images — it cannot grade a mockup it cannot see", async () => {
	const { workflow, step } = makeWorkflow({ criteria: "matches the mockup" });
	const acc = (await upload(workflow.id, { field: "acceptance", stepId: step.id, filename: "mockup.png" })).json
		.attachment;
	const desc = (await upload(workflow.id, { field: "description", stepId: step.id, filename: "desc.png" })).json
		.attachment;

	const input = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, { mode: "judge" });

	assert.ok(input.includes(acc.path), "the criteria image is in the judge prompt");
	assert.equal(input.includes(desc.path), false, "the description's image is not — it isn't part of the criterion");
});

test("a context that is ONLY an image still produces a preamble", async () => {
	const { workflow, step } = makeWorkflow({ context: null });
	const ctx = (await upload(workflow.id, { field: "context", filename: "spec.png" })).json.attachment;
	const input = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, { injectContext: true });
	assert.match(input, /^Conversation context/);
	assert.ok(input.includes(ctx.path), "attaching a spec screenshot and writing nothing still reaches the agent");
});

test("context images are injected only when the context is (not on a resumed conversation)", async () => {
	const { workflow, step } = makeWorkflow({ context: "background" });
	const ctx = (await upload(workflow.id, { field: "context" })).json.attachment;
	const withContext = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, { injectContext: true });
	const without = composeStepInput(getStep(step.id)!, getWorkflow(workflow.id)!, { injectContext: false });
	assert.ok(withContext.includes(ctx.path));
	assert.equal(without.includes(ctx.path), false, "a later step resumes the session that already carries it");
});

test("attachmentSection returns nothing at all when there is nothing attached", () => {
	assert.equal(attachmentSection("attached to whatever", []), "");
});

// --- end to end: the string that really goes over the wire ------------

test("a real dispatch POSTs hook inputs containing all three fields' image paths", async () => {
	// A fake awb hook that records the body it is sent, so this asserts on the
	// actual wire payload rather than on the composer alone.
	const dispatched: { input: string }[] = [];
	const hook = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			dispatched.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
	// Registered before anything can throw: a listening server keeps the event
	// loop alive, so an assertion failure below would otherwise hang the whole
	// test FILE instead of just failing one test.
	test.after(() => hook.close());
	const hookAddress = hook.address();
	if (!hookAddress || typeof hookAddress === "string") throw new Error("fake hook did not bind");

	const { workflow, step } = makeWorkflow({
		context: "the design system is in docs/",
		criteria: "pixel-matches the mockup",
		hookUrl: `http://127.0.0.1:${hookAddress.port}/hook/agent`,
	});
	const ctx = (await upload(workflow.id, { field: "context", filename: "palette.png" })).json.attachment;
	const desc = (await upload(workflow.id, { field: "description", stepId: step.id, filename: "wireframe.png" })).json
		.attachment;
	const acc = (await upload(workflow.id, { field: "acceptance", stepId: step.id, filename: "mockup.png" })).json
		.attachment;

	// The conversation context now travels as its OWN dispatch (the hub-owned
	// context step, materialised by the upload above), so the images arrive over
	// two turns rather than one: the context's on the context step, the step's own
	// two on the step. Both are real POSTs to the hook, which is the point of this
	// test — it asserts on the wire payload, not on the composer.
	const contextStep = getContextStep(workflow.id);
	assert.ok(contextStep, "attaching a context image materialised the context step");
	await dispatchStep(contextStep, getWorkflow(workflow.id)!, cfg, silent);
	await dispatchStep(getStep(step.id)!, getWorkflow(workflow.id)!, cfg, silent);

	assert.equal(dispatched.length, 2, "the hook was called for the context step and for the step");
	const contextInput = dispatched[0].input;
	const stepInput = dispatched[1].input;
	for (const [label, attachment, input] of [
		["conversation context", ctx, contextInput],
		["task description", desc, stepInput],
		["acceptance criteria", acc, stepInput],
	] as const) {
		assert.ok(input.includes(attachment.path), `the ${label} image path reached the hook`);
		// And the path really points at a readable file — the agent's Read would work.
		assert.deepEqual(fs.readFileSync(attachment.path), PNG_BYTES);
	}
	// And the step's own dispatch is clean: the background is not glued to it.
	assert.equal(stepInput.includes(ctx.path), false, "the context image is not repeated on the step");
	assert.doesNotMatch(stepInput, /Conversation context/);
});

test("saveAttachment keeps a workflow's images in one stable directory across fields and steps", () => {
	const { workflow, step } = makeWorkflow();
	const a = saveAttachment({
		workflowId: workflow.id,
		stepId: null,
		field: "context",
		filename: "a.png",
		mime: "image/png",
		data: PNG_BYTES,
	});
	const b = saveAttachment({
		workflowId: workflow.id,
		stepId: step.id,
		field: "acceptance",
		filename: "b.png",
		mime: "image/png",
		data: PNG_BYTES,
	});
	// Same directory regardless of which field/step it belongs to: that's what
	// makes a path stable for the workflow's lifetime.
	assert.equal(path.dirname(a.path), path.dirname(b.path));
	assert.notEqual(a.path, b.path, "but distinct files");
});
