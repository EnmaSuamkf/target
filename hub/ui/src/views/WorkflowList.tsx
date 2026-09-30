import { useEffect, useMemo, useRef, useState } from "react";
import type { Workflow, WorkflowOrigin, WorkflowStatus } from "../api/types.ts";
import { ArchivedBadge, Badge, OriginBadge, ScheduleBadge } from "../components/Badge.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ProgressBar } from "../components/Progress.tsx";
import { usePermissions } from "../hooks/usePermissions.ts";
import { prettyPath, relativeTime } from "../lib/format.ts";
import {
	filterBySchedule,
	presentScheduleFilters,
	SCHEDULE_FILTER_LABELS,
	type ScheduleFilter,
} from "../lib/scheduleView.ts";
import {
	type ArchiveFilter,
	emptyListMessage,
	filterAndSort,
	isArchived,
	type OriginFilter,
	presentOrigins,
	presentStatuses,
	scopeByArchive,
	type StatusFilter as Filter,
} from "../lib/workflowFilter.ts";
import styles from "./WorkflowList.module.css";

/**
 * The workflows rail: a horizontal strip of cards across the TOP of the
 * workflows view, plus an "All workflows" control that opens the same set as a
 * scannable surface.
 *
 * It used to be a tall left sidebar that listed every workflow in one vertical
 * column — fine at a dozen, and the thing being complained about at sixty. The
 * list moved to the top so a row of cards reads left-to-right and the detail
 * pane gets the full width underneath it.
 *
 * "All workflows" opens a full **page** (`AllWorkflowsPage`, paginated twelve at
 * a time) on every screen — the only way to find one among sixty without
 * scrolling sideways for screen-widths. The page replaces the workflows view,
 * so it gets the whole content area and its own back button, and on a phone it
 * adapts to the narrow width (one card per row, a full-width search, the
 * pagination stacked) rather than being a separate bottom-sheet dialog.
 *
 * Sorting is unchanged: the work that needs you first (waiting on a manual
 * review), then active work (running, then paused), then everything else by
 * recency — so the workflow you're most likely to want is the leftmost card.
 *
 * Archived workflows are hidden from both surfaces by default; each surface's
 * "Archived" filter flips it to show ONLY them. The shell fetches the list with
 * `archived=include` and the narrowing happens here (see lib/workflowFilter.ts).
 */

/** How many cards the "All workflows" page shows per page. */
const PAGE_SIZE = 12;

/**
 * The narrowing state one surface owns (search, status, origin, archive side),
 * plus what it derives from it. The rail and the page each call this, so
 * narrowing one never silently narrows the other. Archived workflows are
 * hidden unless the surface's "Archived" filter is on, which shows ONLY them;
 * counts and the offered status/origin chips follow that scope.
 */
function useWorkflowFilters(workflows: Workflow[]) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
	const [archive, setArchiveState] = useState<ArchiveFilter>("active");
	const [scheduleFilter, setScheduleFilter] = useState<ScheduleFilter>("all");

	const scoped = useMemo(() => scopeByArchive(workflows, archive), [workflows, archive]);
	const archivedCount = useMemo(() => workflows.filter(isArchived).length, [workflows]);
	const visible = useMemo(
		() => filterBySchedule(filterAndSort(workflows, query, filter, originFilter, archive), scheduleFilter),
		[workflows, query, filter, originFilter, archive, scheduleFilter],
	);
	const statuses = useMemo(() => presentStatuses(scoped), [scoped]);
	const origins = useMemo(() => presentOrigins(scoped), [scoped]);
	const scheduleFilters = useMemo(() => presentScheduleFilters(scoped), [scoped]);

	// Switching sides of the archive changes which statuses exist (archived work
	// is only ever completed/failed), so a status chip picked on the other side
	// could strand the list on "No matches" with no chip left to clear it.
	const setArchive = (next: ArchiveFilter): void => {
		setArchiveState(next);
		setFilter("all");
	};

	return {
		query,
		setQuery,
		filter,
		setFilter,
		originFilter,
		setOriginFilter,
		scheduleFilter,
		setScheduleFilter,
		scheduleFilters,
		archive,
		setArchive,
		scoped,
		archivedCount,
		visible,
		statuses,
		origins,
	};
}

export function WorkflowList({
	workflows,
	selectedId,
	onSelect,
	onCreate,
	onShowAll,
	railResetKey,
}: {
	workflows: Workflow[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onCreate: () => void;
	/** Open the paginated "All workflows" page. Called from the "All workflows"
	 * button on every screen — the page adapts to a phone width itself, so
	 * there is no separate mobile picker. */
	onShowAll?: () => void;
	/** Bumped by the owner whenever a workflow has just been created; every
	 * change scrolls the rail fully back to the left so the newly created
	 * workflow is on screen instead of hidden behind however far the operator
	 * had scrolled sideways. */
	railResetKey?: number;
}): React.JSX.Element {
	// The rail's own search + status/origin/archive filters. Independent of the
	// "All workflows" page's state, so narrowing one doesn't silently narrow the other.
	const filters = useWorkflowFilters(workflows);
	const { visible, scoped, archive } = filters;
	const railRef = useRef<HTMLDivElement | null>(null);
	const { can } = usePermissions();
	const canCreate = can("client.workflows.create");
	const createTitle = canCreate ? undefined : "Requires client.workflows.create";

	const empty = emptyListMessage(workflows.length, scoped.length, archive);

	// A new workflow: put the rail back at its left edge. `scrollLeft` (not
	// `scrollIntoView`) on purpose — this must never move the *page*, which
	// stays at the top (see the App-level scroll reset).
	useEffect(() => {
		if (railResetKey === undefined) return;
		const rail = railRef.current;
		if (!rail) return;
		rail.scrollLeft = 0;
	}, [railResetKey]);

	return (
		<section className={styles.strip} aria-label="Workflows">
			<div className={styles.toolbar}>
				<h2 className={styles.heading}>
					{archive === "archived" ? "Archived" : "Workflows"}
					{scoped.length > 0 && <span className={styles.count}>{scoped.length}</span>}
				</h2>

				<div className={styles.toolbarTools}>
					{workflows.length > 0 && <FilterToolbar {...filters} />}

					{/* Classed so the phone can give it a row of its own: sharing the
					    line with the horizontally-scrolling status chips left the last
					    chip sliding under it (see `.newBtn` in the media query). */}
					<button
						type="button"
						className={`btn btn--primary btn--sm ${styles.newBtn}`}
						onClick={onCreate}
						disabled={!canCreate}
						title={createTitle}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
							<path d="M12 5v14M5 12h14" />
						</svg>
						New
					</button>

					{/* The rail is for quick access; this opens the SAME workflows as a
					    scannable surface — the full paginated "All workflows" page, on
					    every screen. The page adapts to a phone width itself, so there
					    is no separate mobile picker behind this button. */}
					{workflows.length > 0 && (
						<button
							type="button"
							className={`btn btn--sm ${styles.allBtn}`}
							onClick={() => onShowAll?.()}
							title="Browse every workflow in a grid."
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<rect x="3" y="3" width="7" height="7" rx="1.5" />
								<rect x="14" y="3" width="7" height="7" rx="1.5" />
								<rect x="3" y="14" width="7" height="7" rx="1.5" />
								<rect x="14" y="14" width="7" height="7" rx="1.5" />
							</svg>
							All workflows
						</button>
					)}
				</div>
			</div>

			{/* `data-workflow-list` is the keyboard-shortcut hook's anchor (Alt+W
			    focuses the first card in here, falling back to the search box), so it
			    stays on the scroll container that holds the cards. */}
			<div className={styles.rail} data-workflow-list data-workflow-rail ref={railRef}>
				{visible.length === 0 ? (
					<div className={styles.railEmpty}>
						{workflows.length === 0 ? (
							<EmptyState
								title="No workflows yet"
								description="A workflow creates its own agent and runs its steps in order on one shared session."
								action={
									<button
										type="button"
										className="btn btn--primary btn--sm"
										onClick={onCreate}
										disabled={!canCreate}
										title={createTitle}
									>
										Create your first workflow
									</button>
								}
							/>
						) : (
							empty && <EmptyState title={empty.title} description={empty.description} />
						)}
					</div>
				) : (
					visible.map((workflow) => (
						<WorkflowCard
							key={workflow.id}
							workflow={workflow}
							selected={workflow.id === selectedId}
							onSelect={onSelect}
						/>
					))
				)}
			</div>

		</section>
	);
}

/**
 * One workflow, as a card. Shared by the rail (a fixed-width tile in a
 * horizontal row), the mobile dialog and the desktop page (cells that fill
 * their column), so a workflow looks the same wherever you pick it.
 *
 * Richer than the old sidebar row: it carries the agent name and the workdir
 * too, because with sixty-odd completed workflows the name alone is rarely
 * enough to tell them apart — the directory is what you actually remember.
 * The progress bar is the headline: bigger and rounder than the thin global
 * bar, with the step count on the left and the percentage pulled out bold on
 * the right, so the card reads as a fill gauge at a glance.
 */
function WorkflowCard({
	workflow,
	selected,
	onSelect,
}: {
	workflow: Workflow;
	selected: boolean;
	onSelect: (id: string) => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			className={`${styles.card} ${selected ? styles.cardSelected : ""}`}
			onClick={() => onSelect(workflow.id)}
			aria-current={selected ? "true" : undefined}
			title={`${workflow.name} · ${workflow.id}`}
			data-workflow-card
		>
			<span className={styles.cardTop}>
				<span className={styles.cardName}>{workflow.name}</span>
				{/* Only the contained ones are marked: `host` is the default and
				    marking it everywhere would make the badge invisible on the
				    workflows where it actually says something. Marked here too: a
				    status somebody set by hand should be recognisable from the list,
				    not only after opening it. */}
				<span className={styles.cardBadges}>
					<OriginBadge origin={workflow.origin} />
					<ArchivedBadge archivedAt={workflow.archivedAt} />
					<Badge status={workflow.status} manual={workflow.statusManual} manualAt={workflow.statusManualAt} />
				</span>
			</span>

			{/* Its own line, not beside the status: "Scheduled · next in 14h" or
			    "Run of <series> · <occurrence>" is long enough that sharing the
			    title row squeezed the name down to a few letters. */}
			<span className={styles.cardSchedule}>
				<ScheduleBadge workflow={workflow} />
			</span>

			<ProgressBar progress={workflow.progress} running={workflow.status === "running"} />

			<span className={styles.cardMeta}>
				<span>
					{workflow.progress.done}/{workflow.progress.total} steps
				</span>
				{workflow.updatedAt && (
					<>
						<span className={styles.dot} aria-hidden="true">
							·
						</span>
						<span>{relativeTime(workflow.updatedAt)}</span>
					</>
				)}
				<span className={styles.cardPct}>{workflow.progress.pct}%</span>
			</span>

			<span className={styles.cardFoot}>
				<span className={styles.cardAgent} title={workflow.agentName}>
					{workflow.agentName}
				</span>
				{workflow.sandbox === "docker" && (
					<span className={styles.sandbox} title={`Steps run in a container (${workflow.image ?? "default image"})`}>
						docker
					</span>
				)}
			</span>

			{/* The directory is what distinguishes sixty completed workflows from
			    each other; show it muted and truncated rather than not at all. */}
			<span className={styles.cardPath} title={workflow.workdir ?? undefined}>
				{prettyPath(workflow.workdir) || "—"}
			</span>
		</button>
	);
}

/** The shared search + archive/origin/schedule/status-filter toolbar, used by the rail and the page. */
function FilterToolbar({
	query,
	setQuery,
	filter,
	setFilter,
	originFilter,
	setOriginFilter,
	scheduleFilter,
	setScheduleFilter,
	scheduleFilters,
	archive,
	setArchive,
	archivedCount,
	statuses,
	origins,
	autoFocus,
}: {
	query: string;
	setQuery: (q: string) => void;
	filter: Filter;
	setFilter: (f: Filter) => void;
	originFilter: OriginFilter;
	setOriginFilter: (f: OriginFilter) => void;
	scheduleFilter: ScheduleFilter;
	setScheduleFilter: (f: ScheduleFilter) => void;
	/** Which schedule filters would match something on this side of the archive. */
	scheduleFilters: Exclude<ScheduleFilter, "all">[];
	archive: ArchiveFilter;
	setArchive: (a: ArchiveFilter) => void;
	/** How many archived workflows exist — the Archived toggle only appears when there are some (or it's on). */
	archivedCount: number;
	statuses: WorkflowStatus[];
	origins: WorkflowOrigin[];
	autoFocus?: boolean;
}): React.JSX.Element {
	return (
		<>
			<div className={styles.search}>
				<svg className={styles.searchIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
					<circle cx="11" cy="11" r="7" />
					<path d="m20 20-3.5-3.5" />
				</svg>
				<input
					type="search"
					className={styles.searchInput}
					placeholder="Search workflows…"
					value={query}
					onChange={(ev) => setQuery(ev.target.value)}
					aria-label="Search workflows by name or agent"
					autoFocus={autoFocus}
					data-workflow-search
				/>
			</div>

			{/* Archived workflows are hidden by default; this flips the surface to
			    show ONLY them. Offered once something is archived — or while it's on,
			    so the way back never disappears (e.g. after unarchiving the last one). */}
			{(archivedCount > 0 || archive === "archived") && (
				<div className={styles.filters} role="group" aria-label="Filter by archive state" data-archive-filter>
					<button
						type="button"
						className={`${styles.filter} ${archive === "active" ? styles.filterActive : ""}`}
						onClick={() => setArchive("active")}
						aria-pressed={archive === "active"}
					>
						Active
					</button>
					<button
						type="button"
						className={`${styles.filter} ${archive === "archived" ? styles.filterActive : ""}`}
						onClick={() => setArchive("archived")}
						aria-pressed={archive === "archived"}
						title="Show only archived workflows"
					>
						Archived
					</button>
				</div>
			)}

			{origins.length > 1 && (
				<div className={styles.filters} role="group" aria-label="Filter by origin">
					<button
						type="button"
						className={`${styles.filter} ${originFilter === "all" ? styles.filterActive : ""}`}
						onClick={() => setOriginFilter("all")}
						aria-pressed={originFilter === "all"}
					>
						All origins
					</button>
					{origins.map((origin) => (
						<button
							key={origin}
							type="button"
							className={`${styles.filter} ${originFilter === origin ? styles.filterActive : ""}`}
							onClick={() => setOriginFilter(origin)}
							aria-pressed={originFilter === origin}
						>
							{origin === "remote" ? "Remote" : "Local"}
						</button>
					))}
				</div>
			)}

			{/* Same pattern as origin. Offered once any schedule exists on this side
			    of the archive — or while one is picked, so the way back to "All"
			    never disappears (e.g. after cancelling the last schedule). */}
			{(scheduleFilters.length > 0 || scheduleFilter !== "all") && (
				<div className={styles.filters} role="group" aria-label="Filter by schedule" data-schedule-filter>
					<button
						type="button"
						className={`${styles.filter} ${scheduleFilter === "all" ? styles.filterActive : ""}`}
						onClick={() => setScheduleFilter("all")}
						aria-pressed={scheduleFilter === "all"}
					>
						All
					</button>
					{(["scheduled", "runs"] as const)
						.filter((f) => scheduleFilters.includes(f) || scheduleFilter === f)
						.map((f) => (
							<button
								key={f}
								type="button"
								className={`${styles.filter} ${scheduleFilter === f ? styles.filterActive : ""}`}
								onClick={() => setScheduleFilter(f)}
								aria-pressed={scheduleFilter === f}
								title={
									f === "scheduled"
										? "Each schedule once, by its next run"
										: "Runs that schedules have already executed"
								}
							>
								{SCHEDULE_FILTER_LABELS[f]}
							</button>
						))}
				</div>
			)}

			{statuses.length > 1 && (
				<div className={styles.filters} role="group" aria-label="Filter by status">
					<button
						type="button"
						className={`${styles.filter} ${filter === "all" ? styles.filterActive : ""}`}
						onClick={() => setFilter("all")}
						aria-pressed={filter === "all"}
					>
						All statuses
					</button>
					{statuses.map((status) => (
						<button
							key={status}
							type="button"
							className={`${styles.filter} ${filter === status ? styles.filterActive : ""}`}
							onClick={() => setFilter(status)}
							aria-pressed={filter === status}
						>
							{status}
						</button>
					))}
				</div>
			)}
		</>
	);
}

/**
 * The page numbers to offer for a given `current`/`total`, with ellipses where
 * a run is skipped: always the first and last, plus a three-wide window around
 * the current page. `total <= 7` is short enough to just list every page.
 */
function pageWindow(current: number, total: number): (number | "…")[] {
	if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
	const out: (number | "…")[] = [1];
	const start = Math.max(2, current - 1);
	const end = Math.min(total - 1, current + 1);
	if (start > 2) out.push("…");
	for (let i = start; i <= end; i++) out.push(i);
	if (end < total - 1) out.push("…");
	out.push(total);
	return out;
}

/**
 * The "All workflows" page: the same scannable grid as the rail, but as a full
 * page that paginates twelve cards at a time — the answer to "I have sixty-plus
 * and need to find one", because a single grid of sixty is a wall and a
 * horizontal rail of sixty is screen-widths of sideways scrolling. Its own
 * search and status filter narrow before pagination, so a filter that leaves
 * twenty results is two pages, not one page of twelve plus a clipped remainder.
 * Picking a card selects that workflow and returns to the workflows view (the
 * rail + the detail). On a phone the grid is one card per row and the toolbar
 * and pagination stack to the narrow width (see the media query).
 */
export function AllWorkflowsPage({
	workflows,
	selectedId,
	onSelect,
	onBack,
}: {
	workflows: Workflow[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onBack: () => void;
}): React.JSX.Element {
	const filters = useWorkflowFilters(workflows);
	const { query, filter, originFilter, archive, scheduleFilter, scoped, visible } = filters;
	const [page, setPage] = useState(1);
	const empty = emptyListMessage(workflows.length, scoped.length, archive);

	const total = visible.length;
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	// A filter that shrinks the list below the current page would otherwise land
	// on an empty page; clamp into range. `Math.min` first so a page beyond the
	// new end drops back, and the lower bound covers the no-results case.
	const safePage = Math.min(Math.max(1, page), totalPages);
	const start = (safePage - 1) * PAGE_SIZE;
	const pageItems = visible.slice(start, start + PAGE_SIZE);
	const end = Math.min(start + PAGE_SIZE, total);

	// Reset to the first page whenever the narrowing changes — page 3 of a
	// search you've just retyped is never the page you want.
	useEffect(() => {
		setPage(1);
	}, [query, filter, originFilter, archive, scheduleFilter]);

	return (
		<section className={styles.page} aria-label="All workflows">
			<div className={styles.pageHeader}>
				<button type="button" className="btn btn--ghost btn--sm" onClick={onBack} title="Back to workflows">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M19 12H5M12 19l-7-7 7-7" />
					</svg>
					Back
				</button>
				<h2 className={styles.pageTitle}>
					{archive === "archived" ? "Archived workflows" : "All workflows"}
					{scoped.length > 0 && <span className={styles.count}>{scoped.length}</span>}
				</h2>
				<span className={styles.pageSpacer} />
			</div>

			{workflows.length > 0 && (
				<div className={styles.pageToolbar}>
					<FilterToolbar {...filters} autoFocus />
				</div>
			)}

			<div className={styles.pageBody}>
				{pageItems.length === 0 ? (
					<div className={styles.pageEmpty}>
						<EmptyState
							title={empty?.title ?? "No workflows yet"}
							description={empty?.description ?? "Create a workflow from the Workflows view to see it here."}
						/>
					</div>
				) : (
					<div className={styles.pageGrid} data-workflow-list>
						{pageItems.map((workflow) => (
							<WorkflowCard
								key={workflow.id}
								workflow={workflow}
								selected={workflow.id === selectedId}
								onSelect={onSelect}
							/>
						))}
					</div>
				)}
			</div>

			{total > 0 && (
				<div className={styles.pagination}>
					<span className={styles.pageInfo}>
						Showing {start + 1}–{end} of {total}
					</span>
					<nav className={styles.pageNav} aria-label="Pagination">
						<button
							type="button"
							className={styles.pageBtn}
							onClick={() => setPage(safePage - 1)}
							disabled={safePage <= 1}
							aria-label="Previous page"
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M15 18l-6-6 6-6" />
							</svg>
						</button>
						{pageWindow(safePage, totalPages).map((item, idx) =>
							item === "…" ? (
								<span key={`gap-${idx}`} className={styles.pageEllipsis} aria-hidden="true">
									…
								</span>
							) : (
								<button
									key={item}
									type="button"
									className={`${styles.pageBtn} ${item === safePage ? styles.pageBtnActive : ""}`}
									onClick={() => setPage(item)}
									aria-current={item === safePage ? "page" : undefined}
									aria-label={`Page ${item}`}
								>
									{item}
								</button>
							),
						)}
						<button
							type="button"
							className={styles.pageBtn}
							onClick={() => setPage(safePage + 1)}
							disabled={safePage >= totalPages}
							aria-label="Next page"
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M9 18l6-6-6-6" />
							</svg>
						</button>
					</nav>
				</div>
			)}
		</section>
	);
}
