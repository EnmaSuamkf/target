import { useState } from "react";
import * as api from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import type { Account } from "../api/types.ts";
import { Field } from "../components/Field.tsx";
import { RecoveryToken } from "../components/RecoveryToken.tsx";
import styles from "./Auth.module.css";

/**
 * Forgot password — there is no e-mail channel in a local app, so the
 * recovery token saved at setup is the way back in. A successful reset rotates
 * the token (the one just used is dead), kills every other session and signs
 * the user straight in, so the second step here is the same one-time token
 * reveal as at setup.
 */
export function ResetPasswordView({
	onDone,
	onBack,
}: {
	onDone: (account: Account) => void;
	onBack: () => void;
}): React.JSX.Element {
	const [token, setToken] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<{ account: Account; recoveryToken: string } | null>(null);

	const submit = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			const result = await api.resetPassword({ recoveryToken: token, newPassword: password });
			setPending(result);
		} catch (err) {
			if (err instanceof ApiError && err.status === 429) {
				const retry = err.retryAfterSec;
				setError(
					`Too many attempts. Try again in ${retry !== null ? `about ${Math.max(1, Math.ceil(retry / 60))} minute(s)` : "a few minutes"}.`,
				);
			} else if (err instanceof ApiError && err.status === 401) {
				setError("That recovery token doesn't match. Check it and try again.");
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
						<h1 className={styles.title}>Save your new recovery token</h1>
						<p className={styles.subtitle}>
							Your password was reset. The old token is dead — this is its replacement, shown once.
						</p>
						<RecoveryToken
							token={pending.recoveryToken}
							onConfirmed={() => {
								const { account } = pending;
								setPending(null);
								onDone(account);
							}}
						/>
					</>
				) : (
					<>
						<h1 className={styles.title}>Reset your password</h1>
						<p className={styles.subtitle}>
							Enter the recovery token you saved when you set up this machine, and pick a new password.
						</p>
						<form
							className={styles.form}
							onSubmit={(ev) => {
								ev.preventDefault();
								if (!busy && token.trim() !== "" && password.length >= 10 && confirm === password) void submit();
							}}
						>
							<Field label="Recovery token" required hint="The XXXXX-XXXXX-XXXXX-XXXXX token shown once at setup.">
								{(props) => (
									<input
										{...props}
										type="text"
										className="input mono"
										autoComplete="off"
										autoFocus
										spellCheck={false}
										required
										placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
										value={token}
										onChange={(ev) => setToken(ev.target.value)}
									/>
								)}
							</Field>
							<Field label="New password" required hint="At least 10 characters.">
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
								label="Repeat new password"
								required
								{...(password !== "" && confirm !== "" && confirm !== password
									? { error: "Passwords don't match." }
									: {})}
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
								disabled={busy || token.trim() === "" || password.length < 10 || confirm !== password}
							>
								{busy ? "Resetting…" : "Reset password"}
							</button>
						</form>
						<div className={styles.linkRow}>
							<button type="button" className={styles.linkButton} onClick={onBack}>
								← Back to sign in
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
