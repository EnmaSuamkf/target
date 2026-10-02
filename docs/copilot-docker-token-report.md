# Copilot + Docker token flow: end-to-end report

Workflow "copilot-docker-token-flow", step 5/5 (2026-10-02). Verifies the "option B"
design: the hub finds the GitHub token itself (environment, then Settings, then
`gh auth token`), writes `COPILOT_GITHUB_TOKEN=<value>` into the awb hook's
`sandbox.env` (hooks.json mode 600) and awb hands the value to the container
through the docker client's environment, never argv. No token appears anywhere in
this file; the real token lived only in a shell variable and in the throwaway
hooks.json.

## Setup (throwaway instances, real Docker, real Copilot)

```bash
T=$(mktemp -d /tmp/tokflow-XXXXXX)            # AWB_HOME=$T/awb  TARGET_HOME=$T/target
echo '{"host":"127.0.0.1","port":8990,"maxBodyBytes":1048576,"publicBaseUrl":null,"hooks":{}}' > $T/awb/hooks.json
echo '{"port": 8993}' > $T/target/config.json
# broker (vendor clone, with the step-4 awb change) and hub, both with the token variables removed:
cd vendor/agent-webhook-bridge && env -u COPILOT_GITHUB_TOKEN -u GH_TOKEN -u GITHUB_TOKEN \
  AWB_HOME=$T/awb COPILOT_MODEL=claude-haiku-4.5 node broker/daemon.ts &
cd hub && env -u COPILOT_GITHUB_TOKEN -u GH_TOKEN -u GITHUB_TOKEN \
  TARGET_HOME=$T/target AWB_HOME=$T/awb node daemon.ts &
```

- Broker on 8990 (PID 1102369), hub on 8993 (PID 1102371). `/proc/<pid>/environ` of both
  showed **0** of `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`.
- `gh` logged in as the operator (OAuth `gho_` token, keyring). Image
  `target-agent-copilot:latest` present.
- `COPILOT_MODEL` is set in the broker environment, but the hook only forwards the token
  (`-e HOME`, `-e COPILOT_GITHUB_TOKEN`), so it never reaches the container: the account's
  default model ran. Prompts were kept tiny.

## (a) Token from `gh`, no environment variable

`GET /api/copilot/token-status` (admin token):

```json
{"status":{"available":true,"source":"gh","envName":null,"tokenType":"oauth","usable":true,
 "warning":"gh tokens carry broader scopes (repo, workflow...); a fine-grained token with only the Copilot Requests permission is safer",
 "ghInstalled":true,"ghLoggedIn":true,"storedInSettings":false}}
```

No token or fragment in the payload. `POST /api/workflows {runner:"copilot", sandbox:"docker",
permissionMode:"acceptEdits", workdir:<scratch under /tmp>}` → **200**, workflow `draft`,
image `target-agent-copilot:latest`, with nothing exported anywhere. The created hooks.json
was already mode **600** (`stat -c %a`).

## (b) Two-step docker workflow

Steps (each with acceptance criteria, 2 retries):
1. create `note.txt` containing exactly `token flow ok`;
2. append `second line` and report the file.

Note: `POST /api/workflows/:id/start` needs `{"stepIds":[...]}`; an empty body runs nothing.

| Observation | Result |
| --- | --- |
| Workflow status | `completed` (17 polls at 5 s) |
| Step 1 / Step 2 | `done` / `done`; hub log: `step … done, dispatching judge` then `passed the judge` for both |
| Session id | both steps report the same session id (`458a8577-…`, first step `--session-id`, second `--resume`) = workflow `lastSessionId` |
| `note.txt` | `token flow ok` / `second line` (2 lines, 26 bytes) |
| Owner | uid 1000 `lenovo` (the operator), mode 644 |
| Containers | one real `target-agent-copilot:latest` container per run, all `--rm`; none left |

## (c) Broker log: docker run without a value

Header line of the awb run log (all 4 runs, 2 steps + 2 judge runs, identical in this respect):

```
$ docker run --rm --init --user 1000:1000 --memory 4g --cpus 2 --pids-limit 512 -v <workdir>:<workdir> -v ~/.claude:~/.claude ... -v ~/.copilot:~/.copilot -v ~/.cache/copilot:~/.cache/copilot -e HOME=/home/lenovo -e COPILOT_GITHUB_TOKEN -w <workdir> target-agent-copilot:latest copilot -p "..."
```

`-e COPILOT_GITHUB_TOKEN` is present, with no `=value`. While steps ran, `ps -eo args | grep -F <real token>`
was polled every 5 s (15 polls with a container up): **0 matches**.

## (d) Rejection, no-token and rotation cases

| Case | Observed |
| --- | --- |
| `PUT /api/settings/copilot-token` with a classic token (`ghp_<dummy>`) | **HTTP 400**, `Classic personal access tokens (ghp_...) are not supported by Copilot CLI. Use a fine-grained token ... with the "Copilot Requests" permission, or sign in with the GitHub CLI.` |
| `DELETE /api/settings/copilot-token` | 200; status falls back to `source: gh`, `storedInSettings: false` |
| No token anywhere: `POST /api/workflows` | **HTTP 400** `{"error":"copilot_token_required","message":"runner 'copilot' in a docker sandbox authenticates with a GitHub token ... none was found in the hub's environment (...), in Settings or from `gh auth token`. Sign in with the GitHub CLI (`gh auth login` in a terminal), or paste a token in Settings ...","actions":["gh-login","paste-token"],"status":{"available":false,"source":null,...,"ghInstalled":true,"ghLoggedIn":false,"storedInSettings":false}}` |
| Rotation (separate workflow) | see below |

How the no-token case was produced (deviations from "PATH lacking gh"): the hub also tries
`/usr/bin/gh`, which cannot be removed, and on this machine `gh auth token` still returns the
keyring token with an empty `GH_CONFIG_DIR` or `HOME` (and `gh auth status` says "not logged
in"). So the hub was restarted (by PID) with a PATH of symlinks to docker/git/bash/sh only,
`GH_CONFIG_DIR` pointing at an empty dir and `DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/bus`
(the keyring is reached over D-Bus), and still without token variables. `gh auth token` then
exits 1 and the hub answered as shown. A first attempt with a PATH that also hid `docker`
returned the unrelated "docker is not available" 400, and one with only `GH_CONFIG_DIR` changed
still found the keyring token (workflow created with 200): both discarded.

Rotation check (hook value compared by label only, never printed; hub and broker not restarted):

| Moment | hooks.json value of the rotation workflow's hook |
| --- | --- |
| After `POST /api/workflows` | equals the `gh` token |
| After `PUT` of a fine-grained-looking dummy in Settings (status: `source: settings`), before any dispatch | still the `gh` token |
| 2 s after `start` (dispatch) | **equals the dummy**: refreshed before the dispatch |
| Result | step failed in Copilot with `Authentication token found but could not be validated ... Bad credentials (401)` (expected for a dummy; the error text carries no token); hooks.json still mode 600 |

## (e) Leak audit (real token from `gh auth token`, kept in a shell variable)

`grep -rlF` (file names only; `node_modules` and `.git` excluded) after all of the above:

| Searched | Files containing the real token |
| --- | --- |
| throwaway `$AWB_HOME` (logs, events.db, hooks.json, locks) | `awb/hooks.json` only (expected; mode **600**, 3 occurrences: the hooks that carry `COPILOT_GITHUB_TOKEN=<value>`) |
| throwaway `$TARGET_HOME` (db + WAL, step/progress .md, config) | none |
| captured broker/hub stdout logs, API response captures, helper scripts | none |
| scratch workdirs (`note.txt`, ...) | none |
| `/home/lenovo/Documentos/target` working tree | none |
| `/home/lenovo/Documentos/target-server` | none |
| `vendor/agent-webhook-bridge` and `/home/lenovo/Documentos/agent-webhook-bridge` | none |
| `/home/lenovo/Documentos/target/docs` (incl. this report) | none |
| other `/tmp` scratch dirs | none (only the throwaway hooks.json above) |
| `~/.copilot` (session state mounted into the container) | none |
| live `~/.agent-webhook-bridge` and `~/.target` | none |
| `ps -eo args` during the runs (15 polls with a container up) and afterwards | none |

Result: the real token exists only in the throwaway hooks.json (and in the docker client / container
environment while a step runs). No leak was found, so nothing needed fixing or re-running.

Static check of the docs written by this step: a grep for GitHub token shapes (`gh` + o/p/s/u + underscore + 20 alphanumerics, or the fine-grained prefix)
over `docs/`, `README.md`, `web-docs`, `CHANGELOG.md` finds nothing.

## (f) Cleanup

- Both throwaway processes were stopped by PID after checking `/proc/<pid>/environ` for the
  throwaway homes (hub 1112803 [restarted instance], broker 1102369). Ports **8990 and 8993 are free**.
- `rm -rf $T` (it held the real token in hooks.json); the token variable was unset. No `tokflow` dirs left in `/tmp`.
- Live broker (8890, PID 1086985) and live hub (8893, PID 1086986) were never touched: same PIDs before and after.
- `target-server`, `vendor/agent-webhook-bridge` and `agent-webhook-bridge`: `git status` output identical
  before and after this step's e2e and regression runs. No commit, branch, push or stash was made
  (HEAD still `b4e7014` on `main`).

## Final regression

| Check | Result |
| --- | --- |
| `cd hub && npm run typecheck` | clean |
| `cd hub/ui && npm run typecheck` / `npm run build` | clean / built |
| `cd hub && npm test` | 1387 tests, 1387 pass, 0 fail, 0 cancelled, 0 skipped |
| `vendor/agent-webhook-bridge` `npm test` | 58 tests, 58 pass, 0 fail |
| `/home/lenovo/Documentos/agent-webhook-bridge` `npm test` | 58 tests, 58 pass, 0 fail |

## Notes and follow-ups for the operator

- The new code is **not loaded yet** in the live hub (8893) or live broker (8890). Restart both
  to load it (the broker needs the awb process-env change; the live hooks.json is still mode 664 and
  becomes 600 on the next write by the new hub/broker).
- The hub, awb token-flow changes and docs are uncommitted in `target`, `vendor/agent-webhook-bridge`
  and `agent-webhook-bridge`: commit/push them later.
- `COPILOT_MODEL` is still not forwarded into the container (only the token is declared in the hook);
  choosing a model for docker steps needs the hook env or a future `--model` option.
- Quirk found: `gh auth token` can succeed while `gh auth status` reports "not logged in" (keyring entry
  without a hosts.yml). The hub uses `gh auth token`, so such a login is accepted; `ghLoggedIn` is then false.
