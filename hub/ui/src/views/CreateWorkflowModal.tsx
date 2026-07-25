import { useEffect, useState } from "react";
import type { CreateWorkflowInput, PermissionMode, Template } from "../api/types.ts";
import { Field } from "../components/Field.tsx";
import { Modal } from "../components/Modal.tsx";
import styles from "./CreateWorkflowModal.module.css";

/**
 * New-workflow dialog.
 *
 * Permission modes are described rather than listed as bare enum values,
 * because the choice decides what the workflow's agent may do on this machine.
 * `bypassPermissions` additionally requires `acceptBypassRisk: true` — the
 * server rejects it otherwise — so it's gated behind an explicit checkbox with
 * the consequence spelled out instead of hidden in a `<select>` option.
 *
 * Conversation context is deliberately absent: the API ignores it at creation
 * time, it's set from the workflow's detail pane afterwards.
 */

const PERMISSION_OPTIONS: { value: "" | PermissionMode; label: string; description: string }[] = [
	{ value: "", label: "Read-only (default)", description: "The agent can answer but cannot write files or run commands." },
	{ value: "acceptEdits", label: "acceptEdits", description: "Can write files inside the workflow's sandbox." },
	{ value: "auto", label: "auto", description: "Harness decides per action." },
	{ value: "dontAsk", label: "dontAsk", description: "Never prompts for confirmation." },
	{ value: "plan", label: "plan", description: "Planning only — no execution." },
	{
		value: "bypassPermissions",
		label: "bypassPermissions",
		description: "No restrictions at all — arbitrary command execution on this machine.",
	},
];

export function CreateWorkflowModal({
	open,
	templates,
	onClose,
	onCreate,
}: {
	open: boolean;
	templates: Template[];
	onClose: () => void;
	onCreate: (input: CreateWorkflowInput) => Promise<void>;
}): React.JSX.Element {
	const [name, setName] = useState("");
	const [workdir, setWorkdir] = useState("");
	const [permissionMode, setPermissionMode] = useState<"" | PermissionMode>("");
	const [templateId, setTemplateId] = useState("");
	const [acceptRisk, setAcceptRisk] = useState(false);
	const [saving, setSaving] = useState(false);

	// Fresh form on every open.
	useEffect(() => {
		if (!open) return;
		setName("");
		setWorkdir("");
		setPermissionMode("");
		setTemplateId("");
		setAcceptRisk(false);
	}, [open]);

	const bypass = permissionMode === "bypassPermissions";
	const canSubmit = name.trim() !== "" && (!bypass || acceptRisk) && !saving;

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (!canSubmit) return;
		setSaving(true);
		try {
			const input: CreateWorkflowInput = { name: name.trim() };
			if (workdir.trim()) input.workdir = workdir.trim();
			if (permissionMode) input.permissionMode = permissionMode;
			if (templateId) input.templateId = templateId;
			if (bypass) input.acceptBypassRisk = true;
			await onCreate(input);
		} finally {
			setSaving(false);
		}
	};

	const selectedOption = PERMISSION_OPTIONS.find((o) => o.value === permissionMode);

	return (
		<Modal
			open={open}
			title="New workflow"
			description="Creates a dedicated agent and hook. Its steps then run in order on one shared session."
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn" onClick={onClose} disabled={saving}>
						Cancel
					</button>
					<button type="submit" form="create-workflow" className="btn btn--primary" disabled={!canSubmit}>
						{saving ? "Creating…" : "Create workflow"}
					</button>
				</>
			}
		>
			<form id="create-workflow" className={styles.form} onSubmit={submit}>
				<Field label="Name" required>
					{(props) => (
						<input
							{...props}
							type="text"
							className="input"
							value={name}
							placeholder="e.g. release-notes"
							onChange={(ev) => setName(ev.target.value)}
							required
							autoFocus
						/>
					)}
				</Field>

				<Field
					label="Working directory"
					hint="Where this workflow's agent works. Leave empty for a dedicated sandbox under ~/.target/sandboxes/."
				>
					{(props) => (
						<input
							{...props}
							type="text"
							className="input"
							value={workdir}
							placeholder="~/my-project"
							onChange={(ev) => setWorkdir(ev.target.value)}
						/>
					)}
				</Field>

				<Field label="Agent permissions" {...(selectedOption ? { hint: selectedOption.description } : {})}>
					{(props) => (
						<select
							{...props}
							className="select"
							value={permissionMode}
							onChange={(ev) => {
								setPermissionMode(ev.target.value as "" | PermissionMode);
								setAcceptRisk(false);
							}}
						>
							{PERMISSION_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					)}
				</Field>

				{bypass && (
					<label className={styles.risk}>
						<input type="checkbox" checked={acceptRisk} onChange={(ev) => setAcceptRisk(ev.target.checked)} />
						<span>
							<strong>I understand the risk.</strong> Every step of this workflow will be able to run any command on
							this machine with no permission checks.
						</span>
					</label>
				)}

				{templates.length > 0 && (
					<Field label="Start from template" hint="Optional — seeds the workflow with the template's steps.">
						{(props) => (
							<select
								{...props}
								className="select"
								value={templateId}
								onChange={(ev) => setTemplateId(ev.target.value)}
							>
								<option value="">No template — start empty</option>
								{templates.map((template) => (
									<option key={template.id} value={template.id}>
										{template.name} ({template.steps.length} steps)
									</option>
								))}
							</select>
						)}
					</Field>
				)}
			</form>
		</Modal>
	);
}
