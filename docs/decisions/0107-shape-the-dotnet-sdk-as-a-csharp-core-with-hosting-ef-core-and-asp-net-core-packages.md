# ADR 0107: Shape the .NET SDK as a C# core with hosting, EF Core, and ASP.NET Core packages

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amends:** [ADR 0021](0021-no-framework-integration-packages.md),
  [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0059](0059-assemble-the-1-0-0-specification.md)
- **Related:** [ADR 0018](0018-framework-neutral-dashboard-host.md),
  [ADR 0023](0023-language-sdks-and-http-boundaries.md),
  [ADR 0028](0028-flat-per-language-repository-layout.md),
  [ADR 0029](0029-embeddable-dashboard-backends.md),
  [ADR 0030](0030-distinguish-suspensions-gates-and-child-joins.md),
  [ADR 0039](0039-use-a-restricted-json-schema-contract-profile.md),
  [ADR 0056](0056-set-the-1-0-0-exit-criteria.md) (SM-1615 records the changed gates),
  [ADR 0058](0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md),
  [ADR 0070](0070-publish-the-verified-sqlalchemy-transaction-accessor.md),
  [ADR 0071](0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md),
  [ADR 0072](0072-converge-the-worker-runtime-defaults.md),
  [ADR 0074](0074-shape-the-rust-sdk-as-one-python-shaped-crate.md),
  [ADR 0076](0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md),
  [ADR 0077](0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md),
  [ADR 0078](0078-start-a-long-running-workers-first-claim-beside-its-startup-maintenance-pass.md),
  [ADR 0083](0083-run-each-language-suite-once-per-change.md),
  [ADR 0095](0095-add-task-groups-with-completion-callbacks.md),
  [ADR 0098](0098-check-the-input-of-a-checkpoint-on-replay.md),
  [ADR 0103](0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md),
  [ADR 0105](0105-skip-a-locked-row-in-a-heartbeat-and-report-the-lease-as-busy.md),
  [ADR 0106](0106-keep-the-release-lines-in-lockstep-after-1-0-0.md)
- **Issue:** SM-1614. SM-1613 lists the decisions, and SM-1355 is the fact base.

## Context

ADR 0023 makes the SQL protocol the authority, and every language SDK an orchestration layer. .NET
applications cannot use Workhorse today. On 2026-10-18 the maintainer decided that .NET is the
second new SDK, after the JVM, and that 1.0.0 ships when both SDKs land. SM-1360 records that
decision, and SM-1613 lists the decisions for the .NET SDK. No .NET code exists in this repository
yet. This record designs the SDK before SM-1616 through SM-1630 implement it, as ADR 0103 did for
the JVM.

Six facts from SM-1355 shape the design.

- **Npgsql is the only maintained ADO.NET driver for PostgreSQL.** It sends native `$1`
  placeholders without a change. So the generated SQL catalogue runs as it is.
- **The Generic Host is the standard process model.** A `BackgroundService` holds a long-running
  loop. `ConsoleLifetime` handles `SIGINT`, `SIGQUIT`, and `SIGTERM`. The default shutdown timeout
  is 30 s, and the ADR 0072 shutdown grace of 25 s fits inside it.
- **.NET has no shared task API.** `Microsoft.Extensions.*` defines hosting, dependency injection,
  options, logging, and health checks, but no enqueue abstraction. So no adapter reaches every
  framework. The integration targets are the host, EF Core, and ASP.NET Core.
- **The runtime has tracing and metrics.** `ActivitySource` and `Meter` are part of .NET. An
  OpenTelemetry SDK in the application listens to them, so the SDK needs no OpenTelemetry package.
- **The baseline in .NET has no language-neutral protocol.** In the baseline, a task is a
  serialized .NET call or a .NET message type. No other language can enqueue it or run it, and no
  baseline library gives durable waits under PostgreSQL authority.
- **ADR 0056 Gate 2 freezes the shape early.** The C# API must change only additively after its
  first published minor. So this record settles the governed surface now.

The JVM SDK is the template. Its amendments record lessons that this record applies from the
start: public records that can grow (SM-1516), a shared listener connection (ADR 0071), `Admin` at
the ADR 0059 bar, and dependency floors above known advisories. Each choice below follows a Ruby,
Python, or JVM surface, or names the .NET constraint that forces a difference. The decisions are
numbered as in SM-1613. Where SM-1613 left a detail open, this record decides it and lists the
rejected alternatives.

## Decision

### Package IDs and namespaces

_SM-1613 decision 6. The coordinator accepted these IDs and the fallback on 2026-10-22._

| Package ID                      | Root namespace                  | Contents                                                     |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `Workhorse`                     | `Workhorse`                     | client, worker, `Admin`, durable context, and telemetry      |
| `Workhorse.Hosting`             | `Workhorse.Hosting`             | dependency injection, options, the hosted worker, and health |
| `Workhorse.EntityFrameworkCore` | `Workhorse.EntityFrameworkCore` | the EF Core transaction accessor                             |
| `Workhorse.AspNetCore`          | `Workhorse.AspNetCore`          | the embedded dashboard backend                               |

The project keeps one identity, `workhorse.run`, as SM-1455 decided for the JVM. The package IDs
therefore use the product name and not `stablemates`. Each assembly name is its package ID. No
public type is named `Workhorse`, so the namespace never hides a type.

The ID prefix is `Workhorse.*`. On 2026-10-22, nuget.org had no package whose ID starts with
`Workhorse`. SM-1441 step 4 asks nuget.org to reserve the prefix for the organization `stablemates`.

nuget.org can refuse the reservation. Its criteria say to avoid common or generic words, and
"workhorse" is a common English word. A reservation is not necessary to publish. If nuget.org
refuses, the fallback is this:

1. The four packages publish with the same IDs and no reservation.
2. The organization `stablemates` owns each ID from its first publish.
3. The site's installation page, `support.json`, and `docs/compatibility.md` name the four IDs and
   no other ID.

The fallback changes no namespace, so it changes no line of `api/dotnet.txt`.

Each extension method lives in the namespace of its package. For example,
`IServiceCollection.AddWorkhorse` is in `Workhorse.Hosting`, not in
`Microsoft.Extensions.DependencyInjection`. So `api/dotnet.txt` lists only `Workhorse` namespaces.

### Packages and their dependencies

_SM-1613 decision 5._

The repository builds the four packages from one solution, rooted at `dotnet/` under ADR 0028. Each
package has a separate reason to exist. A worker must not take ASP.NET Core. A caller without EF
Core must not take EF Core.

| Package                         | Required dependencies                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workhorse`                     | `Npgsql`, and `Microsoft.Extensions.Logging.Abstractions`, which `Npgsql` already brings                                                                          |
| `Workhorse.Hosting`             | `Workhorse`, `Microsoft.Extensions.Hosting.Abstractions`, `Microsoft.Extensions.Options.ConfigurationExtensions`, `Microsoft.Extensions.Diagnostics.HealthChecks` |
| `Workhorse.EntityFrameworkCore` | `Workhorse`, `Microsoft.EntityFrameworkCore.Relational`                                                                                                           |
| `Workhorse.AspNetCore`          | `Workhorse`, and the framework reference `Microsoft.AspNetCore.App`                                                                                               |

The core uses `System.Text.Json`, `System.Diagnostics.ActivitySource`, and
`System.Diagnostics.Metrics.Meter` from the runtime. It has no other dependency.

Hosting, dependency injection, options, and health checks share one package. Their
`Microsoft.Extensions.*` packages follow the runtime's version line, so they do not couple the
package to a framework major. EF Core and ASP.NET Core each get a package, because each couples to
its own major.

Each satellite package depends on `Workhorse` with a minimum version equal to its own train
version. It uses only the public API of the core. No shipped assembly gives
`InternalsVisibleTo` to another shipped assembly. So a mixed set of versions cannot break an
internal contract. Only the test projects see the internals.

### SQL comes from the generated catalogue

_SM-1613 decision 3._

SM-1616 adds a C# target to `scripts/generate-sql-catalogues.ts` and to
`pnpm sql-catalogues:check`. The target writes `SqlCatalogue.g.cs` as an `internal static` class
of the core. Npgsql sends native positional placeholders, so the generator keeps each `$n` as it
is. A statement that uses one `$n` twice binds the value once. No C# class writes protocol SQL by
hand.

The dashboard backend uses `Admin` and `Queue` where they have a method. Some `dashboard/v1`
procedures, such as the retention controls and the dashboard reads, have no `Admin` method, and the
JVM backend calls its catalogue for them. `Workhorse.AspNetCore` cannot read the core's internal
catalogue, because no shipped assembly gives `InternalsVisibleTo`. So the generator writes a second
internal class, `DashboardSqlCatalogue.g.cs`, into `Workhorse.AspNetCore`. It holds only the
statements that the backend calls directly, and the same stale check covers it. Both outputs come
from `protocol/v1/manifest.json`, so .NET adds nothing to the governed SQL surface.

The SDK binds each parameter with an `NpgsqlParameter` that has no name. Its `NpgsqlDbType`
follows the cast in the contract.

- A `jsonb` value binds as `text`, and the contract's `::jsonb` cast converts it.
- `jsonb[]`, for `complete_many_and_claim_v1`, binds as a `string[]`, and the `$4::jsonb[]` cast
  converts it.
- `interval`, for `prune_worker_registry_v1`, comes from `make_interval(secs => $1::double
  precision)`. The SDK binds the seconds as a `double`.
- A composite result, such as that of `get_maintenance_policy_v1`, comes back as columns, because
  the statement selects `(policy).*`.

If a protocol function is difficult to call from Npgsql, the slice stops and reports it. A protocol
change is a separate slice.

### Floors

_SM-1613 decisions 2 and 3._

| Dependency                                             | Floor  | Tested in CI                       | The authority that ends a version   |
| ------------------------------------------------------ | ------ | ---------------------------------- | ----------------------------------- |
| .NET (target framework `net10.0`)                      | 10     | 10 and 11                          | the Microsoft .NET support policy   |
| Npgsql                                                 | 10.0.3 | the floor and the newest release   | the dependency range rule, ADR 0058 |
| `Microsoft.Extensions.*` packages, `Workhorse.Hosting` | 10.0.0 | the floor and the newest 10 and 11 | the Microsoft .NET support policy   |
| EF Core Relational, `Workhorse.EntityFrameworkCore`    | 10.0.0 | 10 and 11                          | the EF Core support policy          |
| ASP.NET Core, `Workhorse.AspNetCore`                   | 10     | 10 and 11                          | the Microsoft .NET support policy   |

.NET 8 and .NET 9 reach end of support on 2026-11-10. .NET 10 is a long-term release, supported
until 2028-11-14. .NET 11 is a short-term release, at RC2 on 2026-10-13. CI tests .NET 11 at its
newest release candidate until it ships, and then at its newest release. The weekly run of ADR 0083
tests every version.

Each package targets only `net10.0`. A `net10.0` library runs in a .NET 11 application without a
second target. ADR 0058 raises the floor in a minor release after .NET 10 reaches end of support.

NuGet resolves the lowest version that a range allows. So the floor of a range is the version that
a caller gets when nothing else in its graph asks for more. The Npgsql floor is therefore 10.0.3,
the newest release on 2026-10-22, and not 10.0.0. Npgsql runs every statement, and the floor lane of
CI tests that exact version. No GitHub advisory affects Npgsql 10.x on 2026-10-22. The SDK sets no
upper bound on any range, so Npgsql 11 resolves when an application asks for it.

The `Microsoft.Extensions.*` and EF Core floors are 10.0.0. The SDK uses only APIs that exist in
10.0.0, and no advisory affects those packages on 2026-10-22. An application that references a
newer patch keeps it.

ASP.NET Core is a shared framework. The installed runtime supplies its patches, not the package
graph. So its floor is a major version. The guide tells the operator to run a serviced .NET 10 or
11 runtime.

SM-1627 adds `dotnet`, `npgsql`, `efcore`, and `aspnetcore` entries to `support.json`, with their
end-of-life dates, so the ADR 0058 check covers them. It also adds a dependency scan. Restore runs
NuGet Audit with `NuGetAuditMode` set to `all` and each finding as an error. A second job restores a
consumer that resolves every package at its floor and runs
`dotnet list package --vulnerable --include-transitive`. Every floor must stay above its known
advisories, as the JVM amendment of 2026-10-18 requires.

### Build tool

The build is the .NET SDK CLI, `dotnet`. `mise.toml` pins the .NET SDK that builds .NET 10 and 11.
Repository commands refuse a tool that disagrees with the pin, as for the other pinned tools.

- The repository has no `global.json`. It would be a second pin of the SDK, and
  `pnpm toolchain:verify` reads only `mise.toml`.
- `dotnet/Directory.Packages.props` holds every package version, with central package management.
- `dotnet/Directory.Build.props` turns on nullable reference types, the .NET analyzers, and
  warnings as errors for every project. It also holds the train version, `Version`.
- `pnpm lint` runs `dotnet format --verify-no-changes` over the solution.

### Connection model

_SM-1613 decision 3._

Every statement runs on an `NpgsqlConnection`. The SDK never changes session state on a connection
that the caller owns. It sets no `search_path`, no isolation level, and no transaction.

`Queue` and `Admin` take an `NpgsqlDataSource`. Each instance has two forms.

- **The source form** is the instance from the constructor. For each call, the SDK opens a
  connection from the data source, runs the statement without a transaction, and disposes the
  connection. Npgsql runs a statement without a transaction in autocommit, so the SDK changes no
  session setting.
- **The caller form** is the instance that `Using(NpgsqlConnection connection)` returns. It runs
  every call on that connection. The connection must be open. Npgsql runs each command on a
  connection inside the connection's open transaction, so the call joins the caller's transaction.
  The SDK never opens, closes, begins, commits, or rolls back on that connection.

`Using` returns a `Queue` or an `Admin` with the same methods. So the surface does not double, as
it does with the JVM's overload pairs. `Using` validates nothing that needs a statement. If the
connection is closed, the first call throws `InvalidOperationException`.

`Npgsql` enlists a new connection in an ambient `System.Transactions.TransactionScope` by default.
The SDK opens each connection of the source form, and each worker connection, inside a suppressed
scope. So an ambient scope never changes an autocommit call of the SDK. A caller who wants an
enqueue in a transaction uses the caller form.

Each `Queue` and `Admin` instance caches its compatibility check once for its data source. It also
caches the check once for each caller connection that reaches it. The JVM amendment of 2026-10-18
gives the same rule.

The claim functions raise SQLSTATE `0A000` under repeatable read or serializable isolation. The SDK
maps `0A000` to `IsolationLevelException`, which names the isolation level that the connection
reported. The worker logs the error and tries the claim again after the poll interval.

#### Timestamps are UTC

_SM-1355 open detail: the `timestamptz` rule._

Npgsql writes a `timestamptz` parameter only from a `DateTime` of kind `Utc` or a `DateTimeOffset`
with offset zero. Every public point in time is therefore a `DateTimeOffset`.

1. Before it binds a `DateTimeOffset`, the SDK converts it with `ToUniversalTime()`. A caller value
   with any offset is unambiguous, so the SDK accepts it.
2. The SDK reads each `timestamptz` column as a `DateTimeOffset`, so each result has offset zero.
3. No public signature takes a `DateTime`, because its `Kind` can be `Local` or `Unspecified`.
4. Npgsql's `Npgsql.EnableLegacyTimestampBehavior` switch changes these mappings for the whole
   process. The SDK reads the switch at the first construction of a `Queue`, `Admin`, or `Worker`.
   If it is on, the constructor throws `InvalidOperationException` that names the switch.

#### Npgsql multiplexing is refused

_SM-1355 open detail: multiplexing on or off._

Npgsql multiplexing lets many commands share one physical connection. SM-1355 did not verify its
limits for `LISTEN`, for a reserved connection, or for a caller transaction. The worker holds the
listener and heartbeat connections for a long time, which is the opposite of multiplexing.

So multiplexing is off. `Queue`, `Admin`, `Worker`, and the dashboard read the data source's
connection string with `NpgsqlConnectionStringBuilder`. If `Multiplexing` is `true`, the
constructor throws `ArgumentException` that names the setting. A later minor can accept
multiplexing for `Queue` and `Admin` after a slice tests it. That change only accepts more input.

#### The worker connections follow ADR 0071

The worker takes an `NpgsqlDataSource` and follows ADR 0071 and its amendment of 2026-10-21.

- Each claim and each other statement opens a connection for its own duration.
- The pool identity is the exact `NpgsqlDataSource` reference. The registry is a
  `ConditionalWeakTable`, which compares by reference and does not keep the data source alive. The
  worker does not unwrap a data source.
- Every worker on one data source shares one listener connection and one heartbeat connection.
- `SharedHeartbeats = true` is the opt-out of ADR 0071, with the same meaning and the default
  `false`. With it set, heartbeat rounds open a connection for each statement.
- The connection string reports `Max Pool Size`, so rule 4 of the amendment applies. A pool
  identity needs at least 3 connections, and a worker on a smaller pool refuses to start unless the
  opt-out is set. With `Pooling=false` the size is unknown, and the readiness check of rule 3 is
  the check.
- A runtime acquisition of the heartbeat connection completes inside the round bound B. The pool's
  `Timeout` is never the bound.

#### The listener sends its own keepalive

_SM-1355 open detail: the listener connection and keepalive._

Npgsql reads a notification only during a query or a wait. Its `Keepalive` setting is off by
default, and it belongs to the caller's connection string. The SDK does not change the caller's
pool configuration.

So the listener sends its own keepalive.

1. The listener waits with `NpgsqlConnection.Wait(TimeSpan)`, which returns after the timeout if no
   notification arrives. The timeout is the poll interval.
2. If the connection has been quiet for one poll interval, the listener runs `SELECT 1` on it.
3. If the wait or the query fails, the listener disposes the connection, logs one warning, and
   connects again with backoff. The workers poll until the listener is back, as rule 3 of the ADR
   0071 amendment requires.
4. After it connects again, the listener runs `LISTEN` again and wakes dispatch once, because a
   notification can be lost during the gap.

### Concurrency

_SM-1613 decision 4._

The SDK is asynchronous. Each method that does I/O returns a `Task` and takes a
`CancellationToken`. The SDK awaits with `ConfigureAwait(false)` and never depends on a
`SynchronizationContext`.

- **Handlers** run as tasks on the .NET thread pool. The worker starts each handler with
  `Task.Run`, so a synchronous prefix in a handler does not block dispatch.
- **Slot accounting** bounds concurrency, as Ruby, Python, and the JVM do. A slot is busy while its
  handler runs, reserved while a claim for it is in flight, and handed over when a fused completion
  claims a task into it. Each cohort has its own capacity. Claimed tasks never exceed
  `Concurrency`.
- **Dispatch** follows ADR 0076. The worker keeps overlapping batched claims in flight, fair across
  the configured queues.
- **The heartbeat and the listener** each run on a dedicated thread, and they run their statements
  with the synchronous Npgsql API. Handlers that block thread-pool threads can starve the pool, and
  the pool adds threads slowly. A dedicated thread keeps a lease renewal independent of that
  starvation.

The synchronous API has no `CancellationToken`, and its command timeout counts whole seconds. So
each wait of the heartbeat and the listener has its own deadline mechanism.

1. **A statement on a held connection.** Each heartbeat round runs with the SM-1442 transaction and
   server timeouts that ADR 0105 keeps, so PostgreSQL also ends a round that waits. When B ends,
   the worker does not wait for the statement. The connection still runs that statement, so it
   cannot serve the next round. This is loss of the reservation, not a failed renewal. At that
   moment the worker marks the heartbeat connection as lost, closes the claim gate, and starts a replacement, as rule 6 of the ADR 0071 amendment
   requires. A new dedicated thread then serves the replacement connection.
   The old thread and its connection get one owner, a cleanup task. It calls
   `NpgsqlCommand.Cancel()` and then disposes of the connection. `Cancel()` opens a second
   connection and can block for the connection timeout, and a `Cancellation Timeout` of 0 waits
   without limit. So no part of the worker waits for the cleanup task, and the stop path does not
   join it. SM-1618 adds fault tests for an unreachable cancellation endpoint and for
   `Cancellation Timeout=0`. Each test proves that the claim gate closes at B. The listener uses
   the same rule for its keepalive query, with the poll interval as its bound. The workers then
   poll until the listener is back.
2. **An acquisition.** The startup reservation and each replacement use `OpenConnectionAsync` with a
   token that the budget or B cancels. An acquisition is rare, so it can use the thread pool. The
   pool's `Timeout` is never the bound.
3. **A late connection.** A connection that arrives after its token was cancelled gets one owner,
   which disposes of it, as rule 7 of the ADR 0071 amendment requires.
4. **The stop path.** The worker waits for each dedicated thread until the stop deadline. The
   threads are background threads, so a thread that does not end in time does not keep the process
   alive.

.NET has no global interpreter lock. So CPU-bound handlers run in parallel in one process, and the
SDK has no fork supervisor, unlike Ruby's `run_worker_processes`.

Cancellation is cooperative. The worker never aborts a thread, because .NET has no safe way to do
it. At the drain deadline, the worker cancels the remaining tokens and then abandons the handlers,
as the Worker section states.

#### Cancellation and statements

A cancelled `CancellationToken` makes Npgsql send a PostgreSQL cancel request for the running
statement. In a transaction, PostgreSQL then aborts the transaction. The JVM learned this lesson in
SM-1447 and SM-1526. These rules apply:

- **The caller form passes the caller's token to Npgsql.** The caller owns the token and the
  transaction. A cancellation fails the statement, and the transaction is then aborted. This is the
  usual .NET behavior, and the guide states it.
- **The durable context and the worker do not pass the handler's token to a statement.** A
  checkpoint write, a progress write, a wait, a child enqueue, and every settlement use a token
  that only the stop-path deadline cancels. The handler sees its cancellation after the statement
  ends. Only the checkpoint operation itself receives the handler's token.

### Errors

Every error the SDK throws derives from `WorkhorseException : Exception`. The set mirrors
`ruby/lib/stablemates/workhorse/errors.rb` class for class, as the JVM's does. Each name ends in
`Exception`, as .NET names do. For example, `LeaseLostError` becomes `LeaseLostException`. .NET
adds two classes.

| Protocol outcome            | Class                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| SQLSTATE `0A000` on a claim | `IsolationLevelException`, with the isolation level found                  |
| any other `NpgsqlException` | `DatabaseException`, with the original as `InnerException`, and `SqlState` |

`DatabaseException` keeps Npgsql types out of the `catch` clauses that a caller writes. So a future
Npgsql major does not move the governed surface. An invalid argument throws `ArgumentException` or
`ArgumentOutOfRangeException` before any statement runs. A cancelled caller token throws
`OperationCanceledException`, as every .NET API does. An unknown status always throws
`UnexpectedStatusException`. It is never a silent success.

#### A handler exception becomes a failure envelope

_SM-1355 open detail: how an unhandled handler exception becomes a failure envelope._

Since .NET 6, an unhandled exception from `BackgroundService.ExecuteAsync` stops the host. So no
handler exception may leave `Worker.RunAsync`.

1. An `OperationCanceledException` whose token is the handler's cancelled token settles the attempt
   by the cancellation reason, as in the other SDKs.
2. A suspension settles the attempt as the Suspension section states, whatever the handler threw.
3. Every other exception fails the attempt. The worker writes the envelope of
   `protocol/v1/failures.json`.

The envelope `name` is `exception.GetType().Name`, without a generic arity suffix. If the name holds
a character from `forbiddenNameCharacters`, such as the `<` of a compiler-generated type, the name
is the `genericName` entry. SM-1618 adds the entry `"csharp": "Exception"`. The `message` is
`exception.Message`. The `stack` is `exception.ToString()`, which holds the stack trace and each
inner exception. Redaction follows the claimed task's `redact_error_details`.

.NET has no class of exceptions that a program must not catch, such as Java's `Error` or Ruby's
non-`StandardError` exceptions. `StackOverflowException` ends the process and cannot be caught.
So no handler exception ends the run. A batch handler exception fails each task in the batch.

`RunAsync` throws only for a fault of the worker itself, after the drain. A failed maintenance pass
is such a fault, as rule 4 of ADR 0078 decides. A startup reservation failure is another, as ADR
0071 decides. So is `ShutdownIncompleteException`.

### Values and durations

_SM-1355 open detail: `System.Text.Json` serialization._

Payloads, results, checkpoints, and progress are JSON values. The core reads and writes them with
`System.Text.Json`, which is part of the runtime. So the core needs no codec interface and no JSON
dependency, unlike the JVM.

- Each `Queue`, `Admin`, and `Worker` takes a `JsonSerializerOptions` through its options.
- The default is `JsonSerializerDefaults.Web`, which writes camelCase names and reads names without
  case. It sets `NumberHandling` to `Strict`, so a number never reads from a string. ASP.NET Core
  uses the same naming, and the other SDKs write camelCase JSON in their examples.
- A typed payload, result, checkpoint, or wait value is a type parameter `T`. The SDK calls
  `JsonSerializer.Deserialize<T>` and `JsonSerializer.Serialize`. An untyped value is a
  `JsonElement`.
- The SDK refuses a non-finite number with `ArgumentException`. It never writes such a value as a
  string. Its copy of the caller's options adds internal converters for `double`, `float`, and
  `Half` that refuse a non-finite value before the writer sees it. The SDK refuses an options object
  whose `NumberHandling` includes `AllowNamedFloatingPointLiterals`. A property attribute that
  selects its own converter or number handling bypasses these converters. The guide states that
  such an attribute must not write a non-finite number, as a JVM codec must not.
- The SDK refuses a lone surrogate with `ArgumentException`. `System.Text.Json` replaces a lone
  surrogate with U+FFFD when it writes, so a check of the encoded text cannot find it. The SDK
  therefore serializes with a copy of the caller's options that adds an internal
  `JsonConverter<string>`. Its `Write` and `WriteAsPropertyName` methods refuse the string before
  the writer sees it. The SDK checks the strings of a `JsonNode` value in the same way. An object
  property name does not pass through that converter. So before it first writes a type, the SDK
  reads the type's resolved `JsonTypeInfo` and refuses a property name with a lone surrogate. Tests
  cover a string value, a dictionary key, a property name from an attribute and from a naming
  policy, a `JsonNode` value, a non-finite number, and a checkpoint input.
- A payload contract validates the JSON text, not the .NET object. Two option sets that write the
  same JSON text give the same validation result. An option that changes the text, such as a naming
  policy, can change the result.

A JSON integer beyond 2^53 - 1 survives a .NET round trip as a `long` or a `decimal`. It still
rounds in a TypeScript or Go worker. `docs/parity.md` already documents that limit. `BigInteger` is
not a supported payload type, because `System.Text.Json` has no number converter for it.

1.0.0 does not promise trimming or Native AOT. The reflection-based `JsonSerializer` calls need
unreferenced code. A later minor can add overloads that take a `JsonTypeInfo<T>`. That change is
additive.

A duration is a `TimeSpan`. A point in time is a `DateTimeOffset` in UTC. A task ID is a `Guid`.
A fence token is a `long`.

#### Public types grow only additively

_The SM-1516 lesson._

A positional C# record has a primary constructor and a `Deconstruct` method. A new component changes
both, which breaks callers. A new optional parameter changes the method signature, which breaks
binary callers. These rules apply to every public type from the first publish.

1. A public record is a `sealed record` with `init` properties. It has no positional parameters
   and no public `Deconstruct`. A new property is additive.
2. A property added after the first publish is never `required`. It is nullable, or it has a
   default that keeps the earlier behavior.
3. A public method has no optional parameters, except `CancellationToken cancellationToken =
   default` as the last parameter. A new setting goes into an options record, or into a new
   overload.
4. An interface that callers implement gains a member only with a default implementation.
5. An enum can gain a member. A closed result family, such as `DashboardAuthorization`, is an
   abstract class with a private constructor, and it can gain a derived class. A caller `switch`
   must handle an unknown value.

A new property also changes `Equals`, `GetHashCode`, and `ToString`. That change is not breaking.
`QueueHealth` holds the snapshot as one `IReadOnlyDictionary<string, JsonElement>`, as the JVM
amendment of 2026-10-17 decided.

### Worker surface

_SM-1613 decision 4._

```csharp
namespace Workhorse;

public interface ITaskHandler<TPayload>
{
    string TaskType { get; }
    Task<object?> HandleAsync(HandlerContext context, TPayload payload);
}

public sealed class WorkerOptions
{
    public IList<string> Queues { get; set; }            // default ["default"]
    public string? WorkerId { get; set; }
    public int Concurrency { get; set; }
    public int Cohorts { get; set; }
    public TimeSpan Lease { get; set; }
    public TimeSpan? Heartbeat { get; set; }
    public TimeSpan? PollInterval { get; set; }
    public bool PollingOnly { get; set; }
    public TimeSpan MaintenanceInterval { get; set; }
    public TimeSpan MaintenanceRoutineInterval { get; set; }
    public TimeSpan RegistryInterval { get; set; }
    public bool DisableRegistry { get; set; }
    public IList<string> ScheduleNamespaces { get; set; }
    public int ScheduleCatchupLimit { get; set; }
    public TimeSpan ShutdownGrace { get; set; }
    public bool SharedHeartbeats { get; set; }
    public RetryDelay? RetryDelay { get; set; }
    public JsonSerializerOptions? Json { get; set; }
    public ILoggerFactory? LoggerFactory { get; set; }
}

public sealed class Worker : IAsyncDisposable
{
    public Worker(NpgsqlDataSource dataSource, WorkerOptions options);

    public void Handle<TPayload, TResult>(string taskType,
        Func<HandlerContext, TPayload, Task<TResult>> handler);
    public void Handle<TPayload>(string taskType, Func<HandlerContext, TPayload, Task> handler);
    public void Handle<TPayload>(ITaskHandler<TPayload> handler);
    public void HandleBatch<TPayload>(string taskType, BatchOptions options,
        Func<IReadOnlyList<BatchHandlerItem<TPayload>>, CancellationToken, Task> handler);

    public Task RunAsync(CancellationToken stoppingToken);       // until the token, then drains
    public Task<bool> RunOnceAsync(CancellationToken cancellationToken = default);
    public void Pause();
    public void Resume();
    public bool IsPaused { get; }
    public bool IsRunning { get; }
    public string WorkerId { get; }
    public IReadOnlyList<string> Queues { get; }
    public int Concurrency { get; }
    public int Cohorts { get; }

    public event EventHandler<Exception>? RegistrationError;
    public event EventHandler<Exception>? NotificationError;
    public ValueTask DisposeAsync();                             // stop, then wait for the drain
}
```

`WorkerOptions` has settable properties, so the configuration binder of `Workhorse.Hosting` fills
it. The worker copies and validates the options in its constructor, so a later change to the
object has no effect. The defaults are the ADR 0072 values. `Heartbeat` defaults to
`max(100 ms, Lease / 3)`, as the JVM amendment of 2026-10-18 states. The concurrency bounds and the
`HandleBatch` bounds are the ones every other SDK enforces. `RetryDelay` is a delegate over the
attempt and the claimed task that returns a `TimeSpan?`, as in Python.

A handler registers before the first run. A call to `Handle` after the first run throws
`InvalidOperationException`. Registering a task type again replaces its handler. A task type with no
handler is released so that another worker can claim it. The type parameter carries the full
payload type, including its type arguments, so a batch handler of `List<Order>` receives orders.
The JVM amendment of 2026-10-20 gives the same rule. A JSON payload can be `null`. A handler that
registers `Order?` then receives `null`.

On the fast tier of ADR 0077, the worker batches completions into fused claims and splits its slots
into cohorts. A long-running worker starts its first claim beside its startup maintenance pass, as
ADR 0078 requires. The shared runtime fixture
`busy-worker-refills-slots-with-overlapping-batched-claims` pins the dispatch in C# as it does in
the other six SDKs.

The heartbeat acts on each `heartbeat_v1` status as ADR 0074's table describes. A lease that the
local watchdog expired is not renewed (SM-1445). A locked row reports the lease as busy (ADR 0105).
A lease lost to `stale` cancels the token and records the loss. The fence token then refuses every
later write from that handler.

#### `CancelReason` is on the context

_SM-1355 open detail: `CancelReason` on the context (ADR 0074)._

A `CancellationToken` carries no cause. `HandlerContext` therefore carries the cause next to the
token.

```csharp
public enum CancelReason { Requested, DeadlineExceeded, ExecutionTimeout, LeaseLost, Suspended, Shutdown }

public abstract class HandlerContext
{
    public CancellationToken CancellationToken { get; }
    public CancelReason? CancelReason { get; }   // set before the token is cancelled
    // the durable methods follow in the Durable context section
}
```

The worker sets `CancelReason` and then cancels the token. So a callback that the token runs always
reads a reason. The names and values match ADR 0074's `CancelReason`.

#### Shutdown

Shutdown follows the library model of ADR 0072.

1. A cancelled `stoppingToken` ends claiming.
2. In-flight handlers can finish within `ShutdownGrace`, default 25 s.
3. At that deadline the worker sets `CancelReason.Shutdown` and cancels the remaining tokens.
4. It gives those handlers one unwind window of 250 ms, as the JVM does.
5. It then stops renewing their leases, and `RunAsync` throws `ShutdownIncompleteException`.

The total stop time is `ShutdownGrace` plus the unwind window. It fits inside the host's default
`HostOptions.ShutdownTimeout` of 30 s. Every wait on the stop path has a deadline that comes from the
grace, as rule 8 of the ADR 0071 amendment requires.

`Worker` installs no signal handler. The Generic Host is the process entry point, as the Hosting
section states. A program without a host calls `RunAsync` with a token that it cancels itself.

### Queue surface

```csharp
public sealed class Queue
{
    public Queue(NpgsqlDataSource dataSource);
    public Queue(NpgsqlDataSource dataSource, QueueOptions options);   // default queue, JSON, logger
    public Queue Using(NpgsqlConnection connection);                   // the caller form
    public Task AssertCompatibleAsync(CancellationToken cancellationToken = default);

    public Task<EnqueueResult> EnqueueAsync<TPayload>(string taskType, TPayload payload,
        CancellationToken cancellationToken = default);
    public Task<EnqueueResult> EnqueueAsync<TPayload>(string taskType, TPayload payload,
        EnqueueOptions options, CancellationToken cancellationToken = default);
    public Task<IReadOnlyList<EnqueueResult>> EnqueueManyAsync(IEnumerable<EnqueueRequest> requests,
        CancellationToken cancellationToken = default);
    public Task<CancelResult> CancelAsync(Guid taskId, CancelOptions options,
        CancellationToken cancellationToken = default);
    public Task<SignalDeliveryResult> SendSignalAsync<TPayload>(Guid taskId, string name,
        TPayload payload, string idempotencyKey, string requestedBy,
        CancellationToken cancellationToken = default);
    public Task<HumanWaitCompletionResult> CompleteHumanWaitAsync<TResult>(Guid taskId, string name,
        TResult result, string idempotencyKey, string requestedBy,
        CancellationToken cancellationToken = default);
    public Task<QueueHealth> HealthAsync(CancellationToken cancellationToken = default);

    // Task groups, schedules, policies, budgets, and contracts: one method for each Ruby method,
    // for example CreateTaskGroupAsync, TaskGroupAsync, AddToTaskGroupAsync, SealTaskGroupAsync,
    // SyncSchedulesAsync, SyncConcurrencyPoliciesAsync, SyncRateLimitPoliciesAsync,
    // SyncBudgetsAsync, SyncContractsAsync, and the list methods.
}

public sealed record EnqueueResult
{
    public required Guid TaskId { get; init; }
    public required EnqueueOutcome Outcome { get; init; }
    public EnqueueNonReplaceableReason? Reason { get; init; }
}
```

Each method keeps the parameters of its Ruby and Java counterparts, with C# spelling and
nullability. A Ruby keyword with a default becomes a property of an options record with the same
default. Each result type keeps every field of its Ruby counterpart. `EnqueueOptions`,
`EnqueueRequest`, and `ChildRequest` carry the keywords of Ruby's `enqueue`. SM-1617 takes the exact
names from Ruby and Java and changes only the C# spelling. The `required` properties above exist at
the first publish. A property that a later minor adds is never `required`.

A list method with a filter takes an `IReadOnlyCollection<string>`, which is not nullable. An empty
collection reads every row. The JVM amendment of 2026-10-20 gives the same rule.

Payload contracts follow ADR 0039. The core validates a contract against the profile with its own
internal validator, as Ruby and Java do. It depends on no JSON Schema library. The profile excludes
`pattern` and `patternProperties`, so the validator rejects either keyword at any depth with the
profile's normal error. It never compiles a regular expression. The validator runs every case of
`protocol/v1/contracts.json`.

### Admin surface

`Admin` gives C# the operator capability at the ADR 0059 parity bar. That bar is the public SDK
operator table of `docs/parity.md`, not the TypeScript method list. The JVM amendment of 2026-10-22
gives the same rule.

```csharp
public sealed record AdminAudit
{
    public required string Actor { get; init; }
    public required string Reason { get; init; }
    public required string RequestId { get; init; }
}

public sealed class Admin
{
    public Admin(NpgsqlDataSource dataSource);
    public Admin(NpgsqlDataSource dataSource, AdminOptions options);
    public Admin Using(NpgsqlConnection connection);
    // One async method for each method of Java Admin, with C# spelling, for example
    // ListTasksAsync, GetTaskAsync, RedriveAsync, PauseQueueAsync, SetQueueTierAsync, and
    // SetQueueHistoryAsync. A read that can find nothing returns a nullable result.
}
```

Every control except `SetQueueHistoryAsync` takes an `AdminAudit`. `Admin` rejects a blank audit
field before it calls PostgreSQL. `SetQueueTierAsync` and `SetQueueHistoryAsync` follow SM-1417, as
the JVM amendment of 2026-10-22 lists them. `Admin` has no health method, because
`Queue.HealthAsync` reads the same snapshot.

### Embedded dashboard backend

_SM-1613 decision 9, and the SM-1355 open detail of the ASP.NET Core backend shape (ADR 0029)._

ADR 0029 requires every SDK to serve the dashboard from the host application's own HTTP server.
SM-1623 builds the .NET backend in `Workhorse.AspNetCore` after `Admin` lands.

```csharp
namespace Workhorse.AspNetCore;

public static class DashboardEndpointRouteBuilderExtensions
{
    public static IEndpointConventionBuilder MapWorkhorseDashboard(
        this IEndpointRouteBuilder endpoints, string pattern, DashboardOptions options);
}

public sealed class DashboardOptions
{
    public required NpgsqlDataSource DataSource { get; init; }
    public required Func<HttpContext, ValueTask<DashboardAuthorization>> Authorize { get; init; }
    public string Environment { get; init; }                  // default "development"
    public string AuditActor { get; init; }                   // default "dashboard"
    public bool ReadOnly { get; init; }
    public IReadOnlyList<string> BrowserModules { get; init; }
    public IReadOnlyList<string> ConfiguredWorkers { get; init; }
    public IReadOnlyDictionary<string, JsonElement> MaintenanceLoops { get; init; }
    public DashboardProcedure? EnqueueTest { get; init; }     // demo tools, off when unset
    public DashboardProcedure? SetSchedulePaused { get; init; }
    public IReadOnlyList<string> AllowedHosts { get; init; }
    public IReadOnlyDictionary<string, DashboardProcedure> Procedures { get; init; }
    public JsonSerializerOptions? Json { get; init; }
}

public abstract class DashboardAuthorization
{
    public static DashboardAuthorization Allow();
    public static DashboardAuthorization Deny();
    public static DashboardAuthorization Principal(string actor, IReadOnlyDictionary<string, object?>? claims);
    public static DashboardAuthorization Response(int status,
        IReadOnlyDictionary<string, string> headers, ReadOnlyMemory<byte> body);
}

public delegate ValueTask<object?> DashboardProcedure(JsonElement input, object? actor,
    CancellationToken cancellationToken);
```

`MapWorkhorseDashboard` maps one route group under `pattern`, with a catch-all route for the
browser application. A request outside the group goes to the host's other endpoints, because
endpoint routing matches only the group's routes. That is the ASP.NET Core counterpart of the
servlet filter's `chain.doFilter`. The backend reads `HttpRequest.PathBase`, so an application
mounted under a path base still works.

The returned `IEndpointConventionBuilder` lets the host add its own metadata, for example
`RequireAuthorization("operators")` or a rate limiter. `Authorize` still runs for each request,
because the four authorization results are the same in every SDK. The fourth result,
`Response`, follows the JVM amendment of 2026-10-18.

The options are Ruby's `Dashboard` options, with C# types. The backend uses `Admin` and `Queue`
where they have a method, and its generated `DashboardSqlCatalogue` otherwise, as the SQL section
states. It writes no SQL by hand. The `dashboard/v1` procedure bindings are generated
from `dashboard/v1/procedures.json` by `typescript/dashboard-server/spec/generate-bindings.ts`, with
a stale check. The package embeds the browser bundle as resources. A 503 body never holds a
database address (SM-1473). Payload redaction follows ADR 0035. The .NET cell becomes Supported
only when the backend passes every shared `dashboard/v1` HTTP fixture.

The backend is asynchronous throughout. Kestrel refuses synchronous I/O by default, and the backend
needs none.

#### The ECMA-262 pattern policy

_SM-1355 open detail: the ECMA-262 pattern policy for `System.Text.RegularExpressions`._

The `dashboard/v1` input schemas use JSON Schema `pattern`, which ECMA-262 defines. These schemas
are the only place where a .NET validator meets a regular expression. The set is closed.
`dashboard/v1/procedures.json` holds six distinct patterns on 2026-10-22, the same six that ADR 0103
lists. They use only anchors, character classes, `\d`, groups, alternation, and bounded quantifiers.

`System.Text.RegularExpressions` differs from ECMA-262 in two places that these patterns reach.

- Without `RegexOptions.Multiline`, .NET's `$` also matches before a final `\n`. So .NET accepts a
  UUID followed by `\n`, and ECMA-262 refuses it.
- .NET's `\d` matches every Unicode decimal digit, for example the Arabic-Indic digits. ECMA-262's
  `\d` matches only `0` to `9`.

The internal validator therefore compiles each pattern through a narrow translator.

1. The translator accepts the subset that the six patterns use: literals, escapes, character
   classes, `\d`, `^`, `$`, groups, non-capturing groups, alternation, and quantifiers.
2. It rewrites `^` to `\A` and `$` to `\z` outside a character class. It rewrites `\d` to `[0-9]`
   outside a class, and to `0-9` inside one.
3. It refuses every other construct, such as a lookaround, a backreference, `\s`, `\w`, `\b`, `.`,
   a property escape, or a flag, with `ArgumentException`.
4. It compiles the result with `RegexOptions.NonBacktracking | RegexOptions.CultureInvariant`. The
   non-backtracking engine runs in linear time and supports every construct of the subset.
5. A unit test compiles every `pattern` in the generated input schemas through the translator. It
   checks each pattern against vectors that differ only in a final line terminator or in a
   non-ASCII digit.

If a later `dashboard/v1` schema adds a construct outside the subset, step 5 fails in CI before any
release. The author then widens the translator for that construct, with its own vectors.

### Durable context

```csharp
public abstract class HandlerContext
{
    public ClaimedTask Task { get; }
    public CancellationToken CancellationToken { get; }
    public CancelReason? CancelReason { get; }

    public Task<TaskCheckpoint?> GetCheckpointAsync(string name);
    public Task<T> CheckpointAsync<T>(string name, Func<CancellationToken, Task<T>> operation);
    public Task<T> CheckpointAsync<T>(string name, CheckpointOptions options,
        Func<CancellationToken, Task<T>> operation);           // options carry the input
    public Task SleepAsync(string name, TimeSpan duration);
    public Task SleepUntilAsync(string name, DateTimeOffset time);
    public Task<T> WaitForSignalAsync<T>(string name, TimeSpan? timeout);
    public Task<T> WaitForHumanAsync<TContext, T>(string name, TContext context, TimeSpan? timeout);

    public Task<T> RunChildAsync<TPayload, T>(string name, string taskType, TPayload payload,
        EnqueueOptions options);
    public Task<IReadOnlyDictionary<string, ChildOutcome>> RunChildrenAsync(
        IReadOnlyList<ChildRequest> children);
    public Task<IReadOnlyDictionary<string, JsonElement>> RunChildrenAllAsync(
        IReadOnlyList<ChildRequest> children);

    public Task<TaskProgress?> GetProgressAsync();
    public Task<TaskProgress> SetProgressAsync<T>(T progress);

    public TaskGroupContext TaskGroup { get; }
}
```

A durable method takes no `CancellationToken`. Its statement uses the deadline token that the
Concurrency section describes, and the handler's own token reaches only the checkpoint operation.
A checkpoint stores and replays the JSON value `null`. `CheckpointOptions.Input` sets an input, and
a `null` input is the JSON value `null`. Only a call without options has no input.

SM-1620 takes the exact semantics and the timeout and option names from Ruby, Python, and Java. It
changes only the C# spelling. `TaskGroupContext` follows Ruby's `HandlerContext#task_group` and ADR 0095.

Checkpoint replay runs the operation only when no checkpoint of that name exists. Concurrent calls
that share one name share one in-flight request. `RunChildrenAsync` keys its outcomes by child name.
`BatchHandlerContext` has no suspending or child methods, as ADR 0030 requires. Each batch member
has its own context. A fast-tier member rejects `CheckpointAsync` and `SetProgressAsync` with
`FastTierUnsupportedException` before any write.

#### RFC 8785 canonical JSON

_SM-1355 open detail: RFC 8785 canonical JSON._

ADR 0098 stores the SHA-256 digest of the RFC 8785 canonical JSON of a checkpoint input. Every SDK
must give the same digest for the same input. The other six SDKs write the canonical form with their
own code and no dependency. The .NET core does the same in an internal class. The public entry point
is `Checkpoints.InputFingerprint<T>(T input, JsonSerializerOptions? options)`, the counterpart of
Ruby's `checkpoint_input_fingerprint`. It throws `ArgumentException` for an input that ADR 0098
refuses.

1. `JsonSerializer` encodes the input to JSON text with the caller's options. The core parses that
   text into its own tree. Two option sets that write the same JSON text give the same canonical
   form. An option that changes the text, such as a naming policy, changes the fingerprint, and a
   replay then reports an input conflict.
2. Object keys sort by UTF-16 code units. A .NET `string` is a sequence of UTF-16 code units, so
   `string.CompareOrdinal` gives that order directly.
3. A string escapes only the quote, the backslash, and the control characters, as
   `JSON.stringify` does. A lone surrogate refuses the input. Step 1 uses the string converter of
   the Values section, so the check runs before `System.Text.Json` can replace the surrogate.
4. An integer prints in decimal. A number of more than 2^53 - 1 in magnitude refuses the input, as
   ADR 0098 requires.
5. A fraction prints in the ECMAScript form of its IEEE 754 double. Since .NET Core 3.0,
   `double.ToString("R", CultureInfo.InvariantCulture)` gives the shortest digits that round-trip.
   The core takes those digits and the exponent, and writes them in the ECMAScript notation of
   `Number::toString`. The .NET notation alone is not enough: .NET writes `1E-07`, and ECMAScript
   writes `1e-7`.

The class runs the number vectors of RFC 8785 Appendix B and the shared fingerprint vectors that the
other SDKs run. A difference in one digest fails CI.

### Suspension

A durable wait that returns `scheduled`, or a child join that returns `created`, suspends the
handler. ADR 0030 defines suspension as releasing the lease and restarting the handler from entry on
resume.

.NET has no exception class that `catch (Exception)` does not catch. So the worker relies on a
flag, as the JVM does.

1. The context records a suspension flag.
2. It sets `CancelReason.Suspended` and cancels the token.
3. It throws an internal `SuspensionException`, which derives from `OperationCanceledException`.
   So `finally` blocks and `using` declarations run, and code that treats cancellation correctly
   does not log it as a failure.
4. After the handler returns or throws, the worker checks the flag. If the flag is set, the worker
   submits `suspended_for_wait` or `suspended_for_child`. It ignores the handler's result or
   exception.

A handler that catches the exception and returns still suspends. `SuspensionException` is internal
and is not part of the governed surface.

### Telemetry

_SM-1613 decision 8._

The core emits through `ActivitySource` and `Meter`, which are part of the runtime. Both use the
instrumentation name `workhorse`, the name that Python and the JVM use, and the SDK version. The
core has no OpenTelemetry package dependency.

- Without a listener, an `ActivitySource` creates no activity, and an instrument records nothing.
  So telemetry costs little when the application has no OpenTelemetry SDK.
- An application that uses OpenTelemetry calls `AddSource("workhorse")` and `AddMeter("workhorse")`.
- Each instrument kind of `api/telemetry.txt` has a runtime form: `Counter<T>`,
  `Histogram<T>`, `Gauge<T>`, and the observable gauge.
- The enqueue injects W3C trace context through `DistributedContextPropagator.Current`. The worker
  extracts it and starts its span with the enqueue as parent.

The worker and queue log through `ILogger` from `Microsoft.Extensions.Logging.Abstractions`, which
Npgsql already depends on. A caller without a logger factory gets `NullLoggerFactory`.

SM-1624 adds the tests in the form of the JVM amendment of 2026-10-18. They use `ActivityListener`
and `MeterListener` from the runtime, so the tests also need no OpenTelemetry package.

1. Each span, attribute, and instrument that the .NET SDK declares is in `api/telemetry.txt`, with
   the kind, unit, and description of the file.
2. Each span, attribute, and instrument that the listeners capture from an enqueue and a worker run
   against PostgreSQL is in the file.
3. The test holds a sorted list of the names in the file that the .NET SDK does not emit. Each name
   in the file is declared by the SDK or is on that list.

### Hosting and dependency injection

_SM-1613 decisions 4 and 5._

`Workhorse.Hosting` lets a Generic Host application use Workhorse with configuration and a few
calls.

```csharp
namespace Workhorse.Hosting;

public static class WorkhorseServiceCollectionExtensions
{
    // Queue and Admin singletons, options from the "Workhorse" configuration section.
    public static IServiceCollection AddWorkhorse(this IServiceCollection services,
        IConfiguration configuration);
    // The hosted worker. A process that does not call this method runs no worker.
    public static IServiceCollection AddWorkhorseWorker(this IServiceCollection services,
        Action<WorkerHandlers> configure);
    public static IServiceCollection AddWorkhorseHandler<THandler, TPayload>(
        this IServiceCollection services) where THandler : class, ITaskHandler<TPayload>;
    public static IHealthChecksBuilder AddWorkhorse(this IHealthChecksBuilder builder);
}
```

- **Data source.** The package resolves an `NpgsqlDataSource` from the container, for example one
  that `AddNpgsqlDataSource` registered. `Workhorse:DataSourceKey` selects a keyed data source.
  The package depends on no Npgsql integration package.
- **Options.** `AddWorkhorse` binds `QueueOptions`, `AdminOptions`, and `WorkerOptions` from the
  `Workhorse` section, for example `Workhorse:Worker:Concurrency`. Each key has the default of the
  core options. SM-1626 records each key, its type, and its default in `api/dotnet.txt`.
- **Handlers.** A handler is a service that implements `ITaskHandler<TPayload>`. For each attempt,
  the worker creates an `AsyncServiceScope`, resolves the handler in it, and disposes the scope
  after the settlement. So a handler can take a scoped `DbContext`.
- **Lifecycle.** `AddWorkhorseWorker` registers a `BackgroundService` whose `ExecuteAsync` calls
  `Worker.RunAsync(stoppingToken)`. At startup it logs one warning if
  `HostOptions.ShutdownTimeout` is less than `ShutdownGrace` plus the unwind window.
- **Faults.** If `RunAsync` throws, the service logs the error, sets `Environment.ExitCode` to 1,
  and throws again. `BackgroundServiceExceptionBehavior.StopHost` then stops the host, and the
  process exits with a failure status, as Ruby's `run_worker_process` exits 1.
- **Health.** The `workhorse` health check runs the compatibility query. It reports `Unhealthy`
  when the database is unavailable or the schema is not compatible. When the process runs a worker,
  it also reports `Unhealthy` after the worker stopped without a stop request or abandoned a
  handler.

The process entry point of .NET is the Generic Host with this package. The host's
`ConsoleLifetime` handles `SIGINT`, `SIGQUIT`, and `SIGTERM`, and stops the hosted worker, which
drains. So the core has no process helper. SM-1628 adds the .NET row to the process entry points
table of `docs/guides/310-workers.md`.

#### The worker is an explicit registration

The JVM starter turns its worker off by default, because Spring auto-configuration acts on the class
path. A Generic Host does nothing that the code does not register. So `AddWorkhorseWorker` is the
user decision, and no configuration switch repeats it. A web replica that does not call
`AddWorkhorseWorker` runs no worker, whatever handlers it registers. If handlers are registered and
no worker is, `AddWorkhorse` logs one warning at startup.

#### The amendment to ADR 0021

ADR 0021 says that Workhorse publishes no framework integration packages, and that workers run in
dedicated processes. ADR 0103 amended it for one Spring Boot starter and said that another
framework adapter needs its own decision record. This record is that decision for three packages:
`Workhorse.Hosting`, `Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`. Three limits keep
ADR 0021's reason.

- These are the only .NET framework packages. Another adapter, for example for Aspire, needs its
  own decision record.
- A worker runs only in a process that calls `AddWorkhorseWorker`.
- The dedicated worker process stays the default topology, as ADR 0012 decided.

ADR 0021 stays in force for every other language and framework.

### EF Core

_SM-1613 decision 5._

`Workhorse.EntityFrameworkCore` lets an enqueue join a `DbContext` transaction, as ADR 0070's
accessor does for SQLAlchemy.

```csharp
namespace Workhorse.EntityFrameworkCore;

public static class WorkhorseDatabaseFacadeExtensions
{
    public static NpgsqlConnection GetWorkhorseConnection(this DatabaseFacade database);
}
```

`GetWorkhorseConnection` returns `database.GetDbConnection()` as an `NpgsqlConnection`. It throws
`InvalidOperationException` if the provider is not Npgsql, or if the connection is not open. A
`DbContext` with a current transaction always has an open connection.

```csharp
await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
db.Orders.Add(order);
await db.SaveChangesAsync(cancellationToken);
await queue.Using(db.Database.GetWorkhorseConnection())
    .EnqueueAsync("send-receipt", new { order.Id }, cancellationToken);
await transaction.CommitAsync(cancellationToken);
```

Npgsql runs the enqueue inside the transaction that EF Core opened. So the task commits and rolls
back with the order. SM-1622 adds an integration test that proves the task is invisible before the
commit, visible after it, and absent after a rollback.

### Governed surface and release

_SM-1613 decisions 7 and 10, and the SM-1355 open detail of the NuGet release stage._

SM-1626 records one surface, the C# API, in `api/dotnet.txt`.

- One section for each package lists every public and protected type and member of the package,
  sorted. Each line shows nullability, `required`, `init`, `sealed`, `abstract`, `static`, generic
  constraints, and default parameter values.
- A last section lists each `Workhorse:*` configuration key of `Workhorse.Hosting` with its type
  and default.

A repository-owned tool under `dotnet/tools/` writes the file from the built assemblies with
`System.Reflection.Metadata`. `pnpm dotnet-api:generate` runs it. `pnpm dotnet-api:check` runs in
the CI `required` job and in `pnpm check`, and fails on any drift. A gone line is a removal, a
rename, or a narrowing, and the failure labels it breaking.

`EnablePackageValidation` is on in every package. Before the first publish, it checks that each
package is consistent with its own target framework. After the first publish, the release stage
sets `PackageValidationBaselineVersion` to the previous published version. Package validation then
compares the packed package with that version and fails on a breaking change. It runs in the
release stage and not in `pnpm check`, because it downloads the baseline package from nuget.org. The
committed snapshot stays the Gate 1 check.

SM-1629 prepares a NuGet stage in `.github/workflows/release.yml`. The first publish waits for
SM-1441.

1. `dotnet pack` writes the four packages with the train version, a README, the license expression
   `Apache-2.0`, SourceLink, a deterministic build, and a symbol package.
2. A repository script checks that each package version equals the train version, as ADR 0106
   requires. A difference fails the stage.
3. Package validation runs against the previous published version.
4. A release consumer restores the packed packages from a local feed and runs a task end to end.
5. The `nuget` job runs in the protected `nuget` environment, with a required reviewer. It gets a
   one-hour key from `NuGet/login@v1` through trusted publishing, and runs `dotnet nuget push`
   with `--skip-duplicate`.

nuget.org never deletes a published version. It can only unlist one. The environment reviewer is
therefore the human check before a version becomes permanent. nuget.org signs each package with its
repository signature, so the stage adds no author signature.

The SDK reports its version from one place. `Directory.Build.props` sets the train version, and
`IncludeSourceRevisionInInformationalVersion` is `false`, so the informational version holds no
commit suffix. One internal class reads `AssemblyInformationalVersionAttribute`. The worker
registers `sdk_language` `csharp` and that version, and the dashboard and the telemetry read the
same class. SM-1627 adds the test.

### The parity column

_SM-1613 decision 9, and the SM-1355 open detail of the parity column name._

`docs/parity.md` gains one column named `.NET`. Its cells describe the `Workhorse` package, which
every hosting, EF Core, and ASP.NET Core caller uses. A cell reads Supported only with executed
evidence. At 1.0.0 every product cell in the column reads Supported, including the embedded
dashboard backend row. A short note under the worker table states that `Workhorse.Hosting` reaches
every Client and Worker cell through the services it registers.

### Scope and line budget

The budgets are estimates, not limits.

| Path under `dotnet/`                                           | Owner   | Contents                                                  |
| -------------------------------------------------------------- | ------- | --------------------------------------------------------- |
| `Workhorse.slnx`, `Directory.*.props`, each project file       | SM-1616 | build, toolchain checks, and the CI lane                  |
| `src/Workhorse/Internal/SqlCatalogue.g.cs`                     | SM-1616 | generated, outside the budget                             |
| `src/Workhorse/` client, errors, values, and contracts         | SM-1617 | `Queue`, the exception set, JSON rules, and the validator |
| `src/Workhorse/` worker, heartbeat, and listener               | SM-1618 | run loop, leases, listener, and drain                     |
| `src/Workhorse/` `Admin` and its page types                    | SM-1619 | the operator client                                       |
| `src/Workhorse/` `HandlerContext` and suspension               | SM-1620 | durable context and the RFC 8785 fingerprint              |
| `src/Workhorse/` batch and fast tier                           | SM-1621 | fast tier, slot cohorts, and batch delivery               |
| `src/Workhorse.Hosting/`, `src/Workhorse.EntityFrameworkCore/` | SM-1622 | dependency injection, hosted worker, health, and EF Core  |
| `src/Workhorse.AspNetCore/`                                    | SM-1623 | the backend, its generated catalogue, and the translator  |
| `src/Workhorse/Internal/Telemetry/`                            | SM-1624 | activities, instruments, and trace context                |

The core budget is 10,000 to 14,000 lines in `src/Workhorse`, excluding the generated catalogue and
tests. C# needs fewer lines than Java for records and options, so the budget is below the JVM's.
`Workhorse.AspNetCore` adds about 2,000 lines. `Workhorse.Hosting` and
`Workhorse.EntityFrameworkCore` take about 600 to 1,000 lines together.

The other SM-1613 children are these.

- SM-1615: the ADR 0056 amendment with the changed gates.
- SM-1625: the conformance lane over `protocol/v1` and the `.NET` parity column.
- SM-1626: `api/dotnet.txt`, its check, and package validation. It also changes the count of
  governed surfaces in `CONTEXT.md` to twelve.
- SM-1627: the floors in `support.json` and `docs/compatibility.md`, the registry version, and the
  dependency scan.
- SM-1628: the README, the guides, the architecture pages, the site, and the C# examples.
- SM-1629: the release stage of the section above.
- SM-1630: the .NET demo worker.
- SM-1441: the maintainer checklist for the nuget.org organization, the prefix, and trusted
  publishing.

The benchmark gate in the private operations repository is a separate maintainer item. This record
sets no throughput bar.

## Amendments to the 1.0.0 decisions

ADR 0103 added the Java and Kotlin APIs as the tenth and the eleventh surfaces. This section adds
the C# API as the twelfth. It amends ADR 0054 and ADR 0059. SM-1615 amends ADR 0056: Gate 1 gains
`dotnet-api:check`, Gate 2 takes its changed form, Gate 3's cold install covers .NET, and Gate 6
needs the `.NET` column. This record does not restate those gates.

### The C# API is the twelfth governed surface

**12. The C# API.** A breaking change makes caller code that ran against the previous release fail
to compile, fail to bind, or behave differently. The surface has two parts.

- Every public and protected type and member of `Workhorse`, `Workhorse.Hosting`,
  `Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`, with its signature, nullability, and
  default values.
- Every `Workhorse:*` configuration key, with its type and default.

A type is internal when it is not public, as `SqlCatalogue`, `SuspensionException`, the contract
validator, the pattern translator, the canonical JSON writer, and the heartbeat and listener are.

Removing or renaming a type, a member, or a key is breaking. So is narrowing a signature. Examples
are a changed parameter type, a new parameter, a new `required` property, and a new abstract member
on an interface that callers implement. Adding a type, a method, an overload, an `init` property,
an enum member, a derived class of a closed result family, an interface member with a default
implementation, or a key is not breaking. The version string is not part of the promise.

ADR 0059 therefore assembles the specification from twelve surfaces.

### The .NET packages ride the train

The four packages join the one 1.0.0 release train of ADR 0054. They publish from the same source
commit as the other language lines, and ADR 0106 keeps them in lockstep after 1.0.0. The four
packages always share one version.

## Consequences

### Positive

- A .NET application enqueues in its own transaction, through an `NpgsqlConnection` or an EF Core
  `DbContext`.
- A C# worker processes tasks that any other SDK enqueues, and the reverse, because the protocol is
  the contract.
- A .NET worker wakes on `LISTEN`/`NOTIFY` instead of a poll interval.
- The core needs only Npgsql, and its telemetry needs no OpenTelemetry package.
- A Generic Host application needs a few calls and a configuration section. A replica runs no worker
  unless its code registers one.
- Every public type follows the growth rules from the first publish. So the record and optional
  parameter problems of the JVM do not occur.

### Negative

- Four packages need four release checks, one snapshot, and package validation.
- nuget.org can refuse the `Workhorse.*` reservation. Without a reservation, another publisher can
  take an unclaimed ID such as `Workhorse.Redis`. Two measures reduce this risk. The first release
  publishes all four IDs together. The docs list only those four IDs.
- 1.0.0 does not support trimming or Native AOT.
- Multiplexing data sources are refused, so an application that uses multiplexing needs a second,
  ordinary data source for Workhorse.
- A synchronous, blocking handler can starve the thread pool. The heartbeat is safe on its own
  thread, but dispatch and other handlers slow down. The guide tells a blocking handler to await.
- At the drain deadline, the worker cannot stop a handler that ignores its token. It abandons the
  handler, and the lease expires.
- The pattern translator accepts only the subset that `dashboard/v1` uses today. A new construct in
  that contract needs a translator change.
- `CONTEXT.md` names eleven governed surfaces. SM-1626 must change it to twelve when it lands the
  check.

## Rejected alternatives

### Package IDs and namespaces

- **`Stablemates.Workhorse` and the prefix `Stablemates.*`.** SM-1355 named it as a candidate. The
  project keeps one identity, `workhorse.run`, as SM-1455 decided for the JVM.
- **The prefix `WorkhorseRun.*` as the fallback.** It is less common, so nuget.org is more likely to
  reserve it. But every ID and every install command would change for a verified mark only.
- **Extension methods in `Microsoft.Extensions.DependencyInjection`.** Many libraries do this for
  discovery. But the snapshot would then cover a namespace that Workhorse does not own.

### Packages

- **One package with everything.** A worker would take ASP.NET Core and EF Core. NuGet has no
  optional features, as Cargo has.
- **A separate health check package.** Its abstractions follow the runtime line, as the hosting
  abstractions do, so a separate package adds a release check for no caller.
- **Exact version pins between the packages.** An exact pin makes NuGet report a downgrade or a
  conflict when another dependency asks for a newer core. The satellites use only the public API of
  the core, so a minimum version is safe.
- **`InternalsVisibleTo` between shipped assemblies.** A mixed set of versions could then break an
  internal contract that no snapshot governs.

### Floors and build

- **A floor of .NET 8.** .NET 8 reaches end of support on 2026-11-10, before the first publish.
- **Multi-targeting `net10.0` and `net11.0`.** A `net10.0` assembly runs on .NET 11. A second target
  doubles the build and the snapshot inputs for no API difference.
- **An Npgsql floor of 10.0.0.** NuGet resolves the lowest version of a range, so callers would get
  10.0.0 by default. The floor lane would then test a release without the 10.0.x fixes.
- **A `global.json`.** It pins the SDK a second time. `mise.toml` owns every tool pin.

### Connection model

- **Overload pairs with an `NpgsqlConnection` first, as the JVM has.** They double every method of
  `Queue` and `Admin`. `Using` gives the same behavior with one method.
- **`DbConnection` instead of `NpgsqlConnection`.** The SDK runs only on Npgsql, so a provider-neutral
  type would accept connections that fail at the first call.
- **Ambient `TransactionScope` as the transaction seam.** The async flow needs an opt-in option, and
  the commit is synchronous. An explicit connection is clear.
- **Multiplexing on by default.** Its limits for `LISTEN`, reserved connections, and caller
  transactions are not verified.
- **`Keepalive` in the caller's connection string.** It changes every pooled connection of the
  caller. A second data source from the connection string would also lose the password, which
  Npgsql removes from `ConnectionString`.
- **`DateTime` in public signatures.** Its `Kind` can be `Local` or `Unspecified`, which Npgsql
  refuses for `timestamptz`.

### Worker

- **An asynchronous heartbeat on the thread pool.** Thread pool starvation from blocking handlers
  could delay a lease renewal past the lease.
- **A custom `TaskScheduler` for handlers.** It changes how `await` continues in handler code, and
  it adds a scheduler that the SDK must keep correct.
- **Ending the run for some handler exceptions.** .NET has no exception class that marks a fault a
  program must not catch, as Java's `Error` does.
- **A process helper in the core.** The Generic Host already handles signals and drains hosted
  services. A second entry point would duplicate it.
- **A worker switch in configuration, default off, as the JVM starter has.** A Generic Host runs only
  the services that code registers, so `AddWorkhorseWorker` is already the explicit decision.
- **A builder for `Worker`, as the JVM has.** C# has object initializers and options classes, and
  the configuration binder needs settable properties.

### Values

- **A codec interface, as the JVM has.** `System.Text.Json` is in the runtime, so no dependency
  conflict exists. `JsonSerializerOptions` already lets a caller change the conversion.
- **`JsonSerializerDefaults.General`.** It writes PascalCase names, which the JSON of the other SDKs
  does not use.
- **Positional records for results.** A new component changes the constructor and `Deconstruct`,
  which SM-1516 found for Java.
- **A JSON Schema library for contracts.** The profile is small, and every SDK validates it with its
  own code since ADR 0039.

### Dashboard

- **Middleware, `UseWorkhorseDashboard`.** Middleware runs outside endpoint routing, so the host
  cannot add authorization or rate-limit metadata to it.
- **MVC controllers.** They need `AddControllers` and application parts in the host, and they add
  nothing to the procedure bindings.
- **A separate Kestrel port.** The dashboard would not run on the host application's own server,
  which ADR 0029 requires.
- **ASP.NET Core authorization policies instead of `Authorize`.** The four authorization results are
  the same in every SDK. The returned endpoint builder still lets the host add a policy.

### Patterns

- **`System.Text.RegularExpressions` without translation.** `$` would accept a final line
  terminator, and `\d` would accept non-ASCII digits.
- **`RegexOptions.ECMAScript`.** It makes `\d` ASCII, but it does not change `$`. It also cannot
  combine with `RegexOptions.NonBacktracking`, so it excludes the linear-time engine.
- **A port of Ruby's full ECMA-262 translator.** The six patterns use none of the constructs that it
  exists for.

### Canonical JSON

- **A third-party RFC 8785 library.** It adds a dependency for about 200 lines that every other SDK
  writes itself.
- **`JsonSerializer` output with sorted keys.** .NET number notation differs from ECMAScript, and
  the default encoder escapes characters that RFC 8785 leaves as they are.

### Telemetry

- **The OpenTelemetry API package as a dependency.** The runtime already has `ActivitySource` and
  `Meter`, and the OpenTelemetry .NET SDK listens to them.
- **`EventSource` for logs.** `ILogger` is the standard logging API, and Npgsql already brings its
  abstractions.

### Release

- **Package validation as the Gate 1 check.** It needs a published baseline and a download. A
  committed snapshot needs neither, as ADR 0084 found for Ruby.
- **An author signing certificate.** nuget.org signs every package, and a certificate adds a secret
  and a renewal date.
- **An API key in a repository secret.** Trusted publishing gives a one-hour key and stores no key.

### Parity column

- **A column named `C#`.** The packages are .NET packages, and an F# caller uses the same cells.
  `.NET` matches the platform name, as `JVM` does.
- **Columns for each package.** Every hosting, EF Core, and ASP.NET Core cell follows from the core.

## Amendment: `Admin` takes no serializer options (2026-10-22)

The Values and durations section says that each `Queue`, `Admin`, and `Worker` takes a
`JsonSerializerOptions` through its options. SM-1619 found that `Admin` serializes no caller type.
It writes only its own filter documents, and it returns each JSON value as a `JsonElement`. These
values are payloads, results, errors, checkpoints, progress, wait contexts, and event details.
Java and Ruby `Admin` also take no codec.

This amendment changes the rule for `Admin`:

1. `AdminOptions` is a `sealed record` with no property. It exists so that a later setting is
   additive.
2. `Admin` keeps both constructors, `new Admin(NpgsqlDataSource)` and
   `new Admin(NpgsqlDataSource, AdminOptions)`.
3. `Admin` returns each JSON value as a `JsonElement`. SQL `NULL` is `null`, and JSON `null` is an
   element of kind `JsonValueKind.Null`.

`Queue` and `Worker` keep the rule of the Values and durations section.
