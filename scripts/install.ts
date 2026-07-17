/**
 * One-command install for target: hub dependencies + the local
 * agent-webhook-bridge (awb) install the hub can't work without — it spawns
 * every step's `claude` run and hosts the hooks `hub/awb.ts` writes.
 *
 * Reached through `npm run target:install` (scripts/bootstrap.mjs guarantees a
 * node that can run this file). Idempotent: each step checks whether its work
 * is already done, so a second run is a no-op and costs no network.
 *
 * The awb clone lives in vendor/ (gitignored) unless AWB_DIR points elsewhere
 * — pointing it at an existing clone is the way to reuse one instead of
 * cloning a second copy.
 */
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB_DIR = path.join(REPO_DIR, "hub");
const AWB_REPO_URL = "https://github.com/EnmaSuamkf/agent-webhook-bridge.git";

function awbDir(): string {
	return process.env.AWB_DIR ?? path.join(REPO_DIR, "vendor", "agent-webhook-bridge");
}

class InstallError extends Error {}

function log(message: string, type: "info" | "warning" | "error" = "info"): void {
	const prefix = type === "error" ? "[error]" : type === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

function run(cmd: string, args: string[], cwd: string): number {
	const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
	if (res.error) throw new InstallError(`could not run \`${cmd}\`: ${res.error.message}`);
	return res.status ?? 1;
}

function runQuiet(cmd: string, args: string[], cwd: string): { status: number; stdout: string } {
	const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
	if (res.error) throw new InstallError(`could not run \`${cmd}\`: ${res.error.message}`);
	return { status: res.status ?? 1, stdout: res.stdout ?? "" };
}

/**
 * Fingerprint of the lockfile the current node_modules was installed from.
 * npm gives no cheap "are deps current?" answer (`npm ci` always wipes and
 * reinstalls), so we stamp the tree ourselves and skip the install when the
 * lockfile hasn't moved since.
 */
function depsStamp(dir: string): { file: string; want: string } | null {
	const lock = path.join(dir, "package-lock.json");
	if (!fs.existsSync(lock)) return null;
	const want = crypto.createHash("sha256").update(fs.readFileSync(lock)).digest("hex");
	return { file: path.join(dir, "node_modules", ".target-install-stamp"), want };
}

function depsAreCurrent(dir: string): boolean {
	const stamp = depsStamp(dir);
	if (!stamp || !fs.existsSync(path.join(dir, "node_modules"))) return false;
	try {
		return fs.readFileSync(stamp.file, "utf8").trim() === stamp.want;
	} catch {
		return false;
	}
}

function writeDepsStamp(dir: string): void {
	const stamp = depsStamp(dir);
	if (!stamp) return;
	try {
		fs.writeFileSync(stamp.file, `${stamp.want}\n`);
	} catch {
		// No stamp → next run reinstalls. Slower, never wrong; not worth failing.
	}
}

/**
 * `npm ci` when the lockfile is in sync with package.json, `npm install`
 * otherwise — ci is the reproducible path but it refuses to run (exit 1) on a
 * drifted lockfile, and that must not break the installer.
 */
function installDeps(label: string, dir: string): void {
	if (depsAreCurrent(dir)) {
		log(`${label} dependencies already installed — skipping.`);
		return;
	}
	if (!fs.existsSync(path.join(dir, "package-lock.json"))) {
		log(`${label}: no lockfile, running \`npm install\`...`);
		if (run("npm", ["install"], dir) !== 0) throw new InstallError(`\`npm install\` failed in ${dir}`);
	} else {
		log(`${label}: installing dependencies (\`npm ci\`)...`);
		if (run("npm", ["ci"], dir) !== 0) {
			log(`${label}: \`npm ci\` failed (lockfile out of sync?) — falling back to \`npm install\`...`, "warning");
			if (run("npm", ["install"], dir) !== 0) throw new InstallError(`\`npm install\` failed in ${dir}`);
		}
	}
	writeDepsStamp(dir);
}

function requireGit(): void {
	if (runQuiet("git", ["--version"], REPO_DIR).status !== 0) {
		throw new InstallError("`git` is required to fetch agent-webhook-bridge but isn't on PATH.");
	}
}

/**
 * Clones awb, or fast-forwards an existing clone. A pull failure is only a
 * warning: an already-cloned awb is enough to start, and the machine may
 * simply be offline or the clone parked on a local branch.
 */
function syncAwb(dir: string): void {
	if (!fs.existsSync(dir)) {
		log(`agent-webhook-bridge: cloning into ${dir}...`);
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		if (run("git", ["clone", AWB_REPO_URL, dir], REPO_DIR) !== 0) {
			throw new InstallError(`could not clone ${AWB_REPO_URL} into ${dir}`);
		}
		return;
	}
	if (!fs.existsSync(path.join(dir, ".git"))) {
		throw new InstallError(`${dir} exists but is not a git clone. Remove it, or point AWB_DIR at a real agent-webhook-bridge clone.`);
	}
	log(`agent-webhook-bridge: updating existing clone at ${dir}...`);
	if (runQuiet("git", ["pull", "--ff-only"], dir).status !== 0) {
		log("agent-webhook-bridge: could not fast-forward the clone — keeping it as is.", "warning");
	}
}

function main(): void {
	const awb = awbDir();
	log("[1/4] node");
	log(`node ${process.version} satisfies the >=24 requirement.`);

	log("[2/4] hub dependencies");
	installDeps("hub", HUB_DIR);

	log("[3/4] agent-webhook-bridge");
	requireGit();
	syncAwb(awb);
	if (!fs.existsSync(path.join(awb, "package.json"))) {
		throw new InstallError(`${awb} has no package.json — that doesn't look like an agent-webhook-bridge clone.`);
	}

	log("[4/4] agent-webhook-bridge dependencies");
	installDeps("agent-webhook-bridge", awb);

	console.log(`
Ready to start. Two processes, two terminals:

  1) the broker:  node ${path.join(awb, "broker", "daemon.ts")}
  2) the hub:     npm start

The hub prints its admin token on startup (also in ~/.target/config.json) and
serves the UI at http://127.0.0.1:8893.
`);
}

try {
	main();
} catch (err) {
	log(err instanceof InstallError ? err.message : String(err), "error");
	process.exitCode = 1;
}
