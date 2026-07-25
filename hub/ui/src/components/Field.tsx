import { useId } from "react";
import styles from "./Field.module.css";

/**
 * Labelled form control wrapper.
 *
 * The previous UI put its explanations in `title` attributes marked with a "ⓘ"
 * glyph, which never appear on touch, are invisible to screen readers as
 * descriptions, and take a second to trigger on hover. Here the same text is a
 * real `<p>` wired to the control via `aria-describedby`, so it's always
 * readable — the help is part of the form, not a hover easter egg.
 */
export function Field({
	label,
	hint,
	error,
	required,
	children,
}: {
	label: string;
	hint?: string;
	error?: string;
	required?: boolean;
	/** Receives the generated id/aria wiring for the control. */
	children: (props: { id: string; "aria-describedby": string | undefined }) => React.ReactNode;
}): React.JSX.Element {
	const id = useId();
	const hintId = hint ? `${id}-hint` : undefined;
	const errorId = error ? `${id}-error` : undefined;
	const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

	return (
		<div className={styles.field}>
			<label className="label" htmlFor={id}>
				{label}
				{required && (
					<span className={styles.required} aria-hidden="true">
						*
					</span>
				)}
			</label>
			{children({ id, "aria-describedby": describedBy })}
			{hint && (
				<p className="hint" id={hintId}>
					{hint}
				</p>
			)}
			{error && (
				<p className="msg msg--error" id={errorId} role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
