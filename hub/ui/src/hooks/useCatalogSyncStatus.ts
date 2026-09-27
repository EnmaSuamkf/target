import { useSyncExternalStore } from "react";
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