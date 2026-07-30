import { useState } from "react";
import { type AttachmentThumb, ImageAttachments, imageFilesFrom } from "./ImageAttachments.tsx";
import { RichTextModal } from "./RichTextModal.tsx";
import styles from "./ExpandableTextarea.module.css";

/**
 * Everything the field needs to also carry attached images. Passing it turns the
 * plain textarea into an attachment target: a thumbnail strip appears under it,
 * and pasting or dropping an image on the textarea itself attaches it.
 *
 * Owned by the parent rather than by this component because who the images belong
 * to differs per field — the conversation context uploads to the workflow, a step
 * editor to that step, and the add-step forms can't upload at all until the step
 * exists, so they hold the files locally and upload after the POST.
 */
export interface TextareaAttachments {
	items: AttachmentThumb[];
	onAdd: (files: File[]) => void | Promise<void>;
	onRemove: (id: string) => void | Promise<void>;
	busy?: boolean;
	/** What the images belong to, for accessible names ("acceptance criteria"). */
	label: string;
	idPrefix: string;
}

/**
 * A textarea with an "expand" affordance in its corner.
 *
 * Clicking it opens the rich-text popup ({@link RichTextModal}) seeded with the
 * field's current value, where the text can be worked on comfortably with
 * formatting (bold, lists, headings). OK writes the result — as Markdown —
 * back into this field through the normal `onChange`, so to the surrounding
 * form nothing changed: same value prop, same change events, same submit path.
 *
 * The button is hidden while the field is read-only or disabled — expanding a
 * locked value into an editor that can't save it would be a lie.
 */
export function ExpandableTextarea({
	value,
	onChange,
	expandTitle,
	className = "textarea",
	readOnly,
	disabled,
	attachments,
	...rest
}: {
	value: string;
	onChange: (value: string) => void;
	/** Title of the popup, e.g. "Edit task description". */
	expandTitle: string;
	/** Present when this field can carry images; see {@link TextareaAttachments}. */
	attachments?: TextareaAttachments;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">): React.JSX.Element {
	const [expanded, setExpanded] = useState(false);
	const [dragging, setDragging] = useState(false);
	const editable = !readOnly && !disabled;
	const canAttach = attachments !== undefined && editable;

	/**
	 * A paste carrying image files attaches them; anything else is left to the
	 * browser. `preventDefault` is called ONLY in the image case — swallowing a
	 * plain text paste would break the field's primary use.
	 */
	const handlePaste = (ev: React.ClipboardEvent<HTMLTextAreaElement>): void => {
		if (!canAttach) return;
		const files = imageFilesFrom(ev.clipboardData);
		if (files.length === 0) return;
		ev.preventDefault();
		void attachments.onAdd(files);
	};

	return (
		<div className={styles.wrap}>
			<textarea
				{...rest}
				className={`${className}${dragging ? ` ${styles.dropTarget}` : ""}`}
				value={value}
				readOnly={readOnly}
				disabled={disabled}
				onChange={(ev) => onChange(ev.target.value)}
				onPaste={handlePaste}
				onDragOver={
					canAttach
						? (ev) => {
								// Only claim the drag when it actually carries files — a text
								// selection dragged within the textarea must still move text.
								if (!Array.from(ev.dataTransfer.types).includes("Files")) return;
								ev.preventDefault();
								setDragging(true);
							}
						: undefined
				}
				onDragLeave={canAttach ? () => setDragging(false) : undefined}
				onDrop={
					canAttach
						? (ev) => {
								const files = imageFilesFrom(ev.dataTransfer);
								setDragging(false);
								if (files.length === 0) return;
								ev.preventDefault();
								void attachments.onAdd(files);
							}
						: undefined
				}
			/>
			{editable && (
				<button
					type="button"
					className={`${styles.expand} tap-target`}
					title="Expand — edit in a larger window with formatting"
					aria-label={`Expand: ${expandTitle}`}
					aria-haspopup="dialog"
					onClick={() => setExpanded(true)}
				>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
					</svg>
				</button>
			)}

			<RichTextModal
				open={expanded}
				title={expandTitle}
				initialValue={value}
				onCancel={() => setExpanded(false)}
				onConfirm={(next) => {
					onChange(next);
					setExpanded(false);
				}}
			/>

			{attachments && (
				<ImageAttachments
					items={attachments.items}
					onAdd={attachments.onAdd}
					onRemove={attachments.onRemove}
					busy={attachments.busy ?? false}
					label={attachments.label}
					idPrefix={attachments.idPrefix}
					disabled={!editable}
				/>
			)}
		</div>
	);
}
