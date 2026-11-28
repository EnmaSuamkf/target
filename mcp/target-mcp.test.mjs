/**
 * add_step_note in the Target MCP server: the hub request it builds marks the
 * note as an agent note, the tool's input schema does not let the agent choose
 * the source, and the request/response path still works end to end.
 *
 * Run by `npm test` at the repo root (`node --test mcp/target-mcp.test.mjs`).
 */
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const mcpPath = fileURLToPath(new URL("./target-mcp.mjs", import.meta.url));
const { buildStepNoteRequest } = await import("./target-mcp.mjs");

test("buildStepNoteRequest posts the note with source agent", () => {
	const req = buildStepNoteRequest({ workflowId: "wf 1", stepId: "s/2", content: "checked the logs", theme: "warning" });
	assert.equal(req.method, "POST");
	assert.equal(req.path, "/api/workflows/wf%201/steps/s%2F2/notes");
	assert.deepEqual(req.body, { content: "checked the logs", theme: "warning", source: "agent" });
});

test("buildStepNoteRequest sends source agent without a theme", () => {
	const req = buildStepNoteRequest({ workflowId: "wf", stepId: "s", content: "no theme" });
	assert.deepEqual(req.body, { content: "no theme", source: "agent" });
});

test("buildStepNoteRequest ignores any source passed in the arguments", () => {
	const req = buildStepNoteRequest({ workflowId: "wf", stepId: "s", content: "x", source: "operator" });
	assert.equal(req.body.source, "agent");
});

/** Runs the server as a child process and returns a `request(msg)` that resolves with the reply to `msg.id`. */
function startServer(env) {
	const child = spawn(process.execPath, [mcpPath], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
	const replies = new Map();
	const waiters = new Map();
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line) {
				const msg = JSON.parse(line);
				const waiter = waiters.get(msg.id);
				if (waiter) {
					waiters.delete(msg.id);
					waiter(msg);
				} else {
					replies.set(msg.id, msg);
				}
			}
			nl = buffer.indexOf("\n");
		}
	});
	const request = (msg) =>
		new Promise((resolve) => {
			if (replies.has(msg.id)) return resolve(replies.get(msg.id));
			waiters.set(msg.id, resolve);
			child.stdin.write(`${JSON.stringify(msg)}\n`);
		});
	const stop = () => {
		child.stdin.end();
		child.kill();
	};
	return { request, stop };
}

test("tools/list describes add_step_note as an agent note and offers no source parameter", async () => {
	const server = startServer({ TARGET_HUB_URL: "http://127.0.0.1:1", TARGET_ADMIN_TOKEN: "unused" });
	try {
		const reply = await server.request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		const tool = reply.result.tools.find((t) => t.name === "add_step_note");
		assert.ok(tool, "add_step_note is still listed under the same name");
		assert.match(tool.description, /agent note/);
		assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["content", "stepId", "theme", "workflowId"]);
		assert.deepEqual(tool.inputSchema.required, ["workflowId", "stepId", "content"]);
		assert.equal(tool.inputSchema.additionalProperties, false);
	} finally {
		server.stop();
	}
});

test("tools/call add_step_note sends source agent to the hub and returns the hub's note unchanged", async () => {
	const captured = [];
	const hub = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			captured.push({ method: req.method, url: req.url, body: JSON.parse(raw || "{}"), auth: req.headers.authorization });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ note: { id: "n1", content: "from the agent", theme: "neutral", source: "agent" } }));
		});
	});
	await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
	const { port } = hub.address();
	const server = startServer({ TARGET_HUB_URL: `http://127.0.0.1:${port}`, TARGET_ADMIN_TOKEN: "test-admin-token" });
	try {
		const reply = await server.request({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "add_step_note", arguments: { workflowId: "wf-1", stepId: "step-1", content: "from the agent" } },
		});
		assert.equal(captured.length, 1);
		assert.equal(captured[0].method, "POST");
		assert.equal(captured[0].url, "/api/workflows/wf-1/steps/step-1/notes");
		assert.deepEqual(captured[0].body, { content: "from the agent", source: "agent" });
		assert.equal(captured[0].auth, "Bearer test-admin-token");

		assert.equal(reply.result.isError, undefined);
		assert.deepEqual(JSON.parse(reply.result.content[0].text), {
			note: { id: "n1", content: "from the agent", theme: "neutral", source: "agent" },
		});
	} finally {
		server.stop();
		hub.close();
	}
});

/** A stand-in hub: records each request and answers with what `respond` returns. */
async function withHub(respond, run) {
	const captured = [];
	const hub = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = raw ? JSON.parse(raw) : undefined;
			captured.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
			const { status = 200, payload } = respond({ method: req.method, url: req.url, body }) ?? {};
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(payload ?? {}));
		});
	});
	await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
	const { port } = hub.address();
	const server = startServer({ TARGET_HUB_URL: `http://127.0.0.1:${port}`, TARGET_ADMIN_TOKEN: "test-admin-token" });
	try {
		return await run(server, captured);
	} finally {
		server.stop();
		hub.close();
	}
}

async function listTools() {
	const server = startServer({ TARGET_HUB_URL: "http://127.0.0.1:1", TARGET_ADMIN_TOKEN: "unused" });
	try {
		const reply = await server.request({ jsonrpc: "2.0", id: 90, method: "tools/list" });
		return reply.result.tools;
	} finally {
		server.stop();
	}
}

test("the pipeline read tools and the writers are listed under their names", async () => {
	const names = (await listTools()).map((t) => t.name);
	for (const name of ["list_pipelines", "get_pipeline", "create_pipeline", "update_pipeline"]) {
		assert.ok(names.includes(name), `${name} is listed`);
	}
});

test("add_step and edit_step accept kind, pipelineId and pipelineInputs", async () => {
	const tools = await listTools();
	for (const name of ["add_step", "edit_step"]) {
		const props = tools.find((t) => t.name === name).inputSchema.properties;
		assert.deepEqual(props.kind.enum, ["task", "command"], `${name}.kind is task|command`);
		assert.equal(props.pipelineId.type, "string", `${name}.pipelineId is a string`);
		assert.equal(props.pipelineInputs.type, "object", `${name}.pipelineInputs is an object`);
		assert.deepEqual(props.pipelineInputs.additionalProperties, { type: "string" }, `${name}.pipelineInputs values are strings`);
		assert.deepEqual(props.onSuccessTask.type, ["string", "null"], `${name}.onSuccessTask is a string or null`);
		assert.deepEqual(props.onFailureTask.type, ["string", "null"], `${name}.onFailureTask is a string or null`);
	}
});

test("no tool approves a pipeline or reads or writes a secret", async () => {
	const names = (await listTools()).map((t) => t.name);
	const forbidden = names.filter((name) => /approv|secret/i.test(name));
	assert.deepEqual(forbidden, [], "no approve or secret tool is listed");
});

test("create_pipeline says the saved pipeline stays untrusted until an operator approves it", async () => {
	const tool = (await listTools()).find((t) => t.name === "create_pipeline");
	assert.match(tool.description, /UNTRUSTED/);
	assert.match(tool.description, /operator approves it in the hub UI/);
});

test("list_pipelines filters by name or tag on the client and calls the hub's list route", async () => {
	const pipelines = [
		{ id: "p1", name: "deploy-staging", tags: ["ops"] },
		{ id: "p2", name: "verify", tags: ["ci", "Deploy-Tag"] },
		{ id: "p3", name: "lint", tags: [] },
	];
	await withHub(
		() => ({ payload: { pipelines } }),
		async (server, captured) => {
			const reply = await server.request({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "list_pipelines", arguments: { q: "deploy" } },
			});
			assert.equal(captured[0].method, "GET");
			assert.equal(captured[0].url, "/api/pipelines");
			assert.equal(captured[0].auth, "Bearer test-admin-token");
			const ids = JSON.parse(reply.result.content[0].text).pipelines.map((p) => p.id);
			assert.deepEqual(ids, ["p1", "p2"], "matches the name in one and the tag in the other, case-insensitively");
		},
	);
});

test("get_pipeline reads one pipeline by id", async () => {
	await withHub(
		() => ({ payload: { pipeline: { id: "p 1", name: "verify" } } }),
		async (server, captured) => {
			await server.request({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "get_pipeline", arguments: { pipelineId: "p 1" } },
			});
			assert.equal(captured[0].method, "GET");
			assert.equal(captured[0].url, "/api/pipelines/p%201");
		},
	);
});

test("add_step sends the command fields to the hub unchanged", async () => {
	await withHub(
		() => ({ status: 200, payload: { step: { id: "s1" } } }),
		async (server, captured) => {
			await server.request({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: {
					name: "add_step",
					arguments: {
						workflowId: "wf-1",
						description: "",
						kind: "command",
						pipelineId: "p1",
						pipelineInputs: { branch: "main" },
					},
				},
			});
			assert.equal(captured[0].method, "POST");
			assert.equal(captured[0].url, "/api/workflows/wf-1/steps");
			assert.equal(captured[0].body.kind, "command");
			assert.equal(captured[0].body.pipelineId, "p1");
			assert.deepEqual(captured[0].body.pipelineInputs, { branch: "main" });
		},
	);
});

// ---------------------------------------------------------------------------
// Failure recovery: step fields, the workflow's recovery model, and the
// reopen_step / set_workflow_model / set_recovery_model tools.
// ---------------------------------------------------------------------------

/** Calls one tool against a stand-in hub and returns what the hub received. */
async function callTool(name, args, respond = () => ({ payload: { ok: true } })) {
	return withHub(respond, async (server, captured) => {
		const reply = await server.request({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name, arguments: args } });
		return { reply, captured };
	});
}

test("add_step and edit_step expose recoverOnFailure (boolean) and maxRecoveries (integer ≥ 0)", async () => {
	const tools = await listTools();
	for (const name of ["add_step", "edit_step"]) {
		const tool = tools.find((t) => t.name === name);
		const props = tool.inputSchema.properties;
		assert.equal(props.recoverOnFailure.type, "boolean", `${name}.recoverOnFailure is a boolean`);
		assert.match(props.recoverOnFailure.description, /Failure recovery when this step fails for good/);
		assert.equal(props.maxRecoveries.type, "integer", `${name}.maxRecoveries is an integer`);
		assert.equal(props.maxRecoveries.minimum, 0, `${name}.maxRecoveries has minimum 0`);
		assert.match(props.maxRecoveries.description, /default 1/);
		assert.match(tool.description, /Failure recovery/);
		assert.ok(!(tool.inputSchema.required ?? []).includes("recoverOnFailure"), "recoverOnFailure is optional");
		assert.ok(!(tool.inputSchema.required ?? []).includes("maxRecoveries"), "maxRecoveries is optional");
	}
});

test("create_workflow and clone_workflow expose recoveryModel", async () => {
	const tools = await listTools();
	const create = tools.find((t) => t.name === "create_workflow").inputSchema.properties;
	assert.equal(create.recoveryModel.type, "string");
	assert.match(create.recoveryModel.description, /list_runners models\[\]/);
	const clone = tools.find((t) => t.name === "clone_workflow").inputSchema.properties;
	assert.deepEqual(clone.recoveryModel.type, ["string", "null"]);
	assert.match(clone.recoveryModel.description, /omit to inherit/);
});

test("reopen_step, set_workflow_model and set_recovery_model are listed with their parameters", async () => {
	const tools = await listTools();
	const reopen = tools.find((t) => t.name === "reopen_step");
	assert.ok(reopen, "reopen_step is listed");
	assert.deepEqual(Object.keys(reopen.inputSchema.properties).sort(), ["stepId", "workflowId"]);
	assert.deepEqual(reopen.inputSchema.required, ["workflowId", "stepId"]);
	assert.equal(reopen.inputSchema.additionalProperties, false);
	assert.match(reopen.description, /retries reset/);
	assert.match(reopen.description, /recovery count/);
	for (const name of ["set_workflow_model", "set_recovery_model"]) {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `${name} is listed`);
		assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["model", "workflowId"]);
		assert.deepEqual(tool.inputSchema.required, ["workflowId", "model"]);
		assert.deepEqual(tool.inputSchema.properties.model.type, ["string", "null"], `${name}.model is a string or null`);
		assert.equal(tool.inputSchema.additionalProperties, false);
	}
	assert.match(tools.find((t) => t.name === "set_recovery_model").description, /Failure recovery/);
});

test("add_step forwards recoverOnFailure and maxRecoveries to the hub", async () => {
	const { captured } = await callTool("add_step", {
		workflowId: "wf-1",
		description: "build it",
		recoverOnFailure: true,
		maxRecoveries: 3,
	});
	assert.equal(captured[0].method, "POST");
	assert.equal(captured[0].url, "/api/workflows/wf-1/steps");
	assert.equal(captured[0].body.recoverOnFailure, true);
	assert.equal(captured[0].body.maxRecoveries, 3);
});

test("add_step forwards recoverOnFailure false and maxRecoveries 0", async () => {
	const { captured } = await callTool("add_step", {
		workflowId: "wf-1",
		description: "build it",
		recoverOnFailure: false,
		maxRecoveries: 0,
	});
	assert.equal(captured[0].body.recoverOnFailure, false);
	assert.equal(captured[0].body.maxRecoveries, 0);
});

test("add_step without the recovery fields sends neither (the hub defaults apply)", async () => {
	const { captured } = await callTool("add_step", { workflowId: "wf-1", description: "build it" });
	assert.ok(!("recoverOnFailure" in captured[0].body));
	assert.ok(!("maxRecoveries" in captured[0].body));
});

test("edit_step sends the recovery fields only when given (omitted = unchanged)", async () => {
	const omitted = await callTool("edit_step", { workflowId: "wf-1", stepId: "s 1", description: "new text" });
	assert.equal(omitted.captured[0].method, "PATCH");
	assert.equal(omitted.captured[0].url, "/api/workflows/wf-1/steps/s%201");
	assert.deepEqual(omitted.captured[0].body, { description: "new text" }, "only the given field is sent");

	const onlyToggle = await callTool("edit_step", { workflowId: "wf-1", stepId: "s1", description: "d", recoverOnFailure: true });
	assert.deepEqual(onlyToggle.captured[0].body, { description: "d", recoverOnFailure: true }, "maxRecoveries stays unchanged");

	const both = await callTool("edit_step", {
		workflowId: "wf-1",
		stepId: "s1",
		description: "d",
		recoverOnFailure: false,
		maxRecoveries: 2,
	});
	assert.deepEqual(both.captured[0].body, { description: "d", recoverOnFailure: false, maxRecoveries: 2 });
});

test("create_workflow forwards recoveryModel, and omits it when not given", async () => {
	const withModel = await callTool("create_workflow", { name: "wf", runner: "claude", recoveryModel: "claude-opus-5-5" });
	assert.equal(withModel.captured[0].method, "POST");
	assert.equal(withModel.captured[0].url, "/api/workflows");
	assert.equal(withModel.captured[0].body.recoveryModel, "claude-opus-5-5");

	const without = await callTool("create_workflow", { name: "wf", runner: "claude" });
	assert.ok(!("recoveryModel" in without.captured[0].body));
});

test("clone_workflow forwards recoveryModel, maps null to the CLI default, and inherits when omitted", async () => {
	const form = { workflowId: "src 1", name: "copy", runner: "claude", sandbox: "none" };
	const set = await callTool("clone_workflow", { ...form, recoveryModel: "claude-sonnet-5-5" });
	assert.equal(set.captured[0].method, "POST");
	assert.equal(set.captured[0].url, "/api/workflows/src%201/clone");
	assert.equal(set.captured[0].body.recoveryModel, "claude-sonnet-5-5");

	const cleared = await callTool("clone_workflow", { ...form, recoveryModel: null });
	assert.equal(cleared.captured[0].body.recoveryModel, "", "null = CLI default");

	const inherited = await callTool("clone_workflow", form);
	assert.ok(!("recoveryModel" in inherited.captured[0].body), "omitted = inherit the source's");

	const plain = await callTool("clone_workflow", { workflowId: "src", recoveryModel: "claude-haiku-5-5" });
	assert.deepEqual(plain.captured[0].body, { recoveryModel: "claude-haiku-5-5" }, "a plain copy still carries it");

	const plainInherit = await callTool("clone_workflow", { workflowId: "src" });
	assert.equal(plainInherit.captured[0].body, undefined, "a plain copy without it sends no body");
});

test("reopen_step posts to the hub's reopen route", async () => {
	const { captured, reply } = await callTool("reopen_step", { workflowId: "wf 1", stepId: "s/2" }, () => ({
		payload: { step: { id: "s/2", status: "pending", retryCount: 0, recoveryCount: 1 } },
	}));
	assert.equal(captured.length, 1);
	assert.equal(captured[0].method, "POST");
	assert.equal(captured[0].url, "/api/workflows/wf%201/steps/s%2F2/reopen");
	assert.equal(captured[0].auth, "Bearer test-admin-token");
	assert.equal(JSON.parse(reply.result.content[0].text).step.recoveryCount, 1);
});

test("reopen_step reports the hub's refusal as a tool error", async () => {
	const { reply } = await callTool("reopen_step", { workflowId: "wf", stepId: "s" }, () => ({
		status: 400,
		payload: { error: "step_not_failed" },
	}));
	assert.equal(reply.result.isError, true);
	assert.match(reply.result.content[0].text, /step_not_failed/);
});

test("set_workflow_model patches the model route; null clears it", async () => {
	const set = await callTool("set_workflow_model", { workflowId: "wf 1", model: "claude-opus-5-5" });
	assert.equal(set.captured[0].method, "PATCH");
	assert.equal(set.captured[0].url, "/api/workflows/wf%201/model");
	assert.deepEqual(set.captured[0].body, { model: "claude-opus-5-5" });

	const cleared = await callTool("set_workflow_model", { workflowId: "wf", model: null });
	assert.deepEqual(cleared.captured[0].body, { model: "" }, "the model route clears on an empty model");
});

test("set_recovery_model patches the recovery-model route; null clears it", async () => {
	const set = await callTool("set_recovery_model", { workflowId: "wf 1", model: "claude-sonnet-5-5" });
	assert.equal(set.captured[0].method, "PATCH");
	assert.equal(set.captured[0].url, "/api/workflows/wf%201/recovery-model");
	assert.deepEqual(set.captured[0].body, { recoveryModel: "claude-sonnet-5-5" });

	const cleared = await callTool("set_recovery_model", { workflowId: "wf", model: null });
	assert.deepEqual(cleared.captured[0].body, { recoveryModel: null });

	const blank = await callTool("set_recovery_model", { workflowId: "wf", model: "  " });
	assert.deepEqual(blank.captured[0].body, { recoveryModel: null }, "a blank model is the CLI default too");
});
