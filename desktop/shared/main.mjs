/**
 * Shared Electron shell logic for The Target Project desktop wrappers.
 *
 * Starts the hub + awb broker (via scripts/start.ts, without opening a browser),
 * waits until the hub answers, then loads the React UI in a BrowserWindow.
 */
import { app, BrowserWindow } from "electron";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {{ importMetaUrl: string; logPrefix?: string; windowTitle?: string }} opts
 */
export function registerTargetShell({
	importMetaUrl,
	logPrefix = "[target-desktop]",
	windowTitle = "The Target Project",
}) {
	const wrapperDir = path.dirname(fileURLToPath(importMetaUrl));

	/** Repo root: two levels up from desktop/<platform>/ in dev, bundled when packaged. */
	function repoDir() {
		return app.isPackaged ? path.join(process.resourcesPath, "target") : path.resolve(wrapperDir, "../..");
	}

	function targetHome() {
		return process.env.TARGET_HOME ?? path.join(os.homedir(), ".target");
	}

	function endpointFromConfig(file, fallback) {
		try {
			const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
			return { host: cfg.host ?? fallback.host, port: cfg.port ?? fallback.port };
		} catch {
			return fallback;
		}
	}

	function hubEndpoint() {
		return endpointFromConfig(path.join(targetHome(), "config.json"), { host: "127.0.0.1", port: 8893 });
	}

	function hubUrl() {
		const e = hubEndpoint();
		return `http://${e.host}:${e.port}`;
	}

	function readAdminTokenFromConfig() {
		try {
			const cfg = JSON.parse(fs.readFileSync(path.join(targetHome(), "config.json"), "utf8"));
			return typeof cfg.adminToken === "string" ? cfg.adminToken.trim() : "";
		} catch {
			return "";
		}
	}

	/**
	 * Node >= 24 runs the repo's .ts entrypoints natively. Prefer TARGET_NODE,
	 * then `which node`, then plain `node` on PATH. Electron's binary only runs
	 * JS when ELECTRON_RUN_AS_NODE is set — not .ts — so it is not used here.
	 */
	function resolveNodeExecutable() {
		const override = process.env.TARGET_NODE?.trim();
		if (override) return override;
		const which = spawnSync("which", ["node"], { encoding: "utf8" });
		if (which.status === 0) {
			const found = which.stdout.trim();
			if (found) return found;
		}
		return "node";
	}

	function nodeSpawn(scriptPath) {
		return { cmd: resolveNodeExecutable(), args: [scriptPath], extraEnv: {} };
	}

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function isListening(host, port, timeoutMs = 1000) {
		return new Promise((resolve) => {
			const socket = net.connect({ host, port });
			const done = (ok) => {
				socket.destroy();
				resolve(ok);
			};
			socket.setTimeout(timeoutMs);
			socket.once("connect", () => done(true));
			socket.once("timeout", () => done(false));
			socket.once("error", () => done(false));
		});
	}

	async function waitForHub(deadlineMs = 30_000) {
		const { host, port } = hubEndpoint();
		const deadline = Date.now() + deadlineMs;
		while (Date.now() < deadline) {
			if (await isListening(host, port)) return;
			await sleep(250);
		}
		throw new Error(`The Target Project hub did not come up on ${hubUrl()} within ${deadlineMs / 1000}s`);
	}

	function prerequisitesOk(root) {
		const missing = [];
		if (!fs.existsSync(path.join(root, "hub", "node_modules"))) {
			missing.push("hub dependencies (run npm run target:install)");
		}
		if (!fs.existsSync(path.join(root, "hub", "ui", "dist", "index.html"))) {
			missing.push("web UI build (run npm run target:install)");
		}
		if (!fs.existsSync(path.join(root, "vendor", "agent-webhook-bridge", "broker", "daemon.ts"))) {
			missing.push("agent-webhook-bridge (run npm run target:install)");
		}
		return missing;
	}

	/** @type {import("node:child_process").ChildProcess | null} */
	let backend = null;
	/** @type {BrowserWindow | null} */
	let mainWindow = null;

	function startBackend() {
		const root = repoDir();
		const startScript = path.join(root, "scripts", "start.ts");
		const { cmd, args, extraEnv } = nodeSpawn(startScript);
		backend = spawn(cmd, args, {
			cwd: root,
			env: { ...process.env, TARGET_NO_BROWSER: "1", ...extraEnv },
			stdio: "inherit",
		});
		backend.on("exit", () => {
			backend = null;
			if (!app.isQuitting) app.quit();
		});
	}

	function createWindow() {
		mainWindow = new BrowserWindow({
			width: 1280,
			height: 860,
			minWidth: 800,
			minHeight: 600,
			title: windowTitle,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
			},
			show: false,
		});

		mainWindow.once("ready-to-show", () => mainWindow?.show());
		mainWindow.webContents.once("did-finish-load", () => {
			const token = readAdminTokenFromConfig();
			if (!token) return;
			// Convenience for automation paths; session cookie alone is enough to mutate.
			void mainWindow.webContents.executeJavaScript(
				`(function(){try{if(!localStorage.getItem("targetAdminToken"))localStorage.setItem("targetAdminToken",${JSON.stringify(token)});}catch{}})();`,
			);
		});
		mainWindow.loadURL(hubUrl());

		mainWindow.on("closed", () => {
			mainWindow = null;
		});
	}

	async function boot() {
		const root = repoDir();
		const missing = prerequisitesOk(root);
		if (missing.length > 0) {
			console.error(`${logPrefix} Missing prerequisites:\n  - ${missing.join("\n  - ")}`);
			app.exit(1);
			return;
		}

		const { host, port } = hubEndpoint();
		if (await isListening(host, port)) {
			console.log(`${logPrefix} Hub already listening on ${hubUrl()} — reusing it.`);
		} else {
			console.log(`${logPrefix} Starting The Target Project backend…`);
			startBackend();
		}

		await waitForHub();
		createWindow();
	}

	app.isQuitting = false;

	app.whenReady().then(boot).catch((err) => {
		console.error(logPrefix, err);
		app.exit(1);
	});

	app.on("before-quit", () => {
		app.isQuitting = true;
		if (backend && !backend.killed) {
			backend.kill("SIGTERM");
		}
	});

	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
			void boot();
		}
	});
}
