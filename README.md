# target

Define **workflows** made of N sequential **steps**. It reuses agentmesh's
mechanism (agent = `agent-webhook-bridge` hook, step = async job with a
callback) but with a different goal: instead of a registry of shared agents +
a queue of loose jobs, each **workflow creates its own dedicated agent +
hook**, and its steps run one after another **on the same Claude session**
(`--resume` chained), like a single conversation that advances step by step.

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

## Usage

```bash
cd hub && npm install
node daemon.ts        # or: npx tsx cli.ts start / node cli.ts start
```

The hub prints its **admin token** on startup (it also lives in
`~/.target/config.json`) — the UI asks for it and the CLI uses it automatically.

```bash
node cli.ts create "release-notes" [--workdir <dir>] [--permission-mode acceptEdits]
node cli.ts add-step <workflowId> "Read the CHANGELOG and put together a summary"
node cli.ts add-step <workflowId> "Publish the summary to docs/release-notes.md"
node cli.ts run <workflowId>       # start / continue
node cli.ts pause <workflowId>
node cli.ts resume <workflowId>
node cli.ts restart <workflowId>   # resets every step and starts from scratch
node cli.ts list
node cli.ts show <workflowId>
```

Or from the UI at `http://127.0.0.1:8893` (the **Workflow** section): create a
workflow, add steps with the `+ Add step` button, watch the progress bar,
Start/Pause/Resume/Restart, and edit a pending step before restarting.

### Agent permissions

By default a workflow's agent can answer but **cannot** write files or run
commands (the same conservative default as agentmesh phase 1). To let steps
actually write files in their dedicated sandbox
(`~/.target/sandboxes/<agent>/`), create the workflow with
`--permission-mode acceptEdits` (or pick it in the UI form).
`bypassPermissions` exists but requires explicit confirmation because it
enables unrestricted command execution.

## External requirement

It needs `agent-webhook-bridge` running (`awb start`) — that's what actually
spawns `claude -p` / `claude --resume` for each step.

## Project status

This repo is in its early stages. GitHub issues are used to track bugs and
pending features; PRs should target `main`.
