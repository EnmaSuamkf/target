import { useId } from "react";
import styles from "./RecoveryFields.module.css";
import { Switch } from "./Switch.tsx";

/** The hint under the toggle, shared so every step form explains it the same way. */
export const RECOVER_ON_FAILURE_HINT =
	"If this step fails for good, an agent fixes the plan and relaunches the workflow.";

/**
 * Failure recovery's two step fields: the "Recover on failure" toggle and the
 * "Max recoveries" budget. Shared by every step form (the add-step form under
 * the list, the add-step dialog and the step editor) so the three cannot drift.
 *
 * "Max recoveries" stays visible but is disabled while the toggle is off: the
 * budget means nothing without the toggle, and hiding it would make the form
 * jump as the switch is flipped. The value is kept as typed text (like the
 * retry fields) and parsed with `parseMaxRecoveries` (lib/recovery.ts) on submit.
 */
export function RecoveryFields({
	recoverOnFailure,
	onRecoverOnFailure,
	maxRecoveries,
	onMaxRecoveries,
	disabled = false,
	recoveryCount,
}: {
	recoverOnFailure: boolean;
	onRecoverOnFailure: (on: boolean) => void;
	/** Raw text of the number field. */
	maxRecoveries: string;
	onMaxRecoveries: (value: string) => void;
	disabled?: boolean;
	/** Recoveries this step already used (the editor shows it; the add forms have none). */
	recoveryCount?: number | undefined;
}): React.JSX.Element {
	const id = useId();
	const hintId = `${id}-recover-hint`;
	const maxId = `${id}-max-recoveries`;
	const maxHintId = `${id}-max-recoveries-hint`;
	return (
		<div className={styles.block} data-recovery-fields>
			<div className={styles.gateRow}>
				<div className={styles.gateText}>
					<span className="label">Recover on failure</span>
					<p className="hint" id={hintId}>
						{RECOVER_ON_FAILURE_HINT} It changes only the plan (the step&rsquo;s text, criteria, retries), never the
						code, and uses the workflow&rsquo;s Recovery model.
					</p>
				</div>
				<Switch
					checked={recoverOnFailure}
					onChange={onRecoverOnFailure}
					label="Recover on failure"
					describedBy={hintId}
					disabled={disabled}
				/>
			</div>
			<div className={styles.maxRow}>
				<label className="label" htmlFor={maxId}>
					Max recoveries
				</label>
				<input
					id={maxId}
					type="number"
					className={`input ${styles.maxInput}`}
					min={0}
					step={1}
					inputMode="numeric"
					value={maxRecoveries}
					disabled={disabled || !recoverOnFailure}
					aria-describedby={maxHintId}
					onChange={(ev) => onMaxRecoveries(ev.target.value)}
					data-max-recoveries
				/>
				<p className="hint" id={maxHintId}>
					{recoverOnFailure
						? "How many times recovery may run for this step."
						: "Turn on Recover on failure to set it."}
					{recoveryCount !== undefined && recoveryCount > 0 ? ` Used so far: ${recoveryCount}.` : ""}
				</p>
			</div>
		</div>
	);
}
