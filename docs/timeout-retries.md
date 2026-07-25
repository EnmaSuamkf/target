# Feature: Idle timeout (progress watchdog) + timeout retries

A step is no longer failed for taking long. It's failed for going **silent** —
for showing no sign of progress for `stepIdleTimeoutMs` — or for blowing past
the absolute ceiling `stepHardTimeoutMs`. A step that does time out and still
has retries available (`maxRetries` minus retries already used) is **retried**
instead of failing the step and the workflow outright.

## Why

The original timeout was a plain wall clock: 20 minutes after the broker
reported the run had started, the step was marked `failed` with
`error: "timeout"`. The hub had no way to tell a hung agent from one that was
simply working on a long task, so a genuinely-working step was killed mid-work
— and, with `maxRetries: 0` (the default), that failed the whole workflow. The
retry budget softened the symptom but not the cause: the wall clock was the
wrong question.

What the hub *can* observe is the trail the harness leaves on disk while it
works. That turns "have 20 minutes passed?" into "has anything happened
recently?", which is the question that actually distinguishes hung from busy.

## Progress signals

`hub/progress.ts` looks for the most recently modified artifact belonging to
the step's agent, newest wins:

| Kind | Where | Notes |
|---|---|---|
| `transcript` | `~/.claude/projects/<workdir-slug>/*.jsonl` and `<session>/subagents/*.jsonl` | Claude Code. The subagent transcripts are the ones that move, since every step delegates its real work to a subagent. |
| `session-file` | the free-code session `.jsonl` (its path *is* the session id), else `<awbDir>/sessions/<agent>/*.jsonl` | free-code. |
| `run-log` | `<awbDir>/logs/<agent>-<epoch>.log` | Harness-agnostic fallback. |

It's a `stat`, not a parse: no extra API calls, no protocol change, nothing
added to the hook↔broker contract. The whole project tree is watched rather
than one file because a resumed run only reports its session id in the final
callback — while the step is in flight the hub doesn't know which file is its.

Two guards keep the signal honest:

- Progress is recorded only when the artifact's **fingerprint**
  (`path|mtime|size`) changes. A file that merely still exists is not progress.
- A signal older than the one already stored is ignored, so a stale run log
  can't drag the clock backwards.

If **nothing** is found (unknown harness, remote hook, deleted transcripts) the
step simply times out on the idle clock the way it used to on the wall clock —
the watchdog degrades, it never blocks.

## States

Derived, display-only; the DB's `status` enum is untouched (it still drives the
badge, the progress bar and the workflow-status reconciliation):

| State | Meaning |
|---|---|
| `running-active` | progress within `stepIdleWarnMs` |
| `running-idle` | quiet for a while, still under the idle timeout — shown in amber, nothing acts on it |
| `stalled` | no progress for `stepIdleTimeoutMs` → takes the timeout path |
| `timed-out-hard` | past `stepHardTimeoutMs` since `started_at`, however busy it looks |

They're exposed as `activity` on every step in the API and rendered next to the
step's elapsed time ("active 8s ago" / "no activity 6m").

## The sweep, in two phases

`expireStale` (`hub/workflow.ts`) used to fail every step past the clock in a
single SQL statement. Now:

1. `findTimeoutCandidates` (`hub/db.ts`) **reads** the steps whose clocks have
   run out (idle, hard cap, or the unchanged `queued` clock). Nothing is failed.
2. Each `idle` candidate is **re-probed** against the filesystem, unthrottled.
   One whose agent demonstrably wrote something recently is left alone and
   logged as still active; only silence proceeds to the timeout path.

Steps are also probed opportunistically on every sweep (throttled to
`progressProbeThrottleMs`), which is what keeps the UI's activity label live
instead of only discovering the truth at the deadline.

## Behavior on timeout (unchanged)

1. **Budget left** (`retryCount < maxRetries`) — the timeout consumes one retry:
   - `beginRetry` puts the step back to `pending`, bumps `retryCount` and clears
     the progress clock, so the next attempt starts fresh.
   - The hung run is best-effort killed on the broker (`abortAwbRun`), freeing
     the workdir `flock`.
   - The step's `retryIntervalSeconds` is honored before the re-run.
   - The re-dispatch resumes the shared session with a note that the previous
     attempt timed out, so the agent continues from partial progress.
   - If the step was resolved another way while waiting (abort, restart, manual
     ▶ run), the retry backs off — whatever resolved it wins.
2. **Budget spent** (or `maxRetries: 0`, the default) — the step is marked
   `failed` and a still-`running` workflow that owned it is failed too.

The only thing that changed is *when* a timeout is declared. The `error` now
says why: `timeout (no progress for 12m; last signal: transcript at …)` or
`timeout (hard cap: 6h 3m running)`.

## Configuration (`~/.target/config.json`)

| Key | Default | Meaning |
|---|---|---|
| `stepIdleTimeoutMs` | `600000` (10 min) | No sign of progress for this long → stalled. |
| `stepIdleWarnMs` | `180000` (3 min) | When the UI starts showing the step as idle. Display only. |
| `stepHardTimeoutMs` | `21600000` (6 h) | Absolute ceiling, regardless of activity. |
| `progressProbeThrottleMs` | `5000` | Minimum gap between filesystem probes of the same step. |
| `queuedTimeoutMs` | `21600000` (6 h) | Unchanged: a `queued` step whose run never started. |
| `stepTimeoutMs` | `1200000` (20 min) | **Legacy.** No longer a wall clock. A config that sets it (and not `stepIdleTimeoutMs`) has that value used as the idle timeout. |

The sweep also runs on a 60s interval in `hub/daemon.ts`, so a stalled step is
noticed (and its workdir lock freed) on an unattended hub — previously it only
ran on workflow reads, i.e. only while someone had the UI open.

## Implementation notes

- `hub/progress.ts` (new): the probe, the derived-state helper, the per-step
  probe throttle. Read-only and best-effort: any fs error yields "no signal".
- `hub/db.ts`: `last_progress_at` / `last_progress_kind` / `last_progress_token`
  columns (added via the existing `addColumn` upgrade path, so old DBs migrate
  themselves), `recordStepProgress`, `listRunningSteps`, `findTimeoutCandidates`
  + `failTimedOutStep` replacing `expireStaleSteps`.
- The clock is *seeded* with the run start by `markStepRunning` /
  `promoteQueuedToRunning`, re-seeded by `markStepJudging` (the judge doesn't
  inherit the exec run's inactivity) and cleared by `beginRetry`, `resetSteps`,
  `markStepQueued` and `startManualRun`.
- The progress `.md` gets a `Last activity:` line for running steps.

## Known limits

- A workflow pointed at a **shared** workdir (rather than its own sandbox) can
  read another Claude session's transcript writes in that directory as its own
  progress; such a step would then only be stopped by the hard cap.
- An agent stuck *inside* a long-running tool writes nothing, so it looks
  stalled. That's the accepted trade-off — `stepIdleTimeoutMs` is set well above
  any normal quiet period, and the retry budget still covers a false positive.

## Tests

`hub/progress.test.ts` (new): freshest transcript wins (subagents included),
free-code session files, the run-log fallback, "no artifact → no signal",
fingerprint semantics, the throttle, and every derived state.

`hub/workflow.test.ts`: a long step whose agent is still writing is **not**
timed out (the reported bug), a quiet step is timed out even though its
artifacts exist, the hard cap fires on a busy step, a retry starts the idle
clock over, the judge phase re-seeds it — plus the pre-existing retry-budget
cases, which are unchanged.
