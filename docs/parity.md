# Language feature parity

This is the authoritative per-language support matrix for the Workhorse SDKs, anchored to schema
version 85. It owns one question: which language can use which capability today. What each
capability does, and its exact limits, stay owned by [docs/features.md](features.md); this
document never restates them.

Statuses:

- **Supported.** Shipped in that language and covered by tests in this repository.
- **Planned.** Deliberately sequenced work with an open Linear Issue. The Issue owns the
  acceptance criteria; this matrix records the resulting language support.
- **Absent.** Not shipped and not scheduled. An Absent cell is a fact, not a commitment.

Two boundaries keep this matrix small:

- PostgreSQL owns accepted JSON values, lifecycle transitions, idempotency, retries, waits,
  fencing, and structured errors (see `protocol/README.md`). Behavior PostgreSQL owns cannot
  diverge between languages, so it has no row here. A language row exists only for behavior a
  client or worker runtime supplies itself.
- PostgreSQL operator capabilities and public SDK reachability are separate tables below. This
  keeps a shared database capability from implying that every language exposes a matching client.

Ruby is the fifth SDK, shipped as the `stablemates-workhorse` gem ([ADR
0075](decisions/0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md)). Its client, `Admin` client,
dashboard backend, worker runtime, durable handler context, fast task tier, and batch delivery ship
today.

The JVM SDK is the sixth SDK ([ADR
0103](decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)). Its
`JVM` column describes the `workhorse` artifact, which Java, Kotlin, and Spring callers use. Its
client, `Admin` client, dashboard backend, worker runtime, durable handler context, fast task tier,
batch delivery, and OpenTelemetry support are tested today. Every JVM cell of the capability tables
below is Supported. Maven Central serves the JVM artifacts from `0.9.0`.

The .NET SDK is the seventh SDK ([ADR
0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)).
Its `.NET` column describes the `Workhorse` package. Every `Workhorse.Hosting`,
`Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore` caller uses that package. Its client,
`Admin` client, dashboard backend, worker runtime, durable handler context, fast task tier, batch
delivery, and telemetry are tested today. Every .NET cell of the capability tables below is
Supported. Two known differences do not change a cell:

- The public demo runs no .NET worker. [SM-1630](https://linear.app/stablemates/issue/SM-1630) adds
  a .NET demo worker program that only tests run. The maintainer decides in
  [SM-1680](https://linear.app/stablemates/issue/SM-1680) whether the public demo runs it.
- CI tests `Workhorse.EntityFrameworkCore` on EF Core 10 only. EF Core 11 waits for its Npgsql
  provider ([SM-1678](https://linear.app/stablemates/issue/SM-1678)). The "Transactional enqueue in a
  caller-owned tx" cell describes the `Workhorse` package, so EF Core 10 does not limit it.

## Client (enqueue side)

<!-- BEGIN GENERATED PARITY CLIENT -->

| Capability                                 | TypeScript | Python    | Go        | Rust      | Ruby      | JVM       | .NET      |
| ------------------------------------------ | ---------- | --------- | --------- | --------- | --------- | --------- | --------- |
| Transactional enqueue in a caller-owned tx | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Atomic batch enqueue                       | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Task groups with completion callbacks      | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Delayed enqueue (`runAt` / `run_at`)       | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Priority                                   | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Tags and max attempts                      | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Persisted retry policies                   | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Absolute deadlines and execution timeouts  | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Enqueue idempotency                        | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Keyed debounce                             | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Keyed throttle                             | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Task dependencies with terminal policies   | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Concurrency keys                           | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Concurrency policy management              | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Rate-limit policy management               | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Named budget management                    | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Recurring schedule definition sync         | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Payload and result contracts               | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Compatibility refusal before mutation      | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Public startup schema compatibility check  | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| SQL protocol conformance fixtures executed | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Enqueue trace-context propagation          | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |

<!-- END GENERATED PARITY CLIENT -->

The .NET "Enqueue trace-context propagation" cell cites the C# implementation and its test.
`Instrumentation.InjectTraceContext` in `dotnet/src/Workhorse/Internal/Telemetry/Instrumentation.cs`
stores the W3C trace context of the caller at enqueue. The test
`TelemetryDatabaseTests.TheHandlerSpanContinuesTheTraceOfTheEnqueue` checks that the handler span
continues that trace.

A .NET caller gets the PostgreSQL diagnostic details with the default Npgsql settings. Npgsql hides
DETAIL unless the connection string sets `Include Error Detail=true`. So the SDK reads the same JSON
from HINT when DETAIL is hidden ([ADR
0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md),
"Amendment: HINT carries the diagnostic details"). The test
`ErrorDetailTests.ADefaultDataSourceFillsTheTypedValuesFromTheHint` holds this.

## Worker runtime

Every worker row is the runtime's own responsibility above the SQL protocol: local validation,
handler dispatch, concurrency, heartbeats, polling or notifications, cancellation delivery,
telemetry, and graceful shutdown.

<!-- BEGIN GENERATED PARITY WORKER -->

| Capability                                                  | TypeScript | Python    | Go        | Rust      | Ruby      | JVM       | .NET      |
| ----------------------------------------------------------- | ---------- | --------- | --------- | --------- | --------- | --------- | --------- |
| Claiming and handler execution                              | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Bounded worker concurrency                                  | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Fast task tier with one outcome row per task                | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Fused fast-tier completion and refill claim in slot cohorts | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Unhandled task type released to its queue                   | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Heartbeats, lease recovery, fenced ownership                | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Cooperative cancellation delivery                           | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Notification-assisted dispatch with polling                 | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Durable checkpoints (handler context)                       | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Checkpoint input check                                      | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Durable timers (`sleep` / `sleepUntil`)                     | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Signal and human-decision waits                             | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Linked child fan-out and result join                        | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Task group reads and adds from a handler                    | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Latest-value progress reporting                             | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Batch handler delivery                                      | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Schedule firing (database cron evaluation)                  | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Worker fleet registration and remote pause                  | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Graceful stop and signal drain                              | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Retention maintenance participation                         | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| OpenTelemetry tracing and metrics                           | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Shared runtime fixtures executed                            | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |

<!-- END GENERATED PARITY WORKER -->

The `workhorse-kotlin` module reaches every cell of the JVM column through the core. Its suspend
handlers, its worker DSL, and its suspend wrappers call the `workhorse` artifact and add no protocol
behavior. The Spring Boot starter reaches every Client, Worker, and Operator cell through the
`Queue` and `Admin` beans and the `Worker` that it builds.

`Workhorse.Hosting` reaches every Client and Worker cell of the .NET column through the services it
registers: the `Queue`, the `Admin`, and the hosted `Worker`. A .NET `Worker` installs no signal
handler. The Generic Host stops it when the process gets a stop signal. The "Graceful stop and
signal drain" cell cites the test that drains a hosted worker when the host stops.

## Reporter callback failures

A reporter callback is a worker option that observes the worker, such as the registration error
callback. A reporter is not part of the dispatch contract. Thus, if a reporter fails, the worker
continues to claim and run tasks, and the result of the run does not change.

In TypeScript, Python, Go, Rust, Ruby, and the JVM, the worker catches the failure and writes a
bounded report. For each callback, it writes the first failure. Then it writes at most one failure
in each 60 s, with the count of the failures that it did not write. It never calls the failed
reporter for its own failure. If the report itself fails, the worker ignores that failure.

| SDK        | Reporter callbacks                                            | Failure that the worker catches                | Report                                                         |
| ---------- | ------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| TypeScript | `onRegistrationError`, `onNotificationError`, `onMaintenance` | A throw, or a promise or thenable that rejects | `console.error`                                                |
| Python     | `on_registration_error`, `on_notification_error`              | An `Exception`                                 | The `workhorse.worker` logger, at error                        |
| Go         | `OnRegistrationError`                                         | A panic                                        | `WorkerOptions.Logger`, at error                               |
| Rust       | `on_registration_error`                                       | A panic                                        | `tracing`, at error                                            |
| Ruby       | `on_registration_error`, `on_notification_error`              | A `StandardError`                              | `logger` at error, or standard error                           |
| JVM        | `onRegistrationError`, `onNotificationError`                  | A `RuntimeException`                           | The worker's `System.Logger`, at `ERROR`                       |
| .NET       | The `RegistrationError` and `NotificationError` events        | An `Exception`                                 | None ([SM-1726](https://linear.app/stablemates/issue/SM-1726)) |

Only TypeScript has a maintenance reporter. Go and Rust have no notification reporter: their
workers write a listener failure to their logger. A Python, Go, Rust, Ruby, JVM, or .NET reporter
returns no value that the worker awaits. Thus, these SDKs have no asynchronous reporter failure.
The worker does not await an awaitable that a Python callback returns. An `async void` .NET event
handler fails outside the worker.

The .NET worker drops a reporter failure without a log record. Every .NET log record carries an
event name of the shared telemetry catalogue, and that catalogue has no name for this failure.
[SM-1726](https://linear.app/stablemates/issue/SM-1726) adds a catalogued event name for a reporter
failure in every SDK. A Rust panic also goes to the panic hook of the process, which writes each
panic to standard error by default.

## Active Job reachability

The Ruby column above records the native SDK. A Rails application can also reach Workhorse through
Active Job, and that path cannot express everything the native SDK can. This table records which
capabilities an Active Job job reaches, by the job format ADR 0075 defines. A default job carries
Active Job's own serialization under the `active_job` task type. A typed job declares a task type
and carries one JSON `Hash`, so any SDK can enqueue or handle it.

- **Native only.** Active Job has no vocabulary for the capability. A caller reaches it through the
  native Ruby SDK.
- **Payload only.** The typed job's payload is the task's payload, so a payload contract applies.
  A result contract does not, because the adapter stores no result for either format.

<!-- BEGIN GENERATED PARITY ACTIVE JOB -->

| Capability                                   | Default job | Typed job               |
| -------------------------------------------- | ----------- | ----------------------- |
| Transactional enqueue in a caller-owned tx   | Supported   | Supported               |
| Atomic batch enqueue                         | Supported   | Supported               |
| Delayed enqueue (`runAt` / `run_at`)         | Supported   | Supported               |
| Priority                                     | Supported   | Supported               |
| Tags and max attempts                        | Supported   | Supported               |
| Concurrency keys                             | Supported   | Supported               |
| Enqueue trace-context propagation            | Supported   | Supported               |
| Claiming and handler execution               | Supported   | Supported               |
| Bounded worker concurrency                   | Supported   | Supported               |
| Heartbeats, lease recovery, fenced ownership | Supported   | Supported               |
| Graceful stop and signal drain               | Supported   | Supported               |
| Payload and result contracts                 | Native only | Payload only, Supported |
| Persisted retry policies                     | Native only | Native only             |
| Absolute deadlines and execution timeouts    | Native only | Native only             |
| Enqueue idempotency                          | Native only | Native only             |
| Keyed debounce                               | Native only | Native only             |
| Keyed throttle                               | Native only | Native only             |
| Task groups with completion callbacks        | Supported   | Supported               |
| Task dependencies with terminal policies     | Native only | Native only             |
| Recurring schedule definition sync           | Native only | Native only             |
| Cooperative cancellation delivery            | Native only | Native only             |
| Durable checkpoints (handler context)        | Native only | Native only             |
| Durable timers (`sleep` / `sleepUntil`)      | Native only | Native only             |
| Signal and human-decision waits              | Native only | Native only             |
| Linked child fan-out and result join         | Native only | Native only             |
| Latest-value progress reporting              | Native only | Native only             |
| Batch handler delivery                       | Native only | Native only             |

<!-- END GENERATED PARITY ACTIVE JOB -->

Durable execution stays native-only for both formats. Checkpoints, timers, waits, child fan-out,
progress, and batch delivery need a handler context, and `perform` never receives one. An Active
Job cell can be Supported only while the native Ruby cell for the same capability is Supported.

## Worker runtime defaults

A capability row answers whether a language can do something. It says nothing about what that
language does when the caller configures nothing, and that is the behavior an operator actually
runs. Seven runtimes can agree on every row above and still drain, poll, and retry differently out
of the box.

The table below is the whole list. A default differs only where the host language forces it, which
[ADR 0072](decisions/0072-converge-the-worker-runtime-defaults.md) records as the rule. Two rows
differ today, and the reasons follow the table.

<!-- BEGIN GENERATED PARITY DEFAULTS -->

| Setting                                           | TypeScript                                                | Python                                                    | Go                                                        | Rust                                                      | Ruby                                                      | JVM                                                       | .NET                                                      |
| ------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| Worker concurrency                                | 1                                                         | 1                                                         | 1                                                         | 1                                                         | 1                                                         | 1                                                         | 1                                                         |
| Lease duration                                    | 30,000 ms                                                 | 30,000 ms                                                 | 30,000 ms                                                 | 30,000 ms                                                 | 30,000 ms                                                 | 30,000 ms                                                 | 30,000 ms                                                 |
| Heartbeat interval                                | max(100 ms, lease duration / 3)                           | max(100 ms, lease duration / 3)                           | max(100 ms, lease duration / 3)                           | max(100 ms, lease duration / 3)                           | max(100 ms, lease duration / 3)                           | max(100 ms, lease duration / 3)                           | max(100 ms, lease duration / 3)                           |
| Claim poll interval (subscription live)           | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  |
| Claim poll interval (polling only)                | 250 ms                                                    | 250 ms                                                    | 250 ms                                                    | 250 ms                                                    | 250 ms                                                    | 250 ms                                                    | 250 ms                                                    |
| Empty-claim backoff ceiling                       | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  |
| Maintenance tick interval                         | 1,000 ms                                                  | 1,000 ms                                                  | 1,000 ms                                                  | 1,000 ms                                                  | 1,000 ms                                                  | 1,000 ms                                                  | 1,000 ms                                                  |
| Maintenance routine offer interval                | 60,000 ms                                                 | 60,000 ms                                                 | 60,000 ms                                                 | 60,000 ms                                                 | 60,000 ms                                                 | 60,000 ms                                                 | 60,000 ms                                                 |
| Worker registry interval                          | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  | 5,000 ms                                                  |
| Schedule catch-up limit                           | 100                                                       | 100                                                       | 100                                                       | 100                                                       | 100                                                       | 100                                                       | 100                                                       |
| Dispatch cohorts                                  | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | 1 below concurrency 8, else concurrency / 8 within 2 to 8 | 1 below concurrency 8, else concurrency / 8 within 2 to 8 |
| Shutdown grace, then                              | 25,000 ms, then exit the process                          | 25,000 ms, then exit the process                          | 25,000 ms, then abandon the handlers                      | 25,000 ms, then abandon the handlers                      | 25,000 ms, then abandon the handlers                      | 25,000 ms, then abandon the handlers                      | 25,000 ms, then abandon the handlers                      |
| Handler retry delay override                      | `retryDelayMs`, unset                                     | `retry_delay_ms`, unset                                   | `RetryDelay`, unset                                       | `retry_delay`, unset                                      | `retry_delay`, unset                                      | `retryDelay`, unset                                       | `RetryDelay`, unset                                       |
| Queue of a handler task group add without a queue | The queue of the member task                              | The queue of the member task                              | The queue of the member task                              | The queue of the member task                              | The queue of the member task                              | The queue of the member task                              | The queue of the member task                              |
| Queue of a child task request without a queue     | The queue of the parent task                              | The queue of the parent task                              | The queue of the parent task                              | The queue of the parent task                              | The queue of the parent task                              | The queue of the parent task                              | The queue of the parent task                              |

<!-- END GENERATED PARITY DEFAULTS -->

Three rows carry a condition the setting name alone cannot.

- **Claim poll interval.** A worker claims on one of two schedules. While its `LISTEN` subscription
  is live, a notification wakes it, so polling is only a fallback and the worker waits the ceiling
  between empty claims. A worker without a live subscription starts at 250 ms and doubles toward
  that same ceiling. That includes a worker that cannot subscribe, because a connection pooler
  forbids `LISTEN` or the caller asked for polling only. It also includes a worker whose listener
  has not run `LISTEN` yet, or reconnects after a lost connection. All seven read the subscription
  state before each wait. A lost subscription wakes the worker, and the backoff then restarts at
  250 ms, because the empty claims of the live period do not count. The `subscription-recovery`
  runtime fixture checks these rules.
- **Dispatch cohorts.** A worker splits its slots into cohorts so fused fast-tier completions do
  not run in lockstep. The quotient rounds up, and a worker that knows its pool size caps the
  default at the connections left after its listener and heartbeat connection. A worker that
  only polls reserves no listener connection, and a worker with shared heartbeats reserves no
  heartbeat connection. An explicit cohort count is never capped.
- **Maintenance routine offer interval.** All seven tick maintenance every 1,000 ms, which bounds
  dispatch latency. The slower retention routines keep their own minute, because PostgreSQL owns
  the global due decision and a faster offer only adds rejected calls. All seven bind the text
  `now` as the maintenance time, so the database clock sets due times and retention cutoffs. The
  Python asyncpg driver reads `database_time` first, which adds one round trip to each routine
  pass.

The shutdown deadline agrees at 25,000 ms, and it sits under the 30 second termination grace a
container platform gives a process by default. What follows that deadline cannot agree, and it is
the one accepted exception.

A TypeScript or Python worker owns a process, so its deadline ends that process. A Go, Rust, Ruby,
JVM, or .NET `Worker` runs inside a caller's process, and a library that ends someone else's process is wrong. Its deadline
cancels the handlers, gives them one short window to unwind, then stops renewing the leases of
whatever still runs. It returns `ErrShutdownIncomplete` in Go or `Error::ShutdownIncomplete` in
Rust. It raises `ShutdownIncompleteError` in Ruby and throws `ShutdownIncompleteException` on the
JVM and in .NET. The caller decides whether to exit.

PostgreSQL sees the same thing either way. An abandoned handler holds a lease no one renews, so
`recover_expired_telemetry_v1` recovers its task exactly as it recovers the task of a process that
exited at its own deadline. What differs is what the handler observes: a Go, Rust, Ruby, JVM, or .NET
handler observes cancellation, where a TypeScript or Python handler observes termination.

The queue of a handler task group add agrees. A handler can add a task to its own task group. If
the request names no queue, all seven SDKs put the task in the queue of the member task that adds it.
A worker just ran that member task, so a worker serves its queue. The queue of a child task request
agrees for the same reason. If a child task request names no queue, all seven SDKs put the child in
the queue of the parent task. [ADR
0097](decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md) records the rule.

The retry delay override sends one attempt's delay to `fail_v1` in place of the persisted policy's
choice. All seven SDKs carry it and all seven leave it unset, so the persisted retry policy chooses
every delay until a caller says otherwise.

## Integer semantics

PostgreSQL stores a `jsonb` number at full precision, but the SDKs do not read one the same way.
Python decodes a JSON integer as a Python `int`, which is unbounded. Ruby decodes it through
`JSON.parse` as an `Integer`, which is also unbounded. The JVM default codec,
`JsonCodec.standard()`, decodes it as a `Long` inside the signed 64-bit range and as a `BigInteger`
outside it. The Spring Boot `JacksonJsonCodec` also keeps an integer exact. Rust's `serde_json`
holds an integer exactly within the signed and unsigned 64-bit ranges. TypeScript and Go decode it
as an IEEE-754 double, which holds integers exactly only up to 2^53 - 1.

So a payload, result, checkpoint, or progress value that carries an integer larger than
9,007,199,254,740,991 in magnitude is not portable. Enqueued from Python and handled by a Python,
Ruby, or JVM worker, it survives. A Rust worker keeps it while it fits in 64 bits. Enqueued from
Python and handled by a TypeScript or Go worker, it arrives rounded: the worker never sees the value
the caller sent, and never reports an error.

Workhorse does not reject such a value, because PostgreSQL accepts it and some languages read it
correctly. Send an identifier beyond that bound as a string instead. Within the bound every SDK
round-trips an integer exactly, and `typescript/core/test/json-integers.test.ts`,
`python/tests/test_json_integers.py`, and `go/json_integers_test.go` hold those languages to that.
`jvm/workhorse/src/test/java/run/workhorse/internal/JsonTest.java` holds the JVM parser to a
`BigInteger` above the 64-bit range.

Linear owns the SDK roadmap, sequencing, blockers, and completion state in the `stablemates`
workspace, `SM` team, and `workhorse` project. This document changes only
when repository tests prove a capability has shipped or been withdrawn.

## Product operator capability

PostgreSQL implements every operator read and control. The standalone or embedded dashboard and
the `workhorse` CLI expose the subsets shown below against any database, whatever language
enqueued the work. That product capability does not vary by worker language.

Every Planned cell below must be Supported before 1.0.0
(WH-581). Adding a command or a procedure later
would not break anything, so this is not a compatibility requirement; it is the point at which an
operator surface stops being excused as beta-incomplete. An operator should not have to change
tools mid-incident because one action is only in the browser. The rule also applies to each
capability that the table gets after WH-581, so the Planned task group cell must be Supported
before 1.0.0.

<!-- BEGIN GENERATED PARITY PRODUCT -->

| Capability                                 | PostgreSQL | Dashboard | CLI       |
| ------------------------------------------ | ---------- | --------- | --------- |
| Task lookup, listing, and timeline         | Supported  | Supported | Supported |
| Queue health snapshot                      | Supported  | Supported | Supported |
| Cancellation requests                      | Supported  | Supported | Supported |
| Queue pause and resume                     | Supported  | Supported | Supported |
| Queue purge                                | Supported  | Supported | Supported |
| Dead-letter listing                        | Supported  | Supported | Supported |
| Redrive                                    | Supported  | Supported | Supported |
| Checkpoint, wait, and human-decision reads | Supported  | Supported | Supported |
| Durable operator worker pause              | Supported  | Supported | Supported |
| Task group listing, detail, and cancel     | Supported  | Supported | Supported |

<!-- END GENERATED PARITY PRODUCT -->

## Public SDK operator surface

This table records the narrower fact of which language lets application code invoke an operation
through its own public SDK.

<!-- BEGIN GENERATED PARITY OPERATOR -->

| Capability                                 | TypeScript | Python    | Go        | Rust      | Ruby      | JVM       | .NET      |
| ------------------------------------------ | ---------- | --------- | --------- | --------- | --------- | --------- | --------- |
| Task lookup, listing, and timeline         | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Queue health snapshot                      | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Cancellation requests                      | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Queue pause, resume, and purge             | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Queue tier and history controls            | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Dead-letter listing and redrive            | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Task group cancel                          | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Task group drift listing and repair        | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Checkpoint, wait, and human-decision reads | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Durable operator worker pause              | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |
| Embedded dashboard backend                 | Supported  | Supported | Supported | Supported | Supported | Supported | Supported |

<!-- END GENERATED PARITY OPERATOR -->

TypeScript, Go, Rust, Ruby, the JVM, and .NET expose these methods through dedicated public `Admin`
clients. Python provides synchronous `Admin` over Psycopg and `AsyncAdmin` over Psycopg or asyncpg.
Their embedded dashboards call the same clients for shared operator reads and controls. Cancellation
remains application-shaped, so every queue client exposes it with audit attribution.

The table above lists the operator operations that every SDK exposes. It is not the full TypeScript
operator surface. Only the TypeScript SDK has public methods for these operator operations:

- `Admin.runTaskNow`, which releases a future-scheduled task now.
- The lineage reads `Admin.getRedriveLineage`, `Admin.getDependencyLineage`, and
  `Admin.getChildLineage`.
- The dependency drift list and repair, `Admin.listDependencyDrift` and
  `Admin.repairDependencyDrift`.
- The metric snapshots `queueMetricSnapshot` and `budgetMetricSnapshot`, on `Admin` and `Queue`.
- The schedule reads and controls `schedules`, on `Admin` and `Queue`, and `Queue.fireSchedule`.
- The status reads `Queue.rateLimitStatuses` and `Queue.budgetStatuses`.
- The retention policy methods `Queue.syncRetentionPolicy`, `overrideRetentionPolicy`,
  `revertRetentionPolicy`, `previewRetentionPolicy`, and `getRetentionPolicy`.
- The maintenance policy methods `Queue.syncMaintenancePolicy`, `overrideMaintenancePolicy`,
  `revertMaintenancePolicy`, and `getMaintenancePolicy`.
- The cold export methods `Queue.setColdExportPolicy` and `Queue.getColdExportStatus`.

`Admin` also has `getRetentionPolicy`, `previewRetentionPolicy`, and `getMaintenancePolicy` in
TypeScript only. The statement catalogue of each SDK holds the SQL of many of these operations,
for example `run_task_now_v1` and `get_retention_policy_v1`. No public method in Python, Go, Rust,
Ruby, the JVM, or .NET uses those statements. In those languages, the embedded dashboard gives some of
these operations: run now, the lineage reads, and the retention and maintenance policy controls.
For the other operations, an operator must run TypeScript code.

ADR 0059 sets the 1.0.0 parity bar, and the TypeScript-only methods are not part of it.
Amendments to [ADR 0074](decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md),
[ADR 0075](decisions/0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md), and
[ADR 0103](decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)
state this bar for the Rust, Ruby, and JVM `Admin` clients. [ADR
0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)
states it for the .NET `Admin` client.

The queue tier and history controls are in the `Admin` client of all seven SDKs.
[SM-1417](https://linear.app/stablemates/issue/SM-1417) added them to Ruby and the JVM.

The embedded dashboard backend row records which language can serve the dashboard from its own HTTP
server ([ADR 0029](decisions/0029-embeddable-dashboard-backends.md)). A cell is Supported only when
that backend passes the shared `dashboard/v1` HTTP fixtures. [ADR
0074](decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md) gives Rust a `tower::Service`
backend behind the `dashboard` feature. Ruby serves it as a Rack application that a Rails route or
`Rack::Builder#map` mounts. The JVM serves it as `run.workhorse.dashboard.Dashboard`, a Jakarta
Servlet filter that the host application registers. .NET serves it from `Workhorse.AspNetCore`,
whose `MapWorkhorseDashboard` maps it on an ASP.NET Core route.

## Schema tooling is TypeScript-only, deliberately

Schema installation and migration ship in `@stablemates/workhorse` and nowhere else. That is a
decision, not a gap in the matrix. Thus no row above records it as Absent for Python, Go, Rust,
Ruby, the JVM, or .NET.

Two reasons hold it there. No component can own an automatic migration, because no component is a
singleton: the dashboard and every worker deploy on many nodes as part of an ordinary application
deploy, so a component that migrated itself would be many concurrent migrators rather than one
deliberate step. And `applySchemaMigrationPlan` is the most safety-critical code in this
repository — an advisory lock, a post-lock version guard, gap rejection, transaction-control
rejection, per-step atomic rollback, and a concurrent-migrator race that must be read as success.
One implementation of that is worth more than five filled cells
([ADR 0053](decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)).

A Python, Go, Rust, Ruby, Java, Kotlin, or .NET deployment therefore runs the TypeScript CLI as a
pipeline step, at the version its own SDK declares. It verifies with `workhorse schema status
--json` before it starts. What every
language does ship is the startup check that reads the result: the "Public startup schema
compatibility check" row above is Supported everywhere, and it is what turns a missed migration
into a refused start rather than a corrupted write.

This boundary holds at 1.0.0, and the CLI and TUI hold it with the schema tooling
([ADR 0059](decisions/0059-assemble-the-1-0-0-specification.md)). The 1.0.0 parity bar is the
product table: the dashboard and the CLI give each operator capability against any database,
whatever language enqueued the work. 1.0.0 also promises that each language refuses to start
against a schema it cannot speak. Each SDK `Admin` client covers the rows of the public SDK
operator table. 1.0.0 does not promise the TypeScript-only operator methods in other languages, and
it does not promise a second migration runner in each language.

## Keeping this document honest

If a cell says Supported, tests in this repository must exercise that capability in that language.
The conformance fixtures under `protocol/v1/` are the intended enforcement point. The TypeScript
suite runs the SQL fixtures through `scripts/verify-sql-protocol.ts` and the runtime fixtures through
`Worker`. All seven SDKs execute `protocol/v1/contracts.json`. The Python suite runs the SQL
fixtures through `python/tests/test_protocol_conformance.py` and every runtime fixture through
`python/tests/test_worker_runtime_conformance.py`. The Rust suite runs every `protocol/v1` fixture
category through `rust/tests/protocol_conformance.rs`, and
`rust/tests/conformance/expected-unsupported.json` lists no exception. The Ruby suite runs every
`protocol/v1` fixture through `ruby/spec/conformance/protocol_conformance_spec.rb`. The JVM suite
runs every `protocol/v1` fixture through
`jvm/workhorse/src/test/java/run/workhorse/conformance/ProtocolConformanceTest.java`. The .NET suite
runs every `protocol/v1` fixture through
`dotnet/tests/Workhorse.Tests/Conformance/ProtocolConformanceTests.cs`. The Ruby, JVM, and .NET
`expected-unsupported.json` files list no exception. Each suite fails if a fixture that the file
does not list does not pass.

`scripts/generate-parity-tables.ts` renders every capability matrix from
`typescript/core/test/support/parity-capabilities.ts`. `pnpm parity:check` fails if the checked-in
document is stale. Every Supported cell must name an existing test file for that surface. The file
must match every evidence pattern. Every Absent cell must record why it is absent. Every Planned
cell must name a Linear `SM-*` issue, whose link the generator also writes.

A Rust Supported cell cites executed evidence instead of a pattern in a test file. It names either
`protocol/v1` fixtures or one test function in a file that `pnpm rust:integration` runs. The Rust
runner in `rust/tests/protocol_conformance.rs` executes every fixture. It fails on a fixture that
neither passes nor appears in `rust/tests/conformance/expected-unsupported.json`. `pnpm parity:check`
fails when a cited fixture does not exist or the list still holds it. It also fails when the cited
file is not in that script or has no test function by that name. That script requires a database,
so the named test cannot skip there.

A Ruby Supported cell follows the same rule. It names either `protocol/v1` fixtures or one example
in a `ruby/spec` file that `pnpm ruby:test` runs. The Ruby runner fails on a fixture that neither
passes nor appears on its expected-unsupported list. It also fails on a listed fixture that passes,
so a gap closes by removing its entry. `pnpm parity:check` fails when a cited fixture does not
exist or the list still holds it. It also fails when no `ruby/spec` file by that name exists or the
file has no example by that name. CI runs that suite with `WORKHORSE_REQUIRE_DATABASE=1`, so the
named example cannot skip there. The same check covers the Active Job table.

A JVM Supported cell follows the same rule. It names either `protocol/v1` fixtures or one JUnit
test method in a `jvm/workhorse/src/test/java` file that `pnpm jvm:test` runs. The JVM runner fails
on a fixture that neither passes nor appears on its expected-unsupported list. It also fails on a
listed fixture that passes, so a gap closes by removing its entry. `pnpm parity:check` fails when a
cited fixture does not exist or the list still holds it. It also fails when no test file by that
name exists or the file has no `@Test` method by that name. CI runs that suite with
`WORKHORSE_REQUIRE_DATABASE=1`, so a database test cannot skip there.

A .NET Supported cell follows the same rule. It names either `protocol/v1` fixtures or one xUnit
test method in a test project that `pnpm dotnet:test` runs. The .NET runner fails on a fixture that
neither passes nor appears on its expected-unsupported list. It also fails on a listed fixture that
passes, so a gap closes by removing its entry. `pnpm parity:check` fails when a cited fixture does
not exist or the list still holds it. It also fails when no test file by that name exists, or the
file has no `[Fact]` or `[Theory]` method by that name, or that method sets `Skip`. CI sets `CI`, so
a .NET database test cannot skip there. A cell can also name the C# implementation that its test
proves. Then `pnpm parity:check` fails when that file does not contain the named text.

That check binds the document to declared evidence, not to a proof of behaviour — no static check
can supply one. Naming a test file that never exercises the capability would satisfy it. The rule
this document states still governs: a cell says Supported because tests prove it, and generation
stops the published view from becoming another source of truth.

<!-- BEGIN GENERATED PARITY LINEAR LINKS -->
<!-- END GENERATED PARITY LINEAR LINKS -->
