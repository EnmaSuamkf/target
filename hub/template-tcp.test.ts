/**
 * Templates carry TCP selections; using a template attaches those TCPs/tools to the workflow.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-template-tcp-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { insertWorkflow } = await import("./db.ts");
const { insertTemplate, templateBundle, parseTemplateBundle, importTemplates } = await import("./db.ts");
const {
	insertTcp,
	listWorkflowTcpIds,
	listWorkflowTcpSelections,
	applyTemplateTcpsToWorkflow,
	setWorkflowTcpSelections,
} = await import("./tcp-store.ts");
const { tcpCatalogPreamble } = await import("./tcp-catalog.ts");

test("template stores whole TCP and applying it attaches to workflow", () => {
	const tcp = insertTcp({ name: "github", tools: [] });
	const template = insertTemplate({
		name: "with-tcp",
		steps: [{ description: "use github tools" }],
		tcpIds: [tcp.id],
	});
	assert.deepEqual(template.tcpIds, [tcp.id]);
	assert.deepEqual(template.tcpSelections, [{ tcpId: tcp.id }]);

	const workflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "from-template",
		agentName: "agent",
		hookUrl: "http://127.0.0.1/hook/x",
		secret: "s",
		mdPath: path.join(tmpHome, "w.md"),
	});
	assert.deepEqual(listWorkflowTcpIds(workflow.id), []);

	applyTemplateTcpsToWorkflow(workflow.id, template.tcpSelections);
	assert.deepEqual(listWorkflowTcpIds(workflow.id), [tcp.id]);
});

test("template can store a single-tool selection", () => {
	const tcp = insertTcp({
		name: "multi",
		tools: [
			{ name: "a", description: "A", requestTemplate: "curl https://example.com/a", inputs: [], tokens: {} },
			{ name: "b", description: "B", requestTemplate: "curl https://example.com/b", inputs: [], tokens: {} },
		],
	});
	const template = insertTemplate({
		name: "one-tool",
		steps: [{ description: "only a" }],
		tcpSelections: [{ tcpId: tcp.id, toolNames: ["a"] }],
	});
	assert.deepEqual(template.tcpSelections, [{ tcpId: tcp.id, toolNames: ["a"] }]);

	const workflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "partial",
		agentName: "agent-partial",
		hookUrl: "http://127.0.0.1/hook/x",
		secret: "s",
		mdPath: path.join(tmpHome, "w2.md"),
	});
	applyTemplateTcpsToWorkflow(workflow.id, template.tcpSelections);
	assert.deepEqual(listWorkflowTcpSelections(workflow.id), [{ tcpId: tcp.id, toolNames: ["a"] }]);

	const catalog = tcpCatalogPreamble(workflow.id);
	assert.match(catalog, /\ba\b/);
	assert.doesNotMatch(catalog, /\bb\b \(TCP/);
});

test("applyTemplateTcpsToWorkflow merges with existing workflow TCPs", () => {
	const a = insertTcp({ name: "a", tools: [] });
	const b = insertTcp({ name: "b", tools: [] });
	const workflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "merge",
		agentName: "agent2",
		hookUrl: "http://127.0.0.1/hook/y",
		secret: "s",
		mdPath: path.join(tmpHome, "w3.md"),
	});
	applyTemplateTcpsToWorkflow(workflow.id, [{ tcpId: a.id }]);
	applyTemplateTcpsToWorkflow(workflow.id, [{ tcpId: b.id }]);
	assert.deepEqual(listWorkflowTcpIds(workflow.id), [a.id, b.id]);
});

test("setWorkflowTcpSelections can attach one tool from a pack", () => {
	const tcp = insertTcp({
		name: "pack",
		tools: [
			{ name: "x", description: "X", requestTemplate: "curl https://example.com/x", inputs: [], tokens: {} },
			{ name: "y", description: "Y", requestTemplate: "curl https://example.com/y", inputs: [], tokens: {} },
		],
	});
	const workflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "tool-only",
		agentName: "agent3",
		hookUrl: "http://127.0.0.1/hook/z",
		secret: "s",
		mdPath: path.join(tmpHome, "w4.md"),
	});
	setWorkflowTcpSelections(workflow.id, [{ tcpId: tcp.id, toolNames: ["y"] }]);
	assert.deepEqual(listWorkflowTcpSelections(workflow.id), [{ tcpId: tcp.id, toolNames: ["y"] }]);
});

test("template bundle round-trips tcpSelections", () => {
	const tcp = insertTcp({ name: "pack", tools: [] });
	const template = insertTemplate({
		name: "bundle",
		tcpIds: [tcp.id],
		steps: [{ description: "x" }],
		tcpSelections: [{ tcpId: tcp.id, toolNames: ["only"] }],
	});
	const entries = parseTemplateBundle(templateBundle([template]));
	assert.deepEqual(entries[0]?.tcpIds, [tcp.id]);
	assert.deepEqual(entries[0]?.tcpSelections, [{ tcpId: tcp.id, toolNames: ["only"] }]);
	const imported = importTemplates(entries);
	assert.deepEqual(imported[0]?.tcpSelections, [{ tcpId: tcp.id, toolNames: ["only"] }]);
});
