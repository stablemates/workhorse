# ADR 0086: Separate Rust enqueue preparation from mutable transports

- **Status:** Accepted
- **Date:** 2026-10-02
- **Related:** [ADR 0074](0074-shape-the-rust-sdk-as-one-python-shaped-crate.md),
  [ADR 0079](0079-govern-the-rust-api-as-an-eighth-surface.md),
  [ADR 0083](0083-run-each-language-suite-once-per-change.md)
- **Issue:** SM-1123

## Context

Applications must enqueue through their own transaction to commit business writes and tasks together.
The sealed Rust `Executor` works for tokio-postgres and deadpool-postgres.
Its shared references, binds, rows and errors describe those drivers, not every PostgreSQL driver.
Unsealing it would leave those restrictions in place.
In particular, a SQLx transaction exposes its connection through a mutable borrow.
An adapter cannot satisfy that interface by promising a different connection.
Separate enqueue implementations would duplicate validation, contract refresh and protocol calls.

## Decision

### Keep the shipped runtime interface

`Executor` remains sealed, with its existing implementations, bounds and signatures.
`Queue`, `Admin`, durable contexts and workers retain their public interfaces.
Workers still require a deadpool-postgres pool and the ADR 0074 connection model.
This decision supplements that record for enqueue only; it does not replace the runtime driver.

### Give preparation one owner

The additive `EnqueueClient` owns preparation, option validation, compatibility and contract caches.
It also owns payload validation, bounded contract refresh, result validation and request ordering.
Its operations are `assert_compatible`, `enqueue`, `enqueue_many` and `sync_contracts`.
`Queue` delegates those operations through a private tokio/deadpool transport.
The existing compatibility and contract loaders use the same shared readers.
There is no second protocol implementation or driver-specific preparation path.

Each client belongs to one logical database and schema.
Successful compatibility checks and refusals are cached; transport errors are not.
Contract caching retains the shipped behavior, including refreshing a mismatch before one retry.
Clients must not share caches across unrelated databases.
After rolling back a contract change, callers must use a fresh client or synchronize contracts again.

### Borrow the transport, not its transaction lifecycle

`EnqueueTransport::query(&mut self, EnqueueQuery)` returns a `Send` future with named, typed rows.
The trait requires `Send`, but not `Sync`, transaction ownership, or a static lifetime.
An adapter can therefore exclusively borrow a caller-owned transaction.
Generic dispatch avoids boxed futures and does not promise a trait-object interface.
`EnqueueClient` borrows the adapter for each operation.

The interface offers no acquire, begin, commit, rollback, savepoint or close operation.
Implementations must execute on the exact connection supplied by the caller.
They must not fall back to a pool or spawn a detached query.
The caller creates and resolves transactions and savepoints.
Dropping an operation releases the Rust borrow and leaves an unfinished compatibility check uncached.
It does not promise server-side cancellation or recovery from an aborted transaction.
Those behaviors depend on the driver; the caller must cancel, recover or roll back as appropriate.
The existing pool executor still discards a connection when its statement future is dropped.

### Keep SQL and bind types in the core

`EnqueueQuery` has a private constructor.
It exposes generated catalogue SQL, ordered `EnqueueBind` values and required `EnqueueColumn` metadata.
Adapters execute that SQL instead of reconstructing a protocol call.
The current operations bind JSONB documents and nullable text values.
`EnqueueBind::Json` and `EnqueueBind::Text` distinguish those types, including a null text value.
The core serializes task timestamps inside JSONB in the existing UTC format.
No native timestamp bind or driver timestamp compatibility is implied.

### Validate named, typed results centrally

`EnqueueRow` maps column names to `EnqueueValue`.
Supported values are SQL null, integer, text, text array, JSONB and UUID.
`EnqueueColumn` declares each required column's name, type and nullability.
Adapters decode native values without coercing strings into integers or UUIDs.
The core checks required columns and types, then checks outcomes and ordinals.
A batch must return every request exactly once, with unique ordinals within the request range.
The core restores input order even when a transport returns rows in another order.
Unknown outcomes, missing fields and invalid reasons fail closed.
A contract mismatch is a singleton with ordinal zero, a null task ID and structured task types.
It is never a successful enqueue result.

### Preserve structured errors

`Error::Database` adds optional SQLSTATE and DETAIL plus the original driver error as its source.
`Error::database` constructs it from structured driver diagnostics.
The shared translator maps `P1001`, `P1003`, `P1005` and `P1007` to existing typed enqueue variants.
Malformed diagnostic JSON retains the shipped sanitized defaults.
Unrecognized errors preserve SQLSTATE, DETAIL and the source chain.
Human-readable message parsing is not an alternative.
The shipped tokio transport still returns `Error::Postgres` for unrecognized errors.
Its existing driver source and `sqlstate()` behavior remain intact.
The new variant is additive to the already non-exhaustive `Error` enum.

## Verification and limits

Existing enqueue and protocol conformance suites exercise the delegated tokio/deadpool path.
An external test-only adapter exclusively borrows a transaction and is deliberately non-`Sync`.
Compile assertions require its enqueue futures to remain `Send` without static transaction ownership.
PostgreSQL tests prove backend and transaction identity, observer invisibility, joint outcomes and savepoints.
They also exercise contract refresh, structured errors and caller-controlled cancellation.
Scripted transports test malformed rows, ordered batches, compatibility caching and bounded retries.

The governed snapshot is additive: no existing public item or feature disappears.
No dependency, crate, feature or CI lane is added.
The existing all-features Rust lane collects the tests once, preserving ADR 0083.
This foundation ships no SQLx, SeaORM or Diesel adapter.
Their respective issues must prove actual binds, decoding, errors, cancellation and ownership.
A driver without supported SQLSTATE access cannot claim typed-error parity.
No catalog transport-support entry follows from a test-only adapter.

## Alternatives rejected

- Unseal `Executor`: it retains driver-specific types and incompatible borrowing.
- Replace every runtime driver: it widens scope and breaks the governed shipped surface.
- Export preparation alone: adapters must duplicate compatibility, contracts, retries and decoding.
- Acquire a second connection: it breaks joint commit and rollback.
- Parse error messages: it cannot preserve structured categories reliably.
