/**
 * Host, Origin, and Content-Type checks in front of routing (server.ts).
 *
 * DNS rebinding sends a Host the hub did not expect; a page on another local
 * port is same-site for the session cookie and can POST text/plain without a
 * preflight. Both are refused. CLI/MCP-style requests (no Origin, JSON
 * content type) and a configured sandboxHost keep working. The server listens
 * on an ephemeral port — the allowlist is not hard-coded to 8893.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-perimeter-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
delete process.env.TARGET_HUB_DOCKER_FRIENDLY;

const SANDBOX_HOST = "sandbox.example.test";
fs.writeFileSync(
	path.join(tmpHome, "config.json"),
	JSON.stringify({
		host: "127.0.0.1",
		port: 8893,
		adminToken: "perimeter-test-token",
		sandboxHost: SANDBOX_HOST,
		sandboxHostManual: true,
	}),
);

const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const cfg = loadConfig();
assert.equal(cfg.sandboxHost, SANDBOX_HOST);
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const port = address.port;

test.after(() => {
	server.close();
});

function raw(
	method: string,
	requestPath: string,
	headers: Record<string, string>,
	body?: string,
): Promise<{ status: number; json: { error?: string; ok?: boolean; setupCompleted?: boolean } }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let json: { error?: string; ok?: boolean; setupCompleted?: boolean } = {};
				try {
					json = JSON.parse(text) as typeof json;
				} catch {
					json = {};
				}
				resolve({ status: res.statusCode ?? 0, json });
			});
		});
		req.on("error", reject);
		req.end(body);
	});
}

const jsonHeaders = { "content-type": "application/json" };
const shortSetup = JSON.stringify({ password: "short" });

test("a bad Host is refused on an open route and on a gated route", async () => {
	const host = `evil.example:${port}`;
	const open = await raw("POST", "/api/auth/setup", { host, ...jsonHeaders }, JSON.stringify({ password: "long-enough-password" }));
	assert.equal(open.status, 403);
	assert.equal(open.json.error, "forbidden_host");

	const gated = await raw("GET", "/api/workflows", { host, authorization: `Bearer ${cfg.adminToken}` });
	assert.equal(gated.status, 403);
	assert.equal(gated.json.error, "forbidden_host");

	const status = await raw("GET", "/api/auth/status", { host: `127.0.0.1:${port}` });
	assert.equal(status.status, 200);
	assert.equal(status.json.setupCompleted, false);
});

test("Host localhost and 127.0.0.1 on this port are accepted, including /health", async () => {
	for (const name of ["localhost", "127.0.0.1", "[::1]"]) {
		const host = `${name}:${port}`;
		const health = await raw("GET", "/health", { host });
		assert.equal(health.status, 200, name);
		assert.equal(health.json.ok, true, name);
		const setup = await raw("POST", "/api/auth/setup", { host, ...jsonHeaders }, shortSetup);
		assert.equal(setup.status, 400, name);
		assert.match(String(setup.json.error), /at least 10 characters/);
	}
});

test("a loopback name on the wrong port is refused", async () => {
	const res = await raw("GET", "/health", { host: "127.0.0.1:1" });
	assert.equal(res.status, 403);
	assert.equal(res.json.error, "forbidden_host");
});

test("a cross-origin browser POST is refused and a same-origin POST is accepted", async () => {
	const cross = await raw(
		"POST",
		"/api/auth/setup",
		{ host: `127.0.0.1:${port}`, origin: "http://127.0.0.1:3000", ...jsonHeaders },
		JSON.stringify({ password: "long-enough-password" }),
	);
	assert.equal(cross.status, 403);
	assert.equal(cross.json.error, "cross_origin");

	const fetched = await raw(
		"POST",
		"/api/auth/setup",
		{ host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site", ...jsonHeaders },
		shortSetup,
	);
	assert.equal(fetched.status, 403);
	assert.equal(fetched.json.error, "cross_origin");

	const same = await raw(
		"POST",
		"/api/auth/setup",
		{ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...jsonHeaders },
		shortSetup,
	);
	assert.equal(same.status, 400);
	assert.match(String(same.json.error), /at least 10 characters/);
});

test("a text/plain JSON body is refused and a client with no Origin is accepted", async () => {
	const plain = await raw(
		"POST",
		"/api/auth/setup",
		{ host: `127.0.0.1:${port}`, "content-type": "text/plain" },
		JSON.stringify({ password: "long-enough-password" }),
	);
	assert.equal(plain.status, 415);
	assert.equal(plain.json.error, "unsupported_media_type");

	const charset = await raw(
		"POST",
		"/api/auth/setup",
		{ host: `127.0.0.1:${port}`, "content-type": "application/json; charset=utf-8" },
		shortSetup,
	);
	assert.equal(charset.status, 400);

	// CLI, MCP, awb, and curl send no Origin.
	const noOrigin = await raw("POST", "/api/auth/setup", { host: `127.0.0.1:${port}`, ...jsonHeaders }, shortSetup);
	assert.equal(noOrigin.status, 400);
	assert.match(String(noOrigin.json.error), /at least 10 characters/);

	const status = await raw("GET", "/api/auth/status", { host: `127.0.0.1:${port}` });
	assert.equal(status.json.setupCompleted, false);
});

test("sandboxHost, host.docker.internal, and the docker bridge default are accepted", async () => {
	for (const name of [SANDBOX_HOST, "host.docker.internal", "172.17.0.1"]) {
		const host = `${name}:${port}`;
		const health = await raw("GET", "/health", { host });
		assert.equal(health.status, 200, name);
		const setup = await raw("POST", "/api/auth/setup", { host, ...jsonHeaders }, shortSetup);
		assert.equal(setup.status, 400, name);
		assert.match(String(setup.json.error), /at least 10 characters/);
	}
	const lan = await raw("GET", "/health", { host: `192.0.2.10:${port}` });
	assert.equal(lan.status, 403);
	assert.equal(lan.json.error, "forbidden_host");
});

/**
 * One raw request, including the forms Node's HTTP client will not send
 * (no Host, HTTP/1.0, Upgrade). A reset with no status line is status 0.
 */
function exchange(payload: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port }, () => socket.write(payload));
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			const text = Buffer.concat(chunks).toString("utf8");
			const match = text.match(/^HTTP\/1\.[01] (\d+)/);
			const headerEnd = text.indexOf("\r\n\r\n");
			resolve({
				status: match ? Number(match[1]) : 0,
				body: headerEnd === -1 ? text : text.slice(headerEnd + 4),
			});
		};
		socket.setTimeout(2000, finish);
		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			const text = Buffer.concat(chunks).toString("utf8");
			const headerEnd = text.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const length = text.slice(0, headerEnd).match(/content-length: (\d+)/i);
			const bodyBytes = Buffer.byteLength(text.slice(headerEnd + 4));
			if (!length || bodyBytes >= Number(length[1])) finish();
		});
		socket.on("end", finish);
		socket.on("error", (err: NodeJS.ErrnoException) => {
			if (chunks.length > 0 || err.code === "ECONNRESET" || err.code === "EPIPE") {
				finish();
				return;
			}
			if (!settled) reject(err);
		});
	});
}

test("Host spelling, IPv6 forms, a missing port, and a smuggled name stay closed", async () => {
	// Case is folded and one trailing dot is the same DNS name.
	for (const host of [`LOCALHOST:${port}`, `localhost.:${port}`, `127.0.0.1.:${port}`]) {
		const health = await raw("GET", "/health", { host });
		assert.equal(health.status, 200, host);
		assert.equal(health.json.ok, true, host);
	}

	// A missing port is HTTP's default (80), which is not this connection.
	const bare = await raw("GET", "/health", { host: "localhost" });
	assert.equal(bare.status, 403);
	assert.equal(bare.json.error, "forbidden_host");
	const bareV6 = await raw("GET", "/health", { host: "[::1]" });
	assert.equal(bareV6.status, 403);
	assert.equal(bareV6.json.error, "forbidden_host");

	// One trailing dot is stripped, not a suffix. The extra label stays.
	const glued = await raw("GET", "/health", { host: `localhost.evil.example.:${port}` });
	assert.equal(glued.status, 403);
	assert.equal(glued.json.error, "forbidden_host");

	// Userinfo and a percent-encoded lookalike are not the allowed name.
	const userinfo = await exchange(`GET /health HTTP/1.1\r\nHost: evil@127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
	assert.equal(userinfo.status, 403);
	assert.match(userinfo.body, /forbidden_host/);
	const encoded = await raw("GET", "/health", { host: `%31%32%37%2e%30%2e%30%2e%31:${port}` });
	assert.equal(encoded.status, 403);
	assert.equal(encoded.json.error, "forbidden_host");

	// Unbracketed IPv6 is not a name. Expanded ::1 and the v4-mapped form are
	// not rewritten into the loopback entries — a non-match is a refusal.
	for (const host of [`::1:${port}`, `[0:0:0:0:0:0:0:1]:${port}`, `[::ffff:127.0.0.1]:${port}`]) {
		const res = await exchange(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
		assert.equal(res.status, 403, host);
		assert.match(res.body, /forbidden_host/);
	}
});

test("Origin null, a missing Host, and HTTP/1.0 cannot skip the perimeter", async () => {
	const opaque = await raw(
		"POST",
		"/api/auth/setup",
		{ host: `127.0.0.1:${port}`, origin: "null", ...jsonHeaders },
		shortSetup,
	);
	assert.equal(opaque.status, 403);
	assert.equal(opaque.json.error, "cross_origin");

	const userinfoOrigin = await raw(
		"POST",
		"/api/auth/setup",
		{ host: `127.0.0.1:${port}`, origin: `http://evil@127.0.0.1:${port}`, ...jsonHeaders },
		shortSetup,
	);
	assert.equal(userinfoOrigin.status, 403);
	assert.equal(userinfoOrigin.json.error, "cross_origin");

	// Uppercase scheme is the same origin the browser would send in lowercase.
	const upper = await raw(
		"POST",
		"/api/auth/setup",
		{ host: `127.0.0.1:${port}`, origin: `HTTP://127.0.0.1:${port}`, ...jsonHeaders },
		shortSetup,
	);
	assert.equal(upper.status, 400);
	assert.match(String(upper.json.error), /at least 10 characters/);

	const noHost = await exchange("GET /health HTTP/1.1\r\nConnection: close\r\n\r\n");
	assert.ok(noHost.status === 400 || noHost.status === 403, `missing Host status ${noHost.status}`);
	assert.doesNotMatch(noHost.body, /"ok":true/);

	const http10Bare = await exchange("GET /health HTTP/1.0\r\n\r\n");
	assert.ok(http10Bare.status === 400 || http10Bare.status === 403, `HTTP/1.0 status ${http10Bare.status}`);
	assert.doesNotMatch(http10Bare.body, /"ok":true/);

	const http10 = await exchange(`GET /health HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
	assert.equal(http10.status, 200);
	assert.match(http10.body, /"ok":true/);
});

test("static files use the Host check, and there is no upgrade route", async () => {
	for (const requestPath of ["/", "/favicon.ico", "/assets/app.js"]) {
		const blocked = await raw("GET", requestPath, { host: `evil.example:${port}` });
		assert.equal(blocked.status, 403, requestPath);
		assert.equal(blocked.json.error, "forbidden_host", requestPath);
	}

	const page = await raw("GET", "/", { host: `127.0.0.1:${port}` });
	assert.equal(page.status, 200);
	const favicon = await raw("GET", "/favicon.ico", { host: `127.0.0.1:${port}` });
	assert.equal(favicon.status, 204);

	// The URL parser collapses `..` before the file is opened, and the file
	// still has to live under the UI build directory.
	for (const requestPath of ["/assets/../../package.json", "/%2e%2e/package.json", "/assets/%2e%2e/%2e%2e/package.json"]) {
		const escaped = await raw("GET", requestPath, { host: `127.0.0.1:${port}` });
		assert.equal(escaped.status, 404, requestPath);
		assert.equal(escaped.json.error, "not_found", requestPath);
	}

	// No `upgrade` listener: a websocket handshake is not a route, and a bad
	// Host on that request is still not a 200.
	const upgrade = await exchange(
		`GET /health HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
	);
	assert.notEqual(upgrade.status, 200);
	assert.doesNotMatch(upgrade.body, /"ok":true/);
});
