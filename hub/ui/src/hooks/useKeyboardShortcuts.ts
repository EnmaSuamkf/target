import { useEffect, useRef } from "react";
import type { View } from "../components/Header.tsx";
import type { ShortcutAction, ShortcutBinding } from "../api/types.ts";
import { isTypingTarget, pressContinueButton } from "../lib/continueShortcut.ts";
import { pressStartButton } from "../lib/startShortcut.ts";
import type { Dictation } from "./useDictation.ts";

/**
 * Global keyboard shortcuts. Five actions — each bound to a configurable
 * letter and usable with either Alt or Shift — let an operator drive the hub
 * without reaching for the mouse:
 *
 * - **focusWorkflow** — focus the first workflow in the list, so keyboard
 *   navigation starts at the top. When a search/filter has narrowed the list to
 *   nothing, it falls back to the search box so the shortcut still lands
 *   somewhere useful (clear the filter, try again). Default key: W.
 * - **toggleDictation** — toggle dictation into whichever field last had focus.
 *   Press the combo to start recording (the same start as the VoiceDock's mic),
 *   press it again to stop — a plain toggle, not a hold. Default key: R.
 * - **createWorkflow** — open the create-workflow modal, the same as the "New"
 *   button. Default key: N.
 * - **continueStep** — press the Continue button of the step held at its
 *   manual-review gate, by clicking the button itself (see
 *   lib/continueShortcut.ts), so approving a hold is one keystroke instead of a
 *   trip to the mouse. With no such button on screen — no step waiting, or a
 *   Continue already in flight and therefore disabled — the combo does nothing
 *   at all. Default key: C.
 * - **startWorkflow** — press the open workflow's run button (Start, or Resume
 *   / Start over when that's what the same button reads), again by clicking the
 *   button itself (see lib/startShortcut.ts). The button's own `disabled` is the
 *   only condition: no workflow open, nothing selected, a run already going, a
 *   step held for review — in all of those the combo does nothing at all.
 *   Default key: S.
 *
 * Which letter fires which action is configured in the Settings view and
 * persisted by the hub (see `ShortcutSettings` in api/types.ts). The bindings
 * are read through a ref, so the listener is attached once and always sees the
 * latest values — the same trick `usePolling` uses, and it matters here both
 * because the app re-renders every 2s on the poll and because a saved change
 * to the bindings takes effect on the next keydown without re-attaching the
 * listener.
 *
 * Exactly one of Alt or Shift must be held (never both): Alt+Shift is left for
 * layout switching on some systems and Ctrl/Cmd is left for the OS and window
 * manager. `repeat`/IME-composing keydowns are ignored, so holding a combo
 * fires it once — for dictation that means a held key toggles a single time
 * rather than streaming starts and stops. Every shortcut except dictation also
 * skips while a modal dialog is open, so they don't fight the dialog's own
 * focus handling; dictation is left alone because a dialog's text fields are
 * exactly where you might want to dictate.
 *
 * Continue and Start additionally ignore keystrokes aimed at a text field:
 * Shift+C and Shift+S are how a capital C and S are typed, and approving
 * someone's held step — or launching a run — because they wrote "Continue" or
 * "Start" in a description would be the worst kind of surprise. The other three
 * keep the older behaviour rather than being changed here — none of them
 * commits anything.
 */

export interface KeyboardShortcutHandlers {
	view: View;
	dictation: Dictation;
	onCreateWorkflow: () => void;
	/** Configured key per action; defaults to W/R/N/C/S when nothing is saved yet. */
	bindings: Record<ShortcutAction, ShortcutBinding>;
}

const WORKFLOW_LIST_SELECTOR = "[data-workflow-list]";
const WORKFLOW_CARD_SELECTOR = "[data-workflow-card]";
const WORKFLOW_SEARCH_SELECTOR = "[data-workflow-search]";

const WORKFLOW_RAIL_SELECTOR = "[data-workflow-rail]";

/**
 * Bring a card into view **sideways only**, by moving its scroll container's
 * `scrollLeft`. `scrollIntoView` would do this too, but it also scrolls every
 * ancestor — including the document — and the workflows view is meant to sit at
 * the top of the page at all times. On the "All workflows" page (a grid, no
 * rail) there is nothing to scroll, so this is a no-op there.
 */
function scrollRailToCard(card: HTMLElement): void {
	const rail = card.closest<HTMLElement>(WORKFLOW_RAIL_SELECTOR);
	if (!rail) return;
	// Rects rather than `offsetLeft`, which is measured against whichever
	// ancestor happens to be positioned and so isn't reliably rail-relative.
	const left = card.getBoundingClientRect().left - rail.getBoundingClientRect().left + rail.scrollLeft;
	const right = left + card.getBoundingClientRect().width;
	if (left < rail.scrollLeft) rail.scrollLeft = left;
	else if (right > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = right - rail.clientWidth;
}

/** A modal dialog (create/confirm) is currently on screen. */
function modalOpen(): boolean {
	return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

export function useKeyboardShortcuts({ view, dictation, onCreateWorkflow, bindings }: KeyboardShortcutHandlers): void {
	const handlersRef = useRef({ view, dictation, onCreateWorkflow, bindings });
	handlersRef.current = { view, dictation, onCreateWorkflow, bindings };

	useEffect(() => {
		const onKeyDown = (ev: KeyboardEvent): void => {
			// Bare Alt or bare Shift combos only: exactly one of Alt/Shift must be
			// held. Ignore Alt+Shift (layout switching on some systems) and
			// Ctrl/Cmd (the OS and window manager grab those), as well as auto-repeat
			// and IME compose, so a held key fires the action exactly once.
			if ((Number(ev.altKey) + Number(ev.shiftKey)) !== 1 || ev.ctrlKey || ev.metaKey || ev.repeat || ev.isComposing) {
				return;
			}

			const key = ev.key.toLowerCase();
			const { view: currentView, dictation: d, onCreateWorkflow: create, bindings: currentBindings } = handlersRef.current;

			// Resolve the pressed key to an action via the configured bindings. Two
			// actions can't share a key (the route rejects it), so the first match is
			// the only match — but iterate rather than early-return so a malformed
			// binding set still picks a deterministic action.
			let action: ShortcutAction | null = null;
			for (const candidate of [
				"focusWorkflow",
				"toggleDictation",
				"createWorkflow",
				"continueStep",
				"startWorkflow",
			] as ShortcutAction[]) {
				if (currentBindings[candidate]?.key === key) {
					action = candidate;
					break;
				}
			}
			if (!action) return;
			// Checked before preventDefault so a capital C or S still types as one:
			// the shortcut declines the keystroke rather than swallowing it. Only the
			// two actions that commit something need it — the others are harmless.
			if (
				(action === "continueStep" || action === "startWorkflow") &&
				isTypingTarget(ev.target as HTMLElement | null)
			) {
				return;
			}
			ev.preventDefault();

			switch (action) {
				case "toggleDictation": {
					// Toggle dictation: press to start, press again to stop — the same
					// toggle as the mic button. The modifier guard above rejected
					// auto-repeat, so holding the key fires it once rather than streaming.
					if (!d.supported) return;
					d.toggle();
					return;
				}

				case "createWorkflow": {
					// Open the create-workflow modal (same as the "New" button).
					if (currentView !== "workflows" || modalOpen()) return;
					create();
					return;
				}

				case "continueStep": {
					// Click the held step's own Continue button, so the keystroke and
					// the mouse take exactly the same path. Silently a no-op when there
					// is no enabled one on screen — which is most of the time.
					if (currentView !== "workflows" || modalOpen()) return;
					pressContinueButton({
						querySelectorAll: (selector) => document.querySelectorAll<HTMLButtonElement>(selector),
					});
					return;
				}

				case "startWorkflow": {
					// Click the open workflow's own run button, so the keystroke and the
					// mouse take exactly the same path — including which of
					// start/resume/restart that button decided to call. Silently a no-op
					// when there is no enabled one on screen: no workflow open, no steps
					// selected, or nothing to start in this status.
					if (currentView !== "workflows" || modalOpen()) return;
					pressStartButton({
						querySelectorAll: (selector) => document.querySelectorAll<HTMLButtonElement>(selector),
					});
					return;
				}

				case "focusWorkflow": {
					// Focus the first workflow in the list; fall back to the search
					// box when there are no cards to focus (e.g. a filter with no
					// matches), so the shortcut still does something useful.
					if (currentView !== "workflows" || modalOpen()) return;
					const list = document.querySelector(WORKFLOW_LIST_SELECTOR);
					if (!list) return;
					const first = list.querySelector<HTMLElement>(WORKFLOW_CARD_SELECTOR);
					if (first) {
						// `preventScroll` + a horizontal-only nudge of the rail: the page
						// itself must stay at the top (the workflows view is rendered from
						// the top and never scrolls itself), while the rail — which scrolls
						// sideways — still brings the focused card into view. The list
						// lives at the top of the view, so putting the window back there
						// is what makes the card visible; `scrollIntoView` would instead
						// scroll the page to wherever the card happened to be.
						first.focus({ preventScroll: true });
						window.scrollTo({ top: 0, left: 0 });
						scrollRailToCard(first);
						return;
					}
					list.querySelector<HTMLInputElement>(WORKFLOW_SEARCH_SELECTOR)?.focus();
					return;
				}
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}
