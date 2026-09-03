# Changelog

This changelog covers nine published packages on npm. They are versioned in lockstep and released
from one tag:
`@stablemates/workhorse`, `@stablemates/workhorse-drizzle`, `@stablemates/workhorse-prisma`, `@stablemates/workhorse-typeorm`,
`@stablemates/workhorse-kysely`, `@stablemates/workhorse-otel`, `@stablemates/workhorse-dashboard`,
`@stablemates/workhorse-dashboard-server`, and `@stablemates/workhorse-dashboard-contract`. The Python distribution and Go module release
independently, so their notes live in [`python/CHANGELOG.md`](python/CHANGELOG.md) and
[`go/CHANGELOG.md`](go/CHANGELOG.md). Each entry states its required schema version and upgrade steps.

The supported Node.js and PostgreSQL versions, the schema compatibility guarantees, and the release
process are in [`docs/compatibility.md`](docs/compatibility.md).

Workhorse is a public beta. While the line is `0.x`, any minor release may change behaviour. From
`0.1.0` the schema upgrades in place: every release ships ordered, immutable migrations, and inside
a major line a migration only adds. Breaking changes are always listed with upgrade steps.

## 0.1.0 — 2026-09-14

Published to npm from one source commit shared with the Python distribution and the Go module,
tagged `v0.1.0`. This is the first version without a prerelease suffix
([ADR 0050](docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)). Workhorse stays a
public beta on the `0.x` line.

Requires **schema v1**, Node.js **22** or newer, PostgreSQL **15** or newer. CI exercises Node.js 22
and 24 and PostgreSQL 15 through 18.

### Changed

- **The TypeScript policy reads are renamed to match Python and Go.** `Queue.concurrencyPolicies`
  becomes `Queue.listConcurrencyPolicies`, `Queue.rateLimitPolicies` becomes
  `Queue.listRateLimitPolicies`, and `Admin.concurrencyPolicies` becomes
  `Admin.listConcurrencyPolicies`. Every language now names the read the same way as
  `list_concurrency_policies` and `ListConcurrencyPolicies` already did. The old names remain as
  `@deprecated` aliases that call the new methods for the rest of the `0.x` line, so no call site
  breaks now; they are removed in `1.0.0`.
- **TypeScript type names.** Ten exported types take the names the Python and Go SDKs already
  share: `EnqueueIdempotency` becomes `Idempotency`, `EnqueueDebounce` becomes `Debounce`,
  `EnqueueThrottle` becomes `Throttle`, `JobDependencies` becomes `Dependencies`,
  `ScheduleJobDefinition` becomes `ScheduledJob`, `SendSignalResult` becomes
  `SignalDeliveryResult`, `SendSignalStatus` becomes `SignalDeliveryStatus`,
  `CompleteHumanWaitResult` becomes `HumanWaitCompletionResult`, `CompleteHumanWaitStatus` becomes
  `HumanWaitCompletionStatus`, and `ExternalWaitListOptions` becomes `ExternalWaitQuery`. Every old
  name is still exported as a deprecated alias of its replacement, so no code has to change on this
  release. The aliases are removed in `1.0.0`.
- **Dashboard contract.** Every shared wire type in `dashboard/v1/procedures.json` now carries the
  `Dashboard` prefix. Eight `$defs` entries are renamed: `CancelStatus`, `SignalDeliveryStatus`,
  `HumanWaitCompletionStatus`, `Json`, `QueueHealthReason`, `QueueHealthReasonCode`,
  `RetentionPolicyImpact`, and `MaintenanceLoopCadences` gain the prefix, and the generated Go and
  Python bindings rename their types to match. Those types are core types that reach a dashboard
  response, so without the prefix `go/dashboard` declared a second `CancelStatus` beside `go`'s own
  and `workhorse.dashboard_v1` declared a second one beside `workhorse.types`. Generated bindings
  carry no aliases, so a Go or Python caller that names one of the eight updates the name.
  `@stablemates/workhorse-dashboard-server/wire` keeps `MaintenanceLoopCadences` as a deprecated
  alias of `DashboardMaintenanceLoopCadences` for the rest of the `0.x` line. No request or
  response payload changes, so an HTTP client of the dashboard is unaffected and
  `dashboard/v1/conformance.json` and `dashboard/v1/manifest.json` are unchanged.
- All nine packages move from `0.1.0-beta.2` to `0.1.0`, and every peer range on
  `@stablemates/workhorse` becomes `>=0.1.0 <0.2.0`. A later prerelease of this line is a
  `0.2.0-beta.N`; a published version is never reissued.
- Install commands name no version. `support.json` states each command once, every README and
  documentation page copies it, and a test fails any surface that disagrees.
- **The schema command is the one exception, and it now has two forms.** A TypeScript project runs
  `npm exec --no -- workhorse schema install`, which resolves the binary from its own
  `node_modules` and never installs anything, so the schema tool and the application match by
  construction. A Python or Go project has no `node_modules` and pins instead:
  `npx --package @stablemates/workhorse@0.1.0 workhorse schema install`, at the version of the SDK
  it depends on. A schema tool behind the application leaves a schema the application refuses to
  start against, so the pin is a deployment requirement rather than a preference. A test keeps the
  pinned literal equal to the published version.
- The installation page links to the compatibility matrix instead of restating the supported
  floors, and documents the verification step: run `workhorse schema status --json` after migrating
  and before the first process from the new release starts, and fail the deploy on a non-zero exit.
- Every GitHub release attaches `schema.sql`, so a Python or Go developer with no Node.js toolchain
  can create a development database with `psql -f schema.sql`. That path carries none of the CLI's
  guards and is documented for development only.
- The documentation site publishes one agent-facing layer. `/docs/for-ai-agents` is the entry point
  that every landing surface and `llms.txt` name, every documentation page has a Markdown twin at
  its URL plus `.md` served as `text/markdown`, and `llms-full.txt` carries the whole corpus.
- `SECURITY.md` names the private reporting channel and states that only the latest `0.x` minor of
  each package line receives fixes.
- **Ordered migrations start here.** The `0.1.0` clean-install artifact is frozen as
  `sql/releases/0001.sql`, and from `0.2.0` every schema change ships as an ordered, immutable step.
  Inside a major line a migration only adds, so a client accepts any installed schema at or above
  the version it was built against, and a deployment upgrades in place while its running processes
  keep working. Run `migrateSchema` from a deployment step before processes from the new release
  start; nothing migrates automatically.
  ([ADR 0053](docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md))
- `workhorse schema status` reports where the installed schema sits and whether this build accepts
  it as two separate fields. `schema.state` is now `not-installed`, `behind`, `current`, or `ahead`
  in place of `drift`; `schema.compatible` and `schema.refusal` carry the verdict, and the exit code
  follows `compatible`. A schema ahead of the running build is accepted, so a deployment gate no
  longer fails the normal middle of a rolling upgrade. The report prints the same sentence
  `assertSchemaCompatible` throws.
- **Schema.** `workhorse.valid_tags` is renamed `workhorse.valid_tags_v1`, so every function in the
  schema now carries a version suffix and can be superseded without breaking its callers.
  `workhorse.dashboard_run_task_now_v1` is removed: the Python and Go dashboard backends now call
  the audited four-argument `workhorse.run_task_now_v1`, which the TypeScript dashboard server
  already used. A dashboard run-now action is therefore audited in all three languages, and its
  `promoted` event records the actor, the reason, and the request identity.
- **Removed from `@stablemates/workhorse`.** Five identifiers left the package index because no
  application called them. `queueHealthFromDocument` and `QueueHealthDocument` existed so the
  dashboard server could convert a raw `queue_health_v1` row; the dashboard now calls
  `Admin.health()`, and the raw row shape, which leaked SQL column names and string-typed counts,
  is private to core. `Failpoint`, `InjectedCrashError`, and `WorkerOptions.failpoint` were a
  crash-injection hook for this repository's own worker tests and benchmarks; they are marked
  internal and no longer appear in the published type declarations. Nothing about worker behaviour
  changes.
- **`@stablemates/workhorse-dashboard` and `@stablemates/workhorse-dashboard-server` export each
  public name from one subpath.** Six names are removed. `TaskActivityGroup` and
  `TaskActivityPeriod` leave the dashboard's `.` subpath: they restated `DashboardActivityGroupBy`
  and `DashboardActivityPeriod` member for member, and those are the names Python and Go already
  carry. `./presentation` no longer re-exports `dashboardJobEventTypes` or
  `dashboardAttemptOutcomes`; import them from `./wire`, which owns them. `CompleteDashboardOptions`
  leaves `./wire`, `sql` and `DashboardSql` leave the dashboard-server `./server` subpath, and
  `DashboardWorkspaceLink` is now exported from `./server` alone rather than also from `.` and
  `./client`. The three were internal: the bare `sql` collided with the `drizzle` and `kysely`
  template tags in a consumer namespace, and `dashboardDatabase(database)` already returns the
  `DashboardDatabase` that `createDashboardHost` accepts, so no consumer builds a fragment.
- **`@stablemates/workhorse-dashboard-server/server` names every controller type and stops
  exporting its read model.** A host that implements `DashboardTaskController` can now name the
  types its methods return: `DashboardRunNowResult`, `DashboardSignalTaskResult`, and
  `DashboardCompleteHumanWaitResult` join the already-exported `DashboardCancelTaskResult`, and
  `DashboardCancellationAuditContext`, which `cancelTask` receives, is exported beside
  `DashboardAuditContext`. Python and Go already generated the first three. In the other direction,
  `readDashboardEvents`, `readDashboardEventDetail`, `readDashboardWorkers`, and
  `DashboardEventsQuery` are removed from the subpath. They were three of the read model's thirteen
  readers, exported for no stated reason; the read model is the implementation of `dashboardRouter`,
  which is where read-only mode, the worker-management decision, and error-stack redaction are
  applied. Read through the procedures the dashboard already mounts instead. The same subpath is
  re-exported by `@stablemates/workhorse-dashboard/server`, so both packages change together.
- **The idempotency wire family takes the `Dashboard` prefix every other wire name has.**
  `IdempotencyEvidence` becomes `DashboardIdempotencyEvidence`, `readIdempotencyEvidence` becomes
  `readDashboardIdempotencyEvidence`, `hasIdempotencyEvidence` becomes
  `hasDashboardIdempotencyEvidence`, and `idempotencyEventDetailKeys` becomes
  `dashboardIdempotencyEventDetailKeys`. Every old name stays as a `@deprecated` alias for the rest
  of the `0.x` line and is removed in `1.0.0`. `MaintenanceLoopCadences` is unchanged, because
  Python and Go share that name.

### Added

- `SchemaCompatibilityError` is exported from `@stablemates/workhorse`. `assertSchemaCompatible`
  throws it instead of a bare `Error`, so a TypeScript caller can catch a schema or protocol
  mismatch by type the way a Python caller catches `ProtocolCompatibilityError` and a Go caller
  matches `*CompatibilityError`. Its `code` is one of `schema-not-installed`, `schema-too-old`,
  `schema-too-new`, `client-protocol-too-old`, or `client-protocol-too-new` — the same five strings
  the other two SDKs use — and `installedVersion` and `expectedVersion` name the two versions that
  disagree. A database the check cannot read at all still throws a plain `Error`, because an
  unreachable database is not a verdict about versions.
- `workhorse schema status --json` adds `schema.refusalCode` beside `schema.refusal`, so a
  deployment gate can branch on the same code the process that starts after it would throw.

### Fixed

- The demo no longer replays the schema on startup against a database that already holds it.
- The poll-cadence conformance fixture in `protocol/v1/runtime.json` holds the worker at each empty
  poll, so every language runtime's cadence test observes the same schedule.

### Upgrade notes

- **Schema version.** `0.1.0` stays at schema version 1, but its baseline is not the one
  `0.1.0-beta.2` installed: `workhorse.valid_tags` was renamed and
  `workhorse.dashboard_run_task_now_v1` was removed. A database installed by any beta reports
  version 1 and passes `assertSchemaCompatible`, yet holds the old function names. You must recreate the database and
  install the new baseline with `npm exec --no -- workhorse schema install`.
  This is the last release that asks for a recreation: from `0.1.0` the schema is frozen as the
  migration baseline, and later releases upgrade a database in place.
- **Dashboard bindings.** A Go or Python backend that names `dashboard.SendSignalStatus` or
  `dashboard.CompleteHumanWaitStatus` from the generated dashboard bindings renames those
  references to `SignalDeliveryStatus` and `HumanWaitCompletionStatus`. Generated code carries no
  deprecated alias. The TypeScript names all keep one, so a TypeScript project needs no edit.
- **Removed exports.** Code that imported `queueHealthFromDocument` or `QueueHealthDocument` should
  read the snapshot through `Admin.health()`, which returns the same `QueueHealth`. Code that
  imported `Failpoint` or `InjectedCrashError`, or that set `WorkerOptions.failpoint`, was using a
  test hook that was never part of the supported surface; there is no replacement.
- **Dashboard imports.** If a build breaks on a missing dashboard name, move the import to the
  subpath that now owns it: `dashboardJobEventTypes` and `dashboardAttemptOutcomes` to `./wire`,
  `DashboardWorkspaceLink` to `@stablemates/workhorse-dashboard-server/server`, and
  `TaskActivityGroup` and `TaskActivityPeriod` to `DashboardActivityGroupBy` and
  `DashboardActivityPeriod` on `./wire`. Nothing replaces `sql`, `DashboardSql`, or
  `CompleteDashboardOptions`, which were never meant to leave their package. The renamed
  idempotency names still resolve under their old spellings until `1.0.0`, so that rename needs no
  action in `0.x`.

## 0.1.0-beta.2 — 2026-09-01

Published to npm from commit `856cdcf354aa83a3acf8ee67043145adb9c99e09`, tagged
`v0.1.0-beta.2`.

First published line. Requires **schema v1**, Node.js **22 or 24**, PostgreSQL **15 through 18**.

### Changed

- The unpublished `0.1.0-beta.1` tag stopped before its first registry upload because npm parsed a
  relative tarball path as GitHub shorthand. Publication now uses an explicit local path.
- All nine npm packages, the Python distribution, and the Go module use the Apache
  License, Version 2.0. Contributions require the agreement in `CLA.md`.

### Added

- `@stablemates/workhorse`: the schema ships as a single baseline at version 1. Nothing has been
  published, so the pre-release migration history was squashed into `sql/schema/current.sql` rather
  than carried as steps no deployment could ever have applied. `workhorse.protocol_version` records
  the served SQL protocol versions independently of the `workhorse.schema_migration` history;
  `readProtocolVersions` and `workhorse schema status` report it. The migration framework —
  `migrateSchema`, `workhorse schema migrate`, the `workhorse:schema-migration` advisory lock, and
  atomic per-step rollback — remains and has nothing to apply until the first ordered step ships at
  1.0.0. Upgrade steps: recreate the database. Development worktrees run `pnpm worktree:setup`.

- `@stablemates/workhorse`: durable PostgreSQL job queue with at-least-once delivery, leases and fencing,
  cooperative cancellation, deadlines and execution timeouts, durable waits, progress and
  checkpoints, dead letters and redrive, enqueue idempotency keys, persisted retry policies,
  queue and per-key token-bucket rate limits,
  declarative recurring schedules, versioned payload and result contracts, durable JSON size
  limits, operator redaction, automated history retention, and a durable worker registry.
- `@stablemates/workhorse`: database-authoritative maintenance and retention settings with application
  defaults, operator overrides, per-setting provenance, revert operations, and bounded retention
  impact previews.
- `@stablemates/workhorse`: versioned dashboard read views and a planner-estimate function that isolate
  the dashboard server from private table changes.
- `@stablemates/workhorse`: strict job priority from 0 through 100 across direct, batched, delayed, and
  recurring enqueue, with FIFO order inside each priority and preservation through retries,
  promotion, and redrive.
- `@stablemates/workhorse`: PostgreSQL-owned keyed debounce and throttle windows with structured enqueue
  outcomes, atomic batch and transaction behavior, and shared safe key diagnostics.
- `@stablemates/workhorse`: durable dependency edges keep jobs blocked until every prerequisite satisfies
  its fan-in terminal policy. Bounded lineage and job queries expose those edges, while health
  snapshots and per-queue telemetry report dependency pressure.
- `@stablemates/workhorse`: bounded dependency fan-in with terminal policies, plus fenced child creation
  and result joining through `HandlerContext.runChild` and `HandlerContext.runChildren`.
- `@stablemates/workhorse`: child lineage survives retry and cancellation, redrive keeps the source tree
  immutable, retention avoids parent-child cleanup cycles, and health, metrics, and dashboard
  detail expose bounded orchestration evidence.
- `@stablemates/workhorse`: named signal waits release worker leases, and application or authenticated
  dashboard callers can deliver bounded payloads exactly once at the waiting-state transition.
  Callers can shorten the PostgreSQL-owned timeout; unanswered boundaries fail terminally.
- `@stablemates/workhorse`: named human waits retain bounded decision context, release worker leases, and
  resume once after an application or authenticated dashboard operator supplies a bounded result.
  They share the signal-wait timeout and terminal failure contract.
- `@stablemates/workhorse`: `Worker.handleBatch` for compatible full and linger-bounded partial batches,
  with explicit per-job success or failure outcomes, independent retries, leases, contexts, fencing,
  cancellation, timeout handling, policy accounting, priority order, and bounded batch telemetry.
- `@stablemates/workhorse`: transactionally consistent `Queue.health()` snapshots — one SQL statement
  for every correctness-sensitive value, size-capped history scans with explicit lower-bound
  flags, PostgreSQL estimates separated under `observations`, and caller-overridable health
  budgets producing machine-readable `status.reasons` shared by the `workhorse health --json`
  exit code, the benchmark invariants, and the dashboard verdict.
- `@stablemates/workhorse`: the `workhorse` CLI — `init`, `schema install`, `schema status`, `worker`,
  `dashboard`, `health`, `bench`, and `bench competitors`.
- `@stablemates/workhorse`: the `workhorse admin` command set — inspection of jobs, queues, schedules,
  failures, workers, and maintenance state with table and `--json` output, plus guarded `cancel`,
  `redrive`, `pause`, and `resume` that require an explicit verified `--env` target and
  confirmation — and the `workhorse tui` terminal application rendering the same views over the
  same administrative client and safety checks.
- `@stablemates/workhorse`: notification-assisted worker dispatch through one process-local
  `workhorse_jobs` listener per node-postgres pool, with queue routing, reconnect backoff, and
  jittered bounded polling as the durable fallback.
- `@stablemates/workhorse-drizzle`: Drizzle ORM provider with caller-owned transactions.
- `@stablemates/workhorse-prisma`: Prisma ORM provider with caller-owned interactive transactions and optional
  node-postgres notification connections.
- `@stablemates/workhorse-typeorm`: TypeORM provider with caller-owned `EntityManager` transactions and optional
  node-postgres notification connections.
- `@stablemates/workhorse-kysely`: Kysely provider with caller-owned transactions and optional node-postgres
  notification connections.
- `@stablemates/workhorse-otel`: explicit OpenTelemetry registration for the vendor-neutral core
  telemetry contract, with host-owned API peers and no import side effect.
- `@stablemates/workhorse-dashboard`: the operator dashboard, its framework-neutral `Request`/`Response` host,
  a settings page with audited policy changes, and a Connect-style Node bridge for Express,
  Connect, and Fastify.
- `@stablemates/workhorse-dashboard-server`: single-administrator sessions protect standalone dashboard reads
  and mutations, including credential rotation, login throttling, secure cookies, container secret
  files, and a supported container that requires an HTTPS public origin for remote listeners.
- `@stablemates/workhorse-dashboard-contract`: the type-only standalone server contract shared by the core CLI
  and dashboard package, so both compile against one optional embedding boundary.
- Language-neutral SQL protocol conformance fixtures under `protocol/v1`, covering compatibility,
  canonical enqueue requests, lifecycle scenarios, runtime behavior, and structured errors for
  TypeScript and future language clients.
- `typescript/examples/agentic-flow.mjs` and `pnpm example:agentic-flow`, demonstrating a durable
  agent loop built from checkpoints, child jobs, a durable timer, rate limits, and an approval
  signal.
- A supported-version contract: `MINIMUM_POSTGRES_MAJOR`, `SUPPORTED_POSTGRES_MAJORS`,
  `MINIMUM_NODE_MAJOR`, `SUPPORTED_NODE_MAJORS`, and `readPostgresSupport` are exported from
  `@stablemates/workhorse`, exercised by the CI matrix, and reported by `workhorse schema status`.
- `@stablemates/workhorse`: `WorkhorseError`, the base class every error Workhorse raises now extends, so
  one `instanceof` test recognizes a rejected call without enumerating seventeen class names.
- `@stablemates/workhorse`: `databaseErrorCode`, `expectOneRow`, and `MissingRowError`. `databaseErrorCode`
  reads a SQLSTATE through the wrappers an ORM adds around a driver error; `expectOneRow` takes the
  single row a statement is defined to return and throws `MissingRowError` naming that statement
  when the result is empty.
- `@stablemates/workhorse`: the shared adapter core an ORM provider is built from — `QueryError`,
  `rowsToQueryResult`, `attachNotificationPool`, `createProviderQueryable`, and
  `createProviderAdapter`, alongside the existing `createWorkhorseAdapter`. A provider now supplies
  only how its ORM runs a statement; error translation, the result shape, the notification
  capability, and the transaction wiring are owned once. What an adapter must guarantee is written
  down in [`docs/architecture.md`](docs/architecture.md).
- npm provenance on every published tarball.

### Changed

These changes precede the first publication, so no deployment upgrades through them. They are
recorded because the pre-release dashboards and ADRs in this repository name the retired
instruments.

- **Breaking:** `@stablemates/workhorse` now publishes only the `workhorse` binary. Replace
  `workhorse-health`, `workhorse-bench`, and `workhorse-bench-competitors` with `workhorse health`,
  `workhorse bench`, and `workhorse bench competitors`. The CLI rejects unknown options, supports
  both string-option spellings, provides help at each command depth, and uses exit 64 for usage
  errors. `schema status --json` separates schema drift from PostgreSQL support. `health --json`
  preserves the machine-readable health output; human output is now the default.

- `@stablemates/workhorse`: health snapshots and per-queue metrics now count rejected signal deliveries
  and human decisions over a trailing 24-hour window. A partial event index bounds these polling
  reads to recent rejection evidence instead of scanning all retained event history.

- **Breaking:** `@stablemates/workhorse`: every SQL function is at version 1. `claim_v3`,
  `heartbeat_v2`, `list_jobs_v2`, `list_job_timeline_v2`, `list_dead_letters_v2`, and
  `register_worker_v2` lost suffixes that recorded compatibility windows nobody could have been
  inside. `enqueue_many_v2` became `enqueue_many_v1`, and the internal batch function that held
  that name became `enqueue_batch_v1`. The single-queue `register_worker_v1` shim is gone; the
  multi-queue signature owns the name. Existing development worktrees must run
  `pnpm worktree:setup` once to recreate their dedicated databases.

- **Breaking:** `@stablemates/workhorse`: the rolling-statistics cadence is maintenance policy rather
  than a worker option. `WorkerOptions.statisticsRollupIntervalMs` is removed; set
  `statisticsRollupIntervalMs`, and the newly policy-owned `statisticsGroupLimit` and
  `statisticsRecomputeBuckets`, through `Queue.syncMaintenancePolicy` or an operator override.
  `rollup_stats_v1` now reads all three from `maintenance_policy`, gates itself on the interval
  (`Queue.rollupStatistics({ force: true })` bypasses the gate), and its signature is
  `(p_force, p_now, p_max_buckets)`. The baseline schema carries the three policy columns and their
  provenance. The dashboard
  settings page shows the new settings and derives recommendations from measured state — arrival rate against the terminal-cleanup ceiling, retention lag, a stalled or
  opted-out rollup, and default-partition spill — in `DashboardSettingsPage.recommendations`.

- `@stablemates/workhorse`: metric instruments are created on first emission and re-created when the
  global meter provider changes. An application may now install its OpenTelemetry SDK after
  importing `@stablemates/workhorse` and still receive metrics; previously every instrument bound to
  whichever provider existed at import, so a later SDK silently received nothing.
  [ADR 0024](docs/decisions/0024-metrics-instrument-lifecycle.md) records the measurement behind
  this.
- `@stablemates/workhorse`: two instrumentation modules emitted separately on the same lifecycle events.
  They are now one. `typescript/core/src/metrics.ts` is deleted; `typescript/core/src/telemetry.ts` owns every instrument, and
  `WorkhorseMetricsObserver` moves to `typescript/core/src/metrics-observer.ts`. The package export is unchanged —
  `WorkhorseMetricsObserver` is still exported from `@stablemates/workhorse` — and no other export from
  either module was public.
- `@stablemates/workhorse`: `JobValueSizeLimitError` extends `WorkhorseError` rather than `RangeError`.
  Code testing `instanceof RangeError` on it must test `instanceof JobValueSizeLimitError` or
  `instanceof WorkhorseError` instead. Its name, message, and fields are unchanged.
- `@stablemates/workhorse`: enqueue and redrive idempotency conflicts are now recognized through an ORM's
  error wrapper rather than only on the error object the driver threw. A conflict raised inside a
  Drizzle, Prisma, TypeORM, or Kysely transaction reaches the caller as
  `EnqueueIdempotencyConflictError` or `RedriveIdempotencyConflictError` instead of the adapter's
  own query error.
- `@stablemates/workhorse`: the duplicated instruments are retired in favor of one name per event.
  `workhorse.job.enqueued` becomes `workhorse.jobs.enqueued`, `workhorse.job.claimed` becomes
  `workhorse.jobs.claimed`, `workhorse.lease.recovered` becomes `workhorse.leases.expired`,
  `workhorse.job.cancellation` becomes `workhorse.jobs.cancellation`, `workhorse.job.redrive`
  becomes `workhorse.jobs.redrive`, and `workhorse.job.count` becomes `workhorse.jobs.count`.
- `@stablemates/workhorse`: `workhorse.job.execution` becomes `workhorse.handler.executions`, and its
  `workhorse.job.outcome` attribute becomes `workhorse.handler.outcome`. The
  `workhorse.job.execution.duration` histogram is removed; `workhorse.handler.duration` now carries
  the outcome attribute and times the same activation in **milliseconds rather than seconds**.
  Dashboards and alerts that read the retired histogram need both the new name and the new unit.

- `@stablemates/workhorse-dashboard`: `DashboardClient` is inferred from the router that serves it rather than
  written out a second time by hand. The method names and shapes are the ones the dashboard already
  spoke, so a host built against the packaged client needs no change; a host that answered a
  slightly different shape now hears about it from the type-checker. Filter arguments that were
  typed as `string` are now the vocabulary the router accepts — `events({ types })` takes event
  types and attempt outcomes, exported as `DashboardEventTypeFilter`. Adding a procedure is an edit
  to the router alone.
- `@stablemates/workhorse-dashboard`: the server read model uses core-owned versioned views and functions. Its
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
