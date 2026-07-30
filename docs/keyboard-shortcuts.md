# Feature: Keyboard shortcuts

Five combos let an operator drive the hub without leaving the keyboard. Each
works with **either Alt or Shift** (but never both at once), and **the key for
each action is configurable** in Settings → Atajos (one letter A–Z per action,
stored by the hub so every browser sees the same bindings):

| Action | Default key |
| --- | --- |
| Focus the first workflow in the list (falls back to the search box when a filter has narrowed the list to nothing). | **W** |
| Toggle dictation into whichever text field last had focus — press to start, press again to stop, the same toggle as the VoiceDock's mic. | **R** |
| Open the create-workflow modal — the same as the "New" button. | **N** |
| Press the Continue button of a step held at its manual-review gate — a real click on the button, and nothing at all when there is no such button. | **C** |
| Press the open workflow's Start button — a real click on the one run control, whatever it currently reads (Start / Resume / Start over), and nothing at all when it is disabled. | **S** |

So with the defaults, Alt+W / Shift+W focuses the first workflow, Alt+R /
Shift+R toggles dictation, Alt+N / Shift+N opens the modal, Alt+C / Shift+C
approves the step that is waiting for review, and Alt+S / Shift+S starts the
open workflow. Rebinding focus to `Q` in Settings makes that Shift+Q instead,
and Shift+W stops doing anything.

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

Continue is the same argument at the other end of a run. A workflow with a
manual-review step stops and waits for a human to say yes, and that yes was a
mouse trip to one small button — for an operator babysitting a long run, the
single most repeated click there is. Shift+C is now that yes.

Start is the click at the other end again: having opened a workflow and ticked
the steps to run, the last thing left is one trip to the primary button.
Shift+S is that trip. It presses the same single run control the mouse would,
so it inherits which endpoint that button had already decided to call —
start, resume or restart — and it inherits the button's `disabled` too, which
is why the combo does nothing on a workflow that is already running, is held at
a review gate, or has no step selected.

## How it's implemented

`useKeyboardShortcuts` (`hub/ui/src/hooks/useKeyboardShortcuts.ts`) attaches a
`keydown` listener on `window` and resolves the pressed key to an action via
the configured bindings (`bindings: Record<ShortcutAction, ShortcutBinding>`,
defaulting to W/R/N/C/S). The modifier alone is fixed (Alt or Shift), so the
`case` bodies run for either form of a combo:

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
- **continueStep** calls `pressContinueButton`
  (`hub/ui/src/lib/continueShortcut.ts`), which finds the first enabled
  `[data-continue-step]` button and calls `.click()` on it. It does not call the
  API: clicking the button runs the button's own `onClick`, which is
  `handleContinueStep` in `App.tsx` → `POST
  /api/workflows/:id/steps/:stepId/continue` → the toast and the refresh. The
  keystroke and the mouse are therefore the same code path, by construction.
- **startWorkflow** calls `pressStartButton`
  (`hub/ui/src/lib/startShortcut.ts`), which finds the first enabled
  `[data-start-workflow]` button and calls `.click()` on it — the same
  construction, and the same refusal to touch the API itself: the click runs
  `handleStart` in `App.tsx`, which is what picks `start` / `resume` /
  `restart` from the workflow's status and sends the checked step ids.

Both press helpers are one line over `pressShortcutButton`
(`hub/ui/src/lib/shortcutButtons.ts`), which owns what "press it" means — first
match in document order, disabled ones skipped, returns whether it pressed one —
so the two shortcuts can't drift apart. That module is deliberately DOM-free
(structural types instead of `HTMLButtonElement`/`Document`), which is what lets
the hub's node:test suite exercise it against a stub root.

The bindings come from the hub (see `ShortcutSettings` in
`hub/ui/src/api/types.ts`): `GET /api/settings/shortcuts` reads them,
`PUT /api/settings/shortcuts` replaces the whole set, and the route rejects two
actions sharing a key. `App.tsx` keeps them in state and passes a memoised
binding set to the hook through a ref, so a saved rebinding takes effect on the
next keydown without re-attaching the listener (and before the bindings load,
the hook gets the W/R/N/C/S defaults so the shortcuts work from first paint).
A binding set stored before an action existed reads back with that action's
default key — `normalizeShortcutBindings` fills absent actions rather than
dropping them — so a hub upgraded into this feature has Shift+S working without
anyone visiting Settings.

Those `data-*` attributes are added in `WorkflowList.tsx` (and
`data-continue-step` in `StepItem.tsx`, `data-start-workflow` in
`WorkflowDetail.tsx`) purely as stable selectors — CSS Module
class names are hashed, so they can't be targeted from a `querySelector`; the
data attributes survive the build unchanged.

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
- focusWorkflow, createWorkflow, continueStep and startWorkflow skip while a
  modal dialog (`[role="dialog"][aria-modal="true"]`) is open, so they don't
  fight the dialog's own focus handling. toggleDictation is left alone — a
  dialog's text fields are exactly where you might want to dictate.
- The same four check `view === "workflows"`, since creating a workflow,
  focusing the list, continuing a held step and starting a run are all
  workflows-view concepts.
- continueStep and startWorkflow ignore keystrokes aimed at a text field
  (`<input>`, `<textarea>`, `<select>`, contenteditable), because Shift+C and
  Shift+S are also how a capital C and S are typed, and approving a held step by
  typing "Continue" into a description — or launching a run by typing "Start" —
  would be indefensible. The check runs **before** `preventDefault`, so the
  letter still types. The other three actions keep their older behaviour — none
  of them commits anything.
- A **disabled** button is skipped, not clicked, for both: `disabled` is how the
  UI says the action can't be taken right now, and a mouse click would do
  nothing there either. With no enabled Continue button on screen (the usual
  case — it only exists while a step is `waiting`) the combo does nothing; the
  same holds for Start, whose button is disabled when the workflow is running or
  `waiting` (no start action applies), while a mutation is in flight, or while
  no step is selected.
- The Start shortcut is bound to the run control whatever its label reads —
  Start, Resume or Start over. They are one button hitting one endpoint chosen
  by `startActionFor`, and the operator was never asked to pick between them;
  binding to the label instead would make the same keystroke work on some
  workflows and silently not on others.

## Notes

Dictation itself is Chrome/Edge only (the Web Speech API), inherited from
`useDictation` — on a browser without it the dictation shortcut is a silent
no-op, the same as a disabled mic. The shortcuts now touch the hub side too:
the per-action key bindings are stored (one row in the `settings` table, key
`shortcuts`) and surfaced in Settings → Atajos, where each of the five actions
gets its own one-letter field and a Save that PUTs the whole set. `useDictation` exposes
`toggle` (used by both the mic button and the toggleDictation shortcut) as the
single start/stop control.
