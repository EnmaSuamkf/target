import { useState } from "react";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import styles from "./DockerMountEditor.module.css";

export function DockerMountEditor({
	mounts,
	onChange,
	disabled = false,
	addLabel = "Add path…",
}: {
	mounts: string[];
	onChange: (mounts: string[]) => void;
	disabled?: boolean;
	addLabel?: string;
}): React.JSX.Element {
	const [browsing, setBrowsing] = useState(false);

	return (
		<div className={styles.root}>
			{mounts.length === 0 ? (
				<p className="hint">No extra paths yet.</p>
			) : (
				<ul className={styles.list}>
					{mounts.map((mount) => (
						<li key={mount} className={styles.item}>
							<code className={styles.path}>{mount}</code>
							<button
								type="button"
								className="btn btn--sm btn--ghost"
								disabled={disabled}
								onClick={() => onChange(mounts.filter((entry) => entry !== mount))}
							>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}
			<button
				type="button"
				className={`btn btn--sm ${styles.addPath}`}
				disabled={disabled}
				onClick={() => setBrowsing(true)}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
					<path d="M12 5v14M5 12h14" />
				</svg>
				{addLabel}
			</button>
			{browsing && (
				<DirectoryBrowser
					initialPath=""
					selectLabel="Bind this directory"
					onSelect={(path) => {
						if (!mounts.includes(path)) onChange([...mounts, path]);
						setBrowsing(false);
					}}
					onClose={() => setBrowsing(false)}
				/>
			)}
		</div>
	);
}
