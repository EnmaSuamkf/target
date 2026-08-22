import { useMemo, useState } from "react";
import type { ResourceSelection, ResourceSet } from "../api/types.ts";
import { Modal } from "../components/Modal.tsx";
import { KIND_LABELS } from "../rciKinds.ts";
import { attachSetAllResources, detachSet, isResourceSelected, toggleResource } from "../rciSelection.ts";
import styles from "./TcpToolPickerModal.module.css";

/** Searchable dialog for picking individual resources out of one Resource Set. */
export function ResourcePickerModal({
	resourceSet,
	selections,
	disabled,
	onChange,
	onClose,
}: {
	resourceSet: ResourceSet;
	selections: ResourceSelection[];
	disabled?: boolean;
	onChange: (next: ResourceSelection[]) => void;
	onClose: () => void;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const resourceNames = useMemo(() => resourceSet.resources.map((resource) => resource.name), [resourceSet.resources]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return resourceSet.resources;
		// The kind is searchable too: "agent" is the obvious way to ask for every
		// agent definition in a set that mixes them with skills.
		return resourceSet.resources.filter(
			(resource) =>
				resource.name.toLowerCase().includes(q) ||
				(resource.description?.toLowerCase().includes(q) ?? false) ||
				KIND_LABELS[resource.kind].toLowerCase().includes(q),
		);
	}, [query, resourceSet.resources]);

	const selectedInView = filtered.filter((resource) => isResourceSelected(selections, resourceSet.id, resource.name)).length;
	const allInViewSelected = filtered.length > 0 && selectedInView === filtered.length;

	return (
		<Modal
			open
			size="lg"
			title={`Choose resources — ${resourceSet.name}`}
			description="Select which resources from this set are injected into the workflow's conversation. Leave all checked to include the whole set."
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
					placeholder="Search resources…"
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
							for (const resource of filtered) {
								if (!isResourceSelected(next, resourceSet.id, resource.name)) {
									next = toggleResource(next, resourceSet.id, resource.name, resourceNames);
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
							for (const resource of filtered) {
								if (isResourceSelected(next, resourceSet.id, resource.name)) {
									next = toggleResource(next, resourceSet.id, resource.name, resourceNames);
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
				<p className="hint">No resources match your search.</p>
			) : (
				<ul className={styles.toolList}>
					{filtered.map((resource) => (
						<li key={resource.name}>
							<label className={styles.toolRow}>
								<input
									type="checkbox"
									checked={isResourceSelected(selections, resourceSet.id, resource.name)}
									disabled={disabled}
									onChange={() => onChange(toggleResource(selections, resourceSet.id, resource.name, resourceNames))}
								/>
								<span className={styles.toolName}>{resource.name}</span>
								<span className="badge badge--pending">{KIND_LABELS[resource.kind]}</span>
								{resource.description ? <span className={styles.toolDesc}>{resource.description}</span> : null}
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
					onClick={() => onChange(attachSetAllResources(selections, resourceSet.id))}
				>
					Include all {resourceSet.resources.length} resources
				</button>
				<button
					type="button"
					className="btn btn--sm btn--ghost"
					disabled={disabled}
					onClick={() => onChange(detachSet(selections, resourceSet.id))}
				>
					Detach set
				</button>
			</div>
		</Modal>
	);
}
