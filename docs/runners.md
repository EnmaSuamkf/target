# Feature: Per-workflow runtime (`--runner`)

Let a workflow choose which coding-agent CLI its dedicated agent spawns:
**Claude Code** (the default, unchanged) or
**[free-code](https://github.com/EnmaSuamkf/free-code)** — the same two
runtimes agent-webhook-bridge's spawn adapter and agentmesh already support.

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
| `hub/awb.ts` | `PUBLISHABLE_RUNNERS` (`claude`, `free-code`); `HookOptions.runner`; `createAwbHook` writes `spawn:<runner>`; `HARNESS_RESUME_COMMANDS` gains `free-code --session <path>` |
| `hub/workflow.ts` | `createWorkflow` accepts and forwards `runner` |
| `hub/server.ts` | `POST /api/workflows` validates an optional `runner` body field against `PUBLISHABLE_RUNNERS` |
| `hub/cli.ts` | `target create` / `create-from-template` accept `--runner <claude\|free-code>` |
| `hub/transcript.ts` | `readTokenUsage` detects a free-code session (an absolute `.jsonl` path), reads the transcript directly, and normalises free-code's usage shape (`input`/`output`/`cacheRead`/`cacheWrite`) alongside Claude's (`input_tokens`/…) |
| `hub/tokens.ts` | the CLI accepts a free-code `.jsonl` path as its argument |
| `hub/ui` | `Runner` type + `runner` on `CreateWorkflowInput`; an **Agent runtime** selector in the New-workflow modal |
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
- **"Open conversation"** spawns `free-code --session <path>` instead of
  `claude --resume <uuid>`.
- **Permissions**: awb maps the hook's `permissionMode` to free-code's
  `--tools` flag (unset → read-only; `acceptEdits` → +write/edit, no bash;
  `bypassPermissions`/`auto`/`dontAsk` → full incl. bash; `manual`/`plan` →
  read-only). Same opt-in risk model.
- **Token usage** comes from free-code's own per-message usage records; the
  context-window meter uses the same 200k default and there are no subagent
  transcripts to fold in.
- **The runner is fixed at creation** — it's baked into the hook's
  `consumers` — so switching runtime means creating a new workflow.

## Status

Implemented and covered by `hub/runner-harness.test.ts` plus the existing
suites. `npm test` and `npm run typecheck` pass. Documented in `README.md`
and `web-docs/index.html`.
