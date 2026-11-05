# Step notes timeline and note source

Each workflow step can carry notes: short sticky notes with a theme colour. The
step's notes are shown as a **timeline**, oldest first, so the history of a step
reads top to bottom. Every note also records **who wrote it**: the operator, in
the UI, or an agent, through the MCP tool `add_step_note`.

Template steps keep the old sticky-note list. Their notes have no timestamps, so
the timeline does not apply to them.

## What the timeline shows

One row per note, in creation order (the server returns notes by `created_at`,
then insertion order, and the UI keeps that order):

| Part | What it shows |
| --- | --- |
| Position | 1, 2, 3, … in creation order |
| Time | The creation time in the browser's local time. The date is included when the note was not created today. |
| Author | **Agent** or **Operator**, from the note's `source` |
| Edited | An **Edited** marker, only when the note changed after it was created (`updatedAt` later than `createdAt`) |
| Text | The full note text, wrapped to the width of the row |
| Theme | A coloured marker: warning (amber), success (green) or neutral (yellow), the same colours as the sticky notes |

The composer and the **Add**, **Edit** and **Delete** controls are unchanged.
They sit with the timeline and act on the same notes.

Layout: the timeline is a single column that wraps within its container. It must
not scroll sideways at phone width.

## The `source` field

A note's `source` is one of two values:

- `operator`: a note written in the UI, or by the hub itself (see below).
- `agent`: a note written by an agent through the MCP tool `add_step_note`.

`source` is stored in the `step_notes` table and returned on every note in the
step payload (`GET /api/workflows/:id`, `steps[].notes[]`) as
`"source": "operator"` or `"source": "agent"`.

### How the MCP tool marks agent notes

`add_step_note` sends `source: "agent"` in every request it makes. The tool's
input schema does not include `source`, so an agent cannot choose it. Its
parameters (`workflowId`, `stepId`, `content`, optional `theme`) and its
response are unchanged. Its description says the note is recorded as an agent
note.

### Automatic notes written by the hub

Some notes are written by the hub, not by a person. The abort outcome is one
(see [abort.md](abort.md)). These are stored with the default `operator` source,
so they show the **Operator** label in the timeline. There is no separate
"system" source.

## Route rule for `source`

`POST /api/workflows/:id/steps/:stepId/notes` accepts an optional `source` in the
JSON body:

- **Missing**: the note is stored as `operator`.
- **`"operator"` or `"agent"`**: the note is stored with that source.
- **Anything else** (including `null`, an empty string, a different case, or a
  non-string): the request is refused with HTTP **400** and the body
  `{"error":"invalid_source"}`. Nothing is stored.

`PATCH /api/workflows/:id/steps/:stepId/notes/:noteId` never changes `source`.
If the body includes `source`, it is ignored. An edit changes the content and the
theme only, so an agent note stays an agent note after an operator edits it.

The URLs, the admin-token requirement and the response shape are unchanged,
except for the added `source` field on each note.

## Events

The report events for notes carry `source` in their `data`:

- `step.note.added`: `data.source` is the source of the new note.
- `step.note.modified`: `data.source` is the note's source, which an edit never
  changes.

The other fields (`note_id`, `step_id`, `theme`, `content` (cut to 2000
characters), `content_len`) are unchanged. `step.note.deleted` is unchanged and
has no `source`.

## Migration of existing notes

The `step_notes` table gains a `source` column:

```sql
ALTER TABLE step_notes ADD COLUMN source TEXT NOT NULL DEFAULT 'operator';
```

The migration runs when the hub opens the database. It checks
`PRAGMA table_info(step_notes)` first, so it is safe to run again. Every note that
existed before the upgrade becomes `operator`. Their creation times and their
order (`created_at`, then rowid) do not change. A new database creates the column
in the table definition, so the migration does nothing there.

## Decision: operators can edit and delete agent notes

Operators **can edit and delete agent notes**, as they could edit and delete any
note before this change. This is the default for this implementation. The
alternative, locking agent notes against operator edits, was not built. If you
want that later, the check belongs in `editStepNote` and `removeStepNote`
(`hub/step-notes.ts`), and the Edit and Delete controls would need to hide for
agent rows.

## Where it lives

- `hub/db.ts`: the `source` column, the migration, `StepNote.source`,
  `normalizeStepNoteSource`, `insertStepNote`.
- `hub/step-notes.ts`: the note service and the `step.note.*` events.
- `hub/server.ts`: the routes (`source` validation on POST, `source` in the step
  payload).
- `mcp/target-mcp.mjs`: `buildStepNoteRequest` and the `add_step_note` tool.
- `hub/ui/src/components/StepTimeline.tsx` and `hub/ui/src/lib/stepTimeline.ts`:
  the timeline and its ordering, edited and author rules.
- `hub/ui/src/components/StepNotes.tsx`: the timeline for workflow notes, and the
  sticky-note list for template notes.
