# Copilot runner: end-to-end report (workflow 7, step 2/3)

Date 2026-10-02. Real `copilot` CLI 1.0.91 (default model forced to `claude-haiku-4.5` through
`COPILOT_MODEL` in the broker's environment), real awb broker from
`vendor/agent-webhook-bridge`, real hub from this checkout. Everything ran on throwaway
instances; no token or secret appears below (the hub admin token was read from the throwaway hub's
log into a `0600` file under the throwaway dir and only ever sent as a Bearer header).

## Setup

```
T=$(mktemp -d /tmp/copilot-e2e-XXXXXX)          # /tmp/copilot-e2e-1WFdXO
mkdir -p $T/{awb,target,work1,work2}
echo '{"host":"127.0.0.1","port":8990,"maxBodyBytes":1048576,"publicBaseUrl":null,"hooks":{}}' > $T/awb/hooks.json
echo '{"port": 8993}' > $T/target/config.json
(cd vendor/agent-webhook-bridge && AWB_HOME=$T/awb COPILOT_MODEL=claude-haiku-4.5 node broker/daemon.ts) &   # 8990
(cd hub && TARGET_HOME=$T/target AWB_HOME=$T/awb node daemon.ts) &                                          # 8993
```

- Ports 8990/8993 were free beforehand. Live broker 8890 (pid 772936) and live hub 8893 (pid 772937)
  were listening before and after with the same PIDs: never touched.
- Throwaway PIDs 971640 (broker) and 971651 (hub) were taken from `ss -ltnp`, confirmed through
  `/proc/<pid>/environ` (`AWB_HOME=$T/awb`), saved to files and stopped with `kill <pid>`.
- Both answered `/health` (`{"ok":true,...}`). The hub requires `Authorization: Bearer <admin token>` on `/api/*`.
- The reporting outbox is disabled on the throwaway hub (no server linked), so no `usage.snapshot`
  row is written there; check 6 builds the payload through the same function the hub calls.

## Results

| # | Check | Result |
|---|-------|--------|
| 1 | `GET /api/runners` lists copilot installed | PASS |
| 2 | Two-step copilot host workflow (acceptEdits, 2 steps with criteria, maxRetries 2) completes, judge passes | PASS |
| 3 | session-info, chaining, token numbers, resume command, conversations listing + preview | PASS |
| 4 | No permissionMode: read-only mapping, file NOT created | PASS (with a caveat, see Open issues) |
| 5 | Compaction boundary detected, context re-injected on the next step | PASS (compaction forced by running `/compact` directly, see Open issues) |
| 6 | `usage.snapshot` payload has `agent: "copilot"` | PASS |

## 1. Runners

`GET /api/runners` -> `{"runners":[{"id":"claude","installed":true},{"id":"free-code","installed":false},{"id":"cursor","installed":true},{"id":"copilot","installed":true}],"sandboxes":[{"id":"host","available":true},{"id":"docker","available":true}]}`.

## 2. Two-step workflow

Workflow `copilot-e2e-1` (id `9efd9b2a…`), `harness: "copilot"`, `permissionMode: "acceptEdits"`, `sandbox: "host"`,
workdir `$T/work1`. Step 1: create `hello.txt` with exactly `hello copilot`. Step 2: append `second step` and report
the content. Both steps had acceptance criteria and `maxRetries: 2`.

- Polled to `completed`, progress 2/2 (about 60 s). Hub log: both `step … done, dispatching judge` and `step … passed the judge`.
- `hello.txt` is `hello copilot\nsecond step` (no trailing newline).
- awb commands (from the run logs, token-free): `copilot -p … --output-format json --stream off --no-auto-update --no-color --no-ask-user --session-id=8d112047… --allow-tool=write --deny-tool=shell`, then `… --resume=8d112047… --allow-tool=write --deny-tool=shell` for step 2 and both judges.
- Shell was denied three times with `error.code "denied"`, `Permission to run this tool was denied due to the following rules: \`shell\`` (the agents tried `bash` to read the file): this is the `acceptEdits` mapping working.

## 3. Session info, chaining, tokens, resume, conversations

Session id (truncated): `8d112047…`. Step 1 and step 2 `sessionId` both `8d112047…` and the workflow's `lastSessionId` the same: chaining PASS.

`GET /api/workflows/:id/session-info` after the two steps (4 copilot runs: 2 steps + 2 judges, 4 `session.shutdown` events) against the LAST `session.shutdown` in
`~/.copilot/session-state/8d112047…/events.jsonl`:

| Field | Hub | events.jsonl shutdown | Match |
|-------|-----|------------------------|-------|
| `harness` | `copilot` | n/a | yes |
| `usage.model` | `claude-haiku-4.5` | `currentModel` `claude-haiku-4.5` | yes |
| `totalInputTokens` | 270598 | `inputTokens` 270598 | yes |
| `inputTokens` (uncached) | 126 | 270598 − 233829 (cacheRead) − 36643 (cacheWrite) = 126 | yes |
| `cacheReadTokens` / `cacheCreationTokens` | 233829 / 36643 | `cacheReadTokens` 233829 / `cacheWriteTokens` 36643 | yes |
| `outputTokens` | 2983 | 2983 | yes |
| `turns` | 17 | `requests.count` 17 | yes |
| `contextTokens` | 15649 | `currentTokens` 15649 | yes |
| `contextWindow` | 128000 | (table value for `claude-haiku-4.5`) | > 0 |
| `contextEstimated` | false | n/a | yes |
| `includesSubagents` / `costUsd` | true / null | n/a | as designed |

`totalInputTokens` = 126 + 36643 + 233829 = 270598: no double counting (adding the cache buckets to Copilot's `inputTokens` would have given 541070).

Open conversation: the route builds `harnessResumeCommand(...)` and spawns a terminal; to avoid opening a window the same functions
were called with the hook's URL (`hookRuntime`): `{"harness":"copilot","workdir":"$T/work1","sandbox":null,"permissionMode":"acceptEdits"}`,
command `copilot --resume='8d112047-c5f6-406a-9d74-e948f38c5c6a'` (workdir is the terminal's cwd), env `{"COPILOT_AUTO_UPDATE":"false"}`.

Conversations: `GET /api/conversations?runner=copilot` returned 45 sessions (the operator's real ones too, read only) and includes
`{"runner":"copilot","sessionId":"8d112047…","workdir":"$T/work1","title":"Workflow \"copilot-e2e-1\"","updatedAt":"2026-10-02T05:58:35Z","sizeBytes":269218}`.
`GET /api/conversations/preview?runner=copilot&sessionId=8d112047…` returned `turns: 11, shownTurns: 11`, `adoptable: {ok: true, workdir: $T/work1}` and text
made of `User:` (the step prompts) and `Assistant:` turns ("I'll delegate this task to a subagent…", "Done.", "**Result:** The file `hello.txt` has been successfully updated…").

## 4. Permission modes

Workflow `copilot-e2e-ro` (`f6aa478e…`), created without `permissionMode` (reports `null`; the hook has no `permissionMode`). One step: create
`should-not-exist.txt` containing `nope`.

- The awb command carried `--available-tools=view,grep,glob --deny-tool=write --deny-tool=shell`.
- The step reached `done` and the workflow `completed`, but `$T/work2` stayed EMPTY: the file was not created.
- `events.jsonl`: the agent requested only `view`; there was no `create`/`edit`/`bash` call, because those tools do not exist in this mode, so no `denied` event either.
- What the hub shows: the step result text claims success (`Now I'll create the file: echo "nope" > …/should-not-exist.txt … Successfully created file`). It is the model describing something it could not do (the spike already warned never to trust answer text for what changed). The hub shows no warning.
- acceptEdits (check 2) behaved as mapped: file writes worked, `bash` denied.

## 5. Compaction

1. Conversation context `CONTEXT-MARKER: the project codeword is pelican-42.` set on workflow 1 (`PUT /api/workflows/:id/context`); extra steps 3 (`/compact`) and 4 added.
2. Step 3 as a workflow step: the hub wraps every step description inside its prompt, so `/compact` is NOT at the start of the prompt and Copilot does not treat it as a command. The agent merely answered "Acknowledged. The `/compact` command has been noted…"; `session-info` stayed `compactions: 0`. (This step also injected the context, as `contextInjected` was still false.)
3. Forced real compaction with the CLI itself, same session, same flags: `cd $T/work1 && COPILOT_MODEL=claude-haiku-4.5 copilot -p "/compact" --output-format json --stream off --no-auto-update --no-color --no-ask-user --resume=8d112047… --allow-tool=write --deny-tool=shell`. `events.jsonl` got
   `session.compaction_start{trigger:"manual",currentTokens:16117,…}` and `session.compaction_complete{success:true,preCompactionTokens:3236,postCompactionTokens:2887,messagesRemoved:22,tokenLimit:128000,trigger:"manual"}` at `2026-10-02T06:03:10.493Z`.
4. Hub right after (no restart): `session-info` -> `usage.compactions: 1`, `usage.lastCompactionAt` and top-level `lastCompactionAt` = `2026-10-02T06:03:10.493Z`, `compactionPending: true`; hub log `[warn] workflow 9efd9b2a…: conversation 8d112047… was compacted at 2026-10-02T06:03:10.493Z — its earlier history is now a summary; the conversation context will be re-injected on the next step`.
5. Step 4: the awb prompt (run log) began with the compacted notice ("…compacted, so its earlier turns have been replaced by a summary and detail has been lost. Restating the workflow's background in full — treat this as authoritative…") followed by `CONTEXT-MARKER: the project codeword is pelican-42.`, and ran with `--resume=8d112047…`. The agent answered `pelican-42` plus the file content; afterwards `compactionPending: false`. The log also has `[warn] step … resumes conversation 8d112047…, which was compacted at …`.
6. Accounting: totals did not grow because of the compaction call itself (expected, the compaction tokens are not in `modelMetrics`); `usage.contextTokens` after it was 15770, the new shutdown's `currentTokens`.

## 6. usage.snapshot

Reporting is off on the throwaway hub, so the payload was produced by the call `workflow.ts:2708` makes
(`usageSnapshot(readTokenUsage(workdir, sessionId, hookRuntime(hookUrl).harness), runtime.harness)`) at the end of the run:

```json
{"agent":"copilot","input_tokens":375361,"output_tokens":4384,"input_tokens_uncached":178,"cache_creation":47503,"cache_read":327680,
 "context_tokens":16904,"context_window":128000,"context_pct":13.2,"context_estimated":false,"model":"claude-haiku-4.5",
 "turns":23,"includes_subagents":true,"compacted":true,"cost_usd":null}
```

Last `session.shutdown` (8th) for comparison: `inputTokens 375361`, `cacheReadTokens 327680`, `cacheWriteTokens 47503`, `outputTokens 4384`,
`requests.count 23`, `currentTokens 16904`; 375361 − 327680 − 47503 = 178 = `input_tokens_uncached`. PASS.

## Bugs found

None in the hub or the vendored awb during this run; no code was changed in this step.

## Open issues / limitations (not bugs of the implementation)

1. **Read-only mode hides the failure.** With the tools removed there is no `denied` event, and a model can write a convincing "I created the file" answer; the step is `done` and nothing in the hub flags that nothing was written. The hub has no check of denied tool calls (the spike suggested warning on `error.code: "denied"`; nothing in `hub/` implements it). Judges with real acceptance criteria catch it, steps without criteria do not.
2. **`/compact` cannot be forced through a workflow step**, because the prompt is wrapped (see check 5). Compaction was exercised by running the CLI directly on the session. A genuine automatic compaction (`trigger: "threshold"`, `success: true`) is still unverified, as in the spike.
3. **Usage reporting not exercised end to end:** the throwaway hub has no linked server, so no `usage.snapshot` event reached an outbox; only the payload function was checked.
4. **Open conversation was checked at command level**, not by opening a terminal window.
5. Cost of the run: about 3 premium requests of `claude-haiku-4.5` (workflow 1 plus the compaction call) and 0.33 for the read-only workflow.

## Cleanup

Both throwaway processes stopped by PID (`kill 971651 971640`); `ss -ltnp | grep -E ':(8990|8993)'` prints nothing; live 8890 (pid 772936) and 8893 (pid 772937) still listening with unchanged PIDs; no container was started. The throwaway dir `/tmp/copilot-e2e-1WFdXO` and the test sessions `8d112047…` and `f96e7f1c…` under `~/.copilot/session-state` were left in place (the operator's own sessions were not modified).
