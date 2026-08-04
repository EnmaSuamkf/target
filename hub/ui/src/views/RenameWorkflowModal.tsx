import { useEffect, useState } from "react";
import { Field } from "../components/Field.tsx";
import { Modal } from "../components/Modal.tsx";
import styles from "./RenameWorkflowModal.module.css";

/**
 * The workflow header's **Change** button: edit the workflow's name, with
 * **Cancel** (discard) and **Save** (persist) as the only two ways out.
 *
 * A dialog rather than an inline editable title: the title sits next to the
 * status badge in a header that also holds the run controls, and a field that
 * appears in that row would either shift the controls or turn a click meant for
 * the badge into an edit. It's also the shape the rest of this UI already uses
 * for "type something and confirm" (see AddStepModal).
 *
 * The field is re-seeded from the workflow on every open, so a dialog reopened
 * after a Cancel shows the stored name rather than the abandoned edit — that is
 * what makes Cancel actually discard. `onSave` resolves true only when the
 * server really stored it, so a rejected rename leaves the dialog open with the
 * text still in it instead of silently losing it.
 */
export function RenameWorkflowModal({
	open,
	name,
	onClose,
	onSave,
}: {
	open: boolean;
	/** The workflow's current name — what the field starts from. */
	name: string;
	onClose: () => void;
	/** Resolves true when the new name reached the server. */
	onSave: (name: string) => Promise<boolean>;
}): React.JSX.Element {
	const [value, setValue] = useState(name);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setValue(name);
		// Seeded per open, not per render: the app re-renders this every 2s (the
		// poll), and re-seeding then would overwrite what is being typed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const trimmed = value.trim();
	// Saving the name it already has is a no-op the server would accept anyway;
	// disabling it keeps the button honest about what it's for.
	const canSubmit = trimmed !== "" && trimmed !== name && !saving;

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (!canSubmit) return;
		setSaving(true);
		try {
			if (await onSave(trimmed)) onClose();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			open={open}
			title="Change workflow name"
			description="Only the name changes. This workflow's agent, its hook and its status file keep the name they were created with, so renaming is safe while it's running."
			onClose={onClose}
			size="sm"
			footer={
				<>
					<button type="button" className="btn" onClick={onClose} disabled={saving}>
						Cancel
					</button>
					<button type="submit" form="rename-workflow" className="btn btn--primary" disabled={!canSubmit}>
						{saving ? "Saving…" : "Save"}
					</button>
				</>
			}
		>
			<form id="rename-workflow" className={styles.form} onSubmit={submit}>
				<Field label="Workflow name" required>
					{(props) => (
						<input
							{...props}
							type="text"
							className="input"
							value={value}
							placeholder="What this workflow is for…"
							onChange={(ev) => setValue(ev.target.value)}
							disabled={saving}
							required
							autoFocus
						/>
					)}
				</Field>
			</form>
		</Modal>
	);
}
