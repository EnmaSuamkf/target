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
import type { HubConfig } from "./config.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-config-test-"));
process.env.TARGET_HOME = path.join(tmpHome, ".target");
// Keep this configuration suite hermetic: config.ts deliberately consults a
// repo-root .env for real installations, but a developer's local Docker flag
// must not change assertions about an unset environment. The per-home .env is
// the documented higher-precedence location and stops that fallback.
fs.mkdirSync(String(process.env.TARGET_HOME), { recursive: true });
fs.writeFileSync(path.join(String(process.env.TARGET_HOME), ".env"), "# test environment\n");


const {
	loadConfig,
	syncDockerFriendlyNetworking,
	DOCKER_FRIENDLY_HOST,
	DOCKER_FRIENDLY_PORT,
	DOCKER_FRIENDLY_SANDBOX_HOST_DEFAULT,
	LOOPBACK_HOST,
} = await import("./config.ts");
const { open } = await import("./db.ts");

const { dockerHostAddress } = await import("./sandbox-net.ts");

function expectedEnvSandboxHost(): string {
	return dockerHostAddress() ?? DOCKER_FRIENDLY_SANDBOX_HOST_DEFAULT;
}

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

function configPath(): string {
	return path.join(String(process.env.TARGET_HOME), "config.json");
}

function readPersisted(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, unknown>;
}

function withDockerFriendlyEnv(value: string | undefined, fn: () => void): void {
	// Env-path tests assume Settings have never been saved. Clear any leftover row
	// (e.g. from a parallel suite sharing TARGET_HOME) so updatedAt stays null.
	open().prepare("DELETE FROM settings WHERE key = ?").run("docker_friendly");
	const prev = process.env.TARGET_HUB_DOCKER_FRIENDLY;
	if (value === undefined) delete process.env.TARGET_HUB_DOCKER_FRIENDLY;
	else process.env.TARGET_HUB_DOCKER_FRIENDLY = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.TARGET_HUB_DOCKER_FRIENDLY;
		else process.env.TARGET_HUB_DOCKER_FRIENDLY = prev;
	}
}

test("TARGET_HUB_DOCKER_FRIENDLY=false keeps loopback defaults", () => {
	withDockerFriendlyEnv("false", () => {
		const cfg = loadWith({ host: "0.0.0.0", sandboxHost: "172.17.0.1", dockerNetworkingFromEnv: true });
		assert.equal(cfg.host, LOOPBACK_HOST);
		assert.equal(cfg.port, DOCKER_FRIENDLY_PORT);
		assert.equal(cfg.sandboxHost, undefined);
	});
});

test("env flag off leaves unset host at loopback and port 8893", () => {
	withDockerFriendlyEnv(undefined, () => {
		fs.rmSync(configPath(), { force: true });
		const cfg = loadConfig();
		assert.equal(cfg.host, LOOPBACK_HOST);
		assert.equal(cfg.port, DOCKER_FRIENDLY_PORT);
	});
});

test("documented docker-friendly sandboxHost fallback is 172.17.0.1", () => {
	assert.equal(DOCKER_FRIENDLY_SANDBOX_HOST_DEFAULT, "172.17.0.1");
});

test("flag on sets 0.0.0.0 and sandboxHost 172.17.0.1 when bridge detection is unavailable", () => {
	withDockerFriendlyEnv("true", () => {
		const base: HubConfig = {
			host: LOOPBACK_HOST,
			port: 8893,
			adminToken: "t",
			stepTimeoutMs: 1,
			stepIdleTimeoutMs: 1,
			stepIdleWarnMs: 1,
			stepHardTimeoutMs: 1,
			progressProbeThrottleMs: 1,
			queuedTimeoutMs: 1,
			maxInputBytes: 1,
		};
		const { cfg } = syncDockerFriendlyNetworking(base, {});
		assert.equal(cfg.host, DOCKER_FRIENDLY_HOST);
		assert.equal(cfg.port, DOCKER_FRIENDLY_PORT);
		assert.equal(cfg.sandboxHost, expectedEnvSandboxHost());
		if (dockerHostAddress() === null) {
			assert.equal(cfg.sandboxHost, DOCKER_FRIENDLY_SANDBOX_HOST_DEFAULT);
		}
	});
});

test("TARGET_HUB_DOCKER_FRIENDLY=true persists docker-friendly networking and keeps adminToken", () => {
	withDockerFriendlyEnv("true", () => {
		const cfg = loadWith({ adminToken: "keep-token", stepHardTimeoutMs: 42_000 });
		assert.equal(cfg.host, DOCKER_FRIENDLY_HOST);
		assert.equal(cfg.port, DOCKER_FRIENDLY_PORT);
		assert.equal(cfg.sandboxHost, expectedEnvSandboxHost());
		assert.equal(cfg.adminToken, "keep-token");
		assert.equal(cfg.stepHardTimeoutMs, 42_000);
		const onDisk = readPersisted();
		assert.equal(onDisk.adminToken, "keep-token");
		assert.equal(onDisk.host, DOCKER_FRIENDLY_HOST);
		assert.equal(onDisk.dockerNetworkingFromEnv, true);
	});
});

test("turning TARGET_HUB_DOCKER_FRIENDLY off restores loopback and drops env-managed sandboxHost", () => {
	withDockerFriendlyEnv("true", () => {
		loadWith({ adminToken: "toggle-token" });
	});
	withDockerFriendlyEnv(undefined, () => {
		const cfg = loadConfig();
		assert.equal(cfg.host, LOOPBACK_HOST);
		assert.equal(cfg.sandboxHost, undefined);
		assert.equal(cfg.adminToken, "toggle-token");
		const onDisk = readPersisted();
		assert.equal(onDisk.host, LOOPBACK_HOST);
		assert.equal(onDisk.sandboxHost, undefined);
		assert.equal(onDisk.dockerNetworkingFromEnv, undefined);
	});
});

test("operator sandboxHost survives when docker-friendly env is off", () => {
	withDockerFriendlyEnv(undefined, () => {
		const cfg = loadWith({ adminToken: "manual-host", sandboxHost: "10.8.0.1" });
		assert.equal(cfg.host, LOOPBACK_HOST);
		assert.equal(cfg.sandboxHost, "10.8.0.1");
		const onDisk = readPersisted();
		assert.equal(onDisk.sandboxHostManual, true);
		assert.equal(onDisk.sandboxHost, "10.8.0.1");
	});
});

test("syncDockerFriendlyNetworking: flag on replaces config.json host with 0.0.0.0", () => {
	withDockerFriendlyEnv("true", () => {
		const base: HubConfig = {
			host: "10.1.2.3",
			port: 8893,
			sandboxHost: "10.8.0.1",
			adminToken: "t",
			stepTimeoutMs: 1,
			stepIdleTimeoutMs: 1,
			stepIdleWarnMs: 1,
			stepHardTimeoutMs: 1,
			progressProbeThrottleMs: 1,
			queuedTimeoutMs: 1,
			maxInputBytes: 1,
		};
		const { cfg } = syncDockerFriendlyNetworking(base, {
			host: "10.1.2.3",
			sandboxHost: "10.8.0.1",
			sandboxHostManual: true,
		});
		assert.equal(cfg.host, DOCKER_FRIENDLY_HOST);
		assert.equal(cfg.sandboxHost, expectedEnvSandboxHost());
		assert.equal(cfg.sandboxHostManual, undefined);
	});
});

test("docker-friendly env overrides a manual sandboxHost while enabled", () => {
	withDockerFriendlyEnv(undefined, () => {
		loadWith({ adminToken: "override-me", sandboxHost: "10.8.0.1" });
	});
	withDockerFriendlyEnv("true", () => {
		const cfg = loadConfig();
		assert.equal(cfg.sandboxHost, expectedEnvSandboxHost());
		assert.equal(cfg.dockerNetworkingFromEnv, true);
		assert.equal(cfg.sandboxHostManual, undefined);
	});
});
