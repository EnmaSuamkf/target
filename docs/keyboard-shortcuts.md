# Feature: Keyboard shortcuts

Three combos let an operator drive the hub without leaving the keyboard. Each
works with **either Alt or Shift** (but never both at once), and **the key for
each action is configurable** in Settings → Atajos (one letter A–Z per action,
stored by the hub so every browser sees the same bindings):

| Action | Default key |
| --- | --- |
| Focus the first workflow in the list (falls back to the search box when a filter has narrowed the list to nothing). | **W** |
| Toggle dictation into whichever text field last had focus — press to start, press again to stop, the same toggle as the VoiceDock's mic. | **R** |
| Open the create-workflow modal — the same as the "New" button. | **N** |

So with the defaults, Alt+W / Shift+W focuses the first workflow, Alt+R /
Shift+R toggles dictation, and Alt+N / Shift+N opens the modal. Rebinding focus
to `Q` in Settings makes that Shift+Q instead, and Shift+W stops doing
anything.

## Why

The hub is a tool an operator returns to constantly: scan the list, open
something, dictate a step, start the next workflow. Every one of those was a
mouse trip. The shortcuts put the common path under the keyboard, and the
dictation shortcut in particular pairs with speech so a hands-free run is
possible — focus a field, press Shift+R, speak the instruction, press it
again, move on — without ever touching the floating mic. It is a toggle so the
recording stays on until the combo is pressed again: press to talk, press to
stop. Shift is offered alongside Alt because on some layouts Alt+letter is a
compose sequence or a window-manager grab, so a second modifier keeps the
shortcut reachable regardless of platform.

## How it's implemented

`useKeyboardShortcuts` (`hub/ui/src/hooks/useKeyboardShortcuts.ts`) attaches a
`keydown` listener on `window` and resolves the pressed key to an action via
the configured bindings (`bindings: Record<ShortcutAction, ShortcutBinding>`,
defaulting to W/R/N). The modifier alone is fixed (Alt or Shift), so the `case`
bodies run for either form of a combo:

- **toggleDictation** toggles dictation: it calls `dictation.toggle()`, which
  starts when nothing is listening and stops when something is — the same
  toggle the mic button uses, so a second press ends the recording. The guard
  only checks `supported`, not `listening`, so the same press that starts can
  also stop.
- **createWorkflow** calls the same `onCreateWorkflow` handler the "New"
  button uses (`setCreateOpen(true)` in `App.tsx`).
- **focusWorkflow** queries the DOM for the first `[data-workflow-card]` inside
  `[data-workflow-list]` and focuses it (with `scrollIntoView`), falling back
  to `[data-workflow-search]` when there are no cards.

The bindings come from the hub (see `ShortcutSettings` in
`hub/ui/src/api/types.ts`): `GET /api/settings/shortcuts` reads them,
`PUT /api/settings/shortcuts` replaces the whole set, and the route rejects two
actions sharing a key. `App.tsx` keeps them in state and passes a memoised
binding set to the hook through a ref, so a saved rebinding takes effect on the
next keydown without re-attaching the listener (and before the bindings load,
the hook gets the W/R/N defaults so the shortcuts work from first paint).

Those `data-*` attributes are added in `WorkflowList.tsx` purely as stable
selectors — CSS Module class names are hashed, so they can't be targeted from a
`querySelector`; the data attributes survive the build unchanged.

The handler callbacks are read through a ref, so the listener is attached once
and always sees the latest props. This is the same trick `usePolling` uses, and
it matters here because the app re-renders every 2s on the poll — without it an
inline `onCreateWorkflow` would re-attach the listener on every tick.

## Guards

- Exactly **one** of Alt or Shift must be held (never both): the guard is
  `!!ev.altKey + !!ev.shiftKey !== 1` returns early. Alt+Shift is left to
  keyboard-layout switching, and Ctrl/Cmd to the OS and window manager.
  `repeat` and IME-composing keydowns are ignored, so holding a combo fires it
  exactly once — for dictation that means a held key toggles a single time
  rather than streaming starts and stops.
- `preventDefault` is called on each keydown match so the combos don't also type
  their platform-specific Alt characters (e.g. Option+letter symbols on macOS).
- focusWorkflow and createWorkflow skip while a modal dialog
  (`[role="dialog"][aria-modal="true"]`) is open, so they don't fight the
  dialog's own focus handling. toggleDictation is left alone — a dialog's text
  fields are exactly where you might want to dictate.
- focusWorkflow and createWorkflow also check `view === "workflows"`, since
  "create workflow" and "focus the workflow list" are workflows-view concepts.

## Notes

Dictation itself is Chrome/Edge only (the Web Speech API), inherited from
`useDictation` — on a browser without it the dictation shortcut is a silent
no-op, the same as a disabled mic. The shortcuts now touch the hub side too:
the per-action key bindings are stored (one row in the `settings` table, key
`shortcuts`) and surfaced in Settings → Atajos, where each action gets its own
one-letter field and a Save that PUTs the whole set. `useDictation` exposes
`toggle` (used by both the mic button and the toggleDictation shortcut) as the
single start/stop control.
