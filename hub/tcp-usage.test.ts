import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-tcp-usage-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { insertWorkflow, setContextInjected } = await import("./db.ts");
const { insertTemplate } = await import("./db.ts");
const { insertTcp, setWorkflowTcpSelections } = await import("./tcp-store.ts");
const { getTcpUsage, tcpToolNamesAtRisk, tcpUsageHasReferences } = await import("./tcp-usage.ts");

test("getTcpUsage lists workflows and templates referencing an TCP", () => {
	const tcp = insertTcp({
		name: "github",
		tools: [
			{ name: "get_me", description: "me", requestTemplate: "curl https://example.com/me", inputs: [], tokens: {} },
			{ name: "list_repos", description: "repos", requestTemplate: "curl https://example.com/repos", inputs: [], tokens: {} },
		],
	});
	insertTemplate({
		name: "tpl-all",
		steps: [{ description: "x" }],
		tcpSelections: [{ tcpId: tcp.id }],
	});
	insertTemplate({
		name: "tpl-one",
		steps: [{ description: "y" }],
		tcpSelections: [{ tcpId: tcp.id, toolNames: ["get_me"] }],
	});
	const workflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "wf-partial",
		agentName: "usage-agent",
		hookUrl: "http://127.0.0.1/hook/u",
		secret: "s",
		mdPath: path.join(tmpHome, "w.md"),
	});
	setWorkflowTcpSelections(workflow.id, [{ tcpId: tcp.id, toolNames: ["list_repos"] }]);

	const usage = getTcpUsage(tcp.id);
	assert.ok(usage);
	assert.equal(usage.workflows.length, 1);
	assert.equal(usage.workflows[0]?.name, "wf-partial");
	assert.deepEqual(usage.workflows[0]?.toolNames, ["list_repos"]);
	assert.equal(usage.templates.length, 2);
});

test("getTcpUsage filtered to a tool includes whole-pack selections", () => {
	const tcp = insertTcp({
		name: "pack",
		tools: [
			{ name: "a", description: "A", requestTemplate: "curl https://example.com/a", inputs: [], tokens: {} },
			{ name: "b", description: "B", requestTemplate: "curl https://example.com/b", inputs: [], tokens: {} },
		],
	});
	insertTemplate({
		name: "all-tools",
		steps: [{ description: "x" }],
		tcpSelections: [{ tcpId: tcp.id }],
	});
	insertTemplate({
		name: "only-b",
		steps: [{ description: "y" }],
		tcpSelections: [{ tcpId: tcp.id, toolNames: ["b"] }],
	});

	const usage = getTcpUsage(tcp.id, ["a"]);
	assert.ok(usage);
	assert.equal(usage.templates.length, 1);
	assert.equal(usage.templates[0]?.name, "all-tools");
});

test("getTcpUsage reports contextInjected for workflows", () => {
	const tcp = insertTcp({
		name: "pack",
		tools: [{ name: "a", description: "A", requestTemplate: "curl https://example.com/a", inputs: [], tokens: {} }],
	});
	const pending = insertWorkflow({
		id: crypto.randomUUID(),
		name: "pending-wf",
		agentName: "usage-agent-pending",
		hookUrl: "http://127.0.0.1/hook/p",
		secret: "s",
		mdPath: path.join(tmpHome, "pending.md"),
	});
	const injected = insertWorkflow({
		id: crypto.randomUUID(),
		name: "injected-wf",
		agentName: "usage-agent-injected",
		hookUrl: "http://127.0.0.1/hook/i",
		secret: "s",
		mdPath: path.join(tmpHome, "injected.md"),
	});
	setWorkflowTcpSelections(pending.id, [{ tcpId: tcp.id }]);
	setWorkflowTcpSelections(injected.id, [{ tcpId: tcp.id }]);
	setContextInjected(injected.id, true);

	const usage = getTcpUsage(tcp.id);
	assert.ok(usage);
	assert.equal(usage.workflows.length, 2);
	assert.deepEqual(
		usage.workflows.map((workflow) => ({ name: workflow.name, contextInjected: workflow.contextInjected })),
		[
			{ name: "injected-wf", contextInjected: true },
			{ name: "pending-wf", contextInjected: false },
		],
	);
});

test("tcpToolNamesAtRisk detects removed or renamed tools", () => {
	const before = [
		{ name: "keep", description: "", requestTemplate: "curl https://x", inputs: [], tokens: {} },
		{ name: "gone", description: "", requestTemplate: "curl https://y", inputs: [], tokens: {} },
	];
	const after = [
		{ name: "keep", description: "", requestTemplate: "curl https://x", inputs: [], tokens: {} },
		{ name: "renamed", description: "", requestTemplate: "curl https://y", inputs: [], tokens: {} },
	];
	assert.deepEqual(tcpToolNamesAtRisk(before, after), ["gone"]);
	assert.equal(tcpUsageHasReferences({ workflows: [], templates: [{ id: "1", name: "t", toolNames: ["a"] }] }), true);
});
