/**
 * The daemon log is readable by a step agent on the host. The admin token is
 * also the bundled pack's TOKEN_1, so startup must not write it out.
 */
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const LIVE_PORTS = new Set([8893, 8993]);

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
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const port = await freePort();
		if (!LIVE_PORTS.has(port)) return port;
	}
	throw new Error("could not reserve a port other than the live hubs");
}

test("the hub log does not include the admin token or a tool token", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-daemon-log-"));
	const awb = fs.mkdtempSync(path.join(os.tmpdir(), "target-daemon-awb-"));
	const token = `admin-${crypto.randomUUID()}`;
	const port = await unusedPort();
	fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ host: "127.0.0.1", port, adminToken: token }));
	const daemon = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts");
	const child = spawn(process.execPath, [daemon], {
		cwd: path.dirname(daemon),
		env: { ...process.env, TARGET_HOME: home, AWB_HOME: awb },
		stdio: ["ignore", "pipe", "pipe"],
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
			const timer = setTimeout(() => reject(new Error(`daemon did not listen\n${out}`)), 20_000);
			const watch = (): void => {
				if (!out.includes("listening on")) return;
				clearTimeout(timer);
				resolve();
			};
			child.stdout?.on("data", watch);
			child.stderr?.on("data", watch);
			child.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`daemon exited ${code} before listening\n${out}`));
			});
		});
		assert.equal(out.includes(token), false);
		assert.match(out, /not written to this log/);
		assert.doesNotMatch(out, /admin token \(for mutating/);
	} finally {
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve();
				return;
			}
			child.once("exit", () => resolve());
		});
	}
});
