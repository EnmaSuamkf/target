---
name: target-workflows
description: >-
  Manage existing Target Project hub workflows — list, edit, delete, add steps,
  set conversation context, and control runs. Use when the user asks to modify,
  start, pause, inspect, or delete Target workflows. For creating a new
  workflow, use the create-workflow skill. Requires the Target hub running
  (npm start) and auth via TARGET MCP tools or curl with the admin token from
  ~/.target/config.json.
TARGET_SKILL_VERSION: "8"
managedBy: target
---

# Target workflow management

Creating a **new** workflow is the `create-workflow` skill — do not skip that interview.

The Target hub exposes a JSON API (default `http://127.0.0.1:8893`). Mutating routes need:

```http
Authorization: Bearer <adminToken>
```

Read `adminToken` from `~/.target/config.json` when using curl. Prefer **Target MCP tools** when configured (`target sync-mcp`). MCP v0.3 exposes the same operations as the UI (workflows, steps, templates, TCP, RCI, settings, attachments).

### Templates / TCP / RCI MCP tools

| Area | Tools |
|------|-------|
| Templates | `list_templates`, `get_template`, `create_template`, `update_template`, `delete_template`, `export_template`, `export_all_templates`, `import_templates` |
| TCP | `list_tcps`, `get_tcp`, `create_tcp`, `update_tcp`, `delete_tcp`, `get_tcp_usage`, `export_tcp`, `export_all_tcps`, `import_tcps`, `set_workflow_tcp_selections` |
| Pipelines | `list_pipelines`, `get_pipeline`, `create_pipeline`, `update_pipeline` (saved pipelines stay untrusted until an operator approves them in the hub UI; no MCP tool approves or touches secrets) |
| RCI | `list_resource_sets`, `get_resource_set`, `create_resource_set`, `update_resource_set`, `delete_resource_set`, `get_resource_set_usage`, `scan_resources`, `set_workflow_resource_selections` |

## Step create / edit (MCP)

Use `add_step` or `edit_step` with the full form — no separate hub API call needed:

```json
{
  "workflowId": "...",
  "description": "Say hello to the user",
  "acceptanceCriteria": "The agent said hello",
  "useSubagent": true,
  "manualReview": true,
  "maxRetries": 2,
  "retryIntervalSeconds": 15,
  "recoverOnFailure": true,
  "maxRecoveries": 1
}
```

Steps another agent will run must be self-contained: always set `acceptanceCriteria`, and use `maxRetries` of at least 2.

Omit `useSubagent` / `manualReview` / `recoverOnFailure` / `maxRecoveries` only when you intentionally leave the stored value unchanged on **edit**; on **create**, set them explicitly (or accept the defaults: recovery off, `maxRecoveries` 1).

## Failure recovery

A step with **Recover on failure** does not stop the workflow when it fails for good (its judge rejects it with no retries left, its pipeline fails with no retries left, its on-success agent fails the attempt with `fail_attempt` and no retries are left, or it times out with no retries left). Instead the workflow goes to status **`recovering`** and the hub sends a **recovery agent** that fixes the **plan, never the code**, then reopens the step and relaunches the workflow in its own conversation — or gives up, which leaves the step and the workflow `failed`. Infrastructure failures (hook down, usage limit, untrusted/revoked pipeline, a judge that could not run or answered unreadably, an operator abort) never trigger it.

| Field | Where | Meaning |
|-------|-------|---------|
| `recoverOnFailure` | step (`add_step` / `edit_step`) | boolean, default `false` — the "Recover on failure" toggle |
| `maxRecoveries` | step (`add_step` / `edit_step`) | integer ≥ 0, default `1` — how many recoveries the step may use; once used up it fails as before |
| `recoveryCount` | step (read-only) | recoveries the step already used; owned by the hub, reset only by `restart_workflow` |
| `recoveryModel` | workflow (`create_workflow`, `clone_workflow`, `set_recovery_model`) | model id the recovery agent runs with (one of the runner's `models[]` from `list_runners`); `null` = CLI default. Same runner, sandbox, workdir and permissions as the workflow |
| `recovering` | workflow `status` | a recovery is running on the workflow; nothing else is dispatched on it |

Tools:

- `reopen_step` `{ workflowId, stepId }` — puts a **failed** step back to `pending` with its retries reset (`retryCount` 0), keeping `recoveryCount`; then `start_workflow` runs it again. Route: `POST /api/workflows/:id/steps/:stepId/reopen`.
- `set_workflow_model` `{ workflowId, model }` — the workflow's own model (`null` = CLI default). Route: `PATCH /api/workflows/:id/model`.
- `set_recovery_model` `{ workflowId, model }` — the recovery model (`null` = CLI default). Route: `PATCH /api/workflows/:id/recovery-model`.
- `fail_attempt` `{ workflowId, stepId, reason }` — **only for a command step's own on-success agent**, while it runs: its checks show the step must not pass (for example QA cases failed). Call it, then end the turn. The attempt then settles as a failed pipeline run: the pipeline re-runs while retries are left, then Failure recovery runs if the step has it on, otherwise the workflow fails. Route: `POST /api/workflows/:id/steps/:stepId/fail-attempt`.

**`fail_attempt` vs `abort_step` vs `set_step_status failed`.** Abort and a manual `failed` are operator decisions: they never retry and never start Failure recovery (and `set_step_status` is refused while the step's own job runs). When an on-success agent finds the step's work failed and a retry or a recovery could fix it, it uses `fail_attempt`. Keep `abort_step` for problems a retry or a recovery cannot fix: the environment is down (a server, the hub or the database is unreachable) or a dependency is missing (a contract gap).

While a workflow is **`recovering`**, its steps cannot be added, edited, moved, deleted or reopened, and start/restart/run are refused (409 `{"error":"recovering"}`): only the recovery agent changes the plan. To stop a recovery, `POST /api/workflows/:id/recovery/abort` (it settles as gave up). The history is `GET /api/workflows/:id/recoveries`. Every change the recovery made is a "Recovery: <field>: before → after" note on the changed step. The recovery agent itself does **not** use this MCP: it uses a separate recovery API with a token valid only for that workflow and that recovery.

## Before mutating

1. Confirm the hub is up: `GET /health` (no auth) or MCP `hub_health`.
2. If connection refused, tell the operator to run `npm start` in the Target repo.

## Rules

- **Edit/delete steps** only while the step is `pending` (not started or done), and never while the workflow is `recovering`.
- **Conversation context** is locked after `contextInjected` is true — restart the workflow to change it.
- **Confirm with the operator** before `delete_workflow`.
- Prefer `add_step` over restarting when extending a workflow.

## Common routes

| Intent | Method | Path |
|--------|--------|------|
| List | GET | `/api/workflows` (archived hidden; `?archived=include\|only`) or MCP `list_workflows` `{ archived? }` |
| Detail | GET | `/api/workflows/:id` |
| Create | POST | `/api/workflows` body `{ "name", "workdir"? }` |
| Delete | DELETE | `/api/workflows/:id` |
| Rename | PATCH | `/api/workflows/:id/name` body `{ "name" }` |
| Set context | PATCH | `/api/workflows/:id/context` body `{ "conversationContext" }` |
| Add step | POST | `/api/workflows/:id/steps` or MCP `add_step` |
| Edit step | PATCH | `/api/workflows/:id/steps/:stepId` or MCP `edit_step` |
| Delete step | DELETE | `/api/workflows/:id/steps/:stepId` |
| Reopen failed step | POST | `/api/workflows/:id/steps/:stepId/reopen` or MCP `reopen_step` |
| Workflow model | PATCH | `/api/workflows/:id/model` body `{ "model" }` or MCP `set_workflow_model` |
| Recovery model | PATCH | `/api/workflows/:id/recovery-model` body `{ "recoveryModel" }` or MCP `set_recovery_model` |
| Abort a recovery | POST | `/api/workflows/:id/recovery/abort` |
| Fail an attempt (on-success agent) | POST | `/api/workflows/:id/steps/:stepId/fail-attempt` body `{ "reason" }` or MCP `fail_attempt` |
| Start | POST | `/api/workflows/:id/start` |
| Archive | POST | `/api/workflows/:id/archive` (completed/failed only; 409 `not_archivable`) or MCP `archive_workflow` |
| Unarchive | POST | `/api/workflows/:id/unarchive` or MCP `unarchive_workflow` |

An archived workflow answers 409 `{"error":"archived"}` to start/resume/restart/step run — unarchive it first.

## Workflow steps (Target engine)

When running **inside a Target workflow step**, use **TCP tools** from the injected catalog (`POST /api/tcps/execute?stepId=…&token=…`) instead of the admin token.
