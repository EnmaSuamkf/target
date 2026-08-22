/**
 * Sticky notes on workflow steps — create, edit, delete, and report each change
 * to the activity queue (step.note.added / modified / deleted).
 */
import {
	copyTemplateNotesToStep,
	deleteStepNote as deleteStepNoteRow,
	getStep,
	getStepNote,
	insertStepNote,
	listStepNotes,
	normalizeStepNoteTheme,
	type StepNote,
	type StepNoteTheme,
	type TemplateStepNote,
	updateStepNote as updateStepNoteRow,
} from "./db.ts";
import { emit as reportEmit } from "./reporter.ts";

export class StepNoteError extends Error {}

function refuseContextStep(step: { kind: string }): void {
	if (step.kind === "context") throw new StepNoteError("context step cannot carry notes");
}

function reportNoteEvent(
	kind: "step.note.added" | "step.note.modified" | "step.note.deleted",
	note: StepNote,
	extra: Record<string, unknown> = {},
): void {
	reportEmit(kind, {
		workflowId: note.workflowId,
		data: {
			note_id: note.id,
			step_id: note.stepId,
			theme: note.theme,
			content: note.content.slice(0, 2000),
			content_len: note.content.length,
			...extra,
		},
	});
}

export function notesForStep(stepId: string): StepNote[] {
	return listStepNotes(stepId);
}

export function addStepNote(
	workflowId: string,
	stepId: string,
	content: string,
	theme: StepNoteTheme = "neutral",
): StepNote {
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new StepNoteError("unknown step");
	refuseContextStep(step);
	const trimmed = content.trim();
	if (trimmed === "") throw new StepNoteError("note content is required");
	const note = insertStepNote(stepId, workflowId, trimmed, normalizeStepNoteTheme(theme));
	reportNoteEvent("step.note.added", note);
	return note;
}

export function editStepNote(
	workflowId: string,
	stepId: string,
	noteId: string,
	content: string,
	theme?: StepNoteTheme,
): StepNote {
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new StepNoteError("unknown step");
	refuseContextStep(step);
	const existing = getStepNote(noteId);
	if (!existing || existing.stepId !== stepId) throw new StepNoteError("unknown note");
	const trimmed = content.trim();
	if (trimmed === "") throw new StepNoteError("note content is required");
	const updated = updateStepNoteRow(noteId, trimmed, theme);
	if (!updated) throw new StepNoteError("unknown note");
	reportNoteEvent("step.note.modified", updated);
	return updated;
}

export function removeStepNote(workflowId: string, stepId: string, noteId: string): void {
	const step = getStep(stepId);
	if (!step || step.workflowId !== workflowId) throw new StepNoteError("unknown step");
	refuseContextStep(step);
	const existing = getStepNote(noteId);
	if (!existing || existing.stepId !== stepId) throw new StepNoteError("unknown note");
	deleteStepNoteRow(noteId);
	reportNoteEvent("step.note.deleted", existing);
}

/** Seeds notes from a template step onto a workflow step (no events — the step.added event covers planning). */
export function seedStepNotesFromTemplate(
	stepId: string,
	workflowId: string,
	notes: TemplateStepNote[] | undefined,
): StepNote[] {
	return copyTemplateNotesToStep(stepId, workflowId, notes);
}
