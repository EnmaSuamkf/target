/**
 * Pure rules behind the step notes timeline (components/StepTimeline.tsx): the
 * order notes are shown in, whether a note reads as edited, who the author label
 * names, and how a creation time is written. Kept out of the component so the
 * hub's node:test suite can load them without a DOM or CSS modules.
 */
import type { StepNoteSource } from "../api/types.ts";

/**
 * Notes oldest first by `createdAt`. Notes created in the same instant keep
 * the order they arrived in, so the result never depends on the sort algorithm.
 * An unreadable timestamp sorts as the epoch rather than poisoning the order.
 */
export function orderNotesForTimeline<T extends { createdAt: string }>(notes: readonly T[]): T[] {
	const keyed = notes.map((note, index) => ({ note, index, at: timestampOf(note.createdAt) }));
	keyed.sort((a, b) => a.at - b.at || a.index - b.index);
	return keyed.map((k) => k.note);
}

/** True when the note changed after it was created: `updatedAt` is later than `createdAt`. */
export function isEdited(note: { createdAt: string; updatedAt: string }): boolean {
	const created = Date.parse(note.createdAt);
	const updated = Date.parse(note.updatedAt);
	if (Number.isNaN(created) || Number.isNaN(updated)) return false;
	return updated > created;
}

/** The author label for a note's source. Anything that is not "agent" is an operator note, as on the server. */
export function authorLabel(source: StepNoteSource): "Agent" | "Operator" {
	return source === "agent" ? "Agent" : "Operator";
}

/**
 * A note's creation time in the browser's local time: the clock time, with the
 * date in front of it when the note was not created today. Empty when the
 * timestamp cannot be read.
 */
export function noteTimeLabel(createdAt: string, now: Date): string {
	const at = new Date(createdAt);
	if (Number.isNaN(at.getTime())) return "";
	const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (sameLocalDay(at, now)) return time;
	const date = at.toLocaleDateString(
		[],
		at.getFullYear() === now.getFullYear()
			? { month: "short", day: "numeric" }
			: { year: "numeric", month: "short", day: "numeric" },
	);
	return `${date} ${time}`;
}

function timestampOf(iso: string): number {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? 0 : ms;
}

function sameLocalDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
