import { useIsMobile } from "../hooks/useIsMobile.ts";
import type { Dictation, DictationLang } from "../hooks/useDictation.ts";
import styles from "./VoiceDock.module.css";

/**
 * Floating dictation control. The mic suppresses `mousedown` so clicking it
 * doesn't move focus out of the field being dictated into — the hook targets
 * the last focused editable element, and stealing focus here would leave it
 * with nowhere to write.
 *
 * On a phone it stays hidden until some text field has been focused. A desktop
 * has room to park a dock in a corner indefinitely; a phone screen doesn't, and
 * while you're reading a list of workflows the mic has nothing to dictate into
 * anyway — it would be a floating button whose only function is to cover the
 * bottom row. Once there's somewhere to write, it appears and stays.
 */
export function VoiceDock({ dictation }: { dictation: Dictation }): React.JSX.Element | null {
	const { supported, listening, hasTarget, lang, setLang, toggle, hint, hintIsError } = dictation;
	const isMobile = useIsMobile();

	if (isMobile && !hasTarget) return null;

	return (
		<div className={styles.dock}>
			{hint && <span className={`${styles.hint} ${hintIsError ? styles.hintError : ""}`}>{hint}</span>}

			<select
				className={styles.lang}
				value={lang}
				onChange={(ev) => setLang(ev.target.value as DictationLang)}
				title="Dictation language"
				aria-label="Dictation language"
				disabled={!supported}
			>
				<option value="en-US">EN</option>
				<option value="es-ES">ES</option>
			</select>

			<button
				type="button"
				className={`${styles.mic} ${listening ? styles.listening : ""}`}
				onMouseDown={(ev) => ev.preventDefault()}
				onClick={toggle}
				disabled={!supported}
				title={
					supported
						? listening
							? "Listening… click to stop."
							: "Dictate into the focused field"
						: "Speech recognition is not supported by this browser (try Chrome/Edge)."
				}
				aria-label={listening ? "Stop dictation" : "Dictate into the focused field"}
				aria-pressed={listening}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
					<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
					<line x1="12" y1="19" x2="12" y2="23" />
					<line x1="8" y1="23" x2="16" y2="23" />
				</svg>
			</button>
		</div>
	);
}
