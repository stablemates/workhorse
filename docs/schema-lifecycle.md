# Database schema lifecycle

## Current pre-release policy

Schema version 23 is the forward-migration baseline. Workhorse does not derive migrations for
versions 1 through 22. Each later change adds one immutable file to `sql/migrations/`, increments
`WORKHORSE_SCHEMA_VERSION`, and updates the canonical current schema in
`sql/schema/current.sql`.

`pnpm schema:generate` derives the shipped clean-install artifact at `sql/schema.sql`, and
`pnpm schema:check` rejects a stale artifact. The artifact represents the latest schema directly;
it does not concatenate or replay the migration files.

The artifact contains only the current table, trigger, and function definitions. It contains no
in-place `ALTER TABLE` steps, retired function signatures, or `DROP ... IF EXISTS` upgrade
prologues. Idempotent `CREATE OR REPLACE` definitions let installation reconverge an already-current
schema without carrying old signatures forward.

`installSchema(database)` is explicit. It installs a clean database and accepts an already-installed
schema only when it exactly matches the current canonical version. It is not an upgrade mechanism.
Framework mounts call `assertSchemaCompatible(database)` and never create, seed, or alter database
objects.

`migrateSchema(database)` is the explicit upgrade path. It rejects an uninstalled schema, versions
below the baseline, versions newer than the runtime, and gaps in the ordered migration list. Each
migration file takes the `workhorse:schema-migration` transaction advisory lock, validates its
starting version after taking that lock, and commits one version step atomically. The first step is
`0024-add-schema-migration-ledger.sql`, which creates `workhorse.schema_migration` and advances the
single `workhorse.schema_version` row from 23 to 24.

`0025-make-schedule-occurrence-replay-a-no-op.sql` advances the schema from 24 to 25. The next step,
`0026-add-dashboard-read-surface.sql`, adds the core-owned versioned dashboard views and
planner-estimate function, then advances the schema from 25 to 26. Migration
`0027-add-job-priority.sql` adds strict-priority dispatch and advances the schema from 26 to 27.
`0030-add-job-dependencies.sql` adds success-only prerequisite dispatch and advances the schema from 29 to 30.
`0031-add-fan-in-dependency-policies.sql` adds bounded fan-in and terminal policies, advancing the schema from 30 to 31.
`0032-index-dependency-failures.sql` adds the dependency-failure operations index and advances the schema from 31 to 32.

`0028-add-keyed-debounce-enqueue.sql` adds keyed debounce and advances the schema from 27 to 28.

`0029-add-keyed-throttle-enqueue.sql` adds keyed throttle and advances the schema from 28 to 29.

`sql/schema/versions/0023.sql` preserves the supported baseline as a test fixture. It is immutable,
just like a released migration, and does not ship in the package. `test/schema-migrations.test.ts`
installs that fixture in one database, applies `migrateSchema(database)`, and compares its
schema-only dump with a second database created by `installSchema(database)`. The dump omits
ownership, privileges, comments, security labels, publications, and subscriptions. The test also
removes `pg_dump` headers and randomized restriction keys before comparison. The existing database
test suite includes this check, so its configured PostgreSQL matrix will exercise both paths when
repository CI is enabled.

Schema versions and SQL function versions are separate. A migration may add `claim_v3` while
retaining `claim_v2` for a compatibility window, but the migration's filename and target schema
version do not change either function suffix.

Application data is outside this lifecycle. In particular, all representative jobs, schedules,
audit records, and other seed/reset behavior live in `demo/` and are not shipped as core migrations.
The development command `pnpm demo` recreates the purpose-guarded demo database on every run so the
current canonical schema is always exercised from scratch. `pnpm demo:production` preserves its
database and represents the future deployable shape.

## Deployment order

Run migrations explicitly before new application instances start. Runtime and dashboard mounts
remain read-only with respect to DDL and fail on an incompatible version. A mixed fleet cannot span
a schema change unless both runtime versions already support the same SQL function versions.

## After production launch

Every schema change ships as a new immutable ordered migration. Released migrations are never edited.
The canonical schema remains useful for fresh installation, while the migration chain owns upgrades.
Destructive or long-running PostgreSQL changes require a separately rehearsed
expand/migrate/contract rollout and documented rollback or roll-forward procedure.
