# Changelog

All notable changes to The Target Project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The current version is reported by every instance to the central server (see
`docs/report-server.es.html`), so it should be bumped whenever behaviour changes.

## [Unreleased]

### Added

- **Token usage on the workflow detail page, under the steps.** Below the
  Canvas/List content and the canvas legend, a workflow now shows the same
  readout its operator's client shows for the same session: a
  `Context 202.0k / 1.0M` bar with the percentage, then
  `143 turns · in 16.0M · out 98.6k · incl. subagents`. Same words, same
  abbreviations, so the two can be held side by side and compared digit for
  digit — which is the only way to notice they have drifted apart again. The
  Conversation panel and this one render the same component, so they cannot
  disagree with each other either.

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
- **`.env` configuration.** The report destination and behaviour are read from a
  `.env` file (`TARGET_REPORT_URL`, `TARGET_REPORT_TOKEN`,
  `TARGET_REPORT_ENABLED`, `TARGET_REPORT_INTERVAL_MS`,
  `TARGET_REPORT_INCLUDE_CONVERSATIONS`, `TARGET_INSTANCE_ID`). See
  `.env.example`. With no URL configured, reporting is fully disabled.
- **Client versioning.** `hub/version.ts` exposes `TARGET_VERSION` (sourced from
  `package.json`); it is included in every report so the server sees which
  version each user runs.

## [0.1.0]

- Initial internal version: workflows made of sequential steps, each running as
  a job against one dedicated agent + hook on a shared Claude session.
