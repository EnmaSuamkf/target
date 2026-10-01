# `usage.snapshot`: `model`, `agent` and `cost_usd`

What the hub guarantees in the `usage.snapshot` report event so a server can
price a session by `(agent, model)`. The wire contract itself is
`docs/report-server.es.html` §7.2; code is `usageSnapshot` and `readTokenUsage`
in `hub/transcript.ts`, emitted by `reportUsageSnapshot` in `hub/workflow.ts`.

## Payload

All earlier fields are unchanged (`input_tokens`, `output_tokens`,
`input_tokens_uncached`, `cache_creation`, `cache_read`, `context_tokens`,
`context_window`, `context_pct`, `context_estimated`, `model`, `turns`,
`includes_subagents`, `compacted`, `cost_usd`). Only `agent` was added.

| Field | Type | Guarantee |
| --- | --- | --- |
| `agent` | string, optional | The runner id of the workflow (`claude`, `free-code`, `cursor`), taken from the workflow's hook harness. **Omitted** when the hub doesn't know it; never guessed. |
| `model` | string or `null` | The model the session ran on whenever a source on disk names it; `null` otherwise, never invented. |
| `cost_usd` | number or `null` | Only a cost the runner itself recorded for the whole session (see below). Never computed from token counts in the hub. |

### Where `model` comes from

- **claude**: `message.model` of the last real assistant turn in the main
  transcript (`<synthetic>` error notices are ignored). If the main thread has no
  real turn but a subagent transcript does, the subagent's model.
- **free-code**: the last `model_change.modelId` (or `message.model`).
- **cursor**, first match wins: `model` / `modelUsage` in the run result, the
  `--model` flag of the logged `agent -p` command, Cursor's tracking database
  (`ai_code_hashes.model`), the transcript's `modelName`, then the CLI default
  (`~/.cursor/cli-config.json` `model.modelId`). The last one is the CLI's
  setting at snapshot time, not a per-session record; it only applies when
  nothing per-session names the model (e.g. a step that edited no files).

`model` stays `null` for a snapshot taken before any assistant turn and for a
session whose only turn is a `<synthetic>` error.

### `cost_usd` policy

| Runner | `cost_usd` | Why |
| --- | --- | --- |
| `free-code` | number | Sum of `message.usage.cost.total` over deduplicated turns, as free-code recorded it. `null` if any turn that spent tokens has no positive cost (models free-code has no price for report `0`), or if subagent transcripts are folded in. |
| `claude` | `null` | `total_cost_usd` in the result JSON and the transcript `cost-state` records are per run/process and reset on `--resume`; they are not a session total. |
| `cursor` | `null` | The `agent -p` result carries token counts and no cost. |

When `cost_usd` is `null` the server prices the session from its own table by
`(agent, model)`, falling back to `(agent, '*')` when the model is unknown.

## What a server can rely on

- **Newer server, older hub**: `agent` may be absent. Fall back to the `agent`
  of the workflow's `workflow.created` / `workflow.updated` events. Older hubs
  also left `model` `null` more often; treat `null` as "unknown", not an error.
- **Older server, newer hub**: nothing breaks; fields were only added, none
  renamed or removed, and `cost_usd` is still a number-or-null that older
  servers ignore or already handle as `null`.
- `input_tokens` etc. are cumulative per session, so the latest snapshot of a
  session replaces earlier ones.

## Verify on a live hub

1. Enable reporting (`TARGET_REPORT_URL`, or Settings → Report) so the hub
   queues events; with reporting off nothing is emitted.
2. Run a workflow step to completion (or fail/time out). The hub emits a
   `usage.snapshot` each time a step settles, after reading the session's
   transcript. A session whose transcript can't be read emits none.
3. Read the queued JSON from the hub's SQLite database (`target.db` under
   `TARGET_HOME`, default `~/.target`), table `report_events`:

   ```sh
   node -e '
   const { DatabaseSync } = require("node:sqlite");
   const db = new DatabaseSync(process.env.HOME + "/.target/target.db", { readOnly: true });
   for (const r of db.prepare("SELECT created_at, payload FROM report_events WHERE kind = ? ORDER BY created_at DESC LIMIT 3").all("usage.snapshot"))
     console.log(r.created_at, r.payload);
   '
   ```

   `payload.data` holds the fields above; check `agent` and `model`. Delivered
   rows are purged after a retention period, so look soon after the step ends,
   or point `TARGET_REPORT_URL` at a request-logging endpoint instead.

## Tests

`hub/usage-snapshot-model.test.ts` (model per runner) and
`hub/usage-report.test.ts` (`agent` and `cost_usd`).
