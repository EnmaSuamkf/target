import { useState } from "react";
import * as api from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import type { Account } from "../api/types.ts";
import { Field } from "../components/Field.tsx";
import { RecoveryToken } from "../components/RecoveryToken.tsx";
import styles from "./Auth.module.css";

/**
 * First-run setup — the signup screen, reachable exactly once in the life of
 * an installation: the server answers 409 the moment the account exists and
 * the landing page stops offering "Get started", so this view only ever
 * renders while `setupCompleted` is false.
 *
 * Two steps: pick a password (plus an optional display name, never a
 * credential — login is password-only), then the one-time recovery-token
 * reveal. Finishing the reveal completes setup: the server already issued a
 * session with the setup response, so the user lands signed in.
 */
export function SetupView({
	onDone,
	onBack,
}: {
	onDone: (account: Account) => void;
	onBack: () => void;
}): React.JSX.Element {
	const [displayName, setDisplayName] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Set once setup succeeds: the token to reveal. Held in state for exactly as
	// long as the reveal is on screen, then dropped (onDone unmounts this view).
	const [pending, setPending] = useState<{ account: Account; recoveryToken: string } | null>(null);

	const passwordError =
		password !== "" && password.length < 10
			? "At least 10 characters."
			: confirm !== "" && confirm !== password
				? "Passwords don't match."
				: undefined;

	const submit = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			const result = await api.setupAccount({
				password,
				...(displayName.trim() !== "" ? { displayName: displayName.trim() } : {}),
			});
			setPending(result);
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				setError("This machine already has its account — setup only runs once. Sign in instead.");
			} else {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={styles.page}>
			<div className={styles.card}>
				<div className={styles.brand}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
						<circle cx="12" cy="12" r="9" />
						<circle cx="12" cy="12" r="4.5" />
						<circle cx="12" cy="12" r="1" fill="currentColor" />
					</svg>
					<span className={styles.brandName}>The Target Project</span>
				</div>

				{pending ? (
					<>
						<h1 className={styles.title}>Save your recovery token</h1>
						<RecoveryToken
							token={pending.recoveryToken}
							onConfirmed={() => {
								const { account } = pending;
								setPending(null); // wipe the token from state before leaving
								onDone(account);
							}}
						/>
					</>
				) : (
					<>
						<h1 className={styles.title}>Welcome — let's set up</h1>
						<p className={styles.subtitle}>
							One account for this machine. This runs once; afterwards this screen disappears and only the
							sign-in remains.
						</p>
						<form
							className={styles.form}
							onSubmit={(ev) => {
								ev.preventDefault();
								if (!busy && password.length >= 10 && confirm === password) void submit();
							}}
						>
							<Field label="Display name" hint="Optional — shown in the header. Never used to sign in.">
								{(props) => (
									<input
										{...props}
										type="text"
										className="input"
										autoComplete="nickname"
										maxLength={64}
										value={displayName}
										onChange={(ev) => setDisplayName(ev.target.value)}
									/>
								)}
							</Field>
							<Field label="Password" required hint="At least 10 characters.">
								{(props) => (
									<input
										{...props}
										type="password"
										className="input"
										autoComplete="new-password"
										required
										value={password}
										onChange={(ev) => setPassword(ev.target.value)}
									/>
								)}
							</Field>
							<Field
								label="Repeat password"
								required
								{...(password !== "" && confirm !== "" && passwordError ? { error: passwordError } : {})}
							>
								{(props) => (
									<input
										{...props}
										type="password"
										className="input"
										autoComplete="new-password"
										required
										value={confirm}
										onChange={(ev) => setConfirm(ev.target.value)}
									/>
								)}
							</Field>
							{error && (
								<p className={styles.error} role="alert">
									{error}
								</p>
							)}
							<button
								type="submit"
								className={`btn btn--primary ${styles.submit}`}
								disabled={busy || password.length < 10 || confirm !== password}
							>
								{busy ? "Creating account…" : "Create account"}
							</button>
						</form>
						<div className={styles.linkRow}>
							<button type="button" className={styles.linkButton} onClick={onBack}>
								← Back to home
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
