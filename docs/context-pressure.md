# Feature: Context-pressure override

Once a workflow's shared conversation is **more than 60% full**, a step is
delegated to a subagent even when its own "Use subagent" toggle says inline.

## Why

Every step of a workflow resumes the **same** Claude session — that's what makes
a workflow read as one continuous conversation instead of N unrelated runs. The
consequence is that the conversation only ever grows.

A step that runs *inline* pours its whole working context into that thread:
every file it read, every command it ran, every dead end it backed out of. A
step that *delegates* leaves behind only the subagent's final summary. So the
inline toggle is, in practice, a decision about how much of the shared window
this step will spend.

That decision is made when the step is written, long before anyone knows what
the window will look like when it actually runs. Step 9 of a workflow can be
perfectly reasonable to run inline on a fresh session and a bad idea on the same
session eleven steps later, because by then the thread is crowded — and a
crowded thread is where reasoning starts to degrade, for this step and for every
step after it, which then inherit the degraded thread.

The override exists so that the toggle doesn't have to be right about the
future. Below the threshold it is honoured exactly as written; above it, the hub
protects the conversation.

## The rule

> `useSubagent === false` **and** the session this dispatch resumes is over 60%
> full → delegate anyway.

Three properties are worth stating explicitly, because they are what keep the
rule from being surprising:

**It is one-way.** Pressure can only turn delegation *on*. A step whose toggle
is already on is unaffected, and nothing here can ever make a delegated step run
inline. The override protects the conversation; it never spends it.

**It is strictly greater.** A session sitting at exactly 60.0% is not pressure —
the boundary belongs to the operator's choice.

**Unmeasurable is not crowded.** When occupancy can't be read — the dispatch
starts a fresh session, the hook is remote so there's no local workdir, the
transcript doesn't exist yet — the answer is "no pressure", and the step runs as
configured. An unknown never silently overrides what someone asked for.

## What is measured

The same number the **Conversation** panel shows: context occupancy at the
session's last turn, read straight from the transcript Claude Code writes on
disk (`hub/transcript.ts`). No API call, no extra state, no new bookkeeping —
if the panel says 74%, that is the number the rule used.

Crucially it is measured against **the session this dispatch actually resumes**,
resolved *after* that session is chosen:

- the first step of a workflow starts fresh → nothing to measure, toggle stands;
- a `resumeSession: false` dispatch starts fresh → same;
- a judge pass resumes the **step's own** session, which may not be the
  workflow's newest one → the step's is what gets read.

Only the main thread counts. Subagents have their own windows, which is the
entire point.

## What the agent is told

An overridden step gets a third instruction, in place of — not in addition to —
the inline one it was configured with. It says to delegate, and says why:

> Important: run this step by delegating the work to a subagent (the Task tool)
> instead of solving it yourself directly in this thread. This step was
> configured to run inline, but this session's context window is already more
> than 60% full, and doing the work here would crowd it further and degrade the
> quality of your thinking for this step and every step after it. The override is
> deliberate: delegate, and keep only the subagent's summary in this thread.

The reason is spelled out on purpose. The agent can still see an "inline" step in
front of it, and an unexplained contradiction is something it may try to
"helpfully" resolve in the other direction.

The **judge** pass is not redirected — its verdict has to come back on the main
thread, so it never carries a delegation instruction. But it is told the truth
about where the work went: for an overridden step it's warned that the output
lives in a subagent's transcript, not in this thread's narration. Judging an
overridden step by re-reading a thread that never held the work is exactly the
blind pass the judge prompt otherwise works hard to prevent.

## Where it shows up

- **Conversation panel** — past 60% the usage meter carries a line saying inline
  steps are now being delegated.
- **Step badge** — the `inline` badge's tooltip names the condition.
- **Hub log** — each override logs a warning naming the step, the session and
  its measured occupancy, so an unexpected delegation can be traced after the
  fact.

Nothing is persisted: the override is a property of a *dispatch*, not of the
step. The toggle in the UI still says what the operator chose, and once the
session is roomy again (a fresh conversation, a restart) that choice is honoured
without anyone having to reset anything.

## Code

| | |
|---|---|
| `hub/context-pressure.ts` | the threshold, the measurement, the decision |
| `hub/runner.ts` | `CONTEXT_PRESSURE_SUFFIX`, and the decision's place in `dispatchStep` |
| `hub/context-pressure.test.ts` | the condition, its boundary, and where it sits |

The threshold is `CONTEXT_PRESSURE_RATIO` in `hub/context-pressure.ts`.
`hub/ui/src/views/SessionPanel.tsx` repeats it as a literal, since the UI
doesn't import server modules — the two are kept in sync by hand.
