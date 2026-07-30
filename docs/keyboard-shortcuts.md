# Feature: Keyboard shortcuts

Three combos let an operator drive the hub without leaving the keyboard. Each
works with **either Alt or Shift** (but never both at once):

| Combo | Action |
| --- | --- |
| **Alt+W** / **Shift+W** | Focus the first workflow in the list (falls back to the search box when a filter has narrowed the list to nothing). |
| **Alt+R** / **Shift+R** | Start dictating into whichever text field last had focus — the same action as the VoiceDock's mic. |
| **Alt+N** / **Shift+N** | Open the create-workflow modal — the same as the "New" button. |

## Why

The hub is a tool an operator returns to constantly: scan the list, open
something, dictate a step, start the next workflow. Every one of those was a
mouse trip. The shortcuts put the common path under the keyboard, and the
dictation shortcut in particular pairs with speech so a hands-free run is
possible — focus a field, speak the instruction, move on — without ever
touching the floating mic. Shift is offered alongside Alt because on some
layouts Alt+letter is a compose sequence or a window-manager grab, so a second
modifier keeps the shortcut reachable regardless of platform.

## How it's implemented

`useKeyboardShortcuts` (`hub/ui/src/hooks/useKeyboardShortcuts.ts`) attaches one
`keydown` listener on `window` and dispatches on `ev.key`. The key alone decides
the action, so the `case` bodies run for both the Alt and the Shift form of a
combo:

- **…+R** calls `dictation.toggle()`, but only when dictation is supported and
  not already listening — the shortcut *starts*, it does not toggle, so pressing
  it again mid-dictation is a no-op rather than a stop.
- **…+N** calls the same `onCreateWorkflow` handler the "New" button uses
  (`setCreateOpen(true)` in `App.tsx`).
- **…+W** queries the DOM for the first `[data-workflow-card]` inside
  `[data-workflow-list]` and focuses it (with `scrollIntoView`), falling back to
  `[data-workflow-search]` when there are no cards.

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
  exactly once.
- `preventDefault` is called on each match so the combos don't also type their
  platform-specific Alt characters (e.g. Option+letter symbols on macOS).
- …+W and …+N skip while a modal dialog (`[role="dialog"][aria-modal="true"]`)
  is open, so they don't fight the dialog's own focus handling. …+R is left
  alone — a dialog's text fields are exactly where you might want to dictate.
- …+W and …+N also check `view === "workflows"`, since "create workflow" and
  "focus the workflow list" are workflows-view concepts.

## Notes

Dictation itself is Chrome/Edge only (the Web Speech API), inherited from
`useDictation` — on a browser without it the dictation shortcut is a silent
no-op, the same as a disabled mic. The shortcuts are a UI-only change: nothing
on the hub side moved.
