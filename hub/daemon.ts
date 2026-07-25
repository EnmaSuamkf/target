#!/usr/bin/env node
/**
 * The Target Project hub daemon entry point. Run directly (`node hub/daemon.ts`) or via
 * `target start`; stays alive serving the API + UI and receiving awb's
 * step-result callbacks.
 */
import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { expireStale } from "./workflow.ts";

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
		log(`target hub listening on http://${cfg.host}:${cfg.port}`);
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
	server.on("error", (err) => {
		log(`server error: ${String(err)}`, "error");
		process.exitCode = 1;
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	startHub();
}
