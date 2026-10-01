# How the hub measures context

The **Conversation** panel of a workflow shows a meter like
`Context 108.9k / 1.0M · 10.9%`. This page explains where both numbers come
from for each harness the hub runs: Claude Code, free-code and Cursor. It also
covers how to correct the window, and when the hub's number can differ from the
one in the agent's own `/context` bar.

The same figures go to the report server in every `usage.snapshot` event
(`context_tokens`, `context_window`, `context_pct`, `context_estimated`), and
the CLI prints them for one session:

```sh
node hub/tokens.ts <workflow id | workflow name | session id | free-code .jsonl path>
```

Everything is read from files the harnesses already write on this machine. The
hub makes no API calls for this. The code is in `hub/transcript.ts` (reading)
and `hub/models.ts` (windows).

## The two numbers

- **Context (the numerator)** is how full the main thread's window was at its
  last turn: the input, cache-creation and cache-read tokens that turn sent.
  Only the main thread counts, because subagents have windows of their own.
- **Window (the denominator)** is the context window of the model that turn ran
  on. It is looked up from the model id, never assumed (see
  [Resolving the window](#resolving-the-window)).

The line under the bar (`n turns · in … · out …`) shows **billed totals**
instead. Those add up every turn, and for Claude Code they also include every
subagent transcript. Totals and context are different quantities: a long session
can have billed 16M input tokens while its window holds 200k.

## Claude Code

| | |
|---|---|
| Transcript | `~/.claude/projects/<slug>/<sessionId>.jsonl`, where `<slug>` is the absolute workdir with every character outside `a-z A-Z 0-9 -` replaced by `-` (`/home/u/.target/x` → `-home-u--target-x`) |
| Usage | `message.usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` on assistant lines |
| Context | `input + cache_creation + cache_read` of the last assistant turn |
| Model | `message.model` of the last assistant turn |
| Subagents | `~/.claude/projects/<slug>/<sessionId>/subagents/*.jsonl`, added to the billed totals only |
| Compaction | `{"type":"system","subtype":"compact_boundary",…}` |

Details that keep the reading steady while the file is being written:

- **Duplicate lines.** Claude Code writes an assistant message more than once
  (a streamed copy, then the final one). Lines are deduplicated by message id
  and the last copy wins.
- **Turns that never reached the model.** Turns with all-zero usage, such as
  `<synthetic>` error notices, count in the totals but never set the context.
  `<synthetic>` is never taken as a model id either.
- **Impossible readings.** A reading larger than the model's whole window is
  rejected in favor of the previous plausible one (`plausibleOccupancy`). Such a
  reading is a billing total or an unfinished line, not occupancy.

## free-code

| | |
|---|---|
| Transcript | The session id **is** the transcript's absolute path. awb keeps it under `~/.agent-webhook-bridge/sessions/<hook>/<…>.jsonl`. |
| Usage | `message.usage.input`, `cacheWrite`, `cacheRead`, `output`, on assistant messages only |
| Context | `input + cacheWrite + cacheRead` of the last assistant turn |
| Model | `modelId` of the last `{"type":"model_change",…}` record, carried forward to the turns after it |
| Compaction | `{"type":"compaction",…}` (no token fields required) |

Aborted turns (`"stopReason":"aborted"`) and error turns carry all-zero usage.
Like Claude Code's synthetic turns, they count in the totals but never set the
context. The same window check applies as well.

## Cursor

Cursor writes no per-turn usage anywhere on disk. The hub combines three
sources:

| | |
|---|---|
| Usage | awb's run logs, `~/.agent-webhook-bridge/logs/*.log`: the `{"type":"result",…}` line at the end of each headless `agent -p` run, with `session_id` and `usage.inputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `outputTokens`. Only the last 128 KiB of each log is read. |
| Rounds | The agent-transcript, `~/.cursor/projects/<project>/agent-transcripts/<sessionId>/<sessionId>.jsonl`, which has one `user` line per run and one `assistant` line per API round. It carries no usage. |
| Model | See [Which model a Cursor session ran on](#which-model-a-cursor-session-ran-on) |

### Cursor occupancy is an estimate

The `usage` in a run's result is **summed over every API round of that run**.
For example, a run that called tools 20 times reports about 20 times its context
in `cacheReadTokens`. It is a billing total, not the occupancy of the window,
and nothing Cursor writes says how full the window was at the end of the run.

So for Cursor the hub estimates occupancy (`estimateCursorOccupancy`) and says
so: `contextEstimated: true`, which the meter renders as `≈` with a tooltip, and
which the report server receives as `context_estimated: true`. For each run, in
order:

1. Find the run in the agent-transcript by its final text. The result's
   `result` text ends with the run's last text block, once Cursor's
   `[REDACTED]` markers are removed. Matching on content rather than position
   matters, because the transcript also holds prompts typed into the CLI by
   hand that never went through awb.
2. Count its rounds `n`: its `assistant` lines, plus one if the last of them
   still calls tools (the results had to go back for the final answer).
3. With `S` = the run's summed input:
   - `n = 1` → `S` is the occupancy, exactly;
   - otherwise `S / n` (the mean) is a floor on the final occupancy, and
     assuming linear growth from the previous reading (0 for a session's first
     run) gives `2·S/n − previous`, kept within `[mean, S]`. The estimate is the
     midpoint of the two.
4. If a run can't be estimated (no transcript, no matching run, or an estimate
   larger than the window), the previous reading stands. The very first run of a
   session, which is usually the one-round context step, is taken as `S` when it
   fits the window. Nothing is ever clamped to the window.

Why this matters: the hub used to publish a run's summed total as occupancy (or
clamp it to the window). During a judge pass, the newest finished run is the
long exec run, so the meter read 100% until the short judge run replaced it.
Replayed over this machine's 412 judge passes, the readings pinned at the full
window went from 178 to 0, and the average jump across a judge pass went from
30.6 to 5.5 points.

### Which model a Cursor session ran on

Neither the result JSON nor the agent-transcript names the model on this
machine, and awb's Cursor adapter doesn't pass `--model`. The hub tries these
sources in order:

1. `model` / `modelUsage` in the result JSON, if a Cursor version writes it.
2. `--model` on the run's logged `$ agent -p …` line, read after skipping the
   quoted prompt (prompts often quote command lines). The parameterized form
   `--model 'claude-opus-4-8[context=1m,effort=high]'` also gives the run's
   window.
3. Cursor's own AI-code tracking database, `~/.cursor/ai-tracking/ai-code-tracking.db`,
   table `ai_code_hashes`: the latest `model` recorded for
   `conversationId = <sessionId>`. It only has rows for runs that changed
   files, so a session that never wrote anything has none.
4. `providerOptions.cursor.modelName` in the agent-transcript, if present.

If no source names the model, the window is the fallback.

## Resolving the window

`contextWindowForModel(model, stated)` in `hub/models.ts`, in this order:

1. **Your override.** `modelContextWindows[<model id>]` in
   `~/.target/config.json` (the id is matched case-insensitively).
2. **The window the run stated.** This only exists for Cursor: the
   `[context=…]` of a `--model` flag, or else the `context` parameter
   `~/.cursor/cli-config.json` sets for that model under `modelParameters`
   (e.g. `gpt-5.6-terra: context=272k`). Cursor offers the same model id at more
   than one size, so what the run used outranks the table.
3. **The table below**, matched on the exact id first, then on the longest id
   prefix: `claude-sonnet-5-20260101` resolves through `claude-sonnet-5`, and
   `claude-opus-5-thinking-high` through `claude-opus-5-thinking`.
4. **The fallback**: `fallbackContextWindowTokens` from the config, or 200,000.

The fallback is the smallest window any of these harnesses has shipped with.
The risk is asymmetric. A denominator that is too small shows a session as
fuller than it is. One that is too large hides a conversation filling up until
the harness compacts it.

`~/.target/config.json` is re-read only when it changes (its mtime, size or
inode), so an edit takes effect on the next poll without restarting the hub. A
value that isn't a positive number, such as `"200k"`, `0` or `-5`, is ignored.

### Example

```json
{
  "modelContextWindows": {
    "grok-4.6": 256000,
    "claude-opus-5": 200000
  },
  "fallbackContextWindowTokens": 128000
}
```

Merge these keys into the existing `~/.target/config.json` next to `port`,
`adminToken` and the rest. With them:

- a Cursor session on `grok-4.6`, which has no table entry, is measured against
  256k instead of the fallback;
- `claude-opus-5` is measured against 200k instead of the table's 1M, for an
  account that doesn't have the 1M tier;
- any model nobody has named is measured against 128k.

### Model table

`MODEL_CONTEXT_WINDOWS` in `hub/models.ts`, entry for entry. A test
(`hub/models.test.ts`) fails if the two disagree.

| Model id | Window | Basis |
|---|---|---|
| `claude-opus-5` | 1,000,000 | Measured 245,912 in one turn, above the 200k tier |
| `claude-sonnet-5` | 1,000,000 | Measured 370,543 |
| `claude-fable-5` | 1,000,000 | Measured 415,362, the largest single turn on this machine |
| `claude-opus-4-8` | 1,000,000 | Measured 236,715 |
| `claude-haiku-5` | 200,000 | Published small-model window; no local transcript |
| `accounts/fireworks/models/glm-5p2` | 256,000 | Measured 219,145; published 256k tier |
| `accounts/fireworks/models/kimi-k3` | 1,048,576 | Fireworks: "1,048,576 tokens, which Moonshot describes as a 1-million-token window"; measured 191,734 |
| `composer-2.5` | 200,000 | Cursor's `/context` bar reads Composer against 200k |
| `composer-2` | 200,000 | Same |
| `claude-opus-5-thinking` | 1,000,000 | Cursor picker name carries "1M" |
| `claude-sonnet-5-thinking` | 1,000,000 | Same |
| `claude-fable-5-thinking` | 1,000,000 | Same |
| `gpt-5.6-sol` | 1,000,000 | Same; the CLI config can run it at 272k, which then wins |
| `gpt-5.6-luna` | 1,000,000 | Same |
| `opus` | 1,000,000 | Alias Claude Code writes for `claude-opus-5` |
| `sonnet` | 1,000,000 | Alias for `claude-sonnet-5` |
| `fable` | 1,000,000 | Alias for `claude-fable-5` |
| `haiku` | 200,000 | Alias for `claude-haiku-5` |

Cursor models with no entry, such as `grok-4.6`, `grok-4.5` and
`gpt-5.6-terra`, use the size the CLI config sets for them when it sets one
(`gpt-5.6-terra` → 272k here), else the fallback. No local source gives a
window for `grok-4.6`; set it in `modelContextWindows` if you know it.

## When the hub's number differs from the agent's own `/context`

For Claude Code and free-code the **tokens** are the usage the harness itself
recorded for the turn, as reported by the provider, so they are not an
approximation. The **percentage** can still differ, and for Cursor so can the
tokens:

| Harness | Why it can differ | What to do |
|---|---|---|
| All | The hub only sees **finished** turns. While a turn is in flight, the agent's bar may already count the new prompt. | Nothing; the next poll after the turn lands agrees. |
| Claude Code | The window: if the account runs a model at a smaller tier than the table assumes (e.g. 200k instead of 1M), the hub's percentage is lower. | Set `modelContextWindows` for that model. |
| free-code | free-code gives a `models.json` entry without `contextWindow` **128,000**. kimi-k3 has no `contextWindow` here, so free-code's footer reads it against 128k (and compacts at about 112k), while the hub uses the provider's 1,048,576. | Set `contextWindow` for the model in `~/.free-code/agent/models.json` if free-code's own bar should agree. |
| Cursor | The reading is an **estimate** (see above). On the one run checked against Cursor's own bar it said 69k against 79.8k. It also moves only when a run finishes, not per round. | Treat the `≈` reading as approximate. |
| Cursor | The window is the fallback (200k) when no source names the model or its window, e.g. `grok-4.6`. | Set `modelContextWindows`. |

## Code

| | |
|---|---|
| `hub/transcript.ts` | Reading every harness: `readTokenUsage`, `estimateCursorOccupancy`, `cursorModelFromCommandLine`, `cursorModelFromTracking`, `cursorConfiguredContext`, `usageSnapshot` |
| `hub/models.ts` | `MODEL_CONTEXT_WINDOWS`, `FALLBACK_CONTEXT_WINDOW_TOKENS`, `contextWindowForModel` |
| `hub/ui/src/views/UsageMeter.tsx` | The meter, including the `≈` and its tooltip for estimates |
| `hub/context-occupancy.test.ts`, `hub/cursor-occupancy.test.ts`, `hub/cursor-model.test.ts`, `hub/models.test.ts` | Tests, built on real transcript and log lines from this machine |

The history of why the window stopped being a constant is in
[`compaction-resilience.md` §3](compaction-resilience.md#3-the-context-window-is-derived-not-assumed).
