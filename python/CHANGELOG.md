# Python changelog

`stablemates-workhorse` versions and release notes live here because the Python distribution
releases independently from the TypeScript packages and the Go module.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## 0.1.0 — 2026-09-14

Published to PyPI from one source commit shared with the npm packages and the Go module, tagged
`python/v0.1.0`. This is the first version without a prerelease suffix
([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)). The distribution
stays a public beta on the `0.x` line, and its classifier stays `Development Status :: 4 - Beta`.

Requires **schema v1** and Python **3.12** or newer.

### Added

- `workhorse.compatibility` publishes the startup schema check that the installation page tells every
  runtime to make. `assert_schema_compatible(connection)` takes a Psycopg connection, and
  `assert_schema_compatible_psycopg` and `assert_schema_compatible_asyncpg` name their asynchronous
  driver, mirroring `AsyncQueue.from_psycopg` and `AsyncQueue.from_asyncpg`.

### Fixed

- `Worker.handle_batch` groups and orders members by the worker's claim order. Each job runs on its
  own handler thread, so members previously reached the coordinator in thread scheduling order, and
  two equal-priority jobs could appear in a batch in either order. `AsyncWorker.handle_batch`
  shares the coordinator and gains the same guarantee. This change landed after `0.1.0b3` published
  and was listed under that entry in error.

### Changed

- The README states the unpinned install command and the schema install step, which the TypeScript
  CLI owns.
- The dashboard backend's run-now action calls the audited `workhorse.run_task_now_v1` instead of
  `workhorse.dashboard_run_task_now_v1`, which is removed from the schema. The action now records
  the authenticated actor, the reason, and the request identity in its `promoted` event, matching
  the TypeScript dashboard server.
- **Type names.** Two exported type aliases take the names the TypeScript and Go SDKs already share:
  `workhorse.types.TerminalPolicy` becomes `DependencyTerminalPolicy` and
  `workhorse.types.NonReplaceableReason` becomes `EnqueueNonReplaceableReason`. Both new names are
  exported from `workhorse`, which neither old name was. Each old name stays in `workhorse.types` as
  a deprecated alias of its replacement, so no code has to change on this release. The aliases are
  removed in `1.0.0`.

### Upgrade notes

- **Schema version.** `0.1.0` stays at schema version 1, but its baseline is not the one the last
  beta installed: `workhorse.valid_tags` was renamed `workhorse.valid_tags_v1` and
  `workhorse.dashboard_run_task_now_v1` was removed. A database installed by any beta reports
  version 1 and passes the compatibility check, yet holds the old function names. You must recreate the database and
  install the new baseline with
  `npx --package @stablemates/workhorse@0.1.0 workhorse schema install`.
  This is the last release that asks for a recreation: from `0.1.0` the schema is frozen as the
  migration baseline, and later releases upgrade a database in place.

## 0.1.0b3 — 2026-09-01

Published to PyPI from commit `663c526805746786f12b3be3e151e8ce06c80057`, tagged
`python/v0.1.0b3`.

### Fixed

- The fix-forward release uploads PEP 740 attestations with its wheel and source distribution.
  The package behavior is unchanged from `0.1.0b1`.

## 0.1.0b2 — 2026-08-31

Published to PyPI from commit `0c15212cc5510501bbc9b74bd372fa480e77a1ff`, tagged
`python/v0.1.0b2`.

### Fixed

- The release workflow generated PEP 740 attestations but omitted them from the PyPI upload.
  The package behavior is unchanged from `0.1.0b1`.

## 0.1.0b1 — 2026-08-31

Published to PyPI from commit `6769c768d19861fb8c5c7ea3764e8d5abc62fcf4`, tagged
`python/v0.1.0b1`.

### Changed

- The distribution uses the Apache License, Version 2.0. Contributions require the
  repository `CLA.md`.

### Added

- Synchronous and asynchronous queue clients, workers, administrative clients, and an embedded
  WSGI dashboard implement the Workhorse SQL protocol through Psycopg and asyncpg.
- Handlers can use durable batches, timers, signals, human decisions, child jobs, progress, and
  checkpoints with the same fenced ownership rules as the TypeScript runtime.
- Synchronous handlers can suspend through named signal and human-decision waits, then replay the
  retained external value in the same logical attempt. Synchronous and asynchronous queue clients
  deliver attributed values with idempotency and typed conflict errors.
- `run_worker_process` adds bounded `SIGINT` and `SIGTERM` drain handling for the synchronous
  worker. A second signal exits with its conventional code, while an expired deadline exits with
  failure so PostgreSQL can recover active leases.
- Synchronous `Worker.handle_batch` delivery supports queue-isolated full and partial groups,
  explicit per-member outcomes, independent fences and retries, and durable batch evidence.
- Typed synchronous Psycopg and asynchronous Psycopg or asyncpg enqueue clients support delayed and
  recurring work, priority, atomic batches, idempotency, debounce, throttle, dependencies,
  caller-owned transactions, compatibility refusal, and shared SQL conformance.
