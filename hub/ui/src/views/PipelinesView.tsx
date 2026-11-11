import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	approvePipeline,
	createPipeline,
	exportPipelines,
	getPipeline,
	importPipelines,
	listPipelines,
	updatePipeline,
	validatePipeline,
} from "../api/client.ts";
import type { PipelineDetail, PipelineSummary, PipelineValidationError } from "../api/types.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { useIsMobile } from "../hooks/useIsMobile.ts";
import { usePermissions, requires } from "../hooks/usePermissions.ts";
import { relativeTime } from "../lib/format.ts";
import styles from "./PipelinesView.module.css";

/**
 * The hub refuses a pipeline document over this size (`MAX_PIPELINE_BYTES` in
 * hub/pipeline-yaml.ts). The browser checks the file's size before reading it,
 * so an oversized file is never loaded into memory just to be turned away.
 */
export const MAX_PIPELINE_UPLOAD_BYTES = 64 * 1024;

/** How long the editor waits after the last keystroke before asking the hub to check the text. */
const VALIDATE_DEBOUNCE_MS = 400;

function kib(bytes: number): string {
	return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

/**
 * Reads an uploaded YAML file into text, or says why it cannot be used. The size
 * check comes first, on `file.size`, so a large file is refused without being read.
 * UTF-8 is decoded strictly: a file in another encoding is refused rather than
 * silently shown with replacement characters that would then be saved.
 */
export async function readPipelineFile(file: File): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
	if (file.size > MAX_PIPELINE_UPLOAD_BYTES) {
		return {
			ok: false,
			message: `${file.name} is ${kib(file.size)}. Pipelines are limited to ${kib(MAX_PIPELINE_UPLOAD_BYTES)}, so it was not read.`,
		};
	}
	const bytes = await file.arrayBuffer();
	try {
		return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
	} catch {
		return { ok: false, message: `${file.name} is not valid UTF-8 text, so it cannot be a pipeline.` };
	}
}

function downloadJson(name: string, value: unknown): void {
	const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}

type Selection = { kind: "none" } | { kind: "new" } | { kind: "existing"; id: string };

export function PipelinesView(): React.JSX.Element {
	const [list, setList] = useState<PipelineSummary[] | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [selection, setSelection] = useState<Selection>({ kind: "none" });
	const [detail, setDetail] = useState<PipelineDetail | null>(null);
	/** The text the editor shows. */
	const [draft, setDraft] = useState("");
	/** The text as last saved (for an existing pipeline) or "" for a new one. */
	const [saved, setSaved] = useState("");
	const [errors, setErrors] = useState<PipelineValidationError[]>([]);
	const [validating, setValidating] = useState(false);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const [dragging, setDragging] = useState(false);
	const isMobile = useIsMobile();
	const { can } = usePermissions();
	const canWrite = can("client.workflows.manage");
	const { confirm, dialog } = useConfirm();
	const fileInput = useRef<HTMLInputElement>(null);
	const importInput = useRef<HTMLInputElement>(null);
	/** Guards the debounced validation against answers that arrive after a newer edit. */
	const validationRun = useRef(0);

	const dirty = selection.kind === "new" ? draft !== "" : draft !== saved;
	const editing = selection.kind !== "none";

	const refreshList = useCallback(async (): Promise<void> => {
		try {
			setList(await listPipelines());
			setListError(null);
		} catch (err) {
			setListError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void refreshList();
	}, [refreshList]);

	// Debounced check of the draft. An empty editor has nothing to check.
	useEffect(() => {
		if (!editing) return;
		if (draft.trim() === "") {
			setErrors([]);
			setValidating(false);
			return;
		}
		const run = ++validationRun.current;
		setValidating(true);
		const timer = window.setTimeout(() => {
			validatePipeline(draft)
				.then((result) => {
					if (run !== validationRun.current) return;
					setErrors(result.ok ? [] : result.errors);
				})
				.catch((err: unknown) => {
					if (run !== validationRun.current) return;
					setErrors([{ line: null, path: "", message: err instanceof Error ? err.message : String(err) }]);
				})
				.finally(() => {
					if (run === validationRun.current) setValidating(false);
				});
		}, VALIDATE_DEBOUNCE_MS);
		return () => window.clearTimeout(timer);
	}, [draft, editing]);

	// Leaving the page with unsaved text is the one way out of the editor the
	// browser can still intercept.
	useEffect(() => {
		if (!dirty) return;
		const warn = (ev: BeforeUnloadEvent): void => {
			ev.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	/** Asks before leaving unsaved text. Resolves true when it is safe to move on. */
	const leaveEditor = async (): Promise<boolean> => {
		if (!dirty) return true;
		return confirm({
			title: "Discard unsaved changes?",
			description: "The pipeline text you changed has not been saved.",
			confirmLabel: "Discard",
			danger: true,
		});
	};

	const openExisting = async (id: string): Promise<void> => {
		if (selection.kind === "existing" && selection.id === id) return;
		if (!(await leaveEditor())) return;
		setMessage(null);
		try {
			const full = await getPipeline(id);
			setDetail(full);
			setSaved(full.source);
			setDraft(full.source);
			setErrors(full.errors);
			setSelection({ kind: "existing", id });
		} catch (err) {
			setMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
		}
	};

	const openNew = async (): Promise<void> => {
		if (selection.kind === "new") return;
		if (!(await leaveEditor())) return;
		setMessage(null);
		setDetail(null);
		setSaved("");
		setDraft("");
		setErrors([]);
		setSelection({ kind: "new" });
	};

	/**
	 * Puts an uploaded file in the editor as a NEW pipeline. Nothing is sent to the
	 * hub here: the operator reviews the text and presses Save. An existing
	 * pipeline is never replaced by an upload.
	 */
	const takeUpload = async (file: File): Promise<void> => {
		setMessage(null);
		const read = await readPipelineFile(file);
		if (!read.ok) {
			setMessage({ tone: "error", text: read.message });
			return;
		}
		if (dirty) {
			const replace = await confirm({
				title: "Replace the text in the editor?",
				description: `The text you changed will be replaced by ${file.name}. Nothing is saved either way.`,
				confirmLabel: "Replace",
				danger: true,
			});
			if (!replace) return;
		}
		setDetail(null);
		setSaved("");
		setDraft(read.text);
		setSelection({ kind: "new" });
	};

	const save = async (): Promise<void> => {
		if (saving || !dirty || errors.length > 0 || validating) return;
		setSaving(true);
		setMessage(null);
		try {
			const result =
				selection.kind === "existing" ? await updatePipeline(selection.id, draft) : await createPipeline(draft);
			setDetail(result);
			setSaved(result.source);
			setDraft(result.source);
			setErrors(result.errors);
			setSelection({ kind: "existing", id: result.id });
			await refreshList();
			setMessage({
				tone: "ok",
				text: result.trusted
					? "Saved and approved: this pipeline can run."
					: "Saved, but it is not approved yet. It will not run until you approve it.",
			});
		} catch (err) {
			setMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
		} finally {
			setSaving(false);
		}
	};

	const approve = async (): Promise<void> => {
		if (!detail || saving) return;
		setSaving(true);
		setMessage(null);
		try {
			const approved = await approvePipeline(detail.id, detail.sourceHash);
			setDetail({ ...detail, ...approved, errors: detail.errors, referencedBy: detail.referencedBy });
			await refreshList();
			setMessage({ tone: "ok", text: "Approved. This pipeline can run now." });
		} catch (err) {
			setMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
		} finally {
			setSaving(false);
		}
	};

	const importFile = async (file: File): Promise<void> => {
		setMessage(null);
		try {
			const bundle = JSON.parse(await file.text()) as unknown;
			const created = await importPipelines(bundle);
			await refreshList();
			setMessage({
				tone: "ok",
				text: `Imported ${created.length} pipeline${created.length === 1 ? "" : "s"}. They are not approved yet: approve each one before it can run.`,
			});
		} catch (err) {
			setMessage({ tone: "error", text: `Import failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	};

	const exportAll = async (): Promise<void> => {
		try {
			downloadJson("target-pipelines.json", await exportPipelines());
		} catch (err) {
			setMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
		}
	};

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (list ?? [])
			.filter((p) => (q === "" ? true : p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q))))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [list, query]);

	const canSave = canWrite && dirty && errors.length === 0 && !validating && !saving && draft.trim() !== "";
	const showList = !isMobile || !editing;
	const showEditor = !isMobile || editing;
	const untrusted = detail !== null && !detail.trusted;

	return (
		<div className={styles.layout}>
			{showList && (
				<aside className={styles.listPanel} aria-label="Pipelines">
					<div className={styles.head}>
						<div className={styles.headRow}>
							<h2 className={styles.heading}>
								Pipelines
								{list && list.length > 0 && <span className={styles.count}>{list.length}</span>}
							</h2>
							<button
								type="button"
								className="btn btn--primary btn--sm"
								onClick={() => void openNew()}
								disabled={!canWrite}
								title={canWrite ? undefined : requires("client.workflows.manage")}
							>
								New
							</button>
						</div>
						<div className={styles.ioRow}>
							<button
								type="button"
								className="btn btn--sm"
								onClick={() => fileInput.current?.click()}
								disabled={!canWrite}
								title={canWrite ? "Pick a .yml or .yaml file; it opens as a new pipeline" : requires("client.workflows.manage")}
							>
								Upload YAML
							</button>
							<button
								type="button"
								className="btn btn--sm"
								onClick={() => importInput.current?.click()}
								disabled={!canWrite}
								title={canWrite ? "Import a bundle exported from another hub (.json)" : requires("client.workflows.manage")}
							>
								Import
							</button>
							<button
								type="button"
								className="btn btn--sm"
								onClick={() => void exportAll()}
								disabled={!list || list.length === 0}
							>
								Export
							</button>
						</div>
						<input
							ref={fileInput}
							type="file"
							accept=".yml,.yaml,text/yaml,application/yaml"
							className={styles.fileInput}
							aria-label="Upload a pipeline YAML file"
							onChange={(ev) => {
								const f = ev.target.files?.[0];
								if (f) void takeUpload(f);
								ev.target.value = "";
							}}
						/>
						<input
							ref={importInput}
							type="file"
							accept="application/json,.json"
							className={styles.fileInput}
							aria-label="Import a pipeline bundle"
							onChange={(ev) => {
								const f = ev.target.files?.[0];
								if (f) void importFile(f);
								ev.target.value = "";
							}}
						/>
						<input
							type="search"
							className="input"
							placeholder="Search pipelines…"
							value={query}
							onChange={(ev) => setQuery(ev.target.value)}
						/>
					</div>
					<div className={styles.list}>
						{listError && <p className={styles.error}>{listError}</p>}
						{list !== null && visible.length === 0 ? (
							<EmptyState
								title={list.length === 0 ? "No pipeline yet" : "No match"}
								description={
									list.length === 0
										? "A pipeline is a short list of shell commands the hub runs on this machine for a command step. Write one, or upload a .yml file."
										: "No pipeline matches that search."
								}
							/>
						) : (
							visible.map((p) => (
								<button
									key={p.id}
									type="button"
									className={`${styles.card} ${selection.kind === "existing" && selection.id === p.id ? styles.cardSelected : ""}`}
									onClick={() => void openExisting(p.id)}
									aria-current={selection.kind === "existing" && selection.id === p.id ? "true" : undefined}
								>
									<span className={styles.cardNameRow}>
										<span className={styles.cardName}>{p.name}</span>
										<TrustBadge trusted={p.trusted} revoked={p.revoked} />
									</span>
									<span className={styles.cardMeta}>
										{p.tags.length > 0 ? `${p.tags.join(", ")} · ` : ""}
										{p.origin === "server" ? "from server · " : ""}
										updated {relativeTime(p.updatedAt)}
									</span>
								</button>
							))
						)}
					</div>
				</aside>
			)}

			{showEditor && (
				<section className={styles.formPanel} aria-label="Pipeline editor">
					{!editing ? (
						<EmptyState title="No pipeline selected" description="Pick one to read or edit it, or start a new one." />
					) : (
						<>
							{isMobile && (
								<button type="button" className="btn btn--sm" onClick={() => setSelection({ kind: "none" })}>
									← Pipelines
								</button>
							)}
							<div className={styles.titleRow}>
								<h3 className={styles.title}>{detail ? detail.name : "New pipeline"}</h3>
								{detail && <TrustBadge trusted={detail.trusted} revoked={detail.revoked} />}
								{dirty && <span className={styles.dirty}>unsaved changes</span>}
							</div>

							{untrusted && (
								<div className={styles.trustBanner} role="status">
									<p className={styles.trustTitle}>This pipeline will not run until you approve it.</p>
									<p className={styles.trustText}>
										{detail.trustedHash
											? "The text changed since it was last approved. Review it below, then approve it."
											: "It has not been approved. Review the text below. Approving it lets command steps run it on this machine."}
										{dirty ? " Save your changes first; approval applies to the saved text." : ""}
									</p>
									<details className={styles.sourceToApprove}>
										<summary>Show the text to approve</summary>
										<pre className={styles.approveSource}>{detail.source}</pre>
									</details>
									<button
										type="button"
										className="btn btn--primary btn--sm"
										onClick={() => void approve()}
										disabled={!canWrite || saving || dirty}
										title={canWrite ? undefined : requires("client.workflows.manage")}
									>
										Approve
									</button>
								</div>
							)}

							<PipelineEditor
								value={draft}
								onChange={setDraft}
								errors={errors}
								disabled={!canWrite}
								dragging={dragging}
								onDragState={setDragging}
								onDropFile={(file) => void takeUpload(file)}
							/>

							<div className={styles.validation} aria-live="polite">
								{validating && <span className={styles.muted}>Checking…</span>}
								{!validating && draft.trim() === "" && <span className={styles.muted}>Write the pipeline in YAML.</span>}
								{!validating && draft.trim() !== "" && errors.length === 0 && (
									<span className={styles.ok}>Valid.</span>
								)}
								{!validating && errors.length > 0 && (
									<ul className={styles.errorList}>
										{errors.map((err, i) => (
											<li key={`${err.line ?? "x"}-${i}`}>
												{err.line !== null ? <strong>Line {err.line}: </strong> : null}
												{err.message}
											</li>
										))}
									</ul>
								)}
							</div>

							<div className={styles.actions}>
								<button
									type="button"
									className="btn btn--primary"
									onClick={() => void save()}
									disabled={!canSave}
									title={
										!canWrite
											? requires("client.workflows.manage")
											: errors.length > 0
												? "Fix the errors first"
												: undefined
									}
								>
									{saving ? "Saving…" : "Save"}
								</button>
								{!detail && (
									<span className={styles.muted}>Saving from this page approves the pipeline.</span>
								)}
							</div>
							{message && (
								<p className={message.tone === "ok" ? styles.ok : styles.error} role={message.tone === "error" ? "alert" : "status"}>
									{message.text}
								</p>
							)}
						</>
					)}
				</section>
			)}
			{dialog}
		</div>
	);
}

function TrustBadge({ trusted, revoked }: { trusted: boolean; revoked: boolean }): React.JSX.Element {
	if (revoked) return <span className={`${styles.badge} ${styles.badgeRevoked}`}>Revoked</span>;
	return trusted ? (
		<span className={`${styles.badge} ${styles.badgeTrusted}`}>Trusted</span>
	) : (
		<span className={`${styles.badge} ${styles.badgeUntrusted}`}>Needs approval</span>
	);
}

/**
 * The YAML editor: a monospace textarea with a line-number gutter. Lines that
 * carry a validation error are marked in the gutter, and the error text is
 * listed under the editor by the caller. The gutter scrolls with the text.
 */
function PipelineEditor({
	value,
	onChange,
	errors,
	disabled,
	dragging,
	onDragState,
	onDropFile,
}: {
	value: string;
	onChange: (value: string) => void;
	errors: PipelineValidationError[];
	disabled: boolean;
	dragging: boolean;
	onDragState: (dragging: boolean) => void;
	onDropFile: (file: File) => void;
}): React.JSX.Element {
	const gutter = useRef<HTMLDivElement>(null);
	const lineCount = Math.max(1, value.split("\n").length);
	const errorLines = useMemo(() => new Set(errors.map((e) => e.line).filter((l): l is number => l !== null)), [errors]);
	const numbers = Array.from({ length: lineCount }, (_, i) => i + 1);

	return (
		<div
			className={`${styles.editor} ${dragging ? styles.editorDragging : ""}`}
			onDragOver={(ev) => {
				if (disabled) return;
				ev.preventDefault();
				onDragState(true);
			}}
			onDragLeave={() => onDragState(false)}
			onDrop={(ev) => {
				ev.preventDefault();
				onDragState(false);
				if (disabled) return;
				const file = ev.dataTransfer.files?.[0];
				if (file) onDropFile(file);
			}}
		>
			<div className={styles.gutter} ref={gutter} aria-hidden="true">
				{numbers.map((n) => (
					<div key={n} className={`${styles.lineNo} ${errorLines.has(n) ? styles.lineNoError : ""}`}>
						{n}
					</div>
				))}
			</div>
			<textarea
				className={styles.textarea}
				aria-label="Pipeline YAML"
				value={value}
				spellCheck={false}
				wrap="off"
				disabled={disabled}
				rows={Math.min(Math.max(lineCount, 12), 28)}
				onChange={(ev) => onChange(ev.target.value)}
				onScroll={(ev) => {
					if (gutter.current) gutter.current.scrollTop = ev.currentTarget.scrollTop;
				}}
				placeholder={"name: verify\nsteps:\n  - name: Tests\n    run: npm test"}
			/>
		</div>
	);
}
