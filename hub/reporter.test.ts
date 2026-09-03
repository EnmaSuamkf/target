/**
 * Tests for the activity reporter (reporter.ts) and its config surface.
 *
 * Runs against a throwaway TARGET_HOME so the durable queue lives in a scratch
 * DB, and drives flush() with a fake `fetch` so every branch of the §7.4/§7.5
 * contract is exercised without a server. See docs/report-server.es.html §7.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-reporter-test-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");

const { emit, flush, backoffMs } = await import("./reporter.ts");
const { loadReportConfig, isInsecureReportUrl } = await import("./config.ts");
const { TARGET_VERSION } = await import("./version.ts");
const db = await import("./db.ts");

const ENABLED = {
	enabled: true,
	url: "https://ingest.example.com/report",
	token: "secret",
	intervalMs: 30_000,
	includeConversations: "digest" as const,
	instanceId: "fixed-instance",
};


/** Empty the queue between tests. */
function clearQueue(): void {
	db.open().prepare("DELETE FROM report_events").run();
}

test("emit is a no-op when reporting is disabled", () => {
	clearQueue();
	emit("step.done", { workflowId: "w1", data: { a: 1 } }, { ...ENABLED, enabled: false, url: "" });
	assert.equal(db.pendingReportCount(), 0);
});

test("emit enqueues one durable event when enabled", () => {
	clearQueue();
	emit("step.done", { workflowId: "w1", sessionId: "s1", data: { order_index: 2 } }, ENABLED);
	const pending = db.pendingReportEvents(10);
	assert.equal(pending.length, 1);
	assert.equal(pending[0].kind, "step.done");
	assert.equal(pending[0].workflowId, "w1");
	assert.deepEqual(JSON.parse(pending[0].payload), { order_index: 2 });
});

test("flush delivers on a 200 with empty body (whole batch accepted)", async () => {
	clearQueue();
	emit("step.done", { data: {} }, ENABLED);
	emit("step.failed", { data: {} }, ENABLED);
	let sentBody: unknown;
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async (_url, init) => {
			sentBody = JSON.parse(String(init.body));
			return new Response("", { status: 200 });
		},
	});
	assert.equal(summary.delivered, 2);
	assert.equal(db.pendingReportCount(), 0);
	// Envelope carries version + instance id + schema version (§7.1).
	const body = sentBody as { version: string; instance_id: string; schema_version: number; events: unknown[] };
	assert.equal(body.version, TARGET_VERSION);
	assert.equal(body.instance_id, "fixed-instance");
	assert.equal(body.schema_version, 1);
	assert.equal(body.events.length, 2);
});

test("flush honours partial acceptance: accepted delivered, rejected dropped", async () => {
	clearQueue();
	emit("a", { data: {} }, ENABLED);
	emit("b", { data: {} }, ENABLED);
	const ids = db.pendingReportEvents(10).map((e) => e.id);
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async () =>
			new Response(JSON.stringify({ accepted: [ids[0]], rejected: [{ id: ids[1], reason: "schema" }] }), {
				status: 200,
			}),
	});
	assert.equal(summary.delivered, 1);
	assert.equal(summary.dropped, 1);
	// Both are gone from the pending queue (one delivered, one poison-dropped).
	assert.equal(db.pendingReportCount(), 0);
});

test("flush retries the batch with backoff on a 5xx", async () => {
	clearQueue();
	emit("a", { data: {} }, ENABLED);
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async () => new Response("boom", { status: 503 }),
	});
	assert.equal(summary.retried, 1);
	assert.equal(summary.delivered, 0);
	// Still queued, but scheduled for the future (next_try_at = now + backoff), so
	// a re-read sees nothing due yet.
	assert.equal(db.pendingReportEvents(10).length, 0);
	assert.equal(db.pendingReportCount(), 1);
});

test("flush respects Retry-After on a 429", async () => {
	clearQueue();
	emit("a", { data: {} }, ENABLED);
	let calls = 0;
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async () => {
			calls++;
			return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
		},
	});
	assert.equal(calls, 1);
	assert.equal(summary.retried, 1);
	// next_try_at = now + 120s → not due yet.
	assert.equal(db.pendingReportEvents(10).length, 0);
});

test("flush does not drop or deliver on a 400 (config bug, paused not poisoned by delete)", async () => {
	clearQueue();
	emit("a", { data: {} }, ENABLED);
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async () => new Response("bad request", { status: 400 }),
	});
	assert.equal(summary.delivered, 0);
	assert.equal(summary.dropped, 0);
	assert.equal(summary.retried, 1);
	assert.equal(db.pendingReportCount(), 1); // still there, just backed off
});

test("flush retries the whole batch when the transport throws (timeout)", async () => {
	clearQueue();
	emit("a", { data: {} }, ENABLED);
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async () => {
			throw new Error("network down");
		},
	});
	assert.equal(summary.retried, 1);
	assert.equal(db.pendingReportCount(), 1);
});

test("flush is a no-op when disabled", async () => {
	clearQueue();
	emit("a", { data: {} }, ENABLED); // seed something
	let called = false;
	const summary = await flush({
		config: { ...ENABLED, enabled: false },
		fetchImpl: async () => {
			called = true;
			return new Response("", { status: 200 });
		},
	});
	assert.equal(called, false);
	assert.equal(summary.delivered, 0);
});

test("backoff grows and stays under the 5-minute cap + jitter", () => {
	assert.ok(backoffMs(0) >= 1_000);
	assert.ok(backoffMs(20) <= 5 * 60 * 1_000 + 1_000);
	assert.ok(backoffMs(3) >= backoffMs(0));
});

test("TARGET_VERSION matches the root package.json", () => {
	const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
	assert.equal(TARGET_VERSION, pkg.version);
});

test("loadReportConfig parses the environment", () => {
	const prev = { ...process.env };
	process.env.TARGET_REPORT_URL = "https://x.example/report";
	process.env.TARGET_REPORT_TOKEN = "tok";
	process.env.TARGET_REPORT_ENABLED = "true";
	process.env.TARGET_REPORT_INTERVAL_MS = "5000";
	process.env.TARGET_REPORT_INCLUDE_CONVERSATIONS = "full";
	const cfg = loadReportConfig();
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.url, "https://x.example/report");
	assert.equal(cfg.intervalMs, 5000);
	assert.equal(cfg.includeConversations, "full");
	// Disabled when the URL is absent, regardless of the enabled flag.
	delete process.env.TARGET_REPORT_URL;
	assert.equal(loadReportConfig().enabled, false);
	Object.assign(process.env, prev);
});

test("isInsecureReportUrl flags only non-loopback http", () => {
	assert.equal(isInsecureReportUrl("http://example.com/x"), true);
	assert.equal(isInsecureReportUrl("http://127.0.0.1:9000/x"), false);
	assert.equal(isInsecureReportUrl("http://localhost/x"), false);
	assert.equal(isInsecureReportUrl("https://example.com/x"), false);
});
