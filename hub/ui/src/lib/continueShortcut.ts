/**
 * The DOM half of the Continue shortcut (Alt/Shift+C by default): find the
 * Continue button a step held at its manual-review gate is showing, and press
 * it. The pressing itself — click the real button, skip a disabled one, take
 * the first in document order — is `pressShortcutButton` in shortcutButtons.ts,
 * shared with the Start shortcut; what belongs to Continue alone is which
 * attribute identifies its button.
 *
 * Two consequences of pressing the real button, both of them the point:
 *
 * - **No button, no effect.** The Continue button only exists while a step is
 *   `waiting` (see StepItem), so with nothing held the shortcut is inert rather
 *   than firing a request the server would refuse.
 * - **A disabled button is not pressed.** `disabled` is how the UI says "a
 *   mutation is already in flight"; a real click would do nothing there, and so
 *   does this. It moves on to the next candidate instead, in document order.
 *
 * The structural types (no `HTMLButtonElement`/`Document`) come from
 * shortcutButtons.ts for the same reason they were written that way: the hub's
 * node:test suite exercises this against a stub root, with no DOM in sight (see
 * hub/continue-shortcut.test.ts).
 */

import {
	isTypingTarget,
	pressShortcutButton,
	type ShortcutButton,
	type ShortcutButtonRoot,
	type ShortcutEventTarget,
} from "./shortcutButtons.ts";

/** The stable hook the Continue button carries; CSS Module names are hashed. */
export const CONTINUE_BUTTON_SELECTOR = "[data-continue-step]";

/**
 * Presses the first enabled Continue button in `root`, and reports whether one
 * was found. Document order is the tie-break — a workflow holds at one gate at
 * a time, so in practice there is at most one, but "the first one you can see"
 * is the deterministic reading of a shortcut that stands in for a click.
 */
export function pressContinueButton(root: ContinueButtonRoot): boolean {
	return pressShortcutButton(root, CONTINUE_BUTTON_SELECTOR);
}

// The names this module has always exported, kept as aliases of the shared
// structural types so callers and tests don't have to care where they moved.
export type ContinueButton = ShortcutButton;
export type ContinueButtonRoot = ShortcutButtonRoot;
export { isTypingTarget, type ShortcutEventTarget };
