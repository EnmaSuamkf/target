# Feature: Image attachments on a workflow's text inputs

The three text inputs a workflow is written in can each carry images:

| Where | Field | `field` value |
| --- | --- | --- |
| Workflow detail | Conversation context | `context` |
| Step editor / add-step forms | Task description | `description` |
| Step editor / add-step forms | Acceptance criteria | `acceptance` |

## Why

Plenty of instructions are only expressible as a picture — a mockup, a
screenshot of a broken panel, a spec diagram. Before this, the operator had to
describe the image in prose and hope, or drop the file somewhere and paste a
path by hand. Now the image is attached to the field it belongs to, and the
agent running the step is told to read it.

## How the agent sees them

This is the whole point, so it is worth being precise: the bytes are stored as
ordinary **files on disk**, and it is their **absolute path** that gets composed
into the step's prompt. Claude Code's `Read` tool renders an image, so a path is
all the agent needs — no data URLs, no BLOBs, no HTTP link it has no credentials
for.

`attachmentSection` (`hub/attachments.ts`) renders one labelled block per field,
which `composeStepInput` (`hub/runner.ts`) splices in next to the text it belongs
to:

```
Lee la imagen adjunta a esta descripcion y describe que muestra.

Attached image — attached to this step's task description. Read it with the Read
tool; it is part of the instructions, not an optional extra:
- /home/you/.target/attachments/<workflow-id>/<attachment-id>-wireframe.png (wireframe.png, image/png)
```

- The **conversation context**'s images ride its once-only injection: they appear
  in the preamble of the first dispatch of a fresh conversation, alongside the
  context text. A context that is *only* images still produces a preamble.
- The **task description**'s images sit directly after the description, so "do
  what this shows" reads as one instruction.
- The **acceptance criteria**'s images appear after the criterion — and also in
  the **judge** prompt, since a judge grading "matches the mockup" cannot do it
  without the mockup.

A step with nothing attached composes byte-for-byte the prompt it did before this
feature existed.

## Storage

`~/.target/attachments/<workflow_id>/<attachment_id>-<filename>` — inside the
hub's existing state directory (`targetDir()`, overridable with `TARGET_HOME`),
which already holds `target.db`, the progress markdown files and the default
sandboxes. The directory is keyed by **workflow**, not by step or field, so a
path stays valid for the workflow's lifetime: reordering steps, editing text or
re-saving a field never moves a file the agent may already have been told about.

Metadata lives in the `attachments` table (`hub/db.ts`), following the same
`CREATE TABLE IF NOT EXISTS` + additive-column style as the rest of the schema.
`step_id` is NULL for a context attachment; `field` says which input it hangs
off.

Deleting a step removes its images (the workflow's context images stay);
deleting a workflow removes its whole attachment directory.

## API

| Route | Notes |
| --- | --- |
| `POST /api/workflows/:id/attachments` | Admin. `{field, stepId?, filename, mime, data}` where `data` is base64 (a full `data:image/png;base64,…` URL is also accepted). Its own body limit, since base64 inflates by 4/3 and `maxInputBytes` (64 KiB) is smaller than any real screenshot. |
| `GET /api/workflows/:id/attachments` | Every attachment of the workflow at once. |
| `GET /api/attachments/:id/content` | The bytes. **Not** admin-gated — an `<img>` tag cannot send an `Authorization` header, so gating it would mean no thumbnails. Only files the operator uploaded, only by opaque uuid. |
| `DELETE /api/attachments/:id` | Admin. Removes the row and the file. |

Attachments are also folded into the existing reads: `publicWorkflow` gains the
context ones, `publicStep` gains that step's two fields' (discriminated by
`field`).

Accepted types are PNG, JPEG, GIF and WebP, capped at 5 MiB per file. SVG is
deliberately excluded — it is a script container, not a raster image.

Attaching to a conversation context that has already been injected is refused
(400 `context already injected`), the same freeze that applies to editing the
context text: the agent is already running under that preamble, so a new image
would never reach it.

## UI

`ImageAttachments` (`hub/ui/src/components/ImageAttachments.tsx`) is the strip of
thumbnails with a remove button and an "Attach file" picker. It is wired in
through `ExpandableTextarea`'s optional `attachments` prop, so all three fields
get it uniformly — and **paste** (Ctrl+V) and **drag & drop** are handled on the
textarea itself, which is what makes pasting into the acceptance criteria land on
the acceptance criteria rather than on whichever field was focused last. A plain
text paste is untouched: `preventDefault` is only called when the clipboard
actually carries image files.

Each thumbnail shows the absolute path the agent is given, because that is the
string an operator debugging "did it see my screenshot?" needs to compare.

The two **add-step** forms have no step to attach to yet, so their files are
staged locally (`useStagedImages`, previewed from an object URL, shown as
"attaches when you save") and uploaded straight after the create returns an id.
Everywhere else the step already exists and an image uploads the moment it is
picked.
