/**
 * Body-size tests for the three importable things: TCP packs, templates and
 * Resource Sets.
 *
 * A TCP pack is the tool list of a real MCP server, and a real one — the
 * Atlassian catalogue that prompted this — is well past a megabyte of JSON
 * schema. Those routes used to read their body under `cfg.maxInputBytes`
 * (64 KiB, sized for a step description), so every genuine pack came back
 * `payload_too_large` and the UI showed "Could not import the TCP packs:
 * payload_too_large". They now share the catalogue ceiling the folder importer
 * already enforced on a Resource Set.
 *
 * The point of testing this over real HTTP is that the limit lives in the
 * routing layer, not in the parsers: `parseTcpBundle` and `parseTemplateBundle`
 * never saw the body at all, so a store-level test would have passed
 * throughout. Each case therefore posts a body far larger than the old ceiling
 * and asserts the payload actually landed.
 *
 * Same throwaway-TARGET_HOME convention as server.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-import-size-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

/** Roughly what one MCP tool costs on the wire once its schema prose is in. */
const PROSE = "Performs the operation against the remote instance. ".repeat(40);

/** A pack of `count` tools, shaped like an exported bundle from a real server. */
function bigTcpPack(name: string, count: number) {
	return {
		name,
		tags: ["mcp"],
		tools: Array.from({ length: count }, (_, i) => ({
			name: `tool_${i}`,
			description: `${PROSE} (tool ${i})`,
			requestTemplate: `GET https://example.atlassian.net/rest/api/3/thing/${i}?q={{query}}`,
			inputs: [{ name: "query", placeholder: "{{query}}", description: PROSE, required: true }],
			tokens: { AUTH: "" },
		})),
	};
}

// 600 tools of that shape is ~1.5 MB — over twenty times the old 64 KiB
// ceiling, and the same order of magnitude as the file that reported the bug.
const TOOL_COUNT = 600;

test("POST /api/tcps/import accepts a multi-megabyte pack", async () => {
	const bundle = {
		kind: "target.tcps",
		schemaVersion: 1,
		exportedAt: new Date().toISOString(),
		tcps: [bigTcpPack("atlassian", TOOL_COUNT)],
	};
	const payload = JSON.stringify(bundle);
	assert.ok(payload.length > cfg.maxInputBytes, "fixture must exceed the old step-sized ceiling");

	const res = await fetch(`${baseUrl}/api/tcps/import`, { method: "POST", headers: adminHeaders(), body: payload });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { tcps: { id: string; name: string; tools: unknown[] }[] };
	assert.equal(body.tcps.length, 1);
	assert.equal(body.tcps[0]?.name, "atlassian");
	// Every tool survived — a limit raised only far enough to stop the 413 while
	// truncating the pack would still be the bug the operator reported.
	assert.equal(body.tcps[0]?.tools.length, TOOL_COUNT);
});

test("a pack that big can be re-saved through PATCH /api/tcps/:id", async () => {
	// Importing it is only half of it: the editor writes the whole tool list
	// back on every save, so the update route needs the same ceiling or the
	// pack becomes read-only the moment it lands.
	const created = await fetch(`${baseUrl}/api/tcps`, {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify(bigTcpPack("editable", TOOL_COUNT)),
	});
	assert.equal(created.status, 200);
	const { tcp } = (await created.json()) as { tcp: { id: string; tools: unknown[] } };
	assert.equal(tcp.tools.length, TOOL_COUNT);

	const edited = bigTcpPack("editable", TOOL_COUNT);
	edited.tools[0]!.description = "renamed";
	const res = await fetch(`${baseUrl}/api/tcps/${tcp.id}`, {
		method: "PATCH",
		headers: adminHeaders(),
		body: JSON.stringify({ tools: edited.tools }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { tcp: { tools: { description: string }[] } };
	assert.equal(body.tcp.tools.length, TOOL_COUNT);
	assert.equal(body.tcp.tools[0]?.description, "renamed");
});

test("POST /api/templates/import accepts a multi-megabyte bundle", async () => {
	// A template bundle is big for a different reason than a pack — many steps,
	// each carrying a description the operator wrote — but it read its body
	// under the same 64 KiB ceiling, so it failed the same way.
	const steps = Array.from({ length: 400 }, (_, i) => ({
		description: `${PROSE} (step ${i})`,
		acceptanceCriteria: PROSE,
	}));
	const bundle = {
		kind: "target.templates",
		schemaVersion: 1,
		exportedAt: new Date().toISOString(),
		templates: [{ name: "big checklist", tags: ["release"], steps, tcpIds: [], tcpSelections: [], resourceSelections: [] }],
	};
	const payload = JSON.stringify(bundle);
	assert.ok(payload.length > cfg.maxInputBytes, "fixture must exceed the old step-sized ceiling");

	const res = await fetch(`${baseUrl}/api/templates/import`, { method: "POST", headers: adminHeaders(), body: payload });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { templates: { name: string; steps: unknown[] }[] };
	assert.equal(body.templates.length, 1);
	assert.equal(body.templates[0]?.steps.length, steps.length);
});

test("POST /api/resourcesets accepts a multi-megabyte set", async () => {
	// RCI already had the bigger ceiling; this pins it so the shared constant
	// can't be narrowed back to the step-sized one without a failure here.
	const resources = Array.from({ length: 40 }, (_, i) => ({
		name: `skill-${i}`,
		description: `reference ${i}`,
		kind: "skill",
		entryFile: "SKILL.md",
		content: PROSE.repeat(8),
		files: [{ path: "references/notes.md", content: PROSE.repeat(8) }],
	}));
	const payload = JSON.stringify({ name: "big set", tags: [], resources });
	assert.ok(payload.length > cfg.maxInputBytes, "fixture must exceed the old step-sized ceiling");

	const res = await fetch(`${baseUrl}/api/resourcesets`, { method: "POST", headers: adminHeaders(), body: payload });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { resourceSet: { resources: unknown[] } };
	assert.equal(body.resourceSet.resources.length, resources.length);
});

test("a body past the catalogue ceiling is still refused", async () => {
	// The fix raises the ceiling; it does not remove it. Over the limit the
	// server answers 413 and destroys the socket, so a client that is still
	// uploading may see the response OR a transport error — both are the guard
	// firing, and neither is the request succeeding.
	const payload = JSON.stringify({
		kind: "target.tcps",
		schemaVersion: 1,
		tcps: [{ name: "huge", tags: [], tools: [], filler: "x".repeat(17 * 1024 * 1024) }],
	});
	let status: number | "transport-error";
	try {
		const res = await fetch(`${baseUrl}/api/tcps/import`, { method: "POST", headers: adminHeaders(), body: payload });
		status = res.status;
		const body = (await res.json()) as { error?: string };
		assert.equal(body.error, "payload_too_large");
	} catch {
		status = "transport-error";
	}
	assert.notEqual(status, 200);
});
