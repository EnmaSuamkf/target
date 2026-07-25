# Feature: Expandable rich-text inputs

Every multi-line text field in The Target Project web UI (step descriptions,
acceptance criteria, conversation context, template steps) has an **expand**
button in its top-right corner. Clicking it opens a popup with a large
formatting-capable editor; pressing **OK** writes the edited text back into
the original field.

## Why

Workflow inputs are often long — dictated paragraphs, multi-step
instructions, structured acceptance criteria. A small `<textarea>` is a poor
place to work on them: no formatting, little room, no structure. The popup
gives the operator a comfortable surface with bold, italic, headings and
bullet/numbered lists, without changing what the field ultimately holds.

## How it works

- **`ExpandableTextarea`** (`hub/ui/src/components/ExpandableTextarea.tsx`)
  wraps a normal `.textarea` and renders the corner expand button. To the
  surrounding form nothing changes: same `value` prop, same change events,
  same submit path. The button is hidden while the field is read-only or
  disabled (e.g. a locked conversation context).
- **`RichTextModal`** (`hub/ui/src/components/RichTextModal.tsx`) is the
  popup: a `contentEditable` surface plus a toolbar (bold, italic, bulleted
  list, numbered list, heading, normal text). It is built on the existing
  `Modal` component, so focus trapping, Escape and backdrop dismissal come
  for free.
- **Markdown at rest** (`hub/ui/src/lib/richtext.ts`). Everything typed in
  The Target Project ultimately becomes plain text handed to an agent, so the editor
  stores Markdown, not HTML. On open the field's Markdown is rendered to
  HTML (`markdownToHtml`); on OK the edited DOM is serialized back
  (`htmlToMarkdown`): `**bold**`, `*italic*`, `- ` / `1. ` lists, `#`
  headings. The subset is exactly what the toolbar can produce, so the round
  trip is lossless for content the editor created.

## Commit semantics

- **OK** serializes the editor to Markdown, pushes it through the field's
  normal `onChange`, and closes the popup. The value then follows the
  field's own save path (e.g. "Save context", the step editor's "Save").
- **Cancel / Escape / backdrop click** discard the popup's edits; the field
  keeps its previous value. The field itself only ever changes on OK.

## Fields covered

| View | Field |
| --- | --- |
| Workflow detail | Conversation context |
| Workflow detail | Add-step description and acceptance criteria |
| Step editor | Description and acceptance criteria |
| Templates | Each step's description and acceptance criteria |
