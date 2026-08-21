import * as assert from "node:assert/strict";
import { test } from "node:test";

const {
	filterUsageForAlert,
	formatTcpDeleteUsage,
	formatTcpToolChangeUsage,
	tcpToolChangeAction,
	tcpToolNamesAtRisk,
	tcpToolsForComparison,
	tcpUsageConfirmOptions,
	tcpUsageHasReferences,
} = await import("./ui/src/tcpUsageAlert.ts");

const tool = (name: string, requestTemplate = "curl https://example.com"): import("./ui/src/api/types.ts").TcpTool => ({
	name,
	description: "",
	requestTemplate,
	inputs: [],
	tokens: {},
});

const injectedWorkflow = {
	id: "wf-injected",
	name: "already-started",
	contextInjected: true,
	toolNames: ["get_me"] as string[] | null,
};

const pendingWorkflow = {
	id: "wf-pending",
	name: "not-started-yet",
	contextInjected: false,
	toolNames: ["list_repos"] as string[] | null,
};

const template = {
	id: "tpl-1",
	name: "my-template",
	toolNames: null as string[] | null,
};

test("filterUsageForAlert excludes injected workflows but keeps templates", () => {
	const filtered = filterUsageForAlert({
		workflows: [injectedWorkflow, pendingWorkflow],
		templates: [template],
	});
	assert.equal(filtered.workflows.length, 1);
	assert.equal(filtered.workflows[0]?.name, "not-started-yet");
	assert.deepEqual(filtered.templates, [template]);
});

test("tcpUsageHasReferences ignores injected-only workflows", () => {
	assert.equal(
		tcpUsageHasReferences({ workflows: [injectedWorkflow], templates: [] }),
		false,
	);
	assert.equal(
		tcpUsageHasReferences({ workflows: [injectedWorkflow], templates: [template] }),
		true,
	);
	assert.equal(
		tcpUsageHasReferences({ workflows: [pendingWorkflow], templates: [] }),
		true,
	);
});

test("formatTcpDeleteUsage lists only pending workflows and all templates", () => {
	const { description } = formatTcpDeleteUsage("github", {
		workflows: [injectedWorkflow, pendingWorkflow],
		templates: [template],
	});
	assert.match(description, /not-started-yet \(list_repos\)/);
	assert.doesNotMatch(description, /already-started/);
	assert.doesNotMatch(description, /context already injected/);
	assert.doesNotMatch(description, /not started yet/);
	assert.match(description, /my-template \(all tools\)/);
});

test("formatTcpToolChangeUsage lists only pending workflows", () => {
	const { description } = formatTcpToolChangeUsage(
		"github",
		["get_me"],
		{ workflows: [injectedWorkflow, pendingWorkflow], templates: [] },
		"remove",
	);
	assert.match(description, /not-started-yet/);
	assert.doesNotMatch(description, /already-started/);
});

test("tcpToolsForComparison drops blank tools like the TCP form submit", () => {
	assert.deepEqual(
		tcpToolsForComparison([tool("keep"), tool("", ""), tool("skip", "")]),
		[tool("keep")],
	);
});

test("tcpToolNamesAtRisk detects a renamed tool on save", () => {
	const before = [tool("get_me"), tool("list_repos")];
	const after = [tool("get_user"), tool("list_repos")];
	assert.deepEqual(tcpToolNamesAtRisk(before, after), ["get_me"]);
});

test("tcpToolChangeAction treats an in-place rename as rename", () => {
	const before = [tool("get_me")];
	const after = [tool("get_user")];
	assert.equal(tcpToolChangeAction(before, after), "rename");
});

test("tcpToolChangeAction treats a dropped tool as remove", () => {
	const before = [tool("get_me"), tool("list_repos")];
	const after = [tool("list_repos")];
	assert.equal(tcpToolChangeAction(before, after), "remove");
});

test("formatTcpToolChangeUsage rename lists pending workflows and templates", () => {
	const { title, description } = formatTcpToolChangeUsage(
		"github",
		["get_me"],
		{ workflows: [injectedWorkflow, pendingWorkflow], templates: [template] },
		"rename",
	);
	assert.match(title, /Renaming tool "get_me"/);
	assert.match(description, /not-started-yet \(list_repos\)/);
	assert.match(description, /my-template \(all tools\)/);
	assert.doesNotMatch(description, /already-started/);
});

test("tcpUsageConfirmOptions mirrors delete and save tool-change alerts", () => {
	const usage = { workflows: [pendingWorkflow], templates: [template] };
	assert.deepEqual(tcpUsageConfirmOptions("github", usage, { type: "delete" })?.confirmLabel, "Delete anyway");
	assert.deepEqual(
		tcpUsageConfirmOptions("github", usage, {
			type: "tool-change",
			toolNames: ["get_me"],
			action: "rename",
			confirmLabel: "Save anyway",
		})?.confirmLabel,
		"Save anyway",
	);
	assert.equal(tcpUsageConfirmOptions("github", { workflows: [injectedWorkflow], templates: [] }, { type: "delete" }), null);
});
