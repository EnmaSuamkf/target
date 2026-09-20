import { useEffect, useId, useState } from "react";
import type {
	DeviceLinkOutcome,
	DeviceLinkStatus,
	DockerFriendlySettings,
	DockerFriendlySettingsInput,
	DockerMountSettings,
	DockerMountSettingsInput,
	NotificationSettings,
	NotificationSettingsInput,
	ReportSettings,
	ReportSettingsInput,
	SlackDeliverySettings,
	SlackDeliverySettingsInput,
	ShortcutAction,
	ShortcutSettings,
	ShortcutSettingsInput,
	UiSettings,
	UiSettingsInput,
} from "../api/types.ts";
import * as api from "../api/client.ts";
import { CollapsibleSection } from "../components/CollapsibleSection.tsx";
import { DockerMountEditor } from "../components/DockerMountEditor.tsx";
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
	slackDeliverySettings,
	dockerFriendlySettings,
	dockerMountSettings,
	uiSettings,
	busy,
	onSave,
	onSaveShortcuts,
	onSaveReport,
	onSaveSlackDelivery,
	onSaveDockerFriendly,
	onSaveDockerMounts,
	onSaveUi,
}: {
	settings: NotificationSettings;
	shortcutSettings: ShortcutSettings;
	reportSettings: ReportSettings;
	slackDeliverySettings: SlackDeliverySettings;
	dockerFriendlySettings: DockerFriendlySettings;
	dockerMountSettings: DockerMountSettings;
	uiSettings: UiSettings;
	busy: boolean;
	onSave: (input: NotificationSettingsInput) => Promise<boolean>;
	onSaveShortcuts: (input: ShortcutSettingsInput) => Promise<boolean>;
	onSaveReport: (input: ReportSettingsInput) => Promise<boolean>;
	onSaveSlackDelivery: (input: SlackDeliverySettingsInput) => Promise<boolean>;
	onSaveDockerFriendly: (input: DockerFriendlySettingsInput) => Promise<boolean>;
	onSaveDockerMounts: (input: DockerMountSettingsInput) => Promise<boolean>;
	onSaveUi: (input: UiSettingsInput) => Promise<boolean>;
}): React.JSX.Element {
	const [enabled, setEnabled] = useState(settings.enabled);
	const [slackUsername, setSlackUsername] = useState(settings.channels.slack.username);
	const [slackError, setSlackError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const [xoxc, setXoxc] = useState("");
	const [xoxd, setXoxd] = useState("");
	const [slackDeliveryError, setSlackDeliveryError] = useState<string | null>(null);
	const [savingSlackDelivery, setSavingSlackDelivery] = useState(false);

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
	const [dockerFriendlyHub, setDockerFriendlyHub] = useState(dockerFriendlySettings.dockerFriendlyHub);
	const [dockerFriendlyError, setDockerFriendlyError] = useState<string | null>(null);
	const [savingDockerFriendly, setSavingDockerFriendly] = useState(false);
	const [dockerMounts, setDockerMounts] = useState<string[]>(dockerMountSettings.mounts);
	const [dockerMountError, setDockerMountError] = useState<string | null>(null);
	const [savingDockerMounts, setSavingDockerMounts] = useState(false);

	const [showTcpCatalog, setShowTcpCatalog] = useState(uiSettings.showTcpCatalog);
	const [showRciCatalog, setShowRciCatalog] = useState(uiSettings.showRciCatalog);
	const [savingUi, setSavingUi] = useState(false);
	const [linkStatus, setLinkStatus] = useState<DeviceLinkStatus | null>(null);
	const [linkOrigin, setLinkOrigin] = useState("");
	const [linkDeviceName, setLinkDeviceName] = useState("");
	const [linkMessage, setLinkMessage] = useState<string | null>(null);
	const [linkBrowserUrl, setLinkBrowserUrl] = useState<string | null>(null);
	const [linkBusy, setLinkBusy] = useState(false);

	const notificationsId = useId();
	const catalogNavId = useId();
	const hintId = `${notificationsId}-hint`;
	const shortcutsId = useId();
	const reportId = useId();
	const dockerFriendlyId = useId();
	const linkId = useId();

	const applyLinkOutcome = (outcome: DeviceLinkOutcome): void => {
		setLinkStatus(outcome.status);
		setLinkBrowserUrl(outcome.browserUrl ?? null);
		const messages: Record<DeviceLinkOutcome["code"], string> = {
			browser_opened: "Browser opened. Sign in with Google or email/password on your server; approval is tied to that server account and this hub completes automatically.",
			open_browser_manually: "Open the approval page below. Sign in on the server, then this hub will complete automatically after approval.",
			waiting_for_approval: "Waiting for your server account to approve this device. No additional action is needed in this hub.",
			connected: "Connected securely. Remote reporting and sync can use this device.",
			approval_denied: "Your server account denied this device or lacks permission to approve it. This hub remains fully local; ask a server administrator or try again.",
			approval_expired: "Approval expired or the server login was cancelled. This hub remains fully local; choose Connect to start a new request.",
			cancelled: "Disconnected. Remote traffic stopped and local workflows continue unchanged.",
			server_unavailable: "Disconnected locally; remote cleanup pending. Local workflows and tools continue unchanged.",
			relink_required: "This device needs to be linked again. Local workflows and tools continue unchanged.",
		};
		setLinkMessage(messages[outcome.code]);
	};

	useEffect(() => {
		void api
			.getDeviceLinkStatus()
			.then((status) => {
				setLinkStatus(status);
				if (status.origin) setLinkOrigin(status.origin);
			})
			.catch(() => setLinkMessage("Could not read server connection status. Local workflows and tools continue unchanged."));
	}, []);

	useEffect(() => {
		if (linkStatus?.state !== "awaiting_authorization") return;
		const timer = window.setInterval(() => {
			void api.pollDeviceLink().then(applyLinkOutcome).catch(() => {
				setLinkMessage("Could not contact the server yet. Local workflows and tools continue unchanged.");
			});
		}, 3_000);
		return () => window.clearInterval(timer);
	}, [linkStatus?.state]);

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (saving || savingSlackDelivery) return;
		const username = slackUsername.trim();
		// Enabled with nowhere to deliver is what the server rejects too; catching
		// it here keeps the reason next to the field instead of in a toast.
		if (enabled && username === "") {
			setSlackError("Enter your Slack username, or turn notifications off.");
			return;
		}
		setSlackError(null);
		setSlackDeliveryError(null);
		setSaving(true);
		setSavingSlackDelivery(true);
		try {
			await onSave({ enabled, channels: { slack: { username } } });
			// Same Save also persists delivery tokens (blank fields keep stored secrets).
			const input: SlackDeliverySettingsInput = {};
			const xoxcValue = xoxc.trim();
			const xoxdValue = xoxd.trim();
			if (xoxcValue !== "") input.xoxc = xoxcValue;
			if (xoxdValue !== "") input.xoxd = xoxdValue;
			const ok = await onSaveSlackDelivery(input);
			if (ok) {
				setXoxc("");
				setXoxd("");
			} else {
				setSlackDeliveryError("Could not save Slack credentials.");
			}
		} finally {
			setSaving(false);
			setSavingSlackDelivery(false);
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


	const submitDockerFriendly = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (savingDockerFriendly) return;
		setDockerFriendlyError(null);
		setSavingDockerFriendly(true);
		try {
			const ok = await onSaveDockerFriendly({ dockerFriendlyHub });
			if (!ok) setDockerFriendlyError("Could not save docker-friendly networking.");
		} finally {
			setSavingDockerFriendly(false);
		}
	};

	const submitReport = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (savingReport) return;
		const linked = linkStatus?.state === "connected";
		const url = linked ? reportSettings.url : reportUrl.trim();
		if (reportEnabled && !linked && url === "") {
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

			<section className={styles.section} aria-labelledby={`${linkId}-section`}>
				<h3 className={styles.sectionHeading} id={`${linkId}-section`}>Optional server connection</h3>
				<p className="hint">
					This hub stays fully usable for workflows, templates, TCP tools and RCI with no server, while offline,
					or if a link is revoked. Your server login stays in the browser; this hub never receives a password.
				</p>
				{linkStatus && (
					<p className="hint" aria-live="polite">
						Status: <strong>{linkStatus.state.replaceAll("_", " ")}</strong>
						{linkStatus.deviceName ? ` · ${linkStatus.deviceName}` : ""}
						{linkStatus.lastRemoteActivityAt
							? ` · last remote activity ${relativeTime(linkStatus.lastRemoteActivityAt)}`
							: linkStatus.connectedAt
								? ` · linked ${relativeTime(linkStatus.connectedAt)}`
								: ""}
						{linkStatus.remoteCleanupPending ? " · remote cleanup pending" : ""}
						{linkStatus.reason === "sync_registration_failed" ? " · server rejected Remote Sync registration; will retry without changing this device link" : ""}
					</p>
				)}
				{linkStatus?.state === "connected" ? (
					<div className={styles.channels}>
						<p className="hint"><strong>{linkStatus.origin}</strong> · device {linkStatus.deviceName ?? "unnamed"} · scopes: {linkStatus.scopes.join(", ") || "none"}{linkStatus.lastRemoteActivityAt ? ` · last remote activity ${relativeTime(linkStatus.lastRemoteActivityAt)}` : ""}</p>
						{linkStatus.scopes.includes("sync:write") && <p className="hint">Remote Sync is active automatically for this linked device.</p>}
						{linkStatus.scopes.includes("ingest:write") && <p className="hint">Activity reporting is active automatically and includes full conversation text, as accepted when this hub was linked.</p>}
						<div className={styles.actions}>
						<button type="button" className="btn btn--secondary" disabled={linkBusy} onClick={async () => {
							setLinkBusy(true);
							try { applyLinkOutcome(await api.cancelDeviceLink()); } finally { setLinkBusy(false); }
						}}>{linkBusy ? "Disconnecting…" : "Disconnect this device"}</button>
						<button type="button" className="btn btn--primary" disabled={linkBusy} onClick={async () => {
							setLinkBusy(true);
							try { applyLinkOutcome(await api.cancelDeviceLink()); setLinkMessage("Previous link removed. Connect this hub again to link a replacement."); }
							finally { setLinkBusy(false); }
						}}>Link a replacement</button>
						</div>
					</div>
				) : (
					<form className={styles.channels} onSubmit={async (event) => {
						event.preventDefault();
						if (linkBusy) return;
						setLinkBusy(true);
						try {
							const deviceName = linkDeviceName.trim();
							applyLinkOutcome(await api.startDeviceLink({
								origin: linkOrigin.trim(),
								...(deviceName ? { deviceName } : {}),
							}));
						}
						catch { setLinkMessage("Could not start the connection. Check the server address; local work remains available."); }
						finally { setLinkBusy(false); }
					}}>
						<p className="msg msg--error" role="note" id={`${linkId}-consent`}>By connecting, you explicitly allow this server to receive Activity and full conversation text whenever it grants <code>ingest:write</code>, and Remote Sync whenever it grants <code>sync:write</code>. You can cancel before connecting.</p>
						<Field label="Server address" hint="HTTPS server origin, for example https://target.example." required>
							{(props) => <input {...props} type="url" className="input" value={linkOrigin} placeholder="https://target.example" onChange={(event) => setLinkOrigin(event.target.value)} disabled={linkBusy} />}
						</Field>
						<Field label="Device name" hint="Optional display name shown when approving this device.">
							{(props) => <input {...props} type="text" className="input" value={linkDeviceName} onChange={(event) => setLinkDeviceName(event.target.value)} disabled={linkBusy} />}
						</Field>
						<div className={styles.actions}>
							<button type="submit" className="btn btn--primary" disabled={linkBusy} aria-describedby={`${linkId}-consent`}>{linkBusy ? "Connecting…" : linkStatus?.state === "awaiting_authorization" ? "Start a new request" : "Connect with my server"}</button>
							{linkStatus?.state === "awaiting_authorization" && <button type="button" className="btn btn--secondary" disabled={linkBusy} onClick={async () => { setLinkBusy(true); try { applyLinkOutcome(await api.cancelDeviceLink()); } finally { setLinkBusy(false); } }}>Cancel</button>}
						</div>
					</form>
				)}
				{linkBrowserUrl && <p className="hint">If your browser did not open, <a href={linkBrowserUrl} target="_blank" rel="noreferrer">open the approval page</a>.</p>}
				{linkMessage && <p className="msg msg--error" role="status">{linkMessage}</p>}
			</section>

			<form
				className={styles.section}
				aria-labelledby={`${catalogNavId}-section`}
				onSubmit={async (ev) => {
					ev.preventDefault();
					if (savingUi) return;
					setSavingUi(true);
					try {
						await onSaveUi({ showTcpCatalog, showRciCatalog });
					} finally {
						setSavingUi(false);
					}
				}}
			>
				<h3 className={styles.sectionHeading} id={`${catalogNavId}-section`}>
					Catalog navigation
				</h3>
				<p className="hint">
					Control whether <strong>TCP</strong> and <strong>RCI</strong> (resource sets) appear in the
					header, on workflows, and on templates. When hidden, existing attachments on the server are
					unchanged — the hub API and MCP tools still work.
				</p>

				<div className={styles.toggleRow}>
					<div className={styles.toggleText}>
						<span className="label">Show TCP catalog</span>
						<p className="hint">Top-level page for managing TCP tool definitions.</p>
					</div>
					<Switch
						checked={showTcpCatalog}
						onChange={setShowTcpCatalog}
						label="Show TCP catalog"
						disabled={savingUi || busy}
					/>
				</div>

				<div className={styles.toggleRow}>
					<div className={styles.toggleText}>
						<span className="label">Show RCI catalog</span>
						<p className="hint">Top-level page for managing resource sets.</p>
					</div>
					<Switch
						checked={showRciCatalog}
						onChange={setShowRciCatalog}
						label="Show RCI catalog"
						disabled={savingUi || busy}
					/>
				</div>

				<div className={styles.actions}>
					<button type="submit" className="btn btn--primary" disabled={savingUi || busy}>
						{savingUi ? "Saving…" : "Save"}
					</button>
					{uiSettings.updatedAt && (
						<span className="hint">Last saved {relativeTime(uiSettings.updatedAt)}</span>
					)}
				</div>
			</form>

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
							<p className="hint">
								Username is who receives messages. The tokens below are how the hub
								reaches Slack (browser session pair). With Slack open: copy{" "}
								<code>xoxc</code> from DevTools → console (workspace <code>token</code>{" "}
								in localStorage); copy <code>xoxd</code> from Application → Cookies →{" "}
								<code>d</code> on app.slack.com (HttpOnly — paste exactly). Leave a
								token blank to keep the stored value.
								{slackDeliverySettings.envConfigured && (
									<>
										{" "}
										Currently reading tokens from <code>.env</code> — save here to
										manage from Settings instead.
									</>
								)}
							</p>
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
							<Field
								label="xoxc token"
								hint={
									slackDeliverySettings.xoxcConfigured
										? "Leave blank to keep the stored token."
										: "Starts with xoxc-."
								}
							>
								{(props) => (
									<input
										{...props}
										type="password"
										className="input"
										autoComplete="off"
										value={xoxc}
										placeholder={slackDeliverySettings.xoxcConfigured ? "••••••••" : "xoxc-…"}
										onChange={(ev) => {
											setXoxc(ev.target.value);
											if (slackDeliveryError) setSlackDeliveryError(null);
										}}
									/>
								)}
							</Field>
							<Field
								label="xoxd token"
								hint={
									slackDeliverySettings.xoxdConfigured
										? "Leave blank to keep the stored token."
										: "Starts with xoxd- (the d cookie)."
								}
							>
								{(props) => (
									<input
										{...props}
										type="password"
										className="input"
										autoComplete="off"
										value={xoxd}
										placeholder={slackDeliverySettings.xoxdConfigured ? "••••••••" : "xoxd-…"}
										onChange={(ev) => {
											setXoxd(ev.target.value);
											if (slackDeliveryError) setSlackDeliveryError(null);
										}}
									/>
								)}
							</Field>
						</div>
					</div>
				)}

				{slackDeliveryError && (
					<p className="msg msg--error" role="alert">
						{slackDeliveryError}
					</p>
				)}

				<div className={styles.actions}>
					<button type="submit" className="btn btn--primary" disabled={saving || savingSlackDelivery || busy}>
						{saving || savingSlackDelivery ? "Saving…" : "Save"}
					</button>
					{(settings.updatedAt || slackDeliverySettings.updatedAt) && (
						<span className="hint">
							Last saved{" "}
							{relativeTime(
								[settings.updatedAt, slackDeliverySettings.updatedAt]
									.filter((value): value is string => value != null)
									.sort()
									.at(-1)!,
							)}
						</span>
					)}
				</div>
			</form>

			{linkStatus?.state !== "connected" && <form className={styles.section} aria-labelledby={`${reportId}-section`} onSubmit={submitReport}>
				<h3 className={styles.sectionHeading} id={`${reportId}-section`}>
					Activity reporting
				</h3>
				<p className="hint">
					Send workflow and step activity to a central server for monitoring. Stored by the hub — the same values apply in the desktop app and in the browser.
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
						<Field label="Conversation detail" hint="Choose what may leave this machine. Activity metadata is still reported when reporting is on.">
							{(props) => (
								<select {...props} className="input" value={reportConversations} onChange={(ev) => setReportConversations(ev.target.value as ReportSettings["includeConversations"])}>
									<option value="off">Off — no conversation data</option>
									<option value="digest">Digest — metadata and summary only (default)</option>
									<option value="full">Full — include conversation text</option>
								</select>
							)}
						</Field>
						<CollapsibleSection title="Legacy / Advanced endpoint configuration" defaultOpen={false}>
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

						</CollapsibleSection>
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
			</form>}

			{/* Atajos: the key each of the five hub shortcuts fires on. The
			    modifier is always Alt or Shift (the hook honours either), so only
			    the letter is configurable — one field per action. A Save here is a
			    separate PUT from notifications: they're independent resources with
			    their own validity, so a half-edited set in one never blocks the
			    other. */}
			
			<form className={styles.section} aria-labelledby={`${dockerFriendlyId}-section`} onSubmit={submitDockerFriendly}>
				<h3 className={styles.sectionHeading} id={`${dockerFriendlyId}-section`}>
					Docker-friendly hub networking
				</h3>
				<p className="hint">
					When the hub itself runs in Docker (or you need containers to reach it on the host),
					bind on all interfaces and advertise a host address sandboxes can dial.
					{dockerFriendlySettings.envConfigured && (
						<>
							{" "}
							Currently reading from <code>.env</code> — save here to manage from Settings
							instead.
						</>
					)}
				</p>

				<div className={styles.toggleRow}>
					<div className={styles.toggleText}>
						<span className="label">Docker-friendly hub networking</span>
						<p className="hint" id={`${dockerFriendlyId}-hint`}>
							{dockerFriendlyHub
								? "On — hub binds 0.0.0.0:8893 and sets sandboxHost so containers can reach the host."
								: "Off — loopback defaults (127.0.0.1 bind; no sandboxHost override)."}
						</p>
					</div>
					<Switch
						checked={dockerFriendlyHub}
						onChange={(next) => {
							setDockerFriendlyHub(next);
							if (dockerFriendlyError) setDockerFriendlyError(null);
						}}
						label="Docker-friendly hub networking"
						describedBy={`${dockerFriendlyId}-hint`}
						disabled={savingDockerFriendly || busy}
					/>
				</div>

				<p className="msg msg--warn" role="status">
					Restart the hub after changing this so the listen address takes effect.{" "}
					<code>sandboxHost</code> for new sandboxes updates on the next sync without a restart.
				</p>

				{dockerFriendlyError && (
					<p className="msg msg--error" role="alert">
						{dockerFriendlyError}
					</p>
				)}

				<div className={styles.actions}>
					<button type="submit" className="btn btn--primary" disabled={savingDockerFriendly || busy}>
						{savingDockerFriendly ? "Saving…" : "Save"}
					</button>
					{dockerFriendlySettings.updatedAt && (
						<span className="hint">Last saved {relativeTime(dockerFriendlySettings.updatedAt)}</span>
					)}
				</div>
			</form>


<div className={styles.section}>
				<CollapsibleSection
					title="Docker bind mounts"
					defaultOpen={dockerMounts.length > 0}
					meta={
						dockerMounts.length > 0 ? (
							<span className="hint">{dockerMounts.length} path{dockerMounts.length === 1 ? "" : "s"}</span>
						) : undefined
					}
				>
					<p className="hint">
						Host paths mounted at the same absolute path inside every <strong>docker</strong> workflow container.
						Use this for shared config such as <code>~/.m2</code> for Maven.
					</p>
					<form
						onSubmit={async (ev) => {
							ev.preventDefault();
							if (savingDockerMounts) return;
							setDockerMountError(null);
							setSavingDockerMounts(true);
							try {
								const ok = await onSaveDockerMounts({ mounts: dockerMounts });
								if (!ok) setDockerMountError("Could not save docker bind mounts.");
							} finally {
								setSavingDockerMounts(false);
							}
						}}
					>
						<DockerMountEditor mounts={dockerMounts} onChange={setDockerMounts} disabled={savingDockerMounts || busy} />
						{dockerMountError && (
							<p className="msg msg--error" role="alert">
								{dockerMountError}
							</p>
						)}
						<div className={styles.actions}>
							<button type="submit" className="btn btn--sm btn--primary" disabled={savingDockerMounts || busy}>
								{savingDockerMounts ? "Saving…" : "Save"}
							</button>
							{dockerMountSettings.updatedAt && (
								<span className="hint">Last saved {relativeTime(dockerMountSettings.updatedAt)}</span>
							)}
						</div>
					</form>
				</CollapsibleSection>
			</div>

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
