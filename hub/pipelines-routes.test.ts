/**
 * HTTP tests for the pipeline routes (server.ts): /api/pipelines, /api/secrets
 * and the run records and logs. Trust is the point of these tests: a pipeline
 * saved or approved with the admin bearer token must stay untrusted, and only the
 * browser session may approve it.
 *
 * Same throwaway-TARGET_HOME convention as auth-routes.test.ts. Tests share one
 * server and one account, and run in order.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-pipelines-routes-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { insertStep, open } = await import("./db.ts");
const { insertPipelineRun, updatePipelineRunStep, finishPipelineRun } = await import("./pipeline-runs.ts");
const { registerSecret } = await import("./redact.ts");

const cfg = loadConfig();
const silent = () => {};
const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

const PASSWORD = "correct horse battery";

/** The browser session cookie, set by the first-run setup and reused for the session-only calls. */
let sessionCookie = "";

type Auth = "bearer" | "session" | "none";

async function call(method: string, route: string, auth: Auth, body?: unknown): Promise<{ status: number; json: any; text: string }> {
	const headers: Record<string, string> = {};
	if (body !== undefined) headers["content-type"] = "application/json";
	if (auth === "bearer") headers.authorization = `Bearer ${cfg.adminToken}`;
	if (auth === "session") headers.cookie = sessionCookie;
	const res = await fetch(`${baseUrl}${route}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { status: res.status, json, text };
}

const VERIFY = `name: verify
description: Install and test.
inputs:
  package:
    default: hub
steps:
  - run: npm test
    working-directory: \${{ inputs.package }}
`;

test("first-run setup signs the browser in: the session cookie is the session caller", async () => {
	const res = await fetch(`${baseUrl}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: PASSWORD }),
	});
	assert.equal(res.status, 200);
	const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("target_session="));
	assert.ok(setCookie, "setup sets the session cookie");
	sessionCookie = setCookie.split(";")[0];
});

test("a pipeline saved with the admin bearer token is untrusted", async () => {
	const saved = await call("POST", "/api/pipelines", "bearer", { source: VERIFY });
	assert.equal(saved.status, 200, saved.text);
	assert.equal(saved.json.pipeline.name, "verify");
	assert.equal(saved.json.pipeline.trusted, false);
	assert.equal(saved.json.pipeline.trustedHash, null);
});

test("a pipeline saved from the browser session is trusted", async () => {
	const saved = await call("POST", "/api/pipelines", "session", { source: VERIFY.replace("npm test", "npm run session") });
	assert.equal(saved.status, 200, saved.text);
	assert.equal(saved.json.pipeline.trusted, true);
	assert.equal(saved.json.pipeline.trustedHash, saved.json.pipeline.sourceHash);
});

test("a session save that does not change the text keeps trust; a bearer edit drops it", async () => {
	const saved = await call("POST", "/api/pipelines", "session", { source: "name: keep\nsteps:\n  - run: echo keep\n" });
	const id = saved.json.pipeline.id;
	assert.equal(saved.json.pipeline.trusted, true);

	const retagged = await call("PUT", `/api/pipelines/${id}`, "bearer", { tags: ["x"] });
	assert.equal(retagged.json.pipeline.trusted, true, "tags alone keep the approval");

	const edited = await call("PUT", `/api/pipelines/${id}`, "bearer", { source: "name: keep\nsteps:\n  - run: echo changed\n" });
	assert.equal(edited.status, 200);
	assert.equal(edited.json.pipeline.trusted, false, "an edit by the bearer token is untrusted");
});

test("POST /api/pipelines/:id/approve with only the bearer token is 403 session_required", async () => {
	const saved = await call("POST", "/api/pipelines", "bearer", { source: "name: needs-approval\nsteps:\n  - run: x\n" });
	const id = saved.json.pipeline.id;
	const sourceHash = saved.json.pipeline.sourceHash;
	const res = await call("POST", `/api/pipelines/${id}/approve`, "bearer", { sourceHash });
	assert.equal(res.status, 403);
	assert.equal(res.json.error, "session_required");
	assert.equal((await call("GET", `/api/pipelines/${id}`, "bearer")).json.pipeline.trusted, false);
});

test("a session approve with a stale sourceHash is 409 and changes nothing", async () => {
	const saved = await call("POST", "/api/pipelines", "bearer", { source: "name: stale\nsteps:\n  - run: a\n" });
	const id = saved.json.pipeline.id;
	const stale = saved.json.pipeline.sourceHash;
	await call("PUT", `/api/pipelines/${id}`, "bearer", { source: "name: stale\nsteps:\n  - run: b\n" });

	const res = await call("POST", `/api/pipelines/${id}/approve`, "session", { sourceHash: stale });
	assert.equal(res.status, 409);
	assert.equal(res.json.error, "stale_hash");
	assert.equal((await call("GET", `/api/pipelines/${id}`, "bearer")).json.pipeline.trusted, false);
});

test("a session approve with the current sourceHash trusts the pipeline", async () => {
	const saved = await call("POST", "/api/pipelines", "bearer", { source: "name: approve-me\nsteps:\n  - run: a\n" });
	const id = saved.json.pipeline.id;
	const res = await call("POST", `/api/pipelines/${id}/approve`, "session", { sourceHash: saved.json.pipeline.sourceHash });
	assert.equal(res.status, 200);
	assert.equal(res.json.pipeline.trusted, true);
});

test("invalid YAML is 400 with every error and its line", async () => {
	const res = await call("POST", "/api/pipelines", "bearer", {
		source: "name: bad\nsteps:\n  - run: a\n    continue_on_error: true\n  - shell: bash\n",
	});
	assert.equal(res.status, 400);
	assert.equal(res.json.error, "invalid_pipeline");
	const lines = res.json.errors.map((e: { line: number | null }) => e.line);
	assert.ok(lines.includes(4), `the unknown key is on line 4: ${JSON.stringify(res.json.errors)}`);
	assert.ok(lines.includes(5), `the missing run is on line 5: ${JSON.stringify(res.json.errors)}`);
	const unknown = res.json.errors.find((e: { line: number }) => e.line === 4);
	assert.match(unknown.message, /did you mean "continue-on-error"/);
});

test("validate returns the errors with their lines and saves nothing", async () => {
	const before = (await call("GET", "/api/pipelines", "bearer")).json.pipelines.length;
	const bad = await call("POST", "/api/pipelines/validate", "bearer", { source: "on: push\nname: v\nsteps: []\n" });
	assert.equal(bad.status, 200);
	assert.equal(bad.json.ok, false);
	assert.ok(bad.json.errors.some((e: { line: number }) => e.line === 1));
	const good = await call("POST", "/api/pipelines/validate", "bearer", { source: VERIFY });
	assert.deepEqual(good.json, { ok: true, errors: [] });
	const after = (await call("GET", "/api/pipelines", "bearer")).json.pipelines.length;
	assert.equal(after, before, "validate never saves");
});

test("the list carries no source; the detail carries source, hashes, errors and references", async () => {
	const list = await call("GET", "/api/pipelines", "bearer");
	assert.ok(list.json.pipelines.length > 0);
	for (const p of list.json.pipelines) {
		assert.equal("source" in p, false, "no source in the list");
		assert.equal(typeof p.trusted, "boolean");
	}
	const id = list.json.pipelines[0].id;
	const detail = await call("GET", `/api/pipelines/${id}`, "bearer");
	assert.equal(typeof detail.json.pipeline.source, "string");
	assert.equal(typeof detail.json.pipeline.sourceHash, "string");
	assert.deepEqual(detail.json.pipeline.errors, []);
	assert.deepEqual(detail.json.pipeline.referencedBy, { steps: [], templates: [] });
});

test("a pipeline used by a command step cannot be deleted, and reports the step", async () => {
	const saved = await call("POST", "/api/pipelines", "bearer", { source: "name: in-use\nsteps:\n  - run: x\n" });
	const id = saved.json.pipeline.id;
	const step = insertStep("wf-routes-in-use", "run in-use", { kind: "command", pipelineId: id });

	const refused = await call("DELETE", `/api/pipelines/${id}`, "bearer");
	assert.equal(refused.status, 409);
	assert.equal(refused.json.error, "in_use");
	assert.deepEqual(refused.json.references, [`step ${step.id}`]);

	const detail = await call("GET", `/api/pipelines/${id}`, "bearer");
	assert.deepEqual(detail.json.pipeline.referencedBy.steps, [step.id]);

	open().prepare("DELETE FROM steps WHERE id = ?").run(step.id);
	const deleted = await call("DELETE", `/api/pipelines/${id}`, "bearer");
	assert.equal(deleted.status, 200);
});

test("an unknown pipeline is 404", async () => {
	const res = await call("GET", "/api/pipelines/does-not-exist", "bearer");
	assert.equal(res.status, 404);
	assert.equal(res.json.error, "unknown_pipeline");
});

test("a server copy is read-only: PUT and DELETE are 409", async () => {
	const saved = await call("POST", "/api/pipelines", "bearer", { source: "name: server-copy\nsteps:\n  - run: x\n" });
	const id = saved.json.pipeline.id;
	open().prepare("UPDATE pipelines SET origin = 'server' WHERE id = ?").run(id);
	assert.equal((await call("PUT", `/api/pipelines/${id}`, "bearer", { tags: ["y"] })).status, 409);
	assert.equal((await call("DELETE", `/api/pipelines/${id}`, "bearer")).status, 409);
});

test("export carries the text and no secret values; import comes back untrusted", async () => {
	await call("PUT", "/api/secrets/EXPORT_CHECK", "session", { value: "export-secret-value-000" });
	const exported = await call("GET", "/api/pipelines/export", "bearer");
	assert.equal(exported.status, 200);
	assert.equal(exported.json.kind, "target.pipelines");
	assert.ok(exported.json.pipelines.length > 0);
	assert.ok(!exported.text.includes("export-secret-value-000"), "no secret value in the export");
	assert.ok(!exported.text.includes("trustedHash"), "no trust in the export");

	const imported = await call("POST", "/api/pipelines/import", "bearer", exported.json);
	assert.equal(imported.status, 200);
	assert.ok(imported.json.pipelines.every((p: { trusted: boolean }) => p.trusted === false), "imports are untrusted");
});

test("GET /api/secrets lists names and whether each is set, never a value", async () => {
	const value = "listed-secret-value-98765";
	const set = await call("PUT", "/api/secrets/LISTED_TOKEN", "session", { value });
	assert.equal(set.status, 200);
	assert.equal(set.json.secret.isSet, true);
	assert.ok(!set.text.includes(value), "the PUT answer does not echo the value");

	const list = await call("GET", "/api/secrets", "bearer");
	assert.equal(list.status, 200);
	assert.ok(list.json.secrets.some((s: { name: string }) => s.name === "LISTED_TOKEN"));
	assert.ok(!list.text.includes(value), "GET /api/secrets never contains the value");
	for (const s of list.json.secrets) {
		assert.deepEqual(Object.keys(s).sort(), ["isSet", "name", "updatedAt"]);
	}
});

test("writing a secret with only the bearer token is 403 session_required", async () => {
	const put = await call("PUT", "/api/secrets/BEARER_TRY", "bearer", { value: "bearer-cannot-set-this" });
	assert.equal(put.status, 403);
	assert.equal(put.json.error, "session_required");
	const del = await call("DELETE", "/api/secrets/LISTED_TOKEN", "bearer");
	assert.equal(del.status, 403);
	assert.equal(del.json.error, "session_required");
});

test("an invalid secret name is 400 and a missing one is 404 on delete", async () => {
	assert.equal((await call("PUT", "/api/secrets/lower_case", "session", { value: "abcdefgh12" })).status, 400);
	assert.equal((await call("DELETE", "/api/secrets/NEVER_SET_NAME", "session")).status, 404);
});

test("run records: a step's runs are listed with their job steps; the log is served redacted, per job step", async () => {
	const saved = await call("POST", "/api/pipelines", "bearer", { source: VERIFY });
	const pipelineId = saved.json.pipeline.id;
	const step = insertStep("wf-routes-runs", "verify", { kind: "command", pipelineId, pipelineInputs: {} });

	const logDir = path.join(tmpHome, "run-logs");
	fs.mkdirSync(logDir, { recursive: true });
	const logPath = path.join(logDir, "run.log");
	const first = "install ok\n";
	const second = "tests printed leaked-value-abcdef123456\n";
	fs.writeFileSync(logPath, first + second);
	registerSecret("leaked-value-abcdef123456");

	const run = insertPipelineRun({
		stepId: step.id,
		workflowId: "wf-routes-runs",
		attempt: 1,
		pipelineId,
		sourceHash: saved.json.pipeline.sourceHash,
		logPath,
		steps: [
			{ index: 0, name: "Install" },
			{ index: 1, name: "Tests" },
		],
	});
	updatePipelineRunStep(run.id, 0, { status: "success", exitCode: 0, logOffset: 0, logLength: first.length });
	updatePipelineRunStep(run.id, 1, { status: "success", exitCode: 0, logOffset: first.length, logLength: second.length });
	finishPipelineRun(run.id, { conclusion: "success" });

	const runs = await call("GET", `/api/steps/${step.id}/pipeline-runs`, "bearer");
	assert.equal(runs.status, 200);
	assert.equal(runs.json.runs.length, 1);
	assert.equal(runs.json.runs[0].conclusion, "success");
	assert.deepEqual(
		runs.json.runs[0].steps.map((s: { name: string }) => s.name),
		["Install", "Tests"],
	);
	assert.equal("logPath" in runs.json.runs[0], false, "the on-disk path is not exposed");

	const whole = await call("GET", `/api/pipeline-runs/${run.id}/log`, "bearer");
	assert.equal(whole.status, 200);
	assert.ok(whole.text.includes("install ok"));
	assert.ok(!whole.text.includes("leaked-value-abcdef123456"), "the log is redacted");
	assert.ok(whole.text.includes("***"));

	const onlyTests = await call("GET", `/api/pipeline-runs/${run.id}/log?step=1`, "bearer");
	assert.equal(onlyTests.status, 200);
	assert.ok(!onlyTests.text.includes("install ok"), "one job step's section only");
	assert.ok(onlyTests.text.includes("***"));

	assert.equal((await call("GET", `/api/pipeline-runs/${run.id}/log?step=9`, "bearer")).status, 404);
	assert.equal((await call("GET", "/api/steps/no-such-step/pipeline-runs", "bearer")).status, 404);
});

test("every pipeline route answers 401 login_required without a session or the bearer token", async () => {
	for (const [method, route] of [
		["GET", "/api/pipelines"],
		["POST", "/api/pipelines"],
		["GET", "/api/secrets"],
		["PUT", "/api/secrets/X"],
	] as const) {
		const res = await call(method, route, "none", method === "GET" ? undefined : {});
		assert.equal(res.status, 401, `${method} ${route}`);
		assert.equal(res.json.error, "login_required");
	}
});
