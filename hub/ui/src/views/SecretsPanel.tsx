import { useEffect, useId, useState } from "react";
import { deleteSecret, listSecrets, setSecret } from "../api/client.ts";
import type { SecretSummary } from "../api/types.ts";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { usePermissions, requires } from "../hooks/usePermissions.ts";
import { relativeTime } from "../lib/format.ts";
import styles from "./SettingsView.module.css";
import panel from "./PipelinesView.module.css";

/** The same rule the hub enforces (`SECRET_NAME_PATTERN` in hub/pipeline-secrets.ts). */
export const SECRET_NAME_RULE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Pipeline secrets, by name only. The hub never sends a value back, so this panel
 * cannot show one: a value goes in once, through the password field, and a
 * replace is a new value typed again. Set state and the last change are the only
 * things listed.
 */
export function SecretsPanel(): React.JSX.Element {
	const headingId = useId();
	const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const { can } = usePermissions();
	const canWrite = can("client.workflows.manage");
	const { confirm, dialog } = useConfirm();

	const refresh = async (): Promise<void> => {
		try {
			setSecrets(await listSecrets());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const trimmed = name.trim();
	const nameProblem =
		trimmed === "" ? null : SECRET_NAME_RULE.test(trimmed) ? null : "Use capital letters, digits and underscores, starting with a letter or _.";
	const canSave = canWrite && !busy && trimmed !== "" && nameProblem === null && value !== "";

	const save = async (): Promise<void> => {
		if (!canSave) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await setSecret(trimmed, value);
			setValue("");
			setNotice(`Saved ${trimmed}. The value is stored and will not be shown again.`);
			setName("");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (secret: SecretSummary): Promise<void> => {
		const ok = await confirm({
			title: `Delete ${secret.name}?`,
			description: "A pipeline that uses it fails with 'missing secret' until a value is set again.",
			confirmLabel: "Delete secret",
			danger: true,
		});
		if (!ok) return;
		setBusy(true);
		setError(null);
		try {
			await deleteSecret(secret.name);
			setNotice(`Deleted ${secret.name}.`);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className={styles.section} aria-labelledby={`${headingId}-section`}>
			<h3 className={styles.sectionHeading} id={`${headingId}-section`}>
				Pipeline secrets
			</h3>
			<p className="hint">
				Values a pipeline reads as <code>{"${{ secrets.NAME }}"}</code>. They are kept on this hub, are never
				exported or synced, and are hidden in every log. Only names and set state are shown here.
			</p>

			{secrets === null ? (
				<p className="hint">Loading…</p>
			) : secrets.length === 0 ? (
				<p className="hint">No secrets yet.</p>
			) : (
				<ul className={panel.secretList}>
					{secrets.map((secret) => (
						<li key={secret.name} className={panel.secretRow}>
							<span className={panel.secretName}>{secret.name}</span>
							<span className={`${panel.badge} ${panel.badgeTrusted}`}>set</span>
							<span className={panel.cardMeta}>changed {relativeTime(secret.updatedAt)}</span>
							<button
								type="button"
								className="btn btn--sm btn--danger"
								onClick={() => void remove(secret)}
								disabled={!canWrite || busy}
								title={canWrite ? undefined : requires("client.workflows.manage")}
							>
								Delete
							</button>
						</li>
					))}
				</ul>
			)}

			<div className={panel.secretForm}>
				<label className={panel.fieldLabel}>
					<span>Name</span>
					<input
						className="input"
						value={name}
						onChange={(ev) => setName(ev.target.value.toUpperCase())}
						placeholder="DEPLOY_TOKEN"
						autoComplete="off"
						spellCheck={false}
						disabled={!canWrite}
						aria-invalid={nameProblem !== null}
					/>
				</label>
				{nameProblem && <p className={panel.error}>{nameProblem}</p>}
				<label className={panel.fieldLabel}>
					<span>Value</span>
					<input
						className="input"
						type="password"
						value={value}
						onChange={(ev) => setValue(ev.target.value)}
						autoComplete="new-password"
						disabled={!canWrite}
					/>
				</label>
				<div className={panel.actions}>
					<button
						type="button"
						className="btn btn--primary"
						onClick={() => void save()}
						disabled={!canSave}
						title={canWrite ? undefined : requires("client.workflows.manage")}
					>
						Save secret
					</button>
					<span className={panel.muted}>Saving an existing name replaces its value.</span>
				</div>
			</div>
			{notice && <p className={panel.ok} role="status">{notice}</p>}
			{error && <p className={panel.error} role="alert">{error}</p>}
			{dialog}
		</section>
	);
}
