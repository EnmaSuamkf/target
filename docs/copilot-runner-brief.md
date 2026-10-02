# Brief: add GitHub Copilot CLI as a 4th runner (`copilot`)

Shared handover for the 7 workflows that implement this feature. Uncommitted on purpose
(the operator asked to work on `main` with NO commits). Read it fully before any step.

## Goal

Add GitHub Copilot CLI (binary `copilot`, npm `@github/copilot`, v1.0.89 installed on this
machine) as a runner with id `copilot` next to `claude`, `free-code` and `cursor` in The Target
Project: a workflow can be created with `runner: copilot`, its steps run `copilot -p ...`,
sessions chain across steps, token usage / model / context occupancy / compaction are read from
Copilot's own files, and it works on the host and in Docker.

## Workflow order (execution order)

1. `copilot-runner-spike` – verify the unknowns against the real CLI, write `docs/copilot-runner-spike.md`.
2. `copilot-awb-adapter` – awb: `spawn:copilot` adapter (vendor clone), then fast-forward the Documentos clone.
3. `copilot-hub-runner-core` – hub: runner registration, resume command, CLI/MCP/UI/agent-sync, tests.
4. `copilot-hub-context-usage` – hub: usage/model/occupancy/compaction readers, models table, conversations, progress.
5. `copilot-hub-docker` – hub: `Dockerfile.copilot`, mounts, auth, docker end-to-end.
6. `copilot-target-server` – target-server: whitelist, UI label, pricing docs/rules (independent; may run any time after #1).
7. `copilot-docs-and-e2e` – docs/CHANGELOG + full end-to-end on throwaway instances + final status.

## Repos (all under /home/lenovo/Documentos)

- `target` – hub (`hub/*.ts`, `hub/ui`), `mcp/`, `scripts/`, `docs/`, `Dockerfile*`, `skills/`.
- `target/vendor/agent-webhook-bridge` – awb broker clone the hub uses (gitignored in `target`; it is its own git clone of github.com/EnmaSuamkf/agent-webhook-bridge, currently == origin/main). This is the source of truth for awb.
- `agent-webhook-bridge` – second clone of the same remote, 3 commits behind origin/main (clean tree).
- `target-server` – central report/sync server (`*.mjs` + `ui/` React).

## HARD RULES

- Work directly on `main`. NEVER create branches, commit, push, stash or reset. Leave every change uncommitted.
- NEVER kill or restart the live broker (port 8890) or the live hub (port 8893): these workflows run through them. For end-to-end runs use throwaway instances on spare ports (e.g. broker 8990, hub 8993) with throwaway `AWB_HOME` / `TARGET_HOME`, and stop them by PID only (never `pkill -f`).
- Never print, log or store secrets (GitHub tokens, `gh auth token` output).
- Real `copilot` calls spend the operator's premium requests: always `--model claude-haiku-4.5`, tiny prompts, scratch dirs under /tmp, fixtures instead of repeated live calls. The operator's real `~/.copilot/session-state` sessions must not be modified or deleted; test sessions you create may be left.
- For web research use the `free-browser` skill (`~/.free-browser/bin/free-browser`, export `AGENT_BROWSER_ARGS=--no-sandbox` if Chrome complains) or web search. Official docs live on docs.github.com.
- Match surrounding code style and comment density; keep `npm run typecheck` and the test suites green.

## Verified facts about Copilot CLI 1.0.89 (observed live)

- Headless: `copilot -p "<prompt>" --output-format json --allow-all-tools --no-auto-update` emits JSONL. The LAST line is
  `{"type":"result","sessionId":"<uuid>","exitCode":0,"usage":{"premiumRequests":N,"totalApiDurationMs":..,"sessionDurationMs":..,"codeChanges":{..}}}`
  and carries NO answer text. The answer is the last `assistant.message` event whose `data.toolRequests` is empty and `data.content` non-empty (a tool-calling message has content ""). Also: `--stream on|off`, `--usage-output-file <file>`, `--no-color`, `--no-ask-user`.
- Sessions: new session `--session-id=<uuid>`; resume `--resume=<id>` (unknown id => exit 1, stderr `No session, task, or name matched ...`, no stdout). The session id is a bare uuid (same shape as claude/cursor ids, so shape-sniffing cannot tell runners apart). Storage `~/.copilot/session-state/<uuid>/{events.jsonl,workspace.yaml}` (dir overridable with `COPILOT_HOME`). A resumed session keeps running in the cwd where it was CREATED, ignoring the invoking cwd; lookup is cwd-independent.
- `events.jsonl` events: `session.start`, `session.model_change{newModel}`, `user.message{content}`, `assistant.turn_start/end`, `assistant.message{model,content,toolRequests,outputTokens}`, `tool.execution_start/complete`, `session.usage_checkpoint`, `session.resume`, `session.shutdown`, `session.compaction_start/complete`. Files grow fast (encrypted reasoning blobs, snapshots): never parse them fully on every poll.
- `session.shutdown.data` (written at EVERY process exit): `totalPremiumRequests`, `modelMetrics.<model>.{usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens},requests{count,cost}}`, `agentMetrics.<agent>...`, `currentModel`, `currentTokens`, `systemTokens`, `conversationTokens`, `toolDefinitionsTokens`. Metrics are CUMULATIVE for the whole session across resumes.
- CRITICAL token semantics: `inputTokens` is the TOTAL input and already INCLUDES cacheRead and cacheWrite (example: input 15704 = cacheWrite 15694 + 10 uncached). So `uncached = inputTokens - cacheRead - cacheWrite`. The hub's usual `input + cacheCreation + cacheRead` would double count. `currentTokens` is the exact current context occupancy (not an estimate).
- Compaction, verified with `/compact` sent through `-p`: `session.compaction_start{trigger:"manual",currentTokens,systemTokens,conversationTokens,toolDefinitionsTokens}` then `session.compaction_complete{success,preCompactionTokens,postCompactionTokens,messagesRemoved,summaryContent}` are written to the same `events.jsonl` (NOT to stdout). Session id survives; the summary kept the agent's memory. Per docs auto compaction starts near 95% of the limit (also env `COPILOT_BACKGROUND_COMPACTION_THRESHOLD` / `COPILOT_BUFFER_EXHAUSTION_THRESHOLD` per a third-party page); the `trigger` value for auto is UNVERIFIED.
- Permissions in `-p` without flags: writes are denied ("Permission denied and could not request permission from user") while some safe shell commands (`echo`) still run; the exit code stays 0 even when a tool was denied. Flags: `--allow-all-tools`, `--allow-tool` / `--deny-tool` (`shell(git:*)`, `write`), `--allow-all-paths`, `--allow-all-urls`, `--allow-all`/`--yolo`. Denials beat allows. Do NOT set env `COPILOT_ALLOW_ALL=true` (it also trusts the directory).
- Works in non-git dirs with no trust prompt. Writes `~/.cache/copilot` and `~/.cache/Microsoft` besides `~/.copilot`. Built-in subagent tool is `task` (same idea as Claude's Task tool, so the hub's SUBAGENT_SUFFIX works unchanged). Autoupdate can be disabled with `--no-auto-update` / `COPILOT_AUTO_UPDATE=false`.
- Auth: with `env -i` and a fresh HOME the CLI still authenticated, so credentials appear to come from the OS keyring (D-Bus), outside HOME. Inside Docker there is no keyring, so `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN`/`GITHUB_TOKEN`) env is probably required. UNVERIFIED.
- MCP: `~/.copilot/mcp-config.json` key `mcpServers`; the server block hub/agent-sync.ts writes for other harnesses is accepted as-is (`copilot mcp list` / `get` show it, tools `*`). Skills dir `~/.copilot/skills/`.
- Models: ids use dots, e.g. `claude-haiku-4.5`, `gpt-5-mini`, `gpt-5.4`, `gpt-5.4-nano`; `--model auto` lets Copilot pick (the resolved id appears in `session.model_change` / `assistant.message.model`). Many more exist (Claude Sonnet 4.6/5/5.5, Opus 4.7/4.8/5/5.5, Fable 5/5.1, GPT-5.x/6.x, Gemini 3.x Flash, Grok 4.x, Kimi K2.7 Code/K3, MAI-Code-1.1-Flash). Each model has `max_context_window_tokens` and `max_prompt_tokens` (gpt-5.4-nano 400000/272000, gpt-4o-mini 128000/64000), visible only in interactive `model.turn_ended` events. `--context long_context` selects the 1M tier on models that support it (costs more).
- Cost: Copilot bills per token (1 AI credit = $0.01 USD, per docs.github.com "Models and pricing for GitHub Copilot"). The hub never computes cost: `cost_usd` stays null and the report server prices by (agent, model). Accounts on the legacy plan report `totalNanoAiu: 0` and `premiumRequests` instead.

## How a runner is wired today (Cursor was the last one added)

Use `git show fbbb30c 8ee426e 10e8241 bb18473 9bd4d75 9e5c8c3 eb97ed3` in the `target` repo as templates, and `git show 659bc76 300e74d` in the awb vendor clone.

- hub: `hub/awb.ts` (PUBLISHABLE_RUNNERS, RUNNER_BINARIES, DEFAULT_SANDBOX_IMAGES, BUILDABLE_SANDBOX_IMAGES, HARNESS_RESUME_COMMANDS, harnessStateMounts, HARNESS_RESUME_ENV, availableRunners), `hub/transcript.ts` (usage/model/compaction readers; `readTokenUsage` currently SNIFFS the runner from the session id), `hub/models.ts` (context windows), `hub/conversations.ts`, `hub/progress.ts`, `hub/compaction.ts`, `hub/agent-sync.ts` + `mcp/runners.manifest.json`, `hub/cli.ts`, `mcp/target-mcp.mjs` (has its own RUNNERS list), `hub/ui` (`api/types.ts`, `views/CreateWorkflowModal.tsx`), `Dockerfile.<runner>`, `scripts/install.ts`, `skills/create-workflow/SKILL.md`, docs, tests (`hub/*.test.ts`, `hub/test-setup.ts`).
- awb: `adapters/spawn-runner/<runner>.ts`, `broker/dispatch.ts`, `adapters/spawn-runner/sandbox.ts` (`harnessStateMounts`, `env` forwarding), `cli/awb.ts` (`VALID_RUNNERS`, which currently lacks cursor too).
- Runtime link: the hub writes `spawn:<runner>` into awb's hooks.json; an awb broker WITHOUT the adapter silently stores the event and the step hangs until its timeout, so the hub must not offer a runner the broker cannot run.
- `target-server`: `blueprint.mjs` line ~646 has `agent: Joi.string().valid("claude","free-code","cursor")` for `sync.remote_workflow.create`; `ui/src/components/RemoteWorkflowsPanel.tsx` has `RUNNER_LABELS`; pricing rules are per (agent, model) in `pricing.mjs`/`docs/pricing.md`; the rest of the event pipeline treats `agent` as a free string.

## Handoff

- Workflow 1 writes `docs/copilot-runner-spike.md` (target repo). Every later workflow reads it and follows its decisions; if a later step finds a decision wrong, it records the correction in a section "Corrections" at the end of that same file.
- Workflow 7 writes the final status to `docs/copilot-runner-status.md`.
