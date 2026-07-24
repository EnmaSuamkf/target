# Feature: Conversation context

Add an optional **Conversation context** to a workflow: a free-text preamble
that is injected into the agent's conversation **before everything else** when
the workflow's conversation starts, and never re-injected automatically once
it has been injected.

## Why

A workflow runs as one continuous conversation on a shared Claude session
(every step after the first resumes `workflow.lastSessionId`). Today there is
no way to give that conversation a stable preamble — background, constraints,
definitions, a persona — that every step inherits. Per-step descriptions are
the only input, and they don't carry across the resumed session as a shared
frame.

This feature lets the operator attach that preamble at the workflow level and
have it delivered exactly once, at the start of the conversation.

## Requirements

1. An existing workflow has an input field called **Conversation context**
   (in its detail panel — it is not part of workflow creation).
2. When a conversation starts inside the workflow, the context is injected
   **before all** (prepended to the first dispatched step's input).
3. We track whether the conversation from the workflow has already had the
   context injected, at any time.
4. If the context was injected before, it is **not** injected automatically
   again.

## Design

### Where it lives

Workflow-level, not per-step. A workflow is one continuous conversation on a
shared session, so the context preamble belongs to the conversation, not to
individual steps.

### When it is injected

Prepended to the input of the **first dispatch that starts a fresh
conversation** — i.e. when there is no session to resume yet
(`workflow.lastSessionId === null`). That is the only dispatch where "before
all" is meaningful; every later step resumes a session that already carries
the context in its history, so re-injecting would duplicate it.

### The tracker (req #3) and the guard (req #4)

A new `context_injected` boolean on the workflow:

- Set `true` once the first session is actually established (when
  `setWorkflowSessionId` records the first session id), not at dispatch time.
- Checked in `dispatchStep`, so the preamble is skipped if already injected.

Setting the flag when the session is established (rather than at dispatch
time) is more robust: a first dispatch that fails to produce a session leaves
the flag `false`, so a re-run re-injects cleanly — no lost preamble, no double
preamble.

### When the flag resets

- **Restart** → `false`. A brand-new conversation should get the context
  again. (Restart also drops the session id, so the next first dispatch is a
  fresh conversation.)

### Once injected, the context is locked

Once `context_injected` is `true`, the context is **frozen**: the agent is
already operating under it, so editing it mid-conversation would be silently
inconsistent. `setConversationContext` rejects edits with `context already
injected`, the `PATCH /api/workflows/:id/context` route returns `400`, and the
UI makes the field read-only and disables Save. The context can only be
changed again after a **restart** resets the flag (and starts a fresh
conversation), so the next first dispatch re-injects whatever the context is
by then.

### Empty context

A workflow with an empty/null context behaves exactly as before — no preamble
is ever injected and the flag is irrelevant.

## File-by-file plan

| File | Change |
|---|---|
| `hub/db.ts` | `Workflow.conversationContext` + `contextInjected` fields; new columns + upgrade `ALTER TABLE` for older DBs; `insertWorkflow` accepts `conversationContext`; new `setContextInjected()` and `setWorkflowConversationContext()` |
| `hub/workflow.ts` | `setConversationContext` edits the context on an existing workflow; mark `contextInjected=true` when the first session is established; reset the flag in `restartWorkflow`; surface the context in `writeStatusMd` |
| `hub/runner.ts` | `dispatchStep` prepends the context preamble to the input only on a fresh, not-yet-injected conversation (exec mode, no session to resume) |
| `hub/server.ts` | `publicWorkflow` exposes `conversationContext`/`contextInjected`; `PATCH /api/workflows/:id/context` to edit it on an existing workflow (creation ignores `conversationContext`) |
| `hub/cli.ts` | `set-context <id> <text>` command edits the context on an existing workflow; `show` displays the context |
| `hub/ui/index.html` | A visible/editable "Conversation context" field in the workflow detail panel (not the new-workflow form); read-only + Save disabled once injected; read-back + persistence |
| Tests | `context.test.ts`: injection on first dispatch, no re-injection on subsequent steps, reset on restart, not reset on same-value save, re-inject after a failed first dispatch, empty-context unchanged, create ignores `conversationContext`, PATCH context + auth/error round-trips |
| `README.md` + `web-docs/index.html` | Document the feature, the CLI flag/command, and the API field |

## Status

Implemented and covered by `hub/context.test.ts` (14 tests) plus the
existing suites. `npm test` (60 tests) and `npm run typecheck` pass.

- `hub/db.ts` — schema, fields, migration, setters.
- `hub/workflow.ts` — `createWorkflow`/`setConversationContext`, `chainSession`
  (marks injected on first session), restart flag reset, `writeStatusMd`.
- `hub/runner.ts` — `contextPreamble` + injection guard in `dispatchStep`.
- `hub/server.ts` — `publicWorkflow` fields, `PATCH .../context` (create ignores the field).
- `hub/cli.ts` — `set-context`, `show`.
- `hub/ui/index.html` — detail panel block + state read-back (not the new-workflow form).
- `README.md`, `web-docs/index.html` — documented.
