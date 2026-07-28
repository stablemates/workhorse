# Demo findings and follow-up gaps

The Workhorse demo is a vertical slice of the project: transactional enqueue, worker lifecycle, retry
behavior, recurring scheduling, and operator inspection. It uses Hono and Drizzle to prove the supported
integrations in a realistic application, but those libraries are implementation details rather than the
subject of the demo. This document records what the implementation proved, what it forced the repository
to fix, and which gaps remain.

## Validation performed

The demo now proves these paths against PostgreSQL rather than mocks:

- a Hono request inserts an application order and its Workhorse job in the same Drizzle transaction;
- a Hono-managed worker processes the job and shuts down through the integration lifecycle;
- an intentional handler error records a `retry` attempt and succeeds on attempt 2;
- `PgCronScheduler` synchronizes and fires a recurring definition with occurrence deduplication;
- the typed oRPC snapshot exposes queues, jobs, schedules, workers, failures, and database health;
- the dashboard can be omitted without changing core queue behavior;
- `pnpm demo` recreates only a purpose-guarded demo database, builds the workspace, and serves the app.

## Gaps fixed while building the demo

| Area        | Finding                                                                                                       | Resolution                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| DX          | Reusing `workhorse_dev` made the documented command fail when that database contained an old or mixed schema. | Added the suffix-guarded `workhorse_demo` database and made `pnpm demo` recreate only that disposable target. |
| Packaging   | Starting the source demo without building workspace package outputs depended on stale local `dist` files.     | Made `pnpm demo` build core, integrations, and the demo before startup.                                       |
| Integration | A dashboard coupled to process startup would make the queue unusable in API-only deployments.                 | Added `{ dashboard: false }` and an integration test that proves workers and Hono routes remain functional.   |
| Correctness | Transactional enqueue was documented but not demonstrated through an ORM-owned request transaction.           | Added a test comparing PostgreSQL `xmin` for the application row and accepted job.                            |
| Operations  | Browser polling would repeatedly read queue tables even when nothing changed.                                 | Added coalesced SSE invalidation hints backed by local events, PostgreSQL `LISTEN`, and a bounded fallback.   |

## Remaining API gaps

### A1. No supported operational query surface

The dashboard must issue bounded SQL directly against `workhorse.job`, `job_runtime`, `job_outcome`,
`attempt_history`, `schedule_definition`, and `schedule_occurrence`. Those relations are protocol
internals, so a schema evolution can break an otherwise type-safe dashboard.

**Needed:** a typed, cursor-based read API for job lists, queue pressure, lifecycle timelines, schedule
status, worker observations, failures, and health. Keep payload inclusion bounded and support redaction.
This is tracked primarily by **P2-01 Query and listing API** and **P0-06 Consistent operational snapshots**.

### A2. Retry configuration is a callback, not a durable policy

The demo uses `retryDelayMs: attempt => attempt * 100`. It is easy to start with, but the selected policy
and its inputs are not named or persisted, and callers must implement overflow, jitter, and cap behavior.

**Needed:** built-in fixed, exponential, and decorrelated-jitter policies with persisted inputs and
bounded validation. This is tracked by **P0-05 Built-in retry policies**.

### A3. Framework integrations do not own schedule deployment

The Drizzle adapter can enqueue through a caller-owned transaction, but recurring schedules still need
separate raw `pg` target and metadata pools plus an explicit `PgCronScheduler.sync()` call. Hono has
worker lifecycle hooks but no deploy-time schedule synchronization hook.

**Needed:** a framework-neutral deploy lifecycle abstraction, plus Drizzle and Hono helpers that retain
clear pool ownership and still expose the full `PgCronScheduler` result. This does not block the current
API, but should be designed before adding more framework integrations.

### A4. Worker identity is observational only

The worker view infers active workers from leases and recent workers from attempt history. There is no
registry, start time, declared concurrency, build version, graceful-stop state, or authoritative liveness
record.

**Needed:** decide whether production telemetry is sufficient or whether Workhorse needs a bounded,
expiring worker registry. Any registry must avoid turning worker heartbeats into unbounded write load.
This decision belongs with **P0-02 Production telemetry** and **P0-03 Configurable worker concurrency**.

### A5. No audited operator mutation contract exists yet

The dashboard correctly exposes no cancellation, redrive, pause, resume, or schedule-edit controls.
There is therefore no stable mutation API, authorization seam, idempotency contract, or audit record.

**Needed:** add mutations only after their queue transitions exist, and require actor, reason, request ID,
timestamp, target, and before/after state. This is covered by **P1-02 Cancellation**, **P1-04 Dead-letter
views and redrive**, and the later operator tooling work.

## Remaining packaging gaps

### P1. The demo validates workspace source, not a consumer installation

The app imports workspace packages and the one-command path builds local outputs. That proves repository
integration but not registry metadata, exported files, peer-dependency behavior, or installation from
published tarballs.

**Needed:** run the same application shape against packed artifacts in an isolated project, then include
that path in the release compatibility matrix. This is tracked by **P0-07 Release and compatibility
matrix**. Existing package tests cover important pieces, but not the complete dashboard application.

### P2. Dashboard asset serving assumes a package working directory

`serveStatic({ root: "./dist" })` is simple for the demo, but production launchers, containers, and
bundlers may use another current directory. The dashboard also has no standalone package or asset
manifest contract.

**Needed:** resolve assets relative to the installed module or publish a dedicated dashboard package
with an explicit mounting API. Keep the dashboard optional and avoid adding React to core dependencies.

## Remaining documentation gaps

### D1. Schema upgrades are not documented because they do not exist

`installSchema()` intentionally rejects non-v2 or mixed installations. The live demo exposed how quickly
that clean-install boundary becomes user-visible.

**Needed:** ordered transactional migrations, independent schema and protocol versions, dry-run/status
commands, rollback guidance, and upgrade tests. This is tracked by **P2-07 Schema migration framework**.

### D2. pg_cron remains the highest-friction prerequisite

Recurring jobs require a second metadata connection, matching deployment roles, grants, target
authentication, and cluster-level configuration. The base demo remains portable by making recurrence
optional, but that can hide deployment failures until scheduling is enabled.

**Needed:** keep `pnpm pg-cron:check` prominent, add provider-specific verified recipes over time, and
surface preflight failures with actionable remediation before schedule synchronization.

### D3. Operational semantics need task-oriented guides

The architecture references are comprehensive, but application developers still need short guides for
idempotent handlers, retry exhaustion, lease loss, schedule deployment, transaction ownership, and
reading immutable attempt history.

**Needed:** derive task-oriented guides from the working demo and link each guide to the authoritative
protocol documentation rather than duplicating invariants.

## Remaining developer-experience gaps

### X1. Dashboard refresh is application plumbing

The demo owns a dedicated PostgreSQL client, `LISTEN` reconnect/error behavior, an in-process refresh
hub, SSE serialization, coalescing, and a safety timer. PostgreSQL notifications are hints, but Workhorse
does not expose a reusable invalidation stream or complete notification contract.

**Needed:** after **P0-04 Notification-assisted dispatch**, consider a reusable hint subscription API
that handles reconnect and coalescing without claiming to be an authoritative event stream.

### X2. Startup failure cleanup is manual

The executable creates multiple pools and a notification client before server startup. Graceful shutdown
is centralized after startup, but failures during schema installation, schedule synchronization, or
listener setup still rely on process exit to release resources.

**Needed:** a small acquisition/cleanup helper or integration lifecycle that disposes partially acquired
resources in reverse order. Ownership must remain explicit so caller-owned pools are never closed.

### X3. Job detail inspection is incomplete

The dashboard shows a bounded recent-job row and current attempt count, but it does not expose a selected
job's event timeline, immutable attempts, payload/result redaction state, or redrive lineage.

**Needed:** implement this on the future P2-01 query API rather than adding more direct SQL to the demo.

## Priority conclusion

The demo validates the current write path and lifecycle semantics. The highest-leverage next production
work remains the existing P0 sequence: retention, telemetry, concurrency, notification-assisted dispatch,
built-in retry policies, consistent snapshots, and release compatibility. The demo specifically raises
the importance of a stable operational read API and schema migrations before the dashboard can become a
separately supported product surface.
