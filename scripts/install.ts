/**
 * One-command install for The Target Project: hub dependencies + the local
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
// The one definition of which images back a `sandbox: docker` workflow and how
// each is built. hub/awb.ts imports nothing but node builtins, so it is safe to
// pull in here — before any dependency has been installed.
import { BUILDABLE_SANDBOX_IMAGES, imageBuildCommand } from "../hub/awb.ts";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB_DIR = path.join(REPO_DIR, "hub");
const UI_DIR = path.join(HUB_DIR, "ui");
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

/**
 * Builds the React UI into hub/ui/dist, which is what the hub serves at `/`.
 * The hub itself stays dependency-free at runtime — this is the only build
 * step in the repo, and it runs here so `npm start` never has to.
 */
function buildUi(): void {
	log("ui: building the web UI (vite)...");
	if (run("npm", ["run", "build"], UI_DIR) !== 0) {
		throw new InstallError(`the UI build failed in ${UI_DIR}`);
	}
}

/**
 * Whether docker is usable here — `info` rather than `--version`, because a
 * binary on PATH with no daemon behind it fails every `docker run` just as
 * hard as no docker at all. Mirrors `dockerAvailable()` in hub/awb.ts, which
 * is what later decides whether the UI offers the docker sandbox. Not imported
 * from there because that one caches its answer for a running hub, which is
 * meaningless for a one-shot script.
 */
function dockerIsReady(): boolean {
	const res = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20_000 });
	return !res.error && res.status === 0;
}

function imageExists(tag: string): boolean {
	const res = spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore", timeout: 20_000 });
	return !res.error && res.status === 0;
}

/**
 * Builds the default agent images, so that choosing "Docker container" in the
 * New-workflow form yields a workflow that actually runs. Before this existed
 * the image was an undocumented manual step, and skipping it surfaced at the
 * first step as docker's `pull access denied … repository does not exist` —
 * a registry-login error for an image that is only ever built locally.
 *
 * The list and the exact `docker build` come from hub/awb.ts, which is also
 * what the hub uses to build a missing image on demand: two places build these
 * images, from one definition of what they are.
 *
 * Docker is OPTIONAL, and so is this whole step: everything the hub does on
 * the host works without it. A machine with no docker — and equally a build
 * that fails, since the free-code image clones a third-party repo from
 * `master` and the base image installs from apt and npm — gets a note naming
 * what is missing and the command that fixes it, and the install still
 * succeeds. Losing an optional sandbox must not cost the operator the hub.
 *
 * Idempotent by existence: an image that is already here is left alone, so a
 * second run costs two `docker image inspect` calls and no build. That
 * deliberately does NOT notice an edited Dockerfile — the escape hatch for
 * that (and for picking up a newer claude CLI) is TARGET_REBUILD_IMAGES=1,
 * which is named in the skip message so it is discoverable at the moment it
 * is wanted. TARGET_SKIP_IMAGES=1 is the other direction: skip the builds on a
 * machine that has docker but doesn't want to spend the minutes now — the hub
 * builds what a docker workflow needs at its first dispatch anyway.
 */
function buildAgentImages(): void {
	if (process.env.TARGET_SKIP_IMAGES === "1") {
		log("TARGET_SKIP_IMAGES=1 — skipping the agent images; the hub will build one the first time a docker workflow needs it.");
		return;
	}
	if (!dockerIsReady()) {
		log("docker not found (or its daemon isn't running) — skipping the agent images.", "warning");
		log("Docker workflows will be unavailable and the UI won't offer them. Install/start Docker and re-run this installer to enable them.", "warning");
		return;
	}
	const force = process.env.TARGET_REBUILD_IMAGES === "1";
	for (const image of BUILDABLE_SANDBOX_IMAGES) {
		if (!force && imageExists(image.tag)) {
			log(`${image.tag} already built — skipping (TARGET_REBUILD_IMAGES=1 to rebuild).`);
			continue;
		}
		log(`building ${image.tag} from ${image.dockerfile} (${image.runner} workflows) — this takes a few minutes the first time...`);
		const { cmd, args, cwd } = imageBuildCommand(image);
		if (run(cmd, args, cwd) === 0) continue;
		log(`could not build ${image.tag} — ${image.runner} docker workflows won't run until it exists:`, "warning");
		log(`  ${cmd} ${args.join(" ")}`, "warning");
		// Every later image is FROM an earlier one, so once one is missing the
		// rest can only fail with a confusing "pull access denied" on the parent
		// — the exact error this step exists to prevent.
		break;
	}
}

function main(): void {
	const awb = awbDir();
	log("[1/7] node");
	log(`node ${process.version} satisfies the >=24 requirement.`);

	log("[2/7] hub dependencies");
	installDeps("hub", HUB_DIR);

	log("[3/7] ui dependencies");
	installDeps("ui", UI_DIR);

	log("[4/7] ui build");
	buildUi();

	log("[5/7] agent-webhook-bridge");
	requireGit();
	syncAwb(awb);
	if (!fs.existsSync(path.join(awb, "package.json"))) {
		throw new InstallError(`${awb} has no package.json — that doesn't look like an agent-webhook-bridge clone.`);
	}

	log("[6/7] agent-webhook-bridge dependencies");
	installDeps("agent-webhook-bridge", awb);

	log("[7/7] agent images (docker)");
	buildAgentImages();

	console.log(`
Ready to start. One command brings up both the broker and the hub and opens
the UI:

  npm start

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
