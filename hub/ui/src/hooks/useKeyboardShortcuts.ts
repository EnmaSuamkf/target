import { useEffect, useRef } from "react";
import type { View } from "../components/Header.tsx";
import type { Dictation } from "./useDictation.ts";

/**
 * Global keyboard shortcuts. Three combos — each usable with either Alt or
 * Shift — let an operator drive the hub without reaching for the mouse:
 *
 * - **Alt+W** / **Shift+W** — focus the first workflow in the list, so keyboard
 *   navigation starts at the top. When a search/filter has narrowed the list to
 *   nothing, it falls back to the search box so the shortcut still lands
 *   somewhere useful (clear the filter, try again).
 * - **Alt+R** / **Shift+R** — start dictating into whichever field last had
 *   focus, the same action as the VoiceDock's mic. It *starts* — it does not
 *   toggle, so pressing it again while already listening is a no-op rather than
 *   a stop.
 * - **Alt+N** / **Shift+N** — open the create-workflow modal, the same as the
 *   "New" button.
 *
 * The handlers are read through a ref so the listener is attached once and
 * always sees the latest props — the same trick `usePolling` uses to spare
 * callers from memoising an inline callback that would otherwise restart the
 * effect on every render (and this app re-renders every 2s on the poll).
 *
 * Exactly one of Alt or Shift must be held (never both): Alt+Shift is left for
 * layout switching on some systems and Ctrl/Cmd is left for the OS and window
 * manager. `repeat`/IME-composing keydowns are ignored so holding a combo
 * doesn't toggle dictation on and off or reopen a modal. The list and create
 * shortcuts also skip while a modal dialog is open, so they don't fight the
 * dialog's own focus handling; dictation is left alone because a dialog's text
 * fields are exactly where you might want to dictate.
 */

export interface KeyboardShortcutHandlers {
	view: View;
	dictation: Dictation;
	onCreateWorkflow: () => void;
}

const WORKFLOW_LIST_SELECTOR = "[data-workflow-list]";
const WORKFLOW_CARD_SELECTOR = "[data-workflow-card]";
const WORKFLOW_SEARCH_SELECTOR = "[data-workflow-search]";

/** A modal dialog (create/confirm) is currently on screen. */
function modalOpen(): boolean {
	return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

export function useKeyboardShortcuts({ view, dictation, onCreateWorkflow }: KeyboardShortcutHandlers): void {
	const handlersRef = useRef({ view, dictation, onCreateWorkflow });
	handlersRef.current = { view, dictation, onCreateWorkflow };

	useEffect(() => {
		const onKeyDown = (ev: KeyboardEvent): void => {
			// Bare Alt or bare Shift combos only: exactly one of Alt/Shift must be
			// held. Ignore Alt+Shift (layout switching on some systems) and
			// Ctrl/Cmd (the OS and window manager grab those), as well as auto-repeat
			// and IME compose, so a held key fires the action exactly once.
			if ((Number(ev.altKey) + Number(ev.shiftKey)) !== 1 || ev.ctrlKey || ev.metaKey || ev.repeat || ev.isComposing) {
				return;
			}

			switch (ev.key.toLowerCase()) {
				case "r": {
					// Start dictation into the last-focused field. Leaves a running
					// session alone — the shortcut starts, it doesn't toggle.
					ev.preventDefault();
					const { dictation: d } = handlersRef.current;
					if (!d.supported || d.listening) return;
					d.toggle();
					return;
				}

				case "n": {
					// Open the create-workflow modal (same as the "New" button).
					ev.preventDefault();
					if (handlersRef.current.view !== "workflows" || modalOpen()) return;
					handlersRef.current.onCreateWorkflow();
					return;
				}

				case "w": {
					// Focus the first workflow in the list; fall back to the search
					// box when there are no cards to focus (e.g. a filter with no
					// matches), so the shortcut still does something useful.
					ev.preventDefault();
					if (handlersRef.current.view !== "workflows" || modalOpen()) return;
					const list = document.querySelector(WORKFLOW_LIST_SELECTOR);
					if (!list) return;
					const first = list.querySelector<HTMLElement>(WORKFLOW_CARD_SELECTOR);
					if (first) {
						first.focus();
						first.scrollIntoView({ block: "nearest" });
						return;
					}
					list.querySelector<HTMLInputElement>(WORKFLOW_SEARCH_SELECTOR)?.focus();
					return;
				}

				default:
					return;
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}
