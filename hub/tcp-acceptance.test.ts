/**
 * Acceptance scenario for TCP: github/get_me tool, dummy workflow, attachment.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-tcp-acceptance-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const TEST_GITHUB_TOKEN = "test-github-token-for-acceptance";

const { insertWorkflow } = await import("./db.ts");
const { insertStep } = await import("./db.ts");
const { executeTcpTool } = await import("./tcp-executor.ts");
const { tcpCatalogPreamble } = await import("./tcp-catalog.ts");
const { composeStepInput } = await import("./runner.ts");
const { insertTcp, setWorkflowTcps } = await import("./tcp-store.ts");

test("acceptance: github TCP get_me on dummy workflow", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "https://api.github.com/user");
		const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
		assert.match(auth ?? "", /Bearer test-github-token-for-acceptance/);
		return new Response(JSON.stringify({ login: "acceptance-user" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	const tcp = insertTcp({
		name: "github",
		tags: ["api"],
		tools: [
			{
				name: "get_me",
				description: "Obtiene el perfil del usuario autenticado en GitHub",
				requestTemplate:
					"curl -X GET https://api.github.com/user -H 'Authorization: Bearer $TOKEN_1' -H 'Accept: application/vnd.github+json'",
				inputs: [],
				tokens: { TOKEN_1: TEST_GITHUB_TOKEN },
			},
		],
	});
	assert.equal(tcp.name, "github");
	assert.equal(tcp.tools[0]?.name, "get_me");

	const workflow = insertWorkflow({
		id: crypto.randomUUID(),
		name: "dummy-tcp-workflow",
		agentName: "dummy-agent",
		hookUrl: "http://127.0.0.1:8890/hook/dummy",
		secret: "secret",
		mdPath: path.join(tmpHome, "dummy.md"),
	});
	setWorkflowTcps(workflow.id, [tcp.id]);

	const step = insertStep(workflow.id, "Usa la herramienta TCP get_me y devuelve el login de GitHub.", {
		useSubagent: false,
		acceptanceCriteria: "La respuesta incluye el login del usuario de GitHub",
	});

	const catalog = tcpCatalogPreamble(workflow.id);
	assert.match(catalog, /get_me/);
	assert.match(catalog, /tcpExecute/);

	const prompt = composeStepInput(step, workflow, { injectTcp: true, injectContext: false });
	assert.match(prompt, /get_me/);

	const result = await executeTcpTool(tcp.tools[0]!, { toolName: "get_me" });
	assert.equal(result.ok, true, result.message ?? result.body ?? "execution failed");
	assert.equal(result.status, 200);
	const body = JSON.parse(result.body ?? "{}") as { login?: string };
	assert.equal(body.login, "acceptance-user");
});
