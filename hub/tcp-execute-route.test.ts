/**
 * The other half of TCP: actually running a tool.
 *
 * The catalog injected into a step used to tell the agent to emit a
 * `tcpExecute` JSON block and promise that "the hub runs the request". Nothing
 * read that block — `executeTcpTool` was reachable only from the operator's own
 * admin-gated route — so a perfectly obedient agent wrote a well-formed call
 * into its output and nobody ever picked it up. The catalog now hands the agent
 * a url it can POST to, and this suite is the proof that the loop closes.
 *
 * The credential is the step's existing `callbackToken`, the same one the
 * result/started callbacks use, and NOT the admin token — so the scope of a
 * leaked prompt is bounded. That scoping is asserted here too: a step may run
 * the tools its own workflow attached, and nothing else.
 *
 * Everything runs against the real HTTP server, plus a throwaway upstream that
 * stands in for the API the tool calls, so this exercises the whole chain the
 * agent would: request → auth → scope → curl template → upstream → result.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-tcp-execute-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { insertWorkflow, insertStep, getStep } = await import("./db.ts");
const { insertTcp, setWorkflowTcps } = await import("./tcp-store.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

// The API the TCP tool points at. Answers a tiny JSON body so a success is
// distinguishable from "the request never left the hub".
const upstream = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ login: "acceptance-user", path: req.url }));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddr = upstream.address();
if (!upstreamAddr || typeof upstreamAddr === "string") throw new Error("upstream did not bind");
const upstreamUrl = `http://127.0.0.1:${upstreamAddr.port}/user`;

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
	upstream.close();
});

const tcp = insertTcp({
	name: "github",
	tools: [
		{
			name: "get_me",
			description: "Gets the authenticated user",
			requestTemplate: `curl -X GET ${upstreamUrl}`,
			inputs: [],
			tokens: {},
		},
	],
});

// A second pack the workflow does NOT attach — the thing the scope check is for.
const otherTcp = insertTcp({
	name: "unattached",
	tools: [
		{
			name: "secret",
			description: "Not for this workflow",
			requestTemplate: `curl -X GET ${upstreamUrl}`,
			inputs: [],
			tokens: {},
		},
	],
});

const workflow = insertWorkflow({
	id: crypto.randomUUID(),
	name: "tcp-exec",
	agentName: "agent-tcp-exec",
	hookUrl: "http://127.0.0.1/hook/x",
	secret: "s",
	mdPath: path.join(tmpHome, "w.md"),
});
setWorkflowTcps(workflow.id, [tcp.id]);
const step = getStep(insertStep(workflow.id, "call the tool").id)!;

function execUrl(stepId: string, token: string) {
	return `${baseUrl}/api/tcps/execute?stepId=${stepId}&token=${token}`;
}

test("a running step's agent can execute an attached tool with no admin token", async () => {
	// Exactly what the agent does with the url the catalog gave it: no cookie, no
	// admin bearer, just the step credential in the query string.
	const res = await fetch(execUrl(step.id, step.callbackToken), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tcpId: tcp.id, toolName: "get_me" }),
	});
	assert.equal(res.status, 200);
	const { result } = (await res.json()) as { result: { ok: boolean; status: number; body: string } };
	assert.equal(result.ok, true);
	assert.equal(result.status, 200);
	// The upstream really answered — the request left the hub.
	assert.equal((JSON.parse(result.body) as { login: string }).login, "acceptance-user");
});

test("a wrong or missing step token is refused", async () => {
	const bad = await fetch(execUrl(step.id, "not-the-token"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tcpId: tcp.id, toolName: "get_me" }),
	});
	assert.equal(bad.status, 401);

	const none = await fetch(`${baseUrl}/api/tcps/execute`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tcpId: tcp.id, toolName: "get_me" }),
	});
	assert.equal(none.status, 401);
});

test("a step's credential does NOT reach a tool its workflow never attached", async () => {
	// The whole point of not handing the agent the admin token: the blast radius
	// of a leaked prompt is this workflow's own selection.
	const res = await fetch(execUrl(step.id, step.callbackToken), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tcpId: otherTcp.id, toolName: "secret" }),
	});
	assert.equal(res.status, 403);
	assert.equal(((await res.json()) as { error: string }).error, "tool_not_attached_to_workflow");
});

test("another step's token does not work for this workflow's tools", async () => {
	const otherWorkflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "tcp-exec-other",
		agentName: "agent-other",
		hookUrl: "http://127.0.0.1/hook/y",
		secret: "s",
		mdPath: path.join(tmpHome, "w2.md"),
	});
	const otherStep = getStep(insertStep(otherWorkflow.id, "unrelated").id)!;
	// Valid token, but for a step whose workflow has nothing attached.
	const res = await fetch(execUrl(otherStep.id, otherStep.callbackToken), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tcpId: tcp.id, toolName: "get_me" }),
	});
	assert.equal(res.status, 403);
});

test("the operator's admin path still works", async () => {
	// Regression: the UI's execute button predates all of this and is unscoped
	// on purpose — the operator may run any tool on the machine.
	const res = await fetch(`${baseUrl}/api/tcps/execute`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` },
		body: JSON.stringify({ tcpId: otherTcp.id, toolName: "secret" }),
	});
	assert.equal(res.status, 200);
	const { result } = (await res.json()) as { result: { ok: boolean } };
	assert.equal(result.ok, true);
});

test("a tool name that is not in the workflow's selection is out of scope", async () => {
	const res = await fetch(execUrl(step.id, step.callbackToken), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tcpId: tcp.id, toolName: "no_such_tool" }),
	});
	// Scope is checked first, and an unselected name is out of scope.
	assert.equal(res.status, 403);
});
