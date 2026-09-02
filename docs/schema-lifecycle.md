# Database schema lifecycle

## Current policy

Schema version 1 is the whole schema. `sql/schema/current.sql` is the tracked source and
`sql/schema.sql` is a build artifact for published packages. `sql/releases/0001.sql` freezes the
0.1.0 clean-install artifact, and `sql/migrations/` holds every step after it.

**The migration chain begins at 0.1.0** ([ADR 0053](decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)).
A database this project has agreed to carry forward exists from that release, so a schema change is
an upgrade rather than a reinstall. `sql/schema/current.sql` is no longer edited in place: a change
adds a migration step and applies the same change to the tracked source.

**Inside a major line, a migration only adds.** It may add a function, a view, a column, a table, or
an index. It may not rename, drop, or change the meaning of anything a supported release reads or
writes. A function is superseded by adding the next `_vN` beside it and retaining the old one; the
old one is removed at the next major release, never before. Every function already carries a
suffix, so every one of them can be superseded this way.

That rule is what makes a rolling deployment safe. A pipeline migrates the database before any
process from the new release starts, and every still-running process keeps working, because the
schema only grew.

Every schema change ships as an ordered, immutable step:

1. Add `sql/migrations/<NNNN>-<slug>.sql` containing only the schema change body. The runtime
   supplies the transaction, the advisory lock, the starting-version validation, and the version
   bookkeeping; a body that contains its own `BEGIN`, `COMMIT`, `ROLLBACK`, or `START TRANSACTION`
   is rejected before execution.
2. Apply the same change to `sql/schema/current.sql`, increment `WORKHORSE_SCHEMA_VERSION`, and add
   the step to `SCHEMA_MIGRATIONS` in `typescript/core/src/schema.ts` with its description. Clean
   installation inserts one `workhorse.schema_migration` row per lineage version, so both paths
   record the identical baseline-to-current history.
3. Advance the compatibility manifest (`protocol/v1/manifest.json`,
   `protocol/v1/compatibility.json`) and the Python and Go client bounds
   (`python/src/workhorse/_protocol.py`, `go/compatibility.go`) with the same schema version. The
   package build generates its clean-install artifact from the tracked source.
4. When a version has shipped in a published release, freeze its clean-install artifact as
   `sql/releases/<NNNN>.sql`. Released artifacts and released migrations are never edited, and a
   released migration never renames a function or reinterprets its `_vN` suffix.

`typescript/core/test/schema-migrations.test.ts` iterates
whatever it contains, so the released-artifact check starts running by itself when the first
artifact lands. That test installs each released artifact, migrates it with `migrateSchema`, and
requires the `pg_dump --schema-only` result to match a clean installation of the current artifact
exactly. It also verifies the framework contract on a small synthetic fixture chain: bookkeeping
rows, gap rejection, transaction-control rejection, and atomic rollback of a failing step.

`installSchema(database)` is explicit. It installs a clean database and accepts an already-installed
schema only when it exactly matches the current canonical version. It is not an upgrade mechanism.
Framework mounts call `assertSchemaCompatible(database)` and never create, seed, or alter database
objects.

`migrateSchema(database)` is the explicit upgrade API. It rejects an uninstalled schema, versions
below the baseline, versions newer than the runtime, mixed version rows, and gaps in the ordered
plan. `workhorse schema migrate` exposes the same step from the CLI. An already-current schema is
left unchanged, which is every schema while the plan is empty.

## Migration execution contract

`applySchemaMigrationPlan` wraps every step in one transactional script:

1. `BEGIN`, then `pg_advisory_xact_lock(hashtext('workhorse:schema-migration'))`, so concurrent
   migrators serialize.
2. A guard that requires exactly one `workhorse.schema_version` row equal to the step's starting
   version, raising otherwise. The guard runs after the lock, so a competing migrator that
   committed first fails this check rather than reapplying the step.
3. The migration body.
4. Bookkeeping: advance `workhorse.schema_version`, refresh its `installed_at`, and insert the
   step's row into `workhorse.schema_migration`.
5. `COMMIT`. Any error rolls the entire step back; the schema is either at the starting version or
   at the target version, never between.

When a step fails because a concurrent migrator already committed the same step, the plan runner
re-reads the version and continues; that outcome is indistinguishable from its own success. Any
other failure surfaces as `Workhorse migration <file> failed and was rolled back`.

Migrations are transactional only. PostgreSQL statements that refuse to run inside a transaction
block, such as `CREATE INDEX CONCURRENTLY`, have no step class yet; one is defined when a released
change first needs it, together with its resume semantics.

`workhorse.schema_migration` records the installed migration history. `workhorse.protocol_version`
independently records which SQL protocol versions the installed schema serves, so a protocol
revision is never inferred from a schema version. That table is also the compatibility ceiling: a
client refuses an installed schema that no longer lists the protocol it speaks, and a major release
narrows the list when it removes a superseded function. A client applies no ceiling of its own,
because it cannot know at build time which later release will stop serving it. Schema versions and SQL function versions remain
separate: a migration may add `claim_v2` while retaining `claim_v1` for the rest of the major line.

## Expand and contract across deployments

This applies from 0.1.0. A change that spans application deployments rolls out in three releases,
so every running process version always finds the schema shape it expects:

1. **Expand.** A migration adds the new column, table, or function alongside the old one. New
   writes populate both shapes where needed. Old application versions keep working untouched.
2. **Migrate.** Application releases move reads, then writes, to the new shape. Backfills run as
   bounded, idempotent statements inside the expand or a follow-up migration, never as unbounded
   rewrites of large relations.
3. **Contract.** A later migration removes the old shape only after no supported application
   version reads or writes it.

Destructive or long-running changes require a separately rehearsed rollout with a documented
rollback or roll-forward decision before they ship. Dual-write compatibility views remain
rejected; the migration chain is the single authority.

## Backup, rollback, and failed-migration recovery

Take a backup before `migrateSchema` runs: a `pg_dump` of the database, or a provider snapshot or
PITR restore point. The migration framework has no down migrations by design; restoring the backup
is the rollback path, and it discards jobs enqueued after the backup, so stop producers first for a
clean rollback window.

Run migrations from a deployment step while application processes from the new release have not
started. Old processes fail closed: `assertSchemaCompatible` and the SQL protocol compatibility
checks refuse a version they do not expect rather than misreading it.

A failed migration rolls back atomically, so recovery is diagnose and rerun:

1. Read the error. The schema is still at the step's starting version; nothing partial persists.
2. Fix the environmental cause — privileges, disk, locks held by long transactions.
3. Rerun `migrateSchema` or `workhorse schema migrate`. The plan revalidates and reapplies the
   failed step from its recorded starting version.

If a migration cannot succeed because the released step itself is defective, do not edit it. Ship a
new release whose next migration corrects the result, or restore the backup and hold the old
release. `workhorse schema status` reports the installed schema version, the installed protocol
versions, and PostgreSQL support at any point in this process.

## Supported upgrade window

A client accepts an installed schema at or above its own minimum, up to the next major boundary.
Inside a major line there is no upper bound, because the additive rule guarantees that a newer
schema still carries every function an older release calls. At the boundary the bound closes: a
major release removes superseded functions, so a client from the previous major refuses a schema
that has crossed it.

`workhorse.protocol_version` is where the installed schema states that bound, and
`assertSchemaCompatible`, `AssertCompatible`, and `assert_compatible` read it in the same statement
that reads the schema version.

How long a superseded function is retained is not yet decided. `docs/compatibility.md` records the
range each release supports.

## Application data

Application data is outside this lifecycle. Representative jobs, schedules, audit records, and
other seed or reset behavior live in `typescript/demo/` and are not shipped as core migrations.
The demo recreates its purpose-guarded database in development and preserves it in the production
shape.
