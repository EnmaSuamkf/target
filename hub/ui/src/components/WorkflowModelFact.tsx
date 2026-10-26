import { useEffect, useRef, useState } from "react";
import { listHostCapabilities } from "../api/client.ts";
import type { RunnerModel, Workflow } from "../api/types.ts";
import styles from "./WorkflowModelFact.module.css";

/**
 * The editable "Model" fact on the workflow detail. The runner is fixed at
 * create; only the model changes, from the next spawn on. Options are CLI
 * default + the models Settings has enabled for this workflow's agent, plus the
 * id the workflow already has even if Settings has since disabled it
 * (grandfathered).
 *
 * The catalog is not fetched with the workflow. "List models" loads it: that
 * request reads each CLI's config and used to stall the hub on every open.
 */
export function WorkflowModelFact({
	className,
	workflow,
	locked,
	disabled,
	disabledTitle,
	onSave,
}: {
	className?: string | undefined;
	workflow: Workflow;
	/** A step is running or about to be dispatched: the model can't change right now. */
	locked: boolean;
	disabled: boolean;
	disabledTitle?: string | undefined;
	onSave: (model: string) => Promise<boolean>;
}): React.JSX.Element {
	const stored = workflow.model ?? "";
	const [enabled, setEnabled] = useState<RunnerModel[]>([]);
	// Until the list lands, the stored id is shown plainly rather than as "not enabled".
	const [loaded, setLoaded] = useState(false);
	const [listing, setListing] = useState(false);
	const [listError, setListError] = useState<string | null>(null);
	const [draft, setDraft] = useState(stored);
	const [saving, setSaving] = useState(false);
	// Bumped when the workflow changes so a list requested for the previous one
	// cannot land on this one. The first render does not bump it: the button is
	// already on screen, and a mount-time reset would drop a click that landed
	// before the effect ran.
	const listRequest = useRef(0);
	const listedFor = useRef<{ id: string; harness: string | null } | null>(null);

	useEffect(() => {
		const prev = listedFor.current;
		listedFor.current = { id: workflow.id, harness: workflow.harness };
		if (!prev || (prev.id === workflow.id && prev.harness === workflow.harness)) return;
		listRequest.current += 1;
		setEnabled([]);
		setLoaded(false);
		setListing(false);
		setListError(null);
	}, [workflow.id, workflow.harness]);

	const listModels = (): void => {
		const request = ++listRequest.current;
		setListing(true);
		setListError(null);
		void listHostCapabilities({ models: true })
			.then((caps) => {
				if (listRequest.current !== request) return;
				setEnabled(caps.runners.find((r) => r.id === workflow.harness)?.models ?? []);
				setLoaded(true);
			})
			.catch(() => {
				if (listRequest.current !== request) return;
				setListError("Couldn't load models. The saved model is still shown.");
			})
			.finally(() => {
				if (listRequest.current === request) setListing(false);
			});
	};

	// The draft follows the saved value (a poll or a save lands a new one) but is
	// never reset by a poll that returns the same thing.
	useEffect(() => {
		setDraft(stored);
	}, [workflow.id, stored]);

	const storedNotEnabled = stored !== "" && !enabled.some((m) => m.id === stored);
	const grandfathered = storedNotEnabled ? stored : null;
	const dirty = draft !== stored;

	return (
		<div className={`${styles.block} ${className ?? ""}`} data-workflow-model>
			<label className={styles.label} htmlFor={`model-${workflow.id}`}>
				Model
			</label>
			<div className={styles.row}>
				<select
					id={`model-${workflow.id}`}
					className="select"
					value={draft}
					disabled={disabled || locked || saving}
					title={disabledTitle}
					onChange={(ev) => setDraft(ev.target.value)}
				>
					<option value="">CLI default</option>
					{grandfathered && (
						<option value={grandfathered}>{loaded ? `${grandfathered} (not enabled in Settings)` : grandfathered}</option>
					)}
					{enabled.map((m) => (
						<option key={m.id} value={m.id}>
							{m.label === m.id ? m.id : `${m.label} (${m.id})`}
						</option>
					))}
				</select>
				<button
					type="button"
					className={`btn btn--sm${listing ? " btn--busy" : ""}`}
					disabled={disabled || listing}
					title={disabledTitle}
					aria-busy={listing}
					aria-label={listing ? "Loading models" : undefined}
					onClick={listModels}
				>
					{listing ? <span className="spinner" aria-hidden="true" /> : "List models"}
				</button>
				<button
					type="button"
					className="btn btn--sm btn--primary"
					disabled={disabled || locked || saving || !dirty}
					title={disabledTitle}
					onClick={() => {
						void (async () => {
							setSaving(true);
							try {
								await onSave(draft);
							} finally {
								setSaving(false);
							}
						})();
					}}
				>
					{saving ? "Saving…" : "Save"}
				</button>
			</div>
			{listError && (
				<p className="msg msg--error" role="alert">
					{listError}
				</p>
			)}
			{!loaded && !listError && (
				<p className="hint">List models to choose one enabled in Settings. Until then this stays on the saved value.</p>
			)}
			{locked && <p className="hint">A step is running. Change the model once it finishes.</p>}
			{workflow.lastSessionId && (
				<p className="msg msg--warn" role="note" data-model-session-warning>
					This workflow already has a session. The next step will request this model, but some CLIs keep the
					session&rsquo;s original model when they resume.
				</p>
			)}
		</div>
	);
}
