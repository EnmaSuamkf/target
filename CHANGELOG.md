# Changelog

All notable changes to The Target Project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The current version is reported by every instance to the central server (see
`docs/report-server.es.html`), so it should be bumped whenever behaviour changes.

## [Unreleased]

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
