# Compatibility and support boundary

This is the authoritative supported-version contract for the published Workhorse packages. The
version lists here are generated from the same constants CI uses: `typescript/core/src/support.ts` declares them,
`.github/workflows/ci.yml` runs them, and `typescript/core/test/support-matrix.test.ts` fails when this document,
that workflow, and the package `engines` fields disagree.

## What "supported" means

A version is supported when CI exercises it on every change to `main` and on every pull request.
Nothing weaker counts. In particular:

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
| Python     | 3.10–3.14      | 3.10    | `stablemates-workhorse` ships one `py3-none-any` wheel. |
| Go         | 1.25 and newer | 1.25    | The module pins pgx v5.9.2.                             |
| PostgreSQL | 15, 16, 17, 18 | 15      | No extension beyond the default `plpgsql` is installed. |

The TypeScript suite, including PostgreSQL integration, runs against every combination of the Node
and PostgreSQL lists. The packed-package install test runs on both Node majors against the newest
supported PostgreSQL. The demo smoke test runs on the lowest supported Node major.

Package managers: the repository is developed with pnpm, and the packed-install test installs the
published tarballs with pnpm. npm and yarn are not exercised in CI; the packages are plain ESM with
no install scripts, so nothing in them is package-manager specific.

The Python package declares Python 3.10 through 3.14 and includes Psycopg 3.3 through the next
major. Its `asyncpg` extra supports asyncpg 0.31 through the next major. Its package lane builds the
source distribution and universal wheel, checks inline types, runs both real drivers, and executes
every shared SQL scenario. `python/tests/test_release.py` installs the wheel and source distribution
bare, with the compatibility `psycopg` extra, and with the `asyncpg` extra. It runs the lifecycle and async enqueue examples without repository imports, then
checks that the active Python and PostgreSQL versions belong to this matrix. GitHub Actions remain
intentionally disabled while the repository is private; when they are restored, each declared
Python version and PostgreSQL major must run this lane before publication.

The Go module declares Go 1.25 or newer and supports its pinned pgx 5.9.2 release. Its repository
lane exercises enqueue through pgx transactions, pgx pools, and `database/sql` with pgx stdlib. It
also compiles and runs a separate module through a local `replace` directive. Another external
module builds every Go example through the public import path. These tests prove the exported module
surface without repository-only imports. The Go tests run against every PostgreSQL major supplied
to the lane. GitHub Actions wiring waits for the CI unfreeze.

## JS runtime smoke tier

Node.js is the only supported runtime. Bun and Deno sit in a deliberately weaker tier declared by
`SMOKE_TESTED_JS_RUNTIMES` in `typescript/core/src/support.ts`: the `runtime-smoke` CI lane runs
`typescript/core/test/runtime-smoke.ts` — `installSchema`, then an enqueue, claim, and complete
round-trip through the built `@stablemates/workhorse` entry point — against the newest supported
PostgreSQL, under the latest release of each runtime. A green lane proves the driver connects, the
schema installs, and one job completes there. It proves nothing else: the full vitest suites run
under Node.js only, so this tier carries no correctness claim beyond the round-trip.

What the validation run on 2026-08-17 (Bun 1.2.17, Deno 2.9.5) recorded:

- **Bun.** The smoke round-trip passes. The vitest suites cannot run at all: the default forks
  pool crashes in tinypool's process entry (`ReferenceError: Cannot access 'listeners' before
initialization`), and `--pool=threads` fails because Bun's `worker_threads` `MessagePort` lacks
  `addListener`. Harness incompatibility, not a library failure — but it means no fuller claim is
  possible.
- **Deno.** The smoke round-trip passes, and vitest itself runs: 563 of 601 unit tests and 467 of
  470 database tests pass. Every failure is a test that respawns `process.execPath` on the
  TypeScript sources — under Deno that child needs `--unstable-sloppy-imports` to resolve the
  repository's `.js`-suffixed imports of `.ts` files. The failures say nothing about the built
  package, which is plain ESM.

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

Nine packages ship from this repository. `@stablemates/workhorse` is the TypeScript durable queue;
`stablemates-workhorse` is the Python client and worker SDK; the rest are optional TypeScript packages.

| Package                            | Purpose                                           | Peer requirements                                                               |
| ---------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `@stablemates/workhorse`           | Queue, worker, schema, CLI                        | None; includes `pg` >= 8.16.3 and < 9                                           |
| `@workhorse-js/drizzle`            | Drizzle ORM provider                              | `@stablemates/workhorse`, `drizzle-orm` >= 0.45, `pg`                           |
| `@workhorse-js/prisma`             | Prisma ORM provider                               | `@stablemates/workhorse`, `@prisma/client` >= 6 and < 7                         |
| `@workhorse-js/typeorm`            | TypeORM provider                                  | `@stablemates/workhorse`, `typeorm` >= 0.3 and < 2                              |
| `@workhorse-js/kysely`             | Kysely provider                                   | `@stablemates/workhorse`, `kysely` >= 0.29 and < 0.30                           |
| `@workhorse-js/dashboard`          | Operator dashboard and its framework-neutral host | `@stablemates/workhorse` >= 0.1 and < 0.2, React 19                             |
| `@workhorse-js/dashboard-server`   | Authenticated standalone dashboard server         | `@workhorse-js/dashboard-contract`                                              |
| `@workhorse-js/dashboard-contract` | Type-only dashboard server boundary               | None                                                                            |
| `stablemates-workhorse`            | Python clients, workers, and WSGI dashboard       | None; includes Psycopg >= 3.3 and < 4; `asyncpg` extra supports >= 0.31 and < 1 |

The eight TypeScript packages are versioned in lockstep and released from a single `vX.Y.Z` tag. An
optional TypeScript package always declares the core version it was released with as a peer range.
The Python package version floats independently and declares compatibility through SQL protocol 1
and schema version 1 instead of a TypeScript peer range.

The dashboard and core may use different patch releases within the same minor line. The dashboard
server reads `workhorse.dashboard_*_v1` views and versioned functions, so a core patch remains
compatible when its migration preserves those contracts.

While the line is `0.x`, any minor release may make a breaking change, including changing the
schema. There is no upgrade path within `0.x`: the schema is edited in place, so moving between
`0.x` releases means installing the new schema on a fresh database. Ordered migrations begin at
1.0.0. Breaking changes are listed in [`CHANGELOG.md`](../CHANGELOG.md) with the upgrade steps for
that release.

The Python package releases independently from a `python/vX.Y.Z` tag. Its version comes from
`python/pyproject.toml`, and its release candidate is the source distribution plus universal wheel
produced by `pnpm python:build`. Before publication, the Python format, lint, type, test, packed, and
site smoke lanes must pass from that tag. Publication remains disabled while GitHub Actions are
frozen.

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
cancellation, durable checkpoints, durable timers, and graceful drain. Its release remains
unsupported until the runtime and worker module-consumer matrices exist.

## Release process

Every release is a tag, and every tag runs the full check suite before anything is published.

1. Update all six package versions in lockstep and add the `CHANGELOG.md` entry for the release,
   including upgrade notes for any breaking change.
2. Tag `vX.Y.Z`. The release workflow refuses to continue if the tag disagrees with any manifest or
   if `CHANGELOG.md` has no entry for it.
3. `pnpm check` runs — format, lint, types, unit and integration tests, the packed-package install
   test, the site smoke test, and the demo smoke test.
4. Each package is packed and published with `npm publish --provenance`. `@stablemates/workhorse` is
   published first, because the other five declare it as a peer.

**Provenance.** Every published tarball carries an npm provenance attestation linking it to this
repository, the commit it was built from, and the workflow that built it. Verify a downloaded
release with `npm audit signatures` in a project that depends on it, or inspect the "Provenance"
section on the package's npm page. A release without an attestation did not come from this
pipeline.

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
