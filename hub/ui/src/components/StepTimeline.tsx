import type { ReactNode } from "react";
import type { StepNote, StepNoteTheme } from "../api/types.ts";
import { authorLabel, isEdited, noteTimeLabel, orderNotesForTimeline } from "../lib/stepTimeline.ts";
import styles from "./StepTimeline.module.css";

function markerClass(theme: StepNoteTheme): string {
	switch (theme) {
		case "warning":
			return styles.markerWarning ?? "";
		case "success":
			return styles.markerSuccess ?? "";
		default:
			return styles.markerNeutral ?? "";
	}
}

/**
 * A step's workflow notes as a vertical timeline, oldest first. Each row shows
 * its position, creation time, author, an "Edited" marker when the note changed
 * after it was created, the full text and a theme-coloured marker. `renderActions`
 * adds the operator's controls under a row; the timeline itself is read-only.
 */
export function StepTimeline({
	notes,
	now = new Date(),
	renderActions,
}: {
	notes: StepNote[];
	now?: Date;
	renderActions?: ((note: StepNote) => ReactNode) | undefined;
}): React.JSX.Element {
	const ordered = orderNotesForTimeline(notes);
	return (
		<ol className={styles.timeline} data-step-timeline>
			{ordered.map((note, index) => (
				<li key={note.id} className={styles.row} data-note-theme={note.theme} data-note-source={note.source}>
					<span className={`${styles.marker} ${markerClass(note.theme)}`} aria-hidden="true" />
					<div className={styles.body}>
						<div className={styles.meta}>
							<span className={styles.position}>{index + 1}</span>
							<time className={styles.time} dateTime={note.createdAt}>
								{noteTimeLabel(note.createdAt, now)}
							</time>
							<span className={styles.author} data-note-author>
								{authorLabel(note.source)}
							</span>
							{isEdited(note) && (
								<span className={styles.edited} data-note-edited>
									Edited
								</span>
							)}
						</div>
						<div className={styles.text}>{note.content}</div>
						{renderActions?.(note)}
					</div>
				</li>
			))}
		</ol>
	);
}
