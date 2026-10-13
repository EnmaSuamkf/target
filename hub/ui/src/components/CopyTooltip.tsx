import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../lib/copyText.ts";
import { tooltipPosition, type TooltipPlacement } from "../lib/tooltipPosition.ts";
import { useToast } from "./Toast.tsx";
import styles from "./CopyTooltip.module.css";

interface Props {
	/** Full, untruncated text to show and copy. Empty/null renders `children` alone. */
	value: string | null | undefined;
	/** What the label is called in the toast, e.g. "Workdir". */
	label?: string | undefined;
	mono?: boolean;
	children: React.ReactNode;
}

/** Time to travel from the trigger onto the tooltip without it closing. */
const CLOSE_DELAY_MS = 150;

/**
 * Hover/focus/tap tooltip that shows a value in full and offers Copy.
 *
 * Rendered in a portal with `position: fixed` because the fact values sit in
 * `overflow: hidden` cells that would clip an absolutely positioned child.
 */
export function CopyTooltip({ value, label, mono = false, children }: Props): React.JSX.Element {
	if (!value) return <>{children}</>;
	return (
		<Tip value={value} label={label} mono={mono}>
			{children}
		</Tip>
	);
}

function Tip({ value, label, mono, children }: Props & { value: string }): React.JSX.Element {
	const toast = useToast();
	const id = useId();
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
	const triggerRef = useRef<HTMLSpanElement>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pointerType = useRef("mouse");

	const cancelClose = useCallback(() => clearTimeout(closeTimer.current), []);
	const show = useCallback(() => {
		cancelClose();
		setOpen(true);
	}, [cancelClose]);
	const hide = useCallback(() => {
		cancelClose();
		setOpen(false);
		setPlacement(null);
	}, [cancelClose]);
	const hideSoon = useCallback(() => {
		cancelClose();
		closeTimer.current = setTimeout(hide, CLOSE_DELAY_MS);
	}, [cancelClose, hide]);

	useEffect(() => cancelClose, [cancelClose]);

	const reposition = useCallback(() => {
		const trigger = triggerRef.current;
		const tip = tipRef.current;
		if (!trigger || !tip) return;
		const r = trigger.getBoundingClientRect();
		setPlacement(
			tooltipPosition(
				{ top: r.top, left: r.left, width: r.width, height: r.height },
				{ width: tip.offsetWidth, height: tip.offsetHeight },
				{ width: window.innerWidth, height: window.innerHeight },
			),
		);
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		reposition();
		window.addEventListener("resize", reposition);
		// Capture: scrolling any ancestor moves the trigger.
		window.addEventListener("scroll", reposition, true);
		return () => {
			window.removeEventListener("resize", reposition);
			window.removeEventListener("scroll", reposition, true);
		};
	}, [open, value, reposition]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") hide();
		};
		// A tap elsewhere closes it; there is no mouseleave on touch.
		const onPointerDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (!triggerRef.current?.contains(t) && !tipRef.current?.contains(t)) hide();
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open, hide]);

	const onBlur = (e: React.FocusEvent) => {
		const next = e.relatedTarget as Node | null;
		if (next && (triggerRef.current?.contains(next) || tipRef.current?.contains(next))) return;
		hide();
	};

	const onCopy = () => {
		void copyText(value).then((ok) =>
			ok
				? toast.success(`${label ?? "Value"} copied.`)
				: toast.error("Could not copy — select the text and copy it by hand."),
		);
	};

	return (
		<>
			<span
				ref={triggerRef}
				className={`${styles.trigger}${mono ? " mono" : ""}`}
				tabIndex={0}
				aria-describedby={open ? id : undefined}
				onPointerEnter={(e) => {
					pointerType.current = e.pointerType;
					if (e.pointerType === "mouse") show();
				}}
				onPointerDown={(e) => {
					pointerType.current = e.pointerType;
				}}
				onPointerLeave={(e) => {
					if (e.pointerType === "mouse") hideSoon();
				}}
				// Tab focus only: a tap also focuses, and would fight the click toggle.
				onFocus={(e) => {
					if (e.currentTarget.matches(":focus-visible")) show();
				}}
				onBlur={onBlur}
				onClick={() => {
					if (pointerType.current !== "mouse") (open ? hide : show)();
				}}
			>
				{children}
			</span>
			{open &&
				createPortal(
					<div
						ref={tipRef}
						id={id}
						role="tooltip"
						className={styles.tooltip}
						style={{
							top: placement?.top ?? 0,
							left: placement?.left ?? 0,
							visibility: placement ? "visible" : "hidden",
						}}
						onPointerEnter={(e) => {
							if (e.pointerType === "mouse") show();
						}}
						onPointerLeave={(e) => {
							if (e.pointerType === "mouse") hideSoon();
						}}
						onBlur={onBlur}
					>
						<p className={`${styles.value}${mono ? " mono" : ""}`}>{value}</p>
						<button
							type="button"
							className={`btn btn--sm ${styles.copy}`}
							aria-label={`Copy ${label ?? "value"}`}
							onClick={onCopy}
						>
							Copy
						</button>
					</div>,
					document.body,
				)}
		</>
	);
}
