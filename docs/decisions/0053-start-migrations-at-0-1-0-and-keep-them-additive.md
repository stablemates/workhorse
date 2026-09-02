# ADR 0053: Start ordered migrations at 0.1.0 and keep every migration additive

- **Status:** Accepted
- **Date:** 2026-09-02
- **Amends:** [ADR 0034](0034-reset-the-pre-release-schema-baseline.md), [ADR 0042](0042-publish-the-first-public-beta.md), [ADR 0050](0050-release-0-1-0-without-a-prerelease-suffix.md)
- **Related:** [WH-604](https://ontrack.sh/projects/WH/issues/WH-604), [WH-607](https://ontrack.sh/projects/WH/issues/WH-607), [WH-605](https://ontrack.sh/projects/WH/issues/WH-605), [WH-582](https://ontrack.sh/projects/WH/issues/WH-582)

## Context

ADR 0034 point 4 deferred ordered migrations to 1.0.0. It was explicit that the version number did
not justify the rule. What justified it was a premise: no database existed that this project had
agreed to carry forward, so an upgrade path would have described an upgrade nobody could perform.

That premise expires at 0.1.0. The release is published to three registries and named as usable for
early production adoption. A reader who takes that invitation has a database.

The machinery was never the obstacle. `migrateSchema`, `applySchemaMigrationPlan`, the advisory
lock, the starting-version guard, and the bookkeeping all ship today.
`typescript/core/test/schema-migrations.test.ts` starts running by itself once `sql/releases/`
holds an artifact. The plan is empty, not missing.

Two facts make the change cheap now. The published betas are not carried forward: the only live
instance is the Workhorse demo, which is reinstalled. And WH-601 gave every function in the schema
a `_vN` suffix, which is the mechanism a compatible change needs.

Deferring the chain has a cost that grows. Every release published without it is a database that
must be recreated to move forward.

## Decision

**The migration chain starts at 0.1.0.** `sql/releases/0001.sql` freezes the 0.1.0 clean-install
artifact. From 0.2.0, a schema change ships as an ordered, immutable step under `sql/migrations/`.
`sql/schema/current.sql` stops being editable in place.

**Inside a major line, every migration only adds.** A migration may add a function, a view, a
column, a table, or an index. It may not rename, drop, or change the meaning of anything a
supported release reads or writes. A removal waits for the next major release. The `_vN` suffix is
how a function is superseded: a migration adds `claim_v2` and retains `claim_v1`.

**A client accepts a newer schema inside its major line.** It refuses an installed schema below its
minimum, and refuses one at or above the next major boundary. It does not refuse a schema that is
merely newer than the one it was built against, because the additive rule guarantees the functions
it calls are still present.

**Migration is a pipeline step, never automatic.** A deployment runs the migration once, from the
release pipeline, before any process from the new release starts. No component migrates on start.
No component is a singleton: the dashboard and every worker deploy on many nodes as part of an
ordinary application deploy, so a component that migrated itself would be many concurrent
migrators rather than one deliberate step.

**Expand and contract applies from 0.1.0.** The three-release procedure in
`docs/schema-lifecycle.md` is no longer reserved for 1.0.0.

Together these give a rolling upgrade. The pipeline migrates first. Every still-running process
keeps working, because the schema only grew. The new release then rolls out at its own pace.

## Consequences

The schema accumulates. A superseded function stays beside its replacement until a major release
removes it. That is the price of the promise, and it is visible in the schema rather than hidden in
a compatibility layer.

A rename costs two releases and a data change costs three. Nothing in the schema can be corrected
in place after 0.1.0, so a defective name is carried until the next major.

**Additive is necessary but not sufficient for an uninterrupted upgrade.** A logically additive
`ALTER TABLE` still takes an `ACCESS EXCLUSIVE` lock, and a long transaction delays it while every
later statement queues behind it. A worker holds long transactions by design. `lock_timeout` in the
migration runner and lock-cheap DDL are therefore part of the promise, not refinements of it.
WH-607 carries that work.

The CLI that runs the migration lives outside the application's dependency graph, so its version
can drift from the SDK the application depends on. Every mismatch fails loudly rather than
corrupting data: a CLI behind the application leaves the application refusing to start, and a CLI
that crosses a major boundary strands it. WH-605 pins the version and adds the verification step.

This answers WH-582. The additive rule is what makes a mixed fleet work, so rolling deploys need no
separate decision. What WH-582 still owns is how long a superseded function is retained.

"Public beta" keeps its meaning as a stability label and loses one clause. A 0.x minor may still
change behaviour and still requires reading the changelog. It no longer requires recreating the
database.
