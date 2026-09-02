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
| Go         | 1.25 and newer | 1.25    | The module pins pgx v5.9.2.                             |
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

The Go module declares Go 1.25 or newer and supports its pinned pgx 5.9.2 release. Its repository
lane exercises enqueue through pgx transactions, pgx pools, and `database/sql` with pgx stdlib. It
also compiles and runs a separate module through a local `replace` directive. Another external
module builds every Go example through the public import path. These tests prove the exported module
surface without repository-only imports. Pull requests and pushes run Go against the newest
PostgreSQL. The weekly schedule runs Go against every supported PostgreSQL major.

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
| `@stablemates/workhorse-dashboard`          | Operator dashboard and its framework-neutral host | `@stablemates/workhorse` >= 0.1.0-beta.1 and < 0.2, React 19                                                  |
| `@stablemates/workhorse-dashboard-server`   | Authenticated standalone dashboard server         | `@stablemates/workhorse-dashboard-contract`                                                                   |
| `@stablemates/workhorse-dashboard-contract` | Type-only dashboard server boundary               | None                                                                                                          |
| `stablemates-workhorse`                     | Python clients, workers, and WSGI dashboard       | None; includes Psycopg >= 3.3 and < 4; `asyncpg` extra supports >= 0.31 and < 1                               |

The nine TypeScript packages are versioned in lockstep and released from a single `vX.Y.Z` tag. An
optional TypeScript package always declares the core version it was released with as a peer range.
The Python package version floats independently and declares compatibility through SQL protocol 1
and schema version 1 instead of a TypeScript peer range.

The first public beta is `0.1.0-beta.2` for npm, `0.1.0-beta.1` for Go, and `0.1.0b3` for Python.
“Public beta” means the release is usable for evaluation and early production adoption without a
0.x compatibility promise.

The dashboard and core may use different patch releases within the same minor line. The dashboard
server reads `workhorse.dashboard_*_v1` views and versioned functions, so a core patch remains
compatible when its migration preserves those contracts.

While the line is `0.x`, any minor release may make a breaking change, including changing the
schema. There is no upgrade path between 0.x releases: moving between them requires a fresh
database. Ordered migrations begin at 1.0.0. Breaking changes are listed in
[`CHANGELOG.md`](../CHANGELOG.md) with the upgrade steps for that release.

The Python package releases independently from a `python/vX.Y.Z` tag. The tag must match
`python/pyproject.toml` and a heading in `python/CHANGELOG.md`. `.github/workflows/release-python.yml`
runs `pnpm check`, then uv builds a source distribution and universal wheel. A separate `pypi`
environment publishes those artifacts through PyPI trusted publishing with `id-token: write`.
Before publication, the publish job generates a PEP 740 attestation beside each distribution.

The Go module releases independently from a `go/vX.Y.Z` tag. `scripts/release-go.sh X.Y.Z` requires
a clean worktree and a matching `go/CHANGELOG.md` heading. It resets the test database, runs
`pnpm check`, creates an annotated tag, and pushes that tag to `origin`.

## Protocol and schema compatibility

The durable protocol is the PostgreSQL schema, not the TypeScript API. Its guarantees:

- **The schema is versioned and exact.** `WORKHORSE_SCHEMA_VERSION` in the runtime must equal the
  single row in `workhorse.schema_version`. `assertSchemaCompatible` refuses anything else, and it
  refuses on both sides: an older runtime against a newer schema fails just as loudly as the
  reverse. A mixed fleet mid-deploy is not supported.
- **Installation is clean-database only; migration owns upgrades from 1.0.0.** `installSchema`
  refuses to interpret an older or unversioned `workhorse` schema. While the line is `0.x` the
  schema changes in place and the migration plan is empty, so a schema change means a fresh
  database. `migrateSchema` applies ordered, immutable, transactional migrations forward from the
  baseline once the first step ships. `docs/schema-lifecycle.md` records the execution contract,
  the expand/contract rollout rules, and the backup and recovery guidance. The supported upgrade
  window is deliberately undefined until real released versions require one.
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

### First public beta release train

The first public beta was planned to publish from one source commit during one controlled release
window. It was a staged release rather than a concurrent one, and fix-forwards moved it across three
source commits. This is how it ran:

1. Rehearsal required a green public CI run for the candidate commit. `.github/workflows/release.yml`
   and `.github/workflows/release-python.yml` were dispatched manually with `dry-run` enabled. Every
   npm and Python archive was downloaded and inspected. All nine npm tarballs, the Python wheel, and
   the Python source distribution were installed in clean consumers, and the Go external consumer
   was built from the same commit. Test registries are not part of the rehearsal.
2. Publish Python first. `0.1.0b1` published from `6769c768d19861fb8c5c7ea3764e8d5abc62fcf4` and
   `0.1.0b2` from `0c15212cc5510501bbc9b74bd372fa480e77a1ff` on 2026-08-31. The workflow generated
   PEP 740 attestations for both but omitted them from the upload, so both remain public without
   provenance. The fix-forward `0.1.0b3` published from `663c526805746786f12b3be3e151e8ce06c80057`
   on 2026-09-01 with attestations and was verified through PyPI before the train continued.
3. Publish npm second. The `v0.1.0-beta.1` tag on `756c3ae1f73e7481ba065fefd35c051107ee614a`
   stopped before its first registry upload because npm parsed a relative tarball path as GitHub
   shorthand; it remains unpublished. The fix-forward `0.1.0-beta.2` published all nine packages
   from `856cdcf354aa83a3acf8ee67043145adb9c99e09` on 2026-09-01, `@stablemates/workhorse` before
   its eight dependents, and every package was verified before the train continued.
4. Publish Go last. `go/v0.1.0-beta.1` published from `dbd5437362930f712157ffcc72c3296e971e4f5a` on
   2026-09-01 and was verified through the public module proxy.

The three published versions therefore come from three source commits rather than one. Each source
commit is on `main` and had a green public CI run. The dated entries in `CHANGELOG.md`,
`python/CHANGELOG.md`, and `go/CHANGELOG.md` name the same commits.

Each verification checked registry visibility, provenance or the module checksum, and installation
of the exact public version in a clean environment. It then ran a minimal enqueue-and-worker smoke
test against a fresh PostgreSQL database. Any failure stops the release train.

A published version is never reused. An ordinary defect stays available and receives a higher
fix. A security, secret, privacy, or legal exposure triggers credential rotation and removal where
the registry permits it. The response also deprecates the npm release, yanks the PyPI release, or
retracts the Go version as appropriate. Removal does not make prior public access reversible.
[`SECURITY.md`](../SECURITY.md) states how to report a vulnerability privately and which versions
receive fixes.

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
