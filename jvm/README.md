# Workhorse for Java and Kotlin

The JVM SDK of the Workhorse durable task queue for PostgreSQL. The Java core has a queue client,
an operator client, a worker runtime, and a dashboard backend. A Kotlin module and a Spring Boot
starter extend it.

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="https://workhorse.run/diagrams/readme-overview-narrow-dark.png">
  <source media="(max-width: 600px)" srcset="https://workhorse.run/diagrams/readme-overview-narrow-light.png">
  <source media="(prefers-color-scheme: dark)" srcset="https://workhorse.run/diagrams/readme-overview-dark.png">
  <img src="https://workhorse.run/diagrams/readme-overview-light.png" width="960" alt="One protocol for your workers and your dashboard">
</picture>

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the
> [changelog](https://github.com/stablemates/workhorse/blob/main/jvm/CHANGELOG.md) before you upgrade.
> It does not ask you to recreate your database. Migrations are ordered, and inside a major line a
> migration only adds. Thus a running deployment upgrades in place.

An AI agent should read [the Workhorse documentation index](https://workhorse.run/llms.txt) first.

## Install

The JVM SDK has three artifacts. All three use the group `run.workhorse` and one version.

| Artifact                        | Package                | Use it for                                                       |
| ------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `workhorse`                     | `run.workhorse`        | The queue client, `Admin`, the worker, and the dashboard backend |
| `workhorse-kotlin`              | `run.workhorse.kotlin` | Suspend handlers, suspend wrappers, and a worker DSL             |
| `workhorse-spring-boot-starter` | `run.workhorse.spring` | Auto-configuration, transactions, lifecycle, and health          |

Maven Central does not serve these artifacts yet. Thus, this page gives no Gradle or Maven
dependency to copy. [Compatibility](https://workhorse.run/docs/compatibility) states the supported
Java, Kotlin, Spring Boot, and PgJDBC versions.

Install the schema once, as a deployment step. The application never installs or migrates it.

```bash
npx --package @stablemates/workhorse@0.8.0 workhorse schema install
```

The machine that runs that deployment step needs Node.js 22 or newer. The application itself needs
no Node.js.

Pin that version to the JVM artifact version the application depends on. The two come from one
commit of this repository, so the numbers match. The application refuses a schema below its schema
floor, the oldest schema version it runs against. A schema at or above the floor is compatible
while it still serves the application's protocol.

Runtime processes verify compatibility instead of changing the schema. Call
`Queue.assertCompatible()` or `Admin.assertCompatible()` at startup. A refusal is a
`CompatibilityException`, whose `code()` names the reason.

Requires Java 21 or newer and PostgreSQL 15 through 18.

The core needs PgJDBC 42.7.12 or newer and JSpecify. The Kotlin module needs Kotlin 2.2 or newer.
The starter needs Spring Boot 4.0 or newer.

## Run one task

This Java program enqueues one task and runs it with `Worker.runOnce()`. The release check builds
and runs it from `jvm/release-consumer/java`.

```java
PGSimpleDataSource dataSource = new PGSimpleDataSource();
dataSource.setURL(args[0]);
Queue queue =
    new Queue(ConnectionSource.of(dataSource), QueueOptions.builder().defaultQueue(QUEUE).build());
EnqueueResult enqueued = queue.enqueue(TASK_TYPE, Map.of("packaged", true));

try (Worker worker =
    Worker.builder(dataSource)
        .queues(QUEUE)
        .disableRegistry(true)
        .handle(TASK_TYPE, Map.class, (context, payload) -> Map.of("echo", payload))
        .build()) {
  if (!worker.runOnce()) throw new IllegalStateException("the worker ran no handler");
}
```

The same task in Kotlin uses a suspend handler. The release check builds and runs it from
`jvm/release-consumer/kotlin`.

```kotlin
val dataSource = PGSimpleDataSource().apply { setURL(args[0]) }
val queue = Queue(ConnectionSource.of(dataSource))
val taskId = runBlocking {
  queue
    .enqueueSuspend(TASK_TYPE, mapOf("packaged" to true), EnqueueOptions.builder().queue(QUEUE).build())
    .taskId()
}

workhorseWorker(dataSource) {
    queues = listOf(QUEUE)
    disableRegistry = true
    handle<Map<String, Any?>>(TASK_TYPE) { _, payload -> mapOf("echo" to payload) }
  }
  .use { worker -> check(worker.runOnce()) { "the worker ran no handler" } }
```

Handlers receive at-least-once delivery. Use stable provider idempotency keys around external
effects. In production, run the worker with `WorkerProcess.runWorkerProcess(worker)`, or with the
Spring Boot starter.

`jvm/examples/` holds each Java and Kotlin snippet of the documentation. It also holds a JDBC
transaction, a Spring `@Transactional` service, the dashboard filter, and a worker process. Its
tests run every snippet against PostgreSQL. It is not an artifact and is never published.

`jvm/examples/programs/` holds the scenario programs that the other SDKs also have: the quickstart,
a transactional enqueue, a dedicated worker, an orchestration, a demo worker, and an agentic flow.
Each program has a `main` method and reads a JDBC URL from `WORKHORSE_DATABASE_URL`. The demo
worker reads `DATABASE_URL_PRIMARY`. Its tests start each program in a child JVM against
PostgreSQL. It is not an artifact and is never published.

## Package boundary

The core is the named Java module `run.workhorse`. Every package is `@NullMarked`, so
a Kotlin caller reads each nullable value as a nullable type.

- `Queue` enqueues, cancels, signals, completes human waits, creates task groups, and synchronizes
  schedules, policies, budgets, and contracts. Each method has two forms. The source form takes a
  connection from the `ConnectionSource` for the call. The caller form takes your `Connection`
  first and runs in your open transaction, so the enqueue becomes part of your commit. The SDK
  never commits, rolls back, or closes a connection that you give it.
- `Worker` takes a `DataSource`, registers handlers by task type, and runs each handler on its own
  virtual thread under a lease. `WorkerProcess.runWorkerProcess(worker)` drains the worker on
  `SIGINT` or `SIGTERM`.
- `HandlerContext` offers checkpoints, durable sleeps, signal and human waits, child tasks, task
  groups, and progress. PostgreSQL owns every durable decision, and an unresolved wait suspends the
  task.
- `Admin` lists, inspects, and repairs tasks, dead letters, waits, workers, queues, and task groups.
- `dashboard.Dashboard` is a Jakarta Servlet filter that serves the dashboard under its own path.
- Payloads and results go through a `JsonCodec`. The default codec reads JSON into maps, lists,
  strings, numbers, and booleans. The starter supplies a codec on the application's Jackson
  `JsonMapper`.
- When the OpenTelemetry API is on the class path, the SDK adds spans, metrics, and trace
  propagation. Without it, telemetry does nothing.

Each Workhorse exception extends the unchecked `WorkhorseException`. An invalid argument throws
`IllegalArgumentException`. The SDK never installs or migrates the
shared PostgreSQL schema.

### Kotlin

`workhorse-kotlin` adds no protocol behavior. It gives each `Queue`, `Admin`, and handler context
call a suspend form, such as `enqueueSuspend`. `workhorseWorker` builds a `Worker` with a DSL, and
`handle<P>` registers a `SuspendHandler` with a reified payload type.

### Spring Boot

`workhorse-spring-boot-starter` builds `Queue` and `Admin` beans from the application's
`DataSource`. The starter requires only the core, `spring-boot-autoconfigure`, and
`spring-boot-jdbc`. Add Jackson, Spring Boot health, `spring-web`, or the OpenTelemetry API to use
the feature that needs it. An enqueue inside `@Transactional` joins that transaction. The worker is
off by default. A worker process sets `workhorse.worker.enabled=true`, and the starter then
registers every `TaskHandler` bean. Keep `spring.lifecycle.timeout-per-shutdown-phase` above
`workhorse.worker.shutdown-grace` plus 2 seconds. Then Spring waits for the drain and the cleanup.

## Next

- Follow the [quickstart](https://workhorse.run/docs/quickstart) and deploy
  [worker processes](https://workhorse.run/docs/worker-processes).
- Enqueue in your own transaction with [transactional enqueue](https://workhorse.run/docs/enqueue).
- Read the [compatibility policy](https://workhorse.run/docs/compatibility).
