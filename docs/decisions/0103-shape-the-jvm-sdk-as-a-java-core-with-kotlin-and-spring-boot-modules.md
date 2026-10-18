# ADR 0103: Shape the JVM SDK as a Java core with Kotlin and Spring Boot modules

- **Status:** Proposed
- **Date:** 2026-10-17
- **Amends:** [ADR 0021](0021-no-framework-integration-packages.md),
  [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0056](0056-set-the-1-0-0-exit-criteria.md),
  [ADR 0059](0059-assemble-the-1-0-0-specification.md)
- **Related:** [ADR 0018](0018-framework-neutral-dashboard-host.md),
  [ADR 0023](0023-language-sdks-and-http-boundaries.md),
  [ADR 0028](0028-flat-per-language-repository-layout.md),
  [ADR 0029](0029-embeddable-dashboard-backends.md),
  [ADR 0030](0030-distinguish-suspensions-gates-and-child-joins.md),
  [ADR 0039](0039-use-a-restricted-json-schema-contract-profile.md),
  [ADR 0058](0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md),
  [ADR 0071](0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md),
  [ADR 0072](0072-converge-the-worker-runtime-defaults.md),
  [ADR 0075](0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md),
  [ADR 0076](0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md),
  [ADR 0077](0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md),
  [ADR 0078](0078-start-a-long-running-workers-first-claim-beside-its-startup-maintenance-pass.md),
  [ADR 0083](0083-run-each-language-suite-once-per-change.md),
  [ADR 0084](0084-govern-the-ruby-api-as-a-ninth-surface.md),
  [ADR 0095](0095-add-task-groups-with-completion-callbacks.md),
  [ADR 0098](0098-check-the-input-of-a-checkpoint-on-replay.md),
  SM-1381,
  SM-1360

## Context

ADR 0023 makes the SQL protocol the authority, and every language SDK an orchestration layer.
Java and Kotlin applications cannot use Workhorse today. On 2026-10-17 the maintainer decided that
the JVM is the next SDK, after a grilling that SM-1360 records. SM-1381 lists those decisions. No
JVM code exists in this repository yet. This record designs the SDK before SM-1383 through SM-1398
implement it, as ADR 0075 did for Ruby.

Five facts shape the design more than the SDK itself does.

- **Most JVM backend code is Java, and much of the rest is Kotlin.** Kotlin reads a Java API with
  nullness annotations as real Kotlin types. A Java caller cannot call a `suspend`
  function in a natural way. So the core is Java, and Kotlin gets an extension module.
- **The JVM has no shared task API.** Ruby has Active Job, which many backends implement. The JVM
  has no equivalent, so no adapter can reach every framework. Spring Boot is the largest framework
  target, and the maintainer chose one Spring Boot starter.
- **Virtual threads are final in Java 21.** One thread for each handler is cheap. PgJDBC replaced
  its `synchronized` blocks with `ReentrantLock` in 42.6.0, so a JDBC call does not pin its carrier
  thread.
- **ADR 0056 Gate 2 freezes the shape early.** After the first published minor, the Java and
  Kotlin APIs must change only additively. So this record settles the governed surface now.
- **The baseline on the JVM polls the database.** No checked baseline library wakes a worker with
  `LISTEN`/`NOTIFY`, and none shares a protocol with other languages. One baseline library sells
  transactional enqueue only in a paid edition.

The JVM SDK copies the Ruby, Python, and Rust surfaces. Each choice below either follows from that
rule or names the JVM constraint that forces a difference. The maintainer's decisions are numbered
as in SM-1381. Where SM-1381 left a detail open, this record recommends an answer and lists the
rejected alternatives. The maintainer accepts or changes each recommendation in review. On
2026-10-17 the maintainer decided two more details: the JSON codec, and the default of the
starter's worker. This record marks both as decided.

## Decision

### Coordinates and packages

_SM-1381 decision 4._

| Artifact                        | Package                            | Contents                                                    |
| ------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `workhorse`                     | `dev.stablemates.workhorse`        | client, worker, `Admin`, dashboard backend, durable context |
| `workhorse-kotlin`              | `dev.stablemates.workhorse.kotlin` | suspend handlers, suspend client wrappers, and a DSL        |
| `workhorse-spring-boot-starter` | `dev.stablemates.workhorse.spring` | auto-configuration, transactions, lifecycle, and health     |

The group is `dev.stablemates`. Every artifact uses the train version. The coordinates follow the
reverse-domain rule of Maven Central, so they need the domain `stablemates.dev`. The maintainer
registers the domain and verifies the namespace before the first publish. SM-1384 records both.

If the domain is not available, the fallback group is `run.workhorse`, with the domain
`workhorse.run`. The packages then move to `run.workhorse`, `run.workhorse.kotlin`, and
`run.workhorse.spring`. The fallback must apply before SM-1395 lands the first snapshot. After that
commit, a package rename removes every line of both snapshots.

The core is a named Java module, `dev.stablemates.workhorse`. Its `module-info.java` exports the
public packages only. Internal code lives under `dev.stablemates.workhorse.internal`, which the
module does not export. The Kotlin module and the starter use
`Automatic-Module-Name` entries with their package names. The starter name follows the Spring Boot
convention for a third-party starter, `{name}-spring-boot-starter`.

### Three artifacts and their dependencies

_SM-1381 decision 1._

The repository publishes three artifacts from one Gradle build, rooted at `jvm/` under ADR 0028.
Each artifact has a separate reason to exist. A Java caller must not take the Kotlin standard
library. A caller without Spring must not take Spring.

`workhorse` has two required dependencies.

- **PgJDBC, `org.postgresql:postgresql`, at least 42.7.8.** Every statement runs through it.
- **JSpecify, `org.jspecify:jspecify`, 1.x.** Every package is `@NullMarked`. Kotlin reads
  JSpecify as nullness errors by default, so a Kotlin caller sees `String?` where Java allows
  `null`. Spring Framework 7 uses the same annotations.

Two more dependencies are optional. Each loads only when the caller has it on the class path.

- **The OpenTelemetry API.** The Telemetry section below describes it.
- **The Jakarta Servlet API, 6.0 or later.** The dashboard backend implements a servlet filter.
  A servlet container already supplies the API, so the core declares it as optional.

The core has no JSON library dependency. The Values section below explains why.

`workhorse-kotlin` depends on `workhorse`, the Kotlin standard library, and `kotlinx-coroutines-core`.
`workhorse-spring-boot-starter` depends on `workhorse` and on Spring Boot's auto-configuration and
JDBC modules. Actuator and Jackson are optional in the starter.

### SQL comes from the generated catalogue

_SM-1381 decision 6._

SM-1383 adds a JVM target to `scripts/generate-sql-catalogues.ts` and to `pnpm sql-catalogues:check`.
The target writes `SqlCatalogue.java` under the internal package. PgJDBC binds positional `?`
parameters, so the generator rewrites each `$n` to `?`. A statement that uses one `$n` twice gets
the value bound twice. The generator records the binding order next to each statement. No JVM
class writes protocol SQL by hand. The dashboard backend delegates to `Admin` and `Queue`, as Ruby's
does. So the JVM adds nothing to the governed SQL surface.

The catalogue statements already shape three protocol types, so the generator changes no SQL
except the placeholders.

- A composite result, such as that of `get_maintenance_policy_v1`, comes back as columns, because
  the statement selects `(policy).*`.
- `jsonb[]`, for `complete_many_and_claim_v1`, comes from a `$4::jsonb[]` cast. JDBC binds a
  `String[]` through `createArrayOf("text", …)`, and the cast converts it.
- `interval`, for `prune_worker_registry_v1`, comes from `make_interval(secs => $1::double
  precision)`. JDBC binds the seconds as a `double` with `setDouble`.

If a protocol function is difficult to call from JDBC, the slice stops and reports it. A protocol
change is a separate slice.

### Floors

_SM-1381 decisions 2, 5, and 6._

| Dependency      | Floor                | Tested in CI                       | The authority that ends a version                |
| --------------- | -------------------- | ---------------------------------- | ------------------------------------------------ |
| Java            | 21                   | 21, 25, and 27                     | the Eclipse Temurin support date of that release |
| Kotlin          | language and API 2.2 | built with the pinned Kotlin 2.4.x | the Kotlin compiler drops the language version   |
| Spring Boot     | 4.0                  | 4.0 and 4.1, and the next snapshot | the Spring Boot open-source support end date     |
| PgJDBC          | 42.7.8               | the newest 42.7.x                  | the dependency range rule of ADR 0058            |
| Jakarta Servlet | 6.0                  | the version Spring Boot 4.1 brings | the dependency range rule of ADR 0058            |

Java 21 and 25 are long-term releases. Java 27 is the newest release on 2026-10-17. Temurin
supports Java 21 until at least December 2029. CI tests the floor and the newest release, and
the weekly run of ADR 0083 tests every version.

Java 21 pins a virtual thread that blocks inside `synchronized`. Java 24 removed that limit. The
SDK uses `ReentrantLock` and never blocks inside `synchronized`. Handler code that does block there
pins its carrier on Java 21, so the guide recommends Java 25 for such code.

The Kotlin module compiles with `languageVersion` and `apiVersion` 2.2. It also sets
`coreLibrariesVersion` to the 2.2 line. A Kotlin 2.2 caller therefore resolves no newer standard
library. SM-1394 names the lowest `kotlinx-coroutines-core` release that a Kotlin 2.2 compiler
reads, and SM-1397 records it.

The Spring Boot floor is 4.0. It rises to 4.1 in the first minor release after 2026-12-31, which
the maintainer set from the end of 4.0 open-source support. A non-blocking CI job tests the next
Spring Boot snapshot.

SM-1397 adds `java`, `kotlin`, `spring-boot`, and `pgjdbc` entries to `support.json`, with their
end-of-life dates, so the ADR 0058 check covers them. ADR 0058 then raises each floor in a minor
release.

### Build tool

_SM-1381 decision 3._

The build is Gradle with the Kotlin DSL. `mise.toml` pins `java` (Temurin) and `gradle`.
Repository commands refuse a tool that disagrees with the pin, as for the other pinned tools. The
repository has no Gradle wrapper. A wrapper would be a second pin that downloads its own Gradle, and
`pnpm toolchain:verify` could not see it. The Gradle toolchain resolver stays off, so the build
uses the pinned JDK and no downloaded one.

### Connection model

_SM-1381 decision 6._

Every statement runs on a `java.sql.Connection` from PgJDBC. The SDK never changes session state
on a connection that the caller owns. It sets no `search_path`, no isolation level, and no
autocommit mode on it.

`Queue` and `Admin` take a `ConnectionSource`, an interface with two methods.

```java
public interface ConnectionSource {
  Connection acquire() throws SQLException;
  void release(Connection connection, boolean transactional) throws SQLException;

  static ConnectionSource of(DataSource dataSource) { /* … */ }
}
```

Every method of `Queue` and `Admin` has two forms.

- **The caller form** takes a `Connection` as its first argument. The SDK runs on that connection
  inside the caller's transaction. It never begins, commits, or rolls back.
- **The source form** omits the connection. The SDK acquires one from the `ConnectionSource` for
  the call. `ConnectionSource.of(DataSource)` runs the call in autocommit. If the pool gives a
  connection with autocommit off, the SDK turns autocommit on for the call. It restores the earlier
  value before it releases the connection.

The Spring Boot starter supplies a second `ConnectionSource`. It calls
`DataSourceUtils.getConnection` and `DataSourceUtils.releaseConnection`. Inside a Spring
transaction, it returns the connection that holds the transaction, and the SDK does not commit it.
So an enqueue inside `@Transactional` commits and rolls back with the caller's transaction.

That is the JVM counterpart of ADR 0070's SQLAlchemy accessor and of Ruby's
`ActiveRecordExecutor`, with the same obligation. SM-1385 adds an integration test for the caller
form, and SM-1393 adds one for `@Transactional`. Each test proves that the task is invisible before
the commit, visible after it, and absent after a rollback.

`Queue` caches its compatibility check for each `ConnectionSource`, as Python's `Queue` caches it
for each executor. A caller form call checks compatibility on its connection the first time that
connection reaches the `Queue`.

The claim functions raise SQLSTATE `0A000` under repeatable read or serializable isolation. Only
the worker calls them, and it runs each claim as its own statement in autocommit. A pool can still
give a connection whose default isolation is repeatable read. The SDK then does not change the
isolation level. It maps `0A000` to `IsolationLevelException`, which names the level that the
connection reported. The worker logs the error and tries the claim again after the poll interval. The guide tells the
operator to configure the pool at read committed.

The worker takes a `DataSource` and follows ADR 0071.

- Each claim and each other statement borrows a connection for its own duration.
- Every worker on one `DataSource` shares one dedicated heartbeat connection. The sharing key is
  the `DataSource` object.
- `sharedHeartbeats(true)` is the opt-out of ADR 0071, with the same meaning and the default
  `false`. With it set, heartbeat rounds borrow from the `DataSource` like other statements.
- The worker holds one listener connection for its life. It unwraps it with
  `unwrap(PGConnection.class)`, which a pooled proxy connection supports.
- A `DataSource` reports no pool size, so the worker cannot refuse a small pool at construction.
  The guide states the budget: two held connections plus one for each claim in flight. With
  `sharedHeartbeats(true)`, the budget is one held connection.

### Concurrency: one virtual thread for each task

_SM-1381 decision 7._

The SDK is blocking. It offers one API for Java. Kotlin gets its suspend surface from the Kotlin
module.

- **Handlers** run on one virtual thread for each task. A `Semaphore` with `concurrency` permits
  bounds them. The caller can pass an `ExecutorService` instead. The worker then submits each
  handler to it, and the semaphore still bounds the count.
- **Dispatch** follows ADR 0076, as in every SDK. The worker keeps overlapping batched claims in
  flight. A claim in flight reserves the permits its limit covers, so claimed tasks never exceed
  `concurrency`. Each claim runs on its own virtual thread.
- **The heartbeat and the listener** each run on a dedicated platform thread. The listener blocks
  in `getNotifications(timeoutMillis)` with a bounded timeout, so `stop` ends it within one
  timeout. A platform thread keeps both off the carrier pool, so a full carrier pool cannot delay a
  lease renewal.
- **Shared state** uses `java.util.concurrent` atomics and `ConcurrentHashMap`. No worker lock
  blocks inside `synchronized`.

Three rules keep the worker safe inside a caller's process.

- The worker never submits to `ForkJoinPool.commonPool()`. Another library in the same process
  could fill it.
- Cancellation is cooperative. The handler reads the `CancellationToken` or registers a callback.
- At the drain deadline, the worker calls `Thread.interrupt()` on each remaining handler thread.
  An interrupt sets a flag and ends a blocking JDK wait. It cannot stop a `finally` block, so it is
  safe where Ruby's `Thread#raise` was not. A JDBC socket read does not reliably answer an
  interrupt, so the worker then abandons the handler, as the Worker section describes.

Virtual threads also run CPU-bound handlers in parallel, because the JVM has no global interpreter
lock. So the JVM SDK has no fork supervisor, unlike Ruby's `run_worker_processes`. It has the
explicit process helper `runWorkerProcess`, which the Worker section describes.

### One error hierarchy

Every error the SDK throws extends `WorkhorseException extends RuntimeException`. The exceptions
are unchecked. A checked exception cannot pass through a `java.util.function` lambda, and Kotlin
has no checked exceptions. Each subclass names a category and carries the operation, as Ruby's do.

The set mirrors `ruby/lib/stablemates/workhorse/errors.rb` class for class. Each Java name ends in
`Exception` instead of `Error`, because a Java `Error` means a fault that a caller must not catch.
For example, `LeaseLostError` becomes `LeaseLostException`, and `CheckpointInputConflictError`
becomes `CheckpointInputConflictException`. The JVM adds one class.

| Protocol outcome            | Class                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| SQLSTATE `0A000` on a claim | `IsolationLevelException` with the isolation level found           |
| any other `SQLException`    | `DatabaseException`, with the original as `cause` and its SQLSTATE |

`DatabaseException` keeps PgJDBC types out of the catch clauses a caller writes. So a future
PgJDBC major does not move the governed surface. An invalid argument throws Java's own
`IllegalArgumentException` before any statement runs. An unknown status always throws
`UnexpectedStatusException`. It is never a silent success.

A handler fails its attempt by throwing any `Exception`. The worker maps it to the envelope in
`protocol/v1/failures.json`. The name is the exception's class name, and the stack is its stack
trace followed by each `cause`. SM-1386 adds the `java` entry to `genericName` for an anonymous or
hidden class. Redaction follows the claimed task's `redact_error_details`.

### Values and durations

_The JSON codec. Decided by the maintainer on 2026-10-17._

Payloads, results, checkpoints, and progress are JSON values. The core reads and writes them
through a `JsonCodec`.

```java
public interface JsonCodec {
  String encode(@Nullable Object value);
  <T extends @Nullable Object> T decode(String json, Type type);
}
```

The core ships an internal default codec. It decodes a JSON value into these Java types.

| JSON value                   | Java type                                        |
| ---------------------------- | ------------------------------------------------ |
| object                       | `Map<String, @Nullable Object>`, in source order |
| array                        | `List<@Nullable Object>`                         |
| integer that fits in 64 bits | `Long`                                           |
| larger integer               | `BigInteger`                                     |
| number with a fraction       | `Double`                                         |
| string, `true` or `false`    | `String`, `Boolean`                              |
| `null`                       | `null`                                           |

It encodes only those types, and `Integer`, `Short`, `Float`, and `BigDecimal`. It refuses any other value, such as a `java.time.Instant`. It never
calls `toString` on a value to make it fit.

A caller that wants records or beans passes another codec. The Spring Boot starter supplies a
codec built on the application's Jackson `JsonMapper`, so a Spring handler receives its record
type. The guide shows a codec of about 15 lines for a caller without Spring.

Every `JsonCodec` must throw for a value that is not JSON, such as a non-finite number. It must
not write such a value as a string. The core parses each encoded text with its own strict parser,
which refuses a non-JSON token and a lone surrogate. The starter's Jackson codec turns off
`WRITE_NAN_AS_STRINGS`. A test for each shipped codec proves that NaN, infinity, and a lone
surrogate throw.

A handler declares its payload type at registration. The worker decodes the payload with the
codec, and encodes the result with it. A payload contract validates the JSON text, not the Java
object, so every codec gives the same validation result.

A value beyond 2^53 - 1 survives a JVM round trip as a `Long` or a `BigInteger`. It still rounds
in a TypeScript or Go worker. `docs/parity.md` already documents that limit.

A duration is a `java.time.Duration`. A point in time is a `java.time.Instant`. PgJDBC reads
`timestamptz` as an `OffsetDateTime` in UTC, and the SDK converts it. Result types are Java
records.

### Worker surface

_SM-1381 decision 7._

```java
package dev.stablemates.workhorse;

@FunctionalInterface
public interface Handler<P extends @Nullable Object> {
  @Nullable Object handle(HandlerContext ctx, P payload) throws Exception;
}

public interface TaskHandler<P extends @Nullable Object> extends Handler<P> {
  String taskType();
  Type payloadType();
}

public final class Worker implements AutoCloseable {
  public static Builder builder(DataSource dataSource);

  public void run();                 // blocks until stop, then drains
  public boolean runOnce();          // true when a task ran
  public void start();               // runs on a worker-owned platform thread
  public void stop();                // ends claiming and starts the drain
  public void close();               // stop, then wait for the drain
  public void pause();
  public void resume();
  public boolean isPaused();
  public String workerId();
  public List<String> queues();
  public int concurrency();
  public int cohorts();

  public static final class Builder {
    public Builder queues(String... queues);
    public Builder workerId(String workerId);
    public Builder concurrency(int concurrency);
    public Builder executor(ExecutorService executor);
    public Builder lease(Duration lease);
    public Builder heartbeat(Duration heartbeat);
    public Builder pollInterval(Duration pollInterval);
    public Builder pollingOnly(boolean pollingOnly);
    public Builder maintenanceInterval(Duration interval);
    public Builder maintenanceRoutineInterval(Duration interval);
    public Builder registryInterval(Duration interval);
    public Builder disableRegistry(boolean disable);
    public Builder scheduleNamespaces(String... namespaces);
    public Builder scheduleCatchupLimit(int limit);
    public Builder shutdownGrace(Duration grace);
    public Builder sharedHeartbeats(boolean shared);
    public Builder cohorts(int cohorts);
    public Builder retryDelay(RetryDelay retryDelay);
    public Builder onRegistrationError(Consumer<Throwable> listener);
    public Builder onNotificationError(Consumer<Throwable> listener);
    public Builder logger(System.Logger logger);
    public Builder codec(JsonCodec codec);
    public Builder telemetry(WorkhorseTelemetry telemetry);
    public <P extends @Nullable Object> Builder handle(String taskType, Class<P> payloadType,
        Handler<P> handler);
    public <P extends @Nullable Object> Builder handle(TaskHandler<P> handler);
    public <P extends @Nullable Object> Builder handleBatch(String taskType, Class<P> payloadType,
        BatchOptions options, BatchHandler<P> handler);           // options: maxSize, linger
    public Worker build();
  }
}
```

A JSON payload can be `null`, and the shared fixtures enqueue such tasks. Every package is
`@NullMarked`, so each payload type parameter has the bound `P extends @Nullable Object`. This
applies to `Handler`, `TaskHandler`, `BatchHandlerItem`, and each registration method. A handler
that registers `Class<P>` for a nullable payload then receives `null`. A Kotlin caller writes
`SuspendHandler<Order?>` for the same case.

A Java builder replaces Ruby's keyword arguments. Java has no default arguments, and a builder
method is additive under Gate 2. A constructor with 20 parameters is not.

The defaults are the ADR 0072 values. `heartbeat` defaults to a third of `lease`. `pollInterval`
defaults to 5 seconds with a listener, and to 250 milliseconds backing off to 5 seconds without
one. `retryDelay` is a function over the attempt and the claimed task that returns a `Duration` or
`null`, as in Python. The concurrency bounds and the `handleBatch` bounds are the ones every other
SDK enforces.

Registration is by task type. Registering a task type again replaces its handler. A task type
with no handler is released so that another worker can claim it.

Dispatch follows ADR 0076. The worker keeps overlapping batched claims in flight, fair across the
configured queues. On the fast tier of ADR 0077 it batches completions into fused claims and splits
its slots into cohorts. A long-running worker starts its first claim beside its startup maintenance
pass, as ADR 0078 requires. The shared runtime fixture
`busy-worker-refills-slots-with-overlapping-batched-claims` pins the dispatch in Java as it does in
the other five SDKs.

The heartbeat thread acts on each `heartbeat_v1` status as ADR 0074's table describes. The
cancellation reasons are `REQUESTED`, `DEADLINE_EXCEEDED`, `EXECUTION_TIMEOUT`, `LEASE_LOST`,
`SUSPENDED`, and `SHUTDOWN`, as the values of the `CancellationReason` enum. A lease lost to `stale`
cancels the token and records the loss. The fence token then refuses every later write from that
handler.

Shutdown follows the library model of ADR 0072, because a `Worker` runs inside the caller's
process.

1. `stop` ends claiming.
2. In-flight handlers can finish within `shutdownGrace`.
3. At that deadline the worker cancels the remaining tokens with `SHUTDOWN` and interrupts their
   threads.
4. It gives those handlers one bounded window to unwind.
5. It then stops renewing their leases, and `run` throws `ShutdownIncompleteException`.

`Worker` installs no JVM shutdown hook and traps no signal. The process owner calls `stop` or
`close`, or calls the process helper below.

#### A worker process without Spring

A Java or Kotlin program without Spring runs a worker as its own process with one call, as the
other SDKs do.

```java
public final class WorkerProcess {
  public static void runWorkerProcess(Worker worker);   // returns only by ending the process
}
```

`runWorkerProcess` is the counterpart of Ruby's `run_worker_process`. It installs a shutdown hook
only when the caller calls it. The helper keeps two pieces of state: a shutdown flag, and a
completion latch.

1. It registers one JVM shutdown hook, and then it runs `worker.run()` on the calling thread.
2. On `SIGINT` or `SIGTERM`, the JVM starts its shutdown hooks. The hook sets the shutdown flag,
   calls `worker.stop()`, and waits for the completion latch.
3. The worker drains within `shutdownGrace` and the unwind window, as the steps above describe.
4. When `run` returns or throws, the calling thread first releases the latch. Then it acts on the
   outcome, as the table below states.

| Outcome on the calling thread            | Action after the latch is released                       |
| ---------------------------------------- | -------------------------------------------------------- |
| `run` returns, and no shutdown has begun | `System.exit(0)`, as Ruby exits 0 after `run` returns    |
| `run` throws, and no shutdown has begun  | write the error to standard error, then `System.exit(1)` |
| a shutdown has begun                     | write an error, if any, and wait for the JVM to end      |

`run` returns without a signal when another thread calls `stop`. The hook waits for the latch, and
it never joins the calling thread. The calling thread can be blocked inside `System.exit`, which
blocks until the JVM ends, so a join from the hook would never finish. The latch is released before
any exit call. So the hook always returns after the drain, whichever path started the shutdown.

The JVM limits three points of the behavior of the other SDKs.

- **The exit status of a signal.** Ruby exits 0 after a drain that a signal started. A JVM
  shutdown hook can set the status only with `Runtime.halt`, which would stop the application's
  other shutdown hooks, such as a log flush. So the process ends with the JVM's status for the
  signal.
- **A second signal.** Ruby exits at once on a second signal. The `Runtime` documentation does not
  say what a second signal does during the shutdown sequence, so the helper promises nothing for
  it. `SIGKILL` is the forced stop.
- **Concurrent hooks.** The JVM starts all shutdown hooks in an unspecified order, and they run
  concurrently. A hook of the application that closes the `DataSource` can therefore close it
  while the worker drains. `docs/architecture/operations.md` closes resources only after the run
  loops finish. So a caller must not close the worker's resources in a separate shutdown hook.

The worker drain is bounded. The end of the process also depends on every other shutdown hook of the
application. A hook that does not return delays the end without limit. A caller that needs
to close resources after the drain uses `Worker.run` and `stop` itself, instead of this helper.

SM-1386 builds the helper. SM-1398 adds its row to the process entry points table of
`docs/guides/310-workers.md`. SM-1391 gives the JVM column of the worker runtime defaults in
`docs/parity.md` the library model of the "Shutdown grace, then" row: abandon the handlers.

The Spring Boot starter does not use the helper. Spring owns the signals and its own shutdown
hook, and it stops the `SmartLifecycle` bean, which drains the worker. The guide tells the user to
keep `spring.lifecycle.timeout-per-shutdown-phase` above `shutdownGrace` and the unwind window.

```java
public interface CancellationToken {
  boolean isCancelled();
  @Nullable CancellationReason reason();
  void throwIfCancelled();                       // throws CancelledException
  void await() throws InterruptedException;                   // waits until cancelled
  boolean await(Duration timeout) throws InterruptedException;
  AutoCloseable onCancel(Runnable callback);     // close() removes the callback
}
```

`HandlerContext.isCancelled()` delegates to the token.

### Queue surface

```java
public final class Queue {
  public Queue(ConnectionSource connections);
  public Queue(ConnectionSource connections, QueueOptions options);   // default queue, codec
  public void assertCompatible();

  public EnqueueResult enqueue(String taskType, @Nullable Object payload);
  public EnqueueResult enqueue(String taskType, @Nullable Object payload, EnqueueOptions options);
  public List<EnqueueResult> enqueueMany(List<EnqueueRequest> requests);
  public CancelResult cancel(UUID taskId, @Nullable String requestedBy, @Nullable String reason);
  public SignalDeliveryResult sendSignal(UUID taskId, String name, @Nullable Object payload,
      String idempotencyKey, String requestedBy);
  public HumanWaitCompletionResult completeHumanWait(UUID taskId, String name,
      @Nullable Object result, String idempotencyKey, String requestedBy);
  public QueueHealth health();

  public TaskGroup createTaskGroup(TaskGroupCallbacks callbacks);
  public TaskGroupBlockResult taskGroup(TaskGroupCallbacks callbacks,
      Consumer<TaskGroupBuilder> block);                 // creates, adds, and seals in one statement
  public List<EnqueueResult> addToTaskGroup(UUID groupId, List<EnqueueRequest> requests);
  public TaskGroup sealTaskGroup(UUID groupId);
  public Optional<TaskGroup> getTaskGroup(UUID groupId);
  public TaskGroupMemberPage listTaskGroupMembers(UUID groupId, long after, int limit);
  public Optional<TaskGroupLink> findTaskGroup(UUID taskId);

  public void syncSchedules(String namespace, List<ScheduleDefinition> schedules, boolean prune);
  // Each sync with prune also has an overload without it, which prunes, as Ruby's default does.
  public List<ConcurrencyPolicy> syncConcurrencyPolicies(String namespace,
      List<ConcurrencyPolicyDefinition> definitions,
      boolean prune);
  public List<RateLimitPolicy> syncRateLimitPolicies(String namespace,
      List<RateLimitPolicyDefinition> definitions,
      boolean prune);
  public List<Budget> syncBudgets(String namespace, List<BudgetDefinition> definitions,
      boolean prune);
  public void syncContracts(Map<String, TaskTypeContracts> contracts);   // keyed by task type

  public List<ConcurrencyPolicy> listConcurrencyPolicies(@Nullable List<String> queues);
  public List<RateLimitPolicy> listRateLimitPolicies(@Nullable List<String> queues);
  public List<Budget> listBudgets(@Nullable List<String> names);
}

public record EnqueueResult(UUID taskId, EnqueueOutcome outcome,
    @Nullable EnqueueNonReplaceableReason reason) {}
// EnqueueOutcome: ACCEPTED, REPLAYED, REPLACED, NON_REPLACEABLE, COALESCED
// EnqueueNonReplaceableReason: INCOMPATIBLE_KEY_MODE, NOT_PENDING, WINDOW_ELAPSED_PENDING
```

Each method keeps the parameters of its Ruby counterpart, with Java spelling and nullability. A
Ruby keyword with a default becomes an overload without that parameter, or a builder option with
the same default. `TaskGroupCallbacks` holds the three optional callbacks of `create_task_group`,
each a nullable `EnqueueRequest`. `TaskGroupBuilder` collects the requests of the block, as
Ruby's does. `health` returns a `QueueHealth` record that holds Ruby's snapshot `Hash` as one map.
The amendment at the end of this record supersedes an earlier form of this sentence.

Each result type keeps every field of its Ruby counterpart, with Java spelling. For example,
`EnqueueResult.reason` keeps the protocol's reason for a `non_replaceable` debounce outcome, and it
is `null` for every other outcome. The syncs return the stored rows, as Ruby's do.

Each method above also has a caller form that takes a `Connection` first. The block omits those
overloads for length. `EnqueueOptions` is a record with a builder. Its fields are the keywords of
Ruby's `enqueue` and of Python's `EnqueueOptions`. `EnqueueRequest` and `ChildRequest` carry the
same fields, and their payload is nullable. SM-1385 takes the exact names from Ruby and changes
only the Java spelling.

Payload contracts follow ADR 0039. The core validates a contract against the profile with its own
internal validator, as Ruby does. It depends on no JSON Schema library. Since the amendment of
2026-10-01, the profile excludes `pattern` and `patternProperties`. So the contract validator
rejects either keyword with the profile's normal error, and never compiles a regular expression.
The validator runs every case of `protocol/v1/contracts.json`.

### Admin surface

`Admin` gives Java the operator capability of the other five SDKs. It takes the same
`ConnectionSource` as `Queue`, and each control has a caller form. So a control can join a
caller-owned transaction.

```java
public record AdminAudit(String actor, String reason, String requestId) {}

public final class Admin {
  public Admin(ConnectionSource connections);
  public void assertCompatible();

  public TaskPage listTasks(TaskQuery query);
  public Optional<TaskDetail> getTask(UUID taskId);
  public TimelinePage getTaskTimeline(UUID taskId, TimelineQuery query);

  public DeadLetterPage listDeadLetters(DeadLetterQuery query);
  public RedriveResult redrive(UUID sourceTaskId, AdminAudit audit);
  public BulkRedrivePage redriveMany(RedriveFilter filter, AdminAudit audit);

  public Optional<TaskCheckpoint> getCheckpoint(UUID taskId, String name);
  public List<TaskCheckpoint> listCheckpoints(UUID taskId);
  public Optional<TaskProgress> getProgress(UUID taskId);
  public Optional<TaskWait> getWait(UUID taskId, String name);
  public List<TaskWait> listWaits(UUID taskId);
  public SignalWaitPage listSignalWaits(SignalWaitQuery query);
  public HumanWaitPage listHumanWaits(HumanWaitQuery query);

  public List<WorkerInfo> listWorkers();
  public Optional<WorkerPauseResult> setWorkerPaused(String workerId, boolean paused,
      AdminAudit audit);
  public void pauseQueue(String queue, AdminAudit audit);
  public void resumeQueue(String queue, AdminAudit audit);
  public long purgeQueue(String queue, AdminAudit audit);          // tasks deleted or canceled

  public Optional<TaskGroup> getTaskGroup(UUID groupId);
  public TaskGroupMemberPage listTaskGroupMembers(UUID groupId, long after, int limit);
  public List<TaskGroupEvent> listTaskGroupEvents(UUID groupId, int limit);
  public Optional<TaskGroup> cancelTaskGroup(UUID groupId, AdminAudit audit);
  public List<TaskGroupDrift> listTaskGroupDrift(int limit);
  public List<TaskGroupRepair> repairTaskGroupDrift(AdminAudit audit, int limit);
}
```

The query records hold the keywords of Ruby's methods with their defaults. For example,
`TaskQuery` has the queue, the type, the states, the creation range, the limit, the cursor, and the
payload projection. Each `int limit` above also has an overload without it, with Ruby's default.
Every control takes an `AdminAudit`. `Admin` rejects a blank audit field before it calls PostgreSQL, as Python does. Each
page carries the cursor for the next page. `Admin` has no `health` method, because `Queue.health`
reads the same snapshot.

### Embedded dashboard backend

_SM-1381 decision 9, and the open detail of the servlet backend shape. Recommendation._

ADR 0029 requires every SDK to serve the dashboard from the host application's own HTTP server.
The maintainer put the JVM backend in the 1.0.0 scope. SM-1390 builds it after `Admin` lands.

```java
public final class Dashboard implements jakarta.servlet.Filter {
  public static Builder builder(ConnectionSource connections, DashboardAuthorizer authorize);

  public static final class Builder {
    public Builder path(String path);                         // default "/workhorse"
    public Builder environment(String environment);           // default "development"
    public Builder auditActor(String actor);                  // default "dashboard"
    public Builder readOnly(boolean readOnly);
    public Builder browserModules(List<String> sources);       // extra browser module URLs
    public Builder configuredWorkers(List<String> workerIds);
    public Builder maintenanceLoops(Map<String, Object> loops); // default {"tickIntervalMs": 1000}
    public Builder enqueueTest(DashboardProcedure procedure);   // demo tools, off when unset
    public Builder setSchedulePaused(DashboardProcedure procedure);
    public Builder allowedHosts(List<String> hosts);
    public Builder procedures(Map<String, DashboardProcedure> procedures);
    public Builder codec(JsonCodec codec);
    public Dashboard build();
  }

  public String basePath();
  public boolean owns(String path);
}

@FunctionalInterface
public interface DashboardProcedure {
  @Nullable Object call(@Nullable Object input, @Nullable Object actor) throws Exception;
}
```

`Dashboard` is a Jakarta Servlet filter, as Ruby's `Dashboard` is a Rack application. A servlet
application registers it with `ServletContext.addFilter` and maps it to `/*`. The filter reads the
request path from `getRequestURI` less `getContextPath`, so the context path does not change the
mount path. A request outside the mount path goes to `chain.doFilter`. So the host's own servlets
and controllers still answer it. That is the servlet counterpart of Ruby's `X-Cascade: pass`.

The builder options are Ruby's `Dashboard` options, with Java types. `auditActor` is a fallback
string, as in Ruby and Python. The backend uses it only when `authorize` gives a bare allow. A
principal names its own actor. A `DashboardProcedure`
receives the decoded input and the actor, as Ruby's procedure callables do. `procedures` adds or
replaces procedures by name.

`authorize` receives the `HttpServletRequest` and returns a principal, an allow, or a deny, as
Python's and Ruby's do. Reads and controls go through `Admin` and `Queue`, so the backend writes no
dashboard SQL. The `dashboard/v1` procedure bindings are generated from
`dashboard/v1/procedures.json`. The jar ships the browser bundle as class path resources. The JVM
cell becomes Supported only when the backend passes every shared `dashboard/v1` HTTP fixture.

The backend is blocking. A servlet container on virtual threads runs it without a platform thread
for each waiting request. The backend uses no asynchronous servlet API.

#### The ECMA-262 pattern policy

_Open detail. Recommendation._

The `dashboard/v1` input schemas use JSON Schema `pattern`, which ECMA-262 defines. The contract
profile excludes `pattern`, so these schemas are the only place a JVM validator meets a regular
expression. The set is closed. `dashboard/v1/procedures.json` holds six distinct patterns today. They
match a UUID, an RFC 3339 instant in two forms, a local time, a commit hash, and an event ID. Each uses only anchors, character classes, `\d`, groups, alternation, and bounded
quantifiers.

`java.util.regex` differs from ECMA-262 in one place that these patterns reach. Without
`MULTILINE`, Java's `$` also matches before a final line terminator. So `java.util.regex` accepts
a UUID followed by `\n`, and ECMA-262 refuses it. Java's `\d` matches ASCII digits only without
`UNICODE_CHARACTER_CLASS`, as ECMA-262 does with the `u` flag.

The internal validator therefore compiles each pattern through a narrow translator.

1. The translator accepts the subset that the six patterns use: literals, escapes, character
   classes, `\d`, `^`, `$`, groups, non-capturing groups, alternation, and quantifiers.
2. It rewrites `^` to `\A` and `$` to `\z` outside a character class.
3. It refuses every other construct, such as a lookaround, a backreference, `\s`, `\b`, `.`, a
   property escape, or a flag, with `IllegalArgumentException`.
4. A unit test compiles every `pattern` in the generated input schemas through the translator.
5. The same test checks each translated pattern against vectors that differ only in a final line
   terminator.

If a later `dashboard/v1` schema adds a construct outside the subset, step 4 fails in CI before any
release. The SM-1390 author then widens the translator for that construct, with its own vectors.

### Durable handler context

```java
public interface HandlerContext {
  ClaimedTask task();
  CancellationToken cancellation();
  boolean isCancelled();

  Optional<TaskCheckpoint> getCheckpoint(String name);
  <T extends @Nullable Object> T checkpoint(String name, Type type, Callable<T> operation);
  <T extends @Nullable Object> T checkpoint(String name, Type type, CheckpointOptions options,
      Callable<T> operation);                  // options carry the input, which can be null
  void sleep(String name, Duration duration);
  void sleepUntil(String name, Instant time);
  <T extends @Nullable Object> T waitForSignal(String name, Type type, @Nullable Duration timeout);
  <T extends @Nullable Object> T waitForHuman(String name, @Nullable Object context, Type type,
      @Nullable Duration timeout);

  <T extends @Nullable Object> T runChild(String name, String taskType, @Nullable Object payload,
      EnqueueOptions options, Type resultType);
  Map<String, ChildOutcome> runChildren(List<ChildRequest> children);
  Map<String, @Nullable Object> runChildrenAll(List<ChildRequest> children);

  Optional<TaskProgress> getProgress();
  TaskProgress setProgress(@Nullable Object progress);

  TaskGroupContext taskGroup();
}

public interface TaskGroupContext {
  Optional<TaskGroupLink> get();                               // the task's role, callback kind, and group
  List<EnqueueResult> add(List<EnqueueRequest> requests);      // fenced on this task's lease
}

public record TaskGroupLink(TaskGroupRole role, @Nullable TaskGroupCallbackKind callback,
    TaskGroup group) {}
// TaskGroupRole: MEMBER, CALLBACK. TaskGroupCallbackKind: ON_FINISH, ON_SUCCESS, ON_FAILURE

public record BatchHandlerItem<P extends @Nullable Object>(P payload, BatchHandlerContext context) {}

public interface BatchHandlerContext {
  ClaimedTask task();                      // the member's ClaimedTask
  CancellationToken cancellation();        // the member's token
  Optional<TaskCheckpoint> getCheckpoint(String name);
  <T extends @Nullable Object> T checkpoint(String name, Type type, Callable<T> operation);
  <T extends @Nullable Object> T checkpoint(String name, Type type, CheckpointOptions options,
      Callable<T> operation);
  Optional<TaskProgress> getProgress();
  TaskProgress setProgress(@Nullable Object progress);
  TaskGroupContext taskGroup();            // the member's group
}
```

A checkpoint operation, a wait, and a child can each give the JSON value `null`. So each of their
type parameters has the bound `T extends @Nullable Object`, and a checkpoint stores and replays
`null` as Ruby's does. `CheckpointOptions.input(@Nullable Object)` sets an input, and a `null`
input is the JSON value `null`. Only a call without options has no input.

`getProgress` and `setProgress` return a `TaskProgress` record, as Ruby and Python do. It holds
the value, the revision that PostgreSQL acknowledged, and the other fields of Ruby's `TaskProgress`.

SM-1387 takes the exact semantics and the timeout and option names from Ruby and Python. It
changes only the Java spelling.

`TaskGroupContext` follows Ruby's `HandlerContext#task_group` and ADR 0095. `add` writes under the
task's lease and fence, as every durable call does. The batch context has the same input check and
the same task group access for each member as the ordinary context.

Checkpoint replay runs the operation only when no checkpoint of that name exists. Concurrent calls
that share one name share one in-flight request. `runChildren` keys its outcomes by child name.
`BatchHandlerContext` has no suspending or child primitives, as ADR 0030 requires. Each batch
member has its own context, as SM-986 decided for Ruby. A fast-tier member rejects `checkpoint` and
`setProgress` with `FastTierUnsupportedException` before any write.

#### RFC 8785 canonical JSON

_Open detail. Recommendation._

ADR 0098 stores the SHA-256 digest of the RFC 8785 canonical JSON of a checkpoint input. Every SDK
must give the same digest for the same input. The other five SDKs each write the canonical form
with their own code and no dependency. The JVM does the same in an internal class of the core. The
public entry point is `Checkpoints.inputFingerprint(@Nullable Object input)`, the counterpart of Ruby's
`checkpoint_input_fingerprint`. It throws `IllegalArgumentException` for an input that ADR 0098
refuses. A `null` input is the JSON value `null`, which has a fingerprint, as Ruby's vectors show.

1. The codec encodes the input to JSON text. The core parses that text into its own tree, so a
   Jackson codec and the default codec give the same canonical form.
2. Object keys sort by UTF-16 code units. A Java `String` is a sequence of UTF-16 code units, so
   `String.compareTo` gives that order directly.
3. A string escapes only the quote, the backslash, and the control characters, as
   `JSON.stringify` does. A lone surrogate refuses the input.
4. An integer prints in decimal. A number of more than 2^53 - 1 in magnitude refuses the input, of
   any type, as ADR 0098 requires.
5. A fraction prints in the ECMAScript form of its IEEE 754 double. The core implements the
   ECMAScript `Number::toString` algorithm itself: the shortest digits that round-trip, then the
   ECMAScript notation. `Double.toString` is not enough. For `Double.MIN_VALUE` it gives
   `4.9E-324`, and ECMAScript gives `5e-324`.

The class runs the number vectors of RFC 8785 Appendix B and the shared fingerprint vectors that
the other SDKs run. A difference in one digest fails CI.

### Suspension

A durable wait that returns `scheduled`, or a child join that returns `created`, suspends the
handler. ADR 0030 defines suspension as releasing the lease and restarting the handler from entry
on resume.

The JVM copies Ruby's mechanism. The context records a suspension flag, cancels the token with
`SUSPENDED`, and throws an internal `Suspension`. `Suspension` extends `java.lang.Error`, not
`Exception`. So `catch (Exception e)` in a handler does not catch it, and `finally` blocks still run.

The worker checks the flag after the handler returns or throws. A handler that catches `Throwable`
and swallows the suspension still suspends, and the worker ignores its result. Kotlin's
`runCatching` catches `Throwable`, so the flag is what makes a Kotlin handler safe. The worker then
submits `suspended_for_wait` or `suspended_for_child`.

`Suspension` lives in the internal package and is not part of the governed surface. Handlers never
construct it.

### Telemetry

_Open detail: the optional OpenTelemetry dependency. Recommendation._

The worker and queue log through `System.Logger`, the JDK logging facade. A caller routes it to
their logging library through the JDK's `LoggerFinder`. The SDK adds no logging dependency.

The OpenTelemetry API, `io.opentelemetry:opentelemetry-api` 1.x, is an optional dependency. The
POM marks it `optional`, and the Gradle metadata declares it as a feature variant.

- By default the SDK reads `GlobalOpenTelemetry` when the API is on the class path. Without it,
  telemetry is a no-op and loads no OpenTelemetry class.
- `WorkhorseTelemetry.of(OpenTelemetry)` passes an explicit instance to a `Worker` or a `Queue`. It
  is the one public signature that names an OpenTelemetry type. The OpenTelemetry API 1.x promises
  backward compatibility, so that type does not move the governed surface.
- The Spring Boot starter passes the application's `OpenTelemetry` bean when one exists.

The SDK emits the span names, counters, histograms, attributes, outcome values, and attribute
limits of `api/telemetry.txt`, as `python/src/workhorse/_telemetry.py` does. It injects and extracts
W3C trace context. SM-1392 adds a test that proves each name in `api/telemetry.txt` comes from the
JVM SDK. A second test runs the SDK without OpenTelemetry on the class path. The amendment at the
end of this record supersedes an earlier form of the first test.

### Spring Boot starter

_SM-1381 decision 5._

The starter lets a Spring Boot application use Workhorse with configuration only.

- **Auto-configuration.** It builds `Queue` and `Admin` beans from the application's `DataSource`.
  It builds a `Worker` bean only when the worker is on, as below. Properties live under `workhorse.*`. Every property has a description in the
  configuration metadata.
- **Transactions.** It supplies the `DataSourceUtils` `ConnectionSource` that the Connection model
  section describes. So an enqueue inside `@Transactional` joins that transaction.
- **Codec.** It supplies a `JsonCodec` from the application's Jackson `JsonMapper` when Jackson is
  present.
- **Handlers.** When the worker is on, it registers every bean that implements `TaskHandler`. It
  uses no annotations, so a handler is a plain bean that a test can construct.
- **Lifecycle.** When the worker is on, a `SmartLifecycle` bean starts the worker after the context
  refreshes. It stops the worker with a graceful drain before the `DataSource` closes. Its phase is
  set so that this order holds.
- **Health.** When the worker is on and Actuator is present, a `HealthIndicator` reports the worker
  state. A started worker that stops or abandons a handler reports `DOWN`. When the worker is off,
  the starter creates no indicator, so an application that only enqueues reports no worker health.
- **Dashboard.** A `FilterRegistrationBean` registers the dashboard filter only when
  `workhorse.dashboard.enabled=true`. It is off by default, and it requires an authorizer bean.

_The worker default. Decided by the maintainer on 2026-10-17._

The worker is off by default. It starts only when `workhorse.worker.enabled=true`. A Spring Boot
worker process sets that property, for example beside `spring.main.web-application-type=none`. That
process is the Spring form of Ruby's `run_worker_process`. A web replica that does not set the
property starts no worker, whatever beans it defines. So a replica never runs a worker without a
user decision, as ADR 0012 and ADR 0021 require.

If the context holds `TaskHandler` beans and the worker is off, the starter logs one warning at
startup. The warning names the property. So a worker process that forgets the property does not
fail without a sign.

The starter's two switches have these defaults.

| Property                      | Default | Effect when `true`                                                                          |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `workhorse.worker.enabled`    | `false` | builds the `Worker` and the lifecycle bean, and the health indicator if Actuator is present |
| `workhorse.dashboard.enabled` | `false` | registers the dashboard filter, which needs an authorizer bean                              |

The other `workhorse.*` properties configure `Queue`, `Admin`, and the `Worker`. They have the
defaults of the core builders. SM-1393 lists them in the configuration metadata, and SM-1395 records
them in `api/java.txt`.

Out of scope at 1.0.0: an outbox integration, R2DBC, and adapters for other frameworks such as
Quarkus, Micronaut, and Ktor. Each is additive later.

#### The amendment to ADR 0021

ADR 0021 says that Workhorse publishes no framework integration packages, and that workers run in
dedicated processes. Its reason is that web replicas must not silently multiply worker capacity or
database pressure. ADR 0075 applied it to reject a Railtie.

This record amends ADR 0021 for one package, `workhorse-spring-boot-starter`. The JVM has no shared
task API. Without the starter, each Spring application writes its own transaction binding and
drain. Three limits keep ADR 0021's reason.

- The starter is the only Spring Boot package, and the only framework package. Another framework
  adapter needs its own decision record.
- The starter's worker bean is off by default. Only `workhorse.worker.enabled=true` starts it.
- The dedicated worker process stays the default topology, as ADR 0012 decided. In Spring Boot,
  that process is an application that sets the property and usually serves no web requests.

ADR 0021 stays in force for every other language and framework.

### Kotlin module

_SM-1381 decision 7._

`workhorse-kotlin` gives Kotlin an idiomatic surface over the Java core. It adds no protocol
behavior.

```kotlin
package dev.stablemates.workhorse.kotlin

fun interface SuspendHandler<P> {
    suspend fun handle(ctx: SuspendHandlerContext, payload: P): Any?
}

fun workhorseWorker(dataSource: DataSource, configure: WorkerScope.() -> Unit): Worker

class WorkerScope {
    var queues: List<String>
    var concurrency: Int
    // … one property for each Worker.Builder option
    inline fun <reified P> handle(taskType: String, handler: SuspendHandler<P>)
}

suspend fun Queue.enqueueSuspend(taskType: String, payload: Any?, /* defaults */): EnqueueResult
```

- **Suspend handlers** run on a dispatcher built from a virtual-thread executor with
  `asCoroutineDispatcher()`. Each handler runs in a coroutine scope of the worker.
- **Cancellation.** A cancelled task cancels the coroutine `Job` of its handler. A blocking call
  inside the SDK runs in `runInterruptible`, which maps the cancellation to `Thread.interrupt()`.
- **Suspend wrappers** cover `Queue`, `Admin`, and the durable context. Each public Java method has
  one wrapper with the same parameters and nullability. Ruby's defaults become Kotlin default
  arguments. `SuspendHandlerContext` wraps `HandlerContext`. A suspension still reaches the worker through the
  core's flag.
- **The DSL** registers a worker and its handlers. Reified type parameters replace the `Class`
  argument of the Java form.

The module adds no Kotlin twin for `TaskHandler` beans. A Spring application in Kotlin implements
the Java interface, or registers suspend handlers through the DSL inside a bean.

### Governed surface and release

_SM-1381 decision 8, and the open detail of the Maven Central release stage._

SM-1395 records the two surfaces.

- `api/java.txt` covers `workhorse` and `workhorse-spring-boot-starter`, one section for each
  artifact. It lists every public and protected class, interface, record, enum, method, field, and
  constructor of an exported package, with generic signatures and JSpecify nullness. The starter's
  section adds every `workhorse.*` property name with its type and default.
- `api/kotlin.txt` covers `workhorse-kotlin`. It lists the Kotlin declarations with their default
  arguments, `suspend` modifiers, and reified parameters, which a class-file view cannot show.

`pnpm java-api:generate` and `pnpm kotlin-api:generate` write the files from the built artifacts.
`pnpm java-api:check` and `pnpm kotlin-api:check` run in the CI `required` job and in
`pnpm check`. Each fails on any drift, like `ruby-api:check`. A gone line is a removal, a rename,
or a narrowing, and the failure labels it breaking. SM-1395 uses the Kotlin Gradle plugin's ABI
dump where its text format is stable. Where it is not, or for the Java classes, a repository-owned
Gradle task writes the same sorted format.

SM-1396 prepares a JVM stage in `.github/workflows/release.yml`. The first publish waits for
SM-1384.

1. Gradle's `maven-publish` and `signing` plugins write the three artifacts, with `-sources.jar`,
   `-javadoc.jar`, and checksums, to a local staging directory. The signing key comes from an
   in-memory secret.
2. A repository script checks that each artifact version equals the train version. A difference
   fails the stage.
3. The script zips the staging directory and uploads the bundle to the Central Publisher Portal API
   with `publishingType=USER_MANAGED`. The maintainer then publishes the validated deployment in
   the Portal.
4. The token and the key come only from GitHub Actions secrets in a protected `maven-central`
   environment. SM-1396 names the secrets for SM-1384.
5. A dry-run job builds and signs with a throwaway key in CI, and uploads nothing.

Maven Central never deletes a published version. `USER_MANAGED` therefore keeps a human check
before a version becomes permanent. After two clean releases, the maintainer can change the stage
to `AUTOMATIC`. That changes no governed surface.

`docs/compatibility.md` gains a JVM section that mirrors the Ruby gem section.

### The parity column

_SM-1381 decision 9, and the open detail of the parity column name. Recommendation._

`docs/parity.md` gains one column named `JVM`. Its cells describe the `workhorse` artifact, which
every Kotlin and Spring caller uses. A cell reads Supported only with executed evidence, as Ruby's
cells do. At 1.0.0 every product cell in the column reads Supported, including the embedded
dashboard backend row.

A short note under the worker table states two facts. The Kotlin module reaches every cell through
the core. The starter reaches every Client and Worker cell through the beans it builds.

### Scope and line budget

The budgets are estimates, not limits. Java needs explicit types, builders, and records, so the core
lands above Python's 8,242 lines.

| Path under `jvm/`                                                | Owner   | Contents                                                  |
| ---------------------------------------------------------------- | ------- | --------------------------------------------------------- |
| `settings.gradle.kts`, `build.gradle.kts`, each module's         | SM-1383 | build, toolchain checks, and the CI lane                  |
| `workhorse/…/internal/SqlCatalogue.java`                         | SM-1383 | generated, outside the budget                             |
| `workhorse/…/workhorse/{Queue,errors,values,contracts}`          | SM-1385 | client, errors, codec, and contract validator             |
| `workhorse/…/workhorse/{Worker,CancellationToken,WorkerProcess}` | SM-1386 | run loop, leases, listener, drain, and the process helper |
| `workhorse/…/workhorse/HandlerContext` and suspension            | SM-1387 | durable context and the RFC 8785 fingerprint              |
| `workhorse/…/workhorse/` batch and fast tier                     | SM-1388 | fast tier, slot cohorts, and batch delivery               |
| `workhorse/…/workhorse/Admin` and its page types                 | SM-1389 | the operator client                                       |
| `workhorse/…/workhorse/dashboard/`                               | SM-1390 | the servlet filter and the pattern translator             |
| `workhorse/…/internal/telemetry/`                                | SM-1392 | spans, metrics, and trace context                         |
| `workhorse-spring-boot-starter/`                                 | SM-1393 | auto-configuration, lifecycle, and health                 |
| `workhorse-kotlin/`                                              | SM-1394 | suspend handlers, wrappers, and the DSL                   |

The core budget is 12,000 to 16,000 lines in `workhorse/src/main`, excluding the generated
catalogue, the dashboard package, and tests. The dashboard package adds about 2,000 lines outside
the budget. The Kotlin module takes about 800 to 1,500 lines, and the starter about 800 to 1,200.

The other SM-1381 children are these.

- SM-1384: the maintainer checklist for the domain, the Central namespace, and the signing key.
- SM-1391: the conformance lane over `protocol/v1` and the `JVM` parity column.
- SM-1395: `api/java.txt`, `api/kotlin.txt`, and their checks.
- SM-1396: the release stage of the section above.
- SM-1397: the `support.json` entries and the `docs/compatibility.md` floors.
- SM-1398: the JVM README, the guide examples, the architecture pages, and the site.

The benchmark gate in the private operations repository is a separate maintainer item. This record
sets no throughput bar.

## Amendments to the 1.0.0 decisions

ADR 0084 added the Ruby API as the ninth surface. This section does the same for the Java and
Kotlin APIs. It amends ADR 0054, ADR 0056, and ADR 0059.

### The Java API is the tenth governed surface, and the Kotlin API is the eleventh

**10. The Java API.** A breaking change makes caller code that ran against the previous release
fail to compile, fail to link, or behave differently. The surface has two parts.

- Every public and protected declaration in an exported package of `workhorse` and
  `workhorse-spring-boot-starter`, with its signature and nullness.
- Every `workhorse.*` configuration property name, with its type and default.

**11. The Kotlin API.** The same rule applies to every public declaration of `workhorse-kotlin`,
including its default arguments, `suspend` modifiers, and reified type parameters.

A declaration is internal when its package is not exported, as `dev.stablemates.workhorse.internal`
is not. `SqlCatalogue`, `Suspension`, the default codec, the contract validator, the pattern
translator, and the worker's heartbeat and listener are internal this way.

Removing or renaming a declaration or a property is breaking. So is narrowing a signature. Examples
are a changed parameter type and a new abstract method on an interface that callers implement. Adding a class, a method, a builder
option, a default interface method, or a property is not. The version string is not part of the
promise.

ADR 0059 therefore assembles the specification from eleven surfaces.

### Gate 1 gains `java-api:check` and `kotlin-api:check`

Gate 1 of ADR 0056 gains two rows.

| Surface        | The check                                                           |
| -------------- | ------------------------------------------------------------------- |
| The Java API   | `java-api:check`, against the committed snapshot `api/java.txt`     |
| The Kotlin API | `kotlin-api:check`, against the committed snapshot `api/kotlin.txt` |

Gate 1 then has eleven checks. Both run in the CI `required` job.

### The Java and Kotlin clocks start where their snapshots land

Gate 2 needs six weeks and two published 0.x minors after the last non-additive change to a
governed surface. Before SM-1395, no file records whether a JVM change was additive.

Each JVM surface has its own clock. The Java clock starts at the later of two commits. One is the
merge of SM-1395, which first lands `api/java.txt`. The other is the last merge that removes a line
from that file.
The Kotlin clock starts in the same way from `api/kotlin.txt`. Both counted minors must publish all
three artifacts to Maven Central from a commit at or after that start.

The first publish waits for SM-1384. So the earliest qualifying pair is the first two train minors
that publish the artifacts after both SM-1384 and SM-1395 are done. Both must publish before 1.0.0.
The two clocks run beside the other nine and do not replace them. The tag needs every clock to have
run out.

### The cold install covers the JVM

Gate 3 of ADR 0056 needs a fresh host to install the candidate from the published registries. That
gate now covers six language lines. The fresh host also follows only the site's installation page
to do two things.

1. It builds a Java consumer with Gradle that takes `dev.stablemates:workhorse` from Maven Central,
   and runs a task end to end.
2. It builds a Kotlin consumer that takes `dev.stablemates:workhorse-kotlin`, and runs a suspend
   handler end to end.

The release consumer check of SM-1396 also builds a Spring Boot consumer of the starter.

### The JVM artifacts ride the train and float afterwards

The three artifacts join the one 1.0.0 release train of ADR 0054. They publish 1.0.0 from the same
source commit as the other five language lines. After 1.0.0 their version line floats
independently, like the others. The three JVM artifacts always share one version.

## Consequences

### Positive

- A Java or Kotlin application enqueues in its own transaction, through a plain `Connection` or
  through `@Transactional`, without a paid edition.
- A JVM worker processes tasks that any other SDK enqueues, and the reverse, because the protocol is
  the contract.
- A JVM worker wakes on `LISTEN`/`NOTIFY` instead of a poll interval. The baseline polls.
- One virtual thread for each task gives a JVM worker high concurrency with blocking code.
- A Kotlin caller gets real nullable types from JSpecify, and `suspend` handlers from the module.
- A Spring Boot application needs only properties and handler beans. A web replica runs no worker
  unless its configuration asks for one.
- The core needs only PgJDBC and JSpecify, so it adds little to a crowded class path.

### Negative

- Three artifacts need three release checks and two snapshots, not one.
- A Spring Boot worker process must set `workhorse.worker.enabled=true`. Without it, the starter
  only logs a warning, and its tasks wait.
- Gate 2 cannot close before two train minors publish the JVM artifacts. The first publish waits for
  the domain and the namespace.
- A caller without Spring writes a small codec to receive records instead of maps.
- The starter amends ADR 0021, so one framework package exists. A later request for another
  framework adapter needs its own decision.
- The Spring Boot floor follows Spring's short support windows. It rises to 4.1 within weeks of the
  first publish.
- On Java 21, a handler that blocks inside `synchronized` pins its carrier thread.
- A JDBC call in a handler does not reliably answer an interrupt, so a slow handler can still be
  abandoned at the drain deadline.
- The pattern translator accepts only the subset that `dashboard/v1` uses today. A new construct in
  that contract needs a translator change.
- `CONTEXT.md` names nine governed surfaces. SM-1395 must change it to eleven when it lands the
  checks.

## Rejected alternatives

### Shape

- **One Java SDK with no Kotlin module.** Kotlin callers would wrap every call in
  `withContext(Dispatchers.IO)` and write blocking handlers. The maintainer chose a module.
- **A Kotlin-first SDK.** Every Java caller would take the Kotlin standard library and coroutines,
  and Java would need `@JvmOverloads`, `@JvmStatic`, and `CompletableFuture` wrappers.
- **Two separate SDKs.** The conformance lane and every protocol slice would run twice for one
  protocol.
- **One artifact with Kotlin and Spring inside.** A Java caller would take the Kotlin standard
  library, and a caller without Spring would take Spring.
- **A separate auto-configuration artifact beside the starter.** Spring allows one starter artifact
  that holds its auto-configuration. A fourth artifact would add a release check for no caller.

### Coordinates and build

- **The group `io.github.stablemates`.** Central verifies `io.github.<user>` only for a GitHub user,
  not for an organization.
- **The bare artifact name `workhorse` under another group.** The group carries the product name
  already. A longer name such as `stablemates-workhorse` repeats it.
- **Maven as the build tool.** The maintainer chose Gradle with the Kotlin DSL. The Kotlin module
  and its ABI dump need the Kotlin Gradle plugin anyway.
- **A Gradle wrapper.** It pins Gradle a second time, in its distribution URL. `mise.toml` owns
  every tool pin, and `pnpm toolchain:verify` cannot read the wrapper's pin.

### Floors and drivers

- **A Java 17 floor.** It would reach more Spring Boot 3 users, but Java 17 has no final virtual
  threads. The worker model would then need a second thread model.
- **R2DBC or a reactive driver.** The maintainer kept 1.0.0 to PgJDBC. A reactive driver would
  double the connection model, and the R2DBC driver does not mention composite types.
- **`synchronized` inside the SDK.** It pins a virtual thread on Java 21.

### Worker

- **A fixed platform thread pool for handlers.** It caps concurrency at the pool size. Virtual
  threads let the database pool, not the thread count, limit the work.
- **`Thread.stop` or killing a handler at the deadline.** The JDK removed `Thread.stop`, and no safe
  replacement exists. An interrupt is cooperative.
- **A JVM shutdown hook in the core.** A library that installs one decides the process lifecycle for
  its caller. The starter and the caller own the process.
- **No process helper.** Each program without Spring would write its own shutdown hook and drain,
  and every other SDK gives that boundary in one call.
- **Signal handlers through `sun.misc.Signal`.** A handler could drain, and then call
  `System.exit(0)`, which runs the shutdown hooks. It could also give Ruby's second-signal exit. But
  the API lives in `jdk.unsupported`, which the JDK does not support as a public API. A governed
  surface must not depend on it.
- **A counterpart of Ruby's `run_worker_processes`.** It forks processes for CPU-bound work. The
  JVM runs handlers in parallel in one process, so it needs no fork supervisor.
- **Structured concurrency for handlers.** It is still a preview API in Java 27 and needs
  `--enable-preview`.
- **Checked exceptions.** They cannot pass through a `java.util.function` lambda, and Kotlin has
  none.
- **Java names that end in `Error`.** A Java `Error` means a fault that a caller must not catch.

### Values

- **Jackson as a required core dependency.** Spring Boot 4 uses Jackson 3, and many other
  applications still use Jackson 2. Either choice adds a large dependency that the other half does
  not want. A Jackson type in a public signature would also make a Jackson major a breaking change
  of the Java API.
- **Another JSON library as a required dependency.** It has the same cost for fewer callers. A
  later minor can add an optional codec to the core additively.
- **A JSON Schema library for contracts.** The profile is small and every SDK validates it with its
  own code since ADR 0039. A library would accept keywords outside the profile, and the SDK would
  still have to reject them first.

### Dashboard

- **An `HttpServlet` instead of a filter.** A servlet answers only the path that the container maps
  to it. It cannot pass a request through to the host. A servlet mapping also splits the path into a
  servlet path and path info, which a mount must join again.
- **A Spring MVC controller.** It would tie the backend to Spring, which ADR 0018 forbids.
- **The JDK HTTP server on a separate port.** The dashboard would not run on the host
  application's own server, which ADR 0029 requires.
- **Leaving the servlet dashboard until after 1.0.0.** The maintainer put it in scope. The JVM would
  otherwise be the only SDK without the operator console that ADR 0029 promises.

### Patterns

- **`java.util.regex` without translation.** `$` would accept a value followed by a final line
  terminator, so the JVM would accept input that the TypeScript reference refuses.
- **A port of Ruby's full ECMA-262 translator.** It is about 270 lines plus a property table. The six
  patterns use none of the constructs that it exists for.
- **A third-party ECMA-262 engine.** The JVM engines that JSON Schema validators offer add
  about 2 MB or about 50 MB to the class path.

### Canonical JSON

- **A third-party RFC 8785 library.** It adds a dependency for about 200 lines that every other
  SDK writes itself. It would also canonicalize a tree type that is not the core's.
- **Jackson's sorted-key output.** It writes Java number forms, such as `1.0E-7`, and it escapes
  characters that RFC 8785 leaves as they are. So it gives a different digest for some inputs,
  which ADR 0098 forbids.

### Telemetry

- **The OpenTelemetry API as a required dependency.** Go and TypeScript require it. Python, Ruby,
  and Rust keep it optional, and a JVM class path is often crowded.
- **A separate `workhorse-opentelemetry` artifact.** The maintainer fixed three artifacts, and a
  fourth adds a release check for a few hundred lines.
- **Micrometer Observation instead of OpenTelemetry.** Spring prefers it, but the names would pass
  through a bridge, and `api/telemetry.txt` parity would depend on that bridge.
- **SLF4J for logs.** `System.Logger` needs no dependency, and every logging library can receive
  it.

### Spring Boot starter

- **A worker that starts when `TaskHandler` beans exist.** A replica that only enqueues would run
  no worker. But a web replica that shares a handler module with the worker process would start a
  worker without a user decision. ADR 0012 and ADR 0021 forbid that. The startup warning covers
  the case that this rule wanted to cover: a worker process that forgets the property.
- **No worker bean in the starter.** Each Spring worker process would then write its own lifecycle
  bean, its drain, and its health indicator. The bean is the part that most needs the same shape in
  every application.
- **A worker that always starts.** Every replica would run a worker, which is the failure ADR 0021
  exists to prevent.
- **Handler annotations such as a method-level task type annotation.** The maintainer chose beans
  that implement the core interface. An annotation needs reflection at startup and hides the
  handler from a plain unit test.
- **An outbox integration, R2DBC, or other framework adapters at 1.0.0.** Each is additive later.

### Release

- **The OSSRH staging API.** OSSRH reached end of life on 2025-06-30. The staging API is a
  compatibility layer, and Gradle needs extra manual calls with it.
- **A third-party Gradle publishing plugin.** It adds a build dependency that reads the publishing
  credentials. The Portal upload is one HTTP request that a repository script can make.
- **`publishingType=AUTOMATIC` for the first releases.** Maven Central never deletes a version, so
  a mistake in the first release would be permanent.
- **Diff against the published jars with a binary compatibility tool.** No jar is published yet.
  A registry download on every check also adds a network dependency. A committed snapshot needs
  neither, as ADR 0084 found for Ruby.

### Parity column

- **A column named `Java`.** It would hide that the column also covers Kotlin and Spring callers.
- **Two columns, `Java` and `Kotlin`.** Every Kotlin cell follows from the Java core. The second
  column would repeat the first.
- **A column named `Java/Kotlin`.** It puts two names in one header for one artifact family. `JVM`
  is the name SM-1381 already uses.

## Amendment: `QueueHealth` holds the snapshot as one map (2026-10-17)

The Queue surface section first said that `health` returns a record whose fields are the keys of
Ruby's snapshot `Hash`. This amendment supersedes that sentence.

`Queue.health` returns `public record QueueHealth(Map<String, @Nullable Object> snapshot)`. The map
holds the snapshot that `queue_health_v1` returns, with the keys as Ruby returns them.

The snapshot has about 60 top-level keys, and a schema migration can add a key. A record component
for each key would make each new key a change to the canonical constructor and to the accessors.
Under Gate 2 of ADR 0056, that is a breaking change of the Java API. A new snapshot key must not
break the governed surface. A map lets a key appear without a change to the Java API.

Python and Go already type the snapshot as an open map: `python/src/workhorse/types.py:12` and
`go/queue.go:188`. The maintainer chose this form during SM-1385.

## Amendment: `Worker` reports whether a run is in progress (2026-10-18)

The Worker surface section lists the public methods of `Worker`. This amendment adds one method to
that list.

```java
public boolean isRunning();          // a run from start, run, or runOnce is in progress
```

`isRunning` returns `true` from `start` until the worker-owned thread ends. It also returns `true`
from the start of `run` or `runOnce` until that call returns or throws, including the drain. The
worker counts the runs in progress, and `close` is not a run, so a `close` that waits for a run does
not change the result. `isRunning` returns `false` before the first run and after a run ends,
whether a `stop` or an error ended it.

The Spring Boot starter starts its worker with `start`. A lifecycle `stop` that arrives before a
caller-owned thread reads its stop version is lost, so the starter cannot call `run` on its own
thread. The starter health indicator must then see that a started worker stopped without a `stop`,
and report `DOWN`. No other public method shows that state.

The maintainer delegated this decision to the SM-1381 coordinator, who chose this form during
SM-1393. SM-1387 adds the method.

## Amendment: the telemetry test holds the Java names to `api/telemetry.txt` (2026-10-18)

The Telemetry section first said that a test proves each name in `api/telemetry.txt` comes from the
JVM SDK. This amendment supersedes that sentence.

The TypeScript source generates `api/telemetry.txt`. Ruby and Python, the reference SDKs, emit a
subset of it. For example, neither emits `workhorse.enqueue` or the `workhorse.redrive.*`
attributes. So the JVM SDK does not emit each name in the file. The JVM SDK emits
the Ruby reference set and the `workhorse.enqueue` span. The SM-1392 tests check three conditions:

1. Each span, attribute, and instrument that the JVM SDK declares is in `api/telemetry.txt`. Each
   instrument has the kind, unit, and description of the file.
2. Each span, attribute, and instrument that a recording OpenTelemetry SDK captures from an enqueue
   and a worker run against PostgreSQL is in the file.
3. The test holds a sorted list of the names in the file that the JVM SDK does not emit. Each name
   in the file must be declared by the JVM SDK or be on that list. A new name in the file then
   fails the test until the JVM SDK emits it or the list names it. SM-1438 holds the listed names.

The JVM SDK compiles against `opentelemetry-api` 1.55.0. `spring-boot-dependencies` 4.0.8, the
Spring Boot floor, manages that version.

The maintainer delegated this decision to the SM-1381 coordinator, who chose this form during
SM-1392.

## Amendment: a coroutine cancellation waits for a durable statement (2026-10-18)

The Kotlin module section says that a blocking call inside the SDK runs in `runInterruptible`,
which maps the cancellation to `Thread.interrupt()`. This amendment adds one exception to that
sentence.

A durable call of `SuspendHandlerContext` is the exception: the cancellation waits until the core's
statement ends, and then reaches the handler. Only a checkpoint operation gets the interrupt.

An interrupt closes the PostgreSQL socket of a virtual thread. If a cancellation interrupts a
checkpoint or progress write, the worker loses the write. The Java worker defers the drain's
interrupt during its own statements for the same reason (SM-1440). The `Queue` and `Admin` suspend
wrappers keep `runInterruptible`.

The maintainer delegated this decision to the SM-1381 coordinator, who chose this form during
SM-1447.
