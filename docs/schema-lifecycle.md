# Database schema lifecycle

## Current pre-release policy

Until the first production-supported release, Workhorse keeps the canonical current schema in
`sql/schema/current.sql`. `pnpm schema:generate` derives the shipped clean-install artifact at
`sql/schema.sql`, and `pnpm schema:check` rejects a stale artifact. Development schema changes edit
the source and increment `WORKHORSE_SCHEMA_VERSION`. We intentionally do not accumulate migrations
while the data model is still moving quickly.

The artifact contains only the current table, trigger, and function definitions. It contains no
in-place `ALTER TABLE` steps, retired function signatures, or `DROP ... IF EXISTS` upgrade
prologues. Idempotent `CREATE OR REPLACE` definitions let installation reconverge an already-current
schema without carrying old signatures forward.

`installSchema(database)` is explicit. It installs a clean database and accepts an already-installed
schema only when it exactly matches the current canonical version. It is not an upgrade mechanism.
Framework mounts call `assertSchemaCompatible(database)` and never create, seed, or alter database
objects.

Application data is outside this lifecycle. In particular, all representative jobs, schedules,
audit records, and other seed/reset behavior live in `demo/` and are not shipped as core migrations.
The development command `pnpm demo` recreates the purpose-guarded demo database on every run so the
current canonical schema is always exercised from scratch. `pnpm demo:production` preserves its
database and represents the future deployable shape.

## Production baseline

Immediately before the first supported production release:

1. Freeze the then-current `sql/schema.sql` as migration `0001` and declare it the production
   baseline.
2. Add an ordered migration runner with an advisory lock, one transaction per migration where
   PostgreSQL permits it, checksums, status reporting, and independent schema/protocol versions.
3. Require migrations to run explicitly in deployment or CI before new application instances start.
4. Keep runtime and dashboard mounts read-only with respect to DDL. They should fail clearly on an
   incompatible version rather than attempting an opportunistic upgrade.
5. Test both a fresh install and every supported upgrade path from released versions.

## After production launch

Every schema change ships as a new immutable ordered migration. Released migrations are never edited.
The canonical schema remains useful for fresh-install equivalence tests, but the supported upgrade
path is the migration chain. Destructive or long-running PostgreSQL changes require a separately
rehearsed expand/migrate/contract rollout and documented rollback or roll-forward procedure.
