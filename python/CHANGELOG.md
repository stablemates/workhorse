# Python changelog

`stablemates-workhorse` versions and release notes live here because the Python distribution
releases independently from the TypeScript packages and the Go module.

Workhorse is a public beta. Any 0.x minor release may break compatibility, including the schema.
There is no upgrade path between 0.x releases; ordered migrations begin at 1.0.0.

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

### Upgrade notes

- **Schema version.** `0.1.0` requires the same schema version 1 baseline that `0.1.0b3` required,
  so a database the beta installed passes `assert_schema_compatible` as it is. The `0.x` rule still
  applies: there is no upgrade path between `0.x` releases, so when a release changes the schema,
  recreate the database and install the new baseline with
  `npx --package @stablemates/workhorse workhorse schema install`.

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
