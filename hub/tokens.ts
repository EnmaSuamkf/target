#!/usr/bin/env node
/**
 * CLI: print the real token usage of a session, read straight from the
 * transcript Claude Code writes (no API calls). Accepts either a Claude session
 * id or a workflow id/name — a workflow resolves to its shared session and the
 * agent's workdir; a bare session id is located by scanning ~/.claude/projects.
 *
 *   node hub/tokens.ts <sessionId | workflowId | workflow-name>
 *
 * Totals fold in subagent transcripts, since each step delegates its real work
 * to a subagent (see readTokenUsage).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hookRuntime } from "./awb.ts";
import { getWorkflow, latestStepSession, listWorkflows } from "./db.ts";
import { readTokenUsage, transcriptPath, type TokenUsage } from "./transcript.ts";

/** Finds the workdir whose Claude project folder holds `<sessionId>.jsonl`, by scanning ~/.claude/projects. */
function findWorkdirForSession(sessionId: string): string | null {
	const projects = path.join(os.homedir(), ".claude", "projects");
	let slugs: string[];
	try {
		slugs = fs.readdirSync(projects);
	} catch {
		return null;
	}
	for (const slug of slugs) {
		if (fs.existsSync(path.join(projects, slug, `${sessionId}.jsonl`))) {
			// The project folder name is the slugified workdir; the slug is lossy
			// (every non-alphanumeric became '-'), but transcriptPath only needs it to
			// re-slug to the same folder, so handing back the slug itself round-trips.
			return slug;
		}
	}
	return null;
}

/** Resolves the CLI argument to the session + workdir whose usage we should read. */
function resolve(arg: string): { sessionId: string; workdir: string; label: string } | { error: string } {
	// A workflow id or name → its shared session and the agent's real workdir.
	const workflow = getWorkflow(arg) ?? listWorkflows().find((w) => w.name === arg || w.agentName === arg);
	if (workflow) {
		const sessionId = latestStepSession(workflow.id) ?? workflow.lastSessionId;
		if (!sessionId) return { error: `workflow '${workflow.name}' has no session yet (no step has finished running)` };
		const workdir = hookRuntime(workflow.hookUrl).workdir;
		if (!workdir) return { error: `can't resolve the workdir for workflow '${workflow.name}' (remote or missing hook)` };
		return { sessionId, workdir, label: `workflow ${workflow.name} · session ${sessionId}` };
	}
	// Otherwise treat the argument as a bare session id and locate its transcript.
	const workdir = findWorkdirForSession(arg);
	if (!workdir) return { error: `no transcript found for session '${arg}' (unknown session or workflow)` };
	return { sessionId: arg, workdir, label: `session ${arg}` };
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function print(label: string, usage: TokenUsage): void {
	const pct = usage.contextWindow ? ((100 * usage.contextTokens) / usage.contextWindow).toFixed(1) : "0.0";
	const lines = [
		`Token usage — ${label}`,
		"".padEnd(52, "="),
		"",
		`Context window (main thread, last turn):`,
		`  ${fmt(usage.contextTokens)} / ${fmt(usage.contextWindow)} tokens  (${pct}%)`,
		"",
		`Billed totals${usage.includesSubagents ? " (incl. subagents)" : ""} over ${fmt(usage.turns)} turn(s):`,
		`  input (new):     ${fmt(usage.inputTokens)}`,
		`  cache creation:  ${fmt(usage.cacheCreationTokens)}`,
		`  cache read:      ${fmt(usage.cacheReadTokens)}`,
		`  output:          ${fmt(usage.outputTokens)}`,
		`  ${"".padEnd(30, "-")}`,
		`  input total:     ${fmt(usage.totalInputTokens)}  (new + cache creation + cache read)`,
	];
	console.log(lines.join("\n"));
}

function main(): void {
	const arg = process.argv[2];
	if (!arg) {
		console.error("usage: node hub/tokens.ts <sessionId | workflowId | workflow-name>");
		process.exitCode = 1;
		return;
	}
	const resolved = resolve(arg);
	if ("error" in resolved) {
		console.error(resolved.error);
		process.exitCode = 1;
		return;
	}
	const usage = readTokenUsage(resolved.workdir, resolved.sessionId);
	if (usage.turns === 0 && !fs.existsSync(transcriptPath(resolved.workdir, resolved.sessionId))) {
		console.error(`transcript is empty or missing for ${resolved.label}`);
		process.exitCode = 1;
		return;
	}
	print(resolved.label, usage);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
