import { useEffect, useMemo, useRef, useState } from "react";
import type { Resource, ResourceKind, ResourceSet, ResourceSetInput } from "../api/types.ts";
import { DirectoryBrowser } from "../components/DirectoryBrowser.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Field } from "../components/Field.tsx";
import { useIsMobile } from "../hooks/useIsMobile.ts";
import { defaultEntryFile, isMarkdownFile, KIND_LABELS, RESOURCE_KINDS } from "../rciKinds.ts";
import { relativeTime } from "../lib/format.ts";
import styles from "./TemplatesView.module.css";

const emptyResource = (): Resource => ({ name: "", description: "", kind: "skill", entryFile: "SKILL.md", content: "", files: [] });

/** "2 skills · 1 agent" — what a set holds, at a glance, in the list. */
function kindSummary(resources: Resource[]): string {
	const counts = RESOURCE_KINDS.map((kind) => [kind, resources.filter((r) => r.kind === kind).length] as const).filter(
		([, count]) => count > 0,
	);
	if (counts.length === 0) return "empty";
	return counts.map(([kind, count]) => `${count} ${KIND_LABELS[kind].toLowerCase()}${count === 1 ? "" : "s"}`).join(" · ");
}

/**
 * The RCI tab: Resource Sets, the resources-shaped sibling of the TCP tab.
 *
 * A set is made here or not at all — created and deleted, never imported or
 * exported as a bundle. Import is a thing you do *to* a set: inside the editor,
 * pointing at a folder, a skill/agent folder, or a single `.md` on the hub's
 * machine. That asymmetry with TCP is deliberate. A TCP pack is a handful of
 * URLs worth mailing around; a Resource Set is a copy of files that already
 * exist on disk, so the folder is the source of truth and a bundle format would
 * only be a second, staler one.
 */
export function ResourceSetsView({
	resourceSets,
	busy,
	onCreate,
	onUpdate,
	onDelete,
	onBeforeRemoveResource,
	onScan,
}: {
	resourceSets: ResourceSet[];
	busy: boolean;
	onCreate: (input: ResourceSetInput) => Promise<void>;
	onUpdate: (id: string, input: ResourceSetInput, beforeResources: Resource[]) => Promise<boolean>;
	onDelete: (id: string) => void;
	onBeforeRemoveResource?: (resourceSetId: string, resourceName: string) => Promise<boolean>;
	/** Reads a path on the hub's machine; returns null when the read failed. */
	onScan: (path: string) => Promise<{ suggestedName: string; resources: Resource[] } | null>;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const isMobile = useIsMobile();

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return resourceSets
			.filter((s) => (q === "" ? true : s.name.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q))))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [resourceSets, query]);

	const editing = editingId ? (resourceSets.find((s) => s.id === editingId) ?? null) : null;
	const showForm = creating || editing !== null;
	const closeForm = (): void => {
		setCreating(false);
		setEditingId(null);
	};

	useEffect(() => {
		if (editingId && !resourceSets.some((s) => s.id === editingId)) setEditingId(null);
	}, [resourceSets, editingId]);

	return (
		<div className={styles.layout}>
			{(!isMobile || !showForm) && (
				<aside className={styles.listPanel} aria-label="RCI">
					<div className={styles.head}>
						<div className={styles.headRow}>
							<h2 className={styles.heading}>
								RCI
								{resourceSets.length > 0 && <span className={styles.count}>{resourceSets.length}</span>}
							</h2>
							<button
								type="button"
								className="btn btn--primary btn--sm"
								onClick={() => {
									setEditingId(null);
									setCreating(true);
								}}
							>
								New
							</button>
						</div>
						<input
							type="search"
							className="input"
							placeholder="Search Resource Sets…"
							value={query}
							onChange={(ev) => setQuery(ev.target.value)}
						/>
					</div>
					<div className={styles.list}>
						{visible.length === 0 ? (
							<EmptyState
								title="No Resource Set yet"
								description="Create one, then import resources into it from disk to inject them into workflows."
							/>
						) : (
							visible.map((set) => (
								<button
									key={set.id}
									type="button"
									className={`${styles.card} ${set.id === editingId ? styles.cardSelected : ""}`}
									onClick={() => {
										setCreating(false);
										setEditingId(set.id);
									}}
								>
									<span className={styles.cardName}>{set.name}</span>
									<span className={styles.cardMeta}>
										{kindSummary(set.resources)} · {relativeTime(set.updatedAt)}
									</span>
								</button>
							))
						)}
					</div>
				</aside>
			)}
			{showForm ? (
				<section className={styles.formPanel}>
					<ResourceSetForm
						key={editing?.id ?? "new"}
						resourceSet={editing}
						busy={busy}
						onCancel={closeForm}
						onScan={onScan}
						{...(isMobile ? { onBack: closeForm } : {})}
						{...(editing ? { onDelete: () => onDelete(editing.id) } : {})}
						{...(editing && onBeforeRemoveResource
							? { onBeforeRemoveResource: (resourceName: string) => onBeforeRemoveResource(editing.id, resourceName) }
							: {})}
						onSubmit={async (input, beforeResources) => {
							if (editing) {
								const saved = await onUpdate(editing.id, input, beforeResources);
								if (!saved) return;
							} else {
								await onCreate(input);
							}
							closeForm();
						}}
					/>
				</section>
			) : (
				!isMobile && (
					<section className={styles.formPanel}>
						<EmptyState title="No Resource Set selected" description="Pick one to edit, or create a new set." />
					</section>
				)
			)}

		</div>
	);
}

function ResourceSetForm({
	resourceSet,
	busy,
	onSubmit,
	onCancel,
	onBack,
	onDelete,
	onScan,
	onBeforeRemoveResource,
}: {
	resourceSet: ResourceSet | null;
	busy: boolean;
	onSubmit: (input: ResourceSetInput, beforeResources: Resource[]) => Promise<void>;
	onCancel: () => void;
	onBack?: () => void;
	onDelete?: () => void;
	onScan: (path: string) => Promise<{ suggestedName: string; resources: Resource[] } | null>;
	onBeforeRemoveResource?: (resourceName: string) => Promise<boolean>;
}): React.JSX.Element {
	const initialResources = resourceSet?.resources.length ? resourceSet.resources : [emptyResource()];
	const baselineRef = useRef<Resource[]>(initialResources);
	const [name, setName] = useState(resourceSet?.name ?? "");
	const [tags, setTags] = useState(resourceSet?.tags.join(", ") ?? "");
	const [resources, setResources] = useState<Resource[]>(initialResources);
	const [saving, setSaving] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [importing, setImporting] = useState(false);
	// Where the picker reopens. Resources for one set usually live under one tree,
	// so sending the operator back to $HOME for every resource after the first
	// would mean re-walking the same six directories.
	const [browsePath, setBrowsePath] = useState("");

	const updateResource = (index: number, patch: Partial<Resource>): void => {
		setResources((current) => current.map((resource, i) => (i === index ? { ...resource, ...patch } : resource)));
	};

	const addResource = (): void => setResources((current) => [...current, emptyResource()]);

	/**
	 * Folds what was read off disk into the set being edited. A resource already
	 * here by that name is replaced rather than duplicated — re-importing after
	 * editing the folder is the obvious way to refresh a resource, and it should
	 * behave like a refresh. The blank row a new set starts with is dropped, so
	 * importing into an empty set doesn't leave an empty resource behind.
	 */
	const importFrom = async (path: string): Promise<void> => {
		if (importing) return;
		setImporting(true);
		try {
			const found = await onScan(path);
			if (!found) return;
			setBrowsing(false);
			if (name.trim() === "") setName(found.suggestedName);
			setResources((current) => {
				const kept = current.filter((resource) => resource.name.trim() !== "" || resource.content.trim() !== "");
				const merged = [...kept];
				for (const resource of found.resources) {
					const at = merged.findIndex((s) => s.name.trim() === resource.name.trim());
					if (at >= 0) merged[at] = resource;
					else merged.push(resource);
				}
				return merged.length > 0 ? merged : [emptyResource()];
			});
		} finally {
			setImporting(false);
		}
	};

	const removeResource = async (index: number): Promise<void> => {
		const resourceName = resources[index]?.name.trim() ?? "";
		if (onBeforeRemoveResource && resourceName !== "") {
			const allowed = await onBeforeRemoveResource(resourceName);
			if (!allowed) return;
		}
		setResources((current) => current.filter((_, i) => i !== index));
	};

	const removeFile = (resourceIndex: number, filePath: string): void => {
		setResources((current) =>
			current.map((resource, i) => (i === resourceIndex ? { ...resource, files: resource.files.filter((f) => f.path !== filePath) } : resource)),
		);
	};

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		const trimmedName = name.trim();
		if (!trimmedName || saving) return;
		setSaving(true);
		try {
			await onSubmit(
				{
					name: trimmedName,
					tags: tags
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean),
					resources: resources
						.map((resource) => ({ ...resource, name: resource.name.trim(), description: resource.description.trim() }))
						.filter((resource) => resource.name !== "" && resource.content.trim() !== ""),
				},
				baselineRef.current,
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<form className={styles.form} onSubmit={submit}>
			{onBack && (
				<button type="button" className={styles.back} onClick={onBack}>
					RCI
				</button>
			)}
			<div className={styles.formHead}>
				<h2 className={styles.heading}>{resourceSet ? "Edit Resource Set" : "New Resource Set"}</h2>
				<div className={styles.formHeadActions}>
					{onDelete && (
						<button type="button" className="btn btn--sm btn--danger" onClick={onDelete} disabled={busy || saving}>
							Delete
						</button>
					)}
				</div>
			</div>
			<Field label="Name" required>
				{(props) => (
					<input {...props} type="text" className="input" value={name} onChange={(ev) => setName(ev.target.value)} required />
				)}
			</Field>
			<Field label="Tags">
				{(props) => (
					<input
						{...props}
						type="text"
						className="input"
						value={tags}
						onChange={(ev) => setTags(ev.target.value)}
						placeholder="product, research"
					/>
				)}
			</Field>
			<div className={styles.stepsHead}>
				<h3 className={styles.stepsTitle}>Resources</h3>
				<button
					type="button"
					className="btn btn--sm"
					onClick={() => setBrowsing((open) => !open)}
					disabled={busy || saving || importing}
					aria-expanded={browsing}
				>
					{importing ? "Importing…" : "Import"}
				</button>
				<button type="button" className="btn btn--sm" onClick={addResource} disabled={importing}>
					Add resource
				</button>
			</div>
			{browsing && (
				<>
					<p className="hint">
						Pick a folder, a skill or agent folder, or any single .md file on the machine running the hub — skills,
						subagent definitions and reference documents all import. A folder with a SKILL.md or AGENT.md comes in
						whole: everything beside it — references, evals, scripts — travels with it.
					</p>
					<DirectoryBrowser
						initialPath={browsePath}
						selectLabel="Import this folder"
						fileFilter={isMarkdownFile}
						onSelect={(path) => {
							setBrowsePath(path);
							void importFrom(path);
						}}
						onSelectFile={(path) => {
							setBrowsePath(path.replace(/\/[^/]*$/, ""));
							void importFrom(path);
						}}
						onClose={() => setBrowsing(false)}
					/>
				</>
			)}
			{resources.map((resource, index) => (
				<div key={index} className={styles.stepCard}>
					<Field label="Resource name">
						{(props) => (
							<input
								{...props}
								type="text"
								className="input"
								value={resource.name}
								onChange={(ev) => updateResource(index, { name: ev.target.value })}
								placeholder="brainstorming"
							/>
						)}
					</Field>
					<Field label="Description">
						{(props) => (
							<input
								{...props}
								type="text"
								className="input"
								value={resource.description}
								onChange={(ev) => updateResource(index, { description: ev.target.value })}
								placeholder="When to reach for this resource"
							/>
						)}
					</Field>
					<Field label="Kind" hint="How the resource is introduced to the agent when it is injected.">
						{(props) => (
							<select
								{...props}
								className="input"
								value={resource.kind}
								onChange={(ev) => {
									const kind = ev.target.value as ResourceKind;
									// A file name the operator never touched follows the kind; one
									// they typed (or that came from an import) is left alone.
									const patch: Partial<Resource> = { kind };
									const untouched =
										resource.entryFile.trim() === "" ||
										resource.entryFile === defaultEntryFile(resource.kind, resource.name);
									if (untouched) patch.entryFile = defaultEntryFile(kind, resource.name);
									updateResource(index, patch);
								}}
							>
								{RESOURCE_KINDS.map((kind) => (
									<option key={kind} value={kind}>
										{KIND_LABELS[kind]}
									</option>
								))}
							</select>
						)}
					</Field>
					<Field label="File name" hint="What the body is written as on disk: SKILL.md, code-reviewer.md, …">
						{(props) => (
							<input
								{...props}
								type="text"
								className="input"
								value={resource.entryFile}
								onChange={(ev) => updateResource(index, { entryFile: ev.target.value })}
								placeholder="SKILL.md"
							/>
						)}
					</Field>
					<Field label="Markdown" hint="Injected verbatim into the conversation. Frontmatter included.">
						{(props) => (
							<textarea
								{...props}
								className="input"
								rows={10}
								value={resource.content}
								onChange={(ev) => updateResource(index, { content: ev.target.value })}
								placeholder={"---\nname: brainstorming\ndescription: …\n---\n\n# Brainstorming\n…"}
							/>
						)}
					</Field>
					{resource.files.length > 0 && (
						<Field
							label={`Bundled files (${resource.files.length})`}
							hint="Written to disk beside the resource when a workflow injects it; the agent reads them on demand."
						>
							{() => (
								<ul className="hint">
									{resource.files.map((file) => (
										<li key={file.path}>
											{file.path}{" "}
											<button
												type="button"
												className="btn btn--sm btn--ghost"
												onClick={() => removeFile(index, file.path)}
											>
												Remove
											</button>
										</li>
									))}
								</ul>
							)}
						</Field>
					)}
					{resources.length > 1 && (
						<button type="button" className="btn btn--sm btn--danger" onClick={() => void removeResource(index)}>
							Remove resource
						</button>
					)}
				</div>
			))}
			<div className={styles.formActions}>
				<button type="button" className="btn" onClick={onCancel} disabled={saving}>
					Cancel
				</button>
				<button type="submit" className="btn btn--primary" disabled={saving || busy}>
					{saving ? "Saving…" : "Save"}
				</button>
			</div>
		</form>
	);
}
