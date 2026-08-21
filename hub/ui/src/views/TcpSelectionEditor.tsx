import type { Tcp, TcpSelection } from "../api/types.ts";
import {
	isTcpFullySelected,
	isTcpPartiallySelected,
	isToolSelected,
	toggleTcpAll,
	toggleTcpTool,
} from "../tcpSelection.ts";
import styles from "./DetailPanels.module.css";

/** Checkbox tree for selecting whole TCP packs or individual tools. */
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
	if (tcps.length === 0) {
		return <p className="hint">No TCP defined yet — create one in the TCP tab.</p>;
	}

	return (
		<ul className={styles.checkList}>
			{tcps.map((tcp) => {
				const toolNames = tcp.tools.map((tool) => tool.name);
				const fullySelected = isTcpFullySelected(selections, tcp.id);
				const partiallySelected = isTcpPartiallySelected(selections, tcp.id);
				return (
					<li key={tcp.id}>
						<label className={styles.checkRow}>
							<input
								type="checkbox"
								checked={fullySelected}
								ref={(el) => {
									if (el) el.indeterminate = partiallySelected;
								}}
								disabled={disabled}
								onChange={() => onChange(toggleTcpAll(selections, tcp.id))}
							/>
							<span>{tcp.name}</span>
							<span className="hint">({tcp.tools.length} tool{tcp.tools.length === 1 ? "" : "s"})</span>
						</label>
						{tcp.tools.length > 0 && (
							<ul className={`${styles.checkList} ${styles.checkNested}`}>
								{tcp.tools.map((tool) => (
									<li key={tool.name}>
										<label className={styles.checkRow}>
											<input
												type="checkbox"
												checked={isToolSelected(selections, tcp.id, tool.name)}
												disabled={disabled}
												onChange={() => onChange(toggleTcpTool(selections, tcp.id, tool.name, toolNames))}
											/>
											<span>{tool.name}</span>
											{tool.description ? <span className="hint">— {tool.description}</span> : null}
										</label>
									</li>
								))}
							</ul>
						)}
					</li>
				);
			})}
		</ul>
	);
}
