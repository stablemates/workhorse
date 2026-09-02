# Go changelog

`github.com/stablemates/workhorse/go` versions and release notes live here because the Go module
releases independently from the TypeScript packages and the Python distribution.

Workhorse is a public beta. Any 0.x minor release may break compatibility, including the schema.
There is no upgrade path between 0.x releases; ordered migrations begin at 1.0.0.

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
