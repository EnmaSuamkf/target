import { useState } from "react";
import type { Tcp, TcpSelection } from "../api/types.ts";
import {
	describeTcpSelection,
	isTcpFullySelected,
	isTcpPartiallySelected,
	toggleTcpAll,
} from "../tcpSelection.ts";
import styles from "./DetailPanels.module.css";
import { TcpToolPickerModal } from "./TcpToolPickerModal.tsx";

function selectionLabel(summary: ReturnType<typeof describeTcpSelection>): string | null {
	if (!summary.attached) return null;
	if (summary.allTools) return "All tools";
	return `${summary.count} selected`;
}

/** Compact TCP picker: one row per pack, with a modal for individual tools. */
export function TcpSelectionEditor({
	tcps,
	selections,
	disabled,
	onChange,
}: {
	tcps: Tcp[];
	selections: TcpSelection[];
	disabled?: boolean;
	onChange: (next: TcpSelection[]) => void;
}): React.JSX.Element {
	const [pickerTcpId, setPickerTcpId] = useState<string | null>(null);
	const pickerTcp = pickerTcpId ? tcps.find((tcp) => tcp.id === pickerTcpId) : undefined;

	if (tcps.length === 0) {
		return <p className="hint">No TCP defined yet — create one in the TCP tab.</p>;
	}

	return (
		<>
			<ul className={styles.tcpList}>
				{tcps.map((tcp) => {
					const fullySelected = isTcpFullySelected(selections, tcp.id);
					const partiallySelected = isTcpPartiallySelected(selections, tcp.id);
					const summary = describeTcpSelection(selections, tcp.id, tcp.tools.length);
					const label = selectionLabel(summary);

					return (
						<li key={tcp.id} className={styles.tcpRow}>
							<label className={styles.tcpMain}>
								<input
									type="checkbox"
									checked={fullySelected}
									ref={(el) => {
										if (el) el.indeterminate = partiallySelected;
									}}
									disabled={disabled}
									onChange={() => onChange(toggleTcpAll(selections, tcp.id))}
								/>
								<span className={styles.tcpName}>{tcp.name}</span>
								<span className="hint">
									({tcp.tools.length} tool{tcp.tools.length === 1 ? "" : "s"})
								</span>
							</label>
							<div className={styles.tcpActions}>
								{label ? <span className={`badge ${summary.allTools ? "badge--completed" : "badge--pending"}`}>{label}</span> : null}
								{tcp.tools.length > 0 ? (
									<button
										type="button"
										className="btn btn--sm btn--ghost"
										disabled={disabled}
										onClick={() => setPickerTcpId(tcp.id)}
									>
										Choose tools…
									</button>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>

			{pickerTcp ? (
				<TcpToolPickerModal
					tcp={pickerTcp}
					selections={selections}
					{...(disabled !== undefined ? { disabled } : {})}
					onChange={onChange}
					onClose={() => setPickerTcpId(null)}
				/>
			) : null}
		</>
	);
}
