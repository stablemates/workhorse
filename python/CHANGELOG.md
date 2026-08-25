# Python changelog

`stablemates-workhorse` versions and release notes live here because the Python distribution
releases independently from the TypeScript packages and the Go module.

## 0.1.0a1 — unreleased

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
