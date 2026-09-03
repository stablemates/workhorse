# Compatibility and support boundary

This is the supported-version contract for the published Workhorse packages. `support.json` owns
the repository matrix and local toolchain versions. `typescript/core/src/support.ts` exposes the
Node.js and PostgreSQL claims to published packages. `.github/workflows/ci.yml` runs the matrix,
and `typescript/core/test/support-matrix.test.ts` fails when machine-readable consumers drift.

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

| Runtime    | Supported      | Minimum | Notes                                                   |
| ---------- | -------------- | ------- | ------------------------------------------------------- |
| Node.js    | 22, 24         | 22      | Even-numbered releases only. `engines.node` is `>=22`.  |
| Python     | 3.12–3.14      | 3.12    | `stablemates-workhorse` ships one `py3-none-any` wheel. |
| Go         | 1.25 and newer | 1.25    | pgx v5.9.2 is the minimum and the tested version.       |
| PostgreSQL | 15, 16, 17, 18 | 15      | No extension beyond the default `plpgsql` is installed. |

Pull requests and pushes run the newest Node.js and PostgreSQL versions. The weekly schedule runs
every Node.js and PostgreSQL combination. The daily schedule runs the packed-package test on the
newest Node.js version, and manual runs combine the latest-version lanes with that packed test.
Demo and site smoke tests are temporarily disabled.

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

The Go module declares Go 1.25 or newer and requires pgx v5.9.2. That is a minimum rather than a
pin: minimal version selection lets a consumer's own module graph choose a higher pgx v5, which is
expected to work and is not tested. Its repository
lane exercises enqueue through pgx transactions, pgx pools, and `database/sql` with pgx stdlib. It
also compiles and runs a separate module through a local `replace` directive. Another external
module builds every Go example through the public import path. These tests prove the exported module
surface without repository-only imports. Pull requests and pushes run Go against the newest
PostgreSQL. The weekly schedule runs Go against every supported PostgreSQL major.

### Raising a floor

Raising the Node.js, Python, Go, or PostgreSQL minimum is a **minor** release. It is never a major
and never a patch, and it is the only way a version leaves the table above.
[ADR 0058](decisions/0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md) records
the decision. The support matrix is deliberately not one of the governed surfaces in
[What SemVer governs](#what-semver-governs); this rule governs it instead.

A floor rises only when the version being dropped has reached its **upstream end of life**. The
upstream project's own schedule is the authority and this repository keeps no competing one:

| Runtime    | End of life is                                      | Published at                                                            |
| ---------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| Node.js    | Past the release's published end-of-life date       | [nodejs/Release](https://github.com/nodejs/Release)                     |
| Python     | Past the version's published end-of-life date       | [Python developer guide](https://devguide.python.org/versions/)         |
| Go         | Older than the two releases the Go project supports | [Go release policy](https://go.dev/doc/devel/release#policy)            |
| PostgreSQL | Past the major's community end-of-life date         | [PostgreSQL versioning](https://www.postgresql.org/support/versioning/) |

Convenience is not a reason. A runtime still supported upstream keeps its place in the table even
when dropping it would simplify the code or shorten the matrix.

Notice is what makes the minor honest. Before the minor that drops a version, the table above names
it as scheduled for removal with its upstream date, and at least one published minor's changelog
says so. PostgreSQL takes two published minors of notice rather than one, because a PostgreSQL major
upgrade is a database migration the operator schedules rather than a package bump.

A floor raise is a minor because it cannot reach code that already runs. The release you installed
keeps working against the database you built it for; what a dropped runtime loses is future
releases, and every package manager in the three ecosystems reports that as a resolution result.

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

## JS runtime smoke tier

Node.js is the only supported runtime. Bun and Deno sit in a deliberately weaker tier declared by
`SMOKE_TESTED_JS_RUNTIMES` in `typescript/core/src/support.ts`: the `runtime-smoke` CI lane runs
`typescript/core/test/runtime-smoke.ts` — `installSchema`, then an enqueue, claim, and complete
round-trip through the built `@stablemates/workhorse` entry point — against the newest supported
PostgreSQL, under the latest release of each runtime. A green lane proves the driver connects, the
schema installs, and one job completes there. It proves nothing else: the full vitest suites run
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

## Packages and versioning

Ten packages ship from this repository. `@stablemates/workhorse` is the TypeScript durable queue;
`stablemates-workhorse` is the Python client and worker SDK; the rest are optional TypeScript packages.

| Package                                     | Purpose                                           | Peer requirements                                                                                             |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@stablemates/workhorse`                    | Queue, worker, schema, CLI                        | None; includes `pg` >= 8.16.3 and < 9                                                                         |
| `@stablemates/workhorse-drizzle`            | Drizzle ORM provider                              | `@stablemates/workhorse`, `drizzle-orm` >= 0.45, `pg`                                                         |
| `@stablemates/workhorse-prisma`             | Prisma ORM provider                               | `@stablemates/workhorse`, `@prisma/client` >= 6 and < 7                                                       |
| `@stablemates/workhorse-typeorm`            | TypeORM provider                                  | `@stablemates/workhorse`, `typeorm` >= 0.3 and < 2                                                            |
| `@stablemates/workhorse-kysely`             | Kysely provider                                   | `@stablemates/workhorse`, `kysely` >= 0.29 and < 0.30                                                         |
| `@stablemates/workhorse-otel`               | OpenTelemetry adapter                             | `@stablemates/workhorse`, `@opentelemetry/api` >= 1.9 and < 2, `@opentelemetry/api-logs` >= 0.200 and < 0.300 |
| `@stablemates/workhorse-dashboard`          | Operator dashboard and its framework-neutral host | `@stablemates/workhorse` >= 0.1.0 and < 0.2, React 19                                                         |
| `@stablemates/workhorse-dashboard-server`   | Authenticated standalone dashboard server         | `@stablemates/workhorse-dashboard-contract`                                                                   |
| `@stablemates/workhorse-dashboard-contract` | Type-only dashboard server boundary               | None                                                                                                          |
| `stablemates-workhorse`                     | Python clients, workers, and WSGI dashboard       | None; includes Psycopg >= 3.3 and < 4; `asyncpg` extra supports >= 0.31 and < 1                               |

The nine TypeScript packages are versioned in lockstep and released from a single `vX.Y.Z` tag. An
optional TypeScript package always declares the core version it was released with as a peer range.
The Python package version floats independently and declares compatibility through SQL protocol 1
and schema version 1 instead of a TypeScript peer range.

Every release publishes one version to npm, PyPI, and the Go module proxy from one source commit.
The current release is `0.1.0`. “Public beta” means the release is usable for evaluation and early production adoption without a
0.x compatibility promise. The label is retired at 1.0.0 and replaced by “stable”; see
[What SemVer governs](#what-semver-governs).

The dashboard and core may use different patch releases within the same minor line. The dashboard
server reads `workhorse.dashboard_*_v1` views and versioned functions, and a migration may not
remove, retype, or reinterpret a shipped view, so a core release remains compatible with the
dashboard it shipped beside. At 1.0.0 the dashboard's peer range on `@stablemates/workhorse` widens
from the minor line to the major line; see [Retention and removal](#retention-and-removal).

While the line is `0.x`, any minor release may make a breaking change in behaviour. The schema is
not one of them: from `0.1.0` every release ships ordered, immutable migrations, and inside a major
line a migration only adds, so a client built against schema version N accepts any installed
version at or above N below the next major boundary. `migrateSchema` runs from a deployment step
before any process from the new release starts. Breaking changes are listed in
[`CHANGELOG.md`](../CHANGELOG.md) with the upgrade steps for that release, and
[ADR 0053](decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md) states the rule.

`.github/workflows/release.yml` publishes the nine npm packages with provenance, then creates the
GitHub release for the tag and attaches `sql/schema.sql`. That artifact is the clean-install schema
for the version, provided so a Python or Go developer with no Node.js toolchain can create a
development database with `psql -f schema.sql`. It applies none of the CLI's guards, so deployments
run `workhorse schema install` or `workhorse schema migrate` instead.

The Python package releases independently from a `python/vX.Y.Z` tag. The tag must match
`python/pyproject.toml` and a heading in `python/CHANGELOG.md`. `.github/workflows/release-python.yml`
runs `pnpm check`, then uv builds a source distribution and universal wheel. A separate `pypi`
environment publishes those artifacts through PyPI trusted publishing with `id-token: write`.
Before publication, the publish job generates a PEP 740 attestation beside each distribution.

The Go module releases independently from a `go/vX.Y.Z` tag. `scripts/release-go.sh X.Y.Z` requires
a clean worktree and a matching `go/CHANGELOG.md` heading. It resets the test database, runs
`pnpm check`, creates an annotated tag, and pushes that tag to `origin`.

## What SemVer governs

SemVer says a major release may break the public API. It does not say which artifact is the public
API, and Workhorse ships seven of them. Each surface below is governed, and each states in one
sentence what a breaking change is for it. Anything not on this list is internal and may change in
any release. [ADR 0054](decisions/0054-define-what-1-0-0-promises.md) records the decision.

| Governed surface                                    | A breaking change is                                                                                                                                                                   | Enforced by                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| SQL protocol and schema                             | A narrowing of `workhorse.protocol_version`, which is how a superseded `_vN` function is removed. A schema-version bump is not one, because inside a major line a migration only adds. | `sql-catalogues:check`, which classifies the change         |
| TypeScript API                                      | A change that makes caller code stop compiling or behave differently, across the names and types reachable through a package's `exports` map and shipped `.d.ts`.                      | `typescript-api:check`, against `api/typescript.txt`        |
| Python API                                          | The same, across the names in a public module's `__all__`. Underscore-prefixed modules such as `workhorse._protocol` are private.                                                      | `python-api:check`, against `api/python.txt`                |
| Go API                                              | The same, across the exported identifiers of the module's non-`internal` packages. Go's own standard applies: what `apidiff` calls an incompatible change.                             | `go-api:check`, `apidiff` against the tag `api/go.txt` pins |
| `workhorse` CLI                                     | Removing or renaming a command or flag, changing what an exit code means, or removing or retyping a field in `--json` output.                                                          | `cli-surface:check`, against `api/cli.txt`                  |
| `dashboard/v1` wire contract                        | Removing a procedure, removing or retyping a response field, or tightening request validation.                                                                                         | `dashboard-spec:check`, which classifies the change         |
| OpenTelemetry instrument, span, and attribute names | Renaming or removing an instrument, span, or attribute, or changing an instrument's unit or kind.                                                                                      | `telemetry-surface:check`, against `api/telemetry.txt`      |

The right-hand column is Gate 1 of
[ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md): every governed surface holds a mechanical
check in the CI `required` job, so no promise rests on review alone. Five of them read the committed
snapshots in [`api/`](../api/README.md), which that directory's own README explains. Each has a
generator, so a legitimate addition costs one command: `pnpm typescript-api:generate`,
`pnpm python-api:generate`, `pnpm go-api:generate`, `pnpm cli-surface:generate`, or
`pnpm telemetry-surface:generate`.

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

`dashboard/v1` carries its own version in its path, so a break there creates `dashboard/v2` rather
than moving any package major. The obligation runs the other way: `dashboard/v1` is served for the
whole major line it shipped in.

The three language lines float independently, and each is governed on its own surfaces: a Go `/v2`
does not move the TypeScript or Python major. Only a protocol break moves all three at once.

The runtime support matrix and the declared dependency ranges are not on this list. They move by
their own rule, in a minor and only on upstream end of life; see [Raising a floor](#raising-a-floor).

### Two surfaces classify their own changes

`sql-catalogues:check` and `dashboard-spec:check` regenerate an artifact and diff it. A diff alone
says only that something moved, because regenerating rewrites the artifact whether a procedure was
added or removed. Each check therefore compares against a separate promise file that accumulates:
the generator may add an entry and may never drop one. The three language checks need no such file,
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

### The governed SQL surface

The governed set is what a supported release reads, which is not what `protocol/v1/manifest.json`
declares. The manifest names the 26 protocol functions the SQL protocol pins; the audit behind
[ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md) found the SDKs and dashboards reach 33
more functions and 25 tables beyond them. The two differ on purpose and are not reconciled into one
list: the manifest is the protocol's own contract, and the governed set is every relation and
function a release actually touches.

`scripts/generate-sql-catalogues.ts` derives the set from the readers rather than from a hand list,
so a new read governs its target on the next generate:

- The manifest's statement catalogue, which is the SQL all three SDKs send. `assertNoInlineTypeScriptSql`
  and the Python binding check keep it the only source of SDK statements.
- The three dashboard backends, `typescript/dashboard-server/src/server`, `go/dashboard`, and
  `python/src/workhorse/dashboard`, each of which builds its own SQL.
- Every `dashboard_*_v1` view, plus `dashboard_job_result_v1`, whose exact columns
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

The nine npm packages, the Python distribution, and the Go module publish 1.0.0 from one source
commit as one release train. A line that cannot clear the parity bar slips the train rather than
being left behind. That synchronisation happens once; afterwards the three version lines float again
as they do today.

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
once their fleet is entirely on the new major. `workhorse schema migrate` never applies it. The
command refuses while `workhorse.worker_registry` shows a worker on the retiring protocol
heartbeating inside its lease; producers do not register, so it names what it can see and requires
explicit confirmation.

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

1. Every governed surface above has a mechanical check in the CI `required` job. Seven checks, one
   per surface. None of them exists yet.
2. Six weeks and two published 0.x minors separate the last non-additive change to a governed
   surface from the tag, and no outside-filed defect against a governed surface is open and
   unaccepted.
3. The migration rehearsals ADR 0055 placed have run, the recovery procedure has been executed
   against a deliberate mid-migration failure, and a fresh host has installed the candidate from the
   registries in all three languages.
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
  upper bound of its own. A schema that is merely newer still carries every function the runtime
  calls, because inside a major line a migration only adds, so refusing it would make every rolling
  deployment an outage. The ceiling is `workhorse.protocol_version`, where the installed schema
  lists the client protocols it still answers; a contract step drops the ones it stops serving, and
  every older runtime then refuses at once. That narrowing is a contract step the operator runs,
  never something a release performs on their behalf, so a mixed fleet mid-deploy is supported at
  every version boundary including a major one.

  See [Retention and removal](#retention-and-removal).

- **Installation is clean-database only; migration owns every upgrade from 0.1.0.** `installSchema`
  refuses to interpret an older or unversioned `workhorse` schema. `migrateSchema` applies ordered,
  immutable, transactional migrations forward from the baseline frozen as `sql/releases/0001.sql`.
  A deployment runs it from a pipeline step before any process from the new release starts; no
  component migrates on start. `docs/schema-lifecycle.md` records the execution contract, the
  expand/contract rollout rules, and the backup and recovery guidance.
- **Correctness-sensitive transitions stay in versioned SQL functions.** Claim, completion, retry,
  cancellation, deadline, and maintenance transitions are owned by SQL. A client that speaks the
  same schema version speaks the same protocol, whatever language it is written in.
- **Job payloads are caller-owned JSON.** Workhorse stores and returns them unchanged. Trace context
  and other Workhorse metadata are kept beside the payload, never merged into it.
- **The dashboard wire contract is versioned separately.** `dashboard/v1` pins the oRPC envelopes,
  HTML placeholders, request order, and procedure schemas used by the TypeScript, Python, and Go
  backends. Applications should embed a shipped backend rather than call those procedures as a
  public operator API.

The TypeScript, Python, and Go clients and workers implement this protocol. Python runs the same
canonical SQL fixtures and request mapping through Psycopg, plus transaction integration through
Psycopg async and asyncpg. Its synchronous and asynchronous workers share one lifecycle core; the
asynchronous surface uses native Psycopg or asyncpg query and notification connections. The Go
worker supports bounded multi-queue dispatch, fenced ownership, cooperative
cancellation, durable checkpoints, durable timers, and graceful drain. Repository tests compile
and exercise external module consumers before a release can create the module tag.

## Release process

Every release is a tag that points to a green public CI commit. Each tag then runs the focused gate
for the distribution being published.

### Release train

Every release publishes the same version to npm, PyPI, and the Go module proxy from one source
commit, in one controlled window, in a fixed order. Dates go into the changelogs before the
candidate is cut, and a slipped date means a new candidate. No commit lands on `main` between the
first tag and the last, so every tag names the candidate commit.

1. Rehearse. The candidate commit's `main` push run must show a green `CI / required`.
   `.github/workflows/release.yml` and `.github/workflows/release-python.yml` are dispatched
   manually with `dry-run` enabled, and every npm and Python archive is downloaded and inspected.
   All nine npm tarballs, the Python wheel, and the Python source distribution are installed in
   clean consumers, and the Go external consumer is built from the same commit.
   Test registries are not part of the rehearsal.
2. Publish Python first. One distribution is the smallest production test of trusted publishing.
   Its PEP 740 attestations are verified on PyPI before the train continues.
3. Publish npm second. `@stablemates/workhorse` goes before its eight dependents, and every
   package's provenance is verified before the train continues.
4. Publish Go last. The `go/vX.Y.Z` tag is pushed after the gate passes, and the version is
   verified through the public module proxy.

Each verification checks registry visibility, provenance or the module checksum, and installation
of the exact public version in a clean environment. It then runs a minimal enqueue-and-worker smoke
test against a fresh PostgreSQL database. Any failure stops the release train: the defect is filed,
the remaining stages stay blocked, and the fix ships as a new candidate.

A published version is never reused. An ordinary defect stays available and receives a higher
fix. A security, secret, privacy, or legal exposure triggers credential rotation and removal where
the registry permits it. The response also deprecates the npm release, yanks the PyPI release, or
retracts the Go version as appropriate. Removal does not make prior public access reversible.
[`SECURITY.md`](../SECURITY.md) states how to report a vulnerability privately and which versions
receive fixes.

The first public beta did not run this way: fix-forwards spread it across three source commits.
The dated entries in [`CHANGELOG.md`](../CHANGELOG.md),
[`python/CHANGELOG.md`](../python/CHANGELOG.md), and [`go/CHANGELOG.md`](../go/CHANGELOG.md) name
those commits.

### npm packages

1. Update all TypeScript package versions in lockstep and add the `CHANGELOG.md` entry for the release,
   including upgrade notes for any breaking change.
2. Tag `vX.Y.Z`. The workflow requires a successful `main` CI push run for that commit and refuses
   a tag that disagrees with any manifest or lacks a `CHANGELOG.md` entry.
3. `pnpm npm:release-check` validates generated package assets, lint, dependencies, types, and unit
   behavior. It builds every tarball once, then installs and exercises those exact files in clean
   consumers against PostgreSQL.
4. The build job uploads the unchanged tarballs without publication credentials.
5. The protected `npm` environment requires approval, then publishes each package with
   `npm publish --provenance`. `@stablemates/workhorse` goes first because the other packages
   declare it as a peer.

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
4. The `pypi` environment generates PEP 740 attestations for the unchanged artifacts, then
   publishes both distributions and their attestations through trusted publishing.

### Go module

1. Add the intended version to `go/CHANGELOG.md` and commit the release candidate.
2. Run `scripts/release-go.sh X.Y.Z` from a clean worktree.
3. The script runs `pnpm check`, creates `go/vX.Y.Z`, and pushes the tag only after the gate passes.

The public repository requires pull requests and `CI / required` on `main`. Outside collaborators
require workflow approval. The protected `npm` and `pypi` environments require review and prevent
administrator bypass.

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
