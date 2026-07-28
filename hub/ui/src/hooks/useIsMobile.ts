import { useSyncExternalStore } from "react";

/**
 * "Is this a phone-sized screen?", as one shared answer.
 *
 * The app is one responsive UI, not two builds: almost everything that changes
 * on a small screen is CSS. This hook exists for the handful of places where a
 * media query genuinely can't express the difference — a master/detail pair
 * that becomes two separate screens with a back button, or a tab bar that moves
 * from the header to the bottom of the viewport with different markup. Those
 * are structural, so they branch in React; everything else stays in CSS.
 *
 * {@link MOBILE_QUERY} is the single source of truth for the breakpoint and is
 * mirrored by the `@media (max-width: 768px)` blocks throughout the stylesheets.
 * Change one, change the other.
 */
export const MOBILE_QUERY = "(max-width: 768px)";

const mediaQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(MOBILE_QUERY) : null;

function subscribe(onStoreChange: () => void): () => void {
	mediaQuery?.addEventListener("change", onStoreChange);
	return () => mediaQuery?.removeEventListener("change", onStoreChange);
}

function getSnapshot(): boolean {
	return mediaQuery?.matches ?? false;
}

export function useIsMobile(): boolean {
	// The subscription reads the live MediaQueryList rather than mirroring it in
	// state, so a rotation or a resized devtools viewport can never leave the
	// tree rendering the layout for the previous width.
	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
