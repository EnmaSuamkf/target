import { useEffect, useState } from "react";
import { useIsMobile } from "../hooks/useIsMobile.ts";
import { Field } from "./Field.tsx";
import { Modal } from "./Modal.tsx";
import styles from "./Header.module.css";

export type View = "workflows" | "templates" | "settings";

const VIEW_LABELS: Record<View, string> = {
	workflows: "Workflows",
	templates: "Templates",
	settings: "Settings",
};

const VIEWS = ["workflows", "templates", "settings"] as const;

/**
 * Icons for the phone tab bar. A bottom bar with text alone reads as a row of
 * links rather than a place to be; the glyph is what makes a tab a tab. They're
 * only rendered there — the desktop header stays text-only, as it was.
 */
const VIEW_ICONS: Record<View, React.ReactNode> = {
	workflows: (
		<>
			<path d="M8 6h13M8 12h13M8 18h13" />
			<circle cx="3.5" cy="6" r="1.5" />
			<circle cx="3.5" cy="12" r="1.5" />
			<circle cx="3.5" cy="18" r="1.5" />
		</>
	),
	templates: (
		<>
			<rect x="3" y="3" width="8" height="8" rx="2" />
			<rect x="13" y="3" width="8" height="8" rx="2" />
			<rect x="3" y="13" width="8" height="8" rx="2" />
			<rect x="13" y="13" width="8" height="8" rx="2" />
		</>
	),
	settings: (
		<>
			<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
			<circle cx="16" cy="6" r="2" />
			<circle cx="8" cy="12" r="2" />
			<circle cx="14" cy="18" r="2" />
		</>
	),
};

/**
 * App bar: brand, view tabs, and the admin-token control.
 *
 * The token is the one piece of state the previous UI handled badly — it was
 * pulled in through `prompt()` at the moment an action needed it, with no way
 * to see whether one was stored or to replace a wrong one. Here it's a visible,
 * persistent affordance: the button states whether a token is set and opens a
 * dialog to set or change it.
 *
 * On a phone the three views move out of the header into a fixed bottom tab
 * bar. Two reasons: the top of a phone screen is the hardest place to reach,
 * and the header was already crowded enough there that the brand name had to be
 * hidden to fit the tabs. With the tabs gone the header becomes a thin title
 * bar and navigation lands under the thumb. It's a different element rather
 * than the same one re-positioned because a tab bar needs icons and a different
 * arrangement — but it drives exactly the same `view` state.
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
	const isMobile = useIsMobile();

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
		<>
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

					{!isMobile && (
						<nav className={styles.tabs} aria-label="Views">
							{VIEWS.map((item) => (
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
					)}

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

			{isMobile && (
				<nav className={styles.bottomNav} aria-label="Views">
					{VIEWS.map((item) => (
						<button
							key={item}
							type="button"
							className={`${styles.navItem} ${view === item ? styles.navItemActive : ""}`}
							onClick={() => onViewChange(item)}
							aria-current={view === item ? "page" : undefined}
						>
							<svg
								className={styles.navIcon}
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								{VIEW_ICONS[item]}
							</svg>
							{VIEW_LABELS[item]}
						</button>
					))}
				</nav>
			)}
		</>
	);
}
