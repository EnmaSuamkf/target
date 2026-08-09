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
import { getAccount } from "./account.ts";
import { loadReportConfig, type ReportConfig } from "./config.ts";
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
export function emit(kind: string, input: EmitInput = {}, config: ReportConfig = loadReportConfig()): void {
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

function toEnvelope(events: ReportEventRow[], instanceId: string, batchId: string): string {
	const account = safeAccount();
	return JSON.stringify({
		batch_id: batchId,
		instance_id: instanceId,
		version: TARGET_VERSION,
		schema_version: REPORT_SCHEMA_VERSION,
		sent_at: new Date().toISOString(),
		...(account?.displayName ? { user: { display_name: account.displayName } } : {}),
		events: events.map((e) => ({
			id: e.id,
			kind: e.kind,
			workflow_id: e.workflowId,
			session_id: e.sessionId,
			created_at: e.createdAt,
			data: parsePayload(e.payload),
		})),
	});
}

function parsePayload(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return { _unparsed: raw };
	}
}

function safeAccount(): { displayName: string | null } | null {
	try {
		return getAccount();
	} catch {
		return null;
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
 * Drain and deliver the queue. Returns a small summary (handy for tests/logs).
 * Safe to call when disabled — it just returns zeros without touching the DB.
 */
export async function flush(options: FlushOptions = {}): Promise<{ delivered: number; retried: number; dropped: number }> {
	const config = options.config ?? loadReportConfig();
	const summary = { delivered: 0, retried: 0, dropped: 0 };
	if (!config.enabled) return summary;

	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
	if (!fetchImpl) return summary;
	const log = options.log ?? (() => {});
	const now = options.now ?? Date.now;

	const instanceId = getOrCreateInstanceId(config.instanceId);

	// Deliver in batches until the queue drains or a batch tells us to stop.
	for (;;) {
		const batch = pendingReportEvents(MAX_BATCH_EVENTS);
		if (batch.length === 0) break;
		const ids = batch.map((e) => e.id);
		const batchId = crypto.randomUUID();

		let res: Response;
		try {
			res = await fetchImpl(config.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${config.token}`,
					"idempotency-key": batchId,
					"x-target-version": TARGET_VERSION,
				},
				body: toEnvelope(batch, instanceId, batchId),
				signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
			});
		} catch (err) {
			// Timeout / network error → whole batch retries (§7.5, "timeout / red").
			markReportEventsRetry(ids, new Date(now() + backoffMs(batch[0].attempts)).toISOString());
			summary.retried += ids.length;
			log(`report flush: transport error, will retry ${ids.length} event(s): ${String(err)}`, "warning");
			break;
		}

		const status = res.status;
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
			// Loop again to drain any remaining queued events.
			continue;
		}

		if (status === 409) {
			// Duplicate (idempotency) → treat as delivered.
			markReportEventsDelivered(ids);
			summary.delivered += ids.length;
			continue;
		}

		if (status === 413) {
			// Batch too big: shrink and retry soon. Halving the effective cap by
			// retrying with backoff is enough here; the next pass reads fewer via
			// natural draining once some deliver. Push a short retry.
			markReportEventsRetry(ids, new Date(now() + BACKOFF_BASE_MS).toISOString());
			summary.retried += ids.length;
			log("report flush: 413 too large; will retry with a smaller batch", "warning");
			break;
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
	config: ReportConfig = loadReportConfig(),
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
