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

A schema dump speaks for shape, not for rows. The rehearsal that shows a populated database
surviving a migration is the demo deployment, which migrates from its pipeline against a database it
writes to continuously (`typescript/demo/DEPLOYMENT.md`).

`installSchema(database)` is explicit. It installs a clean database and accepts an already-installed
schema only when it exactly matches the current canonical version. It is not an upgrade mechanism.
Framework mounts call `assertSchemaCompatible(database)` and never create, seed, or alter database
objects. A refusal throws `SchemaCompatibilityError`. Catch that type when a caller must act on the
verdict rather than log it: its `code` names the refusal in the vocabulary Python's
`ProtocolCompatibilityError` and Go's `CompatibilityError` share, and `installedVersion` and
`expectedVersion` name the two versions that disagree. A database the check cannot read at all
throws a plain error instead, because an unreachable database says nothing about versions.

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
   version reads or writes it. When the removal narrows `workhorse.protocol_version`, that step
   ships as a contract step the operator runs deliberately, not as part of `workhorse schema
migrate`; see [Contract steps and the major boundary](#contract-steps-and-the-major-boundary).

Destructive or long-running changes require a separately rehearsed rollout with a documented
rollback or roll-forward decision before they ship. Dual-write compatibility views remain
rejected; the migration chain is the single authority.

## Backup, rollback, and failed-migration recovery

Take a backup before `migrateSchema` runs: a `pg_dump` of the database, or a provider snapshot or
PITR restore point. The migration framework has no down migrations by design; restoring the backup
is the rollback path, and it discards jobs enqueued after the backup, so stop producers first for a
clean rollback window. The absence of down migrations is the decision, not a gap in one: a reversed
migration cannot restore rows a forward step interpreted, so a restore is the only rollback that
means what it says
([ADR 0057](decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)).

Run migrations from a deployment step before any process from the new release starts. Processes
from the previous release keep running against the migrated schema, because inside a major line a
migration only adds. Only the two ends fail closed: `assertSchemaCompatible` and the SQL protocol
compatibility checks refuse a schema below the release's minimum, and refuse one whose
`workhorse.protocol_version` no longer lists the protocol the release speaks.

Verify between the two steps. `workhorse schema status --json` exits 1 when the running build would
refuse the installed schema, and reports `schema.compatible`, `schema.refusal`, and
`schema.refusalCode` for a deployment gate to read. The code is the one
`SchemaCompatibilityError.code` would carry, so a gate and the process that starts after it name
the same refusal. `schema.state` reporting `ahead` is not a failure; it is what a rollout in progress
looks like.

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

A client accepts an installed schema at or above its own minimum and applies no upper bound of its
own, because the additive rule guarantees that a newer schema still carries every function an older
release calls. The bound closes only when the installed schema stops serving the client's protocol,
which is one deliberate step and not a version number: a major release still adds, and the operator
narrows the schema later with `workhorse schema contract`. Until that step runs, a client from the
previous major keeps working against a schema in the new major line.

`workhorse.protocol_version` is where the installed schema states that bound, and
`assertSchemaCompatible`, `AssertSchemaCompatible`, and `assert_compatible` read it in the same
statement that reads the schema version.

**1.0.0 is not that boundary** ([ADR 0054](decisions/0054-define-what-1-0-0-promises.md)). It removes
no superseded function and narrows `workhorse.protocol_version` by nothing, so a 0.x client keeps
working against a 1.0.0 schema and the upgrade is an ordinary rolling deployment. Removals
accumulated during 0.x wait for the first contract step of the 2.x line. A breaking change to this
surface is a narrowing of `workhorse.protocol_version`, not a schema-version bump.

A superseded function is retained until a major release has shipped that supersedes it **and**
twelve months have passed since the release that shipped its successor, whichever is later
([ADR 0057](decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)).
Retention is not support: keeping the old function beside the new one costs schema size and nothing
else, so it is promised on a date rather than on a release number. `SECURITY.md` states which
released versions receive fixes, and `docs/compatibility.md` records the range each release supports.

A database may lag arbitrarily far behind. The migration chain is never pruned, so every released
step stays in `sql/migrations/` and in `SCHEMA_MIGRATIONS` and a database at any released version
migrates forward in one `workhorse schema migrate` run. There is no version below which a database
is stranded, and an operator never skips a step: the runner applies every intervening step in order.

## The 1.0.0 boundary

There is no schema freeze ([ADR 0055](decisions/0055-the-1-0-0-schema-boundary-adds-no-migration.md)).
The schema grows additively through 0.x, across 1.0.0, and through 1.x. In-place editing of
`sql/schema/current.sql` already stopped, at 0.1.0.

**1.0.0 adds no migration step.** Its `WORKHORSE_SCHEMA_VERSION` equals the last 0.x minor's,
`sql/migrations/` gains no file, and no new artifact is frozen under `sql/releases/`. The last 0.x
minor carries the final schema change before the boundary, and the release train for 1.0.0 opens
once that release ships. A schema change proposed after the train opens belongs to 1.1.0. A defect
found during the train is fixed by publishing another 0.x minor, never by adding a migration inside
1.0.0.

So the upgrade from the last 0.x to 1.0.0 is the ordinary one:

1. Run `workhorse schema migrate` from the deployment pipeline. It is a no-op at this boundary and
   is still run, because a procedure that special-cases one release teaches the wrong procedure for
   the releases after it. `migrateSchema` leaves an already-current schema unchanged.
2. Roll the fleet onto the 1.0.0 packages.

There is no swap-only upgrade path and no separate migration guide. The three statements a 0.x
reader is given at the boundary are in the 1.0.0 changelog entry and on the site's compatibility
page ([ADR 0054](decisions/0054-define-what-1-0-0-promises.md)).

Two mechanisms hold the rule. The release checklist compares the 1.0.0 candidate against the last
0.x minor and requires an unchanged schema version, no added migration, and no added released
artifact. `typescript/core/test/schema-migrations.test.ts` requires every frozen artifact to migrate
to a schema byte-identical to a clean installation, which is what catches drift in any release, not
only this one. No baseline digest is pinned.

## Contract steps and the major boundary

A major release adds; it does not remove. Its migrations are additive like every other migration,
and it keeps serving every protocol its predecessor served, so a major upgrade is an ordinary
rolling deployment and a fleet on the previous major keeps running while the new one rolls out.

Removal is a **contract step**: a separate migration, shipped by the new major line, that drops
superseded functions and narrows `workhorse.protocol_version`. `workhorse schema migrate` never
applies it. The operator applies it with `workhorse schema contract`, once their own fleet is
entirely on the new major. That command refuses while `workhorse.worker_registry` shows a worker on
the retiring protocol heartbeating inside its lease, names the workers it can see, states that it
cannot see producers, and requires explicit confirmation.

Two consequences follow. `workhorse.protocol_version` is operator state rather than release state,
so two databases at the same schema version may serve different protocol sets; the compatibility
check is unaffected because it reads that table instead of inferring a bound from the schema
version. And a clean install of a major line installs the contracted shape while a database migrated
into it keeps the retained functions until it contracts. The dump-equality guarantee that
`typescript/core/test/schema-migrations.test.ts` enforces is therefore scoped to inside a major line;
it catches drift in every release up to the first contract step, and that step is what will need it
restated.

`dashboard_*_v1` views are schema objects under the same rules. A migration may add a column to a
shipped view and may not remove one, retype one, or change what one means; a new shape is
`dashboard_*_v2` beside it, retained and contracted on the same schedule. A core upgrade therefore
never requires a dashboard release inside a major line.

## Application data

Application data is outside this lifecycle. Representative jobs, schedules, audit records, and
other seed or reset behavior live in `typescript/demo/` and are not shipped as core migrations.
The demo recreates its purpose-guarded database in development and preserves it in the production
shape.
