import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dictation into whichever text field the operator last focused, via the Web
 * Speech API (Chrome/Edge only — Firefox and Safari don't ship it).
 *
 * Two details carried over from the previous UI because they're what make it
 * usable rather than a novelty:
 *
 * - **It writes into the last focused field, not a fixed one.** Clicking the
 *   mic moves focus, so the target is captured on `focusin` beforehand and the
 *   mic button itself suppresses `mousedown` to avoid stealing focus.
 * - **Interim results replace, they don't append.** The caret range captured
 *   at start plus the text committed so far define a region that each new
 *   result overwrites, so live transcription doesn't leave duplicated
 *   fragments behind as the engine revises its guess.
 *
 * Values are written straight to the DOM node and followed by a synthetic
 * `input` event, which is what makes React's onChange fire and keeps
 * controlled components in sync.
 */

export type DictationLang = "en-US" | "es-ES";

const LANG_KEY = "targetVoiceLang";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

/** Anything dictation can write into: form fields or a contenteditable host
 * (the rich-text popup editor is a contenteditable div, not a textarea). */
type DictationTarget = EditableElement | HTMLElement;

const DICTATABLE_INPUT_TYPES = ["text", "password", "number", "search", "email", "url", "tel"];

function isEditable(el: EventTarget | null): el is DictationTarget {
	if (!(el instanceof HTMLElement)) return false;
	if (el instanceof HTMLTextAreaElement) return true;
	if (el instanceof HTMLInputElement) return DICTATABLE_INPUT_TYPES.includes((el.type || "text").toLowerCase());
	// contenteditable surfaces (e.g. the rich-text popup editor). True for any
	// element inside an editable host, which is fine — insertion goes through
	// a dedicated text node planted at the caret, not the element reference.
	return el.isContentEditable;
}

/**
 * The browser's SpeechRecognition constructor, if any. Typed structurally
 * because `lib.dom` still doesn't declare it and the vendor-prefixed name is
 * the only one Chrome exposes.
 */
interface SpeechRecognitionLike extends EventTarget {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	start(): void;
	stop(): void;
	onstart: (() => void) | null;
	onend: (() => void) | null;
	onerror: ((ev: { error: string }) => void) | null;
	onresult: ((ev: SpeechResultEvent) => void) | null;
}

interface SpeechResultEvent {
	resultIndex: number;
	results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
	const w = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERROR_MESSAGES: Record<string, string> = {
	"no-speech": "No speech detected.",
	"audio-capture": "No microphone found.",
	"not-allowed": "Microphone permission denied.",
	"service-not-allowed": "Speech service not allowed.",
};

function readSavedLang(): DictationLang {
	try {
		const saved = localStorage.getItem(LANG_KEY);
		return saved === "es-ES" || saved === "en-US" ? saved : "en-US";
	} catch {
		return "en-US";
	}
}

export interface Dictation {
	supported: boolean;
	listening: boolean;
	/**
	 * Whether a text field has been focused, i.e. whether the mic has anywhere to
	 * write. Lets the dock stay out of the way until it's actually usable — it
	 * costs nothing on a desktop, but on a phone a floating control that can only
	 * say "click a text field first" is just something covering the page.
	 */
	hasTarget: boolean;
	lang: DictationLang;
	setLang: (lang: DictationLang) => void;
	toggle: () => void;
	/** Transient status/error text for the dock; cleared automatically. */
	hint: string;
	hintIsError: boolean;
}

export function useDictation(): Dictation {
	const [supported] = useState(() => getSpeechRecognition() !== null);
	const [listening, setListening] = useState(false);
	const [lang, setLangState] = useState<DictationLang>(readSavedLang);
	const [hint, setHint] = useState("");
	const [hintIsError, setHintIsError] = useState(false);
	const [hasTarget, setHasTarget] = useState(false);

	const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
	const lastFieldRef = useRef<DictationTarget | null>(null);
	// Target field and the replace region for the current dictation session.
	const targetRef = useRef<DictationTarget | null>(null);
	const insertStartRef = useRef(0);
	const insertEndRef = useRef(0);
	const committedRef = useRef("");
	// For contenteditable targets: a dedicated text node at the caret that each
	// recognition result rewrites, so interim guesses replace instead of append.
	const ceNodeRef = useRef<Text | null>(null);
	const hintTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const showHint = useCallback((text: string, isError = false) => {
		setHint(text);
		setHintIsError(isError);
		clearTimeout(hintTimerRef.current);
		if (text) hintTimerRef.current = setTimeout(() => setHint(""), 4000);
	}, []);

	// Track the last editable field so the mic knows where to write.
	useEffect(() => {
		const onFocusIn = (ev: FocusEvent): void => {
			if (!isEditable(ev.target)) return;
			lastFieldRef.current = ev.target;
			// Latched rather than cleared on blur: pressing the mic necessarily
			// takes focus off the field, and a control that disappears as you reach
			// for it is worse than one that lingers.
			setHasTarget(true);
		};
		document.addEventListener("focusin", onFocusIn);
		return () => document.removeEventListener("focusin", onFocusIn);
	}, []);

	useEffect(() => {
		return () => {
			clearTimeout(hintTimerRef.current);
			try {
				recognitionRef.current?.stop();
			} catch {
				// Already stopped/never started — nothing to clean up.
			}
		};
	}, []);

	const setLang = useCallback((next: DictationLang) => {
		setLangState(next);
		try {
			localStorage.setItem(LANG_KEY, next);
		} catch {
			// Storage disabled — the choice just won't survive a reload.
		}
		if (recognitionRef.current) recognitionRef.current.lang = next;
	}, []);

	/**
	 * Writes `text` over the current replace region. React controlled inputs
	 * ignore direct `.value` assignment, so the value is set through the
	 * prototype's native setter and followed by a bubbling `input` event —
	 * that's what React's synthetic onChange listens to.
	 */
	const insertText = useCallback((text: string, isFinal: boolean) => {
		const target = targetRef.current;
		if (!target) return;

		// contenteditable target: rewrite the dedicated text node in place.
		const ceNode = ceNodeRef.current;
		if (ceNode) {
			ceNode.data = committedRef.current + text;
			const selection = window.getSelection();
			if (selection) {
				const range = document.createRange();
				range.setStart(ceNode, ceNode.data.length);
				range.collapse(true);
				selection.removeAllRanges();
				selection.addRange(range);
			}
			target.dispatchEvent(new Event("input", { bubbles: true }));
			if (isFinal) committedRef.current += text;
			return;
		}

		if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;

		const before = target.value.slice(0, insertStartRef.current);
		const after = target.value.slice(insertEndRef.current);
		const next = before + committedRef.current + text + after;

		const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		if (setter) setter.call(target, next);
		else target.value = next;

		const caret = insertStartRef.current + committedRef.current.length + text.length;
		try {
			target.setSelectionRange(caret, caret);
		} catch {
			// number inputs don't support selection ranges — safe to ignore.
		}
		target.dispatchEvent(new Event("input", { bubbles: true }));

		// Advance the region past what we just wrote (final or interim) so the
		// next result overwrites it instead of appending after a stale copy.
		insertEndRef.current = insertStartRef.current + committedRef.current.length + text.length;
		if (isFinal) committedRef.current += text;
	}, []);

	const start = useCallback(() => {
		const Ctor = getSpeechRecognition();
		if (!Ctor) return;

		const field = lastFieldRef.current;
		if (!field || !document.body.contains(field)) {
			showHint("Click a text field first, then the mic.", true);
			return;
		}

		targetRef.current = field;
		committedRef.current = "";
		ceNodeRef.current = null;

		if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
			insertStartRef.current = typeof field.selectionStart === "number" ? field.selectionStart : field.value.length;
			insertEndRef.current = typeof field.selectionEnd === "number" ? field.selectionEnd : field.value.length;
		} else {
			// contenteditable: plant an empty text node at the caret (replacing any
			// selection), or at the end when the selection lives elsewhere. Every
			// recognition result rewrites this node.
			const node = document.createTextNode("");
			const selection = window.getSelection();
			let range: Range;
			if (selection && selection.rangeCount > 0 && field.contains(selection.getRangeAt(0).startContainer)) {
				range = selection.getRangeAt(0);
				range.deleteContents();
			} else {
				range = document.createRange();
				range.selectNodeContents(field);
				range.collapse(false);
			}
			range.insertNode(node);
			ceNodeRef.current = node;
		}

		const recognition = new Ctor();
		recognition.lang = lang;
		recognition.continuous = true;
		recognition.interimResults = true;

		recognition.onstart = () => setListening(true);
		recognition.onresult = (ev) => {
			let interim = "";
			let finalText = "";
			for (let i = ev.resultIndex; i < ev.results.length; i++) {
				const result = ev.results[i];
				if (!result) continue;
				if (result.isFinal) finalText += result[0].transcript;
				else interim += result[0].transcript;
			}
			if (finalText) insertText(finalText, true);
			if (interim) insertText(interim, false);
		};
		recognition.onerror = (ev) => showHint(ERROR_MESSAGES[ev.error] ?? `Recognition error: ${ev.error}`, true);
		recognition.onend = () => {
			setListening(false);
			recognitionRef.current = null;
		};

		recognitionRef.current = recognition;
		try {
			recognition.start();
		} catch (err) {
			showHint(`Could not start dictation: ${err instanceof Error ? err.message : String(err)}`, true);
			recognitionRef.current = null;
		}
	}, [lang, insertText, showHint]);

	const toggle = useCallback(() => {
		if (recognitionRef.current) {
			try {
				recognitionRef.current.stop();
			} catch {
				// Racing with onend — the handler already cleared the ref.
			}
			return;
		}
		start();
	}, [start]);

	return { supported, listening, hasTarget, lang, setLang, toggle, hint, hintIsError };
}
