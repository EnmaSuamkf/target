/**
 * `npm start` (scripts/start.ts) must not print the admin token. It names the
 * config file instead. The daemon log is covered by daemon-log.test.ts.
 */
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const LIVE_PORTS = new Set([8890, 8893, 8993]);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("port probe failed"));
				return;
			}
			const { port } = addr;
			server.close(() => resolve(port));
		});
	});
}

async function unusedPort(): Promise<number> {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const port = await freePort();
		if (!LIVE_PORTS.has(port)) return port;
	}
	throw new Error("could not reserve a port other than the live hubs");
}

test("scripts/start.ts points at the config file and does not print the admin token", async () => {
	const source = fs.readFileSync(path.join(repo, "scripts/start.ts"), "utf8");
	assert.match(source, /the value is not printed/);
	assert.doesNotMatch(source, /admin token: \$\{token/);

	const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-start-banner-"));
	const awb = fs.mkdtempSync(path.join(os.tmpdir(), "target-start-banner-awb-"));
	const token = `banner-${crypto.randomUUID()}`;
	const hubPort = await unusedPort();
	const brokerPort = await unusedPort();
	fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ host: "127.0.0.1", port: hubPort, adminToken: token }));
	fs.writeFileSync(
		path.join(awb, "hooks.json"),
		JSON.stringify({ host: "127.0.0.1", port: brokerPort, hooks: {} }),
	);

	const env: NodeJS.ProcessEnv = { ...process.env, TARGET_HOME: home, AWB_HOME: awb, TARGET_NO_BROWSER: "1" };
	delete env.TARGET_HUB_DOCKER_FRIENDLY;
	// Own process group: SIGTERM can land before start.ts installs its handler
	// and then the hub and broker it already spawned keep the pipes open.
	const child = spawn(process.execPath, [path.join(repo, "scripts/start.ts")], {
		cwd: repo,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let out = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		out += chunk.toString("utf8");
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`npm start did not become ready\n${out}`)), 25_000);
			const watch = (): void => {
				if (!out.includes("Ready.") || !out.includes("the value is not printed")) return;
				clearTimeout(timer);
				resolve();
			};
			child.stdout?.on("data", watch);
			child.stderr?.on("data", watch);
			watch();
			child.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`start.ts exited ${code} before Ready\n${out}`));
			});
		});
		assert.equal(out.includes(token), false);
		assert.match(out, /config\.json/);
		assert.match(out, /the value is not printed/);
	} finally {
		const pid = child.pid;
		const signalGroup = (signal: NodeJS.Signals): void => {
			if (!pid) return;
			try {
				process.kill(-pid, signal);
			} catch {
				// The group is already gone.
			}
		};
		signalGroup("SIGTERM");
		await new Promise<void>((resolve) => {
			const stop = (): void => {
				clearTimeout(timer);
				signalGroup("SIGKILL");
				child.stdout?.destroy();
				child.stderr?.destroy();
				resolve();
			};
			const timer = setTimeout(stop, 2_000);
			if (child.exitCode !== null || child.signalCode !== null) {
				stop();
				return;
			}
			child.once("exit", stop);
		});
	}
});
