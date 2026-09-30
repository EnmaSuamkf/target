# Changelog

All notable changes to The Target Project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The current version is reported by every instance to the central server (see
`docs/report-server.es.html`), so it should be bumped whenever behaviour changes.

## [Unreleased]

### Added

- **Scheduled workflows (UI and Slack notices).**
  - **Schedule dialog.** Offers once, daily and weekly, a searchable timezone
    list (the browser's by default) and the previous-run toggle. It previews
    the next 3 runs from the hub, warns about manual-review steps, and can
    edit or cancel a schedule. A server-managed series is read-only; an
    adopted conversation is refused with the reason.
  - **Badges and run gate.** `Scheduled · next in …` on the armed instance,
    `Run of <series> · <occurrence>` on past runs, and a warning style for
    missed and broken. Start and a step's Retry are disabled on the armed
    instance ("Scheduled — runs automatically").
  - **Filters.** A **Scheduled / Scheduled runs** filter in the rail and the
    All workflows page, combined with Archived. The detail pane gets a
    series panel listing every instance, newest first, with status and links.
  - **Notices.** A banner lists unacknowledged schedule notices, with
    Acknowledge. A missed once offers Run now / Reschedule / Dismiss in the
    banner and in the detail pane.
  - **Slack.** Missed, skipped, broken and failed-start notices, plus
    scheduled runs that end `failed`, are sent through the existing Slack
    notification settings. A non-scheduled failure still sends nothing.
- **Scheduled workflows (engine and API).**
  - **Model.** A workflow can be scheduled once, daily or weekly in an
    explicit IANA timezone. Recurrence uses `Intl` only; a time skipped by a
    daylight-saving change runs at the change, and a repeated time runs once.
    A schedule is a series of instances with exactly one armed instance, the
    next run.
  - **Scheduler.** It ticks every 30s and at boot, claims each run atomically
    and clones the next instance before starting the current run. A run more
    than 10 minutes late is missed: recurring series move on without creating
    workflows, and a once waits for Run now / Reschedule / Dismiss. A run is
    skipped if the previous one is still in progress, or if the linked
    owner's `client.workflows.execute` can't be confirmed (5-minute boot
    wait, 7-day snapshot limit). A failed clone marks the series broken but
    still runs the current instance.
  - **Previous run.** Each run is told about the previous one through the
    context step; in docker that run's results folder is mounted, made
    non-writable because awb has no read-only mount option.
  - **Guards.** The armed instance refuses manual runs with
    `409 { "error": "scheduled_armed" }`, stays editable, and is never
    archived.
  - **Notices.** Missed, skipped, broken and failed runs are stored in
    `schedule_notices`.
  - **API.** `GET`/`PUT`/`DELETE /api/workflows/:id/schedule`,
    `POST …/schedule/run-now|reschedule|dismiss`, `GET /api/schedule-notices`,
    `POST /api/schedule-notices/:id/ack` and `POST /api/schedule/preview`.
    Mutations need `client.workflows.execute` and `client.workflows.manage`.
    Server-managed series answer `409 server_managed`.
  - **MCP.** `set_schedule`, `cancel_schedule`, `list_schedule_notices`, and
    also `get_schedule`, `preview_schedule`, `acknowledge_schedule_notice`.
  - **Not yet.** Remote sync of schedules follows in a later release.
- **Archive workflows, automatically and on demand.** Archiving is an
  `archived_at` flag beside the status, allowed only on completed/failed
  workflows. The daemon's 60s sweep archives them once their last activity
  (later of `updated_at` and the steps' latest `finished_at`) is older than
  `archive_after_days` (default 30, `0` disables; Settings → Auto-archive,
  `GET`/`PUT /api/settings/archive`). Operators can archive/unarchive by hand
  (`POST /api/workflows/:id/archive|unarchive`, detail view buttons, MCP
  `archive_workflow` / `unarchive_workflow`); a non-completed/failed workflow
  answers `409 not_archivable`. `GET /api/workflows` hides archived workflows
  unless `?archived=include|only`, and the UI rail and All workflows page gain
  an **Archived** filter and badge. An archived workflow refuses
  start/resume/restart/step run with `409 { "error": "archived" }`.
- **Server capabilities gate new sync event types.** The hub now reads and
  persists `server_capabilities.events` from register/heartbeat responses and
  only queues newer event types when the server lists them; remote workflows
  emit `workflow.archived` / `workflow.unarchived` on that basis. Gated events
  no longer advertised are dropped at flush; the list is cleared on unlink.

- **Role-based catalog sync from the linked server.** Settings → Catalog
  navigation offers **Sync resources** when the owner's role includes any of
  `client.templates.sync`, `client.tcp-tools.sync`, or `client.rci.sync`. The
  hub pulls `GET /api/sync/catalog` (`catalog-sync/v1`), stores copies with
  `origin=server` / `sync_source=catalog`, and marks them Enabled only while
  `canUseServerResources()` holds (enforced mode plus a workflow
  create/edit/manage permission) and the copy is not revoked. Using an
  unusable copy from the operator HTTP API returns
  `403 { "error": "server_resource_disabled" }`. An old server that lacks the
  catalog route surfaces “The server does not support resource sync”. See
  [`docs/hub-permissions.md`](docs/hub-permissions.md).

### Changed

- **Client permission IDs are `client.*`, not `remote.*`.** The hub gate, UI
  types, tooltips and `docs/hub-permissions.md` now use IDs such as
  `client.workflows.execute` and `client.workflows.manage`. Semantics are
  unchanged: pause still accepts execute or manage; disconnect and Remote
  Sync still need manage. The old `remote.*` prefix is only mentioned here
  as the previous name.

### Added

- **Linked-owner permissions on the local hub.** A hub that is not linked to
  a server is unchanged: every local action still works. Once it is linked,
  target-server already sends the owner's `client.*` role on register and
  heartbeat; the hub now stores that snapshot, expires it after
  `max(30s, 3 × sync)`, and applies it. Mutating HTTP routes answer 403 with
  the missing permission instead of doing the work. GET reads stay open
  (exports are the exception). The UI greys the same controls and names the
  missing id rather than hiding the button. Settings shows the granted list
  and says this is governance, not a security boundary: the admin token, the
  CLI, `~/.target/target.db` and `device-link.json` still sit on the machine.
  See [`docs/hub-permissions.md`](docs/hub-permissions.md).

- **Token usage on the workflow detail page, in the Conversation panel.** A
  workflow now shows the same readout its operator's client shows for the same
  session: a `Context 202.0k / 1.0M` bar with the percentage, then
  `143 turns · in 16.0M · out 98.6k · incl. subagents`. Same words, same
  abbreviations, so the two can be held side by side and compared digit for
  digit — which is the only way to notice they have drifted apart again. It is
  stated once, in the panel that describes the session it belongs to; a separate
  "Token usage" panel under the steps was tried first and only meant the page
  printed the same context bar twice, one directly above the other.

- **Slack notifications no longer need the official plugin.** Delivery used to
  have exactly one route — an OAuth login for the Slack MCP, stored by
  `claude /mcp` in `~/.claude/.credentials.json` — so anyone using a different
  Slack MCP got silence, whatever they had configured: the hub read only that
  one file, spoke only HTTP MCP, and called two tool names only that plugin
  exposes. It now also reads a Slack web session from the environment
  (`TARGET_SLACK_XOXC_TOKEN` + `TARGET_SLACK_XOXD_TOKEN`, with the
  `SLACK_MCP_*` and `SLACK_*` names a third-party MCP may already use accepted
  too) and posts to `slack.com/api` directly, with no MCP anywhere in the path.
  That route is tried first, because two variables in `.env` are a deliberate
  choice while a stored OAuth token is whatever a past `/mcp` login left behind.
  It is a preference, not a commitment: the transports are tried in turn, so a
  `d` cookie that expired overnight falls through to the MCP instead of costing
  the notification, and only when every route has failed is one lost. When that
  happens the log now carries Slack's own words (`send-failed:
  chat.postMessage: invalid_auth`) instead of a bare `send-failed` — the point
  being that expired client tokens announce themselves rather than turning into
  notifications that quietly stop arriving.

- **Templates travel between machines as a file.** A template was always pure
  data — a name, tags and an ordered step list, with no path, secret or session
  id anywhere in it — but it had no way out of the SQLite file it was born in.
  Export writes one (or every) template as a versioned `target.templates`
  bundle, import reads one back: the same `.json` a teammate can be handed, kept
  in a repo, or diffed by hand before it is used. An imported template is a new
  template, never an overwrite — it is given a fresh id, and a name already
  taken on this machine gets the same `Clone - ` prefix a cloned workflow does.
  Because import reuses the normalizers the CRUD routes already trusted, a
  bundle written before a step field existed still lands with that field's
  default rather than being rejected.

- **Subagent boxes on the canvas.** A step whose work is delegated now has a box
  wired into the left of its card, opposite the judge circle: the two branches
  are the two questions the list only answers in words — who runs this step, and
  what its result has to pass. The box wears the step's own state, so during a
  run it says there is a subagent on that step *right now*; a step with no box
  runs inline. The legend names it.
- **The step list says how every step will run.** Each row now carries a
  `subagent` badge as well as the existing `manual review` one, so both facts an
  operator checks before pressing Start are on the row. Previously only the
  non-default choice (`inline`) was shown, and a silent row meant both
  "delegated" and "nobody decided".

### Fixed

- **The token numbers the server reports now match the ones the operator's own
  client shows.** The hub reported a session's `input_tokens` as the bare
  `usage.input_tokens` field of each assistant turn. With prompt caching on
  almost every input token is a cache *read*, so that field measures next to
  nothing: a real 143-turn session on this machine billed **416** uncached input
  tokens against **16,015,192** total (1,605,396 cache creation + 14,409,380
  cache read), and the report server's "INPUT TOKENS" tile duly read `416` next
  to a client reading `in 16.0M`. Output tokens had always agreed (98,599 either
  way), which is what made the input column look like a display bug rather than
  a different number. `usage.snapshot` now leads with that total — the same one
  the client calls "in" — and carries the components beside it
  (`input_tokens_uncached`, `cache_creation`, `cache_read`) so the headline
  stays auditable and the three rates can still be priced apart. It also carries
  what the server previously had no notion of at all: `context_tokens`,
  `context_window` and `context_pct` (how full the window is), `model`, `turns`,
  and `includes_subagents` — a step's real work runs in a subagent, so totals
  that fold those transcripts in are unexplainable unless they say so.

### Changed

- **A workflow created from a conversation now RUNS ON that conversation.**
  Picking one no longer condenses it into the workflow's context — a summary
  with turns cut out of the middle, delivered to a brand-new session. The
  workflow adopts the session itself, so its first step is a `claude --resume` /
  `free-code --session` of that exact conversation and the agent starts with the
  whole history, nothing truncated. Because the harness resumes a session
  relative to the directory it ran in, the create form now *takes* the working
  directory from the chosen conversation (read-only, and the runner follows the
  agent filter); the API refuses a request asking for different ones instead of
  overriding them silently. A restart returns to the adopted conversation rather
  than to a blank session, and a clone deliberately gets a fresh session of its
  own — two workflows must not interleave turns in the operator's thread. The
  new "Say this first" box replaces the old import note: one turn delivered in
  that conversation before step 1, for what should change from here on. See
  `docs/createFromConversation.md`.

- **Start switches the steps to the canvas.** Once a run is in flight the
  question stops being "what is in this workflow" and becomes "where is it now",
  so the run control shows the canvas without being asked (Alt/Shift+S too). The
  List/Canvas toggle takes it straight back.
- **The canvas opens at 60% zoom**, with a longer ladder to move along
  (15 / 30 / 45 / 60 / 75 / 90 / 100 / 115 / 135%), so it shows the shape of the
  workflow rather than opening as a scrollbar — while a card still reads. The
  drawing is now laid out at its zoomed size, so zooming out no longer strands
  the picture in the corner of an empty scroll area.

## [0.2.0] - 2026-08-09

### Added

- **Activity reporting to a central server.** Each instance can report its
  activity — workflow lifecycle, step transitions, token usage and (optionally)
  conversation digests — to a server for monitoring. Events are queued durably
  in a new `report_events` table and flushed in batches by the daemon.
- **Activity reporting configuration.** The report destination and behaviour are
  managed from **Settings → Activity reporting** (URL, token, interval, conversation
  privacy). Legacy process-env overrides remain for tests/advanced ops. With no URL
  configured, reporting is fully disabled.
- **Client versioning.** `hub/version.ts` exposes `TARGET_VERSION` (sourced from
  `package.json`); it is included in every report so the server sees which
  version each user runs.

## [0.1.0]

- Initial internal version: workflows made of sequential steps, each running as
  a job against one dedicated agent + hook on a shared Claude session.
