import { useId, useState } from "react";
import type { NotificationSettings, NotificationSettingsInput } from "../api/types.ts";
import { Field } from "../components/Field.tsx";
import { Switch } from "../components/Switch.tsx";
import { relativeTime } from "../lib/format.ts";
import styles from "./SettingsView.module.css";

/**
 * Configuration: hub-wide preferences, one section per topic. Notifications is
 * the only section so far — a master switch plus, when it's on, the channels the
 * user wants to be reached on.
 *
 * Everything is edited locally and committed by one Save at the bottom (a single
 * PUT), rather than saving on every keystroke: a half-typed username is not a
 * preference worth persisting, and the switch and the channel it gates have to
 * be valid together to be storable at all.
 */
export function SettingsView({
	settings,
	busy,
	onSave,
}: {
	settings: NotificationSettings;
	busy: boolean;
	onSave: (input: NotificationSettingsInput) => Promise<boolean>;
}): React.JSX.Element {
	const [enabled, setEnabled] = useState(settings.enabled);
	const [slackUsername, setSlackUsername] = useState(settings.channels.slack.username);
	const [slackError, setSlackError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const notificationsId = useId();
	const hintId = `${notificationsId}-hint`;

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

	return (
		<form className={styles.panel} onSubmit={submit}>
			<div className={styles.head}>
				<h2 className={styles.heading}>Configuration</h2>
				<p className="hint">
					Preferences for this hub. They're stored by the hub itself, so every browser sees the same values.
				</p>
			</div>

			<section className={styles.section} aria-labelledby={`${notificationsId}-section`}>
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
			</section>

			<div className={styles.actions}>
				<button type="submit" className="btn btn--primary" disabled={saving || busy}>
					{saving ? "Saving…" : "Save"}
				</button>
				{settings.updatedAt && <span className="hint">Last saved {relativeTime(settings.updatedAt)}</span>}
			</div>
		</form>
	);
}
