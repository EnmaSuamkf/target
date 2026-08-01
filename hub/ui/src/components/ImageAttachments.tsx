import { useRef, useState } from "react";
import { ATTACHMENT_MIMES, MAX_ATTACHMENT_BYTES } from "../api/types.ts";
import styles from "./ImageAttachments.module.css";

/**
 * One thumbnail in the strip. Deliberately looser than the API's `Attachment`:
 * the add-step forms show images the operator picked BEFORE the step exists (so
 * there is nothing to upload to yet), which are held locally and rendered from
 * an object URL. Those have no server `path`, which is exactly why `path` is
 * optional — the strip is the same either way.
 */
export interface AttachmentThumb {
	id: string;
	filename: string;
	/** Where to render the image from: the hub's content route, or a local object URL. */
	url: string;
	/** Absolute path on the hub's machine; absent for a not-yet-uploaded file. */
	path?: string | null;
}

/** True for a file the hub would accept — same allowlist and ceiling as the server. */
export function isAllowedImage(file: File): boolean {
	return (ATTACHMENT_MIMES as readonly string[]).includes(file.type) && file.size > 0 && file.size <= MAX_ATTACHMENT_BYTES;
}

/**
 * Pulls the image files out of a paste or drop.
 *
 * `DataTransfer.files` covers a drop and a copied file; a screenshot pasted from
 * the clipboard arrives only in `items` as a `file` kind with an empty name,
 * which is why both are walked and deduplicated by identity. Non-images (the
 * text/html flavour a paste also carries) are dropped silently — a paste of text
 * into a textarea must keep working as a text paste.
 */
export function imageFilesFrom(data: DataTransfer | null): File[] {
	if (!data) return [];
	const found: File[] = [];
	for (const item of Array.from(data.items ?? [])) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file && file.type.startsWith("image/")) found.push(file);
	}
	for (const file of Array.from(data.files ?? [])) {
		if (file.type.startsWith("image/") && !found.some((f) => f === file || (f.name === file.name && f.size === file.size))) {
			found.push(file);
		}
	}
	return found;
}

/** Human-readable rejection reason, or null when the file is fine. */
export function rejectionReason(file: File): string | null {
	if (!(ATTACHMENT_MIMES as readonly string[]).includes(file.type)) {
		return `${file.name || "image"}: unsupported type (PNG, JPEG, GIF or WebP only)`;
	}
	if (file.size === 0) return `${file.name || "image"}: empty file`;
	if (file.size > MAX_ATTACHMENT_BYTES) {
		return `${file.name || "image"}: too large (max ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB)`;
	}
	return null;
}

/**
 * The strip of attached images under a text input: a thumbnail per image with a
 * remove button, plus an "Attach file" button that opens the file picker.
 *
 * Paste and drag&drop are NOT handled here — they belong to the textarea the
 * images are attached to (see `ExpandableTextarea`), which forwards the files to
 * this component's `onAdd`. Keeping the gestures on the textarea is what makes
 * "Ctrl+V into the acceptance criteria" land on the acceptance criteria rather
 * than on whichever field was last focused.
 *
 * The absolute path is shown under each thumbnail because it is the thing the
 * agent is actually told to read — an operator debugging "did it see my
 * screenshot?" needs to see the same string that went into the prompt.
 */
export function ImageAttachments({
	items,
	onAdd,
	onRemove,
	disabled = false,
	busy = false,
	label,
	idPrefix,
}: {
	items: AttachmentThumb[];
	onAdd: (files: File[]) => void | Promise<void>;
	onRemove: (id: string) => void | Promise<void>;
	/** Read-only owner (e.g. an already-injected conversation context): no add, no remove. */
	disabled?: boolean;
	/** An upload is in flight — the button says so and can't be pressed twice. */
	busy?: boolean;
	/** What these images belong to, for the accessible names ("conversation context"). */
	label: string;
	/** Namespaces the file input's id so several strips can coexist on one page. */
	idPrefix: string;
}): React.JSX.Element | null {
	const inputRef = useRef<HTMLInputElement>(null);
	const [rejected, setRejected] = useState<string[]>([]);

	// Nothing attached and nothing addable: render nothing rather than an empty
	// affordance on a locked field.
	if (disabled && items.length === 0) return null;

	const add = (files: File[]): void => {
		const bad = files.map(rejectionReason).filter((r): r is string => r !== null);
		setRejected(bad);
		const good = files.filter((f) => rejectionReason(f) === null);
		if (good.length > 0) void onAdd(good);
	};

	return (
		<div className={styles.wrap}>
			{items.length > 0 && (
				<ul className={styles.list}>
					{items.map((item) => (
						<li key={item.id} className={styles.item}>
							{/* The thumbnail links to the full image, so a detail too small to
							    judge at 64px is one click away. */}
							<a className={styles.thumbLink} href={item.url} target="_blank" rel="noreferrer">
								<img className={styles.thumb} src={item.url} alt={item.filename} />
							</a>
							<div className={styles.meta}>
								<span className={styles.name} title={item.filename}>
									{item.filename}
								</span>
								{item.path ? (
									<code className={styles.path} title={item.path}>
										{item.path}
									</code>
								) : (
									<span className={styles.pending}>attaches when you save</span>
								)}
							</div>
							{!disabled && (
								<button
									type="button"
									className={`${styles.remove} tap-target`}
									title={`Remove ${item.filename}`}
									aria-label={`Remove ${item.filename} from ${label}`}
									onClick={() => void onRemove(item.id)}
								>
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
										<path d="M18 6L6 18M6 6l12 12" />
									</svg>
								</button>
							)}
						</li>
					))}
				</ul>
			)}

			{!disabled && (
				<div className={styles.actions}>
					<input
						ref={inputRef}
						id={`${idPrefix}-image-input`}
						className={styles.fileInput}
						type="file"
						accept={ATTACHMENT_MIMES.join(",")}
						multiple
						onChange={(ev) => {
							add(Array.from(ev.target.files ?? []));
							// Reset, so picking the same file twice in a row still fires change.
							ev.target.value = "";
						}}
					/>
					<button
						type="button"
						className={`${styles.attach} btn btn--sm`}
						disabled={busy}
						onClick={() => inputRef.current?.click()}
						aria-label={`Attach a file to ${label}`}
					>
						{/* A paperclip, not a picture frame: the button is named for files, and
						    the paperclip is the one attachment glyph that stays true whatever
						    the picker ends up accepting. */}
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
						</svg>
						{busy ? "Attaching…" : items.length > 0 ? "Add another file" : "Attach file"}
					</button>
					<span className="hint">or paste (Ctrl+V) / drop it on the field — the agent reads it from disk.</span>
				</div>
			)}

			{rejected.length > 0 && (
				<ul className={styles.errors}>
					{rejected.map((message) => (
						<li key={message}>{message}</li>
					))}
				</ul>
			)}
		</div>
	);
}
