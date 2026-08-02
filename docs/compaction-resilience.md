# Feature: Compaction resilience

A workflow reuses **one** conversation for every step. When that conversation
hits the model's context limit the harness **compacts** it: the earlier turns
are thrown away and replaced by a summary. Until now nothing in the hub noticed,
and the agent simply stopped being able to remember the steps before it.

This is not a hypothetical. At the time of writing there were **17
`"type":"compaction"` records across 8 real free-code sessions** under
`~/.agent-webhook-bridge/sessions/`, and `compact_boundary` records in three
Claude Code transcripts under `~/.claude/projects/`.

Four changes, each independent.

## 1. Step results the agent can actually read

Every completed step's **full** result is written to

```
<workdir>/.target/steps/<NN>-<slug>.md
```

one file per step, zero-padded so `ls` sorts them into workflow order, and the
directory is named in **every** exec prompt `composeStepInput` produces.

The result was already persisted twice, and neither copy helped:

| Where | Why it didn't help |
|---|---|
| `steps.result` in the hub's SQLite DB | the agent has no access to it |
| `~/.target/<slug>-<id>.md` | truncated to 500 chars, never named in a prompt, and under `$HOME` — which the docker sandbox **deliberately never mounts** |

The workdir, by contrast, is mounted in every sandbox mode. Writing there needs
no new mount and changes nothing about the security posture: it's the one
directory the agent could already read and write.

The operator-facing `~/.target/<slug>-<id>.md` is unchanged, still truncated —
it's the summary view, and these files are the untruncated ones. Two readers,
two views.

## 2. Detecting the boundary — for both harnesses

The two harnesses write completely different records, and only one of them says
anything about tokens:

```jsonc
// Claude Code — same .jsonl, same sessionId, so --resume keeps working
{"type":"system","subtype":"compact_boundary",
 "compactMetadata":{"trigger":"manual","preTokens":417221,"postTokens":11944,…},
 "timestamp":"…"}

// free-code — a summary and a parentId chain. No token metadata.
{"type":"compaction","id":"…","parentId":"…","timestamp":"…","summary":"…"}
```

So the detector keys off **the record's presence and its timestamp**, never off
a drop in occupancy: a token-derived signal would work for Claude Code and be
blind for free-code, which is precisely the harness compaction has been observed
on. Both readers live in the same single pass `transcript.ts` already makes over
the file for token usage.

The newest boundary is persisted per workflow (`workflows.last_compaction_at`),
alongside the boundary already recovered from (`compaction_handled_at`). When
they differ, the next **exec** dispatch re-injects the workflow's conversation
context, with a leading line saying that the conversation was compacted and that
the restatement is authoritative. Keeping the handled marker as a *timestamp*
rather than a boolean is what makes a second compaction arm the recovery again.

This is the part that unblocks a real dead end: the context preamble was
injected exactly once ever (`context_injected`, closed permanently by
`chainSession`) and could not be re-set afterwards. The only way to get it back
was `restartWorkflow`, which discards every step's progress. Re-injection after
a detected boundary now works without it.

It's surfaced three ways: a warning in the log, a line in the progress `.md`,
and a note in the UI's Conversation panel.

Observation runs on the dispatch path **and** on the `session-info` route the UI
polls, so an operator sees a compaction the moment it lands rather than on the
next step. It only writes when the boundary is newer than the stored one, so
polling doesn't write (or log) on every poll.

## 3. The context window is derived, not assumed

`CONTEXT_WINDOW_TOKENS = 200_000` was a hardcoded guess, and measurably wrong.
Maximum single-turn context measured in real transcripts on this machine:

| Model | Measured | Assumed window |
|---|---|---|
| `claude-fable-5` | 415,362 | 200,000 |
| `claude-sonnet-5` | 370,543 | 200,000 |
| `claude-opus-5` | 245,912 | 200,000 |
| `claude-opus-4-8` | 236,715 | 200,000 |
| `accounts/fireworks/models/glm-5p2` | 219,145 | 200,000 |

Every threshold that divides by the window inherited that error: the 60%
delegation gate fired from the first step of every workflow, and the UI meter
was pinned red. A wrong denominator isn't cosmetic — it's the feature not
working.

The window now comes from the model actually in use, read per harness
(`message.model` on Claude Code's assistant lines, the `model_change` record's
`modelId` on free-code's) and looked up in `hub/models.ts`. Three layers:

1. `modelContextWindows` in `~/.target/config.json` — the operator's override;
2. the table, matched exactly then by longest id prefix (so
   `claude-sonnet-5-20260101` resolves through `claude-sonnet-5`);
3. `FALLBACK_CONTEXT_WINDOW_TOKENS` for anything unknown.

The fallback is deliberately the **smallest** window in the table. The error is
asymmetric: too small a denominator over-reports pressure, whose worst outcome
is delegating a step that didn't need it; too large under-reports it, and the
failure mode there is a conversation quietly filling up while the hub reports
"42% full". An unknown model errs toward crying wolf.

Override a model without a code change:

```json
{ "modelContextWindows": { "some-new-model": 512000 },
  "fallbackContextWindowTokens": 200000 }
```

## 4. Failures that say what went wrong

`callbackPayload` set no `error` field, so every CLI failure — a bad flag, a
missing credential, a context overflow — reached the hub as a bare `exit 1`.

The broker now captures a tail of stderr and forwards the CLI's own words as
`error` (preferring a structured `{"error":…}` on stdout when there is one), plus
the run's `logFile`. A failure with genuinely nothing to say (visible mode
captures no streams) still falls back to `exit N`, exactly as before —
synthesising a message there would move the fallback one layer down while saying
nothing new.

Separately, `chainSession` was skipped on the failure path because it sat after
an early return, while the failed step row still stored its session id. The
hub's two answers to "which conversation is this workflow on" could therefore
diverge: the next dispatch reads `workflow.lastSessionId`, the UI's "Open
conversation" reads `latestStepSession()`. After a failure the operator was
shown one conversation and the retry resumed a different, older one. A failed
run still *happened* in its conversation, so it is chained too.

## Not done here, on purpose

- **Re-injecting a per-step briefing on every dispatch.** A separate fix.
- **A `PreCompact` hook.** Claude-Code-only, and it would do nothing for
  free-code — which is exactly where compaction has already been observed.
