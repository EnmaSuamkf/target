# Failure recovery

Without it, a step that uses up its retries stops its workflow: the step is
`failed`, the workflow is `failed`, and an operator has to work out what went
wrong. **Failure recovery** lets a step opt into a second chance at the *plan*
level: when it fails for good, the hub sends a **recovery agent** that reads
why it failed, changes the workflow's plan so it can succeed, reopens the step
and relaunches the workflow.

**The recovery agent never edits code or files in the working directory.** It
rewrites the plan (step text, acceptance criteria, retries, a command step's
inputs, the pending steps); the code is written by the step's own agent when
the step runs again.

## Turning it on

| Field | Level | Default | Meaning |
|---|---|---|---|
| `recoverOnFailure` | step | `false` | The **Recover on failure** toggle. |
| `maxRecoveries` | step | `1` | How many recoveries this step may use (integer ≥ 0). |
| `recoveryCount` | step | `0` | How many it already used. Owned by the hub; reset only by **Start over** (`restartWorkflow`). |
| `recoveryModel` | workflow | `null` | The model the recovery agent runs with. `null` = the CLI's default model. |

- **UI:** the add-step dialog and the step editor have the **Recover on
  failure** switch and a **Max recoveries** field (active only while the switch
  is on). The workflow page has a **Recovery model** selector next to the
  **Model** one, offering *CLI default* plus the runner's enabled models
  (Settings > Agent models). Template steps carry the same two fields.
- **HTTP API (admin token):** `POST /api/workflows/:id/steps` and
  `PATCH /api/workflows/:id/steps/:stepId` accept `recoverOnFailure` (boolean)
  and `maxRecoveries` (integer ≥ 0; anything else is `400`); an edit that omits
  them keeps the stored values. `POST /api/workflows` and the clone route accept
  `recoveryModel`; `PATCH /api/workflows/:id/recovery-model` with
  `{"recoveryModel": "<id>" | null}` changes it (an id the runner has not
  enabled is `400`).
- **MCP:** `add_step` / `edit_step` (`recoverOnFailure`, `maxRecoveries`),
  `create_workflow` / `clone_workflow` (`recoveryModel`), `set_recovery_model`,
  `set_workflow_model`, `reopen_step`.
- **Templates, bundles, clone and target-server** keep the fields: a template
  stores them per step, an exported bundle carries them (an older bundle reads
  the defaults), applying a template seeds them, cloning copies them (not the
  used count) and the recovery model, and the remote commands of
  target-server (`step.add`, `step.edit`, `workflow.create`) accept
  `recover_on_failure`, `max_recoveries` and `recovery_model`.

Pick a recovery model **stronger** than the workflow's: it has to understand a
failure and rewrite the plan, often a harder job than the step itself.

## What triggers a recovery

Only a step with `recoverOnFailure: true` and `recoveryCount < maxRecoveries`,
and only when it fails **for good**:

- its **judge rejects** it with no retries left (also on a &#9654; one-off run
  whose rejection would fail the workflow);
- its **pipeline fails** with no retries left (a command step, after its
  on-failure agent, if any) — the pipeline must actually have run;
- it **times out** with no retries left.

These never trigger it — they are not problems with the plan:

- the awb hook or broker is down, or the dispatch failed;
- the model hit a usage limit (or the run failed for another runner error);
- a pipeline refused before anything ran (untrusted, revoked or missing);
- the judge's verdict could not be read, or the judge could not run;
- an operator abort.

Once `recoveryCount` has reached `maxRecoveries`, the step fails exactly as it
would without the toggle. With the toggle off, nothing changes.

## What happens during a recovery

1. The workflow's status becomes **`recovering`** (not `failed`), the step's
   `recoveryCount` goes up by one, and a `step.recovery` event with
   `action: "started"` and the failure reason is emitted.
2. The hub creates or refreshes a second awb hook, `<agentName>-recovery`: a
   copy of the workflow's hook (same runner, workdir, sandbox block and
   permission mode) with `model` set to the recovery model. The recovery job
   goes to that hook in a **new session**: it does not resume the workflow's
   conversation.
3. The recovery agent's prompt names the workflow, the failed step, the kind
   of failure and its reason, the hub's own base URL, a **recovery token**, and
   copy-pasteable `curl` examples for every recovery route.
4. While it runs, nothing else is dispatched on the workflow, and the operator
   cannot add, edit, move, delete or reopen its steps, nor start, restart or
   run it (`409 {"error":"recovering"}`). The operator **can** stop it:
   **Stop recovery** in the UI, or `POST /api/workflows/:id/recovery/abort`.

It ends one of two ways:

- **Relaunched** — the agent calls the relaunch route. The failed step is
  reopened (pending, `retryCount` 0, `recoveryCount` kept), every pending step
  is selected, and the workflow continues **in its existing conversation**.
  Event `step.recovery` `relaunched`; a notification is sent.
- **Gave up** — the agent calls the give-up route, its turn ends without a
  relaunch, its run fails, the operator aborts it, or the watchdog finds it
  running longer than the hard step timeout. The step stays `failed` (a step it
  reopened goes back to failed) and the workflow becomes `failed`. Event
  `step.recovery` `gave_up` with the reason; a notification is sent.

The recovery's history is `GET /api/workflows/:id/recoveries` (status,
failure kind, reason, changes, notification outcome; never the token).

## What the recovery agent can change

Its own workflow only — never other workflows, the conversation context, done
steps, or code:

- the failed step and any pending step: `description`, `acceptanceCriteria`,
  `maxRetries`, `retryIntervalSeconds`, `useSubagent`, `manualReview`,
  `recoverOnFailure`, `maxRecoveries`, and for command steps `pipelineInputs`,
  `onSuccessTask`, `onFailureTask` (a step's kind and pipeline cannot change);
- add a step, delete a pending step, move a pending step;
- add a note, reopen the failed step, relaunch, give up.

## The recovery API

Base: `<hub>/api/recovery/<workflowId>`, with
`Authorization: Bearer <recovery token>`.

The token is minted when the recovery starts, given to the agent in its
prompt, and stored only as a hash. It is valid **only for that workflow and
only while that recovery runs**: it expires the moment the recovery relaunches,
gives up or is aborted. The admin token and login sessions are not accepted on
these routes, and a recovery token is accepted nowhere else. No token is
`401`; a wrong, expired, admin, or other-workflow token is `403`. The agent
does **not** use the Target MCP (which holds the admin token and may point at
another hub).

| Request | Purpose |
|---|---|
| `GET /api/recovery/:wf` | The workflow and its steps, plus the failed step's result, error, judge reason, notes and a transcript excerpt. |
| `PATCH /api/recovery/:wf/steps/:stepId` | Edit the failed step or a pending step. Body: the fields above plus `reason`. |
| `POST /api/recovery/:wf/steps` | Add a step (`afterStepId` to place it; omit to append). |
| `DELETE /api/recovery/:wf/steps/:stepId` | Delete a pending step. |
| `POST /api/recovery/:wf/steps/:stepId/move` | Move a pending step: `{"direction":"up"|"down","reason":...}`. |
| `POST /api/recovery/:wf/steps/:stepId/notes` | Add a note: `{"content":...}`. |
| `POST /api/recovery/:wf/steps/:stepId/reopen` | Reopen the failed step (the relaunch does it too). |
| `POST /api/recovery/:wf/relaunch` | End the recovery by relaunching: `{"summary":...}`. |
| `POST /api/recovery/:wf/give-up` | End the recovery without relaunching: `{"reason":...}`. |

Every change needs a non-empty `reason`. Example:

```sh
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:8893/api/recovery/$WF/steps/$STEP \
  -d '{"reason":"make the criteria match the task","acceptanceCriteria":"out.txt contains exactly the word hello"}'
```

## Notes, events and notifications

- **Notes.** Every change writes a note on the changed step:
  `Recovery: <field>: <before> → <after>` followed by `Reason: …`. The relaunch
  and the give-up leave a note too ("Recovery relaunched the workflow: …",
  "Recovery gave up: …"). The UI tags them **Failure recovery**.
- **Events** (report stream, also sent to target-server):
  - `step.recovery` with `data.action` = `started` | `relaunched` | `gave_up`,
    `data.reason` (why the step failed, or why it gave up) and `data.changes`
    (a short before → after summary; empty at `started`), plus `recovery_id`,
    `failure_kind`, `recovery_count`, `max_recoveries`;
  - `workflow.status_changed` with `to: "recovering"` (and back to `running` or
    `failed`);
  - `workflow.plan` snapshots carry per step `recover_on_failure`,
    `max_recoveries`, `recovery_count`, and `recovery_model` for the workflow;
    `workflow.created` / `workflow.updated` carry `recovery_model`.
- **Notifications.** The notifier that sends the manual-review ping
  (Settings > Notifications) also sends one when a recovery relaunches and one
  when it gives up, naming the workflow, the step, the reason and the changes.
  Delivery is advisory: whether it was sent, or why not (for example
  `notifications-disabled`), is recorded on the recovery and in the hub log.

## Writing steps for it

Failure recovery is a safety net for a plan that turns out wrong, not a reason
to write vague steps. Acceptance criteria should still be **observable
outcomes** a judge can check (a file exists with given content, a command
passes, a URL answers). A recovery that cannot see why a step failed can only
give up.
