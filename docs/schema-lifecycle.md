# Database schema lifecycle

## Current policy

Schema version 1 is the whole schema. `sql/schema/current.sql` is the hand-edited source,
`sql/schema.sql` is the generated clean-install artifact, and `sql/migrations/` is empty.

**While the published line is `0.x`, the schema changes in place.** A schema change is a reinstall,
not an upgrade: edit `sql/schema/current.sql`, run `pnpm schema:generate`, and recreate the
database. Function names may be renamed and `_vN` suffixes reused freely, because no compatibility
window exists to protect.

What licenses that is not the version number, it is the promise attached to it. `0.x` states, in
`CHANGELOG.md` and `docs/compatibility.md`, that there is no upgrade path between releases. Nobody
can be running a database this project has agreed to carry forward. The moment that promise
changes, so does this policy.

**The migration chain begins at 1.0.0.** From the first stable major release, every schema change
ships as an ordered, immutable step:

1. Add `sql/migrations/<NNNN>-<slug>.sql` containing only the schema change body. The runtime
   supplies the transaction, the advisory lock, the starting-version validation, and the version
   bookkeeping; a body that contains its own `BEGIN`, `COMMIT`, `ROLLBACK`, or `START TRANSACTION`
   is rejected before execution.
2. Apply the same change to `sql/schema/current.sql`, increment `WORKHORSE_SCHEMA_VERSION`, and add
   the step to `SCHEMA_MIGRATIONS` in `typescript/core/src/schema.ts` with its description. Clean
   installation inserts one `workhorse.schema_migration` row per lineage version, so both paths
   record the identical baseline-to-current history.
3. Run `pnpm schema:generate` to refresh the shipped clean-install artifact at `sql/schema.sql`,
   and advance the compatibility manifest (`protocol/v1/manifest.json`,
   `protocol/v1/compatibility.json`) and the Python and Go client bounds
   (`python/src/workhorse/_protocol.py`, `go/compatibility.go`) with the same schema version.
4. When a version has shipped in a published release, freeze its clean-install artifact as
   `sql/releases/<NNNN>.sql`. Released artifacts and released migrations are never edited, and a
   released migration never renames a function or reinterprets its `_vN` suffix.

`sql/releases/` is empty until then. `typescript/core/test/schema-migrations.test.ts` iterates
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
revision is never inferred from a schema version. Schema versions and SQL function versions remain
separate: after 1.0.0 a migration may add `claim_v2` while retaining `claim_v1` for a compatibility
window.

## Expand and contract across deployments

This applies from 1.0.0. A change that spans application deployments rolls out in three releases,
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

Deliberately undefined. There is nothing to upgrade from yet. The window is defined when real
released versions make the full chain expensive to support, and it will be recorded here and in
`docs/compatibility.md`.

## Application data

Application data is outside this lifecycle. Representative jobs, schedules, audit records, and
other seed or reset behavior live in `typescript/demo/` and are not shipped as core migrations.
The demo recreates its purpose-guarded database in development and preserves it in the production
shape.
