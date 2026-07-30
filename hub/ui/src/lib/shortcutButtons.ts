/**
 * The mechanism the button-pressing shortcuts share: find a button that is
 * already on screen and press it — literally, by calling `click()` on the
 * button itself, so the keystroke goes through the very same handler, toast and
 * busy-state the mouse would. Nothing here talks to the API: the button already
 * knows how.
 *
 * Two consequences of pressing the real button, and both of them are the point:
 *
 * - **No button, no effect.** A shortcut whose button isn't rendered right now
 *   is inert rather than firing a request the server would refuse.
 * - **A disabled button is not pressed.** `disabled` is how the UI says "this
 *   can't be done right now" — a mutation already in flight, an empty selection,
 *   a status with no such action. A real click would do nothing there, and so
 *   does this. It moves on to the next candidate instead, in document order.
 *
 * The types are structural rather than `HTMLButtonElement`/`Document` so this
 * module carries no DOM lib dependency and can be exercised by the hub's
 * node:test suite (see hub/continue-shortcut.test.ts and hub/start-shortcut.test.ts)
 * against a stub root — the real `document` satisfies them at the call sites in
 * useKeyboardShortcuts.
 *
 * The per-shortcut selectors and wrappers live next door in continueShortcut.ts
 * and startShortcut.ts: each shortcut owns the attribute it selects on, this
 * module owns what "press it" means.
 */

/** As much of a button as pressing one needs. */
export interface ShortcutButton {
	disabled: boolean;
	click: () => void;
}

/** As much of a document as finding those buttons needs. */
export interface ShortcutButtonRoot {
	querySelectorAll: (selector: string) => Iterable<ShortcutButton>;
}

/**
 * Presses the first ENABLED button matching `selector` in `root`, and reports
 * whether one was found. Document order is the tie-break: a shortcut stands in
 * for a click, and "the first one you can see" is the only reading of that which
 * stays deterministic when more than one candidate is on screen.
 */
export function pressShortcutButton(root: ShortcutButtonRoot, selector: string): boolean {
	for (const button of root.querySelectorAll(selector)) {
		if (button.disabled) continue;
		button.click();
		return true;
	}
	return false;
}

/** As much of an event target as the typing check needs. */
export interface ShortcutEventTarget {
	tagName?: string;
	isContentEditable?: boolean;
}

/**
 * Whether the keystroke landed in something the operator is typing into.
 *
 * Shift+<letter> is also how you type a capital letter, so the shortcuts that
 * commit something have to stay out of text entry: typing "Continue" into a step
 * description must not approve the step being described, and typing "Start" into
 * one must not launch the run. Fields are the common case; contenteditable
 * covers the rich-text inputs, and a `<select>` is included because a letter
 * there is a jump-to-option, not a spare keystroke.
 */
export function isTypingTarget(target: ShortcutEventTarget | null | undefined): boolean {
	if (!target) return false;
	if (target.isContentEditable) return true;
	const tag = (target.tagName ?? "").toUpperCase();
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
