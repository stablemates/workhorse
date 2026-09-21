# Database schema lifecycle

## Current policy

Schema version 6 is the migration baseline and schema version 23 is current. `sql/schema/current.sql` is the tracked source and
`sql/schema.sql` is a build artifact for published packages. `sql/releases/` holds the frozen
clean-install artifact of every supported published release: `0006.sql` is 0.2.0 and `0009.sql` is
0.2.1.
`sql/migrations/` holds the ordered steps that carry a baseline installation forward to the current
version; each new schema version adds one more step there.

**The migration chain begins at 0.2.0** ([ADR 0073](decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md),
amending [ADR 0053](decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)). The chain
began at 0.1.0, and 0.1.x produced no production install, so this project carries no database
forward from it. A database this project has agreed to carry forward exists from 0.2.0, so a schema
change is an upgrade rather than a reinstall. `sql/schema/current.sql` is no longer edited in place:
a change adds a migration step and applies the same change to the tracked source.

**Inside a major line, a migration only adds.** It may add a function, a view, a column, a table, or
an index. It may not rename, drop, or change the meaning of anything a supported release reads or
writes. A function is superseded by adding the next `_vN` beside it and retaining the old one; the
old one is removed at the next major release, never before. Every function already carries a
suffix, so every one of them can be superseded this way.

That rule is what makes a rolling deployment safe. A pipeline migrates the database before any
process from the new release starts, and every still-running process keeps working, because the
schema only grew.

Every schema change ships as an ordered, immutable step:

1. Add `sql/migrations/<NNNN>-<slug>.sql`. Its first line declares the step's kind, for example
   `-- workhorse-migration: {"kind":"additive"}`; a contract step writes
   `-- workhorse-migration: {"kind":"contract","retiresProtocolVersions":[<vN>]}`. The rest of the
   file is only the schema change body. A step that must run outside a transaction adds
   `"execution":"nontransactional"` to the same declaration; see
   [Non-transactional steps](#non-transactional-steps). The runtime supplies the transaction, the
   advisory lock, the starting-version validation, and the version bookkeeping; a body that
   contains its own `BEGIN`, `COMMIT`, `ROLLBACK`, `START TRANSACTION`, statement-ending `END` or
   `ABORT`, or `PREPARE TRANSACTION` is rejected before execution.
2. Apply the same change to `sql/schema/current.sql`, increment `WORKHORSE_SCHEMA_VERSION`, and add
   the step to `SCHEMA_MIGRATIONS` in `typescript/core/src/schema.ts` with its description and
   kind. The file's declaration and the entry must agree, and the runner refuses a step whose two
   declarations disagree. Clean
   installation inserts one `workhorse.schema_migration` row per lineage version from the baseline
   up, and a migrating database appends one row per step it applies, so both paths record every
   version from the baseline to the current one. A database installed before the chain was pruned
   also carries the rows below the baseline that it really applied.
3. Advance the compatibility manifest (`protocol/v1/manifest.json`,
   `protocol/v1/compatibility.json`) and the Python and Go client bounds
   (`python/src/workhorse/_protocol.py`, `go/compatibility.go`) with the same schema version. The
   package build generates its clean-install artifact from the tracked source.
4. When a version has shipped in a published release, freeze its clean-install artifact as
   `sql/releases/<NNNN>.sql`. Released artifacts and released migrations are never edited, and a
   released migration never renames a function or reinterprets its `_vN` suffix.

`typescript/core/test/schema-migrations.test.ts` iterates
whatever it contains, so the released-artifact check starts running by itself when the first
artifact lands. That test installs each released artifact, populates it, migrates it with
`migrateSchema`, and requires the `pg_dump --schema-only` result to match a clean installation of
the current artifact exactly. It also verifies the framework contract on a small synthetic fixture
chain: bookkeeping rows, gap rejection, transaction-control rejection, and atomic rollback of a
failing step.

A schema dump speaks for shape, not for rows, so the suite proves data survival separately.
`typescript/core/test/support/populated-schema.ts` seeds each artifact before it is migrated,
through the released schema's own SQL functions wherever one exists. The seed holds a task in every
state the schema can carry, a task set whose history spans more than one partition, a schedule with
its fired occurrence, a checkpoint and a wait, audit records, and a concurrency and a rate limit
policy. The test reads every seeded row back after the migration and compares whole rows by value,
because a count would pass a migration that rewrote a column. Rows are projected to the columns the
released artifact had, so an additive migration leaves the comparison alone.

The demo deployment remains the recurring rehearsal on real data, migrating from its pipeline
against a database it writes to continuously (`typescript/demo/DEPLOYMENT.md`). The suite is the
cheap, reproducible counterpart to it.

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
left unchanged. The current baseline needs no incremental migration.

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

### Non-transactional steps

A few PostgreSQL statements refuse to run inside a transaction block. `CREATE INDEX CONCURRENTLY`
is the one this project needs: an ordinary `CREATE INDEX` holds `SHARE` on its table until the
step commits, so every write to that table waits for the whole build, while the concurrent form
takes `SHARE UPDATE EXCLUSIVE` and lets writes through.

A step opts into that by declaring `execution` in both places its kind is declared:

```
-- workhorse-migration: {"kind":"additive","execution":"nontransactional"}
```

and `execution: "nontransactional"` on its `SCHEMA_MIGRATIONS` entry. The runner refuses a step
whose two declarations disagree, exactly as it does for `kind`. Omitting `execution` means
`transactional`, which is what every step before this class was and what a step should be unless a
statement in it cannot be.

Such a step buys availability with atomicity, and the resume semantics follow from that:

1. The starting-version guard runs first, so a database at the wrong version is never touched. It
   cannot be held across the body, because the body runs outside the transaction that would hold
   it.
2. The runner sends each statement of the body on its own, outside any transaction. `lock_timeout`
   is not set, because the statements this class exists for take a lock that does not block writes.
3. Bookkeeping runs last, in its own transaction, behind the advisory lock and behind a repeat of
   the guard. A peer migrator that got there first wins the step; this one fails the guard, and the
   runner accepts that outcome as the peer's success.

So a failure part-way leaves the earlier statements applied while the schema stays at the starting
version, and the rerun reapplies the body from the beginning. **Every statement in a
non-transactional body must therefore be idempotent**: write `CREATE INDEX CONCURRENTLY IF NOT
EXISTS` rather than `CREATE INDEX CONCURRENTLY`. The runner reports this shape distinctly, as
`failed part-way and rolled nothing back`, so it is never mistaken for an atomic rollback.

One leftover needs an operator's hand. A failed `CREATE INDEX CONCURRENTLY` leaves an invalid
index behind, and `IF NOT EXISTS` on the rerun sees that name taken and skips the build, so the
index stays invalid forever. Before rerunning a failed non-transactional step, list them and drop
what it left:

```sql
SELECT indexrelid::regclass AS index
FROM pg_index
WHERE NOT indisvalid AND indrelid::regclass::text LIKE 'workhorse.%';
```

```sql
DROP INDEX CONCURRENTLY IF EXISTS workhorse.<index>;
```

### Shipped migrations that block writes

No supported step builds an index non-concurrently. The two that did, `0003-named-budgets.sql` and
`0006-bounded-dashboard-reads.sql`, both start below the 0.2.0 baseline, so pruning the chain
removed them along with the operator pre-steps this section described
([ADR 0073](decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)). A step added from
now on that cannot take a lock cheaply declares `"execution":"nontransactional"` instead; see
[Non-transactional steps](#non-transactional-steps).

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
is the rollback path, and it discards tasks enqueued after the backup, so stop producers first for a
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
looks like. Pending contract steps report under `schema.pendingContractSteps`, a separate field, so
a gate never mistakes the operator's own schedule for a pending pipeline migration.

A migration fails in two shapes, and they recover differently. Tell them apart before acting: ask
whether the migrating command reported an error, or whether the process running it died.

**The command reported an error.** The step rolled back atomically, so recovery is diagnose and
rerun:

1. Read the error. The schema is still at the step's starting version; nothing partial persists.
2. Fix the environmental cause — privileges, disk, locks held by long transactions.
3. Rerun `migrateSchema` or `workhorse schema migrate`. The plan revalidates and reapplies the
   failed step from its recorded starting version.

**The process running the migration died.** A killed client does not cancel its migration. The
PostgreSQL backend runs the step's script to `COMMIT` on its own, and only reports the outcome to a
client still there to read it. So the schema may have advanced, and no error was printed to anyone.
Never infer from a dead process that the step did not commit.

That backend also keeps the advisory lock until its current statement finishes and it next writes to
the closed connection. Until then it is a migrator holding the lock with nobody driving it, and a
rerun waits behind it without a deadline, printing nothing. The wait is unbounded by design: the
runner disables `lock_timeout` around the advisory lock so a genuine peer migrator is never cut off,
and the lock timeout in the migration contract above bounds table locks inside the body instead.

Recover by ending the abandoned backends, then reading the version:

1. List the backends holding or waiting on the lock. An interrupted rerun is itself a migrator, so
   expect more than one:

   ```sql
   SELECT a.pid, a.state, l.granted, now() - a.xact_start AS age
   FROM pg_stat_activity a
   JOIN pg_locks l ON l.pid = a.pid
   WHERE l.locktype = 'advisory' AND a.datname = current_database();
   ```

2. End every one whose client is gone, with `pg_terminate_backend(pid)`. Terminating only the holder
   hands the lock to a queued backend, which then commits its own step unattended.
3. Read `workhorse.schema_version`. It says whether any of those backends committed.
4. Rerun `workhorse schema migrate` from that version. An already-current schema is left unchanged,
   so the rerun is safe whichever answer step 3 gave.

`workhorse schema status` answers whether this build accepts the installed schema. It does not
answer whether a migration finished. While a step is uncommitted, the command reads the
pre-migration version, reports it as current and compatible, and exits 0, because an uncommitted
transaction is invisible to it. Do not gate on it to decide that a migration which lost its process
completed; read `workhorse.schema_version` once the lock is free.

An uncommitted `ALTER TABLE` also holds `ACCESS EXCLUSIVE` on its table, so reads of that table
block for as long as the abandoned backend lives. `workhorse.schema_version` and
`workhorse.protocol_version` stay readable throughout, which is why they are what to read during an
incident.

If a migration cannot succeed because the released step itself is defective, do not edit it. Ship a
new release whose next migration corrects the result, or restore the backup and hold the old
release. Rerunning an unchanged defective step fails the same way and changes nothing, so the rerun
in the first procedure above is safe but not a fix. `workhorse schema status` reports the installed
schema version, the installed protocol versions, and PostgreSQL support at any point in this process.

## Supported upgrade window

A client accepts an installed schema at or above its own minimum and applies no upper bound of its
own, because the additive rule guarantees that a newer schema still carries every function an older
release calls.

That minimum is derived rather than authored. `scripts/sql-schema-floor.ts` reads `sql/releases/`
and `sql/migrations/` in schema-version order for the version that introduced each `workhorse.`
function, table, and view. It then reads every name the three generated statement catalogues and the
three dashboard read models write into SQL. `scripts/sql-schema-floor.test.ts` requires
`protocol/v1/manifest.json`'s `schema.minimumVersion` to cover the newest of those introductions. It
also requires the floor to stay at or below `schema.installedVersion`, so a release always accepts
its own clean installation. The floor rises when a release starts calling something new. A release
that runs below its floor would fail on the call itself, so the compatibility check refuses the
schema first. Because the pipeline migrates before any process from the new release starts, that
refusal never reaches a rolling deployment.

The bound closes only when the installed schema stops serving the client's protocol,
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

A database at or above the baseline may lag arbitrarily far behind. Every step from the baseline
upward stays in `sql/migrations/` and in `SCHEMA_MIGRATIONS`, so such a database migrates forward
with `workhorse schema migrate` — up to the first contract step, where the run stops and reports the
step it stopped before. Crossing that step takes one `workhorse schema contract` run, after which
`migrate` continues. An operator never skips a step: the runner applies every intervening step in
order.

**A database below the baseline is stranded, and that is deliberate.** The chain was pruned to the
0.2.0 baseline because 0.1.x had no production install
([ADR 0073](decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)). `migrateSchema`
refuses a schema below the baseline and names Workhorse 0.2.1, which is the last release carrying
the dropped steps: migrate to the baseline with that release, then upgrade. A 0.1.4-shaped database
cannot take even that route and is reinstalled, which is what 0.1.5 already required of it.
Pruning is not the standing rule. It was available here because the line had no production install,
which is decided by evidence rather than by age, and a published version that anyone runs stays in
the chain.

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
superseded functions and narrows `workhorse.protocol_version`. Its `SCHEMA_MIGRATIONS` entry and
the file's first line both declare `kind: "contract"` and name the retiring protocol versions, and
`workhorse schema migrate` stops before it and reports the step rather than applying it.

The operator applies it with `workhorse schema contract --yes`, once their own fleet is entirely on
the new major. The command applies exactly one pending contract step under the same advisory lock,
starting-version guard, and atomic rollback as every other step. Before `--yes` it applies nothing:
it reports the step, names every worker on a retiring protocol that heartbeated inside its lease —
including workers whose SDK predates the reporting columns and names no protocol — and states that
producers never register, so the registry is evidence and never proof that no caller remains. When
the pending step is additive instead, it says to run `workhorse schema migrate`.

The evidence is three nullable `workhorse.worker_registry` columns carried by the schema baseline:
`client_protocol_version`, `sdk_language`, and `sdk_version`. Each SDK stamps its own values at
registration and on every heartbeat that refreshes the row. `worker_client_protocols_v1()` groups
the workers whose last heartbeat falls inside their own `lease_ms` by the protocol version they
reported, and `workhorse schema status --json` reports it under `fleet`. A client that calls the SQL
protocol directly without reporting the three is counted under a null protocol version, which is the
population a contract step must not assume away. Producers never register, so this is evidence about workers and never an inventory
of every process using the database.

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

Application data is outside this lifecycle. Representative tasks, schedules, audit records, and
other seed or reset behavior live in `typescript/demo/` and are not shipped as core migrations.
The demo recreates its purpose-guarded database in development and preserves it in the production
shape.
