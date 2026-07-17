#!/usr/bin/env node
/**
 * Entry point of `npm run target:install`. Plain JS on purpose — every other
 * script in this repo is TypeScript run directly by node, but node only strips
 * types from 23.6 on, so a .ts installer would die with a syntax error on the
 * exact old-node machines this file exists to rescue. It keeps to whatever
 * node started it, resolves an interpreter that satisfies the engine (via nvm
 * or fnm when the current one doesn't), and hands over to scripts/install.ts.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_MAJOR = 24;
const INSTALLER = path.join(path.dirname(fileURLToPath(import.meta.url)), "install.ts");

function log(message, type = "info") {
	const prefix = type === "error" ? "[error]" : type === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

function majorOf(version) {
	return Number(version.replace(/^v/, "").split(".")[0]);
}

function nvmScript() {
	const dir = process.env.NVM_DIR ?? path.join(os.homedir(), ".nvm");
	const file = path.join(dir, "nvm.sh");
	return fs.existsSync(file) ? file : null;
}

function hasFnm() {
	return spawnSync("fnm", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Runs the installer under a node the version manager provides, installing
 * that node first if the machine doesn't have it yet. Returns the exit code,
 * or null when the manager isn't usable so the caller can try the next one.
 */
function runVia(manager) {
	if (manager === "nvm") {
		const script = nvmScript();
		if (!script) return null;
		log(`node ${process.version} is too old — installing/activating node ${REQUIRED_MAJOR} with nvm...`, "warning");
		// nvm is a shell function, so it only exists inside a sourced bash.
		const cmd = `. "${script}" && nvm install ${REQUIRED_MAJOR} && nvm use ${REQUIRED_MAJOR} && exec node "${INSTALLER}"`;
		return spawnSync("bash", ["-c", cmd], { stdio: "inherit" }).status ?? 1;
	}
	if (!hasFnm()) return null;
	log(`node ${process.version} is too old — installing/activating node ${REQUIRED_MAJOR} with fnm...`, "warning");
	if (spawnSync("fnm", ["install", String(REQUIRED_MAJOR)], { stdio: "inherit" }).status !== 0) return 1;
	return spawnSync("fnm", ["exec", `--using=${REQUIRED_MAJOR}`, "node", INSTALLER], { stdio: "inherit" }).status ?? 1;
}

if (majorOf(process.version) >= REQUIRED_MAJOR) {
	process.exit(spawnSync(process.execPath, [INSTALLER], { stdio: "inherit" }).status ?? 1);
}

const viaFnm = runVia("fnm");
if (viaFnm !== null) process.exit(viaFnm);
const viaNvm = runVia("nvm");
if (viaNvm !== null) process.exit(viaNvm);

log(`target needs node >= ${REQUIRED_MAJOR} (running ${process.version}) and found no nvm or fnm to install it.`, "error");
log(`Install it and re-run: nvm install ${REQUIRED_MAJOR} && nvm use ${REQUIRED_MAJOR} (the repo's .nvmrc pins it), or grab it from https://nodejs.org`, "error");
process.exit(1);
