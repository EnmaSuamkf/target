import { useEffect, useState } from "react";
import { ApiError, listConversations, listRunners, openConversationTerminal, previewConversation } from "../api/client.ts";
import type {
	Conversation,
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
import { prettyPath, relativeTime, truncate } from "../lib/format.ts";
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
 * The conversation picker under the runtime is the "create a workflow from a
 * conversation you're already having" path. It reads the chosen runtime's
 * on-disk sessions (`GET /api/conversations`), and the order is deliberate: the
 * agent selector above it is the filter, so picking claude or free-code narrows
 * the list to that harness's conversations. "Open in terminal" reopens the
 * selected one in a real terminal window, because the titles alone are not
 * enough to be sure it's the right conversation, and the import is not something
 * you want to discover was wrong two steps in.
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
	// The conversation this workflow is created from, if any — see the header
	// comment. Keyed by session id, which is the only handle the API takes.
	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [conversationTotal, setConversationTotal] = useState(0);
	const [conversationId, setConversationId] = useState("");
	const [conversationQuery, setConversationQuery] = useState("");
	const [loadingConversations, setLoadingConversations] = useState(false);
	const [conversationError, setConversationError] = useState<string | null>(null);
	// Bumped by Refresh. A conversation you had seconds ago should be one click
	// away, without closing and reopening the form to trigger a refetch.
	const [conversationNonce, setConversationNonce] = useState(0);
	const [preview, setPreview] = useState<string | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [opening, setOpening] = useState(false);
	const [terminalNote, setTerminalNote] = useState<string | null>(null);

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
		setConversations([]);
		setConversationTotal(0);
		setConversationId("");
		setConversationQuery("");
		setConversationError(null);
		setPreview(null);
		setTerminalNote(null);
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

	// The conversation list is per runtime — that IS the agent filter — so it is
	// refetched whenever the selected runtime changes, and any conversation
	// already picked is dropped with it (a claude session id means nothing to
	// free-code). Waits for the runner probe, since before it lands `runner` is
	// only the provisional default.
	useEffect(() => {
		if (!open || loadingRunners || probeFailed) return;
		setConversationId("");
		setPreview(null);
		setTerminalNote(null);
		setLoadingConversations(true);
		setConversationError(null);
		let cancelled = false;
		void (async () => {
			try {
				const found = await listConversations(runner);
				if (cancelled) return;
				setConversations(found.conversations);
				setConversationTotal(found.total);
			} catch (err) {
				if (cancelled) return;
				setConversations([]);
				setConversationTotal(0);
				// A missing admin token is the common case and has an obvious fix, so
				// it's named rather than shown as a bare "unauthorized".
				setConversationError(
					err instanceof ApiError && err.isAuth
						? "Enter your admin token to browse this machine's conversations."
						: err instanceof Error
							? err.message
							: "Couldn't read this machine's conversations.",
				);
			} finally {
				if (!cancelled) setLoadingConversations(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, runner, loadingRunners, probeFailed, conversationNonce]);

	const conversation = conversations.find((c) => c.sessionId === conversationId) ?? null;
	// Free-text narrowing over title and directory. With hundreds of sessions on
	// a working machine, scrolling a <select> to find "the one about the login
	// bug" is not a realistic way to find it.
	const query = conversationQuery.trim().toLowerCase();
	const visibleConversations = query
		? conversations.filter(
				(c) => c.title.toLowerCase().includes(query) || (c.workdir ?? "").toLowerCase().includes(query),
			)
		: conversations;

	/**
	 * Adopting a conversation also proposes its working directory, because a
	 * workflow continuing that conversation's work almost always belongs in the
	 * same repo. Only when the operator hasn't typed one — never overwriting a
	 * deliberate choice.
	 */
	const pickConversation = (sessionId: string): void => {
		setConversationId(sessionId);
		setPreview(null);
		setTerminalNote(null);
		const picked = conversations.find((c) => c.sessionId === sessionId);
		if (picked?.workdir && workdir.trim() === "") setWorkdir(picked.workdir);
	};

	const openInTerminal = async (): Promise<void> => {
		if (!conversation) return;
		setOpening(true);
		setTerminalNote(null);
		try {
			const result = await openConversationTerminal(conversation.runner, conversation.sessionId);
			setTerminalNote(`Opened in a terminal at ${prettyPath(result.workdir)}.`);
		} catch (err) {
			setTerminalNote(err instanceof Error ? err.message : "Couldn't open a terminal.");
		} finally {
			setOpening(false);
		}
	};

	const togglePreview = async (): Promise<void> => {
		if (preview !== null) {
			setPreview(null);
			return;
		}
		if (!conversation) return;
		setPreviewing(true);
		try {
			const result = await previewConversation(conversation.runner, conversation.sessionId);
			setPreview(result.digest.text);
		} catch (err) {
			setPreview(err instanceof Error ? err.message : "Couldn't read that conversation.");
		} finally {
			setPreviewing(false);
		}
	};

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
			if (conversation) input.conversation = { runner: conversation.runner, sessionId: conversation.sessionId };
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

				<Field
					label="Create from a conversation"
					hint={
						loadingConversations
							? `Reading this machine's ${runner} conversations…`
							: conversations.length === 0 && !conversationError
								? `No ${runner} conversations found on this machine. Only conversations this machine has on disk can be imported.`
								: query
									? `${visibleConversations.length} of ${conversations.length} match “${conversationQuery.trim()}”.`
									: conversationTotal > conversations.length
										? `Showing the ${conversations.length} most recent of ${conversationTotal}. Search to reach the rest.`
										: `${conversations.length} conversation${conversations.length === 1 ? "" : "s"} — the chosen one becomes this workflow's context, delivered to the agent before the first step. The list follows the agent runtime above.`
					}
					{...(conversationError ? { error: conversationError } : {})}
				>
					{(props) => (
						<div className={styles.conversationPicker}>
							<div className={styles.conversationRow}>
								<input
									type="search"
									className="input"
									value={conversationQuery}
									placeholder="Search by what was said, or by directory…"
									disabled={runnerDisabled || conversations.length === 0}
									aria-label="Search conversations"
									onChange={(ev) => setConversationQuery(ev.target.value)}
								/>
								{/* Just had the conversation you want? It appears here without
								    closing and reopening the form. */}
								<button
									type="button"
									className="btn"
									disabled={runnerDisabled || loadingConversations}
									onClick={() => setConversationNonce((n) => n + 1)}
									title="Re-read this machine's conversations"
								>
									{loadingConversations ? "Reading…" : "Refresh"}
								</button>
							</div>
							<div className={styles.conversationRow}>
								<select
									{...props}
									className="select"
									value={conversationId}
									disabled={runnerDisabled || loadingConversations || conversations.length === 0}
									onChange={(ev) => pickConversation(ev.target.value)}
								>
									<option value="">No conversation — start with an empty context</option>
									{visibleConversations.map((option) => (
										<option key={option.sessionId} value={option.sessionId}>
											{`${truncate(option.title, 70)} · ${prettyPath(option.workdir) || "unknown dir"} · ${relativeTime(option.updatedAt)}`}
										</option>
									))}
								</select>
								{/* The titles are one line of a long conversation; this is how you
								    confirm it's the right one before importing it. */}
								<button
									type="button"
									className="btn"
									disabled={!conversation || opening}
									onClick={() => void openInTerminal()}
									title="Reopen this conversation in a terminal window"
								>
									{opening ? "Opening…" : "Open in terminal"}
								</button>
							</div>
						</div>
					)}
				</Field>

				{conversation && (
					<div className={styles.conversation}>
						<p className={styles.conversationMeta}>
							{conversation.runner} · {prettyPath(conversation.workdir) || "unknown directory"} ·{" "}
							{Math.max(1, Math.round(conversation.sizeBytes / 1024))} KB · last active {relativeTime(conversation.updatedAt)}
						</p>
						<button type="button" className="btn btn--ghost" onClick={() => void togglePreview()} disabled={previewing}>
							{previewing ? "Reading…" : preview !== null ? "Hide what will be imported" : "Show what will be imported"}
						</button>
						{preview !== null && <pre className={styles.preview}>{preview}</pre>}
						{terminalNote && <p className={styles.conversationMeta}>{terminalNote}</p>}
					</div>
				)}

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
