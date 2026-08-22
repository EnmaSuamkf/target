import { useState } from "react";
import type { StepNote, StepNoteTheme, TemplateStepNote } from "../api/types.ts";
import { STEP_NOTE_THEMES } from "../api/types.ts";
import styles from "./StepNotes.module.css";

const THEME_LABELS: Record<StepNoteTheme, string> = {
	neutral: "Neutral",
	warning: "Warning",
	success: "Success",
};

function noteClass(theme: StepNoteTheme): string {
	switch (theme) {
		case "warning":
			return styles.noteWarning ?? "";
		case "success":
			return styles.noteSuccess ?? "";
		default:
			return styles.noteNeutral ?? "";
	}
}

function themeBtnClass(theme: StepNoteTheme, active: boolean): string {
	const cap = theme.charAt(0).toUpperCase() + theme.slice(1);
	const themeStyle = styles[`theme${cap}` as keyof typeof styles] ?? "";
	const base = `${styles.themeBtn} ${themeStyle}`;
	return active ? `${base} ${styles.themeBtnActive}` : base;
}

type WorkflowNote = StepNote | TemplateStepNote;

/** Sticky notes on a step — workflow mode persists via API; template mode is local state. */
export function StepNotes({
	notes,
	busy = false,
	onAdd,
	onEdit,
	onRemove,
}: {
	notes: WorkflowNote[];
	busy?: boolean;
	onAdd?: (content: string, theme: StepNoteTheme) => Promise<void>;
	onEdit?: (noteId: string, content: string, theme: StepNoteTheme) => Promise<void>;
	onRemove?: (noteId: string) => Promise<void>;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [content, setContent] = useState("");
	const [theme, setTheme] = useState<StepNoteTheme>("neutral");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const resetComposer = (): void => {
		setOpen(false);
		setEditingId(null);
		setContent("");
		setTheme("neutral");
	};

	const startEdit = (note: WorkflowNote): void => {
		setEditingId(note.id);
		setContent(note.content);
		setTheme(note.theme);
		setOpen(true);
	};

	const submit = async (): Promise<void> => {
		const trimmed = content.trim();
		if (!trimmed || saving) return;
		setSaving(true);
		try {
			if (editingId && onEdit) await onEdit(editingId, trimmed, theme);
			else if (onAdd) await onAdd(trimmed, theme);
			resetComposer();
		} finally {
			setSaving(false);
		}
	};

	const canMutate = !!(onAdd || onEdit || onRemove);

	return (
		<div className={styles.stepNotes} data-step-notes>
			<div className={styles.head}>
				<span className={styles.label}>Notes</span>
				{canMutate && !open && (
					<button
						type="button"
						className="btn btn--sm btn--ghost"
						onClick={() => setOpen(true)}
						disabled={busy}
						data-add-note
					>
						+ Add note
					</button>
				)}
			</div>

			{notes.length > 0 && (
				<div className={styles.list}>
					{notes.map((note) => (
						<div key={note.id} className={`${styles.note} ${noteClass(note.theme)}`} data-note-theme={note.theme}>
							{note.content}
							{canMutate && (
								<div className={styles.noteActions}>
									<button type="button" className={styles.noteBtn} onClick={() => startEdit(note)} disabled={busy || saving}>
										Edit
									</button>
									{onRemove && (
										<button
											type="button"
											className={styles.noteBtn}
											onClick={async () => {
												if (saving) return;
												setSaving(true);
												try {
													await onRemove(note.id);
													if (editingId === note.id) resetComposer();
												} finally {
													setSaving(false);
												}
											}}
											disabled={busy || saving}
											data-remove-note
										>
											Delete
										</button>
									)}
								</div>
							)}
						</div>
					))}
				</div>
			)}

			{open && canMutate && (
				<div className={styles.composer}>
					<textarea
						className={styles.textarea}
						value={content}
						onChange={(ev) => setContent(ev.target.value)}
						placeholder="Extra context for this step…"
						autoFocus
						data-note-input
					/>
					<div className={styles.themeRow}>
						<span className={styles.themeLabel}>Theme</span>
						{STEP_NOTE_THEMES.map((t) => (
							<button
								key={t}
								type="button"
								className={themeBtnClass(t, theme === t)}
								onClick={() => setTheme(t)}
								aria-pressed={theme === t}
								data-note-theme-option={t}
							>
								{THEME_LABELS[t]}
							</button>
						))}
					</div>
					<div className={styles.composerActions}>
						<button
							type="button"
							className="btn btn--primary btn--sm"
							onClick={() => void submit()}
							disabled={content.trim() === "" || saving || busy}
							data-save-note
						>
							{saving ? "Saving…" : editingId ? "Save" : "Add"}
						</button>
						<button type="button" className="btn btn--sm" onClick={resetComposer} disabled={saving}>
							Cancel
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
