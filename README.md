# target

Define **workflows** made of N sequential **steps**. It reuses agentmesh's
mechanism (agent = `agent-webhook-bridge` hook, step = async job with a
callback) but with a different goal: instead of a registry of shared agents +
a queue of loose jobs, each **workflow creates its own dedicated agent +
hook**, and its steps run one after another **on the same harness session**
(resume chained), like a single conversation that advances step by step.

Two runtimes are supported, same as agent-webhook-bridge and agentmesh:
**Claude Code** (the default) and **[free-code](https://github.com/EnmaSuamkf/free-code)**.
Pick one per workflow with `--runner <claude|free-code>` (or the **Agent
runtime** selector in the UI form). Both share the same hook protocol
(secret, `callbackUrl`, `sessionId`), so steps, judges, retries, context
injection and session chaining behave identically — only the spawned CLI and
the session-id shape differ (a claude uuid vs. a free-code `.jsonl` path).

## Pieces reused from agentmesh

- `hub/awb.ts` — same as `agentmesh/hub/awb.ts`: creates/inspects
  `agent-webhook-bridge` hooks by writing `~/.agent-webhook-bridge/hooks.json`.
- Same zero-dependency stack: Node 24 + `node:sqlite` + TS run directly, same
  hand-written HTTP server pattern.
- Same async callback model: the hook answers `{ok:true}` immediately, and the
  result arrives later on `POST /api/steps/:id/result`.

## What changes relative to agentmesh

| agentmesh | target |
|---|---|
| Agent = reusable row in a registry | Agent = 1 per workflow, created automatically when the workflow is created |
| Job = loose task, optional session | Step = task of a workflow, always chained to the previous session |
| Parallel jobs, no order | Strictly sequential steps (the next one doesn't fire until the previous one finishes) |
| — | Progress in % (done/total), pause/resume, edit a step + restart the workflow |
| — | Every job carries an appended instruction to resolve itself with a subagent (Task tool), because the main thread is reused for the whole workflow |
| — | Status `.md` in `~/.target/<name-slug>-<id>.md`, rewritten on every change |

## Install

Needs **Node >= 24** (see `.nvmrc`; the installer activates it through nvm/fnm
if the node in your PATH is older).

```bash
npm run target:install
```

One command from the repo root: installs the hub's dependencies, installs and
**builds the web UI** (`hub/ui` → `hub/ui/dist`), clones
`agent-webhook-bridge` into `vendor/` (gitignored) and installs its own. It's
idempotent — re-run it any time. Set `AWB_DIR` to point at an existing
`agent-webhook-bridge` clone instead of vendoring a second copy.

The UI is the only part of the repo with a build step, so `npm start` refuses
to boot until `hub/ui/dist` exists. Rebuild it on its own with:

```bash
npm run ui:build
```

## Usage

```bash
npm start
```

One command brings up **both** processes — the `agent-webhook-bridge` broker
(`127.0.0.1:8890`) and the hub (`127.0.0.1:8893`) — waits until both ports
answer, then opens the UI in your default browser. It stays in the foreground
holding both; press **Ctrl-C** to stop them together. If either is already
running it's reused rather than started twice.

The hub prints its **admin token** on startup, and `npm start` also shows it
in its `Ready.` block (it always lives in `~/.target/config.json`) — the UI
asks for it and the CLI uses it automatically.

```bash
node hub/cli.ts create "release-notes" [--workdir <dir>] [--permission-mode acceptEdits] [--runner free-code]
node hub/cli.ts set-context <workflowId> "<text>"   # set (or clear with "") the conversation context, on an existing workflow
node hub/cli.ts add-step <workflowId> "Read the CHANGELOG and put together a summary"
node hub/cli.ts add-step <workflowId> "Publish the summary to docs/release-notes.md"
node hub/cli.ts run <workflowId>       # start / continue
node hub/cli.ts pause <workflowId>
node hub/cli.ts resume <workflowId>
node hub/cli.ts restart <workflowId>   # resets every step and starts from scratch
node hub/cli.ts list
node hub/cli.ts show <workflowId>
```

Or from the UI at `http://127.0.0.1:8893`: create a workflow, add steps with
`Add step`, tick the steps to run, watch the progress bar, Start/Stop, and edit
a pending step before starting it over.

### The web UI

A React + Vite single-page app in `hub/ui`, served by the hub as static files
from `hub/ui/dist`. The hub itself stays dependency-free at runtime — it only
reads the built output.

| Path | What it is |
|---|---|
| `hub/ui/src` | Application source (components, views, API client) |
| `hub/ui/dist` | Build output the hub serves (gitignored) |
| `hub/ui/legacy-index.html` | The previous single-file UI, kept for reference |

Working on it:

```bash
npm run ui:dev     # Vite dev server on :5173, proxying /api to the hub
npm run ui:build   # production build into hub/ui/dist
npm run typecheck  # type-checks the hub and the UI
```

`ui:dev` gives hot reload while proxying API calls to a hub started separately
with `npm start`. Point it at a hub on another port with `TARGET_HUB_ORIGIN`.

Notes on behaviour worth knowing:

- **Admin token.** Stored in `localStorage` under `targetAdminToken` and sent as
  `Authorization: Bearer <token>`. Set it from the button in the header; the app
  warns while none is stored, since every mutating action would 401.
- **Step selection.** Start/Resume/Start-over dispatch exactly the ticked steps.
  Nothing ticked runs nothing, so the button is disabled rather than a silent
  no-op.
- **One Start button.** It maps to the action that fits the status — `start`
  when draft, `resume` when paused, `restart` when completed or failed.
- **Live updates.** The hub has no streaming endpoint, so the UI polls every 2s.
  Polling pauses while the tab is hidden and resumes on focus.
- **Deep links.** The selected workflow is in the URL hash (`#/w/<id>`), so a
  reload or a shared link reopens it.

### Conversation context

A workflow runs as one continuous conversation on a shared Claude session
(every step after the first resumes the same session). A **conversation
context** is an optional preamble injected **before the first step** of a
fresh run, so every step inherits that background (audience, constraints,
definitions, a persona) without repeating it. It's injected once: later steps
resume the session, which already carries it in history, so it's never
re-injected automatically. Restarting the workflow starts a new conversation
and injects it again. Once injected, the context is **locked** (the field
becomes read-only and Save is disabled) — to change it, restart the workflow
first. You add it to an existing workflow with `target set-context` (or the
**Conversation context** block in the detail panel); it isn't part of workflow
creation.

### Stuck steps

A step whose dispatch never calls back (a hung exec or judge) stays `running`
and blocks the workflow: ▶ won't re-run a `running` step and Restart is
disabled while the workflow is `running`. Use the **Abort** button on the step
(or `POST /api/workflows/:id/steps/:stepId/abort`) to force-fail just that step
— its session is preserved, so "Open conversation" still works — then ▶ re-run
it. (Otherwise you wait for the 20-minute stale-step timeout, or pause +
restart the whole workflow.)

### Agent permissions

By default a workflow's agent can answer but **cannot** write files or run
commands (the same conservative default as agentmesh phase 1). To let steps
actually write files in their dedicated sandbox
(`~/.target/sandboxes/<agent>/`), create the workflow with
`--permission-mode acceptEdits` (or pick it in the UI form).
`bypassPermissions` exists but requires explicit confirmation because it
enables unrestricted command execution.

### Choosing the runtime (`--runner`)

A workflow's agent spawns **Claude Code** by default. Create it with
`--runner free-code` (or pick **free-code** in the UI's Agent runtime
selector) to run every step on the free-code CLI instead:

```bash
node hub/cli.ts create "release-notes" --runner free-code --permission-mode acceptEdits
```

What changes and what doesn't:

- **Same engine.** Steps still run strictly in order on one shared session;
  judges, retries, conversation context and the progress `.md` all work the
  same. The hub writes `spawn:free-code` into the hook's `consumers`, and
  awb's free-code adapter does the rest.
- **Sessions are `.jsonl` paths.** free-code resumes by session-file path,
  not by uuid; awb keeps those files under
  `~/.agent-webhook-bridge/sessions/<agent>/` and reports the path as the
  `session_id`. "Open conversation" accounts for it: it opens a terminal
  running `free-code --session <path>` instead of `claude --resume <id>`.
- **Permissions map to `--tools`.** free-code has no `--permission-mode`;
  awb maps the hook's mode to a tool set (unset → read-only,
  `acceptEdits` → +write/edit, `bypassPermissions` → full incl. bash). Same
  opt-in risk model as claude.
- **Token usage still works.** The Conversation panel reads free-code's own
  transcript usage (`input`/`output`/`cacheRead`/`cacheWrite`) straight off
  the session file; there are no subagent transcripts to fold in.

The runner is fixed at workflow creation (it's the hook's spawn consumer);
to switch runtimes, create a new workflow.

## External requirement

It needs `agent-webhook-bridge` **running** — that's what actually spawns
`claude -p` / `claude --resume` (or `free-code -p` / `free-code --session`)
for each step. `npm run target:install` puts it
in place and `npm start` boots it alongside the hub, so you don't have to start
it yourself.

## Project status

This repo is in its early stages. GitHub issues are used to track bugs and
pending features; PRs should target `main`.
