# Go changelog

`github.com/stablemates/workhorse/go` versions and release notes live here because the Go module
releases independently from the TypeScript packages and the Python distribution.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## 0.1.0 — 2026-09-14

Published through the Go module proxy from one source commit shared with the npm packages and the
Python distribution, tagged `go/v0.1.0`. This is the first version without a prerelease suffix
([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)). The module stays
a public beta on the `0.x` line.

Requires **schema v1** and Go **1.25** or newer.

### Changed

- No exported API changed since `0.1.0-beta.1`. The README states the unpinned install command and
  the schema install step, which the TypeScript CLI owns.
- The dashboard backend's run-now action calls the audited `workhorse.run_task_now_v1` instead of
  `workhorse.dashboard_run_task_now_v1`, which is removed from the schema. The action now records
  the authenticated actor, the reason, and the request identity in its `promoted` event, matching
  the TypeScript dashboard server.
- **Dashboard timestamps.** Every timestamp a dashboard mutation returns is now UTC with exactly
  three fractional digits, matching the TypeScript and Python backends. It was `time.RFC3339Nano`,
  which dropped a trailing zero and passed through PostgreSQL's microseconds, so this module
  answered `2026-09-02T14:30:00Z` and `...:00.123456Z` where the other two answer
  `2026-09-02T14:30:00.000Z` and `...:00.123Z`. A client that compares or displays the string sees
  a different value; one that parses it does not.

### Upgrade notes

- **Schema version.** `0.1.0` stays at schema version 1, but its baseline is not the one the last
  beta installed: `workhorse.valid_tags` was renamed `workhorse.valid_tags_v1` and
  `workhorse.dashboard_run_task_now_v1` was removed. A database installed by any beta reports
  version 1 and passes the compatibility check, yet holds the old function names. You must recreate the database and
  install the new baseline with
  `npx --package @stablemates/workhorse@0.1.0 workhorse schema install`.
  This is the last release that asks for a recreation: from `0.1.0` the schema is frozen as the
  migration baseline, and later releases upgrade a database in place.

## 0.1.0-beta.1 — 2026-09-01

Published through the Go module proxy from commit `dbd5437362930f712157ffcc72c3296e971e4f5a`,
tagged `go/v0.1.0-beta.1`.

### Changed

- The module uses the Apache License, Version 2.0 from the repository root.
  Contributions require the repository `CLA.md`.

### Added

- Queue, worker, and administrative APIs implement the Workhorse SQL protocol through pgx,
  `database/sql`, caller-owned transactions, and connection pools.
- The worker supports durable batches, timers, signals, human decisions, child jobs, progress,
  checkpoints, graceful drain, and recovery after a process crash.
- Individual handler panics become recorded attempt failures without stopping the worker. Compiled
  process and external-module coverage verifies graceful signal drain, crash recovery, and the
  public worker API under the race detector.
