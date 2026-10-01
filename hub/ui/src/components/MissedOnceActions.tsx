/**
 * The three choices a missed `once` waits for (D8), shared by the notices
 * banner and the workflow's detail pane so they read and behave the same in
 * both. Run now is the one manual run an unfired scheduled instance allows;
 * Reschedule opens the schedule dialog on it; Dismiss gives up on the run and
 * it becomes a normal workflow.
 */
export function MissedOnceActions({
	canAct,
	actHint,
	busy,
	onRunNow,
	onReschedule,
	onDismiss,
}: {
	/** execute AND manage (D22). */
	canAct: boolean;
	actHint: string;
	busy: boolean;
	onRunNow: () => void;
	onReschedule: () => void;
	onDismiss: () => void;
}): React.JSX.Element {
	const disabled = busy || !canAct;
	return (
		<>
			<button
				type="button"
				className="btn btn--sm btn--primary"
				onClick={onRunNow}
				disabled={disabled}
				title={canAct ? "Run it now, once." : actHint}
				data-missed-run-now
			>
				Run now
			</button>
			<button
				type="button"
				className="btn btn--sm"
				onClick={onReschedule}
				disabled={disabled}
				title={canAct ? "Pick a new time for it." : actHint}
				data-missed-reschedule
			>
				Reschedule
			</button>
			<button
				type="button"
				className="btn btn--sm btn--ghost"
				onClick={onDismiss}
				disabled={disabled}
				title={canAct ? "Give up on this run; it becomes a normal workflow." : actHint}
				data-missed-dismiss
			>
				Dismiss
			</button>
		</>
	);
}
