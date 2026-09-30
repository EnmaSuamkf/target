# Scheduled workflows e2e — report

Command: `npm run e2e:scheduled` (~12 minutes). Hub `integration/scheduled-workflows` (`56652e3`) + harness, server `651b907` (`origin/integration/scheduled-workflows`).

| Id | Scenario | Result |
| --- | --- | --- |
| S0 | boot, link, plain two-step workflow completes through the stand-in broker | PASS |
| S1 | local daily series fires on time; next instance named/armed; 2nd fire carries previous-run block | PASS |
| S2 | start/resume/restart/step run on an armed instance → 409 scheduled_armed | PASS |
| S3 | missed recurring → notice with 2 missed, no extra workflows, re-armed | PASS |
| S4 | missed once → missed + notice → run-now | PASS |
| S5 | overlap → skipped (busy) + notice + re-armed | PASS |
| S6 | auto-archive rules + default list excludes archived | PASS |
| S7 | remote series created on the server → hub applies it, managed_by server, local PUT/DELETE → 409 server_managed | PASS |
| S8 | two fires → server lists 3 instances (server,hub,hub), equal step_keys; step.edit on fired → instance_already_fired | PASS |
| S9 | hub killed after a fire with the events route blocked → announced exactly once after restart | PASS |
| S10 | missed remote occurrences → run_missed mirrored on the server | PASS |
| S11 | server cancel → normal workflow on the hub, series cancelled; archive/unarchive mirrored | PASS |
| S12 | foreign client cannot announce into (or cancel) another client's series | PASS |

## Failures found while building the scenarios

All were harness bugs; no product bug has been found so far. Every one is fixed.

| Scenario | Class | Evidence | Fix |
| --- | --- | --- | --- |
| cleanup (S1) | harness | Full run printed 7/7 PASS but exited 1 and left `/tmp/sched-e2e-*`: `rm: cannot remove '…/hub-home/steps/s1-daily-series-…/01-write-the-digest.md': Permission denied`. The product locks the previous run's step-results dir read-only on purpose (D5). | `removeTree()` restores write access first and only warns if removal still fails. |
| S8 | harness | `assertion failed: step.edit on the armed instance is applied — expected "applied", got "acked"`. The server stores a command the hub applied as `acked` (the failed one as `failed`, which the same scenario asserted correctly). | Expect `acked`. |
| S9 | harness | `assertion failed: the clone is not announced yet — expected null, got "2026-09-30T22:20:27.425Z"`. The poll for "an armed instance of the series" matched the ORIGINAL instance (armed until it fires, already announced by the server). | Only an armed row with a different `remote_id` counts as the clone. |
| S9 | harness | `timed out after 120000ms waiting for the hub to fire and clone`; hub log `scheduler: S9 announce once: 1 run(s) missed`. The series was created 2h ahead, so rewinding 24h made the run 22h late and the hub (correctly, D8) reported it missed instead of firing. | Create the series on a slot that passed 2 minutes ago (as S5 does), so the 24h rewind lands inside the grace window. |

## Harness notes relevant to reading failures

- Server-created workflows are docker-sandbox ones; the harness puts a stub `docker` on the hub's PATH (daemon up, image present) so the hub never probes or builds on the host.
- A proxy on 8994 fronts the real server (8995). S9 uses it to make `POST /api/sync/events` answer 503 without touching the server.
- After a hub restart the hub waits for its first live heartbeat before firing (D10), so a due run fires on the second ~30s tick.
