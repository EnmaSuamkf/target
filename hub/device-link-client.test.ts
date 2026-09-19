import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { FetchLike } from "./device-link-client.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-device-link-client-"));
process.env.TARGET_HOME = path.join(home, ".target");
process.env.AWB_HOME = path.join(home, ".awb");
const { cancelDeviceLink, pollDeviceLink, startDeviceLink, waitForDeviceApproval } = await import("./device-link-client.ts");

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("approved device flow opens only safe URL and consumes credentials without exposing them", async () => {
	const requests: Array<{ url: string; init: RequestInit }> = [];
	let opens = 0;
	const fetchImpl: FetchLike = async (url, init) => {
		requests.push({ url: String(url), init });
		if (String(url).endsWith("/requests")) {
			return response({
				request_id: "dlr_safe_id",
				state: "pending",
				browser_url: "https://server.example/link/device/dlr_safe_id",
				polling_credential: "pairing-secret",
				expires_at: "2026-09-19T20:00:00.000Z",
				poll_after_seconds: 3,
			});
		}
		if (String(url).endsWith("/poll")) return response({ request_id: "dlr_safe_id", state: "approved" });
		return response({
			device: { id: "dev_safe_id", status: "active", scopes: ["ingest:write", "sync:write"], credential_version: 1 },
			device_secret: "device-secret",
		});
	};
	const start = await startDeviceLink(
		{ origin: "https://server.example", deviceName: "Test hub" },
		{ fetchImpl, openBrowser: (url) => {
			opens += 1;
			assert.equal(url, "https://server.example/link/device/dlr_safe_id");
		} },
	);
	assert.equal(start.code, "browser_opened");
	assert.equal(opens, 1);
	const done = await pollDeviceLink({ fetchImpl });
	assert.equal(done.code, "connected");
	assert.equal(done.status.state, "connected");
	const serialized = JSON.stringify(done);
	assert.ok(!serialized.includes("pairing-secret"));
	assert.ok(!serialized.includes("device-secret"));
	assert.ok(requests.every((request) => !request.url.includes("pairing-secret") && !request.url.includes("device-secret")));
	assert.equal((requests[1]!.init.headers as Record<string, string>).authorization, "Target-Link pairing-secret");
});

test("human login may remain pending, then approval completes automatically without another hub action", async () => {
	let polls = 0;
	let browserOpens = 0;
	await startDeviceLink(
		{ origin: "https://server.example", deviceName: "Login-approved hub" },
		{
			fetchImpl: async () =>
				response({
					request_id: "dlr_after_login",
					state: "pending",
					browser_url: "https://server.example/link/device/dlr_after_login",
					polling_credential: "login-poll-secret",
					expires_at: "2026-09-19T20:00:00.000Z",
					poll_after_seconds: 3,
				}),
			openBrowser: () => {
				browserOpens += 1;
			},
		},
	);
	const outcome = await waitForDeviceApproval({
		fetchImpl: async (url) => {
			if (String(url).endsWith("/poll")) {
				polls += 1;
				return response({ state: polls === 1 ? "pending" : "approved" });
			}
			return response({
				device: { id: "dev_after_login", status: "active", scopes: ["ingest:write"], credential_version: 1 },
				device_secret: "device-secret-after-login",
			});
		},
		sleep: async (ms) => assert.equal(ms, 3_000),
	});
	assert.equal(browserOpens, 1);
	assert.equal(polls, 2);
	assert.equal(outcome.code, "connected");
	assert.equal(outcome.status.state, "connected");
	assert.ok(!JSON.stringify(outcome).includes("login-poll-secret"));
	assert.ok(!JSON.stringify(outcome).includes("device-secret-after-login"));
});

test("denial, expiry, cancellation and unavailable server return safe actionable outcomes", async () => {
	const startPending = async () =>
		await startDeviceLink(
			{ origin: "https://server.example", deviceName: "Test hub" },
			{
				fetchImpl: async () =>
					response({
						request_id: "dlr_pending",
						state: "pending",
						browser_url: "https://server.example/link/device/dlr_pending",
						polling_credential: "secret",
						expires_at: "2026-09-19T20:00:00.000Z",
						poll_after_seconds: 3,
					}),
				openBrowser: () => {},
			},
		);
	await startPending();
	const denied = await pollDeviceLink({ fetchImpl: async () => response({ state: "denied" }) });
	assert.equal(denied.code, "approval_denied");
	assert.equal(denied.status.state, "local_unconfigured");
	await startPending();
	const expired = await pollDeviceLink({ fetchImpl: async () => response({ state: "expired" }) });
	assert.equal(expired.code, "approval_expired");
	await startPending();
	assert.equal(cancelDeviceLink().code, "cancelled");
	const unavailable = await startDeviceLink({ origin: "https://server.example", deviceName: "Test hub" }, { fetchImpl: async () => { throw new Error("offline"); } });
	assert.equal(unavailable.code, "server_unavailable");
	assert.equal(unavailable.status.state, "temporarily_disconnected");
});

test("a browser URL with any query or fragment is rejected before it can leak into browser history", async () => {
	let opened = false;
	const outcome = await startDeviceLink(
		{ origin: "https://server.example", deviceName: "Test hub" },
		{
			fetchImpl: async () =>
				response({
					request_id: "dlr_bad_url",
					browser_url: "https://server.example/link/device/dlr_bad_url?x=unknown-value",
					polling_credential: "never-opened-secret",
					expires_at: "2026-09-19T20:00:00.000Z",
					poll_after_seconds: 3,
				}),
			openBrowser: () => {
				opened = true;
			},
		},
	);
	assert.equal(outcome.code, "relink_required");
	assert.equal(opened, false);
});

test("wait loop uses server cadence and honours cancellation without network credentials in results", async () => {
	const controller = new AbortController();
	await startDeviceLink(
		{ origin: "https://server.example", deviceName: "Test hub" },
		{
			fetchImpl: async () =>
				response({
					request_id: "dlr_wait",
					state: "pending",
					browser_url: "https://server.example/link/device/dlr_wait",
					polling_credential: "wait-secret",
					expires_at: "2026-09-19T20:00:00.000Z",
					poll_after_seconds: 3,
				}),
			openBrowser: () => {},
		},
	);
	const outcome = await waitForDeviceApproval({
		signal: controller.signal,
		fetchImpl: async () => response({ state: "pending" }),
		sleep: async (ms) => {
			assert.equal(ms, 3_000);
			controller.abort();
		},
	});
	assert.equal(outcome.code, "cancelled");
	assert.ok(!JSON.stringify(outcome).includes("wait-secret"));
});

test("target-server handoff model approves only after existing authorized login, without a hub click", async () => {
	let state: "pending" | "approved" = "pending";
	let consumed = 0;
	const visitDeviceLink = (account: { exists: boolean; permissions: string[] } | null): number => {
		if (!account) return 302; // The server starts its existing login flow.
		if (!account.exists || !account.permissions.includes("devices.link")) return 403;
		if (state === "pending") state = "approved"; // Login callback returns directly to this URL.
		return 200;
	};
	const fetchImpl: FetchLike = async (url, init) => {
		const requestUrl = String(url);
		if (requestUrl.endsWith("/requests")) {
			return response({
				request_id: "dlr_handoff",
				state: "pending",
				browser_url: "https://server.example/link/device/dlr_handoff",
				polling_credential: "handoff-poll-secret",
				expires_at: "2026-09-19T20:00:00.000Z",
				poll_after_seconds: 3,
			}, 201);
		}
		assert.equal((init?.headers as Record<string, string>).authorization, "Target-Link handoff-poll-secret");
		if (requestUrl.endsWith("/poll")) return response({ request_id: "dlr_handoff", state });
		if (state !== "approved") return response({ error: "request_not_approved" }, 409);
		consumed += 1;
		if (consumed > 1) return response({ error: "request_already_consumed" }, 410);
		return response({
			device: { id: "dev_handoff", status: "active", scopes: ["ingest:write"], credential_version: 1 },
			device_secret: "handoff-device-secret",
		});
	};

	await startDeviceLink({ origin: "https://server.example", deviceName: "Handoff hub" }, { fetchImpl, openBrowser: () => {} });
	assert.equal(visitDeviceLink(null), 302);
	assert.equal(state, "pending", "visiting without login must not approve");
	assert.equal(visitDeviceLink({ exists: true, permissions: [] }), 403);
	assert.equal(state, "pending", "a read-only account must leave the request unconsumed");
	assert.equal((await pollDeviceLink({ fetchImpl })).code, "waiting_for_approval");

	assert.equal(visitDeviceLink({ exists: true, permissions: ["devices.link"] }), 200);
	const outcome = await pollDeviceLink({ fetchImpl });
	assert.equal(outcome.code, "connected");
	assert.equal(consumed, 1, "the hub consumes once after automatic approval");
	assert.ok(!JSON.stringify(outcome).includes("handoff-poll-secret"));
	assert.ok(!JSON.stringify(outcome).includes("handoff-device-secret"));
	cancelDeviceLink();
});
