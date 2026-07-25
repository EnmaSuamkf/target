import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api/client.ts";
import { ApiError } from "./api/client.ts";
import type { CreateWorkflowInput, SessionInfo, Step, StepConfigInput, Template, TemplateInput, Workflow } from "./api/types.ts";
import { useConfirm } from "./components/ConfirmDialog.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { Header, type View } from "./components/Header.tsx";
import { useToast } from "./components/Toast.tsx";
import { VoiceDock } from "./components/VoiceDock.tsx";
import { useAdminToken } from "./hooks/useAdminToken.ts";
import { useDictation } from "./hooks/useDictation.ts";
import { usePolling } from "./hooks/usePolling.ts";
import { CreateWorkflowModal } from "./views/CreateWorkflowModal.tsx";
import { TemplatesView } from "./views/TemplatesView.tsx";
import { WorkflowDetail } from "./views/WorkflowDetail.tsx";
import { WorkflowList } from "./views/WorkflowList.tsx";
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
 */

const POLL_INTERVAL_MS = 2000;

function readHashSelection(): string | null {
	const match = /^#\/w\/(.+)$/.exec(window.location.hash);
	return match?.[1] ?? null;
}

export function App(): React.JSX.Element {
	const [view, setView] = useState<View>("workflows");
	const [workflows, setWorkflows] = useState<Workflow[]>([]);
	const [templates, setTemplates] = useState<Template[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(readHashSelection);
	const [steps, setSteps] = useState<Step[]>([]);
	const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [loaded, setLoaded] = useState(false);

	const toast = useToast();
	const dictation = useDictation();
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
				await Promise.all([refreshWorkflows(), refreshTemplates()]);
			} catch (err) {
				reportError(err, "Could not load data");
			} finally {
				setLoaded(true);
			}
		})();
	}, [refreshWorkflows, refreshTemplates, reportError]);

	// Detail for the selected workflow, and clearing it when nothing is selected.
	useEffect(() => {
		if (!selectedId) {
			setSteps([]);
			setSessionInfo(null);
			return;
		}
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
		if (ok) setCreateOpen(false);
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

	const handleOpenTerminal = async (): Promise<void> => {
		if (!selectedId) return;
		await act("Could not open the conversation", async () => {
			await api.openTerminal(selectedId);
			toast.success("Terminal opened.");
		});
	};

	// --- step actions ---

	const handleAddStep = async (input: StepConfigInput): Promise<void> => {
		if (!selectedId) return;
		await act("Could not add the step", () => api.addStep(selectedId, input), refreshCurrent);
	};

	const handleSaveStep = async (stepId: string, input: StepConfigInput): Promise<void> => {
		if (!selectedId) return;
		await act("Could not edit the step", () => api.editStep(selectedId, stepId, input), refreshCurrent);
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

	const handleRunStep = async (stepId: string): Promise<void> => {
		if (!selectedId) return;
		await act("Could not run the step", () => api.runStep(selectedId, stepId), refreshCurrent);
	};

	const handleAbortStep = async (stepId: string): Promise<void> => {
		if (!selectedId) return;
		const confirmed = await confirm({
			title: "Abort this step?",
			description: "Force-fails a step whose run never called back, so it can be re-run. Its session is preserved.",
			confirmLabel: "Abort step",
			danger: true,
		});
		if (!confirmed) return;
		await act("Could not abort the step", () => api.abortStep(selectedId, stepId), refreshCurrent);
	};

	const handleAddStepsFromTemplate = async (templateId: string): Promise<void> => {
		if (!selectedId) return;
		await act(
			"Could not add the template's steps",
			async () => {
				const result = await api.addStepsFromTemplate(selectedId, templateId);
				toast.success(
					result.skipped > 0
						? `Added ${result.added} step(s); skipped ${result.skipped} already present.`
						: `Added ${result.added} step(s).`,
				);
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

	return (
		<div className={styles.app}>
			<Header view={view} onViewChange={setView} hasToken={hasToken} onSaveToken={saveToken} />

			<main className={styles.main}>
				{!hasToken && (
					<div className={styles.tokenNotice} role="status">
						<strong>No admin token set.</strong> Reading works, but creating or running anything needs the token the
						hub printed on startup (also in <code>~/.target/config.json</code>).
					</div>
				)}

				{view === "workflows" ? (
					<div className={styles.workflowLayout}>
						<WorkflowList
							workflows={workflows}
							selectedId={selectedId}
							onSelect={setSelectedId}
							onCreate={() => setCreateOpen(true)}
						/>

						{selectedWorkflow ? (
							<WorkflowDetail
								workflow={selectedWorkflow}
								steps={steps}
								sessionInfo={sessionInfo}
								templates={templates}
								busy={busy}
								onStart={handleStart}
								onStop={handleStop}
								onDelete={() => void handleDelete()}
								onSaveContext={handleSaveContext}
								onOpenTerminal={handleOpenTerminal}
								onAddStep={handleAddStep}
								onSaveStep={handleSaveStep}
								onRemoveStep={(id) => void handleRemoveStep(id)}
								onRunStep={(id) => void handleRunStep(id)}
								onAbortStep={(id) => void handleAbortStep(id)}
								onAddStepsFromTemplate={handleAddStepsFromTemplate}
							/>
						) : (
							<section className={styles.placeholder}>
								<EmptyState
									title={loaded && workflows.length === 0 ? "Nothing here yet" : "No workflow selected"}
									description={
										loaded && workflows.length === 0
											? "Create a workflow to define its steps and run them in order."
											: "Pick a workflow from the list to see its steps and controls."
									}
									action={
										<button type="button" className="btn btn--primary btn--sm" onClick={() => setCreateOpen(true)}>
											New workflow
										</button>
									}
								/>
							</section>
						)}
					</div>
				) : (
					<TemplatesView
						templates={templates}
						busy={busy}
						onCreate={handleCreateTemplate}
						onUpdate={handleUpdateTemplate}
						onDelete={(id) => void handleDeleteTemplate(id)}
					/>
				)}
			</main>

			<CreateWorkflowModal
				open={createOpen}
				templates={templates}
				onClose={() => setCreateOpen(false)}
				onCreate={handleCreate}
			/>

			<VoiceDock dictation={dictation} />
			{dialog}
		</div>
	);
}
