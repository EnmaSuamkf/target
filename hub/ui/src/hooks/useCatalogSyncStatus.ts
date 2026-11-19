import { useSyncExternalStore } from "react";
import { ApiError, getCatalogSyncStatus } from "../api/client.ts";
import type { CatalogSyncStatus } from "../api/types.ts";

/**
 * Last catalog pull, written by App.tsx on the existing 2s permissions tick.
 * Settings reads it — no extra timer.
 */

const listeners = new Set<() => void>();

let snapshot: CatalogSyncStatus | null = null;

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function setCatalogSyncStatusSnapshot(next: CatalogSyncStatus | null): void {
	snapshot = next;
	emit();
}

export function useCatalogSyncStatus(): CatalogSyncStatus | null {
	return useSyncExternalStore(subscribe, () => snapshot, () => null);
}

/**
 * One tick of the catalog-status poll (App.tsx, on the permissions interval).
 * A 401 means the operator isn't signed in. That is an empty snapshot: it
 * does not throw, and `getCatalogSyncStatus` does not report the session lost.
 * Any other failure also leaves the last screen quiet and retries next tick.
 */
export async function pollCatalogSyncStatus(): Promise<void> {
	try {
		setCatalogSyncStatusSnapshot(await getCatalogSyncStatus());
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			setCatalogSyncStatusSnapshot(null);
			return;
		}
		setCatalogSyncStatusSnapshot(null);
	}
}