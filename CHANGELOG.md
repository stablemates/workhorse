# Changelog

Six published packages are versioned in lockstep and released from one tag. They are
`@workhorse/core`, `@workhorse/drizzle`, `@workhorse/prisma`, `@workhorse/typeorm`,
`@workhorse/kysely`, and `@workhorse/dashboard`. Each entry states its required
schema version and upgrade steps.

The supported Node.js and PostgreSQL versions, the schema compatibility guarantees, and the release
process are in [`docs/compatibility.md`](docs/compatibility.md).

While the line is `0.x`, any minor release may break compatibility, including bumping the schema
version. Breaking changes are always listed with upgrade steps.

## 0.1.0 — unreleased

First published line. Requires **schema v23**, Node.js **22 or 24**, PostgreSQL **15 through 18**.

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
- A supported-version contract: `MINIMUM_POSTGRES_MAJOR`, `SUPPORTED_POSTGRES_MAJORS`,
  `MINIMUM_NODE_MAJOR`, `SUPPORTED_NODE_MAJORS`, and `readPostgresSupport` are exported from
  `@workhorse/core`, exercised by the CI matrix, and reported by `workhorse schema status`.
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
