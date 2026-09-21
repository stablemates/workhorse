# ADR 0073: Drop 0.1.x support and prune the migration chain to the 0.2.0 baseline

- **Status:** Accepted
- **Date:** 2026-09-21
- **Amends:** [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md)
- **Related:** [ADR 0055](0055-the-1-0-0-schema-boundary-adds-no-migration.md),
  [ADR 0057](0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md),
  [SM-812](https://linear.app/stablemates/issue/SM-812),
  [SM-838](https://linear.app/stablemates/issue/SM-838)

## Context

ADR 0053 started the ordered chain at 0.1.0 and froze `sql/releases/0001.sql` as its clean-install
artifact. It did so on a premise: 0.1.0 was published to three registries and named as usable for
early production adoption, so a reader who took that invitation had a database this project had
agreed to carry forward.

No reader took it. The 0.1.x line produced no production install. The only live instance was the
Workhorse demo, which is reinstalled rather than carried.

Two facts made the unused path expensive rather than merely idle.

SM-812 raised the derived schema floor to 18. A 0.1.x install is schema 1, so
`assertSchemaCompatible` already refuses every 0.1.x database at startup and no process from a
current release runs against one. The chain below the floor was reachable by `migrateSchema` and by
nothing else.

That path was also not sound end to end. The 0.1.0 baseline was re-cut at 0.1.5 for the unit-noun
rename ([ADR 0064](0064-rename-the-unit-noun-from-job-to-task.md)). On a 0.1.4-shaped database the
first step failed with a bare SQLSTATE 42703 that named no cause. SM-812 removed the probe that
turned that into a readable refusal, on the grounds that this decision removes the path.

So the repository shipped, tested, and documented five migration steps for a database shape that
nobody had and that one of the two 0.1.x shapes could not use anyway.

## Decision

**0.1.x is unsupported from 0.3.0.** It had no production installs, so no database is carried
forward from it.

**The migration chain begins at schema 6, the 0.2.0 baseline.**
`WORKHORSE_SCHEMA_BASELINE_VERSION` is 6 and `sql/releases/0006.sql` is the baseline clean-install
artifact. `SCHEMA_MIGRATIONS` begins at 6 → 7. `sql/migrations/0002`–`0006` and
`sql/releases/0001.sql` are deleted: each of those steps either starts below the baseline or
produces the baseline itself, so no supported database can run one.

**`migrateSchema` refuses a schema below the baseline by naming the release that still carries the
dropped steps.** Workhorse 0.2.1 shipped them. An operator holding a 0.1.5-shaped database migrates
to the baseline with 0.2.1, then upgrades. An operator holding a 0.1.4-shaped database reinstalls,
which is what 0.1.5 already required of them.

**This supersedes two promises ADR 0053 and `docs/schema-lifecycle.md` made.** The chain no longer
begins at 0.1.0, and it is no longer true that the chain is never pruned and that no database is
stranded. A database below the supported baseline is stranded, deliberately, and the refusal says
so.

**Pruning is not the rule; it is this one act.** It is available only where a line had no
production install, which is decided by evidence rather than by age. A published version that
anyone runs stays in the chain.

## Consequences

The additive rule is untouched. Inside a major line a migration still only adds, a client still
accepts any schema at or above its own floor, and a rolling deployment is still ordinary. Pruning
removes unreachable steps from the bottom of the chain; it removes nothing from an installed
database and changes no shipped function.

A clean installation now records `(6, 'baseline')` and one row per later step, so it stops claiming
to have applied steps this release does not ship. A database migrated from `0006.sql` or `0009.sql`
keeps the lineage its own artifact wrote, including the rows below the baseline that database
really has. The released-artifact rehearsal compares against both histories rather than one.

The derived floor is unaffected, at 18. `scripts/sql-schema-floor.ts` reads the ordered `sql/` tree
for the version that introduced each object, so an object older than the baseline now dates to the
baseline. That can only raise a derived floor, never lower one, which is the safe direction.

The frozen artifacts keep their meaning. `sql/releases/0006.sql` and `0009.sql` were taken from
tagged commits and are not edited here; only `0001.sql`, whose line is unsupported, is removed.

Two shipped steps that block writes are no longer documented, because neither can run: both
`0003-named-budgets.sql` and `0006-bounded-dashboard-reads.sql` start below the baseline, and the
operator pre-steps `docs/schema-lifecycle.md` gave for them no longer apply to any supported
database.

The next line pays this cost again only if it repeats the premise. A release that anyone installs
is carried forward.
