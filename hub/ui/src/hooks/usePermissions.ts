import { useCallback, useSyncExternalStore } from "react";
import type { DeviceLinkState, PermissionCatalogGroup, PermissionsMode, PermissionsState } from "../api/types.ts";

/**
 * Linked-owner role as reactive state.
 *
 * App.tsx writes the latest GET /api/permissions payload into this store on
 * the existing 2s poll. Components subscribe the same way `useAdminToken`
 * does — no extra timer, no context provider.
 */

export type PermissionReason =
	| "not_linked"
	| "stale"
	| "no_owner"
	| "relink_required"
	| "awaiting_authorization";

const listeners = new Set<() => void>();

let snapshot: PermissionsState | null = null;
let origin: string | null = null;

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function setPermissionsSnapshot(next: PermissionsState, nextOrigin?: string | null): void {
	snapshot = next;
	if (nextOrigin !== undefined) origin = nextOrigin;
	emit();
}

export function getPermissionsOrigin(): string | null {
	return origin;
}

/** Tooltip on a disabled control — names the missing permission(s). */
export function requires(...ids: string[]): string {
	return ids.length === 1 ? `Requiere ${ids[0]}` : `Requiere ${ids.join(" o ")}`;
}

function getSnapshot(): PermissionsState | null {
	return snapshot;
}

function deriveReason(state: PermissionsState | null): PermissionReason | null {
	if (!state || state.mode === "unrestricted") return state ? "not_linked" : null;
	if (state.mode === "enforced") return null;
	if (state.linkState === "relink_required") return "relink_required";
	if (state.linkState === "awaiting_authorization") return "awaiting_authorization";
	if (!state.ownerId) return "no_owner";
	return "stale";
}

export function usePermissions(): {
	mode: PermissionsMode;
	can: (...ids: string[]) => boolean;
	readOnly: boolean;
	reason: PermissionReason | null;
	granted: { groups: PermissionCatalogGroup[] };
	origin: string | null;
	ownerId: string | null;
	linkState: DeviceLinkState;
	receivedAt: string | null;
} {
	const state = useSyncExternalStore(subscribe, getSnapshot, () => null);
	const mode: PermissionsMode = state?.mode ?? "unrestricted";

	const can = useCallback(
		(...ids: string[]): boolean => {
			const current = snapshot;
			const currentMode = current?.mode ?? "unrestricted";
			if (currentMode === "unrestricted") return true;
			if (currentMode !== "enforced") return false;
			return ids.some((id) => current?.permissions.includes(id) === true);
		},
		[state],
	);

	const readOnly = mode === "read_only" || (mode === "enforced" && (state?.permissions.length ?? 0) === 0);

	return {
		mode,
		can,
		readOnly,
		reason: deriveReason(state),
		granted: state?.granted ?? { groups: [] },
		origin,
		ownerId: state?.ownerId ?? null,
		linkState: state?.linkState ?? "local_unconfigured",
		receivedAt: state?.receivedAt ?? null,
	};
}
