/**
 * `model` on POST /api/workflows and clone: validated against the enabled list
 * for the runner, written onto the AWB hook, read back by publicWorkflow.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-workflow-model-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.HOME = tmpHome;

const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
after(() => server.close());

const headers = { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };

function storedHook(agentName: string): Record<string, unknown> {
	const json = JSON.parse(fs.readFileSync(path.join(tmpHome, "hooks.json"), "utf8")) as {
		hooks: Record<string, Record<string, unknown>>;
	};
	return json.hooks[agentName]!;
}

async function post(url: string, body: unknown) {
	const res = await fetch(`${baseUrl}${url}`, { method: "POST", headers, body: JSON.stringify(body) });
	return { status: res.status, body: (await res.json()) as { workflow?: { id: string; agentName: string; model: string | null }; error?: string } };
}

async function saveAllowlist(runners: unknown) {
	const res = await fetch(`${baseUrl}/api/settings/models`, { method: "PUT", headers, body: JSON.stringify({ runners }) });
	assert.equal(res.status, 200);
}

test("an enabled model is accepted, written onto the hook, and returned by GET workflow", async () => {
	const created = await post("/api/workflows", { name: "with model", model: "sonnet" });
	assert.equal(created.status, 200);
	const workflow = created.body.workflow!;
	assert.equal(workflow.model, "sonnet");
	assert.equal(storedHook(workflow.agentName).model, "sonnet");
	const got = (await (await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers })).json()) as { workflow: { model: string | null } };
	assert.equal(got.workflow.model, "sonnet");
});

test("a model that is not enabled for the runner is a 400 and creates nothing", async () => {
	const before = (await (await fetch(`${baseUrl}/api/workflows`, { headers })).json()) as { workflows: unknown[] };
	const unknownId = await post("/api/workflows", { name: "bad model", model: "not-a-real-model" });
	assert.equal(unknownId.status, 400);
	assert.match(unknownId.body.error ?? "", /not enabled for claude/);
	// A real id of ANOTHER runner is not enabled for this one either.
	const wrongRunner = await post("/api/workflows", { name: "wrong runner", model: "composer-2.5" });
	assert.equal(wrongRunner.status, 400);
	assert.equal((await post("/api/workflows", { name: "bad type", model: 5 })).status, 400);
	const after = (await (await fetch(`${baseUrl}/api/workflows`, { headers })).json()) as { workflows: unknown[] };
	assert.equal(after.workflows.length, before.workflows.length);
});

test("a model disabled in Settings is rejected, and a custom id is accepted", async () => {
	await saveAllowlist({ claude: { enabled: ["opus"], custom: [] }, copilot: { enabled: [], custom: ["my-copilot-model"] } });
	assert.equal((await post("/api/workflows", { name: "disabled", model: "sonnet" })).status, 400);
	assert.equal((await post("/api/workflows", { name: "enabled", model: "opus" })).status, 200);
	const custom = await post("/api/workflows", { name: "custom", runner: "copilot", model: "my-copilot-model" });
	assert.equal(custom.status, 200);
	assert.equal(storedHook(custom.body.workflow!.agentName).model, "my-copilot-model");
});

test("omitting model, or sending it empty, leaves hook.model unset", async () => {
	for (const body of [{ name: "no model" }, { name: "empty model", model: "" }]) {
		const created = await post("/api/workflows", body);
		assert.equal(created.status, 200);
		assert.equal(created.body.workflow!.model, null);
		assert.equal("model" in storedHook(created.body.workflow!.agentName), false);
	}
});

test("clone inherits the source's model, even one Settings has since disabled", async () => {
	await saveAllowlist({ claude: { enabled: ["opus", "haiku"], custom: [] } });
	const source = await post("/api/workflows", { name: "clone source", model: "opus" });
	await saveAllowlist({ claude: { enabled: ["haiku"], custom: [] } });
	const clone = await post(`/api/workflows/${source.body.workflow!.id}/clone`, {});
	assert.equal(clone.status, 200);
	assert.equal(clone.body.workflow!.model, "opus");
	assert.equal(storedHook(clone.body.workflow!.agentName).model, "opus");
});

test("clone: an explicit model overrides (validated), empty clears, and a runner change drops the inherited id", async () => {
	await saveAllowlist({});
	const source = await post("/api/workflows", { name: "clone source 2", model: "opus" });
	const url = `/api/workflows/${source.body.workflow!.id}/clone`;

	const override = await post(url, { model: "haiku" });
	assert.equal(override.status, 200);
	assert.equal(override.body.workflow!.model, "haiku");

	assert.equal((await post(url, { model: "not-a-real-model" })).status, 400);

	const cleared = await post(url, { model: "" });
	assert.equal(cleared.body.workflow!.model, null);
	assert.equal("model" in storedHook(cleared.body.workflow!.agentName), false);

	const moved = await post(url, { runner: "cursor" });
	assert.equal(moved.status, 200);
	assert.equal(moved.body.workflow!.model, null);
});

async function patchModel(id: string, model: unknown) {
	const res = await fetch(`${baseUrl}/api/workflows/${id}/model`, { method: "PATCH", headers, body: JSON.stringify({ model }) });
	return { status: res.status, body: (await res.json()) as { workflow?: { model: string | null }; error?: string } };
}

test("PATCH /model rewrites hook.model, validates against the enabled list, and empty clears", async () => {
	await saveAllowlist({});
	const created = await post("/api/workflows", { name: "patch me" });
	const { id, agentName } = created.body.workflow!;
	assert.equal("model" in storedHook(agentName), false);

	const set = await patchModel(id, "sonnet");
	assert.equal(set.status, 200);
	assert.equal(set.body.workflow!.model, "sonnet");
	assert.equal(storedHook(agentName).model, "sonnet");

	assert.equal((await patchModel(id, "not-a-real-model")).status, 400);
	assert.equal(storedHook(agentName).model, "sonnet");
	assert.equal((await patchModel(id, 7)).status, 400);

	const cleared = await patchModel(id, "");
	assert.equal(cleared.status, 200);
	assert.equal(cleared.body.workflow!.model, null);
	assert.equal("model" in storedHook(agentName), false);
	assert.equal((await fetch(`${baseUrl}/api/workflows/nope/model`, { method: "PATCH", headers, body: "{}" })).status, 404);
});

test("PATCH /model grandfathers the id the workflow already has after Settings disables it", async () => {
	await saveAllowlist({});
	const created = await post("/api/workflows", { name: "grandfathered", model: "opus" });
	const { id, agentName } = created.body.workflow!;
	await saveAllowlist({ claude: { enabled: ["haiku"], custom: [] } });
	// Still on the workflow, and re-saving the same id is accepted…
	assert.equal(storedHook(agentName).model, "opus");
	assert.equal((await patchModel(id, "opus")).status, 200);
	// …but a different disabled id is not.
	assert.equal((await patchModel(id, "sonnet")).status, 400);
	assert.equal((await patchModel(id, "haiku")).status, 200);
	// And moving off the grandfathered id means it can't be picked again.
	assert.equal((await patchModel(id, "opus")).status, 400);
});

test("PATCH /model is refused while a step is running", async () => {
	await saveAllowlist({});
	const created = await post("/api/workflows", { name: "busy" });
	const { id } = created.body.workflow!;
	const { addStep } = await import("./workflow.ts");
	const { markStepRunning } = await import("./db.ts");
	const step = addStep(id, "do a thing");
	markStepRunning(step.id);
	const refused = await patchModel(id, "sonnet");
	assert.equal(refused.status, 400);
	assert.match(refused.body.error ?? "", /step is running/);
});
