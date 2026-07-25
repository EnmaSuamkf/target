import styles from "./EmptyState.module.css";

/**
 * Placeholder for an empty list or an unselected detail pane. Takes an optional
 * action so an empty state can offer the next step instead of just stating that
 * there's nothing there.
 */
export function EmptyState({
	icon,
	title,
	description,
	action,
}: {
	icon?: React.ReactNode;
	title: string;
	description?: string;
	action?: React.ReactNode;
}): React.JSX.Element {
	return (
		<div className={styles.empty}>
			{icon && (
				<div className={styles.icon} aria-hidden="true">
					{icon}
				</div>
			)}
			<p className={styles.title}>{title}</p>
			{description && <p className={styles.description}>{description}</p>}
			{action && <div className={styles.action}>{action}</div>}
		</div>
	);
}
