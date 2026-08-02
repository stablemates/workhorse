# Database schema lifecycle

## Current pre-release policy

Until the first production-supported release, Workhorse keeps one canonical clean-install schema in
`sql/schema.sql`. Development schema changes edit that file in place and increment
`WORKHORSE_SCHEMA_VERSION`. We intentionally do not accumulate migrations while the data model is
still moving quickly.

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
