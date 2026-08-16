# Database schema lifecycle

## Current pre-release policy

Schema version 42 is the current pre-release baseline. Workhorse has no published database to
upgrade, so versions 1 through 41 are unsupported and have no derived migration history.

Until the first public release, each schema change updates `sql/schema/current.sql` directly and
increments `WORKHORSE_SCHEMA_VERSION`. `pnpm schema:generate` derives the shipped clean-install
artifact at `sql/schema.sql`, and `pnpm schema:check` rejects a stale artifact. The compatibility
manifest advances with the same schema version.

The artifact contains only the current table, trigger, and function definitions. It contains no
in-place `ALTER TABLE` steps, retired function signatures, or upgrade prologues. Idempotent
definitions let installation reconverge an already-current schema without retaining old
signatures.

`installSchema(database)` is explicit. It installs a clean database and accepts an already-installed
schema only when it exactly matches the current canonical version. It is not an upgrade mechanism.
Framework mounts call `assertSchemaCompatible(database)` and never create, seed, or alter database
objects.

`migrateSchema(database)` remains the explicit upgrade API. On the pre-release line, it accepts the
current baseline without mutation. It rejects an uninstalled schema, older versions, newer versions,
and mixed version rows. Existing development databases must be recreated with `pnpm worktree:setup`
after a schema change.

The forward-only engine remains tested independently of retired product history.
`typescript/core/test/schema-migrations.test.ts` installs a small synthetic baseline, applies two
ordered fixture steps, and compares its schema-only dump with a clean installation of the fixture's
current schema. The dump omits ownership, privileges, comments, security labels, publications, and
subscriptions. The test also removes `pg_dump` headers and randomized restriction keys before
comparison.

Schema versions and SQL function versions are separate. A migration may add `claim_v3` while
retaining `claim_v2` for a compatibility window, but the migration's target schema version does not
change either function suffix.

Application data is outside this lifecycle. Representative jobs, schedules, audit records, and
other seed or reset behavior live in `typescript/demo/` and are not shipped as core migrations.
The demo recreates its purpose-guarded database in development and preserves it in the production
shape.

## Deployment order

Before the first public release, install the current schema into a clean database before new
application instances start. Runtime and dashboard mounts remain read-only with respect to DDL and
fail on an incompatible version.

## After the first public release

The first installable schema becomes the permanent migration baseline. Every later schema change
ships as a new immutable ordered migration, and released migrations are never edited. The canonical
schema remains the clean-install path, while the migration chain owns upgrades.

Each migration takes the `workhorse:schema-migration` transaction advisory lock, validates its
starting version after taking that lock, and commits one version step atomically. Destructive or
long-running PostgreSQL changes require a separately rehearsed expand, migrate, and contract rollout
with a documented rollback or roll-forward procedure.
