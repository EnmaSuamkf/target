import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "../hooks/useIsMobile.ts";
import type { WorkflowStatus } from "../api/types.ts";
import type { ScheduleFilter } from "../lib/scheduleView.ts";
import { type ArchiveFilter, type OriginFilter, STATUS_ORDER, type StatusFilter } from "../lib/workflowFilter.ts";
import {
	type AppliedFilter,
	type AppliedFilterKey,
	FILTER_COPY,
	type FilterOptionCounts,
} from "../lib/workflowFilterView.ts";
import styles from "./WorkflowFilters.module.css";

/**
 * The building blocks of the workflow filter toolbar: status tabs, the
 * "Filters" trigger + popover, and the applied-filter chips. Presentational
 * only — the owning surface holds the state (see `useWorkflowFilters`).
 */

const STATUS_LABELS: Record<WorkflowStatus, string> = {
	waiting: "Waiting",
	running: "Running",
	paused: "Paused",
	draft: "Draft",
	failed: "Failed",
	completed: "Completed",
};

/**
 * `All N` plus one tab per status in STATUS_ORDER order. A status with no
 * matches stays but is dimmed and disabled (unless it is the selected one, so
 * the way back is never lost). `draft` is the one status that is only offered
 * when something is a draft: it is not part of the everyday set.
 */
export function StatusTabs({
	value,
	counts,
	onChange,
}: {
	value: StatusFilter;
	counts: FilterOptionCounts["status"];
	onChange: (status: StatusFilter) => void;
}): React.JSX.Element {
	const statuses = (Object.keys(STATUS_ORDER) as WorkflowStatus[])
		.filter((s) => s !== "draft" || counts.draft > 0 || value === "draft")
		.sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b]);
	return (
		<div className={styles.tabs} role="group" aria-label="Filter by status" data-status-tabs>
			<StatusTab label="All" count={counts.all} selected={value === "all"} neutral onClick={() => onChange("all")} />
			{statuses.map((s) => (
				<StatusTab
					key={s}
					label={STATUS_LABELS[s]}
					count={counts[s]}
					selected={value === s}
					disabled={counts[s] === 0 && value !== s}
					onClick={() => onChange(s)}
				/>
			))}
		</div>
	);
}

function StatusTab({
	label,
	count,
	selected,
	disabled,
	neutral,
	onClick,
}: {
	label: string;
	count: number;
	selected: boolean;
	disabled?: boolean;
	/** The default tab: selected but not accented, so the bar reads as unfiltered at rest. */
	neutral?: boolean;
	onClick: () => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			className={`${styles.tab} ${selected ? (neutral ? styles.tabDefault : styles.tabSelected) : ""}`}
			aria-pressed={selected}
			disabled={disabled}
			onClick={onClick}
		>
			{label}
			<span className={styles.tabCount}>{count}</span>
		</button>
	);
}

/** "Filters", or "Filters · N" when N non-default filters are applied. Never highlighted at rest. */
export function FiltersButton({
	count,
	open,
	onClick,
	buttonRef,
	controlsId,
}: {
	count: number;
	open: boolean;
	onClick: () => void;
	buttonRef: React.RefObject<HTMLButtonElement | null>;
	controlsId: string;
}): React.JSX.Element {
	return (
		<button
			ref={buttonRef}
			type="button"
			className={`${styles.filtersBtn} ${count > 0 ? styles.filtersBtnApplied : ""}`}
			onClick={onClick}
			aria-label={count > 0 ? `Filters, ${count} applied` : "Filters"}
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-controls={open ? controlsId : undefined}
			data-filters-button
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
				<path d="M4 6h16M7 12h10M10 18h4" />
			</svg>
			Filters
			{count > 0 && <span className={styles.badge}>{`· ${count}`}</span>}
		</button>
	);
}

interface RadioOption<V extends string> {
	value: V;
	label: string;
	/** Shown as "(N)" after the label; omitted for the default option. */
	count?: number;
	title?: string;
}

/**
 * One labeled single-select group. Options with no matches are greyed and
 * show (0) but are never removed; they are skipped by the arrow keys and
 * cannot be picked — unless already selected, so it can still be seen.
 */
function FilterSection<V extends string>({
	title,
	value,
	options,
	onChange,
	dataAttr,
}: {
	title: string;
	value: V;
	options: RadioOption<V>[];
	onChange: (value: V) => void;
	dataAttr: string;
}): React.JSX.Element {
	const labelId = useId();
	const groupRef = useRef<HTMLDivElement | null>(null);
	const isDisabled = (o: RadioOption<V>): boolean => o.count === 0 && o.value !== value;

	const onKeyDown = (ev: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
		const step = ev.key === "ArrowDown" || ev.key === "ArrowRight" ? 1 : ev.key === "ArrowUp" || ev.key === "ArrowLeft" ? -1 : 0;
		if (step === 0) return;
		ev.preventDefault();
		for (let i = 1; i <= options.length; i++) {
			const next = (index + step * i + options.length * i) % options.length;
			const option = options[next];
			if (!option || isDisabled(option)) continue;
			onChange(option.value);
			groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
			return;
		}
	};

	return (
		<div className={styles.section} data-filter-section={dataAttr}>
			<div className={styles.sectionTitle} id={labelId}>
				{title}
			</div>
			<div ref={groupRef} className={styles.options} role="radiogroup" aria-labelledby={labelId}>
				{options.map((o, i) => {
					const selected = o.value === value;
					const disabled = isDisabled(o);
					return (
						<button
							key={o.value}
							type="button"
							role="radio"
							aria-checked={selected}
							aria-disabled={disabled || undefined}
							tabIndex={selected ? 0 : -1}
							className={`${styles.option} ${selected ? styles.optionSelected : ""} ${disabled ? styles.optionEmpty : ""}`}
							title={o.title}
							onClick={() => {
								if (!disabled) onChange(o.value);
							}}
							onKeyDown={(ev) => onKeyDown(ev, i)}
						>
							<span className={styles.radioDot} aria-hidden="true" />
							{o.label}
							{o.count !== undefined && <span className={styles.optionCount}>{`(${o.count})`}</span>}
						</button>
					);
				})}
			</div>
		</div>
	);
}

export interface FiltersPopoverProps {
	open: boolean;
	onClose: () => void;
	/** The trigger: clicks on it are not "outside", and focus returns to it on close. */
	anchorRef: React.RefObject<HTMLButtonElement | null>;
	id: string;
	counts: FilterOptionCounts;
	archive: ArchiveFilter;
	onArchiveChange: (a: ArchiveFilter) => void;
	origin: OriginFilter;
	onOriginChange: (o: OriginFilter) => void;
	schedule: ScheduleFilter;
	onScheduleChange: (s: ScheduleFilter) => void;
	onClearAll: () => void;
	/** The compact rail has no status tabs in its bar, so it passes a Status section to show first. */
	leadingSection?: React.ReactNode;
}

/**
 * The popover (a bottom sheet at phone widths — see the media query) with the
 * three labeled sections Show / Created / Scheduling and a Clear all / Done
 * footer. Escape and an outside click close it; focus moves into it on open
 * and back to the trigger on close.
 */
export function FiltersPopover({
	open,
	onClose,
	anchorRef,
	id,
	counts,
	archive,
	onArchiveChange,
	origin,
	onOriginChange,
	schedule,
	onScheduleChange,
	onClearAll,
	leadingSection,
}: FiltersPopoverProps): React.JSX.Element | null {
	const panelRef = useRef<HTMLDivElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const isMobile = useIsMobile();
	// Rendered in a portal and placed under the trigger: the rail's panel clips
	// its overflow, which cut the popover off at the rail's bottom edge. On a
	// phone the CSS bottom sheet takes over and no inline position is applied.
	const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

	useLayoutEffect(() => {
		if (!open || isMobile) return;
		const place = (): void => {
			const rect = anchorRef.current?.getBoundingClientRect();
			if (rect) setPos({ top: rect.bottom + 4, right: Math.max(8, document.documentElement.clientWidth - rect.right) });
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open, isMobile, anchorRef]);

	const shown = open && (isMobile || pos !== null);

	useEffect(() => {
		if (!shown) return;
		const anchor = anchorRef.current;
		const panel = panelRef.current;
		(panel?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ?? panel)?.focus();

		const onKey = (ev: KeyboardEvent): void => {
			if (ev.key !== "Escape") return;
			ev.stopPropagation();
			onCloseRef.current();
		};
		const onPointer = (ev: MouseEvent): void => {
			const target = ev.target as Node | null;
			if (!target || panelRef.current?.contains(target) || anchor?.contains(target)) return;
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onPointer);
			anchor?.focus();
		};
	}, [shown, anchorRef]);

	if (!open) return null;
	const { show, created, scheduling } = FILTER_COPY;
	if (!isMobile && !pos) return null;
	return createPortal(
		<>
			<div className={styles.backdrop} aria-hidden="true" />
			<div
				ref={panelRef}
				id={id}
				className={styles.popover}
				style={isMobile || !pos ? undefined : { top: pos.top, right: pos.right }}
				role="dialog"
				aria-label="Filters"
				tabIndex={-1}
				data-filters-popover
			>
				<div className={styles.popoverBody}>
					{leadingSection}
					<FilterSection<ArchiveFilter>
						title={show.title}
						dataAttr="show"
						value={archive}
						onChange={onArchiveChange}
						options={[
							{ value: "active", label: show.open, title: "Workflows that are not archived" },
							{ value: "archived", label: show.archived, count: counts.archive.archived, title: "Show only archived workflows" },
						]}
					/>
					<FilterSection<OriginFilter>
						title={created.title}
						dataAttr="created"
						value={origin}
						onChange={onOriginChange}
						options={[
							{ value: "all", label: created.all },
							{ value: "local", label: created.local, count: counts.origin.local },
							{ value: "remote", label: created.remote, count: counts.origin.remote },
						]}
					/>
					<FilterSection<ScheduleFilter>
						title={scheduling.title}
						dataAttr="scheduling"
						value={schedule}
						onChange={onScheduleChange}
						options={[
							{ value: "all", label: scheduling.all },
							{
								value: "scheduled",
								label: scheduling.scheduled,
								count: counts.schedule.scheduled,
								title: "Each schedule once, by its next run",
							},
							{
								value: "runs",
								label: scheduling.runs,
								count: counts.schedule.runs,
								title: "Runs that schedules have already executed",
							},
						]}
					/>
				</div>
				<div className={styles.popoverFooter}>
					<button type="button" className="btn btn--ghost btn--sm" onClick={onClearAll}>
						Clear all
					</button>
					<button type="button" className="btn btn--primary btn--sm" onClick={onClose}>
						Done
					</button>
				</div>
			</div>
		</>,
		document.body,
	);
}

/** The Status section the compact rail shows at the top of the popover (the page has the tabs instead). */
export function StatusSection({
	value,
	counts,
	onChange,
}: {
	value: StatusFilter;
	counts: FilterOptionCounts["status"];
	onChange: (status: StatusFilter) => void;
}): React.JSX.Element {
	const statuses = (Object.keys(STATUS_ORDER) as WorkflowStatus[])
		.filter((s) => s !== "draft" || counts.draft > 0 || value === "draft")
		.sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b]);
	return (
		<FilterSection<StatusFilter>
			title="Status"
			dataAttr="status"
			value={value}
			onChange={onChange}
			options={[
				{ value: "all", label: FILTER_COPY.statusAll },
				...statuses.map((s) => ({ value: s as StatusFilter, label: STATUS_LABELS[s], count: counts[s] })),
			]}
		/>
	);
}

/** "Showing:" + a removable chip per non-default filter + "Clear all". Renders nothing when nothing is applied. */
export function AppliedFilterChips({
	applied,
	onRemove,
	onClearAll,
}: {
	applied: AppliedFilter[];
	onRemove: (key: AppliedFilterKey) => void;
	onClearAll: () => void;
}): React.JSX.Element | null {
	if (applied.length === 0) return null;
	return (
		<div className={styles.applied} data-applied-filters>
			<span className={styles.appliedLabel}>Showing:</span>
			{applied.map((a) => (
				<span key={a.key} className={styles.chip}>
					{a.label}
					<button type="button" className={styles.chipRemove} onClick={() => onRemove(a.key)} aria-label={`Remove filter: ${a.label}`}>
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
							<path d="M6 6l12 12M18 6 6 18" />
						</svg>
					</button>
				</span>
			))}
			<button type="button" className={styles.clearLink} onClick={onClearAll}>
				Clear all
			</button>
		</div>
	);
}
