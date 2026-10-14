# Abort

Abort force-fails a step that is `running` or `queued` so the operator can
re-run it, and stops the agent process that was holding the workdir. A step held
at its manual-review gate is a different job under the same button (it rejects
the result and stops the workflow); nothing is running there, so nothing is
killed and the response carries no `abort` outcome.

## Flow

1. `abortStep` (`hub/workflow.ts`) calls `abortAwbRun` (`hub/awb.ts`), which
   POSTs `/hook/<name>/abort` `{ jobId: <stepId> }` to the local broker and
   **waits** for the verdict (fetch timeout 15s; the broker's worst case is ~9s).
   While it waits, the broker's own "run failed" callback for the killed agent is
   ignored for that step (`abortingSteps` in `hub/workflow.ts`); otherwise it would
   fail the step as `run failed` or spend a retry re-dispatching it.
2. Whatever the verdict, the step is then settled exactly as before: `failed`
   with error `"aborted"`, workflow `failed`. Abort never refuses and there is no
   extra persisted status, so a stuck step can always be failed.
3. The outcome goes into the `step.failed` report event (`abort_result`,
   `abort_confirmed`, `abort_signal`) and an automatic step note.
4. `POST /api/workflows/:id/steps/:stepId/abort` and the sync command
   `step.abort` return `abort: { result, confirmed }` next to the existing fields.
   The UI shows "Aborting…" while the request is pending and toasts the result.

## Outcomes

| `result` | `confirmed` | Meaning | Step note |
| --- | --- | --- | --- |
| `killed` | yes | the broker signalled the process group and saw it exit | Abort: agent process stopped (SIGINT) |
| `cancelled_queued` | yes | the job had not started; it was cancelled | Abort: cancelled before it started |
| `not_running` | no | the broker had nothing to kill (it may have just finished) | Abort: nothing was running |
| `kill_failed` | no | the signals were sent but the process did not exit | Abort: COULD NOT confirm the agent stopped (kill_failed) — it may still be running; check the workdir |
| `unreachable` | no | broker down, timed out or answered non-2xx | same, with `(unreachable)` |
| `not_local` | no | the hook is not on this machine's broker | same, with `(not_local)` |

An older broker only answers `{ killed }`: `true` maps to `killed`, `false` to
`not_running`, and neither is `confirmed`, since the old broker never verified the
exit.

## The interruption note on the next attempt

Aborting marks the step as interrupted (`steps.interrupted`, set by
`failRunningStep` only for an operator abort). The next exec dispatch of that step
— ▶ re-run, Restart or a retry — consumes the marker and appends `ABORT_NOTE`
(`hub/runner.ts`): the previous attempt was interrupted by the operator, so the
agent should inspect the working directory and not assume earlier edits were
completed or reverted. It is not added on first runs, timeout retries (which keep
their own note) or judge-reject retries. A column is used instead of reading
`error === "aborted"` because Restart clears `error` before re-dispatching.

## Why nothing is sent into the live conversation

Telling the running agent "you were aborted" is deliberately not done:

- headless runs are **one turn per process**: there is no live conversation to
  talk into, only a process to stop;
- a resumed message would queue behind the workdir lock held by the very run being
  aborted;
- or it would race on the same session file;
- and an LLM reply is not a reliable stop signal anyway.

The interruption is communicated when the step is next resumed (above).

## Limitation: visible mode

Aborting a run started with awb's `--visible` is best-effort. The registered pid is
the `gnome-terminal` client's; the agent lives under `gnome-terminal-server`, so the
broker can report `killed` while the agent keeps going in its window (close the
window to stop it). Docker-sandboxed runs are fine. When in doubt, check the workdir.
