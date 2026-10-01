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

| Runtime    | Supported      | Minimum | End of life                                                    | Notes                                                           |
| ---------- | -------------- | ------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| Node.js    | 22, 24         | 22      | 22: 2027-04-30, 24: 2028-04-30                                 | Even-numbered releases only. `engines.node` is `>=22`.          |
| Python     | 3.12–3.14      | 3.12    | 3.12: 2028-10, 3.13: 2029-10, 3.14: 2030-10                    | `stablemates-workhorse` ships one `py3-none-any` wheel.         |
| Go         | 1.25 and newer | 1.25    | No date; Go supports its two most recent releases              | pgx v5.11.0 is the minimum and the tested version.              |
| Rust       | 1.89 and newer | 1.89    | No date; Rust supports only its latest stable release          | Tokio with `tokio-postgres` 0.7 and `deadpool-postgres`.        |
| Ruby       | 3.3, 3.4, 4.0  | 3.3     | 3.3: 2027-03-31, 3.4: not announced, 4.0: not announced        | `pg` 1.6 alone, behind `connection_pool`, or Active Record.     |
| Active Job | 8.0, 8.1       | 8.0     | 8.0: 2026-11-07, 8.1: 2027-10-10                               | The Rails adapter. Rails dates are the end of security support. |
| PostgreSQL | 15, 16, 17, 18 | 15      | 15: 2027-11-11, 16: 2028-11-09, 17: 2029-11-08, 18: 2030-11-14 | No extension beyond the default `plpgsql` is installed.         |

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
surface without repository-only imports. Pull requests and pushes run Go against the newest
PostgreSQL. The weekly schedule runs Go against every supported PostgreSQL major. It also serves the
module zip from a staged proxy and consumes it from a clean module, as the release rehearsal does.
The race detector runs only on that weekly schedule.

The Rust crate declares Rust 1.89 as its minimum and runs on Tokio through tokio-postgres and
deadpool-postgres. Pull requests and pushes run its suite once, with every optional feature, against
the newest PostgreSQL. The weekly schedule runs it against every supported PostgreSQL major. It also
runs the suite without optional features and packages the crate into a clean consumer, as the
release gate does. [ADR 0083](decisions/0083-run-each-language-suite-once-per-change.md) records
this split.

### Raising a floor

Raising the Node.js, Python, Go, Ruby, Active Job, or PostgreSQL minimum is a **minor** release. It is never a major
and never a patch, and it is the only way a version leaves the table above.
[ADR 0058](decisions/0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md) records
the decision. The support matrix is deliberately not one of the governed surfaces in
[What SemVer governs](#what-semver-governs); this rule governs it instead.

A floor rises only when the version being dropped has reached its **upstream end of life**. The
upstream project's own schedule is the authority and this repository keeps no competing one:

| Runtime    | End of life is                                      | Published at                                                                  |
| ---------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Node.js    | Past the release's published end-of-life date       | [nodejs/Release](https://github.com/nodejs/Release)                           |
| Python     | Past the version's published end-of-life date       | [Python developer guide](https://devguide.python.org/versions/)               |
| Go         | Older than the two releases the Go project supports | [Go release policy](https://go.dev/doc/devel/release#policy)                  |
| Ruby       | Past the branch's published end-of-life date        | [Ruby maintenance branches](https://www.ruby-lang.org/en/downloads/branches/) |
| Active Job | Past the Rails release's security support           | [Rails maintenance policy](https://rubyonrails.org/maintenance)               |
| PostgreSQL | Past the major's community end-of-life date         | [PostgreSQL versioning](https://www.postgresql.org/support/versioning/)       |

`support.json` records that date for every listed Node.js, Python, Ruby, Active Job, and PostgreSQL
version, and the `End of life` column above publishes it. Go is the exception: its policy is
relative to whatever the current release is, so there is no published date to transcribe and none is
recorded. Node.js, PostgreSQL, Ruby, and Rails publish a day. The Python developer guide publishes
only a month until a version retires, and a month-precision entry stands for that whole month.

Ruby names a branch's end only once the branch enters security maintenance. Until then its
`support.json` date is `null`, and the table says "not announced" rather than guessing. The floor
always carries a date, because it retires first. Active Job follows its Rails release, and the
date is the end of that release's security support.

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

`pg`, Psycopg, asyncpg, and pgx move under the same rule, in either direction, and every move is a
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
`pnpm rust:vuln` covers the Rust crate, and `pnpm ruby:vuln` covers the Ruby gem. `pnpm check` runs
all five, and so does the `static` task in `.github/workflows/ci.yml`. The release workflow runs
`pnpm ruby:vuln` again inside `pnpm ruby:release-check`.

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

Connection budget: a notification-capable pool reserves one client connection for the listener no
matter how many `Queue` or `Worker` objects share it, so a worker pool needs at least two
connections for listening plus claims; a pool limited to one stays polling-only. Behind any
pooler that cannot deliver notifications that listener slot is held without delivering anything,
which is wasted budget on both the client pool and the pooler's client cap.

A PgCat routing detail: its `pgcat.toml` names each pool statically, so a client URL's database
name must match a configured pool — unlike PgBouncer, a PgCat deployment cannot forward a database
name it was not configured for.

## Packages and versioning

Eleven packages ship from this repository. `@stablemates/workhorse` is the TypeScript durable queue.
`stablemates-workhorse` names both the Python distribution on PyPI and the Ruby gem on RubyGems. The
rest are optional TypeScript packages.

| Package                                     | Purpose                                           | Peer requirements                                                                                             |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@stablemates/workhorse`                    | Queue, worker, schema, CLI                        | None; includes `pg` >= 8.16.3 and < 9                                                                         |
| `@stablemates/workhorse-drizzle`            | Drizzle ORM provider                              | `@stablemates/workhorse`, `drizzle-orm` >= 0.45, `pg`                                                         |
| `@stablemates/workhorse-prisma`             | Prisma ORM provider                               | `@stablemates/workhorse`, `@prisma/client` >= 6 and < 7                                                       |
| `@stablemates/workhorse-typeorm`            | TypeORM provider                                  | `@stablemates/workhorse`, `typeorm` >= 0.3 and < 2                                                            |
| `@stablemates/workhorse-kysely`             | Kysely provider                                   | `@stablemates/workhorse`, `kysely` >= 0.29 and < 0.30                                                         |
| `@stablemates/workhorse-otel`               | OpenTelemetry adapter                             | `@stablemates/workhorse`, `@opentelemetry/api` >= 1.9 and < 2, `@opentelemetry/api-logs` >= 0.200 and < 0.300 |
| `@stablemates/workhorse-dashboard`          | Operator dashboard and its framework-neutral host | `@stablemates/workhorse` >= 0.5.0 and < 0.6, React 19                                                         |
| `@stablemates/workhorse-dashboard-server`   | Authenticated standalone dashboard server         | `@stablemates/workhorse-dashboard-contract`                                                                   |
| `@stablemates/workhorse-dashboard-contract` | Type-only dashboard server boundary               | None                                                                                                          |
| `stablemates-workhorse`                     | Python clients, workers, and WSGI dashboard       | None; includes Psycopg >= 3.3 and < 4; `asyncpg` extra supports >= 0.31 and < 1                               |
| `stablemates-workhorse` (gem)               | Ruby clients, workers, and Rack dashboard         | None; includes `pg` >= 1.6 and < 2, `connection_pool` >= 2.5 and < 4; Active Job adapter supports >= 8.0      |

The nine TypeScript packages are versioned in lockstep and released from a single `vX.Y.Z` tag. An
optional TypeScript package always declares the core version it was released with as a peer range.
The Python package, the Go module, the Rust crate, and the Ruby gem declare no TypeScript peer range; SQL protocol
5 and schema version 43 are their compatibility boundary instead. Their version numbers still match the npm
packages, because every line releases from one commit.

Every release publishes one version to npm, PyPI, the Go module proxy, crates.io, and RubyGems from
one source commit. The current release is `0.5.0`. “Public beta” means the release is usable for evaluation and early production adoption without a
0.x compatibility promise. The label is retired at 1.0.0 and replaced by “stable”; see
[What SemVer governs](#what-semver-governs).

The dashboard and core may use different patch releases within the same minor line. The dashboard
server reads `workhorse.dashboard_*_v1` views and versioned functions, and a migration may not
remove, retype, or reinterpret a shipped view, so a core release remains compatible with the
dashboard it shipped beside. At 1.0.0 the dashboard's peer range on `@stablemates/workhorse` widens
from the minor line to the major line; see [Retention and removal](#retention-and-removal).

The shared browser bundle carries no SDK version. The TypeScript, Python, Go, or Rust host supplies its
own published version when it renders the application, so the dashboard reports the package that
serves it and a version-only release does not change the bundle.

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
the decision. The upgrade from 0.5 to 0.6 only adds, so it is an ordinary rolling deployment.

`.github/workflows/release.yml` publishes the nine npm packages with provenance, then creates the
GitHub release for the tag and attaches `sql/schema.sql`. That artifact is the clean-install schema
for the version, provided so a Python or Go developer with no Node.js toolchain can create a
development database with `psql -f schema.sql`. It applies none of the CLI's guards, so deployments
run `workhorse schema install` or `workhorse schema migrate` instead.

The asset is reachable at
`https://github.com/stablemates/workhorse/releases/download/vX.Y.Z/schema.sql`. `support.json`
states that URL once as `install.schemaDownload`, pinned to the version this repository publishes,
and `scripts/install-commands.test.ts` fails a URL that names a different version or an asset the
release step does not attach. A tag pushed before that step existed has no release and no asset;
the first release that carries one is `v0.1.0`.

Each line carries its own tag on that one commit, because npm, PyPI, and the Go module proxy have
separate build and publication identities. The Go module proxy also resolves a subdirectory module
only from a `go/`-prefixed tag. The crate and the gem publish from the TypeScript `vX.Y.Z` tag, so
five registries share three tags.
[ADR 0050](decisions/0050-release-0-1-0-without-a-prerelease-suffix.md) records that the tags name
one commit and one version number.

The Python package releases from its own `python/vX.Y.Z` tag. The tag must match
`python/pyproject.toml` and a heading in `python/CHANGELOG.md`. `.github/workflows/release-python.yml`
runs `pnpm check`, then uv builds a source distribution and universal wheel. A separate `pypi`
environment publishes those artifacts through PyPI trusted publishing with `id-token: write`.
Before publication, the publish task generates a PEP 740 attestation beside each distribution.

The Go module releases from its own `go/vX.Y.Z` tag. `scripts/release-go.sh X.Y.Z` requires
a clean worktree and a matching `go/CHANGELOG.md` heading. It rehearses the module release, resets
the test database, runs `pnpm check`, creates an annotated tag, and pushes that tag to `origin`.

## What SemVer governs

SemVer says a major release may break the public API. It does not say which artifact is the public
API, and Workhorse ships nine of them. Each surface below is governed, and each states in one
sentence what a breaking change is for it. Anything not on this list is internal and may change in
any release. [ADR 0054](decisions/0054-define-what-1-0-0-promises.md) records the decision, and
[ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md) and
[ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md) add the Rust and Ruby APIs.

| Governed surface                                    | A breaking change is                                                                                                                                                                                                       | Enforced by                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| SQL protocol and schema                             | A narrowing of `workhorse.protocol_version`, which is how a superseded `_vN` function is removed. A schema-version bump is not one, because inside a major line a migration only adds.                                     | `sql-catalogues:check`, which classifies the change         |
| TypeScript API                                      | A change that makes caller code stop compiling or behave differently, across the names and types reachable through a package's `exports` map and shipped `.d.ts`.                                                          | `typescript-api:check`, against `api/typescript.txt`        |
| Python API                                          | The same, across the names in a public module's `__all__`. Underscore-prefixed modules such as `workhorse._protocol` are private.                                                                                          | `python-api:check`, against `api/python.txt`                |
| Go API                                              | The same, across the exported identifiers of the module's non-`internal` packages. Go's own standard applies: what `apidiff` calls an incompatible change.                                                                 | `go-api:check`, `apidiff` against the tag `api/go.txt` pins |
| Rust API                                            | The same, across the public items reachable from the `workhorse` crate root under any published feature, auto and derived traits included. Removing or renaming a feature, or moving an item behind one, is also breaking. | `rust-api:check`, against `api/rust.txt`                    |
| Ruby API                                            | The same for code that runs rather than compiles, across the public constants under `Stablemates::Workhorse` and the Active Job adapter, with their `Data` members and method signatures. A `:nodoc:` constant is private. | `ruby-api:check`, against `api/ruby.txt`                    |
| `workhorse` CLI                                     | Removing or renaming a command or flag, changing what an exit code means, or removing or retyping a field in `--json` output.                                                                                              | `cli-surface:check`, against `api/cli.txt`                  |
| `dashboard/v1` wire contract                        | Removing a procedure, removing or retyping a response field, or tightening request validation.                                                                                                                             | `dashboard-spec:check`, which classifies the change         |
| OpenTelemetry instrument, span, and attribute names | Renaming or removing an instrument, span, or attribute, or changing an instrument's unit or kind.                                                                                                                          | `telemetry-surface:check`, against `api/telemetry.txt`      |

The right-hand column is Gate 1 of
[ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md): every governed surface holds a mechanical
check in the CI `required` task, so no promise rests on review alone. Seven of them read the committed
snapshots in [`api/`](../api/README.md), which that directory's own README explains. Each has a
generator, so a legitimate addition costs one command: `pnpm typescript-api:generate`,
`pnpm python-api:generate`, `pnpm go-api:generate`, `pnpm rust-api:generate`,
`pnpm ruby-api:generate`, `pnpm cli-surface:generate`, or `pnpm telemetry-surface:generate`.

A snapshot is only as good as where it reads from, so neither of the two newest reads a table kept
beside the code. `api/cli.txt` reads `typescript/core/src/cli/surface.ts`, which the CLI itself
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

The five language lines float independently, and each is governed on its own surfaces: a Go `/v2`
does not move the TypeScript, Python, Rust, or Ruby major. Only a protocol break moves all five at
once.

The runtime support matrix and the declared dependency ranges are not on this list. They move by
their own rule, in a minor and only on upstream end of life; see [Raising a floor](#raising-a-floor).

### Two surfaces classify their own changes

`sql-catalogues:check` and `dashboard-spec:check` regenerate an artifact and diff it. A diff alone
says only that something moved, because regenerating rewrites the artifact whether a procedure was
added or removed. Each check therefore compares against a separate promise file that accumulates:
the generator may add an entry and may never drop one. The five language checks need no such file,
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

- The manifest's statement catalogue, which is the SQL all four SDKs send. `assertNoInlineTypeScriptSql`
  and the Python binding check keep it the only source of SDK statements.
- The three dashboard backends, `typescript/dashboard-server/src/server`, `go/dashboard`, and
  `python/src/workhorse/dashboard`, each of which builds its own SQL.
- Every `dashboard_*_v1` view, plus `dashboard_task_result_v1`, whose exact columns
  [`architecture.md`](architecture.md) publishes as core's relational read contract. They are
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

The nine npm packages, the Python distribution, the Go module, the Rust crate, and the Ruby gem
publish 1.0.0 from one source commit as one release train
([ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md), [ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md)). A line that
cannot clear the parity bar slips the train rather than being left behind. That synchronisation
happens once; afterwards the five version lines float again as they do today.

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
([ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md)):

1. Every governed surface above has a mechanical check in the CI `required` task. Nine checks, one
   per surface.
2. Six weeks and two published 0.x minors separate the last non-additive change to a governed
   surface from the tag, and no outside-filed defect against a governed surface is open and
   unaccepted. The Rust API's clock starts at the later of the commit that first landed
   `api/rust.txt` and the last one that removed a line from it. Both minors must publish the crate
   from a commit at or after that start, so 0.4.0 does not count
   ([ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md)). The Ruby API's clock
   starts the same way at `api/ruby.txt`, and both minors must publish the gem to RubyGems. The gem
   first publishes in 0.6.0, so 0.6.0 and 0.7.0 are the earliest pair, and both precede 1.0.0
   ([ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md)).
3. The migration rehearsals ADR 0055 placed have run, the recovery procedure has been executed
   against a deliberate mid-migration failure, and a fresh host has installed the candidate from the
   registries in all five languages, Rust from crates.io and Ruby from RubyGems included
   ([ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md), [ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md)).
4. One database has run 30 consecutive days under continuous work without being reinstalled, across
   daily partition rollover, a retention pass that dropped a partition, and an ungraceful worker
   kill with clean recovery.
5. `@stablemates/workhorse-dashboard-server` has a written security review with every High finding
   resolved. No third-party audit has taken place, and `SECURITY.md` says so.
6. `pnpm parity:check` passes and the product operator table carries no Planned cell (WH-581
   named four), and any Absent cell records why it is absent.

The tag date is derived from those gates rather than announced. Adoption counts, documentation
coverage, and benchmark numbers are recorded at the tag and gate nothing.

## Protocol and schema compatibility

The durable protocol is the PostgreSQL schema, not the TypeScript API. Its guarantees:

- **The runtime declares a floor; the database declares the ceiling.** A runtime accepts the single
  row in `workhorse.schema_version` when it is at or above `MINIMUM_SCHEMA_VERSION`, and applies no
  upper bound of its own. That floor is the version that introduced the newest schema object the
  release calls, across its statement catalogues and the dashboard host it ships, so a schema the
  release would fail on is refused at startup rather than on the first call. A release raises the
  floor when it starts calling something newer, which is why the deployment pipeline migrates
  before any process from the new release starts. A schema that is merely newer still carries every function the runtime
  calls, because inside a major line a migration only adds, so refusing it would make every rolling
  deployment an outage. The ceiling is `workhorse.protocol_version`, where the installed schema
  lists the client protocols it still answers; a contract step drops the ones it stops serving, and
  every older runtime then refuses at once. That narrowing is a contract step the operator runs,
  never something a release performs on their behalf, so a mixed fleet mid-deploy is supported at
  every version boundary including a major one. Migration 0025 is the one exception: 0.5.0 ships it
  as a contract step that retires protocols 1 through 4. A database from before 0.5.0 therefore
  crosses it offline, with every worker and producer stopped, as
  [the fast-tier cutover](schema-lifecycle.md#the-fast-tier-cutover) describes. From 0.5 to 0.6 a
  mixed fleet is supported again.

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
  HTML placeholders, request order, and procedure schemas used by the TypeScript, Python, Go, and Rust
  backends. Applications should embed a shipped backend rather than call those procedures as a
  public operator API.

The TypeScript, Python, Go, and Rust clients and workers implement this protocol. Python runs the same
canonical SQL fixtures and request mapping through Psycopg, plus transaction integration through
Psycopg async and asyncpg. Its synchronous and asynchronous workers share one lifecycle core; the
asynchronous surface uses native Psycopg or asyncpg query and notification connections. The Go
worker supports bounded multi-queue dispatch, fenced ownership, cooperative
cancellation, durable checkpoints, durable timers, and graceful drain. Repository tests compile
and exercise external module consumers before a release can create the module tag. The Rust crate
runs every `protocol/v1` fixture category through `rust/tests/protocol_conformance.rs`, and
`rust/tests/conformance/expected-unsupported.json` lists no exception.

## Release process

Every release is a tag that points to a green public CI commit. Each tag then runs the focused gate
for the distribution being published.

### Release train

Every release publishes the same version to npm, PyPI, the Go module proxy, crates.io, and RubyGems
from one source commit, in one controlled window, in a fixed order. Dates go into the changelogs before the
candidate is cut, and a slipped date means a new candidate. No commit lands on `main` between the
first tag and the last, so every tag names the candidate commit.

The Rust crate and the Ruby gem have no tag of their own. Each rides the npm `v*` tag and publishes
after npm, as [Rust crate](#rust-crate) and [Ruby gem](#ruby-gem) describe.

1. Rehearse. The candidate commit's `main` push run must show a green `CI / required`.
   `.github/workflows/release.yml` and `.github/workflows/release-python.yml` are dispatched
   manually with `dry-run` enabled, and every npm and Python archive is downloaded and inspected.
   All nine npm tarballs, the Python wheel, and the Python source distribution are installed in
   clean consumers. The Go external consumer, the Rust packaged-crate consumer, and the Ruby
   packaged-gem consumer are built from the same commit.
   Test registries are not part of the rehearsal.
2. Publish Python first. One distribution is the smallest production test of trusted publishing.
   Its PEP 740 attestations are verified on PyPI before the train continues.
3. Publish npm second. Each package goes after the published packages it requires, so
   `@stablemates/workhorse-dashboard-contract` precedes `@stablemates/workhorse`, and the dashboard
   server precedes the dashboard facade.
   [ADR 0085](decisions/0085-publish-npm-packages-in-dependency-order.md) records this order. Every
   package's provenance is verified. The same run then publishes the Rust crate and the Ruby gem.
   Each version is verified on its registry before the train continues.
4. Publish Go last. The `go/vX.Y.Z` tag is pushed after the gate passes, and the version is
   verified through the public module proxy.

Each verification checks registry visibility, provenance or the module checksum, and installation
of the exact public version in a clean environment. It then runs a minimal enqueue-and-worker smoke
test against a fresh PostgreSQL database. Any failure stops the release train: the defect is filed,
the remaining stages stay blocked, and the fix ships as a new candidate.

`pnpm release:verify <python|npm|crate|go> X.Y.Z` holds the version checks as exact commands and
the output each must print. After each stage publishes, the handoff runs that stage's target
instead of restating commands. Each target installs the public version into a fresh scratch
directory:

- `python` installs `stablemates-workhorse==X.Y.Z` into a virtual environment on the oldest
  supported Python. It checks both `workhorse.__version__` and the installed distribution metadata.
- `npm` checks every published package's version, then installs `@stablemates/workhorse` and runs
  `npm audit signatures` and `workhorse --version`.
- `crate` resolves `workhorse = "=X.Y.Z"` from crates.io and checks the locked package ID.
- `go` resolves the module through `proxy.golang.org` with no direct fallback and runs
  `go mod verify`.

The script covers registry visibility, signatures or checksums, and clean installation. The
maintainer still reviews provenance on each registry page and runs the enqueue-and-worker smoke
test.

Every release check also runs its target before anything is tagged or published. Each rehearsal
substitutes the artifact about to ship for the registry release:

- `--wheel <file>` installs the dry-run wheel.
- `--tarballs <directory>` installs all nine packed tarballs and checks each installed version.
  It skips `npm view` and `npm audit signatures`, which only the registry can answer.
- `--crate <directory>` depends on the unpacked `.crate` archive by path and checks its package ID.
- `--go-proxy <directory>` serves a file module proxy ahead of `proxy.golang.org`. It skips the
  checksum database for this module only, which has never seen the unpublished version, and uses a
  scratch module cache.

A check the artifact cannot satisfy therefore fails the rehearsal, not the train after the tag.

A published version is never reused. An ordinary defect stays available and receives a higher
fix. A security, secret, privacy, or legal exposure triggers credential rotation and removal where
the registry permits it. The response also deprecates the npm release, yanks the PyPI release, or
retracts the Go version as appropriate, and yanks the crates.io and RubyGems versions. Removal does not make prior
public access reversible.
[`SECURITY.md`](../SECURITY.md) states how to report a vulnerability privately and which versions
receive fixes.

The first public beta did not run this way: fix-forwards spread it across three source commits.
The dated entries in [`CHANGELOG.md`](../CHANGELOG.md),
[`python/CHANGELOG.md`](../python/CHANGELOG.md), and [`go/CHANGELOG.md`](../go/CHANGELOG.md) name
those commits.
The Ruby gem keeps its own [`ruby/CHANGELOG.md`](../ruby/CHANGELOG.md), which the
[Ruby gem](#ruby-gem) checklist bumps with every release.

### npm packages

1. Update all TypeScript package versions in lockstep and add the `CHANGELOG.md` entry for the release,
   including upgrade notes for any breaking change.
2. Tag `vX.Y.Z`. The workflow requires a successful `main` CI push run for that commit and refuses
   a tag that disagrees with any manifest or lacks a `CHANGELOG.md` entry.
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
2. Tag `python/vX.Y.Z`. The workflow requires a successful `main` CI push run for that commit.
3. `pnpm python:release-check` validates the version and changelog, rebuilds the embedded dashboard
   bundle, checks Python format, lint, types, and dependencies, then runs every Python test against
   PostgreSQL. It builds the wheel and source distribution once and tests those exact files.
   It then runs `pnpm release:verify python` against that wheel, so a post-publish check the
   package cannot satisfy fails the rehearsal before `python/vX.Y.Z` is tagged.
4. The `pypi` environment generates PEP 740 attestations for the unchanged artifacts, then
   publishes both distributions and their attestations through trusted publishing.

`workhorse.__version__` is public Python API from the release after 0.4.0, and `api/python.txt`
records it. The post-publish Python check therefore fails against 0.4.0, which predates the
attribute. For 0.4.0, `importlib.metadata.version("stablemates-workhorse")` is the check.

### Go module

1. Add the intended version to `go/CHANGELOG.md` and commit the release candidate.
2. Run `scripts/release-go.sh X.Y.Z` from a clean worktree.
3. The script runs `pnpm go:release-check X.Y.Z`, which validates the changelog entry and stages a
   file module proxy that serves `HEAD:go` as `vX.Y.Z`. It then runs `pnpm release:verify go`
   against that proxy, so a post-publish check the module cannot satisfy fails before the tag.
4. The script runs `pnpm check`, creates `go/vX.Y.Z`, and pushes the tag only after the gate passes.

### Rust crate

The Rust SDK publishes one crate, `workhorse`, from `rust/`
([ADR 0074](decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md)). It has no tag of its
own and publishes from the npm `v*` tag. The crate joined the release train at `0.4.0`. Before that
release, crates.io held only the `0.0.0` placeholder that reserved the name.

1. Set `version` in `rust/Cargo.toml` to the release version and commit it with the candidate.
2. Tag `vX.Y.Z`. The build job of `.github/workflows/release.yml` runs `pnpm rust:release-check`.
   It packages the crate with verification and builds a clean consumer from the packaged archive.
   With PostgreSQL available, that consumer enqueues one task. It then runs
   `pnpm release:verify crate` against the unpacked archive, so a post-publish check the crate
   cannot satisfy fails before anything is published.
3. After npm publishes, the `crates-io` job compares the crate version with the tag. A mismatch
   writes a notice and publishes nothing, so a release that leaves the crate behind still succeeds.
4. On a match, the job exchanges its OIDC identity for a crates.io token and runs
   `cargo publish --package workhorse --locked`, which verifies the package again before the upload.

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
crate, it has no tag of its own and publishes from the npm `v*` tag. It joins the release train on
the first release after the gem name is reserved.

1. Set `VERSION` in `ruby/lib/stablemates/workhorse/version.rb` to the release version. Move the
   `## Unreleased` entries of `ruby/CHANGELOG.md` under a `## X.Y.Z` heading, and commit both with
   the candidate. For the first release, also remove the "Unreleased" note from `ruby/README.md`.
   Replace the Git install in `install.ruby` of `support.json` with `bundle add
stablemates-workhorse`, and change every surface `scripts/install-commands.test.ts` governs to
   match. Drop the not-yet-released sentences from the site's compatibility, installation,
   quickstart, and agent pages, and the `unpublished` flag from the Ruby entry in
   `site/lib/releases.ts`.
2. Tag `vX.Y.Z`. The build job of `.github/workflows/release.yml` runs `pnpm ruby:release-check`.
   It runs the Ruby gates, then builds the `.gem` once with `gem build --strict`. It installs that
   archive into an empty gem home and runs a clean consumer project without Bundler. With PostgreSQL
   available, that consumer enqueues one task and runs it through a worker.
3. After npm publishes, the `rubygems` job compares the gem version with the tag. A mismatch writes a
   notice and publishes nothing, so a release that leaves the gem behind still succeeds.
4. On a match, `rubygems/release-gem` exchanges the job's OIDC identity for a RubyGems API key and
   runs `rake release` in `ruby/`. That task builds the gem and pushes it with a Sigstore
   attestation. It finds the train tag already in place, so it pushes no tag. The action then waits
   until RubyGems.org serves the new version.
5. Verify the public version with `gem install stablemates-workhorse -v X.Y.Z` in an empty gem home,
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

### Release tags

Each tag prefix publishes a fixed set of packages:

| Tag         | Publishes                                     | Workflow                                |
| ----------- | --------------------------------------------- | --------------------------------------- |
| `v*`        | The nine npm packages, the crate, and the gem | `.github/workflows/release.yml`         |
| `python/v*` | The PyPI distribution                         | `.github/workflows/release-python.yml`  |
| `go/v*`     | The Go module, through the module proxy       | None; `scripts/release-go.sh` pushes it |

Two repository tag rulesets cover `refs/tags/v*`, `refs/tags/python/v*`, and `refs/tags/go/v*`.

- "Protect release tags" (ruleset 21888197) restricts creation to organization administrators. The
  `OrganizationAdmin` role is its only bypass actor.
- "Lock release tags" (ruleset 24047194) blocks update, deletion, and non-fast-forward pushes. It has
  no bypass actor, so a published tag cannot move or disappear.

The Ruby gem publishes from `v*`, which both rulesets already cover. If the gem ever moves to a
different tag prefix, add that prefix to both rulesets in the same change.

The public repository requires pull requests and `CI / required` on `main`. Outside collaborators
require workflow approval. The protected `npm`, `pypi`, `crates-io`, and `rubygems` environments
require review, and all four prevent administrator bypass.

### Publication credentials

None of the five registries holds a credential this repository stores, and none of them holds one
that can expire.

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

The Go module proxy needs no credential at all. `scripts/release-go.sh` pushes a tag, and the proxy
serves what the public repository already holds.

### Recovering a partially published release

npm publishes one package at a time. Nine packages cannot be published atomically, so a failure in
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
the five registries, so every package moves, not only the ones that failed. The packages that did
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
