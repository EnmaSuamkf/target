# The Target Project

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

| agentmesh | The Target Project |
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
node hub/cli.ts create "release-notes" [--workdir <dir>] [--permission-mode acceptEdits] [--runner free-code] [--sandbox docker] [--image <name>]
node hub/cli.ts set-context <workflowId> "<text>"   # set (or clear with "") the conversation context, on an existing workflow
node hub/cli.ts add-step <workflowId> "Read the CHANGELOG and put together a summary"
node hub/cli.ts add-step <workflowId> "Publish the summary to docs/release-notes.md"
node hub/cli.ts run <workflowId>       # start / continue
node hub/cli.ts pause <workflowId>
node hub/cli.ts resume <workflowId>
node hub/cli.ts restart <workflowId>   # resets every step and starts from scratch
node hub/cli.ts list
node hub/cli.ts show <workflowId>                    # also prints each step's id
node hub/cli.ts set-status <workflowId> completed    # set a status by hand (see below)
node hub/cli.ts set-step-status <workflowId> <stepId> done
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
- **Set status…** A picker beside the run controls, and one per step, that sets
  a status by hand when the engine got it wrong. It runs nothing; see
  "Correcting a status by hand" below. Statuses set this way carry a pencil on
  their badge.
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

### Status and progress bar always agree

The workflow badge is derived from the current state of its steps, the same
data the progress bar shows, so they can't disagree: a run that ends with a
step still `failed` ends the workflow `failed` (never `completed` with a red
bar), and every workflow read self-heals settled workflows — one whose steps
are all finished but whose badge is stale (e.g. stuck `running` at 100%
because its remaining pending steps were deleted) is reconciled to
`completed`/`failed`/`draft` on the next `GET`. Workflows that still have
pending or running steps are never touched by this heal.

### Correcting a status by hand

Sometimes the engine's verdict is simply wrong: the agent did the work, but the
run ran out of tokens, or its result callback never arrived, so the step is
`failed` — and the whole workflow reads `failed` with it. The **Set status…**
picker (on the workflow header, and on each step) sets the status yourself, and
so do `target set-status` / `target set-step-status` and
`POST /api/workflows/:id/status` / `POST /api/workflows/:id/steps/:stepId/status`.

Only settled statuses can be set — `done`/`failed`/`pending` for a step,
`completed`/`failed`/`paused`/`draft` for a workflow. `running`, `queued` and
`waiting` belong to the engine and the manual-review gate, and a step (or
workflow) with a job actually in flight is refused: abort it first.

An override **records a verdict, it never runs anything** — a step corrected to
`done` is not re-run and does not advance the workflow. The workflow's badge
still follows from its steps, so fixing the last failed step clears the
workflow's `failed` on its own; and a workflow status you set by hand is left
alone by the read-path heal until the engine writes one itself (Start, Stop,
Resume, Start over, or the next step callback). Statuses set this way are marked
with a pencil on the badge, and called out in the `.md` status file. Full
semantics: [`docs/status-override.md`](docs/status-override.md).

### Stuck steps

A step whose dispatch never calls back (a hung exec or judge) stays
`running` or `queued` and blocks the workflow: ▶ won't re-run an in-flight
step and Restart is disabled while the workflow is `running`. Use the
**Abort** button on the step (or
`POST /api/workflows/:id/steps/:stepId/abort`) to force-fail just that step —
its session is preserved, so "Open conversation" still works, and the spawned
agent process is killed on the broker (SIGTERM/SIGKILL), freeing the workdir
lock so other workflows on the same repo can proceed — then ▶ re-run it.
(Otherwise you wait for the stale-step timeout, or pause + restart the whole
workflow.)

### Queued steps and a fair timeout clock

Runs are serialized per `workdir` with a file lock (`flock`), so a second step
on the same repo waits behind the first. A dispatched step is `queued` until
the broker fires its `started` callback (the instant the lock is acquired and
the run actually begins) — only then does it flip to `running` and its idle
clock start. So a step queued behind a long run isn't timed out while still
waiting its turn. The lock is held by the spawned process
itself, so it survives a broker restart (an orphaned child keeps holding it; a
new broker's run for that workdir blocks until the orphan exits). A separate
`queuedTimeoutMs` (default 6h) is the safety net for a dead broker that never
sends `started`.

### A step is timed out for going silent, not for taking long

A `running` step is no longer failed on a wall clock. The hub watches the
artifacts its harness writes (Claude Code transcripts — subagent transcripts
included — free-code session files, and awb's run log) and only declares a
timeout when **nothing has changed** for `stepIdleTimeoutMs` (default 10 min),
or when the step blows past the absolute ceiling `stepHardTimeoutMs` (default
6h) however busy it looks. A step that's genuinely working is left alone for
as long as it keeps working; a hung one is caught sooner than the old 20-minute
clock caught it.

Each step exposes an `activity` state (`running-active` / `running-idle` /
`stalled` / `timed-out-hard`), rendered in the UI next to the elapsed time as
"active 8s ago" / "no activity 6m", and the timeout error now says why:
`timeout (no progress for 12m; last signal: transcript at …)`. If no artifact
is found at all (remote hook, unknown harness) the watchdog degrades to the
old clock rather than blocking. The sweep runs on every workflow read and on a
60s interval in the daemon, so an unattended hub still frees a hung step's
workdir lock. See `docs/timeout-retries.md`.

### Timeouts consume the retry budget instead of failing outright

A step that times out (any clock) with retry budget left (`maxRetries`
minus retries already used) is **retried instead of failing the workflow**:
the timeout consumes one retry, the hung run is best-effort killed on the
broker (freeing the workdir lock), the step goes back to `pending` and is
re-dispatched on the same shared session with a note that the previous
attempt timed out — so the agent continues from partial progress. The step's
`retryIntervalSeconds` is honored before the re-run, exactly like a
judge-reject retry. Only when the budget is spent (or `maxRetries` is 0, the
default) does a timeout fail the step — and the workflow — for good.

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

### Containing the agent (`--sandbox`)

The runner picks *which* CLI runs a step; the sandbox picks *where* it runs.
By default (`--sandbox host`) it runs directly on this machine, as you — so
the workflow's workdir is a naming convention, not a boundary, and
`bypassPermissions` really does mean "anything you can do". Create the
workflow with `--sandbox docker` to run every step inside a container
instead:

```bash
docker build -t target-agent:latest .            # once; see ./Dockerfile
node hub/cli.ts create "release-notes" --sandbox docker --permission-mode acceptEdits
```

- **The broker stays on the host.** It shells out to `docker run --rm` per
  step and posts the callback itself, so the container needs no port, no
  `--network host` and no route to the hub — only outbound internet for the
  model API. Everything around the spawn (the workdir `flock`, the abort
  path, the progress watchdog, the callbacks) is unchanged.
- **Paths are identical inside and out.** The workdir is bind-mounted at its
  own absolute path and is also the container's `-w`, and `~/.claude`,
  `~/.claude.json` and `~/.agent-webhook-bridge/sessions` come along at
  theirs. That identity is load-bearing: the hub finds a run's transcripts by
  slugifying the workdir string, so a remapped path wouldn't error, it would
  just make every step look stalled after ten minutes.
- **Files stay yours.** The container runs as the broker's `uid:gid`, so
  anything the agent writes into the workdir is owned by you, not root.
  Runs are also capped (`--memory 4g --cpus 2 --pids-limit 512`).
- **The image is per workflow.** `--image <name>` (or the *Container image*
  box in the UI) overrides the default `target-agent:latest`, so a Python
  repo and a Node repo can use different toolchains. The `Dockerfile` at the
  root of this repo is only the default.
- **Mounts are the blast radius.** They're derived from the hook the hub
  wrote, never from a webhook payload. Every extra mount is a hole you chose
  — and the docker socket must never be one of them.
- **"Open conversation" follows.** For a docker workflow the terminal button
  offers `docker run --rm -it … <image> claude --resume <id>`, entering the
  same container shape the steps ran in, because that's where the session is.

Like the runner, the sandbox is fixed at creation (it's a block in the hook);
workflows created before this existed carry no block at all and keep spawning
on the host exactly as they did.

## External requirement

It needs `agent-webhook-bridge` **running** — that's what actually spawns
`claude -p` / `claude --resume` (or `free-code -p` / `free-code --session`)
for each step. `npm run target:install` puts it
in place and `npm start` boots it alongside the hub, so you don't have to start
it yourself.

## Project status

This repo is in its early stages. GitHub issues are used to track bugs and
pending features; PRs should target `main`.
