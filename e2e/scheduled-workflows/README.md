# Scheduled workflows — end-to-end harness

Verifies both `integration/scheduled-workflows` branches (hub + target-server)
working together before anything reaches `main`. Everything is throwaway and
local; nothing here touches the live hub (127.0.0.1:8893), the real
`~/.target`, `~/.agent-webhook-bridge` or the real linked server.

## Run it

```sh
npm run e2e:scheduled                    # all scenarios
npm run e2e:scheduled -- --only S0       # one or more, comma separated (S0,S3)
npm run e2e:scheduled -- --keep          # keep the temp dir (logs/, DBs) for inspection
npm run e2e:scheduled -- --any-server-rev  # don't require the server at origin/integration/scheduled-workflows
```

Exit code: `0` all selected scenarios passed, `1` a scenario failed, `2` harness
problem (busy port, wrong server checkout, unknown scenario id). The last lines
are a per-scenario `PASS`/`FAIL` summary.

## Prerequisites

- Node >= 24 (the hub runs TypeScript directly; `node:sqlite`).
- `/home/lenovo/Documentos/target-server` (override with `E2E_SERVER_DIR=<path>`)
  checked out **detached at `origin/integration/scheduled-workflows`**, with
  dependencies installed (`npm ci`). The harness refuses any other revision
  unless you pass `--any-server-rev`, and never modifies that checkout (its
  DB, control DB and mail outbox live in the temp dir).
- Hub dependencies: none (the hub has no runtime dependencies).
- Ports `8993` (hub), `8994` (server) and `8990` (broker) free. A busy port
  aborts the run before anything is started.

## What it starts

| Piece | Where | Notes |
| --- | --- | --- |
| target-server | `node <server>/server.mjs`, `127.0.0.1:8994` | temp `TARGET_SERVER_DB`/`TARGET_CONTROL_DB`, `TARGET_DEVICE_LINKING_MODE=optional`, file mail transport, seeded `admin@admin.com` |
| hub | `node hub/daemon.ts`, `127.0.0.1:8993` | `TARGET_HOME` / `AWB_HOME` under the temp dir, `{"port": 8993}` in `config.json`, sync tick 5s |
| stand-in awb broker | in the harness process, `127.0.0.1:8990` | awb's hook contract only; never spawns an agent |

Then it links the hub to the server through the real device-link flow
(`POST /api/device-link/start` → server approve as the seeded admin →
`/api/device-link/poll`), and waits for the first live heartbeat so the owner
permission mode is `enforced`, exactly like production.

### Isolation

- Children get a **whitelisted environment** (`PATH`, `HOME`, `LANG`, `TMPDIR`
  plus what the harness sets) — no inherited `TARGET_REPORT_*` / `TARGET_SYNC_*`
  — and `HOME` points into the temp dir.
- `PATH` is prefixed with stub `claude`/`free-code` (answer `--version` only; the
  hub checks the runner exists) and `xdg-open` (linking never opens a browser).
- Every process is killed by its **own pid** (never a pattern kill, which would
  also take down the live hub). Cleanup runs on success, failure, and
  SIGINT/SIGTERM; it then verifies ports 8993/8994/8990 are free and removes the
  temp dir (unless `--keep`).

### The stand-in broker

`POST /hook/<name>` with `x-webhook-secret` (checked against
`$AWB_HOME/hooks.json`, re-read per request) and optional `sessionid` header →
`202`, then `POST {}` to `startedCallbackUrl`, then `{ok, result, session_id,
exitCode}` to `callbackUrl`. Judge prompts (recognised by the verdict-format
instruction) get `{"ok": true, "reason": …}`. Also `POST /hook/<name>/abort`.
Scenario knobs: `broker.delayMs`, `broker.delayFor(hook, ms)`,
`broker.failNext(hook)`, `broker.jobs`.

### Time travel

Scenarios never wait for days. Real fires use schedules a minute or two ahead;
downtime is simulated with `await hub.stop()`, rewriting `next_run_at` /
timestamps through `hub.db()` (a `node:sqlite` handle on the throwaway
`target.db`), then `hub.restart()`.

## Scenarios

| Id | What it proves |
| --- | --- |
| S0 | Everything boots, the hub links and syncs with the throwaway server, and a plain (non-scheduled) two-step workflow (one step judged) runs to `completed` through the broker. |

See `REPORT.md` for the latest recorded results.

## Adding a scenario

Append `{ id, title, async run(ctx) }` to `SCENARIOS` in `run.mjs`. `ctx` has
`hub`, `server` (`.api()` calls carry the operator session), `broker`,
`createWorkflow`, `waitForStatus`, `waitFor`, `check`/`checkEq`, `log`. A
scenario throws to fail; the harness records it and carries on.
