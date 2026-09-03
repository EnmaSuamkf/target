import { useId, useState } from "react";
import type { NotificationSettings, NotificationSettingsInput, ReportSettings, ReportSettingsInput, ShortcutAction, ShortcutSettings, ShortcutSettingsInput } from "../api/types.ts";
import { Field } from "../components/Field.tsx";
import { Switch } from "../components/Switch.tsx";
import { relativeTime } from "../lib/format.ts";
import styles from "./SettingsView.module.css";

/**
 * Configuration: hub-wide preferences, one section per topic. Notifications is
 * the master switch plus the channels it gates; Shortcuts (Atajos) is the key
 * each of the five hub shortcuts fires on.
 *
 * Everything is edited locally and committed by a per-section Save (a single
 * PUT each), rather than saving on every keystroke: a half-typed username or a
 * trial key press is not a preference worth persisting, and the switch and the
 * channel it gates have to be valid together to be storable at all.
 */

/** What each action does, shown next to its key field. */
const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
	focusWorkflow: "Focus the first workflow",
	toggleDictation: "Toggle dictation",
	createWorkflow: "Create a workflow",
	continueStep: "Continue a step waiting for review",
	startWorkflow: "Start the open workflow",
};

const SHORTCUT_ORDER: readonly ShortcutAction[] = [
	"focusWorkflow",
	"toggleDictation",
	"createWorkflow",
	"continueStep",
	"startWorkflow",
];

export function SettingsView({
	settings,
	shortcutSettings,
	reportSettings,
	busy,
	onSave,
	onSaveShortcuts,
	onSaveReport,
}: {
	settings: NotificationSettings;
	shortcutSettings: ShortcutSettings;
	reportSettings: ReportSettings;
	busy: boolean;
	onSave: (input: NotificationSettingsInput) => Promise<boolean>;
	onSaveShortcuts: (input: ShortcutSettingsInput) => Promise<boolean>;
	onSaveReport: (input: ReportSettingsInput) => Promise<boolean>;
}): React.JSX.Element {
	const [enabled, setEnabled] = useState(settings.enabled);
	const [slackUsername, setSlackUsername] = useState(settings.channels.slack.username);
	const [slackError, setSlackError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// Shortcut keys: one letter per action, edited locally and lowercased on
	// input. Seeded from the saved bindings, never re-seeded mid-edit (the
	// parent keys this view on the save stamp, so a save remounts fresh).
	const [keys, setKeys] = useState<Record<ShortcutAction, string>>({
		focusWorkflow: shortcutSettings.bindings.focusWorkflow?.key ?? "w",
		toggleDictation: shortcutSettings.bindings.toggleDictation?.key ?? "r",
		createWorkflow: shortcutSettings.bindings.createWorkflow?.key ?? "n",
		continueStep: shortcutSettings.bindings.continueStep?.key ?? "c",
		startWorkflow: shortcutSettings.bindings.startWorkflow?.key ?? "s",
	});
	const [shortcutError, setShortcutError] = useState<string | null>(null);
	const [savingShortcuts, setSavingShortcuts] = useState(false);

	const [reportEnabled, setReportEnabled] = useState(reportSettings.enabled);
	const [reportUrl, setReportUrl] = useState(reportSettings.url);
	const [reportToken, setReportToken] = useState("");
	const [reportIntervalMs, setReportIntervalMs] = useState(String(reportSettings.intervalMs));
	const [reportConversations, setReportConversations] = useState(reportSettings.includeConversations);
	const [reportError, setReportError] = useState<string | null>(null);
	const [savingReport, setSavingReport] = useState(false);

	const notificationsId = useId();
	const hintId = `${notificationsId}-hint`;
	const shortcutsId = useId();
	const reportId = useId();

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (saving) return;
		const username = slackUsername.trim();
		// Enabled with nowhere to deliver is what the server rejects too; catching
		// it here keeps the reason next to the field instead of in a toast.
		if (enabled && username === "") {
			setSlackError("Enter your Slack username, or turn notifications off.");
			return;
		}
		setSlackError(null);
		setSaving(true);
		try {
			await onSave({ enabled, channels: { slack: { username } } });
		} finally {
			setSaving(false);
		}
	};

	const submitShortcuts = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (savingShortcuts) return;
		const normalized: Record<ShortcutAction, string> = {
			focusWorkflow: keys.focusWorkflow.trim().toLowerCase(),
			toggleDictation: keys.toggleDictation.trim().toLowerCase(),
			createWorkflow: keys.createWorkflow.trim().toLowerCase(),
			continueStep: keys.continueStep.trim().toLowerCase(),
			startWorkflow: keys.startWorkflow.trim().toLowerCase(),
		};
		// Each key must be a single a–z letter (the only thing the hook matches).
		for (const action of SHORTCUT_ORDER) {
			if (!/^[a-z]$/.test(normalized[action])) {
				setShortcutError(`“${SHORTCUT_LABELS[action]}” needs a single letter A–Z.`);
				return;
			}
		}
		// No two actions on the same key — the route rejects it too, but the
		// inline check keeps the reason next to the offending rows.
		const seen = new Map<string, ShortcutAction>();
		for (const action of SHORTCUT_ORDER) {
			const prev = seen.get(normalized[action]);
			if (prev) {
				setShortcutError(`“${SHORTCUT_LABELS[prev]}” and “${SHORTCUT_LABELS[action]}” can't share the key ${normalized[action].toUpperCase()}.`);
				return;
			}
			seen.set(normalized[action], action);
		}
		setShortcutError(null);
		setSavingShortcuts(true);
		try {
			await onSaveShortcuts({
				bindings: {
					focusWorkflow: { key: normalized.focusWorkflow },
					toggleDictation: { key: normalized.toggleDictation },
					createWorkflow: { key: normalized.createWorkflow },
					continueStep: { key: normalized.continueStep },
					startWorkflow: { key: normalized.startWorkflow },
				},
			});
		} finally {
			setSavingShortcuts(false);
		}
	};

	const submitReport = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (savingReport) return;
		const url = reportUrl.trim();
		if (reportEnabled && url === "") {
			setReportError("Enter the report server URL, or turn reporting off.");
			return;
		}
		const intervalMs = Number.parseInt(reportIntervalMs, 10);
		if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
			setReportError("Flush interval must be at least 1000 ms.");
			return;
		}
		setReportError(null);
		setSavingReport(true);
		try {
			const input: ReportSettingsInput = {
				enabled: reportEnabled,
				url,
				intervalMs,
				includeConversations: reportConversations,
			};
			const token = reportToken.trim();
			if (token !== "") input.token = token;
			const ok = await onSaveReport(input);
			if (ok) setReportToken("");
		} finally {
			setSavingReport(false);
		}
	};

	return (
		<div className={styles.panel}>
			<div className={styles.head}>
				<h2 className={styles.heading}>Configuration</h2>
				<p className="hint">
					Preferences for this hub. They're stored by the hub itself, so every browser sees the same values.
				</p>
			</div>

			<form className={styles.section} aria-labelledby={`${notificationsId}-section`} onSubmit={submit}>
				<h3 className={styles.sectionHeading} id={`${notificationsId}-section`}>
					Notifications
				</h3>

				<div className={styles.toggleRow}>
					<div className={styles.toggleText}>
						<span className="label">Receive notifications</span>
						<p className="hint" id={hintId}>
							{enabled
								? "On — configure below where they should be delivered."
								: "Off — nothing is sent, and the delivery settings stay hidden."}
						</p>
					</div>
					<Switch
						checked={enabled}
						onChange={(next) => {
							setEnabled(next);
							if (!next) setSlackError(null);
						}}
						label="Receive notifications"
						describedBy={hintId}
						disabled={saving}
					/>
				</div>

				{/* The channels are only meaningful while notifications are on, so they
				    appear with the switch rather than sitting there disabled.

				    Only Slack is implemented: the request asked for four ways to receive
				    notifications but described just this one, so the other three are
				    left unspecified rather than guessed at. */}
				{enabled && (
					<div className={styles.channels}>
						<div className={styles.channel}>
							<div className={styles.channelHead}>
								<span className={styles.channelName}>Slack</span>
								<span className="hint">Direct message</span>
							</div>
							<Field
								label="Slack username"
								hint="The handle to message, e.g. @ada or ada.lovelace."
								required
								{...(slackError ? { error: slackError } : {})}
							>
								{(props) => (
									<input
										{...props}
										type="text"
										className="input"
										autoComplete="off"
										value={slackUsername}
										placeholder="@ada"
										onChange={(ev) => {
											setSlackUsername(ev.target.value);
											if (slackError) setSlackError(null);
										}}
										aria-invalid={slackError ? true : undefined}
									/>
								)}
							</Field>
						</div>
					</div>
				)}

				<div className={styles.actions}>
					<button type="submit" className="btn btn--primary" disabled={saving || busy}>
						{saving ? "Saving…" : "Save"}
					</button>
					{settings.updatedAt && <span className="hint">Last saved {relativeTime(settings.updatedAt)}</span>}
				</div>
			</form>

			<form className={styles.section} aria-labelledby={`${reportId}-section`} onSubmit={submitReport}>
				<h3 className={styles.sectionHeading} id={`${reportId}-section`}>
					Activity reporting
				</h3>
				<p className="hint">
					Send workflow and step activity to a central server for monitoring. Stored by the hub — the same
					values apply in the desktop app and in the browser.
					{reportSettings.envConfigured && (
						<>
							{" "}
							Currently reading from <code>.env</code> — save here to manage from Settings instead.
						</>
					)}
				</p>

				<div className={styles.toggleRow}>
					<div className={styles.toggleText}>
						<span className="label">Report activity</span>
						<p className="hint" id={`${reportId}-hint`}>
							{reportEnabled
								? "On — events are queued and flushed to the server URL below."
								: "Off — nothing is sent to a report server."}
						</p>
					</div>
					<Switch
						checked={reportEnabled}
						onChange={(next) => {
							setReportEnabled(next);
							if (!next) setReportError(null);
						}}
						label="Report activity"
						describedBy={`${reportId}-hint`}
						disabled={savingReport}
					/>
				</div>

				{reportEnabled && (
					<div className={styles.channels}>
						<Field
							label="Report server URL"
							hint="HTTPS ingest endpoint that receives activity batches."
							required
							{...(reportError?.includes("URL") ? { error: reportError } : {})}
						>
							{(props) => (
								<input
									{...props}
									type="url"
									className="input"
									autoComplete="off"
									value={reportUrl}
									placeholder="https://telemetria.example.com/ingest"
									onChange={(ev) => {
										setReportUrl(ev.target.value);
										if (reportError) setReportError(null);
									}}
									aria-invalid={reportError?.includes("URL") ? true : undefined}
								/>
							)}
						</Field>

						<Field
							label="Bearer token"
							hint={
								reportSettings.tokenConfigured
									? "Leave blank to keep the stored token."
									: "Secret sent as Authorization: Bearer …"
							}
						>
							{(props) => (
								<input
									{...props}
									type="password"
									className="input"
									autoComplete="off"
									value={reportToken}
									placeholder={reportSettings.tokenConfigured ? "••••••••" : "change-me"}
									onChange={(ev) => setReportToken(ev.target.value)}
								/>
							)}
						</Field>

						<Field label="Flush interval (ms)" hint="How often the hub sends queued events. Minimum 1000.">
							{(props) => (
								<input
									{...props}
									type="number"
									className="input"
									min={1000}
									step={1000}
									value={reportIntervalMs}
									onChange={(ev) => {
										setReportIntervalMs(ev.target.value);
										if (reportError) setReportError(null);
									}}
									aria-invalid={reportError?.includes("interval") ? true : undefined}
								/>
							)}
						</Field>

						<Field label="Conversation detail" hint="How much conversation text may leave this machine.">
							{(props) => (
								<select
									{...props}
									className="input"
									value={reportConversations}
									onChange={(ev) => setReportConversations(ev.target.value as ReportSettings["includeConversations"])}
								>
									<option value="off">Off — no conversation data</option>
									<option value="digest">Digest — metadata and summary only (default)</option>
									<option value="full">Full — include conversation text</option>
								</select>
							)}
						</Field>
					</div>
				)}

				{reportError && !reportError.includes("URL") && (
					<p className="msg msg--error" role="alert">
						{reportError}
					</p>
				)}

				<div className={styles.actions}>
					<button type="submit" className="btn btn--primary" disabled={savingReport || busy}>
						{savingReport ? "Saving…" : "Save"}
					</button>
					{reportSettings.updatedAt && (
						<span className="hint">Last saved {relativeTime(reportSettings.updatedAt)}</span>
					)}
				</div>
			</form>

			{/* Atajos: the key each of the five hub shortcuts fires on. The
			    modifier is always Alt or Shift (the hook honours either), so only
			    the letter is configurable — one field per action. A Save here is a
			    separate PUT from notifications: they're independent resources with
			    their own validity, so a half-edited set in one never blocks the
			    other. */}
			<form className={styles.section} aria-labelledby={`${shortcutsId}-section`} onSubmit={submitShortcuts}>
				<h3 className={styles.sectionHeading} id={`${shortcutsId}-section`}>
					Atajos
				</h3>
				<p className="hint">
					The key each shortcut fires on. Hold <strong>Alt</strong> or <strong>Shift</strong> plus the key —
					“W” means Alt+W or Shift+W. Each action needs its own single letter A–Z.
				</p>

				<div className={styles.shortcutRows}>
					{SHORTCUT_ORDER.map((action) => (
						<div className={styles.shortcutRow} key={action}>
							<span className={styles.shortcutLabel}>{SHORTCUT_LABELS[action]}</span>
							<Field
								label={`${SHORTCUT_LABELS[action]} key`}
								hint="A single letter A–Z. Pressed with Alt or Shift."
							>
							{(props) => (
									<input
										{...props}
										type="text"
										className={`input ${styles.shortcutInput}`}
										autoComplete="off"
										maxLength={1}
										value={keys[action]}
										aria-label={`${SHORTCUT_LABELS[action]} key`}
										onChange={(ev) => {
											// One character, lowercased; anything else is a paste the
											// save validation will catch, but normalising on input keeps
											// the field tidy.
											const next = ev.target.value.slice(-1).toLowerCase();
											setKeys((current) => ({ ...current, [action]: next }));
											if (shortcutError) setShortcutError(null);
										}}
										aria-invalid={shortcutError ? true : undefined}
									/>
								)}
							</Field>
						</div>
					))}
				</div>

				{shortcutError && (
					<p className="msg msg--error" role="alert">
						{shortcutError}
					</p>
				)}

				<div className={styles.actions}>
					<button type="submit" className="btn btn--primary" disabled={savingShortcuts || busy}>
						{savingShortcuts ? "Saving…" : "Save"}
					</button>
					{shortcutSettings.updatedAt && <span className="hint">Last saved {relativeTime(shortcutSettings.updatedAt)}</span>}
				</div>
			</form>
		</div>
	);
}
