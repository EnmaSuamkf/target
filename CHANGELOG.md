# Changelog

All notable changes to The Target Project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The current version is reported by every instance to the central server (see
`docs/report-server.es.html`), so it should be bumped whenever behaviour changes.

## [Unreleased]

### Added

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

### Changed

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
