/**
 * The step notes timeline (ui/src/components/StepTimeline.tsx): the pure rules in
 * ui/src/lib/stepTimeline.ts (creation order with a stable tie-break, the edited
 * marker, the author label, the time label), plus source-level checks that the
 * component is wired in and the phone-width layout cannot scroll sideways.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { authorLabel, isEdited, noteTimeLabel, orderNotesForTimeline } from "./ui/src/lib/stepTimeline.ts";

const src = (rel: string) => fs.readFileSync(new URL(`./ui/src/${rel}`, import.meta.url), "utf8");

type Note = { id: string; createdAt: string; updatedAt: string; source: "operator" | "agent"; content: string };
const note = (over: Partial<Note> & { id: string }): Note => ({
	content: `text of ${over.id}`,
	source: "operator",
	createdAt: "2026-11-01T10:00:00.000Z",
	updatedAt: "2026-11-01T10:00:00.000Z",
	...over,
});

test("orderNotesForTimeline returns notes oldest first by createdAt", () => {
	const notes = [
		note({ id: "c", createdAt: "2026-11-03T09:00:00.000Z" }),
		note({ id: "a", createdAt: "2026-11-01T09:00:00.000Z" }),
		note({ id: "b", createdAt: "2026-11-02T09:00:00.000Z" }),
	];
	assert.deepEqual(
		orderNotesForTimeline(notes).map((n) => n.id),
		["a", "b", "c"],
	);
});

test("orderNotesForTimeline breaks ties by the original order, and does not reorder the input", () => {
	const same = "2026-11-01T09:00:00.000Z";
	const first = note({ id: "first", createdAt: same });
	const second = note({ id: "second", createdAt: same });
	const later = note({ id: "later", createdAt: "2026-11-01T09:00:01.000Z" });

	assert.deepEqual(
		orderNotesForTimeline([first, second, later]).map((n) => n.id),
		["first", "second", "later"],
	);
	// The same instant keeps whatever order it arrived in, not an id order.
	assert.deepEqual(
		orderNotesForTimeline([second, first]).map((n) => n.id),
		["second", "first"],
	);

	const input = [later, second, first];
	orderNotesForTimeline(input);
	assert.deepEqual(
		input.map((n) => n.id),
		["later", "second", "first"],
	);
});

test("orderNotesForTimeline sorts an unreadable timestamp to the front instead of breaking the order", () => {
	const notes = [note({ id: "dated", createdAt: "2026-11-01T09:00:00.000Z" }), note({ id: "broken", createdAt: "not a date" })];
	assert.deepEqual(
		orderNotesForTimeline(notes).map((n) => n.id),
		["broken", "dated"],
	);
});

test("isEdited is true only when updatedAt is later than createdAt", () => {
	assert.equal(
		isEdited({ createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:05:00.000Z" }),
		true,
	);
	// Never edited: the server writes the same instant to both.
	assert.equal(
		isEdited({ createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z" }),
		false,
	);
	// Not later is not an edit.
	assert.equal(
		isEdited({ createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T08:59:00.000Z" }),
		false,
	);
	assert.equal(isEdited({ createdAt: "not a date", updatedAt: "2026-11-01T09:00:00.000Z" }), false);
});

test("authorLabel names agent notes Agent and everything else Operator", () => {
	assert.equal(authorLabel("agent"), "Agent");
	assert.equal(authorLabel("operator"), "Operator");
});

test("noteTimeLabel shows only the clock time for a note created today", () => {
	const now = new Date(2026, 10, 4, 15, 0, 0);
	const createdAt = new Date(2026, 10, 4, 9, 30, 0).toISOString();
	const clock = new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	assert.equal(noteTimeLabel(createdAt, now), clock);
});

test("noteTimeLabel includes the date in front of the time for a note from another day", () => {
	const now = new Date(2026, 10, 4, 15, 0, 0);
	const createdAt = new Date(2026, 9, 28, 9, 30, 0).toISOString();
	const label = noteTimeLabel(createdAt, now);
	const clock = new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	assert.ok(label.endsWith(clock), label);
	assert.ok(label.length > clock.length + 1, `expected a date before ${clock}, got "${label}"`);
	assert.match(label, /28/);
});

test("noteTimeLabel is empty for an unreadable timestamp", () => {
	assert.equal(noteTimeLabel("not a date", new Date()), "");
});

test("StepTimeline renders the ordered notes with position, time, author, edited marker, text and theme", () => {
	const component = src("components/StepTimeline.tsx");
	assert.match(component, /orderNotesForTimeline\(notes\)/);
	assert.match(component, /authorLabel\(note\.source\)/);
	assert.match(component, /isEdited\(note\)/);
	assert.match(component, /\{note\.content\}/);
	assert.match(component, /data-note-theme=\{note\.theme\}/);
	assert.match(component, /noteTimeLabel\(note\.createdAt, now\)/);
});

test("StepNotes keeps the Add, Edit and Delete controls and uses the timeline for workflow notes", () => {
	const notes = src("components/StepNotes.tsx");
	assert.match(notes, /<StepTimeline notes=\{workflowNotes\}/);
	assert.match(notes, /data-add-note/);
	assert.match(notes, /data-save-note/);
	assert.match(notes, /data-remove-note/);
	assert.match(notes, /onClick=\{\(\) => startEdit\(note\)\}/);
	// Template notes keep the sticky-note list.
	assert.match(notes, /templateNotes\.map\(/);
});

test("the timeline layout cannot scroll sideways at phone width", () => {
	const css = src("components/StepTimeline.module.css");
	assert.doesNotMatch(css, /white-space:\s*nowrap/);
	assert.doesNotMatch(css, /100vw/);
	assert.doesNotMatch(css, /overflow-x/);
	assert.match(css, /overflow-wrap:\s*anywhere/);
	assert.match(css, /min-width:\s*0/);
});
