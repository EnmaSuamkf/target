import { useCallback, useSyncExternalStore } from "react";
import { getAdminToken, setAdminToken } from "../api/client.ts";

/**
 * The admin token as reactive state.
 *
 * It lives in localStorage (`targetAdminToken`) because the hub prints it once
 * at startup and the operator shouldn't have to paste it on every action. The
 * subscription makes every component that shows token state re-render when it
 * changes — including from another tab, via the `storage` event.
 */

const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	// `storage` only fires for *other* tabs, which is exactly the case a
	// same-tab setter can't cover.
	window.addEventListener("storage", emit);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) window.removeEventListener("storage", emit);
	};
}

export function useAdminToken(): { token: string; hasToken: boolean; saveToken: (value: string) => void } {
	const token = useSyncExternalStore(subscribe, getAdminToken, () => "");

	const saveToken = useCallback((value: string) => {
		setAdminToken(value);
		emit();
	}, []);

	return { token, hasToken: token !== "", saveToken };
}
