import { useEffect, useMemo, useRef, useState } from "react";
import type { Tcp, TcpInput, TcpTool, TcpToolInput } from "../api/types.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { Field } from "../components/Field.tsx";
import { useIsMobile } from "../hooks/useIsMobile.ts";
import { relativeTime } from "../lib/format.ts";
import styles from "./TemplatesView.module.css";

const emptyTool = (): TcpTool => ({
	name: "",
	description: "",
	requestTemplate: "",
	inputs: [],
	tokens: {},
});

function tokensToText(tokens: Record<string, string>): string {
	return JSON.stringify(tokens, null, 2);
}

function inputsToText(inputs: TcpToolInput[]): string {
	return JSON.stringify(inputs, null, 2);
}

function initialToolDrafts(toolList: TcpTool[]): { tokensText: string[]; inputsText: string[] } {
	return {
		tokensText: toolList.map((tool) => tokensToText(tool.tokens)),
		inputsText: toolList.map((tool) => inputsToText(tool.inputs)),
	};
}

function parseTokensText(text: string): Record<string, string> {
	const parsed = JSON.parse(text) as unknown;
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Tokens must be a JSON object");
	}
	return parsed as Record<string, string>;
}

function parseInputsText(text: string): TcpToolInput[] {
	const parsed = JSON.parse(text) as unknown;
	if (!Array.isArray(parsed)) throw new Error("Inputs must be a JSON array");
	return parsed as TcpToolInput[];
}

export function TcpsView({
	tcps,
	busy,
	onCreate,
	onUpdate,
	onDelete,
	onBeforeRemoveTool,
	onExport,
	onExportAll,
	onImport,
}: {
	tcps: Tcp[];
	busy: boolean;
	onCreate: (input: TcpInput) => Promise<void>;
	onUpdate: (id: string, input: TcpInput, beforeTools: TcpTool[]) => Promise<boolean>;
	onDelete: (id: string) => void;
	onBeforeRemoveTool?: (tcpId: string, toolName: string) => Promise<boolean>;
	onExport: (id: string) => void;
	onExportAll: () => void;
	onImport: (file: File) => void;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const isMobile = useIsMobile();
	const fileInput = useRef<HTMLInputElement>(null);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return tcps
			.filter((m) => (q === "" ? true : m.name.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q))))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [tcps, query]);

	const editing = editingId ? (tcps.find((m) => m.id === editingId) ?? null) : null;
	const showForm = creating || editing !== null;
	const closeForm = (): void => {
		setCreating(false);
		setEditingId(null);
	};

	useEffect(() => {
		if (editingId && !tcps.some((m) => m.id === editingId)) setEditingId(null);
	}, [tcps, editingId]);

	return (
		<div className={styles.layout}>
			{(!isMobile || !showForm) && (
				<aside className={styles.listPanel} aria-label="TCP">
					<div className={styles.head}>
						<div className={styles.headRow}>
							<h2 className={styles.heading}>
								TCP
								{tcps.length > 0 && <span className={styles.count}>{tcps.length}</span>}
							</h2>
							<button type="button" className="btn btn--primary btn--sm" onClick={() => { setEditingId(null); setCreating(true); }}>
								New
							</button>
						</div>
						<div className={styles.ioRow}>
							<button type="button" className="btn btn--sm" onClick={() => fileInput.current?.click()} disabled={busy}>Import</button>
							<button type="button" className="btn btn--sm" onClick={onExportAll} disabled={busy || tcps.length === 0}>Export all</button>
						</div>
						<input ref={fileInput} type="file" accept="application/json,.json" className={styles.fileInput} onChange={(ev) => { const f = ev.target.files?.[0]; if (f) onImport(f); ev.target.value = ""; }} />
						<input type="search" className="input" placeholder="Search TCP…" value={query} onChange={(ev) => setQuery(ev.target.value)} />
					</div>
					<div className={styles.list}>
						{visible.length === 0 ? (
							<EmptyState title="No TCP yet" description="Create one to define HTTP tools for workflows." />
						) : (
							visible.map((tcp) => (
								<button key={tcp.id} type="button" className={`${styles.card} ${tcp.id === editingId ? styles.cardSelected : ""}`} onClick={() => { setCreating(false); setEditingId(tcp.id); }}>
									<span className={styles.cardName}>{tcp.name}</span>
									<span className={styles.cardMeta}>{tcp.tools.length} tool{tcp.tools.length === 1 ? "" : "s"} · {relativeTime(tcp.updatedAt)}</span>
								</button>
							))
						)}
					</div>
				</aside>
			)}
			{showForm ? (
				<section className={styles.formPanel}>
					<TcpForm
						key={editing?.id ?? "new"}
						tcp={editing}
						busy={busy}
						onCancel={closeForm}
						{...(isMobile ? { onBack: closeForm } : {})}
						{...(editing ? { onDelete: () => onDelete(editing.id), onExport: () => onExport(editing.id) } : {})}
						{...(editing && onBeforeRemoveTool
							? { onBeforeRemoveTool: (toolName: string) => onBeforeRemoveTool(editing.id, toolName) }
							: {})}
						onSubmit={async (input, beforeTools) => {
							if (editing) {
								const saved = await onUpdate(editing.id, input, beforeTools);
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
						<EmptyState title="No TCP selected" description="Pick one to edit, or create a new pack." />
					</section>
				)
			)}
		</div>
	);
}

function TcpForm({
	tcp,
	busy,
	onSubmit,
	onCancel,
	onBack,
	onDelete,
	onExport,
	onBeforeRemoveTool,
}: {
	tcp: Tcp | null;
	busy: boolean;
	onSubmit: (input: TcpInput, beforeTools: TcpTool[]) => Promise<void>;
	onCancel: () => void;
	onBack?: () => void;
	onDelete?: () => void;
	onExport?: () => void;
	onBeforeRemoveTool?: (toolName: string) => Promise<boolean>;
}): React.JSX.Element {
	const initialTools = tcp?.tools.length ? tcp.tools : [emptyTool()];
	const baselineToolsRef = useRef<TcpTool[]>(initialTools);
	const [name, setName] = useState(tcp?.name ?? "");
	const [tags, setTags] = useState(tcp?.tags.join(", ") ?? "");
	const [tools, setTools] = useState<TcpTool[]>(initialTools);
	const [tokensText, setTokensText] = useState(() => initialToolDrafts(initialTools).tokensText);
	const [inputsText, setInputsText] = useState(() => initialToolDrafts(initialTools).inputsText);
	const [jsonError, setJsonError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const updateTool = (index: number, patch: Partial<TcpTool>): void => {
		setTools((current) => current.map((tool, i) => (i === index ? { ...tool, ...patch } : tool)));
	};

	const addTool = (): void => {
		setTools((current) => [...current, emptyTool()]);
		setTokensText((current) => [...current, "{}"]);
		setInputsText((current) => [...current, "[]"]);
	};

	const removeTool = async (index: number): Promise<void> => {
		const toolName = tools[index]?.name.trim() ?? "";
		if (onBeforeRemoveTool && toolName !== "") {
			const allowed = await onBeforeRemoveTool(toolName);
			if (!allowed) return;
		}
		setTools((current) => current.filter((_, i) => i !== index));
		setTokensText((current) => current.filter((_, i) => i !== index));
		setInputsText((current) => current.filter((_, i) => i !== index));
	};

	const syncJsonDraftsToTools = (): TcpTool[] | null => {
		try {
			const next = tools.map((tool, index) => ({
				...tool,
				tokens: parseTokensText(tokensText[index] ?? "{}"),
				inputs: parseInputsText(inputsText[index] ?? "[]"),
			}));
			setTools(next);
			setJsonError(null);
			return next;
		} catch (err) {
			setJsonError(err instanceof Error ? err.message : "Invalid JSON");
			return null;
		}
	};

	const submit = async (ev: React.FormEvent): Promise<void> => {
		ev.preventDefault();
		const trimmedName = name.trim();
		if (!trimmedName || saving) return;
		const syncedTools = syncJsonDraftsToTools();
		if (!syncedTools) return;
		setSaving(true);
		try {
			await onSubmit(
				{
					name: trimmedName,
					tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
					tools: syncedTools
						.map((tool) => ({
							...tool,
							name: tool.name.trim(),
							description: tool.description.trim(),
							requestTemplate: tool.requestTemplate.trim(),
						}))
						.filter((tool) => tool.name !== "" && tool.requestTemplate !== ""),
				},
				baselineToolsRef.current,
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<form className={styles.form} onSubmit={submit}>
			{onBack && <button type="button" className={styles.back} onClick={onBack}>TCP</button>}
			<div className={styles.formHead}>
				<h2 className={styles.heading}>{tcp ? "Edit TCP" : "New TCP"}</h2>
				<div className={styles.formHeadActions}>
					{onExport && <button type="button" className="btn btn--sm" onClick={onExport} disabled={busy || saving}>Export</button>}
					{onDelete && <button type="button" className="btn btn--sm btn--danger" onClick={onDelete} disabled={busy || saving}>Delete</button>}
				</div>
			</div>
			<Field label="Name" required>{(props) => <input {...props} type="text" className="input" value={name} onChange={(ev) => setName(ev.target.value)} required />}</Field>
			<Field label="Tags">{(props) => <input {...props} type="text" className="input" value={tags} onChange={(ev) => setTags(ev.target.value)} placeholder="github, api" />}</Field>
			<div className={styles.stepsHead}>
				<h3 className={styles.stepsTitle}>Tools</h3>
				<button type="button" className="btn btn--sm" onClick={addTool}>Add tool</button>
			</div>
			{jsonError && <p className="hint" role="alert">{jsonError}</p>}
			{tools.map((tool, index) => (
				<div key={index} className={styles.stepCard}>
					<Field label="Tool name">{(props) => <input {...props} type="text" className="input" value={tool.name} onChange={(ev) => updateTool(index, { name: ev.target.value })} placeholder="get_me" />}</Field>
					<Field label="Description">{(props) => <input {...props} type="text" className="input" value={tool.description} onChange={(ev) => updateTool(index, { description: ev.target.value })} />}</Field>
					<Field label="Request template (curl)">{(props) => <textarea {...props} className="input" rows={4} value={tool.requestTemplate} onChange={(ev) => updateTool(index, { requestTemplate: ev.target.value })} placeholder="curl -X GET https://api.github.com/user -H 'Authorization: Bearer $TOKEN_1'" />}</Field>
					<Field label="Tokens (JSON)" hint="Keys like TOKEN_1 map to $TOKEN_1 in the template.">{(props) => (
						<textarea
							{...props}
							className="input"
							rows={3}
							value={tokensText[index] ?? "{}"}
							onChange={(ev) => {
								setJsonError(null);
								setTokensText((current) => current.map((text, i) => (i === index ? ev.target.value : text)));
							}}
							onBlur={() => { void syncJsonDraftsToTools(); }}
						/>
					)}</Field>
					<Field label="Inputs (JSON)" hint='Array of { name, placeholder, description, required }. Leave [] if none.'>{(props) => (
						<textarea
							{...props}
							className="input"
							rows={3}
							value={inputsText[index] ?? "[]"}
							onChange={(ev) => {
								setJsonError(null);
								setInputsText((current) => current.map((text, i) => (i === index ? ev.target.value : text)));
							}}
							onBlur={() => { void syncJsonDraftsToTools(); }}
						/>
					)}</Field>
					{tools.length > 1 && (
						<button type="button" className="btn btn--sm btn--danger" onClick={() => void removeTool(index)}>
							Remove tool
						</button>
					)}
				</div>
			))}
			<div className={styles.formActions}>
				<button type="button" className="btn" onClick={onCancel} disabled={saving}>Cancel</button>
				<button type="submit" className="btn btn--primary" disabled={saving || busy}>{saving ? "Saving…" : "Save"}</button>
			</div>
		</form>
	);
}
