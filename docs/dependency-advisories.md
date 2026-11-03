# Dependency advisories

A dependency advisory is a published report of a defect, often a vulnerability, in a package
version. This page states how each Workhorse package line finds an advisory in its dependencies,
and when an advisory blocks a build or a release.

[Compatibility and support boundary](compatibility.md) states the dependency ranges that each line
declares, and [`SECURITY.md`](../SECURITY.md) states how to report a vulnerability in Workhorse.

## Scan each package line

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
