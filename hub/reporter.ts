/**
 * Activity reporting — the client side of the contract in
 * docs/report-server.es.html §7.
 *
 * Two halves, deliberately split so the network never touches the hot path:
 *
 *  - `emit()` does ONE local INSERT into `report_events` and returns. It is a
 *    no-op when reporting is disabled (no `TARGET_REPORT_URL`), and it never
 *    throws into its caller — a reporting hiccup must not change a workflow's
 *    outcome.
 *  - `flush()` runs on the daemon's interval: it drains the queue in batches,
 *    POSTs each batch to the ingest endpoint, and settles the rows by the
 *    server's answer (delivered / retry-with-backoff / drop-as-poison).
 *
 * `fetch` is injectable so tests can drive every branch without a server.
 */
import * as crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import {
	dropReportEvents,
	enqueueReportEvent,
	getOrCreateInstanceId,
	markReportEventsDelivered,
	markReportEventsRetry,
	pendingReportCount,
	pendingReportEvents,
	purgeDeliveredReportEvents,
	type ReportEventRow,
} from "./db.ts";
import { type ReportConfig } from "./config.ts";
import { deviceHeaders, handleDeviceAuthResponse, remoteAuth } from "./device-auth.ts";
import { getDeviceCredential } from "./device-link.ts";
import { loadEffectiveReportConfig } from "./remote-config.ts";
import { serverSupportsIngestEncoding } from "./server-capabilities.ts";
import { TARGET_VERSION } from "./version.ts";

/** Version of THIS wire contract (§7.1). Bump when the envelope/event shapes change. */
export const REPORT_SCHEMA_VERSION = 1;

/** Max events per POST (§7.1 caps batch size). */
export const MAX_BATCH_EVENTS = 100;

/** Request timeout, mirroring notifier.ts's outbound-fetch discipline. */
const REPORT_TIMEOUT_MS = 15_000;

/** Backoff ceiling: 2^attempts seconds, capped at 5 minutes, plus jitter (§7.5). */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60 * 1_000;

/**
 * Encoded batches: `events_encoding` + `events_encoded` (base64 of gzip(JSON
 * events[])) instead of `events`. The edge in front of a hosted server (Render /
 * Cloudflare WAF) blocks plain bodies whose transcripts contain shell commands
 * (`curl -s …`) with a 403 HTML page; encoded, the body is opaque to it and ~4x
 * smaller. Used when the server advertises it (server_capabilities.ingest_encodings)
 * or after a plain batch was edge-blocked; see target-server ingest-encoding.mjs.
 */
export const INGEST_ENCODING = "gzip+base64";

/**
 * A batch the server (or the edge in front of it) refuses for its CONTENT —
 * 413, or a 403 without a JSON body (an edge firewall page, never our server) —
 * is split in halves so one bad event cannot hold back the whole queue. A single
 * event refused this many times is dropped (logged), like a server-side reject.
 */
export const POISON_MAX_ATTEMPTS = 5;

/** Content refusals tolerated per flush pass before backing off (bounds the requests a bad queue costs). */
const MAX_CONTENT_REFUSALS_PER_PASS = 40;

/** Delivered events are kept this long (for debugging) then purged. */
const DELIVERED_RETENTION_MS = 24 * 60 * 60 * 1_000;

/** A minimal `fetch` shape — enough to POST and read a JSON body. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FlushOptions {
	/** Override the client config (tests). Defaults to `loadReportConfig()`. */
	config?: ReportConfig;
	/** Override the transport (tests). Defaults to global `fetch`. */
	fetchImpl?: FetchLike;
	/** Log sink; defaults to silent. */
	log?: (message: string, level?: "info" | "warning" | "error") => void;
	/** Clock injection for deterministic backoff timestamps (tests). */
	now?: () => number;
}

export interface EmitInput {
	workflowId?: string | null;
	sessionId?: string | null;
	data?: unknown;
}

/**
 * Queue one activity event. No-op (and no DB write) when reporting is disabled,
 * so every emission site can call unconditionally. Never throws.
 */
export function emit(kind: string, input: EmitInput = {}, config: ReportConfig = loadEffectiveReportConfig()): void {
	if (!config.enabled) return;
	try {
		enqueueReportEvent({
			kind,
			workflowId: input.workflowId ?? null,
			sessionId: input.sessionId ?? null,
			data: input.data ?? {},
		});
	} catch {
		// Reporting is best-effort: a failed enqueue must never surface to the caller.
	}
}

interface IngestResponse {
	accepted?: unknown;
	rejected?: unknown;
}

/** Exponential backoff with jitter, in ms, for the Nth attempt (§7.5). */
export function backoffMs(attempts: number): number {
	const base = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
	return base + Math.floor(Math.random() * Math.min(base, 1_000));
}

function toEnvelope(events: ReportEventRow[], instanceId: string, batchId: string, encode = false): string {
	const wireEvents = events.map((e) => ({
		id: e.id,
		kind: e.kind,
		workflow_id: e.workflowId,
		session_id: e.sessionId,
		created_at: e.createdAt,
		data: parsePayload(e.payload),
	}));
	return JSON.stringify({
		batch_id: batchId,
		instance_id: instanceId,
		version: TARGET_VERSION,
		schema_version: REPORT_SCHEMA_VERSION,
		sent_at: new Date().toISOString(),
		...(encode
			? { events_encoding: INGEST_ENCODING, events_encoded: gzipSync(Buffer.from(JSON.stringify(wireEvents), "utf8")).toString("base64") }
			: { events: wireEvents }),
	});
}

/**
 * What this process learned per ingest URL: true = send encoded (a plain batch
 * was edge-blocked), false = send plain (the server did not understand the
 * encoding). Unset = follow server_capabilities.
 */
const encodingByUrl = new Map<string, boolean>();

function wantsEncoding(url: string): boolean {
	return encodingByUrl.get(url) ?? serverSupportsIngestEncoding(INGEST_ENCODING);
}

/** Forget what was learned per URL (tests). */
export function resetIngestEncodingMemory(): void {
	encodingByUrl.clear();
}

/** The body of an error answer as a JSON object, or null (empty, HTML page, …). Reads the body. */
async function errorObject(res: Response): Promise<{ error?: unknown } | null> {
	const body = await safeJson(res);
	return body && typeof body === "object" && !Array.isArray(body) ? (body as { error?: unknown }) : null;
}

/**
 * Device-authenticated ingest is attributed to the server-issued device id.
 * The durable local UUID remains exclusively the identity of legacy reporters.
 */
export function resolveReportInstanceId(config: ReportConfig): string | null {
	if (remoteAuth("ingest:write").kind !== "device") {
		return getOrCreateInstanceId(config.instanceId);
	}
	return getDeviceCredential()?.deviceId ?? null;
}

function parsePayload(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return { _unparsed: raw };
	}
}

/** Extract the string ids from an ingest response's accepted/rejected arrays (§7.4). */
function idsFrom(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string") out.push(item);
		else if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
			out.push((item as { id: string }).id);
		}
	}
	return out;
}

/**
 * Most events one flush pass sends. The daemon flushes every 30 s, so a large
 * backlog drains in steady slices instead of one long burst against the server.
 */
export const MAX_EVENTS_PER_PASS = 1_000;

type FlushSummary = { delivered: number; retried: number; dropped: number };

/** The pass in progress, if any (see flush). */
let inFlight: Promise<FlushSummary> | null = null;

/**
 * Drain and deliver the queue. Returns a small summary (handy for tests/logs).
 * Safe to call when disabled — it just returns zeros without touching the DB.
 *
 * One pass at a time: a call made while a pass is still running (the daemon's
 * 30 s interval during a long backlog) returns zeros without sending anything.
 * Overlapping passes would read the same pending rows and upload them in parallel.
 */
export async function flush(options: FlushOptions = {}): Promise<FlushSummary> {
	if (inFlight) return { delivered: 0, retried: 0, dropped: 0 };
	const pass = flushPass(options);
	inFlight = pass;
	try {
		return await pass;
	} finally {
		inFlight = null;
	}
}

async function flushPass(options: FlushOptions): Promise<FlushSummary> {
	const config = options.config ?? loadEffectiveReportConfig();
	const summary = { delivered: 0, retried: 0, dropped: 0 };
	if (!config.enabled) return summary;
	if (remoteAuth("ingest:write").kind === "blocked") return summary;

	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
	if (!fetchImpl) return summary;
	const log = options.log ?? (() => {});
	const now = options.now ?? Date.now;

	// Deliver in batches until the queue drains or a batch tells us to stop.
	let batchLimit = MAX_BATCH_EVENTS;
	let contentRefusals = 0;
	let negotiated = false;
	let sent = 0;
	for (;;) {
		if (sent >= MAX_EVENTS_PER_PASS) break;
		const batch = pendingReportEvents(Math.min(batchLimit, MAX_EVENTS_PER_PASS - sent));
		if (batch.length === 0) break;
		const ids = batch.map((e) => e.id);
		const batchId = crypto.randomUUID();
		const auth = remoteAuth("ingest:write");
		if (auth.kind === "blocked") break;
		const instanceId = resolveReportInstanceId(config);
		if (!instanceId) break;
		const encode = wantsEncoding(config.url);
		const body = toEnvelope(batch, instanceId, batchId, encode);
		const signed = auth.kind === "device" ? deviceHeaders("POST", new URL(config.url).pathname, body) : null;
		if (auth.kind === "device" && !signed) break;

		let res: Response;
		try {
			res = await fetchImpl(config.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(signed ?? { authorization: `Bearer ${config.token}` }),
					"idempotency-key": batchId,
					"x-target-version": TARGET_VERSION,
				},
				body,
				signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
			});
		} catch (err) {
			// Timeout / network error → whole batch retries (§7.5, "timeout / red").
			markReportEventsRetry(ids, new Date(now() + backoffMs(batch[0].attempts)).toISOString());
			summary.retried += ids.length;
			log(`report flush: transport error, will retry ${ids.length} event(s): ${String(err)}`, "warning");
			break;
		}

		sent += batch.length;
		const status = res.status;
		// Error answers that the branches below inspect; the body is read once here.
		const errorBody = status === 400 || status === 401 || status === 403 || status === 422 ? await errorObject(res) : null;
		// A 403 without a JSON body never comes from target-server: it is the edge
		// (Render / Cloudflare WAF) refusing the request for its content. It says
		// nothing about our credentials, so it must not reach the auth handling.
		const edgeBlocked = status === 403 && errorBody === null;

		// Encoding negotiation, at most one switch per pass.
		if (edgeBlocked && !encode && !negotiated) {
			negotiated = true;
			encodingByUrl.set(config.url, true);
			log("report flush: the edge in front of the server blocked a plain batch; sending encoded batches from now on", "warning");
			continue;
		}
		if (encode && (status === 400 || status === 422) && errorBody !== null) {
			const notUnderstood = status === 422 || errorBody.error === "unsupported_events_encoding";
			if (notUnderstood && !negotiated) {
				negotiated = true;
				encodingByUrl.set(config.url, false);
				log("report flush: the server does not accept encoded batches; sending plain batches", "warning");
				continue;
			}
			markReportEventsRetry(ids, new Date(now() + BACKOFF_CAP_MS).toISOString());
			summary.retried += ids.length;
			log(`report flush: server ${status} (config/auth?); pausing this pass`, "error");
			break;
		}

		// Refused for its content (edge firewall, or too large): isolate the bad
		// event(s) instead of retrying the same batch forever, which would hold
		// back every newer event behind it.
		if (edgeBlocked || status === 413) {
			if (status === 413) await res.text().catch(() => "");
			contentRefusals++;
			const why = edgeBlocked ? "blocked by the edge in front of the server (403)" : "too large for the server (413)";
			if (contentRefusals > MAX_CONTENT_REFUSALS_PER_PASS) {
				markReportEventsRetry(ids, new Date(now() + backoffMs(batch[0].attempts)).toISOString());
				summary.retried += ids.length;
				log(`report flush: ${ids.length} event(s) ${why}; too many refusals this pass, backing off`, "warning");
				break;
			}
			if (batch.length > 1) {
				batchLimit = Math.ceil(batch.length / 2);
				continue;
			}
			const [event] = batch;
			if (event.attempts + 1 >= POISON_MAX_ATTEMPTS) {
				dropReportEvents([event.id]);
				summary.dropped += 1;
				log(`report flush: dropped event ${event.id} (${event.kind}): ${why} ${event.attempts + 1} times`, "warning");
			} else {
				markReportEventsRetry([event.id], new Date(now() + backoffMs(event.attempts)).toISOString());
				summary.retried += 1;
			}
			batchLimit = MAX_BATCH_EVENTS;
			continue;
		}

		const authError = status === 401 || status === 403 ? errorBody : null;
		if (authError?.error === "device_identity_mismatch") {
			// This means client and server disagree about the ingest contract, not
			// that the device credential has been revoked. Keep the local link and
			// queue intact; a corrected hub/server can retry the exact events later.
			markReportEventsRetry(ids, new Date(now() + BACKOFF_CAP_MS).toISOString());
			summary.retried += ids.length;
			log("report flush: device identity mismatch at /ingest; waiting for a compatible configuration", "error");
			break;
		}
		if (handleDeviceAuthResponse(status, authError?.error)) {
			markReportEventsRetry(ids, new Date(now() + BACKOFF_CAP_MS).toISOString());
			summary.retried += ids.length;
			break;
		}
		if (status >= 200 && status < 300) {
			// Success, possibly partial: honour accepted/rejected; empty body = all accepted.
			let accepted = ids;
			let poisoned: string[] = [];
			const body = (await safeJson(res)) as IngestResponse | null;
			if (body && (Array.isArray(body.accepted) || Array.isArray(body.rejected))) {
				accepted = idsFrom(body.accepted);
				poisoned = idsFrom(body.rejected);
				// Anything neither accepted nor explicitly rejected stays queued to retry.
			}
			markReportEventsDelivered(accepted);
			dropReportEvents(poisoned);
			summary.delivered += accepted.length;
			summary.dropped += poisoned.length;
			if (poisoned.length) log(`report flush: server rejected ${poisoned.length} event(s) as invalid`, "warning");
			// After isolating a refused event, grow back to full batches.
			batchLimit = Math.min(MAX_BATCH_EVENTS, batchLimit * 2);
			// Loop again to drain any remaining queued events.
			continue;
		}

		if (status === 409) {
			// Duplicate (idempotency) → treat as delivered.
			markReportEventsDelivered(ids);
			summary.delivered += ids.length;
			continue;
		}

		if (status === 429) {
			// Respect Retry-After when present; else backoff.
			const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now());
			const delay = retryAfterMs ?? backoffMs(batch[0].attempts);
			markReportEventsRetry(ids, new Date(now() + delay).toISOString());
			summary.retried += ids.length;
			log("report flush: 429 rate-limited; backing off", "warning");
			break;
		}

		if (status >= 500) {
			// Server fault → retry with backoff.
			markReportEventsRetry(ids, new Date(now() + backoffMs(batch[0].attempts)).toISOString());
			summary.retried += ids.length;
			log(`report flush: server ${status}; will retry`, "warning");
			break;
		}

		// 400/401/403/404 and other 4xx: a client/config bug. Retrying the same
		// payload is a poison loop, so schedule a long backoff (so a fixed config
		// eventually recovers) and stop this pass rather than hammering.
		markReportEventsRetry(ids, new Date(now() + BACKOFF_CAP_MS).toISOString());
		summary.retried += ids.length;
		log(`report flush: server ${status} (config/auth?); pausing this pass`, "error");
		break;
	}

	// Housekeeping: drop long-delivered rows so the table stays small.
	try {
		purgeDeliveredReportEvents(new Date(now() - DELIVERED_RETENTION_MS).toISOString());
	} catch {
		// Non-fatal.
	}
	return summary;
}

/** Emit a heartbeat carrying version + instance health (§7.2). No-op when disabled. */
export function emitHeartbeat(
	stats: { workflowsTotal: number; uptimeMs: number },
	config: ReportConfig = loadEffectiveReportConfig(),
): void {
	if (!config.enabled) return;
	emit(
		"heartbeat",
		{
			data: {
				version: TARGET_VERSION,
				os: `${process.platform} ${process.arch}`,
				uptime_ms: Math.round(stats.uptimeMs),
				workflows_total: stats.workflowsTotal,
				queue_pending: safePendingCount(),
			},
		},
		config,
	);
}

function safePendingCount(): number {
	try {
		return pendingReportCount();
	} catch {
		return 0;
	}
}

async function safeJson(res: Response): Promise<unknown> {
	try {
		const text = await res.text();
		if (!text.trim()) return null;
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Retry-After is either seconds or an HTTP-date; return a delay in ms, or null. */
function parseRetryAfter(value: string | null, nowMs: number): number | null {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
	const when = Date.parse(value);
	if (Number.isFinite(when)) return Math.max(0, when - nowMs);
	return null;
}
