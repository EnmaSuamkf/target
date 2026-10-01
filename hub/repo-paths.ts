/**
 * Repo paths shared by bundled catalog import and agent sync.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the repository root (parent of hub/). */
export function repoRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Expand ~ and %APPDATA% in config paths. */
export function expandUserPath(raw: string, homeDir: string = os.homedir()): string {
	let out = raw.trim();
	if (out.startsWith("~/")) out = path.join(homeDir, out.slice(2));
	else if (out === "~") out = homeDir;
	out = out.replace(/%APPDATA%/gi, process.env.APPDATA ?? path.join(homeDir, "AppData", "Roaming"));
	return path.normalize(out);
}

export function readJsonFile<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJsonFile(file: string, value: unknown): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	let mode: number | undefined;
	try {
		mode = fs.statSync(file).mode & 0o777;
	} catch {
		// new file: default mode
	}
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: mode ?? 0o666 });
		if (mode !== undefined) fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, file);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}

export function hubOrigin(host: string, port: number): string {
	return `http://${host}:${port}`;
}
