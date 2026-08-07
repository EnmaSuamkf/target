import { useEffect, useMemo, useRef, useState } from "react";
import type { Workflow, WorkflowStatus } from "../api/types.ts";
import { Badge } from "../components/Badge.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ProgressBar } from "../components/Progress.tsx";
import { prettyPath, relativeTime } from "../lib/format.ts";
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
 */

// `waiting` sorts above even `running`: it's the only status that can't move
// until the operator does something, so it's what they need to find first.
const STATUS_ORDER: Record<WorkflowStatus, number> = {
	waiting: 0,
	running: 1,
	paused: 2,
	draft: 3,
	failed: 4,
	completed: 5,
};

type Filter = "all" | WorkflowStatus;

/** How many cards the "All workflows" page shows per page. */
const PAGE_SIZE = 12;

/**
 * Narrows and orders the workflows the same way in every surface — the rail,
 * the mobile dialog and the desktop page — so a search typed in any one ranks
 * identically. Kept as a plain function (not a hook) so each surface can call
 * it in its own `useMemo` without sharing state.
 */
function filterAndSort(workflows: Workflow[], query: string, filter: Filter): Workflow[] {
	const q = query.trim().toLowerCase();
	return workflows
		.filter((w) => (filter === "all" ? true : w.status === filter))
		.filter((w) => (q === "" ? true : w.name.toLowerCase().includes(q) || w.agentName.toLowerCase().includes(q)))
		.sort((a, b) => {
			const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
			if (byStatus !== 0) return byStatus;
			return b.updatedAt.localeCompare(a.updatedAt);
		});
}

/** Only offer filters that would actually match something. */
function presentStatuses(workflows: Workflow[]): WorkflowStatus[] {
	const present = new Set(workflows.map((w) => w.status));
	return (Object.keys(STATUS_ORDER) as WorkflowStatus[])
		.filter((s) => present.has(s))
		.sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b]);
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
	// The rail's own search + status filter. Independent of the "All workflows"
	// surfaces' state, so narrowing one doesn't silently narrow the other.
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const railRef = useRef<HTMLDivElement | null>(null);

	const visible = useMemo(() => filterAndSort(workflows, query, filter), [workflows, query, filter]);
	const statuses = useMemo(() => presentStatuses(workflows), [workflows]);

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
					Workflows
					{workflows.length > 0 && <span className={styles.count}>{workflows.length}</span>}
				</h2>

				<div className={styles.toolbarTools}>
					{workflows.length > 0 && (
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
									data-workflow-search
								/>
							</div>

							{statuses.length > 1 && (
								<div className={styles.filters} role="group" aria-label="Filter by status">
									<button
										type="button"
										className={`${styles.filter} ${filter === "all" ? styles.filterActive : ""}`}
										onClick={() => setFilter("all")}
										aria-pressed={filter === "all"}
									>
										All
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
					)}

					{/* Classed so the phone can give it a row of its own: sharing the
					    line with the horizontally-scrolling status chips left the last
					    chip sliding under it (see `.newBtn` in the media query). */}
					<button type="button" className={`btn btn--primary btn--sm ${styles.newBtn}`} onClick={onCreate}>
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
									<button type="button" className="btn btn--primary btn--sm" onClick={onCreate}>
										Create your first workflow
									</button>
								}
							/>
						) : (
							<EmptyState title="No matches" description="Try a different search or clear the status filter." />
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
			data-workflow-card
		>
			<span className={styles.cardTop}>
				<span className={styles.cardName}>{workflow.name}</span>
				{/* Only the contained ones are marked: `host` is the default and
				    marking it everywhere would make the badge invisible on the
				    workflows where it actually says something. Marked here too: a
				    status somebody set by hand should be recognisable from the list,
				    not only after opening it. */}
				<Badge status={workflow.status} manual={workflow.statusManual} manualAt={workflow.statusManualAt} />
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

/** A shared search + status-filter toolbar, used by the dialog and the page. */
function FilterToolbar({
	query,
	setQuery,
	filter,
	setFilter,
	statuses,
	autoFocus,
}: {
	query: string;
	setQuery: (q: string) => void;
	filter: Filter;
	setFilter: (f: Filter) => void;
	statuses: WorkflowStatus[];
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

			{statuses.length > 1 && (
				<div className={styles.filters} role="group" aria-label="Filter by status">
					<button
						type="button"
						className={`${styles.filter} ${filter === "all" ? styles.filterActive : ""}`}
						onClick={() => setFilter("all")}
						aria-pressed={filter === "all"}
					>
						All
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
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const [page, setPage] = useState(1);

	const visible = useMemo(() => filterAndSort(workflows, query, filter), [workflows, query, filter]);
	const statuses = useMemo(() => presentStatuses(workflows), [workflows]);

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
	}, [query, filter]);

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
					All workflows
					{workflows.length > 0 && <span className={styles.count}>{workflows.length}</span>}
				</h2>
				<span className={styles.pageSpacer} />
			</div>

			{workflows.length > 0 && (
				<div className={styles.pageToolbar}>
					<FilterToolbar
						query={query}
						setQuery={setQuery}
						filter={filter}
						setFilter={setFilter}
						statuses={statuses}
						autoFocus
					/>
				</div>
			)}

			<div className={styles.pageBody}>
				{pageItems.length === 0 ? (
					<div className={styles.pageEmpty}>
						<EmptyState title="No matches" description="Try a different search or clear the status filter." />
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
