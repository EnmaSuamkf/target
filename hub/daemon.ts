#!/usr/bin/env node
/**
 * The Target Project hub daemon entry point. Run directly (`node hub/daemon.ts`) or via
 * `target start`; stays alive serving the API + UI and receiving awb's
 * step-result callbacks.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInsecureReportUrl, loadConfig, loadReportConfig } from "./config.ts";
import { listWorkflows } from "./db.ts";
import { emitHeartbeat, flush } from "./reporter.ts";
import { createServer } from "./server.ts";
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

export function startHub(): void {
	const cfg = loadConfig();
	const server = createServer(cfg, log);
	server.listen(cfg.port, cfg.host, () => {
		log(`target hub v${TARGET_VERSION} listening on http://${cfg.host}:${cfg.port}`);
		log(`admin token (for mutating /api routes): ${cfg.adminToken}`);
	});
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
	// periodic heartbeat. Entirely off when no TARGET_REPORT_URL is configured, so
	// a default install schedules nothing here. See docs/report-server.es.html.
	const report = loadReportConfig();
	if (report.enabled) {
		log(`activity reporting enabled → ${report.url} (every ${report.intervalMs}ms)`);
		if (isInsecureReportUrl(report.url)) {
			log("TARGET_REPORT_URL is plaintext http:// to a non-loopback host — prefer https", "warning");
		}
		const startedAt = Date.now();
		// Announce the workflows this hub already knows (name, agent, sandbox) so
		// a server that came up late — or fields added to the report after the
		// workflows were created — still get complete dashboard rows. Queued, so
		// it rides the first flush like everything else.
		try {
			announceWorkflows();
		} catch (err) {
			log(`workflow announce failed: ${String(err)}`, "warning");
		}
		const flusher = setInterval(() => {
			// A fresh read each tick so an edited .env (after a restart) is honoured.
			const current = loadReportConfig();
			if (!current.enabled) return;
			try {
				emitHeartbeat({ workflowsTotal: listWorkflows().length, uptimeMs: Date.now() - startedAt }, current);
			} catch (err) {
				log(`heartbeat emit failed: ${String(err)}`, "warning");
			}
			void flush({ config: current, log }).catch((err) => log(`report flush failed: ${String(err)}`, "warning"));
		}, report.intervalMs);
		flusher.unref();
	}

	server.on("error", (err) => {
		log(`server error: ${String(err)}`, "error");
		process.exitCode = 1;
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	startHub();
}
