# Feature: Create a workflow from a conversation

Turn a conversation you are already having with `claude` or `free-code` into a
workflow, with that conversation as the background every step runs under.

## Why

You are talking to an agent about a piece of work, and partway through you
realise it should be a workflow. Today that means creating an empty workflow and
retyping the background into the **Conversation context** box — a summary of a
conversation you already had, written by hand, from memory.

Everything needed to avoid that already existed except the capture:

- a workflow's `conversation_context` is delivered as its **own hub-owned step**
  (`kind='context'`, order index `-1`) before any real work, once, on the shared
  session — see `reconcileContextStep` in `hub/workflow.ts`;
- `insertWorkflow` (`hub/db.ts`) already accepted a `conversationContext`, it
  just had no caller;
- `openResumeTerminal` (`hub/terminal.ts`) already reopens a harness session in a
  real terminal on this machine.

So this feature is the missing half: find the conversations on disk, condense
one, and hand it to the machinery that was already there.

## How it works

1. **Filter by agent.** The create form's **Agent runtime** selector is the
   filter: choosing Claude Code or free-code narrows the conversation list to
   that harness's sessions. This is not cosmetic — the two keep their
   transcripts in different places and resume by different handles.
2. **Pick a conversation.** Listed newest first, labelled with the first thing
   the human said, the directory it ran in, and how long ago it was active.
   Picking one also proposes its working directory, if you haven't typed one.
3. **Check it is the right one.** **Open in terminal** reopens that exact
   conversation in a terminal window on this machine, `cd`'d into its own
   directory — the same mechanism as a workflow's "Open conversation" button.
   One line of a title is not enough to be sure, and discovering the wrong
   import two steps into a run is expensive.
4. **See what will be imported.** "Show what will be imported" renders the
   condensed transcript exactly as the workflow will receive it.
5. **Create.** The workflow is born with that text as its conversation context
   and its context step already pending at order `-1`.

## Where the conversations live

Walked at depth 2 only, which is also what keeps subagent transcripts out.

| Runner | Root(s) | Session id |
|---|---|---|
| `claude` | `~/.claude/projects/<slug>/<uuid>.jsonl` | the uuid (what `claude --resume` takes) |
| `free-code` | `~/.free-code/agent/sessions/<slug>/*.jsonl` and `~/.agent-webhook-bridge/sessions/<hook>/*.jsonl` | the absolute path (what `free-code --session` takes) |

The workdir is read from the records' own `cwd` field rather than decoded from
the directory name, which is a lossy slug of it. awb's session tree is included
on purpose: a previous workflow's run is a conversation too, and turning one into
a new workflow is a real thing to want. Those sessions all open with the hub's
own prompt template, so they are titled `Workflow "<name>"` instead of by that
sentence.

## Why a digest and not the transcript

Real transcripts on a working machine run to megabytes (13–28 MB here). The
hub's JSON body limit (`maxInputBytes`, 64 KiB) is the smaller problem; the real
one is that the context step is **one turn** on the workflow's shared session,
and `hub/context-pressure.ts` exists precisely because that session's occupancy
is a finite resource the workflow should spend on work.

So `readConversationDigest` keeps the prose and drops the machinery — tool calls,
tool results, thinking blocks, injected `<system-reminder>`s, and subagent
sidechains — then caps each turn at 2 000 characters and fits the result into
16 KiB **from both ends**: the opening frames what the conversation was for, the
end is where it got to, and the middle is what a summary would have compressed
anyway. When anything is dropped, the digest says so in its header, because an
agent reading an incomplete record as a complete one draws confident wrong
conclusions.

The header also states that what follows is a transcript of an *earlier*
conversation and not instructions addressed to the agent. Without that framing an
imported conversation reads as a pile of contradictory orders.

## API

| Route | Purpose |
|---|---|
| `GET /api/conversations?runner=<claude\|free-code>` | This machine's conversations for that harness, newest first (capped at 100) |
| `GET /api/conversations/preview?runner=…&sessionId=…` | The digest that would be imported |
| `POST /api/conversations/open-terminal` `{runner, sessionId}` | Reopens that conversation in a terminal here |
| `POST /api/workflows` `{…, conversation: {runner, sessionId}, conversationNote?}` | Creates the workflow with that conversation as its context |

All of them are **admin-gated**, unlike `GET /api/runners` beside them: these
return the content of the operator's own conversations, and one spawns a process
on their desktop.

### The `sessionId` is never trusted

A free-code session id *is* an absolute path, arriving straight off the wire.
Every route resolves it through `findConversation`, which only matches files it
actually enumerated under that harness's own session roots — so an arbitrary path
can neither be read as a digest nor handed to the terminal launcher.

### Relationship to acceptance criterion #8

`docs/acceptanceCriteria.md` #8 says a context is set on an *existing* workflow
and that `POST /api/workflows` ignores a `conversationContext` field. That still
holds: what create accepts is a **reference** to a transcript on this machine,
which the server resolves and condenses itself. A bare `conversationContext` at
creation is still ignored, and `conversationNote` — the operator's own framing,
placed above the transcript — only applies when a `conversation` is present.

## What changed

| File | Change |
|---|---|
| `hub/conversations.ts` | New. Enumerates both harnesses' transcripts, labels them, and condenses one into a workflow context |
| `hub/server.ts` | The three `/api/conversations` routes; `POST /api/workflows` accepts `conversation` + `conversationNote` |
| `hub/workflow.ts` | `createWorkflow` accepts `conversationContext`, stores it, and calls `reconcileContextStep` so the context step exists from creation |
| `hub/ui/src/api/{types,client}.ts` | `Conversation` / `ConversationDigest`; `listConversations`, `previewConversation`, `openConversationTerminal` |
| `hub/ui/src/views/CreateWorkflowModal.tsx` | The picker: agent-filtered list, "Open in terminal", the import preview, and the workdir it proposes |
| `hub/conversations.test.ts` | New. 16 tests, including the end-to-end one: posting a conversation yields a workflow whose context step is that conversation |
