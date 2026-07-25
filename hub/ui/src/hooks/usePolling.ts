import { useEffect, useRef } from "react";

/**
 * Runs `callback` on an interval, with two behaviours the naive
 * `setInterval(fn, ms)` in an effect doesn't give you:
 *
 * - **No overlap.** The next tick is scheduled only after the current one
 *   settles, so a slow request can't pile up behind itself.
 * - **Pauses when hidden.** A background tab stops polling and refreshes
 *   immediately when it becomes visible again — this is a local tool that
 *   polls every 2s, and there's no reason to keep hitting the hub while
 *   nobody's looking.
 *
 * `callback` is kept in a ref so callers don't have to memoise it to avoid
 * restarting the timer on every render.
 */
export function usePolling(callback: () => void | Promise<void>, intervalMs: number, enabled = true): void {
	const savedCallback = useRef(callback);
	savedCallback.current = callback;

	useEffect(() => {
		if (!enabled) return;

		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const tick = async (): Promise<void> => {
			if (cancelled) return;
			// Skip the work while hidden, but keep the loop alive so it resumes
			// on its own even if the visibility event is missed.
			if (document.visibilityState === "visible") {
				try {
					await savedCallback.current();
				} catch {
					// Transient failures are the poll's normal condition (hub
					// restarting, request aborted); the next tick retries.
				}
			}
			if (cancelled) return;
			timer = setTimeout(() => void tick(), intervalMs);
		};

		const onVisibility = (): void => {
			if (document.visibilityState !== "visible" || cancelled) return;
			// Became visible: refresh now instead of waiting out the interval.
			clearTimeout(timer);
			void tick();
		};

		timer = setTimeout(() => void tick(), intervalMs);
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			cancelled = true;
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [intervalMs, enabled]);
}
