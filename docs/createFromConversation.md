# Feature: Run a workflow on a conversation

Turn a conversation you are already having with `claude` or `free-code` into a
workflow that **carries on inside that same conversation**.

## Why

You are talking to an agent about a piece of work, and partway through you
realise it should be a workflow. What you want is not a summary of what you just
said — it's the agent you were just talking to, now running steps.

The first version of this feature did the summary: it condensed the transcript
into the workflow's conversation context and delivered it as one turn to a brand
new session. That was a lossy copy of something the machine already had. The
budget cut turns out of the middle, tool calls and results were dropped, and what
the agent received said so in its own header ("Treat it as a summary, not a
complete record").

So the workflow now **adopts** the session instead.

## How it works

1. **Filter by agent.** The create form's **Agent runtime** selector narrows the
   conversation list to that harness's sessions. Not cosmetic: the two keep their
   transcripts in different places and resume by different handles.
2. **Pick a conversation.** Listed newest first, labelled with the first thing
   the human said, the directory it ran in, and how long ago it was active.
3. **The working directory is taken, not proposed.** Picking a conversation fills
   the workdir field with that conversation's own directory and makes it
   read-only. See "The two things adoption fixes" below.
4. **Check it is the right one.** **Open in terminal** reopens that exact
   conversation in a terminal window on this machine; **Show the end of the
   conversation** renders its last turns inline.
5. **Optionally, say something first.** "Say this first" is delivered as one turn
   in that conversation before step 1 — for what should change from here on. The
   conversation itself needs no restating: the agent still has it.
6. **Create.** The workflow is born with `adopted_session_id` set, and
   `last_session_id` already equal to it — so the first step dispatches with that
   session id in awb's `sessionid` header, i.e. `claude --resume <uuid>` /
   `free-code --session <path>`.

From there nothing is special: every step after the first chains on the shared
session exactly as it always has. Adoption only decides where the chain starts.

## The two things adoption fixes

A workflow that runs on a conversation cannot choose its **runner** or its
**working directory** — they are the conversation's:

| Field | Why it isn't a choice |
|---|---|
| runner | A claude session uuid means nothing to free-code, and a free-code `.jsonl` path means nothing to claude. |
| workdir | The harness looks a session up relative to the directory it ran in (claude derives `~/.claude/projects/<slug>` from the cwd). Resume from anywhere else and it silently starts a *new* conversation. Also: the work continues in the repo it was about. |

`POST /api/workflows` **refuses** a request that asks for a different runner or a
different workdir rather than overriding it silently — a workflow quietly running
somewhere the operator didn't choose is worse than an error. A conversation whose
transcript never recorded a `cwd` cannot be adopted at all, and is refused with
that reason.

## What this costs

The workflow writes into the operator's own conversation. That is the feature —
reopening it later shows the workflow's steps continuing the thread — but it has
consequences worth stating:

- **A restart goes back to the adopted conversation**, not to a blank session
  (`restartWorkflow` in `hub/workflow.ts`). The steps were written to continue a
  thread; starting them in an empty one would make them a different workflow.
  The conversation has of course grown in the meantime — there is no rewinding a
  real transcript, and starting fresh loses strictly more.
- **A clone does NOT inherit the conversation.** A session can only be continued
  by one workflow at a time; two agents resuming the same transcript would
  interleave their turns in the operator's conversation. A clone gets the steps
  and a fresh session of its own.
- **Compaction still applies.** The adopted conversation is a real one that may
  already be large; `hub/compaction.ts` and `hub/context-pressure.ts` treat it
  exactly as they treat any workflow session, which is why the session panel
  shows its context meter from the first step rather than after one.

## Where the conversations live

Walked at depth 2 only, which is also what keeps subagent transcripts out.

| Runner | Root(s) | Session id |
|---|---|---|
| `claude` | `~/.claude/projects/<slug>/<uuid>.jsonl` | the uuid (what `claude --resume` takes) |
| `free-code` | `~/.free-code/agent/sessions/<slug>/*.jsonl` and `~/.agent-webhook-bridge/sessions/<hook>/*.jsonl` | the absolute path (what `free-code --session` takes) |

The workdir is read from the records' own `cwd` field rather than decoded from
the directory name, which is a lossy slug of it. awb's session tree is included
on purpose: a previous workflow's run is a conversation too, and continuing one
is a real thing to want. Those sessions all open with the hub's own prompt
template, so they are titled `Workflow "<name>"` instead of by that sentence.

## The preview is identification only

`readConversationPreview` renders the **tail** of a transcript — the last dozen
prose turns, tool calls and thinking dropped — so you can confirm where the
conversation got to before committing a workflow to carrying on from there. It is
not what the workflow receives; the workflow receives the conversation. Nothing
about the preview is on the critical path: get it wrong and a panel looks odd,
not a workflow runs on the wrong history.

## API

| Route | Purpose |
|---|---|
| `GET /api/conversations?runner=<claude\|free-code>` | This machine's conversations for that harness, newest first, with `total` |
| `GET /api/conversations/preview?runner=…&sessionId=…` | The tail of that conversation, plus `adoptable` (can a workflow continue it, and in which directory) |
| `POST /api/conversations/open-terminal` `{runner, sessionId}` | Reopens that conversation in a terminal here |
| `POST /api/workflows` `{…, conversation: {runner, sessionId}, conversationNote?}` | Creates a workflow that runs on that conversation |

All of them are **admin-gated**, unlike `GET /api/runners` beside them: these
return the content of the operator's own conversations, and one spawns a process
on their desktop.

### The `sessionId` is never trusted

A free-code session id *is* an absolute path, arriving straight off the wire.
Every route resolves it through `findConversation`, which only matches files it
actually enumerated under that harness's own session roots — so an arbitrary path
can neither be read as a preview, nor handed to the terminal launcher, nor
adopted as a workflow's session.

### Relationship to acceptance criterion #8

`docs/acceptanceCriteria.md` #8 says a context is set on an *existing* workflow
and that `POST /api/workflows` ignores a `conversationContext` field. That still
holds — more so than before, since the transcript is no longer copied into a
context at all. What create accepts is a **reference** to a transcript on this
machine, which the server resolves and runs on. `conversationNote` — the
operator's own words, delivered as the context step's turn — is still the only
prose a create carries, and is ignored without a `conversation` to say it in.

## What changed

| File | Change |
|---|---|
| `hub/db.ts` | `adopted_session_id` column (+ migration); `insertWorkflow` seeds `last_session_id` from it |
| `hub/conversations.ts` | `readConversationDigest` → `readConversationPreview` (tail, identification only); new `adoptability` |
| `hub/server.ts` | `POST /api/workflows` adopts the session and pins runner + workdir, refusing contradictions; preview route returns `preview` + `adoptable`; `publicWorkflow` exposes `adoptedSessionId` |
| `hub/workflow.ts` | `createWorkflow` takes `adoptedSessionId`; `restartWorkflow` returns to it; `cloneWorkflow` deliberately doesn't copy it; the progress `.md` names it |
| `hub/cli.ts` | `show` prints the conversation a workflow continues |
| `hub/ui/src/api/{types,client}.ts` | `ConversationPreview` / `Adoptability`; `Workflow.adoptedSessionId` |
| `hub/ui/src/views/CreateWorkflowModal.tsx` | The picker takes over the workdir field, the note box, "Show the end of the conversation" |
| `hub/ui/src/views/SessionPanel.tsx` | Says when the session is a conversation the operator was already having |
| `hub/conversations.test.ts` | Rewritten for adoption, including the end-to-end dispatch test (first step resumes the conversation's session id) |
