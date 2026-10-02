# Copilot runner spike results

## Summary

- Copilot CLI runs headless in Docker only with a token env (`COPILOT_GITHUB_TOKEN`) and a writable, exec-capable `$HOME`; host keyring auth is not usable there.
- Sessions chain with `--session-id=<uuid>` (new) and `--resume=<id>`; the full permission flag set must be passed on EVERY call.
- Permission modes map to `--available-tools`/`--allow-tool`/`--deny-tool`/`--allow-all-tools`/`--allow-all` (table below); exit code is always 0, denials show as `error.code "denied"`.
- Use `--stream off`; the answer is the last main-agent `assistant.message` with empty `toolRequests` (ignore `agentId`/`parentToolCallId`).
- Usage comes from `session.shutdown.modelMetrics` (includes subagents; input already includes cache); occupancy = `currentTokens / max_prompt_tokens` from a static table in `hub/models.ts`.
- Compaction is done only when `compaction_complete.success === true`; successful AUTO compaction was never reproduced (UNVERIFIED).
- Tags: VERIFIED = observed live in sections 1-4; DOCS = from official docs or the brief only; UNVERIFIED = see "Open items". Workflow numbers follow the brief: 2 awb adapter, 3 hub-runner-core, 4 hub-context-usage, 5 hub-docker, 6 target-server, 7 docs-and-e2e.

## Decisions

| Decision | Value (exact flags/values) | Tag | Consumed by workflow # | Evidence |
|---|---|---|---|---|
| Docker auth env | `COPILOT_GITHUB_TOKEN`, forwarded by name only (`-e COPILOT_GITHUB_TOKEN`), value from the hub/broker env; never in a file or argv. `GH_TOKEN`/`GITHUB_TOKEN` untested. Also `COPILOT_AUTO_UPDATE=false` or `--no-auto-update` | VERIFIED (`GH_TOKEN`/`GITHUB_TOKEN` UNVERIFIED) | 2, 5 | 1 (cases A2, B, C, D1) |
| Docker mounts / HOME | `-v $HOME/.copilot:$HOME/.copilot` (rw, required for chaining and for the hub to read `events.jsonl`); `-v $HOME/.cache/copilot:$HOME/.cache/copilot` (rw, optional, saves 185 MB re-extraction); same paths as host; `-e HOME=$HOME --user $(id -u):$(id -g)`; `$HOME` must be writable AND exec (no plain `--tmpfs`, only `--tmpfs ...,exec`); `~/.cache/Microsoft` needs no mount | VERIFIED | 2, 5 | 1 (C, D1-D7, Recommendation) |
| Host <-> container resume | works both ways when the same `~/.copilot` is mounted at the same path | VERIFIED | 3, 5 | 1 (Host <-> container) |
| Permission: unset / manual / plan | `--available-tools=view,grep,glob --deny-tool=write --deny-tool=shell` (read-only; `task` left out, add only for subagent steps) | VERIFIED (M1, M2; the exact combined set was not run as one case) | 2, 3 | 3 (M1, M2, M2b, mapping table) |
| Permission: acceptEdits | `--allow-tool=write --deny-tool=shell` (also blocks read-only shell such as `ls`) | VERIFIED | 2, 3 | 3 (M3, M4) |
| Permission: auto and dontAsk | `--allow-all-tools` (cwd + /tmp paths only; add `--add-dir <dir>` per extra dir; `--allow-all-paths` only if unknowable) | VERIFIED | 2, 3 | 3 (M5, path test) |
| Permission: bypassPermissions | `--allow-all` (= tools + paths + URLs). NOT env `COPILOT_ALLOW_ALL=true` | VERIFIED (equivalence from docs) | 2, 3 | 3 (M6), brief |
| Flags on every call | common: `-p <prompt> --output-format json --stream off --no-auto-update --no-color --no-ask-user` + `--model`; pass the mode flags on first AND resumed calls; same for `--context` if ever used | VERIFIED | 2 | 3 (resume test, mapping) |
| Stream | `--stream off` (-40% bytes, -69% lines, same final answer and `result`) | VERIFIED | 2 | 3 (Part A) |
| New session vs resume | new: `--session-id=<uuid>` (hub-generated); resume: `--resume=<id>`; unknown id exits 1 with `No session, task, or name matched ...`, no stdout; id is a bare uuid (cannot be told apart from claude/cursor ids by shape); lookup is cwd-independent but the session runs in its creation cwd | VERIFIED | 2, 3, 4 | 1 (resume), brief |
| Final-answer extraction | last `assistant.message` with NO envelope `agentId` and no `data.parentToolCallId`, empty `toolRequests`, non-empty `content`. The `result` line has no text. Subagent messages can end the file in async cases | VERIFIED (ordering for async subagents UNVERIFIED) | 2, 3 | 2 (Part B, Decision) |
| Model ids | table in section 4; id = `--model` value = `assistant.message.model` = `modelMetrics` key = `session.shutdown.currentModel`; no `model_change` in a fresh headless session (use `session.start.selectedModel`). Do not hard-code a list (account dependent) | VERIFIED | 3, 4 | 4 (Model id table) |
| `auto` resolution | `auto` appears only as `session.start.selectedModel`; resolve from `assistant.message.model` or `session.shutdown.currentModel` (seen: `mai-code-1.1-flash`) | VERIFIED (single run) | 4 | 4 (Model id table) |
| Rejected model | exit 1, stderr `Error: Model "<id>" from --model flag is not available.`, no stdout; surface it, do not retry | VERIFIED | 2, 3 | 4 (Decision) |
| Context denominator | `max_prompt_tokens`; `occupancy% = session.shutdown.currentTokens / max_prompt_tokens` | VERIFIED (2 models) | 4 | 4 (Decision) |
| Window source | static table in `hub/models.ts` by resolved model id (strip date suffix): `claude-haiku-4.5` 128000, `gpt-5.4` 922000, `gpt-5.4-nano` 272000, `gpt-4o-mini` 64000; fallback 128000 marked as estimate; override with `session.compaction_start.tokenLimit` or `model.turn_ended.modelInfo.capabilities.limits` when present | VERIFIED (haiku, gpt-5.4); others from the brief/interactive runs | 4 | 4 (table, Decision) |
| Long context | do not pass `--context long_context`; treat `contextTier === "long_context"` as table window; flag has no effect on window for gpt-5.4 and is ignored for haiku | VERIFIED (limits); effect above 272K UNVERIFIED | 4 | 4 (Long context tier) |
| Compaction boundary | done only when `session.compaction_complete.success === true`; ignore `success:false`; use `preCompactionTokens`/`postCompactionTokens` (conversation-only) and `trigger` (`"manual"` or `"threshold"`); occupancy from `session.shutdown.currentTokens` | VERIFIED (manual); auto success UNVERIFIED | 4 | 2 (Part A, Decision) |
| Auto-compaction trigger | `trigger: "threshold"` seen on start and complete (forced with `COPILOT_BACKGROUND_COMPACTION_THRESHOLD=0.001`, fraction of the limit); docs say ~95% | VERIFIED (value); successful event UNVERIFIED | 4 | 2 (Part A) |
| Compaction tokens | not in shutdown `modelMetrics`; only in `compaction_complete.compactionTokensUsed` | VERIFIED | 4 | 2 (Accounting) |
| includesSubagents | `true`; read top-level `session.shutdown.modelMetrics`; never add `agentMetrics` (double count) | VERIFIED | 4 | 2 (Part B, Decision) |
| Token mapping | `inputTokens` already includes cacheRead and cacheWrite: `uncached = inputTokens - cacheReadTokens - cacheWriteTokens`; do not use `input + cacheCreation + cacheRead`; metrics cumulative across resumes | VERIFIED (per brief; section 2 confirms per-agent same semantics) | 4 | brief, 2 (Part B) |
| Cost | hub keeps `cost_usd` null; report server prices by (agent, model) per token (1 AI credit = $0.01); legacy plan: `totalNanoAiu` 0 and `premiumRequests` | DOCS | 4, 6 | brief |
| Denied-tool warning | warn when any `tool.execution_complete` has `data.error.code === "denied"`; quote `toolName` from the matching `tool.execution_start` by `toolCallId`; exit code stays 0 | VERIFIED | 2, 3 | 3 (Denied tool calls) |
| Version | observed 1.0.91 (container and host auto-updated); brief says 1.0.89; no difference expected | VERIFIED on 1.0.91; 1.0.89 UNVERIFIED | all | Note below, 1 |

Purpose: close the unknowns (a-e) about GitHub Copilot CLI 1.0.89 that block the `copilot` runner
(see `docs/copilot-runner-brief.md`). Each spike step appends a numbered section below. Decisions
here are binding for later workflows; corrections go in a "Corrections" section at the end.

Note: the container image installed the latest `@github/copilot` (1.0.91); the host CLI also
reported 1.0.91 by the time of the resume test (it auto-updated from 1.0.89). Behaviour below was
observed on 1.0.91 and is not expected to differ from 1.0.89.

## 1. Docker auth and mounts

Setup: throwaway image `FROM target-agent:latest` (base `USER 1000:1000`) plus root `npm i -g @github/copilot`,
back to `1000:1000`. Command in every case: `copilot -p "Reply: ok" --output-format json --allow-all-tools
--no-auto-update --model claude-haiku-4.5`, `docker run --rm --init --user $(id -u):$(id -g)`, cwd a
bind-mounted scratch dir. Token, when used, was passed only by name (`-e COPILOT_GITHUB_TOKEN`).

| Case | Setup | Exit | First stderr line / outcome |
|------|-------|------|------------------------------|
| A | no token, no mounts, `HOME=$HOME` (host path, absent in image) | 1 | `Failed to extract bundled package: Error: EACCES: permission denied, mkdir '/home/lenovo'` |
| A2 | no token, no mounts, writable `HOME` | 1 | `Error: No authentication information found.` |
| B | `~/.copilot` + `~/.cache/copilot` mounted, no token | 1 | `Error: No authentication information found.` (host login lives in the OS keyring, `~/.copilot/config.json` holds only `loggedInUsers`, no secret) |
| C, no mounts | token env, `HOME=$HOME` (unwritable) | 1 | `Failed to extract bundled package: EACCES ... mkdir '/home/lenovo'` (HOME problem, not auth) |
| C, with mounts | token env + `~/.copilot` + `~/.cache/copilot` mounted at same paths | 0 | success, 52 JSONL lines, final `result` line present |
| D1 | token env, `HOME=/tmp/.../h1` (writable dir on a bind mount), NO other mounts | 0 | success, `result` line present. Creates `$HOME/.copilot` and `$HOME/.cache/{copilot,Microsoft}`; 185 MB bundle extracted to `$HOME/.cache/copilot/pkg` on every fresh HOME |
| D2 | as D1 plus only `~/.copilot` mounted onto `$HOME/.copilot` | 0 | success |
| D3 | token, `HOME` on plain `--tmpfs` | 1 | `Failed to load package index: .../pkg/linux-x64/1.0.91/index.js Error: Native addon "runtime" not found` (cause: `failed to map segment`, tmpfs is `noexec` by default) |
| D4 | token, `HOME=/home/lenovo` (root-owned, nonexistent for uid 1000), only `~/.copilot` mounted | 1 | `Failed to extract bundled package: EACCES: permission denied, mkdir '/home/lenovo/.cache'` |
| D5 | token, same unwritable HOME, only `~/.cache/copilot` mounted | 1 | empty stderr, empty stdout (cannot create `$HOME/.copilot`) |
| D6 | token, read-only rootfs, `COPILOT_HOME`/`XDG_CACHE_HOME` on default tmpfs | 1 | same `Native addon "runtime" not found` (noexec) |
| D7 | token, `HOME` on `--tmpfs ...,exec` | 0 | success (so a tmpfs HOME works iff mounted `exec`) |

Findings:

- The env var `COPILOT_GITHUB_TOKEN` is accepted and sufficient. No token and no keyring means
  `Error: No authentication information found.` (exit 1, no stdout). `GH_TOKEN`/`GITHUB_TOKEN` were not
  tested (brief lists them as alternatives; pass only one name).
- Host auth is NOT usable in the container: the mounted `~/.copilot` carries no secret (keyring-based),
  so case B fails. The container needs a token env, always.
- A writable, executable `$HOME` is mandatory, independent of auth: the CLI extracts its native
  bundle into `$HOME/.cache/copilot/pkg/linux-x64/<ver>/` and executes it, and writes `$HOME/.copilot`.
  The failure mode is a misleading stderr (or empty stderr with exit 1 when `.copilot` cannot be created).
- Nothing needs to be mounted from the host for a one-shot run (D1). Mounts are only for sharing
  sessions (below) and avoiding the 185 MB re-extraction (mount `~/.cache/copilot`).

### Recommendation

- Env: `COPILOT_GITHUB_TOKEN` (forward by name only, `-e COPILOT_GITHUB_TOKEN`, value taken from the
  hub/broker environment, e.g. `gh auth token`; never written to a file or command line). Also set
  `COPILOT_AUTO_UPDATE=false` (or keep `--no-auto-update`).
- Mounts: `-v $HOME/.copilot:$HOME/.copilot` (rw, required for session chaining and for the hub to read
  `session-state/<uuid>/events.jsonl`), and `-v $HOME/.cache/copilot:$HOME/.cache/copilot` (rw, optional
  but recommended: reuses the 185 MB native bundle and the user/exp caches). `~/.cache/Microsoft` is
  created on demand and does not need a mount. Mount at the SAME path as the host and pass
  `-e HOME=$HOME` plus `--user $(id -u):$(id -g)` so file ownership matches and `$HOME` is writable
  (the image must not rely on a baked-in home for that uid; if `$HOME` does not exist in the image the bind
  mounts create it root-owned and `.cache` then fails: mount `~/.cache/copilot` too, or make the parent writable).
- Do not use a plain `--tmpfs` for HOME; if one is used it must carry `exec`.

### Host <-> container session resume

Confirmed both ways, with `~/.copilot` mounted at the same path:

- Container-created session (id taken from the `result` line) resumed on the host with
  `copilot -p ... --resume=<id>`: exit 0, the agent quoted the earlier prompt.
- Host-created session (`--session-id=<uuid>`) resumed in the container with `--resume=<id>`: exit 0, the agent
  recalled the word given on the host, and `events.jsonl` got a `session.resume` event.
- A session is only visible when the mounted `~/.copilot` is the one that holds it (D1 style throwaway
  homes start empty, so `--resume` there fails with `No session ... matched`).

### Caveats

- Container CLI version is whatever npm serves at image build time and may differ from the host's; both
  read/write the same `events.jsonl`, and this was fine for 1.0.91 on both sides.
- Running a container with the real `~/.cache/copilot` mounted writes the container's CLI version
  into `pkg/linux-x64/<ver>/` on the host cache (harmless, versioned dirs).
- Resumed sessions keep the cwd they were created in (brief); a session created in a container whose cwd
  does not exist on the host runs there anyway only if the same path is mounted at the same location.
- Failed runs (auth/HOME errors) cost no premium requests; the successful live calls in this step were 7.

## 2. Compaction and subagents

Live calls in this step: 7 (6 for Part A, 1 for Part B), all `--model claude-haiku-4.5`, CLI 1.0.91, flags
`--output-format json --allow-all-tools --no-auto-update`. Test sessions (left in `~/.copilot/session-state`):
`84d04c66-d6c8-4e0e-bc54-bcca0df84217` (Part A), `0402c286-1902-4765-b7cf-7f2742a57e17` (Part B).

### Part A: compaction

Docs. docs.github.com "About GitHub Copilot CLI": "When your conversation approaches 95% of the token limit,
Copilot automatically compresses your history in the background". `copilot help environment|config|limits` do NOT
document any compaction threshold variable (`limits` only says hidden work such as compaction counts toward
`--max-ai-credits`). The two env vars from the brief do exist as strings inside the native runtime
(`~/.cache/copilot/pkg/linux-x64/<ver>/prebuilds/linux-x64/runtime.node`): `COPILOT_BACKGROUND_COMPACTION_THRESHOLD`
and `COPILOT_BUFFER_EXHAUSTION_THRESHOLD` (undocumented, semantics inferred only). `COPILOT_PROVIDER_MAX_PROMPT_TOKENS`
is documented as BYOK-only, so it was not used.

Attempts. New session, env `COPILOT_BACKGROUND_COMPACTION_THRESHOLD=0.001 COPILOT_BUFFER_EXHAUSTION_THRESHOLD=0.002`,
5 chained turns with `--resume=<sid>` (memory word, recall, 3 shell commands with `sleep`, a 250-word story,
another short shell turn), then 1 manual `/compact` (env unset).

Observed. The low threshold DOES trigger the automatic path: every process run (each `-p` call) wrote
`session.compaction_start` + `session.compaction_complete` into `events.jsonl`:

- `session.compaction_start` keys: `systemTokens, conversationTokens, toolDefinitionsTokens, currentTokens, tokenLimit, trigger`.
  Values seen: `trigger: "threshold"` (NOT `"auto"`; manual is `"manual"`), `tokenLimit: 128000` (claude-haiku-4.5),
  `currentTokens` 13003..13657 (about 10% of the limit, so the env var is a fraction of the limit and 0.001 forces it).
- `session.compaction_complete` for `threshold`: `success: false` every time (4 of 4). First run:
  `error: "Compaction Cancelled"` (process ended before the background job; keys `success,error,tokenLimit,trigger`).
  Later runs: `error: "Compaction failed: received empty response from model"` (extra keys `compactionTokensUsed,requestId,serviceRequestId`).
  No `preCompactionTokens`/`postCompactionTokens` are present on a failed compaction.
- So: auto `trigger` value = `"threshold"` (VERIFIED as written to the start event). A SUCCESSFUL auto compaction with
  pre/post numbers was NOT produced: UNVERIFIED (the conversation was tiny, ~1k conversation tokens, and the summary
  call returned empty; a real overflow of a 128k window was not attempted for cost). Assume a success event has the same
  shape as the manual one with `trigger: "threshold"`.
- Manual `/compact` for comparison: `compaction_start{trigger:"manual", currentTokens:13916,...}`, `compaction_complete{success:true,
  preCompactionTokens:1045, postCompactionTokens:758, preCompactionMessagesLength:20, messagesRemoved:19, tokensRemoved:287,
  behaviorModelId, compactionTokensUsed, checkpointNumber:1, checkpointPath, tokenLimit:128000, trigger:"manual"}`
  (plus `summaryContent`, not reproduced here). Note `preCompactionTokens`/`postCompactionTokens` count only the
  CONVERSATION part (excluding system prompt and tool definitions), whereas `currentTokens` includes everything.
  A `checkpoints/NNN-*.md` file is written in the session dir.

Accounting around compaction.

- `session.shutdown.modelMetrics` / `totalPremiumRequests` do NOT include the compaction call. Shutdown before and after the
  manual compaction were identical (`inputTokens 112746, outputTokens 1224, requests.count 7, cost 1.65`). The compaction
  tokens are only in `compaction_complete.compactionTokensUsed` = `{inputTokens, outputTokens, cacheReadTokens,
  cacheWriteTokens, copilotUsage, duration, model}` (e.g. 17774 in / 933 out). Hidden compaction work is therefore
  invisible in shutdown cumulative metrics; add `compactionTokensUsed` if it must be counted.
- `session.shutdown.currentTokens` drops after a successful compaction: 13991 (last shutdown before) -> 13631 (shutdown of
  the compacting run); `conversationTokens` 1042 -> 757. The drop is small only because the conversation was tiny; the
  system + tool-definition floor (~12.9k) stays. After a FAILED auto compaction `currentTokens` is unchanged (keeps growing).
- Every process exit writes a shutdown, and compaction events of a run precede that run's shutdown. A compaction run
  is detectable by `compaction_complete.success === true`; failed/cancelled ones must be ignored.

### Part B: subagent (`task` tool)

Prompt: "Use your task tool to delegate ... list the files in the current directory". In `events.jsonl` (stdout JSONL carries the
same events plus deltas) the order was:

```
assistant.message (main, content "", toolRequests=[task])
tool.execution_start {toolName:"task", toolCallId:T}
subagent.started {agentId:A, agentName:"explore", toolCallId:T, model}
subagent.configured / subagent.selected {agentId:A}
user.message, system.message, session.model_change, assistant.turn_start      (all with agentId:A)
assistant.message {toolRequests=[bash], content ""}                            (agentId:A, parentToolCallId:T)
tool.execution_start/complete {toolName:"bash"}                                (agentId:A, parentToolCallId:T)
assistant.message {content: 628 chars, toolRequests: []}                       (agentId:A, parentToolCallId:T)  <-- subagent "final"
tool.execution_complete {toolCallId:T}                                         (main, no agentId)
subagent.completed {agentId:A, agentName:"explore", toolCallId:T}
assistant.message {content: 246 chars, toolRequests: []}                       (main, no agentId)               <-- real final answer
session.shutdown
```

- Same file, no separate subagent file. The subagent's events carry a top-level `agentId` on the event envelope (sibling of
  `type`/`data`, not inside `data`), and its `assistant.turn_start/end` and `assistant.message` also have
  `data.parentToolCallId`. Main-agent events have neither. The subagent got its own model (`claude-haiku-4.5` inherited),
  agentName `explore`, and agentDisplayName set from the task description.
- The subagent's last message has empty `toolRequests` and non-empty `content`, so the naive rule "last assistant.message with
  empty toolRequests and non-empty content" is only safe because the main final answer happens to be written AFTER the
  subagent's (the subagent's message precedes `subagent.completed`). Ordering is not guaranteed for background/async
  subagents (`session.background_tasks_changed` events exist), so filter explicitly.
- Accounting: `session.shutdown.modelMetrics` is the SUM of everyone (main 2 requests 31863 in + subagent 2 requests 11493 in
  = 43356 in, count 4). `agentMetrics` has keys `main` and one key per subagent = its `agentId` uuid (value has `agentName`,
  `agentDisplayName`, `totalApiDurationMs`, `totalNanoAiu`, `modelMetrics`). Subagent requests are `requests.cost: 0`,
  so `totalPremiumRequests` (0.33) reflects only the main agent. Top-level `modelMetrics` therefore already includes
  subagents: do not add `agentMetrics` on top (double count). Per-agent numbers use the same inclusive `inputTokens`
  semantics (cache counted inside input).
- `result` line (stdout) carries only `premiumRequests` and no answer, as before.

### Decision

- Compaction boundary rule: a compaction is "done" only when a `session.compaction_complete` has `success === true`. Use its
  `trigger` (`"manual"` | `"threshold"` for auto; `"threshold"` observed on start/complete, successful auto UNVERIFIED), and
  `preCompactionTokens` / `postCompactionTokens` (conversation-only tokens) for the before/after figures; skip events with `success:false`
  (cancelled / empty response). For occupancy use `session.shutdown.currentTokens`; it drops after a successful compaction.
  Compaction tokens are not in shutdown `modelMetrics`; read `compactionTokensUsed` if they must be billed/counted.
- includesSubagents: true. Read cumulative usage from top-level `session.shutdown.modelMetrics` (already includes the subagent
  tokens); never add `agentMetrics` entries. `agentMetrics` is only for optional per-agent breakdown (keys `main` + subagent agentId).
- Final-answer extraction rule: take the last `assistant.message` that has NO `agentId` on the event envelope (and no
  `data.parentToolCallId`), `toolRequests` empty and `content` non-empty. Ignore everything with `agentId`/`parentToolCallId`
  (subagent text), even if it is last in file order.

## 3. Flags and permission mapping

Live calls in this step: 21 (all `--model claude-haiku-4.5 --output-format json --no-auto-update --no-color`, CLI 1.0.91, `timeout 180`,
fresh non-git scratch dir per run, stdin from /dev/null, 0.33 premium requests each). Calls: Part A 2; matrix 10 (M0 twice, see below);
resume 3; path 3; url 3. Every run exited 0 (see "Exit code" below). Scratch dirs were under /tmp and were removed afterwards.

Tool names seen in `session.usage_checkpoint` (`promptCacheBreakState[].models.*.tools[].name`): `bash read_bash stop_bash list_bash view create edit
web_fetch web_search fetch_copilot_cli_documentation search_code_subagent skill sql session_store_sql read_agent list_agents write_agent grep glob task`
plus the GitHub MCP tools. Writes are `create`/`edit` (permission kind `write`), the shell is `bash` (kind `shell`).

### Part A: `--stream on|off`

Prompt: "create file a.txt containing x, then reply done", `--allow-all-tools`.

| Run | stdout lines | stdout bytes | Event types only present with `on` | `result` last line | Final answer (`assistant.message`, empty toolRequests, content "done") | a.txt created |
|-----|--------------|--------------|--------------------------------------|--------------------|-----------------------------------------------------------------------|---------------|
| `--stream on` | 72 | 32580 | `assistant.reasoning_delta` (39), `assistant.tool_call_delta` (8), `assistant.message_start` (1), `assistant.message_delta` (1) | yes | yes | yes |
| `--stream off` | 23 | 19521 | none (all of the four above are gone) | yes | yes | yes |

Everything else is identical in both (`assistant.reasoning` and `assistant.message` carry the complete text, plus `tool.execution_*`,
`model.call_*`, `assistant.turn_*`, `session.usage_checkpoint`, `assistant.idle`). `result` carries the same `premiumRequests` (0.33) in both.
`events.jsonl` on disk never held the deltas anyway, so the hub readers are unaffected.

Recommendation: the awb adapter should pass `--stream off`. It cuts stdout by 40% and 69% of the lines, loses nothing the hub or the
final-answer rule needs, and avoids parsing token-level deltas. Only incremental live text in the awb log is lost.

### Part B: permission matrix

Prompt (same in every run, fresh scratch dir with an empty `./victim-dir`): "1) create a file named w.txt containing ok, 2) run the shell command
`echo hi > s.txt` as its own separate shell tool call, 3) run `rm -rf ./victim-dir` as another separate shell tool call, then say what happened".
The first M0 run used the prompt without "as its own separate shell tool call"; the model merged 2 and 3 into one `bash` call
(`echo hi > s.txt && rm -rf ./victim-dir`), so the rows below are from the reworded prompt (M0b onwards), except M1 which was run on the original
prompt (merged call, denied as one). Results were taken from the files on disk and from `tool.execution_complete` matched to
`tool.execution_start` by `toolCallId` (completions arrive out of order, do not match by position).

| Id | Flags (besides the common ones) | (1) write w.txt | (2) shell `echo hi > s.txt` | (3) `rm -rf ./victim-dir` | Exit code |
|----|--------------------------------|-----------------|-----------------------------|---------------------------|-----------|
| M0 | none | denied | denied | denied (dir kept) | 0 |
| M0n | `--no-ask-user` | denied | denied | denied (dir kept) | 0 |
| M1 | `--deny-tool=write --deny-tool=shell` | denied | denied | denied (dir kept) | 0 |
| M2 | `--available-tools=view,grep,glob,task` | not possible (no `create`/`edit` tool) | not possible (no `bash`) | not possible (dir kept) | 0 |
| M2b | M2 plus `--allow-all-tools` | not possible | not possible | not possible (dir kept) | 0 |
| M3 | `--allow-tool=write` | allowed | ALLOWED (the redirect ran) | denied (dir kept) | 0 |
| M4 | `--allow-tool=write --deny-tool=shell` | allowed | denied | denied (dir kept) | 0 |
| M5 | `--allow-all-tools` | allowed | allowed | ALLOWED (dir deleted) | 0 |
| M6 | `--allow-all` | allowed | allowed | ALLOWED (dir deleted) | 0 |

Notes:

- M0/M0n: `-p` never hangs. Without a flag, a permission request is auto-denied at once ("Permission denied and could not request permission
  from user"); `--no-ask-user` makes no observable difference in `-p` (it only disables the model's `ask_user` tool), but it is harmless and
  guarantees no hang. In M0 even `echo hi > s.txt` was denied (the brief saw plain `echo` run; a redirect does not count as safe).
- M3: `--allow-tool=write` also let the shell `echo hi > s.txt` through (a redirect to a file counts as a write), while `rm -rf` stayed denied.
  So an allow on `write` alone is NOT a safe "no shell" mode; add `--deny-tool=shell` (M4).
- M2: `--available-tools` really removes the tools, the model said it had no shell. In M2/M2b the model delegated to `task`: the subagent
  inherited the restricted tool set (no file was written, no `bash`/`create` call appeared in the events), but with `--allow-all-tools` M2b
  spawned 6 nested `task` calls until "Maximum sub-agent depth of 4 reached". Keep `task` out of the read-only list unless the step
  needs subagents (cost loop risk); with it, nothing escaped the restriction. (The model's prose in M2b even claimed a deletion happened; the
  directory was intact, never trust the answer text for what changed.)
- `--allow-all-tools` and `--allow-all` both executed the destructive command (M5, M6): expected, they are the "everything" modes.
- Exit code is 0 in every case, including when all three tools were denied. The result line has `exitCode: 0` too.

### Denied tool calls are visible in JSONL

Yes, both in stdout and in `events.jsonl`: the `tool.execution_complete` event has `data.success: false` and
`data.error: {"message": "...", "code": "denied"}` (a JSON object, not a string). Two messages exist:

- no rule, `-p` cannot ask: `Permission denied and could not request permission from user`
- explicit deny rule: `Permission to run this tool was denied due to the following rules: \`write\`` (or `\`shell\``).

Both carry `code: "denied"`; other failures use a different code (a nested subagent limit gave `code: "failure"`, a DNS error in `web_fetch` also
`failure`). `result.usage.codeChanges` lists only files actually modified. The adapter/hub can surface a warning when any
`tool.execution_complete` has `error.code === "denied"` (count them and quote `toolName` from the matching `tool.execution_start`).
`session.shutdown` has no denied counter.

### `--resume` with a different permission flag set

Flags are evaluated per invocation, not stored in the session. Session created with `--deny-tool=write --deny-tool=shell`, then
resumed with `--allow-all-tools`: the file write succeeded; resumed again with only `--deny-tool=write`: the write was denied. The session id stayed
the same in all three `result` lines. So the adapter must pass the full permission flag set on every call, first and resumed.

### Path and URL restriction

- Paths (verified). `--allow-all-tools` alone does NOT lift the path sandbox: file access is limited to the cwd (+subdirs) and the system temp
  dir (`/tmp`, auto-allowed unless `--disallow-temp-dir`). Test from a workdir under /tmp writing `/tmp/<other-dir>/x.txt`:
  allowed by default (temp dir), DENIED with `--allow-all-tools --disallow-temp-dir` ("Permission denied and could not request permission from user",
  code `denied`, even `mkdir` via the shell was denied), allowed again with `--allow-all-tools --disallow-temp-dir --allow-all-paths`.
  Consequence: for a workflow whose cwd is outside /tmp, edits to other directories (sibling repos, the hub's attachment dir, a home path) are denied
  under `--allow-all-tools`. `--add-dir <dir>` (repeatable) grants specific extra directories and is the narrower alternative to `--allow-all-paths`.
- URLs (not conclusive for blocking). With `--allow-all-tools` only, the shell `curl https://example.com` and the `web_fetch` tool both got past
  the permission stage (no `denied`); both then failed on the network (this sandbox has no DNS: `curl` code 6 / `web_fetch`
  "WebFetchBlockedUrlError: failed to lookup address information"; the host shell also cannot resolve it). The same `web_fetch` with `--allow-all-urls` added
  failed identically. So no URL restriction was observed under `--allow-all-tools`; `--allow-all-urls` showed no difference, and a genuine
  fetch was not achievable here. Docs (`copilot help permissions`) say `url(...)` rules apply to the shell and web-fetch tools; if a
  fetch is denied on a machine with network, add `--allow-all-urls` (only then).

### Recommended mapping (Target permission mode -> copilot flags)

Common flags for every mode: `-p <prompt> --output-format json --stream off --no-auto-update --no-color --no-ask-user` (+ `--model`,
`--session-id`/`--resume`). Always pass the mode's permission flags on every invocation, including resumed ones. In every mode a missing
approval means an immediate deny, never a hang.

| Target mode | Copilot flags | Result | Justification |
|-------------|---------------|--------|---------------|
| unset | `--available-tools=view,grep,glob --deny-tool=write --deny-tool=shell` | read-only | Read-only is the safe default. Tool removal (M2) plus explicit deny rules (M1) so the result does not depend on the default prompting behaviour, which in `-p` is an implicit deny. `task` left out (recursion cost, see M2b); add `task` only when the step uses subagents. |
| manual | same as unset | read-only | The CLI cannot ask in `-p` (prompts auto-deny), so there is no interactive "manual" approval; the honest equivalent is read-only. Denied calls are reported through `error.code: "denied"`. |
| plan | same as unset | read-only | Planning must not change anything. |
| acceptEdits | `--allow-tool=write --deny-tool=shell` | edits yes, shell no | Verified in M4: write allowed, shell denied (deny wins). `--allow-tool=write` alone is not enough (M3 lets `echo ... > file` through). No `--available-tools`, so `view`/`grep`/`glob`/`task` stay usable. Note it also denies read-only shell such as `ls`/`git status`. |
| auto | `--allow-all-tools` | all tools, cwd + /tmp paths | M5. Path sandbox kept on purpose (blast radius limited to the workdir). Add `--add-dir <dir>` for each extra directory the workflow legitimately needs; `--allow-all-paths` only if that is unknowable. |
| dontAsk | `--allow-all-tools` | same as auto | Same semantics (nothing asks, everything runs); no URL flag needed per the finding above. |
| bypassPermissions | `--allow-all` | everything (tools, any path, any URL) | M6; equivalent to `--allow-all-tools --allow-all-paths --allow-all-urls`. Do NOT use env `COPILOT_ALLOW_ALL=true` (also trusts the directory). |

Open points for the adapter: `--available-tools` with a list that includes tool names that do not exist in a given CLI version was not tested
(the three read-only names above exist in 1.0.91); `--excluded-tools=bash,create,edit` is the inverse option if a deny-list is preferred.

## 4. Model ids and context windows

Live calls in this step: 13 (cap 14), CLI 1.0.91, flags `-p ... --output-format json --no-auto-update --no-color --stream off --allow-all-tools`,
fresh non-git scratch dirs under /tmp (removed afterwards). Calls: 1 accidental (`-p "/model"`, see below), 7 tiny `Reply: ok` model probes (haiku-4.5, gpt-5-mini,
gpt-5.4, auto, gpt-5.4-mini, claude-sonnet-4.6, mai-code-1.1-flash), 1 `/context`, 4 for the long-context/limits checks (gpt-5.4 `--context long_context` plus its `/compact`,
gpt-5.4 default-tier `/compact`, haiku `--context long_context` `/compact`). Rejected models cost nothing (exit 1 before any request).
Test sessions (left in `~/.copilot/session-state`):
`33204607-37fa-46de-90e6-1cbbcbfd5526` (haiku, also /context + long_context compact), `f7acec8e-7989-4e71-b033-4e24ecb66f4c` (gpt-5-mini),
`531501de-7a97-4026-89eb-a1e54511f44e` (gpt-5.4, + /compact), `62e5c2ed-b216-48b9-949f-d7894af8d5cd` (auto), `33bbfb34-531c-4e87-80c5-3699009d77a4` (gpt-5.4-mini),
`4d452007-339a-4a1f-b336-66f0af72d5da` (claude-sonnet-4.6), `de9f42a6-a6f5-4c05-8a77-1d7ea4c48690` (mai-code-1.1-flash),
`e193811c-f807-47ee-b14e-8ae66da0d6cc` (gpt-5.4 long_context + /compact), `9314504c-ee13-4eb8-8532-85db700e206d` (the accidental `/model`).

### Model id table

"id" is the string in `assistant.message.data.model`, `session.start.selectedModel`, `session.shutdown.currentModel` and the `modelMetrics` key. In every
observed headless run all of these were IDENTICAL, and no `session.model_change` event is written for a fresh headless session (the initial model is
`session.start.data.selectedModel`; `model_change` only appears when the model changes mid-session). The `--model` value equals the id.

| Display name | id (assistant.message / modelMetrics key) | window default (total / max prompt) | window long_context | evidence |
|---|---|---|---|---|
| Claude Haiku 4.5 | `claude-haiku-4.5` | 144000 / 128000 | same (flag ignored, `contextTier` stays null) | observed (`model.turn_ended.modelInfo`, compaction `tokenLimit` 128000) |
| GPT-5 mini | `gpt-5-mini` | unknown (not captured) | n/a | id observed; window unknown |
| GPT-5.4 | `gpt-5.4` | 1050000 / 922000 | 1050000 / 922000 (identical, `tokenLimit` 922000 in both) | observed (compaction on both tiers) |
| GPT-5.4 mini | `gpt-5.4-mini` | unknown | n/a | id observed |
| GPT-5.4 nano | `gpt-5.4-nano` | 400000 / 272000 | n/a | window observed earlier (interactive session); REJECTED by `--model` on this account today (`Model "gpt-5.4-nano" from --model flag is not available.`) |
| Claude Sonnet 4.6 | `claude-sonnet-4.6` | unknown | n/a | id observed |
| MAI-Code-1.1-Flash | `mai-code-1.1-flash` | unknown | docs: 1M in CLI | id observed (also what `auto` picked) |
| GPT-4o mini | `gpt-4o-mini` (the interactive `model.turn_ended` shows the dated `gpt-4o-mini-2024-07-18`) | 128000 / 64000 | n/a | observed earlier (interactive); REJECTED by `--model` today |
| auto | `auto` is only `session.start.selectedModel`; everything else carries the RESOLVED id | depends on resolved model | | observed |

Differences among `assistant.message.model` / `model_change.newModel` / `modelMetrics` key: none for explicit models. `auto`: `session.start.selectedModel = "auto"`,
`assistant.message.model` = `session.shutdown.currentModel` = `modelMetrics` key = `mai-code-1.1-flash` (one resolution in one run; it is chosen server-side
and may differ per run/account, so always read the resolved id from `assistant.message.model` or the shutdown, never assume it from `--model`).
Only `model.turn_ended.model` can carry a dated variant (gpt-4o-mini).

Rejected / unavailable on this account (CLI exit 1, no stdout, `Error: Model "<id>" from --model flag is not available.`): `gpt-5.4-nano`, `gpt-4o-mini`, `gpt-4.1`,
`claude-sonnet-5`, `claude-sonnet-5.5`, `gpt-5.5`, `gemini-3.7-flash`, `gemini-3.6-flash`. Not probed (avoid cost): the Opus/Fable/GPT-6/Grok/Kimi ids listed by the docs.
The CLI has no free way to list models: the invalid-model error does not list them, and `-p "/model"` is NOT run as a command (see below). The docs page
(docs.github.com "Supported AI models in GitHub Copilot", Copilot CLI column) lists, with the 1M extended context in VS Code and CLI: Claude Haiku 4.5, Opus 4.7/4.8/5/5.5,
Sonnet 5/5.5, GPT-5.3-Codex, GPT-5.4/5.5/5.6 (Luna, Sol, Terra), GPT-6 (Astra, Luna, Sol), Gemini 3.6/3.7 Flash, MAI-Code-1.1-Flash, Kimi K3. Availability is account/plan dependent
(and the docs-vs-reality gap is visible: Sonnet 5 and Gemini 3.7 Flash are listed but were rejected here), so the hub must not hard-code a model list; the
model id is whatever the operator typed.

### Is there a headless source of window limits?

- stdout JSONL and `events.jsonl` of a plain `-p` turn: NO. Only `model.call_start/finished` (no limits) in stdout; no `model.turn_ended`, no `modelInfo`, no `max_*_tokens`
  (grepped all 11 fresh runs of this step).
- `model.turn_started/message/response/turn_ended/messages_snapshot` (with `modelInfo.capabilities.limits{max_context_window_tokens,max_prompt_tokens,max_output_tokens}`
  and `modelInfo.billing`) ARE written headlessly, but only for the model call made BY A SUCCESSFUL COMPACTION (verified with `/compact` through `-p` on haiku and gpt-5.4: they sit between
  `session.compaction_start` and `session.compaction_complete`; the failed automatic ones from section 2 wrote none). So the data exists only after a compaction; useless as a general source.
- `session.compaction_start/complete.tokenLimit`: written for compaction only (128000 haiku, 922000 gpt-5.4). Equals `max_prompt_tokens` in both cases.
- `session.shutdown`, `session.usage_checkpoint`: no limit (only `currentTokens`, `systemTokens`, `conversationTokens`, `toolDefinitionsTokens`).
- `--usage-output-file`, `~/.copilot/logs/*`, `~/.copilot/config.json`, `~/.copilot/session-store.db` (all tables scanned read-only), session `checkpoints|files|research`,
  `~/.cache/copilot/**/*.json`: no `max_prompt_tokens` / `max_context_window_tokens` values. The only hits are the JSON SCHEMAS under `~/.cache/copilot/pkg/linux-x64/<ver>/schemas/`
  (field definitions, no data). The schemas show the CLI has a `models.list` RPC (returns `capabilities.limits`, `billing.tokenPrices`, `supportedContextTiers`), reachable only through
  the server/ACP mode (`copilot --acp`), not tried.
- Interactive sessions: `model.turn_ended` on every turn (the earlier finding). Not applicable to the runner.
- `-p "/context"` (live, resumed haiku session): slash commands other than `/compact` are NOT executed by `-p`; the text was sent to the model, which called
  `fetch_copilot_cli_documentation` and wrote an invented "context window visualization" (no window size, no percentages, wrong CLI version). Costs a premium request and is
  unreliable. Same for `-p "/model"` (the model just answered that it is Claude Haiku 4.5). Do not use either.

### Long context tier

- Flag: `--context <tier>`, values `default | long_context` (`copilot help`); overrides a persisted setting (none on this machine).
- Recording: `session.start.data.contextTier` and every `session.resume.data.contextTier` carry `"long_context"` when the flag was given on a model that supports it, else `null`
  (the key exists in every event, also for default; there is no `model_change.contextTier` in headless runs). The tier is per invocation: passing it only at `--session-id` creation and
  not at `--resume` is not remembered by the flag itself (to be kept consistent, pass it on every call, as with permission flags).
- Effect on limits, gpt-5.4 (docs list a `>272K` long-context pricing tier): NONE observed. Default-tier session and `long_context` session both reported `modelInfo` 1050000 / 922000
  and `tokenLimit` 922000, `currentTokens` ~13.3k. The tier therefore appears to be a pricing tier (`billing.tokenPrices.longContext`, `multiplier` 6 for gpt-5.4), not a different window.
- haiku-4.5 with `--context long_context`: flag silently ignored (`contextTier: null`, limits unchanged 144000/128000), although the docs page claims a 1M tier for it. Do not trust the docs table.
- Not tested: a prompt really above 272K (cost) and any model whose window differs per tier (claude-sonnet-5 is not available here).

### Decision

- Denominator: `max_prompt_tokens`, NOT `max_context_window_tokens`. Evidence: the CLI's own compaction `tokenLimit` equals `max_prompt_tokens` in both measured models (128000 vs
  window 144000; 922000 vs 1050000); the documented 95% auto-compaction applies to that limit; and `currentTokens` (what the hub reads from `session.shutdown`) is a PROMPT-side figure
  (system + tools + conversation) that is compared by the CLI against it. `occupancy% = session.shutdown.currentTokens / max_prompt_tokens`. The remainder of the window is
  reserved for output (`max_output_tokens`). The GPT-5.4 272K figure on the pricing page is a price tier boundary (gpt-5.4-nano happens to have max_prompt 272000), not the occupancy denominator.
- Source: a static table in `hub/models.ts` keyed by the model id exactly as in `assistant.message.model` / `modelMetrics` key (no runtime source exists for a plain headless run).
  Seed it with the observed values: `claude-haiku-4.5` 128000, `gpt-5.4` 922000, `gpt-5.4-nano` 272000, `gpt-4o-mini` 64000 (strip date suffixes like `-2024-07-18`); store the
  max_prompt value, optionally also the window. For unknown ids use a conservative fallback (128000) and mark the percentage as an estimate.
  Opportunistic refresh: whenever a `session.compaction_start.tokenLimit` or a `model.turn_ended.modelInfo.capabilities.limits` is present in the session, prefer that
  (it is the exact value for the exact model and tier); a successful compaction is the only moment it appears. A future improvement is a `copilot --acp` `models.list` call.
- `auto`: resolve to the id found in `assistant.message.model` (or `session.shutdown.currentModel`), never to the literal `auto`, before the table lookup; if the resolved model is
  unknown to the table, use the fallback. Keep `auto` only as the configured value.
- Long context: do not pass `--context long_context` by default (it did not change any window and increases price). Treat `session.start/resume.contextTier === "long_context"` as
  "window = table value" (observed unchanged); if a model is later seen with a larger `tokenLimit` under that tier, the compaction `tokenLimit` override above picks it up automatically.
- Model validation: a rejected model exits 1 with `Model "<id>" from --model flag is not available.` and no stdout; the adapter/hub should surface that stderr line instead of retrying.

## Open items / could not verify

- Successful AUTOMATIC compaction event (`trigger: "threshold"` with `success: true`, pre/post numbers): all 4 forced runs failed ("Compaction Cancelled" / "received empty response from model"); a real 128k overflow was not attempted for cost. Assumed same shape as the manual event.
- Compaction env var semantics (`COPILOT_BACKGROUND_COMPACTION_THRESHOLD`, `COPILOT_BUFFER_EXHAUSTION_THRESHOLD`) are undocumented and inferred only.
- URL restriction: the sandbox has no DNS, so no genuine `web_fetch`/`curl` could succeed; the effect of `--allow-all-urls` is unknown (section 3).
- `--available-tools` with names that do not exist in a given CLI version was not tested.
- `GH_TOKEN` / `GITHUB_TOKEN` as Docker auth were not tested (only `COPILOT_GITHUB_TOKEN`).
- Window limits unknown for `gpt-5-mini`, `gpt-5.4-mini`, `claude-sonnet-4.6`, `mai-code-1.1-flash` (fallback 128000 applies); `gpt-5.4-nano` and `gpt-4o-mini` values come from earlier interactive sessions and these models are rejected on this account.
- Not probed: Opus, Fable, GPT-6, Grok, Kimi ids; `claude-sonnet-5`, `claude-sonnet-5.5`, `gpt-5.5`, Gemini 3.x were rejected on this account.
- `models.list` RPC via `copilot --acp` (would give limits and `supportedContextTiers`) was not tried.
- `--context long_context` effect above 272K tokens and on models whose window differs per tier was not tested.
- Ordering of final answer vs subagent messages for background/async subagents (`session.background_tasks_changed`) not exercised.
- CLI 1.0.89 (brief) vs 1.0.91 (observed): behaviour was only observed on 1.0.91.
- `auto` resolution observed once only; it is server-side and may vary.
- The combined unset-mode flag set (`--available-tools=view,grep,glob --deny-tool=write --deny-tool=shell`) was derived from M1 and M2, not run as one case.

## Throwaway artefacts

Copilot test sessions (left in `~/.copilot/session-state`, not deleted; the operator's own sessions were untouched):

- Section 1: 2 sessions were created (container-created and host-created resume test); their ids were NOT recorded in the doc or the step file. Identify by `session.start` time on the day of the spike if cleanup is wanted.
- Section 2: `84d04c66-d6c8-4e0e-bc54-bcca0df84217` (Part A compaction), `0402c286-1902-4765-b7cf-7f2742a57e17` (Part B subagent).
- Section 3: 21 live calls, mostly one fresh session each (resume test reused one); ids NOT recorded.
- Section 4: `33204607-37fa-46de-90e6-1cbbcbfd5526`, `f7acec8e-7989-4e71-b033-4e24ecb66f4c`, `531501de-7a97-4026-89eb-a1e54511f44e`, `62e5c2ed-b216-48b9-949f-d7894af8d5cd`, `33bbfb34-531c-4e87-80c5-3699009d77a4`, `4d452007-339a-4a1f-b336-66f0af72d5da`, `de9f42a6-a6f5-4c05-8a77-1d7ea4c48690`, `e193811c-f807-47ee-b14e-8ae66da0d6cc`, `9314504c-ee13-4eb8-8532-85db700e206d`.

Docker and filesystem artefacts: all `copilot-spike-*` containers were run with `--rm` and none remain (`docker ps -a --filter name=copilot-spike-` empty); the `copilot-spike:tmp` image was removed (`docker images copilot-spike` empty, re-checked in step 5); `/tmp` scratch dirs of sections 1, 3 and 4 were removed (no `/tmp/*copilot*` or `/tmp/*spike*` dirs remain at step 5). Side effect kept: `~/.cache/copilot/pkg/linux-x64/<ver>/` may hold the container CLI version (harmless).

## Corrections

*Later workflows append corrections here.*

- **Docker token delivery: the "NAME only" decision was reversed (workflow
  "copilot-docker-token-flow").** Sections 1 and the e2e below forward
  `COPILOT_GITHUB_TOKEN` by name only, with the value taken from the broker's
  environment and never stored. The operator reversed that: the broker is a
  separate process that never reads the hub's `.env` and, for a desktop-menu
  launch, inherits no shell exports, so the name-only entry left copilot docker
  workflows without a token for exactly those users. The hub now resolves the
  token itself (environment, then a token pasted in Settings, then `gh auth
  token`), writes `COPILOT_GITHUB_TOKEN=<value>` into the hook's `sandbox.env`
  and refreshes it before each dispatch; `hooks.json` is therefore written with
  mode 600. To keep the value off every command line, awb now emits only
  `-e COPILOT_GITHUB_TOKEN` in argv and sets the value in the environment of
  the spawned `docker` client process (`extraEnv` in `runHidden`/`runVisible`);
  docker copies it into the container. It is absent from `ps` and from the run
  log header, and the log header writer redacts any `-e NAME=<long value>`
  defensively. Details and the leak audit:
  [`copilot-docker-token-report.md`](copilot-docker-token-report.md).

## Docker e2e

Real end-to-end run of `runner: copilot` + `sandbox: docker` (workflow 5, step 4/4), 2026-10-02, Copilot CLI 1.0.91 in `target-agent-copilot:latest` (built from `Dockerfile.copilot`). Throwaway instances only: broker `8990`, hub `8993`, `AWB_HOME`/`TARGET_HOME` under a `/tmp/copilot-e2e-*` dir, real `HOME`; the live 8890/8893 were not touched.

Setup (the token is derived into the variable without printing it and is never written to a file):

```
export COPILOT_GITHUB_TOKEN="$(gh auth token)"      # shell-only, value never echoed
export COPILOT_MODEL=claude-haiku-4.5               # cheap model, see note below
(cd vendor/agent-webhook-bridge && AWB_HOME=$T/awb node broker/daemon.ts) &     # 8990
(cd hub && TARGET_HOME=$T/target AWB_HOME=$T/awb node daemon.ts) &              # 8993
POST /api/workflows {name, runner:"copilot", sandbox:"docker", permissionMode:"acceptEdits", workdir:"$T/work"}   # no image
POST /api/workflows/:id/steps  x2 (with acceptanceCriteria, maxRetries 2)
POST /api/workflows/:id/start {stepIds:[...]}
```

Model: the adapter passes no `--model` (the hub does not choose one), so the cheap model was selected with the CLI's own `COPILOT_MODEL` variable. Only declared env names are forwarded into the container, so for this test only `"COPILOT_MODEL"` was appended by hand to the throwaway hook's `sandbox.env` (`["COPILOT_GITHUB_TOKEN","COPILOT_MODEL"]`); this is not a product change.

| Check | Result | Evidence |
|-------|--------|----------|
| Image chosen by default | PASS | create response: `"sandbox":"docker","image":"target-agent-copilot:latest"` with no image sent; hook block `{kind, image, env:["COPILOT_GITHUB_TOKEN"]}` |
| Workflow completed, both steps judged | PASS | status `completed`, 2/2 done, retries 0/2; hub log `step ... passed the judge` for both steps |
| Session chaining | PASS | step 1 ran `--session-id=431a3e41-...`; every later run (judge 1, step 2, judge 2) ran `--resume=431a3e41-...`; workflow `lastSessionId` the same |
| `note.txt` content and ownership | PASS | content `docker copilot ok` / `step two`; owner `1000:1000` (the operator's uid, not root) |
| Broker log shows the docker run | PASS | awb run log: `docker run --rm --init --user 1000:1000 --memory 4g --cpus 2 --pids-limit 512 -v <workdir>:<workdir> ... -v ~/.copilot:~/.copilot -v ~/.cache/copilot:~/.cache/copilot -e HOME=/home/lenovo -e COPILOT_GITHUB_TOKEN -e COPILOT_MODEL -w <workdir> target-agent-copilot:latest copilot -p "..." --output-format json --stream off --no-auto-update --no-color --no-ask-user --session-id=... --allow-tool ... --deny-tool ...`; the token appears by NAME only |
| session-info | PASS | `GET /api/workflows/:id/session-info`: `harness:"copilot"`, `sandbox:"docker"`, `image:"target-agent-copilot:latest"`, session id as above, `usage.model:"claude-haiku-4.5"`, 17 turns, 387552 total input tokens, 3629 output, window 128000, `includesSubagents:true`, read from the host `~/.copilot/session-state/<id>/events.jsonl` that the container wrote through the mount |
| Resume command shape | PASS | `hookRuntime` + `harnessResumeCommand` for the hook: starts `docker run --rm -it --user 1000:1000 ...`, mounts workdir, `~/.copilot`, `~/.cache/copilot` and the step-results dir, `-e 'COPILOT_AUTO_UPDATE=false' -e COPILOT_GITHUB_TOKEN -e COPILOT_MODEL`, ends `'target-agent-copilot:latest' copilot --resume='431a3e41-...'`; the token value is not in the string |
| Host/container resume proof | PASS | same command with `-it` replaced by `--name copilot-spike-resume` plus `-p 'Say ok' --allow-all-tools --output-format json`: exit 0, result line carries the same `sessionId`, so the session built in the container resumes through the mounted state |

The hub does not return the resume command over the API (`open-terminal` spawns a terminal), so it was built through the same functions (`hookRuntime`, `harnessResumeCommand`) rather than by opening a terminal window.

Cleanup: both throwaway processes stopped by saved PID after checking `/proc/<pid>/environ` for the throwaway dir; ports 8990/8993 free; no `copilot-spike-*` container and none created from `target-agent-copilot` remain; live 8890/8893 still listening, never restarted.

Bugs found: none in the hub or the vendor awb during this run.

Open issues / notes:
- `COPILOT_MODEL` is not forwarded by default (only `COPILOT_GITHUB_TOKEN` is declared); a model other than the account default in docker needs the hook env or a future `--model` option.
- Terminals that hand off to a server process (e.g. `gnome-terminal`) may not inherit the hub's `COPILOT_GITHUB_TOKEN`, so the interactive docker resume would then start without a token. The value is deliberately not put on the command line.
