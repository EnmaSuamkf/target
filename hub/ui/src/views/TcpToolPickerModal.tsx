import { useMemo, useState } from "react";
import type { Tcp, TcpSelection } from "../api/types.ts";
import { Modal } from "../components/Modal.tsx";
import {
	attachTcpAllTools,
	detachTcp,
	isToolSelected,
	toggleTcpTool,
} from "../tcpSelection.ts";
import styles from "./TcpToolPickerModal.module.css";

/** Searchable dialog for picking individual tools from one TCP pack. */
export function TcpToolPickerModal({
	tcp,
	selections,
	disabled,
	onChange,
	onClose,
}: {
	tcp: Tcp;
	selections: TcpSelection[];
	disabled?: boolean;
	onChange: (next: TcpSelection[]) => void;
	onClose: () => void;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const toolNames = useMemo(() => tcp.tools.map((tool) => tool.name), [tcp.tools]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return tcp.tools;
		return tcp.tools.filter(
			(tool) =>
				tool.name.toLowerCase().includes(q) ||
				(tool.description?.toLowerCase().includes(q) ?? false),
		);
	}, [query, tcp.tools]);

	const selectedInView = filtered.filter((tool) => isToolSelected(selections, tcp.id, tool.name)).length;
	const allInViewSelected = filtered.length > 0 && selectedInView === filtered.length;

	return (
		<Modal
			open
			size="lg"
			title={`Choose tools — ${tcp.name}`}
			description="Select which tools from this pack are attached to the workflow. Leave all checked to include the whole pack."
			onClose={onClose}
			footer={
				<button type="button" className="btn btn--primary" onClick={onClose}>
					Done
				</button>
			}
		>
			<div className={styles.toolbar}>
				<input
					type="search"
					className={`input ${styles.search}`}
					placeholder="Search tools…"
					value={query}
					onChange={(ev) => setQuery(ev.target.value)}
					autoFocus
				/>
				<div className={styles.bulk}>
					<button
						type="button"
						className="btn btn--sm btn--ghost"
						disabled={disabled || filtered.length === 0 || allInViewSelected}
						onClick={() => {
							let next = selections;
							for (const tool of filtered) {
								if (!isToolSelected(next, tcp.id, tool.name)) {
									next = toggleTcpTool(next, tcp.id, tool.name, toolNames);
								}
							}
							onChange(next);
						}}
					>
						Select {query.trim() ? "shown" : "all"}
					</button>
					<button
						type="button"
						className="btn btn--sm btn--ghost"
						disabled={disabled || selectedInView === 0}
						onClick={() => {
							let next = selections;
							for (const tool of filtered) {
								if (isToolSelected(next, tcp.id, tool.name)) {
									next = toggleTcpTool(next, tcp.id, tool.name, toolNames);
								}
							}
							onChange(next);
						}}
					>
						Clear {query.trim() ? "shown" : "all"}
					</button>
				</div>
			</div>

			{filtered.length === 0 ? (
				<p className="hint">No tools match your search.</p>
			) : (
				<ul className={styles.toolList}>
					{filtered.map((tool) => (
						<li key={tool.name}>
							<label className={styles.toolRow}>
								<input
									type="checkbox"
									checked={isToolSelected(selections, tcp.id, tool.name)}
									disabled={disabled}
									onChange={() => onChange(toggleTcpTool(selections, tcp.id, tool.name, toolNames))}
								/>
								<span className={styles.toolName}>{tool.name}</span>
								{tool.description ? <span className={styles.toolDesc}>{tool.description}</span> : null}
							</label>
						</li>
					))}
				</ul>
			)}

			<div className={styles.shortcuts}>
				<button
					type="button"
					className="btn btn--sm btn--ghost"
					disabled={disabled}
					onClick={() => onChange(attachTcpAllTools(selections, tcp.id))}
				>
					Include all {tcp.tools.length} tools
				</button>
				<button
					type="button"
					className="btn btn--sm btn--ghost"
					disabled={disabled}
					onClick={() => onChange(detachTcp(selections, tcp.id))}
				>
					Detach pack
				</button>
			</div>
		</Modal>
	);
}
