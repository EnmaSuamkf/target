import { useEffect, useState } from "react";
import { ApiError, listConversations, listHostCapabilities, openConversationTerminal, previewConversation } from "../api/client.ts";
import {
	PERMISSION_MODES,
	type CloneWorkflowInput,
	type Conversation,
	type CreateWorkflowInput,
	type PermissionMode,
	type Runner,
	type RunnerAvailability,
	type Sandbox,
	type SandboxAvailability,
	type Template,
	type Workflow,
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
 * not "anything on this machine". Both selectors are built from what the host
 * reports it can actually run (`GET /api/runners`), never from the static
 * option lists below: an agent CLI that isn't installed, or a docker whose
 * daemon isn't reachable, is not offered at all rather than offered and left
 * to fail at the workflow's first step.
 *
 * The conversation picker under the runtime is the "run this workflow on a
 * conversation you're already having" path. It reads the chosen runtime's
 * on-disk sessions (`GET /api/conversations`), and the order is deliberate: the
 * agent selector above it is the filter, so picking claude or free-code narrows
 * the list to that harness's conversations. "Open in terminal" reopens the
 * selected one in a real terminal window, because the titles alone are not
 * enough to be sure it's the right conversation, and this is not something you
 * want to discover was wrong two steps in.
 *
 * Picking one is not an import: the workflow RESUMES that session, so the agent
 * begins with the whole conversation rather than a summary of it (see
 * hub/conversations.ts). That is why picking one also TAKES OVER the working
 * directory field instead of merely proposing a value — the harness resumes a
 * session relative to the directory it ran in, so a workflow continuing a
 * conversation has exactly one directory it can run in, and the server refuses
 * any other. The field stays visible, and read-only, rather than disappearing:
 * where the agent will run is not something to hide because it was decided for
 * you.
 *
 * ## Clone mode
 *
 * Given a `source` workflow the same form becomes the CLONE dialog, seeded from
 * that workflow: the proposed name, and the runtime it actually runs under. It
 * is the same form on purpose — a clone is a new workflow, and everything you
 * may decide when creating one you may decide when copying one, rather than
 * being handed a fixed copy to go and edit afterwards.
 *
 * Two fields are dropped in clone mode, because the clone already answers what
 * they ask: "create from a conversation" (the copy inherits the original's
 * context) and "start from template" (it inherits the original's steps).
 * Leaving them in would offer to seed a second set of steps on top of the
 * copied ones, and a second context to fight the copied one. What they'd have
 * decided is stated instead, above the form, as what is about to be copied.
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

/** What a clone is proposed as — mirrors the hub's `cloneName` (hub/workflow.ts). */
function cloneName(name: string): string {
	return `Clone - ${name}`;
}

export function CreateWorkflowModal({
	open,
	templates,
	source,
	onClose,
	onCreate,
	onClone,
}: {
	open: boolean;
	templates: Template[];
	/** Set to turn this into the clone dialog for that workflow — see "Clone mode". */
	source?: Workflow | null;
	onClose: () => void;
	onCreate: (input: CreateWorkflowInput) => Promise<void>;
	/** Called instead of `onCreate` in clone mode. */
	onClone: (input: CloneWorkflowInput) => Promise<void>;
}): React.JSX.Element {
	const cloning = !!source;
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
	const [sandboxes, setSandboxes] = useState<SandboxAvailability[]>([]);
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
	// What the operator wants said INSIDE the adopted conversation before the
	// first step ("from here on, answer in Spanish"). Delivered as the context
	// step's own turn — with the conversation itself no longer copied anywhere,
	// this is the only prose a create carries.
	const [conversationNote, setConversationNote] = useState("");
	// The workdir this workflow will run in came from the conversation, not from
	// the operator — which the field says, and which is why it's read-only.
	const [workdirFromConversation, setWorkdirFromConversation] = useState(false);
	const [loadingConversations, setLoadingConversations] = useState(false);
	const [conversationError, setConversationError] = useState<string | null>(null);
	// Bumped by Refresh. A conversation you had seconds ago should be one click
	// away, without closing and reopening the form to trigger a refetch.
	const [conversationNonce, setConversationNonce] = useState(0);
	const [preview, setPreview] = useState<string | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [opening, setOpening] = useState(false);
	const [terminalNote, setTerminalNote] = useState<string | null>(null);

	// Fresh form on every open — or, in clone mode, one seeded from the workflow
	// being copied, so the dialog opens showing what the clone WOULD be and every
	// field is a change to that rather than something to re-enter. Also fetch
	// which agent CLIs are installed on the host so the runtime selector below
	// only offers ones the operator can actually run, and default-selects the
	// first installed runner. A failed probe (hub unreachable) is surfaced as an
	// explicit error and disables submission — it never silently degrades to
	// offering both runners, since an uninstalled agent must not be selectable.
	useEffect(() => {
		if (!open) return;
		setName(source ? cloneName(source.name) : "");
		// `chosenWorkdir`, never `workdir`: a source on its own per-agent sandbox
		// must not hand that directory to the clone's agent.
		setWorkdir(source?.chosenWorkdir ?? "");
		setSandbox(source?.sandbox ?? "host");
		setImage(source?.image ?? "");
		// A mode this form can't offer (awb publishes more than the UI does) reads
		// as the default rather than seeding a value with no matching option.
		setPermissionMode(
			source && PERMISSION_MODES.includes(source.permissionMode as PermissionMode)
				? (source.permissionMode as PermissionMode)
				: "",
		);
		setTemplateId("");
		setAcceptRisk(false);
		setBrowsing(false);
		setLoadingRunners(true);
		setProbeFailed(false);
		setConversations([]);
		setConversationTotal(0);
		setConversationId("");
		setConversationQuery("");
		setConversationNote("");
		setWorkdirFromConversation(false);
		setConversationError(null);
		setPreview(null);
		setTerminalNote(null);
		let cancelled = false;
		void (async () => {
			let avail: RunnerAvailability[] = [];
			let boxes: SandboxAvailability[] = [];
			let failed = false;
			try {
				const caps = await listHostCapabilities();
				avail = caps.runners;
				boxes = caps.sandboxes;
			} catch {
				// Hub down / network blip — record it so the selector shows an
				// explicit error instead of degrading to offering both runners.
				failed = true;
			}
			if (cancelled) return;
			setRunners(avail);
			setSandboxes(boxes);
			setProbeFailed(failed);
			setLoadingRunners(false);
			// The source's own runtime, when this host still has it installed —
			// a clone of a free-code workflow on a machine that has since lost the
			// binary falls back to what can actually run, since offering it would
			// only buy a workflow that dies at its first step.
			const inherited = avail.find((r) => r.id === source?.harness && r.installed)?.id;
			setRunner(inherited ?? avail.find((r) => r.installed)?.id ?? "claude");
		})();
		return () => {
			cancelled = true;
		};
		// Seeded per open and per workflow, NOT per render: the app re-renders this
		// every 2s (the poll) with a fresh `source` object, and depending on the
		// object itself would re-seed the form every two seconds, on top of
		// whatever was being typed into it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, source?.id]);

	// The conversation list is per runtime — that IS the agent filter — so it is
	// refetched whenever the selected runtime changes, and any conversation
	// already picked is dropped with it (a claude session id means nothing to
	// free-code). Waits for the runner probe, since before it lands `runner` is
	// only the provisional default. Skipped entirely in clone mode, where the
	// picker isn't rendered: reading every session on the machine to populate a
	// control nobody can see is work, and an unauthorised read there would raise
	// an error about a field that isn't on the form.
	useEffect(() => {
		if (!open || cloning || loadingRunners || probeFailed) return;
		setConversationId("");
		// Dropping the conversation drops the directory it dictated, or the form
		// would keep a read-only path belonging to a session it is no longer
		// continuing.
		setWorkdirFromConversation((taken) => {
			if (taken) setWorkdir("");
			return false;
		});
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
	}, [open, cloning, runner, loadingRunners, probeFailed, conversationNonce]);

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
	 * Adopting a conversation TAKES the working directory — it doesn't propose
	 * one. The harness resumes a session relative to the directory it ran in, so
	 * this is the only directory in which the workflow can pick that conversation
	 * up; the server refuses any other. Overwriting something the operator typed
	 * is the honest outcome here (the field goes read-only and says why), because
	 * the alternative is a form that looks like it accepted a choice the create
	 * will reject.
	 *
	 * Deselecting hands the field back, empty, rather than leaving the departed
	 * conversation's path behind as if it had been chosen.
	 */
	const pickConversation = (sessionId: string): void => {
		setConversationId(sessionId);
		setPreview(null);
		setTerminalNote(null);
		const picked = conversations.find((c) => c.sessionId === sessionId);
		if (picked?.workdir) {
			setWorkdir(picked.workdir);
			setWorkdirFromConversation(true);
			setBrowsing(false);
			return;
		}
		// Either "no conversation", or one whose transcript never recorded a
		// directory — which can't be continued at all, and is reported below.
		if (workdirFromConversation) setWorkdir("");
		setWorkdirFromConversation(false);
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
			setPreview(result.preview.text);
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
	// Same rule as the runners above, for the same reason: a sandbox this host
	// can't run is not offered at all. Without docker the selector is left with
	// "This machine" alone — picking a container on a machine with no daemon
	// only buys a workflow that dies at its first step, and the server refuses
	// it anyway. Before the probe lands nothing is available, so the option
	// can't flash in and out; `host` is the state's default and stays valid.
	const availableSandboxOptions = SANDBOX_OPTIONS.filter(
		(option) => sandboxes.find((s) => s.id === option.value)?.available ?? false,
	);
	const dockerUnavailable = probeDone && !availableSandboxOptions.some((o) => o.value === "docker");
	const sandboxDisabled = loadingRunners || probeFailed || availableSandboxOptions.length === 0;
	const runnerDisabled = loadingRunners || probeFailed || noInstalled;
	const runnerError = probeFailed
		? "Couldn't reach the hub to verify installed agent CLIs. Please retry."
		: noInstalled
			? "No agent CLI is installed on this machine. Install `claude` or `free-code` to create a workflow."
			: undefined;
	const runnerHint = loadingRunners
		? "Checking which agent CLIs are installed on this machine…"
		: installedOptions.find((o) => o.value === runner)?.description ?? "";
	// A conversation whose transcript never recorded a working directory can't be
	// continued: there is nowhere to resume it from. Caught here so the form says
	// so at the moment it's picked, rather than at submit — the server refuses it
	// either way.
	const unusableConversation = !!conversation && !conversation.workdir;
	// The probe has to have succeeded with at least one installed runner before
	// a workflow can be created — otherwise the form would POST a runner the
	// host can't spawn (or, on a failed probe, one it couldn't even verify).
	const canSubmit =
		probeDone &&
		installedOptions.length > 0 &&
		name.trim() !== "" &&
		!unusableConversation &&
		(!bypass || acceptRisk) &&
		!saving;

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		if (!canSubmit) return;
		setSaving(true);
		try {
			if (source) {
				// Every field, empty ones included: to the clone endpoint an absent key
				// means "keep the source's", so a field the operator CLEARED has to be
				// sent as empty or the clearing is silently undone.
				const input: CloneWorkflowInput = {
					name: name.trim(),
					workdir: workdir.trim(),
					runner,
					sandbox,
					image: sandbox === "docker" ? image.trim() : "",
					permissionMode,
					...(bypass ? { acceptBypassRisk: true } : {}),
				};
				await onClone(input);
				return;
			}
			const input: CreateWorkflowInput = { name: name.trim() };
			if (workdir.trim()) input.workdir = workdir.trim();
			if (runner !== "claude") input.runner = runner;
			if (sandbox !== "host") input.sandbox = sandbox;
			if (sandbox === "docker" && image.trim()) input.image = image.trim();
			if (permissionMode) input.permissionMode = permissionMode;
			if (templateId) input.templateId = templateId;
			if (conversation) {
				input.conversation = { runner: conversation.runner, sessionId: conversation.sessionId };
				// Only with a conversation to say it in: a note alone is ignored by the
				// server (a workflow still can't be born with free-text context).
				if (conversationNote.trim()) input.conversationNote = conversationNote.trim();
			}
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
			title={source ? "Clone workflow" : "New workflow"}
			description={
				source
					? `Creates a second workflow from “${source.name}”, with a dedicated agent and hook of its own. Everything below starts as that workflow's and can be changed here.`
					: "Creates a dedicated agent and hook. Its steps then run in order on one shared session."
			}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn" onClick={onClose} disabled={saving}>
						Cancel
					</button>
					<button type="submit" form="create-workflow" className="btn btn--primary" disabled={!canSubmit}>
						{source ? (saving ? "Cloning…" : "Clone workflow") : saving ? "Creating…" : "Create workflow"}
					</button>
				</>
			}
		>
			<form id="create-workflow" className={styles.form} onSubmit={submit}>
				{/* What the clone gets for free, said where the two fields that would
				    otherwise ask for it used to be. The steps are the copy's reason to
				    exist, so the count is stated rather than implied. */}
				{source && (
					<p className={styles.copied}>
						Copies <strong>{source.progress.total} step{source.progress.total === 1 ? "" : "s"}</strong>, in order,
						with their acceptance criteria and review settings
						{source.conversationContext ? ", and this workflow's conversation context" : ""}. Nothing from its runs
						comes across: the clone starts as a draft with every step pending.
					</p>
				)}

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
					hint={
						workdirFromConversation
							? "Fixed by the conversation this workflow continues — the agent has to run where that conversation ran, or it can't pick the session up. Clear the conversation below to choose a directory again."
							: "Where this workflow's agent works. Leave empty for a dedicated sandbox under ~/.target/sandboxes/. Type a path or browse with …"
					}
				>
					{(props) => (
						<div className={styles.workdirRow}>
							<input
								{...props}
								type="text"
								className="input"
								value={workdir}
								placeholder="~/my-project"
								readOnly={workdirFromConversation}
								onChange={(ev) => setWorkdir(ev.target.value)}
							/>
							<button
								type="button"
								className="btn"
								disabled={workdirFromConversation}
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

				{browsing && !workdirFromConversation && (
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

				{/* Not in clone mode: the copy's context is the original's, and a second
				    one imported here would only fight it. */}
				{!cloning && (
					<Field
					label="Run on a conversation"
					hint={
						loadingConversations
							? `Reading this machine's ${runner} conversations…`
							: conversations.length === 0 && !conversationError
								? `No ${runner} conversations found on this machine. Only conversations this machine has on disk can be continued.`
								: query
									? `${visibleConversations.length} of ${conversations.length} match “${conversationQuery.trim()}”.`
									: conversationTotal > conversations.length
										? `Showing the ${conversations.length} most recent of ${conversationTotal}. Search to reach the rest.`
										: `${conversations.length} conversation${conversations.length === 1 ? "" : "s"} — the workflow resumes the chosen one, so its agent starts with that whole conversation instead of a summary, and its steps continue the thread. The list follows the agent runtime above.`
					}
					{...(conversationError
						? { error: conversationError }
						: unusableConversation
							? {
									error:
										"This conversation's transcript doesn't record the directory it ran in, so a workflow has nowhere to resume it from. Pick another one.",
								}
							: {})}
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
									<option value="">No conversation — start a fresh session</option>
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
				)}

				{!cloning && conversation && (
					<div className={styles.conversation}>
						<p className={styles.conversationMeta}>
							{conversation.runner} · {prettyPath(conversation.workdir) || "unknown directory"} ·{" "}
							{Math.max(1, Math.round(conversation.sizeBytes / 1024))} KB · last active {relativeTime(conversation.updatedAt)}
						</p>
						{/* Said plainly, because it is the one consequence that isn't
						    reversible: the steps are spoken into a conversation the operator
						    owns and will reopen. */}
						<p className={styles.conversationMeta}>
							This workflow's steps will run inside this conversation — reopening it later shows them there.
						</p>
						{/* The tail, not the import: there is no import. */}
						<button type="button" className="btn btn--ghost" onClick={() => void togglePreview()} disabled={previewing}>
							{previewing ? "Reading…" : preview !== null ? "Hide the end of the conversation" : "Show the end of the conversation"}
						</button>
						{preview !== null && <pre className={styles.preview}>{preview}</pre>}
						{terminalNote && <p className={styles.conversationMeta}>{terminalNote}</p>}
					</div>
				)}

				{/* Only with a conversation to say it in: the server ignores a note
				    without one, and a workflow still can't be created with free-text
				    context. */}
				{!cloning && conversation && !unusableConversation && (
					<Field
						label="Say this first (optional)"
						hint="Delivered as one turn in that conversation, before the first step — for what the workflow should do differently from here on. The conversation itself needs no summarising: the agent still has it."
					>
						{(props) => (
							<textarea
								{...props}
								className="input"
								rows={3}
								value={conversationNote}
								placeholder="e.g. From here on, work only on the parser and answer in Spanish."
								onChange={(ev) => setConversationNote(ev.target.value)}
							/>
						)}
					</Field>
				)}

				<Field
					label="Sandbox"
					hint={
						loadingRunners
							? "Checking what this machine can run…"
							: dockerUnavailable
								? "Docker isn't available on this machine (no docker on PATH, or its daemon isn't running), so only this machine is offered. Install/start Docker and re-run the installer to enable container workflows."
								: SANDBOX_OPTIONS.find((o) => o.value === sandbox)?.description ?? ""
					}
				>
					{(props) => (
						<select
							{...props}
							className="select"
							value={sandboxDisabled ? "" : sandbox}
							disabled={sandboxDisabled}
							onChange={(ev) => setSandbox(ev.target.value as Sandbox)}
						>
							{sandboxDisabled ? (
								<option value="" disabled>
									{loadingRunners ? "Checking this machine…" : "Hub unreachable"}
								</option>
							) : (
								availableSandboxOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))
							)}
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

				{/* Also not in clone mode: the copy's steps are the original's, and a
				    template would seed a second set on top of them. */}
				{!cloning && templates.length > 0 && (
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
