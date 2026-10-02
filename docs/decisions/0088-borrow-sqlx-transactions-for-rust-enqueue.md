# ADR 0088: Borrow SQLx transactions for Rust enqueue

- **Status:** Accepted
- **Date:** 2026-10-02
- **Related:** [ADR 0074](0074-shape-the-rust-sdk-as-one-python-shaped-crate.md),
  [ADR 0079](0079-govern-the-rust-api-as-an-eighth-surface.md),
  [ADR 0083](0083-run-each-language-suite-once-per-change.md),
  [ADR 0086](0086-separate-rust-enqueue-preparation-from-mutable-transports.md)
- **Issue:** SM-1124

## Context

SQLx applications need business writes and tasks to commit through the same PostgreSQL transaction.
ADR 0086 centralizes enqueue preparation behind a mutable transport without changing worker drivers.
SQLx implements query execution on the mutable connection behind its transaction.
A second connection cannot provide joint commit and rollback.
ADR 0074's historical feature list has no optional SQLx transport.

## Decision

Add the optional `sqlx` feature to the existing `workhorse` crate, supplementing ADR 0074's feature list.
Pin released SQLx 0.8.6, whose PostgreSQL transaction and structured diagnostics are verified by the maintained fixture.
SQLx 0.9.0 requires Rust 1.94.0; the repository pins Rust 1.89.0.
Disable SQLx defaults and enable only PostgreSQL, JSON, UUID and Tokio support.
The application selects TLS features; the transport chooses no TLS backend.
Re-export the matching dependency as `workhorse::sqlx`.

Implement `EnqueueTransport` directly for SQLx `Transaction<'_, Postgres>`.
Callers pass an exclusive mutable borrow to `EnqueueClient`.
The adapter executes generated SQL through `&mut **transaction` and decodes native values into the shared row representation.
It preserves `PgDatabaseError` SQLSTATE, DETAIL and original sources.
The shared client remains the only owner of validation, compatibility, contract refresh, preparation and result semantics.
Timestamps remain UTC strings inside its JSONB requests; the transport adds no native timestamp bind.

The transport has no pool and owns no transaction lifecycle.
SQLx's transaction and connection types do not implement the sealed runtime `Executor`.
Workers, administration, durable contexts and dashboard access retain tokio-postgres/deadpool-postgres.
No SeaORM or Diesel transport follows from this decision.

Dropping an SQLx operation releases its Rust borrow but does not cancel the server statement.
If the outcome is uncertain, the caller rolls back rather than treating the dropped future as failure evidence.
After server cancellation, the caller rolls back the transaction or its savepoint before continuing.
After rolling back contract changes, callers recreate the enqueue client or synchronize the actual contracts again.

## Verification

Real PostgreSQL tests record backend PID and transaction ID from application writes and an enqueue trigger.
An independent observer proves pre-commit invisibility, joint commit/rollback and nested savepoint ownership.
The fixture covers JSONB, native UUIDs, nullable text, timestamp serialization, contracts and ordered batch replay.
It checks native decoder refusals, structured errors and server cancellation versus future dropping.
Compile proofs require borrowed `Send` futures and reject overlapping mutable access and stale transaction use.
The package consumer tests the optional transport through the unpacked archive, not checkout sources.
The existing all-features CI suite runs these tests once, preserving ADR 0083.

## Alternatives rejected

- A second connection cannot join the caller's commit.
- A separate crate adds no missing seam and complicates feature and version alignment.
- Adapting `Queue` requires redesigning its sealed runtime executor beyond enqueue scope.
- Copying preparation or parsing messages would bypass the shared contract and error rules.

## Sources

- [Released SQLx 0.8.6 transaction API](https://docs.rs/sqlx/0.8.6/sqlx/struct.Transaction.html).
- [SQLx 0.8.6 feature definitions](https://github.com/launchbadge/sqlx/blob/v0.8.6/Cargo.toml).
- [SQLx 0.8.6 PostgreSQL diagnostics](https://github.com/launchbadge/sqlx/blob/v0.8.6/sqlx-postgres/src/error.rs).
- [SQLx 0.9.0 Rust requirement](https://github.com/launchbadge/sqlx/blob/v0.9.0/Cargo.toml).
