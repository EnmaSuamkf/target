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
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function hubOrigin(host: string, port: number): string {
	return `http://${host}:${port}`;
}
