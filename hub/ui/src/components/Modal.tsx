import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "../hooks/useIsMobile.ts";
import { lockBodyScroll } from "../lib/bodyScroll.ts";
import styles from "./Modal.module.css";

/**
 * Accessible modal dialog: focus moves in on open and returns to the trigger on
 * close, Escape dismisses, Tab is trapped inside, and the backdrop closes on a
 * click that both starts and ends outside the box (so a drag that began inside
 * the dialog doesn't dismiss it).
 *
 * The previous UI used `alert()`/`confirm()` and one hand-rolled backdrop; this
 * replaces both so destructive actions and forms share one surface.
 *
 * On a phone the same dialog renders as a **bottom sheet** (see the media query
 * in Modal.module.css): full width, anchored to the bottom edge where the thumb
 * is, its content scrolling inside itself instead of spilling off-screen. A
 * centred box the size of a phone screen is the worst of both worlds — too
 * small to be a page, too big to be a dialog — so the sheet is the one shape
 * that stays reachable. It can be dismissed three ways: the header's close
 * button, a tap on the backdrop above it, and a downward drag on its header
 * (the grabber). The desktop appearance is untouched.
 */

/** How far the sheet has to be dragged down before letting go dismisses it. */
const DISMISS_DISTANCE_PX = 110;

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
	const isMobile = useIsMobile();

	// Live offset of the sheet while it's being dragged down, in px. `null` means
	// "not dragging", which is also what tells the box to animate back into place
	// rather than track the finger.
	const [dragY, setDragY] = useState<number | null>(null);
	const dragStart = useRef<{ pointerId: number; y: number } | null>(null);

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
		// Stop the page behind the dialog from scrolling. Pinning the body (rather
		// than just hiding its overflow) is what keeps a bottom sheet from handing
		// its scroll off to the document underneath on iOS.
		const unlockBodyScroll = lockBodyScroll();

		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			unlockBodyScroll();
			restoreFocusRef.current?.focus?.();
		};
		// Only `open` belongs here — see the note on `onCloseRef` above.
	}, [open]);

	// A sheet left mid-drag when it closes must not reopen already displaced.
	useEffect(() => {
		if (!open) {
			dragStart.current = null;
			setDragY(null);
		}
	}, [open]);

	if (!open) return null;

	const titleId = "modal-title";
	const descId = description ? "modal-desc" : undefined;

	/**
	 * Drag-to-dismiss, bound to the header only. Keeping it off the body is what
	 * makes it safe: the two gestures never compete, so a scroll inside the sheet
	 * is always a scroll and a pull on the grabber is always a dismiss.
	 */
	const dragHandlers = isMobile
		? {
				onPointerDown: (ev: React.PointerEvent<HTMLDivElement>) => {
					if (ev.pointerType === "mouse") return;
					// Never from the close button: capturing the pointer would retarget
					// the click that follows to this header, and the button would stop
					// closing anything.
					if ((ev.target as HTMLElement).closest("button")) return;
					dragStart.current = { pointerId: ev.pointerId, y: ev.clientY };
					// Without capture the move/up events stop arriving the moment the
					// finger leaves the header — which a downward drag does immediately.
					ev.currentTarget.setPointerCapture(ev.pointerId);
				},
				onPointerMove: (ev: React.PointerEvent<HTMLDivElement>) => {
					const start = dragStart.current;
					if (!start || start.pointerId !== ev.pointerId) return;
					// Downward only — an upward pull has nowhere to go.
					setDragY(Math.max(0, ev.clientY - start.y));
				},
				onPointerUp: (ev: React.PointerEvent<HTMLDivElement>) => {
					const start = dragStart.current;
					if (!start || start.pointerId !== ev.pointerId) return;
					dragStart.current = null;
					const travelled = ev.clientY - start.y;
					setDragY(null);
					if (travelled > DISMISS_DISTANCE_PX) onClose();
				},
				onPointerCancel: () => {
					dragStart.current = null;
					setDragY(null);
				},
			}
		: {};

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
				className={`${styles.box} ${styles[size]} ${dragY === null ? "" : styles.dragging}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				{...(descId ? { "aria-describedby": descId } : {})}
				tabIndex={-1}
				{...(dragY === null ? {} : { style: { transform: `translateY(${dragY}px)` } })}
			>
				<div className={styles.header} {...dragHandlers}>
					{/* Sheet grabber: the thing a thumb reaches for first on a phone, and
					    invisible on desktop where the dialog isn't draggable. */}
					<span className={styles.grabber} aria-hidden="true" />
					<h2 id={titleId} className={styles.title}>
						{title}
					</h2>
					<button
						type="button"
						className={`btn btn--ghost btn--sm ${styles.close}`}
						onClick={onClose}
						aria-label="Close dialog"
					>
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
