/**
 * First-run setup on a non-loopback bind, the catalog-status operator gate,
 * and the reset throttle that must not let one address lock every other client.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-perimeter-gaps-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.TARGET_HUB_DOCKER_FRIENDLY = "true";

const { loadConfig } = await import("./config.ts");
const {
	RESET_ADDRESS_LOCK_MS,
	RESET_GLOBAL_LOCK_MS,
	RESET_GLOBAL_MAX_FAILURES,
	createServer,
	resetResetThrottleForTests,
	setClientAddressForTests,
	setResetThrottleClockForTests,
} = await import("./server.ts");

const cfg = loadConfig();
assert.equal(cfg.host, "0.0.0.0");
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	resetResetThrottleForTests();
	server.close();
});

const json = { "content-type": "application/json" };
const badReset = (token: string) =>
	JSON.stringify({ recoveryToken: token, newPassword: "a-brand-new-password" });

async function post(path: string, body: string): Promise<{ status: number; json: { error?: string; retryAfterSec?: number; setupCompleted?: boolean } }> {
	const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: json, body });
	return { status: res.status, json: (await res.json()) as { error?: string; retryAfterSec?: number } };
}

test("setup from a non-loopback address is refused when the hub binds beyond loopback, and allowed from loopback", async () => {
	const allowed = await post("/api/auth/setup", JSON.stringify({ password: "short" }));
	assert.equal(allowed.status, 400);
	assert.match(String(allowed.json.error), /at least 10 characters/);

	setClientAddressForTests(() => "::ffff:127.0.0.1");
	const mapped = await post("/api/auth/setup", JSON.stringify({ password: "short" }));
	assert.equal(mapped.status, 400);

	setClientAddressForTests(() => "203.0.113.9");
	const refused = await post("/api/auth/setup", JSON.stringify({ password: "long-enough-password" }));
	assert.equal(refused.status, 403);
	assert.equal(refused.json.error, "setup_loopback_only");
	assert.match(String((refused.json as { message?: string }).message), /this computer/i);

	const status = await fetch(`${baseUrl}/api/auth/status`);
	assert.equal(((await status.json()) as { setupCompleted: boolean }).setupCompleted, false);
	setClientAddressForTests(null);

	const setupView = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src/views/SetupView.tsx"), "utf8");
	assert.match(setupView, /setup_loopback_only/);
	assert.match(setupView, /only available from this computer/);
});

test("GET /api/catalog/sync/status requires the operator", async () => {
	const open = await fetch(`${baseUrl}/api/catalog/sync/status`);
	assert.equal(open.status, 401);
	assert.equal(((await open.json()) as { error: string }).error, "unauthorized");

	const authed = await fetch(`${baseUrl}/api/catalog/sync/status`, {
		headers: { authorization: `Bearer ${cfg.adminToken}` },
	});
	assert.equal(authed.status, 200);
	const body = (await authed.json()) as { syncedAt: string | null };
	assert.equal(body.syncedAt, null);
});

test("one abusive reset client cannot block a different client indefinitely, and guessing stays limited", async () => {
	resetResetThrottleForTests();
	let now = 1_700_000_000_000;
	setResetThrottleClockForTests(() => now);
	const abused = "AAAAA-BBBBB-CCCCC-DDDDD";
	const victim = "EEEEE-FFFFF-GGGGG-HHHHH";

	setClientAddressForTests(() => "203.0.113.10");
	for (let i = 0; i < 4; i++) {
		const res = await post("/api/auth/password/reset", badReset(abused));
		assert.equal(res.status, 401, `attempt ${i + 1}`);
	}
	const fifth = await post("/api/auth/password/reset", badReset(abused));
	assert.equal(fifth.status, 429);
	assert.equal(fifth.json.error, "too_many_attempts");
	assert.ok((fifth.json.retryAfterSec ?? 0) > 0);
	// The address hold is the short one. The token hold is longer, and it is
	// what the failing response reports (the max of the buckets).
	assert.ok((fifth.json.retryAfterSec ?? 0) >= RESET_ADDRESS_LOCK_MS / 1000);

	const stillAbusing = await post("/api/auth/password/reset", badReset(abused));
	assert.equal(stillAbusing.status, 429);
	assert.ok((stillAbusing.json.retryAfterSec ?? 0) > 0);
	assert.ok((stillAbusing.json.retryAfterSec ?? 0) <= RESET_ADDRESS_LOCK_MS / 1000 + 1);

	setClientAddressForTests(() => "203.0.113.11");
	const otherAddress = await post("/api/auth/password/reset", badReset(victim));
	assert.equal(otherAddress.status, 401);
	assert.equal(otherAddress.json.error, "invalid_token");

	setClientAddressForTests(() => "203.0.113.10");
	now += RESET_ADDRESS_LOCK_MS + 1000;
	const sameAddressOtherToken = await post("/api/auth/password/reset", badReset(victim));
	assert.equal(sameAddressOtherToken.status, 401);
	assert.equal(sameAddressOtherToken.json.error, "invalid_token");

	const sameTokenStillLimited = await post("/api/auth/password/reset", badReset(abused));
	assert.equal(sameTokenStillLimited.status, 429);
	assert.equal(sameTokenStillLimited.json.error, "too_many_attempts");
	assert.ok((sameTokenStillLimited.json.retryAfterSec ?? 0) > RESET_ADDRESS_LOCK_MS / 1000);
});

test("a global reset ceiling holds everyone only briefly", async () => {
	resetResetThrottleForTests();
	let now = 1_700_000_000_000;
	setResetThrottleClockForTests(() => now);
	for (let i = 0; i < RESET_GLOBAL_MAX_FAILURES; i++) {
		setClientAddressForTests(() => `198.51.100.${i + 1}`);
		const res = await post("/api/auth/password/reset", badReset(`TOKEN-${i}-XXXXX-XXXXX-XXXXX`));
		if (i < RESET_GLOBAL_MAX_FAILURES - 1) assert.equal(res.status, 401, `global attempt ${i + 1}`);
		else {
			assert.equal(res.status, 429);
			assert.ok((res.json.retryAfterSec ?? 0) > 0);
			assert.ok((res.json.retryAfterSec ?? 0) <= RESET_GLOBAL_LOCK_MS / 1000);
		}
	}
	setClientAddressForTests(() => "198.51.100.200");
	const during = await post("/api/auth/password/reset", badReset("OTHER-TOKEN-XXXXX-XXXXX-XXXXX"));
	assert.equal(during.status, 429);
	now += RESET_GLOBAL_LOCK_MS + 1000;
	const after = await post("/api/auth/password/reset", badReset("OTHER-TOKEN-XXXXX-XXXXX-XXXXX"));
	assert.equal(after.status, 401);
	resetResetThrottleForTests();
});
