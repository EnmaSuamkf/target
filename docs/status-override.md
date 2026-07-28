# Feature: Manual status override

A step's status, and a workflow's, can be **set by hand**. It's the way to say
"this actually worked" when the engine recorded otherwise, and it's marked as a
human's decision wherever the status is shown.

## Why

Every status in this engine is derived. A step's comes from its run's result
callback; a workflow's comes from its steps (`reconcileStatus` in
`hub/workflow.ts`). That is right almost always, and wrong in one recurring
case: the agent **did** the work, but the run never got to say so —

- it ran out of context/tokens mid-answer and the harness returned an error;
- the result callback was lost (broker restarted, network blip), so the step sat
  until the idle watchdog failed it;
- the judge rejected a result that was, on inspection, fine.

The step is then `failed`, the workflow is `failed` with it, and the progress bar
shows a red segment for work that is sitting finished on disk. Before this
feature the only ways out were re-running the step — burning tokens to redo work
that's already done, on a workflow whose later steps have already run past it —
or editing the SQLite file by hand. Both are worse than letting a person state
the outcome.

## What can be set

Only settled statuses. The in-flight ones are not opinions, they're facts about
a job that is or isn't running, and asserting one would leave a step no callback
will ever settle.

| | Allowed | Refused |
|---|---|---|
| Step | `done`, `failed`, `pending` | `running`, `queued` (the engine owns them), `waiting` (the manual-review gate owns it — press Continue) |
| Workflow | `completed`, `failed`, `paused`, `draft` | `running`, `waiting` (same reasons) |

Two more refusals, both about a job that is actually in flight:

- a **step** that is `running` or `queued` can't be overridden — its callback is
  still coming and would overwrite whatever was written. Abort it first; that is
  exactly what Abort is for;
- a **workflow** can't be overridden while any of its steps is `running` or
  `queued`, for the same reason.

## Semantics

The rules, in full, because "force a status" invites more than it should:

1. **An override never runs anything.** It records a verdict. Correcting a
   `failed` step to `done` cannot re-fire it (`nextPendingStep` only ever returns
   a `pending` step) and cannot advance the workflow (only `advance()`
   dispatches, and nothing on this path calls it). A step put back to `pending`
   is not run now either — it runs on the next Start, if it's selected.
2. **Nothing about the run is invented.** The stored result, session id, retry
   count and `finished_at` are left as they are, so the transcript still tells
   the true story; only the verdict changes. Two exceptions, both to remove a
   contradiction rather than create one: a step forced to `done` drops its
   `error` (a red error body under a green badge is what this feature is here to
   fix), and one forced back to `pending` clears `finished_at`, because a step
   that is going to run again has not finished.
3. **A step override re-derives the workflow.** Fixing the last failed step of a
   run should clear the workflow's `failed` badge without a second action, so the
   ordinary reconciliation runs afterwards — which means it still leaves a
   `running` workflow to the engine.
4. **A workflow override is sticky, but not permanent.** It's pinned against
   re-derivation until the engine authors a status again: Start, Stop, Resume,
   Start over, or any step callback. Without the pin the correction would be
   undone within two seconds — `reconcileStatus` runs on every workflow GET, and
   the UI polls. After a re-run the steps are telling the truth again, so the pin
   goes.
5. **A step's marker clears when the step runs again.** Any dispatch or reset
   (`markStepRunning`, `markStepQueued`, `startManualRun`, `beginRetry`,
   `resetSteps`) re-authors the status, so the human's marker would be stale.

## Where it shows

- **Progress %** — `stepProgress` counts `status = 'done'`, so a manually-done
  step counts like any other. That's the point: the bar has to agree.
- **The status file** (`~/.target/<name>-<id>.md`) — the workflow's `Status:`
  line reads `completed (set manually at <ISO>)`, and an overridden step carries
  a `Status set manually at <ISO>` line. A file that didn't say so would read as
  evidence of a run that never happened.
- **The UI** — the badge carries a small pencil marker, with the timestamp in its
  tooltip, in the workflow list, the workflow header and every step row. The
  colour is deliberately unchanged: the status means the same thing however it
  was reached.

## Storage

Two columns on each of `workflows` and `steps`:

| Column | Meaning |
|---|---|
| `status_manual` | 1 when the CURRENT status was set by a human |
| `status_manual_at` | when that happened; null otherwise |

Added idempotently by the same `addColumn` upgrade path as every earlier column
(`hub/db.ts`), so existing databases pick them up on the next open and old rows
read as engine-set.

`setWorkflowStatus(id, status, { manual: true })` is the only way to raise the
workflow's marker; every other caller in the codebase omits the option and
therefore **clears** it, which is what bounds the pin in time (rule 4 above).

## Using it

**Web / mobile UI.** A `Set status…` picker sits with the run controls on the
workflow header, and another in each step's action row. Picking an option asks
for confirmation and then applies it; the picker never holds a value, because
the step's real status is the badge above it. On a phone both take a full-width,
thumb-sized row of their own.

**HTTP API** (admin token, like every mutating route):

```
POST /api/workflows/:id/status              {"status": "completed"}
POST /api/workflows/:id/steps/:stepId/status {"status": "done"}
```

Both answer `400` with `status must be one of: …` for a status the engine owns,
and `400` when a job is in flight.

**CLI:**

```sh
target show <workflowId>                              # lists the step ids
target set-status <workflowId> completed
target set-step-status <workflowId> <stepId> done
```

## Tests

`hub/status-override.test.ts`, covering the column migration on a
pre-override database, each rule above, the in-flight refusals, the `.md`
markers, and the two HTTP routes (auth, validation, and the fact that a `GET`
— which runs the read-path heal — keeps reporting the corrected status).
