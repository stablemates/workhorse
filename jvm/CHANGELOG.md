# JVM changelog

The versions and release notes of the three JVM artifacts live here: `run.workhorse:workhorse`,
`run.workhorse:workhorse-kotlin`, and `run.workhorse:workhorse-spring-boot-starter`. The three
artifacts always carry one version. It is the version that the other SDKs carry, because every
release tag names one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## Unreleased

### Upgrade steps

**Migrate the schema before starting updated processes.** Run `workhorse schema migrate` before any
process of this release starts, producers too. Migrations 0088 through 0090 move the schema to
version **89**. They replace function bodies and change no stored rows. The SDK compatibility floor
stays at **76**. A 0.10 process keeps working on version 89, because a migration inside a major line
only adds.

### A step of the wall clock no longer moves the expiry request

A worker asks PostgreSQL to end an attempt when its deadline or its attempt timeout passes. Before
this change, the worker read the wall clock again after each wait on the lease window (SM-1869). If
the host clock stepped back 10 minutes, the first expiry request came 10 minutes late. If the clock
stepped forward, the request came early and got `not_due`. Each retry then locked the task row until
the real due time.

Now the worker converts the expiry to a monotonic due time once, when its expiry
watch starts. After that, it reads only the monotonic clock.

### Row retention lag skips a member of an unfinished task group

Terminal cleanup keeps each member of a task group that has not finished, because the group needs
its member outcomes when it finishes. Before this change, queue health counted such a member as row
retention lag after it passed its windows (SM-1851). An open or sealed group can stay unfinished for
any length of time. Thus health reported "Retention cleanup is late for task records, finished
results", and the lag grew without end. The public demo keeps one open and one sealed group on
purpose, so its Health page showed the report every day.

Migration 0088 (`0088-count-only-prunable-rows-as-row-retention-lag.sql`) moves the schema to
version 87. Now `queue_health_v1` skips a member of an unfinished group when it measures task
identity and terminal outcome lag. For a group member, lag counts from the latest of window
expiry, history release, and group finish. The health document keeps its keys, and the schema floor
does not change.
Every process of every SDK version gets the new result when the migration commits.

### An idempotency TTL that rounds to 0 ms is refused

The queue rounds the `Duration` of `Idempotency.ttl` to the nearest millisecond. Before this change,
a positive `Duration` below 0.5 ms rounded to 0, and the queue kept the key for the default one day
without a warning (SM-1857).

Now the queue throws `IllegalArgumentException` for a nonzero `Duration` that rounds to 0 ms.
`Duration.ZERO` still selects the default. ADR 0115 records the rule for all seven SDKs.

### Recovery no longer locks a timed-out attempt that waits for its cancellation

An operator cancels a running task after its execution timeout passed, and its lease is still live.
Before migration 0089, each maintenance tick locked that attempt in its timeout scan, but settled
nothing, because the cancellation wins over the timeout. While the tick ran, the heartbeat of the
owning worker reported the lease busy. The locked rows also used the recovery limit, so a real
timeout behind them waited for their leases to expire (SM-1866).

Now the full-tier timeout scan skips such an attempt while its lease is live and its deadline is
ahead, as the fast tier does. If the deadline passed after the timeout, recovery closes the task
`canceled` at once.

### Fast-tier recovery closes a canceled attempt when its deadline passes

A fast-tier task has a pending cancellation and a live lease. Its execution timeout passes, and
later its deadline passes. Before migration 0090, each maintenance tick locked that attempt and
settled nothing until the lease expired. The cancellation blocks the timeout, and recovery took the
deadline only when the deadline was not later than the timeout (SM-1881).

Now fast-tier recovery closes the task `canceled` when its deadline passes, as the full tier does.

### The dashboard Schedules page reads a bounded number of occurrences

Before migration 0089, `dashboard_cron_v1` counted every retained occurrence of each listed
schedule. A schedule that fires each second keeps about 1.2 million occurrences in the default
retention of 14 days. Each poll of the Schedules page read all of them (SM-1866).

Now the function reads at most 1,001 occurrences for each listed schedule. `occurrenceCount` stops
at 1,000, and the new optional key `occurrenceCountCapped` is `true` when more occurrences are
retained. The bundled Schedules page then shows `1,000+`. `lastFiredAt` is the fire time of the
newest occurrence. The `dashboard/v1` change is additive. A database below schema 88 returns an
exact count and no `occurrenceCountCapped`. The page change rebuilds the shared dashboard bundle
again. The sha256 in "The dashboard bundle uses Mantine 9.7.4" is the sha256 of that bundle.

### The worker registry prune finds expired kept pauses through their index

Before migration 0089, `prune_worker_registry_v1` deleted expired kept pauses with a condition that
the planner could not match to `worker_pause_tombstone_expires_idx`. Each maintenance pass read the
whole table. Now the delete reads only the expired rows through the index (SM-1866).

### A long-running worker no longer keeps every ended registry write

Each registry write runs on its own virtual thread, and it first waits for the write before it.
Before this change, the write kept a reference to that earlier thread after the wait. An ended
virtual thread keeps its task, so every ended registry thread stayed reachable from the newest one.
The worker heap grew by one thread for each registry write and never got the memory back (SM-1846).

The public demo worker refreshes its registration four times a second with a 32 MiB heap. It ran out
of heap and restarted about every six hours. With the default interval of 5 s, a worker kept about
17,000 ended threads each day.

Now a registry write clears its reference to the earlier thread before it waits. The writes still
reach PostgreSQL in order.

A registry write also becomes the current write only after its thread starts. Before, a write whose
thread did not start became current anyway. The next write then waited for that write and not for
the earlier one, so the two writes that still ran could reach PostgreSQL out of order.

### A stale failure or release after a lapsed lease settles its cause

A lease can lapse while a handler runs, with no change to the fence. Then `fail_v1` and
`release_owned_v1` answer `stale`, but `expire_owned_v1` can still settle a due deadline or attempt
timeout under that fence. Before this change, the worker settled nothing, and lease recovery
settled the task later (SM-1884).

Now the worker calls `expire_owned_v1` at once and settles the due boundary, as the Go and Rust
workers do:

- After a lapsed lease with a due deadline, the handler outcome was `lease_lost`. Now it is
  `deadline_exceeded`, and the task fails at once.
- After a lapsed lease with a due attempt timeout, the handler outcome was `lease_lost`. Now it is
  `timeout`, and PostgreSQL applies the retry policy at once.
- After a lapsed lease with no due boundary, the outcome stays `lease_lost`.

The handler span records `deadline_exceeded` or `timeout_exceeded`. Before this change, it
recorded `stale`.

If `fail_v1` or `release_owned_v1` answers `cancel_requested` and `acknowledge_cancel_v1` refuses,
the worker settles nothing. After a failed cancellation acknowledgement, the handler outcome was
`unknown`. Now it is `lease_lost`. The handler span records `stale`. Before this change, it recorded
`cancel_requested`. A late heartbeat round can also deliver the cancellation request, after a
failure, a release, or a refused completion. If the acknowledgement then refuses, the handler
outcome was `canceled`. Now it is `lease_lost`.

### The dashboard bundle uses Mantine 9.7.4

The JVM dashboard backend serves the shared dashboard browser bundle. After 0.10.0, a dependency
update moved the dashboard to Mantine 9.7.4 and rebuilt that bundle (SM-1839). The
`run.workhorse:workhorse` jar now carries the rebuilt `read-surface-1.tar.gz`. Its `bundle.json`
records the sha256 `a7d61ed1d0433e38a8d227cbcc8f98a0bf668f2d3bb1d47391b1882fd69bf795`.

The `dashboard/v1` procedures and the read surface version do not change (SM-1858).

### The dashboard page tells each cache not to store it

The dashboard page holds `window.workhorseDashboard`, which contains the `auditActor` of the
operator. Before this change, the JVM dashboard backend sent the page with only `Content-Type`. A
shared cache in front of the application could store the page by heuristic. A later visitor could
then get the stored page and see the actor name of an earlier operator. A browser could also show
the page from its cache after logout (SM-1870).

Now the JVM dashboard backend sends the page with `Cache-Control: no-store`, as the TypeScript host
does. Each asset keeps `Cache-Control: public, max-age=31536000, immutable`.

### A child set and a task group check every request before their first statement

Before this change, `HandlerContext.runChildren` and `runChildrenAll` checked the options of each
child while they serialized it. Thus the first child could read its payload contract before the SDK
refused the second child. `Queue.createTaskGroup` and `Queue.taskGroup` checked the callbacks after
the compatibility query and the member contract reads. A member add through
`HandlerContext.taskGroup()` read the membership of its task first (SM-1883).

Now these calls check the options of every request before their first statement, also before the
deferred tier read of a child set. The exceptions do not change. Only their time changes.

## 0.10.0 — 2026-10-26

The npm packages, Python distribution, Go module, Rust crate, Ruby gem, JVM artifacts, and .NET
packages release from one source commit.

Requires **schema v76**, Java **21** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** Run `workhorse schema migrate` before any
process of this release starts, producers too. Migrations 0075 through 0087 move the schema to
version **86**. The SDK compatibility floor rises from 73 to **76**, because every SDK statement
catalogue now names `dashboard_retention_preview_v1` and `deregister_worker_v2`. An updated worker
refuses to start on a schema below version 76. A 0.9 process keeps working on version 86, because a
migration inside a major line only adds.

### The dashboard filter refuses a cross-origin read

A CORS filter earlier in the chain can add CORS headers to `run.workhorse.dashboard.Dashboard`
responses. If that policy allowed credentials, a page on another origin could read the dashboard,
task payloads included, with the operator's cookies (SM-1675). Now the filter answers 403 with
`{"error":"A same-origin request is required"}` for a page, an asset, or a read procedure whose
`Origin` header names another origin.

The same-origin check read only the first of two `Origin` headers, so a same-origin value could
hide a foreign one. Now it refuses a request with more than one `Origin` header, also for a
mutation.

The same-origin check compared the `Host` text exactly, so `Host: example.test:443` with
`Origin: https://example.test` failed. Now letter case and the default port do not matter, as in
the allowed hosts check. An `Origin` with a path, a query, a fragment, or a user fails.

A request without `Origin`, such as a top-level navigation, and a same-origin request still
work. A mutation keeps its own refusal. The change needs no migration.

Upgrade step: if a proxy in front of the host ends TLS, the host must see the scheme that the
browser used. Otherwise the dashboard page's own module scripts carry an `Origin` that does not
match, and the host refuses them.

### A failed reporter callback gives a catalogued log record

A throw from `onRegistrationError` or `onNotificationError` gave a `System.Logger` record with the
exception and no event name (SM-1726). Now the worker logs `workhorse.worker.reporter_failed` with
`workhorse.worker.id`, `workhorse.worker.reporter` (`registration_error` or `notification_error`),
and `error.type`, the class name. The record no longer carries the exception. The worker also emits
the event through OpenTelemetry at warn. The level and the bound do not change.

### The dashboard Schedules page shows the last skip of a schedule

Migration 0087 (`0087-show-the-last-schedule-skip-on-the-dashboard.sql`) moves the schema to version 86. The `dashboard/v1` cron document gains `lastSkippedAt`, `lastSkippedCount`, and
`lastSkippedThrough` on each application schedule, an additive change. The bundled Schedules page
shows a `Skipped` badge with the count and the time of the last skip of a `skip` schedule (SM-1708).
The migration does not raise the SDK compatibility floor.

### A canceled task leaves its batch while it waits

A batch handler waits up to its linger for a partial batch. Before this change, a waiting task
stayed in the batch after a cancel request or a lease loss cancelled its cancellation token. The
batch handler then got a task that the worker no longer owned, and the task settled only after the
linger (SM-1709).

Now the worker removes such a task from the batch at once. The task throws the `CancelledException`
of its reason, and the batch handler never gets it. The other waiting tasks keep their order and
dispatch. The TypeScript, Go, and Rust workers already remove such a task.

This includes the `SHUTDOWN` cancellation at the end of the shutdown grace. Before, a task that
still waited then dispatched, and the batch handler ran its payload after the deadline. Now the task
goes back to its queue without a charged attempt. Before the deadline, the drain still dispatches a
lingering batch when all its tasks have arrived.

### Features

- **`Admin` moves a queue between tiers and sets its history.** `Admin.setQueueTier` moves a queue
  to `QueueTier.FAST` or `QueueTier.FULL` and returns the tier after the change. If the tier
  differs and the queue holds a live task, the method throws `FastTierUnsupportedException`. `Admin.setQueueHistory` chooses the
  history a fast-tier queue records. A `null` setting keeps its current value. The method returns a
  `QueueHistory`. Both controls have a caller form with a `Connection`, and the Kotlin module adds
  `setQueueTierSuspend` and `setQueueHistorySuspend`. The other SDKs already have these controls
  (SM-1417).
- **The embedded dashboard changes the tier and the history of a queue.** The `Dashboard` filter
  answers the `setQueueTier` and `setQueueHistory` procedures. Each procedure is a mutation: it
  requires a same-origin request, and a read-only dashboard answers `FORBIDDEN`. `setQueueTier`
  calls `Admin.setQueueTier` with the actor that the server assigns. If Workhorse refuses the
  switch, the answer names the guard as `live_tasks`, `concurrency_policy`, or
  `rate_limit_policy`, and the queue keeps its tier. `setQueueHistory` calls
  `Admin.setQueueHistory`. An absent setting keeps its current value (SM-966).

- **The worker and the queue emit OpenTelemetry log records.** The worker and the queue emit log
  records through the OpenTelemetry Logs API, with the TypeScript event names and attributes. These
  include the checkpoint, progress, wait, signal, human wait, child, and worker life-cycle records.
  The worker also adds the `workhorse.worker.registered`, `workhorse.worker.deregistered`,
  `workhorse.handler.registered`, and `workhorse.handler.finished` records, and the
  `workhorse.maintenance.drift` histogram. The worker still writes each record to `System.Logger`.
  An event that only the Java SDK has stays on `System.Logger`. The `workhorse.handler.outcome` of
  `workhorse.task.execution_finished` now uses the bounded metric values, such as `succeeded`, in
  place of the outcome constant names. The body of `workhorse.handler.signal_swallowed` is now the
  TypeScript body (SM-1438).
- **The worker logs a statement that waits after the stop budget.** If a maintenance pass or a
  claim statement still runs after `shutdownGrace`, the worker logs one
  `workhorse.worker.statement_slow` warning. The record names the worker, the statement as
  `maintenance` or `claim`, and the time that the statement waited in milliseconds. The warning
  does not end, fail, or delay the statement. A grace of 0 turns the warning off. The record also
  goes to OpenTelemetry (SM-1785).

### Fixes

- **The worker waits longer after each `not_due` expiry answer.** When PostgreSQL answers
  `not_due` to an expiry request, the worker asked again every 5 ms. Each request locks the task
  row, so the heartbeat of the same attempt answered `busy`. The attempt could then lose its lease
  before the database expiry.

  Now the first retry waits 5 ms. Each later retry waits twice as long, to a maximum of 1 s. The
  TypeScript, Go, and Rust workers already use this schedule (SM-1701).

- **The JVM client measures signal and human wait values as PostgreSQL does.** PostgreSQL limits a
  signal payload, a human wait context, and a human wait result to 65,536 bytes of
  `octet_length(value::jsonb::text)`. That text has a space after each `:` and `,`, so it can be
  longer than compact JSON. Before this change, the JVM client counted the compact JSON. A value
  near the limit passed that check, and then PostgreSQL refused the statement with a database error
  (SM-1639).

  Now `Queue.sendSignal`, `Queue.completeHumanWait`, and `HandlerContext.waitForHuman` measure the
  canonical JSONB text before any statement. An oversized value throws `IllegalArgumentException`.
  `HandlerContext.waitForHuman` also checks the context before its tier lookup, which can read
  PostgreSQL. The limit does not change.

- **A declared pool size caps the default cohorts.** A `DataSource` reports no pool size. Before
  this change, the worker ignored `poolMaxSize` when it chose its default cohorts. A worker with
  concurrency 64 and `poolMaxSize(4)` used 8 cohorts on 2 free connections.

  Now the worker caps its default cohorts at the declared size, minus 1 for the listener and minus
  1 for the heartbeat connection. Thus that worker uses 2 cohorts. `pollingOnly(true)` reserves no
  listener connection, and `sharedHeartbeats(true)` reserves no heartbeat connection, as in the
  other SDKs. Without `poolMaxSize`, the default is not capped. An explicit `cohorts` is never
  capped (SM-1668).

- **A throwing reporter listener is logged once in each interval.** Before this change, a
  `RuntimeException` from `onRegistrationError` ended the registry thread. The exception then went
  to the uncaught exception handler of that thread on each failed refresh. The worker discarded a
  throw from `onNotificationError` without a record.

  Now the worker catches a `RuntimeException` from either listener and continues. It logs the
  failure through its `System.Logger` at the `ERROR` level. For each listener, it logs the first
  failure. Then it logs at most one failure in each 60 s, with the count of the failures that it did
  not log. It never calls the failed listener for its own failure (SM-1696).

- **Workers use the database clock for maintenance.** Maintenance writes shared due times and
  retention cutoffs. Before this change, the JVM worker sent its host clock as the maintenance time.
  If that clock was two days fast, other workers skipped a routine until that future time, and
  retention deleted a 13-day-old schedule occurrence under a 14-day policy. Now `Worker.run` and
  `Worker.runOnce` bind the text `now`, and PostgreSQL resolves it to its own time at the start of
  the call (SM-1645). The schema does not change.
- **The dashboard names an action that the host does not provide.** The `Dashboard` filter answers
  the `enqueueTest` and `setSchedulePaused` procedures only when the application gives a handler
  for them. Before this change, a writable dashboard without that handler answered `FORBIDDEN` with
  the message "This procedure is not available". Now the message is "This dashboard host does not
  provide the <action> action", as in the TypeScript dashboard server. A read-only dashboard keeps
  the message "This dashboard is read-only". The code `FORBIDDEN` and the HTTP status 403 do not
  change (SM-1705).
- **A lost notification subscription restarts the poll backoff.** Before this change, the empty
  claims of a live period counted toward the 250 ms backoff without a live subscription. After a
  loss, a worker that was idle for some time waited the 5,000 ms ceiling at once. Now the backoff
  restarts at 250 ms when the subscription is lost (SM-1648). The `subscription-recovery` case in
  `protocol/v1/runtime.json` checks this rule in every SDK.
- **A refused completion settles a due deadline or attempt timeout.** A handler can return just
  before its deadline or attempt timeout, and the completion write can then arrive after that
  boundary. PostgreSQL refuses the completion. Before this change, the worker only tried to
  acknowledge a cancellation, then recorded `lease_expired` and left the task to lease recovery. The
  task then settled up to one lease later with the wrong outcome. Now `reconcileRejectedCompletion`
  calls `expire_owned_telemetry_v1` under the attempt's fence before the completion path returns.
  The attempt then ends with the outcome of the due boundary. A cancellation request and a lost
  lease keep their own outcomes (SM-1649).
- **Workers on one pool renew their leases in one transaction.** On the dedicated heartbeat
  connection, a round sent one transaction for each worker and each 100 leases. Each transaction
  needs at least 3 round trips to PostgreSQL. With 8 workers on one pool and 80 ms for each round
  trip, workers lost leases while PostgreSQL still answered (SM-1631). Now the heartbeat thread of
  the pool sends one transaction for each round, with one `heartbeat_pool_v1` statement for every
  worker and every 100 leases. The transaction locks the task rows of every worker in it until its
  `COMMIT`. A round renews all of its leases or none. The settings statement now sets
  `statement_timeout` and `idle_in_transaction_session_timeout` each to one quarter of the time that
  remains, not to one half and one eighth. The statement needs no schema change. The
  `sharedHeartbeats(true)` opt-out does not change (SM-1633).
- **A worker reads a stored contract schema with a fraction outside the double range.** Another
  SDK can synchronize a schema such as `{"maximum": 1000…0.1}` with 310 digits before the point.
  Before this change, the JVM refused that constant, so it could not load the payload contract.
  Now `Contracts.storedSchema` reads the schema with `Json.parseSchema`, which keeps the constant as
  a `BigDecimal`, and `ContractSchema` compares it exactly. The value paths still refuse such a
  fraction (SM-1593).
- **`Queue.syncContracts` stores a schema fraction outside the double range.** Before this change,
  the JVM refused an application schema such as `{"maximum": 1000…0.1}`, with 310 digits before
  the point as a `BigDecimal`: "contract schema is not a JSON value". Now the sync converts each
  schema with `Json.parseSchema`, and PostgreSQL stores all the digits. Each value path still
  refuses such a fraction (SM-1598).
- **The dashboard reads a stored long integer without a `BigInteger` parse.** A stored value
  without a payload contract can hold integers of 131,072 digits. Before this change, each
  dashboard read parsed such an integer into a `BigInteger`, which took about 0.2 s for each
  integer. A read of a payload with seven of them kept a servlet thread busy for more than 1 s.
  Now the dashboard read procedures keep an integer outside the `long` range as its digits and
  write the digits back. The output of the procedures does not change (SM-1531).
- **A worker with `sharedHeartbeats(true)` no longer starves a pool of 1.** Before this change,
  the worker started the shared listener on any `DataSource`. On a pool of 1, the listener held the
  only connection. The compatibility check then waited for the pool timeout, 30 s in HikariCP, and
  the run failed with an error that did not name the cause. A pool without a timeout waited forever
  (SM-1585). A `DataSource` reports no size, and the worker does not probe it. Thus, with
  `sharedHeartbeats(true)`, the worker now starts the listener only when the caller declares a pool
  size of at least 2. Otherwise the worker polls. This changes behavior: a worker under the opt-out
  without a declared size now polls, also on a large pool.
- **New option `poolMaxSize(int)`** on `Worker.Builder` declares the maximum size of the pool behind
  the `DataSource`. Kotlin sets `poolMaxSize`, and the Spring starter reads
  `workhorse.worker.pool-max-size`. The worker trusts the value. With `sharedHeartbeats(true)`, a
  declared size of at least 2 keeps the listener. Without the opt-out, `build()` throws
  `IllegalArgumentException` for a declared size below 3. If an operator makes the pool smaller
  than the declared size, the listener can hold the last connection again.
- **The worker warns when it polls.** A worker that starts without the listener now logs
  `workhorse.worker.polling_only` once, at warn level. The record carries `workhorse.worker.id`,
  `workhorse.worker.queues`, and `workhorse.worker.pool_max_size`, the declared size or `unknown`.
  The warning for a listener that does not listen at startup carries the same attributes. A worker
  with `pollingOnly(true)` logs no warning.
- **A contract compares a stored schema fraction with all its digits.** Before this release, the
  SDK read a stored contract schema with the parse that reads a fraction as a `Double`. Another SDK
  can store `"minimum": 0.30000000000000000001`, which a double cannot hold, and the SDK then
  accepted `0.3`. Now the payload and result contract reads keep each schema number exact, and
  `ContractSchema` compares the `BigDecimal` (SM-1541, ADR 0039).
- **Workers on one `DataSource` no longer lose leases on a small pool.** Before this release, each
  worker held its own listener connection. When a HikariCP pool had fewer connections than
  workers, the listener connections filled the pool. The shared heartbeat then waited up to 30 s,
  the HikariCP timeout, for a connection. A lease of 3 s expired in that wait, so recovery returned
  the task to its queue while the first attempt still ran, and a second attempt could run the task
  again. Now every worker on one `DataSource` object shares one listener connection and one
  heartbeat connection. A pool needs those two connections plus one for each statement in flight,
  so at least 3 (SM-1569).
- The key of both shared connections is the `DataSource` object itself, by reference identity,
  never by `equals`. A wrapper of a pool is a key of its own, with its own two connections. So a
  worker on a wrapper and a worker on its delegate hold four connections of one physical pool.
- Each worker's queues filter its wakes from the shared listener. The last worker that stops gives
  the listener connection back to the pool. After a reconnect, the listener wakes every worker.
- The heartbeat gets its connection, and each replacement, on one checkout thread at a time. A
  round waits for that checkout only inside its round bound, 7.5 s by default, so the timeout of
  the pool never delays a renewal past the bound. The shorter deadlines of a busy retry do not
  change. A failed checkout runs again after a backoff that doubles from 100 ms up to the heartbeat
  interval, also while no task runs. A connection that arrives after every wait for it ended goes
  back to the pool.
- A failed renewal on a connection that stays open now keeps the connection. A closed or aborted
  connection is replaced at once. The first round on the replacement has the full round bound: a
  round that gets the replacement during its bound sends nothing, and a regular round then runs at
  once.
- **The shared heartbeat and listener no longer have two connections out after a slow return.**
  Before this release, the heartbeat let a connection go, and then gave it back to the pool. A new
  reservation could start a second checkout while that return still ran. The listener did the
  same with a connection that arrived after its last subscriber left. On a small pool, the second
  connection could take the last free connection from ordinary statements. Now one checkout thread
  owns each heartbeat connection until the pool has it back, and the listener keeps its checkout
  until the return ends. A new reservation or subscription waits for that return, within the
  startup budget (SM-1580).
- **A claim of an ended run no longer uses the heartbeat reservation of a later run.** Before this
  release, a claim that waited for a connection read the reservation of the latest run. The run
  could stop, and the same worker could start again. The old claim could then claim tasks that no
  handler ran, and their leases had to expire. Now each claim and each fused completion reads the
  claim gate of the run that started it. That gate closes when its run ends.
- A claim statement that passed the claim gate holds the heartbeat reservation of its run until its
  result arrives. This is also true after the stop gave up its wait for the statement. The stop
  time does not change.
- A fused claim that returns after its run stopped its wait for claims starts no handler. Before
  this release, such a claim could start a handler after the drain of its run ended. Now its tasks
  keep their leases until the leases expire, as the tasks of an abandoned ordinary claim do.
- The failure of an attempt stops only the run that admitted it. Before this release, an attempt
  that outlived its run could fail during a later run of the same worker, and stop that later run.
- A registry response applies only to the run that sent it. Each run starts with no operator pause
  and no registration, so a late response of an ended run cannot pause a later run.

### Behavior changes

- **`executionTimeout` refuses a nonzero value that rounds to 0 ms.** The queue rounds the `Duration` to
  the nearest millisecond. Before this change, a positive `Duration` below 0.5 ms rounded to 0, and
  the task had no timeout. Now the queue throws `IllegalArgumentException` for a nonzero `Duration`
  that rounds to 0 ms. `null` and `Duration.ZERO` still set no timeout. ADR 0114 records the rule
  for all seven SDKs (SM-1714).
- **A worker now checks its pool when it starts, and refuses to start on a failed check.** The
  worker reserves the heartbeat connection, starts its listener, and borrows one ordinary
  connection for the compatibility query. The reservation and the borrow share one budget, the
  larger of `heartbeat` and 5 s, and the wait for the listener between them does not count against
  it. If the two steps do not end within the budget, `run`, and the thread of `start`, throw
  `WorkhorseException`. The message names the `DataSource`, the budget of at least 3 connections,
  and the `sharedHeartbeats(true)` opt-out. Before this release, a run that could not get a
  heartbeat connection at start continued, and took the connection when its first task ran. Now a
  startup reservation failure ends that run. A worker with `sharedHeartbeats(true)` reserves
  nothing and starts as before.
- The listener stays best effort. The worker waits until the listener holds its connection, so a
  `LISTEN` that stalls does not use the time of the compatibility check. If the listener does not
  listen yet, the worker logs `workhorse.worker.polling_only` once and polls, and the listener
  keeps trying.
- **A worker claims no task while its heartbeat holds no connection.** This applies to ordinary
  claims and to the claims of fused completions. The worker reads this gate again on the borrowed
  connection, just before each claim statement goes out, a resend after a deadlock too. A fast-tier
  completion still settles its task, with a claim limit of 0. A failed renewal or a busy round does
  not close this gate. When the replacement connection arrives, the worker claims at once, without
  a wait for its next poll. Running tasks continue under their lease watchdogs.
- **The total stop time is now `shutdownGrace` plus the 250 ms unwind window.** Every wait after the
  grace ends by then, also when the pool has no free connection. Before this release, the cleanup
  after the grace could take about 2 s, of which the deregistration took up to 1 s. A deregistration
  that still waits at the end continues in the background.

### Throttle works on a fast-tier queue

Before this change, a throttled enqueue into a fast-tier queue raised `FastTierUnsupportedException` with the feature
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
`dashboard_retention_preview_v1`. The JVM dashboard host now calls it. The `previewRetentionPolicy` response does
not change.

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

`Worker` now calls `deregister_worker_v2` with the instance of the run that stops.

Each SDK keeps its guard for this release: a new run still waits for the stop statements of the
previous run, or it refuses to start. Every SDK statement catalogue names the new function, so the
SDK compatibility floor rises from schema 75 to 76. Run `workhorse schema migrate` before the first
process of this release starts. A 0.9 process keeps working on schema 76. The migration changes no
stored data.

### The worker counts a failed heartbeat round

A heartbeat round that failed before PostgreSQL answered left no metric. For example, the
connection broke or the round reached its deadline. Now the worker counts each such round once in
the new counter `workhorse.worker.heartbeat.round_failure`, by the bounded attribute
`workhorse.heartbeat.failure_reason`: `timeout`, `connection`, `database`, or `other`. The
TypeScript worker uses the same rule (SM-1704).

The shared dedicated heartbeat sends the leases of every worker on a `DataSource` in one round. A
failed round counts once for each distinct `WorkhorseTelemetry` of those workers. A failed round
still gives no ownership verdict, so `workhorse.worker.heartbeat.failure` does not change. Every
attempt keeps running, and the next round retries. The new instrument is an addition.

## 0.9.0 — 2026-10-20

This is the first release of the JVM SDK. The npm packages, Python distribution, Go module, Rust
crate, Ruby gem, and JVM artifacts release from one source commit.

Requires **schema v73**, Java **21** or newer, and PostgreSQL **15** or newer.

- The JVM SDK needs schema version 73 or later. The SDK compatibility floor is schema version
  **73**. Install or migrate the schema with the `workhorse` CLI as a deployment step, before the
  application starts. The application never installs or migrates the schema.
- The SDK has three artifacts. All three use the group `run.workhorse` and one version ([ADR
  0103](../docs/decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)):
  - `workhorse`, package `run.workhorse`: the queue client, `Admin`, the worker, and the dashboard
    backend.
  - `workhorse-kotlin`, package `run.workhorse.kotlin`: suspend handlers, suspend wrappers, and a
    worker DSL.
  - `workhorse-spring-boot-starter`, package `run.workhorse.spring`: auto-configuration,
    transactions, lifecycle, and health.
- Every module compiles with `--release 21`. The Kotlin module sets language and API version 2.2,
  and needs kotlinx-coroutines 1.10.2 or later. The starter needs Spring Boot 4.0 or later. Every
  module needs PgJDBC 42.7.12 or later. Spring Boot 4.0.0 to 4.0.7 manage an older PgJDBC, so use
  Spring Boot 4.0.8 or later, or override `postgresql.version`. [Supported
  versions](../docs/compatibility.md#supported-versions) states each floor and its end-of-life date.
- The core has two optional dependencies, the OpenTelemetry API and the Jakarta Servlet API. Maven
  does not add them. Gradle adds each one only when the build asks for its feature, `opentelemetry`
  or `servlet`.
- The worker renews leases through `heartbeat_many_v2`, and it keeps a lease that the answer marks
  `busy`. Its heartbeat rounds follow the rules of the other SDKs: a fixed schedule, a round bound
  of three quarters of the interval from 200 ms, and server timeouts in each round on the dedicated
  connection. A round that expires before it sends the heartbeat statement rolls back and keeps
  the dedicated connection, and a round that may still run a statement discards it. A busy retry
  with less than 20 ms left before its deadline sends nothing, and the next regular round renews the
  busy leases (SM-1492). For `Worker.Builder.heartbeat` and `WorkerScope.heartbeat`, 100 ms is the
  smallest supported value. The [heartbeat round
  deadline](../docs/architecture/lifecycle.md#heartbeat-round-deadline) and the [heartbeat
  schedule](../docs/architecture/lifecycle.md#heartbeat-schedule) state each rule.
- Migration 0074 adds `heartbeat_v2`, which renews one lease by the rule of `heartbeat_many_v2`
  and reports a locked row as `busy` (SM-1461). The JVM SDK names it in its statement catalogue but
  does not call it. `heartbeat_v1` does not change.
- The Java API is ready for the Gate 2 freeze of [ADR
  0056](../docs/decisions/0056-set-the-1-0-0-exit-criteria.md). A public record can get a new
  component only at the end, and it keeps each earlier canonical constructor; a record pattern that
  names all components is outside the compatibility promise. The name filter of
  `Queue.listBudgets`, `listConcurrencyPolicies`, and `listRateLimitPolicies` is non-null: an empty
  list or the overload without a filter reads every row. A `BigDecimal` payload value reaches
  PostgreSQL with all its digits, and the enqueue refuses a decimal that `numeric` cannot store.
  `Queue` and `Admin` check compatibility once for each physical connection behind a pool, and the
  check does not hold the queue lock. The ADR 0103 amendments of 2026-10-20 state each rule.
- A `BigDecimal` in a handler result, a checkpoint value, progress, or a human wait context keeps
  all its digits, and a result contract checks the exact value. The enqueue and the worker refuse a
  decimal with fraction digits outside the `double` range, because the SDK cannot read the stored
  value back.
- If a run that `Worker.start()` began ends without a `stop()`, the worker logs the error at once
  at `ERROR`, as `workhorse.worker.run_failed`. In a Spring application that serves no web requests,
  the starter then exits the process with a non-zero status, so a supervisor can restart it. A web
  application keeps running, and its health indicator reports the worker as `DOWN`.
- `TransactionAwareConnectionSource` joins only a transaction of its own `DataSource`, for example
  one of `DataSourceTransactionManager` or `JpaTransactionManager`. Under a transaction of another
  transaction manager, it runs the call in autocommit, so the task commits also when the pool turns
  autocommit off. When the context has a `JtaTransactionManager`, it still joins the JTA
  transaction.
- The starter has a new property, `workhorse.data-source`, the bean name of the `DataSource` for
  every Workhorse bean. It is an additive API change: `WorkhorseProperties` gets
  `getDataSource()` and `setDataSource(String)`. If the property names no `DataSource` bean, the
  context does not start. Without the property, the starter uses the only or the `@Primary`
  `DataSource`. With several `DataSource` beans and no selection, it builds no bean and logs a
  warning (SM-1527).
- The starter refuses two `TaskHandler` beans for one task type at startup. It logs the worker-off
  warning when `TaskHandler` beans exist and no `Worker` bean exists, for example for
  `workhorse.worker.enabled=on`. The dashboard filter reports `workhorse.worker.maintenance-interval`
  as its tick interval (SM-1527).
- Kotlin `handle<P>` and `handleBatch<P>` decode each payload as the full type of `P`, with its type
  arguments, such as `List<Order>`. `Worker.Builder.handleBatch(String, Type, BatchOptions,
  BatchHandler)` is the new Java overload that `handleBatch<P>` uses.
- The internal Kotlin helper `blocking` is no longer `@PublishedApi`, so it is not part of the
  published API.
- The `workhorse-kotlin` `-javadoc.jar` holds the Dokka HTML of the module's KDoc, so javadoc.io
  and an IDE show the Kotlin API documentation.
- The release key signs every file of the three artifacts. It is an ed25519 key with the
  fingerprint `B933E2F16C3FA58E5414849A024210DB67A17773`. Use it to check a `.asc` file from Maven
  Central. [Publication credentials](../docs/compatibility.md#publication-credentials) states it.
- A `Float` value reaches PostgreSQL with its shortest `float` digits, so `0.1f` is `0.1`, also in a
  checkpoint input fingerprint (SM-1528). A result, a checkpoint value, progress, and a payload
  refuse a number with more fraction digits than `numeric` stores before any statement, also when
  the value equals a `double` (SM-1540).
- A durable replay conflict inside a wrapper, such as the `CompletionException` of a `join()`, fails
  the task at once and records the conflict class name, as in Go and Rust (SM-1512).
- A child request reads its payload contract through the drain's interrupt, so a drain gives the
  parent back to its queue instead of failing it. At the drain deadline, a task that the caller's
  `executor` never started goes back to its queue, and `ShutdownIncompleteException` does not
  count it. If telemetry or the logger throws before a batch handler runs, each task of the batch
  fails, and no task waits forever (SM-1525).
- `Queue` and `Admin` return the result of a successful call when the connection release fails, and
  log the release error, so a caller does not retry a committed write. `EnqueueOptions` and
  `ScheduledTask` copy the retry policy. An unknown non-replaceable reason throws
  `UnexpectedStatusException` (SM-1525).
- In a Kotlin suspend handler, the `workhorse.handler` span is the current span on every thread
  that runs the handler's coroutine. A task that the handler enqueues joins the handler's trace. The
  module finds OpenTelemetry by reflection, and loads no OpenTelemetry class when the API is absent.
- If a JSON value is `null` and the reified type is not nullable, the Kotlin module throws
  `IllegalArgumentException`. This applies to the payload of `handle<P>`, and to the values of
  `checkpoint`, `waitForSignal`, `waitForHuman`, and `runChild`. For `handle<P>`, the handler does
  not run, and the attempt fails. Write a nullable type, such as `handle<Order?>`, to receive
  `null`.
- A Kotlin `Queue` or `Admin` suspend wrapper with a `connection` runs on the calling thread with no
  interrupt. A cancellation reaches the caller after the statement ends, so the caller's
  transaction stays usable.
