import { useEffect, useState } from "react";
import { listRunners } from "../api/client.ts";
import type {
	CreateWorkflowInput,
	PermissionMode,
	Runner,
	RunnerAvailability,
	Sandbox,
	Template,
} from "../api/types.ts";
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
	const [runners, setRunners] = useState<RunnerAvailability[]>([]);
	const [loadingRunners, setLoadingRunners] = useState(true);
	// True when the GET /api/runners probe threw (hub down / network blip).
	// Distinct from "probe returned no installed runners": a failed probe must
	// NOT silently degrade to offering both, so it surfaces an explicit error
	// and disables submission until the operator retries.
	const [probeFailed, setProbeFailed] = useState(false);

	// Fresh form on every open. Also fetch which agent CLIs are installed on
	// the host so the runtime selector below only offers ones the operator can
	// actually run, and default-selects the first installed runner. A failed
	// probe (hub unreachable) is surfaced as an explicit error and disables
	// submission — it never silently degrades to offering both runners, since
	// an uninstalled agent must not be selectable.
	useEffect(() => {
		if (!open) return;
		setName("");
		setWorkdir("");
		setSandbox("host");
		setImage("");
		setPermissionMode("");
		setTemplateId("");
		setAcceptRisk(false);
		setBrowsing(false);
		setLoadingRunners(true);
		setProbeFailed(false);
		let cancelled = false;
		void (async () => {
			let avail: RunnerAvailability[] = [];
			let failed = false;
			try {
				avail = await listRunners();
			} catch {
				// Hub down / network blip — record it so the selector shows an
				// explicit error instead of degrading to offering both runners.
				failed = true;
			}
			if (cancelled) return;
			setRunners(avail);
			setProbeFailed(failed);
			setLoadingRunners(false);
			setRunner(avail.find((r) => r.installed)?.id ?? "claude");
		})();
		return () => {
			cancelled = true;
		};
	}, [open]);

	const bypass = permissionMode === "bypassPermissions";
	// Only installed runners are selectable: `RUNNER_OPTIONS` is used to look up
	// each installed runner's label/description, never as the source of the
	// option list, so an uninstalled CLI is never offered — not even as a
	// disabled "(not installed)" entry.
	const installedOptions = runners
		.filter((r) => r.installed)
		.map((r) => RUNNER_OPTIONS.find((o) => o.value === r.id))
		.filter((o): o is { value: Runner; label: string; description: string } => o !== undefined);
	const probeDone = !loadingRunners && !probeFailed;
	const noInstalled = probeDone && installedOptions.length === 0;
	const runnerDisabled = loadingRunners || probeFailed || noInstalled;
	const runnerError = probeFailed
		? "Couldn't reach the hub to verify installed agent CLIs. Please retry."
		: noInstalled
			? "No agent CLI is installed on this machine. Install `claude` or `free-code` to create a workflow."
			: undefined;
	const runnerHint = loadingRunners
		? "Checking which agent CLIs are installed on this machine…"
		: installedOptions.find((o) => o.value === runner)?.description ?? "";
	// The probe has to have succeeded with at least one installed runner before
	// a workflow can be created — otherwise the form would POST a runner the
	// host can't spawn (or, on a failed probe, one it couldn't even verify).
	const canSubmit =
		probeDone && installedOptions.length > 0 && name.trim() !== "" && (!bypass || acceptRisk) && !saving;

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
					hint={runnerHint}
					{...(runnerError ? { error: runnerError } : {})}
				>
					{(props) => (
						<select
							{...props}
							className="select"
							value={runnerDisabled ? "" : runner}
							disabled={runnerDisabled}
							onChange={(ev) => setRunner(ev.target.value as Runner)}
						>
							{loadingRunners ? (
								<option value="" disabled>
									Loading installed agents…
								</option>
							) : probeFailed ? (
								<option value="" disabled>
									Hub unreachable
								</option>
							) : noInstalled ? (
								<option value="" disabled>
									No agent CLI installed
								</option>
							) : (
								installedOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))
							)}
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
