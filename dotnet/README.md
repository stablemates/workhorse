# Workhorse for .NET

The .NET SDK of the Workhorse durable task queue for PostgreSQL. The C# core has a queue client, an
operator client, a worker runtime, and a durable handler context. Three more packages add Generic
Host integration, EF Core transactions, and an ASP.NET Core dashboard backend.

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="https://workhorse.run/diagrams/readme-overview-narrow-dark.png">
  <source media="(max-width: 600px)" srcset="https://workhorse.run/diagrams/readme-overview-narrow-light.png">
  <source media="(prefers-color-scheme: dark)" srcset="https://workhorse.run/diagrams/readme-overview-dark.png">
  <img src="https://workhorse.run/diagrams/readme-overview-light.png" width="960" alt="One protocol for your workers and your dashboard">
</picture>

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the
> [changelog](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md) before you upgrade.
> It does not ask you to recreate your database. Migrations are ordered, and inside a major line a
> migration only adds. Thus a running deployment upgrades in place.

An AI agent should read [the Workhorse documentation index](https://workhorse.run/llms.txt) first.

## Install

The .NET SDK has four NuGet packages. All four use one version.

| Package ID                      | Use it for                                                             |
| ------------------------------- | ---------------------------------------------------------------------- |
| `Workhorse`                     | The queue client, `Admin`, the worker, and the durable handler context |
| `Workhorse.Hosting`             | Dependency injection, configuration, the hosted worker, and health     |
| `Workhorse.EntityFrameworkCore` | An enqueue in the transaction of a `DbContext`                         |
| `Workhorse.AspNetCore`          | The embedded dashboard backend, mapped as ASP.NET Core endpoints       |

NuGet does not serve these packages yet. This page gives no install command to copy.
[Compatibility](https://workhorse.run/docs/compatibility) states the supported .NET, Npgsql,
EF Core, and ASP.NET Core versions.

Install the schema once, as a deployment step. The application never installs or migrates it.

```bash
npx --package @stablemates/workhorse@0.9.0 workhorse schema install
```

The machine that runs that deployment step needs Node.js 22 or newer. The application itself needs
no Node.js.

Pin that version to the .NET package version the application depends on. The two come from one
commit of this repository, so the numbers match. The application refuses a schema below its schema
floor, the oldest schema version it runs against. A schema at or above the floor is compatible
while it still serves the application's protocol.

Runtime processes verify compatibility instead of changing the schema. Call
`Queue.AssertCompatibleAsync()` or `Admin.AssertCompatibleAsync()` at startup. A refusal is a
`CompatibilityException`, whose `Code` names the reason.

Requires .NET 10 or newer and PostgreSQL 15 through 18.

Each package targets `net10.0`, and CI also runs it on .NET 11. The core needs Npgsql 10.0.3 or
newer. `Workhorse.Hosting` needs the `Microsoft.Extensions.*` packages 10.0.0 or newer.
`Workhorse.EntityFrameworkCore` needs EF Core 10.0.0 or newer. `Workhorse.AspNetCore` needs
ASP.NET Core 10 or newer.

## Run one task

This C# code enqueues one task and runs it with `Worker.RunOnceAsync()`. `Workhorse.Examples.Tests`
runs it against PostgreSQL.

```csharp
var queue = new Queue(dataSource, new QueueOptions { DefaultQueue = "readme" });
var enqueued = await queue.EnqueueAsync("readme.echo", new { packaged = true });

await using var worker = new Worker(
    dataSource,
    new WorkerOptions { Queues = ["readme"], DisableRegistry = true });
worker.Handle(
    "readme.echo",
    (HandlerContext context, JsonElement payload) => Task.FromResult(new { echo = payload }));
if (!await worker.RunOnceAsync())
{
    throw new InvalidOperationException("the worker ran no handler");
}
```

`dataSource` is an `NpgsqlDataSource`. The default JSON options write camelCase names, so the
payload is `{"packaged": true}`. Handlers receive at-least-once delivery. Use stable provider
idempotency keys around external effects.

## Run a worker in a Generic Host

In production, run the worker in a Generic Host. The host stops on `SIGINT`, `SIGQUIT`, or
`SIGTERM`, and the worker then drains. This program reads its settings from the `Workhorse`
configuration section, for example `Workhorse:Worker:Concurrency`.

```csharp
var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddSingleton(dataSource);
builder.Services.AddWorkhorse(builder.Configuration);
builder.Services.AddWorkhorseWorker(handlers => handlers.Handle(
    "readme.echo",
    (HandlerContext context, JsonElement payload) => Task.FromResult(new { echo = payload })));
await builder.Build().RunAsync(stoppingToken);
```

`AddWorkhorse` registers `Queue` and `Admin` on the `NpgsqlDataSource` of the container. A process
that does not call `AddWorkhorseWorker` runs no worker, so a web replica can enqueue without
claiming. `AddWorkhorseHandler<THandler, TPayload>()` registers an `ITaskHandler<TPayload>` class,
which the worker resolves in a new scope for each attempt. Keep `HostOptions.ShutdownTimeout` above
`Workhorse:Worker:ShutdownGrace` plus 250 milliseconds. The defaults, 30 seconds and 25 seconds,
already do that.

## Enqueue in an EF Core transaction

`Workhorse.EntityFrameworkCore` adds `GetWorkhorseConnection()` to `DatabaseFacade`. Begin a
transaction on the `DbContext`, save your rows, and then call
`queue.Using(db.Database.GetWorkhorseConnection()).EnqueueAsync(...)`. The task commits and rolls
back with your rows. The SDK never commits, rolls back, or closes a connection that you give it.

## Examples

`dotnet/examples/Workhorse.Examples/` holds each C# snippet of the documentation. Its tests in
`dotnet/examples/Workhorse.Examples.Tests/` run every snippet against PostgreSQL. It is not a
package and is never published.

`dotnet/examples/Workhorse.Examples.Programs/` holds the scenario programs that the other SDKs also
have. The first argument selects the program: `quickstart`, `transaction`, `dedicated-worker`,
`orchestration`, or `agentic-flow`. Each program reads a PostgreSQL URL from
`WORKHORSE_DATABASE_URL`. It is not a package and is never published.

## Package boundary

- `Queue` enqueues, cancels, signals, completes human waits, creates task groups, and synchronizes
  schedules, policies, budgets, and contracts. It takes an `NpgsqlDataSource`. The source form opens
  a connection for each call. `queue.Using(connection)` returns the caller form, which runs in your
  open transaction, so the enqueue becomes part of your commit.
- `Worker` takes an `NpgsqlDataSource` and `WorkerOptions`, registers handlers by task type, and runs
  each handler on the .NET thread pool under a lease. `RunAsync(stoppingToken)` drains when the
  token is cancelled.
- `HandlerContext` offers checkpoints, durable sleeps, signal and human waits, child tasks, task
  groups, and progress. PostgreSQL owns every durable decision, and an unresolved wait suspends the
  task.
- `Admin` lists, inspects, and repairs tasks, dead letters, waits, workers, queues, and task groups.
- `MapWorkhorseDashboard` in `Workhorse.AspNetCore` serves the dashboard under its own path in your
  ASP.NET Core application.
- Payloads and results go through `System.Text.Json`. The default options are
  `JsonSerializerDefaults.Web` with strict number handling.
- The SDK emits spans and metrics through `ActivitySource` and `Meter`, both named `workhorse`. An
  OpenTelemetry SDK in the application can listen to them. Without a listener, telemetry does
  nothing.

Each Workhorse exception derives from `WorkhorseException`. An invalid argument throws
`ArgumentException`. The SDK never installs or migrates the shared PostgreSQL schema.

## Next

- Follow the [quickstart](https://workhorse.run/docs/quickstart) and deploy
  [worker processes](https://workhorse.run/docs/worker-processes).
- Enqueue in your own transaction with [transactional enqueue](https://workhorse.run/docs/enqueue).
- Read the [compatibility policy](https://workhorse.run/docs/compatibility).
