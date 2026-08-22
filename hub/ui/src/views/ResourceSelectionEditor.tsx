import { useState } from "react";
import type { ResourceSelection, ResourceSet } from "../api/types.ts";
import { describeResourceSelection, isSetFullySelected, isSetPartiallySelected, toggleSetAll } from "../rciSelection.ts";
import styles from "./DetailPanels.module.css";
import { ResourcePickerModal } from "./ResourcePickerModal.tsx";

function selectionLabel(summary: ReturnType<typeof describeResourceSelection>): string | null {
	if (!summary.attached) return null;
	if (summary.allResources) return "All resources";
	return `${summary.count} selected`;
}

/** Compact RCI picker: one row per Resource Set, with a modal for individual resources. */
export function ResourceSelectionEditor({
	resourceSets,
	selections,
	disabled,
	onChange,
}: {
	resourceSets: ResourceSet[];
	selections: ResourceSelection[];
	disabled?: boolean;
	onChange: (next: ResourceSelection[]) => void;
}): React.JSX.Element {
	const [pickerId, setPickerId] = useState<string | null>(null);
	const picker = pickerId ? resourceSets.find((set) => set.id === pickerId) : undefined;

	if (resourceSets.length === 0) {
		return <p className="hint">No Resource Set defined yet — create one in the RCI tab.</p>;
	}

	return (
		<>
			<ul className={styles.tcpList}>
				{resourceSets.map((set) => {
					const summary = describeResourceSelection(selections, set.id, set.resources.length);
					const label = selectionLabel(summary);

					return (
						<li key={set.id} className={styles.tcpRow}>
							<label className={styles.tcpMain}>
								<input
									type="checkbox"
									checked={isSetFullySelected(selections, set.id)}
									ref={(el) => {
										if (el) el.indeterminate = isSetPartiallySelected(selections, set.id);
									}}
									disabled={disabled}
									onChange={() => onChange(toggleSetAll(selections, set.id))}
								/>
								<span className={styles.tcpName}>{set.name}</span>
								<span className="hint">
									({set.resources.length} resource{set.resources.length === 1 ? "" : "s"})
								</span>
							</label>
							<div className={styles.tcpActions}>
								{label ? (
									<span className={`badge ${summary.allResources ? "badge--completed" : "badge--pending"}`}>{label}</span>
								) : null}
								{set.resources.length > 0 ? (
									<button
										type="button"
										className="btn btn--sm btn--ghost"
										disabled={disabled}
										onClick={() => setPickerId(set.id)}
									>
										Choose resources…
									</button>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>

			{picker ? (
				<ResourcePickerModal
					resourceSet={picker}
					selections={selections}
					{...(disabled !== undefined ? { disabled } : {})}
					onChange={onChange}
					onClose={() => setPickerId(null)}
				/>
			) : null}
		</>
	);
}
