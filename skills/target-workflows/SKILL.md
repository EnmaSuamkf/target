---
name: target-workflows
description: >-
  Manage existing Target Project hub workflows — list, edit, delete, add steps,
  set conversation context, and control runs. Use when the user asks to modify,
  start, pause, inspect, or delete Target workflows. For creating a new
  workflow, use the create-workflow skill. Requires the Target hub running
  (npm start) and auth via TARGET MCP tools or curl with the admin token from
  ~/.target/config.json.
TARGET_SKILL_VERSION: "5";
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
  "retryIntervalSeconds": 15
}
```

Steps another agent will run must be self-contained: always set `acceptanceCriteria`, and use `maxRetries` of at least 2.

Omit `useSubagent` / `manualReview` only when you intentionally leave the stored value unchanged on **edit**; on **create**, set them explicitly.

## Before mutating

1. Confirm the hub is up: `GET /health` (no auth) or MCP `hub_health`.
2. If connection refused, tell the operator to run `npm start` in the Target repo.

## Rules

- **Edit/delete steps** only while the step is `pending` (not started or done).
- **Conversation context** is locked after `contextInjected` is true — restart the workflow to change it.
- **Confirm with the operator** before `delete_workflow`.
- Prefer `add_step` over restarting when extending a workflow.

## Common routes

| Intent | Method | Path |
|--------|--------|------|
| List | GET | `/api/workflows` |
| Detail | GET | `/api/workflows/:id` |
| Create | POST | `/api/workflows` body `{ "name", "workdir"? }` |
| Delete | DELETE | `/api/workflows/:id` |
| Rename | PATCH | `/api/workflows/:id/name` body `{ "name" }` |
| Set context | PATCH | `/api/workflows/:id/context` body `{ "conversationContext" }` |
| Add step | POST | `/api/workflows/:id/steps` or MCP `add_step` |
| Edit step | PATCH | `/api/workflows/:id/steps/:stepId` or MCP `edit_step` |
| Delete step | DELETE | `/api/workflows/:id/steps/:stepId` |
| Start | POST | `/api/workflows/:id/start` |

## Workflow steps (Target engine)

When running **inside a Target workflow step**, use **TCP tools** from the injected catalog (`POST /api/tcps/execute?stepId=…&token=…`) instead of the admin token.
