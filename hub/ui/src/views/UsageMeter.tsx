import type { TokenUsage } from "../api/types.ts";
import { compactNumber } from "../lib/format.ts";
import styles from "./DetailPanels.module.css";

/**
 * How full the context window is, as a percentage. `contextWindow` is the
 * window of the model this session actually ran on (the hub derives it from the
 * transcript — see hub/models.ts), not a fixed 200k: against the old assumed
 * one a 1M-context session read as permanently over 100% and the meter said
 * nothing at all.
 */
export function contextPercent(usage: TokenUsage): number {
	return usage.contextWindow > 0 ? (100 * usage.contextTokens) / usage.contextWindow : 0;
}

/**
 * The session's token usage, exactly as the operator's own client states it:
 * a `Context <used> / <window>` bar with the percentage, then
 * `<n> turns · in <x> · out <y> · incl. subagents`.
 *
 * It lives in its own component because it is rendered in two places on the
 * workflow detail page — under the steps, where an operator is looking at the
 * run, and in the Conversation panel, where they are looking at the session —
 * and the whole point of this readout is that it agrees, digit for digit, with
 * what the client reports. Two copies of the markup would eventually disagree.
 *
 * `in` is `totalInputTokens`: new input + cache creation + cache read. The bare
 * `inputTokens` field is near-zero once prompt caching is on (one real session
 * here: 416 uncached against 16,015,192 total), so quoting it would put a
 * rounding error where the client puts 16.0M.
 */
export function UsageMeter({ usage }: { usage: TokenUsage }): React.JSX.Element {
	const pct = contextPercent(usage);

	// Warn as the context window fills — past ~90% a resumed session is close
	// to compaction, which is worth seeing before starting more steps.
	const meterClass = pct >= 90 ? styles.meterDanger : pct >= 70 ? styles.meterWarn : "";

	return (
		<div className={styles.usage} data-usage-meter>
			<div className={styles.usageHead}>
				{/* The window is per-model, so name the model it belongs to — otherwise
				    the same session showing "of 1M" one day and "of 200k" the next
				    (because the operator switched models) looks like a bug. */}
				<span title={usage.model ? `window for ${usage.model}` : "no model reported yet — assuming the fallback window"}>
					Context {compactNumber(usage.contextTokens)} / {compactNumber(usage.contextWindow)}
				</span>
				<span className={styles.usagePct}>{pct.toFixed(1)}%</span>
			</div>
			<div className={`${styles.meter} ${meterClass}`}>
				<div className={styles.meterFill} style={{ width: `${Math.min(100, pct)}%` }} />
			</div>
			<p className={styles.usageTotals}>
				{usage.turns} turns · in {compactNumber(usage.totalInputTokens)} · out {compactNumber(usage.outputTokens)}
				{usage.includesSubagents && " · incl. subagents"}
			</p>
		</div>
	);
}
