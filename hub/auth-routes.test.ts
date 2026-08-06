/**
 * HTTP tests for the single-user access layer's routes (server.ts):
 *
 *  - GET  /api/auth/status            → open; flips to setupCompleted after setup
 *  - POST /api/auth/setup             → creates the singleton account, returns the
 *                                       one-time recovery token, sets the session
 *                                       cookie; permanent 409 afterwards
 *  - POST /api/auth/login             → 401 on a wrong password, 200 + cookie on the right one
 *  - POST /api/auth/logout            → kills the session server-side
 *  - GET  /api/auth/me                → 401 without a session, the account with one
 *  - POST /api/auth/password/reset    → 401 on a bad token; on a good one rotates
 *                                       the token, kills other sessions, logs in
 *  - the access gate                  → every data route answers 401
 *                                       {"error":"login_required"} without a
 *                                       session or the admin bearer token
 *
 * Same throwaway-TARGET_HOME convention as server.test.ts. Tests in this file
 * share one account and one server, and run in order.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-auth-routes-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

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
const NEW_PASSWORD = "a brand new password";

/** The setup-time recovery token (seen once, exactly like a user's would be). */
let recoveryToken = "";
/** The session cookie issued by setup, then replaced by login's. */
let sessionCookie = "";

function adminHeaders() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

function cookieHeaders() {
	return { cookie: sessionCookie };
}

/** Extracts the `target_session=...` pair from a response's Set-Cookie. */
function readSessionCookie(res: Response): string {
	const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("target_session="));
	assert.ok(setCookie, "expected a target_session Set-Cookie");
	return setCookie.split(";")[0];
}

test("status is open and reports setup not completed; data routes are gated", async () => {
	const statusRes = await fetch(`${baseUrl}/api/auth/status`);
	assert.equal(statusRes.status, 200);
	assert.deepEqual(await statusRes.json(), { setupCompleted: false });

	// The gate: reads as well as mutations answer 401 login_required without a
	// session or the admin token — and the admin token still passes (transition).
	const getRes = await fetch(`${baseUrl}/api/workflows`);
	assert.equal(getRes.status, 401);
	assert.deepEqual(await getRes.json(), { error: "login_required" });
	const adminRes = await fetch(`${baseUrl}/api/workflows`, { headers: adminHeaders() });
	assert.equal(adminRes.status, 200);
});

test("setup validates the password floor", async () => {
	const res = await fetch(`${baseUrl}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: "short" }),
	});
	assert.equal(res.status, 400);
	assert.match(String((await res.json()).error), /at least 10 characters/);
});

test("setup creates the account, returns the token once and signs the user in", async () => {
	const res = await fetch(`${baseUrl}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: PASSWORD, displayName: "Ada" }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { account: { displayName: string | null }; recoveryToken: string };
	assert.equal(body.account.displayName, "Ada");
	assert.match(body.recoveryToken, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
	recoveryToken = body.recoveryToken;
	sessionCookie = readSessionCookie(res);

	// The session from setup is live: gated routes open, and me answers.
	const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: cookieHeaders() });
	assert.equal(meRes.status, 200);
	assert.equal(((await meRes.json()) as { account: { displayName: string } }).account.displayName, "Ada");
	const listRes = await fetch(`${baseUrl}/api/workflows`, { headers: cookieHeaders() });
	assert.equal(listRes.status, 200);
});

test("setup is a one-time door: a second attempt is a permanent 409", async () => {
	const res = await fetch(`${baseUrl}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: "another password entirely" }),
	});
	assert.equal(res.status, 409);
	assert.deepEqual(await res.json(), { error: "setup_already_completed" });

	const statusRes = await fetch(`${baseUrl}/api/auth/status`);
	assert.deepEqual(await statusRes.json(), { setupCompleted: true });
});

test("me without a session is 401; logout kills the session server-side", async () => {
	assert.equal((await fetch(`${baseUrl}/api/auth/me`)).status, 401);

	const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: cookieHeaders() });
	assert.equal(logoutRes.status, 200);
	// The old cookie is now worthless — the row is gone, not just the cookie.
	assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: cookieHeaders() })).status, 401);
	sessionCookie = "";
});

test("login rejects a wrong password uniformly and accepts the right one", async () => {
	const badRes = await fetch(`${baseUrl}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: "wrong password here" }),
	});
	assert.equal(badRes.status, 401);
	assert.deepEqual(await badRes.json(), { error: "invalid_credentials" });

	const okRes = await fetch(`${baseUrl}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: PASSWORD }),
	});
	assert.equal(okRes.status, 200);
	sessionCookie = readSessionCookie(okRes);
	assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: cookieHeaders() })).status, 200);
});

test("password reset: bad token is 401, good token rotates it and kills other sessions", async () => {
	const badRes = await fetch(`${baseUrl}/api/auth/password/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ recoveryToken: "AAAAA-BBBBB-CCCCC-DDDDD", newPassword: NEW_PASSWORD }),
	});
	assert.equal(badRes.status, 401);
	assert.deepEqual(await badRes.json(), { error: "invalid_token" });

	const oldSession = sessionCookie;
	const res = await fetch(`${baseUrl}/api/auth/password/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		// Typed sloppily on purpose: lowercase, no dashes — normalization applies.
		body: JSON.stringify({ recoveryToken: recoveryToken.replaceAll("-", "").toLowerCase(), newPassword: NEW_PASSWORD }),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { recoveryToken: string };
	assert.match(body.recoveryToken, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
	assert.notEqual(body.recoveryToken, recoveryToken);
	recoveryToken = body.recoveryToken;

	// The pre-reset session died with the reset; the reset issued a fresh one.
	assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: oldSession } })).status, 401);
	sessionCookie = readSessionCookie(res);
	assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: cookieHeaders() })).status, 200);

	// Old password fails, new password works.
	const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: PASSWORD }),
	});
	assert.equal(oldLogin.status, 401);
	const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: NEW_PASSWORD }),
	});
	assert.equal(newLogin.status, 200);
});

test("five bad reset attempts trip the per-IP throttle (429 with retryAfterSec)", async () => {
	for (let i = 0; i < 4; i++) {
		const res = await fetch(`${baseUrl}/api/auth/password/reset`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ recoveryToken: "AAAAA-BBBBB-CCCCC-DDDDD", newPassword: NEW_PASSWORD }),
		});
		assert.equal(res.status, 401);
	}
	const fifth = await fetch(`${baseUrl}/api/auth/password/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ recoveryToken: "AAAAA-BBBBB-CCCCC-DDDDD", newPassword: NEW_PASSWORD }),
	});
	assert.equal(fifth.status, 429);
	const body = (await fifth.json()) as { error: string; retryAfterSec: number };
	assert.equal(body.error, "too_many_attempts");
	assert.ok(body.retryAfterSec > 0);

	// Even a VALID token is held while throttled — the hold is on the endpoint.
	const held = await fetch(`${baseUrl}/api/auth/password/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ recoveryToken, newPassword: NEW_PASSWORD }),
	});
	assert.equal(held.status, 429);
});
