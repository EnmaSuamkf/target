---
name: create-workflow
description: >-
  Create a new Target Project workflow after asking the operator which agent,
  sandbox, working directory (this conversation or another), step subagent
  setting, permission mode, and optional template to use, then write
  self-contained conversation context and complete steps (acceptance criteria,
  at least 2 retries). Use when the user asks to create a new Target workflow,
  start a new workflow, or open the new-workflow form.
TARGET_SKILL_VERSION: "5"
managedBy: target
---

# Create a Target workflow

Guided create. Discover live options from the hub, ask the operator, then create a **handover-ready** workflow: another agent — not you, and not this conversation — will run the steps. That agent sees only the conversation context and the step text. Nothing else carries over.

Do not invent agents, sandboxes, or templates. Do not create until the operator answers the questions below.

## 1. Hub

Call `hub_health`. If the hub is unreachable, tell the operator to run `npm start` in the Target repo and stop.

## 2. Discover options

Call these in parallel:

- `list_runners` — agents and sandboxes this host can actually run
- `list_templates` — templates that can seed steps

Offer **only** runners with `installed: true` and sandboxes with `available: true`. If no runner is installed, stop.

Display names:

| id | Offer as |
|---|---|
| `claude` | Claude Code |
| `free-code` | free-code |
| `cursor` | Cursor Agent |
| `host` | This machine |
| `docker` | Docker container |

Permission modes are the create-form list (not discovered from the API). Offer all of them:

| Value sent | Offer as | Meaning |
|---|---|---|
| *(omit `permissionMode`)* | Read-only (default) | Can answer; cannot write files or run commands |
| `acceptEdits` | acceptEdits | Can write files inside the workflow sandbox |
| `auto` | auto | Harness decides per action |
| `dontAsk` | dontAsk | Never prompts for confirmation |
| `plan` | plan | Planning only — no execution |
| `bypassPermissions` | bypassPermissions | No restrictions — arbitrary commands on this machine |

Do not offer `manual` unless the operator asks for it.

Templates: offer **None** plus each template as `name (N steps)` using that template's `id` when they pick it.

## 3. Ask

If the operator did not already give a **workflow name**, ask for one.

Resolve this conversation's working directory first (workspace root / `pwd`). Show that absolute path in the question so the operator knows what "current" means.

Then ask the following (use `AskQuestion` when that tool is available; otherwise ask conversationally). Options must be the live lists from step 2:

1. Which agent do you want for the workflow?
2. Which sandbox?
3. Working directory: this conversation's directory (`<absolute path>`), or a different one?
4. Should steps run with a subagent? (`Yes` / `No`)
5. What permissions should the agent have?
6. Add steps from a template? (`None` or one of the templates)

If they already answered a question in the original request, do not re-ask it. If only one agent or sandbox is available, still show it unless they already chose it.

If they pick **this conversation's directory**, set `workdir` to that absolute path.

If they pick **a different one**, ask for the path (they can type it, or browse with `list_dirs`). Resolve `~` to an absolute path. Do not create until you have a concrete directory.

If they pick `docker`, do not ask for an image unless they name one. Defaults:

- `claude` → `target-agent:latest`
- `free-code` → `target-agent-freecode:latest`
- `cursor` → `target-agent-cursor:latest`

If they pick `bypassPermissions`, confirm they accept unconstrained command execution. Do not create without that yes.

If the **goal of the work** is still vague (no repo, outcome, or constraints), ask what the executing agent must accomplish. Gather enough to write a handover: goal, relevant paths, constraints, and what "done" looks like.

## 4. Create

Call `create_workflow`:

```json
{
  "name": "...",
  "workdir": "/absolute/path",
  "runner": "claude",
  "sandbox": "host",
  "permissionMode": "acceptEdits",
  "acceptBypassRisk": true,
  "templateId": "..."
}
```

- Always send `workdir` as the absolute path from question 3.
- Omit `permissionMode` for Read-only.
- Omit `templateId` when they chose None.
- Set `acceptBypassRisk: true` only after they confirmed `bypassPermissions`.
- If MCP rejects a permission mode enum, POST the same body with `hub_api` to `/api/workflows`.

## 5. Conversation context (required)

Another agent will run this workflow with no memory of this chat. After create, call `set_conversation_context` with a complete briefing. Never leave context empty.

Write it so a stranger agent can start immediately. Include:

- What this workflow is for and the outcome that counts as success
- Working directory / repo / files / URLs the executing agent must use
- Constraints (do not push, stay on a branch, languages, tools, out of bounds)
- How steps relate (order, dependencies, what later steps inherit)
- Operator decisions already made (runner, sandbox, workdir, permissions, subagent)
- Anything said in this conversation that the executing agent would otherwise lose

Forbidden in context (and in step text): "as we discussed", "see above", "the user said", "continue from this chat", or any pointer that only this conversation can resolve.

## 6. Steps (required, complete)

Do not leave a workflow with no steps. Do not leave a one-line task with no acceptance criterion.

Each step must have all of:

- **description** — a self-contained instruction: what to do, where, and how to know it is finished. Write for an agent that has only this step plus the conversation context.
- **acceptanceCriteria** — always set. Observable and checkable by the judge (file exists, test command passes, PR URL, UI state). Not "tried" or "looks good".
- **maxRetries** — at least `2`. If the operator or a template asked for more, keep the higher number.
- **useSubagent** — the operator's Yes/No from the interview.
- **retryIntervalSeconds** — `15` unless the operator named another interval.

### No template

Author the steps from the operator's goal. Split into sequential units another agent can finish and a judge can accept or reject. Then `add_step` for each, in order, with the full form:

```json
{
  "workflowId": "...",
  "description": "...",
  "acceptanceCriteria": "...",
  "useSubagent": true,
  "maxRetries": 2,
  "retryIntervalSeconds": 15
}
```

### Template chosen

`get_workflow` (or `get_template`). Then `edit_step` every pending seeded step:

- Keep the template's intent; expand thin descriptions so they are handover-ready.
- Fill missing acceptance criteria; strengthen vague ones.
- Set `maxRetries` to `max(templateValue, 2)`.
- Apply the operator's `useSubagent`.
- Set `retryIntervalSeconds` to at least `15` when retries are ≥ 2 and the template left `0`.

If the template is only a skeleton and the operator's goal needs extra work, `add_step` the missing pieces rather than stuffing everything into one seeded step.

## 7. Report

Do not start the workflow unless they ask.

Reply with name, id, agent, sandbox, workdir, permission mode (or Read-only), template used or none, subagent Yes/No, step count, and confirm that conversation context, acceptance criteria, and retries (≥ 2) are in place.
