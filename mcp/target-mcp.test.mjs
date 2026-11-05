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
