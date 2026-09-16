import { useState, type ReactNode } from "react";
import styles from "./CollapsibleSection.module.css";

export function CollapsibleSection({
	title,
	defaultOpen = false,
	meta,
	children,
	className,
}: {
	title: string;
	defaultOpen?: boolean;
	meta?: ReactNode;
	children: ReactNode;
	className?: string;
}): React.JSX.Element {
	const [open, setOpen] = useState(defaultOpen);

	return (
		<details
			className={`${styles.section}${className ? ` ${className}` : ""}`}
			open={open}
			onToggle={(ev) => setOpen(ev.currentTarget.open)}
		>
			<summary className={styles.summary}>
				<svg
					className={styles.chevron}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M9 18l6-6-6-6" />
				</svg>
				<span className={styles.title}>{title}</span>
				{meta ? <span className={styles.meta}>{meta}</span> : null}
			</summary>
			<div className={styles.body}>
				<div className={styles.bodyInner}>{children}</div>
			</div>
		</details>
	);
}
