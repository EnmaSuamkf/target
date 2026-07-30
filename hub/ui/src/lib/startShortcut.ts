/**
 * The DOM half of the Start shortcut (Alt/Shift+S by default): find the open
 * workflow's run button and press it. The pressing itself is
 * `pressShortcutButton` in shortcutButtons.ts, shared with the Continue
 * shortcut; what belongs to Start alone is which attribute identifies its
 * button.
 *
 * The attribute is on the one run control WorkflowDetail renders, whatever its
 * label reads at the time — "Start" on a draft, "Resume" on a paused workflow,
 * "Start over" on a finished one. It is a single button hitting a single
 * endpoint chosen by `startActionFor`, and the operator was never asked to pick
 * between them: the label just names which one applies. Binding the shortcut to
 * the label instead would make the same keystroke work on some workflows and
 * silently not on others, which is the surprise this avoids.
 *
 * That button's own `disabled` is what makes the shortcut inert exactly when
 * starting is impossible, so nothing about the workflow's state is re-derived
 * here:
 *
 * - a `running` or `waiting` workflow has no start action at all (a `waiting`
 *   one is released by the held step's Continue, not by Start — the server
 *   refuses a Start on it);
 * - an empty step selection runs nothing, so the button says so instead;
 * - a mutation already in flight (`busy`) disables it like every other control.
 */

import { pressShortcutButton, type ShortcutButtonRoot } from "./shortcutButtons.ts";

/** The stable hook the Start button carries; CSS Module names are hashed. */
export const START_BUTTON_SELECTOR = "[data-start-workflow]";

/**
 * Presses the first enabled Start button in `root`, and reports whether one was
 * found. Only the open workflow renders one, so in practice there is at most a
 * single candidate; document order decides if that ever stops being true.
 */
export function pressStartButton(root: ShortcutButtonRoot): boolean {
	return pressShortcutButton(root, START_BUTTON_SELECTOR);
}
