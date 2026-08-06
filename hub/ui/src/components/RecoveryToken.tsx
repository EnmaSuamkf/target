import { useState } from "react";
import { useToast } from "./Toast.tsx";
import styles from "./RecoveryToken.module.css";

/**
 * The "save your recovery token" screen — shown after setup and again after a
 * password reset (which rotates the token).
 *
 * The token is displayed exactly once: the server stores only its SHA-256, so
 * nothing can show it again after this screen is left. Hence the deliberate
 * friction — copy + download affordances, the full-wipe consequence spelled
 * out, and a mandatory checkbox gating Continue. `onConfirmed` fires only from
 * that gated button; the parent wipes the token from its state there.
 */
export function RecoveryToken({
	token,
	onConfirmed,
}: {
	token: string;
	onConfirmed: () => void;
}): React.JSX.Element {
	const [saved, setSaved] = useState(false);
	const toast = useToast();

	const copy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(token);
			toast.success("Recovery token copied.");
		} catch {
			toast.error("Could not copy — select the token and copy it by hand.");
		}
	};

	const download = (): void => {
		const text = [
			"The Target Project — recovery token",
			"",
			token,
			"",
			"This token is the ONLY way to reset your password.",
			"It is shown once and never stored in readable form.",
			"If you lose both your password and this token, the only recovery",
			"is wiping all Target data on this machine and reinstalling.",
			"",
		].join("\n");
		const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = "target-recovery-token.txt";
		link.click();
		URL.revokeObjectURL(url);
	};

	return (
		<>
			<div className={styles.token} data-testid="recovery-token">
				{token}
			</div>
			<div className={styles.tokenActions}>
				<button type="button" className="btn" onClick={() => void copy()}>
					Copy
				</button>
				<button type="button" className="btn" onClick={download}>
					Download as .txt
				</button>
			</div>
			<p className={styles.warning} role="alert">
				<strong>Shown once — never stored in readable form.</strong>
				This token is the only way to reset your password. If you lose both your password and this token, the only
				recovery is wiping all Target data on this machine and reinstalling. Save it somewhere safe — a password
				manager, or printed.
			</p>
			<label className={styles.confirm}>
				<input type="checkbox" checked={saved} onChange={(ev) => setSaved(ev.target.checked)} />
				<span>I have saved my recovery token</span>
			</label>
			<button type="button" className="btn btn--primary" disabled={!saved} onClick={onConfirmed}>
				Continue
			</button>
		</>
	);
}
