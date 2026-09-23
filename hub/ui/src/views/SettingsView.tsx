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
	SyncSettings,
	UiSettings,
	UiSettingsInput,
} from "../api/types.ts";
import * as api from "../api/client.ts";
import { CollapsibleSection } from "../components/CollapsibleSection.tsx";
import { DockerMountEditor } from "../components/DockerMountEditor.tsx";
import { Field } from "../components/Field.tsx";
import { Switch } from "../components/Switch.tsx";
import { useToast } from "../components/Toast.tsx";
import { usePermissions } from "../hooks/usePermissions.ts";
import { relativeTime } from "../lib/format.ts";
import styles from "./SettingsView.module.css";

const MODE_LABEL: Record<string, string> = {
	unrestricted: "Sin vincular — todo permitido",
	enforced: "Aplicado — el servidor recorta lo concedido",
	read_only: "Solo lectura",
};

/**
 * Configuration: hub-wide preferences, one section per topic. Notifications is
 * the master switch plus the channels it gates; Shortcuts is the master switch
 * plus the key each of the five hub shortcuts fires on.
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

/** Eye / eye-off for the Slack token reveal toggles. */
function SecretVisibilityIcon({ revealed }: { revealed: boolean }): React.JSX.Element {
	if (revealed) {
		// Eye-off: token is visible; click will hide it.
		return (
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
				<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
				<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
				<line x1="1" y1="1" x2="23" y2="23" />
			</svg>
		);
	}
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	);
}

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

	// Seeded from the admin GET so configured tokens show as password dots
	// instead of an empty field with a placeholder. Parent remounts on save
	// stamp, so this initializer is enough — no mid-edit re-seed.
	const [xoxc, setXoxc] = useState(slackDeliverySettings.xoxc ?? "");
	const [xoxd, setXoxd] = useState(slackDeliverySettings.xoxd ?? "");
	const [showXoxc, setShowXoxc] = useState(false);
	const [showXoxd, setShowXoxd] = useState(false);
	const [slackDeliveryError, setSlackDeliveryError] = useState<string | null>(null);
	const [savingSlackDelivery, setSavingSlackDelivery] = useState(false);

	const toast = useToast();
	const [testingConnection, setTestingConnection] = useState(false);
	const [testConnectionMessage, setTestConnectionMessage] = useState<{
		kind: "success" | "error";
		text: string;
	} | null>(null);

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
	const [shortcutsEnabled, setShortcutsEnabled] = useState(shortcutSettings.enabled !== false);
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
	const [syncSettings, setSyncSettings] = useState<SyncSettings | null>(null);
	const [syncBusy, setSyncBusy] = useState(false);
	const {
		mode,
		can,
		readOnly,
		reason,
		granted,
		origin: permissionsOrigin,
		ownerId,
		linkState,
		receivedAt,
	} = usePermissions();
	const canManage = can("remote.workflows.manage");
	const manageTitle = "Requiere remote.workflows.manage";
	const permissionsId = useId();

	const notificationsId = useId();
	const catalogNavId = useId();
	const hintId = `${notificationsId}-hint`;
	const shortcutsId = useId();
	const shortcutsHintId = `${shortcutsId}-hint`;
	const reportId = useId();
	const dockerFriendlyId = useId();
	const dockerMountsId = useId();
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
		void api.getSyncSettings().then(setSyncSettings).catch(() => {
			/* Sync prefs are optional; the panel still renders. */
		});
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
		setTestConnectionMessage(null);
		setSaving(true);
		setSavingSlackDelivery(true);
		try {
			await onSave({ enabled, channels: { slack: { username } } });
			// Fields are seeded with stored values, so Save always submits what is
			// currently in the inputs. (Server still treats a blank half as
			// keep-existing if the operator clears a field.)
			const ok = await onSaveSlackDelivery({
				xoxc: xoxc.trim(),
				xoxd: xoxd.trim(),
			});
			if (!ok) {
				setSlackDeliveryError("Could not save Slack credentials.");
			}
		} finally {
			setSaving(false);
			setSavingSlackDelivery(false);
		}
	};

	/** One-shot Slack DM — does not persist settings; backend bypasses the master switch. */
	const testConnection = async (): Promise<void> => {
		const username = slackUsername.trim();
		if (
			username === "" ||
			testingConnection ||
			saving ||
			savingSlackDelivery ||
			busy
		) {
			return;
		}
		setTestConnectionMessage(null);
		setTestingConnection(true);
		try {
			const result = await api.testNotificationConnection({ username });
			if (result.sent) {
				const message = "Slack connection test succeeded — check your DMs.";
				setTestConnectionMessage({ kind: "success", text: message });
				toast.success(message);
			} else {
				const message = result.detail
					? `Connection test failed (${result.reason}): ${result.detail}`
					: `Connection test failed (${result.reason}).`;
				setTestConnectionMessage({ kind: "error", text: message });
				toast.error(message);
			}
		} catch (err) {
			const message = `Connection test failed: ${err instanceof Error ? err.message : String(err)}`;
			setTestConnectionMessage({ kind: "error", text: message });
			toast.error(message);
		} finally {
			setTestingConnection(false);
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
		// Key rows are hidden while off, but bindings still save with the switch so
		// turning shortcuts back on restores the same keys. Only validate when on.
		if (shortcutsEnabled) {
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
		}
		setShortcutError(null);
		setSavingShortcuts(true);
		try {
			await onSaveShortcuts({
				enabled: shortcutsEnabled,
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

	const submitDockerMounts = async (ev: React.FormEvent): Promise<void> => {
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

			<section className={styles.section} aria-labelledby={`${permissionsId}-section`}>
				<h3 className={styles.sectionHeading} id={`${permissionsId}-section`}>
					Permisos de tu rol
				</h3>
				<p className="hint">
					Estado del modo: <strong>{MODE_LABEL[mode] ?? mode}</strong>
					{reason ? ` · ${reason.replaceAll("_", " ")}` : ""}
					{ownerId ? ` · owner ${ownerId}` : ""}
					{` · vínculo ${linkState.replaceAll("_", " ")}`}
				</p>
				<p className="hint">
					Origen del servidor:{" "}
					<strong>{permissionsOrigin ?? linkStatus?.origin ?? "ninguno"}</strong>
					{receivedAt ? ` · recibido ${relativeTime(receivedAt)}` : ""}
				</p>
				{readOnly && (
					<p className="msg msg--error" role="note">
						Este hub está en solo-lectura: las mutaciones quedan bloqueadas hasta que el owner
						vuelva a estar vivo o el dispositivo se desvincule.
					</p>
				)}
				{granted.groups.length > 0 ? (
					<ul className={styles.granted}>
						{granted.groups.map((group) => (
							<li key={group.id}>
								<strong>{group.label}</strong>
								<ul>
									{group.permissions.map((perm) => (
										<li key={perm.id}>
											<code>{perm.id}</code>
											{perm.label ? ` — ${perm.label}` : ""}
										</li>
									))}
								</ul>
							</li>
						))}
					</ul>
				) : (
					<p className="hint">
						{mode === "unrestricted"
							? "Sin owner: no hay lista recortada porque este hub no aplica rol."
							: "El servidor no envió grupos concedidos (o el snapshot aún no llegó)."}
					</p>
				)}
				<p className="msg msg--error" role="note">
					Esto es gobernanza de UI, no una frontera de seguridad. Quien tenga una shell en esta
					máquina puede saltárselo: token de admin, CLI, <code>~/.target/target.db</code> o
					borrar <code>device-link.json</code>. El límite real sigue en target-server.
				</p>
			</section>

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
						<div className={styles.toggleRow} title={canManage ? undefined : manageTitle}>
							<div className={styles.toggleText}>
								<span className="label">Remote Sync</span>
								<p className="hint" id={`${linkId}-sync`}>
									Activa o pausa la sincronización remota. Mientras el dispositivo está vinculado exige{" "}
									<code>remote.workflows.manage</code>.
								</p>
							</div>
							<Switch
								checked={syncSettings?.enabled ?? linkStatus.scopes.includes("sync:write")}
								onChange={(next) => {
									if (!canManage || syncBusy) return;
									setSyncBusy(true);
									void api
										.saveSyncSettings({ enabled: next })
										.then(setSyncSettings)
										.catch(() => {
											/* toast from the 403 interceptor */
										})
										.finally(() => setSyncBusy(false));
								}}
								label="Remote Sync"
								describedBy={`${linkId}-sync`}
								disabled={!canManage || syncBusy}
							/>
						</div>
						<div className={styles.actions}>
						<button
							type="button"
							className="btn btn--secondary"
							disabled={linkBusy || !canManage}
							title={canManage ? undefined : manageTitle}
							onClick={async () => {
							setLinkBusy(true);
							try { applyLinkOutcome(await api.cancelDeviceLink()); } finally { setLinkBusy(false); }
						}}>{linkBusy ? "Disconnecting…" : "Disconnect this device"}</button>
						<button
							type="button"
							className="btn btn--primary"
							disabled={linkBusy || !canManage}
							title={canManage ? undefined : manageTitle}
							onClick={async () => {
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
								<code>d</code> on app.slack.com (HttpOnly — paste exactly). Stored
								tokens load as dots; use the eye to reveal, edit to replace, then
								Save.
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
									slackDeliverySettings.xoxcConfigured || xoxc !== ""
										? "Loaded from the hub. Edit to replace, then Save."
										: "Starts with xoxc-."
								}
							>
								{(props) => (
									<div className={styles.secretField}>
										<input
											{...props}
											type={showXoxc ? "text" : "password"}
											className="input"
											autoComplete="off"
											spellCheck={false}
											value={xoxc}
											placeholder={xoxc === "" ? "xoxc-…" : undefined}
											onChange={(ev) => {
												setXoxc(ev.target.value);
												if (slackDeliveryError) setSlackDeliveryError(null);
											}}
										/>
										<button
											type="button"
											className={`btn btn--ghost ${styles.secretToggle}`}
											aria-label={showXoxc ? "Hide xoxc token" : "Show xoxc token"}
											aria-pressed={showXoxc}
											onClick={() => setShowXoxc((v) => !v)}
										>
											<SecretVisibilityIcon revealed={showXoxc} />
										</button>
									</div>
								)}
							</Field>
							<Field
								label="xoxd token"
								hint={
									slackDeliverySettings.xoxdConfigured || xoxd !== ""
										? "Loaded from the hub. Edit to replace, then Save."
										: "Starts with xoxd- (the d cookie)."
								}
							>
								{(props) => (
									<div className={styles.secretField}>
										<input
											{...props}
											type={showXoxd ? "text" : "password"}
											className="input"
											autoComplete="off"
											spellCheck={false}
											value={xoxd}
											placeholder={xoxd === "" ? "xoxd-…" : undefined}
											onChange={(ev) => {
												setXoxd(ev.target.value);
												if (slackDeliveryError) setSlackDeliveryError(null);
											}}
										/>
										<button
											type="button"
											className={`btn btn--ghost ${styles.secretToggle}`}
											aria-label={showXoxd ? "Hide xoxd token" : "Show xoxd token"}
											aria-pressed={showXoxd}
											onClick={() => setShowXoxd((v) => !v)}
										>
											<SecretVisibilityIcon revealed={showXoxd} />
										</button>
									</div>
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
					<button
						type="submit"
						className="btn btn--primary"
						disabled={saving || savingSlackDelivery || testingConnection || busy}
					>
						{saving || savingSlackDelivery ? "Saving…" : "Save"}
					</button>
					<button
						type="button"
						className="btn btn--ghost"
						disabled={
							saving ||
							savingSlackDelivery ||
							testingConnection ||
							busy ||
							slackUsername.trim() === ""
						}
						onClick={() => void testConnection()}
					>
						{testingConnection ? "Testing…" : "Test connection"}
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
				{testConnectionMessage && (
					<p
						className={testConnectionMessage.kind === "error" ? "msg msg--error" : "hint"}
						role={testConnectionMessage.kind === "error" ? "alert" : "status"}
					>
						{testConnectionMessage.text}
					</p>
				)}
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


			<form className={styles.section} aria-labelledby={`${dockerMountsId}-section`} onSubmit={submitDockerMounts}>
				<h3 className={styles.sectionHeading} id={`${dockerMountsId}-section`}>
					Docker bind mounts
				</h3>
				<p className="hint">
					Host paths mounted at the same absolute path inside every <strong>docker</strong> workflow container.
					Use this for shared config such as <code>~/.m2</code> for Maven.
				</p>
				<DockerMountEditor mounts={dockerMounts} onChange={setDockerMounts} disabled={savingDockerMounts || busy} />
				{dockerMountError && (
					<p className="msg msg--error" role="alert">
						{dockerMountError}
					</p>
				)}
				<div className={styles.actions}>
					<button type="submit" className="btn btn--primary" disabled={savingDockerMounts || busy}>
						{savingDockerMounts ? "Saving…" : "Save"}
					</button>
					{dockerMountSettings.updatedAt && (
						<span className="hint">Last saved {relativeTime(dockerMountSettings.updatedAt)}</span>
					)}
				</div>
			</form>

			{/* Shortcuts: master enable switch plus the key each of the five hub
			    shortcuts fires on. The modifier is always Alt or Shift (the hook
			    honours either), so only the letter is configurable — one field per
			    action. A Save here is a separate PUT from notifications: they're
			    independent resources with their own validity, so a half-edited set
			    in one never blocks the other. */}
			<form className={styles.section} aria-labelledby={`${shortcutsId}-section`} onSubmit={submitShortcuts}>
				<h3 className={styles.sectionHeading} id={`${shortcutsId}-section`}>
					Shortcuts
				</h3>

				<div className={styles.toggleRow}>
					<div className={styles.toggleText}>
						<span className="label">Keyboard shortcuts</span>
						<p className="hint" id={shortcutsHintId}>
							{shortcutsEnabled
								? "On — configure below which key fires each action."
								: "Off — shortcuts do nothing, and the key bindings stay hidden."}
						</p>
					</div>
					<Switch
						checked={shortcutsEnabled}
						onChange={(next) => {
							setShortcutsEnabled(next);
							if (!next) setShortcutError(null);
						}}
						label="Keyboard shortcuts"
						describedBy={shortcutsHintId}
						disabled={savingShortcuts || busy}
					/>
				</div>

				{/* Key bindings are only meaningful while shortcuts are on, so they
			    appear with the switch rather than sitting there disabled. Bindings
			    stay in local state while off so re-enabling does not wipe keys. */}
				{shortcutsEnabled && (
					<>
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
					</>
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
