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
  part way through `sql/schema.sql`, and `workhorse schema status` reports the server version and
  which of these three categories it falls into.

This boundary is about correctness only. It is not a performance claim; see
[Benchmark validation is not the support boundary](#benchmark-validation-is-not-the-support-boundary).

## Supported versions

| Runtime    | Supported      | Minimum | Notes                                                   |
| ---------- | -------------- | ------- | ------------------------------------------------------- |
| Node.js    | 22, 24         | 22      | Even-numbered releases only. `engines.node` is `>=22`.  |
| PostgreSQL | 15, 16, 17, 18 | 15      | No extension beyond the default `plpgsql` is installed. |

The full test suite, including the PostgreSQL integration suite, runs against every combination of
those two lists. The packed-package install test runs on both Node majors against the newest
supported PostgreSQL. The demo smoke test runs on the lowest supported Node major.

Package managers: the repository is developed with pnpm, and the packed-install test installs the
published tarballs with pnpm. npm and yarn are not exercised in CI; the packages are plain ESM with
no install scripts, so nothing in them is package-manager specific.

## Packages and versioning

Six packages ship from this repository. `@workhorse/core` is the durable queue; the rest are
optional.

| Package                | Purpose                                           | Peer requirements                                |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------ |
| `@workhorse/core`      | Queue, worker, schema, CLI                        | `pg` >= 8.13                                     |
| `@workhorse/drizzle`   | Drizzle ORM provider                              | `@workhorse/core`, `drizzle-orm` >= 0.45, `pg`   |
| `@workhorse/prisma`    | Prisma ORM provider                               | `@workhorse/core`, `@prisma/client` >= 6 and < 7 |
| `@workhorse/typeorm`   | TypeORM provider                                  | `@workhorse/core`, `typeorm` >= 0.3 and < 2      |
| `@workhorse/kysely`    | Kysely provider                                   | `@workhorse/core`, `kysely` >= 0.29 and < 0.30   |
| `@workhorse/dashboard` | Operator dashboard and its framework-neutral host | `@workhorse/core` >= 0.1 and < 0.2, React 19     |

The seven published packages are versioned in lockstep and released from a single `vX.Y.Z` tag. An
optional package always declares the core version it was released with as a peer range. Mixing
versions across the set is not supported.

The dashboard and core may use different patch releases within the same minor line. The dashboard
server reads `workhorse.dashboard_*_v1` views and versioned functions, so a core patch remains
compatible when its migration preserves those contracts.

While the line is `0.x`, any minor release may make a breaking change, including a schema version
bump. Breaking changes are listed in [`CHANGELOG.md`](../CHANGELOG.md) with the upgrade steps for
that release.

## Protocol and schema compatibility

The durable protocol is the PostgreSQL schema, not the TypeScript API. Its guarantees:

- **The schema is versioned and exact.** `WORKHORSE_SCHEMA_VERSION` in the runtime must equal the
  single row in `workhorse.schema_version`. `assertSchemaCompatible` refuses anything else, and it
  refuses on both sides: an older runtime against a newer schema fails just as loudly as the
  reverse. A mixed fleet mid-deploy is not supported.
- **Installation is clean-database only.** `installSchema` refuses to interpret an older or
  unversioned `workhorse` schema. `migrateSchema` owns explicit forward upgrades from the version 23
  baseline, while earlier versions still require a fresh schema or a separately engineered path.
- **Correctness-sensitive transitions stay in versioned SQL functions.** Claim, completion, retry,
  cancellation, deadline, and maintenance transitions are owned by SQL. A client that speaks the
  same schema version speaks the same protocol, whatever language it is written in.
- **Job payloads are caller-owned JSON.** Workhorse stores and returns them unchanged. Trace context
  and other Workhorse metadata are kept beside the payload, never merged into it.
- **The dashboard's oRPC transport is private.** It is an implementation detail between
  `@workhorse/dashboard` and its own client, and it changes without a schema version bump. Do not
  build against it; the supported operator surface is the `Queue` query API.

Only the TypeScript client and worker implement this protocol as a supported SDK today. Protocol
portability does not make an untested language implementation supported. Python and Go become
supported only after their own runtime, driver, PostgreSQL, packed-artifact, and compatibility
matrices run in CI.

## Release process

Every release is a tag, and every tag runs the full check suite before anything is published.

1. Update all six package versions in lockstep and add the `CHANGELOG.md` entry for the release,
   including upgrade notes for any breaking change.
2. Tag `vX.Y.Z`. The release workflow refuses to continue if the tag disagrees with any manifest or
   if `CHANGELOG.md` has no entry for it.
3. `pnpm check` runs — format, lint, types, unit and integration tests, the packed-package install
   test, the site smoke test, and the demo smoke test.
4. Each package is packed and published with `npm publish --provenance`. `@workhorse/core` is
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
