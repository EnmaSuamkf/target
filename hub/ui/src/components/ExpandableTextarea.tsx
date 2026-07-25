import { useState } from "react";
import { RichTextModal } from "./RichTextModal.tsx";
import styles from "./ExpandableTextarea.module.css";

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
	...rest
}: {
	value: string;
	onChange: (value: string) => void;
	/** Title of the popup, e.g. "Edit task description". */
	expandTitle: string;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">): React.JSX.Element {
	const [expanded, setExpanded] = useState(false);
	const editable = !readOnly && !disabled;

	return (
		<div className={styles.wrap}>
			<textarea
				{...rest}
				className={className}
				value={value}
				readOnly={readOnly}
				disabled={disabled}
				onChange={(ev) => onChange(ev.target.value)}
			/>
			{editable && (
				<button
					type="button"
					className={styles.expand}
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
		</div>
	);
}
