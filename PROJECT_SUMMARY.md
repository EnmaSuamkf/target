# target — Project summary

## What it is

**target** is a local hub for defining **workflows** made of N sequential
**steps** executed by Claude. It reuses the **agentmesh** mechanism
(agent = `agent-webhook-bridge` hook, step = asynchronous job with a callback),
but with a different goal: instead of a registry of shared agents with a queue
of loose jobs, **each workflow creates its own dedicated agent + hook**, and its
steps run one after another on the **same Claude session** (`--resume` chained),
so that the whole workflow reads as a single conversation that advances step by
step. The hub exposes an HTTP API, a single-page web UI and a CLI; it also
keeps, for each workflow, a progress `.md` file in `~/.target/` that is
rewritten on every state change.

## Stack

Node.js >= 24, TypeScript run directly by Node (no build step) and **zero
runtime dependencies**. Everything relies on the standard library:
`node:sqlite` (`DatabaseSync`, in WAL mode) for persistence, `node:http` for the
hand-written server, `node:crypto` for tokens and secrets, and the global
`fetch` to talk to the broker. The only dependencies are dev ones:
`typescript` and `@types/node`. The UI is a static `index.html` of ~750 lines
served by the hub itself, with no framework or bundler.

As an external requirement it needs **`agent-webhook-bridge` (awb)** running
(`awb start`): that's what actually spawns `claude -p` / `claude --resume` for
each step.

## Architecture

The flow is asynchronous end to end. The hub dispatches a step to the
workflow's awb hook; the hook answers `{ok:true}` immediately (which only means
"accepted") and the real result arrives later on `POST /api/steps/:id/result`
via the `callbackUrl` the hub sent in the event. The modules, under `hub/`:

- **`daemon.ts`** — entry point; loads config, brings up the server and prints
  the admin token.
- **`server.ts`** — HTTP server: JSON API (workflows, steps, start/pause/
  resume/restart, transcript, result callback) and the UI. Every mutating route
  requires the admin token as a Bearer; awb's callback authenticates instead
  with a per-step token via query string, compared with `timingSafeEqual`.
- **`workflow.ts`** — the engine and the state machine
  (`draft → running → paused/completed/failed`). `advance()` is the only place
  that decides what runs next, so "pausing" is simply not calling it. The judge
  logic and the rewriting of the progress `.md` also live here.
- **`runner.ts`** — dispatches a step (or its evaluation) to the hook: builds
  the input, attaches the `sessionid` to resume and the `callbackUrl`, and marks
  the step `running` or `failed` depending on the hook's response.
- **`db.ts`** — a pure storage layer over SQLite: `workflows` and `steps`
  tables, additive migrations via `ALTER TABLE` for old databases, and **lazy**
  expiry of stuck steps (each read first fails any `running` step older than the
  timeout, instead of a timer per step — it survives hub restarts for free).
- **`awb.ts`** — bridge to the local awb install: creates/inspects/deletes
  hooks by writing `~/.agent-webhook-bridge/hooks.json` directly (the broker
  re-reads the file on every request, so a new hook is live without restarting
  anything).
- **`transcript.ts`** — reads, best-effort and read-only, the `.jsonl` that
  Claude Code writes for a session (under `~/.claude/projects/<slug>/`), to show
  the actual conversation inside the steps and not just the final result.
- **`config.ts`** — config persisted in `~/.target/config.json` (override the
  directory with `TARGET_HOME`); default `127.0.0.1:8893`, step timeout of 10
  minutes. The port was chosen far from awb's (8890) and agentmesh-hub's (8892)
  so the three can coexist.
- **`cli.ts`** — the `target` CLI; talks to the API and takes the admin token
  straight from `~/.target/config.json`, so there's no token to type.

### Design details worth knowing

**Subagent delegation.** Since the session is reused turn after turn, each
step's input appends an explicit instruction to do the work with the Task tool
instead of inline: that keeps each step's working context out of the resumed
session, which only accumulates the subagent's final summaries.

**Judge / self-evaluation.** A step can carry an optional acceptance criterion.
If it has one, when its execution finishes (the `exec` phase) the step does not
go to `done`: it enters the `judge` phase and a second run is dispatched, on the
same session, that asks the agent to evaluate its own result and answer a JSON
`{"ok": bool, "reason": string}`. If the verdict accepts, the step becomes
`done` and the engine advances; if it rejects, the same step is retried with the
judge's feedback until `maxRetries` is exhausted, and only then does the
workflow fail. A verdict that doesn't parse also fails the workflow,
deliberately, rather than guessing. With no acceptance criterion there is no
judge and the behavior is the usual one.

**On-demand runs (▶).** A step can be run out of order. That run uses the same
agent/hook but **always a fresh session**: it never resumes `lastSessionId` nor
becomes the new one. It stays outside the engine and doesn't touch the
workflow's status directly; `reconcileStatus()` later derives the workflow's
status from the **current** state of its steps (all `done` → `completed`, any
`failed` → `failed`, something left to run → `draft`), which is what lets
retrying a failed step until it passes take the workflow out of `failed`.

**Permissions.** By default a workflow's agent can answer but **cannot** write
files or run commands. For steps to actually write in their dedicated sandbox
(`~/.target/sandboxes/<agent>/`) the workflow must be created with
`--permission-mode acceptEdits`. `bypassPermissions` exists but demands explicit
confirmation (`acceptBypassRisk: true` / `--yes-bypass-risk`) because it enables
unrestricted command execution on the operator's machine.

## Directory structure

```
/
├── README.md              Main documentation (usage, differences with agentmesh)
├── .claude/               settings.local.json (permission allowlist)
└── hub/                   All the code
    ├── daemon.ts          Hub entry point
    ├── server.ts          HTTP API + UI
    ├── workflow.ts        Engine, state machine, judge, progress .md
    ├── runner.ts          Dispatch of steps to the awb hook
    ├── db.ts              SQLite (workflows + steps)
    ├── awb.ts             Bridge to agent-webhook-bridge
    ├── transcript.ts      Reading of Claude session transcripts
    ├── config.ts          Config persisted in ~/.target
    ├── cli.ts             The `target` CLI
    └── ui/index.html      Web UI (single page, no build)
```

At runtime the hub uses `~/.target/`: `config.json`, `target.db`,
`sandboxes/<agent>/` and a `<slug>-<id>.md` progress file per workflow.

## How to run it

```bash
cd hub && npm install
node daemon.ts        # or: npm start / node cli.ts start
```

The hub prints its **admin token** on startup (it also lives in
`~/.target/config.json`) — the UI asks for it and the CLI uses it automatically.
The UI lives at `http://127.0.0.1:8893`. It requires `agent-webhook-bridge`
running (`awb start`).

Via CLI:

```bash
node cli.ts create "release-notes" [--workdir <dir>] [--permission-mode acceptEdits]
node cli.ts add-step <workflowId> "Read the CHANGELOG and put together a summary"
node cli.ts run <workflowId>       # start / continue
node cli.ts pause <workflowId>
node cli.ts resume <workflowId>
node cli.ts restart <workflowId>   # resets every step and starts from scratch
node cli.ts list
node cli.ts show <workflowId>
```

Type checking: `npm run typecheck` (`tsc --noEmit`). Tests: `npm test`
(`node --test`, over a throwaway `TARGET_HOME`). **There is no CI in the repo**;
there's no build step either (Node runs the `.ts` files directly).

## Current status and recent focus

The README declares it **in its early stages**: GitHub issues are used to track
bugs and pending features, and PRs target `main`. The repo is small and young
(~2,900 lines, 6 commits since the initial scaffold) and several comments talk
about a local-only "phase 1", with a phase 2 planned for remote nodes that
register their own hooks.

The recent history shows a clear focus on **fine-grained control over
individual steps**: first full deletion of workflows and isolated execution of a
step; then a simplification of that mechanism (the separate "isolated run"
columns and callback were replaced by a simple `manualRun` that reuses the
step's `status`/`result`/`error`, plus the reconciliation of the workflow's
status); and on top of that the **self-evaluation of steps with an acceptance
criterion and retries** — the work of the current branch,
`feat/step-acceptance-criteria-judge`. The most recent commit makes the
transcript show the session of the step that ran most recently, instead of only
the workflow's shared session.
