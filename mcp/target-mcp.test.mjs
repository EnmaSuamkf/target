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
