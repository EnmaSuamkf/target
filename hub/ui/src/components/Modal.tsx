import { useEffect, useRef } from "react";
import styles from "./Modal.module.css";

/**
 * Accessible modal dialog: focus moves in on open and returns to the trigger on
 * close, Escape dismisses, Tab is trapped inside, and the backdrop closes on a
 * click that both starts and ends outside the box (so a drag that began inside
 * the dialog doesn't dismiss it).
 *
 * The previous UI used `alert()`/`confirm()` and one hand-rolled backdrop; this
 * replaces both so destructive actions and forms share one surface.
 */
export function Modal({
	open,
	title,
	description,
	onClose,
	children,
	footer,
	size = "md",
}: {
	open: boolean;
	title: string;
	description?: string;
	onClose: () => void;
	children?: React.ReactNode;
	footer?: React.ReactNode;
	size?: "sm" | "md" | "lg";
}): React.JSX.Element | null {
	const boxRef = useRef<HTMLDivElement>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const pointerDownInside = useRef(false);

	/**
	 * `onClose` is read through a ref so the mount effect below can depend on
	 * `open` alone.
	 *
	 * Callers pass an inline arrow (`onClose={() => setOpen(false)}`), which is a
	 * new function identity on every render of the parent. With `onClose` in the
	 * dependency array, the app's 2s poll re-rendered the parent, the effect
	 * re-ran, and its initial `.focus()` yanked the caret back to the first field
	 * mid-typing — every two seconds.
	 */
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!open) return;

		restoreFocusRef.current = document.activeElement as HTMLElement | null;

		// Focus the first control, or the dialog itself when it has none. This runs
		// once per open, never on a re-render.
		const box = boxRef.current;
		const focusable = box?.querySelectorAll<HTMLElement>(
			'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
		);
		(focusable?.[0] ?? box)?.focus();

		const onKeyDown = (ev: KeyboardEvent): void => {
			if (ev.key === "Escape") {
				ev.stopPropagation();
				onCloseRef.current();
				return;
			}
			if (ev.key !== "Tab") return;

			// Trap Tab within the dialog.
			const items = boxRef.current?.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
			);
			if (!items || items.length === 0) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (!first || !last) return;

			if (ev.shiftKey && document.activeElement === first) {
				ev.preventDefault();
				last.focus();
			} else if (!ev.shiftKey && document.activeElement === last) {
				ev.preventDefault();
				first.focus();
			}
		};

		document.addEventListener("keydown", onKeyDown, true);
		// Stop the page behind the dialog from scrolling.
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.body.style.overflow = previousOverflow;
			restoreFocusRef.current?.focus?.();
		};
		// Only `open` belongs here — see the note on `onCloseRef` above.
	}, [open]);

	if (!open) return null;

	const titleId = "modal-title";
	const descId = description ? "modal-desc" : undefined;

	return (
		<div
			className={styles.backdrop}
			onPointerDown={(ev) => {
				pointerDownInside.current = boxRef.current?.contains(ev.target as Node) ?? false;
			}}
			onClick={(ev) => {
				// Only dismiss when the gesture started and ended on the backdrop.
				if (ev.target === ev.currentTarget && !pointerDownInside.current) onClose();
				pointerDownInside.current = false;
			}}
		>
			<div
				ref={boxRef}
				className={`${styles.box} ${styles[size]}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				{...(descId ? { "aria-describedby": descId } : {})}
				tabIndex={-1}
			>
				<div className={styles.header}>
					<h2 id={titleId} className={styles.title}>
						{title}
					</h2>
					<button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close dialog">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
							<path d="M18 6 6 18M6 6l12 12" />
						</svg>
					</button>
				</div>

				{description && (
					<p id={descId} className={styles.description}>
						{description}
					</p>
				)}

				{children && <div className={styles.body}>{children}</div>}
				{footer && <div className={styles.footer}>{footer}</div>}
			</div>
		</div>
	);
}
