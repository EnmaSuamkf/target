/**
 * Step note `source` (operator | agent): the `step_notes` migration on a DB that
 * already holds notes, insert defaults, the validator, and that editing a note
 * never changes who wrote it.
 *
 * The legacy `step_notes` table is seeded before db.ts is imported, so the
 * assertions run against the real upgrade path in open(). Runs against a
 * throwaway TARGET_HOME, so nothing here touches the operator's real ~/.target.
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-step-note-source-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const dbPath = path.join(tmpHome, "target.db");
const LEGACY_STEP = "legacy-step";
{
	// The `step_notes` table as it was before `source` existed. Two notes share a
	// created_at, so the rowid tie-break is what keeps their order.
	const legacy = new DatabaseSync(dbPath);
	legacy.exec(`
		CREATE TABLE step_notes (
			id TEXT PRIMARY KEY,
			step_id TEXT NOT NULL,
			workflow_id TEXT NOT NULL,
			content TEXT NOT NULL,
			theme TEXT NOT NULL DEFAULT 'neutral',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);
	const insert = legacy.prepare(
		"INSERT INTO step_notes (id, step_id, workflow_id, content, theme, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	insert.run("legacy-1", LEGACY_STEP, "wf-legacy", "first", "warning", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
	insert.run("legacy-2", LEGACY_STEP, "wf-legacy", "second", "neutral", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
	insert.run("legacy-3", LEGACY_STEP, "wf-legacy", "third", "success", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
	legacy.close();
}

const { open, insertStepNote, updateStepNote, getStepNote, listStepNotes, normalizeStepNoteSource } = await import(
	"./db.ts"
);

function sourceColumnCount(): number {
	const rows = open().prepare("PRAGMA table_info(step_notes)").all() as { name: string }[];
	return rows.filter((c) => c.name === "source").length;
}

test("migration adds source with default operator and keeps existing notes in order", () => {
	assert.equal(sourceColumnCount(), 1);

	const notes = listStepNotes(LEGACY_STEP);
	assert.deepEqual(
		notes.map((n) => n.id),
		["legacy-1", "legacy-2", "legacy-3"],
	);
	assert.deepEqual(
		notes.map((n) => n.content),
		["first", "second", "third"],
	);
	for (const note of notes) assert.equal(note.source, "operator");
	assert.equal(notes[0].createdAt, "2026-01-01T00:00:00.000Z");
	assert.equal(notes[0].theme, "warning");
});

test("migration is idempotent: a second process opening the migrated DB succeeds and keeps one column", () => {
	const dbModuleUrl = pathToFileURL(path.join(import.meta.dirname, "db.ts")).href;
	const child = spawnSync(
		process.execPath,
		["--input-type=module", "-e", `const m = await import(${JSON.stringify(dbModuleUrl)}); m.open(); console.log("opened");`],
		{
			cwd: import.meta.dirname,
			env: { ...process.env, TARGET_HOME: tmpHome, AWB_HOME: tmpHome },
			encoding: "utf8",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /opened/);
	assert.equal(sourceColumnCount(), 1);
	assert.equal(
		listStepNotes(LEGACY_STEP).every((n) => n.source === "operator"),
		true,
	);
});

test("insert with source agent stores and returns agent", () => {
	const note = insertStepNote("step-agent", "wf-agent", "from the agent", "success", "agent");
	assert.equal(note.source, "agent");
	assert.equal(getStepNote(note.id)?.source, "agent");
	assert.equal(listStepNotes("step-agent")[0].source, "agent");
});

test("insert without source stores operator", () => {
	const note = insertStepNote("step-default", "wf-default", "typed in the UI");
	assert.equal(note.source, "operator");
	assert.equal(getStepNote(note.id)?.source, "operator");
	assert.equal(listStepNotes("step-default")[0].source, "operator");
});

test("normalizeStepNoteSource accepts only operator and agent", () => {
	assert.equal(normalizeStepNoteSource("operator"), "operator");
	assert.equal(normalizeStepNoteSource("agent"), "agent");
	for (const bad of ["Agent", "OPERATOR", " agent", "", "system", undefined, null, 0, 1, true, {}, ["agent"]]) {
		assert.equal(normalizeStepNoteSource(bad), null, `expected null for ${JSON.stringify(bad)}`);
	}
});

test("a stored value that is not a known source reads back as operator", () => {
	const note = insertStepNote("step-corrupt", "wf-corrupt", "odd row", "neutral", "agent");
	open().prepare("UPDATE step_notes SET source = ? WHERE id = ?").run("system", note.id);
	assert.equal(getStepNote(note.id)?.source, "operator");
	assert.equal(listStepNotes("step-corrupt")[0].source, "operator");
});

test("updating a note keeps its source and does not change it", () => {
	const agentNote = insertStepNote("step-update", "wf-update", "agent text", "neutral", "agent");
	const updated = updateStepNote(agentNote.id, "edited text", "warning");
	assert.equal(updated?.source, "agent");
	assert.equal(updated?.content, "edited text");
	assert.equal(getStepNote(agentNote.id)?.source, "agent");

	const operatorNote = insertStepNote("step-update", "wf-update", "operator text");
	assert.equal(updateStepNote(operatorNote.id, "changed")?.source, "operator");
	assert.equal(getStepNote(operatorNote.id)?.source, "operator");
});
