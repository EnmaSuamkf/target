# Scheduled workflows e2e — report

Command: `npm run e2e:scheduled`. Hub `22c7348` on `integration/scheduled-workflows` (`56652e3`), server `651b907`.

| Id | Scenario | Result |
| --- | --- | --- |
| S0 | boot, link, plain two-step workflow completes through the stand-in broker | PASS |
| S1 | local daily series fires on time; next instance named/armed; 2nd fire carries previous-run block | PASS |
| S2 | start/resume/restart/step run on an armed instance → 409 scheduled_armed | PASS |
| S3 | missed recurring → notice with 2 missed, no extra workflows, re-armed | PASS |
| S4 | missed once → missed + notice → run-now | PASS |
| S5 | overlap → skipped (busy) + notice + re-armed | PASS |
| S6 | auto-archive rules + default list excludes archived | PASS |

## Failures found while building the scenarios

| Where | Class | Evidence | Fix |
| --- | --- | --- | --- |
| harness cleanup | harness bug | Full run printed 7/7 PASS but exited 1 and left `/tmp/sched-e2e-*`: `rm: cannot remove '…/hub-home/steps/s1-daily-series-…/01-write-the-digest.md': Permission denied`. The product locks the previous run's step-results dir read-only on purpose (D5, `lockStepResults`), so `fs.rmSync` threw in `cleanup()`. | `removeTree()` restores write access first and only warns if removal still fails. |

No product bugs were found by S1–S6.
