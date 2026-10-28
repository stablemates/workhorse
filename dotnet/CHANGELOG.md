# .NET changelog

The versions and release notes of the four .NET packages live here: `Workhorse`,
`Workhorse.Hosting`, `Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`. The four packages
always carry one version. It is the version that the other SDKs carry, because every release tag
names one commit.

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

### The dashboard bundle uses Mantine 9.7.4

`Workhorse.AspNetCore` serves the shared dashboard browser bundle. After 0.10.0, a dependency update
moved the dashboard to Mantine 9.7.4 and rebuilt that bundle (SM-1839). The `Workhorse.AspNetCore`
package now carries the rebuilt `read-surface-1.tar.gz`. Its `bundle.json` records the sha256
`a7d61ed1d0433e38a8d227cbcc8f98a0bf668f2d3bb1d47391b1882fd69bf795`.

The `dashboard/v1` procedures and the read surface version do not change (SM-1858).

### The dashboard page tells each cache not to store it

The dashboard page holds `window.workhorseDashboard`, which contains the `auditActor` of the
operator. Before this change, the `Workhorse.AspNetCore` dashboard backend sent the page with only
`Content-Type`. A shared cache in front of the application could store the page by heuristic. A
later visitor could then get the stored page and see the actor name of an earlier operator. A
browser could also show the page from its cache after logout (SM-1870).

Now the `Workhorse.AspNetCore` dashboard backend sends the page with `Cache-Control: no-store`, as
the TypeScript host does. Each asset keeps `Cache-Control: public, max-age=31536000, immutable`.

### An idempotency TTL that rounds to 0 ms is refused

The queue rounds `Idempotency.Ttl` to the nearest millisecond. Before this change, a positive
`TimeSpan` below 0.5 ms rounded to 0, and the queue kept the key for the default one day without a
warning (SM-1857).

Now the queue throws `ArgumentException` for a nonzero `TimeSpan` that rounds to 0 ms.
`TimeSpan.Zero` still selects the default. ADR 0115 records the rule for all seven SDKs.

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

## 0.10.0 — 2026-10-26

### The first publish of the .NET SDK

This is the first release of the .NET SDK on nuget.org. The npm packages, Python distribution, Go
module, Rust crate, Ruby gem, JVM artifacts, and .NET packages release from one source commit.

Requires **schema v76**, .NET **10** or newer, and PostgreSQL **15** or newer.

- The .NET SDK needs schema version 76 or later. The SDK compatibility floor is schema version
  **76**. Install or migrate the schema with the `workhorse` CLI as a deployment step, before the
  application starts. The application never installs or migrates the schema.
- The SDK has four packages. All four use one version ([ADR
  0107](../docs/decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)):
  - `Workhorse`: the queue client, `Admin`, the worker, and the durable handler context.
  - `Workhorse.Hosting`: dependency injection, options, the hosted worker, and health checks for
    the Generic Host.
  - `Workhorse.EntityFrameworkCore`: an enqueue in the transaction of an EF Core `DbContext`.
  - `Workhorse.AspNetCore`: the embedded dashboard backend, mapped as ASP.NET Core endpoints.
- Each package other than `Workhorse` depends on `Workhorse` at the same version. Use the same
  version for each package that you add.
- Every package targets `net10.0`, and a .NET 11 application runs it without a second target. Every
  package needs Npgsql 10.0.3 or later. `Workhorse` and `Workhorse.Hosting` need
  `Microsoft.Extensions.*` 10.0.0 or later. `Workhorse.EntityFrameworkCore` needs EF Core
  Relational 10.0.0 or later. `Workhorse.AspNetCore` uses the ASP.NET Core shared framework of the
  installed runtime. [Supported versions](../docs/compatibility.md#supported-versions) states each
  floor and its end-of-life date.
- nuget.org signs each package. Each package has a symbol package with SourceLink to the commit of
  the release.
