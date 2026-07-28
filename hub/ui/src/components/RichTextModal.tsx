import { useEffect, useRef } from "react";
import { htmlToMarkdown, markdownToHtml } from "../lib/richtext.ts";
import { Modal } from "./Modal.tsx";
import styles from "./RichTextModal.module.css";

/**
 * The enlarged text editor behind every field's "expand" button.
 *
 * A big contentEditable surface with a formatting toolbar (bold, italic,
 * headings, bullet/numbered lists). The document is Markdown at rest — the
 * field's value is Markdown text, rendered to HTML on open and serialized back
 * on OK — because everything typed here ultimately becomes plain text in a
 * prompt, and Markdown is the one format agents read natively.
 *
 * OK commits, Cancel/Escape/backdrop discard. The field itself only changes on
 * OK, so an accidental dismiss never destroys what was in the input.
 */

const TOOLBAR: { command: string; arg?: string; label: string; title: string; content: React.ReactNode }[] = [
	{
		command: "bold",
		label: "Bold",
		title: "Bold (Ctrl+B)",
		content: <strong>B</strong>,
	},
	{
		command: "italic",
		label: "Italic",
		title: "Italic (Ctrl+I)",
		content: <em>I</em>,
	},
	{
		command: "insertUnorderedList",
		label: "Bulleted list",
		title: "Bulleted list",
		content: (
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
				<path d="M9 6h11M9 12h11M9 18h11" />
				<circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none" />
				<circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none" />
				<circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		command: "insertOrderedList",
		label: "Numbered list",
		title: "Numbered list",
		content: (
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
				<path d="M10 6h10M10 12h10M10 18h10" />
				<path d="M4 5l1.5-1v5M3.5 13.5a1.5 1.5 0 1 1 3 0c0 .8-.6 1.2-3 3h3M3.5 18h2a1.25 1.25 0 0 1 0 2.5h-1 1a1.25 1.25 0 0 1 0 2.5h-2" transform="scale(0.9) translate(0.5 0)" />
			</svg>
		),
	},
	{
		command: "formatBlock",
		arg: "h2",
		label: "Heading",
		title: "Heading",
		content: <span className={styles.headingIcon}>H</span>,
	},
	{
		command: "formatBlock",
		arg: "div",
		label: "Normal text",
		title: "Normal text (remove heading)",
		content: <span className={styles.headingIcon}>¶</span>,
	},
];

export function RichTextModal({
	open,
	title,
	initialValue,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	title: string;
	/** Markdown seed — the current value of the field being expanded. */
	initialValue: string;
	onCancel: () => void;
	/** Receives the edited text serialized back to Markdown. */
	onConfirm: (value: string) => void;
}): React.JSX.Element {
	const editorRef = useRef<HTMLDivElement>(null);

	// Seed the editable surface once per open, from the field's current value.
	// This runs after Modal's own focus effect (parent effects fire after the
	// child's), so the editor — not the close button — ends up focused.
	useEffect(() => {
		if (!open) return;
		const editor = editorRef.current;
		if (!editor) return;
		editor.innerHTML = markdownToHtml(initialValue);
		editor.focus();
		// Caret at the end, where appending naturally continues.
		const selection = window.getSelection();
		if (selection) {
			const range = document.createRange();
			range.selectNodeContents(editor);
			range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
		}
		// `initialValue` intentionally omitted: re-seeding mid-edit (e.g. from a
		// poll re-render) would wipe what's being typed. One seed per open.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const exec = (command: string, arg?: string): void => {
		editorRef.current?.focus();
		// execCommand is deprecated but universally supported and is the only
		// dependency-free way to toggle inline formatting on a live selection.
		document.execCommand(command, false, arg);
	};

	const confirm = (): void => {
		const editor = editorRef.current;
		onConfirm(editor ? htmlToMarkdown(editor) : initialValue);
	};

	return (
		<Modal
			open={open}
			title={title}
			description="Format with the toolbar — bold, lists and headings are saved as Markdown."
			onClose={onCancel}
			size="lg"
			footer={
				<>
					<button type="button" className="btn" onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className="btn btn--primary" onClick={confirm} data-testid="richtext-ok">
						OK
					</button>
				</>
			}
		>
			<div className={styles.toolbar} role="toolbar" aria-label="Text formatting">
				{TOOLBAR.map((item) => (
					<button
						key={item.label}
						type="button"
						className={`${styles.tool} tap-target`}
						title={item.title}
						aria-label={item.label}
						// Prevent the button press from stealing the selection the
						// command should apply to.
						onMouseDown={(ev) => ev.preventDefault()}
						onClick={() => exec(item.command, item.arg)}
					>
						{item.content}
					</button>
				))}
			</div>

			<div
				ref={editorRef}
				className={styles.editor}
				contentEditable
				role="textbox"
				aria-multiline="true"
				aria-label={title}
				data-testid="richtext-editor"
				// React never re-renders this subtree's content — the DOM is the
				// source of truth while the dialog is open.
				suppressContentEditableWarning
			/>
		</Modal>
	);
}
