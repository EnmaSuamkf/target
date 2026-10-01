# Scheduled workflows and archiving — end-to-end report

Automated verification of **both** `integration/scheduled-workflows` branches working together, run before anything reaches `main`.
Command: `npm run e2e:scheduled` (about 12 minutes). Harness: [`run.mjs`](run.mjs), how it works: [`README.md`](README.md).

## Tested commits

| Repo | Ref | Commit |
| --- | --- | --- |
| `EnmaSuamkf/target` (hub + hub UI) | `origin/integration/scheduled-workflows` | `56652e319648b9ec47c47b9b9b89b57a3646deee` |
| `EnmaSuamkf/target-server` | `origin/integration/scheduled-workflows` (checked out detached) | `651b907cb19cb47d9ca25c642c23369f897d3cf7` |
| `EnmaSuamkf/target` | `test/scheduled-workflows-e2e` = hub integration + the harness commits (the code the run executed) | see the E2E PR's head |

Final full run on exactly these commits: **13/13 scenarios PASS, exit code 0**. Both integration branches had not moved between the first baseline and the final run.

## Program PRs in the integration branches

| # | Repo | PR |
| --- | --- | --- |
| 1 | target-server | [#27 fix(sync): scope events to their client and advertise event capabilities](https://github.com/EnmaSuamkf/target-server/pull/27) |
| 2 | target | [#110 feat(hub): archive workflows automatically and on demand](https://github.com/EnmaSuamkf/target/pull/110) |
| 3 | target | [#111 feat(hub): scheduled workflow series engine](https://github.com/EnmaSuamkf/target/pull/111) |
| 4 | target | [#112 feat(hub-ui): schedule workflows, series badges, filters and notices](https://github.com/EnmaSuamkf/target/pull/112) |
| 5 | target | [#113 feat(hub): sync scheduled series with the Target server](https://github.com/EnmaSuamkf/target/pull/113) |
| 6 | target-server | [#28 feat(sync): scheduled series API and protocol](https://github.com/EnmaSuamkf/target-server/pull/28) |
| 7 | target-server | [#29 feat(ui): schedule remote workflows and browse series](https://github.com/EnmaSuamkf/target-server/pull/29) |

## Pull requests of this work (none merged by the workflow)

- E2E harness + this report: [target #114](https://github.com/EnmaSuamkf/target/pull/114) → `integration/scheduled-workflows`
- Release `integration/scheduled-workflows` → `main`, titled "Scheduled workflows and archiving": [target #115](https://github.com/EnmaSuamkf/target/pull/115) and [target-server #30](https://github.com/EnmaSuamkf/target-server/pull/30)

## Environment

- Linux 7.0.0-34-generic, Node v24.21.0. The hub has zero runtime dependencies.
- Everything is throwaway and local. `target-server` from the checkout above (temp DB and control DB, `TARGET_DEVICE_LINKING_MODE=optional`, file mail, seeded admin), a hub with `TARGET_HOME`/`AWB_HOME` in a temp dir and `{"port": 8993}`, and a stand-in awb broker on 8990. A fault-injecting proxy on 8994 fronts the server (8995).
- The hub is linked to the server through the real device-link flow (Ed25519 signed requests); owner permissions are `enforced` after the first live heartbeat, as in production.
- Children get a whitelisted environment (no inherited `TARGET_REPORT_*` / `TARGET_SYNC_*`), `HOME` in the temp dir; stub `claude` / `free-code` / `xdg-open` / `docker` executables on `PATH`. The live hub on 8893 and the real `~/.target`, `~/.agent-webhook-bridge` and linked server are never touched. All processes are killed by their own pid, and ports 8993/8994/8990/8995 are verified free at the end.
- Time is never waited for in days: real fires use schedules one or two minutes ahead; downtime is simulated by stopping the hub and rewriting `next_run_at` / timestamps in the throwaway SQLite DB.
- Baselines (before the harness): hub `npm test` 1222/1222 and `npm run typecheck` clean; server `npm test` 295/295. At the end of this report's work: hub `npm test` 1222/1222, `npm run typecheck` clean, `npm run ui:build` OK.

## Scenarios

| Id | Result | What it proves |
| --- | --- | --- |
| S0 | PASS | Server, hub and broker boot; the hub links and syncs with the server (device registered, permissions enforced); a plain non-scheduled two-step workflow (one step judged) runs to `completed` through the broker. |
| S1 | PASS | A local daily series fires on time. The next armed instance exists, named `<series> · YYYY-MM-DD HH:mm` and due exactly +24h. On the second fire the context step carries the previous-run block (previous id, final status, absolute step-results path) while `conversation_context` is unchanged, and the block does not accumulate in the third instance. |
| S2 | PASS | start / resume / restart / step run on an armed instance answer 409 `scheduled_armed`; nothing reaches the broker; the armed instance can still be edited (steps, context). |
| S3 | PASS | Missed recurring: with the hub stopped and `next_run_at` two days back, one notice lists 2 missed runs ("2 runs missed (…) because the hub was offline; next: …"); no workflow is created; the series is re-armed in the future. |
| S4 | PASS | Missed once becomes `missed` with a notice and does not run; `run-now` fires it; a second `run-now` is 409 `not_missed`. |
| S5 | PASS | Overlap: the previous instance is held running by the broker when the next is due, so the run is skipped (`busy`) with a notice, the instance is re-armed, and no junk instance is created. |
| S6 | PASS | Auto-archive with `archive_after_days=1`: old completed/failed instances are archived and keep their outcome; armed, running, draft and fresh completed ones are not; `GET /api/workflows` excludes archived by default, `?archived=include|only` work, a bad filter is 400. |
| S7 | PASS | A remote daily series created through the server API is applied by the hub (`managed_by: server`, same series id); the server mirrors `armed` with the same `next_run_at`; local `PUT` and `DELETE` of its schedule on the hub answer 409 `server_managed`. |
| S8 | PASS | After two fires the server lists 3 instances (`server,hub,hub`, hub-minted ids, identical `step_key`s, `fired,fired,armed`). A server `step.edit` to a fired instance is acked `failed` with `instance_already_fired`; the same edit to the armed instance is applied. |
| S9 | PASS | The events route is blocked, the hub fires and clones, and is SIGKILLed before the announcement is pushed. After unblocking and restarting, `instance-created:<id>` is accepted exactly once (one stored event, one workflow row, `announced_at` set). |
| S10 | PASS | Missed remote occurrences are mirrored: the server shows a `run_missed` notice with the 2 occurrences and the re-armed `next_run_at`. |
| S11 | PASS | Cancel from the server: the series is `cancelled`, the hub's armed instance becomes a normal startable workflow and is never re-armed; archive and unarchive of a remote workflow are mirrored as `archived_at`. |
| S12 | PASS | A second registered client cannot announce an instance into the first client's series (`foreign_series`; with the real instance id `foreign_remote_id`), nor cancel it with a forged `workflow.schedule_changed`; nothing is created or changed. |

## Bugs found

**Product bugs: none.** S0–S12 found no defect in either integration branch, so no fix PRs were needed.

Four **harness** bugs were found while building the scenarios and are fixed in this PR:

| Where | Evidence | Fix |
| --- | --- | --- |
| cleanup | Full run printed 7/7 PASS but exited 1 and left the temp dir: `Permission denied` removing `…/steps/<agent>/01-….md`. The product locks the previous run's step-results directory read-only on purpose. | `removeTree()` restores write access before deleting. |
| S8 | `expected "applied", got "acked"` | The server stores an applied command as `acked`. |
| S9 | The poll for "armed instance" matched the original instance, which is armed until it fires. | Only an armed row with a different `remote_id` counts as the clone. |
| S9 | `timed out … waiting for the hub to fire`; hub log `1 run(s) missed`: a 24h rewind of a series created 2h ahead was 22h late, which the hub correctly treats as missed. | Create the series on a slot that passed 2 minutes ago. |

## Known limitations

- Not covered by automation: the UIs (hub React UI and server dashboard) — see the manual checklist; DST transitions, weekly and `once` recurrence beyond S4 (covered by unit tests in the hub); the permission gate (D10: forbidden/stale skips) and Slack delivery; docker sandboxes with read-only previous-results mounts (the broker is a stand-in, the `docker` binary a stub); multi-org servers; a real agent run.
- A real fire is observed through the 30s scheduler tick, and after a hub restart the first tick waits for the first live heartbeat (D10), so a "due" run fires on the second tick. The suite therefore takes about 12 minutes (S1 ~3 min, S8 ~3.5 min).
- The "second fire" in S1/S8/S9 is produced by moving `next_run_at` back 24h in the DB while the hub is stopped (a real second fire needs a real day).
- The suite needs ports 8993/8994/8995/8990 free and the server checkout at `origin/integration/scheduled-workflows` (override with `--any-server-rev`).
- Time zones: all scenarios use `UTC`, so "tomorrow" is exactly +24h.

## Manual test checklist (operator)

Run against a hub linked to a server. Use a throwaway hub if you do not want to touch real data (`TARGET_HOME`, `AWB_HOME`).

### Hub (UI)

- [ ] **Schedule modal.** On a draft/completed workflow open *Schedule*: choose Once / Daily / Weekly; the timezone defaults to the browser's; the next-3-runs preview matches the chosen time; invalid input shows field errors; the *include previous run* toggle is on by default. Save arms the workflow.
- [ ] **Adopted conversation.** A workflow that continues an operator conversation cannot be scheduled (clear message).
- [ ] **Badges.** An armed instance shows its schedule badge and next run time; fired, missed, cancelled and broken instances show their own state; a server-managed series shows "Managed by server" and read-only controls.
- [ ] **Armed guard.** On an armed instance Start / Resume / Restart / Step run are not offered (or are refused with `scheduled_armed`); editing steps and context still works.
- [ ] **Filters.** The rail and *All workflows* page have *Scheduled*, *Scheduled runs* and *Archived* filters; *Archived* lists archived workflows and the default list hides them.
- [ ] **Series.** *Scheduled* shows one entry per series with its armed instance; *Scheduled runs* shows the fired instances; instance names read `<series> · YYYY-MM-DD HH:mm`.
- [ ] **Previous-run reference.** After a second run, the context step shows the previous-run block (previous workflow id, final status, step-results directory); conversation context is unchanged.
- [ ] **Notices banner.** After a missed run, a skipped run (busy), a failed scheduled run and a broken series, a banner shows each notice until acknowledged; *Acknowledge* removes it; it survives a hub restart. Slack gets the same message when configured.
- [ ] **Missed once.** Shows *Run now*, *Reschedule* and *Dismiss*: *Run now* starts it; *Reschedule* re-arms it; *Dismiss* turns it into a normal workflow.
- [ ] **Cancel schedule.** The armed instance becomes a normal workflow, can be started by hand, and no new instance appears.
- [ ] **Archive.** *Archive* / *Unarchive* on a completed or failed workflow; running, waiting, paused, draft and armed instances cannot be archived; Settings → archive after N days (0 disables).

### Server (dashboard)

- [ ] **Schedule editor.** Creating a remote workflow with a schedule (and scheduling an existing one) offers Once / Daily / Weekly, a timezone and *include previous run*; invalid input is refused; scheduling requires `client.workflows.execute` and `client.workflows.manage`; a hub without the command shows the capability error.
- [ ] **Series view.** *Scheduled series* lists each series with state (active / cancelled / broken), spec, timezone and its instances oldest first with created by (server / hub), schedule state, scheduled for and next run.
- [ ] **Filters.** The workflows table has the *Schedule filter*, *Scheduled runs* and *Archived* views; archive and unarchive done on the hub appear here.
- [ ] **Notices.** *Schedule notices* shows missed and skipped runs reported by the hub.
- [ ] **Cancel.** *Cancel schedule* marks the series cancelled; the hub's armed instance becomes a normal workflow; the series is not revived by later hub events.
- [ ] **Server-managed.** On the hub the same series is read-only (local edits answer `server_managed`).
