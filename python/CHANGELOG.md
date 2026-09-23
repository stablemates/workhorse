# Python changelog

`stablemates-workhorse` versions and release notes live here because the Python distribution builds
and publishes from its own tag. It carries the version the TypeScript packages, the Go module, and
the Rust crate carry, because every release tag names one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## 0.4.0 — 2026-09-23

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v18** and Python **3.12** or newer.

**A 0.3.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migration 0024 and leaves the installation at
schema version 24. The step is additive: it replaces one read function. No table changes, no
database is dropped, and no data is lost. The compatibility floor stays at version 18.

- Measure row retention lag against the history gate the prune applies. `prune_terminal_tasks_v1`
  keeps a terminal task until daily history retention passes its `history_through_at`, but queue
  health counted a row held only by that gate as lag. The measured lag climbed toward a day between
  history passes, so health read Degraded for most of every day. Migration 0024 replaces
  `queue_health_v1` so both eligible boundaries apply the prune's predicate. A history pass that
  stops advancing still shows as task event and attempt history lag.
- Fit the embedded dashboard Workers table on a laptop viewport without horizontal scrolling. Schedules
  become a calendar icon with a hover card, the Paused badge moves to the placement line, queues
  stack one per line, and a long worker name is truncated in the middle with the full name on hover.

## 0.3.0 — 2026-09-21

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v18** and Python **3.12** or newer.

**A worker takes a connection pool, not a connection.** `Worker` takes a
`psycopg_pool.ConnectionPool`, `AsyncWorker.from_psycopg` takes an `AsyncConnectionPool`, and
`AsyncWorker.from_asyncpg` takes an `asyncpg.Pool`. The `heartbeat_connection_factory` and
`notification_connection_factory` options are removed, because the worker now takes its dedicated
connections from the pool
([ADR 0071](../docs/decisions/0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md)).
Every other statement borrows a connection for that one statement and returns it, replacing the
model in which one connection serialized every statement for up to 100 handler threads.

The pool needs a known capacity of at least 3: the listener, the heartbeat connection, and one
statement. A worker whose pool is smaller refuses to start and names the capacity it found, the
capacity it needs, and the opt-out. `shared_heartbeats=True` takes heartbeat rounds back to the
shared pool, which is how a small pool runs. `concurrency` does not raise the floor, but a pool of
`concurrency + 3` lets the dispatcher and every handler run a statement at the same time.

**A worker offers the slow maintenance routines once a minute, not on every tick.** A worker used to
offer them on every one-second tick, sending sixty times the intended rate of `run_maintenance`
calls. The cadence [ADR 0011](../docs/decisions/0011-daily-retention-and-split-maintenance.md)
decided is restored, and the new `maintenance_routine_poll_ms` option gates it
([ADR 0072](../docs/decisions/0072-converge-the-worker-runtime-defaults.md)).

**A 0.2.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migrations 0010 through 0023 and leaves the
installation at schema version 23. Every step is additive: it replaces read and transition functions
or adds one, and 0023 also releases the dependency edges a cancellation abandoned. No table changes,
no database is dropped, and no data is lost.

**A process from this release refuses a schema below version 18.** The compatibility gate's floor is
now derived from the newest function the SDKs call, rather than held at 1 by hand. A lagging
installation is refused at startup instead of failing on its first dashboard read, after the process
has taken work.

**0.1.x support is dropped.** The migration chain now starts at the 0.2.0 baseline, schema version 6
([ADR 0073](../docs/decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)). Workhorse
0.2.1 is the last release that migrates a database below the baseline: reach the baseline with
0.2.1, then upgrade to this release. The refusal names it.

- Accept `retry_delay_ms` on the worker, as a whole number of milliseconds or a callable over the
  attempt, and send it to `fail_v1`. A worker that sets nothing still leaves every delay to the
  persisted retry policy.
- Treat a failed heartbeat round as unknown until the lease lapses. A single round that threw used
  to cancel every in-flight attempt and re-raise out of the handler. The round now retries on the
  next beat, and each attempt keeps its own lease watchdog: once one lease passes with no accepted
  renewal, the attempt submits `lease_expired`, aborts its handler, and records `lease_lost`.
- Run `AsyncWorker` context calls on dedicated threads.
- Raise a fresh suspension from a durable wait, and run handler cleanup in `finally`.
- Release a task whose type the worker has no handler for, instead of failing it.
  `release_owned_v1` returns the claim to its queue with the attempt intact and appends a `released`
  event. During a rolling deployment the old release no longer spends the retry budget of a type
  only the new release runs.
- Count a sweep that only released a claim as no progress, so a caller looping `run_once` waits
  instead of claiming and releasing the same task.
- Cache the compatibility check and the contract definitions in the producer.
- Never skip a busy schedule occurrence, and read the evaluation instant from the database clock.
- Release a canceled dependent's incoming dependency edges, which used to hold a prerequisite's
  identity against retention.
- Lock only the row a claim takes, and skip the enqueue dependency block for a request that declares
  no prerequisite.
- Document the 2^53 integer bound that Python clears where TypeScript and Go do not.

## 0.2.1 — 2026-09-18

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

**A 0.2.0 database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migrations 0007 through 0009 and leaves the
installation at schema version 9. The migrations change read functions and no table. No database is
dropped and no data is lost.

- Prune the dashboard task lists on the task table's indexes. A list filtered by a tag, a queue, or
  a task type seeks that index before it reads the runtime and outcome projections, and an
  unfiltered list no longer joins every task back to itself.
- Stop compiling the queue health snapshot with JIT on every call. Past a few thousand ready tasks,
  compilation cost about two seconds for a statement that executes in tens of milliseconds.
- Release a pinned task page in the dashboard. While a pager click holds the list on an older
  page, auto refresh pauses and says why, and a first-page control returns to the live list with
  every filter kept.

## 0.2.0 — 2026-09-17

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

**A 0.1.5 database upgrades in place.** This is the first release that ships migrations. Run
`workhorse schema migrate` from a deployment step before any process from this release starts. It
applies migrations 0002 through 0006 and leaves the installation at schema version 6. No database is
dropped and no data is lost.

- Add named budgets that span queues. `sync_budgets()` declares a namespace of budgets,
  `list_budgets()` reads them, and an enqueue names one through `budget`. A budget caps the
  unexpired active tasks that name it, refills one shared token bucket, or does both. The
  synchronous and asynchronous clients carry both methods.
- Skip missed schedule occurrences by default. `ScheduleDefinition` carries a `catchup_policy` of
  `skip`, `latest`, or `all`. A schedule that a paused deployment left behind no longer enqueues
  every occurrence it missed. Existing schedules take `skip`.
- Look each contracted task type up once per enqueue batch instead of once per row, and hoist the
  telemetry constants a worker rebuilt on every attempt.
- Bound every dashboard read procedure to the page it returns, and serve the browser bundle as page
  chunks with compressed, cached assets.
- Document two tenancy tiers. One database per tenant is the boundary Workhorse enforces; a shared
  database carries the tenant on the concurrency key, a budget, and a tag.

## 0.1.5 — 2026-09-14

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

**A 0.1.4 database must be dropped and reinstalled.** This release re-cuts schema v1 to separate
deployment-owned schedule activation from durable operator pauses and to retain maintenance-run
history; no migration exists between 0.1.4 and 0.1.5.

- Preserve operator schedule pauses across deployment synchronization, removal, and re-addition,
  and expose the configured, paused, and effective states through the dashboard bindings.
- Record recent maintenance executions with phase timings, errors, and affected-row counts. The
  shared dashboard shows those runs and supports exact event time ranges.
- Defer `SIGINT` and `SIGTERM` shutdown through a nonblocking self-pipe, so the signal handler stays
  responsive while worker state is locked and a second signal can still force an exit.
- Verify and document transactional enqueue through SQLAlchemy's synchronous connection accessor.
- Report the Python distribution version from the dashboard host instead of baking a version into
  the shared browser bundle.

## 0.1.4 — 2026-09-11

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

**A 0.1.x database must be dropped and reinstalled.** This release renames the unit of work from
"job" to "task" on every surface and re-cuts the schema baseline in place; no migration exists
between 0.1.3 and 0.1.4 ([ADR 0064](../docs/decisions/0064-rename-the-unit-noun-from-job-to-task.md)).

- Rename every `Job*` class, `job_id` argument and attribute, `context.job`, and `Admin.get_job`,
  `list_jobs`, and `get_job_timeline` to their `Task` and `task` spellings; the package exports no
  bare `Task` name, so `asyncio.Task` cannot collide with it.
- Rename the schema, the `workhorse_jobs` notification channel (now `workhorse_tasks`), and the
  substituted error name `RedactedJobError` (now `RedactedTaskError`).
- Rename the OpenTelemetry names from `workhorse.jobs.*` and `workhorse.job.*` to
  `workhorse.tasks.*` and `workhorse.task.*`, with the `{task}` unit.
- Rename the `dashboard/v1` bindings: `jobDetail` becomes `taskDetail` and every `job*` field
  becomes `task*`; `maintenanceTaskPollMs` becomes `maintenanceRoutinePollMs` and the cron page
  lists `maintenance.routines`.

## 0.1.3 — 2026-09-10

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

- Improve task and event tables with readable status labels, compact columns, full hover text,
  and task ID copy controls.
- Add worker and search filters to Events, and show task tags and accepted enqueue modes in details.
- Share task actions between listings and details, with cancellation confirmation and an optional reason.
- Keep task menus responsive on long pages and reset pagination when selecting a task view in the sidebar.
- Remember chart visibility and task drawer width, and clarify rate-limit labels on Queues.

## 0.1.2 — 2026-09-10

Published to PyPI from one source commit shared with the npm packages and the Go module, tagged
`python/v0.1.2`. Workhorse stays a public beta on the `0.x` line.

Requires **schema v1** and Python **3.12** or newer.

**Upgrading from `0.1.0` means you recreate the database.** The clean-install baseline was re-cut
so that schema version 1 installs the corrected statistics functions. A `0.1.0` database still
reports version 1 and passes `assertSchemaCompatible`, yet holds the uncorrected ones, and no
migration carries it forward. Recreate the database, or keep running `0.1.0`.

**`0.1.1` was a stopped train and its number is spent.** Its npm stage failed before it wrote
anything: `npm publish --provenance` is rejected from a runner npm reads as `self-hosted`, which is
how it classifies the Depot runners every job used. Nothing reached npm and the Go tag was never
pushed, so `0.1.1` exists only on PyPI, where the distribution is complete and not defective.
`0.1.2` carries the identical content to all three registries and supersedes it. Nothing on npm
needs deprecating, because nothing was published there.

- Add cursor task browsing through `tasksCursor`, with optional exact totals and backward navigation.
- Read system statistics once per response, sharing the live history tail across dashboard panels.
- Coalesce dashboard refreshes and reuse validated full builds across repository smoke checks.
- Anchor every statistics bucket on UTC, so day and hour boundaries no longer follow the
  database's timezone setting.
- Publish npm packages from a GitHub-hosted runner, which is the only environment npm accepts a
  provenance attestation from.

## 0.1.0 — 2026-09-04

Published to PyPI from one source commit shared with the npm packages and the Go module, tagged
`python/v0.1.0`. This is the first version without a prerelease suffix
([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)). The distribution
stays a public beta on the `0.x` line, and its classifier stays `Development Status :: 4 - Beta`.

Requires **schema v1** and Python **3.12** or newer.

### Added

- The dashboard backend serves `redriveTask` and `redriveDeadLetters`, which the shared
  `dashboard/v1` contract added this release. Both map onto `Admin.redrive` and
  `Admin.redrive_many`: a source the queue does not hold answers 404, and a bulk page reports every
  result plus the continuation cursor the next page resumes from. The host lists both as mutations,
  so a cross-origin or read-only request is refused before dispatch. `workhorse.dashboard_v1` gains
  their generated input and output types.
- **The Python worker records what it is.** The schema baseline carries `client_protocol_version`,
  `sdk_language`, and `sdk_version` to `workhorse.worker_registry`, and every registration refresh
  reports `python` with this distribution's version and the SQL protocol version it speaks. The
  dashboard shows them per worker, and `workhorse schema status --json` counts the live workers by
  protocol so an operator can see whether a protocol is still in use before retiring it. The
  columns are nullable and the older call is retained, so a worker running an earlier release keeps
  registering during a rolling deploy.
- `workhorse.compatibility` publishes the startup schema check that the installation page tells every
  runtime to make. `assert_schema_compatible(connection)` takes a Psycopg connection, and
  `assert_schema_compatible_psycopg` and `assert_schema_compatible_asyncpg` name their asynchronous
  driver, mirroring `AsyncQueue.from_psycopg` and `AsyncQueue.from_asyncpg`.
- `workhorse` exports nine names that were reachable only through a submodule and are the declared
  type of an already-exported field or callback: `CancelStatus`, `CompatibilityCode`,
  `DependencyPolicy`, `EnqueueOutcome`, `Handler`, `HumanWaitCompletionStatus`, `JobState`,
  `JobTimelineEntry`, and `SignalDeliveryStatus`. `workhorse.dashboard` exports `Authorize`, the
  declared type of its documented `authorize` hook, and `DashboardProcedure`, the declared type of
  its `enqueue_test` and `set_schedule_enabled` parameters.
- Every module under `workhorse` whose name carries no leading underscore now declares `__all__`,
  so `from workhorse.worker import *` and `dir(workhorse.admin)` describe the supported surface.
  Only `workhorse.dashboard` declared one before.

### Fixed

- `Worker.handle_batch` groups and orders members by the worker's claim order. Each job runs on its
  own handler thread, so members previously reached the coordinator in thread scheduling order, and
  two equal-priority jobs could appear in a batch in either order. `AsyncWorker.handle_batch`
  shares the coordinator and gains the same guarantee. This change landed after `0.1.0b3` published
  and was listed under that entry in error.

### Changed

- **The compatibility check declares a floor and no ceiling, and reads the ceiling from the
  database.** It refused any schema newer than the version this build was compiled against, which
  would have turned the first in-place migration into an outage for the length of a rolling
  deployment. A build cannot know which later release stops serving it, so the installed schema
  declares that instead: `workhorse.protocol_version` records the SQL protocol versions it still
  serves, and a client whose protocol is absent from that list raises
  `ProtocolCompatibilityError`. Below the oldest served version is `schema-too-new`; above the
  newest is `schema-too-old`. A schema that records nothing enforces nothing. One statement returns
  the schema version and the served list together, so the check stays one round trip.
- The README states the unpinned install command and the schema install step, which the TypeScript
  CLI owns.

### Removed

- The public submodules no longer re-export the private helpers they import. About seventy names
  from `workhorse._compatibility`, `workhorse._contracts`, `workhorse._drivers`,
  `workhorse._external_waits`, `workhorse._notifications`, `workhorse._protocol`,
  `workhorse._statements`, and `workhorse._telemetry` are gone from `workhorse.admin`,
  `workhorse.client`, `workhorse.compatibility`, `workhorse.dashboard`, and `workhorse.worker`.
  Among them are `SQL_STATEMENTS`, `STATEMENTS`, `DriverStatement`, `Row`, `SyncConnection`,
  `SyncExecutor`, `PsycopgConnection`, `AsyncpgConnection`, and every other driver protocol. Import
  the supported name from `workhorse` instead; nothing in the documented surface referenced them.
- `workhorse.errors.translate_database_error`, `workhorse.worker.AttemptOutcome`,
  `workhorse.worker.JobExecutionOutcome`, `workhorse.async_worker.T`,
  `workhorse.types.TJson`, `workhorse.dashboard.DashboardBackend`,
  `workhorse.dashboard.DashboardRPCError`, and `workhorse.dashboard.normalize_dashboard_path`
  are private. They were internal helpers that no document or test named.
- The `workhorse.admin` statement and limit constants `GET_*`, `LIST_*`, `REDRIVE`,
  `REDRIVE_MANY`, `SET_*`, `PURGE_QUEUE`, `DEFAULT_PAYLOAD_BYTES`, `JOB_STATES`, `MAX_PAGE_SIZE`,
  `MAX_PAYLOAD_BYTES`, `MAX_REDACT_KEYS`, and `MAX_REDRIVE_BATCH_SIZE` are private. The limits stay
  internal rather than becoming public under the TypeScript names, because the Go module publishes
  no counterpart and no Python document states them.
- The dashboard backend's run-now action calls the audited `workhorse.run_task_now_v1` instead of
  `workhorse.dashboard_run_task_now_v1`, which is removed from the schema. The action now records
  the authenticated actor, the reason, and the request identity in its `promoted` event, matching
  the TypeScript dashboard server.
- **Type names.** Two exported type aliases take the names the TypeScript and Go SDKs already share:
  `workhorse.types.TerminalPolicy` becomes `DependencyTerminalPolicy` and
  `workhorse.types.NonReplaceableReason` becomes `EnqueueNonReplaceableReason`. Both new names are
  exported from `workhorse`, which neither old name was. Each old name stays in `workhorse.types` as
  a deprecated alias of its replacement, so no code has to change on this release. The aliases are
  removed in `1.0.0`.
- **`workhorse.dashboard_v1` type names.** Every type generated from a shared `dashboard/v1` wire
  type now carries the `Dashboard` prefix, so the module no longer declares a second `CancelStatus`
  and `JSON` beside `workhorse.types`. `CancelStatus`, `SendSignalStatus`,
  `CompleteHumanWaitStatus`, `JSON`, `QueueHealthReason`, `QueueHealthReasonCode`,
  `RetentionPolicyImpact`, and `MaintenanceLoopCadences` become `DashboardCancelStatus`,
  `DashboardSignalDeliveryStatus`, `DashboardHumanWaitCompletionStatus`, `DashboardJSON`,
  `DashboardQueueHealthReason`, `DashboardQueueHealthReasonCode`,
  `DashboardRetentionPolicyImpact`, and `DashboardMaintenanceLoopCadences`. The module is
  generated, so it carries no aliases: a caller that names one of the eight updates the name. No
  request or response payload changes.

### Upgrade notes

- **Schema version.** `0.1.0` stays at schema version 1, but its baseline is not the one the last
  beta installed: `workhorse.valid_tags` was renamed `workhorse.valid_tags_v1` and
  `workhorse.dashboard_run_task_now_v1` was removed. A database installed by any beta reports
  version 1 and passes the compatibility check, yet holds the old function names. You must recreate the database and
  install the new baseline with
  `npx --package @stablemates/workhorse@0.1.0 workhorse schema install`.
  This is the last release that asks for a recreation: from `0.1.0` the schema is frozen as the
  migration baseline, and later releases upgrade a database in place.

## 0.1.0b3 — 2026-09-01

Published to PyPI from commit `663c526805746786f12b3be3e151e8ce06c80057`, tagged
`python/v0.1.0b3`.

### Fixed

- The fix-forward release uploads PEP 740 attestations with its wheel and source distribution.
  The package behavior is unchanged from `0.1.0b1`.

## 0.1.0b2 — 2026-08-31

Published to PyPI from commit `0c15212cc5510501bbc9b74bd372fa480e77a1ff`, tagged
`python/v0.1.0b2`.

### Fixed

- The release workflow generated PEP 740 attestations but omitted them from the PyPI upload.
  The package behavior is unchanged from `0.1.0b1`.

## 0.1.0b1 — 2026-08-31

Published to PyPI from commit `6769c768d19861fb8c5c7ea3764e8d5abc62fcf4`, tagged
`python/v0.1.0b1`.

### Changed

- The distribution uses the Apache License, Version 2.0. Contributions require the
  repository `CLA.md`.

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
