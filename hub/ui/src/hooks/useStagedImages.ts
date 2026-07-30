import { useCallback, useEffect, useRef, useState } from "react";
import type { StagedStepImages } from "../api/types.ts";
import type { TextareaAttachments } from "../components/ExpandableTextarea.tsx";

/**
 * Holds the images picked in an add-step form until the step exists.
 *
 * A step's attachments hang off its id, and the two add-step forms are filled in
 * before any step has been created — so there is nothing to upload to yet. The
 * files are kept here, previewed from `URL.createObjectURL`, and handed to the
 * caller as plain `File`s once the create POST has returned an id (see
 * `handleAddStep` in App.tsx). The strip renders them with no `path`, which is
 * what makes it say "attaches when you save" instead of showing a path that
 * doesn't exist yet.
 *
 * Object URLs are revoked on unmount and on `reset`, so reopening the form a
 * dozen times doesn't leak a blob per preview.
 */
interface StagedFile {
	id: string;
	file: File;
	url: string;
}

type StagedField = keyof StagedStepImages;

/** Ids only need to be unique within a form, but a module counter is simpler than a per-hook one. */
let seq = 0;

export function useStagedImages(idPrefix: string): {
	/** The files themselves, ready to upload after the step is created. */
	staged: StagedStepImages;
	/** Clears both fields and revokes their previews (call when the form reopens). */
	reset: () => void;
	/** The `attachments` prop for one of the two textareas. */
	attachmentsFor: (field: StagedField) => TextareaAttachments;
	/** True while either field holds at least one image. */
	hasAny: boolean;
} {
	const [files, setFiles] = useState<Record<StagedField, StagedFile[]>>({ description: [], acceptance: [] });
	// Every URL ever created by this hook, so unmount can revoke them all without
	// depending on the current state (which the cleanup would capture stale).
	const urls = useRef<string[]>([]);

	useEffect(
		() => () => {
			for (const url of urls.current) URL.revokeObjectURL(url);
			urls.current = [];
		},
		[],
	);

	const reset = useCallback(() => {
		for (const url of urls.current) URL.revokeObjectURL(url);
		urls.current = [];
		setFiles({ description: [], acceptance: [] });
	}, []);

	const attachmentsFor = (field: StagedField): TextareaAttachments => ({
		items: files[field].map((f) => ({
			id: f.id,
			filename: f.file.name || "pasted image",
			url: f.url,
			// No server path yet — that's the point of staging.
			path: null,
		})),
		onAdd: (added: File[]) => {
			// The object URLs are created HERE, not inside the state updater: an
			// updater must be pure, and React may call it more than once.
			const staged = added.map((file) => {
				const url = URL.createObjectURL(file);
				urls.current.push(url);
				seq += 1;
				return { id: `staged-${seq}`, file, url };
			});
			setFiles((current) => ({ ...current, [field]: [...current[field], ...staged] }));
		},
		onRemove: (id: string) => {
			setFiles((current) => ({ ...current, [field]: current[field].filter((f) => f.id !== id) }));
		},
		label: field === "description" ? "the task description" : "the acceptance criteria",
		idPrefix: `${idPrefix}-${field}`,
	});

	return {
		staged: {
			description: files.description.map((f) => f.file),
			acceptance: files.acceptance.map((f) => f.file),
		},
		reset,
		attachmentsFor,
		hasAny: files.description.length > 0 || files.acceptance.length > 0,
	};
}
