/**
 * Docker bind mounts: Settings defaults merged with per-workflow extras.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-docker-mounts-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { createAwbHook, hookRuntime } = await import("./awb.ts");
const { saveDockerMountSettings } = await import("./db.ts");
const { createWorkflow, updateWorkflowDockerMounts } = await import("./workflow.ts");
const { effectiveDockerMounts, mergeDockerMounts, normalizeDockerMountPath, parseDockerMountsInput } =
	await import("./docker-mounts.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

test("normalizeDockerMountPath expands ~ and rejects overly broad paths", () => {
	assert.equal(normalizeDockerMountPath("~/projects"), path.join(os.homedir(), "projects"));
	assert.equal(normalizeDockerMountPath("/tmp/repo"), path.normalize("/tmp/repo"));
	assert.equal(normalizeDockerMountPath("~"), null);
	assert.equal(normalizeDockerMountPath("/"), null);
	assert.equal(normalizeDockerMountPath("relative/path"), null);
});

test("mergeDockerMounts deduplicates paths", () => {
	const merged = mergeDockerMounts(["/tmp/a", "/tmp/a"], ["/tmp/b"]);
	assert.deepEqual(merged, [path.normalize("/tmp/a"), path.normalize("/tmp/b")]);
});

test("createWorkflow applies Settings defaults to a docker hook", () => {
	const defaults = path.join(tmpHome, "defaults");
	fs.mkdirSync(defaults, { recursive: true });
	saveDockerMountSettings([defaults]);
	const workflow = createWorkflow("docker mounts", { sandbox: "docker" });
	const extra = path.join(tmpHome, "extra");
	fs.mkdirSync(extra, { recursive: true });
	const updated = updateWorkflowDockerMounts(workflow.id, [extra]);
	assert.deepEqual(updated.dockerMounts, [extra]);
	const runtime = hookRuntime(updated.hookUrl);
	assert.ok(runtime.sandbox?.mounts?.includes(defaults));
	assert.ok(runtime.sandbox?.mounts?.includes(extra));
});

test("POST /api/settings/docker-mounts stores defaults and GET reads them back", async () => {
	const cfg = loadConfig();
	const server = createServer(cfg, () => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const mount = path.join(tmpHome, "m2");

	const put = await fetch(`${baseUrl}/api/settings/docker-mounts`, {
		method: "PUT",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` },
		body: JSON.stringify({ mounts: [mount] }),
	});
	assert.equal(put.status, 200);

	const get = await fetch(`${baseUrl}/api/settings/docker-mounts`, {
		headers: { authorization: `Bearer ${cfg.adminToken}` },
	});
	assert.equal(get.status, 200);
	const body = (await get.json()) as { settings: { mounts: string[] } };
	assert.deepEqual(body.settings.mounts, [mount]);
	server.close();
});

test("parseDockerMountsInput rejects invalid entries", () => {
	assert.throws(() => parseDockerMountsInput(["/ok", "relative"]), /invalid mount path/);
});

test.after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
});
