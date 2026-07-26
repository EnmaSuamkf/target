import { useEffect, useState } from "react";
import { Field } from "./Field.tsx";
import { Modal } from "./Modal.tsx";
import styles from "./Header.module.css";

export type View = "workflows" | "templates" | "settings";

const VIEW_LABELS: Record<View, string> = {
	workflows: "Workflows",
	templates: "Templates",
	settings: "Settings",
};

/**
 * App bar: brand, view tabs, and the admin-token control.
 *
 * The token is the one piece of state the previous UI handled badly — it was
 * pulled in through `prompt()` at the moment an action needed it, with no way
 * to see whether one was stored or to replace a wrong one. Here it's a visible,
 * persistent affordance: the button states whether a token is set and opens a
 * dialog to set or change it.
 */
export function Header({
	view,
	onViewChange,
	hasToken,
	onSaveToken,
}: {
	view: View;
	onViewChange: (view: View) => void;
	hasToken: boolean;
	onSaveToken: (token: string) => void;
}): React.JSX.Element {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [draft, setDraft] = useState("");

	// Start each visit to the dialog from an empty field rather than showing
	// the stored secret back.
	useEffect(() => {
		if (dialogOpen) setDraft("");
	}, [dialogOpen]);

	const save = (): void => {
		const trimmed = draft.trim();
		if (!trimmed) return;
		onSaveToken(trimmed);
		setDialogOpen(false);
	};

	return (
		<header className={styles.header}>
			<div className={styles.inner}>
				<div className={styles.brand}>
					<span className={styles.mark} aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
							<circle cx="12" cy="12" r="9" />
							<circle cx="12" cy="12" r="4.5" />
							<circle cx="12" cy="12" r="1" fill="currentColor" />
						</svg>
					</span>
					<span className={styles.name}>The Target Project</span>
				</div>

				<nav className={styles.tabs} aria-label="Views">
					{(["workflows", "templates", "settings"] as const).map((item) => (
						<button
							key={item}
							type="button"
							className={`${styles.tab} ${view === item ? styles.tabActive : ""}`}
							onClick={() => onViewChange(item)}
							aria-current={view === item ? "page" : undefined}
						>
							{VIEW_LABELS[item]}
						</button>
					))}
				</nav>

				<button
					type="button"
					className={`${styles.token} ${hasToken ? styles.tokenSet : styles.tokenMissing}`}
					onClick={() => setDialogOpen(true)}
					title={
						hasToken
							? "An admin token is saved in this browser. Click to replace it."
							: "No admin token saved — mutating actions will fail. Click to add it."
					}
				>
					<span className={styles.tokenDot} aria-hidden="true" />
					{hasToken ? "Token set" : "Set token"}
				</button>
			</div>

			<Modal
				open={dialogOpen}
				size="sm"
				title={hasToken ? "Replace admin token" : "Admin token"}
				description="The hub prints this token on startup; it also lives in ~/.target/config.json. It's kept in this browser's local storage and sent as a bearer token on actions that change state."
				onClose={() => setDialogOpen(false)}
				footer={
					<>
						<button type="button" className="btn" onClick={() => setDialogOpen(false)}>
							Cancel
						</button>
						<button type="button" className="btn btn--primary" onClick={save} disabled={draft.trim() === ""}>
							Save token
						</button>
					</>
				}
			>
				<Field label="Admin token" required>
					{(props) => (
						<input
							{...props}
							type="password"
							className="input"
							autoComplete="off"
							value={draft}
							placeholder="Paste the token printed by the hub"
							onChange={(ev) => setDraft(ev.target.value)}
							onKeyDown={(ev) => {
								if (ev.key === "Enter") {
									ev.preventDefault();
									save();
								}
							}}
						/>
					)}
				</Field>
			</Modal>
		</header>
	);
}
