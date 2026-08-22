import { useEffect, useRef, useState } from "react";
import { ApiError, listDirs } from "../api/client.ts";
import type { DirListing } from "../api/types.ts";
import styles from "./DirectoryBrowser.module.css";

/**
 * Click-through filesystem picker, used by the create-workflow form (the
 * workdir) and by RCI's resource import (a resources folder, or one SKILL.md).
 *
 * Rendered inline (not as a nested `Modal`) because the form already sits in
 * one: stacking two modals would double the Escape handlers and fight over
 * the focus trap. The panel lists the server's directories via
 * `GET /api/fs/dirs` — the browser can't see the hub machine's filesystem
 * itself, and the native directory pickers (`<input webkitdirectory>`,
 * `showDirectoryPicker()`) upload/handle *contents* rather than return a
 * path string, so a server-backed listing is the only way to fill a plain
 * `workdir: string`.
 */
export function DirectoryBrowser({
	initialPath,
	onSelect,
	onClose,
	selectLabel = "Select this directory",
	fileFilter,
	onSelectFile,
}: {
	/** Where to start browsing; empty starts at the hub user's home. */
	initialPath: string;
	/** Called with the chosen absolute path. */
	onSelect: (path: string) => void;
	onClose: () => void;
	/** Wording for the "take this directory" button, when "select" is too vague. */
	selectLabel?: string;
	/**
	 * Given a file name, whether it can be picked. Passing this is what turns
	 * files on at all: without it the listing is directories only, which is what
	 * the workdir picker wants.
	 */
	fileFilter?: (name: string) => boolean;
	/** Called with the absolute path of a picked file. Required with `fileFilter`. */
	onSelectFile?: (path: string) => void;
}): React.JSX.Element {
	const withFiles = fileFilter !== undefined;
	const [listing, setListing] = useState<DirListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// Monotonic counter so a slow response for a directory the user already
	// navigated away from can't overwrite the newer listing.
	const requestSeq = useRef(0);

	const load = (path?: string, fallbackToHome = false): void => {
		const seq = ++requestSeq.current;
		setLoading(true);
		listDirs(path, withFiles)
			.then((data) => {
				if (seq !== requestSeq.current) return;
				setListing(data);
				setError(null);
				setLoading(false);
			})
			.catch((err: unknown) => {
				if (seq !== requestSeq.current) return;
				// A half-typed or stale path shouldn't strand the picker with every
				// control disabled — fall back to home on the opening load.
				if (fallbackToHome && path !== undefined) {
					load(undefined);
					return;
				}
				setError(err instanceof ApiError ? err.message : String(err));
				setLoading(false);
			});
	};

	// One initial load per mount; the parent remounts the panel on reopen.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => load(initialPath || undefined, true), []);

	const childPath = (name: string): string => {
		if (!listing) return name;
		const sep = listing.path.endsWith("/") ? "" : "/";
		return `${listing.path}${sep}${name}`;
	};

	const enter = (name: string): void => {
		if (listing) load(childPath(name));
	};

	const files = (listing?.files ?? []).filter((name) => fileFilter?.(name) ?? false);

	return (
		<div className={styles.panel} role="group" aria-label="Browse directories">
			<div className={styles.toolbar}>
				<button
					type="button"
					className="btn btn--sm"
					onClick={() => listing?.parent && load(listing.parent)}
					disabled={!listing?.parent || loading}
					title="Go to parent directory"
				>
					↑ Up
				</button>
				<button
					type="button"
					className="btn btn--sm"
					onClick={() => listing && load(listing.home)}
					disabled={!listing || loading}
					title="Go to home directory"
				>
					Home
				</button>
				<span className={styles.path} title={listing?.path ?? ""}>
					{listing?.path ?? "…"}
				</span>
			</div>

			{error ? (
				<p className="msg msg--error" role="alert">
					{error}
				</p>
			) : (
				<ul className={styles.list} aria-busy={loading}>
					{listing && listing.dirs.length === 0 && files.length === 0 && !loading && (
						<li className={styles.empty}>{withFiles ? "Nothing to import here" : "No subdirectories"}</li>
					)}
					{listing?.dirs.map((name) => (
						<li key={name}>
							<button type="button" className={styles.dir} onClick={() => enter(name)} disabled={loading}>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
								</svg>
								<span className={styles.dirName}>{name}</span>
							</button>
						</li>
					))}
					{files.map((name) => (
						<li key={`file:${name}`}>
							<button
								type="button"
								className={styles.dir}
								onClick={() => onSelectFile?.(childPath(name))}
								disabled={loading}
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
									<polyline points="14 2 14 8 20 8" />
								</svg>
								<span className={styles.dirName}>{name}</span>
							</button>
						</li>
					))}
				</ul>
			)}

			<div className={styles.actions}>
				<button type="button" className="btn btn--sm" onClick={onClose}>
					Cancel
				</button>
				<button
					type="button"
					className="btn btn--sm btn--primary"
					onClick={() => listing && onSelect(listing.path)}
					disabled={!listing || loading}
				>
					{selectLabel}
				</button>
			</div>
		</div>
	);
}
