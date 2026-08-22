import { useEffect, useMemo, useRef, useState } from "react";
import type {
	ResourceSelection,
	ResourceSet,
	Tcp,
	TcpSelection,
	Template,
	TemplateInput,
	TemplateStep,
	TemplateStepNote,
} from "../api/types.ts";
import { StepNotes } from "../components/StepNotes.tsx";
import { ResourceSelectionEditor } from "./ResourceSelectionEditor.tsx";
import { TcpSelectionEditor } from "./TcpSelectionEditor.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ExpandableTextarea } from "../components/ExpandableTextarea.tsx";
import { Field } from "../components/Field.tsx";
import { Switch } from "../components/Switch.tsx";
import { useIsMobile } from "../hooks/useIsMobile.ts";
import { relativeTime } from "../lib/format.ts";
import styles from "./TemplatesView.module.css";

/**
 * Templates: reusable ordered step lists that seed a new workflow or get
 * appended to an existing one. They never execute, so there's no status or
 * session here — just a name, tags, and the steps with their verification
 * config (acceptance criteria, retries, and the manual-review gate), all of
 * which are copied onto the real steps the template creates.
 *
 * Search filters locally on name and tags (the API also accepts `?q=`, but
 * filtering in the browser is instant and the list is small by nature).
 *
 * Layout mirrors the workflows view: side-by-side list and form on a wide
 * screen, and on a phone the same state (`creating` / `editingId`) decides
 * which of the two is the screen you're on, with a back link out of the form.
 */
export function TemplatesView({
	templates,
	tcps,
	resourceSets,
	busy,
	onCreate,
	onUpdate,
	onDelete,
	onExport,
	onExportAll,
	onImport,
}: {
	templates: Template[];
	tcps: Tcp[];
	resourceSets: ResourceSet[];
	busy: boolean;
	onCreate: (input: TemplateInput) => Promise<void>;
	onUpdate: (id: string, input: TemplateInput) => Promise<void>;
	onDelete: (id: string) => void;
	/** Downloads one template as a .json bundle — the export half of moving one between machines. */
	onExport: (id: string) => void;
	/** The same, for every template at once. */
	onExportAll: () => void;
	/** Reads a chosen .json bundle and stores its templates as new ones. */
	onImport: (file: File) => void;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [tagFilter, setTagFilter] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const isMobile = useIsMobile();
	// A file input can only be opened by the user clicking the input itself, so
	// the visible "Import" button clicks a hidden one on their behalf — that's
	// the only way to have an import control that matches the other buttons.
	const fileInput = useRef<HTMLInputElement>(null);

	const allTags = useMemo(() => {
		const tags = new Set<string>();
		for (const template of templates) for (const tag of template.tags) tags.add(tag);
		return [...tags].sort();
	}, [templates]);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return templates
			.filter((t) => (tagFilter === "" ? true : t.tags.includes(tagFilter)))
			.filter((t) =>
				q === "" ? true : t.name.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q)),
			)
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [templates, query, tagFilter]);

	const editing = editingId ? (templates.find((t) => t.id === editingId) ?? null) : null;

	// If the template being edited disappears (deleted elsewhere), leave the form.
	useEffect(() => {
		if (editingId && !templates.some((t) => t.id === editingId)) setEditingId(null);
	}, [templates, editingId]);

	const showForm = creating || editing !== null;
	const closeForm = (): void => {
		setCreating(false);
		setEditingId(null);
	};

	return (
		<div className={styles.layout}>
			{/* One pane at a time on a phone — see the layout note above. */}
			{(!isMobile || !showForm) && (
			<aside className={styles.listPanel} aria-label="Templates">
				<div className={styles.head}>
					<div className={styles.headRow}>
						<h2 className={styles.heading}>
							Templates
							{templates.length > 0 && <span className={styles.count}>{templates.length}</span>}
						</h2>
						<button
							type="button"
							className="btn btn--primary btn--sm"
							onClick={() => {
								setEditingId(null);
								setCreating(true);
							}}
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
								<path d="M12 5v14M5 12h14" />
							</svg>
							New
						</button>
					</div>

					{/* Moving templates between machines: a bundle is plain, portable
					    JSON (no ids, no paths, nothing machine-specific), so export is
					    a download and import is a file the operator picks. */}
					<div className={styles.ioRow}>
						<button
							type="button"
							className="btn btn--sm"
							onClick={() => fileInput.current?.click()}
							disabled={busy}
							title="Import templates from a .json bundle"
						>
							Import
						</button>
						{templates.length > 0 && (
							<button
								type="button"
								className="btn btn--sm"
								onClick={onExportAll}
								disabled={busy}
								title="Download every template as one .json bundle"
							>
								Export all
							</button>
						)}
						<input
							ref={fileInput}
							type="file"
							accept="application/json,.json"
							className={styles.fileInput}
							aria-label="Template bundle to import"
							onChange={(ev) => {
								const file = ev.target.files?.[0];
								// Cleared straight away so picking the SAME file again still
								// fires a change event — re-importing after a failed attempt
								// would otherwise appear to do nothing.
								ev.target.value = "";
								if (file) onImport(file);
							}}
						/>
					</div>

					{templates.length > 0 && (
						<>
							<input
								type="search"
								className="input"
								placeholder="Search by name or tag…"
								value={query}
								onChange={(ev) => setQuery(ev.target.value)}
								aria-label="Search templates"
							/>
							{allTags.length > 0 && (
								<div className={styles.tags} role="group" aria-label="Filter by tag">
									<button
										type="button"
										className={`${styles.tag} ${tagFilter === "" ? styles.tagActive : ""}`}
										onClick={() => setTagFilter("")}
										aria-pressed={tagFilter === ""}
									>
										All
									</button>
									{allTags.map((tag) => (
										<button
											key={tag}
											type="button"
											className={`${styles.tag} ${tagFilter === tag ? styles.tagActive : ""}`}
											onClick={() => setTagFilter(tag)}
											aria-pressed={tagFilter === tag}
										>
											{tag}
										</button>
									))}
								</div>
							)}
						</>
					)}
				</div>

				<div className={styles.list}>
					{visible.length === 0 ? (
						templates.length === 0 ? (
							<EmptyState
								title="No templates yet"
								description="Save a step list you repeat, then use it to seed new workflows."
								action={
									<button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
										Create a template
									</button>
								}
							/>
						) : (
							<EmptyState title="No matches" description="Try a different search or clear the tag filter." />
						)
					) : (
						visible.map((template) => (
							<button
								key={template.id}
								type="button"
								className={`${styles.card} ${template.id === editingId ? styles.cardSelected : ""}`}
								onClick={() => {
									setCreating(false);
									setEditingId(template.id);
								}}
								aria-current={template.id === editingId ? "true" : undefined}
							>
								<span className={styles.cardName}>{template.name}</span>
								<span className={styles.cardMeta}>
									{template.steps.length} step{template.steps.length === 1 ? "" : "s"} ·{" "}
									{relativeTime(template.updatedAt)}
								</span>
								{template.tags.length > 0 && (
									<span className={styles.cardTags}>
										{template.tags.map((tag) => (
											<span key={tag} className={styles.cardTag}>
												{tag}
											</span>
										))}
									</span>
								)}
							</button>
						))
					)}
				</div>
			</aside>
			)}

			{/* With only the list on screen there is nothing for a "pick one"
			    placeholder to sit next to, so the pane isn't rendered at all. */}
			{showForm ? (
				<section className={styles.formPanel}>
					<TemplateForm
						key={editing?.id ?? "new"}
						template={editing}
						tcps={tcps}
						resourceSets={resourceSets}
						busy={busy}
						{...(isMobile ? { onBack: closeForm } : {})}
						onCancel={closeForm}
						onDelete={editing ? () => onDelete(editing.id) : undefined}
						// Only for a template that exists: there is nothing to export
						// from a form that hasn't been saved yet.
						onExport={editing ? () => onExport(editing.id) : undefined}
						onSubmit={async (input) => {
							if (editing) await onUpdate(editing.id, input);
							else await onCreate(input);
							setCreating(false);
						}}
					/>
				</section>
			) : (
				!isMobile && (
					<section className={styles.formPanel}>
						<EmptyState
							title="No template selected"
							description="Pick a template to edit it, or create a new one."
							action={
								<button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
									New template
								</button>
							}
						/>
					</section>
				)
			)}
		</div>
	);
}

/** Create/edit form for a template and its ordered steps. */
function TemplateForm({
	template,
	tcps,
	resourceSets,
	busy,
	onSubmit,
	onCancel,
	onBack,
	onDelete,
	onExport,
}: {
	template: Template | null;
	tcps: Tcp[];
	resourceSets: ResourceSet[];
	busy: boolean;
	onSubmit: (input: TemplateInput) => Promise<void>;
	onCancel: () => void;
	/** Only supplied when the list isn't on screen beside this form. */
	onBack?: () => void;
	onDelete?: (() => void) | undefined;
	/** Only supplied for a saved template — downloads it as a .json bundle. */
	onExport?: (() => void) | undefined;
}): React.JSX.Element {
	const [name, setName] = useState(template?.name ?? "");
	const [tags, setTags] = useState(template?.tags.join(", ") ?? "");
	const [steps, setSteps] = useState<TemplateStep[]>(template?.steps ?? []);
	const [tcpSelections, setTcpSelections] = useState<TcpSelection[]>(template?.tcpSelections ?? []);
	const [resourceSelections, setResourceSelections] = useState<ResourceSelection[]>(template?.resourceSelections ?? []);
	const [saving, setSaving] = useState(false);

	const updateStep = (index: number, patch: Partial<TemplateStep>): void => {
		setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
	};

	const move = (index: number, delta: number): void => {
		setSteps((current) => {
			const target = index + delta;
			if (target < 0 || target >= current.length) return current;
			const next = [...current];
			const [moved] = next.splice(index, 1);
			if (moved) next.splice(target, 0, moved);
			return next;
		});
	};

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		const trimmedName = name.trim();
		if (!trimmedName || saving) return;
		setSaving(true);
		try {
			await onSubmit({
				name: trimmedName,
				tags: tags
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean),
				tcpSelections,
				resourceSelections,
				// Drop blank rows rather than persisting empty steps.
				steps: steps
					.map((step) => ({ ...step, description: step.description.trim() }))
					.filter((step) => step.description !== ""),
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<form className={styles.form} onSubmit={submit}>
			{onBack && (
				<button type="button" className={styles.back} onClick={onBack}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M15 18l-6-6 6-6" />
					</svg>
					Templates
				</button>
			)}

			<div className={styles.formHead}>
				<h2 className={styles.heading}>{template ? "Edit template" : "New template"}</h2>
				<div className={styles.formHeadActions}>
					{onExport && (
						<button
							type="button"
							className="btn btn--sm"
							onClick={onExport}
							disabled={busy || saving}
							title="Download this template as a .json bundle"
						>
							Export
						</button>
					)}
					{onDelete && (
						<button type="button" className="btn btn--sm btn--danger" onClick={onDelete} disabled={busy || saving}>
							Delete
						</button>
					)}
				</div>
			</div>

			<Field label="Name" required>
				{(props) => (
					<input
						{...props}
						type="text"
						className="input"
						value={name}
						placeholder="e.g. release checklist"
						onChange={(ev) => setName(ev.target.value)}
						required
					/>
				)}
			</Field>

			<Field label="Tags" hint="Comma-separated, used for search and filtering.">
				{(props) => (
					<input
						{...props}
						type="text"
						className="input"
						value={tags}
						placeholder="release, docs"
						onChange={(ev) => setTags(ev.target.value)}
					/>
				)}
			</Field>

			<div className={styles.stepsBlock}>
				<span className="label">TCP packs</span>
				<p className="hint">Attached to the workflow when this template is used. Select a whole pack or individual tools.</p>
				<TcpSelectionEditor tcps={tcps} selections={tcpSelections} onChange={setTcpSelections} />
			</div>

			<div className={styles.stepsBlock}>
				<span className="label">Resource Sets (RCI)</span>
				<p className="hint">
					Injected into the workflow's conversation when this template is used — nothing is installed in the agent.
					Select a whole set or individual resources.
				</p>
				<ResourceSelectionEditor resourceSets={resourceSets} selections={resourceSelections} onChange={setResourceSelections} />
			</div>

			<div className={styles.stepsBlock}>
				<div className={styles.stepsHead}>
					<span className="label">Steps</span>
					<span className="hint">{steps.length} total</span>
				</div>

				{steps.length === 0 && <p className="hint">No steps yet — add the first one below.</p>}

				<div className={styles.stepRows}>
					{steps.map((step, index) => (
						// Index keys are correct here: these rows are positional and
						// reordering is an explicit user action that rewrites the list.
						<div key={index} className={styles.stepRow}>
							<div className={styles.stepRowHead}>
								<span className={styles.stepRowIndex}>{index + 1}</span>
								<div className={styles.stepRowControls}>
									<button
										type="button"
										className="btn btn--sm btn--ghost"
										onClick={() => move(index, -1)}
										disabled={index === 0}
										aria-label={`Move step ${index + 1} up`}
									>
										↑
									</button>
									<button
										type="button"
										className="btn btn--sm btn--ghost"
										onClick={() => move(index, 1)}
										disabled={index === steps.length - 1}
										aria-label={`Move step ${index + 1} down`}
									>
										↓
									</button>
									<button
										type="button"
										className="btn btn--sm btn--ghost"
										onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}
										aria-label={`Remove step ${index + 1}`}
									>
										✕
									</button>
								</div>
							</div>

							<ExpandableTextarea
								value={step.description}
								placeholder="What the agent should do in this step…"
								onChange={(value) => updateStep(index, { description: value })}
								aria-label={`Step ${index + 1} description`}
								expandTitle={`Edit step ${index + 1} description`}
							/>
							<ExpandableTextarea
								value={step.acceptanceCriteria ?? ""}
								placeholder="Optional acceptance criteria — empty = no judge."
								onChange={(value) => updateStep(index, { acceptanceCriteria: value || null })}
								aria-label={`Step ${index + 1} acceptance criteria`}
								expandTitle={`Edit step ${index + 1} acceptance criteria`}
							/>

							<div className={styles.stepRowGrid}>
								<label className={styles.smallField}>
									<span className="hint">Max retries</span>
									<input
										type="number"
										className="input"
										min={0}
										step={1}
										value={step.maxRetries}
										onChange={(ev) =>
											updateStep(index, { maxRetries: Math.max(0, parseInt(ev.target.value, 10) || 0) })
										}
									/>
								</label>
								<label className={styles.smallField}>
									<span className="hint">Interval (s)</span>
									<input
										type="number"
										className="input"
										min={0}
										step={1}
										value={step.maxRetries > 1 ? step.retryIntervalSeconds : 0}
										disabled={step.maxRetries <= 1}
										onChange={(ev) =>
											updateStep(index, {
												retryIntervalSeconds: Math.max(0, parseInt(ev.target.value, 10) || 0),
											})
										}
										title="Only applies with more than one retry."
									/>
								</label>
							</div>

							{/* Carried onto every step this template creates: a checklist whose
							    sign-off step is gated is only reusable if the gate travels with it. */}
							<div className={styles.stepRowToggle}>
								<span className="hint">Manual review — the workflow waits for a human after this step</span>
								<Switch
									checked={step.manualReview}
									onChange={(next) => updateStep(index, { manualReview: next })}
									label={`Step ${index + 1} manual review`}
								/>
							</div>

							{/* Carried onto every step this template creates too: whether the
							    step is delegated to a subagent (the default) or run inline. */}
							<div className={styles.stepRowToggle}>
								<span className="hint">Use subagent — off runs this step inline in the conversation</span>
								<Switch
									checked={step.useSubagent !== false}
									onChange={(next) => updateStep(index, { useSubagent: next })}
									label={`Step ${index + 1} use subagent`}
								/>
							</div>

							<StepNotes
								notes={step.notes ?? []}
								onAdd={async (content, theme) => {
									const note: TemplateStepNote = { id: crypto.randomUUID(), content, theme };
									updateStep(index, { notes: [...(step.notes ?? []), note] });
								}}
								onEdit={async (noteId, content, theme) => {
									updateStep(index, {
										notes: (step.notes ?? []).map((n) =>
											n.id === noteId ? { ...n, content, theme } : n,
										),
									});
								}}
								onRemove={async (noteId) => {
									updateStep(index, { notes: (step.notes ?? []).filter((n) => n.id !== noteId) });
								}}
							/>
						</div>
					))}
				</div>

				<button
					type="button"
					className={styles.addStep}
					onClick={() =>
						setSteps((current) => [
							...current,
							{
								description: "",
								acceptanceCriteria: null,
								manualReview: false,
								useSubagent: true,
								maxRetries: 0,
								retryIntervalSeconds: 0,
							},
						])
					}
				>
					+ Add step
				</button>
			</div>

			<div className={styles.formActions}>
				<button type="submit" className="btn btn--primary" disabled={name.trim() === "" || saving}>
					{saving ? "Saving…" : template ? "Save changes" : "Create template"}
				</button>
				<button type="button" className="btn" onClick={onCancel} disabled={saving}>
					Cancel
				</button>
			</div>
		</form>
	);
}
