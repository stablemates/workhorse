# Changelog

All four published packages — `@workhorse/core`, `@workhorse/drizzle`, `@workhorse/hono`, and
`@workhorse/dashboard` — are versioned in lockstep and released from one tag, so they share this
file. Each entry states the schema version it requires and the steps needed to move to it.

The supported Node.js and PostgreSQL versions, the schema compatibility guarantees, and the release
process are in [`docs/compatibility.md`](docs/compatibility.md).

While the line is `0.x`, any minor release may break compatibility, including bumping the schema
version. Breaking changes are always listed with upgrade steps.

## 0.1.0 — unreleased

First published line. Requires **schema v20**, Node.js **22 or 24**, PostgreSQL **15 through 18**.

### Added

- `@workhorse/core`: durable PostgreSQL job queue with at-least-once delivery, leases and fencing,
  cooperative cancellation, deadlines and execution timeouts, durable waits, progress and
  checkpoints, dead letters and redrive, enqueue idempotency keys, persisted retry policies,
  declarative recurring schedules, versioned payload and result contracts, durable JSON size
  limits, operator redaction, automated history retention, and a durable worker registry.
- `@workhorse/core`: the `workhorse` CLI — `init`, `schema install`, `schema status`, `worker`, and
  `dashboard`.
- `@workhorse/drizzle`: Drizzle ORM provider with caller-owned transactions.
- `@workhorse/hono`: Hono lifecycle integration and dashboard route registration.
- `@workhorse/dashboard`: the operator dashboard, its framework-neutral `Request`/`Response` host,
  and a Connect-style Node bridge for Express, Connect, and Fastify.
- A supported-version contract: `MINIMUM_POSTGRES_MAJOR`, `SUPPORTED_POSTGRES_MAJORS`,
  `MINIMUM_NODE_MAJOR`, `SUPPORTED_NODE_MAJORS`, and `readPostgresSupport` are exported from
  `@workhorse/core`, exercised by the CI matrix, and reported by `workhorse schema status`.
- npm provenance on every published tarball.

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
