/**
 * Single source of truth for the Target client version, reported to the server
 * with every activity batch (see reporter.ts / docs/report-server.es.html §4).
 *
 * The number lives in the repo-root package.json — bumped in lockstep with an
 * entry in CHANGELOG.md — and is read once here so the reporter, the daemon log
 * and anything else all agree on one value. Reading rather than hard-coding it
 * means the version can never drift from what `npm version`/the changelog say.
 */
import * as fs from "node:fs";

function readVersion(): string {
	try {
		// hub/version.ts → repo root is one level up.
		const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
		};
		if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
	} catch {
		// Missing/unreadable package.json — fall through to the sentinel.
	}
	return "0.0.0-unknown";
}

/** The client version, e.g. "0.2.0". Never throws. */
export const TARGET_VERSION: string = readVersion();
