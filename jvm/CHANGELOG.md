# JVM changelog

The versions and release notes of the three JVM artifacts live here: `run.workhorse:workhorse`,
`run.workhorse:workhorse-kotlin`, and `run.workhorse:workhorse-spring-boot-starter`. The three
artifacts always carry one version. It is the version that the other SDKs carry, because every
release tag names one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## Unreleased

### Features

- **`Admin` moves a queue between tiers and sets its history.** `Admin.setQueueTier` moves a queue
  to `QueueTier.FAST` or `QueueTier.FULL` and returns the tier after the change. If the tier
  differs and the queue holds a live task, the method throws `FastTierUnsupportedException`. `Admin.setQueueHistory` chooses the
  history a fast-tier queue records. A `null` setting keeps its current value. The method returns a
  `QueueHistory`. Both controls have a caller form with a `Connection`, and the Kotlin module adds
  `setQueueTierSuspend` and `setQueueHistorySuspend`. The other SDKs already have these controls
  (SM-1417).

### Fixes

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
