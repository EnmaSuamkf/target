import { useEffect, useId, useState } from "react";
import { ApiError, getModelSettings, listHostCapabilities, saveModelSettings } from "../api/client.ts";
import type { ModelSettings, Runner } from "../api/types.ts";
import { relativeTime } from "../lib/format.ts";
import styles from "../views/SettingsView.module.css";
import modelStyles from "./AgentModelsSection.module.css";
import { useToast } from "./Toast.tsx";

const RUNNER_NAMES: Record<Runner, string> = {
	claude: "Claude Code",
	"free-code": "free-code",
	cursor: "Cursor Agent",
	copilot: "GitHub Copilot",
};

/** Per-agent draft: which catalog ids are ticked, plus the operator's custom ids. */
interface Draft {
	enabled: string[];
	custom: string[];
}

function draftsFrom(settings: ModelSettings): Partial<Record<Runner, Draft>> {
	const drafts: Partial<Record<Runner, Draft>> = {};
	for (const [runner, entry] of Object.entries(settings.runners) as [Runner, NonNullable<ModelSettings["runners"][Runner]>][]) {
		drafts[runner] = {
			enabled: entry.models.filter((m) => m.source !== "custom" && m.enabled).map((m) => m.id),
			custom: [...entry.custom],
		};
	}
	return drafts;
}

/**
 * Settings > Agent models: which models a workflow's Model picker may offer for
 * each INSTALLED agent. It does not choose a workflow's model — that happens on
 * the workflow, from the ids ticked here. Loads its own data and saves with its
 * own button like the other sections.
 */
export function AgentModelsSection({ disabled = false }: { disabled?: boolean }): React.JSX.Element {
	const headingId = useId();
	const toast = useToast();
	const [settings, setSettings] = useState<ModelSettings | null>(null);
	const [installed, setInstalled] = useState<Runner[]>([]);
	const [drafts, setDrafts] = useState<Partial<Record<Runner, Draft>>>({});
	const [newCustom, setNewCustom] = useState<Partial<Record<Runner, string>>>({});
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const [caps, loaded] = await Promise.all([listHostCapabilities(), getModelSettings()]);
				if (cancelled) return;
				setInstalled(caps.runners.filter((r) => r.installed).map((r) => r.id));
				setSettings(loaded);
				setDrafts(draftsFrom(loaded));
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : "Could not load agent models.");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const update = (runner: Runner, change: (draft: Draft) => Draft): void => {
		setDrafts((prev) => ({ ...prev, [runner]: change(prev[runner] ?? { enabled: [], custom: [] }) }));
		if (error) setError(null);
	};

	const addCustom = (runner: Runner): void => {
		const id = (newCustom[runner] ?? "").trim();
		if (id === "") return;
		if (/\s/.test(id) || id.startsWith("-")) {
			setError("A model id can't contain spaces or start with “-”.");
			return;
		}
		update(runner, (d) => (d.custom.includes(id) ? d : { ...d, custom: [...d.custom, id] }));
		setNewCustom((prev) => ({ ...prev, [runner]: "" }));
	};

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (saving || !settings) return;
		setSaving(true);
		setError(null);
		try {
			// PUT replaces the whole allowlist, so agents not shown here (not
			// installed) are sent back exactly as they were loaded.
			const runners: Record<string, Draft> = {};
			for (const [runner, draft] of Object.entries(drafts)) runners[runner] = draft;
			const saved = await saveModelSettings({ runners });
			setSettings(saved);
			setDrafts(draftsFrom(saved));
			toast.success("Agent models saved.");
		} catch (err) {
			setError(err instanceof ApiError ? err.message : "Could not save agent models.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<form className={styles.section} aria-labelledby={`${headingId}-section`} onSubmit={submit}>
			<h3 className={styles.sectionHeading} id={`${headingId}-section`}>
				Agent models
			</h3>
			<p className="hint">
				Choose which models each installed agent may use. This list only controls what the Model picker offers
				on a workflow; it does not pick a workflow&rsquo;s model, and a workflow that already uses a model you
				untick keeps it. Leave a workflow on <strong>CLI default</strong> to let the agent&rsquo;s own CLI
				decide. GitHub Copilot has no model list the hub can read without spending requests, so add its ids
				yourself.
			</p>
			{!settings && !error && <p className="hint">Loading…</p>}
			{settings && installed.length === 0 && <p className="hint">No agent CLI is installed on this host.</p>}
			{settings &&
				installed.map((runner) => {
					const entry = settings.runners[runner];
					const draft = drafts[runner] ?? { enabled: [], custom: [] };
					const catalog = (entry?.models ?? []).filter((m) => m.source !== "custom");
					return (
						<fieldset key={runner} className={modelStyles.agent} disabled={disabled || saving}>
							<legend className={modelStyles.legend}>{RUNNER_NAMES[runner]}</legend>
							{catalog.length === 0 && draft.custom.length === 0 && (
								<p className="hint">No models known for this agent yet. Add one below.</p>
							)}
							<ul className={modelStyles.list}>
								{catalog.map((model) => (
									<li key={model.id}>
										<label className={modelStyles.option}>
											<input
												type="checkbox"
												checked={draft.enabled.includes(model.id)}
												onChange={(ev) =>
													update(runner, (d) => ({
														...d,
														enabled: ev.target.checked
															? [...d.enabled, model.id]
															: d.enabled.filter((id) => id !== model.id),
													}))
												}
											/>
											<span>
												<code>{model.id}</code>
												{model.label !== model.id && <span className="hint"> {model.label}</span>}
												{model.source === "live" && <span className="hint"> · found on this machine</span>}
											</span>
										</label>
									</li>
								))}
								{draft.custom.map((id) => (
									<li key={`custom:${id}`} className={modelStyles.customRow}>
										<span>
											<code>{id}</code>
											<span className="hint"> · custom</span>
										</span>
										<button
											type="button"
											className="btn btn--sm btn--ghost"
											onClick={() => update(runner, (d) => ({ ...d, custom: d.custom.filter((c) => c !== id) }))}
										>
											Remove
										</button>
									</li>
								))}
							</ul>
							<div className={modelStyles.addRow}>
								<input
									type="text"
									className="input"
									aria-label={`Custom model id for ${RUNNER_NAMES[runner]}`}
									placeholder="Add a custom model id"
									value={newCustom[runner] ?? ""}
									onChange={(ev) => setNewCustom((prev) => ({ ...prev, [runner]: ev.target.value }))}
									onKeyDown={(ev) => {
										if (ev.key === "Enter") {
											ev.preventDefault();
											addCustom(runner);
										}
									}}
								/>
								<button type="button" className="btn btn--sm" onClick={() => addCustom(runner)}>
									Add
								</button>
							</div>
						</fieldset>
					);
				})}
			{error && (
				<p className="msg msg--error" role="alert">
					{error}
				</p>
			)}
			<div className={styles.actions}>
				<button type="submit" className="btn btn--primary" disabled={saving || disabled || !settings}>
					{saving ? "Saving…" : "Save"}
				</button>
				{settings?.updatedAt && <span className="hint">Last saved {relativeTime(settings.updatedAt)}</span>}
			</div>
		</form>
	);
}
