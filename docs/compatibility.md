# Compatibility and support boundary

This is the supported-version contract for the published Workhorse packages. `support.json` owns
the repository matrix, each listed version's upstream end-of-life date, and local toolchain
versions. `typescript/core/src/support.ts` exposes the Node.js and PostgreSQL claims to published
packages. `.github/workflows/ci.yml` runs the matrix, and
`typescript/core/test/support-matrix.test.ts` fails when machine-readable consumers drift or a
listed version outlives its recorded date.

## What "supported" means

A version is supported when the weekly CI run exercises every declared combination. Pull requests
and pushes exercise the newest language and PostgreSQL versions for fast feedback. In particular:

- **Supported.** In the CI matrix below. A regression on one of these is a release blocker.
- **Expected to work, untested.** A PostgreSQL major newer than the tested set. Workhorse does not
  refuse to run on it, because a release cannot know about a database released after it. Bugs are
  accepted, but nothing here is evidence that it works.
- **Unsupported.** Below the minimum. `installSchema` refuses these outright rather than failing
  part way through `sql/schema.sql`, and `workhorse schema status --json` reports the server
  version and support level separately from schema compatibility.

This boundary is about correctness only. It is not a performance claim; see
[Benchmark validation is not the support boundary](#benchmark-validation-is-not-the-support-boundary).

## Supported versions

| Runtime      | Supported         | Minimum | End of life                                                    | Notes                                                                                           |
| ------------ | ----------------- | ------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node.js      | 22, 24            | 22      | 22: 2027-04-30, 24: 2028-04-30                                 | Even-numbered releases only. `engines.node` is `>=22`.                                          |
| Python       | 3.12–3.14         | 3.12    | 3.12: 2028-10, 3.13: 2029-10, 3.14: 2030-10                    | `stablemates-workhorse` ships one `py3-none-any` wheel.                                         |
| Go           | 1.25 and newer    | 1.25    | No date; Go supports its two most recent releases              | pgx v5.11.0 is the minimum and the tested version.                                              |
| Rust         | 1.89 and newer    | 1.89    | No date; Rust supports only its latest stable release          | Tokio with `tokio-postgres` 0.7 and `deadpool-postgres`.                                        |
| Ruby         | 3.3, 3.4, 4.0     | 3.3     | 3.3: 2027-03-31, 3.4: not announced, 4.0: not announced        | `pg` 1.6 alone, behind `connection_pool`, or Active Record.                                     |
| Active Job   | 8.0, 8.1          | 8.0     | 8.0: 2026-11-07, 8.1: 2027-10-10                               | The Rails adapter. Rails dates are the end of security support.                                 |
| Java         | 21, 25, 27        | 21      | 21: 2029-12, 25: 2031-09, 27: 2027-03                          | Every JVM module compiles with `--release 21`. The dates are Temurin support.                   |
| Kotlin       | 2.2 and newer     | 2.2     | No date; the Kotlin compiler drops a language version          | `workhorse-kotlin` sets language and API version 2.2. kotlinx-coroutines 1.10.2 is the minimum. |
| Spring Boot  | 4.0, 4.1          | 4.0     | 4.0: 2026-12-31, 4.1: 2027-07-31                               | The starter. The dates are the end of open-source support.                                      |
| PgJDBC       | 42.7.12 and newer | 42.7.12 | No date; the dependency range rule applies                     | The JDBC driver of every JVM module.                                                            |
| .NET         | 10, 11            | 10      | 10: 2028-11-14, 11: not announced                              | Every package targets `net10.0`. `Microsoft.Extensions.*` 10.0.0 is the minimum.                |
| Npgsql       | 10.0.3 and newer  | 10.0.3  | No date; the dependency range rule applies                     | The driver of every .NET package.                                                               |
| EF Core      | 10.0              | 10.0    | 10.0: 2028-11-10                                               | `Workhorse.EntityFrameworkCore`. EF Core Relational 10.0.0 is the minimum.                      |
| ASP.NET Core | 10, 11            | 10      | 10: 2028-11-14, 11: not announced                              | `Workhorse.AspNetCore`. The installed runtime supplies the patches.                             |
| PostgreSQL   | 15, 16, 17, 18    | 15      | 15: 2027-11-11, 16: 2028-11-09, 17: 2029-11-08, 18: 2030-11-14 | No extension beyond the default `plpgsql` is installed.                                         |

Pull requests and pushes run the newest Node.js and PostgreSQL versions. The weekly schedule runs
every Node.js and PostgreSQL combination. It also runs the packed-package test on the newest
Node.js version, and manual runs combine the latest-version lanes with that packed test.
Pull requests and pushes also run the demo and site smoke tests.

Package managers: the repository is developed with pnpm, and the packed-install test installs the
published tarballs with pnpm. npm and yarn are not exercised in CI; the packages are plain ESM with
no install scripts, so nothing in them is package-manager specific.

The Python package declares Python 3.12 through 3.14 and includes Psycopg 3.3 through the next
major. Its `asyncpg` extra supports asyncpg 0.31 through the next major. Its package lane builds the
source distribution and universal wheel, checks inline types, runs both real drivers, and executes
every shared SQL scenario. `python/tests/test_release.py` installs the wheel and source distribution
bare, with the compatibility `psycopg` extra, and with the `asyncpg` extra. It runs the lifecycle and async enqueue examples without repository imports, then
checks that the active Python and PostgreSQL versions belong to this matrix. Pull requests and
pushes run the newest Python and PostgreSQL versions. The weekly schedule runs every Python and
PostgreSQL combination.

The Go module declares Go 1.25 or newer and requires pgx v5.11.0. That is a minimum rather than a
pin: minimal version selection lets a consumer's own module graph choose a higher pgx v5, which is
expected to work and is not tested. Its repository
lane exercises enqueue through pgx transactions, pgx pools, and `database/sql` with pgx stdlib. It
also compiles and runs a separate module through a local `replace` directive. Another external
module builds every Go example through the public import path. These tests prove the exported module
surface without repository-only imports. Pull requests and pushes run Go 1.25 against the newest
PostgreSQL. The weekly schedule runs Go 1.25 against every supported PostgreSQL major. It also runs
the suite once on the development compiler that `mise.toml` pins, against the newest PostgreSQL.
Before each Go suite run, CI records the compiler. If the compiler is not the release that CI
installed for that run, the run fails. The weekly schedule also serves the module zip from a staged
proxy and consumes it from a clean module, as the release rehearsal does. The race detector runs
only on that weekly schedule.

The Rust crate declares Rust 1.89 as its minimum and runs on Tokio through tokio-postgres and
deadpool-postgres. Pull requests and pushes run its suite once, with every optional feature, against
the newest PostgreSQL. The weekly schedule runs it against every supported PostgreSQL major. It also
runs the suite without optional features and packages the crate into a clean consumer, as the
release gate does. [ADR 0083](decisions/0083-run-each-language-suite-once-per-change.md) records
this split.

The JVM SDK has three modules: the `workhorse` core, `workhorse-kotlin`, and
`workhorse-spring-boot-starter`. Maven Central serves them. The [JVM artifacts](#jvm-artifacts)
section gives the Gradle and Maven coordinates. Every module compiles with `--release` set to the Java floor. A local build
uses the JDK that `mise.toml` pins. Each JVM CI job uses the Java release of its matrix entry. Pull
requests and pushes run the JVM suite on the Java floor and on the newest tested Java release,
against the newest PostgreSQL. The weekly schedule runs every tested Java release against every
supported PostgreSQL major.
[ADR 0103](decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)
records these floors.

Java 21 and 25 are long-term releases. The Adoptium support roadmap publishes a month, not a day,
for each Temurin release. For Java 21 and 25 it states "at least" that month, so the recorded date
is the earliest end that Adoptium promises.

The Kotlin module compiles with language version and API version 2.2, and it uses the 2.2
standard library. So a caller on the Kotlin 2.2 compiler can read it, and resolves no newer
standard library. The build itself uses a newer Kotlin compiler.

The Spring Boot starter compiles against the Spring Boot floor. The `jvm` CI job tests it on the
floor. The `spring-boot` CI job tests the same jar on the newest tested Spring Boot line. A weekly
CI job tests it on the next Spring Boot snapshot. That CI job does not block a release.

The JVM floors exclude the releases with the advisories that ADR 0103 lists. The core and the
starter declare the OpenTelemetry API 1.62.0 as an optional dependency. The `jackson` feature of the
starter declares `jackson-databind` 3.1.7. Spring Boot 4.0.0 to 4.0.7 manage a PgJDBC release below
the floor, so the starter needs Spring Boot 4.0.8 or later, or a `postgresql.version` override. If
an application imports the Spring Boot BOM as Maven dependency management, or through the Spring
dependency management plugin for Gradle, the BOM selects the Jackson and OpenTelemetry versions,
which can be lower than these floors. A Gradle `platform` keeps the higher versions that the starter
declares.

The core declares the Jakarta Servlet API as an optional dependency for the dashboard backend. Its
floor is Jakarta Servlet 6.0. CI tests the dashboard backend in the Tomcat release that the newest
tested Spring Boot line manages.

The .NET SDK has four packages: `Workhorse`, `Workhorse.Hosting`, `Workhorse.EntityFrameworkCore`,
and `Workhorse.AspNetCore`. nuget.org serves them from `0.10.0`. A project adds the core with
`dotnet add package Workhorse`, and `support.json` states that command as
`install.dotnet`. Every package targets `net10.0`, and a .NET 11 application runs it without a
second target. A local build uses the .NET SDK that `mise.toml` pins, which carries the .NET 10
runtime. Pull requests and pushes run the .NET suite on .NET 10 and on .NET 11, against the newest
PostgreSQL. The weekly schedule runs every tested .NET release against every supported PostgreSQL
major.
[ADR 0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)
records these floors.

The .NET 11 CI job installs the .NET and ASP.NET Core runtimes of .NET 11 beside the pinned SDK, and
the tests run on them. Until .NET 11 ships, that CI job installs its newest release candidate, and
`support.json` lists 11 under `dotnet.prerelease`. Microsoft states the end of support of a release
when the release ships. Until then, the table says "not announced" for .NET 11.

NuGet resolves the lowest version that a range allows. Each package states each dependency as a
floor without an upper bound, so a caller who asks for nothing more gets the floor. The floors are
Npgsql 10.0.3, `Microsoft.Extensions.*` 10.0.0, and EF Core Relational 10.0.0. CI tests EF Core 10
only, because no CI job resolves the Npgsql provider for EF Core 11 yet. SM-1678 adds that CI job
after the provider ships. ASP.NET Core is a shared framework. The installed runtime supplies its
patches, so its floor is a major version. An operator must run a serviced .NET 10 or .NET 11
runtime.

### Node.js releases with a JSON.parse fault

`JSON.parse` in some Node.js releases can read an escaped object key as a different key
(nodejs/node#63785). The fault can change a value without an error, so run a release that does not
have it.

**Example.** A worker on Node.js 24.22.0 claims a task with the payload `{"orderId":7,"\\":1}`. Later
it claims a task with the payload `{"orderId":7,"\"":1}`. The handler can then receive the key `\`
in place of `"`.

The fault occurs only for a key that has an escape in its JSON text: a key with `"`, `\`, or a
control character. A key without these characters and every string value are correct. The
TypeScript worker, `Queue`, `Admin`, the adapters, and the dashboard server read jsonb values through
the database driver, and the driver uses `JSON.parse`. Workhorse code also uses `JSON.parse` for a
stored payload contract schema, and for the JSON files and arguments of the `workhorse` CLI. Thus
Workhorse cannot prevent the fault on an affected release. Workhorse code does not use `JSON.parse`
for a checkpoint input fingerprint or for the stored value comparison of `replayHandler`.

| Node.js line | Affected releases | First fixed release |
| ------------ | ----------------- | ------------------- |
| 22           | None              | Not applicable      |
| 24           | 24.0.0 to 24.22.0 | 24.22.1             |
| 26           | 26.0.0 to 26.12.0 | 26.12.1             |

Node.js 26 is not a supported line. It is in the table for an operator who runs it. `engines.node`
stays `>=22`, so npm does not refuse an affected release, and the worker does not check the release
when it starts. V8 fixed the fault in commit 93cd21e8, and Node.js 24.22.1 and 26.12.1 include that
fix. `mise.toml` and the Node.js base image of each repository Dockerfile pin Node.js 24.22.1.

### Raising a floor

Raising the Node.js, Python, Go, Ruby, Active Job, Java, Kotlin, Spring Boot, .NET, EF Core,
ASP.NET Core, or PostgreSQL minimum is a **minor** release. It is never a major and never a patch. With one exception, it is the only
way a version leaves the table above. The exception is a Java release that is not long-term: Temurin
ends its support before the Java floor. ADR 0103 tests the Java floor and the newest Java release,
so the newest release then replaces it in the table. [ADR
0058](decisions/0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md) records the
decision. The support matrix is deliberately not one of the governed surfaces in [What SemVer
governs](#what-semver-governs); this rule governs it instead.

A floor rises only when the version being dropped has reached its **upstream end of life**. The
upstream project's own schedule is the authority and this repository keeps no competing one:

| Runtime      | End of life is                                             | Published at                                                                                |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Node.js      | Past the release's published end-of-life date              | [nodejs/Release](https://github.com/nodejs/Release)                                         |
| Python       | Past the version's published end-of-life date              | [Python developer guide](https://devguide.python.org/versions/)                             |
| Go           | Older than the two releases the Go project supports        | [Go release policy](https://go.dev/doc/devel/release#policy)                                |
| Ruby         | Past the branch's published end-of-life date               | [Ruby maintenance branches](https://www.ruby-lang.org/en/downloads/branches/)               |
| Active Job   | Past the Rails release's security support                  | [Rails maintenance policy](https://rubyonrails.org/maintenance)                             |
| Java         | Past the Temurin release's end of availability             | [Adoptium support roadmap](https://adoptium.net/support/)                                   |
| Kotlin       | The Kotlin compiler no longer accepts the language version | [Kotlin evolution principles](https://kotlinlang.org/docs/kotlin-evolution-principles.html) |
| Spring Boot  | Past the line's end of open-source support                 | [Spring Boot support](https://spring.io/projects/spring-boot#support)                       |
| .NET         | Past the release's end of support                          | [.NET support policy](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)     |
| EF Core      | Past the release's end of support                          | [EF Core releases](https://learn.microsoft.com/ef/core/what-is-new/)                        |
| ASP.NET Core | Past the .NET release's end of support                     | [.NET support policy](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)     |
| PostgreSQL   | Past the major's community end-of-life date                | [PostgreSQL versioning](https://www.postgresql.org/support/versioning/)                     |

`support.json` records that date for every listed Node.js, Python, Ruby, Active Job, Java, Spring
Boot, .NET, EF Core, ASP.NET Core, and PostgreSQL version, and the `End of life` column above
publishes it. Go is the exception:
its policy is relative to whatever the current release is, so there is no published date to
transcribe and none is recorded. Kotlin has no date for the same reason: a newer compiler ends a
language version when it drops it. Node.js, PostgreSQL, Ruby, Rails, Spring Boot, .NET, and EF Core
publish a day.
The Python developer guide publishes only a month until a version retires, and the Adoptium support
roadmap publishes only a month for each Temurin release. A month-precision entry stands for that
whole month.

Ruby names a branch's end only once the branch enters security maintenance. Until then its
`support.json` date is `null`, and the table says "not announced" rather than guessing. The floor
always carries a date, because it retires first. Active Job follows its Rails release, and the
date is the end of that release's security support. Microsoft states the end of a .NET release
only when it ships, so a .NET release in `dotnet.prerelease` is the only .NET entry with a `null`
date. ASP.NET Core follows its .NET release.

Convenience is not a reason. A runtime still supported upstream keeps its place in the table even
when dropping it would simplify the code or shorten the matrix.

Notice is what makes the minor honest. The table above carries every version's upstream date from
the day that version is first supported, and `typescript/core/test/support-matrix.test.ts` fails
once a listed version is past it, so the repository notices the retirement rather than the reader.
Before the minor that drops a version, at least one published minor's changelog says so.
PostgreSQL takes two published minors of notice rather than one, because a PostgreSQL major
upgrade is a database migration the operator schedules rather than a package bump.

A floor raise is a minor because it cannot reach code that already runs. The release you installed
keeps working against the database you built it for; what a dropped runtime loses is future
releases, and every package manager in these ecosystems reports that as a resolution result.

### Moving a dependency range

`pg`, Psycopg, asyncpg, pgx, PgJDBC, the Jakarta Servlet API, Npgsql, and the
`Microsoft.Extensions.*` packages move under the same rule, in either direction, and every move is a
minor:

- **Raising a floor inside the declared major range** — a minor.
- **Widening the range to admit a new upstream major** — a minor, once CI exercises it.
- **Narrowing the range to drop an upstream major** — a minor, allowed only when that major is
  end-of-life upstream or unusable, such as an unfixed advisory with no release that carries the
  fix. It takes the same one-minor notice a runtime floor takes.

Narrowing a **peer** range is the same event as a floor raise and takes the same treatment. The
consumer who cannot move keeps the version they installed; only the next release stops resolving.

One dependency move is a major, for an ordinary governed-surface reason rather than a new one.
`NewWorker(pool *pgxpool.Pool, options WorkerOptions)` puts a pgx type in the Go module's exported
signature, so moving to pgx v6 changes an exported identifier and requires
`github.com/stablemates/workhorse/go/v2`. The general rule: a dependency whose types appear in a
governed surface moves that surface when it changes incompatibly, and that surface's own definition
of breaking decides the release. `pg` and Psycopg are bundled dependencies that a caller never
names, so no equivalent exists on the TypeScript or Python lines.

### Dependency advisories

Each language line fails its build on an advisory in its own dependency tree. `pnpm npm:vuln`
covers npm, `pnpm python:vuln` covers PyPI, `pnpm go:vuln` covers the Go module, and
`pnpm rust:vuln` covers the Rust crate, `pnpm ruby:vuln` covers the Ruby gem, `pnpm jvm:vuln`
covers the three JVM artifacts, and `pnpm dotnet:vuln` covers the four .NET packages. `pnpm check`
runs all seven, and so does the `static` task in
`.github/workflows/ci.yml`. The release workflow runs `pnpm ruby:vuln` again inside
`pnpm ruby:release-check`.

`pnpm npm:vuln` runs `pnpm audit --prod` and fails on every advisory it reports, whatever the
severity. Severity describes the advisory rather than this repository's exposure to it, so a
severity threshold would both hide advisories that matter here and fail on ones that cannot. An
advisory passes only with an entry in `scripts/npm-advisory-acceptances.json` stating why it does
not block a release and the date the decision expires. The check fails once that date passes, when
an entry stops matching anything, and when an accepted advisory starts reaching a workspace package
the entry does not name — which is how an advisory outside the published closure gets caught the
day it enters it.

The packed-release gate in `typescript/core/test/packed-packages.ts` scans a second tree. It
installs the packed tarballs into a throwaway consumer and audits that, so it reads the resolution
someone installing the release receives rather than the one this repository's lockfile pins. Both
scans call `readAuditReport` in `scripts/audit-npm-dependencies.ts`, so an advisory service that
never answered is refused in one place and never read as a clean tree. The packed scan fails on a
high or critical advisory that no acceptance names a published package for; `pnpm npm:vuln` remains
the scan with no severity threshold. A release therefore needs an answer from the advisory service
twice, which is deliberate: the two trees can hold different versions of the same dependency.

`pnpm rust:vuln` runs `cargo deny check advisories` against the root `Cargo.lock`. `mise.toml` pins
the cargo-deny version, and `deny.toml` holds its configuration. The graph includes every feature
of the published crate, because a consumer can enable any of them. The scan fails on every RustSec
entry that reaches the lockfile, whatever its kind: a vulnerability, an unmaintained crate, or an
unsound API. A reported entry passes only when `scripts/rust-advisory-acceptances.json` states a
reason and a review date for it. The check fails once that date passes, and when an entry stops
matching anything. cargo-deny's own `ignore` list stays empty, because it carries no review date.

cargo-deny exits non-zero both on an advisory and on an advisory database it could not fetch.
`scripts/audit-rust-dependencies.ts` tells them apart by the summary record a completed check
writes. Without that record, the scan reports the unreachable database and names no acceptance
entry as stale.

`pnpm ruby:vuln` runs bundler-audit, locked in the gem's own bundle, against `ruby/Gemfile.lock` and
every locked Rails gemfile under `ruby/gemfiles/`. Dependabot updates only the first of those, so the
scan is what catches an advisory in a Rails lockfile. The scan fails on every advisory that reaches a
lockfile, whatever its criticality, and on a gem source fetched without TLS. A reported advisory
passes only when `scripts/ruby-advisory-acceptances.json` states a reason and a review date for it.
The check fails once that date passes, and when an entry stops matching anything in any lockfile.
An entry without a reason, or whose review date is not a real calendar date, fails the check before
any advisory is judged. bundler-audit's own `ruby/.bundler-audit.yml` ignore list is refused, because it carries no review
date.

bundler-audit reads a local copy of the ruby-advisory-db and reports a clean lockfile when that
copy is empty. `scripts/audit-ruby-dependencies.ts` therefore refreshes the database with
`bundle-audit update` first. It refuses the run when the refresh fails, when the database holds no
advisories, or when it is not a git checkout that a refresh can move. bundler-audit silently skips
a directory it cannot list, so the script also reads every advisory directory and file itself. An
unreadable one refuses the run. Each refusal names the database and no acceptance entry as stale.

`pnpm jvm:vuln` runs `scripts/audit-jvm-dependencies.ts`. The JVM build has no lockfile.
`jvm/gradle/verification-metadata.xml` holds the sha256 checksum of each artifact that the `jvm/`
build resolves, and Gradle refuses an artifact that differs from it.
`pnpm jvm:verification-metadata:check` fails if that file is not current. `pnpm check` runs it, and
the CI `jvm-verification-metadata` job runs it on the Java floor. That file does not decide what a
caller resolves, because the caller's own conflict resolution selects the versions from the POM and
the Gradle module metadata of each artifact.

Thus the scan reads the runtime classpaths that a caller resolves, and its consumer build has no
verification metadata. The script publishes `workhorse`, `workhorse-kotlin`, and
`workhorse-spring-boot-starter` to a scratch Maven repository. Then the consumer build in
`scripts/jvm-dependency-scan/` resolves each artifact for Java 21, with no optional feature, with
each optional feature, and with all features together. The scan reads the union of these
classpaths and asks the OSV database about each module on them. It does not read the modules of
`run.workhorse`.

The JVM scan fails on every advisory that reaches a classpath, whatever its severity. It skips an
advisory that OSV marks as withdrawn. A reported advisory passes only when
`scripts/jvm-advisory-acceptances.json` has an entry for that advisory and module, with a reason and
a review date. The check fails when that date has passed, and when an entry matches nothing on any
classpath. An entry without an advisory, a module, or a reason, or whose review date is not a real
calendar date, fails the check before any advisory is judged.

OSV answers an unknown module with no advisory, so an empty answer cannot show a clean classpath.
Each query batch therefore also asks about a canary module with a known advisory. If OSV does not
report that advisory, or if OSV does not answer, the script refuses the run. The refusal names the
database and no acceptance entry as stale.

Every restore of a .NET project runs NuGet Audit. `dotnet/Directory.Build.props` sets `NuGetAudit`,
`NuGetAuditMode` to `all`, and `NuGetAuditLevel` to `low`, and makes NU1901 to NU1904 errors. So
each advisory against a direct or a transitive package fails the restore, whatever its severity.
That includes the test packages, such as `Microsoft.Extensions.Hosting` and
`Npgsql.EntityFrameworkCore.PostgreSQL`. NU1900 says that the advisory data did not load. It stays a
warning in a build, so that a build from the package cache works without the network.

`pnpm dotnet:vuln` runs `scripts/audit-dotnet-dependencies.ts`. The floor consumer in
`dotnet/floor-consumer/` references the four packages and nothing else. So its restore resolves each
shipped dependency at the floor that `dotnet/Directory.Packages.props` states, as a caller gets it.
The consumer makes NU1900 and NU1905 errors, so its restore fails when the advisory data does not
load. The script refuses a shipped dependency that the consumer does not resolve at its floor. Then
it runs `dotnet list package --vulnerable --include-transitive`, and fails on every advisory that
the listing reports. It also refuses a listing that did not read the advisories of nuget.org. The
.NET scan has no acceptance list. An advisory fails the scan until a raised floor fixes it.

`pnpm tooling:vuln` audits the build and publication tooling, in a lane separate from the seven
production gates. [ADR 0058](decisions/0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md)
records why. The lane runs `pnpm audit` over the whole workspace, development dependencies included.
It runs `pip-audit` over the uv export with every dependency group, and separately over
`python/build-constraints.txt`, which pins the Python build backend. The `static` task in
`.github/workflows/ci.yml` runs it, and so does `pnpm check`. The build job of `release-python.yml`
runs it before anything is built for publication. The build job of `release.yml` installs no Python
toolchain, so it runs only the npm half, `pnpm tooling:vuln:npm`, at the same point.

`scripts/audit-tooling-dependencies.ts` judges only advisories the production scans do not report.
An advisory the production scan reports belongs to the production gate and its acceptance list. A
remaining advisory passes only when `scripts/tooling-advisory-acceptances.json` states a reason and
a review date for it. That file has an `npm` and a `python` section. The check fails once a date
passes, and when an entry stops matching anything. It also fails on an entry that names an advisory
the production scan reports, so a tooling acceptance can never let a production finding pass. An
entry without a reason, or whose review date is not a real calendar date, fails the check before any
advisory is judged. pip-audit exits non-zero both on an advisory and on a scan it could not finish.
The script refuses a run whose report lists no dependencies, and names no acceptance entry as stale.
It also refuses a report in which pip-audit skipped a dependency, because a skipped dependency has
no advisories and would otherwise read as clean. The development export and the build backend are
separate environments, so each gets its own pip-audit run, and they may pin different versions.

uv.lock does not pin the build backend, and `python/pyproject.toml` accepts a range of hatchling
versions. `ci.yml` and `release-python.yml` set `UV_BUILD_CONSTRAINT` to
`python/build-constraints.txt`, so every editable build in CI uses the backend the lane audits.

Fixing beats accepting. Prefer a lockfile bump, then a declared-range bump; write an entry only when
no released version carries the fix, or when the path is provably outside what this repository
publishes. [`SECURITY.md`](../SECURITY.md) states the triage window and fix target per severity.

## JS runtime smoke tier

Node.js is the only supported runtime. Bun and Deno sit in a deliberately weaker tier declared by
`SMOKE_TESTED_JS_RUNTIMES` in `typescript/core/src/support.ts`: the `runtime-smoke` CI lane runs
`typescript/core/test/runtime-smoke.ts` — `installSchema`, then an enqueue, claim, and complete
round-trip through the built `@stablemates/workhorse` entry point — against the newest supported
PostgreSQL, under the latest release of each runtime. A green lane proves the driver connects, the
schema installs, and one task completes there. It proves nothing else: the full vitest suites run
under Node.js only, so this tier carries no correctness claim beyond the round-trip.

What the validation runs recorded:

- **Bun (2026-08-27, Bun 1.2.17, Vitest 4.1.11).** The smoke round-trip passes. Vitest 4 starts
  the unit suites: 894 of 942 collected tests passed. Remaining failures spawn `process.execPath`
  (Bun) and then load TypeScript through tsx's Node-only CJS loader, or fail to collect files
  whose Zod import is `undefined` under Bun. Harness and process-boundary issues, not a library
  failure — Node.js remains the only runtime that runs the full suites.
- **Deno (2026-08-17, Deno 2.9.5).** The smoke round-trip passes, and vitest itself runs: 563 of
  601 unit tests and 467 of 470 database tests pass. Every failure is a test that respawns
  `process.execPath` on the TypeScript sources — under Deno that child needs
  `--unstable-sloppy-imports` to resolve the repository's `.js`-suffixed imports of `.ts` files.
  The failures say nothing about the built package, which is plain ESM.
- **Node.js (2026-09-09, Node.js 24.15.0).** Benchmark baseline on the same machine and
  PostgreSQL 18.4, run as `pnpm benchmark` (`suite=all`, `profile=default`). Conventional design at
  worker concurrency 8: throughput ~3,295 tasks/s, claim p50 ~0.91 ms, p99 ~8.35 ms.
  Concurrent producer-consumer churn: throughput ~105 tasks/s, claim p50 ~0.91 ms, p99 ~2.94 ms.
- **Bun (2026-09-09, Bun 1.2.17).** The full `pnpm benchmark` suite (`suite=all`,
  `profile=default`) passes on the same PostgreSQL 18.4 and the same machine as the Node.js 24
  baseline. Conventional design at worker concurrency 8: throughput ~3,158 tasks/s, claim p50
  ~0.91 ms, p99 ~7.85 ms. Concurrent producer-consumer churn: throughput ~105 tasks/s, claim p50
  ~0.89 ms, p99 ~1.77 ms. Vitest 4 under Bun runs the unit suites: 1,299 of 1,324 tests passed,
  20 skipped. The 5 failures are test-harness issues: one supervisor test spawns
  `process.execPath` and gets a different descendant count under Bun; four demo telemetry tests
  spawn `node --require` and fail because the demo's `@stablemates/workhorse-otel` points at a
  `dist/` that is not built in this worktree. Database vitest suites: 669 of 671 tests passed,
  2 skipped, 0 failed. The raw JSON reports are in
  `docs/benchmarks/results/2026-09-09-node-24.15.0-all-default.json` and
  `docs/benchmarks/results/2026-09-09-bun-1.2.17-all-default.json`.

No runtime-specific code paths or shims exist, and none are planned. If a smoke lane turns red,
the fix is filed against the runtime story, never inlined as a conditional in the library.

### Serverless and edge runtimes

Two independent rules determine whether a serverless runtime can use Workhorse. A producer needs
a supported client and a PostgreSQL connection. A worker also needs an autonomous process that can
hold connections, renew leases, send heartbeats, and drain after a termination signal. Database
connectivity does not turn a request-scoped function into a worker host.

| Platform              | Runtime                | Enqueue with the published client | Host a worker | Requirement or boundary                                                                                                                                               |
| --------------------- | ---------------------- | --------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers    | Workers isolate        | No                                | No            | Hyperdrive provides verified `pg` connectivity under `nodejs_compat`, but `@stablemates/workhorse` supports Node.js, not the Workers runtime. Use a Node.js producer. |
| Vercel Functions      | Node.js                | Yes                               | No            | Use `@stablemates/workhorse` normally. The caller can pass its open `pg` transaction to `Queue.enqueue`.                                                              |
| Vercel Functions      | Edge                   | No                                | No            | The Edge runtime omits the Node.js APIs required by `pg` and `@stablemates/workhorse`. Move the route to the Node.js runtime.                                         |
| AWS Lambda            | Node.js                | Yes                               | No            | Use `@stablemates/workhorse` over a network path to PostgreSQL. Lambda owns the execution environment lifetime.                                                       |
| Cloud Run service     | Node.js, request-based | Yes                               | No            | Use `@stablemates/workhorse` in the request. Request-based CPU allocation and instance scaling cannot own a continuous worker loop.                                   |
| Cloud Run worker pool | Node.js container      | Yes                               | Yes           | Run the dedicated Workhorse worker process with at least one worker-pool instance.                                                                                    |

We verified these claims on 2026-08-18. A Wrangler 4.124 local Worker used `nodejs_compat`, the
repository's `pg` dependency, and a local Hyperdrive binding to execute `SELECT 1` against the
worktree test database. The request returned `{ "connected": true }`. This test covers the Workers
runtime and PostgreSQL transport, but local Hyperdrive does not enable Cloudflare's managed pooling
or cache. The repository's PostgreSQL integration suite covers the Node.js transaction path used by
Vercel Functions, Lambda, and Cloud Run. Provider runtime documentation supplies their lifecycle
boundaries and confirms that Vercel Edge omits the Node.js networking APIs required by `pg`.

The published [serverless guide](https://workhorse.run/docs/serverless) links each provider source
and explains where to deploy workers when the web tier is serverless.

## PostgreSQL connection poolers

A connection pooler between a Workhorse process and PostgreSQL changes which connection semantics
a client can rely on. `typescript/core/test/integration-pooling.test.ts` exercises each pooler and
mode as a separate lane: direct against PostgreSQL, then PgBouncer and PgCat each in
`pool_mode = session` and `pool_mode = transaction`. The TypeScript CI job runs all five lanes on
every supported PostgreSQL version; a checkout without a pooler runs the direct lane and reports
the pooled lanes as skipped. `pnpm test:pooling` provisions the same fixture locally.

| Operation                                                           | Direct | PgBouncer session | PgBouncer transaction                                                            | PgCat session                                                             | PgCat transaction |
| ------------------------------------------------------------------- | ------ | ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------- |
| Enqueue, claim, settle, heartbeat, operator reads                   | Yes    | Yes               | Yes                                                                              | Yes                                                                       | Yes               |
| Transactional enqueue inside a caller-owned transaction             | Yes    | Yes               | Yes                                                                              | Yes                                                                       | Yes               |
| `installSchema`, `migrateSchema`, `contractSchema`                  | Yes    | Yes               | Yes; each step is one `BEGIN`…`COMMIT` script                                    | Yes                                                                       | Yes               |
| Maintenance tick and every SQL `pg_(try_)advisory_xact_lock`        | Yes    | Yes               | Yes; the locks are transaction-scoped                                            | Yes                                                                       | Yes               |
| `LISTEN`/`NOTIFY` wake hints on `workhorse_tasks`                   | Yes    | Yes               | `LISTEN` succeeds but no notification is ever delivered; the fallback poll works | Relayed only with the client's next query; an idle listener hears nothing | Same              |
| Session-level `pg_advisory_lock`/`pg_advisory_unlock`               | Yes    | Yes               | Unsafe; a grant pins to a pooled backend and a second client can take the key    | Yes                                                                       | Unsafe            |
| Session state (`SET`, SQL `PREPARE`/`DEALLOCATE`, temporary tables) | Yes    | Yes               | Unsafe; state lands on a server session the client does not own                  | Yes                                                                       | Unsafe            |

Verified on 2026-09-11 against PgBouncer 1.25.2, PgCat 1.2.0, and PostgreSQL 18.6.

Two consequences matter operationally. Wake hints are dead wherever a notification cannot reach
the listener — PgBouncer in transaction mode accepts `LISTEN` then releases the server connection,
and PgCat buffers a notification until the client sends another query — while
`Queue.supportsTaskNotifications()` and the subscription's `isListening()` still report capability.
Dispatch runs entirely on the fallback poll, which is correct but slower; give the worker a pool
that reaches a session-pooled PgBouncer or PostgreSQL directly to restore hints. And every leaked
session grant or `SET` lands on a pooled backend that outlives the client that created it, so a
transaction-mode pool must never serve a code path that leaves session state behind.

Connection budget: the workers on one pool share one listener connection and one heartbeat
connection, for any number of `Queue` or `Worker` objects. A worker pool thus needs at least 3
connections: the listener, the heartbeat, and one claim. Under the heartbeat opt-out, a TypeScript
or Go pool limited to one connection stays polling-only. Behind a pooler that cannot deliver
notifications, the listener connection delivers nothing. It still counts against the client limit
of the pooler and against the pool of your app. A Rust listener connection is outside the pool, so
it counts only against the client limit. [Overview: Connection budgets per
language](architecture/overview.md#connection-budgets-per-language) states the budget of each
language.

A PgCat routing detail: its `pgcat.toml` names each pool statically, so a client URL's database
name must match a configured pool — unlike PgBouncer, a PgCat deployment cannot forward a database
name it was not configured for.

## Packages and versioning

Twelve packages ship from this repository. `@stablemates/workhorse` is the TypeScript durable queue.
`stablemates-workhorse` names both the Python distribution on PyPI and the Ruby gem on RubyGems. The
rest are optional TypeScript packages.

| Package                                     | Purpose                                           | Peer requirements                                                                                             |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@stablemates/workhorse`                    | Queue, worker, schema, CLI                        | None; includes `pg` >= 8.16.3 and < 9                                                                         |
| `@stablemates/workhorse-drizzle`            | Drizzle ORM provider                              | `@stablemates/workhorse`, `drizzle-orm` >= 0.45, `pg`                                                         |
| `@stablemates/workhorse-prisma`             | Prisma ORM provider                               | `@stablemates/workhorse`, `@prisma/client` >= 6 and < 8                                                       |
| `@stablemates/workhorse-typeorm`            | TypeORM provider                                  | `@stablemates/workhorse`, `typeorm` >= 0.3 and < 2                                                            |
| `@stablemates/workhorse-kysely`             | Kysely provider                                   | `@stablemates/workhorse`, `kysely` >= 0.29 and < 0.30                                                         |
| `@stablemates/workhorse-knex`               | PostgreSQL Knex provider                          | `@stablemates/workhorse` >= 0.10 and < 0.11, `knex` 3.3.0, `pg` 8.23.1                                        |
| `@stablemates/workhorse-otel`               | OpenTelemetry adapter                             | `@stablemates/workhorse`, `@opentelemetry/api` >= 1.9 and < 2, `@opentelemetry/api-logs` >= 0.200 and < 0.300 |
| `@stablemates/workhorse-dashboard`          | Operator dashboard and its framework-neutral host | `@stablemates/workhorse` >= 0.10.0 and < 0.11, React 19                                                       |
| `@stablemates/workhorse-dashboard-server`   | Authenticated standalone dashboard server         | `@stablemates/workhorse-dashboard-contract`                                                                   |
| `@stablemates/workhorse-dashboard-contract` | Type-only dashboard server boundary               | None                                                                                                          |
| `stablemates-workhorse`                     | Python clients, workers, and WSGI dashboard       | None; includes Psycopg >= 3.3 and < 4; `asyncpg` extra supports >= 0.31 and < 1                               |
| `stablemates-workhorse` (gem)               | Ruby clients, workers, and Rack dashboard         | None; includes `pg` >= 1.6 and < 2, `connection_pool` >= 2.5 and < 4; Active Job adapter supports >= 8.0      |

The ten TypeScript packages are versioned in lockstep and released from a single `vX.Y.Z` tag. An
optional TypeScript package always declares the core version it was released with as a peer range.
The Python package, the Go module, the Rust crate, the Ruby gem, and the JVM SDK declare no TypeScript peer
range. SQL protocol 5 and schema version 76 are their compatibility boundary instead. Their version numbers
still match the npm packages, because every line releases from one commit.

Every release publishes one version to npm, PyPI, the Go module proxy, crates.io, RubyGems, Maven
Central, and nuget.org from one source commit. The current release is `0.10.0`. “Public beta” means the release is usable for evaluation and early production adoption without a
0.x compatibility promise. The label is retired at 1.0.0 and replaced by “stable”; see
[What SemVer governs](#what-semver-governs).

The dashboard and core may use different patch releases within the same minor line. The dashboard
server reads `workhorse.dashboard_*_v1` views and versioned functions, and a migration may not
remove, retype, or reinterpret a shipped view, so a core release remains compatible with the
dashboard it shipped beside. At 1.0.0 the dashboard's peer range on `@stablemates/workhorse` widens
from the minor line to the major line; see [Retention and removal](#retention-and-removal).

The shared browser bundle carries no SDK version. The TypeScript, Python, Go, Rust, Ruby, or JVM
host supplies its own published version when it renders the application. Thus the dashboard reports
the package that serves it. A version-only release does not change the bundle.

While the line is `0.x`, any minor release may make a breaking change in behaviour. The schema is
not one of them: from `0.1.0` every release ships ordered, immutable migrations, and inside a major
line a migration only adds, so a client built against schema version N accepts any installed
version at or above N below the next major boundary. `migrateSchema` runs from a deployment step
before any process from the new release starts. Breaking changes are listed in
[`CHANGELOG.md`](../CHANGELOG.md) with the upgrade steps for that release, and
[ADR 0053](decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md) states the rule.

Migration 0025 is the one exception. It is a contract step that 0.5.0 ships, so a database from
before 0.5.0 crosses it offline, with the
[0.5.0 upgrade steps](../CHANGELOG.md#050--2026-09-28).
[The fast-tier cutover](schema-lifecycle.md#the-fast-tier-cutover) explains why, and
[ADR 0077](decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md) records
the decision.
An installation that runs cold export also stops its exporters across migration 0052, as
[the current schema policy](schema-lifecycle.md#current-policy) describes.

`.github/workflows/release.yml` publishes the ten npm packages with provenance. It then creates the
GitHub release for the tag and attaches `sql/schema.sql`. That artifact is the clean-install schema
for the version, provided so a Python or Go developer with no Node.js toolchain can create a
development database with `psql -f schema.sql`. It applies none of the CLI's guards, so deployments
run `workhorse schema install` or `workhorse schema migrate` instead.

The GitHub release becomes public only after the `crates-io`, `rubygems`, `maven-central`, and
`nuget` jobs succeed. If the version of a crate, gem, JVM artifact, or .NET package does not match
the tag, that line skips publication, and its job still succeeds. The release then still appears. A failed
crate, gem, Maven Central, or nuget.org publication ends the run before the release exists.

The asset is reachable at
`https://github.com/stablemates/workhorse/releases/download/vX.Y.Z/schema.sql`. `support.json`
states that URL once as `install.schemaDownload`, pinned to the version this repository publishes,
and `scripts/install-commands.test.ts` fails a URL that names a different version or an asset the
release step does not attach. A tag pushed before that step existed has no release and no asset;
the first release that carries one is `v0.1.0`.

Each line carries its own tag on that one commit, because npm, PyPI, and the Go module proxy have
separate build and publication identities. The Go module proxy also resolves a subdirectory module
only from a `go/`-prefixed tag. The crate, the gem, the JVM artifacts, and the .NET packages publish
from the TypeScript `vX.Y.Z` tag, so seven registries share three tags.
[ADR 0050](decisions/0050-release-0-1-0-without-a-prerelease-suffix.md) records that the tags name
one commit and one version number.

The Python package releases from its own `python/vX.Y.Z` tag. The tag must match
`python/pyproject.toml` and a heading in `python/CHANGELOG.md`. `.github/workflows/release-python.yml`
requires a successful `main` CI run on the tagged commit. It then runs `pnpm python:release-check`,
which builds a source distribution and universal wheel with uv. It runs no Rust check. The required
`main` CI run includes `pnpm rust:gates`, and the build job of `release.yml` runs
`pnpm rust:release-check` before any npm, crate, or gem publish.
A separate `pypi` environment publishes those artifacts through PyPI trusted publishing with
`id-token: write`.
Before publication, the publish task generates a PEP 740 attestation beside each distribution.
An attestation rehearsal job proves on every run, dry runs included, that the pinned uv uploads them.

The Go module releases from its own `go/vX.Y.Z` tag. `scripts/release-go.sh X.Y.Z` requires
a clean worktree and a matching `go/CHANGELOG.md` heading. It also requires that `HEAD` is an
ancestor of `origin/main`, and that `vX.Y.Z` and `python/vX.Y.Z` on origin point to `HEAD`. It
rehearses the module release and resets the test database. If the `origin` repository has a
successful `main` CI push run for exactly `HEAD`, the script runs only `pnpm go:test` and
`pnpm go:vuln`. If not, it runs `pnpm check`. It then creates an annotated tag and pushes that tag
to `origin`.

## What SemVer governs

SemVer says a major release may break the public API. It does not say which artifact is the public
API, and Workhorse ships twelve of them. Each surface below is governed, and each states in one
sentence what a breaking change is for it. Anything not on this list is internal and may change in
any release. [ADR 0054](decisions/0054-define-what-1-0-0-promises.md) records the decision, and
[ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md),
[ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md),
[ADR 0103](decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md),
and
[ADR 0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)
add the Rust, Ruby, Java, Kotlin, and C# APIs.

| Governed surface                                    | A breaking change is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Enforced by                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| SQL protocol and schema                             | A narrowing of `workhorse.protocol_version`, which is how a superseded `_vN` function is removed. A schema-version bump is not one, because inside a major line a migration only adds.                                                                                                                                                                                                                                                                                                                                | `sql-catalogues:check`, which classifies the change         |
| TypeScript API                                      | A change that makes caller code stop compiling or behave differently, across the names and types reachable through a package's `exports` map and shipped `.d.ts`.                                                                                                                                                                                                                                                                                                                                                     | `typescript-api:check`, against `api/typescript.txt`        |
| Python API                                          | The same, across the names in a public module's `__all__`. Underscore-prefixed modules such as `workhorse._protocol` are private.                                                                                                                                                                                                                                                                                                                                                                                     | `python-api:check`, against `api/python.txt`                |
| Go API                                              | The same, across the exported identifiers of the module's non-`internal` packages. Go's own standard applies: what `apidiff` calls an incompatible change.                                                                                                                                                                                                                                                                                                                                                            | `go-api:check`, `apidiff` against the tag `api/go.txt` pins |
| Rust API                                            | The same, across the public items reachable from the `workhorse` crate root under any published feature, auto and derived traits included. Removing or renaming a feature, or moving an item behind one, is also breaking.                                                                                                                                                                                                                                                                                            | `rust-api:check`, against `api/rust.txt`                    |
| Ruby API                                            | The same for code that runs rather than compiles, across the public constants under `Stablemates::Workhorse` and the Active Job adapter, with their `Data` members and method signatures. A `:nodoc:` constant is private.                                                                                                                                                                                                                                                                                            | `ruby-api:check`, against `api/ruby.txt`                    |
| Java API                                            | The same, across every public and protected declaration in an exported package of `workhorse` and `workhorse-spring-boot-starter`, with its signature and nullness. It also covers every `workhorse.*` property with its type and default. `run.workhorse.internal` is not exported. A new last component of a public record is not breaking, because the record keeps its earlier canonical constructor; a record pattern that names all components of a public Workhorse record is outside this promise (ADR 0103). | `java-api:check`, against `api/java.txt`                    |
| Kotlin API                                          | The same, across every public declaration of `workhorse-kotlin`, with its default arguments, `suspend` modifiers, and reified type parameters.                                                                                                                                                                                                                                                                                                                                                                        | `kotlin-api:check`, against `api/kotlin.txt`                |
| C# API                                              | The same, across every public and protected type and member of `Workhorse`, `Workhorse.Hosting`, `Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`, with its signature, nullability, and default values. It also covers every `Workhorse:*` configuration key with its type and default. A new `required` property and a new abstract member of an interface that callers implement are breaking (ADR 0107).                                                                                                | `dotnet-api:check`, against `api/dotnet.txt`                |
| `workhorse` CLI                                     | Removing or renaming a command or flag, changing what an exit code means, or removing or retyping a field in `--json` output.                                                                                                                                                                                                                                                                                                                                                                                         | `cli-surface:check`, against `api/cli.txt`                  |
| `dashboard/v1` wire contract                        | Removing a procedure, removing or retyping a response field, or tightening request validation.                                                                                                                                                                                                                                                                                                                                                                                                                        | `dashboard-spec:check`, which classifies the change         |
| OpenTelemetry instrument, span, and attribute names | Renaming or removing an instrument, span, or attribute, or changing an instrument's unit or kind.                                                                                                                                                                                                                                                                                                                                                                                                                     | `telemetry-surface:check`, against `api/telemetry.txt`      |

The right-hand column is Gate 1 of
[ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md): every governed surface holds a mechanical
check in the CI `required` task, so no promise rests on review alone. Ten of them read the committed
snapshots in [`api/`](../api/README.md), which that directory's own README explains. Each has a
generator, so a legitimate addition costs one command: `pnpm typescript-api:generate`,
`pnpm python-api:generate`, `pnpm go-api:generate`, `pnpm rust-api:generate`,
`pnpm ruby-api:generate`, `pnpm java-api:generate`, `pnpm kotlin-api:generate`,
`pnpm dotnet-api:generate`, `pnpm cli-surface:generate`, or `pnpm telemetry-surface:generate`.

A snapshot is only as good as where it reads from, so neither `api/cli.txt` nor `api/telemetry.txt`
reads a table kept beside the code. `api/cli.txt` reads `typescript/core/src/cli/surface.ts`, which the CLI itself
dispatches, parses, and serializes through, so renaming a command or dropping a flag stops the CLI
from accepting it. `api/telemetry.txt` reads the emitting source directly, so renaming an instrument
or an attribute changes the snapshot on the same commit.

A type-level break counts even when no runtime behaviour moved: a narrowed parameter or a widened
return that an existing caller cannot hold is a break.

Adding is not breaking. A new `--json` field, a new instrument, and a new export are all minor
changes, so a `--json` consumer must ignore fields it does not know. The CLI's human-readable stdout
prose is not governed; scripts read `--json`.

`dashboard/v1` carries its version in its committed artifacts, not its HTTP path. Each SDK release
binds its backend to the matching dashboard contract and browser bundle. A break creates
`dashboard/v2` rather than moving any package major, and the release ships its backend and bundle
together. Existing installations keep serving their bound `dashboard/v1` pair until their operator
upgrades them.

The release notes announce a `dashboard/v2` transition and give its upgrade steps. An installed
backend serves one bound contract rather than negotiating concurrent versions, so `Deprecation`
and `Sunset` response headers do not apply.

Each language line has its own governed surfaces, but the six lines share one version. From 1.0.0,
if a change needs a major release on one line, the next release is a major for every line. A line
with no break publishes the major as a version-only release. For the Go module, each major N from 2
also changes the module path to end in `/vN`, for example `github.com/stablemates/workhorse/go/v2`.
[ADR 0106](decisions/0106-keep-the-release-lines-in-lockstep-after-1-0-0.md) records the decision.

The runtime support matrix and the declared dependency ranges are not on this list. They move by
their own rule, in a minor and only on upstream end of life; see [Raising a floor](#raising-a-floor).

### Two surfaces classify their own changes

`sql-catalogues:check` and `dashboard-spec:check` regenerate an artifact and diff it. A diff alone
says only that something moved, because regenerating rewrites the artifact whether a procedure was
added or removed. Each check therefore compares against a separate promise file that accumulates:
the generator may add an entry and may never drop one. The seven language checks need no such file,
because their snapshots in [`api/`](../api/README.md) are not regenerated from the surface they
describe.

- `dashboard/v1/governed-surface.json` holds every procedure, request field, and response field
  `dashboard/v1` has served, each with its type and whether validation requires it.
- `protocol/v1/governed-surface.json` holds the governed SQL functions, views, and columns, each
  with its signature or type, and lists the internal helpers beside them.

A removal or a retype fails by name and says what changed about it. An addition passes once the
generator has recorded it, which needs no hand edit. Taking a break deliberately needs
`--accept-breaking`, which rewrites the promise from the current surface; for `dashboard/v1` that
means creating `dashboard/v2` instead, and for SQL it means narrowing
`workhorse.protocol_version`.

[ADR 0064](decisions/0064-rename-the-unit-noun-from-job-to-task.md) holds the exception for
`dashboard/v1`: while no consumer outside this repository speaks the contract, a break is taken in
place with `--accept-breaking` and recorded in the deciding issue. Check that condition before
taking one. The published `openapi.json` is what is most likely to end it.

### The governed SQL surface

The governed set is what a supported release reads, which is not what `protocol/v1/manifest.json`
declares. The manifest names the 26 protocol functions the SQL protocol pins; the audit behind
[ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md) found the SDKs and dashboards reach 33
more functions and 25 tables beyond them. The two differ on purpose and are not reconciled into one
list: the manifest is the protocol's own contract, and the governed set is every relation and
function a release actually touches.

`scripts/generate-sql-catalogues.ts` derives the set from the readers rather than from a hand list,
so a new read governs its target on the next generate:

- The manifest's statement catalogue, which is the SQL all seven SDKs send. `assertNoInlineTypeScriptSql`
  and the Python binding check keep it the only source of SDK statements.
- The three dashboard backends, `typescript/dashboard-server/src/server`, `go/dashboard`, and
  `python/src/workhorse/dashboard`, each of which builds its own SQL.
- Every `dashboard_*_v1` view, plus `dashboard_task_result_v1`, whose exact columns
  [`architecture/dashboard.md`](architecture/dashboard.md#dashboard-package-boundary) publishes as core's relational read contract. They are
  governed whether or not this repository's own backends still read them.

A view is governed whole, because its projection is the contract. A table is governed one column at
a time, by the names the reader that touches it mentions; that over-approximates when two relations
in one statement share a column name, which over-governs an internal column rather than
under-governing a read one. Everything else the schema installs is an internal helper and may change
in any release. `protocol/v1/governed-surface.json` lists both sides, so which is which is a file
rather than a judgement.

### Experimental surface

Nothing is experimental by default. An API is stable unless it appears in the table below, and this
table is the authority — a doc comment marking something experimental without an entry here is a
defect in this table, not an exclusion. An entry is outside every promise above and may change or
disappear in any release.

| Experimental API | Line | Since |
| ---------------- | ---- | ----- |
| _None._          |      |       |

Doc comments mirror this table so a reader sees the exclusion at the call site: an `@experimental`
JSDoc tag in TypeScript, `@experimental` on the first line of a Python docstring, and an
`Experimental:` prefix on a Go doc comment.

### What 1.0.0 changes

1.0.0 is a promise change, not a shape change. It removes nothing: no superseded `_vN` function, no
narrowing of `workhorse.protocol_version`, no export, name, identifier, flag, or telemetry name.
Accumulated removals wait for the first contract step of the 2.x line, which 2.0.0 itself does not
apply; see [Retention and removal](#retention-and-removal). The upgrade from the last 0.x to 1.0.0 is
therefore an ordinary rolling deployment — `workhorse schema migrate` from the pipeline, then a
package bump — and not a release that requires stopping every process.

1.0.0 adds no migration step of its own, so that migrate command reports an already-current schema
and changes nothing. The last 0.x minor carries the final schema change before the boundary. Running
the command anyway is the point: the procedure is the same one every other release uses. See
`docs/schema-lifecycle.md`.

All six lines publish 1.0.0 from one source commit as one release train
([ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md), [ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md)). A line that
cannot clear the parity bar slips the train rather than being left behind. After 1.0.0 the six
lines stay in lockstep, as every release before it does; see [Release train](#release-train) and
[ADR 0106](decisions/0106-keep-the-release-lines-in-lockstep-after-1-0-0.md).

At 1.0.0 the “public beta” label retires and “stable” replaces it.

### Retention and removal

A superseded `_vN` function is retained until a major release has shipped that supersedes it **and**
twelve months have passed since the release that shipped its successor, whichever is later.
Twelve months is chosen so that an operator upgrading on an annual cadence never finds a function
gone between two consecutive upgrades. [ADR 0057](decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)
records the decision.

Retention is not support. Keeping the old function beside the new one costs schema size and nothing
else — no backports and no second implementation to maintain — which is why it is promised on a date.
[`SECURITY.md`](../SECURITY.md) states which released versions receive fixes.

**A major release removes nothing.** Its migrations add, and it keeps serving every protocol its
predecessor served, so a major upgrade is an ordinary rolling deployment. Removal is a separate
**contract step** the new major line ships and the operator applies with `workhorse schema contract`
once their fleet is entirely on the new major. `workhorse schema migrate` stops before it and names
the step it stopped before. `workhorse schema contract` applies nothing without `--yes`: it names
every worker on a retiring protocol that heartbeated inside its lease in
`workhorse.worker_registry`; producers do not register, so that evidence is never proof that no
caller remains, and confirmation is required either way. Every worker reports its client protocol
version, SDK language, and SDK
version at registration, and `workhorse schema status --json` shows the resulting counts under
`fleet` and the pending step under `schema.pendingContractSteps`.

Two consequences are worth stating plainly. `workhorse.protocol_version` is operator state rather
than release state, so two databases at the same schema version may serve different protocol sets.
And a clean install of a major line installs the contracted shape while a database migrated into it
keeps the retained functions until it contracts.

`dashboard_*_v1` views are schema objects under the same rules: a migration may add a column to a
shipped view and may not remove, retype, or reinterpret one, so a core upgrade never requires a
dashboard release inside a major line.

### What must be true before 1.0.0

Six gates hold the tag, and each is met with evidence rather than with an assertion
([ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md)). 1.0.0 ships when the JVM and .NET SDKs
land. The maintainer changed the gates on 2026-10-18, and the amendment of ADR 0056 records the
change.

1. Every governed surface has a mechanical check in the CI `required` task. Twelve checks, one per
   surface: the eleven above, and the C# API with `dotnet-api:check` against `api/dotnet.txt`
   ([ADR 0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)).
2. Each governed surface has its API snapshot and one published 0.x minor that carries its
   artifacts. A second model has written a review of its API. No outside-filed defect against a
   governed surface is open and unaccepted. The six-week quiet period and the two-minor requirement
   do not apply.
3. The migration rehearsals ADR 0055 placed have run. The recovery procedure has run against a
   deliberate mid-migration failure. A fresh host has installed the candidate from the registries of
   all seven SDKs. These include Rust from crates.io, Ruby from RubyGems, the JVM artifacts from
   Maven Central, and the .NET packages from NuGet
   ([ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md),
   [ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md),
   [ADR 0103](decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)).
4. One database has run 30 consecutive days under continuous work without being reinstalled, across
   daily partition rollover, a retention pass that dropped a partition, and an ungraceful worker
   kill with clean recovery.
5. `@stablemates/workhorse-dashboard-server` has a written security review with every High finding
   resolved. No third-party audit has taken place, and `SECURITY.md` says so.
6. `pnpm parity:check` passes and the product operator table carries no Planned cell (WH-581
   named four), and any Absent cell records why it is absent. Every product cell in the JVM and
   .NET columns of [`docs/parity.md`](parity.md) reads Supported, including the embedded dashboard
   backend.

The tag date is derived from those gates rather than announced. The tag lands no earlier than the
latest of four moments:

1. 2026-11-02.
2. The last day of the soak.
3. The day the .NET SDK lands.
4. The day the first minor publishes the JVM and .NET artifacts.

Adoption counts, documentation coverage, and benchmark numbers are recorded at the tag and gate
nothing.

## Protocol and schema compatibility

The durable protocol is the PostgreSQL schema, not the TypeScript API. Its guarantees:

- **The runtime declares a floor; the database declares the ceiling.** A runtime accepts the single
  row in `workhorse.schema_version` when it is at or above `MINIMUM_SCHEMA_VERSION`, and applies no
  upper bound of its own. That floor is the version that introduced the newest schema object the
  release calls, across its statement catalogues and the dashboard host it ships. Thus the
  compatibility check refuses a schema that the release fails on. A process that runs the check at
  startup stops before its first call. A release raises the
  floor when it starts calling something newer, which is why the deployment pipeline migrates
  before any process from the new release starts. A schema that is merely newer still carries every function the runtime
  calls, because inside a major line a migration only adds, so refusing it would make every rolling
  deployment an outage. The ceiling is `workhorse.protocol_version`, where the installed schema
  lists the client protocols it still answers; a contract step drops the ones it stops serving, and
  the compatibility check of an older runtime then refuses the schema. That narrowing is a contract
  step the operator runs, never something a release performs on their behalf, so a mixed fleet
  mid-deploy is supported at every version boundary including a major one. Migration 0025 is the one exception: 0.5.0 ships it
  as a contract step that retires protocols 1 through 4. A database from before 0.5.0 therefore
  crosses it offline, with every worker and producer stopped, as
  [the fast-tier cutover](schema-lifecycle.md#the-fast-tier-cutover) describes.

  See [Retention and removal](#retention-and-removal).

- **Installation is clean-database only; migration owns every upgrade from 0.2.0.** `installSchema`
  refuses to interpret an older or unversioned `workhorse` schema. `migrateSchema` applies ordered,
  immutable, transactional migrations forward from the baseline frozen as `sql/releases/0006.sql`,
  which is schema 6, the 0.2.0 clean install. The supported floor is that baseline: 0.1.x had no
  production install and is not carried forward, so `migrateSchema` refuses a schema below 6 and
  names Workhorse 0.2.1 as the last release that migrates one
  ([ADR 0073](decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)).
  A deployment runs it from a pipeline step before any process from the new release starts; no
  component migrates on start. `docs/schema-lifecycle.md` records the execution contract, the
  expand/contract rollout rules, and the backup and recovery guidance.
- **Correctness-sensitive transitions stay in versioned SQL functions.** Claim, completion, retry,
  cancellation, deadline, and maintenance transitions are owned by SQL. A client that speaks the
  same schema version speaks the same protocol, whatever language it is written in.
- **Task payloads are caller-owned JSON.** Workhorse stores and returns them unchanged. Trace context
  and other Workhorse metadata are kept beside the payload, never merged into it.
- **The dashboard wire contract is versioned separately.** `dashboard/v1` pins the oRPC envelopes,
  HTML placeholders, request order, and procedure schemas used by the TypeScript, Python, Go,
  Rust, Ruby, and JVM backends. Applications should embed a shipped backend rather than call those
  procedures as a public operator API.

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="../site/public/diagrams/schema-compatibility-narrow-dark.png">
  <source media="(max-width: 600px)" srcset="../site/public/diagrams/schema-compatibility-narrow-light.png">
  <source media="(prefers-color-scheme: dark)" srcset="../site/public/diagrams/schema-compatibility-dark.png">
  <img src="../site/public/diagrams/schema-compatibility-light.png" width="960" alt="schemaCompatibilityRefusal tests in this order; the first failed test decides">
</picture>

The TypeScript, Python, Go, Rust, Ruby, and JVM clients and workers implement this protocol. Python
runs the same canonical SQL fixtures and request mapping through Psycopg, plus transaction
integration through Psycopg async and asyncpg. Its synchronous and asynchronous workers share one
lifecycle core; the asynchronous surface uses native Psycopg or asyncpg query and notification
connections. The Go worker supports bounded multi-queue dispatch, fenced ownership, cooperative
cancellation, durable checkpoints, durable timers, and graceful drain. Repository tests compile and
exercise external module consumers before a release can create the module tag. The Rust crate runs
every `protocol/v1` fixture category through `rust/tests/protocol_conformance.rs`, and
`rust/tests/conformance/expected-unsupported.json` lists no exception.

## Release process

Every release is a tag that points to a green public CI commit. Each tag then runs the focused gate
for the distribution being published.

### Release train

Every release publishes the same version from one source commit, in one controlled window, in a
fixed order. The registries are npm, PyPI, the Go module proxy, crates.io, RubyGems, Maven
Central, and nuget.org. Dates go into the changelogs before the
candidate is cut, and a slipped date means a new candidate. The candidate commit is a commit on
`main`, and every tag of the train points to it, so every tag names the candidate commit. Other
commits can land on `main` during the release. Thus the maintainer must create each tag on the
candidate SHA, for example `git tag --annotate vX.Y.Z <sha>`, not on the current tip of `main`.
Nobody may cancel the `main` CI push run of the candidate commit, because each release workflow
requires that run to succeed.

The rule does not change at a major release. If the defect is in one SDK, the fix ships in a
release train like any other release. Each other line publishes the same version with no change, a
version-only release. The changelog of that line states that it has no changes.
[ADR 0106](decisions/0106-keep-the-release-lines-in-lockstep-after-1-0-0.md) records the decision.

The Rust crate and the Ruby gem have no tag of their own. Each rides the npm `v*` tag and publishes
after npm, as [Rust crate](#rust-crate) and [Ruby gem](#ruby-gem) describe. The three JVM artifacts
ride the same tag and publish to Maven Central after npm, as [JVM artifacts](#jvm-artifacts)
describes.

1. Rehearse. The candidate commit's `main` push run must show a green `CI / required`.
   `.github/workflows/release.yml` and `.github/workflows/release-python.yml` are dispatched
   manually with `dry-run` enabled, and every npm and Python archive is downloaded and inspected.
   All ten npm tarballs, the Python wheel, and the Python source distribution are installed in
   clean consumers. The Python dry run's `attestation-rehearsal` job must pass, which proves that
   the attestation files exist and that the pinned uv uploads them. The Go external consumer, the Rust packaged-crate consumer, the Ruby
   packaged-gem consumer, and the JVM consumers of the staged artifacts are built from the same
   commit.
   Test registries are not part of the rehearsal.

   Each dry run must test the candidate SHA. A dispatched run builds the head of the branch that it
   starts on, not a SHA, and other commits can land on `main` after the candidate. A dry run on a
   later commit proves nothing about the candidate. Python publishes first, so a candidate that
   fails the `release.yml` build job after the tag stops the train partly published. Do these
   steps:
   1. Before you dispatch, compare the tip of `main` with the candidate SHA. If they are equal,
      dispatch both dry runs on `main`.
   2. If the tip of `main` moved after the candidate, push a branch that points at the candidate
      SHA, for example `git push origin <sha>:refs/heads/release-candidate-X.Y.Z`. Then dispatch
      both dry runs on that branch. A push to this branch starts no CI run.
   3. When each dry run ends, run `gh run view <run-id> --json headSha`. The `headSha` must equal
      the candidate SHA. If it does not, the dry run does not count. Dispatch it again on a branch
      that points at the candidate SHA.
   4. After the train, delete the candidate branch with
      `git push origin --delete release-candidate-X.Y.Z`.

2. Publish Python first. One distribution is the smallest production test of trusted publishing.
   `pnpm release:verify python` checks its PEP 740 attestations on PyPI before the train continues.
3. Publish npm second. Each package goes after the published packages it requires, so
   `@stablemates/workhorse-dashboard-contract` precedes `@stablemates/workhorse`, and the dashboard
   server precedes the dashboard facade.
   [ADR 0085](decisions/0085-publish-npm-packages-in-dependency-order.md) records this order. Every
   package's provenance is verified. The same run then publishes the Rust crate and the Ruby gem,
   and uploads the three JVM artifacts to Maven Central. Each of these versions is verified on its
   registry before the train continues. The same run also pushes the four .NET packages to
   nuget.org. The run creates the public GitHub release last, after the `crates-io`, `rubygems`,
   `maven-central`, and `nuget` jobs succeed.
4. Publish Go last. The `go/vX.Y.Z` tag is pushed after the gate passes, and the version is
   verified through the public module proxy.

Each verification checks registry visibility, provenance or the module checksum, and installation
of the exact public version in a clean environment. It then runs a minimal enqueue-and-worker smoke
test against a fresh PostgreSQL database. Any failure stops the release train: the defect is filed,
the remaining stages stay blocked, and the fix ships as a new candidate.

The release check stops a candidate that leaves one line behind. In `release.yml`, if the version
of the crate, the gem, the JVM artifacts, or the .NET packages differs from the tag, they skip
publication. The run still succeeds. So the check must refuse the candidate before the first
registry receives it. The check also reads `dotnet/Directory.Build.props`, so it refuses a .NET
version that differs from the tag.

The release check reads no secret. If a `maven-central` secret is missing, the JVM artifacts also
skip publication after npm publishes, and the run still succeeds. `pnpm release:check
<npm|python|go> <tag>` runs the same checks for each tag. `pnpm npm:release-check`,
`pnpm python:release-check`, and `pnpm go:release-check` call it first. It fails, and lists each problem, if one of these is true:

1. A file does not carry the release version. The files are every published `package.json`,
   `typescript/core/src/version.ts`, `python/pyproject.toml`, `python/src/workhorse/_version.py`,
   `python/uv.lock`, `go/version.go`, `rust/Cargo.toml`, `Cargo.lock`,
   `ruby/lib/stablemates/workhorse/version.rb`, each Ruby lockfile, `jvm/gradle.properties`, and
   `dotnet/Directory.Build.props`.
2. A peer range on a published package does not cover the release. For a `0.x` release, the range
   is the release's minor line. From the first major release, the range is its major line. The
   check reads every published `package.json` and `dashboard/app/package.json`.
3. An `install` command in `support.json` names another version.
4. A changelog has no `## X.Y.Z` entry for the release. The changelogs are `CHANGELOG.md`,
   `python/CHANGELOG.md`, `go/CHANGELOG.md`, `rust/CHANGELOG.md`, `ruby/CHANGELOG.md`,
   `jvm/CHANGELOG.md`, `dotnet/CHANGELOG.md`, and the changelog of each published npm package that
   has one.
5. The release is a minor or major release, and `sql/releases/<NNNN>.sql` does not exist for
   `WORKHORSE_SCHEMA_VERSION`. The first major release adds no migration, so the last `0.x` minor
   already froze its artifact.

The Python files and `python/CHANGELOG.md` use the PEP 440 spelling of a prerelease, and the other
files use the SemVer spelling. The check changes no publication step of a workflow.

`pnpm release:verify <python|npm|crate|go|maven|nuget> X.Y.Z` holds the version checks as exact commands and
the output each must print. After each stage publishes, the handoff runs that stage's target
instead of restating commands. Each target installs the public version into a fresh scratch
directory:

- `python` installs `stablemates-workhorse==X.Y.Z` into a virtual environment on the oldest
  supported Python. It checks both `workhorse.__version__` and the installed distribution metadata.
  It then reads PyPI's integrity API for every file of the release. Each file needs an attestation
  bundle whose publisher is `stablemates/workhorse` `release-python.yml`.
- `npm` checks every published package's version, then installs `@stablemates/workhorse` and runs
  `npm audit signatures` and `workhorse --version`.
- `crate` resolves `workhorse = "=X.Y.Z"` from crates.io and checks the locked package ID.
- `go` resolves the module through `proxy.golang.org` with no direct fallback and runs
  `go mod verify`.
- `maven` builds the Java consumer of `run.workhorse:workhorse` and the Kotlin consumer of
  `run.workhorse:workhorse-kotlin` from `jvm/release-consumer` against Maven Central. Each
  consumer runs one task in the database that `WORKHORSE_VERIFY_DATABASE_URL` names, and checks
  that it succeeded. That database must have the Workhorse schema. Each consumer prints the file
  name of the jar it loaded, which must name the version, and the id of the task.
- `nuget` restores `dotnet/release-consumer` with the four .NET packages from nuget.org into an
  empty package folder, with no HTTP cache. Each package must come from nuget.org. The consumer
  prints the version of each package assembly. It then runs one task in the database that
  `WORKHORSE_VERIFY_DATABASE_URL` names, and checks that it succeeded.

The script covers registry visibility, signatures or checksums, and clean installation. It also
covers PyPI provenance. The maintainer still reviews provenance on the npm, crates.io, and RubyGems
pages and runs the enqueue-and-worker smoke test.

Every release check also runs its target before anything is tagged or published. Each rehearsal
substitutes the artifact about to ship for the registry release:

- `--wheel <file>` installs the dry-run wheel. It skips the PyPI provenance check, which only the
  registry can answer. The attestation rehearsal covers that path before the tag.
- `--tarballs <directory>` installs all ten packed tarballs and checks each installed version.
  It skips `npm view` and `npm audit signatures`, which only the registry can answer.
- `--crate <directory>` depends on the unpacked `.crate` archive by path and checks its package ID.
- `--go-proxy <directory>` serves a file module proxy ahead of `proxy.golang.org`. It skips the
  checksum database for this module only, which has never seen the unpublished version, and uses a
  scratch module cache.
- `--maven-repo <directory>` makes the consumers take `run.workhorse` only from the staging
  directory that `pnpm jvm:package-check` writes. They take every other module from Maven Central.
- `--nuget-feed <directory>` makes the .NET consumer take the four packages only from the packed
  files that `pnpm dotnet:package-check` writes. It takes every other package from nuget.org.

A check the artifact cannot satisfy therefore fails the rehearsal, not the train after the tag.

A published version is never reused. An ordinary defect stays available and receives a higher
fix. A security, secret, privacy, or legal exposure triggers credential rotation and removal where
the registry permits it. The response also deprecates the npm release, yanks the PyPI release, or
retracts the Go version as appropriate, and yanks the crates.io and RubyGems versions. Removal does not make prior
public access reversible. Maven Central never deletes a published version, so a defective JVM
version stays available. A higher fixed version replaces it, and a published advisory names it.
[`SECURITY.md`](../SECURITY.md) states how to report a vulnerability privately and which versions
receive fixes.

The first public beta did not run this way: fix-forwards spread it across three source commits.
The dated entries in [`CHANGELOG.md`](../CHANGELOG.md),
[`python/CHANGELOG.md`](../python/CHANGELOG.md), and [`go/CHANGELOG.md`](../go/CHANGELOG.md) name
those commits.
The Ruby gem keeps its own [`ruby/CHANGELOG.md`](../ruby/CHANGELOG.md), which the
[Ruby gem](#ruby-gem) checklist bumps with every release. The three JVM artifacts keep one
[`jvm/CHANGELOG.md`](../jvm/CHANGELOG.md), which the [JVM artifacts](#jvm-artifacts) checklist bumps
with every release.
The four .NET packages keep one [`dotnet/CHANGELOG.md`](../dotnet/CHANGELOG.md). The release
candidate moves its `## Unreleased` entries under a `## X.Y.Z` heading, as for the JVM artifacts.
For the first release, the candidate also removes `unpublished` from the .NET line in
`site/lib/releases.ts`.

### npm packages

1. Update all TypeScript package versions in lockstep and add the `CHANGELOG.md` entry for the release,
   including upgrade notes for any breaking change.
2. Tag the candidate SHA with `git tag --annotate vX.Y.Z <sha>`, then push the tag. The workflow
   requires a successful `main` CI push run for that commit. It refuses a tag that fails the
   [release check](#release-train) for any line.
3. `pnpm npm:release-check` validates generated package assets, lint, dependencies, types, and unit
   behavior. It builds every tarball once, then installs and exercises those exact files in clean
   consumers against PostgreSQL. It then runs `pnpm release:verify npm` against those tarballs, so
   a post-publish check the packages cannot satisfy fails before anything is published.
4. The build job uploads the unchanged tarballs without publication credentials. It runs on Depot
   like the rest of CI; the publish task that follows does not. npm verifies the Sigstore provenance
   bundle against the runner environment and rejects anything it reads as `self-hosted`, which is
   how it classifies a Depot runner, so the publish task runs GitHub-hosted. That is the only task in
   the repository that does.
5. The protected `npm` environment requires approval. `scripts/publish-npm.ts` then confirms that
   this runner can authenticate at all, and checks every target version against the registry,
   before it writes anything. It publishes each package with `npm publish --provenance`, which
   exchanges the job's OIDC identity for the credential that write uses. `@stablemates/workhorse`
   goes first because the other packages declare it as a peer. A failure partway through prints the
   ledger described in
   [Recovering a partially published release](#recovering-a-partially-published-release).

**Provenance.** Every published tarball carries an npm provenance attestation linking it to this
repository, the commit it was built from, and the workflow that built it. Verify a downloaded
release with `npm audit signatures` in a project that depends on it, or inspect the "Provenance"
section on the package's npm page. A release without an attestation did not come from this
pipeline.

### Python distribution

1. Update `python/pyproject.toml` and add the same version to `python/CHANGELOG.md`.
2. Tag the candidate SHA with `git tag --annotate python/vX.Y.Z <sha>`, then push the tag. The
   workflow requires a successful `main` CI push run for that commit.
3. `pnpm python:release-check` runs the [release check](#release-train). It rebuilds the embedded
   dashboard bundle, checks Python format, lint, types, and dependencies, then runs every Python
   test against PostgreSQL. It builds the wheel and source distribution once and tests those exact
   files.
   It then runs `pnpm release:verify python` against that wheel, so a post-publish check the
   package cannot satisfy fails the rehearsal before `python/vX.Y.Z` is tagged.
4. The `attestation-rehearsal` job runs on every run, dry runs included, without the `pypi`
   environment. It generates PEP 740 attestations for the unchanged artifacts with the publish
   job's action and uv. `scripts/check-attestation-upload.ts` then runs `uv publish` against a
   loopback endpoint. It fails unless every distribution arrives with its attestation. `uv publish`
   uploads attestations only from uv 0.9.12, and an older uv still exits 0. That is how 0.6.0
   reached PyPI without provenance.
5. After the rehearsal passes, the `pypi` environment generates attestations again and publishes
   both distributions and their attestations through trusted publishing.
6. `pnpm release:verify python X.Y.Z` fails unless PyPI shows an attestation for every file.

`workhorse.__version__` is public Python API from the release after 0.4.0, and `api/python.txt`
records it. The post-publish Python check therefore fails against 0.4.0, which predates the
attribute. For 0.4.0, `importlib.metadata.version("stablemates-workhorse")` is the check.

### Go module

1. Add the intended version to `go/CHANGELOG.md`. Then re-pin the Go API baseline:
   1. Fetch the tags with `git fetch origin --tags`.
   2. Run `pnpm go-api:generate`. It pins `api/go.txt` to the newest `go/v*` tag and lists only
      the breaks since that tag. Without this step, `pnpm go-api:check` compares the module with an
      older release, and a new break is hard to see in review.
   3. Commit `go/CHANGELOG.md` and `api/go.txt` with the release candidate.
2. Fetch origin. Then check out the candidate commit in a clean worktree with
   `git switch --detach <sha>`. Do not use the current tip of `main`, because other commits can
   land on `main` during the release.
3. Run `scripts/release-go.sh X.Y.Z` from that checkout. Before the long checks, the script fetches
   `main` from origin. It refuses to continue in these conditions, and names the tag or commit:
   1. The version has no PEP 440 spelling for the Python tag.
   2. The worktree is not clean.
   3. `HEAD` is not an ancestor of `origin/main`.
   4. `vX.Y.Z` or `python/vX.Y.Z` does not exist on origin. The Python tag uses the PEP 440
      spelling of a prerelease.
   5. One of those tags points to a commit other than `HEAD`. The script peels an annotated tag to
      its commit.
   6. `go/vX.Y.Z` already exists locally or on origin.
4. The script runs `pnpm go:release-check X.Y.Z`, which runs the [release check](#release-train).
   Next, it stages a file module proxy that serves `HEAD:go` as `vX.Y.Z`. It then runs
   `pnpm release:verify go` against that proxy, so a post-publish check the module cannot satisfy
   fails before the tag.
5. The script asks GitHub with `gh api` for a successful run of the `CI` workflow on `main` for
   exactly `HEAD`, with the `push` event. A push run executes every CI job, and ADR 0043 and ADR 0102
   make it the release gate. The query names the github.com repository of the `origin` URL, so
   `GH_REPO` cannot change it.
   1. If such a run exists, the script prints its URL. It then runs only `pnpm go:test` and
      `pnpm go:vuln`.
   2. If no such run exists, the script runs the full `pnpm check`. A canceled, failed, or
      unfinished run does not count. The script also runs the full check in these conditions:
      `gh` is missing or fails, `origin` is not one github.com URL, or `origin` has a different or
      a second push URL.
6. The script creates `go/vX.Y.Z` on `HEAD`, and pushes the tag only after the gate passes.

### Rust crate

The Rust SDK publishes one crate, `workhorse`, from `rust/`
([ADR 0074](decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md)). It has no tag of its
own and publishes from the npm `v*` tag. The crate joined the release train at `0.4.0`. Before that
release, crates.io held only the `0.0.0` placeholder that reserved the name.

1. Set `version` in `rust/Cargo.toml` to the release version and commit it with the candidate.
2. Use the `vX.Y.Z` tag that the [npm packages](#npm-packages) step creates on the candidate SHA.
   Do not create another tag. The build job of `.github/workflows/release.yml` runs
   `pnpm rust:release-check`. It packages the crate with verification and builds a clean consumer
   from the packaged archive. With PostgreSQL available, that consumer enqueues one task. It then
   runs `pnpm release:verify crate` against the unpacked archive, so a post-publish check the
   crate cannot satisfy fails before anything is published.
3. After npm publishes, the `crates-io` job compares the crate version with the tag. A mismatch
   writes a notice and publishes nothing, so a release that leaves the crate behind still succeeds.
   The [release check](#release-train) in the build job refuses that tag before npm publishes.
4. On a match, the job packages the crate with `cargo package`. `scripts/check-registry-version.ts`
   then asks crates.io for the version. If crates.io serves it with the SHA-256 checksum of the
   packaged crate, the job uploads nothing and succeeds. If the checksum differs, the job fails. Thus
   a re-run finishes after an earlier run uploaded the crate, as
   [Re-run a failed crates-io or rubygems job](#re-run-a-failed-crates-io-or-rubygems-job) states.
5. If crates.io does not serve the version, the job exchanges its OIDC identity for a crates.io
   token and runs `cargo publish --package workhorse --locked`, which verifies the package again
   before the upload.

The job can publish only after a crate owner registers the workflow on crates.io:

1. Sign in to crates.io as an owner of `workhorse` and open workhorse → Settings → Trusted Publishing.
2. Add a GitHub publisher with owner `stablemates`, repository `workhorse`, and workflow filename
   `release.yml`.
3. Enter the environment `crates-io`. The field is optional, but it makes crates.io refuse a token
   to any job outside that environment. Protect the `crates-io` environment on GitHub with required
   reviewers, as `npm` and `pypi` are.

`skyeagle` (Anton Orel) is the only owner. An owner adds another in workhorse → Settings → Owners,
or with `cargo owner --add <github-login> workhorse` using a token that carries the
`change-owners` scope. crates.io sends the new owner an invitation, and ownership starts when they
accept it.

### Ruby gem

The Ruby SDK publishes one gem, `stablemates-workhorse`, from `ruby/`
([ADR 0075](decisions/0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md)). Like the
crate, it has no tag of its own and publishes from the npm `v*` tag. It joined the release train at
0.6.0, its first release.

1. Set `VERSION` in `ruby/lib/stablemates/workhorse/version.rb` to the release version. Move the
   `## Unreleased` entries of `ruby/CHANGELOG.md` under a `## X.Y.Z` heading, and commit both with
   the candidate.
2. Use the `vX.Y.Z` tag that the [npm packages](#npm-packages) step creates on the candidate SHA.
   Do not create another tag. The build job of `.github/workflows/release.yml` runs
   `pnpm ruby:release-check`.
   It runs the Ruby gates, then builds the `.gem` once with `gem build --strict`. It installs that
   archive into an empty gem home and runs a clean consumer project without Bundler. With PostgreSQL
   available, that consumer enqueues one task and runs it through a worker.
3. After npm publishes, the `rubygems` job compares the gem version with the tag. A mismatch writes a
   notice and publishes nothing, so a release that leaves the gem behind still succeeds.
   The [release check](#release-train) in the build job refuses that tag before npm publishes.
4. On a match, the job builds the gem with `gem build`. `scripts/check-registry-version.ts` then
   asks RubyGems.org for the version. If RubyGems.org serves it with the SHA-256 checksum of the
   built gem, the job uploads nothing and succeeds. If the checksum differs, the job fails. Thus a
   re-run finishes after an earlier run pushed the gem, as
   [Re-run a failed crates-io or rubygems job](#re-run-a-failed-crates-io-or-rubygems-job) states.
5. If RubyGems.org does not serve the version, `rubygems/release-gem` exchanges the job's OIDC
   identity for a RubyGems API key and runs `rake release` in `ruby/`. That task builds the gem and
   pushes it with a Sigstore attestation. It finds the train tag already in place, so it pushes no
   tag. The action then waits until RubyGems.org serves the new version.
6. Verify the public version with `gem install stablemates-workhorse -v X.Y.Z` in an empty gem home,
   and review the attestation on the gem's RubyGems.org page.

Both jobs install the locked bundle beside the release credentials. A frozen bundle pins each gem
version, and the `CHECKSUMS` section of each committed Ruby lockfile pins that version's bytes.
Bundler compares every downloaded gem with its SHA-256 digest and refuses a mismatch.
`scripts/ruby-lockfile-checksums.test.ts` fails when a lockfile resolves a gem without a checksum,
or when CI, the release workflow, or a hook disables the comparison. After changing a Gemfile,
regenerate the lockfile with the pinned Bundler, which keeps the section current.

A maintainer set up publication on 2026-09-30 with these steps. Nothing in this repository performs
them.

1. Reserve the name. The maintainer took the placeholder route and pushed `stablemates-workhorse`
   `0.0.0` by hand. The placeholder is not a release, and the first release supersedes it. The other
   route, a pending trusted publisher, reserves nothing until the first release publishes within
   its 12-hour expiry.
2. Choose the owners. The maintainer is the only owner for now. An owner adds another with
   `gem owner stablemates-workhorse --add <email>` or in the gem's settings on RubyGems.org.
3. Register the trusted publisher on the gem: owner `stablemates`, repository `workhorse`, workflow
   filename `release.yml`, and environment `rubygems`. The maintainer registered it. RubyGems.org
   does not publish trusted publishers, so only an owner can check it.
4. Create the `rubygems` environment on GitHub with required reviewers and a policy that admits only
   the `v*` tags, as `npm`, `pypi`, and `crates-io` have. Turn off administrator bypass. The
   environment exists with these settings.

The gem's `rubygems_mfa_required` metadata does not block this job. RubyGems.org accepts a push with
a trusted publisher's API key without an OTP.
[ADR 0075](decisions/0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md) also makes the
Ruby competitor benchmark a release gate. That gate has to pass before the first release publishes the
gem.

### JVM artifacts

The JVM SDK publishes three artifacts to Maven Central from `jvm/`: `run.workhorse:workhorse`,
`run.workhorse:workhorse-kotlin`, and `run.workhorse:workhorse-spring-boot-starter`
([ADR 0103](decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)).
The three always carry one version. Like the crate and the gem, they have no tag of their own and
publish from the npm `v*` tag. The first version that Maven Central serves is `0.9.0`. The
maintainer steps at the end of this section came before that first publish.

A Gradle build adds the core with `implementation("run.workhorse:workhorse:0.10.0")`. A Maven
build adds
`<dependency><groupId>run.workhorse</groupId><artifactId>workhorse</artifactId><version>0.10.0</version></dependency>`.
For the Kotlin module or the starter, replace the artifact ID with `workhorse-kotlin` or
`workhorse-spring-boot-starter`. `support.json` states the two commands as `install.gradle` and
`install.maven`.

The core has two optional dependencies, the OpenTelemetry API and the Jakarta Servlet API. Its POM
marks each one `<optional>true</optional>`, so Maven does not add it. Its Gradle module metadata
puts each one in a feature variant, so Gradle adds it only when the build asks for the feature,
for example `requireFeature("opentelemetry")` or `requireFeature("servlet")`.

1. Set `version` in `jvm/gradle.properties` to the release version. Move the `## Unreleased`
   entries of `jvm/CHANGELOG.md` under a `## X.Y.Z` heading, and commit both with the candidate.
   For the first release, also remove `unpublished` from the JVM line in `site/lib/releases.ts`,
   because the site build refuses an unpublished line whose changelog records a release.
2. Use the `vX.Y.Z` tag that the [npm packages](#npm-packages) step creates on the candidate SHA.
   Do not create another tag. The build job of `.github/workflows/release.yml` runs
   `pnpm jvm:release-check`. It runs the JVM gates, then `pnpm jvm:package-check`, the dry run:
   1. Gradle writes the three artifacts, with `-sources.jar`, `-javadoc.jar`, and checksums, to
      `jvm/build/staging-deploy`. A throwaway key that the check generates signs every file. The
      throwaway key has the shape of the release key: an ed25519 primary key that signs, with no
      subkey. Thus each dry run tests the signature path of the release.
   2. The check refuses a module other than the three artifacts, a version other than
      `jvm/gradle.properties`, a missing file, signature, or checksum, and a POM without the
      metadata that Central requires. It also refuses a `-javadoc.jar` without an `index.html`.
      The `workhorse-kotlin` module has no Java sources, so its `-javadoc.jar` holds the Dokka HTML
      of its KDoc.
   3. It builds a Java, a Kotlin, and a Spring Boot consumer from the staging directory. With
      PostgreSQL available, each consumer enqueues one task and runs it. It then runs
      `pnpm release:verify maven` against the staging directory.
      The dry run uploads nothing and reads no secret. The CI `jvm` job runs it on the Java floor on
      every change.
3. After npm publishes, the `maven-central` job compares the version in `jvm/gradle.properties`
   with the tag. A mismatch writes a notice and publishes nothing. The job also writes a notice and
   publishes nothing while one of the four secrets of the `maven-central` environment is missing.
   The [release check](#release-train) in the build job refuses a mismatched tag before npm
   publishes.
4. On a match, the job stages and signs the artifacts with the release key, and runs the same
   checks. It refuses a version that differs from the tag, and a signing key whose fingerprint is
   not the one that [Publication credentials](#publication-credentials) states. It then zips the
   staging directory without `maven-metadata.xml` files.
5. A second step gets no secret. It runs the Java, Kotlin, and Spring Boot consumers and
   `pnpm release:verify maven` from the same staging directory, with
   `pnpm jvm:package-check --consumers-only`. Thus the stage uploads the jars that its consumers
   ran, not a second build.
6. `scripts/upload-maven-central.ts` first asks the Central Publisher Portal whether Maven Central
   has each of the three artifacts at the version. If Maven Central has all three, the script
   uploads nothing and the `maven-central` job succeeds. This lets a re-run finish after a late
   publish. If Maven Central has some of the three but not all, the `maven-central` job fails and
   uploads nothing. If it has none, the script uploads the bundle to the Portal with
   `publishingType=AUTOMATIC`. The Portal validates the deployment and, if it passes, publishes it
   to Maven Central. No person selects Publish in the Portal. The job waits until the Portal
   reports the deployment as `PUBLISHED`. It fails if the Portal reports `FAILED` or a state that
   the Portal API does not document. It also fails if the deployment is not `PUBLISHED` after 60
   minutes. The script retries a status request that fails with a network error, HTTP 429, or
   HTTP 5xx, and fails after five such failures in a row.
7. Verify the public version with `pnpm release:verify maven X.Y.Z`. Set
   `WORKHORSE_VERIFY_DATABASE_URL` to a database with the Workhorse schema first.
   `repo1.maven.org` can serve the version some minutes after the Portal reports `PUBLISHED`.

Maven Central never deletes a published version. Thus the person who approves the `maven-central`
environment is the human check before a version becomes permanent. After that approval, three
checks stop a defective bundle before the Portal publishes it: the release check of the build job,
the release consumers on the bytes of the bundle, and the Portal validation. For 0.9.0 and 0.10.0
the stage used `publishingType=USER_MANAGED`, and the maintainer selected Publish in the Portal.
Both releases were clean, so SM-1837 changed the stage to `AUTOMATIC`.

The `github-release` job waits for the `maven-central` job. A failed upload, a failed validation, a
failed publish, or a publish that did not end in 60 minutes therefore ends the run before the GitHub
release exists.
[Recover from a failed Maven Central upload](#recover-from-a-failed-maven-central-upload) states
what to do then.

A maintainer did these steps before the first publish, and SM-1384 records them. Nothing in this
repository performs them.

1. Verify the namespace `run.workhorse` in the Central Portal with a DNS TXT record on the domain
   `workhorse.run`.
2. Generate a Portal user token.
3. Generate an OpenPGP key for signing only, and publish its public key to `keyserver.ubuntu.com`
   and `keys.openpgp.org`.
4. Create the `maven-central` environment on GitHub with a required reviewer and a policy that
   admits only the `v*` tags, as `rubygems` has. Turn off administrator bypass. Do this before
   step 5. A tag that runs the job before the environment exists makes GitHub create the
   environment without protection.
5. Add the four environment secrets: `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
   `MAVEN_SIGNING_KEY`, and `MAVEN_SIGNING_PASSWORD`. [Publication credentials](#publication-credentials)
   describes each one.

### .NET packages

The .NET SDK has four packages for nuget.org: `Workhorse`, `Workhorse.Hosting`,
`Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`
([ADR 0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)).
The four always carry one version, the train version that `dotnet/Directory.Build.props` sets. Like
the crate, the gem, and the JVM artifacts, they have no tag of their own and publish from the npm
`v*` tag. nuget.org serves them from `0.10.0`. The `nuget` job of `.github/workflows/release.yml`
publishes them from each `v*` tag that has the version of `dotnet/Directory.Build.props`.

`pnpm dotnet:package-check` is the dry run. It publishes nothing and reads no secret. The CI
`dotnet` job runs it on the first entry of its matrix on every .NET change.

1. `dotnet pack` of `dotnet/Workhorse.slnx` writes the four packages and their `.snupkg` symbol
   packages after a full build with `ContinuousIntegrationBuild`. Each other project sets
   `IsPackable` to `false`, so the demo worker, the tools, the consumers, and the tests pack nothing.
2. Package validation runs in the pack. Before the first publish, nuget.org has no version of the
   packages, so validation checks each package against its own target framework. After the first
   publish, the check sets `PackageValidationBaselineVersion` to the newest published version below
   the train version, and validation fails on a breaking change from it. The check refuses the
   packages if their newest published versions differ.
3. The check refuses a file other than the four packages and their symbol packages, and a version
   other than the train version or the `--tag` version. It also refuses a dependency on another
   Workhorse package at another version. Each nuspec must have the license expression `Apache-2.0`,
   the README `dotnet/PACKAGE.md`, the project URL, and the repository URL and the commit of the
   build. Each PDB must have a SourceLink map to that commit and no path in the checkout.
4. The check runs `pnpm release:verify nuget` with `--nuget-feed` and the packed files, in a scratch
   database. The hosted worker of `Workhorse.Hosting` runs the task of the consumer, and the check
   reads the task back. Without PostgreSQL, the check skips the consumer.

`pnpm dotnet:release-check` runs `pnpm dotnet:lint`, `pnpm dotnet-api:check`, `pnpm dotnet:vuln`,
and then the dry run.

The `nuget` job runs in the protected `nuget` environment. No step starts until the required
reviewer of that environment approves the run. The version check is a step, so each `v*` run waits
for the reviewer, even a run that pushes nothing. After npm publishes and the reviewer approves, the
`nuget` job works in this sequence:

1. It compares the version in `dotnet/Directory.Build.props` with the tag. A mismatch writes a
   notice and publishes nothing. The job also writes a notice and publishes nothing while the
   `nuget` environment has no `NUGET_USER` secret.
2. It runs `pnpm dotnet:package-check` with the tag, and keeps the packages that the consumer ran.
3. `NuGet/login` exchanges the OIDC identity of the `nuget` job for a nuget.org API key that is valid for
   one hour. nuget.org mints it only for the trusted publishing policy of this repository,
   `release.yml`, and the `nuget` environment. The repository stores no key.
4. `dotnet nuget push --skip-duplicate` pushes `Workhorse` first and then the other three packages.
   Each push also sends the symbol package. nuget.org signs each package, so the `nuget` job adds no
   author signature.
5. Verify the public version with `pnpm release:verify nuget X.Y.Z`. Set
   `WORKHORSE_VERIFY_DATABASE_URL` to a database with the Workhorse schema first.

nuget.org never deletes a published version. It can only unlist one. The required reviewer of the
`nuget` environment is therefore the person between the push and a permanent version.

The `github-release` job needs the `nuget` job, so the GitHub release announces a version only after
nuget.org has the packages. A version mismatch or a missing `NUGET_USER` secret ends the `nuget` job
with success, so the GitHub release still appears. If the reviewer rejects the run, the `nuget` job
fails, and the GitHub release does not appear. SM-1441 records the maintainer setup: the
nuget.org organization `stablemates`, the prefix `Workhorse.*`, the trusted publishing policy, and
the protected `nuget` environment with the `NUGET_USER` secret. Nothing in this repository performs
it.

### Release tags

Each tag prefix publishes a fixed set of packages:

| Tag         | Publishes                                                                                     | Workflow                                |
| ----------- | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| `v*`        | The ten npm packages, the crate, the gem, the three JVM artifacts, and the four .NET packages | `.github/workflows/release.yml`         |
| `python/v*` | The PyPI distribution                                                                         | `.github/workflows/release-python.yml`  |
| `go/v*`     | The Go module, through the module proxy                                                       | None; `scripts/release-go.sh` pushes it |

Two repository tag rulesets cover `refs/tags/v*`, `refs/tags/python/v*`, and `refs/tags/go/v*`.

- "Protect release tags" (ruleset 21888197) restricts creation to organization administrators. The
  `OrganizationAdmin` role is its only bypass actor.
- "Lock release tags" (ruleset 24047194) blocks update, deletion, and non-fast-forward pushes. It has
  no bypass actor, so a published tag cannot move or disappear.

The Ruby gem, the JVM artifacts, and the .NET packages publish from `v*`, which both rulesets
already cover. If one of them ever moves to a different tag prefix, add that prefix to both
rulesets in the same change.

The public repository requires pull requests and `CI / required` on `main`. Outside collaborators
require workflow approval. The protected `npm`, `pypi`, `crates-io`, `rubygems`, `maven-central`,
and `nuget` environments require review, and all six prevent administrator bypass. The
repository has one maintainer. That maintainer is the only required reviewer of each environment,
and can approve a run of their own tag. Thus the review is a second step of that maintainer, not a
check by a second person.

### Publication credentials

Six of the seven registries hold no credential that this repository stores, and none of those six
holds one that can expire. Maven Central is the exception, as the last paragraph of this section
describes.

npm publication uses trusted publishing. `npm publish` exchanges the publish job's GitHub Actions
OIDC identity for a short-lived registry credential, and npm mints it only for the trusted publisher
each package names: this repository and `.github/workflows/release.yml`. Those two names are the
credential. Renaming the workflow file or the repository breaks publication until a maintainer
updates every `@stablemates/workhorse*` package on npmjs.com, so a maintainer who changes one of
them updates npm in the same change. The exchange needs npm 11.5.1 or later, which is why the
publish job runs Node 24.

That exchange happens inside `npm publish`, so nothing before it can prove the credential works.
`scripts/publish-npm.ts` checks the two conditions the exchange needs instead: the runner's npm
version, and the OIDC identity GitHub offers only to a job holding `id-token: write`. Both are
readable before the first write, and each failure names what to fix.

PyPI publication stores no credential. The `pypi` environment mints a short-lived token through
trusted publishing, and PyPI issues that token only for this repository, this workflow file, and
this environment name. Nothing expires, so nothing needs rotating. Those three names are the
credential instead. Renaming `.github/workflows/release-python.yml`, renaming the `pypi`
environment, or renaming the repository breaks publication until someone updates the trusted
publisher on PyPI. A maintainer who changes one of them updates PyPI in the same change.

crates.io publication stores no credential. `rust-lang/crates-io-auth-action` exchanges the
`crates-io` job's OIDC identity for a short-lived token. crates.io mints that token only for the
trusted publisher registered on the `workhorse` crate: this repository, `release.yml`, and the
`crates-io` environment. The action revokes the token when the job ends. Renaming the workflow
file, the environment, or the repository breaks publication until an owner updates the trusted
publisher on crates.io. The `0.0.0` placeholder was published by hand, because crates.io accepts
a trusted publisher only for a crate that already exists.

RubyGems publication stores no credential. `rubygems/release-gem` exchanges the `rubygems` job's OIDC
identity for a short-lived API key. RubyGems.org mints that key only for the trusted publisher
registered on the `stablemates-workhorse` gem: this repository, `release.yml`, and the `rubygems`
environment. Renaming the workflow file, the environment, or the repository breaks publication until
an owner updates the trusted publisher on RubyGems.org.

nuget.org publication stores no credential. `NuGet/login` exchanges the `nuget` job's OIDC identity
for an API key that is valid for one hour. nuget.org mints that key only for the trusted publishing
policy of the `stablemates` organization: this repository, `release.yml`, and the `nuget`
environment. The `NUGET_USER` secret of the `nuget` environment holds the nuget.org profile name
that `NuGet/login` sends with the exchange. It is a user name, not a credential, and it does not
expire. Renaming the workflow file, the environment, or the repository stops publication until an
owner updates the trusted publishing policy on nuget.org.

The Go module proxy needs no credential at all. `scripts/release-go.sh` pushes a tag, and the proxy
serves what the public repository already holds.

Maven Central has no trusted publishing, so its stage reads four GitHub Actions secrets of the
`maven-central` environment. `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD` are the Central
Portal user token. `MAVEN_SIGNING_KEY` is the ASCII-armored private OpenPGP key, and
`MAVEN_SIGNING_PASSWORD` is its passphrase. Only the step that signs receives the key, and only the
step that uploads receives the token. The token and the key do not expire by themselves, so the
maintainer rotates them: generate a new token in the Portal, or a new key, and replace the secret.
A new signing key must be on a public key server before the next release.

The release key is an ed25519 primary key that signs, with no subkey. Its fingerprint is
`B933E2F16C3FA58E5414849A024210DB67A17773`. Use this fingerprint to check a `.asc` file of a
`run.workhorse` artifact on Maven Central. `releaseKeyFingerprint` in
`scripts/check-jvm-release.ts` pins the same value, and the `maven-central` job refuses a signing
key with another fingerprint. To rotate the key, change both values in the change that the new
key signs. The check imports only the public part of the key to verify the signatures, so no
GnuPG home on the runner holds the secret key.

### Recovering a partially published release

npm publishes one package at a time. Ten packages cannot be published atomically, so a failure in
the middle leaves some at the new version and the rest at the old one.

npm's immutable unit is the name@version pair. npm refuses a pair that has ever existed, so the
packages that did publish keep this version permanently. Unpublishing is available only within 72
hours, and only while nothing depends on the version, so it is not a recovery plan.

The packages that published stay installable. `scripts/packages.ts` orders the train so each package
follows the published packages it requires. A stopped run therefore never leaves a package that
needs one it skipped.

The publish step reports the split. It names every package npm confirmed, every package it never
attempted, and the version each one carries. It reports the package that failed as unknown, because
npm can store an upload and still fail before it confirms it. The next run's preflight reads the
registry and settles that package. The report goes to the task log and to the run summary. Read that
report. Do not infer registry state from whichever npm command logged last.

Recover by re-cutting the whole train at the next patch version. That is this project's policy, not
npm's constraint: npm would still accept the packages that did not publish at this version.
Completing a partial train from the same commit is not an allowed recovery. `pnpm npm:publish`
refuses to resume a version the registry partly holds, and no other path publishes npm packages.
[ADR 0050](decisions/0050-release-0-1-0-without-a-prerelease-suffix.md) requires one version across
the seven registries, so every package moves, not only the ones that failed. The packages that did
publish stay published, because removal is unavailable and would break anyone who installed them.
Deprecate each with `npm deprecate <name>@<version>` so an installer is pointed at the version that
replaces it.

Python has already published by then, because the train publishes PyPI first. That distribution is
not defective, so it stays available and the higher version supersedes it. The Go tag was never
pushed, because the Go stage runs last and a stopped train never reaches it. One version number can
therefore end up complete on PyPI, partial on npm, and absent from the module proxy.

The half-published version is never completed and never reused. Its number is spent. Record what
happened in [`CHANGELOG.md`](../CHANGELOG.md) under the version that replaces it, so a reader who
finds the orphaned packages on npm can tell why they exist.

#### Re-run a failed crates-io or rubygems job

crates.io and RubyGems.org never accept a version twice. The `crates-io` or `rubygems` job can fail
after the registry accepts the upload, for example in the wait step of `rubygems/release-gem` or at
the job timeout. The `github-release` job then does not run.

Re-run the failed job. Its environment asks for a review first. The job builds the crate or the gem
from the tag again, and `scripts/check-registry-version.ts` asks the registry for the version:

1. If the registry does not serve the version, the job uploads the artifact.
2. If the registry serves the version with the SHA-256 checksum of the new build, the job uploads
   nothing and succeeds. `cargo package` and `gem build` make the same bytes from the same tag, so
   this is the case after an upload of an earlier run. The run summary names the checksum.
3. If the registry serves the version with a different checksum, the job fails and uploads nothing.
   The registry has bytes that this tag did not build. Do not re-run the job again. Compare the
   published artifact with a build of the tag before you continue the release.

If a request to the registry fails with a network error, HTTP 429, or HTTP 5xx, the script tries
again, up to five requests in a row. Each other failure stops the job before the upload. The
`github-release` job runs after the re-run, if the other publication jobs of the run succeeded.

A re-run uses the workflow and the scripts of the tag, not of `main`. SM-1860 adds the check before
0.11.0 is tagged, so a re-run of an earlier tag still fails on a published version.

#### Recover from a failed Maven Central upload

The `maven-central` job runs after npm publishes. If it fails after the Central Portal accepted the
bundle, the Portal keeps that deployment. The upload uses `publishingType=AUTOMATIC`, so the Portal
can still publish the deployment after the job ends. The log of the failed run names the deployment
in the line "The Portal accepted deployment". Each line "Deployment ... is" gives a state that the
`maven-central` job read, and the last of these lines gives the last known state.

Do not re-run the `maven-central` job before you know the state of each deployment of the
version. If Maven Central has the version, a re-run uploads nothing. While the Portal still works
on a deployment, a re-run uploads a second deployment, and Maven Central refuses it when the first
publishes. Do these steps:

1. Open <https://central.sonatype.com/publishing/deployments>. Find the deployment by the ID in the
   log. If the log has no line "The Portal accepted deployment", look for a deployment with the name
   `workhorse-jvm-vX.Y.Z` that the Portal created during the failed run. The Portal can accept the
   bundle while the `maven-central` job fails before it reads the ID. If the Portal has no
   deployment of the version, re-run the failed `maven-central` job. The `maven-central`
   environment asks for a review first.
2. If the state is `PENDING`, `VALIDATING`, `VALIDATED`, or `PUBLISHING`, the Portal still works on
   the deployment. Wait, and read the state again. Do not re-run the `maven-central` job in one of
   these states. You cannot drop a deployment in `PUBLISHING`.
3. If the state is `PUBLISHED`, Maven Central has the version permanently. Re-run the failed
   `maven-central` job. The `maven-central` environment asks for a review first. The `maven-central`
   job runs its checks again, finds the three artifacts on Maven Central, and uploads nothing. Then
   the `github-release` job runs, if the `publish`, `crates-io`, `rubygems`, and `nuget` jobs of the
   run succeeded. Run `pnpm release:verify maven X.Y.Z`, as step 7 of
   [JVM artifacts](#jvm-artifacts) describes.

   A re-run uses the workflow and the scripts of the tag, not of `main`. SM-1838 adds the check
   before 0.11.0 is tagged. 0.11.0 is the first tag that uploads with `publishingType=AUTOMATIC`, so
   each such tag has the check. The tags 0.9.0 and 0.10.0 upload with `USER_MANAGED`, so the Portal
   publishes nothing for them without the maintainer.

   If the re-run fails because Maven Central has only some of the three artifacts, do not re-run
   it again. Ask Central Support with the deployment ID.

4. If the state is `FAILED`, read the `errors` of the deployment in the log or in the Portal.

If the errors name a defect of the bundle, for example a missing signature or a POM without the
required metadata, a re-run cannot fix it. The failure is a defect of the candidate, and
[Release train](#release-train) states what to do with a defect. If the errors name no defect of
the bundle, ask Central Support with the deployment ID. Do not drop the deployment before you ask,
because Central Support uses its files. When Central Support confirms that the Portal published
nothing, drop the deployment and re-run the failed `maven-central` job. The `github-release` job
runs after the re-run succeeds.

## Benchmark validation is not the support boundary

Recorded benchmark evidence in [`docs/benchmarks/`](benchmarks/) comes from a single configuration:
one PostgreSQL major, one machine, one storage profile, documented per run in that directory. That
configuration is fixed on purpose, because comparing throughput across machines is meaningless.

The consequence is that the two boundaries are different sizes, and neither implies the other:

- The **support boundary** is the CI matrix above. It says that Workhorse is correct on those
  versions — every invariant, integration, and lifecycle test passes there.
- The **benchmark boundary** is one configuration. It says what throughput and latency were measured
  there, and nothing about any other version or machine.

So a supported version is not automatically a version with published performance numbers, and the
benchmarked configuration is not a statement that other supported versions are slower or faster.
Requirements for making a performance claim at all are in [`benchmarking.md`](benchmarking.md);
until a scenario has a recorded live artifact, no performance claim is made for any version.

## Upgrade from 0.9.x to 0.10.0

0.10.0 lets a producer throttle an enqueue into a fast-tier queue. Its dashboard hosts
read the retention preview through the new `dashboard_retention_preview_v1`. Its workers deregister
through the new `deregister_worker_v2`. Thus the schema floor rises. The upgrade is a rolling
deployment, and a mixed fleet is supported while it runs.

1. Run `workhorse schema migrate`. It applies migrations 0075 through 0087 and leaves the schema at
   version 86.
2. Roll out the new processes in any order.

A 0.9.0 database is at schema version 73. The migrations only add, or change behavior that was an
error:

| Migration                                                               | Schema version | Changes                                                                                                                          |
| ----------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `0075-allow-throttle-on-fast-tier-queues.sql`                           | 74             | `enqueue_throttle_v1` and `enqueue_many_v1` accept throttle on a fast-tier queue                                                 |
| `0076-add-the-dashboard-retention-preview-function.sql`                 | 75             | `dashboard_retention_preview_v1`, which returns the retention preview document                                                   |
| `0077-fence-the-worker-deregistration-by-instance.sql`                  | 76             | `deregister_worker_v2`, which deletes a registry row only for the instance of the caller                                         |
| `0078-copy-the-diagnostic-details-into-hint.sql`                        | 77             | Each P1001 to P1010 error also carries its DETAIL JSON in HINT                                                                   |
| `0079-bound-the-history-partition-lock-waits.sql`                       | 78             | Partition DDL waits at most 250 ms for each lock, and retention and partition preparation run last                               |
| `0080-compare-the-enqueue-fingerprint-instants-as-values.sql`           | 79             | An enqueue fingerprint compares `runAt` and `deadline` as instants, so a replay matches from any session time zone               |
| `0081-bound-the-dense-cron-evaluation.sql`                              | 80             | `cron_occurrences_v1` resolves only the wall-clock times near its window, and its results do not change                          |
| `0082-keep-the-operator-pause-after-a-registry-prune.sql`               | 81             | A registry prune keeps the operator pause of a paused instance, and the same instance gets it back                               |
| `0083-fire-skip-schedules-within-the-supported-delay.sql`               | 82             | A `skip` schedule fires each occurrence inside the supported delay and records the occurrences it skips                          |
| `0084-recheck-terminal-cleanup-references-and-continue-lease-scans.sql` | 83             | Terminal cleanup keeps a task that got a new reference during a batch, and a full expired-lease scan does not space the next one |
| `0085-make-the-day-and-schedule-lock-keys-unambiguous.sql`              | 84             | A history-day lock does not depend on the session DateStyle or time zone, and two schedules do not share an occurrence lock      |
| `0086-report-the-fast-tier-retry-of-an-expired-timeout.sql`             | 85             | A fast-tier attempt timeout that starts another attempt returns its retry state                                                  |
| `0087-show-the-last-schedule-skip-on-the-dashboard.sql`                 | 86             | The dashboard Schedules page shows the last skip of a `skip` schedule                                                            |

The SDK schema floor rises from 73 to 76. Every SDK statement catalogue names
`dashboard_retention_preview_v1`, which schema version 75 adds, and `deregister_worker_v2`, which
schema version 76 adds. Thus the migrations must run before the first new process starts. 0.10.0
freezes `sql/releases/0086.sql`.

If the schema is below version 76, a new dashboard host refuses its requests. A new worker refuses
to start, but a TypeScript worker checks the schema only in `run`, and only without
`sharedHeartbeats: true`. `runOnce` does not check it. The Go, Python, Ruby, Rust, JVM, and .NET
`Queue` and `Admin` refuse each mutation. The TypeScript `Queue` and `Admin` do not check the
schema, so their statements run against the older schema. To get the refusal in a TypeScript
process, call `assertSchemaCompatible` before the first mutation.

Schema version 77 does not raise the floor. Migration 0078 changes only the HINT of the P1001 to
P1010 errors, and DETAIL does not change.

Schema version 78 does not raise the floor. Migration 0079 changes only the bodies of
`prepare_history_partitions_v1`, `retire_history_partitions_v1`, and `run_maintenance_v1`, and no
signature. Every process gets the
bounded partition lock waits when the migration commits.

Migration 0079 changes the row order of `run_maintenance_v1`. The set of phases does not change.
`history_partitions` and the retention phases now come after `worker_registry`, because the DDL
phases must run last so that their parent locks end when the call commits. No SDK reads the rows by
position, so this is a change of behavior and not a breaking change.

Schema version 79 does not raise the floor. Migration 0080 changes the bodies of `enqueue_batch_v1`
and `enqueue_debounce_v1`, and no signature. A replay that the earlier schema rejected only because
of the session time zone now returns the bound task. A fingerprint stored before the migration
still matches an exact replay. Every process gets the new comparison when the migration commits.

Schema version 80 does not raise the floor. Migration 0081 changes only the body of
`cron_occurrences_v1`, and no signature. The occurrences and their order do not change. Every
process gets the bounded evaluation when the migration commits.

Schema version 81 does not raise the floor. Migration 0082 adds the table `worker_pause_tombstone`.
It changes the bodies of `register_worker_v1`, `deregister_worker_v1`, `deregister_worker_v2`,
`set_worker_paused_internal_v1`, and `prune_worker_registry_v1`, and no signature. A worker of any
SDK version gets its kept pause back when it registers again, because the pause comes back in the
return value of `register_worker_v1`. A registration with a long `registry_interval_ms` now stays
for at least three intervals before maintenance prunes it.

Schema version 82 does not raise the floor. Migration 0083 adds the nullable columns
`last_skipped_at`, `last_skipped_count`, and `last_skipped_through` to `schedule_definition`. It
changes only the body of `fire_due_schedules_v2`, and no signature or result shape. A `skip`
schedule now fires each occurrence that is not older than the supported delay,
`GREATEST(60 seconds, 2 × evaluation_window_ms)`, and records the older occurrences it skips. Thus
after a delay inside the supported delay, a `skip` schedule fires occurrences that the earlier
schema skipped. The pass also tries each namespace lock before it reads occurrence history. Every
process of every SDK version gets the new behavior when the migration commits.

Schema version 83 does not raise the floor. Migration 0084 changes only the bodies of
`prune_full_terminal_tasks_internal_v1`, `recover_expired_v1`, and `tick_v1`, and no signature or
result shape. Terminal cleanup now rechecks the references of its locked rows in a second
statement. Thus at read committed, a task that got a dependency during a batch stays, and the rest
of the batch is deleted. The terminal_tasks phase no longer fails with SQLSTATE `23001` there.

A recovery scan that fills its share of the limit no longer spaces the next expired-lease scan.
Every process of every SDK version gets the new behavior when the migration commits.

Schema version 84 does not raise the floor. Migration 0085 changes the bodies of `fire_schedule_v1`,
`fire_due_schedules_v2`, `create_history_day_v1`, `retire_history_day_v1`,
`retire_history_partitions_v1`, and `prepare_history_partitions_v1`, and no signature or result
shape. A history-day lock now gives one day the same lock under every session DateStyle and time
zone. A history partition gets the name of its UTC day under every session time zone. Two schedules
whose namespace or name contains a colon no longer share an occurrence lock, so one no longer defers
the other.

Migration 0085 also renames a history partition that has the name of the wrong UTC day. Only a
calendar day that the session time zone skipped can produce such a name. Every process of every SDK
version gets the new locks when the migration commits.

Schema version 85 does not raise the floor. Migration 0086 changes the body of
`expire_owned_telemetry_v1`, and no signature or result shape. A fast-tier attempt timeout that
starts another attempt now returns `ready` or `scheduled` in `retry_state`, not null. Thus the
workers of all seven SDKs record the retry span and the retry count for it. A Go or Rust worker
from before SM-1734 does not read `retry_state`, so it records no retry telemetry for a timeout.
Every process of every SDK version gets the new result when the migration commits.

Schema version 86 does not raise the floor. Migration 0087 appends `last_skipped_at`,
`last_skipped_count`, and `last_skipped_through` to `dashboard_schedule_definition_v1`.
`dashboard_cron_v1` returns them as `lastSkippedAt`, `lastSkippedCount`, and `lastSkippedThrough`
on each application schedule. The view keeps its earlier columns, and the document only gains keys.
A dashboard host of every SDK version passes the document through, so it serves the keys when the
migration commits. A dashboard of this release on a schema below 86 gets no skip keys and shows no
skip.

A 0.9 process keeps working on schema version 86. Its dashboard host still sends its own retention
preview statement, which reads tables that the migrations do not change. Its worker still sends
`deregister_worker_v1`, which migration 0077 does not change. Every process gets the throttle
behavior when migration 0075 commits. On schema 73, a throttled enqueue into a fast-tier queue still
raises the fast-tier error with the feature `throttle`.

While the fleet is mixed, the deregistration fence stops only a late deregistration that a new
process sends. A 0.9 process and a new process can use the same worker ID. Then a late
`deregister_worker_v1` call of the 0.9 process can still delete the row of the new run. The fence
is complete when no 0.9 worker runs. Each SDK keeps its own guard for one release. The guard stops
a late statement of an earlier run in the same process from changing the row of a later run.

## Upgrade from 0.8.x to 0.9.0

0.9.0 renews leases through `heartbeat_many_v2`, which does not wait for a locked
task row ([ADR 0105](decisions/0105-skip-a-locked-row-in-a-heartbeat-and-report-the-lease-as-busy.md)).
It also adds `heartbeat_v2`, which renews one lease by the same rule. Its SDKs call the new
functions, so the schema floor rises. The upgrade is a rolling deployment, and a mixed fleet is
supported while it runs.

1. Run `workhorse schema migrate`. It applies migrations 0073 through 0074 and leaves the schema at
   version 73.
2. Roll out the new processes, producers too.

A 0.8.0 database is at schema version 71. The migrations only add:

| Migration                                             | Schema version | Adds                                                        |
| ----------------------------------------------------- | -------------- | ----------------------------------------------------------- |
| `0073-skip-a-locked-row-in-a-heartbeat.sql`           | 72             | `heartbeat_many_v2`, which reports a locked lease as `busy` |
| `0074-skip-a-locked-row-in-a-one-lease-heartbeat.sql` | 73             | `heartbeat_v2`, which reports a locked lease as `busy`      |

The SDK schema floor rises from 69 to 73. Every SDK statement catalogue names `heartbeat_many_v2`
and `heartbeat_v2`. The compatibility check of 0.9.0 refuses a schema below version 73. Thus the
migrations must run before the first new process starts. 0.9.0 freezes `sql/releases/0073.sql`.

A 0.8 process keeps working on schema version 73. It calls `heartbeat_many_v1` and `heartbeat_v1`,
which do not change, so it still waits for a locked row. A new worker calls `heartbeat_many_v2` and
does not wait. Both renew the same columns.

The TypeScript return type of the batched heartbeat surfaces gains `busy`, as
[`CHANGELOG.md`](../CHANGELOG.md) states. The new `Queue.tryHeartbeat` calls `heartbeat_v2`.
`Queue.heartbeat` and `Queue.heartbeatStatus` still call `heartbeat_v1` and wait for a locked row.

## Upgrade from 0.7.x to 0.8.0

0.8.0 adds task groups and the checkpoint input check. Its SDKs call new SQL functions, so the
schema floor rises. The upgrade is a rolling deployment, and a mixed fleet is supported while it
runs.

1. Run `workhorse schema migrate`. It applies migrations 0066 through 0072 and leaves the schema at
   version 71.
2. Roll out the 0.8.0 processes.

A 0.7.0 or 0.7.1 database is at schema version 64. The migrations only add:

| Migration                                                              | Schema version | Adds                                                                                                        |
| ---------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `0066-add-task-groups-with-completion-callbacks.sql`                   | 65             | The task group tables and functions that every SDK statement catalogue names                                |
| `0067-count-task-group-outcomes-in-counter-shards.sql`                 | 66             | Counter shards for task groups, and `dashboard_task_groups_v1`                                              |
| `0068-read-the-newest-task-group-events.sql`                           | 67             | `list_newest_task_group_events_v1`, for the task group detail of the dashboard                              |
| `0069-check-the-input-of-a-checkpoint-on-replay.sql`                   | 68             | `task_checkpoint.input_fingerprint` and `save_checkpoint_v2`                                                |
| `0070-fence-a-task-group-member-add-and-index-the-group-list.sql`      | 69             | A lease check for a member add in `add_task_group_members_v1`, and the index `task_group_state_created_idx` |
| `0071-lock-purged-runtime-rows-in-identity-order.sql`                  | 70             | A lock order for `purge_queue_internal_v1`: every runtime row, then every task row, each in identity order  |
| `0072-purge-a-queue-that-holds-a-prerequisite-of-a-live-dependent.sql` | 71             | A purge that cancels, not deletes, a task whose dependent outside the purge waits (ADR 0101)                |

Migration 0070 is the first non-transactional step. It builds `task_group_state_created_idx` with
`CREATE INDEX CONCURRENTLY`, so the build does not block writes to `task_group`. If the step fails
part-way, the earlier statements stay applied and the schema stays at version 68. A failed build
can leave an invalid index, and the rerun then skips the build. Before you run the step again, do
these steps:

1. Drop the invalid index:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS workhorse.task_group_state_created_idx;
   ```

2. Run `workhorse schema migrate` again.

[Non-transactional steps](schema-lifecycle.md#non-transactional-steps) gives the query that lists
every invalid Workhorse index.

The SDK schema floor rises from 54 to 69. Every SDK statement catalogue names `save_checkpoint_v2`,
which schema version 68 adds. Schema version 69 also fences a member add: on an earlier schema, a
worker whose lease expired can still add tasks to the group of its member task. The compatibility
check of 0.8.0 refuses a schema below version 69. Thus the migration must run before the first
0.8.0 process starts.

Schema versions 70 and 71 do not raise the floor, so it stays 69. Migration 0071 changes only the
lock order of a queue purge. Migration 0072 changes what a purge does with a task that a dependent
outside the purge waits for: the purge cancels that task instead of a delete, and the purge count
includes it. No SDK statement and no result shape changes, and no SDK reads the difference between
a deleted and a canceled task in the purge result. Every process uses the new purge when the
migration commits, so a higher floor only refuses schema 69 or 70 and adds no protection. On
schema 69 or 70, such a purge still fails with `23001`.

A 0.7 process keeps working on schema version 71, because a migration inside a major line only
adds. Thus old and new processes can run together during the rollout:

- A 0.7 worker can run a member task. PostgreSQL counts the outcome of a member task in a trigger
  on `task_outcome`, so the group counts do not depend on the SDK version.
- A 0.7 process cannot create a task group, and its handlers cannot read or add to a group.
- A 0.7 worker saves a checkpoint through `save_checkpoint_v1`. That function calls
  `save_checkpoint_v2` with no input fingerprint, so its results do not change.

A checkpoint that Workhorse saved before the upgrade has no input fingerprint. A checkpoint that a
0.7 worker saves during the rollout also has none. If the stored checkpoint has no fingerprint,
Workhorse does not check the input. The replay returns the stored value, even when the handler now
gives an input. A 0.7 worker does not compare fingerprints at all. Thus the check applies only to
checkpoints that a 0.8.0 worker saves with an input, and only when a 0.8.0 worker replays them.

0.8.0 also changes two TypeScript behaviors. `Worker.runOnce()` returns `false` after a pass that
only released tasks, and a child request with no queue goes to the queue of its parent task.
[`CHANGELOG.md`](../CHANGELOG.md) gives the details of each change.
