/**
 * Tests for pipeline-store.ts, the step and template storage for command steps,
 * and the migration of an existing DB. Each test file gets its own throwaway
 * TARGET_HOME, set before db.ts is imported (see templates.test.ts).
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { PipelineStoreError as PipelineStoreErrorType } from "./pipeline-store.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-pipeline-store-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { deleteStep, getStep, getTemplate, insertStep, insertTemplate, open } = await import("./db.ts");
const {
	approvePipeline,
	deletePipeline,
	getPipeline,
	importPipelines,
	insertPipeline,
	isTrusted,
	listPipelines,
	parsePipelineBundle,
	pipelineBundle,
	PipelineStoreError,
	updatePipeline,
	PIPELINE_BUNDLE_KIND,
} = await import("./pipeline-store.ts");
const { sourceHash } = await import("./pipeline-yaml.ts");
const { deletePipelineRunsForWorkflow, insertPipelineRun, listPipelineRunsForStep } = await import("./pipeline-runs.ts");

const VERIFY = `name: verify
description: Install and test.
inputs:
  package:
    default: hub
  branch:
    required: true
steps:
  - run: npm test
    working-directory: \${{ inputs.package }}
`;

const OTHER = `name: other
steps:
  - run: echo hi
`;

function errorCode(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		if (err instanceof PipelineStoreError) return err.code;
		throw err;
	}
	throw new Error("expected a PipelineStoreError");
}

test("insertPipeline stores the text, copies the name, and starts untrusted", () => {
	const p = insertPipeline({ source: VERIFY, tags: ["ci", "ci", " hub "] });
	assert.equal(p.name, "verify");
	assert.equal(p.source, VERIFY);
	assert.equal(p.sourceHash, sourceHash(VERIFY));
	assert.deepEqual(p.tags, ["ci", "hub"]);
	assert.equal(p.origin, "local");
	assert.equal(p.trustedHash, null);
	assert.equal(isTrusted(p), false);
	assert.equal(p.revoked, false);

	const read = getPipeline(p.id);
	assert.deepEqual(read, p);
	assert.ok(listPipelines().some((x) => x.id === p.id));
});

test("insertPipeline refuses invalid YAML and returns every validator error", () => {
	let caught: PipelineStoreErrorType | null = null;
	try {
		insertPipeline({ source: "name: x\nsteps:\n  - run: a\n    continue_on_error: true\n  - shell: bash\n" });
	} catch (err) {
		caught = err as PipelineStoreErrorType;
	}
	assert.ok(caught instanceof PipelineStoreError);
	assert.equal(caught.code, "invalid_pipeline");
	assert.equal(caught.errors.length, 2, JSON.stringify(caught.errors));
	assert.ok(caught.errors.some((e) => e.line === 4 && /did you mean "continue-on-error"/.test(e.message)));
	assert.ok(caught.errors.some((e) => e.path === "steps[1]" && e.message === '"run" is required'));
});

test("updatePipeline changes the hash and drops trust when the text changes", () => {
	const p = insertPipeline({ source: VERIFY, approve: true });
	assert.equal(isTrusted(p), true, "approve on create trusts the text");

	const edited = updatePipeline(p.id, { source: VERIFY.replace("npm test", "npm run ci") });
	assert.ok(edited);
	assert.notEqual(edited.sourceHash, p.sourceHash, "hash changes on edit");
	assert.equal(edited.trustedHash, null, "trust is dropped on edit");
	assert.equal(isTrusted(edited), false);
});

test("re-saving the same text keeps an earlier approval; tags alone do not revoke it", () => {
	const p = insertPipeline({ source: VERIFY, approve: true });
	const retagged = updatePipeline(p.id, { tags: ["renamed"] });
	assert.ok(retagged);
	assert.deepEqual(retagged.tags, ["renamed"]);
	assert.equal(isTrusted(retagged), true);
});

test("updatePipeline with approve trusts the new text in the same save", () => {
	const p = insertPipeline({ source: VERIFY, approve: true });
	const edited = updatePipeline(p.id, { source: OTHER, approve: true });
	assert.ok(edited);
	assert.equal(edited.name, "other", "the name follows the text");
	assert.equal(isTrusted(edited), true);
});

test("approvePipeline with a stale hash is refused; the current hash approves", () => {
	const p = insertPipeline({ source: VERIFY });
	const stale = p.sourceHash;
	updatePipeline(p.id, { source: OTHER });
	assert.equal(errorCode(() => approvePipeline(p.id, stale)), "stale_hash");
	assert.equal(getPipeline(p.id)?.trustedHash, null, "a refused approval changes nothing");

	const fresh = getPipeline(p.id)!;
	const approved = approvePipeline(p.id, fresh.sourceHash);
	assert.ok(approved);
	assert.equal(isTrusted(approved), true);
});

test("a server copy is read-only locally", () => {
	const p = insertPipeline({ source: VERIFY });
	// Phase 2's sync is what sets origin=server; there is no writer for it yet, so
	// the row is flipped directly, the way sync will leave it.
	open().prepare("UPDATE pipelines SET origin = 'server' WHERE id = ?").run(p.id);
	assert.equal(errorCode(() => updatePipeline(p.id, { tags: ["x"] })), "server_managed");
});

test("deletePipeline is refused while a command step uses it, and allowed after", () => {
	const p = insertPipeline({ source: VERIFY });
	const step = insertStep("wf-delete-test", "run the tests", {
		kind: "command",
		pipelineId: p.id,
		pipelineInputs: { branch: "main" },
	});
	assert.equal(errorCode(() => deletePipeline(p.id)), "in_use");
	try {
		deletePipeline(p.id);
	} catch (err) {
		assert.deepEqual((err as PipelineStoreErrorType).references, [`step ${step.id}`]);
	}
	assert.ok(getPipeline(p.id), "still there");

	assert.equal(deleteStep(step.id), true);
	assert.equal(deletePipeline(p.id), true);
	assert.equal(getPipeline(p.id), null);
});

test("deletePipeline is refused while a template step names the pipeline", () => {
	const p = insertPipeline({ source: OTHER });
	insertTemplate({
		name: "deploy checklist",
		steps: [{ description: "run the pipeline", kind: "command", pipelineId: p.id, pipelineInputs: {} }],
	});
	assert.equal(errorCode(() => deletePipeline(p.id)), "in_use");
	let refs: string[] = [];
	try {
		deletePipeline(p.id);
	} catch (err) {
		refs = (err as PipelineStoreErrorType).references;
	}
	assert.deepEqual(refs, ["template deploy checklist"]);
});

test("a template command step round-trips with its kind, pipeline and inputs; a plain step stays a task", () => {
	const p = insertPipeline({ source: VERIFY });
	const template = insertTemplate({
		name: "round trip",
		steps: [
			{ description: "agent work" },
			{
				description: "verify",
				kind: "command",
				pipelineId: p.id,
				pipelineInputs: { branch: "release" },
			},
		],
	});
	const read = getTemplate(template.id)!;
	assert.equal(read.steps[0].kind, "task", "absent kind defaults to task");
	assert.equal(read.steps[0].pipelineId, null);
	assert.equal(read.steps[0].pipelineInputs, null);
	assert.equal(read.steps[1].kind, "command");
	assert.equal(read.steps[1].pipelineId, p.id);
	assert.deepEqual(read.steps[1].pipelineInputs, { branch: "release" });
});

test("a template step that is not a command drops a stale pipeline id", () => {
	const template = insertTemplate({
		name: "stale fields",
		steps: [{ description: "agent work", pipelineId: "leftover", pipelineInputs: { x: "1" } } as never],
	});
	const [step] = getTemplate(template.id)!.steps;
	assert.equal(step.kind, "task");
	assert.equal(step.pipelineId, null, "a task never keeps a pipeline");
	assert.equal(step.pipelineInputs, null);
});

test("a command step stores useSubagent false and no acceptance criteria, whatever was asked", () => {
	const p = insertPipeline({ source: VERIFY });
	const step = insertStep("wf-command-fields", "verify", {
		kind: "command",
		pipelineId: p.id,
		pipelineInputs: { branch: "main" },
		useSubagent: true,
		acceptanceCriteria: "should be ignored",
	});
	const read = getStep(step.id)!;
	assert.equal(read.kind, "command");
	assert.equal(read.pipelineId, p.id);
	assert.deepEqual(read.pipelineInputs, { branch: "main" });
	assert.equal(read.useSubagent, false);
	assert.equal(read.acceptanceCriteria, null);
	assert.equal(read.pendingReport, null);
	assert.equal(read.pendingReportDelivered, false);
});

test("an agent step reads back with no pipeline fields set", () => {
	const step = insertStep("wf-agent-fields", "agent work");
	const read = getStep(step.id)!;
	assert.equal(read.kind, "task");
	assert.equal(read.pipelineId, null);
	assert.equal(read.pipelineInputs, null);
});

test("a bundle carries the text and no trust, ids or secrets; an import comes back untrusted", () => {
	const original = insertPipeline({ source: VERIFY, tags: ["ci"], approve: true });
	const bundle = pipelineBundle([original]);
	assert.equal(bundle.kind, PIPELINE_BUNDLE_KIND);
	const serialized = JSON.stringify(bundle);
	assert.ok(!serialized.includes(original.id), "no id");
	assert.ok(!serialized.includes("trusted"), "no trust");
	assert.ok(!serialized.includes(original.sourceHash), "no hash");

	const entries = parsePipelineBundle(JSON.parse(serialized));
	const [copy] = importPipelines(entries);
	assert.notEqual(copy.id, original.id, "an import mints a new id, never overwrites");
	assert.equal(copy.source, VERIFY, "the text survives the round trip");
	assert.equal(copy.name, "verify");
	assert.deepEqual(copy.tags, ["ci"]);
	assert.equal(isTrusted(copy), false, "an import is untrusted");
	assert.equal(isTrusted(getPipeline(original.id)!), true, "the original is untouched");
});

test("a bundle with an invalid entry is refused whole, with the line of the error", () => {
	const bad = { kind: PIPELINE_BUNDLE_KIND, schemaVersion: 1, pipelines: [{ name: "x", tags: [], source: "name: x\nsteps: []\n" }] };
	let caught: PipelineStoreErrorType | null = null;
	try {
		parsePipelineBundle(bad);
	} catch (err) {
		caught = err as PipelineStoreErrorType;
	}
	assert.equal(caught?.code, "invalid_pipeline");
	assert.ok(caught?.errors.some((e) => e.path === "pipelines[0].steps"));
});

test("a bundle of another kind is refused", () => {
	assert.equal(errorCode(() => parsePipelineBundle({ kind: "target.tcps", schemaVersion: 1, pipelines: [] })), "invalid_bundle");
});

test("deleting a pipeline that is not referenced removes it", () => {
	const p = insertPipeline({ source: OTHER });
	assert.equal(deletePipeline(p.id), true);
	assert.equal(deletePipeline(p.id), false, "a second delete finds nothing");
});

test("run records: one row per attempt, job steps in order, removed with the workflow", () => {
	const logDir = path.join(tmpHome, "logs");
	fs.mkdirSync(logDir, { recursive: true });
	const logPath = path.join(logDir, "run-1.log");
	fs.writeFileSync(logPath, "output\n");
	const p = insertPipeline({ source: VERIFY });
	const run = insertPipelineRun({
		stepId: "step-run-records",
		workflowId: "wf-run-records",
		attempt: 1,
		pipelineId: p.id,
		sourceHash: p.sourceHash,
		logPath,
		steps: [
			{ index: 0, name: "Install" },
			{ index: 1, name: "Test" },
		],
	});
	assert.equal(run.steps.length, 2);
	assert.equal(run.steps[0].status, "pending");
	assert.equal(listPipelineRunsForStep("step-run-records").length, 1);

	assert.equal(deletePipelineRunsForWorkflow("wf-run-records"), 1);
	assert.equal(fs.existsSync(logPath), false, "the log file is removed with the run");
	assert.equal(listPipelineRunsForStep("step-run-records").length, 0);
});

// --- Migration of an existing DB -------------------------------------------

/**
 * The `steps` table exactly as HEAD creates it, before this step: none of the
 * pipeline columns. An install that predates command steps has this table.
 */
const LEGACY_STEPS_DDL = `
CREATE TABLE steps (
	id TEXT PRIMARY KEY,
	workflow_id TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'task',
	order_index INTEGER NOT NULL,
	description TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	result TEXT,
	error TEXT,
	session_id TEXT,
	callback_token TEXT NOT NULL,
	created_at TEXT NOT NULL,
	started_at TEXT,
	queued_at TEXT,
	finished_at TEXT,
	is_manual_run INTEGER NOT NULL DEFAULT 0,
	manual_review INTEGER NOT NULL DEFAULT 0,
	use_subagent INTEGER NOT NULL DEFAULT 1,
	acceptance_criteria TEXT,
	max_retries INTEGER NOT NULL DEFAULT 0,
	retry_interval_seconds INTEGER NOT NULL DEFAULT 0,
	retry_count INTEGER NOT NULL DEFAULT 0,
	phase TEXT NOT NULL DEFAULT 'exec',
	selected INTEGER NOT NULL DEFAULT 1,
	last_progress_at TEXT,
	last_progress_kind TEXT,
	last_progress_token TEXT,
	status_manual INTEGER NOT NULL DEFAULT 0,
	status_manual_at TEXT
);`;

test("an existing DB without the pipeline columns is upgraded in place by open()", () => {
	const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-pipeline-legacy-"));
	const db = new DatabaseSync(path.join(legacyHome, "target.db"));
	db.exec(LEGACY_STEPS_DDL);
	db.prepare(
		"INSERT INTO steps (id, workflow_id, order_index, description, callback_token, created_at) VALUES ('legacy-step', 'legacy-wf', 0, 'old agent step', 'tok', '2025-01-01T00:00:00.000Z')",
	).run();
	db.close();

	// open() is a per-process singleton, so the upgrade runs in a fresh process
	// that opens the legacy file exactly as the hub does.
	const storeUrl = new URL("./db.ts", import.meta.url).href;
	const script = `
		const { open, getStep } = await import(${JSON.stringify(storeUrl)});
		const database = open();
		const columns = database.prepare("PRAGMA table_info(steps)").all().map((c) => c.name);
		const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
		const step = getStep("legacy-step");
		console.log(JSON.stringify({ columns, tables, step }));
	`;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, TARGET_HOME: legacyHome, AWB_HOME: legacyHome },
		encoding: "utf8",
	});
	const result = JSON.parse(out.trim().split("\n").pop() ?? "{}") as {
		columns: string[];
		tables: string[];
		step: Record<string, unknown>;
	};

	for (const column of ["pipeline_id", "pipeline_inputs", "pending_report", "pending_report_delivered"]) {
		assert.ok(result.columns.includes(column), `steps gained ${column}`);
	}
	for (const table of ["pipelines", "pipeline_runs", "pipeline_run_steps", "pipeline_secrets"]) {
		assert.ok(result.tables.includes(table), `table ${table} created`);
	}
	assert.equal(result.step.kind, "task", "an old row stays an agent step");
	assert.equal(result.step.pipelineId, null);
	assert.equal(result.step.pipelineInputs, null);
	assert.equal(result.step.pendingReport, null);
	assert.equal(result.step.pendingReportDelivered, false);
	assert.equal(result.step.description, "old agent step");
});
