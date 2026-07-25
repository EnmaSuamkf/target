# Feature: Timeout retries

When a step fails because of a timeout, and it still has retries available
(`maxRetries` minus retries already used), it is **retried** instead of
failing the step and the workflow outright.

## Why

`maxRetries` used to apply only to judge rejections: a step whose acceptance
evaluation failed was re-run with feedback until the budget was spent. A
timeout, however, was always terminal — one hung run (a slow model, a stuck
tool, a broker hiccup) killed the whole workflow even when the operator had
explicitly granted the step retries. Timeouts are the most transient failure
mode of all, so they are exactly what a retry budget is for.

## Behavior

The lazy stale-step sweep (`expireStale` in `hub/workflow.ts`, run on every
workflow read) now decides per timed-out step:

1. **Budget left** (`retryCount < maxRetries`) — the timeout consumes one
   retry, mirroring the judge-reject path:
   - `beginRetry` puts the step back to `pending` and bumps `retryCount`
     (synchronously, so the read that triggered the sweep already sees it).
   - The hung run is best-effort killed on the broker (`abortAwbRun`), so it
     stops holding the workdir `flock` — otherwise the retry would just queue
     behind the zombie until it too timed out.
   - The step's `retryIntervalSeconds` is honored before the re-run.
   - The re-dispatch resumes the workflow's shared session and appends a note
     that the previous attempt timed out, so the agent continues from any
     partial progress instead of starting over blind.
   - If the step was resolved another way while waiting (abort, restart,
     manual ▶ run), the retry backs off — whatever resolved it wins.
   - A manual ▶ run's timeout retry keeps its `manualRun` flag and stays
     outside the sequential engine, exactly like a judge-reject retry.
2. **Budget spent** (or `maxRetries: 0`, the default) — unchanged behavior:
   the step is marked `failed` with `error: "timeout"` and a still-`running`
   workflow that owned it is failed too.

Both timeout clocks use the same rule: `stepTimeoutMs` for `running` steps
(measured from the broker's `started` callback) and `queuedTimeoutMs` for
`queued` steps (measured from `queued_at`).

## Implementation notes

- `expireStaleSteps` (`hub/db.ts`) now returns `(stepId, workflowId)` pairs
  instead of just workflow ids, so the caller can decide per step.
- The re-dispatch is fire-and-forget: the read-path caller of `expireStale`
  is never blocked by the retry interval or the dispatch round-trip.
- `dispatchStep` (`hub/runner.ts`) accepts `timedOut: true`, which appends
  the "previous attempt timed out — continue from partial progress" note to
  the exec input.

## Tests

`hub/workflow.test.ts` covers:

- a timed-out step with retries available is retried, not failed;
- a timed-out step with no retry budget fails the step and the workflow;
- a timed-out step whose budget is spent fails for good on the next timeout;
- a timed-out `queued` step also uses its retry budget (and keeps its
  `manualRun` flag).
