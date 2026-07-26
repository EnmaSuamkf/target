import styles from "./Switch.module.css";

/**
 * On/off switch for a single boolean preference.
 *
 * It's a `<button role="switch">` rather than a styled checkbox: the button
 * already answers to Space and Enter and carries a real accessible name, so the
 * only thing left to state is `aria-checked` — no hidden input to keep in sync
 * with the visual track, which is where switches usually go wrong. The track and
 * thumb are decoration (`aria-hidden`); the state lives on the button.
 */
export function Switch({
	checked,
	onChange,
	label,
	describedBy,
	disabled,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	/** Accessible name — the switch itself renders no text. */
	label: string;
	describedBy?: string | undefined;
	disabled?: boolean;
}): React.JSX.Element {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			aria-describedby={describedBy}
			className={`${styles.switch} ${checked ? styles.on : ""}`}
			onClick={() => onChange(!checked)}
			disabled={disabled}
		>
			<span className={styles.thumb} aria-hidden="true" />
		</button>
	);
}
