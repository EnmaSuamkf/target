# Feature: Per-workflow runtime (`--runner`)

Let a workflow choose which coding-agent CLI its dedicated agent spawns:
**Claude Code** (the default, unchanged),
**[free-code](https://github.com/EnmaSuamkf/free-code)**, **Cursor Agent** or
**GitHub Copilot CLI** — the runtimes agent-webhook-bridge's spawn adapters
support. The text below was written for free-code and still describes its
details; [GitHub Copilot CLI](#github-copilot-cli-runner-copilot) has its own
section at the end.

## Why

The Target Project's engine was already runtime-agnostic in everything that matters: it
talks to the awb hook over the shared hook protocol (secret, `callbackUrl`,
`sessionId` header), and awb ships both a `spawn:claude` and a
`spawn:free-code` adapter that produce the same `{result, session_id}`
callback envelope. The only thing pinning The Target Project to Claude was that
`createAwbHook` hard-coded `consumers: ["spawn:claude"]`, plus a few places
that assumed Claude's session/transcript conventions.

## What changed

| File | Change |
|---|---|
| `hub/awb.ts` | `PUBLISHABLE_RUNNERS` (`claude`, `free-code`, `cursor`, `copilot`); `HookOptions.runner`; `createAwbHook` writes `spawn:<runner>`; `HARNESS_RESUME_COMMANDS` gains `free-code --session <path>` |
| `hub/workflow.ts` | `createWorkflow` accepts and forwards `runner` |
| `hub/server.ts` | `POST /api/workflows` validates an optional `runner` body field against `PUBLISHABLE_RUNNERS`, and for a host sandbox rejects a runner whose CLI isn't installed on this machine (via `availableRunners()`); `GET /api/runners` exposes that probe to the create form |
| `hub/cli.ts` | `target create` / `create-from-template` accept `--runner <claude\|free-code\|cursor\|copilot>` and verify that CLI is installed on the host before POSTing (host only; `--force` warns-and-proceeds, docker isn't blocked) |
| `hub/transcript.ts` | `readTokenUsage` detects a free-code session (an absolute `.jsonl` path), reads the transcript directly, and normalises free-code's usage shape (`input`/`output`/`cacheRead`/`cacheWrite`) alongside Claude's (`input_tokens`/…) |
| `hub/tokens.ts` | the CLI accepts a free-code `.jsonl` path as its argument |
| `hub/ui` | `Runner` type + `runner` on `CreateWorkflowInput`; an **Agent runtime** selector in the New-workflow modal that offers ONLY the agents `GET /api/runners` reports as installed — with an explicit error when the hub is unreachable or none are installed, never a silent fallback to both |
| `hub/runner-harness.test.ts` | Tests: consumers written, harness surfaced, resume commands, runner validation, free-code usage reading, session-info and open-terminal on a free-code workflow |

## What deliberately did NOT change

- **The engine.** Sequential dispatch, judge/retries, conversation context,
  step selection, abort, on-demand runs: all identical for both runners —
  they only ever see the hook URL and the opaque `sessionId`.
- **The default.** A workflow created without `runner` still spawns Claude
  Code; existing workflows and hooks are untouched.
- **The session-id contract.** The hub round-trips whatever `session_id` the
  callback reports. For free-code that value happens to be the session
  file's absolute path (awb keeps it under
  `~/.agent-webhook-bridge/sessions/<agent>/` and guards it against
  path traversal on its side).

## Behaviour differences the operator sees

- **Session ids** are `.jsonl` paths, shown as-is in the Conversation panel
  and the progress `.md`.
- **"Open conversation"** spawns `free-code --session <path> --no-rag-server`
  instead of `claude --resume <uuid>`. Like the steps, the reopened terminal
  loads free-code's full environment — extensions (subagent widget included),
  skills, prompt templates and themes auto-discovered from `~/.free-code` and
  the workdir. The terminal also sets `FREE_CODE_STARTUP_PROFILE=default`
  (a docker resume gets it as a `-e` flag), which free-code's profile-manager
  extension reads to apply the default profile instead of stopping the
  terminal on its startup profile picker. `--no-rag-server` skips the local
  Python RAG server auto-start, which isn't installed in the docker image and
  otherwise blocks ~90s before the conversation paints (an apparently empty
  terminal).
- **Steps run with the full free-code environment.** awb's free-code adapter
  passes only `--no-rag-server` (plus the `--tools` set mapped from the
  hook's `permissionMode`): no `--no-extensions`, no `--no-skills`, so a step
  has the same extensions, skills and MCP tools as running free-code by hand
  in that directory. `~/.free-code` is mounted at its own path in the docker
  sandbox, so discovery agrees on both sides.
- **Permissions**: awb maps the hook's `permissionMode` to free-code's
  `--tools` flag (unset → read-only; `acceptEdits` → +write/edit, no bash;
  `bypassPermissions`/`auto`/`dontAsk` → full incl. bash; `manual`/`plan` →
  read-only). Same opt-in risk model.
- **Token usage** comes from free-code's own per-message usage records; the
  context-window meter measures them against the window of the model in the
  last `model_change` record (`hub/models.ts`, e.g. kimi-k3 → 1,048,576), and
  there are no subagent transcripts to fold in. See
  [`context-meter.md`](context-meter.md).
- **The runner is fixed at creation** — it's baked into the hook's
  `consumers` — so switching runtime means creating a new workflow.
- **Only installed agents are offered.** The create form probes each runner
  with `<cli> --version` (`GET /api/runners`) and offers just the ones that
  answer; an uninstalled CLI is never selectable, not even as a disabled
  "(not installed)" entry. A host workflow whose runner isn't installed is
  rejected at creation (server and CLI both), while a docker workflow is not —
  the image ships its own binary.

## GitHub Copilot CLI (runner `copilot`)

`--runner copilot` spawns `copilot -p` per step through awb's `spawn:copilot`
adapter. What differs from the other runners:

- **Session ids are bare uuids**, the same shape as claude's and Cursor's, so
  the id alone cannot say which runner owns it: the hub decides from the
  workflow's runner. Shape-sniffing is only the fallback for a bare session id
  with no workflow, and treats it as Copilot only when
  `~/.copilot/session-state/<id>/` exists and no Claude or Cursor artefact does. The
  first step runs with `--session-id=<fresh uuid>` and every later step and
  judge with `--resume=<id>`; an unknown id exits 1 with `No session, task, or
  name matched …` instead of silently starting a new session.
- **"Open conversation"** runs `copilot --resume=<id>` (with the `=`; a
  space-separated value is read as a session name). A docker workflow gets the
  same `docker run --rm -it …` shape as the others, with `~/.copilot` and
  `~/.cache/copilot` mounted at their own paths and `COPILOT_AUTO_UPDATE=false`.
- **A resumed session keeps its original cwd.** Lookup by id is independent of
  the directory, but the session keeps running in the one it was created in,
  which is why the workflow's workdir is fixed at creation too.
- **Permissions** are tool flags, evaluated per call and not stored in the
  session, so awb passes them on every call, first and resumed. Copilot cannot
  ask in `-p`: an unapproved call is denied at once and the process still
  exits 0 (the denial shows as `error.code: "denied"` on the tool event).

  | Permission mode | Flags | Effect |
  |---|---|---|
  | unset, `manual`, `plan` | `--available-tools=view,grep,glob --deny-tool=write --deny-tool=shell` | read-only |
  | `acceptEdits` | `--allow-tool=write --deny-tool=shell` | edits yes, shell no |
  | `auto`, `dontAsk` | `--allow-all-tools` | all tools; paths limited to the workdir and `/tmp` |
  | `bypassPermissions` | `--allow-all` | everything: tools, any path, any URL |

  `task` (subagents) is left out of the read-only set on purpose: nested
  subagents recurse and cost requests.
- **Usage, model and context** are read from
  `~/.copilot/session-state/<id>/events.jsonl` (`COPILOT_HOME` overrides the
  base): the last `session.shutdown` event, written at every process exit,
  carries cumulative `modelMetrics` for the whole session, subagents included.
  The hub reads only the tail of the file, since it grows quickly. Copilot's
  `inputTokens` already **includes** its cache buckets, so the hub shows
  `inputTokens − cacheRead − cacheWrite` as the uncached part. Occupancy is the
  exact `currentTokens`. The hub never computes a cost for Copilot: `cost_usd`
  stays null and the report server prices by (agent, model). See
  [`context-meter.md`](context-meter.md#github-copilot-cli).
- **Compaction** is detected from a successful `session.compaction_complete`
  record in the same `events.jsonl`; see
  [`compaction-resilience.md`](compaction-resilience.md).
- **Model**: the hub passes no `--model`, so the CLI's own default applies
  (the CLI's own `COPILOT_MODEL` variable is the lever: it worked in the docker
  end-to-end run once added to the hook's `sandbox.env`, which does not forward
  it by default; not separately verified on the host); the model that ran is
  read back from the session.
- **Docker** needs a token inside the container (the host keyring login is
  not reachable). The hub finds it itself: environment (`COPILOT_GITHUB_TOKEN`,
  `GH_TOKEN`, `GITHUB_TOKEN`), then a token pasted in Settings, then
  `gh auth token`, checked lazily when a copilot docker workflow is created or
  dispatched (`400 copilot_token_required` with the in-app "Sign in with GitHub
  CLI" / "Paste a token" flow when none is found). `ghp_` classic tokens are
  rejected; a gh token gets a broader-scopes warning (a fine-grained PAT with
  only "Copilot Requests" is safer). The value is written into the awb hook's
  `sandbox.env` as `COPILOT_GITHUB_TOKEN=<value>` (hooks.json mode 600),
  refreshed before every dispatch, and handed to the container through the
  docker client's environment, never argv. No `export` is needed before
  `npm start`; see the README and
  [`copilot-docker-token-report.md`](copilot-docker-token-report.md). Image:
  `target-agent-copilot:latest`, from `Dockerfile.copilot`.
- **The runner is fixed at creation**, as for the others, and **only runners
  that are installed and that the broker can run are offered**: the hub probes
  `<cli> --version` and also checks that the awb checkout ships
  `adapters/spawn-runner/<runner>.ts`, because a broker without the adapter
  accepts the event and the step hangs until its timeout.

## Status

Implemented and covered by `hub/runner-harness.test.ts` and
`hub/runner-install.test.ts` plus the existing suites. `npm run typecheck`
passes. Documented in `README.md` and `web-docs/index.html`.
