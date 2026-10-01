# Workflow list filters redesign

Design note for the filter toolbar of the hub's workflow list (`hub/ui/src/views/WorkflowList.tsx`).
This is a UI/UX change only: the filtering logic in `lib/workflowFilter.ts` and `lib/scheduleView.ts`
stays as it is. Other catalog views (Templates, TCPs, Resource sets) are not touched.

Branch: `feat/workflow-filters-redesign`.

## Problem with the current toolbar

`FilterToolbar` renders four independent, unlabeled chip groups in one row: Active/Archived,
All origins/Local/Remote, All/Scheduled/Scheduled runs, and All statuses + status chips.

- Four filters read as one, and three differently worded "All" chips are ambiguous.
- Defaults (Active, All origins, All) are highlighted, so the bar looks filtered at rest.
- Jargon: "Active" really means "not archived"; "Scheduled" vs "Scheduled runs" is unclear.
- Groups appear and disappear with the data, so the bar changes shape and overflows on narrow widths.
- No applied-filter summary, no result counts, no clear-all.
- View, property and state filters all have the same visual weight.

## Component breakdown

All new components live in `hub/ui/src/views/WorkflowList.tsx` (or small sibling files if it grows)
and use `WorkflowList.module.css` tokens (`var(--space-*)`, `var(--accent-*)`, the existing `.filter` pill look).

| Component | Role |
|---|---|
| `FilterToolbar` | Orchestrator. Takes the `useWorkflowFilters` result plus `variant: "rail" \| "page"`. Renders the search input, then (page only) `StatusTabs`, then the `Filters` button with its `FiltersPopover`, then `AppliedFilterChips`. |
| `StatusTabs` | Status tabs with counts: `All N · Running · Waiting · Paused · Completed · Failed`. Always rendered (page variant), in `STATUS_ORDER` order. Zero-count statuses are dimmed and disabled, not removed. `aria-pressed` buttons in a `role="group"` labeled "Filter by status". |
| `FiltersButton` | One button, "Filters". Shows a count badge ("Filters · 2") only when non-default filters are applied. `aria-haspopup="dialog"`, `aria-expanded`. Not highlighted at rest. |
| `FiltersPopover` | Popover anchored to the button (bottom sheet at phone widths, same media query as the existing mobile block). Holds the three radio sections below, plus, in the rail variant only, the status section. Footer: **Clear all** and **Done**. Escape and outside click close it; focus moves into it on open and returns to the button on close. |
| `FilterSection` | One labeled single-select group (`role="radiogroup"` with a visible legend). Options are `role="radio"` / `aria-checked`, roving arrow-key navigation. Options with no matches are greyed and show `(0)` but stay present. |
| `AppliedFilterChips` | The "Showing:" row below the main row. One removable chip per non-default filter (including status and search), e.g. `Remote ✕`, `Past runs ✕`, `Failed ✕`, `"foo" ✕`. Plus a "Clear all" link. Not rendered when nothing is applied. |

`useWorkflowFilters` keeps its state (`query`, `filter`, `originFilter`, `archive`, `scheduleFilter`) and
`setArchive` still resets the status filter. It gains derived values: per-option counts (below), an
`appliedCount` (non-default filters, excluding the search text), and a `clearAll()`.

### Defaults ("nothing applied")

`filter = "all"`, `originFilter = "all"`, `archive = "active"`, `scheduleFilter = "all"`, `query = ""`.
The Filters badge counts non-default values among archive, origin and schedule, plus status in the rail
variant (where the status tabs are inside the popover). Search never counts toward the badge, but it does
show as a chip in "Showing:". On the page the status tabs are visible, so status is not counted in the badge.

## Exact copy

All user-facing copy is English.

Filters popover (sections are always present; the layout is stable):

- **Show**: `Open` (default) / `Archived (N)`. "Open" means not archived and replaces "Active".
- **Created**: `Anywhere` (default) / `Local (N)` / `Remote (N)`.
- **Scheduling**: `Any` (default) / `Upcoming runs (N)` / `Past runs (N)`.
  - `Upcoming runs` replaces "Scheduled" (`scheduleFilter = "scheduled"`: the armed instance of each series, once).
  - `Past runs` replaces "Scheduled runs" (`scheduleFilter = "runs"`: executions a schedule already ran).
  - Tooltips keep the old explanations: "Each schedule once, by its next run" and "Runs that schedules have already executed".
- Rail only, an extra first section **Status**: `All` (default) / Running / Waiting / Paused / Completed / Failed (with counts).
- Footer: `Clear all`, `Done`.
- Main row: search placeholder stays `Search workflows…`; button `Filters` / `Filters · 2`; status tabs `All N`, `Running`, `Waiting`, `Paused`, `Completed`, `Failed` (each with its count).
- Applied row: label `Showing:`, chips such as `Remote ✕`, `Past runs ✕`, `Archived ✕`; link `Clear all`. Chip remove buttons have `aria-label="Remove filter: Remote"`.

Update `SCHEDULE_FILTER_LABELS` consumers carefully: the constant in `scheduleView.ts` keeps its values
(`Scheduled`, `Scheduled runs`) because the logic module is unchanged. The toolbar uses its own
new labels (`Upcoming runs`, `Past runs`), kept next to the toolbar code.

Draft status: `draft` exists in `STATUS_ORDER` but is not in the agreed tab list. It is not given a tab.
Instead it is counted in `All N` and is reachable only through the rail popover's Status section, which lists
every status that `presentStatuses` can return.
(Decision for step 2: if drafts are rare in practice, the rail and the page may simply include a `Draft` tab/option
only when `draft` count > 0; this is the one place where "always present" is relaxed.)

## How option counts are computed

**Scoping rule: each count is computed with all OTHER active filters applied.** The dimension being
counted is ignored, everything else (search, status, archive side, origin, schedule) is applied.
This is the usual faceted-search behaviour: the number on an option is what you get if you click it.

Concretely, with `f(...)` meaning the existing `filterAndSort(workflows, query, status, origin, archive, schedule)`:

- Status tab count for `s` = `f(workflows, query, s, origin, archive, schedule).length`.
  `All N` = `f(workflows, query, "all", origin, archive, schedule).length`.
- Show: `Archived (N)` = `f(workflows, query, "all", origin, "archived", schedule).length`.
  This is the one exception to the rule: the status filter is ignored here, because `setArchive` resets status, so a status-scoped number would not match the list the click produces.
  `Open` shows no number (it is the default and is the working list).
- Created: `Local (N)` / `Remote (N)` = `f(workflows, query, status, o, archive, schedule).length` for `o` in local/remote.
- Scheduling: `Upcoming runs (N)` / `Past runs (N)` = `f(workflows, query, status, origin, archive, sch).length` for `sch` in scheduled/runs.
  `Upcoming runs` therefore counts one per series, same as the list will show.

Notes:
- Counts are derived by calling the existing logic, so they can never disagree with the list. No logic
  change in `workflowFilter.ts` / `scheduleView.ts`.
- Archived work is only ever completed/failed. If the archive side is switched, `setArchive` resets the
  status filter (existing behaviour) so no stale status can strand the list.
- A zero count greys the option and shows `(0)`; the option stays selectable if it is currently selected
  (so the user can always see and undo it) and disabled otherwise.
- The heading count (`scoped.length`) next to "Workflows" / "All workflows" is unchanged.
- Counts are `useMemo`'d on `[workflows, query, filter, originFilter, archive, scheduleFilter]`. The number of
  workflows is small (tens to low hundreds), so ~13 passes are cheap.

## Rail vs All workflows page

| | Rail (`WorkflowList`) | `AllWorkflowsPage` |
|---|---|---|
| Main row | Search + `Filters` button only | Search + status tabs (with counts) + `Filters` button |
| Status | Inside the popover (extra "Status" section) | Visible `StatusTabs` |
| Popover sections | Status, Show, Created, Scheduling | Show, Created, Scheduling |
| Filters badge counts | archive, origin, schedule and status | archive, origin, schedule |
| "Showing:" row | Same behaviour (non-default filters incl. status/search) | Same |
| Autofocus | No | Search is autofocused (as today, `autoFocus`) |
| Phone width | Search full width, Filters button next to it; popover is a bottom sheet | Search full width; status tabs scroll horizontally on one row; Filters button; bottom sheet |

The rail keeps its `New` and `All workflows` buttons in `toolbarTools`. Each surface still owns its own
`useWorkflowFilters` state, so narrowing one never narrows the other.

## Existing tests and files to update

Tests that assert on the current markup and will need to change in step 3:

- `hub/ui-archive.test.ts`
  - "the rail and the All workflows page both go through the archive-aware filter hook" (around lines 108-120):
    asserts `role="group" aria-label="Filter by archive state"`, `onClick={() => setArchive("archived")}`,
    `aria-pressed={archive === "archived"}`, `<FilterToolbar {...filters} />` and `<FilterToolbar {...filters} autoFocus />`.
    Also asserts `filterAndSort(workflows, query, filter, originFilter, archive)` (that call stays in the hook; keep or adjust the regex if the call changes shape).
  - The header comment on line 2 mentions the old toggle; refresh it.
  - Pure-logic tests (`filterAndSort`, `presentStatuses`, `scopeByArchive`, `isArchived`...) stay unchanged.
- `hub/ui-schedule-list.test.ts`
  - "the filter group is in the shared toolbar, so the rail AND the All workflows page get it" (around lines 200-212):
    asserts `aria-label="Filter by schedule" data-schedule-filter`, `SCHEDULE_FILTER_LABELS[f]`,
    `scheduled: "Scheduled",\s*runs: "Scheduled runs"` in `scheduleView.ts` (stays valid because the constant is kept),
    `filterBySchedule(filterAndSort(...), scheduleFilter)`, two `useWorkflowFilters(workflows)` calls,
    and the two `<FilterToolbar ... />` usages (the props change to `variant`).
  - The page-reset assertion `[query, filter, originFilter, archive, scheduleFilter]` stays valid.
  - Logic tests on `filterAndSort` / `presentScheduleFilters` / `filterBySchedule` stay unchanged.
- No change needed: `hub/catalog-sync-ui.test.ts` ("Filter by origin" is about Templates/TCPs/Resource sets, which are out of scope).

Non-test files:

- `hub/ui/src/views/WorkflowList.tsx`: replace `FilterToolbar`; extend `useWorkflowFilters`; update both call sites.
- `hub/ui/src/views/WorkflowList.module.css`: new styles for the tabs, Filters button/badge, popover, bottom sheet, sections, applied chips; keep `.filter` look; remove styles that become unused. Dark mode via the existing tokens.
- `hub/ui/src/lib/workflowFilter.ts`: `emptyListMessage` copy "Try a different search or clear the status filter." should point at "Clear all" (copy only, no logic change). Tests in `ui-archive.test.ts` that assert this string, if any, move with it.
- `hub/ui/src/hooks/useKeyboardShortcuts.ts`: keep `data-workflow-search` on the search input; the shortcut depends on it.
- User-facing copy elsewhere that names the old "Archived" filter (`SettingsView.tsx` ~line 1157, `WorkflowDetail.tsx` ~line 796, `App.tsx` comment ~line 340): "Archived" is still the name of the option, so these stay accurate; re-check wording in step 3.
- `CHANGELOG.md`: add an entry in the file's existing format (step 5).
- `hub/ui/dist/` is build output and is not edited by hand.

New tests to add (step 3): a source-level test for the new components (labels, radio semantics, Escape/outside click handlers), and pure tests for the count helper and `appliedCount`, placed in a new `hub/ui-workflow-filters.test.ts`.

## Out of scope

- Any change to filtering/sorting logic, `STATUS_ORDER`, or `ScheduleFilter` semantics.
- Templates / TCPs / Resource sets filters.
- Server/API changes.

## Implementation map

- `hub/ui/src/lib/workflowFilterView.ts`: pure helpers `countFilterOptions`, `appliedFilters`, `filtersButtonCount`, `withoutFilter`, `FILTER_COPY`, `DEFAULT_FILTER_STATE`.
- `hub/ui/src/views/WorkflowFilters.tsx` + `.module.css`: `StatusTabs`, `FiltersButton`, `FiltersPopover` (exactly three sections; the rail passes a `leadingSection`, built with `StatusSection`), `AppliedFilterChips`.
- Tests: `hub/ui-workflow-filters.test.ts`.
