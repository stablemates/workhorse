# .NET changelog

The versions and release notes of the four .NET packages live here: `Workhorse`,
`Workhorse.Hosting`, `Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`. The four packages
always carry one version. It is the version that the other SDKs carry, because every release tag
names one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## Unreleased

### The dashboard bundle uses Mantine 9.7.4

`Workhorse.AspNetCore` serves the shared dashboard browser bundle. After 0.10.0, a dependency update
moved the dashboard to Mantine 9.7.4 and rebuilt that bundle (SM-1839). The `Workhorse.AspNetCore`
package now carries the rebuilt `read-surface-1.tar.gz`. Its `bundle.json` records the sha256
`f234a7d60a362c841becc2522ff8dd750958136873ccda90461c26f45f9ba7d1`.

The `dashboard/v1` procedures and the read surface version do not change (SM-1858).

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
