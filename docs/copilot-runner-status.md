# Copilot runner: final status

Final regression of the 7-workflow project that adds GitHub Copilot CLI (`copilot`) as the 4th runner.
Everything is uncommitted on `main`, as required. Date 2026-10-02.

## 1. Regression results

| Repo | Command | Result |
|------|---------|--------|
| target | `cd hub && npm run typecheck` | OK (exit 0) |
| target | `cd hub && npm test` (`node --test --import ./test-setup.ts`) | **1355 tests, 1355 pass, 0 fail, 0 cancelled, 0 skipped** |
| target | `cd hub/ui && npm run typecheck && npm run build` | OK, OK (vite build succeeded) |
| target/vendor/agent-webhook-bridge | `npm test` (`node --test`) | **47 tests, 47 pass, 0 fail** (includes `adapters/spawn-runner/copilot.test.ts`) |
| target-server | `npm test` (`node --test`) | **347 tests, 347 pass, 0 fail, 0 cancelled, 0 skipped** |
| target-server | `npm run typecheck`, `npm run build` (ui) | OK, OK |
| agent-webhook-bridge (Documentos) | `git status -sb` | `## main...origin/main` (after `git fetch`: not behind, not ahead), working tree clean |

No regression was found, so no code was changed in this step.

## 2. Git state per repo

HEADs (unchanged since the project began, no commits were made; `git branch --show-current` is `main` in all four):

| Repo | HEAD |
|------|------|
| target | `b4e7014` Merge pull request #119 from EnmaSuamkf/feat/usage-snapshot-model-agent |
| target/vendor/agent-webhook-bridge | `300e74d` fix: mount Cursor OAuth config in Docker sandboxes and fix daemon main-module detection (#10) |
| target-server | `7ada263` Merge pull request #32 from EnmaSuamkf/fix/instance-user-fallback |
| agent-webhook-bridge (Documentos) | `300e74d` (same commit as the vendor clone and as origin/main) |

### target (hub)

`git status --short`:

```
 M CHANGELOG.md
 M README.md
 M docs/compaction-resilience.md
 M docs/context-meter.md
 M docs/runners.md
 M hub/agent-sync.test.ts
 M hub/agent-sync.ts
 M hub/awb.ts
 M hub/cli.ts
 M hub/compaction.ts
 M hub/conversations.ts
 M hub/docker-sandbox.test.ts
 M hub/models.test.ts
 M hub/models.ts
 M hub/progress.ts
 M hub/runner-harness.test.ts
 M hub/runner-install.test.ts
 M hub/sandbox.test.ts
 M hub/server.test.ts
 M hub/server.ts
 M hub/sync.test.ts
 M hub/test-setup.ts
 M hub/tokens.ts
 M hub/transcript.ts
 M hub/ui/src/api/types.ts
 M hub/ui/src/views/CreateWorkflowModal.tsx
 M hub/ui/src/views/LandingView.tsx
 M hub/workflow.ts
 M mcp/runners.manifest.json
 M mcp/target-mcp.mjs
 M skills/create-workflow/SKILL.md
 M web-docs/index.html
?? Dockerfile.copilot
?? docs/copilot-e2e-report.md
?? docs/copilot-runner-brief.md
?? docs/copilot-runner-spike.md
?? hub/copilot-compaction.test.ts
?? hub/copilot-conversations.test.ts
?? hub/copilot-session-info.test.ts
?? hub/copilot-usage.test.ts
?? hub/transcript-harness.test.ts
?? hub/ui-runners.test.ts
```

`git diff --stat`:

```
 CHANGELOG.md                             |  32 +++
 README.md                                | 107 ++++++--
 docs/compaction-resilience.md            |  27 +-
 docs/context-meter.md                    |  62 ++++-
 docs/runners.md                          |  74 ++++-
 hub/agent-sync.test.ts                   |  37 ++-
 hub/agent-sync.ts                        |   4 +
 hub/awb.ts                               | 121 ++++++++-
 hub/cli.ts                               |   8 +-
 hub/compaction.ts                        |   7 +-
 hub/conversations.ts                     | 123 ++++++++-
 hub/docker-sandbox.test.ts               |  72 +++++
 hub/models.test.ts                       |  90 +++++-
 hub/models.ts                            | 113 +++++++-
 hub/progress.ts                          |  20 +-
 hub/runner-harness.test.ts               | 154 ++++++++++-
 hub/runner-install.test.ts               |  15 +-
 hub/sandbox.test.ts                      | 120 +++++++-
 hub/server.test.ts                       |   2 +-
 hub/server.ts                            |  22 +-
 hub/sync.test.ts                         |   1 +
 hub/test-setup.ts                        |  21 +-
 hub/tokens.ts                            |  31 ++-
 hub/transcript.ts                        | 452 ++++++++++++++++++++++++++++---
 hub/ui/src/api/types.ts                  |   4 +-
 hub/ui/src/views/CreateWorkflowModal.tsx |  28 +-
 hub/ui/src/views/LandingView.tsx         |   2 +-
 hub/workflow.ts                          |   2 +-
 mcp/runners.manifest.json                |   5 +
 mcp/target-mcp.mjs                       |   2 +-
 skills/create-workflow/SKILL.md          |   4 +
 web-docs/index.html                      |  69 ++++-
 32 files changed, 1679 insertions(+), 152 deletions(-)
```

Untracked new files: `Dockerfile.copilot`, `docs/copilot-e2e-report.md`, `docs/copilot-runner-brief.md`, `docs/copilot-runner-spike.md`, `hub/copilot-compaction.test.ts`, `hub/copilot-conversations.test.ts`, `hub/copilot-session-info.test.ts`, `hub/copilot-usage.test.ts`, `hub/transcript-harness.test.ts`, `hub/ui-runners.test.ts`

### target/vendor/agent-webhook-bridge (awb vendor clone, gitignored in target)

`git status --short`:

```
 M README.md
 M adapters/spawn-runner/sandbox.test.ts
 M adapters/spawn-runner/sandbox.ts
 M adapters/spawn-runner/shared.ts
 M broker/config.ts
 M broker/dispatch.test.ts
 M broker/dispatch.ts
 M cli/awb.ts
 M web-docs/index.html
?? adapters/spawn-runner/copilot.test.ts
?? adapters/spawn-runner/copilot.ts
```

`git diff --stat`:

```
 README.md                             | 49 ++++++++++++++++++++++++++++++++++-
 adapters/spawn-runner/sandbox.test.ts | 28 ++++++++++++++++++++
 adapters/spawn-runner/sandbox.ts      | 15 +++++++++++
 adapters/spawn-runner/shared.ts       | 16 +++++++-----
 broker/config.ts                      |  7 +++--
 broker/dispatch.test.ts               | 15 +++++++++++
 broker/dispatch.ts                    | 23 +++++++++++-----
 cli/awb.ts                            | 22 ++++++++++------
 web-docs/index.html                   | 31 +++++++++++++++++++++-
 9 files changed, 181 insertions(+), 25 deletions(-)
```

Untracked new files: `adapters/spawn-runner/copilot.test.ts`, `adapters/spawn-runner/copilot.ts`

### target-server

`git status --short`:

```
 M README.md
 M blueprint.mjs
 M docs/pricing.md
 M docs/report-server.es.html
 M pricing.mjs
 M test/pricing-core.test.mjs
 M test/sync-operator.test.mjs
 M ui/src/components/RemoteWorkflowsPanel.tsx
?? docs/copilot-pricing-rules.json
```

`git diff --stat`:

```
 README.md                                  |  2 +-
 blueprint.mjs                              |  2 +-
 docs/pricing.md                            | 42 ++++++++++++++++++++++++++++-
 docs/report-server.es.html                 | 11 +++++++-
 pricing.mjs                                |  2 +-
 test/pricing-core.test.mjs                 | 26 ++++++++++++++++++
 test/sync-operator.test.mjs                | 43 ++++++++++++++++++++++++++++++
 ui/src/components/RemoteWorkflowsPanel.tsx |  1 +
 8 files changed, 124 insertions(+), 5 deletions(-)
```

Untracked new files: `docs/copilot-pricing-rules.json`

### agent-webhook-bridge (Documentos clone)

`git status --short`:

```
(clean)
```

`git diff --stat`:

```
(no tracked changes)
```

Untracked new files: none

The status file itself and `docs/copilot-e2e-report.md` are untracked files added after/around these snapshots (both live in `docs/` of the target repo).

## 3. Files changed per workflow

The work is uncommitted and not tagged per workflow, so this attribution is reconstructed from the file areas and the brief's workflow split (a file touched by more than one workflow is listed under the main one; `hub/awb.ts` and `hub/server.ts` were touched by 3 and 5).

1. **copilot-runner-spike** (target): `docs/copilot-runner-brief.md`, `docs/copilot-runner-spike.md` (the brief was written before; the spike also holds the "Docker e2e" section added by workflow 5).
2. **copilot-awb-adapter** (vendor awb clone): `adapters/spawn-runner/copilot.ts` (new), `adapters/spawn-runner/copilot.test.ts` (new), `adapters/spawn-runner/sandbox.ts`, `adapters/spawn-runner/sandbox.test.ts`, `adapters/spawn-runner/shared.ts`, `broker/config.ts`, `broker/dispatch.ts`, `broker/dispatch.test.ts`, `cli/awb.ts`, `README.md`, `web-docs/index.html`.
3. **copilot-hub-runner-core** (target): `hub/awb.ts` (runner registration, resume command, adapter-presence guard), `hub/cli.ts`, `hub/workflow.ts`, `hub/server.ts`, `hub/agent-sync.ts`, `mcp/runners.manifest.json`, `mcp/target-mcp.mjs`, `hub/ui/src/api/types.ts`, `hub/ui/src/views/CreateWorkflowModal.tsx`, `hub/ui/src/views/LandingView.tsx`, `hub/test-setup.ts`, tests `hub/runner-harness.test.ts`, `hub/runner-install.test.ts`, `hub/agent-sync.test.ts`, `hub/server.test.ts`, `hub/sync.test.ts`, `hub/ui-runners.test.ts` (new).
4. **copilot-hub-context-usage** (target): `hub/transcript.ts`, `hub/models.ts`, `hub/conversations.ts`, `hub/progress.ts`, `hub/compaction.ts`, `hub/tokens.ts`, tests `hub/models.test.ts`, `hub/copilot-usage.test.ts`, `hub/copilot-compaction.test.ts`, `hub/copilot-conversations.test.ts`, `hub/copilot-session-info.test.ts`, `hub/transcript-harness.test.ts` (all new except `models.test.ts`).
5. **copilot-hub-docker** (target): `Dockerfile.copilot` (new), the docker parts of `hub/awb.ts` (mounts, `COPILOT_AUTO_UPDATE`, token env by name, `BUILDABLE_SANDBOX_IMAGES`) and `hub/server.ts` (missing-token refusal), tests `hub/docker-sandbox.test.ts`, `hub/sandbox.test.ts`, and the "Docker e2e" section of `docs/copilot-runner-spike.md`.
6. **copilot-target-server** (target-server): `blueprint.mjs`, `pricing.mjs`, `ui/src/components/RemoteWorkflowsPanel.tsx`, `docs/pricing.md`, `docs/report-server.es.html`, `README.md`, `docs/copilot-pricing-rules.json` (new), tests `test/pricing-core.test.mjs`, `test/sync-operator.test.mjs`.
7. **copilot-docs-and-e2e** (target): `README.md`, `web-docs/index.html`, `docs/runners.md`, `docs/context-meter.md`, `docs/compaction-resilience.md`, `CHANGELOG.md`, `skills/create-workflow/SKILL.md`, `docs/copilot-e2e-report.md` (new), `docs/copilot-runner-status.md` (this file, new). `hub/test-setup.ts` already carried the Copilot comment from workflow 3.

## 4. End-to-end outcome

Real awb broker + hub on throwaway ports 8990/8993 with the real `copilot` CLI: all six checks passed (runner listing, a 2-step workflow completed with the judge passing and `hello.txt` holding both lines, session-info token/context numbers equal to the last `session.shutdown`, the `copilot --resume=<id>` command, conversations listing/preview, the read-only mapping, a forced `/compact` detected and followed by context re-injection, and `usage.snapshot` with `agent: "copilot"`).
Details, numbers and the open issues are in `docs/copilot-e2e-report.md`; a separate docker + copilot end-to-end is recorded in the "Docker e2e" section of `docs/copilot-runner-spike.md`. No bug was found in either run.

## 5. Manual follow-ups for the operator

1. **Restart the live awb broker (8890) and the live hub (8893)** to load the new code. They were deliberately never touched; until restarted, the live hub does not know the `copilot` runner and the live broker has no `spawn:copilot` adapter. Currently running: broker pid 772936 (127.0.0.1:8890), hub pid 772937 (0.0.0.0:8893), the same processes that were running when the project began.
2. **Commit and push the awb vendor changes** (`/home/lenovo/Documentos/target/vendor/agent-webhook-bridge`: it is its own clone of github.com/EnmaSuamkf/agent-webhook-bridge, gitignored by `target`), then `git pull --ff-only` in `/home/lenovo/Documentos/agent-webhook-bridge` (currently clean and equal to origin/main, `300e74d`, so it will fast-forward).
3. **Commit the `target` and `target-server` changes** (nothing was committed by the project; no branches were created).
4. **Deploy target-server before the hubs**: its `sync.remote_workflow.create` whitelist now accepts `copilot`; a hub on the new code sending a `copilot` workflow to an old server would be rejected.
5. **Import `docs/copilot-pricing-rules.json`** (in the target-server repo) into the server's pricing table so `(agent: copilot, model)` pairs are priced; the hub keeps `cost_usd` null for Copilot.
6. **Docker workflows need the token variable**: export `COPILOT_GITHUB_TOKEN` in the shell that starts the hub (e.g. `export COPILOT_GITHUB_TOKEN="$(gh auth token)"` then `npm start`) and restart the hub after exporting it; creating a copilot + docker workflow without it is refused with this instruction. Only the variable's name is written to the hook. Build the image with `npm run target:install` (or `docker build -t target-agent-copilot:latest -f Dockerfile.copilot .`).
7. **Remove the throwaway artefacts** listed in section 7.

## 6. Known gaps

- **Automatic compaction is unverified.** `trigger: "threshold"` is written on the start event (forced with `COPILOT_BACKGROUND_COMPACTION_THRESHOLD`), but all forced attempts ended `success: false`; a successful automatic compaction event was never produced. Only the manual `/compact` boundary was verified, in the spike and again in the e2e. The env var semantics are undocumented.
- **A compaction cannot be forced through a workflow step**: the hub wraps the step text in its prompt, so `/compact` is not a slash command there (e2e check 5).
- **Context windows:** only `claude-haiku-4.5` (128000) and `gpt-5.4` (922000) were measured on this account; `gpt-5.4-nano` and `gpt-4o-mini` come from earlier interactive sessions; every other Copilot id is an inferred 128000 and unknown ids fall back to the generic 200000 (not a Copilot-specific value). `--context long_context` is recorded but changed no limit in the cases tested; its effect above 272k tokens and on models with different per-tier windows is unverified, and the hub does not use it.
- **Read-only mode** (unset/manual/plan) removes the write and shell tools, so there is no `denied` event; a model can claim a write that never happened and the hub shows the step as done. The spike's suggestion to warn on `error.code: "denied"` is not implemented in the hub.
- **Model selection:** the hub passes no `--model`; `COPILOT_MODEL` is the CLI's own variable and is not forwarded into docker unless added to the hook's `sandbox.env` by hand. `auto` resolution was observed once.
- **`GH_TOKEN` / `GITHUB_TOKEN` as docker auth** were not tested; only `COPILOT_GITHUB_TOKEN`. Interactive docker resume via a terminal that hands off to a server process (e.g. `gnome-terminal`) may not inherit the token.
- **URL restriction** under `--allow-all-tools` could not be tested (the sandbox has no DNS); `--available-tools` with names missing in a given CLI version was not tested.
- **CLI version:** observed on 1.0.91 (the brief says 1.0.89); the container installs whatever npm serves at build time (`ARG COPILOT_VERSION`).
- **Platforms:** only Linux was exercised. Windows and macOS behaviour (paths under `~/.copilot`, keyring auth, terminal launching) is unverified.
- **Desktop-app PATH:** the hub finds the runner with `copilot --version` on its own PATH; an npm-installed `copilot` outside the PATH that a desktop-launched hub sees would show as "not installed". Unverified.
- **Interactive "Open conversation"** was checked at command level (the exact string), not by opening a terminal window.
- **Usage reporting** to a linked server was not exercised end to end (no linked server in the throwaway hub); the payload was produced with the same function the hub calls.
- A subagent final-answer ordering for background/async subagents (`session.background_tasks_changed`) was not exercised.

## 7. Throwaway artefacts the operator may delete

Intentional, keep: docker image `target-agent-copilot:latest` (built from `Dockerfile.copilot`).

Copilot test sessions under `~/.copilot/session-state/` (created by the spikes and e2e runs; the operator's own sessions were never modified):

- Spike section 2: `84d04c66-d6c8-4e0e-bc54-bcca0df84217`, `0402c286-1902-4765-b7cf-7f2742a57e17`.
- Spike section 4: `33204607-37fa-46de-90e6-1cbbcbfd5526`, `f7acec8e-7989-4e71-b033-4e24ecb66f4c`, `531501de-7a97-4026-89eb-a1e54511f44e`, `62e5c2ed-b216-48b9-949f-d7894af8d5cd`, `33bbfb34-531c-4e87-80c5-3699009d77a4`, `4d452007-339a-4a1f-b336-66f0af72d5da`, `de9f42a6-a6f5-4c05-8a77-1d7ea4c48690`, `e193811c-f807-47ee-b14e-8ae66da0d6cc`, `9314504c-ee13-4eb8-8532-85db700e206d`.
- Docker e2e (workflow 5): `431a3e41-a6fc-41b6-96cc-d08c814b0157`.
- This workflow's e2e: `8d112047-c5f6-406a-9d74-e948f38c5c6a` (two-step workflow + compaction), `f96e7f1c-a590-489a-bd31-3027f7cc1923` (read-only workflow).
- NOT recorded anywhere (cannot be listed by id): the 2 sessions of spike section 1 (container/host resume test) and about 21 sessions of spike section 3 (permission matrix); identify them by `session.start` time on the day of the spike (2026-10-01) if a cleanup is wanted.

Temporary directories under `/tmp`: `copilot-e2e-1WFdXO` (this e2e's homes, workdirs, logs and hooks.json), `copilot-e2e-dir`, `copilot-e2e-yAZ2` (docker e2e of workflow 5), `copilot-e2e-T`, `copilot-models.txt`, `copilot-pricing.txt`, `final-reg/` (this step's test logs), and the many `target-test-copilot-*` directories the test suites leave behind (compaction, conv, info, usage).

## 8. Processes

No process started by these workflows is running: `ss -ltnp | grep -E ':(8990|8993)'` prints nothing, and no copilot container exists (`docker ps -a` has none). The live processes are those that were running at the start: broker pid 772936 on 8890, hub pid 772937 on 8893, never restarted.
