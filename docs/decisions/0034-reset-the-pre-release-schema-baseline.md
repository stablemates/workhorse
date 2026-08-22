# ADR 0034: Reset the pre-release schema to one baseline at version 1

- **Status:** Accepted
- **Date:** 2026-08-22
- **Related:** [ADR 0027](0027-keep-versioned-dashboard-views.md), [ADR 0028](0028-flat-per-language-repository-layout.md)
- **Amends:** the migration policy in `docs/schema-lifecycle.md`

## Context

The repository carried schema version 47, four migration files, and a frozen 378 KB
`sql/releases/0043.sql` baseline artifact. Seven SQL functions carried a `_vN` suffix above 1 —
`claim_v3`, `heartbeat_v2`, `list_jobs_v2`, `list_job_timeline_v2`, `list_dead_letters_v2`,
`register_worker_v2`, and `enqueue_many_v2` — and two of those shipped alongside a live `_v1` kept
for a compatibility window.

Nothing has been published. `CHANGELOG.md` records the line as `0.1.0 — unreleased`, and
`docs/features.md` already listed clean-install-only schema management. No database exists that
this project has agreed to carry forward, so every one of those artifacts recorded an upgrade
nobody could have performed and a compatibility window nobody could have been inside.

The cost of keeping them was not storage. It was that each one told a reader something false: that
`claim_v1` had been retired, that `register_worker_v1` served older callers, that the migration
chain had a history. A new SDK author reading the schema would have reproduced those assumptions.

## Decision

Reset the pre-release schema to a single baseline.

1. `sql/schema/current.sql` is the whole schema at version 1. `sql/migrations/` and
   `sql/releases/` are empty. A clean install seeds one `workhorse.schema_migration` row.
2. Every SQL function and view is at `_v1`. The five names with no live `_v1` were renamed down.
   The two that collided were resolved by name, not by number: the single-queue `register_worker_v1`
   shim was deleted and the multi-queue function took the name, and the internal batch function
   became `enqueue_batch_v1` so the public wrapper could become `enqueue_many_v1`. That split is
   real and stays — `enqueue_batch_v1` is the shared insert path under `enqueue_v1`,
   `enqueue_debounce_v1`, `enqueue_throttle_v1`, and `enqueue_many_v1`.
3. The clean-install artifact contains no upgrade residue. The `DO $migration$` block that renamed
   `create_child_v1` to `create_single_child_v1` is gone; the function is declared under its own
   name. `typescript/core/test/schema-installation.test.ts` now rejects `ALTER FUNCTION` and
   `DO $migration$` in the artifact alongside the existing `ALTER TABLE` and `DROP … IF EXISTS`
   checks, and asserts that no installed function or view carries a suffix above `_v1`.
4. **The schema changes in place while the published line is `0.x`. Ordered, immutable migrations
   begin at 1.0.0.**

Point 4 is the durable rule, and the version number is not what justifies it. What justifies it is
the promise attached to `0.x`: `CHANGELOG.md` and `docs/compatibility.md` state that there is no
upgrade path between `0.x` releases, so a schema change means installing on a fresh database. In
place edits are safe precisely as long as that promise holds. If a `0.x` release ever needs a
user's database to survive an upgrade, the chain starts there instead, whatever the version says.

The migration framework stays. `migrateSchema`, `workhorse schema migrate`, the
`workhorse:schema-migration` advisory lock, the starting-version guard, and atomic per-step
rollback are all retained and still tested against a synthetic fixture chain. Only the plan is
empty. Keeping it means the first real step at 1.0.0 exercises reviewed machinery rather than newly
written machinery.

## Consequences

### Positive

- The schema stops describing history it does not have. A reader of `sql/schema.sql` sees one
  version of everything.
- 438 KB of duplicated SQL leaves the repository, and `pg_dump` comparisons no longer have two
  sources to reconcile.
- A future SDK author cannot infer a compatibility window from a `_vN` suffix that never protected
  anything.
- Renaming stays available for the rest of `0.x`, which is when the remaining
  language-local designs — contracts, cron evaluation, the dashboard read model — are expected to
  move into SQL and will want to name things properly.

### Negative

- Every `workhorse.*_vN` reference moved at once: roughly 370 in TypeScript, 26 Go statements, 44
  Python statements, the `protocol/v1` manifest and scenarios, the `dashboard/v1` conformance
  fixtures, and about 300 documentation mentions.
- Existing development worktrees must run `pnpm worktree:setup` to recreate their databases.
- ADRs and dated benchmark analyses still name the old identifiers (see below), so a `git grep` for
  `claim_v3` finds records rather than nothing.

## What was deliberately not renamed

Dated records keep the names that were true when they were written:

- `docs/benchmarks/*.md` and `docs/benchmarks/results/*.json` describe specific runs at specific
  commits. Renaming would misreport what was measured.
- [ADR 0009](0009-enqueue-idempotency-keys.md) and
  [ADR 0010](0010-cooperative-job-cancellation.md) decided to introduce `enqueue_many_v1` and
  `heartbeat_v2`. Both names now denote different functions, so each carries a note pointing here
  rather than a rewritten body. An ADR records a decision; it is not a description of the current
  schema.

## Rejected alternatives

### Keep version 47 and only delete the migration files

Cheaper, and it avoids moving the version constants in five places. But the number 47 is itself the
false history: it counts steps that never ran anywhere. Keeping it means every future reader asks
what happened to versions 1 through 46.

### Keep the `_vN` suffixes and squash only the migrations

Less churn across roughly 800 call sites. It leaves the worse half of the problem: `claim_v3`
implies `claim_v1` and `claim_v2` existed and were withdrawn, and `register_worker_v1` implies
someone is still calling the single-queue form.

### Delete the migration framework until 1.0.0

Smallest surface. Rejected because the framework is already written, reviewed, and covered by
contract tests for gap rejection, transaction-control rejection, and atomic rollback. Deleting it
would mean rebuilding and re-reviewing it under the pressure of the first real migration.

## Validation

`pnpm schema:generate` reproduces `sql/schema.sql` byte for byte. A clean install reports schema
version 1, one `schema_migration` row, and protocol version 1. No installed function or view
carries a suffix above `_v1`, and the artifact contains no `ALTER TABLE`, `ALTER FUNCTION`,
`DROP … IF EXISTS`, or `DO $migration$`. The SQL protocol conformance run, the Go statement
registry check, the Python compatibility fixtures, and the `dashboard/v1` conformance fixtures all
pass against the renamed functions.
