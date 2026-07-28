import { useMemo, useState } from "react";
import type { Workflow, WorkflowStatus } from "../api/types.ts";
import { Badge } from "../components/Badge.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ProgressBar } from "../components/Progress.tsx";
import { relativeTime } from "../lib/format.ts";
import styles from "./WorkflowList.module.css";

/**
 * Sidebar list of workflows, with a search box and a status filter that the
 * previous UI didn't have — it rendered every workflow as one flat column,
 * which stops being navigable after a dozen or so.
 *
 * Sorting puts the work that needs you first (waiting on a manual review), then
 * active work (running, then paused), then everything else by recency, so the
 * workflow you're most likely to want is at the top.
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

export function WorkflowList({
	workflows,
	selectedId,
	onSelect,
	onCreate,
}: {
	workflows: Workflow[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onCreate: () => void;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return workflows
			.filter((w) => (filter === "all" ? true : w.status === filter))
			.filter((w) => (q === "" ? true : w.name.toLowerCase().includes(q) || w.agentName.toLowerCase().includes(q)))
			.sort((a, b) => {
				const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
				if (byStatus !== 0) return byStatus;
				return b.updatedAt.localeCompare(a.updatedAt);
			});
	}, [workflows, query, filter]);

	// Only offer filters that would actually match something.
	const availableStatuses = useMemo(() => {
		const present = new Set(workflows.map((w) => w.status));
		return (Object.keys(STATUS_ORDER) as WorkflowStatus[])
			.filter((s) => present.has(s))
			.sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b]);
	}, [workflows]);

	return (
		<aside className={styles.panel} aria-label="Workflows">
			<div className={styles.head}>
				<div className={styles.headRow}>
					<h2 className={styles.heading}>
						Workflows
						{workflows.length > 0 && <span className={styles.count}>{workflows.length}</span>}
					</h2>
					<button type="button" className="btn btn--primary btn--sm" onClick={onCreate}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
							<path d="M12 5v14M5 12h14" />
						</svg>
						New
					</button>
				</div>

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
							/>
						</div>

						{availableStatuses.length > 1 && (
							<div className={styles.filters} role="group" aria-label="Filter by status">
								<button
									type="button"
									className={`${styles.filter} ${filter === "all" ? styles.filterActive : ""}`}
									onClick={() => setFilter("all")}
									aria-pressed={filter === "all"}
								>
									All
								</button>
								{availableStatuses.map((status) => (
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
			</div>

			<div className={styles.list}>
				{visible.length === 0 ? (
					workflows.length === 0 ? (
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
					)
				) : (
					visible.map((workflow) => (
						<button
							key={workflow.id}
							type="button"
							className={`${styles.card} ${workflow.id === selectedId ? styles.cardSelected : ""}`}
							onClick={() => onSelect(workflow.id)}
							aria-current={workflow.id === selectedId ? "true" : undefined}
						>
							<span className={styles.cardHead}>
								<span className={styles.cardName}>{workflow.name}</span>
								{/* Only the contained ones are marked: `host` is the default and
								    marking it everywhere would make the badge invisible on the
								    workflows where it actually says something. */}
								{workflow.sandbox === "docker" && (
									<span className={styles.sandbox} title={`Steps run in a container (${workflow.image ?? "default image"})`}>
										docker
									</span>
								)}
								{/* Marked here too: a status somebody set by hand should be
							    recognisable from the list, not only after opening it. */}
							<Badge status={workflow.status} manual={workflow.statusManual} manualAt={workflow.statusManualAt} />
							</span>

							<ProgressBar progress={workflow.progress} running={workflow.status === "running"} />

							<span className={styles.cardMeta}>
								<span>
									{workflow.progress.done}/{workflow.progress.total} steps
								</span>
								<span className={styles.dot} aria-hidden="true">
									·
								</span>
								<span>{workflow.progress.pct}%</span>
								{workflow.updatedAt && (
									<>
										<span className={styles.dot} aria-hidden="true">
											·
										</span>
										<span>{relativeTime(workflow.updatedAt)}</span>
									</>
								)}
							</span>
						</button>
					))
				)}
			</div>
		</aside>
	);
}
