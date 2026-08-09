#!/usr/bin/env node
/**
 * Seed the "report to server" workflow with every step needed to implement
 * docs/report-server.es.html.
 *
 * The `target` CLI's `add-step` only takes a description, so this posts to the
 * API directly to also set each step's acceptance criteria (and manual-review /
 * retry knobs). Run it against a RUNNING hub:
 *
 *   WORKFLOW_ID=<id> \
 *   TARGET_ADMIN_TOKEN=<token from `target start` output / ~/.target/config.json> \
 *   TARGET_API=http://127.0.0.1:8893/api \
 *   node scripts/seed-report-steps.mjs [--dry-run]
 *
 * Idempotency: this APPENDS steps; running it twice adds them twice. Seed once
 * on a workflow that only has the context/plan steps so far.
 */

const API = process.env.TARGET_API ?? "http://127.0.0.1:8893/api";
const WORKFLOW_ID = process.env.WORKFLOW_ID;
const TOKEN = process.env.TARGET_ADMIN_TOKEN;
const DRY = process.argv.includes("--dry-run");

if (!WORKFLOW_ID || (!DRY && !TOKEN)) {
  console.error("Set WORKFLOW_ID (and TARGET_ADMIN_TOKEN unless --dry-run). See file header.");
  process.exit(1);
}

const PLAN = "docs/report-server.es.html";

/** @type {{ description: string, acceptanceCriteria: string, manualReview?: boolean }[]} */
const steps = [
  // ---- Phase 0 — versioning & scaffolding ----
  {
    description:
      `Implement Phase 0 of ${PLAN} (versioning & scaffolding). Create CHANGELOG.md at the repo root ` +
      `in Keep-a-Changelog format with a [0.2.0] entry describing the activity-reporting feature, and an [Unreleased] header. ` +
      `Bump "version" to 0.2.0 in package.json, hub/package.json and hub/ui/package.json. Add hub/version.ts that reads ` +
      `the root package.json and exports TARGET_VERSION. Do NOT wire any reporting yet.`,
    acceptanceCriteria:
      `CHANGELOG.md exists at repo root with a [0.2.0] section for the reporting feature; the three package.json files all ` +
      `read version 0.2.0; hub/version.ts exports TARGET_VERSION equal to that version; \`npm run typecheck\` passes.`,
  },
  {
    description:
      `Implement the .env support from §3 of ${PLAN}. At the start of loadConfig() in hub/config.ts, load a .env via ` +
      `process.loadEnvFile(), trying \${TARGET_HOME}/.env first then \${cwd}/.env, ignoring a missing/invalid file. ` +
      `Add a versioned .env.example listing TARGET_REPORT_URL, TARGET_REPORT_TOKEN, TARGET_REPORT_ENABLED, ` +
      `TARGET_REPORT_INTERVAL_MS, TARGET_REPORT_INCLUDE_CONVERSATIONS and (commented) TARGET_INSTANCE_ID. Add .env to .gitignore.`,
    acceptanceCriteria:
      `.env is loaded during loadConfig() from TARGET_HOME then cwd; .env.example documents every report variable from §3; ` +
      `.gitignore ignores .env; a test in hub/ proves variables from a temp .env are visible on process.env after loadConfig(); typecheck passes.`,
  },

  // ---- Phase A — config surface & durable queue ----
  {
    description:
      `Add the derived report configuration (§3/§8 of ${PLAN}) to hub/config.ts: a reportConfig object with ` +
      `{ url, token, enabled, intervalMs, includeConversations ('off'|'digest'|'full'), instanceId }, read from process.env ` +
      `(NOT from config.json, so the URL/token stay only in .env). Reporting is disabled when url is empty or ` +
      `TARGET_REPORT_ENABLED=false. Warn in the log if url is a non-loopback http:// URL.`,
    acceptanceCriteria:
      `loadConfig() exposes reportConfig with the documented fields and defaults (interval 30000, includeConversations 'digest'); ` +
      `it reports disabled when TARGET_REPORT_URL is unset or TARGET_REPORT_ENABLED=false; a non-loopback http URL logs a warning; ` +
      `tests cover enabled/disabled and the http warning; typecheck passes.`,
  },
  {
    description:
      `Add the durable event queue from §5 of ${PLAN}. In hub/db.ts create the report_events table ` +
      `(id, kind, workflow_id, session_id, payload JSON, created_at, delivered_at, attempts, next_try_at) with the pending index, ` +
      `alongside the other CREATE TABLE statements. Add helpers enqueueEvent, pendingEvents(limit), markDelivered(ids), ` +
      `markFailed(ids, nextTryAt). Persist a stable instance_id in the settings table (generate once if TARGET_INSTANCE_ID is unset).`,
    acceptanceCriteria:
      `A fresh DB has report_events with the §5 columns and idx_report_pending; enqueue/pending/markDelivered/markFailed round-trip ` +
      `correctly; instance_id is generated once and stable across loads (and honours TARGET_INSTANCE_ID when set); hub tests cover it; typecheck passes.`,
  },

  // ---- Phase B — the reporter ----
  {
    description:
      `Create hub/reporter.ts implementing the client side of the §7 contract of ${PLAN}. emit(kind, {workflowId, sessionId, data}) ` +
      `does ONE local INSERT into report_events and returns immediately (a no-op when reporting is disabled). flush() builds the §7.1 batch ` +
      `envelope (batch_id + Idempotency-Key header, instance_id, version from TARGET_VERSION, schema_version), POSTs it with a Bearer token and ` +
      `AbortSignal.timeout() (mirror hub/notifier.ts's fetch pattern), then applies §7.4/§7.5: mark accepted ids delivered, quarantine permanent ` +
      `4xx/schema rejects, honour 429 Retry-After, and back off (attempts++, next_try_at) on 5xx/timeout. Cap batch size (~100 events).`,
    acceptanceCriteria:
      `emit() inserts a row and never blocks (no-op when disabled, no fetch); flush() sends the §7.1/§7.2 envelope and, driven by a fake fetch, ` +
      `handles: 200 with partial accepted/rejected (delivers accepted, quarantines schema rejects), 400/401/403 (no infinite retry), 429 (respects ` +
      `Retry-After), and 5xx/timeout (sets next_try_at with backoff). reporter.test.ts covers all these cases and passes; typecheck passes.`,
  },
  {
    description:
      `Wire the reporter into the daemon (§6 of ${PLAN}). In hub/daemon.ts startHub(), add a second setInterval on ` +
      `TARGET_REPORT_INTERVAL_MS that calls reporter.flush() inside try/catch and is .unref()'d, plus a periodic 'heartbeat' event ` +
      `(version, os, uptime_ms, workflows_total, queue_pending). Do nothing when reporting is disabled.`,
    acceptanceCriteria:
      `With reporting enabled the daemon flushes on its interval and emits periodic heartbeat events carrying TARGET_VERSION and instance_id; ` +
      `the interval is unref'd and a throwing flush cannot crash the daemon; with reporting disabled no interval/heartbeat is scheduled; typecheck passes.`,
  },

  // ---- Phase C — emission points ----
  {
    description:
      `Emit the workflow lifecycle events from §7.2 in hub/workflow.ts: workflow.created, workflow.renamed, workflow.removed and ` +
      `workflow.status_changed (from/to/manual). When status becomes 'failed', attach the structured error object from §7.3. ` +
      `Call reporter.emit() from createWorkflow, renameWorkflow, removeWorkflow and the status-change path.`,
    acceptanceCriteria:
      `Creating/renaming/removing a workflow and each status change emit the matching event with the §7.2 data shape; ` +
      `status_changed→failed carries the §7.3 error object (phase/kind/message/retryable/...); emission never changes workflow state on failure; ` +
      `tests assert the emitted rows; typecheck passes.`,
  },
  {
    description:
      `Emit the step lifecycle events from §7.2/§7.3 in hub/workflow.ts: step.started at dispatch, and step.done / step.failed / ` +
      `step.waiting / step.judged in onStepResult (and the judge path). step.failed and a failed step.judged MUST carry the §7.3 error object ` +
      `(phase exec|judge, kind, truncated message from steps.error/outcome.error, retryable, retry_count, max_retries, failed_criterion, timestamps).`,
    acceptanceCriteria:
      `Every step transition emits its event with correct order_index/phase/retry fields; step.failed and failed step.judged include the §7.3 ` +
      `error object with a truncated message and correct retryable = retry_count < max_retries; hub tests cover a success, an exec failure and a ` +
      `judge rejection; typecheck passes.`,
  },
  {
    description:
      `Emit usage.snapshot and conversation.snapshot (§7.2, §8 of ${PLAN}). On step close, derive usage from readTokenUsage ` +
      `(hub/transcript.ts) and emit usage.snapshot (input/output tokens, cache, cost_usd, compacted). Emit conversation.snapshot honouring ` +
      `TARGET_REPORT_INCLUDE_CONVERSATIONS: 'off' emits nothing, 'digest' uses readConversationDigest (metadata + summary only), 'full' includes ` +
      `messages. Never include the hook secret or auth/session hashes.`,
    acceptanceCriteria:
      `A closed step emits usage.snapshot with the token/cost fields; conversation.snapshot obeys the privacy mode (none on 'off', no full text on ` +
      `'digest', messages on 'full'); no secret/hash ever appears in any payload; tests cover the three privacy modes; typecheck passes.`,
  },

  // ---- Docs & test sweep ----
  {
    description:
      `Round out the test suite and docs (§10 of ${PLAN}). Ensure coverage exists for: .env loading precedence, TARGET_VERSION matching ` +
      `package.json, reporter §7.4/§7.5 behaviours, event idempotency (same id on resend), and the privacy modes. Add an "Activity reporting" ` +
      `section to README.md documenting the .env variables, the version/CHANGELOG story, and the privacy switch.`,
    acceptanceCriteria:
      `\`npm test\` passes with the new tests; README.md has an Activity-reporting section covering every .env variable, versioning via ` +
      `CHANGELOG.md, and the conversation privacy modes.`,
  },

  // ---- Land it (repo convention) ----
  {
    description:
      `Create a new branch (e.g. feat/report-to-server), commit all the changes with a clear message, and open a pull request whose ` +
      `body summarises the feature and links docs/report-server.es.html.`,
    acceptanceCriteria:
      `A new branch exists with the committed changes and an open PR references the plan; the PR body summarises the reporting feature.`,
  },
  {
    description: `Merge the pull request, and after it is merged delete the feature branch.`,
    acceptanceCriteria: `The PR is merged into main and its feature branch is deleted.`,
  },
];

async function main() {
  console.log(`${DRY ? "[dry-run] " : ""}Seeding ${steps.length} steps into workflow ${WORKFLOW_ID} via ${API}`);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const label = `${String(i + 1).padStart(2, "0")}  ${s.description.slice(0, 70)}…`;
    if (DRY) {
      console.log(`  would add: ${label}`);
      continue;
    }
    const res = await fetch(`${API}/workflows/${WORKFLOW_ID}/steps`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria,
        ...(s.manualReview ? { manualReview: true } : {}),
      }),
    });
    if (!res.ok) {
      console.error(`  FAILED at step ${i + 1}: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    console.log(`  added: ${label}`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
