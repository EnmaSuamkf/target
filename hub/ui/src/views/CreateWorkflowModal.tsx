import { useEffect, useState } from "react";
import type { CreateWorkflowInput, PermissionMode, Runner, Sandbox, Template } from "../api/types.ts";
import { DirectoryBrowser } from "../components/DirectoryBrowser.tsx";
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
 * The sandbox sits right next to the runtime because the two answer different
 * halves of the same question — which CLI runs the steps, and where it runs —
 * and because the sandbox is what bounds the permission choice below it:
 * `bypassPermissions` in a container means "anything inside these mounts",
 * not "anything on this machine".
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

const SANDBOX_OPTIONS: { value: Sandbox; label: string; description: string }[] = [
	{
		value: "host",
		label: "This machine (default)",
		description: "The agent runs directly on this machine, as you — its permissions are the only limit.",
	},
	{
		value: "docker",
		label: "Docker container",
		description:
			"Every step runs inside a container. Only the working directory and the harness's own state are mounted, so the agent can't reach the rest of your filesystem.",
	},
];

const RUNNER_OPTIONS: { value: Runner; label: string; description: string }[] = [
	{ value: "claude", label: "Claude Code (default)", description: "Steps run on claude -p / claude --resume." },
	{
		value: "free-code",
		label: "free-code",
		description: "Steps run on the free-code CLI; sessions are .jsonl files chained the same way.",
	},
];

/**
 * Mirrors the server's `DEFAULT_SANDBOX_IMAGES` (hub/awb.ts) so the image box
 * shows the image the workflow will actually get. It's per runner because the
 * runner's binary is the container command — the claude image has no
 * `free-code` in it.
 */
const DEFAULT_IMAGES: Record<Runner, string> = {
	claude: "target-agent:latest",
	"free-code": "target-agent-freecode:latest",
};

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
	const [runner, setRunner] = useState<Runner>("claude");
	const [sandbox, setSandbox] = useState<Sandbox>("host");
	const [image, setImage] = useState("");
	const [permissionMode, setPermissionMode] = useState<"" | PermissionMode>("");
	const [templateId, setTemplateId] = useState("");
	const [acceptRisk, setAcceptRisk] = useState(false);
	const [saving, setSaving] = useState(false);
	const [browsing, setBrowsing] = useState(false);

	// Fresh form on every open.
	useEffect(() => {
		if (!open) return;
		setName("");
		setWorkdir("");
		setRunner("claude");
		setSandbox("host");
		setImage("");
		setPermissionMode("");
		setTemplateId("");
		setAcceptRisk(false);
		setBrowsing(false);
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
			if (runner !== "claude") input.runner = runner;
			if (sandbox !== "host") input.sandbox = sandbox;
			if (sandbox === "docker" && image.trim()) input.image = image.trim();
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
					hint="Where this workflow's agent works. Leave empty for a dedicated sandbox under ~/.target/sandboxes/. Type a path or browse with …"
				>
					{(props) => (
						<div className={styles.workdirRow}>
							<input
								{...props}
								type="text"
								className="input"
								value={workdir}
								placeholder="~/my-project"
								onChange={(ev) => setWorkdir(ev.target.value)}
							/>
							<button
								type="button"
								className="btn"
								onClick={() => setBrowsing((value) => !value)}
								aria-expanded={browsing}
								aria-label="Browse directories"
								title="Browse directories"
							>
								…
							</button>
						</div>
					)}
				</Field>

				{browsing && (
					<DirectoryBrowser
						initialPath={workdir}
						onSelect={(path) => {
							setWorkdir(path);
							setBrowsing(false);
						}}
						onClose={() => setBrowsing(false)}
					/>
				)}

				<Field
					label="Agent runtime"
					hint={RUNNER_OPTIONS.find((o) => o.value === runner)?.description ?? ""}
				>
					{(props) => (
						<select
							{...props}
							className="select"
							value={runner}
							onChange={(ev) => setRunner(ev.target.value as Runner)}
						>
							{RUNNER_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					)}
				</Field>

				<Field label="Sandbox" hint={SANDBOX_OPTIONS.find((o) => o.value === sandbox)?.description ?? ""}>
					{(props) => (
						<select
							{...props}
							className="select"
							value={sandbox}
							onChange={(ev) => setSandbox(ev.target.value as Sandbox)}
						>
							{SANDBOX_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					)}
				</Field>

				{sandbox === "docker" && (
					<Field
						label="Container image"
						hint={`Optional — leave empty for ${DEFAULT_IMAGES[runner]}, built from this repo's ${runner === "free-code" ? "Dockerfile.free-code" : "Dockerfile"}. It must ship the ${runner} binary, or steps die with exit 127. The image is per workflow, so a Python repo and a Node repo can use different ones.`}
					>
						{(props) => (
							<input
								{...props}
								type="text"
								className="input"
								value={image}
								placeholder={DEFAULT_IMAGES[runner]}
								onChange={(ev) => setImage(ev.target.value)}
							/>
						)}
					</Field>
				)}

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
