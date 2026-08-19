/**
 * Hermetic test setup, loaded via `node --test --import ./test-setup.ts`
 * (see hub/package.json `test`).
 *
 * The hub's host install-check in POST /api/workflows calls availableRunners(),
 * which probes `claude`/`free-code`/`agent` (cursor) on PATH with `<cli> --version`.
 * are installed on dev machines but NOT on CI runners, so without this stub
 * every workflow-creation test would get a 400 ("runner not installed") and the
 * suite would be red on CI. Workflow-CRUD tests don't care whether the CLIs are
 * actually installed — they test the hub, not CLI execution — so the probe is
 * stubbed to report both runners installed, WITHOUT spawning (it returns
 * status 0 for any command, including a nonexistent one, so the result is
 * independent of what's on PATH).
 *
 * The same stub answers the docker probes (`dockerAvailable`, which gates
 * `sandbox: "docker"` creation, and `sandboxImageExists`, which decides whether
 * a dispatch has to build the image first), and for the same reason in reverse:
 * docker is present on dev machines and absent on CI, so without it the sandbox
 * tests would pass locally and 400 on CI. Answering "yes, the image is here" is
 * also what guarantees no test ever shells out to a real `docker build`.
 *
 * Per-test overrides still win: runner-install.test.ts reassigns
 * `_impl.spawnSync` itself (and restores it via t.after) to force a runner to
 * read as uninstalled, so the install-check's 400 path is still exercised
 * there, and docker-sandbox.test.ts does the same for docker (clearing the
 * probe cache around itself, since that answer is cached).
 */
import { _impl } from "./awb.ts";

_impl.spawnSync = (() => ({ status: 0 })) as unknown as typeof _impl.spawnSync;
