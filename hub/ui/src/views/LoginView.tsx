import { useState } from "react";
import * as api from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import type { Account } from "../api/types.ts";
import { Field } from "../components/Field.tsx";
import styles from "./Auth.module.css";

/**
 * The login screen: a single password field. There is deliberately no username
 * — with exactly one account per machine, a username adds friction but selects
 * nothing (plan decision D6). "Forgot password" leads to the recovery-token
 * reset; there is NO link to signup, because setup is unreachable once the
 * account exists.
 */
export function LoginView({
	onDone,
	onForgot,
	onBack,
}: {
	onDone: (account: Account) => void;
	onForgot: () => void;
	onBack: () => void;
}): React.JSX.Element {
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			const { account } = await api.login(password);
			onDone(account);
		} catch (err) {
			if (err instanceof ApiError && err.status === 429) {
				const retry = err.retryAfterSec;
				setError(
					`Too many attempts — locked for now. Try again in ${retry !== null ? `about ${Math.max(1, Math.ceil(retry / 60))} minute(s)` : "a few minutes"}.`,
				);
			} else if (err instanceof ApiError && err.status === 401) {
				setError("Invalid password.");
			} else {
				setError(err instanceof Error ? err.message : String(err));
			}
			setPassword("");
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
				<h1 className={styles.title}>Sign in</h1>
				<p className={styles.subtitle}>The password you chose when you set up this machine.</p>
				<form
					className={styles.form}
					onSubmit={(ev) => {
						ev.preventDefault();
						if (!busy && password !== "") void submit();
					}}
				>
					<Field label="Password" required>
						{(props) => (
							<input
								{...props}
								type="password"
								className="input"
								autoComplete="current-password"
								autoFocus
								required
								value={password}
								onChange={(ev) => setPassword(ev.target.value)}
							/>
						)}
					</Field>
					{error && (
						<p className={styles.error} role="alert">
							{error}
						</p>
					)}
					<button type="submit" className={`btn btn--primary ${styles.submit}`} disabled={busy || password === ""}>
						{busy ? "Signing in…" : "Sign in"}
					</button>
				</form>
				<div className={styles.linkRow}>
					<button type="button" className={styles.linkButton} onClick={onBack}>
						← Back to home
					</button>
					<button type="button" className={styles.linkButton} onClick={onForgot}>
						Forgot password?
					</button>
				</div>
			</div>
		</div>
	);
}
