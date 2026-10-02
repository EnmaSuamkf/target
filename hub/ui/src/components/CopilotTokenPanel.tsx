import { useCallback, useEffect, useRef, useState } from "react";
import {
	ApiError,
	deleteCopilotToken,
	getCopilotTokenStatus,
	saveCopilotToken,
	startGhLogin,
} from "../api/client.ts";
import type { CopilotTokenStatus } from "../api/types.ts";
import {
	GH_LOGIN_POLL_MS,
	describeTokenStatus,
	ghLoginFailureMessage,
	ghLoginPollOutcome,
} from "../lib/copilotToken.ts";
import styles from "./CopilotTokenPanel.module.css";

/**
 * The GitHub token a copilot + docker workflow needs, as the hub sees it: where
 * it was found (or that it was not) and the ways to provide one — sign in with
 * the GitHub CLI (the hub opens a terminal on this machine), paste a token, or
 * check again. It renders status text only: the API never returns a token, and
 * a pasted one lives in this component's state just until the PUT settles.
 */
export function CopilotTokenPanel({
	onStatusChange,
	notice,
	disabled = false,
}: {
	/** Called with every status this panel reads or changes (null while unreadable), so a parent can gate on it. */
	onStatusChange?: (status: CopilotTokenStatus | null) => void;
	/** A message from the server's structured 400, shown above the status. */
	notice?: string | null;
	disabled?: boolean;
}): React.JSX.Element {
	const [status, setStatus] = useState<CopilotTokenStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [readError, setReadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [waiting, setWaiting] = useState(false);
	const [pasting, setPasting] = useState(false);
	const [pasted, setPasted] = useState("");
	const [busy, setBusy] = useState(false);
	// Latest callback without re-triggering the load effect on every parent render.
	const report = useRef(onStatusChange);
	report.current = onStatusChange;
	const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

	const apply = useCallback((next: CopilotTokenStatus | null) => {
		setStatus(next);
		report.current?.(next);
	}, []);

	const read = useCallback(async (): Promise<CopilotTokenStatus | null> => {
		try {
			const next = await getCopilotTokenStatus();
			setReadError(null);
			apply(next);
			return next;
		} catch (err) {
			setReadError(err instanceof ApiError ? err.message : "Could not read the token status.");
			apply(null);
			return null;
		}
	}, [apply]);

	const stopPolling = useCallback(() => {
		if (pollTimer.current) clearInterval(pollTimer.current);
		pollTimer.current = null;
		setWaiting(false);
	}, []);

	useEffect(() => {
		let live = true;
		void read().finally(() => {
			if (live) setLoading(false);
		});
		return () => {
			live = false;
			if (pollTimer.current) clearInterval(pollTimer.current);
		};
	}, [read]);

	const checkAgain = async (): Promise<void> => {
		setActionError(null);
		setInfo(null);
		setBusy(true);
		try {
			await read();
		} finally {
			setBusy(false);
		}
	};

	const signIn = async (): Promise<void> => {
		setActionError(null);
		setInfo(null);
		setBusy(true);
		try {
			await startGhLogin();
		} catch (err) {
			setActionError(ghLoginFailureMessage(err));
			return;
		} finally {
			setBusy(false);
		}
		setWaiting(true);
		setInfo("A terminal was opened on this machine. Finish the GitHub sign-in there; this updates by itself.");
		const startedAt = Date.now();
		pollTimer.current = setInterval(() => {
			void read().then((next) => {
				const outcome = ghLoginPollOutcome(next, Date.now() - startedAt);
				if (outcome === "keep-waiting") return;
				stopPolling();
				setInfo(outcome === "found" ? null : "Still no token. Check again after signing in, or paste one instead.");
			});
		}, GH_LOGIN_POLL_MS);
	};

	const savePasted = async (): Promise<void> => {
		const value = pasted.trim();
		if (value === "") return;
		setActionError(null);
		setInfo(null);
		setBusy(true);
		try {
			apply(await saveCopilotToken(value));
			setPasting(false);
		} catch (err) {
			setActionError(err instanceof ApiError ? err.message : "Could not save the token.");
		} finally {
			// Success or failure, the value does not stay in memory.
			setPasted("");
			setBusy(false);
		}
	};

	const removeSaved = async (): Promise<void> => {
		setActionError(null);
		setInfo(null);
		setBusy(true);
		try {
			apply(await deleteCopilotToken());
		} catch (err) {
			setActionError(err instanceof ApiError ? err.message : "Could not remove the saved token.");
		} finally {
			setBusy(false);
		}
	};

	const view = status ? describeTokenStatus(status) : null;
	const off = disabled || busy;

	return (
		<div className={styles.panel} data-testid="copilot-token-panel">
			{notice && (
				<p className="msg msg--error" role="alert">
					{notice}
				</p>
			)}
			{loading ? (
				<p className="hint">Checking for a GitHub token…</p>
			) : readError ? (
				<p className="msg msg--error" role="alert">
					{readError}
				</p>
			) : view ? (
				<div className={`${styles.status} ${styles[view.tone]}`} role="status">
					<span className={styles.headline}>{view.headline}</span>
					{view.warning && <span className={styles.detail}>{view.warning}</span>}
					{view.error && (
						<span className={styles.detail} role="alert">
							{view.error}
						</span>
					)}
				</div>
			) : null}

			{info && (
				<p className="hint" role="status">
					{info}
				</p>
			)}
			{actionError && (
				<p className="msg msg--error" role="alert">
					{actionError}
				</p>
			)}

			{pasting && (
				<div className={styles.paste}>
					<input
						type="password"
						className="input"
						autoComplete="off"
						spellCheck={false}
						aria-label="GitHub token"
						placeholder="github_pat_… or gho_…"
						value={pasted}
						disabled={off}
						onChange={(ev) => setPasted(ev.target.value)}
					/>
					<button
						type="button"
						className="btn btn--primary"
						disabled={off || pasted.trim() === ""}
						onClick={() => void savePasted()}
					>
						Save token
					</button>
					<button
						type="button"
						className="btn btn--ghost"
						disabled={busy}
						onClick={() => {
							setPasting(false);
							setPasted("");
						}}
					>
						Cancel
					</button>
				</div>
			)}

			<div className={styles.actions}>
				{waiting ? (
					<button type="button" className="btn btn--sm" onClick={() => stopPolling()}>
						Stop waiting
					</button>
				) : (
					<button type="button" className="btn btn--sm" disabled={off} onClick={() => void signIn()}>
						Sign in with GitHub CLI
					</button>
				)}
				<button type="button" className="btn btn--sm" disabled={off || pasting} onClick={() => setPasting(true)}>
					Paste a token
				</button>
				<button type="button" className="btn btn--sm btn--ghost" disabled={off} onClick={() => void checkAgain()}>
					Check again
				</button>
				{status?.storedInSettings && (
					<button type="button" className="btn btn--sm btn--danger" disabled={off} onClick={() => void removeSaved()}>
						Remove saved token
					</button>
				)}
			</div>
		</div>
	);
}
