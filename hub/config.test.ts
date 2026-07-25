/**
 * Tests for the hub's configuration (config.ts), focused on the idle watchdog's
 * knobs: their defaults, and the compatibility rule that keeps an operator who
 * had tuned the old wall-clock `stepTimeoutMs` from silently losing that choice
 * when the timeout became an inactivity timeout.
 *
 * Runs against a throwaway TARGET_HOME so it never reads (or rewrites) the real
 * ~/.target/config.json — `loadConfig` persists the generated admin token.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-config-test-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");

const { loadConfig } = await import("./config.ts");

/** Writes a config file the way an operator would, then loads it back. */
function loadWith(fileCfg: Record<string, unknown>) {
	const dir = String(process.env.TARGET_HOME);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ adminToken: "t", ...fileCfg }));
	return loadConfig();
}

test("the watchdog defaults are the documented ones", () => {
	fs.rmSync(path.join(String(process.env.TARGET_HOME), "config.json"), { force: true });
	const cfg = loadConfig();

	assert.equal(cfg.stepIdleTimeoutMs, 10 * 60 * 1000);
	assert.equal(cfg.stepIdleWarnMs, 3 * 60 * 1000);
	assert.equal(cfg.stepHardTimeoutMs, 6 * 60 * 60 * 1000);
	assert.equal(cfg.progressProbeThrottleMs, 5_000);
	// The queued clock is deliberately untouched by this feature.
	assert.equal(cfg.queuedTimeoutMs, 6 * 60 * 60 * 1000);
});

test("a config written before the watchdog has its stepTimeoutMs honored as the idle timeout", () => {
	// The operator's answer to "how long may a step be silent before I worry" —
	// keeping their 45 minutes beats resetting them to the 10-minute default.
	const cfg = loadWith({ stepTimeoutMs: 45 * 60 * 1000 });

	assert.equal(cfg.stepIdleTimeoutMs, 45 * 60 * 1000);
});

test("an explicit stepIdleTimeoutMs wins over the legacy stepTimeoutMs", () => {
	const cfg = loadWith({ stepTimeoutMs: 45 * 60 * 1000, stepIdleTimeoutMs: 90_000 });

	assert.equal(cfg.stepIdleTimeoutMs, 90_000);
	assert.equal(cfg.stepTimeoutMs, 45 * 60 * 1000); // kept as written, just no longer a wall clock
});

test("the other knobs are still overridable from the file", () => {
	const cfg = loadWith({ stepHardTimeoutMs: 1_000, stepIdleWarnMs: 2_000, progressProbeThrottleMs: 3_000 });

	assert.equal(cfg.stepHardTimeoutMs, 1_000);
	assert.equal(cfg.stepIdleWarnMs, 2_000);
	assert.equal(cfg.progressProbeThrottleMs, 3_000);
	assert.equal(cfg.stepIdleTimeoutMs, 10 * 60 * 1000); // untouched by the compat rule
});
