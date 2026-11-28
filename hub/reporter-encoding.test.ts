/**
 * Encoded ingest batches and content refusals (reporter.ts).
 *
 * A hosted target-server sits behind an edge firewall (Render / Cloudflare WAF)
 * that answers a 403 HTML "Blocked" page to bodies whose agent transcripts
 * contain shell commands (`curl -s …`). The reporter must:
 *  - send encoded batches (gzip+base64) when the server advertises them, or after
 *    a plain batch was edge-blocked, and fall back to plain for an older server;
 *  - never let one refused event hold back the rest of the queue.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeEach, test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-reporter-encoding-test-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");

const { emit, flush, INGEST_ENCODING, MAX_EVENTS_PER_PASS, POISON_MAX_ATTEMPTS, resetIngestEncodingMemory } = await import("./reporter.ts");
const { clearServerCapabilities, recordServerCapabilities } = await import("./server-capabilities.ts");
const db = await import("./db.ts");

const ENABLED = {
	enabled: true,
	url: "https://ingest.example.com/ingest",
	token: "secret",
	intervalMs: 30_000,
	includeConversations: "full" as const,
	instanceId: "fixed-instance",
};

interface WireEvent {
	id: string;
	kind: string;
	data: { text?: string };
}
interface Sent {
	encoded: boolean;
	events: WireEvent[];
	raw: string;
}

/** Decode what the reporter POSTed, whichever form it used. */
function decode(body: string): Sent {
	const parsed = JSON.parse(body) as { events?: WireEvent[]; events_encoding?: string; events_encoded?: string };
	if (parsed.events_encoding !== undefined) {
		assert.equal(parsed.events_encoding, INGEST_ENCODING);
		assert.equal(parsed.events, undefined, "an encoded batch has no plain events");
		const events = JSON.parse(gunzipSync(Buffer.from(String(parsed.events_encoded), "base64")).toString("utf8")) as WireEvent[];
		return { encoded: true, events, raw: body };
	}
	return { encoded: false, events: parsed.events ?? [], raw: body };
}

const blockedPage = () => new Response("<!DOCTYPE html><title>Blocked</title>", { status: 403, headers: { "content-type": "text/html; charset=UTF-8" } });
const ok = (events: WireEvent[]) =>
	new Response(JSON.stringify({ accepted: events.map((e) => e.id), rejected: [] }), { status: 200, headers: { "content-type": "application/json" } });

/** The edge's rule: a plain body that shows the command is refused. */
const WAF = /`curl -s /;

function seed(texts: string[]): string[] {
	for (const text of texts) emit("conversation.snapshot", { workflowId: "w1", data: { mode: "full", text } }, ENABLED);
	return db.pendingReportEvents(1000).map((e) => e.id);
}

beforeEach(() => {
	db.open().prepare("DELETE FROM report_events").run();
	resetIngestEncodingMemory();
	clearServerCapabilities();
});

test("sends encoded batches when the server advertises gzip+base64", async () => {
	recordServerCapabilities({ server_capabilities: { events: [], ingest_encodings: [INGEST_ENCODING] } });
	seed(["confirm with `curl -s http://localhost:3000/`", "plain words"]);
	const sent: Sent[] = [];
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async (_url, init) => {
			const s = decode(String(init.body));
			sent.push(s);
			return WAF.test(s.raw) ? blockedPage() : ok(s.events);
		},
	});
	assert.equal(sent.length, 1);
	assert.equal(sent[0].encoded, true);
	assert.doesNotMatch(sent[0].raw, WAF, "the command is not visible in the encoded body");
	assert.equal(sent[0].events.length, 2);
	assert.match(String(sent[0].events[0].data.text), /curl -s/);
	assert.equal(summary.delivered, 2);
	assert.equal(db.pendingReportCount(), 0);
});

test("a plain batch blocked by the edge is resent encoded in the same pass, and later passes encode directly", async () => {
	seed(["confirm with `curl -s http://localhost:3000/`"]);
	const sent: Sent[] = [];
	const fetchImpl = async (_url: string, init: RequestInit) => {
		const s = decode(String(init.body));
		sent.push(s);
		return WAF.test(s.raw) ? blockedPage() : ok(s.events);
	};
	const logs: string[] = [];
	const first = await flush({ config: ENABLED, fetchImpl, log: (m) => logs.push(m) });
	assert.deepEqual(
		sent.map((s) => s.encoded),
		[false, true],
	);
	assert.equal(first.delivered, 1);
	assert.ok(logs.some((m) => /sending encoded batches/.test(m)));

	seed(["another `curl -s http://x/` transcript"]);
	sent.length = 0;
	const second = await flush({ config: ENABLED, fetchImpl });
	assert.deepEqual(
		sent.map((s) => s.encoded),
		[true],
	);
	assert.equal(second.delivered, 1);
	assert.equal(db.pendingReportCount(), 0);
});

test("an older server that does not understand the encoding gets plain batches", async () => {
	recordServerCapabilities({ server_capabilities: { events: [], ingest_encodings: [INGEST_ENCODING] } });
	seed(["hello"]);
	const sent: Sent[] = [];
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async (_url, init) => {
			const s = decode(String(init.body));
			sent.push(s);
			if (s.encoded) {
				return new Response(JSON.stringify({ error: "missing instance_id or events[]" }), { status: 422, headers: { "content-type": "application/json" } });
			}
			return ok(s.events);
		},
	});
	assert.deepEqual(
		sent.map((s) => s.encoded),
		[true, false],
	);
	assert.equal(summary.delivered, 1);
});

test("one refused event no longer holds back the queue: it is isolated and the rest is delivered", async () => {
	seed(["one", "two", "POISON", "four", "five", "six", "seven"]);
	// Look it up by content: events emitted in the same millisecond are ordered by id.
	const poison = db.pendingReportEvents(1000).find((e) => JSON.parse(e.payload).text === "POISON")!.id;
	let requests = 0;
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async (_url, init) => {
			requests++;
			const s = decode(String(init.body));
			// Refused for its content even when encoded.
			return s.events.some((e) => e.data.text === "POISON") ? blockedPage() : ok(s.events);
		},
	});
	assert.equal(summary.delivered, 6);
	assert.equal(summary.retried, 1);
	assert.ok(requests < 20, `bounded requests (${requests})`);
	const left = db.open().prepare("SELECT id, attempts, delivered_at FROM report_events WHERE delivered_at IS NULL").all() as {
		id: string;
		attempts: number;
	}[];
	assert.deepEqual(
		left.map((r) => r.id),
		[poison],
	);
	assert.equal(left[0].attempts, 1);
});

test(`an event refused ${POISON_MAX_ATTEMPTS} times on its own is dropped and logged`, async () => {
	const [poison] = seed(["POISON"]);
	db.open().prepare("UPDATE report_events SET attempts = ? WHERE id = ?").run(POISON_MAX_ATTEMPTS - 1, poison);
	const logs: string[] = [];
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async () => blockedPage(),
		log: (m) => logs.push(m),
	});
	assert.equal(summary.dropped, 1);
	assert.equal(db.pendingReportCount(), 0);
	assert.ok(logs.some((m) => m.includes(poison) && /blocked by the edge/.test(m)));
});

test("a 403 with a JSON body is still treated as an auth/config answer, not as content", async () => {
	seed(["hello"]);
	let requests = 0;
	const summary = await flush({
		config: ENABLED,
		fetchImpl: async () => {
			requests++;
			return new Response(JSON.stringify({ error: "instance_owned_by_device" }), { status: 403, headers: { "content-type": "application/json" } });
		},
	});
	assert.equal(requests, 1);
	assert.equal(summary.retried, 1);
	assert.equal(summary.dropped, 0);
	assert.equal(db.pendingReportCount(), 1);
});

test("only one flush pass runs at a time: an overlapping call sends nothing", async () => {
	seed(["one", "two", "three"]);
	let requests = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const fetchImpl = async (_url: string, init: RequestInit) => {
		requests++;
		await gate;
		return ok(decode(String(init.body)).events);
	};
	const first = flush({ config: ENABLED, fetchImpl });
	const second = await flush({ config: ENABLED, fetchImpl });
	assert.deepEqual(second, { delivered: 0, retried: 0, dropped: 0 });
	release();
	assert.equal((await first).delivered, 3);
	assert.equal(requests, 1);
	// Once the pass is over, the next call runs normally.
	seed(["four"]);
	assert.equal((await flush({ config: ENABLED, fetchImpl })).delivered, 1);
});

test(`one pass sends at most ${MAX_EVENTS_PER_PASS} events; the rest waits for the next pass`, async () => {
	for (let i = 0; i < MAX_EVENTS_PER_PASS + 150; i++) emit("step.done", { workflowId: "w1", data: { i } }, ENABLED);
	const fetchImpl = async (_url: string, init: RequestInit) => ok(decode(String(init.body)).events);
	assert.equal((await flush({ config: ENABLED, fetchImpl })).delivered, MAX_EVENTS_PER_PASS);
	assert.equal(db.pendingReportCount(), 150);
	assert.equal((await flush({ config: ENABLED, fetchImpl })).delivered, 150);
});
