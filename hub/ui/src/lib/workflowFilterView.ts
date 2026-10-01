import type { WorkflowStatus, Workflow } from "../api/types.ts";
import type { ScheduleFilter } from "./scheduleView.ts";
import {
	type ArchiveFilter,
	filterAndSort,
	type OriginFilter,
	STATUS_ORDER,
	type StatusFilter,
} from "./workflowFilter.ts";

/**
 * View-model helpers for the filter toolbar: option counts, the applied-filter
 * list and the "is this the default?" rules. Pure and free of React/CSS so the
 * hub test suite imports them directly. They only CALL `filterAndSort` — the
 * filtering behavior itself lives in workflowFilter.ts / scheduleView.ts.
 */

export interface WorkflowFilterState {
	query: string;
	status: StatusFilter;
	origin: OriginFilter;
	archive: ArchiveFilter;
	schedule: ScheduleFilter;
}

/** Nothing applied: the bar reads as unfiltered. */
export const DEFAULT_FILTER_STATE: WorkflowFilterState = {
	query: "",
	status: "all",
	origin: "all",
	archive: "active",
	schedule: "all",
};

/** The labels the toolbar, the popover and the "Showing:" chips all share. */
export const FILTER_COPY = {
	show: { title: "Show", open: "Open", archived: "Archived" },
	created: { title: "Created", all: "Anywhere", local: "Local", remote: "Remote" },
	scheduling: { title: "Scheduling", all: "Any", scheduled: "Upcoming runs", runs: "Past runs" },
	statusAll: "All",
} as const;

export interface FilterOptionCounts {
	/** Per status (and `all`): workflows matching every OTHER filter. */
	status: Record<StatusFilter, number>;
	archive: Record<ArchiveFilter, number>;
	origin: Record<OriginFilter, number>;
	schedule: Record<ScheduleFilter, number>;
}

/**
 * Faceted counts: the number on an option is what the list would show if it
 * were picked, so each dimension is counted with every OTHER active filter
 * applied (search included) and its own value ignored.
 *
 * One deliberate exception: the archive counts ignore the status filter,
 * because switching archive side resets status (see `setArchive`), so a
 * status-scoped number would not match the list the click produces.
 */
export function countFilterOptions(workflows: Workflow[], state: WorkflowFilterState): FilterOptionCounts {
	const { query, status, origin, archive, schedule } = state;
	const count = (s: StatusFilter, o: OriginFilter, a: ArchiveFilter, sch: ScheduleFilter): number =>
		filterAndSort(workflows, query, s, o, a, sch).length;

	const byStatus = {} as Record<StatusFilter, number>;
	const base = filterAndSort(workflows, query, "all", origin, archive, schedule);
	byStatus.all = base.length;
	for (const s of Object.keys(STATUS_ORDER) as WorkflowStatus[]) {
		byStatus[s] = base.filter((w) => w.status === s).length;
	}

	return {
		status: byStatus,
		archive: {
			active: count("all", origin, "active", schedule),
			archived: count("all", origin, "archived", schedule),
		},
		origin: {
			all: count(status, "all", archive, schedule),
			local: count(status, "local", archive, schedule),
			remote: count(status, "remote", archive, schedule),
		},
		schedule: {
			all: count(status, origin, archive, "all"),
			scheduled: count(status, origin, archive, "scheduled"),
			runs: count(status, origin, archive, "runs"),
		},
	};
}

export type AppliedFilterKey = "query" | "status" | "origin" | "archive" | "schedule";

export interface AppliedFilter {
	key: AppliedFilterKey;
	label: string;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One entry per non-default filter, in the order the chips are shown. */
export function appliedFilters(state: WorkflowFilterState): AppliedFilter[] {
	const out: AppliedFilter[] = [];
	const q = state.query.trim();
	if (q !== "") out.push({ key: "query", label: `“${q}”` });
	if (state.status !== "all") out.push({ key: "status", label: titleCase(state.status) });
	if (state.archive !== "active") out.push({ key: "archive", label: FILTER_COPY.show.archived });
	if (state.origin !== "all") {
		out.push({ key: "origin", label: state.origin === "remote" ? FILTER_COPY.created.remote : FILTER_COPY.created.local });
	}
	if (state.schedule !== "all") {
		out.push({
			key: "schedule",
			label: state.schedule === "scheduled" ? FILTER_COPY.scheduling.scheduled : FILTER_COPY.scheduling.runs,
		});
	}
	return out;
}

/**
 * The number on the "Filters" button: how many non-default filters the popover
 * owns. Search never counts (it is visible in the bar itself). Status counts
 * only where the status tabs live inside the popover (the compact rail).
 */
export function filtersButtonCount(state: WorkflowFilterState, opts: { includeStatus: boolean }): number {
	let n = 0;
	if (state.archive !== "active") n++;
	if (state.origin !== "all") n++;
	if (state.schedule !== "all") n++;
	if (opts.includeStatus && state.status !== "all") n++;
	return n;
}

/** The state after removing one chip (status keeps no memory, the rest return to default). */
export function withoutFilter(state: WorkflowFilterState, key: AppliedFilterKey): WorkflowFilterState {
	return { ...state, [key]: DEFAULT_FILTER_STATE[key] };
}
