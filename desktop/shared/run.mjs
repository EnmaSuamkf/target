/**
 * Launches Electron with platform-appropriate flags (Linux dev often needs
 * --no-sandbox when chrome-sandbox is not setuid-root).
 *
 * @param {string} importMetaUrl — pass import.meta.url from the wrapper's run.mjs
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function launchElectron(importMetaUrl) {
	const wrapperDir = path.dirname(fileURLToPath(importMetaUrl));
	const electronBin = path.join(
		wrapperDir,
		"node_modules",
		".bin",
		process.platform === "win32" ? "electron.cmd" : "electron",
	);
	const args = [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
	const env = { ...process.env };
	if (process.platform === "linux" && !env.ELECTRON_DISABLE_SANDBOX) {
		env.ELECTRON_DISABLE_SANDBOX = "1";
	}

	const child = spawn(electronBin, args, {
		stdio: "inherit",
		env,
		cwd: wrapperDir,
		shell: process.platform === "win32",
	});
	child.on("exit", (code, signal) => {
		process.exit(code ?? (signal ? 1 : 0));
	});
}
