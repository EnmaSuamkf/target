import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api/client.ts";
import { ApiError } from "./api/client.ts";
import type {
	Account,
	AttachmentField,
	CloneWorkflowInput,
	CreateWorkflowInput,
	NotificationSettings,
	NotificationSettingsInput,
	ReportSettings,
	ReportSettingsInput,
	OverridableStepStatus,
	OverridableWorkflowStatus,
	SessionInfo,
	ShortcutAction,
	ShortcutBinding,
	ShortcutSettings,
	ShortcutSettingsInput,
	StagedStepImages,
	Step,
	StepConfigInput,
	StepNoteTheme,
	Resource,
	ResourceSelection,
	ResourceSet,
	ResourceSetInput,
	ResourceSetUsage,
	Tcp,
	TcpInput,
	TcpSelection,
	TcpTool,
	TcpUsage,
	Template,
	TemplateInput,
	Workflow,
} from "./api/types.ts";
import { useConfirm } from "./components/ConfirmDialog.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { Header, type View } from "./components/Header.tsx";
import { useToast } from "./components/Toast.tsx";
import { VoiceDock } from "./components/VoiceDock.tsx";
import { useAdminToken } from "./hooks/useAdminToken.ts";
import { useDictation } from "./hooks/useDictation.ts";
import { useIsMobile } from "./hooks/useIsMobile.ts";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.ts";
import { usePolling } from "./hooks/usePolling.ts";
import { downloadJson, jsonFilename } from "./lib/download.ts";
import {
	tcpToolChangeAction,
	tcpToolNamesAtRisk,
	tcpToolsForComparison,
	tcpUsageConfirmOptions,
} from "./tcpUsageAlert.ts";
import { resourceNamesAtRisk, resourceUsageConfirmOptions } from "./rciUsageAlert.ts";
import { CreateWorkflowModal } from "./views/CreateWorkflowModal.tsx";
import { LandingView } from "./views/LandingView.tsx";
import { LoginView } from "./views/LoginView.tsx";
import { ResetPasswordView } from "./views/ResetPasswordView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { SetupView } from "./views/SetupView.tsx";
import { ResourceSetsView } from "./views/ResourceSetsView.tsx";
import { TcpsView } from "./views/TcpsView.tsx";
import { TemplatesView } from "./views/TemplatesView.tsx";
import { WorkflowDetail } from "./views/WorkflowDetail.tsx";
import { AllWorkflowsPage, WorkflowList } from "./views/WorkflowList.tsx";
import styles from "./App.module.css";

/**
 * Root component: owns the data (workflows, the selected workflow's steps,
 * templates, session info), the 2s poll that keeps them fresh, and the action
 * handlers the views call.
 *
 * Polling matches the previous UI's cadence, because the hub has no streaming
 * endpoint — sequential dispatch only becomes visible by re-reading. What's new
 * is that the poll pauses on a hidden tab (see `usePolling`) and that a request
 * in flight is never overlapped by the next tick.
 *
 * The selected workflow is mirrored in the URL hash (`#/w/<id>`), so a reload
 * or a copied link lands back on the same workflow — the old UI always reset to
 * "nothing selected".
 *
 * Layout: the workflows view is a master/detail pair. On a wide screen both
 * panes are on screen at once; on a phone there isn't room for two columns, so
 * the same selection state drives *which* of them is shown — the list until a
 * workflow is picked, then the detail with a back affordance. No routes and no
 * second component tree, just one branch on `useIsMobile()`.
 */

const POLL_INTERVAL_MS = 2000;

function readHashSelection(): string | null {
	const match = /^#\/w\/(.+)$/.exec(window.location.hash);
	return match?.[1] ?? null;
}

/**
 * The access gate: decides what an unauthenticated visitor sees and owns the
 * transition into the app.
 *
 * On load it asks the hub how far this machine is: no account yet → the
 * landing page offers "Get started" (the one-time setup); account exists →
 * probe the session cookie (`GET /api/auth/me`): live → straight into the
 * workflows screen; dead → the landing page with "Sign in". Setup, login and
 * the recovery-token reset are full-screen views in front of the shell, never
 * beside it.
 *
 * Everything authenticated lives in `Shell`, which only MOUNTS after login —
 * so its hooks (the 2s poll included) never fire a request a logged-out
 * visitor would just get a 401 from. Likewise, logging out unmounts it and
 * every in-flight poll dies with it.
 */
type GatePhase = "loading" | "landing" | "setup" | "login" | "reset" | "authed";

export function App(): React.JSX.Element {
	const [phase, setPhase] = useState<GatePhase>("loading");
	const [setupCompleted, setSetupCompleted] = useState(false);
	const [account, setAccount] = useState<Account | null>(null);
	const [hubUnreachable, setHubUnreachable] = useState(false);

	// Any API answer of `401 login_required` while the app is open means the
	// session died under us (expiry, or a password reset in another browser):
	// drop back to the login screen instead of letting every action fail.
	useEffect(() => {
		api.setAuthLostHandler(() => {
			setAccount(null);
			setPhase((current) => (current === "authed" ? "login" : current));
		});
	}, []);

	useEffect(() => {
		void (async () => {
			try {
				const status = await api.getAuthStatus();
				setSetupCompleted(status.setupCompleted);
				if (!status.setupCompleted) {
					setPhase("landing");
					return;
				}
				try {
					const { account: current } = await api.getAccount();
					setAccount(current);
					setPhase("authed");
				} catch {
					setPhase("landing");
				}
			} catch {
				// The hub itself didn't answer — nothing to set up or sign into.
				setHubUnreachable(true);
			}
		})();
	}, []);

	const finishAuth = useCallback((authed: Account): void => {
		setSetupCompleted(true);
		setAccount(authed);
		setPhase("authed");
	}, []);

	const handleLogout = useCallback((): void => {
		void api.logout().catch(() => {
			// Even if the call fails (hub restarting), the cookie is expiring
			// client-side intent — drop to the landing page regardless.
		});
		setAccount(null);
		setPhase("landing");
	}, []);

	if (hubUnreachable) {
		return (
			<div className={styles.gateCenter}>
				<EmptyState
					title="Can't reach the hub"
					description="The Target hub didn't answer. Check that it's running (npm start) and reload."
					action={
						<button type="button" className="btn btn--primary btn--sm" onClick={() => window.location.reload()}>
							Reload
						</button>
					}
				/>
			</div>
		);
	}

	switch (phase) {
		case "loading":
			return (
				<div className={styles.gateCenter}>
					<EmptyState title="Loading…" description="Checking this machine's setup." />
				</div>
			);
		case "landing":
			return (
				<LandingView
					setupCompleted={setupCompleted}
					onGetStarted={() => setPhase("setup")}
					onSignIn={() => setPhase("login")}
				/>
			);
		case "setup":
			return <SetupView onDone={finishAuth} onBack={() => setPhase("landing")} />;
		case "login":
			return <LoginView onDone={finishAuth} onForgot={() => setPhase("reset")} onBack={() => setPhase("landing")} />;
		case "reset":
			return <ResetPasswordView onDone={finishAuth} onBack={() => setPhase("login")} />;
		case "authed":
			return <Shell account={account as Account} onLogout={handleLogout} />;
	}
}

function Shell({ account, onLogout }: { account: Account; onLogout: () => void }): React.JSX.Element {
	const [view, setView] = useState<View>("workflows");
	const [workflows, setWorkflows] = useState<Workflow[]>([]);
	const [templates, setTemplates] = useState<Template[]>([]);
	const [tcps, setTcps] = useState<Tcp[]>([]);
	const [resourceSets, setResourceSets] = useState<ResourceSet[]>([]);
	const [settings, setSettings] = useState<NotificationSettings | null>(null);
	const [shortcutSettings, setShortcutSettings] = useState<ShortcutSettings | null>(null);
	const [reportSettings, setReportSettings] = useState<ReportSettings | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(readHashSelection);
	const [steps, setSteps] = useState<Step[]>([]);
	const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	// The "All workflows" page. It replaces the workflows view while open, so
	// it's a page-level state rather than a dialog flag. Reset whenever the
	// operator leaves the workflows view, so coming back to Workflows lands on
	// the rail rather than stranded on the page. The page is used on every
	// screen — on a phone it adapts to the narrow width, so there's no separate
	// mobile picker.
	const [allWorkflowsOpen, setAllWorkflowsOpen] = useState(false);
	// Which workflow the create dialog is CLONING, if any — it doubles as the
	// clone dialog, seeded from this one (see CreateWorkflowModal). Held by id
	// rather than by object so the note in that dialog keeps up with the poll.
	const [cloneSourceId, setCloneSourceId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [loaded, setLoaded] = useState(false);
	// Bumped every time a workflow is created (including via Clone, which is the
	// same create dialog). The rail watches it and scrolls itself fully back to
	// the left, so the workflow that was just created is where the operator is
	// looking rather than off the left edge of however far they had scrolled.
	const [railResetKey, setRailResetKey] = useState(0);

	const toast = useToast();
	const dictation = useDictation();
	const isMobile = useIsMobile();
	const { hasToken, saveToken } = useAdminToken();
	const { confirm, dialog } = useConfirm();

	// Guards a race: a slow detail fetch for a workflow the user already left
	// must not overwrite the newly selected one's data.
	const selectedRef = useRef<string | null>(selectedId);
	selectedRef.current = selectedId;

	const selectedWorkflow = useMemo(
		() => workflows.find((w) => w.id === selectedId) ?? null,
		[workflows, selectedId],
	);

	const cloneSource = useMemo(
		() => workflows.find((w) => w.id === cloneSourceId) ?? null,
		[workflows, cloneSourceId],
	);

	// The two ways the create dialog opens. Clearing the clone source on the plain
	// "New workflow" path matters: without it, the dialog opened from New right
	// after a Clone would come up still seeded from — and still cloning — that
	// workflow.
	const openCreate = (): void => {
		setCloneSourceId(null);
		setCreateOpen(true);
	};

	const closeCreate = (): void => {
		setCreateOpen(false);
		setCloneSourceId(null);
	};

	/**
	 * Turns any handler failure into a toast. A 401 is called out specifically
	 * because it has an obvious fix (set the admin token) that the generic
	 * message wouldn't suggest.
	 */
	const reportError = useCallback(
		(err: unknown, context: string) => {
			if (err instanceof ApiError && err.isAuth) {
				toast.error(`${context}: admin token missing or invalid. Set it from the header.`);
				return;
			}
			toast.error(`${context}: ${err instanceof Error ? err.message : String(err)}`);
		},
		[toast],
	);

	const refreshWorkflows = useCallback(async (): Promise<void> => {
		const list = await api.listWorkflows();
		setWorkflows(list);
	}, []);

	const refreshTemplates = useCallback(async (): Promise<void> => {
		const list = await api.listTemplates();
		setTemplates(list);
	}, []);

	const refreshTcps = useCallback(async (): Promise<void> => {
		const list = await api.listTcps();
		setTcps(list);
	}, []);

	const refreshResourceSets = useCallback(async (): Promise<void> => {
		const list = await api.listResourceSets();
		setResourceSets(list);
	}, []);

	const refreshSettings = useCallback(async (): Promise<void> => {
		setSettings(await api.getNotificationSettings());
	}, []);

	const refreshShortcutSettings = useCallback(async (): Promise<void> => {
		setShortcutSettings(await api.getShortcutSettings());
	}, []);

	const refreshReportSettings = useCallback(async (): Promise<void> => {
		setReportSettings(await api.getReportSettings());
	}, []);

	// Leaving the workflows view closes the "All workflows" page so a return to
	// the Workflows tab starts on the rail, not stranded on the page.
	useEffect(() => {
		if (view !== "workflows") setAllWorkflowsOpen(false);
	}, [view]);

	const refreshDetail = useCallback(async (id: string): Promise<void> => {
		const [detail, session] = await Promise.all([
			api.getWorkflow(id),
			api.getSessionInfo(id).catch(() => null),
		]);
		// Discard if the selection moved on while these were in flight.
		if (selectedRef.current !== id) return;
		setSteps(detail.steps);
		setSessionInfo(session);
		// Fold the fresh workflow row in so the detail pane isn't a poll behind.
		setWorkflows((current) => current.map((w) => (w.id === id ? detail.workflow : w)));
	}, []);

	// Initial load.
	useEffect(() => {
		void (async () => {
			try {
				await Promise.all([
					refreshWorkflows(),
					refreshTemplates(),
					refreshTcps(),
					refreshResourceSets(),
					refreshSettings(),
					refreshShortcutSettings(),
					refreshReportSettings(),
				]);
			} catch (err) {
				reportError(err, "Could not load data");
			} finally {
				setLoaded(true);
			}
		})();
	}, [
		refreshWorkflows,
		refreshTemplates,
		refreshTcps,
		refreshResourceSets,
		refreshSettings,
		refreshShortcutSettings,
		refreshReportSettings,
		reportError,
	]);

	// Detail for the selected workflow, and clearing it when nothing is selected.
	useEffect(() => {
		if (!selectedId) {
			setSteps([]);
			setSessionInfo(null);
			return;
		}
		// Drop the previous workflow's steps immediately so the detail pane cannot
		// seed checkboxes from stale rows while the new fetch is in flight.
		setSteps([]);
		setSessionInfo(null);
		void refreshDetail(selectedId).catch(() => {
			// A workflow deleted from elsewhere — the poll drops it from the list.
		});
	}, [selectedId, refreshDetail]);

	// Keep the hash in sync so reloads and shared links restore the selection.
	useEffect(() => {
		const next = selectedId ? `#/w/${selectedId}` : "";
		if (window.location.hash !== next) {
			window.history.replaceState(null, "", next || window.location.pathname);
		}
	}, [selectedId]);

	useEffect(() => {
		const onHashChange = (): void => setSelectedId(readHashSelection());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	// The workflows view always renders from the top of the page. Picking a card
	// in the rail swaps the pane underneath it, and a taller pane used to leave
	// the window scrolled wherever the browser decided to put it (focus moving
	// into the new pane, or the restored scroll of the previous one) — which read
	// as "clicking a card scrolls the page down to the workflow". Selecting is a
	// deliberate act with a deliberate result: the top of the workflow. Keyed on
	// the things that change what the view *is*, never on the 2s poll, so it
	// cannot yank the page while the operator is reading further down.
	useEffect(() => {
		if (view !== "workflows") return;
		window.scrollTo({ top: 0, left: 0 });
	}, [view, selectedId, allWorkflowsOpen]);

	// Drop a selection whose workflow no longer exists.
	useEffect(() => {
		if (loaded && selectedId && !workflows.some((w) => w.id === selectedId)) setSelectedId(null);
	}, [workflows, selectedId, loaded]);

	usePolling(async () => {
		await refreshWorkflows();
		const id = selectedRef.current;
		if (id) await refreshDetail(id);
		// Templates change only through this UI, so they don't need the 2s poll.
	}, POLL_INTERVAL_MS);

	// Keyboard shortcuts: Alt+W focuses the first workflow, Alt+R starts
	// dictation into the focused field, Alt+N opens the create-workflow modal,
	// Alt+C presses the Continue button of a step held for review, Alt+S presses
	// the open workflow's Start button. The key per action is configurable in
	// Settings; until the bindings load, the hook gets the defaults (W/R/N/C/S)
	// so the shortcuts work from first paint.
	const shortcutBindings = useMemo<Record<ShortcutAction, ShortcutBinding>>(() => {
		const stored = shortcutSettings?.bindings;
		return {
			focusWorkflow: { key: stored?.focusWorkflow?.key ?? "w" },
			toggleDictation: { key: stored?.toggleDictation?.key ?? "r" },
			createWorkflow: { key: stored?.createWorkflow?.key ?? "n" },
			continueStep: { key: stored?.continueStep?.key ?? "c" },
			startWorkflow: { key: stored?.startWorkflow?.key ?? "s" },
		};
	}, [shortcutSettings]);

	useKeyboardShortcuts({
		view,
		dictation,
		onCreateWorkflow: () => openCreate(),
		bindings: shortcutBindings,
	});

	/** Runs a mutating action, then refreshes and reports failures uniformly. */
	const act = useCallback(
		async (context: string, fn: () => Promise<unknown>, after?: () => Promise<void>): Promise<boolean> => {
			setBusy(true);
			try {
				await fn();
				if (after) await after();
				return true;
			} catch (err) {
				reportError(err, context);
				return false;
			} finally {
				setBusy(false);
			}
		},
		[reportError],
	);

	const refreshCurrent = useCallback(async (): Promise<void> => {
		await refreshWorkflows();
		const id = selectedRef.current;
		if (id) await refreshDetail(id);
	}, [refreshWorkflows, refreshDetail]);

	// --- workflow actions ---

	const handleCreate = async (input: CreateWorkflowInput): Promise<void> => {
		const ok = await act("Could not create the workflow", async () => {
			const workflow = await api.createWorkflow(input);
			setSelectedId(workflow.id);
			toast.success(`Workflow "${workflow.name}" created.`);
		}, refreshCurrent);
		if (ok) {
			// Send the rail back to its left edge for the new card (see
			// `railResetKey`). Only on success: a failed create added nothing, so
			// yanking the rail sideways would be noise.
			setRailResetKey((n) => n + 1);
			closeCreate();
		}
	};

	const handleStart = (stepIds: string[]): void => {
		const workflow = selectedWorkflow;
		if (!workflow) return;
		const action =
			workflow.status === "draft"
				? "start"
				: workflow.status === "paused"
					? "resume"
					: ("restart" as const);
		void act(
			"Could not start the workflow",
			() => api.runWorkflowAction(workflow.id, action, stepIds),
			refreshCurrent,
		);
	};

	const handleStop = (): void => {
		if (!selectedId) return;
		void act("Could not stop the workflow", () => api.runWorkflowAction(selectedId, "pause"), refreshCurrent);
	};

	/**
	 * Clone opens the create dialog seeded from this workflow rather than copying
	 * it on the spot: a clone is a new workflow, and the things you decide when
	 * creating one — its name, where it works, which agent, what it may do — are
	 * exactly the things you want to decide when copying one. The copy itself
	 * happens on that dialog's submit, in `handleCloneSubmit`.
	 */
	const handleClone = (): void => {
		if (!selectedWorkflow) return;
		setCloneSourceId(selectedWorkflow.id);
		setCreateOpen(true);
	};

	/**
	 * Performs the clone with whatever the dialog was left showing, and SELECTS
	 * the copy — it's what you're about to edit or run, and leaving the original
	 * open would make a successful clone look like nothing happened. Not
	 * confirmed: it creates something, changes nothing, and is undone by deleting
	 * the copy.
	 */
	const handleCloneSubmit = async (input: CloneWorkflowInput): Promise<void> => {
		if (!cloneSourceId) return;
		const ok = await act(
			"Could not clone the workflow",
			async () => {
				const clone = await api.cloneWorkflow(cloneSourceId, input);
				setSelectedId(clone.id);
				toast.success(`Workflow cloned as "${clone.name}".`);
			},
			refreshCurrent,
		);
		if (ok) closeCreate();
	};

	// Returns whether the rename reached the server, so the dialog only closes on
	// a real success and a rejected name isn't silently lost.
	const handleRename = async (name: string): Promise<boolean> => {
		const workflow = selectedWorkflow;
		if (!workflow) return false;
		return await act(
			"Could not rename the workflow",
			async () => {
				const renamed = await api.renameWorkflow(workflow.id, name);
				toast.success(`Workflow renamed to "${renamed.name}".`);
			},
			refreshCurrent,
		);
	};

	const handleDelete = async (): Promise<void> => {
		const workflow = selectedWorkflow;
		if (!workflow) return;
		const confirmed = await confirm({
			title: `Delete "${workflow.name}"?`,
			description: "This removes the workflow, its steps and its agent hook. It cannot be undone.",
			confirmLabel: "Delete workflow",
			danger: true,
		});
		if (!confirmed) return;
		const ok = await act("Could not delete the workflow", () => api.deleteWorkflow(workflow.id), refreshWorkflows);
		if (ok) {
			setSelectedId(null);
			toast.success("Workflow deleted.");
		}
	};

	/**
	 * Forces the workflow's status by hand. Confirmed, because it overrules what
	 * the engine recorded and the hub will then stop re-deriving that status
	 * until the workflow runs again — but it is not destructive (nothing is lost,
	 * and setting it again or re-running restores the derived value), so it isn't
	 * styled as a danger.
	 */
	const handleSetWorkflowStatus = async (status: OverridableWorkflowStatus): Promise<void> => {
		const workflow = selectedWorkflow;
		if (!workflow) return;
		const confirmed = await confirm({
			title: `Mark "${workflow.name}" as ${status}?`,
			description:
				"Records the status by hand — nothing is run. It stays as you set it until the workflow is started, stopped or restarted, and it's marked as set manually.",
			confirmLabel: `Mark ${status}`,
		});
		if (!confirmed) return;
		await act(
			"Could not set the workflow status",
			async () => {
				await api.setWorkflowStatus(workflow.id, status);
				toast.success(`Workflow marked ${status}.`);
			},
			refreshCurrent,
		);
	};

	// Returns whether the save actually reached the server, so the context
	// panel only clears its "unsaved edits" state on a real success.
	const handleSaveContext = async (context: string): Promise<boolean> => {
		if (!selectedId) return false;
		return await act(
			"Could not save the context",
			async () => {
				await api.setConversationContext(selectedId, context);
				toast.success("Conversation context saved.");
			},
			refreshCurrent,
		);
	};

	const handleSaveTcps = async (tcpSelections: TcpSelection[]): Promise<boolean> => {
		if (!selectedId) return false;
		return await act(
			"Could not save TCP selection",
			async () => {
				await api.setWorkflowTcpSelections(selectedId, tcpSelections);
				toast.success("TCP selection saved.");
			},
			refreshCurrent,
		);
	};

	const handleSaveResources = async (resourceSelections: ResourceSelection[]): Promise<boolean> => {
		if (!selectedId) return false;
		return await act(
			"Could not save RCI selection",
			async () => {
				await api.setWorkflowResourceSelections(selectedId, resourceSelections);
				toast.success("RCI selection saved.");
			},
			refreshCurrent,
		);
	};

	const handleOpenTerminal = async (): Promise<void> => {
		if (!selectedId) return;
		await act("Could not open the conversation", async () => {
			await api.openTerminal(selectedId);
			toast.success("Terminal opened.");
		});
	};

	// --- image attachments ---
	//
	// Images pinned to one of the three text inputs (the workflow's conversation
	// context, a step's task description, a step's acceptance criteria). They go
	// through `act` + `refreshCurrent` like every other mutation, so the thumbnail
	// strip is repainted from the server rather than from a guess — which matters
	// here because the server is what assigns the absolute path the strip shows.

	/** Uploads one field's staged files in order. Sequential on purpose: a failure names the file that failed. */
	const uploadImages = async (
		workflowId: string,
		field: AttachmentField,
		stepId: string | null,
		files: File[],
	): Promise<void> => {
		for (const file of files) await api.uploadAttachment(workflowId, { field, stepId, file });
	};

	const handleAttachImages = async (
		field: AttachmentField,
		stepId: string | null,
		files: File[],
	): Promise<boolean> => {
		if (!selectedId || files.length === 0) return false;
		return await act(
			"Could not attach the image",
			async () => {
				await uploadImages(selectedId, field, stepId, files);
				toast.success(files.length === 1 ? "Image attached." : `${files.length} images attached.`);
			},
			refreshCurrent,
		);
	};

	const handleRemoveAttachment = async (id: string): Promise<void> => {
		await act("Could not remove the image", () => api.deleteAttachment(id), refreshCurrent);
	};

	// --- step actions ---

	const handleAddStep = async (input: StepConfigInput, staged?: StagedStepImages): Promise<void> => {
		if (!selectedId) return;
		await act(
			"Could not add the step",
			async () => {
				// The step has to exist before its images can be pinned to it, so the
				// staged files are uploaded with the id the create just returned.
				const step = await api.addStep(selectedId, input);
				if (staged) {
					await uploadImages(selectedId, "description", step.id, staged.description);
					await uploadImages(selectedId, "acceptance", step.id, staged.acceptance);
				}
			},
			refreshCurrent,
		);
	};

	const handleSaveStep = async (stepId: string, input: StepConfigInput): Promise<void> => {
		if (!selectedId) return;
		await act("Could not edit the step", () => api.editStep(selectedId, stepId, input), refreshCurrent);
	};

	const handleAddNote = async (stepId: string, content: string, theme: StepNoteTheme): Promise<void> => {
		if (!selectedId) return;
		await act("Could not add the note", () => api.addStepNote(selectedId, stepId, { content, theme }), refreshCurrent);
	};

	const handleEditNote = async (stepId: string, noteId: string, content: string, theme: StepNoteTheme): Promise<void> => {
		if (!selectedId) return;
		await act("Could not edit the note", () => api.editStepNote(selectedId, stepId, noteId, { content, theme }), refreshCurrent);
	};

	const handleRemoveNote = async (stepId: string, noteId: string): Promise<void> => {
		if (!selectedId) return;
		await act("Could not delete the note", () => api.removeStepNote(selectedId, stepId, noteId), refreshCurrent);
	};

	const handleRemoveStep = async (stepId: string): Promise<void> => {
		if (!selectedId) return;
		const confirmed = await confirm({
			title: "Remove this step?",
			description: "It's removed from the workflow. Only pending steps can be removed.",
			confirmLabel: "Remove step",
			danger: true,
		});
		if (!confirmed) return;
		await act("Could not remove the step", () => api.removeStep(selectedId, stepId), refreshCurrent);
	};

	/**
	 * One button, two meanings — which is why the confirmation is written from
	 * the step's status rather than being one fixed sentence. On a stuck step
	 * Abort unsticks it; on a step held at its manual-review gate it's the "no"
	 * to Continue's "yes", and what it stops is the whole workflow, so that had
	 * better be what the dialog says before it happens.
	 */
	const handleAbortStep = async (stepId: string): Promise<void> => {
		if (!selectedId) return;
		const step = steps.find((s) => s.id === stepId);
		const held = step?.status === "waiting";
		const confirmed = await confirm({
			title: held ? "Abort this step and stop the workflow?" : "Abort this step?",
			description: held
				? "Refuses this step's result: it's recorded failed and the workflow stops here — no further step runs. Its result and session are kept, so you can still read it and talk to the agent, and re-running it later — check it, then Start over — clears the failure."
				: "Force-fails a step whose run never called back, so it can be re-run by checking it and pressing Start over. Its session is preserved.",
			confirmLabel: held ? "Abort and stop" : "Abort step",
			danger: true,
		});
		if (!confirmed) return;
		await act(
			held ? "Could not abort the workflow" : "Could not abort the step",
			async () => {
				await api.abortStep(selectedId, stepId);
				if (held) toast.success("Step rejected — the workflow stopped.");
			},
			refreshCurrent,
		);
	};

	// Same action as the header's "Open conversation", pointed at one step's own
	// session instead of the workflow's most recent one — from a held step, the
	// conversation worth resuming is the one that produced the result being
	// reviewed.
	const handleOpenStepConversation = async (stepId: string): Promise<void> => {
		if (!selectedId) return;
		await act("Could not open the conversation", async () => {
			await api.openStepTerminal(selectedId, stepId);
			toast.success("Terminal opened.");
		});
	};

	// Returns the step that really landed (null when the server refused it), so
	// the dialog stays open (holding what was typed) on failure and the detail
	// pane can tick the new step's box on success — the gate-inserted step is
	// dispatched next on Continue, and the checkbox must say so.
	const handleAddStepAfter = async (
		afterStepId: string,
		input: StepConfigInput,
		staged?: StagedStepImages,
	): Promise<Step | null> => {
		if (!selectedId) return null;
		let created: Step | null = null;
		const ok = await act(
			"Could not add the step",
			async () => {
				created = await api.addStep(selectedId, input, afterStepId);
				if (staged) {
					await uploadImages(selectedId, "description", created.id, staged.description);
					await uploadImages(selectedId, "acceptance", created.id, staged.acceptance);
				}
				toast.success("Step added — it runs next.");
			},
			refreshCurrent,
		);
		return ok ? created : null;
	};

	/**
	 * Pushes the checkboxes to the hub on every toggle, so the selection the
	 * engine dispatches from is the one on screen — not the one Start was
	 * pressed with. Fire-and-forget rather than `act`: ticking a box must not
	 * lock the controls behind `busy` (least of all mid-run, which is exactly
	 * when this matters), and a failure is reported without reverting the box —
	 * the next toggle or Start resends the set.
	 */
	const handleSelectionChange = (stepIds: string[]): void => {
		const id = selectedRef.current;
		if (!id) return;
		api.setStepSelection(id, stepIds).catch((err) => reportError(err, "Could not save the step selection"));
	};

	// Releasing a manual-review gate is not destructive (it approves work that
	// already happened) and it's the one action the operator is being actively
	// waited on for, so unlike Abort it doesn't ask for a confirmation.
	const handleContinueStep = async (stepId: string): Promise<void> => {
		if (!selectedId) return;
		await act(
			"Could not continue the step",
			async () => {
				await api.continueStep(selectedId, stepId);
				toast.success("Step approved — the workflow continues.");
			},
			refreshCurrent,
		);
	};

	/**
	 * Forces one step's status by hand. Same confirmation rationale as the
	 * workflow's, plus the one consequence worth spelling out: the workflow's own
	 * badge follows from its steps, so correcting the last failed step of a run
	 * also clears the workflow's `failed`.
	 */
	const handleSetStepStatus = async (stepId: string, status: OverridableStepStatus): Promise<void> => {
		if (!selectedId) return;
		const step = steps.find((s) => s.id === stepId);
		const confirmed = await confirm({
			title: `Mark step ${step ? step.orderIndex + 1 : ""} as ${status}?`.replace("  ", " "),
			description:
				status === "pending"
					? "Puts the step back in the queue. It isn't run now — it runs on the next Start, if it's selected."
					: "Records the status by hand — the step is not re-run. The workflow's own status follows from its steps, so this can clear its failed badge too.",
			confirmLabel: `Mark ${status}`,
		});
		if (!confirmed) return;
		await act(
			"Could not set the step status",
			async () => {
				await api.setStepStatus(selectedId, stepId, status);
				toast.success(`Step marked ${status}.`);
			},
			refreshCurrent,
		);
	};

	/**
	 * Moves a step one place up or down. No confirmation: it changes nothing that
	 * has already happened (only pending steps move, and only past other pending
	 * ones), and it undoes itself by pressing the other arrow — the cheapest
	 * possible mistake to make and to fix.
	 */
	const handleMoveStep = async (stepId: string, direction: "up" | "down"): Promise<void> => {
		if (!selectedId) return;
		await act("Could not move the step", () => api.moveStep(selectedId, stepId, direction), refreshCurrent);
	};

	const handleAddStepsFromTemplate = async (templateId: string): Promise<void> => {
		if (!selectedId) return;
		await act(
			"Could not add the template's steps",
			async () => {
				const result = await api.addStepsFromTemplate(selectedId, templateId);
				toast.success(`Added ${result.added} step(s).`);
			},
			refreshCurrent,
		);
	};

	// --- template actions ---

	const handleCreateTemplate = async (input: TemplateInput): Promise<void> => {
		await act(
			"Could not create the template",
			async () => {
				await api.createTemplate(input);
				toast.success("Template created.");
			},
			refreshTemplates,
		);
	};

	const handleUpdateTemplate = async (id: string, input: TemplateInput): Promise<void> => {
		await act(
			"Could not update the template",
			async () => {
				await api.updateTemplate(id, input);
				toast.success("Template saved.");
			},
			refreshTemplates,
		);
	};

	const handleDeleteTemplate = async (id: string): Promise<void> => {
		const template = templates.find((t) => t.id === id);
		const confirmed = await confirm({
			title: `Delete "${template?.name ?? "this template"}"?`,
			description: "Workflows already created from it keep their steps.",
			confirmLabel: "Delete template",
			danger: true,
		});
		if (!confirmed) return;
		await act(
			"Could not delete the template",
			async () => {
				await api.deleteTemplate(id);
				toast.success("Template deleted.");
			},
			refreshTemplates,
		);
	};

	// Export/import move templates between machines as a plain .json file. The
	// bundle is fetched rather than linked to (the route needs the session), and
	// the file is written from the response — see lib/download.ts.
	const handleExportTemplate = async (id: string): Promise<void> => {
		await act("Could not export the template", async () => {
			const name = templates.find((t) => t.id === id)?.name ?? "template";
			const bundle = await api.exportTemplate(id);
			downloadJson(jsonFilename(name, "template"), bundle);
			toast.success("Template exported.");
		});
	};

	const handleExportAllTemplates = async (): Promise<void> => {
		await act("Could not export the templates", async () => {
			const bundle = await api.exportAllTemplates();
			downloadJson("target-templates.json", bundle);
			toast.success(`Exported ${bundle.templates.length} template${bundle.templates.length === 1 ? "" : "s"}.`);
		});
	};

	/**
	 * The chosen file is parsed here so a file that isn't JSON at all fails with
	 * the same error banner as a bundle the hub rejects, rather than as an
	 * unhandled throw inside the file input's change handler. The names in the
	 * toast come from the RESPONSE: the hub renames a template whose name is
	 * already taken, and silently landing a differently-named one would be a
	 * surprise the operator only finds later in the list.
	 */
	const handleImportTemplates = async (file: File): Promise<void> => {
		await act(
			"Could not import the templates",
			async () => {
				const created = await api.importTemplates(JSON.parse(await file.text()));
				toast.success(
					created.length === 1
						? `Imported "${created[0]?.name}".`
						: `Imported ${created.length} templates: ${created.map((t) => t.name).join(", ")}.`,
				);
			},
			refreshTemplates,
		);
	};

	// --- tcp actions ---

	const confirmTcpChangeIfReferenced = async (
		loadUsage: () => Promise<TcpUsage>,
		buildOptions: (usage: TcpUsage) => ReturnType<typeof tcpUsageConfirmOptions>,
	): Promise<boolean> => {
		try {
			const usage = await loadUsage();
			const options = buildOptions(usage);
			if (!options) return true;
			return await confirm(options);
		} catch {
			return true;
		}
	};

	const handleCreateTcp = async (input: TcpInput): Promise<void> => {
		await act(
			"Could not create the TCP",
			async () => {
				await api.createTcp(input);
				toast.success("TCP created.");
			},
			refreshTcps,
		);
	};

	const handleUpdateTcp = async (id: string, input: TcpInput, beforeTools: TcpTool[]): Promise<boolean> => {
		const tcpName = tcps.find((m) => m.id === id)?.name ?? input.name.trim();
		const atRisk = tcpToolNamesAtRisk(tcpToolsForComparison(beforeTools), tcpToolsForComparison(input.tools));
		if (atRisk.length > 0) {
			const action = tcpToolChangeAction(beforeTools, input.tools) ?? "remove";
			const allowed = await confirmTcpChangeIfReferenced(
				() => api.getTcpUsage(id, atRisk),
				(usage) =>
					tcpUsageConfirmOptions(tcpName, usage, {
						type: "tool-change",
						toolNames: atRisk,
						action,
						confirmLabel: "Save anyway",
					}),
			);
			if (!allowed) return false;
		}
		return await act(
			"Could not update the TCP",
			async () => {
				await api.updateTcp(id, input);
				toast.success("TCP saved.");
			},
			refreshTcps,
		);
	};

	const confirmTcpToolRemoval = async (id: string, toolName: string): Promise<boolean> => {
		const trimmed = toolName.trim();
		if (trimmed === "") return true;
		const tcp = tcps.find((m) => m.id === id);
		if (!tcp) return true;
		return await confirmTcpChangeIfReferenced(
			() => api.getTcpUsage(id, [trimmed]),
			(usage) =>
				tcpUsageConfirmOptions(tcp.name, usage, {
					type: "tool-change",
					toolNames: [trimmed],
					action: "remove",
					confirmLabel: "Remove tool",
				}),
		);
	};

	const handleDeleteTcp = async (id: string): Promise<void> => {
		const tcp = tcps.find((m) => m.id === id);
		const tcpName = tcp?.name ?? "this TCP";
		let confirmOptions = {
			title: `Delete "${tcpName}"?`,
			description: "This pack will be removed from the hub.",
			confirmLabel: "Delete TCP",
			danger: true as const,
		};
		try {
			const usage = await api.getTcpUsage(id);
			const referenced = tcpUsageConfirmOptions(tcpName, usage, { type: "delete" });
			if (referenced) confirmOptions = referenced;
		} catch {
			// Keep the generic confirmation if usage lookup fails.
		}
		const confirmed = await confirm(confirmOptions);
		if (!confirmed) return;
		await act(
			"Could not delete the TCP",
			async () => {
				await api.deleteTcp(id);
				toast.success("TCP deleted.");
			},
			refreshTcps,
		);
	};

	const handleExportTcp = async (id: string): Promise<void> => {
		await act("Could not export the TCP", async () => {
			const name = tcps.find((m) => m.id === id)?.name ?? "tcp";
			const bundle = await api.exportTcp(id);
			downloadJson(jsonFilename(name, "tcp"), bundle);
			toast.success("TCP exported.");
		});
	};

	const handleExportAllTcps = async (): Promise<void> => {
		await act("Could not export the TCP packs", async () => {
			const bundle = await api.exportAllTcps();
			downloadJson("target-tcps.json", bundle);
			toast.success(`Exported ${bundle.tcps.length} TCP pack${bundle.tcps.length === 1 ? "" : "s"}.`);
		});
	};

	const handleImportTcps = async (file: File): Promise<void> => {
		await act(
			"Could not import the TCP packs",
			async () => {
				const created = await api.importTcps(JSON.parse(await file.text()));
				toast.success(
					created.length === 1
						? `Imported "${created[0]?.name}".`
						: `Imported ${created.length} TCP packs: ${created.map((m) => m.name).join(", ")}.`,
				);
			},
			refreshTcps,
		);
	};

	// --- rci actions ---

	const confirmResourceChangeIfReferenced = async (
		loadUsage: () => Promise<ResourceSetUsage>,
		buildOptions: (usage: ResourceSetUsage) => ReturnType<typeof resourceUsageConfirmOptions>,
	): Promise<boolean> => {
		try {
			const options = buildOptions(await loadUsage());
			if (!options) return true;
			return await confirm(options);
		} catch {
			return true;
		}
	};

	const handleCreateResourceSet = async (input: ResourceSetInput): Promise<void> => {
		await act(
			"Could not create the Resource Set",
			async () => {
				await api.createResourceSet(input);
				toast.success("Resource Set created.");
			},
			refreshResourceSets,
		);
	};

	const handleUpdateResourceSet = async (id: string, input: ResourceSetInput, beforeResources: Resource[]): Promise<boolean> => {
		const setName = resourceSets.find((s) => s.id === id)?.name ?? input.name.trim();
		const atRisk = resourceNamesAtRisk(beforeResources, input.resources);
		if (atRisk.length > 0) {
			const allowed = await confirmResourceChangeIfReferenced(
				() => api.getResourceSetUsage(id, atRisk),
				(usage) =>
					resourceUsageConfirmOptions(setName, usage, {
						type: "resource-change",
						resourceNames: atRisk,
						confirmLabel: "Save anyway",
					}),
			);
			if (!allowed) return false;
		}
		return await act(
			"Could not update the Resource Set",
			async () => {
				await api.updateResourceSet(id, input);
				toast.success("Resource Set saved.");
			},
			refreshResourceSets,
		);
	};

	const confirmResourceRemoval = async (id: string, resourceName: string): Promise<boolean> => {
		const trimmed = resourceName.trim();
		if (trimmed === "") return true;
		const set = resourceSets.find((s) => s.id === id);
		if (!set) return true;
		return await confirmResourceChangeIfReferenced(
			() => api.getResourceSetUsage(id, [trimmed]),
			(usage) =>
				resourceUsageConfirmOptions(set.name, usage, {
					type: "resource-change",
					resourceNames: [trimmed],
					confirmLabel: "Remove resource",
				}),
		);
	};

	const handleDeleteResourceSet = async (id: string): Promise<void> => {
		const set = resourceSets.find((s) => s.id === id);
		const setName = set?.name ?? "this Resource Set";
		let confirmOptions = {
			title: `Delete "${setName}"?`,
			description: "This set will be removed from the hub.",
			confirmLabel: "Delete Resource Set",
			danger: true as const,
		};
		try {
			const referenced = resourceUsageConfirmOptions(setName, await api.getResourceSetUsage(id), { type: "delete" });
			if (referenced) confirmOptions = referenced;
		} catch {
			// Keep the generic confirmation if usage lookup fails.
		}
		if (!(await confirm(confirmOptions))) return;
		await act(
			"Could not delete the Resource Set",
			async () => {
				await api.deleteResourceSet(id);
				toast.success("Resource Set deleted.");
			},
			refreshResourceSets,
		);
	};

	/**
	 * Reads resources off the hub's disk for the set editor. Nothing is written —
	 * the editor merges them into the set it's editing and the operator saves —
	 * so there's no refresh to run, and the resources come back to the caller
	 * instead of the plain boolean the write handlers return.
	 */
	const handleScanResources = async (path: string): Promise<{ suggestedName: string; resources: Resource[] } | null> => {
		let found: { suggestedName: string; resources: Resource[] } | null = null;
		await act("Could not read the resources", async () => {
			found = await api.scanResources(path);
			toast.success(`Imported ${found.resources.length} resource${found.resources.length === 1 ? "" : "s"}.`);
		});
		return found;
	};

	// --- settings actions ---

	// The response carries the stored values, so there's nothing to re-fetch —
	// they're folded straight back into state. Returns whether the save landed,
	// like handleSaveContext, so the form knows a real success from a rejection.
	const handleSaveNotificationSettings = async (input: NotificationSettingsInput): Promise<boolean> => {
		return await act("Could not save the settings", async () => {
			setSettings(await api.saveNotificationSettings(input));
			toast.success("Settings saved.");
		});
	};

	// Same shape as the notification handler: the PUT response is the stored
	// values, folded straight back into state so the Settings form re-seeds from
	// what the hub actually kept. Returns whether the save landed so the form's
	// Save button can distinguish a real success from a rejection.
	const handleSaveShortcutSettings = async (input: ShortcutSettingsInput): Promise<boolean> => {
		return await act("Could not save the shortcuts", async () => {
			setShortcutSettings(await api.saveShortcutSettings(input));
			toast.success("Shortcuts saved.");
		});
	};

	const handleSaveReportSettings = async (input: ReportSettingsInput): Promise<boolean> => {
		return await act("Could not save activity reporting", async () => {
			setReportSettings(await api.saveReportSettings(input));
			toast.success("Activity reporting saved.");
		});
	};

	return (
		<div className={styles.app}>
			<Header
				view={view}
				onViewChange={setView}
				hasToken={hasToken}
				onSaveToken={saveToken}
				account={account}
				onLogout={onLogout}
			/>

			<main className={styles.main}>
				{view === "workflows" && allWorkflowsOpen ? (
					<AllWorkflowsPage
						workflows={workflows}
						selectedId={selectedId}
						onSelect={(id) => {
							setSelectedId(id);
							setAllWorkflowsOpen(false);
						}}
						onBack={() => setAllWorkflowsOpen(false)}
					/>
				) : view === "workflows" ? (
					<div className={styles.workflowLayout}>
						{/* On a phone the list steps aside while a workflow is open — two
						    stacked panes would mean scrolling past the whole list to reach
						    the steps of the thing you just tapped. */}
						{(!isMobile || !selectedWorkflow) && (
							<WorkflowList
								workflows={workflows}
								selectedId={selectedId}
								onSelect={setSelectedId}
								onCreate={openCreate}
								onShowAll={() => setAllWorkflowsOpen(true)}
								railResetKey={railResetKey}
							/>
						)}

						{selectedWorkflow ? (
							<WorkflowDetail
								workflow={selectedWorkflow}
								steps={steps}
								sessionInfo={sessionInfo}
								templates={templates}
								tcps={tcps}
								resourceSets={resourceSets}
								busy={busy}
								{...(isMobile ? { onBack: () => setSelectedId(null) } : {})}
								onStart={handleStart}
								onStop={handleStop}
								onClone={handleClone}
								onRename={handleRename}
								onDelete={() => void handleDelete()}
								onSetStatus={(status) => void handleSetWorkflowStatus(status)}
								onSaveContext={handleSaveContext}
								onSaveTcps={handleSaveTcps}
								onSaveResources={handleSaveResources}
								onAttachImages={handleAttachImages}
								onRemoveAttachment={(id) => void handleRemoveAttachment(id)}
								onOpenTerminal={handleOpenTerminal}
								onAddStep={handleAddStep}
								onSaveStep={handleSaveStep}
								onRemoveStep={(id) => void handleRemoveStep(id)}
								onAbortStep={(id) => void handleAbortStep(id)}
								onContinueStep={(id) => void handleContinueStep(id)}
								onOpenStepConversation={(id) => void handleOpenStepConversation(id)}
								onAddStepAfter={handleAddStepAfter}
								onSetStepStatus={(id, status) => void handleSetStepStatus(id, status)}
								onMoveStep={(id, direction) => void handleMoveStep(id, direction)}
								onAddStepsFromTemplate={handleAddStepsFromTemplate}
								onSelectionChange={handleSelectionChange}
								onAddNote={handleAddNote}
								onEditNote={handleEditNote}
								onRemoveNote={handleRemoveNote}
							/>
						) : (
							// The "pick something" placeholder is a two-pane idea: with only
							// the list on screen there is nothing to explain.
							!isMobile && (
								<section className={styles.placeholder}>
									<EmptyState
										title={loaded && workflows.length === 0 ? "Nothing here yet" : "No workflow selected"}
										description={
											loaded && workflows.length === 0
												? "Create a workflow to define its steps and run them in order."
												: "Pick a workflow from the list to see its steps and controls."
										}
										action={
											<button type="button" className="btn btn--primary btn--sm" onClick={openCreate}>
												New workflow
											</button>
										}
									/>
								</section>
							)
						)}
					</div>
				) : view === "templates" ? (
					<TemplatesView
						templates={templates}
						tcps={tcps}
						resourceSets={resourceSets}
						busy={busy}
						onCreate={handleCreateTemplate}
						onUpdate={handleUpdateTemplate}
						onDelete={(id) => void handleDeleteTemplate(id)}
						onExport={(id) => void handleExportTemplate(id)}
						onExportAll={() => void handleExportAllTemplates()}
						onImport={(file) => void handleImportTemplates(file)}
					/>
				) : view === "tcps" ? (
					<TcpsView
						tcps={tcps}
						busy={busy}
						onCreate={handleCreateTcp}
						onUpdate={handleUpdateTcp}
						onDelete={(id) => void handleDeleteTcp(id)}
						onBeforeRemoveTool={confirmTcpToolRemoval}
						onExport={(id) => void handleExportTcp(id)}
						onExportAll={() => void handleExportAllTcps()}
						onImport={(file) => void handleImportTcps(file)}
					/>
				) : view === "rci" ? (
					<ResourceSetsView
						resourceSets={resourceSets}
						busy={busy}
						onCreate={handleCreateResourceSet}
						onUpdate={handleUpdateResourceSet}
						onDelete={(id) => void handleDeleteResourceSet(id)}
						onBeforeRemoveResource={confirmResourceRemoval}
						onScan={handleScanResources}
					/>
				) : view === "settings" && settings && shortcutSettings && reportSettings ? (
					// Keyed on all three save stamps: a successful save in any section re-seeds
					// that form's local fields from what the hub actually stored.
					<SettingsView
						key={`${settings.updatedAt ?? "unsaved"}|${shortcutSettings.updatedAt ?? "unsaved"}|${reportSettings.updatedAt ?? "unsaved"}|${reportSettings.envConfigured}`}
						settings={settings}
						shortcutSettings={shortcutSettings}
						reportSettings={reportSettings}
						busy={busy}
						onSave={handleSaveNotificationSettings}
						onSaveShortcuts={handleSaveShortcutSettings}
						onSaveReport={handleSaveReportSettings}
					/>
				) : (
					<section className={styles.placeholder}>
						<EmptyState
							title={loaded ? "Settings unavailable" : "Loading settings…"}
							description={
								loaded
									? "The hub didn't return the preferences. Check that it's running and reload."
									: "Reading the preferences from the hub."
							}
						/>
					</section>
				)}
			</main>

			<CreateWorkflowModal
				open={createOpen}
				templates={templates}
				source={cloneSource}
				onClose={closeCreate}
				onCreate={handleCreate}
				onClone={handleCloneSubmit}
			/>

			<VoiceDock dictation={dictation} />
			{dialog}
		</div>
	);
}
