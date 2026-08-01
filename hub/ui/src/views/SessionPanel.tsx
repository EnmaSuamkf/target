import type { SessionInfo } from "../api/types.ts";
import { compactNumber } from "../lib/format.ts";
import styles from "./DetailPanels.module.css";

/**
 * The workflow's shared Claude session: harness, session id, token usage, and
 * the button that opens a real terminal already `cd`'d into the workdir running
 * that harness's resume command.
 *
 * Token usage is rendered as a meter because the number that actually matters
 * is context used against the window — a bare "142k" says nothing about how
 * close the conversation is to the limit.
 */
export function SessionPanel({
	info,
	canOpen,
	onOpenTerminal,
	opening,
}: {
	info: SessionInfo | null;
	canOpen: boolean;
	onOpenTerminal: () => void;
	opening: boolean;
}): React.JSX.Element {
	const usage = info?.usage ?? null;
	const pct = usage && usage.contextWindow > 0 ? (100 * usage.contextTokens) / usage.contextWindow : 0;

	// Warn as the context window fills — past ~90% a resumed session is close
	// to compaction, which is worth seeing before starting more steps.
	const meterClass = pct >= 90 ? styles.meterDanger : pct >= 70 ? styles.meterWarn : "";

	// Past this the hub overrides every step's "run inline" toggle and delegates
	// to a subagent anyway (CONTEXT_PRESSURE_RATIO in hub/context-pressure.ts —
	// kept in sync by hand, since the UI doesn't import server modules). This is
	// the panel that already shows the number the rule is about, so it's where an
	// operator should find out their toggle is no longer being honoured.
	const pressured = pct > 60;

	return (
		<section className={styles.block}>
			<div className={styles.blockHead}>
				<h3 className={styles.blockTitle}>Conversation</h3>
				<button
					type="button"
					className="btn btn--sm"
					onClick={onOpenTerminal}
					disabled={!canOpen || opening}
					title={
						canOpen
							? info?.sandbox === "docker"
								? "Opens a terminal on this machine running `docker run -it …` in the same container image the steps used, resuming this session."
								: "Opens a terminal on this machine, cd'd into the workflow's workdir, resuming this session."
							: "No session yet — run a step first."
					}
				>
					{opening ? "Opening…" : "Open conversation"}
				</button>
			</div>

			{!info?.sessionId ? (
				<p className="hint">No session yet. The first step's callback reports one.</p>
			) : (
				<>
					<dl className={styles.facts}>
						<div className={styles.fact}>
							<dt>Harness</dt>
							<dd>{info.harness ?? "unknown"}</dd>
						</div>
						<div className={styles.fact}>
							<dt>Sandbox</dt>
							<dd title={info.image ?? undefined}>{info.sandbox === "docker" ? `docker · ${info.image ?? "default image"}` : "this machine"}</dd>
						</div>
						<div className={styles.fact}>
							<dt>Session</dt>
							<dd className="mono" title={info.sessionId}>
								{info.sessionId}
							</dd>
						</div>
					</dl>

					{usage && usage.turns > 0 && (
						<div className={styles.usage}>
							<div className={styles.usageHead}>
								<span>
									Context {compactNumber(usage.contextTokens)} / {compactNumber(usage.contextWindow)}
								</span>
								<span className={styles.usagePct}>{pct.toFixed(1)}%</span>
							</div>
							<div className={`${styles.meter} ${meterClass}`}>
								<div className={styles.meterFill} style={{ width: `${Math.min(100, pct)}%` }} />
							</div>
							<p className={styles.usageTotals}>
								{usage.turns} turns · in {compactNumber(usage.totalInputTokens)} · out{" "}
								{compactNumber(usage.outputTokens)}
								{usage.includesSubagents && " · incl. subagents"}
							</p>
							{pressured && (
								<p className="hint">
									Over 60% — steps set to run inline are delegated to a subagent anyway, so this conversation doesn't
									fill up and degrade.
								</p>
							)}
						</div>
					)}
				</>
			)}
		</section>
	);
}
