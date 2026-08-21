import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-tcps-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const {
	deleteTcp,
	getTcp,
	importTcps,
	insertTcp,
	listTcps,
	tcpBundle,
	parseTcpBundle,
	setWorkflowTcps,
	updateTcp,
} = await import("./tcp-store.ts");
const { insertWorkflow } = await import("./db.ts");
const { parseCurlTemplate, validateInputs } = await import("./tcp-executor.ts");

test("insertTcp stores tools and tokens", () => {
	const tcp = insertTcp({
		name: "github",
		tools: [
			{
				name: "get_me",
				description: "profile",
				requestTemplate: "curl -X GET https://api.github.com/user -H 'Authorization: Bearer $TOKEN_1'",
				inputs: [],
				tokens: { TOKEN_1: "secret" },
			},
		],
	});
	assert.equal(tcp.tools.length, 1);
	assert.equal(getTcp(tcp.id)?.name, "github");
});

test("bundle export strips token values", () => {
	const tcp = insertTcp({
		name: "x",
		tools: [
			{
				name: "t",
				description: "d",
				requestTemplate: "curl https://example.com",
				inputs: [],
				tokens: { TOKEN_1: "secret" },
			},
		],
	});
	const bundle = tcpBundle([tcp]);
	assert.equal(bundle.tcps[0]?.tools[0]?.tokens.TOKEN_1, "");
});

test("importTcps creates copies", () => {
	const entries = parseTcpBundle({
		kind: "target.tcps",
		schemaVersion: 1,
		tcps: [{ name: "imported", tags: [], tools: [] }],
	});
	const created = importTcps(entries);
	assert.equal(created.length, 1);
	assert.equal(created[0]?.name, "imported");
});

test("setWorkflowTcps attaches TCPs to workflow", () => {
	const tcp = insertTcp({ name: "one", tools: [] });
	const wf = insertWorkflow({
		id: crypto.randomUUID(),
		name: "wf",
		agentName: "a",
		hookUrl: "http://x/h",
		secret: "s",
		mdPath: path.join(tmpHome, "w.md"),
	});
	setWorkflowTcps(wf.id, [tcp.id]);
	const again = getTcp(tcp.id);
	assert.ok(again);
	deleteTcp(tcp.id);
});

test("parseCurlTemplate reads URL and headers in any order", () => {
	const parsed = parseCurlTemplate(
		"curl -X GET https://api.github.com/user -H 'Authorization: Bearer tok' -H 'Accept: application/json'",
	);
	assert.equal(parsed.method, "GET");
	assert.equal(parsed.url, "https://api.github.com/user");
	assert.equal(parsed.headers.Authorization, "Bearer tok");
});

test("validateInputs reports missing required inputs", () => {
	const missing = validateInputs(
		{
			name: "t",
			description: "d",
			requestTemplate: "curl https://x -d '{\"a\":\"$INPUT_A\"}'",
			inputs: [{ name: "a", placeholder: "$INPUT_A", description: "a", required: true }],
			tokens: {},
		},
		{},
	);
	assert.deepEqual(missing, ["a"]);
});
