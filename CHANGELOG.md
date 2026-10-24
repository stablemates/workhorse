# Changelog

This changelog covers 10 published packages on npm. They are versioned in lockstep and released
from one tag:
`@stablemates/workhorse`, `@stablemates/workhorse-drizzle`, `@stablemates/workhorse-prisma`, `@stablemates/workhorse-typeorm`,
`@stablemates/workhorse-kysely`, `@stablemates/workhorse-knex`, `@stablemates/workhorse-otel`, `@stablemates/workhorse-dashboard`,
`@stablemates/workhorse-dashboard-server`, and `@stablemates/workhorse-dashboard-contract`. The Python distribution, Go module, Rust crate, Ruby
gem, and three JVM artifacts release from that same commit, so their notes live in
[`python/CHANGELOG.md`](python/CHANGELOG.md), [`go/CHANGELOG.md`](go/CHANGELOG.md),
[`rust/CHANGELOG.md`](rust/CHANGELOG.md), [`ruby/CHANGELOG.md`](ruby/CHANGELOG.md), and
[`jvm/CHANGELOG.md`](jvm/CHANGELOG.md). Each entry states its required schema version and upgrade steps.

The supported Node.js and PostgreSQL versions, the schema compatibility guarantees, and the release
process are in [`docs/compatibility.md`](docs/compatibility.md).

Workhorse is a public beta. While the line is `0.x`, any minor release may change behaviour. From
`0.1.0` the schema upgrades in place: every release ships ordered, immutable migrations, and inside
a major line a migration only adds. Breaking changes are always listed with
upgrade steps.

## Unreleased

### An explicit pollMs keeps its value while the subscription is live

`Worker` takes `pollMs` as its fallback poll interval. Before this change, the worker capped every
wait at 5,000 ms, also an explicit `pollMs` while its `LISTEN` subscription was live. Thus
`pollMs: 30_000` waited about 5 s, and the other six SDKs waited about 30 s (SM-1668).

Now a worker with a live subscription waits the explicit `pollMs` with ±10% jitter. This is a
behavior change for a caller who sets `pollMs` above 5,000: an idle worker claims less often. Without
a live subscription, the backoff still caps the wait at 5,000 ms. ADR 0112 records the order for all
seven SDKs.

### The .NET heartbeat round gives each server budget one quarter

PostgreSQL measures `statement_timeout` for each statement and
`idle_in_transaction_session_timeout` for each idle gap of a heartbeat round. The other SDKs set
each budget to one quarter of the time that remains in the round (SM-1633). The .NET worker still
set one half for the statement and one eighth for each idle gap. An idle gap is about one round
trip. Thus, on a slow network, PostgreSQL could end the session of a .NET round. The other SDKs
complete the same round. The .NET worker now sets both budgets to one quarter, at least 1 ms
(SM-1745).

### The .NET SDK refuses a `BigInteger` value

ADR 0107 states that `BigInteger` is not a supported payload type. Before this change, the .NET SDK
wrote a `BigInteger` in a payload, result, checkpoint, wait value, or progress value as an object of
its properties, such as `{"isPowerOfTwo":false,...}`, and reported no error. Now the write fails with
`ArgumentException` at any depth. A `JsonConverter<BigInteger>` that the caller adds to the JSON
options or to a property still writes the value (SM-1746).

### The metrics observer reports maintenance freshness and retention lag

The `workhorse.maintenance.*` counters and histograms record only when a routine runs. If every
worker stops, they record nothing, and an operator cannot alert on a routine that stops (SM-1674).

`WorkhorseMetricsObserver` now records five gauges from database state:
`workhorse.maintenance.routine.age`, `workhorse.maintenance.routine.overdue`,
`workhorse.retention.lag`, `workhorse.retention.lag_budget`, and `workhorse.retention.enabled`. They
use the attributes `workhorse.maintenance.routine` and `workhorse.retention.category`, and give a
fixed 28 series for each database. The observer reads them every `maintenanceIntervalMs`, a new
option with a default of 60,000, because the query calls `queue_health_v1`. `start()` now runs that
query at once, and `collect()` runs it with the queue queries.
[ADR 0110](docs/decisions/0110-export-maintenance-freshness-and-retention-lag-from-the-metrics-observer.md)
records the names. `docs/architecture/telemetry.md` gives alert examples. The change needs no
migration.

### The .NET docs state how a `DateTime` converts to an enqueue time

C# converts a `DateTime` to a `DateTimeOffset` implicitly. If the `Kind` is `Local` or
`Unspecified`, the conversion uses the offset of the host. Thus a `DateTime` with `Kind`
`Unspecified` can give `RunAt` or `Deadline` an instant that the caller does not intend. The XML
docs of `EnqueueOptions.RunAt`, `EnqueueOptions.Deadline`, `HandlerContext.SleepUntilAsync`, and
the six admin time filters now state the rule. The architecture reference also shows how a caller
can make the build report each implicit conversion with `Microsoft.CodeAnalysis.BannedApiAnalyzers`.
The C# governed surface does not change (SM-1722).

### The .NET RetryDelay refuses a delay outside the fail_v1 range

`fail_v1` takes the retry delay as a PostgreSQL `integer`. Before this change, the .NET worker
clamped a `RetryDelay` result to 0 through 2,147,483,647 ms without a record. A negative delay thus
retried the task at once. The worker also rounded a fraction of a millisecond to even (SM-1668).

Now the worker rounds the delay to the nearest millisecond, half up. A negative delay, or one that
rounds above 2,147,483,647 ms, throws `ArgumentOutOfRangeException` before `fail_v1`. The Go, Rust,
Python, and Ruby notes list their changes. ADR 0111 records the rule for all seven SDKs.

### A fast-tier attempt timeout reports its retry

`expire_owned_telemetry_v1` settles a due deadline or attempt timeout for a live worker and returns
`status` and `retry_state`. The TypeScript, Python, Ruby, JVM, and .NET workers use `retry_state`
to record a `workhorse.retry` span and one `workhorse.tasks.retried` count. Before migration 0086,
the function reads `retry_state` only from the full tier. If an attempt timeout retries a fast-tier
task, the function returns null, and the worker records no retry. The task state is correct
(SM-1694).

Migration 0086 (`0086-report-the-fast-tier-retry-of-an-expired-timeout.sql`) moves the schema to
version 85. `expire_owned_telemetry_v1` now returns `ready` or `scheduled` for a fast-tier timeout
retry. A ready fast-tier task with a future run time gives `scheduled`. The full tier keeps its
values. The Go and Rust workers do not read `retry_state`, so this change does not add timeout
retry telemetry to them.

The migration does not raise the SDK compatibility floor, and no signature or result shape
changes. Run `workhorse schema migrate`. Every process gets the new result when the migration
commits.

### History-day and schedule occurrence locks are unambiguous

A history-day lock converted its date to text with the session `DateStyle`. Two sessions with
different settings then took different locks for one day and did not exclude each other. A history
partition name converted its date with the session `TimeZone`. In a time zone that skipped a whole
day, such as `Pacific/Apia` on 2011-12-30, the name of that day named the next day. A schedule occurrence lock joined the namespace, the
schedule name, and the second with colons. Thus the schedule `a:b`/`c` and the schedule `a`/`b:c`
shared one lock, and one pass could falsely defer the other (SM-1665).

Migration 0085 (`0085-make-the-day-and-schedule-lock-keys-unambiguous.sql`) moves the schema to
version 84. `create_history_day_v1`, `retire_history_day_v1`, and `retire_history_partitions_v1`
now give one day the same lock under every `DateStyle` and `TimeZone`. These functions and
`prepare_history_partitions_v1` also give one day the same partition name under every `TimeZone`.
`fire_schedule_v1` and
`fire_due_schedules_v2` now keep the three parts of an occurrence separate in its lock.
Duplicate-occurrence protection, busy-occurrence deferral, and the history parent lock order do not
change.

Only a calendar day that the session time zone skipped can produce a wrong partition name. Before
this change, `retire_history_day_v1` for the next day dropped that partition, which holds the rows
of the wrong day. The migration renames each such partition to the name of its UTC day. If the
correct name is taken, it raises a NOTICE that names both tables and changes nothing.

The migration does not raise the SDK compatibility floor, and no signature or result shape
changes. Run `workhorse schema migrate`. Every process gets the new locks when the migration
commits.

### A disposed .NET host records the worker outcome before the disposal returns

Before this change, a Generic Host that an application disposed without `StopAsync` could return
from the disposal before the hosted worker recorded its outcome. The worker drained, but
`ExecuteAsync` wrote the phase and `Environment.ExitCode` later, on another thread. If the drain
abandoned a handler, a program that exited right after the disposal could exit with code 0
(SM-1731).

When an application disposes the host, the hosted worker of `Workhorse.Hosting` now waits for
`ExecuteAsync`. The phase that the health check reads, the log events, and the exit code are final
when the disposal returns. The disposal does not throw the run's error, because the hosted worker
already logged it. `StopAsync` does not change.

### Terminal cleanup and lease recovery continue under concurrent work

Terminal cleanup chose and locked its candidates in one statement, with one snapshot. If an enqueue
committed a dependency on a terminal prerequisite after that snapshot and before the lock, the
delete failed with SQLSTATE `23001`, and the `terminal_tasks` phase rolled back all its batches.
Also, a recovery scan that filled its limit counted as a completed expired-lease scan. After many
workers failed at once, expired leases then drained at one batch per half maintenance interval, not
one batch per tick (SM-1665).

Migration 0084 (`0084-recheck-terminal-cleanup-references-and-continue-lease-scans.sql`) moves the
schema to version 83. `prune_full_terminal_tasks_internal_v1` now locks its candidate window in one
statement and checks every reference again in a second statement. At read committed, the isolation
level of workers since migration 0048, the second statement sees the new dependency. The
prerequisite stays, the rest of the batch is deleted, and a later pass deletes the prerequisite
after its dependent finishes. At repeatable read or serializable, the phase keeps its earlier
error.

`recover_expired_v1` and `tick_v1` now record a completed scan only when the scan returns
fewer rows than its share of the limit. While a backlog remains, every tick scans.

The migration does not raise the SDK compatibility floor, and no signature or result shape
changes. Run `workhorse schema migrate`. Every process gets the new behavior when the migration
commits.

### Workers use the database clock for maintenance

Maintenance writes shared state: the due time of each routine and the retention cutoffs. Before
this change, each TypeScript and .NET worker sent its host clock as the maintenance time. If that clock was two days
fast, other workers skipped a routine until that future time. Retention also deleted a 13-day-old
schedule occurrence under a 14-day policy (SM-1645).

Now both workers bind the text `now`, and PostgreSQL resolves it to its own time at the start of
the call. `Queue.runMaintenance`, `prepareHistoryPartitions`, `rollupStatistics`, `retainHistory`,
and `pruneTerminalStorage` also use the database clock when the caller gives no `now`. An explicit
`now` stays as a seam for tests and operator repairs. Inside a caller's transaction, the default
is the start time of that transaction.

The schema does not change.

### A worker without a live notification subscription polls at the short interval

A worker that can listen uses a 5,000 ms wait after an empty claim, because a notification wakes it
for new work. Before this change, the TypeScript worker chose that wait from its configuration, not from
the state of its listener. If the listener had not run `LISTEN` yet, or reconnected after a lost
connection, nothing woke the worker. A new task then waited up to 5 s for a claim (SM-1648).

Now `Worker.run()` reads the listener state before each wait. Without a live subscription, the default
wait starts at 250 ms and doubles toward 5,000 ms after each empty claim, as in the other SDKs.
When `LISTEN` succeeds, the 5,000 ms wait applies again. An explicit `pollMs` does not change.

When a live subscription is lost, the backoff restarts at 250 ms, because the empty claims of the
live period do not count. Before this change, a worker that was idle for some time while it
listened went to the 5,000 ms ceiling at once after a loss. The .NET worker now also clears its
listening state before it wakes its workers after a loss, and it wakes them after a failed
keepalive.

The `subscription-recovery` case in `protocol/v1/runtime.json` checks these rules in every SDK.

### The docs give tested database roles for the dashboard and workers

ADR 0022 promised least-privilege database roles for the dashboard, but no guidance existed. Only
the application enforced the read-only dashboard mode. The new "Database roles" section of
`docs/architecture/operations.md` gives the grant SQL (SM-1667). It covers the installation role, a
read-only dashboard role, a writable dashboard role, and a worker role. A scratch-database test runs that SQL
and checks that the read-only role serves each dashboard read and that PostgreSQL rejects its
writes with SQLSTATE `42501`.

The read-only role needs `SELECT` on each table in the `workhorse` schema, because each function
runs with the privileges of its caller. It can read stored payloads, results, checkpoints, and
human-wait context, so its grants are not a redaction boundary. A worker role must act as the
installation role, because maintenance creates and drops history partitions. The schema and
its grants do not change. No upgrade step is necessary.

### The schema lifecycle documents the write-blocking index of migration 0061

Before this change, `docs/schema-lifecycle.md` stated that no supported migration step builds an
index without `CONCURRENTLY`. Migration 0061 does: it builds `fast_task_outcome_failed_finished_idx`
on `workhorse.fast_task_outcome` and blocks fast-tier outcome writes until it commits (SM-1642).

- If a database at schema version 25 through 59 holds many fast-tier outcomes, build the index
  concurrently before you upgrade. The section "Shipped migrations that block writes" in
  `docs/schema-lifecycle.md` gives the procedure and the validity check. Migration 0061 then skips
  its build. Migration 0061 does not change.
- A test now rejects a new migration step that builds an index on an existing table without
  `CONCURRENTLY`.
- `docs/schema-lifecycle.md` and ADR 0109 now state when a migration can replace the body of a
  `_vN` function and keep the suffix, and when the change needs a `_vN+1` successor (SM-1665).

### A late schedule pass no longer loses a `skip` occurrence

A worker waits one maintenance interval after its schedule pass ends, so the next pass always
starts more than one interval after the previous one. Before this change, a `skip` schedule fired
only occurrences newer than one interval. An occurrence in the extra time never fired, and nothing
recorded the miss (SM-1644). Also, each pass read all retained occurrences of a namespace before it
tried the namespace lock, so a pass that lost the lock read that history for nothing (SM-1647).

Migration 0083 (`0083-fire-skip-schedules-within-the-supported-delay.sql`) moves the schema to
version 82. A `skip` schedule now continues from its durable position. It fires each occurrence
that is not older than the supported delay, `GREATEST(60 seconds, 2 × evaluation_window_ms)`. After
a longer outage, it skips only the older occurrences and records the skip in the new columns
`last_skipped_at`, `last_skipped_count`, and `last_skipped_through` of `schedule_definition`. The
count stops at 10,000. A `skip` pass that reaches the catch-up limit advances only through its last
occurrence, as `all` does, so the next pass fires the rest. `fire_due_schedules_v2` now tries each namespace lock before it reads
occurrence history, and it reads one occurrence row for each definition in a namespace it holds.

The migration does not raise the SDK compatibility floor. No SDK statement changes, and the result
of `fire_due_schedules_v2` keeps its shape. The `latest` and `all` policies do not change. The
migration changes no stored data.

### A registry prune keeps the operator pause of a live worker

An operator pauses a worker. A network partition or a PostgreSQL failover then stops the worker
from refreshing its registration for more than one minute, and maintenance prunes its stale row.
Before this change, the next registration of the same worker inserted a new row with
`paused = false`. The worker started to claim tasks again, and no operator ended the pause
(SM-1646).

Migration 0082 (`0082-keep-the-operator-pause-after-a-registry-prune.sql`) moves the schema to
version 81. It adds the table `worker_pause_tombstone`. When `prune_worker_registry_v1` removes a
paused row, it keeps the pause of that worker instance for one day or three registration
intervals, whichever is longer. If the same instance registers again in that time,
`register_worker_v1` restores the pause and its attribution. A new instance still starts running.
An operator resume or a deregistration of the instance ends the kept pause.
Registration, resume, deregistration, and pruning of one worker ID take one transaction advisory
lock, so a resume cannot miss a registration that restores a kept pause.

`prune_worker_registry_v1` also keeps each row for at least three of its own registration
intervals. Before this change, a worker with a registration interval above one minute could lose
its row between two healthy refreshes.

The migration does not raise the SDK compatibility floor. No SDK statement changes. The migration
changes no stored data.

### A handler error with text that jsonb cannot store settles by its retry policy

PostgreSQL `jsonb` cannot store a NUL character or an unpaired surrogate. Before this change, a
handler error with such text made `fail_v1` refuse the failure envelope. The worker stopped, and the
task stayed active until lease recovery (SM-1650).

Now `errorEnvelope` replaces each NUL character and each unpaired UTF-16 surrogate with U+FFFD. It
does this in the name, the message, and the stack. The JVM and .NET workers use the same rule. The
retry policy then settles the task. A valid surrogate pair and all other text do not change.

The `protocol/v1/failures.json` fixtures pin the rule for every SDK.

### A dense cron schedule resolves only the times near its window

A schedule pass calls `cron_occurrences_v1` for each schedule. Before this change, the function
resolved every wall-clock time that the cron fields allow on each matching day of the window. For an
every-second expression, each pass resolved 86,400 wall-clock times. Each accepted occurrence was
also compared with all earlier ones, so a catch-up at the limit of 10,000 did a quadratic number of
comparisons (SM-1643).

Migration 0081 (`0081-bound-the-dense-cron-evaluation.sql`) moves the schema to version 80. After
it, the function reads the UTC offsets of the zone near the durable position and near `now`. It
resolves only the wall-clock times whose instants can fall in the window. It removes duplicate
instants with one set operation. The occurrences, their order, the daylight-saving rules, and the
catch-up limits do not change.

The migration does not raise the SDK compatibility floor. No SDK statement changes. The migration
changes no stored data.

### Worker readiness waits for startup, and failed heartbeat rounds have a counter

A worker process reported ready on `/readyz` as soon as it started its workers. A worker that then
failed its startup check, for example on an incompatible schema, gave a short ready interval. Now
readiness returns 503 with `{"status":"starting"}` until every worker has the reserved heartbeat
connection, a compatible schema, and its first registration write. A pause does not change
readiness: a paused process stays ready, and the body adds `"paused":true` while every worker is
paused (SM-1669).

A heartbeat round that failed before PostgreSQL answered left no log record and no metric. Now the
TypeScript worker counts each such round in the new counter
`workhorse.worker.heartbeat.round_failure`, by the bounded attribute
`workhorse.heartbeat.failure_reason`: `timeout`, `connection`, `database`, or `other`. A failed
round still gives no ownership verdict, so `workhorse.worker.heartbeat.failure` does not change.
The other SDKs do not record the counter yet. The new instrument is an addition.

### The dashboard server names a mutation that the host does not provide

A writable dashboard host that wired no controller for a mutation answered "This dashboard is
read-only". Now it answers `FORBIDDEN` with the message "This dashboard host does not provide the
<action> action". A read-only host keeps its message. The code and the HTTP status 403 do not
change.

If a bounded dashboard read failed and its `ROLLBACK` also failed, the server released the client
to the pool for reuse. Now it releases the client with the `ROLLBACK` error, so that the pool
destroys it. The caller still gets the original read error.

### TypeScript schedule sync reads the current payload contract from PostgreSQL

A schedule stores the payload contract version, size limits, and redaction keys of its task type.
Before this change, `Queue.syncSchedules` used the payload contract that the queue had cached, or a
local payload contract definition. If an operator overrode the current version after the cache
filled, the schedule stored the old version. Each occurrence then fired with the old redaction keys
(SM-1652).

Now `syncSchedules` reads the current payload contract of each task type once from PostgreSQL, as
the other SDKs do. If PostgreSQL has no payload contract for a task type, the schedule stores no
contract version, even when the queue has a local definition. Call `syncContracts()` before
`syncSchedules()` to store local definitions first. No schema change is required.

### An idempotent replay matches from any session time zone

An enqueue idempotency key binds a fingerprint of the request. Before this change, the fingerprint
stored `runAt` and `deadline` as text in the session `TimeZone`. A caller sent an exact replay
from a session with a different `TimeZone`. Then Workhorse raised SQLSTATE `P1001`, although both
requests named the same instants (SM-1641).

Migration 0080 (`0080-compare-the-enqueue-fingerprint-instants-as-values.sql`) moves the schema to
version 79. After it, Workhorse stores each instant as UTC text with microsecond precision. It
compares `runAt` and `deadline` as instants. A fingerprint stored before the migration keeps its
offset in the text, so a replay matches it until its retention ends. A different instant still
raises `P1001`. A debounce replacement stores its fingerprint in the same form. An omitted `runAt`
stays omitted.

The migration does not raise the SDK compatibility floor. No SDK statement changes. The migration
changes no stored data.

### Dashboard status labels are static, and the theme has a System option

Before this change, each status label in the dashboard was a live region. On a list of 100 tasks,
a refresh could make a screen reader announce each changed row (SM-1662). The dashboard also had
smaller accessibility problems (SM-1672).

- Status labels are static text. A refresh does not announce changed rows. The dashboard keeps a
  live region only for the connection state, a failed refresh, and a copy result.
- The queue, budget, and System queue tables give each explanation as text. A focusable tooltip
  shows it by pointer, keyboard, and touch. No paragraph has an `aria-label`.
- The task and event drawers have one heading each. The resize separator is outside the heading.
- Warning and danger text, and light badges in the light theme, have a contrast ratio of at least
  4.5:1 in both themes.
- The color theme control adds System. While System is selected, the dashboard follows the
  browser setting. The dashboard stores the theme only when the user selects an option.
- `@stablemates/workhorse-dashboard` exports `DashboardThemePreference`. The value of
  `useWorkhorseTheme` adds `preference` and `setPreference`, and keeps `scheme` and `setScheme`.

### Partition preparation no longer blocks lifecycle transitions behind a reader

Partition preparation creates the next daily partitions of `task_event` and `attempt_history`. It
locks both parent tables in `ACCESS EXCLUSIVE` mode. Before this change, that lock request had no
wait limit. If a long reader, such as `pg_dump`, held a parent table, every claim, completion, and
enqueue that writes history waited behind the request. When PostgreSQL granted the locks,
`run_maintenance_v1` kept them through retention and terminal cleanup. Retention also kept the
parent locks of a dropped partition through terminal cleanup (SM-1640).

Migration 0079 (`0079-bound-the-history-partition-lock-waits.sql`) moves the schema to version 78.
After it, each lock request of partition preparation waits at most 250 ms, as partition retirement
does. If a lock stays busy, the routine defers the day and does not fail. The returned
`history_partitions` row sets `skippedLock`, the recorded run has the outcome `incomplete` and names
the `deferredDay`, and the next pass creates the day. `run_maintenance_v1` now runs history
retention and partition preparation after terminal cleanup and registry cleanup. Thus the call
commits directly after the partition DDL. Partition retirement takes both parent locks in the
documented order, `attempt_history` before `task_event`. Terminal cleanup now uses the retention
watermark of the previous pass, which delays it by one pass on the day that retention runs.

The row order of `run_maintenance_v1` changes: `history_partitions` and the retention phases now
come after `worker_registry`. The set of phases does not change. The DDL phases run last, so their
parent locks end when the call commits. No SDK reads the rows by position.

The migration does not raise the SDK compatibility floor. No SDK statement changes. The migration
changes no stored data.

### Each diagnosed error also carries its details in HINT

Before this change, SQLSTATE `P1001` to `P1010`, apart from `P1004`, carried their structured
fields only in DETAIL. Npgsql, the .NET driver, hides DETAIL unless the connection string sets
`Include Error Detail=true`. That setting also shows the row values of every other DETAIL on the
data source (SM-1638). Migration 0078 (`0078-copy-the-diagnostic-details-into-hint.sql`) moves the
schema to version 77. After it, each of these errors also sets HINT to the same JSON text as DETAIL.
`P1004` carries neither field. DETAIL does not change and stays the authoritative field, so the
TypeScript, Python, Go, Rust, Ruby, and JVM SDKs keep their behavior. The C# SDK reads HINT when
Npgsql hides DETAIL.

The migration does not raise the SDK compatibility floor. No SDK statement changes. The migration
changes no stored data.

### Workers on one pool renew their leases in one transaction

On the dedicated heartbeat connection, a round sent one transaction for each worker and each 100
leases. Each transaction needs at least 3 round trips to PostgreSQL. With 8 workers on one pool and
80 ms for each round trip, workers lost leases while PostgreSQL still answered (SM-1631). Now the rounds that wait for the connection share one transaction, with one `heartbeat_pool_v1` statement for every worker and every 100 leases. The round that leads the transaction takes every waiting round whose deadline is not earlier than its own. The
transaction locks the task rows of every worker in it until its `COMMIT`. A round renews all of its
leases or none. The settings statement now sets `statement_timeout` and
`idle_in_transaction_session_timeout` each to one quarter of the time that remains, not to one half
and one eighth. The statement needs no schema change. The `sharedHeartbeats` opt-out does not change (SM-1633).

### The dashboard Queues page switches a queue's tier and history

Before this change, an operator on the Queues page saw the tier and history of each queue. To
change them, the operator had to leave the page for `workhorse admin set-tier` and `set-history`
(SM-966).

- `dashboard/v1` adds the mutations `setQueueTier` and `setQueueHistory`. They call
  `Admin.setQueueTier` and `Admin.setQueueHistory`, so `set_queue_tier_v1` keeps every guard.
  Each has the bounded audit attribution and the same-origin check. `setQueueTier` requires a
  reason.
- `setQueueTier` answers `status` `set`, `live_tasks`, `concurrency_policy`, or
  `rate_limit_policy`. A refused switch changes nothing, and the Queues page names the guard.
- `setQueueHistory` changes the settings that the request names and keeps the other.
- `DashboardQueueController` adds the optional `setQueueTier` and `setQueueHistory`, and
  `createDashboardOperatorControllers` implements them. The two procedures are optional in
  `DashboardClient`. If a client does not have one, the Queues page shows the action disabled with
  the reason.
- All six dashboard hosts implement both procedures. No schema change is necessary.

### The Go release script reuses the main CI run of the candidate

Before this change, `scripts/release-go.sh` always ran the full `pnpm check`, which repeats every
SDK suite that the main CI run of the candidate already passed (SM-1564).

- If the candidate has a successful `CI` push run on `main` for its exact SHA, the script prints
  the run URL and runs only the Go checks. Otherwise it runs the full `pnpm check`, as before.
- Every refusal of the script stays.

### One protocol fixture holds the checkpoint fingerprint vectors

Before this change, each SDK test kept its own copy of the checkpoint input fingerprint vectors. No
vector had a quote, a backslash, a control character, or a lone surrogate. Thus two SDKs could
write an escape differently and give different digests, and no test found it (SM-1431).

`protocol/v1/checkpoint-fingerprints.json` now holds the vectors. Each vector has an input as JSON
text and an expected digest or an expected refusal. The vectors cover escapes, control characters,
key order above U+FFFF, number forms, exponent limits, integer limits, lone surrogates, and the
SM-1272 key case. The tests of all six SDKs read the file directly. No digest changes.

### `workhorse init` writes a Prisma 7 client on Prisma 7

Before this change, `workhorse init` always wrote the Prisma 6 constructor
`new PrismaClient({ datasources: ... })`. Prisma 7 has no `datasources` option and requires a
driver adapter. Thus a worker file that `init` wrote for a Prisma 7 project failed when it started
(SM-1590).

- `init` now reads the major of the installed `@prisma/client`. On Prisma 7, the worker file creates
  the client with `PrismaPg` from `@prisma/adapter-pg`. It keeps the same `pool` and `close`.
- If `@prisma/adapter-pg` is not installed, `init` prints the command that installs it.
- On Prisma 6, the worker file does not change. If `init` cannot read the installed version, it
  writes the Prisma 6 file and prints a note.

### A checkpoint input fingerprint does not depend on earlier JSON parses

Before this change, `checkpointInputFingerprint` wrote the input with `JSON.stringify` and read it
again with `JSON.parse`. On Node 24 and 26, `JSON.parse` can read an escaped object key as a key that
an earlier parse made (nodejs/node#63785). If a process first took the fingerprint of
`{ orderId: 7, "\\": 1 }`, the input `{ orderId: 7, '"': 1 }` then got the same fingerprint. Thus a
replay could miss an input conflict, or report a conflict for the same input (SM-1272).

`checkpointInputFingerprint` still writes the input with `JSON.stringify`. It now reads that text
with its own reader, not with `JSON.parse`. Each fingerprint that was correct does not change, and
each input that was refused is still refused.

### The Prisma adapter supports Prisma 7

Before this change, `@stablemates/workhorse-prisma` declared `@prisma/client >=6 <7`. A project on
Prisma 7 could not install it without a peer warning, and CI did not test Prisma 7 (SM-840).

- The peer range is now `@prisma/client >=6 <8`. Adapter conformance runs on Prisma 6 and on
  Prisma 7 in each CI run.
- Prisma 7 reports the PostgreSQL error of its driver adapter in `meta.driverAdapterError`. The
  error-code search of `@stablemates/workhorse` now follows that key and reads `originalCode` when
  an error has no `code`. Thus `PrismaQueryError.code` is the SQLSTATE on Prisma 7, and Workhorse
  conflicts keep their own error classes. On Prisma 6, nothing changes.
- `workhorse init` still writes the Prisma 6 constructor. SM-1590 adds the Prisma 7 form.

### A worker on a pool that hides its size polls under the opt-out

Before this change, a worker with `sharedHeartbeats: true` started the shared listener on a pool
that has `connect()` and no `options.max`. If that pool had only one connection, the listener held
it. Registration and claims then waited for the pool timeout, and no task ran (SM-1585).

Now, with `sharedHeartbeats: true`, the worker starts the listener only when the pool reports an
`options.max` of at least 2. Otherwise the worker polls. The `workhorse.worker.polling_only`
warning now also carries `workhorse.worker.pool_max_size`: the size that the worker found, or
`unknown`. A pool that reports its size does not change. Without the opt-out, the `Worker`
constructor still refuses a pool whose size is unknown.

### A contract compares a stored schema number with all its digits

Before this change, the TypeScript SDK read a stored contract schema into doubles. Another SDK can
store `"maximum": 9007199254740995`, which a double cannot hold. The TypeScript SDK then compared a
result with `9007199254740996` and accepted that result. Now the SDK reads the stored schema as
jsonb text and keeps each schema number exact (SM-1541, ADR 0039). `minimum`, `maximum`,
`exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `const`, and `enum` compare the exact
decimals. An application schema that you give in `contracts` does not change, because its numbers
are already doubles.

### A worker waits for its heartbeat connection before it claims

Before this change, a TypeScript worker started the reservation of its dedicated heartbeat
connection and did not wait for it. If the pool could not lend that connection, the worker still
claimed tasks, and it could not renew their leases. If the connection failed later, the worker
continued to claim (SM-1575, ADR 0071).

These rules apply to a worker that uses the dedicated heartbeat connection. Nothing changes under
`sharedHeartbeats: true` or with a custom `WorkerQueueApi`.

- `Worker.run()` waits for the heartbeat connection for `max(heartbeatMs, 5 s)`. Then it borrows
  one more connection from the pool, runs the schema compatibility query on it, and returns it at
  once. If a step fails in that time, `run()` rejects. The error names the pool, the time, and the
  opt-out `sharedHeartbeats: true`. A schema that the worker does not support rejects with
  `SchemaCompatibilityError`.
- `runOnce()` waits for the heartbeat connection for the same time before it claims. If the
  connection does not arrive, `runOnce()` rejects and claims nothing.
- While the heartbeat connection is lost, the worker claims no task. A fast-tier completion then
  claims nothing. The worker reads this state again after a claim gets its pooled connection,
  immediately before each attempt, so a claim that waited for a connection during the loss does not
  run. The worker's claim statements therefore borrow a client with `connect()` from the pool of the
  heartbeat connection, and run on it. On a node-postgres `Pool`, this is what `pool.query()` does
  internally, but code that wraps `pool.query()` no longer sees these statements. On an ORM adapter,
  they run on the attached pool, not through the ORM. Instrumentation of `Client.query()` still sees
  them. A failed heartbeat round does not stop claims. The worker asks the pool for a
  replacement at once, and tries again with a backoff of at most `heartbeatMs`, also while no task
  runs. When the replacement arrives, claims start at once.
- The startup time also bounds the compatibility query. `stop()` ends the startup waits of `run()`
  and the wait of `runOnce()` at once.
- A connect that arrives after its wait ended has one owner. The next wait on the pool takes it, so
  repeated timeouts do not queue more connects in the pool.
- After its handlers and its claims in flight end, `run()` resolves within `max(heartbeatMs, 5 s)`,
  also when the pool lends no connection.
- A later `run()` or `runOnce()` of the same worker waits until every stop-path statement of the
  ended run has settled, within `max(heartbeatMs, 5 s)`. If one has not settled, it refuses to
  start. Before this change, a late deregistration of the ended run could delete the registry row
  and the pause state of the new run. Each `run()` now writes its first registration at once.
- A heartbeat connection that the worker destroys keeps its error listener until the connection
  ends. Before this change, a late PostgreSQL error on that connection, such as `25P03`
  (idle-in-transaction timeout), reached pg-pool. A pool without an `error` listener then ended the
  process.

**Behaviour change.** A worker that cannot reserve its heartbeat connection within the startup time
now ends its run. Before this change, the run continued. A pool that is still warming up does not
cause this, because the worker tries again within the startup time.

The declarations of the package-internal `WorkerHeartbeatChannel` gain readiness members. The
package does not export that type or the symbol that returns it, so application code does not
change.

### Throttle works on a fast-tier queue

Before this change, a throttled enqueue into a fast-tier queue raised `FastTierUnsupportedError` with the feature
`throttle`. Throttle only decides if Workhorse accepts an enqueue request, so it needs no state of
the full tier (SM-928, ADR 0077). Migration 0075
(`0075-allow-throttle-on-fast-tier-queues.sql`) moves the schema to version 74. After it,
`enqueue_throttle_v1` and `enqueue_many_v1` accept throttle on a fast-tier queue. The outcomes are
`accepted` and `coalesced`, as on the full tier.

A coalesced request on a fast-tier task writes no `throttled` event, because a fast-tier task
records only the history that its queue enables. The SDK still emits the throttle log and the
enqueue outcome metric. In a batch with a debounce or a throttle member, a fast-tier rejection of
one member now reports the position of that member in the batch. Debounce on a fast-tier queue is
still rejected.

The migration does not raise the SDK compatibility floor. No SDK statement changes. The migration changes no stored data.

### The retention preview reads through a dashboard function

Before this change, each dashboard host read the retention policy, sent a shared statement that
counted rows directly in the tables, and capped the counts in its own code. ADR 0040 asks for one
SQL implementation for each dashboard procedure (SM-1478). Migration 0076
(`0076-add-the-dashboard-retention-preview-function.sql`) moves the schema to version 75 and adds
`dashboard_retention_preview_v1`. The TypeScript dashboard host and `Queue.previewRetentionPolicy`
now call it. The `previewRetentionPolicy` response does not change. If a setting in the definition
of `Queue.previewRetentionPolicy` is `undefined`, it now keeps its current value, as an absent
setting does. Before, it disabled its category.

Every SDK statement catalogue names the new function, so the SDK compatibility floor rises from
schema 73 to 75. Run `workhorse schema migrate` before the first process of this release starts.
A 0.9 process keeps working on schema 75. The migration changes no stored data.

### A late worker deregistration cannot delete the row of a later run

Before this change, a worker that stopped sent `deregister_worker_v1`, which deletes the registry
row by worker ID only. If the stop path was slow and the same worker ID started again, the late
deregistration could delete the row of the new run and its operator pause state. Each SDK guarded
against this in its own code (SM-1589). Migration
0077 (`0077-fence-the-worker-deregistration-by-instance.sql`) moves the schema to version 76 and
adds `deregister_worker_v2`. It deletes the row only while the row names the instance of the run
that stops. `deregister_worker_v1` does not change.

The TypeScript `Worker` now calls `deregister_worker_v2` with the instance of the run that stops.
A `Worker` now announces a new instance at each `run()`, as the other SDKs do. Before, it kept one
instance for its lifetime. Then the fence could not tell the first `run()` of an object from a
second `run()` of the same object. `Queue.deregisterWorker` takes an optional `instanceId`. With
it, the call uses `deregister_worker_v2`. Without it, the call is not fenced and uses
`deregister_worker_v1`, as before.

Each SDK keeps its guard for this release: a new run still waits for the stop statements of the
previous run, or it refuses to start. Every SDK statement catalogue names the new function, so the
SDK compatibility floor rises from schema 75 to 76. Run `workhorse schema migrate` before the first
process of this release starts. A 0.9 process keeps working on schema 76. The migration changes no
stored data.

## 0.9.0 — 2026-10-20

The npm packages, Python distribution, Go module, Rust crate, Ruby gem, and JVM artifacts release from one source commit.

Requires **schema v73**, Node.js **22** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** Run `workhorse schema migrate` before any
process of this release starts, producers too. Migrations 0073 and 0074 move the schema to version
**73**. The SDK compatibility floor rises from 69 to **73**, because every SDK statement catalogue
now names `heartbeat_many_v2` and `heartbeat_v2`. An updated process refuses a schema below version
73 at startup. A 0.8 process keeps working on version 73, because a migration inside a major line
only adds.

### Heartbeats do not wait for a locked task row

Before this release, a heartbeat waited for a task row that another transaction locked. If a
settlement held the row, the heartbeat then kept the row locked after the settlement committed, and
a claim skipped the ready task (SM-1434). The worker now renews leases through `heartbeat_many_v2`
(SM-1443, ADR 0105). It skips a locked row and reports that lease as `busy`: no renewal and no
ownership verdict. The worker keeps a busy lease, retries only the busy leases after a short delay
with jitter, and does not move the regular heartbeat schedule. A busy answer never extends the local
lease watchdog, so a lease that stays busy until the watchdog ends is lost, as before. Old and new
workers can run together: an old worker keeps calling `heartbeat_many_v1`, which does not change.

**Breaking (TypeScript types).** A new type, `HeartbeatBatchStatus`, is `HeartbeatStatus | "busy"`.
`WorkerQueueApi.heartbeatMany` and `WorkerHeartbeatChannel.heartbeatMany` return it. This is a
breaking return change in a 0.x minor. Code that implements `WorkerQueueApi.heartbeatMany` compiles
unchanged. Code that reads its result and checks every status must handle `busy` as "not renewed,
no verdict". The scalar `HeartbeatStatus`, `Queue.heartbeat()`, and `Queue.heartbeatStatus()` do
not change, and they still wait for a row lock. A `Worker` with a custom `WorkerQueueApi` that has
no `heartbeatMany` renews through `heartbeatStatus`, so it never sees `busy`.

**New: `Queue.tryHeartbeat()`.** Migration 0074 adds `heartbeat_v2`, a one-lease successor of
`heartbeat_v1` (SM-1461). It renews one lease by the rule of `heartbeat_many_v2`: it skips a locked
row and reports the lease as `busy`. `Queue.tryHeartbeat(task, workerId, leaseMs?)` calls it and
returns a `HeartbeatBatchStatus`. On `busy`, call it again later. `Queue.heartbeat()`,
`Queue.heartbeatStatus()`, and `heartbeat_v1` do not change. A custom `WorkerQueueApi` should
implement `heartbeatMany` to get the busy retry.

### Heartbeat rounds keep a renewal margin and end on the server

Before this release, the reserved heartbeat connection bounded each heartbeat round by one full
interval. After a failed round, the next round fell due one interval after that round ended. With
the defaults, one timed-out round thus left about 0 s before the lease watchdog expired (SM-1444).
Also, when the worker stopped waiting for a round, PostgreSQL continued to run the heartbeat
statement, and that statement kept its row locks (SM-1442). These changes apply to each round on the
reserved heartbeat connection:

- **Rounds start on a fixed schedule.** A round falls due one interval after the previous round
  started, not after it ended. The schedule uses a monotonic clock. If a round ends after its next
  slot, the worker starts one overdue round at once and sends no round for the other missed slots.
- **The round bound is shorter.** A round ends by
  `max(1 ms, interval × 3 / 4, min(50 ms, interval))`. For an interval of 200 ms or more, this is
  three quarters of the interval. With the defaults (lease 30 s, interval 10 s), the bound is 7.5 s,
  so one timed-out round leaves a margin of 2.5 s. An attempt keeps its lease after one timed-out
  round if `2 × interval + round bound < lease`. The worker does not reject an interval that breaks
  this rule.
- **Each round sets server timeouts.** The round sends `BEGIN`, then one `set_config` statement for
  `statement_timeout` and `idle_in_transaction_session_timeout`, then `heartbeat_many_v2`, then
  `COMMIT`. Both settings are transaction-local. The heartbeat statement gets one half of the time
  that remains, and each idle gap one eighth. If less than 8 ms remains at the settings statement,
  the round fails before the heartbeat. The worker counts a renewal only after a `COMMIT` that ends
  before the deadline. No setting bounds `COMMIT` on PostgreSQL 15 and later.
- **A failed round discards its connection only when a statement may still run** (SM-1492). A
  round that expires before it sends the heartbeat statement rolls back and keeps its connection.
  Under load, PostgreSQL can log
  `canceling statement due to statement timeout` for a heartbeat statement. It can also end the
  session with `terminating connection due to idle-in-transaction timeout`. Each message means that
  one round failed. Every task continues, and the next round tries again. A deadlock (`40P01`) is
  sent again in a new transaction with the time that remains.
- **A busy retry with less than 20 ms left sends nothing** (SM-1492). A bounded busy retry runs
  only if its deadline is at least 20 ms after its start: the 8 ms that a round needs at its
  settings statement, plus a 12 ms margin. Otherwise the next regular round renews the busy leases.
- **Replacement connections.** A failed round now asks the pool for its replacement connection when
  the round ends, so the connect starts before the next round.
- **100 ms is the smallest supported heartbeat interval** (SM-1471). This applies to
  `WorkerOptions.heartbeatMs`: the smallest supported value is 100. At 100 ms, the round bound is 75
  ms. The worker still accepts a shorter interval, and it does not warn. On a loaded host, a shorter
  interval can make each round miss its deadline, and attempts can then lose their leases.

Rounds under `WorkerOptions.sharedHeartbeats` have no client deadline and set no server timeouts, as
before. They follow the new schedule. The [heartbeat round
deadline](docs/architecture/lifecycle.md#heartbeat-round-deadline) and the [heartbeat
schedule](docs/architecture/lifecycle.md#heartbeat-schedule) state each rule.

### A payload contract divides the decimals in `multipleOf`

Before this release, `compileContractSchema` divided doubles in `multipleOf`, so
`{"multipleOf": 0.01}` refused `1.15` (SM-1539). Go, Rust, Ruby, and the JVM accepted it. A contract
now compares the decimal that `JSON.stringify` writes to PostgreSQL, and `multipleOf` divides those
decimals (ADR 0039). A result that `multipleOf` refused for a fraction can now pass. TypeScript
still reads a stored schema constant that a double cannot hold as a double (SM-1541).

### A wrapped durable replay conflict is terminal

Before this release, the TypeScript worker checked only the outermost error for a durable replay
conflict (ADR 0098). If a handler wrapped a conflict in its own error, the worker recorded a
retryable failure, and the conflict repeated until `max_attempts` (SM-1512). The worker now follows
the cause chain of the error, as the Go and Rust workers do. It reads at most 16 errors, so a cyclic
chain cannot stop it. It reads the `cause` property. A wrapped conflict fails the task at once. The
failure envelope records the name of the conflict. Its fields `message` and `stack` stay those of
the outer error.

### A heartbeat round sends at most 100 leases in each statement

`heartbeat_many_v2` accepts at most 100 leases. If the fused completion of a task is rejected, for
example by a cancel request, the attempt keeps its lease registered while it waits for PostgreSQL.
The task that the same statement claimed registers its lease too. A round can then hold more leases
than the concurrency limit. That round raised an error, and no lease in it renewed (SM-1495).
`Queue.heartbeatMany` now sends at most 100 leases in each statement. If one statement fails, the
call fails, and the worker counts no renewal of that round, as before.

### A worker lease is from 100 through 86,400,000 ms

Before this release, the TypeScript `Worker` accepted a `leaseMs` from 1 ms, with no maximum. The
other five SDKs accept 100 through 86,400,000 ms, which is the range of the SQL protocol. The
TypeScript `Worker` now rejects a `leaseMs` outside that range when you construct it (SM-1510).

## 0.8.0 — 2026-10-13

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.
All five SDKs ship task groups and the checkpoint input check in this release.

Requires **schema v69**, Node.js **22** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** The upgrade is a rolling deployment:

1. Run `workhorse schema migrate`. The final schema version is **71**.
2. Roll out the updated processes.

The SDK compatibility floor is schema version **69**, which migration 0070 reaches. The floor rises
from 54. Every SDK statement catalogue now names the task group functions that migration 0066 adds,
and `save_checkpoint_v2`, which migration 0069 adds. The dashboard of each SDK calls
`dashboard_task_groups_v1`, which migration 0067 adds, and `list_newest_task_group_events_v1`, which
migration 0068 adds. Migration 0070 fences a member add, so an updated process does not add tasks to
a group without that check. An updated process refuses a schema below version 69 at startup. A 0.7
process keeps working on version 71, because a migration inside a major line only adds.

Migration 0066 (`0066-add-task-groups-with-completion-callbacks.sql`) adds task groups (SM-1231,
[ADR 0095](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0095-add-task-groups-with-completion-callbacks.md)).
A task group is a set of full-tier tasks that Workhorse tracks as one unit. When the group is
sealed and every member task is finished, Workhorse enqueues its `onFinish`, `onSuccess`, or
`onFailure` callback task. The migration adds the `task_group`, `task_group_member`,
`task_group_callback`, and `task_group_event` tables, and a trigger on `task_outcome` that counts
each member outcome in the transaction that writes it. A queue purge counts a purged member task as
`canceled`. The `terminal_storage` routine keeps member tasks while their group is not finished,
reports a new `task_groups` phase after `terminal_tasks`, and deletes a finished group after its
callback tasks are terminal. New SQLSTATEs: `P1008` (the task group does not accept tasks), `P1009`
(member limit of 100,000), and `P1010` (an enqueue idempotency hit returns a task that is not a
member of the group).

Migration 0067 (`0067-count-task-group-outcomes-in-counter-shards.sql`) counts task group outcomes
in counter shards (SM-1245,
[ADR 0096](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0096-count-task-group-outcomes-in-counter-shards.md)).
Each group gets 32 rows in the new `task_group_shard` table, and a member outcome locks only its
shard row at commit. The outcome locks the group row only when the pending count of its shard
becomes 0. The migration moves the counts of existing groups into the shards. It locks `task_group`
in `EXCLUSIVE` mode while it runs, so task group changes wait for it. The counts on a `task_group`
row stay 0 until the group finishes, so read the counts through `get_task_group_v1`. The migration
also adds `dashboard_task_groups_v1`, which lists task groups one page at a time. The dashboard of
each SDK reads the task group list through it (SM-1237).

Migration 0068 (`0068-read-the-newest-task-group-events.sql`) adds
`list_newest_task_group_events_v1`, which returns the newest events of a task group first
(SM-1254). The task group detail of the dashboard reads its events through it. A group with more
than 1,000 events now shows its newest 100 events. `eventsTruncated` is true when the group has
older events that the detail does not show. `list_task_group_events_v1` does not change. The
migration changes no stored data.

Migration 0069 (`0069-check-the-input-of-a-checkpoint-on-replay.sql`) adds the nullable column
`task_checkpoint.input_fingerprint` and `save_checkpoint_v2` (SM-1211,
[ADR 0098](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0098-check-the-input-of-a-checkpoint-on-replay.md)).
If a checkpoint name exists, `save_checkpoint_v2` returns `input_conflict` when the stored and the
given input fingerprints are both present and differ. `save_checkpoint_v1` now calls
`save_checkpoint_v2` with no fingerprint, so its results do not change. The checkpoint reads of each
statement catalogue return the new column. Existing rows keep a NULL fingerprint. The migration adds
the column without a table scan.

Migration 0070 (`0070-fence-a-task-group-member-add-and-index-the-group-list.sql`) fences a task
group member add (SM-1273). `add_task_group_members_v1` now locks the runtime row of the member task
first, before the shard rows and the group row, as a completion does. Then it refuses the add with
`P1008` and the reason `not_running_member` if the lease of the member task expired, its deadline or
attempt timeout passed, or a cancel was requested. Before, a worker whose lease expired could add
tasks after Workhorse gave the member task to a new worker. The signature does not change. The
migration also adds `task_group_state_created_idx`, so `dashboard_task_groups_v1` reads one page of
a state without a read of the groups of other states. The migration is a non-transactional step: it
builds the index with `CREATE INDEX CONCURRENTLY`, so writes to `task_group` continue. If it fails
part-way, drop the invalid index before the rerun, as `docs/schema-lifecycle.md` describes. It
changes no stored data.

Migration 0071 (`0071-lock-purged-runtime-rows-in-identity-order.sql`) makes a queue purge lock its
tasks in identity order (SM-1282). Before, `purge_queue_internal_v1` locked the runtime rows and the
task rows of the queue in scan order. An enqueue that named two of those tasks as prerequisites
locks them in identity order. Thus the purge and the enqueue could wait for each other, and
PostgreSQL aborted one of them with `40P01`. The purge now locks every runtime row, then every task
row, each in identity order. The signature and the deleted count do not change. The migration does
not raise the SDK compatibility floor, because no SDK statement changes and every process gets the
new lock order when the migration commits. It changes no stored data.

Migration 0072 (`0072-purge-a-queue-that-holds-a-prerequisite-of-a-live-dependent.sql`) lets a
queue purge succeed when it holds a prerequisite of a waiting dependent (SM-1284,
[ADR 0101](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0101-cancel-a-purged-prerequisite-whose-dependent-stays.md)).
Before, the purge deleted that prerequisite, and PostgreSQL refused the delete with `23001`. The
whole purge then failed, also when the dependent was in the same queue. Now the purge deletes a
dependent in the same purge with its prerequisite. If the dependent stays, for example in another
queue, the purge cancels the prerequisite instead of a delete. The dependent's own
`on_cancellation` policy then decides its outcome, as after a cancel. The canceled task keeps its
history and its keys. The purge count, `deleted_count` and `deletedCount`, includes the canceled
tasks. The purge locks the dependents after its own tasks, as a cancel does, so it has no
deadlock that a cancel of the same tasks does not also have. Two purges run one after the
other, also for different queues. The migration does not raise the SDK compatibility
floor, because no SDK statement or result shape changes. It changes no stored data.

TypeScript `HandlerContext.checkpoint` gains the option `input` (SM-1211). The worker stores the
fingerprint of the input with the result. If a later call gives an input with a different
fingerprint, the task fails at once with `CheckpointInputConflictError`, and the operation does not
run. If the call or the stored checkpoint has no input, the call compares nothing.
`checkpointInputFingerprint` returns the SHA-256 digest of the RFC 8785 canonical JSON of an input.
Every SDK refuses the same inputs (SM-1274). `checkpointInputFingerprint` raises a `TypeError` for a
value that is not JSON, a non-finite number, a string or key with a lone surrogate, or a `Number`
larger than `Number.MAX_SAFE_INTEGER` in magnitude, such as `2 ** 53` or `1e21`. A `Number` cannot
show if an integer was rounded before the call, so the limit applies to every number.
`TaskCheckpoint` gains `inputFingerprint`, and `Queue.saveCheckpoint` accepts `inputFingerprint`.
`replayHandler` compares the `inputFingerprint` of a stored checkpoint in the same way. The Python,
Go, Rust, and Ruby SDKs ship the same check in 0.8.0. Their changelogs give the details.

TypeScript `Queue` gains `createTaskGroup`, `addToTaskGroup`, `sealTaskGroup`, the block form
`taskGroup`, `getTaskGroup`, `listTaskGroupMembers`, and `findTaskGroup`. The block form creates,
adds, and seals in one transaction. A handler reads its group through `ctx.taskGroup.get()`, and a
running member task adds tasks through `ctx.taskGroup.add()`. If a request names no queue, `add()`
puts the task in the queue of the member task, not in the `defaultQueue` of the `Queue` (SM-1251,
[ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)). `Admin` gains `getTaskGroup`,
`listTaskGroupMembers`, `listTaskGroupEvents`, `cancelTaskGroup`, `listTaskGroupDrift`, and
`repairTaskGroupDrift`. `MaintenancePhase` gains `task_groups`. The Python, Go, Rust, and Ruby SDKs
ship task groups in 0.8.0. Their changelogs give the details.

TypeScript task group reads return the callbacks and the last member page as the documentation
states (SM-1277). `TaskGroup.callbacks` lists the requested callbacks in the order `onFinish`,
`onSuccess`, `onFailure`. Before, the list had the key order of the PostgreSQL `jsonb` object, for
example `onFinish`, `onFailure`, `onSuccess`. `listTaskGroupMembers` of `Queue` and `Admin` returns
`nextAfter: null` on the last page, also when the page is full. Before, a full last page gave a
`nextAfter` that read an empty page. A full page now costs one more read of one member.
`workhorse admin task-group` takes its `nextAfter` from `Admin.listTaskGroupMembers`. The change adds
no SQL function and no migration.

TypeScript gains `replayHandler` (SM-1210). A test can run new handler code against the stored
durable state of a task before a deployment, without a database or a worker. The state is a plain
JSON `DurableState` value with stored checkpoints, timer waits, signals, human decisions, and
children. The replay raises `HandlerReplayError` when the code asks for a new name before a stored
name, or when a wait, human decision, or child request conflicts with the stored request. It
reports the replayed, new, and unused names. The change adds no SQL function and no migration.

The `workhorse admin` CLI gains three task group commands (SM-1257). `task-groups` lists task
groups newest first, with an optional `--state`, `--limit`, and `--page`. `task-group <group-id>`
shows the group, one page of its member tasks after `--after`, and its newest 100 events.
`cancel-task-group <group-id>` cancels a group through `Admin.cancelTaskGroup`. It is a guarded
command, so it requires `--env`, a confirmation, and `--reason`. If the group is already finished,
the command reports `already_finished` and exits with 1. Each command has a `--json` form. The
protocol manifest adds `dashboard_task_groups_v1` and `list_newest_task_group_events_v1` to the
admin statements. The change adds no migration.

`createDashboardHost` gains the option `workhorseRevision` (SM-1215). It is the Git commit that a
host was built from, such as a deployment of `main`. The dashboard shows its short form beside the
version and links it to the commit. The value must be a hexadecimal commit hash of 7 to 64
characters, or `createDashboardHost` raises a `TypeError`. The runtime config of the dashboard
gains the optional field `workhorseRevision`. A host without the option shows the dashboard as
before.

### Behaviour changes

- If a child task request names no queue, TypeScript puts the child in the queue of the parent task
  (SM-1260, [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)). This applies to `runChild`, `runChildren`, and `runChildrenAll` of
  `HandlerContext`, and to `Queue.createChild`, `Queue.createChildren`, and
  `Queue.createChildrenAll`. Before, the child went to the `defaultQueue` of the `Queue`. If no
  worker served that queue, the child stayed `ready`, and the parent task did not continue. To keep
  the old queue, name it on the request, for example `{ queue: "default" }`.
  A parent task that created a child before the upgrade can replay that request after the upgrade.
  If the replayed request names no queue, it keeps the queue of the stored child, so the parent
  task joins its child.
- `Worker.runOnce()` returns `false` when it released every task that it claimed (SM-1259,
  [ADR 0099](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0099-report-a-released-only-single-pass-as-no-progress.md)). A worker releases a task when it has no handler for the task type.
  Before, `runOnce()` returned `true` for that pass. After that pass or a pass that claimed no task,
  a second call inside `pollMs` returned `false` without a claim. Now the worker keeps no state between calls, so the next call claims at
  once. `pollMs` no longer changes `runOnce()`. If you call `runOnce()` in a loop, wait after
  `false`. The Python, Go, Rust, and Ruby workers already return `false` for that pass.
- A continuous worker that released every task of a claim now waits for its next poll before it
  claims again (SM-1247). A worker releases a task when it has no handler for the task type, for
  example during a rolling deployment. Before, the release notification ended the empty wait of the
  same worker, so it claimed the task again after 0 to 50 ms. One listening worker released one task
  about 30 times each second. Now a notification does not end this release wait. Only its deadline,
  a stop, or a pause ends it. The deadline is the poll interval while the listener is active, or the
  poll backoff without a listener. Thus a worker claims a task that it cannot run at most once in
  each poll interval. The workers of all five SDKs make this change.
- A dashboard mutation refuses an `audit.requestId` of more than 512 UTF-8 bytes with `BAD_REQUEST`
  (SM-1253). The dashboard measures the value as sent, before trim. Before, the input check accepted
  it, the SQL audit function refused it, and the client got an internal server error. The dashboard
  hosts of all five SDKs make the same check before any SQL runs.

## 0.7.1 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**0.7.1 exists because the npm publish of 0.7.0 stopped partway.** Five packages published at
0.7.0: `@stablemates/workhorse`, `@stablemates/workhorse-dashboard-contract`,
`@stablemates/workhorse-dashboard-server`, `@stablemates/workhorse-dashboard`, and
`@stablemates/workhorse-drizzle`. They are deprecated in favour of 0.7.1. The knex, kysely, otel,
prisma, and typeorm packages never published at 0.7.0. The Python 0.7.0 distribution is on PyPI and
is not defective, and 0.7.1 supersedes it. The Go module, Rust crate, and Ruby gem never published
at 0.7.0. No package changes its code, so the [0.7.0 notes](#070--2026-10-09) describe what 0.7.1
ships. Every package releases at 0.7.1 to keep one version across the registries
([ADR 0050](docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).

**A 0.7.0 database needs no migration.** 0.7.1 adds no migration, so the final schema version is
**64** and the SDK compatibility floor stays at schema version **54**. An installation on 0.6
follows the [0.7.0 upgrade steps](#070--2026-10-09).

## 0.7.0 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.
This release adds `@stablemates/workhorse-knex`, so ten npm packages now release together.

Requires **schema v54**, Node.js **22** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** The upgrade is a rolling deployment:

1. Run `workhorse schema migrate`. The final schema version is **64**.
2. Roll out the 0.7 processes.

The SDK compatibility floor is schema version **54**, which migration 0055 reaches. A 0.7 process
refuses a schema below version 54 at startup. A 0.6 process keeps working on version 64, so a mixed
fleet is supported during the rollout. Each migration commits on its own, and each SQL change below
takes effect when its migration commits.

**Check a 0.6 TypeScript `retryDelayMs` callback before migration 0055 commits.** That migration
makes `fail_v1` read a retry delay of -1 as a terminal failure. A 0.6 TypeScript worker sends a
callback's result unchecked, so a callback that returns -1 fails its task without a retry. A 0.7
worker throws before `fail_v1` instead (SM-1164). The Python, Go, Rust, and Ruby workers of 0.6
never send a negative delay.

**Migration 0059 clears incomplete rate settings.** A per-key rate limit or a budget rate with one
or two of its three fields null used to pass its CHECK constraint. The migration clears such a
setting before it adds the stricter constraints. It deletes a budget that the clearing leaves
without a limit, because a missing budget row imposes no limit. After the migration, PostgreSQL
rejects a synchronization that writes an incomplete rate setting. To keep a limit the migration
cleared, complete it in your synchronized definitions and synchronize after the migration.

**Accept the new `terminal-cleanup-backlog` health reason.** Queue health can now report it as
degraded, so code that switches on reason codes should accept it. Its budget,
`terminal_cleanup_backlog_ms`, starts from your `row_retention_lag_ms` setting, so existing alerts
evaluate as before. After migration 0065 the two budgets are independent. Set the new one with
`sync_queue_health_policy_v2` or `override_queue_health_policy_v1`.

**Update `dashboard/v1` clients that read `humanWait.context` from a task listing.** The
[breaking change](#breaking-changes) below removes it from `dashboard.tasks` and
`dashboard.tasksCursor` rows. Read it from `dashboard.taskDetail`.

**Handler authors: a durable replay conflict now fails its task on the first occurrence.** The
[behaviour changes](#behaviour-changes) below describe it. A 0.6 worker still retries a conflict
under the task's retry policy until the 0.6 processes are gone.

### Breaking changes

- **`dashboard/v1`:** `dashboard.tasks` and `dashboard.tasksCursor` rows no longer carry
  `humanWait.context`. They carry `humanWait.quickAction`, which is `{ label }` or `null`, so
  polling a listing no longer sends up to 64 KiB of decision context per row.
  `dashboard.taskDetail` still returns the full context, and the dashboard reads it before
  confirming a quick action. The break is taken in place under the ADR 0064 exception in
  [`docs/compatibility.md`](docs/compatibility.md), and the published `openapi.json` changes with
  it. In the TypeScript packages, `DashboardTaskRow.humanWait` becomes `DashboardTaskRowHumanWait`.
  `TaskActionTarget.humanWait` becomes `TaskActionHumanWait`, whose `context` is optional (SM-1171).

### Behaviour changes

Durable execution:

- Durable checkpoint, timer, child, child-set, and human-decision replay conflicts fail the task on
  their first occurrence. The worker preserves the current attempt and records the conflict class.
  Before, a conflict retried under the task's retry policy, and every retry met the same conflict.
  Redaction still hides error details. Transient failures, lease loss, child-limit errors, and
  already-waiting signal errors keep their existing behaviour. Conflict settlement bypasses the
  worker's `retryDelayMs` callback (SM-1107, migration 0055).
- A renamed individual child on replay raises `ChildConflictError` with the stored and requested
  names. Its constructor takes an optional `storedChildName`. Before, it raised a child-limit
  error. A second child after joining the retained child in the same handler run still exceeds the
  child limit (SM-1106, migration 0054).
- A `retryDelayMs` callback must return `undefined` or a safe integer from 0 through
  2,147,483,647. Any other result throws before `fail_v1`. Before, a computed `-1` reached
  `fail_v1`, which reads it as a terminal failure (SM-1164).

Worker process:

- A dedicated worker process reports a fatal worker error when the worker first observes it.
  Readiness turns false and the failure deadline starts before active handlers drain. A handler
  that ignores cancellation no longer keeps `/readyz` at 200 or the process alive. The failing
  worker also stops its maintenance and registration loops at once (SM-1161).
- The worker measures lease windows and expiry timers on the monotonic clock, so a worker wall clock
  that runs ahead or jumps backward moves neither. It counts the deadline and attempt timeout from
  the database time of the claim. It aborts the handler only after `expire_owned_v1` confirms the
  expiry, and a `not_due` answer keeps the handler running. A claim answer that arrives after its
  lease window has run out no longer starts the handler (SM-1163).
- A handler whose deadline or attempt timeout PostgreSQL confirms always sees
  `DeadlineExceededError` or `ExecutionTimeoutError` as its abort reason. Before, a `stale`
  heartbeat answer that arrived first aborted it as a lost lease. A real lease loss still aborts
  with the lease-loss error (SM-1195).
- Checkpoint and progress writes reject `NaN` and the infinities at any depth with a `TypeError`,
  because JSON would store them as `null`. Worker intervals and the metrics observer's
  `intervalMs` reject values above 2,147,483,647 ms, which Node's timers would run every
  millisecond (SM-1169).

Maintenance and health:

- Terminal cleanup repeats its batch while each one fills, for up to one second per pass. A pass
  that still ends with a full batch makes its follow-up due five seconds later, not after the
  five-minute interval. Full-tier and fast-tier tasks share every batch. Expect more cleanup work
  per pass while a backlog lasts (SM-1160, migration 0058).
- `tick_v1` runs the expired-lease scan only when no tick ran it within half the shortest
  maintenance interval of the live registered workers. Promotion and the deadline and timeout scans
  still run on every tick. A worker that opts out of the registry does not shorten that spacing, so
  recovery of an expired lease can wait for the spacing plus one interval of the fastest
  unregistered worker. [Maintenance cadence](docs/architecture/lifecycle.md#maintenance-cadence)
  explains how to restore the shorter bound (SM-1167, SM-1192, migration 0061).
- Row retention lag counts from the scheduled history pass that released the row, when that pass
  came after the row window. Health no longer reports task records and finished results as late
  after every daily pass (SM-1134, migration 0056).
- Queue health raises the degraded reason `terminal-cleanup-backlog` once
  `terminal_cleanup_backlog_since` is older than its budget. `Queue.health()` returns the backlog
  start as `terminalCleanupBacklogSince` and the budget as `budgets.terminalCleanupBacklogMs`.
  Against a schema older than 64, it reports `rowRetentionLagMs` there, the budget those schemas
  apply (SM-1178, SM-1197, migrations 0063 and 0065).

Administration:

- `run_task_now_v1` reports `not_scheduled` for a blocked task instead of raising an error
  (SM-1165, migration 0059).
- A synchronization that changes a rate refills each changed bucket at the old rate up to one clock
  reading. The new rate applies from that reading (SM-1165, migration 0059).
- An update can no longer change a dependency edge's endpoints or outcome policies (SM-1165,
  migration 0059).
- A full-tier task that a worker without a handler returned through `release_owned_v1` can be
  canceled. Deadline recovery terminalizes it instead of rolling back the whole recovery pass. Both
  close it like never-started work, with no attempt history row (SM-1158, migration 0057).

Telemetry:

- `WorkhorseMetricsObserver` and `registerQueueMetrics` count fast-tier tasks, so queue gauges rise
  on an installation that uses the fast tier. A fast-tier ready task with a future run time counts
  as scheduled, as in `queue_health_v1`. The observer records 0 once for a gauge series that a later
  collection no longer returns, such as a worker group that left a state. The oldest ready age of a
  queue with no ready task is 0 (SM-1166).
- `@stablemates/workhorse-otel` starts a task's spans from `ROOT_CONTEXT`. A task without a stored
  trace context starts a new trace instead of joining a span active in the worker, including during
  fused fast-tier dispatch (SM-1170). Every SDK now parents a handler span this way (SM-1176,
  SM-1179).

Dashboard:

- Single-admin login throttling in `@stablemates/workhorse-dashboard-server` counts failures per
  client address instead of process-wide. A global bound limits concurrent password hashing. The
  node middleware supplies the socket address. Behind a reverse proxy, every client shares the
  proxy's window until you list the proxy as trusted, as described under
  [Added](#added) (ADR 0093, SM-1168).
- The workspace switcher lists only the workspaces `authorize(request, workspace)` grants for the
  request (SM-1168).
- Pausing a schedule asks for confirmation, as resuming one already did (SM-1147).
- The Events pager stops at the last page the server accepts. It offers to continue with older
  events through a custom range. Event rows keep their table semantics and open through a named
  button in the Event cell (SM-1171).
- The Schedules page says how many schedules past the first 50 it does not show (SM-1171).

### Migrations

Migration 0054 is the first since 0.6.1. Each migration takes effect when it commits.

- **0054** (`0054-distinguish-a-single-child-rename-from-a-second-child.sql`) adds versioned child
  functions and the nullable `task_child.last_seen_fence_token` fence marker. Older clients keep
  their v1 functions (SM-1106).
- **0055** (`0055-fail-durable-replay-conflicts-without-retrying.sql`) reserves a retry delay of -1
  in `fail_v1` and `fast_fail_v1` as the terminal failure override. It is the SDK compatibility
  floor, schema version 54 (SM-1107).
- **0056** (`0056-count-row-retention-lag-from-the-history-pass-that-released-the-row.sql`) changes
  only `queue_health_v1`, to count row retention lag from the releasing history pass (SM-1134).
- **0057** (`0057-close-a-released-task-without-attributing-its-unrun-attempt.sql`) changes only
  `cancel_v1` and `terminalize_deadline_v1`, to close a released task like never-started work
  (SM-1158).
- **0058** (`0058-let-terminal-cleanup-keep-pace-and-share-its-budget-across-tiers.sql`) changes
  `prune_terminal_tasks_v1`, `prune_terminal_storage_v1`, and `queue_health_v1`. It adds two
  `maintenance_state` columns, and the health document reports `terminal_cleanup_backlog_since`
  while cleanup is behind (SM-1160).
- **0059** (`0059-close-sql-integrity-gaps-in-rate-refill-dependency-edges-and-mixed-batches.sql`)
  closes five SQL integrity gaps. It adds the `rate_limit_policy_per_key_complete_check` and
  `budget_rate_complete_check` constraints, after clearing incomplete settings as the upgrade steps
  describe. It adds a trigger that rejects a dependency edge update. A batch with a debounce or
  throttle member now locks every member's prerequisites before its first member runs (SM-1165).
- **0060** (`0060-judge-fast-tier-completions-and-cancellation-acknowledgements-after-waits.sql`)
  judges two fast-tier operations at the time they act. `fast_complete_many_v1` reads the clock
  again after failing oversized members, so a later member whose lease expired meanwhile no longer
  completes. `fast_acknowledge_cancel_v1` checks the lease after its row lock, as
  `acknowledge_cancel_v1` does on the full tier (SM-1163).
- **0061** (`0061-bound-the-scan-cost-of-fast-dead-letters-statistics-and-repeated-ticks.sql`)
  bounds three reads whose cost grew with table size or fleet size. It adds
  `fast_task_outcome_failed_finished_idx`, so `list_dead_letters_v1` reads only failed fast-tier
  outcomes. `aggregate_stats_v1` no longer materializes fast-tier rows that cannot hold a fact
  inside its window. `tick_v1` spaces the expired-lease scan and records each run in the new
  `maintenance_state.lease_recovery_started_at` column (SM-1167).
- **0062** (`0062-bound-dashboard-worker-and-task-listings.sql`) adds
  `dashboard_human_wait_quick_action_v1` and changes four dashboard read functions.
  `dashboard_workers_v1` reads its one-hour cutoff once, so a Workers poll prunes attempt history
  to the partitions that can hold that hour. `dashboard_cron_v1` adds `scheduleCount`. The task
  listings carry `humanWait.quickAction` (SM-1171).
- **0063** (`0063-raise-a-health-reason-for-a-terminal-cleanup-backlog.sql`) changes
  `evaluate_queue_health_v1`, `prune_terminal_storage_v1`, `dashboard_cron_v1`, and
  `dashboard_maintenance_state_v1`, and adds `terminal_cleanup_follow_up_delay_ms_v1`. It raises
  `terminal-cleanup-backlog`. The dashboard's `terminal_storage` routine is due after the same
  five-second follow-up delay that gates the pass, and the System page lists the new check.
  `dashboard/v1` adds the reason code to its enum, an additive change (SM-1178).
- **0064** (`0064-keep-jit-out-of-the-statistics-aggregate.sql`) disables JIT for
  `aggregate_stats_v1`. A catch-up `rollup_stats_v1` pass, and the live tail of `stat_buckets_v1`
  behind a lagging rollup, could spend about a second compiling a plan that runs in tens of
  milliseconds. The function's body, signature, and result are unchanged (SM-1193).
- **0065** (`0065-give-the-terminal-cleanup-backlog-reason-its-own-health-budget.sql`) gives
  `terminal-cleanup-backlog` its own budget, so an operator can warn on a saturated cleanup without
  tightening `retention-lag`. `queue_health_policy` gains `terminal_cleanup_backlog_ms` and
  `application_terminal_cleanup_backlog_ms`, with a 6 h default. The migration starts each from its
  row retention counterpart and carries an override of `row_retention_lag_ms` over. Reverting
  `row_retention_lag_ms` no longer reverts the backlog budget. `sync_queue_health_policy_v2` seeds
  all six budgets. `sync_queue_health_policy_v1` keeps its signature and no longer moves the backlog
  budget. `override_queue_health_policy_v1` and `revert_queue_health_policy_v1` accept
  `terminal_cleanup_backlog_ms`, and the health document reports `budgets.terminalCleanupBacklogMs`
  (SM-1197).

### Added

- `@stablemates/workhorse-knex` is an optional adapter. It preserves native PostgreSQL statements
  and parameters on the pinned Knex route. The tested Objection recipe shares the model-write
  transaction with enqueue, and callers keep transaction and resource ownership. Its peer
  dependencies pin Knex 3.3.0 and `pg` 8.23.1 (SM-1118).
- `DashboardHost.handle(request, context?)` accepts an optional `DashboardRequestContext`. A
  fetch-native host sets its `clientAddress` from its own transport (SM-1168).
- `workhorse dashboard` accepts a repeatable `--trusted-proxy <address-or-cidr>`, and reads
  `WORKHORSE_DASHBOARD_TRUSTED_PROXIES` as a comma-separated list. Any flag replaces the whole
  variable. `dashboardNodeMiddleware` and `DashboardCommandOptions` take the same list as
  `trustedProxies`. For a request from a listed proxy, login throttling counts the rightmost
  `X-Forwarded-For` or `Forwarded` hop that is not a listed proxy. The list is empty by default,
  and a malformed entry stops the listener at startup (ADR 0094, SM-1177).
- An unexpected dashboard schema-compatibility failure emits
  `workhorse.dashboard.compatibility_check_failed` (SM-1168).
- `ChildTaskOptions` is exported from the package root (SM-1169). `dashboardPageMax` is exported
  as the one dashboard page limit (SM-1171).

### Fixed

- `runChild`, `runChildren`, and `runChildrenAll` join existing children after their task type's
  contract advances. Replay retries a contract conflict with the stored versions. It rebuilds under
  those versions when the current contract rejects the payload. Changed payloads and child sets
  still raise `ChildConflictError` (SM-1105).
- A producer that never called `syncContracts()` retries a contract mismatch with the contract
  definition it fetched. Before, it failed with "Contract policy changed again while retrying
  enqueue" and aborted the caller's transaction. The Objection recipe, which builds a new adapter
  per transaction, can enqueue a task type whose contract another process installed (SM-1170).
- A worker no longer waits without limit while shutting down. Closing the reserved heartbeat
  connection no longer waits for a connect stuck behind an exhausted pool, and it releases a client
  that arrives later. `UNLISTEN` gets 1,000 ms before the listener destroys its connection
  (SM-1169).
- A `WorkhorseMetricsObserver` `onError` reporter that throws or rejects is written to
  `console.error` instead of becoming an unhandled rejection (SM-1166).
- The dashboard's activity chart shows loading, error, and stale states with a Retry button. It
  never draws one query's bars under another query's controls. Its series keys no longer collide
  when group names differ only by `.` and `_`, or when a group is named `bucket` or `other`
  (SM-1171).
- The `@stablemates/workhorse-drizzle` README states that a `forTransaction` queue must not outlive
  its transaction (SM-1170).

### Dependencies

- `@stablemates/workhorse` and the Drizzle, Prisma, TypeORM, and Kysely adapters require `pg`
  8.23.1 or a later 8.x release.

### Recipes and documentation

- New tested recipes: transactional enqueue with MikroORM through Kysely (SM-1111), signed Stripe
  invoice acceptance (SM-1117), signed Slack approvals with durable decisions (SM-1120), and
  durable GitHub issue triage (SM-1121). The integration pages are grouped by category (SM-1142).
- The site documents expected PlanetScale PostgreSQL compatibility (SM-107).
- The architecture reference is split into one page per area under
  [`docs/architecture/`](docs/architecture.md) (SM-1131). The guides are rewritten scenario-first
  with collapsed reference blocks (SM-1146, SM-1151), and the README and architecture pages gain
  Mermaid diagrams (SM-1130).

### Demo

- The demo passes each client's address to the dashboard login throttle. Five wrong passwords from
  one visitor no longer lock every visitor out for a minute (SM-1188).

## 0.6.1 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**0.6.1 exists to publish the Python distribution with provenance.** The 0.6.0 Python distributions
on PyPI have no PEP 740 attestations, and the 0.6.1 distributions have them. The
[Python changelog](python/CHANGELOG.md) describes the release workflow fix. No package changes its
code. The npm packages have no changes, and every package releases at 0.6.1 to keep one version
across the registries ([ADR 0050](docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).

**A 0.6.0 database needs no migration.** 0.6.1 adds no migration, so the final schema version is
**52** and the SDK compatibility floor stays at schema version **43**. An installation on 0.5
follows the [0.6.0 upgrade steps](#060--2026-10-02).

## 0.6.0 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**Upgrade: migrate the schema before any 0.6 process starts.** Migrations 0045 through 0053 only
add, so the upgrade is a rolling deployment. Run `workhorse schema migrate`, then roll out the new
processes. The final schema version is **52**. The SDK compatibility floor stays at schema version
**43**, so a 0.5.0 process keeps working on version 52. Each migration commits on its own, so
each SQL fix below takes effect when its migration commits. Version 52 includes them all.

**An installation that runs cold export stops its exporters across migration 0052.** That migration
repairs the export ledger so each segment covers one UTC day. It cannot stop an upload already in
flight, and such an upload would overwrite a corrected day's object. Upgrade in this order:

1. Stop every cold exporter, and let each finish its object and manifest uploads.
2. Keep cold export enabled, so retention keeps waiting for the export.
3. Run `workhorse schema migrate`.
4. Restart the exporters after the migration commits.

An installation that never enabled cold export needs no extra step. The
[cold export guide](docs/guides/335-cold-export.md#a-day-is-a-utc-day) explains the repair and the
warnings it raises.

**A handler result PostgreSQL cannot store now fails only its task.** jsonb refuses a NUL character
and an unpaired surrogate. Such a result used to reach the completion statement, whose refusal
stopped the worker and left the task leased. The worker now fails the attempt under the task's
retry policy with a `TypeError` and the message `<task type> result contains a NUL character or an
unpaired surrogate, which PostgreSQL jsonb cannot store`. On the fast tier the other members of a
completion batch still complete. A database error during completion still stops the worker.

**Breaking: contract schemas can no longer use `pattern` or `patternProperties`.** The SDKs' regular
expression engines accept different syntax and match differently, so one contract could validate
differently in each language.
[ADR 0039](docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now leaves both
keywords out of the contract profile. Every SDK rejects such a schema with
`<path> is outside the Workhorse contract profile` when either keyword appears at any depth. A
property named `pattern` stays valid. Check a string's shape in handler code instead; `format` stays
an annotation. A `$ref` must also point at a subschema, so it cannot reach a schema hidden in
`default` or `examples`; every SDK rejects any other reference with
`<path>.$ref must point at a subschema of the contract`. That includes a pointer that encodes
`/` as `%2F`. Upgrade in this order:

1. Find each contract version that uses `pattern` or `patternProperties`, or a `$ref` that points
   outside a subschema. A version synced before the upgrade stops compiling once the SDK is
   upgraded.
2. Publish a new version without either keyword, and move `currentVersion` to it.
3. Let tasks that hold the old version finish before you upgrade workers. A worker checks a task's
   result against the version the task holds. If that version's result schema uses either keyword,
   completing the task fails the attempt with the profile error, and the task's retry policy
   applies. Each payload was checked at enqueue, so a keyword in the payload schema does not affect
   tasks already queued.

**Breaking: a contract `$ref` must be `#` or `#/$defs/<name>`, and `$anchor` is no longer
accepted.** The SDKs' JSON Schema libraries disagreed on how to decode and resolve other reference
forms, so a reference could reach a schema the profile check never saw.
[ADR 0039](docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now names two reference forms: `#`, the root schema, and `#/$defs/<name>`, where
`<name>` is a key of the root `$defs`. Every SDK rejects the schema for any other reference, with
`<path>.$ref must point at a subschema of the contract`; for `$defs` below the root; for a `$defs`
name that does not match `^[A-Za-z_][-A-Za-z0-9._]*$`; and for `$anchor` at any depth. A property
named `$anchor` stays valid. Upgrade in this order:

1. Find each contract version that references anything other than `#` or a root definition, nests
   `$defs`, uses `$anchor`, or names a definition outside that pattern. A version synced before the
   upgrade stops compiling once the SDK is upgraded.
2. Move each referenced or anchored subschema into the root `$defs` and reference it as
   `#/$defs/<name>`. Rename each definition outside the pattern and update the references to it.
   Declare a new contract version, because contract rows are immutable, and move `currentVersion` to
   it.
3. Let tasks that hold the old version finish before you upgrade workers. A worker checks a task's
   result against the version the task holds, so a removed form in that result schema fails the
   attempt with the profile error, and the task's retry policy applies.

**The demo deployment contract names schema version 52 as the final version.**
`typescript/demo/DEPLOYMENT.md` said the build ships version 51 and that migration finishes there.
Migration 0053 had already made the final version 52. The contract now says 52, and a test compares
it with the generated schema version. The cold-export outage stays at the step to version 51, which
migration 0052 takes.

SQL fixes, each in its own additive migration:

- Migrations 0045 and 0046: schedule-run retention health follows the daily history pass, and a pass
  that has not run yet is dated from the oldest expired run.
- Migration 0047: a NULL limit, lease, or bucket count is rejected before any lock. A NULL limit
  passed straight to `claim_many_v1` used to lease every claimable task.
- Migration 0048: `claim_many_v1`, `claim_one_v1`, `claim_policy_batch_v1`, and
  `complete_many_and_claim_v1` raise SQLSTATE `0A000` under repeatable read or serializable
  isolation. Under repeatable read, two claims could start more tasks than a budget's `maxActive`
  allows.
- Migration 0049: `prune_terminal_tasks_v1` no longer stalls on redrive sources that younger
  redrive targets pin. A bulk redrive used to stop terminal pruning for good.
- Migration 0050: `sync_budgets_v1` takes each `workhorse:budget:<name>` lock in name order. A
  concurrent claim could fail with SQLSTATE `23514` or leave a start uncharged.
- Migration 0051: `fast_complete_many_v1`, `fast_heartbeat_many_v1`, `heartbeat_v1`, and
  `heartbeat_many_v1` read the clock after taking the row lock. A fast completion could accept, and
  a heartbeat could renew, a lease that expired while the function waited for the lock.
- Migration 0052: the cold-export segment claim and `stat_buckets_v1` step a fixed UTC day whatever
  the session `TimeZone` is. The migration adds `cold_export_dataset_utc_midnight_check` and
  `cold_export_segment_utc_day_check` and repairs the ledger, as the upgrade steps above describe.
- Migration 0053: `sync_schedule_definitions_v2` takes the
  `workhorse:schedule-namespace:<namespace>` lock, so it no longer deadlocks with
  `fire_due_schedules_v2`.

`@stablemates/workhorse`:

- `Worker` rejects a non-finite, fractional, or out-of-range timing option at construction. This
  covers `leaseMs`, `heartbeatMs`, `pollMs`, `maintenanceIntervalMs`, `maintenanceRoutinePollMs`,
  `registryIntervalMs`, `scheduleCatchupLimit`, and a fixed `retryDelayMs`. `heartbeatMs` must be at
  least 1 and below `leaseMs`. `registryIntervalMs: 0`, `pollMs: 0`, and `retryDelayMs: 0` stay
  valid.
- Contract schemas compile with Ajv's `strict: false` and `strictNumbers: true`. A profile schema
  that another SDK accepts, such as a union `type`, now loads in TypeScript too.
- An enqueue whose cached contract rejects the payload reloads the definition once and validates
  again. An operator's new `currentVersion` or larger payload limit no longer fails locally.
- External wait names, the `requestedBy` actor, and the admin audit actor and reason are counted in
  code points, as PostgreSQL counts them.
- A durable handler call on a fast-tier task that a fallback full-tier claim returned resolves the
  queue tier, then rejects with `FastTierUnsupportedError`. It touches no durable state and runs no
  callback.
- The package exports `connectionPoolOf` and the `ConnectionPool` type, so the dashboard server
  resolves a database's pool the way a worker does.
- The documentation states that metrics need `registerOpenTelemetry()`.

`@stablemates/workhorse-drizzle`:

- The adapter binds only the parameters PostgreSQL would bind. It used to treat a `$N` inside a
  string literal, quoted identifier, comment, or function body as a parameter, which broke
  `installSchema` and `migrateSchema` through the adapter.

`@stablemates/workhorse-dashboard-server` and `@stablemates/workhorse-dashboard`:

- The host answers every non-POST request under `{basePath}/rpc` with 405 and `Allow: POST`.
- Every read is bounded, including reads through an ORM adapter and the retention preview. The
  Drizzle and TypeORM adapters always attach a pool. The Prisma and Kysely adapters attach one only
  when given their pool option. A database with no pool is still read unbounded.
- Under `redactErrorStacks`, the host also withholds worker stacks from the error copy in lifecycle
  event details.
- System health lists every check with its own state. Rate limits show as Throttling, and
  concurrency and shared budgets show as Limiting.
- Every count groups its digits.
- The dashboard uses Mantine 9.6.3.

Demo:

- An operator mutation holds its slot until its work settles, and the host bounds how long a request
  is handled.
- Operator redrives stay within the pending-work budget across both tiers.

## 0.5.0 — 2026-09-28

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v43**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**Breaking: a 0.4.x database upgrades offline, across one contract step.** Migration 0025 adds the
fast tier and SQL protocol version 5. It is a contract step shipped in a minor release, which
[ADR 0077](docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md) §6
allows once. It narrows the protocol to exactly 5 and drops `fire_due_schedules_v1` and
`sync_schedule_definitions_v1` without a shim, so a 0.4.x process fails its compatibility check
against the new schema. `workhorse schema migrate` stops before a contract step. Upgrade in this
order:

1. Stop every worker and every producer.
2. Run `workhorse schema migrate`. It applies nothing past schema version 24 and reports the pending
   contract step.
3. Run `workhorse schema contract --yes`, which applies migration 0025 and leaves schema version 25.
4. Run `workhorse schema migrate` again. It applies migrations 0026 through 0044 and leaves schema
   version 43.
5. Start the processes from this release.

Every queue starts full-tier, so live tasks stay where they are and no history needs a backfill.

**Breaking: a process from this release refuses a schema below version 43.** The compatibility
floor moves from schema version 18 to 43 and the protocol floor from 1 to 5, because the SDKs now
call functions that migrations up to 0044 add.

**Add a fast task tier.** A fast-tier queue records one `fast_task_outcome` row per task instead of
the attempt and event history, and keeps its live state in `fast_task_runtime`. Tasks take
`uuidv7` identities, and `complete_many_and_claim_v1` completes a batch and claims the refill in
one statement. A fast-tier queue refuses dependencies, child tasks, concurrency keys, budgets,
debounce, throttle, and concurrency or rate-limit policies with SQLSTATE `P1007`. The client raises
that as `FastTierUnsupportedError`, naming the queue, the feature, and the batch ordinal. A queue
moves tiers only while it is empty
([ADR 0077](docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md)).

- Add `Admin.setQueueTier(queue, tier, audit)` and `Admin.setQueueHistory(queue, settings)`, with the
  `QueueTier` and `QueueHistorySettings` types. `setQueueHistory` opts a fast-tier queue into
  attempt or claim history. The CLI adds the guarded `workhorse admin set-tier` and
  `workhorse admin set-history`, and `workhorse admin queues` reports each queue's tier and history.
- Batch fast-tier completions with a fused refill claim. The worker's `cohorts` option splits its
  slots into fixed shares that each complete and claim together. The default is 1 below a
  concurrency of 8 and otherwise one cohort per eight slots, between 2 and 8, capped by the pool's
  spare connections. `Queue` adds `completeAndClaim` and `claimFast`, with the `CompletionClaim` and
  `CompletionClaimResult` types.
- Fail only the oversized row when a fast-tier batch carries a result past the size limit, instead
  of the whole batch. The client measures a result the way PostgreSQL does.
- Add `fast_task_outcome` to `ColdExportDataset`.
- Keep overlapping batched claims in flight, so a worker fills free slots while a claim is still
  running
  ([ADR 0076](docs/decisions/0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md)).
- Claim policy- and rate-limited tasks as a set, and send a capacity notification only when a
  release frees a full cap. The notification is serialized with claims, so a worker cannot miss it.
- Shard the admission counters, so claims on a governed queue no longer serialize on one counter
  row ([ADR 0082](docs/decisions/0082-shard-the-admission-counters.md)). A plain full-tier claim
  also costs less.
- Skip the notification claim delay while claims keep finding work.
- Start a long-running worker's first claim beside its startup maintenance pass
  ([ADR 0078](docs/decisions/0078-start-a-long-running-workers-first-claim-beside-its-startup-maintenance-pass.md)).
- Release dependents through a pending-prerequisite counter, planned once per session and applied
  per statement. A dependent enqueue holds its prerequisites against completion, and an enqueue
  batch locks its prerequisites before its first request.
- Enqueue full-tier batches set-based. A batch with several invalid members can report a different
  member's error than before.
- Settle a parent whose child is already terminal when it is created. Migration 0032 repairs parents
  an earlier release left waiting.
- Detect and repair dependency counter drift. `Admin.listDependencyDrift(limit?)` lists it,
  `Admin.repairDependencyDrift(audit, limit?)` repairs it, and `MAX_DEPENDENCY_DRIFT_LIMIT` bounds
  both. `workhorse admin repair-dependencies` runs the same repair, with `--dry-run` to list it; a
  repair needs `--reason`, `--env`, and confirmation. Each repaired dependent records a
  `dependency_counter_repaired` event, which the dashboard's event filter offers.
- Lock fast-tier rows in task ID order, and release a fused claim's row locks before they can
  deadlock
  ([ADR 0081](docs/decisions/0081-release-a-fused-claim-lock-before-it-can-deadlock.md)).
- Resend a fenced write and the concurrency policy sync when PostgreSQL chooses them as a deadlock
  victim, up to three attempts. Inside a caller's transaction the original deadlock error is raised.
- Keep the worker running when its heartbeat connection's backend is terminated.
- Add a Tier column to the dashboard Queues page. `dashboard_queues_v1` returns `tier`,
  `recordAttempts`, and `recordClaims`.
- Keep JIT compilation out of the dashboard task detail read, and link a schedule's tasks to that
  schedule's queue on the Schedules page.
- Add the `workhorse.complete.batch_size` and `workhorse.queue.tier` metrics and the
  `workhorse.queue.tier_set` log event.
- Move every optional package's peer range on `@stablemates/workhorse` to `>=0.5.0 <0.6.0`.

## 0.4.0 — 2026-09-23

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v18**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.3.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migration 0024 and leaves the installation at
schema version 24. The step is additive: it replaces one read function. No table changes, no
database is dropped, and no data is lost. The compatibility floor stays at version 18.

**The Rust crate joins the release train.** `workhorse` publishes to crates.io from the same `v*`
tag as the npm packages, and its notes live in [`rust/CHANGELOG.md`](rust/CHANGELOG.md).

- Measure row retention lag against the history gate the prune applies. `prune_terminal_tasks_v1`
  keeps a terminal task until daily history retention passes its `history_through_at`, but queue
  health counted a row held only by that gate as lag. The measured lag climbed toward a day between
  history passes, so health read Degraded for most of every day. Migration 0024 replaces
  `queue_health_v1` so both eligible boundaries apply the prune's predicate. A history pass that
  stops advancing still shows as task event and attempt history lag.
- Fit the dashboard Workers table on a laptop viewport without horizontal scrolling. Schedules
  become a calendar icon with a hover card, the Paused badge moves to the placement line, queues
  stack one per line, and a long worker name is truncated in the middle with the full name on hover.
- Bound the dashboard login body. A non-numeric or unsafe `Content-Length` returns 413, and a
  streamed body past `MAX_LOGIN_BODY_BYTES` returns 413 without being buffered.
- Enforce dashboard mutation authorization in the RPC middleware, so a read-only dashboard refuses a
  mutation with `FORBIDDEN` before any handler runs.
- Substitute the dashboard's runtime configuration and module URLs literally, so a `$` pattern in a
  value is no longer expanded.
- Document the dashboard's security boundaries in
  [`docs/dashboard-security-review.md`](docs/dashboard-security-review.md).
- Move every optional package's peer range on `@stablemates/workhorse` to `>=0.4.0 <0.5.0`.

## 0.3.0 — 2026-09-21

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v18**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.2.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migrations 0010 through 0023 and leaves the
installation at schema version 23. Every step is additive: it replaces read and transition functions
or adds one, and 0023 also releases the dependency edges a cancellation abandoned. No table changes,
no database is dropped, and no data is lost.

**A process from this release refuses a schema below version 18.** The compatibility gate's floor is
now derived from the newest function the SDKs call, rather than held at 1 by hand. A lagging
installation is refused at startup instead of failing on its first dashboard read, after the process
has taken work. Migrating before any new process starts is what the deployment contract already
asks for, so a pipeline that follows it sees no change.

**0.1.x support is dropped.** The migration chain now starts at the 0.2.0 baseline, schema version 6
([ADR 0073](docs/decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)). Workhorse
0.2.1 is the last release that migrates a database below the baseline: reach the baseline with
0.2.1, then upgrade to this release. The refusal names it. The 0.1.x line had no production
installation, which is what made the chain prunable.

- Give every worker a connection pool, and reserve one heartbeat connection from that pool. A worker
  whose pool cannot lend one refuses to start, naming the capacity it found, the capacity it needs,
  and the opt-out. `sharedHeartbeats` takes heartbeat rounds back to the shared pool, which is how a
  single connection or a small pool runs
  ([ADR 0071](docs/decisions/0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md)).
- Remove `notificationPool` from the Prisma, TypeORM, and Kysely adapters. TypeORM finds its pool
  through `dataSource.driver.master`, and Prisma and Kysely take one through the adapter option
  `pool`. Drizzle keeps finding its pool through `$client`.
- Release a task whose type a worker has no handler for, instead of failing it. `release_owned_v1`
  returns the claim to its queue with the attempt intact, appends a `released` event the dashboard
  timeline labels, and charges the held lease to the execution-timeout budget. During a rolling
  deployment the old release no longer spends the retry budget of a type only the new release runs.
- Keep every task running through a heartbeat round that fails, and retry on the next beat. Each
  attempt keeps its own lease watchdog: once one lease passes with no accepted renewal, the attempt
  submits `lease_expired`, aborts its handler, and records `lease_lost` without failing the attempt.
- Warn once when a worker starts without a listener. Polling is the correctness mechanism, so a
  missing listener costs latency rather than correctness, but it is no longer silent.
- Release a canceled dependent's incoming dependency edges. A dependent canceled while it was still
  blocked used to hold its prerequisite's identity against retention, which queue health reported as
  `retentionPruneStarved`.
- Never skip a busy schedule occurrence. The firing pass takes each occurrence's advisory lock
  itself and ends evaluation for that definition when another transaction holds it, so a manual fire
  that rolled back no longer strands an occurrence. The pass also reads its evaluation instant from
  the database clock rather than the caller's.
- Keep expiration timers armed past 24.8 days.
- Refuse a debounce replacement once a task has started.
- Hold a per-budget lock during budget admission, so two claims cannot admit past one budget.
- Compare promotion and recovery scans against one stable time.
- Name `pg_temp` in every history-day staging reference. A caller's `search_path` can no longer
  redirect maintenance to a table of the same name in a writable schema.
- Lock only the row a claim takes. A claim on a queue whose keys are all saturated wrote a row lock
  for each of the 100 rows it sampled; it now writes none, and an admitting claim writes one.
- Skip the enqueue dependency block for a request that declares no prerequisite. Measured on 200
  dependency-free tasks in one call, the median fell from 70.599 ms to 44.287 ms.
- Give the three SDKs one failure envelope. An unredacted failure carries exactly name, message, and
  stack, and a redacted one carries the two fields `redact_error_details_v1` writes. A thrown
  non-Error now records a null stack rather than omitting the field.
- Render the dashboard only when a poll changed something. An unchanged poll writes no state, a
  changed one commits once rather than twice, each row compares the fields it draws, and the task
  drawer is fetched the first time an operator opens one.
- Bound every dashboard task read, serve the queue health snapshot from cache, bin activity once per
  poll, and compress RPC answers. A withheld task value is shown by size until an operator asks for
  it.
- Tell sunsetting workers from replacements on the Workers page. A Started column carries an exact
  timestamp on hover, and a draining or offline worker renders an inert Claims cell that says why
  instead of a switch that controls nothing.
- Refuse a dashboard request whose `Host` is not the dashboard's own address. Bound RPC bodies, hide
  stacks off loopback, and return to the mount after login.
- Order generated spec properties by declaration site. An unrelated declaration elsewhere in the
  repository can no longer reorder the `dashboard/v1` schemas or the Go and Python bindings.
- Document that a signal or human wait which omits its timeout expires after seven days, and that
  the expiry is terminal.
- Move the dashboard to Mantine 9 and pin zod 4.6.5. `taskFailures.rangeStart` and `rangeEnd` now
  require seconds in their ISO datetime, which RFC 3339 requires and which every first-party caller
  already sends.
- Move every optional package's peer range on `@stablemates/workhorse` to `>=0.3.0 <0.4.0`.

## 0.2.1 — 2026-09-18

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

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

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.1.5 database upgrades in place.** This is the first release that ships migrations. Run
`workhorse schema migrate` from a deployment step before any process from this release starts. It
applies migrations 0002 through 0006 and leaves the installation at schema version 6. No database is
dropped and no data is lost.

- Add named budgets that span queues. `Queue.syncBudgets()` declares a namespace of budgets,
  `Queue.listBudgets()` reads them, and an enqueue names one through `budget`. A budget caps the
  unexpired active tasks that name it, refills one shared token bucket, or does both
  ([ADR 0067](docs/decisions/0067-add-named-budgets-that-span-queues.md)).
- Skip missed schedule occurrences by default. Each schedule carries a `catchupPolicy` of `skip`,
  `latest`, or `all` and a durable evaluation position. A schedule that a paused deployment left
  behind no longer enqueues every occurrence it missed. Existing schedules take `skip`
  ([ADR 0066](docs/decisions/0066-skip-missed-schedule-occurrences-by-default.md)).
- Ship the cold history export ledger behind the rollup watermark. `Queue.setColdExportPolicy()` and
  `Queue.getColdExportStatus()` drive it, and retention holds a day until an exporter reports it
  copied. Export is off on a clean install and no exporter ships with this release
  ([ADR 0068](docs/decisions/0068-export-cold-history-behind-the-rollup-watermark.md)).
- Derive the history partition horizon from the preparation cadence, so a slower maintenance
  schedule still prepares each partition before a writer needs it.
- Bound every dashboard read procedure to the page it returns. `DashboardQueueHealthReader` resolves
  a `DashboardQueueHealthDocument` where it resolved `unknown`.
- Split the dashboard browser bundle into page chunks and serve its assets compressed and cached.
- Document two tenancy tiers. One database per tenant is the boundary Workhorse enforces; a shared
  database carries the tenant on the concurrency key, a budget, and a tag
  ([ADR 0069](docs/decisions/0069-isolate-tenants-by-database-and-carry-tenant-identity-as-task-metadata.md)).
- Move every optional package's peer range on `@stablemates/workhorse` to `>=0.2.0 <0.3.0`.

## 0.1.5 — 2026-09-14

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.1.4 database must be dropped and reinstalled.** This release re-cuts schema v1 to separate
deployment-owned schedule activation from durable operator pauses and to retain maintenance-run
history; no migration exists between 0.1.4 and 0.1.5.

- Preserve operator schedule pauses across deployment synchronization, removal, and re-addition.
  The dashboard distinguishes deployment configuration from the effective state and requires
  confirmation before Resume can enqueue bounded catch-up occurrences.
- Record recent maintenance executions with phase timings, errors, and affected-row counts. The
  Schedules page shows those runs and supports exact event time ranges.
- Use opaque, versioned task cursor URLs while continuing to accept old JSON cursors, link task
  menus directly to scoped event history, and keep event pagination beside its table.
- Report the version of the TypeScript, Python, or Go SDK serving the dashboard instead of baking a
  version into the shared browser bundle.
- Publish deployment guidance for Kubernetes, schema-first rollouts, worker draining, connection
  budgets, and host administration.

## 0.1.4 — 2026-09-11

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.1.x database must be dropped and reinstalled.** This release renames the unit of work from
"job" to "task" on every surface and re-cuts the schema baseline in place; no migration exists
between 0.1.3 and 0.1.4 ([ADR 0064](docs/decisions/0064-rename-the-unit-noun-from-job-to-task.md)).

- Rename every `Job*` type, `jobId` field, `HandlerContext.job`, and `Admin.getJob`, `listJobs`,
  and `getJobTimeline` to their `Task` spellings; `ChildJobRequest` becomes `ChildTaskRequest`.
- Rename the schema: `workhorse.job` and its companion tables, every `job_id` column and
  `p_job_id` parameter, `list_jobs_v1`, `dashboard_job_detail_v1`, and the `workhorse_jobs`
  notification channel, which is now `workhorse_tasks`. `RedactedJobError` becomes
  `RedactedTaskError`.
- Rename the OpenTelemetry names: `workhorse.jobs.*` instruments become `workhorse.tasks.*`,
  `workhorse.job.*` span events and attributes become `workhorse.task.*`, and the `{job}` unit
  becomes `{task}`. Saved dashboards and alerts on the old names stop matching.
- Rename the `workhorse` CLI subcommands `admin jobs` and `admin job` to `admin tasks` and
  `admin task`; positionals are `<task-id>` and the TUI view is `tasks`.
- Rename the `dashboard/v1` procedure `jobDetail` to `taskDetail` and every `job*` request and
  response field to its `task*` spelling; the contract is rewritten in place rather than
  versioned.
- Rename scheduled maintenance from "task" to "routine": `maintenanceTaskPollMs` becomes
  `maintenanceRoutinePollMs`, `maintenance_state.task_name` becomes `routine_name`, and the cron
  page lists `maintenance.routines`.
- Rename the documentation slugs `/docs/job-dependencies` and `/docs/child-jobs` to
  `/docs/task-dependencies` and `/docs/child-tasks`; the old URLs redirect.

## 0.1.3 — 2026-09-10

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

- Improve task and event tables with readable status labels, compact columns, full hover text,
  and task ID copy controls.
- Add worker and search filters to Events, and show task tags and accepted enqueue modes in details.
- Share task actions between listings and details, with cancellation confirmation and an optional reason.
- Keep task menus responsive on long pages and reset pagination when selecting a task view in the sidebar.
- Remember chart visibility and task drawer width, and clarify rate-limit labels on Queues.

## 0.1.2 — 2026-09-10

Published to npm from one source commit shared with the Python distribution and the Go module,
tagged `v0.1.2`. Workhorse stays a public beta on the `0.x` line.

Requires **schema v1**, Node.js **22** or newer, PostgreSQL **15** or newer. CI exercises Node.js 22
and 24 and PostgreSQL 15 through 18.

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
  can create a development database with `psql -f schema.sql`. The installation page names the
  release that carries the file and the command that downloads it, pinned to the same version as
  the schema tool, because a reader on a host with no checkout has no `schema.sql` to apply
  otherwise. That path carries none of the CLI's guards and is documented for development only.
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

- **A client declares a schema floor and no ceiling, and the database declares which clients it
  still serves.** The startup check refused any schema newer than the version the build was
  compiled against, which would have turned the first in-place migration into an outage for the
  length of a rolling deployment. A build cannot know which later release stops serving it, so the
  ceiling comes from the database instead: `workhorse.protocol_version` records the SQL protocol
  versions the installed schema still serves, and a client whose protocol is absent from that list
  refuses. Below the oldest served version is `schema-too-new`; above the newest is
  `schema-too-old`. A schema that records nothing enforces nothing. `readProtocolVersions` reports
  the list, and the Python and Go checks read the same rows.
- **The standalone dashboard server sets browser protections, because it owns its whole origin.**
  Every response from `startDashboardServer` now carries `Content-Security-Policy`,
  `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and `X-Robots-Tag`, and no
  response references a remote origin. `createDashboardHost` still sets none: an embedded host
  shares the application's origin, and two `Content-Security-Policy` headers on one response
  intersect rather than override, so a policy set here could quietly narrow an application that
  already has a stricter one. The dashboard-server README, the authentication guide, and the
  dashboard page on the site print the policy an embedder copies.

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
- **Every worker records what it is, not only where it runs.** The baseline carries three nullable
  columns on `workhorse.worker_registry` — `client_protocol_version`, `sdk_language`, and
  `sdk_version` — and the TypeScript, Python, and Go workers all report them at registration and on
  every heartbeat that refreshes the row. They answer two questions the registry could not. A
  rolling deploy runs more than one build at once, so the dashboard worker view now shows which SDK
  and version each worker runs. And `workhorse schema contract` may only retire a protocol once no
  worker still speaks it, which is evidence that had nowhere to live
  ([ADR 0057](docs/decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)).
- `workhorse schema status --json` adds a `fleet` block: one entry per distinct client protocol
  version, counting the workers that heartbeated inside their own lease, with a `note` stating that
  producers never register so the counts are worker evidence and not an inventory. A client that
  calls the SQL protocol directly without reporting the three is counted under a null version.
- **A wrong database URL gets a sentence, not a stack.** Every `workhorse` command that reaches
  PostgreSQL used to answer an unreachable or refused database with six frames of `node_modules`
  internals, and none of them said which of `--database-url`, `WORKHORSE_DATABASE_URL`, or
  `DATABASE_URL` supplied the value. It now prints one line naming the failure, the host and port
  when the driver reports them, and the source it resolved, and it never prints the URL itself
  because that routinely carries a password. Socket and DNS failures, PostgreSQL's `08` and `28`
  SQLSTATE classes, and `3D000` are recognised; anything else keeps its stack, and both still
  exit 1.
- The `workhorse init` options `--dir` and `--force` are documented in
  [`docs/architecture.md`](docs/architecture.md), which also lists the commands the published
  `workhorse` binary owns. Neither flag changed; they were previously visible only in
  `workhorse init --help`.

- **The `workhorse admin` CLI covers every operator action that previously needed a browser.**
  `admin purge <queue>` joins cancel, redrive, pause, and resume as a guarded command, and
  `admin pause-worker <worker-id>` and `admin resume-worker <worker-id>` take one worker out of
  rotation and put it back. All three demand `--env` naming the connected database, then `--yes` or
  an interactive retype of the target, and all three require `--reason`. `purge` prints the deleted
  row count and emits it as `deletedCount` under `--json`; the two worker commands emit the stored
  `WorkerPauseResult`.
- **Three read-only `admin` commands answer what a stalled durable handler is waiting on.**
  `admin checkpoints <job-id>` renders the restart boundaries a handler passed and
  `admin waits <job-id>` its durable timer waits, both narrowing to one record with `--name`.
  `admin external-waits` is the fleet-wide question: every pending human decision and signal wait,
  merged oldest first with a `KIND` column. Under `--json` it emits a `human` and a `signal` page
  that advance independently through `--human-cursor` and `--signal-cursor`.
- **The dashboard redrives a dead letter from the listing that shows it.** `dashboard/v1` gains
  `redriveTask` and `redriveDeadLetters` additively; no existing procedure or field changes. The
  discarded listing redrives one task from its row menu and a bounded page of the failures its
  filters select from a control above the table. Both reach `Admin.redrive` and `Admin.redriveMany`
  through `createDashboardOperatorControllers`, so the embedded, standalone, and demo hosts serve
  them from one factory, and both are attributed to the operator the server authenticated rather
  than to a name the browser supplied. `DashboardTaskController` gains `redriveTask` and
  `redriveDeadLetters`, and `DashboardRedriveResult`, `DashboardRedriveFilter`, and
  `DashboardRedriveBatch` are exported from `@stablemates/workhorse-dashboard-server/server` beside
  the other controller result types.
- `migrateSchema` accepts `lockTimeoutMs`, and `SCHEMA_MIGRATION_LOCK_TIMEOUT_MS` is its 5s
  default. An `ALTER TABLE` takes `ACCESS EXCLUSIVE`, and PostgreSQL queues every later statement on
  that table behind the waiting acquisition, so an unbounded wait turned one long worker
  transaction into a stalled queue. The timeout bounds the migration body alone: waiting for a peer
  migrator on the advisory lock stays unbounded, because that wait is expected. A step that gives
  up rolls back atomically, so the recovery is to end the blocking transaction and rerun.

### Fixed

- The published `@stablemates/workhorse` tarball no longer ships the benchmark suite.
  `dist/src/cli/benchmark.*` and the whole `dist/benchmarks/` tree were built and packed even
  though `benchmark` is not a `bin` entry and not a command of the `workhorse` dispatcher, adding
  roughly 620 kB of unreachable modules to every install. `tsconfig.build.json` now
  excludes the benchmark CLI the way it already excluded `reset-db`, and drops the benchmark
  harness from the build. Both stay repository scripts, run from source through `pnpm benchmark`
  and `pnpm db:reset:*`; no importable API is removed, because neither module was reachable from
  the package `exports`.
- The demo no longer replays the schema on startup against a database that already holds it.
- The poll-cadence conformance fixture in `protocol/v1/runtime.json` holds the worker at each empty
  poll, so every language runtime's cadence test observes the same schedule.

- The dashboard withholds a persisted attempt stack from the Events drawer too. `redactErrorStacks`
  was applied in `jobDetail` and nowhere else, so a host that withheld a stack from task detail
  handed the same stack to the same browser through `dashboard_event_detail_v1`, one click away.
  `readDashboardEventDetail` now takes the flag and defaults it to false, exactly as
  `readDashboardJobDetail` does.
- `workhorse init` reads the lockfile the installer actually wrote when a project declares no
  `packageManager`, instead of defaulting to pnpm, and the npm branch prints `npm exec --no --`
  rather than the unqualified `npx` form the installation page warns about, which resolves whatever
  package on the registry carries that name. It also states that `workhorse dashboard` needs
  `@stablemates/workhorse-dashboard`, which nothing said before.
- `ajv`'s `fast-uri` dependency moves off five High advisories inside the published closure. None is
  reachable through Workhorse, which constructs `ajv` with `validateFormats: false` and requires
  every `$ref` to be a local fragment, and which issues no request from a parsed URI at all. The
  bump costs a lockfile line and is taken anyway.

### Upgrade notes

- **Schema version.** `0.1.0` installs schema version 1, which is the permanent migration baseline.
  It ships no migration step: the worker client identity columns are part of the baseline rather
  than an upgrade on top of it, so `register_worker_v1` carries them and no `_v2` exists. The first
  entry in `sql/migrations/` arrives with the first schema change after this release.
- **Schema baseline.** `0.1.0`'s baseline is not the one
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
