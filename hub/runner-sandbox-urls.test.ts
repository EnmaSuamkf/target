/**
 * Docker sandbox steps hand the agent a container-reachable hub address, but the
 * broker's `started`/`result` callbacks are posted from the host and awb only
 * accepts loopback targets. A regression here leaves steps stuck `queued` even
 * after the agent finished — the run log shows success, the hub never hears it.
 */
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-runner-sandbox-urls-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { createAwbHook } = await import("./awb.ts");
const { loadConfig } = await import("./config.ts");
const { insertStep, insertWorkflow } = await import("./db.ts");
const { dispatchStep } = await import("./runner.ts");

const cfg = loadConfig();
const silent = () => {};

type DispatchBody = { callbackUrl: string; startedCallbackUrl: string };

/** A stand-in awb hook: answers 200 and hands back the body it was dispatched. */
function startFakeHook() {
	let onDispatch!: (body: DispatchBody) => void;
	const dispatched = new Promise<DispatchBody>((resolve) => {
		onDispatch = resolve;
	});
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			onDispatch(body);
		});
	});
	return new Promise<{ server: http.Server; url: string; dispatched: Promise<DispatchBody> }>(
		(resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
				resolve({ server, url: `http://127.0.0.1:${addr.port}/hook/agent`, dispatched });
			});
		},
	);
}

test("docker sandbox dispatches loopback broker callbacks, not host.docker.internal", async () => {
	const workdir = path.join(tmpHome, "wd");
	fs.mkdirSync(workdir, { recursive: true });
	const { hookUrl } = createAwbHook("docker-urls", workdir, "{{payload}}", { sandbox: "docker" });
	const workflow = insertWorkflow({
		id: "wf-docker-urls",
		name: "docker urls",
		agentName: "docker-urls",
		hookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, "wf-docker-urls.md"),
		conversationContext: null,
	});
	const step = insertStep(workflow.id, "say hi");

	const { server, url, dispatched } = await startFakeHook();
	test.after(() => server.close());

	await dispatchStep(step, { ...workflow, hookUrl: url }, cfg, silent);

	const captured = await dispatched;
	assert.match(captured.callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/steps\/.+\/result\?token=/);
	assert.match(captured.startedCallbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/steps\/.+\/started\?token=/);
	assert.ok(!captured.callbackUrl.includes("host.docker.internal"), captured.callbackUrl);
	assert.ok(!captured.startedCallbackUrl.includes("host.docker.internal"), captured.startedCallbackUrl);
});
