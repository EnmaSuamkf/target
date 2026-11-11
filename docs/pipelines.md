# Pipelines and command steps

> Status: Phase 1 and Phase 2 implemented. Phase 1 is the hub side; Phase 2 adds
> the server catalog (`target-server`) and the hub's sync of pipelines. The text
> below describes what exists. Where the first design differed, the difference
> is written in place, and the limitations are listed under
> [Phases](#phases) and [Open questions](#open-questions).

A **pipeline** is a list of shell commands, written in YAML in the style of a
GitHub Actions job. A workflow runs a pipeline through a **command step**: a step
the hub executes itself, with no agent, no session and no tokens spent. If the
pipeline fails, the step fails, the same way a CI run fails.

The goal is to keep work that does not need a model away from the agent.
Installing dependencies, running tests, pulling a branch or waiting for a deploy
are deterministic. The hub runs them, and the agent only gets what it needs to
act on: the result.

## Concepts

| Term | What it is |
| --- | --- |
| Pipeline | A catalog entity, like a TCP or a Resource Set. It holds the YAML source. It can be created, edited, imported, exported and synced. |
| Command step | A workflow step with `kind: "command"`. It references one pipeline and gives it input values. |
| Pipeline run | One execution of a pipeline by a command step. It records each pipeline step's status, exit code, duration and log. |
| Pipeline step | One entry of the YAML `steps:` list. Called a *job step* below to keep it apart from workflow steps. |

## Example

```yaml
name: verify
description: Install, typecheck and test one package.

inputs:
  package:
    description: Directory of the package to verify.
    default: hub

env:
  CI: "1"

timeout-minutes: 15

steps:
  - name: Install
    run: npm ci
    working-directory: ${{ inputs.package }}
    report: false

  - name: Typecheck
    run: npm run typecheck
    working-directory: ${{ inputs.package }}

  - name: Tests
    run: npm test
    working-directory: ${{ inputs.package }}
    continue-on-error: true
    timeout-minutes: 10
    env:
      API_TOKEN: ${{ secrets.API_TOKEN }}

  - name: Collect coverage
    if: always()
    run: cat coverage/summary.txt
    working-directory: ${{ inputs.package }}
```

## YAML schema

The schema is a subset of a GitHub Actions job. A `steps:` list copied from a
`.github/workflows/*.yml` file should work unchanged as long as it only uses
`run:` steps. Target adds one key, `report`.

### Top level

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | Display name. |
| `description` | string | no | Shown in the catalog. |
| `inputs` | map | no | Values the command step passes in. See [Inputs](#inputs). |
| `env` | map of string | no | Environment for every job step. |
| `timeout-minutes` | number | no | Limit for the whole run. Default 30, maximum 360. |
| `defaults.run.shell` | string | no | Shell for every job step. Default `bash`. |
| `defaults.run.working-directory` | string | no | Directory for every job step, relative to the workflow's workdir. |
| `runs-on` | string | no | Only `host` is accepted in v1. See [Where a pipeline runs](#where-a-pipeline-runs). |
| `steps` | list | yes | At least one job step. |

### Job steps

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | no | Display name. Default: the first line of `run`. |
| `id` | string | no | Unique in the pipeline. Reserved for referencing outputs in a later version. |
| `run` | string | yes | The commands. A block scalar (`|`) runs as one script. |
| `shell` | string | no | `bash`, `sh` or `pwsh`. Overrides `defaults.run.shell`. |
| `working-directory` | string | no | Relative to the workflow's workdir. Must stay inside it. |
| `env` | map of string | no | Merged over the top-level `env`. |
| `if` | string | no | `success()` (default), `failure()` or `always()`. |
| `continue-on-error` | boolean | no | A non-zero exit marks this job step failed but does not fail the run. |
| `timeout-minutes` | number | no | Limit for this job step. |
| `report` | boolean | no | Target only. Default `true`. With `false`, this job step's output is not sent to the agent, unless the job step failed. |

### Inputs

```yaml
inputs:
  package:
    description: Directory of the package to verify.
    required: false
    default: hub
```

Every input is a string. A command step must give a value for each input that
is `required: true` and has no `default`. An input the pipeline does not declare
is an error.

### Rejected keys

Unknown keys are errors, not warnings. A misspelled key, such as
`continue_on_error`, must not be silently ignored. The error suggests the
closest valid key.

These GitHub Actions keys are recognised and rejected with a clear message,
because v1 does not support them: `on`, `jobs`, `needs`, `strategy`, `matrix`,
`services`, `container`, `uses`, `with`, `outputs`.

## Parsing and validation

The hub parses pipelines with the [`yaml`](https://www.npmjs.com/package/yaml)
package (eemeli/yaml). It is the hub's first runtime dependency. It has no
dependencies of its own, it ships TypeScript types, and `parseDocument` keeps
source positions, so errors can name a line.

- **YAML 1.2.** The parser runs in its default YAML 1.2 mode. `on`, `yes` and
  `no` stay strings; in YAML 1.1 they become booleans.
- **No aliases.** Anchors and aliases (`&`, `*`) are rejected, which also rules
  out alias-expansion attacks. The document size is capped at 64 KiB.
- **Source is the truth.** The database stores the YAML text as written,
  comments included. The hub parses it when it is saved (to validate it) and
  again when it runs. Export, import and sync carry the text.
- **Schema validation is hand-written.** The hub has no schema library. The
  validator walks the parsed document and returns every error it finds, not
  only the first, each one with its line:

  ```json
  {
    "ok": false,
    "errors": [
      { "line": 14, "path": "steps[2]", "message": "\"run\" is required" },
      { "line": 9, "path": "steps[0]", "message": "unknown key \"continue_on_error\" (did you mean \"continue-on-error\"?)" }
    ]
  }
  ```

- **One implementation.** The UI editor validates through
  `POST /api/pipelines/validate`. It does not parse YAML in the browser, so the
  errors in the editor are exactly the errors a run would give.

The `yaml` package goes in `hub/package.json` `dependencies`.
`npm run target:install` already installs the hub's dependencies
(`scripts/install.ts`, step "[2/7] hub dependencies"), and the desktop apps
already refuse to start without `hub/node_modules`.

## Expressions

`${{ … }}` expressions are resolved when the run starts, never when the YAML is
parsed. Only these are allowed:

| Expression | Value |
| --- | --- |
| `${{ inputs.<name> }}` | The command step's value for that input |
| `${{ secrets.<NAME> }}` | A secret configured on this hub (see [Secrets](#secrets)) |
| `${{ workflow.workdir }}` | The workflow's absolute working directory |
| `${{ workflow.id }}`, `${{ workflow.name }}` | The workflow's id and name |
| `${{ step.results_dir }}` | The workflow's step-results directory |

There are no operators, functions or literals, other than the three `if:`
functions above.

### Expressions are not allowed in `run`

Putting a value directly into a shell script is shell injection. An input like
`main; rm -rf ~` would run. This is a known problem with GitHub Actions, and
GitHub's own advice is to pass values through the environment instead.
Target enforces that rule:

- `${{ … }}` in `run` is a validation error.
- `${{ … }}` is allowed in `env`, `working-directory` and `if`.
- Every input is also exported automatically as `INPUT_<NAME>`, with the name
  upper-cased and `-` turned into `_`. A script reads it as `"$INPUT_PACKAGE"`.

```yaml
- name: Checkout
  env:
    BRANCH: ${{ inputs.branch }}
  run: git checkout "$BRANCH"
```

## Secrets

Secrets live on the hub, in a store separate from TCP tool tokens. Each secret
has a `NAME` and a value. A pipeline reads one through `${{ secrets.NAME }}`,
and only in `env`.

- Values are never exported, synced or returned by the API. A read returns the
  names and whether each one is set.
- Every value is passed to `registerSecret` (`hub/redact.ts`) before the run
  starts. Every log line goes through `redactSecrets` before it is written to
  disk, stored or sent to the agent, so a script that prints a secret produces
  `***`.
- A run that references a secret with no value fails before any job step
  starts, with `missing secret: NAME`.

## Where a pipeline runs

In v1 a pipeline runs **on the host**, as a child process of the hub, in the
workflow's working directory.

A workflow whose hook runs in a docker sandbox cannot use command steps in v1.
Adding a command step to it is refused. Running one would put commands on the
host while the agent's work happens in the container, with different tools,
paths and isolation. `runs-on: sandbox`, which would run the pipeline in a
container with the same image and mounts as the hook (`hub/docker-mounts.ts`),
is planned for a later version. Today `runs-on` only accepts `host`.

Each job step runs as its own process group, so a timeout or an abort can kill
everything it started.

## Execution and failure

The run follows GitHub Actions semantics.

1. Job steps run in order.
2. A job step that exits non-zero, or times out, is `failed`. Without
   `continue-on-error` it also fails the run. Every later job step is then
   `skipped`, unless its `if` is `failure()` or `always()`.
3. A job step with `continue-on-error: true` that fails is recorded as `failed`,
   but the run keeps going and can still succeed.
4. The run's conclusion is `success` or `failure`. A run that is stopped by the
   pipeline's `timeout-minutes` or by an operator abort ends as `failure` with
   `cancelled: true`.

Job step statuses: `pending`, `running`, `success`, `failed`, `skipped`.

### What that does to the workflow step

| Run conclusion | Command step |
| --- | --- |
| `success` | `done`. The workflow advances. |
| `failure` | `failed`. The workflow fails, exactly as when an agent step fails. Continue, ▶ and Restart work as they do today. |

The command step's existing settings keep their meaning:

- `maxRetries` and `retryIntervalSeconds` re-run the **whole pipeline**. With an
  interval, this is how a pipeline waits for something outside, such as a CI
  check or a deploy.
- `manualReview` holds the step at `waiting` after a successful run, as it does
  for agent steps.
- `acceptanceCriteria` and `useSubagent` do not apply. The run's conclusion is
  the verdict, and no judge runs. A command step is always stored with
  `useSubagent: false` and `acceptanceCriteria: null` (see [Phases](#phases)).
- Abort kills the running job step's process group and fails the step with
  `error = "aborted"`.

### Letting the agent fix a failure

To let the next agent step see a failure and fix it, mark that job step
`continue-on-error: true`. The run succeeds, the workflow moves on, and the
failed job step's log goes to the agent (see the next section). No other
failure policy is needed.

## What the agent receives

A command step does not start a turn of its own. Its result is handed to the
**next agent step** that runs on the workflow's conversation.

### Prepended to the next prompt

Every command step that settled since the agent's last turn adds a block to
the next agent step's prompt. The blocks come after the conversation preamble
and the tool and resource catalogs, and before the step's own description. The
lead line is `The hub ran these pipelines since your last step:`, and it
appears once for all the blocks. If several command steps ran in a row, their
blocks are added in order (`composeStepInput`, `hub/runner.ts`):

```
The hub ran the pipeline "verify" before this step: success (1 tolerated failure).

  ✓ Typecheck         4s
  ✗ Tests    exit 1   38s   (continue-on-error)
  ✓ Collect coverage  1s

--- Tests: last 80 lines ---
…
--- Collect coverage ---
…

Full log: ~/.target/steps/<agent>/03-verify.log
```

- The summary always lists every job step.
- The log section includes a job step that failed and every job step without
  `report: false`.
- Each job step's output is cut to its last 80 lines, and the whole block is
  capped at 16 KiB. The block says when something was cut.
- The block is stored with the command step when it settles and is marked
  delivered once an agent dispatch carries it. A failed dispatch leaves it
  pending, so a retry carries it again.
- If the command step is the workflow's first step, there is no conversation
  yet. The block waits for the first agent step, as with the conversation
  context.

### On disk

The full result also goes to the step-results directory, like every other
step's result (`hub/step-results.ts`):

- `<NN>-<slug>.md`: the summary block above, so `stepResultsNote` and
  compaction recovery work as they do for agent steps.
- `<NN>-<slug>.log`: the complete, redacted output of every job step, each with
  a header line.

## Data model

### `pipelines`

| Column | Notes |
| --- | --- |
| `id` | |
| `name` | Copied from the YAML `name` on save. |
| `tags` | Same as TCPs. |
| `source` | The YAML text. |
| `source_hash` | SHA-256 of `source`. Used by trust. |
| `trusted_hash` | `source_hash` at the moment an operator approved it. Null = not approved. |
| `origin`, `sync_source`, `synced_at`, `revoked` | Same meaning as for TCPs (`hub/tcp-store.ts`). |
| `created_at`, `updated_at` | |

### `steps`

- `kind` gains a third value: `"command"`.
- New nullable columns `pipeline_id` and `pipeline_inputs` (JSON object).
- New nullable column `pending_report`: the block for the agent, until it is
  delivered. `pending_report_delivered` is set once an agent dispatch has
  carried it.

### `pipeline_runs` and `pipeline_run_steps`

One `pipeline_runs` row per attempt of a command step: `step_id`, `attempt`,
`pipeline_id`, `source_hash`, `conclusion`, `cancelled`, `started_at`,
`finished_at`, `log_path`.

One `pipeline_run_steps` row per job step: `index`, `name`, `status`,
`exit_code`, `started_at`, `finished_at`, `log_offset`, `log_length`.

### Templates

A template step can be a command step. The template stores the pipeline id and
the inputs. Seeding a workflow from the template copies them. The pipeline's
detail (`GET /api/pipelines/:id`) lists the steps and templates that use it as
`referencedBy`, and deleting the pipeline is refused while either exists. The
template editor does not show that list yet.

## Trust

A pipeline is code that runs on the operator's machine. Who can write and
approve one matters.

**The problem.** The MCP server talks to the hub with the admin bearer token
(`mcp/target-mcp.mjs`), and it exposes a generic `hub_api` tool. `isAdmin`
(`hub/server.ts`) accepts that token the same way it accepts the operator's
browser session. Any agent with the Target MCP tools could therefore create a
pipeline and a command step that runs it on the host. For an agent in a docker
sandbox, that is a way out of the sandbox.

**The rule.** A pipeline runs only if it is trusted: its `trusted_hash` equals
its current `source_hash`.

- Approving a pipeline (setting `trusted_hash`) requires the operator's
  **browser session**. The bearer token is refused with
  `403 { "error": "session_required" }`. On a linked hub it also requires
  `client.workflows.manage`.
- Saving a pipeline from the UI approves the new source in the same request,
  because the operator wrote it there.
- Saving through the bearer token (MCP, CLI, scripts) is allowed, but the
  pipeline stays or becomes untrusted until an operator approves it in the UI.
- An import, or a sync from the server that changes `source`, leaves the
  pipeline untrusted.
- A command step whose pipeline is not trusted fails at dispatch with
  `pipeline not trusted`. The UI shows the full source and an **Approve**
  button. There is no diff against the last approved version in Phase 1: the
  API does not return the approved source.

Changing the source always changes the hash, so an approval never covers code
the operator has not seen.

## Loading a pipeline

An operator gets a pipeline into Target in one of these ways. Every one of them
ends in the same trust state: a pipeline runs only after an operator saves or
approves it from the browser.

| Way | Where | Trusted after |
| --- | --- | --- |
| Write or paste | **Catalog → Pipelines → New**, in the YAML editor | **Save** |
| Upload a `.yml` / `.yaml` file | **Catalog → Pipelines → Upload YAML**, or drop the file on the editor | **Save** |
| Import a bundle exported from another hub | **Catalog → Pipelines → Import** (`.json`, as for TCPs) | **Approve** |
| Sync from the server | Automatic on **Sync resources**, `origin: server`, read-only | **Approve** |
| Through MCP or the bearer token | `POST /api/pipelines` | **Approve** |

### Uploading a YAML file

**Upload YAML** opens a file picker that accepts `.yml`, `.yaml` and
`text/yaml`. Dropping a file on the editor does the same.

1. The browser reads the file. Nothing is sent to the hub and nothing is saved
   yet.
2. The editor opens with the file's text, as a new pipeline. When the editor
   already holds unsaved changes, the operator is asked before they are
   replaced.
3. The text is validated through `POST /api/pipelines/validate`, as when typing,
   and errors are shown on their lines.
4. The operator reviews it, edits it if needed, and presses **Save**. Saving
   from the browser approves the pipeline, as for any pipeline written in the
   editor. The operator has seen exactly what will run.

Rules:

- One file per upload.
- A file over 64 KiB, the document size cap, is refused before it is read,
  with the size in the message.
- A file that is not valid UTF-8 is refused.
- The file name is not used. The pipeline's name comes from the YAML `name`.
- Uploading never overwrites an existing pipeline. To replace one, open it and
  paste the new text.

No new route is needed: the upload only fills the editor, and saving uses
`POST /api/pipelines`.

A GitHub Actions workflow file, such as `.github/workflows/ci.yml`, does not
pass validation as it is. It has `on:`, `jobs:` and usually `uses:` steps, which
are rejected (see [Rejected keys](#rejected-keys)). The operator copies the
job's `steps:` into the editor and removes the `uses:` steps.

## HTTP API

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /api/pipelines` | open read | List, without `source`. |
| `GET /api/pipelines/:id` | open read | Includes `source`, `sourceHash`, `trustedHash`, `trusted` and `referencedBy`. It does not return `errors`: the editor gets those from `validate`. |
| `POST /api/pipelines` | `client.pipelines.create` | Validates before it saves. Approved only when the caller is a session. |
| `PUT /api/pipelines/:id` (`PATCH` also accepted) | `client.pipelines.edit` | Same. `origin: server` copies are refused with 409 `server_managed`. |
| `DELETE /api/pipelines/:id` | `client.pipelines.delete` | Refused with 409 `in_use` while a step or template references it. |
| `POST /api/pipelines/:id/approve` | session only, and `client.workflows.manage` | Body `{ "sourceHash" }`, which must match the current hash. Approval is a trust decision, so it has no `client.pipelines.*` ID (see [Permissions](#permissions)). |
| `POST /api/pipelines/validate` | `client.pipelines.create` or `client.pipelines.edit` | Body `{ "source" }`. Returns `{ ok, errors }`. Saves nothing. |
| `POST /api/pipelines/import` | `client.pipelines.import` | Bundle import, as for TCPs. |
| `GET /api/pipelines/export` | `client.pipelines.export` | Exports carry the source, never secret values. Server copies are not exported. |
| `GET /api/secrets` | operator | Names, and whether each one is set. |
| `PUT /api/secrets/:name`, `DELETE /api/secrets/:name` | session only | |
| `GET /api/steps/:id/pipeline-runs` | open read | Runs and job steps for one command step. |
| `GET /api/pipeline-runs/:id/log` | operator | The redacted log. `?step=<index>` for one job step. |

### Permissions

On a linked hub, pipeline routes use the server's `client.pipelines.*` IDs, the
same way TCP routes use `client.tcp-tools.*`. Reads are never blocked. The
catalogue is in [`docs/hub-permissions.md`](hub-permissions.md#pipelines).

- Writes map to their own ID: create, edit, delete, import and export.
- `validate` takes either `client.pipelines.create` or `client.pipelines.edit`,
  because it saves nothing.
- **Approve** keeps `client.workflows.manage`. A pipeline runs on the host, so
  approving one is a trust decision, not catalogue maintenance. Nothing in TCP
  has that shape, so there is no precedent to follow. A holder of every
  `client.pipelines.*` ID who lacks `client.workflows.manage` cannot approve.
- Sync is gated by `client.pipelines.sync` on the server, not by the hub.

Steps: `POST /api/workflows/:id/steps` accepts
`{ "kind": "command", "pipelineId", "pipelineInputs" }` in place of a
description. It is refused when the workflow's hook runs in a docker sandbox,
when the pipeline does not exist, or when the inputs do not match the
pipeline's `inputs`.

## MCP

- Read: `list_pipelines` (optional `q` filter on name or tag) and `get_pipeline`
  (returns the source and `trusted`).
- Write: `create_pipeline` and `update_pipeline` save YAML through the bearer
  token. The pipeline stays untrusted until an operator approves it in the UI.
- `add_step` and `edit_step` accept `kind`, `pipelineId` and `pipelineInputs`.
  Template tools carry the same fields.
- There is no MCP tool to approve a pipeline or to read or set a secret. A test
  (`mcp/target-mcp.test.mjs`) asserts that the tool list has no such tool.
  `hub_api` uses the bearer token, so the session-only routes refuse it with
  `403 session_required`.

## UI

- **Catalog → Pipelines.** A list with **New**, **Upload YAML**, **Import** and
  **Export**, and a YAML editor. The editor validates through
  `POST /api/pipelines/validate` about 400 ms after the operator stops typing,
  shows errors under the editor and on their line numbers, and disables **Save**
  while the text is invalid. An untrusted pipeline shows the banner *This
  pipeline will not run until you approve it.* with an **Approve** button and
  the full source.
- **Settings → Secrets.** Names, set state and the last change. A value can be
  written and never read back; the field is cleared after save.
- **Step editor.** The add-step form and the template editor have an **Agent /
  Command** toggle. Command shows a pipeline picker, which marks pipelines that
  still need approval, and one field per declared input. It hides acceptance
  criteria and the subagent switch. Two gaps remain, listed under
  [Phase 1 limitations](#phase-1-limitations).
- **Step view.** A command step shows its latest run like a CI job: one row per
  job step with status, exit code and duration. A job step's log opens on
  demand, and earlier attempts are listed under the run. While the step runs,
  the view re-reads the runs every 2 seconds.
- **Step badge.** A command step shows `⌘ Command` in its header.
- **Screenshots.** The screens are in
  [`screenshots/pipelines/`](./screenshots/pipelines/): 01 pipeline list,
  02 untrusted banner, 03 editor with a validation error, 04 upload confirm,
  05 upload loaded, 06 secrets, 07 command step on a workflow, 08 run view,
  09 run log open, 10 Command step editor, 11 phone pipeline list, 12 phone run
  view.

## Reporting

Command steps emit `step.started`, `step.completed` and `step.failed` with
`kind: "command"`, `pipeline_id`, `conclusion` and per-job-step durations
(`job_steps`) in `data`. No log content is sent in report events.

A finished agent step is reported as `step.done`, not `step.completed`, so a
command step's success uses a different name from every other success. The
server dashboard knows only `step.done`. See
[Phase 1 server compatibility findings](#phase-1-server-compatibility-findings).

## Phases

The feature ships in two phases. Phase 1 changes only this repository (the
hub) and is usable on its own. Phase 2 adds the `target-server` side, for
pipelines that come from the server's catalog.

### Phase 1: hub only

Everything in this document except syncing pipelines from the server:

- the `yaml` dependency, the parser and the validator;
- the `pipelines`, `pipeline_runs` and `pipeline_run_steps` tables, and the
  `command` step kind;
- running pipelines, the report handed to the agent, and the files on disk;
- secrets and trust;
- the hub's HTTP API, the MCP tools and the hub UI.

Pipelines come from the editor, an uploaded file, a bundle import or MCP. The
The sync columns (`origin`, `sync_source`, `synced_at`, `revoked`) were created
in phase 1, so phase 2 needed no migration. Every phase 1 pipeline has
`origin: local`. Phase 2 uses them as described in [Phase 2](#phase-2-hub-and-target-server).

**Compatibility with an unchanged server.** The server's workflow canvas
(`target-server/ui/src/lib/canvasLayout.ts`) knows the step kinds `context` and
`task`. It draws a subagent node for every step that is not `context` and does
not have `useSubagent: false`, and a judge for every step with acceptance
criteria. A command step stored with the defaults would be drawn as agent
work, which is false. So in phase 1 the hub always stores command steps with:

- `useSubagent: false`;
- `acceptanceCriteria: null`.

The API refuses other values for a command step. Both fields already have no
meaning for it (see [Execution and failure](#execution-and-failure)). The server
then draws a command step as a plain step card: not marked as a command, but
not showing anything untrue either.

Report events (`step.started`, `step.completed`, `step.failed`) carry
`kind: "command"` from phase 1 on. The server accepts the unknown value and
shows the event as a generic step event. The check against
`target-server/ui/src/components/EventFeed.tsx` and
`ui/src/lib/eventSummary.ts` is in
[Phase 1 server compatibility findings](#phase-1-server-compatibility-findings).
Its one problem is the event name: a finished command step is `step.completed`,
which the server does not summarise.

### Phase 1 limitations

- No diff against the last approved source in the UI. The API does not return
  the approved source.
- The step-edit form does not know about command steps. It still shows the
  acceptance-criteria field and the subagent switch for them. Saving a command
  step with the switch on is refused by the API: `a command step runs without a
  subagent: useSubagent must be false` (`hub/workflow.ts:2012`). The form should
  hide those controls for command steps.
- The after-hold add-step modal has no Agent / Command toggle.
- A refused dispatch (`pipeline not trusted`) leaves only the step's error. The
  next agent prompt does not mention the refusal.
- A workflow restart clears every command step's pending report, by design, and
  the attempt numbers start again at 1. The run list can therefore show two
  attempts labelled 1.
- The app has no dark theme. Only the light tokens exist
  (`hub/ui/src/styles/tokens.css`), so the new screens have no dark variant.
- The end-to-end check ran `composeStepInput` from a script, not `dispatchStep`,
  because `dispatchStep` needs an awb hook.

### Phase 1 server compatibility findings

Checked against `target-server` as it stood at this revision. The server was
read only, and its working tree was clean before and after this check. Paths
are relative to `target-server/ui/src`.

**What renders without errors or false claims:**

- A command step is a numbered task card. `lib/canvasLayout.ts:223` keeps every
  step that is not `kind === "context"`, and `:261-267` builds the card. The
  `kind` field is typed `string` (`:49`), so `"command"` is accepted.
- No subagent box. `usesSubagent` returns false for `useSubagent: false`
  (`lib/canvasLayout.ts:209-210`), and the box is drawn only under the
  `if (usesSubagent(step))` guard (`:288`).
- No judge circle. `hasJudge` is false for `acceptanceCriteria: null`
  (`lib/canvasLayout.ts:200-202`), and the circle is drawn only under the guard
  at `:321`.
- The card is marked `inline` (`lib/canvasLayout.ts:277`). The server treats
  `inline` as "the session does the work itself", which is close enough: no
  agent turn runs, and no subagent is claimed.
- `step.started` gets a headline, `Step N started`
  (`lib/eventSummary.ts:294-302`). `step.failed` gets its headline and error
  text (`:310-325`).
- Keys the summariser does not take, such as `kind: "command"` and
  `pipeline_id`, become plain facts through `restFacts` (`:160-172`). Nested
  values such as `job_steps` are left to the raw payload.
- Unknown kinds do not throw. `EventFeed.tsx` renders `KindBadge`, which uses
  `kindLabel` and `kindTip` (`api/kinds.ts:88-94`), and an unknown kind falls
  back to its raw name. `EventPayload` uses the summariser's default branch
  (`lib/eventSummary.ts:364`).

**What is wrong or misleading:**

1. **Event name.** The hub reports a finished command step as `step.completed`
   (`hub/workflow.ts:2623`), while agent steps finish with `step.done`
   (`hub/workflow.ts:520` and `:608`). The server has a `step.done` case
   (`lib/eventSummary.ts:303-309`) and no `step.completed` case, so a command
   completion gets no `finished in …` headline. Its badge is the neutral info
   tone (`api/kinds.ts:99` gives the success tone to `step.done`, not to
   `step.completed`). Nothing breaks.
   Phase 2 must pick one fix: the server treats `step.completed` as an alias of
   `step.done` in `eventSummary.ts` and `api/kinds.ts`, or the hub emits
   `step.done` with `kind: "command"` and drops `step.completed`. The second
   matches how the server already reads events.
2. **Type drift.** `api/types.ts:124` types a step's kind as
   `"context" | "task"`. A command step's `"command"` is out of type at compile
   time, and the server would need a type change before it reads
   `pipelineId` or `pipelineInputs`. The phase 2 list already names
   `ui/src/api/types.ts`.
3. **No command mark on the canvas.** `canvasLayout.ts` has no command branch,
   so a command step looks like any task card. The Phase 1 doc accepts this. It
   is the place where Phase 2 adds an icon and a card that says what runs.
4. **Not checked in a browser.** The server's UI was not built or run here. The
   findings come from reading the code.

### Phase 2: hub and `target-server`

Phase 2 makes pipelines part of the server catalog and syncs them to linked
hubs. What was built, by area:

**Capability.** A hub advertises `resources.pipelines: true` on register and
heartbeat (`hub/sync.ts`, `syncClientCapabilities`). It is the only way the
server learns that the hub runs pipelines.

**Catalog domain.** `GET /api/sync/catalog` (`target-server/server.mjs`):

- `allowed.pipelines` is `true` only when the hub advertises `pipelines` and its
  owner holds `client.pipelines.sync`.
- `pipelines` is an array of `{ id, name, updatedAt, data: { tags, source,
  sourceHash } }`. It is present only for a hub that advertises the capability.
  Items follow the same per-role sync allowlist as templates and TCPs.
- The YAML text is the pipeline. A pipeline holds no secret value;
  `${{ secrets.NAME }}` only names a secret the hub owns.

**Permissions.** The server has `client.pipelines.{create,edit,delete,import,
export,sync}`, mirroring `client.tcp-tools.*`. The hub uses the same IDs for
its routes; see [Permissions](#permissions) and
[`hub-permissions.md`](hub-permissions.md#pipelines). `sync` is the
`allowed.pipelines` flag.

**Hub sync** (`hub/catalog-sync.ts`, `hub/pipeline-store.ts`). Each sync applies
the domains in this order: TCPs and Resource Sets, then pipelines, then
templates. Pipelines come before templates so a template's command step can
resolve against the same response.

- An absent domain or flag (an older server) leaves every local pipeline
  untouched.
- A local row with the same id is skipped, never overwritten.
- The hub recomputes `source_hash` from the received text. When the server's
  hash differs, it logs a warning and keeps the computed one.
- Trust follows the hash. An insert arrives untrusted. An update never writes
  `trusted_hash`, so a changed source is untrusted again, and an unchanged source
  keeps the earlier approval.
- **Invalid synced text is stored, not skipped.** The copy is kept, untrusted,
  so the operator sees its name and the error. Dispatch refuses it with
  `pipeline does not validate` (`hub/workflow.ts`). It was not skipped because a
  silently missing pipeline is harder to diagnose than a visible broken one.
  Approval stays available, as for any server copy.
- A pipeline the server no longer grants loses its `catalog` source. It is marked
  `revoked` while a step or template still references it, and deleted
  otherwise. A run of a revoked pipeline fails with `pipeline revoked`. Revoked
  copies still count as known, so those runs fail with a reason rather than the
  step disappearing.
- A template command step whose pipeline is not known to the hub after the
  pipelines domain is applied is dropped from the copy. This mirrors how
  unresolved TCP selections are filtered.
- Server copies are read-only in the API: edit and delete return
  `409 server_managed`, and approval is allowed. Only sync removes a server copy.
- The status key `CATALOG_SYNC_STATUS_KEY` stores a `pipelines` result beside the
  others, and the Settings toast shows a Pipelines line.

**Template gating for older hubs** (`target-server`, decided in phase 2). A hub
receives pipelines and command-step templates only when it advertises the
`pipelines` capability, and its owner holds `client.pipelines.sync`:

- A template with a command step is **omitted whole** from the catalogue for a
  hub that cannot run pipelines, and for a hub whose owner is not granted every
  pipeline the template runs. Dropping only the command step would give the hub
  a template that quietly does less than the server's copy, so the whole template
  is withheld instead.
- A server-side remote workflow built from such a template (`POST
  /api/sync/remote-workflows` with `template_id`, or `steps_from_template`) is
  refused with `409 capability_unsupported` for a hub without the capability, and
  with `409 pipeline_not_synced` (listing `pipelineIds`) when a pipeline is not
  granted to the hub's owner. The step is never queued.
- A command step reaches a hub as `step.add` with `kind: "command"`,
  `pipeline_id` and `pipeline_inputs`, with `use_subagent: false` and no
  acceptance criteria. Without `kind`, an older hub would create an agent step.

**Validator sharing.** Decided in phase 2 and implemented: the server has no
TypeScript build for backend code, so it cannot import `hub/pipeline-yaml.ts`.

- `target-server/pipeline-yaml.mjs` is a port of the hub validator with the same
  rules, messages, line numbers, paths and `sourceHash`. Its header says it must
  stay in lockstep with the hub file.
- One set of cases lives in two byte-identical files,
  `hub/fixtures/pipeline-conformance.json` and
  `target-server/test/fixtures/pipeline-conformance.json`. Each case is
  `{ name, source, ok, errors }`. Each repo runs every case through its own
  validator (`hub/pipeline-conformance.test.ts`,
  `target-server/test/pipeline-conformance.test.mjs`) and asserts the exact `ok`
  and `errors`. Each suite also checks the two copies are identical when the
  sibling repo is present.
- A change to a rule changes both validators and both fixture copies in the same
  change set. A rule without a fixture case is not covered and must not ship.

**Canvas and event feed** (`target-server/ui`). A command step is drawn as its own
card with a terminal glyph and `Pipeline: <name>`, with no subagent or judge
node. The event feed summarises `step.started|completed|failed` events for
command steps as the pipeline name, the conclusion, and each job step's name,
status and duration. It never shows log content.

**Known limitations in phase 2**

- The sync-roles picker (`GET /api/catalog/sync-roles`) accepts only
  `templates.edit`, `tcp-tools.edit` or `rci.edit`. An editor who holds only the
  pipeline rights cannot pick sync roles. An admin can.
- The server allows two pipelines with the same name. Only the browser upload
  refuses a collision, and only on the client.
- The hub UI shows a server copy as `from server` and read-only. It has no
  separate "updated by sync" state.
- The server UI has no dark theme. The Pipelines panel fits a 390 px phone, but
  the page as a whole still scrolls horizontally because of the existing top bar.
- Old servers: the hub advertises `pipelines: true`. A server built before this
  change validates the capability object strictly and rejects that key, so a new
  hub registering against it gets a 400. See [Open questions](#open-questions).

## Out of scope for v1

- `runs-on: sandbox` (running in the workflow's container).
- Several jobs, `needs`, `matrix`, `services`.
- `uses:` and reusable actions.
- Job step outputs (`$GITHUB_OUTPUT`) and passing values between steps.
- Running a pipeline outside a workflow, from the catalog alone.
- Conditions that skip later workflow steps based on a run's result.

## Open questions

1. **Default `report`.** Phase 1 decision: `true`. Noisy installs set
   `report: false` on the job steps that do not need to reach the agent
   (`hub/pipeline-yaml.ts`).
2. **Concurrency.** Phase 1 decision: a pipeline does **not** take awb's workdir
   lock. A pipeline and another workflow's agent can write to the same repo at
   the same time. Agent steps keep queuing on the lock as before. **Still open**
   for a later version: whether a pipeline should take the lock.
3. **Windows.** Phase 1 decision: `bash` is the default shell on every platform,
   and the hub does not detect the OS. A workflow that needs PowerShell sets
   `shell: pwsh` on the job steps. Without `bash`, a job step fails with the
   spawn error (`hub/pipeline-runner.ts`). **Still open**: whether a build on
   Windows should default to `pwsh`.
4. **Log retention.** Phase 1 decision: no size cap. A command step's logs stay
   in the workflow's step-results directory until the workflow is removed, and
   removing the workflow deletes that directory (`hub/workflow.ts:1937`).
   **Still open**: a per-workflow cap.
5. **Deployment order for the `pipelines` capability.** A hub advertises
   `resources.pipelines: true`. A `target-server` built before phase 2 rejects
   that key, and a new hub registering against it gets a 400. Ship the server
   and the hub together, or check a hub against an older server before enabling
   it. **Still open**: a capability-tolerant server release, so the order does
   not matter.
6. **Sync-role picker.** `GET /api/catalog/sync-roles` lists roles for
   `templates.edit`, `tcp-tools.edit` or `rci.edit` only. An editor who holds only
   the pipeline rights cannot choose sync roles for a pipeline. **Still open**:
   accept `pipelines.edit` there.
