# Changelog

Seven published packages are versioned in lockstep and released from one tag. They are
`@workhorse/core`, `@workhorse/drizzle`, `@workhorse/prisma`, `@workhorse/typeorm`,
`@workhorse/kysely`, `@workhorse/dashboard`, and `@workhorse/dashboard-contract`. Each entry states its required
schema version and upgrade steps.

The supported Node.js and PostgreSQL versions, the schema compatibility guarantees, and the release
process are in [`docs/compatibility.md`](docs/compatibility.md).

While the line is `0.x`, any minor release may break compatibility, including bumping the schema
version. Breaking changes are always listed with upgrade steps.

## 0.1.0 — unreleased

First published line. Requires **schema v40**, Node.js **22 or 24**, PostgreSQL **15 through 18**.

### Added

- `@workhorse/core`: durable PostgreSQL job queue with at-least-once delivery, leases and fencing,
  cooperative cancellation, deadlines and execution timeouts, durable waits, progress and
  checkpoints, dead letters and redrive, enqueue idempotency keys, persisted retry policies,
  queue and per-key token-bucket rate limits,
  declarative recurring schedules, versioned payload and result contracts, durable JSON size
  limits, operator redaction, automated history retention, and a durable worker registry.
- `@workhorse/core`: database-authoritative maintenance and retention settings with application
  defaults, operator overrides, per-setting provenance, revert operations, and bounded retention
  impact previews.
- `@workhorse/core`: versioned dashboard read views and a planner-estimate function that isolate
  the dashboard server from private table changes.
- `@workhorse/core`: strict job priority from 0 through 100 across direct, batched, delayed, and
  recurring enqueue, with FIFO order inside each priority and preservation through retries,
  promotion, and redrive.
- `@workhorse/core`: PostgreSQL-owned keyed debounce and throttle windows with structured enqueue
  outcomes, atomic batch and transaction behavior, and shared safe key diagnostics.
- `@workhorse/core`: durable dependency edges keep jobs blocked until every prerequisite satisfies
  its fan-in terminal policy. Bounded lineage and job queries expose those edges, while health
  snapshots and per-queue telemetry report dependency pressure.
- `@workhorse/core`: bounded dependency fan-in with terminal policies, plus fenced child creation
  and result joining through `HandlerContext.runChild` and `HandlerContext.runChildren`.
- `@workhorse/core`: child lineage survives retry and cancellation, redrive keeps the source tree
  immutable, retention avoids parent-child cleanup cycles, and health, metrics, and dashboard
  detail expose bounded orchestration evidence.
- `@workhorse/core`: named signal waits release worker leases, and application or authenticated
  dashboard callers can deliver bounded payloads exactly once at the waiting-state transition.
- `@workhorse/core`: named human waits retain bounded decision context, release worker leases, and
  resume once after an application or authenticated dashboard operator supplies a bounded result.
- `@workhorse/core`: `Worker.handleBatch` for compatible full and linger-bounded partial batches,
  with explicit per-job success or failure outcomes, independent retries, leases, contexts, fencing,
  cancellation, timeout handling, policy accounting, priority order, and bounded batch telemetry.
- `@workhorse/core`: transactionally consistent `Queue.health()` snapshots — one SQL statement
  for every correctness-sensitive value, size-capped history scans with explicit lower-bound
  flags, PostgreSQL estimates separated under `observations`, and caller-overridable health
  budgets producing machine-readable `status.reasons` shared by the `workhorse-health` exit
  code, the benchmark invariants, and the dashboard verdict.
- `@workhorse/core`: the `workhorse` CLI — `init`, `schema install`, `schema status`, `worker`, and
  `dashboard`.
- `@workhorse/core`: notification-assisted worker dispatch through one process-local
  `workhorse_jobs` listener per node-postgres pool, with queue routing, reconnect backoff, and
  jittered bounded polling as the durable fallback.
- `@workhorse/drizzle`: Drizzle ORM provider with caller-owned transactions.
- `@workhorse/prisma`: Prisma ORM provider with caller-owned interactive transactions and optional
  node-postgres notification connections.
- `@workhorse/typeorm`: TypeORM provider with caller-owned `EntityManager` transactions and optional
  node-postgres notification connections.
- `@workhorse/kysely`: Kysely provider with caller-owned transactions and optional node-postgres
  notification connections.
- `@workhorse/dashboard`: the operator dashboard, its framework-neutral `Request`/`Response` host,
  a settings page with audited policy changes, and a Connect-style Node bridge for Express,
  Connect, and Fastify.
- `@workhorse/dashboard-contract`: the type-only standalone server contract shared by the core CLI
  and dashboard package, so both compile against one optional embedding boundary.
- A supported-version contract: `MINIMUM_POSTGRES_MAJOR`, `SUPPORTED_POSTGRES_MAJORS`,
  `MINIMUM_NODE_MAJOR`, `SUPPORTED_NODE_MAJORS`, and `readPostgresSupport` are exported from
  `@workhorse/core`, exercised by the CI matrix, and reported by `workhorse schema status`.
- `@workhorse/core`: `WorkhorseError`, the base class every error Workhorse raises now extends, so
  one `instanceof` test recognizes a rejected call without enumerating seventeen class names.
- `@workhorse/core`: `databaseErrorCode`, `expectOneRow`, and `MissingRowError`. `databaseErrorCode`
  reads a SQLSTATE through the wrappers an ORM adds around a driver error; `expectOneRow` takes the
  single row a statement is defined to return and throws `MissingRowError` naming that statement
  when the result is empty.
- `@workhorse/core`: the shared adapter core an ORM provider is built from — `QueryError`,
  `rowsToQueryResult`, `attachNotificationPool`, `createProviderQueryable`, and
  `createProviderAdapter`, alongside the existing `createWorkhorseAdapter`. A provider now supplies
  only how its ORM runs a statement; error translation, the result shape, the notification
  capability, and the transaction wiring are owned once. What an adapter must guarantee is written
  down in [`docs/architecture.md`](docs/architecture.md).
- npm provenance on every published tarball.

### Changed

The line is unreleased, so these changes precede first publication and no deployment upgrades
through them. They are recorded because the pre-release dashboards and ADRs in this repository
name the retired instruments.

- `@workhorse/core`: metric instruments are created on first emission and re-created when the
  global meter provider changes. An application may now install its OpenTelemetry SDK after
  importing `@workhorse/core` and still receive metrics; previously every instrument bound to
  whichever provider existed at import, so a later SDK silently received nothing.
  [ADR 0024](docs/decisions/0024-metrics-instrument-lifecycle.md) records the measurement behind
  this.
- `@workhorse/core`: two instrumentation modules emitted separately on the same lifecycle events.
  They are now one. `src/metrics.ts` is deleted; `src/telemetry.ts` owns every instrument, and
  `WorkhorseMetricsObserver` moves to `src/metrics-observer.ts`. The package export is unchanged —
  `WorkhorseMetricsObserver` is still exported from `@workhorse/core` — and no other export from
  either module was public.
- `@workhorse/core`: `JobValueSizeLimitError` extends `WorkhorseError` rather than `RangeError`.
  Code testing `instanceof RangeError` on it must test `instanceof JobValueSizeLimitError` or
  `instanceof WorkhorseError` instead. Its name, message, and fields are unchanged.
- `@workhorse/core`: enqueue and redrive idempotency conflicts are now recognized through an ORM's
  error wrapper rather than only on the error object the driver threw. A conflict raised inside a
  Drizzle, Prisma, TypeORM, or Kysely transaction reaches the caller as
  `EnqueueIdempotencyConflictError` or `RedriveIdempotencyConflictError` instead of the adapter's
  own query error.
- `@workhorse/core`: the duplicated instruments are retired in favor of one name per event.
  `workhorse.job.enqueued` becomes `workhorse.jobs.enqueued`, `workhorse.job.claimed` becomes
  `workhorse.jobs.claimed`, `workhorse.lease.recovered` becomes `workhorse.leases.expired`,
  `workhorse.job.cancellation` becomes `workhorse.jobs.cancellation`, `workhorse.job.redrive`
  becomes `workhorse.jobs.redrive`, and `workhorse.job.count` becomes `workhorse.jobs.count`.
- `@workhorse/core`: `workhorse.job.execution` becomes `workhorse.handler.executions`, and its
  `workhorse.job.outcome` attribute becomes `workhorse.handler.outcome`. The
  `workhorse.job.execution.duration` histogram is removed; `workhorse.handler.duration` now carries
  the outcome attribute and times the same activation in **milliseconds rather than seconds**.
  Dashboards and alerts that read the retired histogram need both the new name and the new unit.

- `@workhorse/dashboard`: `DashboardClient` is inferred from the router that serves it rather than
  written out a second time by hand. The method names and shapes are the ones the dashboard already
  spoke, so a host built against the packaged client needs no change; a host that answered a
  slightly different shape now hears about it from the type-checker. Filter arguments that were
  typed as `string` are now the vocabulary the router accepts — `events({ types })` takes event
  types and attempt outcomes, exported as `DashboardEventTypeFilter`. Adding a procedure is an edit
  to the router alone.
- `@workhorse/dashboard`: the server read model uses core-owned versioned views and functions. Its
  core peer range now permits independent patch releases within the same minor line.

### Upgrade notes

There is no prior published release, so there is nothing to upgrade from. For the shape future
entries take:

- **Schema version.** `installSchema` is clean-database only and refuses to touch an existing
  versioned schema. A release that bumps the schema version is installed into a fresh schema, with
  the previous one drained rather than migrated in place.
- **Runtime and schema must match exactly.** Deploy so that no process runs against a schema version
  it was not built for; a mixed fleet mid-deploy is not supported.
- **PostgreSQL below the minimum is refused at installation.** `installSchema` fails with the
  server's reported version instead of failing part way through `sql/schema.sql`.
