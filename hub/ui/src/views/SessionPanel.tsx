import type { SessionInfo } from "../api/types.ts";
import styles from "./DetailPanels.module.css";
import { UsageMeter } from "./UsageMeter.tsx";

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
	adoptedSessionId,
	canOpen,
	onOpenTerminal,
	opening,
}: {
	info: SessionInfo | null;
	/**
	 * Set when this workflow was created to continue one of the operator's own
	 * conversations. Worth saying here and nowhere else: it's the difference
	 * between a session the hub started and one that existed before the workflow,
	 * which is what "Open conversation" will show — the steps, below history the
	 * hub never wrote.
	 */
	adoptedSessionId: string | null;
	canOpen: boolean;
	onOpenTerminal: () => void;
	opening: boolean;
}): React.JSX.Element {
	const usage = info?.usage ?? null;
	// Already compacted at least once: the conversation the steps share has lost
	// its earlier turns. The hub recovers by re-injecting the workflow's
	// conversation context on the next step, but this is the panel where an
	// operator finds out it happened at all.
	const compactedAt = info?.lastCompactionAt ?? usage?.lastCompactionAt ?? null;

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

			{adoptedSessionId && (
				<p className="hint">
					This workflow continues a conversation you were already having — its steps run in that conversation, on top of
					everything said in it before the workflow existed. A restart goes back to it rather than starting a blank
					session.
				</p>
			)}

			{!info?.sessionId ? (
				<p className="hint">
					{adoptedSessionId
						? "No step has run yet. The first one resumes the adopted conversation."
						: "No session yet. The first step's callback reports one."}
				</p>
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

					{compactedAt && (
						<p className="hint">
							This conversation was compacted on {new Date(compactedAt).toLocaleString()} — its earlier turns are now a
							summary.{" "}
							{info?.compactionPending
								? "The workflow's conversation context will be re-stated on the next step."
								: "The workflow's conversation context has been re-stated since."}{" "}
							Each completed step's full result is also on disk, under <code>~/.target/steps/</code>.
						</p>
					)}

					{usage && <UsageMeter usage={usage} />}
				</>
			)}
		</section>
	);
}
