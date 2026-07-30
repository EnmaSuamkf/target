/**
 * Image attachments for the three text inputs a workflow is written in: the
 * workflow-level **conversation context**, and each step's **task description**
 * and **acceptance criteria**.
 *
 * The point of the feature is that the agent running a step can actually LOOK at
 * the images, and the only thing a Claude Code session can look at is a file it
 * can `Read`. So the bytes are stored as ordinary files on disk and it's their
 * ABSOLUTE PATH that gets composed into the step's prompt (see
 * `attachmentSection` and runner.ts) — not a data URL, not a BLOB, not an
 * HTTP link the agent has no credentials for.
 *
 * Layout: `~/.target/attachments/<workflow_id>/<attachment_id>-<filename>`,
 * i.e. inside the hub's existing state directory (`targetDir()`, overridable
 * with TARGET_HOME), which is already where target.db, every workflow's
 * progress markdown and the default sandboxes live. Keying the directory by
 * workflow id — not by step, not by field — is what keeps a path stable for the
 * lifetime of the workflow: reordering steps, editing text, or re-saving a field
 * never moves a file the agent may already have been told about.
 *
 * Metadata (which workflow/step/field, filename, mime, size, path) lives in the
 * `attachments` table in db.ts.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { targetDir } from "./config.ts";
import type { Attachment, AttachmentField } from "./db.ts";
import {
	deleteAttachment as deleteAttachmentRow,
	deleteStepAttachments,
	deleteWorkflowAttachments,
	getAttachment,
	insertAttachment,
	listFieldAttachments,
	listStepAttachments,
	listWorkflowAttachments,
} from "./db.ts";

/**
 * The image formats accepted, mapped to the extension the stored file gets when
 * the uploaded name doesn't already carry a usable one. Deliberately a small
 * allowlist of raster formats Claude Code's Read tool renders: an SVG is a
 * script container and a PDF isn't an image, so neither belongs here.
 */
export const ALLOWED_IMAGE_MIMES: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

/**
 * Per-file ceiling. Screenshots and photos pasted from a clipboard land well
 * under this; anything bigger is a mistake (a video, a raw capture) that would
 * bloat ~/.target and slow every workflow read, so it's refused with a clear
 * error rather than silently stored.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Thrown for input the caller got wrong (bad mime, empty body, too big, unknown owner). */
export class AttachmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttachmentError";
	}
}

/** Where a workflow's attachment files live. Stable for the workflow's lifetime. */
export function workflowAttachmentDir(workflowId: string): string {
	return path.join(targetDir(), "attachments", workflowId);
}

/**
 * Reduces an uploaded filename to something safe to concatenate into a path:
 * basename only (so "../../etc/passwd" can't escape), a conservative character
 * set, and a length cap. The attachment id is prefixed by the caller, so a
 * name reduced to nothing still produces a unique file.
 */
export function sanitizeFilename(name: string, mime: string): string {
	const base = path.basename(String(name ?? "").trim()).replace(/[^A-Za-z0-9._-]+/g, "_");
	const trimmed = base.replace(/^[._]+/, "").slice(0, 80);
	const fallbackExt = ALLOWED_IMAGE_MIMES[mime] ?? "";
	if (trimmed === "") return `image${fallbackExt}`;
	// Give it the mime's extension when it has none — the agent (and the UI)
	// read the extension as the format hint.
	return path.extname(trimmed) === "" ? `${trimmed}${fallbackExt}` : trimmed;
}

/**
 * Validates and stores one image, returning its metadata row.
 *
 * `stepId` must be null for `field: "context"` (the context belongs to the
 * workflow) and a real step id for the two per-step fields — mixing those up
 * would silently produce an attachment no prompt ever reads, so it's rejected.
 * Ownership itself is checked by the caller (server.ts), which has the workflow
 * and step at hand.
 */
export function saveAttachment(input: {
	workflowId: string;
	stepId: string | null;
	field: AttachmentField;
	filename: string;
	mime: string;
	data: Buffer;
}): Attachment {
	const mime = String(input.mime ?? "").toLowerCase().trim();
	if (!(mime in ALLOWED_IMAGE_MIMES)) {
		throw new AttachmentError(`unsupported image type '${input.mime}' (allowed: ${Object.keys(ALLOWED_IMAGE_MIMES).join(", ")})`);
	}
	if (!input.data || input.data.length === 0) throw new AttachmentError("empty file");
	if (input.data.length > MAX_ATTACHMENT_BYTES) {
		throw new AttachmentError(`file is too large (${input.data.length} bytes, max ${MAX_ATTACHMENT_BYTES})`);
	}
	if (input.field === "context" && input.stepId !== null) {
		throw new AttachmentError("a conversation-context attachment belongs to the workflow, not to a step");
	}
	if (input.field !== "context" && input.stepId === null) {
		throw new AttachmentError(`a '${input.field}' attachment needs a stepId`);
	}
	const id = crypto.randomUUID();
	const filename = sanitizeFilename(input.filename, mime);
	const dir = workflowAttachmentDir(input.workflowId);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${id}-${filename}`);
	fs.writeFileSync(filePath, input.data);
	return insertAttachment({
		id,
		workflowId: input.workflowId,
		stepId: input.stepId,
		field: input.field,
		filename,
		mime,
		size: input.data.length,
		path: filePath,
	});
}

/** Deletes an attachment's row and its file. Returns false when there was no such attachment. */
export function removeAttachment(id: string): boolean {
	const attachment = getAttachment(id);
	if (!attachment) return false;
	// Row first, file second: a row pointing at a missing file would put a dead
	// path into an agent's prompt, while an orphaned file is merely wasted bytes.
	deleteAttachmentRow(id);
	fs.rmSync(attachment.path, { force: true });
	return true;
}

/** Drops every attachment of one step (its files included) — used when the step is deleted. */
export function removeStepAttachments(stepId: string): void {
	for (const attachment of listStepAttachments(stepId)) fs.rmSync(attachment.path, { force: true });
	deleteStepAttachments(stepId);
}

/**
 * Drops every attachment of a workflow, its steps' included, and removes the
 * workflow's attachment directory — used when the workflow is deleted.
 */
export function removeWorkflowAttachments(workflowId: string): void {
	deleteWorkflowAttachments(workflowId);
	fs.rmSync(workflowAttachmentDir(workflowId), { recursive: true, force: true });
}

/** Re-exported so callers don't need both modules for the common read paths. */
export { getAttachment, listFieldAttachments, listStepAttachments, listWorkflowAttachments };

/**
 * Renders the prompt section that makes an attachment readable by the agent.
 *
 * This is the payoff of the whole feature, so it is deliberately explicit: the
 * label says which input the images belong to, and the instruction names the
 * Read tool, because a bare list of paths is something an agent will happily
 * skim past. Every path is absolute (that's what's in the DB), so it resolves
 * regardless of the agent's working directory.
 *
 * Returns "" when there are no attachments, so callers can always concatenate.
 */
export function attachmentSection(label: string, attachments: Attachment[]): string {
	if (attachments.length === 0) return "";
	const lines = attachments.map((a) => `- ${a.path} (${a.filename}, ${a.mime})`);
	const plural = attachments.length === 1 ? "image" : "images";
	// Deliberately mode-neutral wording: this same section is used by the exec
	// prompt and by the judge pass, so it can't say "before doing the work" (the
	// judge's work is already done).
	return `\n\nAttached ${plural} — ${label}. Read ${
		attachments.length === 1 ? "it" : "each of them"
	} with the Read tool; ${
		attachments.length === 1 ? "it is" : "they are"
	} part of the instructions, not an optional extra:\n${lines.join("\n")}`;
}
