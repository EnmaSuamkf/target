/**
 * Docker bind mounts: global defaults (Settings) plus per-workflow extras,
 * merged into the awb hook before a containerised step runs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { replaceHookMounts, hookRuntime } from "./awb.ts";
import { getDockerMountSettings, type Workflow } from "./db.ts";
import { stepResultsDir } from "./step-results.ts";

export class DockerMountError extends Error {
	readonly code: string;
	constructor(code: string, message?: string) {
		super(message ?? code);
		this.name = "DockerMountError";
		this.code = code;
	}
}

/** Expands `~`, normalises, and rejects paths that are too broad to mount. */
export function normalizeDockerMountPath(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const expanded =
		trimmed === "~" ? os.homedir() : trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	if (!path.isAbsolute(expanded)) return null;
	const normalized = path.normalize(expanded);
	if (normalized === "/" || normalized === os.homedir()) return null;
	return normalized;
}

export function mergeDockerMounts(...lists: string[][]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		for (const raw of list) {
			const normalized = normalizeDockerMountPath(raw);
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			out.push(normalized);
		}
	}
	return out;
}

export function parseDockerMountsInput(mounts: unknown): string[] {
	if (!Array.isArray(mounts)) {
		throw new DockerMountError("invalid_mounts", "mounts must be an array of path strings");
	}
	const out: string[] = [];
	for (const raw of mounts) {
		if (typeof raw !== "string") {
			throw new DockerMountError("invalid_mount", "each mount must be a string path");
		}
		const normalized = normalizeDockerMountPath(raw);
		if (!normalized) {
			throw new DockerMountError("invalid_mount", `invalid mount path: ${raw}`);
		}
		if (!out.includes(normalized)) out.push(normalized);
	}
	return out;
}

/** Defaults ∪ workflow extras ∪ step-results (when that directory already exists). */
export function effectiveDockerMounts(agentName: string, workflowMounts: string[]): string[] {
	const defaults = getDockerMountSettings().mounts;
	const extras: string[] = [];
	const resultsDir = stepResultsDir(agentName);
	if (fs.existsSync(resultsDir)) extras.push(resultsDir);
	return mergeDockerMounts(defaults, workflowMounts, extras);
}

export function syncWorkflowDockerMounts(workflow: Pick<Workflow, "hookUrl" | "agentName" | "dockerMounts">): void {
	const runtime = hookRuntime(workflow.hookUrl);
	if (runtime.sandbox?.kind !== "docker") return;
	replaceHookMounts(workflow.hookUrl, effectiveDockerMounts(workflow.agentName, workflow.dockerMounts));
}

export function resyncAllDockerWorkflowMounts(workflows: Workflow[]): void {
	for (const workflow of workflows) {
		syncWorkflowDockerMounts(workflow);
	}
}
