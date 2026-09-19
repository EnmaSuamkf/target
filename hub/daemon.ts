#!/usr/bin/env node
/**
 * The Target Project hub daemon entry point. Run directly (`node hub/daemon.ts`) or via
 * `target start`; stays alive serving the API + UI and receiving awb's
 * step-result callbacks.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundledCatalog } from "./bundled-bootstrap.ts";
import { isInsecureReportUrl, loadConfig } from "./config.ts";
import { listWorkflows } from "./db.ts";
import { loadEffectiveReportConfig, loadEffectiveSyncConfig } from "./remote-config.ts";
import { emitHeartbeat, flush } from "./reporter.ts";
import { initSyncStateCache, runSyncTick } from "./sync.ts";
import { createServer } from "./server.ts";
import { retryRemoteDisconnect } from "./device-link-client.ts";
import { announceWorkflows, expireStale } from "./workflow.ts";
import { TARGET_VERSION } from "./version.ts";

function log(message: string, type: "info" | "warning" | "error" = "info"): void {
	const prefix = type === "error" ? "[error]" : type === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

/**
 * How often the daemon sweeps for stalled steps on its own. The sweep also runs
 * on every workflow GET, but that only happens while someone has the UI open —
 * a hung step on an unattended hub would otherwise never be noticed (and never
 * free its workdir lock). A minute is far below any timeout, so the extra cost
 * is one throttled filesystem probe per in-flight step.
 */
const SWEEP_INTERVAL_MS = 60_000;
const REMOTE_CLEANUP_RETRY_INTERVAL_MS = 30_000;

export function startHub(): void {
	const cfg = loadConfig();
	try {
		const { tcp, resourceSet } = ensureBundledCatalog(cfg);
		log(`bundled catalog: TCP '${tcp.name}', resource set '${resourceSet.name}'`);
	} catch (err) {
		log(`bundled catalog import failed: ${String(err)}`, "warning");
	}
	const server = createServer(cfg, log);
	server.listen(cfg.port, cfg.host, () => {
		log(`target hub v${TARGET_VERSION} listening on http://${cfg.host}:${cfg.port}`);
		log(`admin token (for mutating /api routes): ${cfg.adminToken}`);
	});
	void retryRemoteDisconnect().catch(() => {});
	const cleanupRetry = setInterval(() => {
		void retryRemoteDisconnect().catch(() => {});
	}, REMOTE_CLEANUP_RETRY_INTERVAL_MS);
	cleanupRetry.unref();
	// `unref` so the timer never keeps the process alive on its own; a sweep that
	// throws must not take the daemon down with it.
	const sweep = setInterval(() => {
		try {
			expireStale(cfg, log);
		} catch (err) {
			log(`stale-step sweep failed: ${String(err)}`, "warning");
		}
	}, SWEEP_INTERVAL_MS);
	sweep.unref();

	// Activity reporting: drain the durable event queue on an interval and emit a
	// periodic heartbeat. A linked device derives this from its persisted origin;
	// an unlinked installation may still use the legacy TARGET_REPORT_URL path.
	const report = loadEffectiveReportConfig();
	if (report.enabled) {
		log(`activity reporting enabled → ${report.url} (every ${report.intervalMs}ms)`);
		if (isInsecureReportUrl(report.url)) {
			log("TARGET_REPORT_URL is plaintext http:// to a non-loopback host — prefer https", "warning");
		}
	}
	const startedAt = Date.now();
	let reportingAnnounced = false;
	// Always retain the lightweight timer: a device can become linked while the
	// daemon is already running. It performs no network or queue work unless an
	// effective linked/legacy report configuration is enabled.
	const flusher = setInterval(() => {
		const current = loadEffectiveReportConfig();
		if (!current.enabled) {
			reportingAnnounced = false;
			return;
		}
		if (!reportingAnnounced) {
			try {
				announceWorkflows();
				reportingAnnounced = true;
			} catch (err) {
				log(`workflow announce failed: ${String(err)}`, "warning");
			}
		}
		try {
			emitHeartbeat({ workflowsTotal: listWorkflows().length, uptimeMs: Date.now() - startedAt }, current);
		} catch (err) {
			log(`heartbeat emit failed: ${String(err)}`, "warning");
		}
		void flush({ config: current, log }).catch((err) => log(`report flush failed: ${String(err)}`, "warning"));
	}, report.intervalMs);
	flusher.unref();

	// Remote sync: register/heartbeat, poll server commands, apply locally, ack.
	const syncCfg = loadEffectiveSyncConfig();
	if (syncCfg.enabled) {
		log(`remote sync enabled → ${syncCfg.url} (every ${syncCfg.intervalMs}ms)`);
		if (isInsecureReportUrl(syncCfg.url)) {
			log("TARGET_SYNC_URL is plaintext http:// to a non-loopback host — prefer https", "warning");
		}
	}
	initSyncStateCache();
	const syncLoop = setInterval(() => {
		const current = loadEffectiveSyncConfig();
		if (!current.enabled) return;
		void runSyncTick({ config: current, hubConfig: cfg, log }).catch((err) =>
			log(`remote sync tick failed: ${String(err)}`, "warning"),
		);
	}, syncCfg.intervalMs);
	syncLoop.unref();
	// First tick soon after startup so a server-enqueued command materializes quickly.
	setTimeout(() => {
		const current = loadEffectiveSyncConfig();
		if (!current.enabled) return;
		void runSyncTick({ config: current, hubConfig: cfg, log }).catch((err) =>
			log(`remote sync tick failed: ${String(err)}`, "warning"),
		);
	}, 2_000).unref();

	server.on("error", (err) => {
		log(`server error: ${String(err)}`, "error");
		process.exitCode = 1;
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	startHub();
}
