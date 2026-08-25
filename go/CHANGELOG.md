# Go changelog

`github.com/stablemates/workhorse/go` versions and release notes live here because the Go module
releases independently from the TypeScript packages and the Python distribution.

## 0.1.0 — unreleased

### Added

- Queue, worker, and administrative APIs implement the Workhorse SQL protocol through pgx,
  `database/sql`, caller-owned transactions, and connection pools.
- The worker supports durable batches, timers, signals, human decisions, child jobs, progress,
  checkpoints, graceful drain, and recovery after a process crash.
- Individual handler panics become recorded attempt failures without stopping the worker. Compiled
  process and external-module coverage verifies graceful signal drain, crash recovery, and the
  public worker API under the race detector.
