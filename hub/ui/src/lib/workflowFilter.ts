import type { Workflow, WorkflowOrigin, WorkflowStatus } from "../api/types.ts";

/**
 * Narrowing and ordering for the workflow surfaces (the rail and the "All
 * workflows" page), kept free of React and CSS so the hub test suite can
 * import it directly.
 */

// `waiting` sorts above even `running`: it's the only status that can't move
// until the operator does something, so it's what they need to find first.
export const STATUS_ORDER: Record<WorkflowStatus, number> = {
	waiting: 0,
	running: 1,
	paused: 2,
	draft: 3,
	failed: 4,
	completed: 5,
};

export type StatusFilter = "all" | WorkflowStatus;
export type OriginFilter = "all" | WorkflowOrigin;
/**
 * Which side of the archive a surface shows. `active` (the default) hides
 * archived workflows; `archived` shows ONLY them. There is deliberately no
 * "both": archived work is filed away, and mixing it back into the working
 * list is exactly what archiving is meant to stop.
 */
export type ArchiveFilter = "active" | "archived";

export function isArchived(workflow: Pick<Workflow, "archivedAt">): boolean {
	return Boolean(workflow.archivedAt);
}

/** Only finished work can be archived — mirrors the hub's `not_archivable` rule. */
export function isArchivable(workflow: Pick<Workflow, "status">): boolean {
	return workflow.status === "completed" || workflow.status === "failed";
}

/** The workflows on the requested side of the archive. */
export function scopeByArchive<W extends Pick<Workflow, "archivedAt">>(workflows: W[], archive: ArchiveFilter): W[] {
	return workflows.filter((w) => (archive === "archived" ? isArchived(w) : !isArchived(w)));
}

/**
 * Narrows and orders the workflows the same way in every surface, so a search
 * typed in any one ranks identically. The archive scope applies first: with
 * the default `active`, archived workflows never appear.
 */
export function filterAndSort(
	workflows: Workflow[],
	query: string,
	filter: StatusFilter,
	originFilter: OriginFilter,
	archive: ArchiveFilter = "active",
): Workflow[] {
	const q = query.trim().toLowerCase();
	return scopeByArchive(workflows, archive)
		.filter((w) => (filter === "all" ? true : w.status === filter))
		.filter((w) => (originFilter === "all" ? true : w.origin === originFilter))
		.filter((w) => (q === "" ? true : w.name.toLowerCase().includes(q) || w.agentName.toLowerCase().includes(q)))
		.sort((a, b) => {
			const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
			if (byStatus !== 0) return byStatus;
			return b.updatedAt.localeCompare(a.updatedAt);
		});
}

/** Only offer filters that would actually match something. */
export function presentStatuses(workflows: Workflow[]): WorkflowStatus[] {
	const present = new Set(workflows.map((w) => w.status));
	return (Object.keys(STATUS_ORDER) as WorkflowStatus[])
		.filter((s) => present.has(s))
		.sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b]);
}

export function presentOrigins(workflows: Workflow[]): WorkflowOrigin[] {
	const present = new Set(workflows.map((w) => w.origin));
	return (["local", "remote"] as WorkflowOrigin[]).filter((o) => present.has(o));
}

/** Title + description for an empty surface, so the rail and the page say the same thing. */
export function emptyListMessage(
	totalCount: number,
	scopedCount: number,
	archive: ArchiveFilter,
): { title: string; description: string } | null {
	if (totalCount === 0) return null; // the "no workflows yet" case each surface renders itself
	if (scopedCount === 0 && archive === "archived") {
		return {
			title: "No archived workflows",
			description: "Completed or failed workflows you archive (or that auto-archive) show up here.",
		};
	}
	if (scopedCount === 0) {
		return {
			title: "No active workflows",
			description: "Every workflow is archived. Switch to Archived to see them, or create a new one.",
		};
	}
	return { title: "No matches", description: "Try a different search or clear the status filter." };
}
