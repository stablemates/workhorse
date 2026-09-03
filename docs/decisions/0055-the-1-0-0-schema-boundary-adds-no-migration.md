# ADR 0055: The 1.0.0 boundary adds no migration, and the last 0.x carries the final schema change

- **Status:** Accepted
- **Date:** 2026-09-02
- **Related:** [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
  [ADR 0054](0054-define-what-1-0-0-promises.md),
  [WH-580](https://ontrack.sh/projects/WH/issues/WH-580),
  [WH-584](https://ontrack.sh/projects/WH/issues/WH-584),
  [WH-608](https://ontrack.sh/projects/WH/issues/WH-608),
  [WH-614](https://ontrack.sh/projects/WH/issues/WH-614)

## Context

WH-580 asked when `sql/schema/current.sql` stops changing in place, and how a 0.x user reaches
1.0.0. Both halves have moved since the Issue was written.

ADR 0053 answered the first half by removing its premise. In-place editing already stopped, at
0.1.0. `sql/releases/0001.sql` freezes the 0.1.0 clean-install artifact, every change since ships as
an ordered step under `sql/migrations/`, and inside a major line a step may only add.

ADR 0054 answered most of the second half. 1.0.0 removes nothing and narrows nothing, so the last
upgrade of the beta is an ordinary rolling deployment rather than the one upgrade that stops every
process. It left one clause to this ADR: _when_ the last 0.x minor becomes schema-identical to
1.0.0.

That leaves a scheduling rule, its enforcement, and one gap the rule exposes. Every migration test
this project runs starts from an empty database. `typescript/core/test/schema-migrations.test.ts`
installs each released artifact, migrates it, and compares a `pg_dump --schema-only` result against
a clean installation. A schema dump says nothing about rows, so no test yet shows that a populated
database survives a migration.

## Decision

### There is no schema freeze

The schema keeps growing additively through 0.x, across 1.0.0, and through 1.x. "Freeze" named a
policy ADR 0053 retired, and reusing the word now would tell a reader the schema stops changing at
1.0.0, which it does not. The vocabulary is **the 1.0.0 boundary**.

### 1.0.0 adds no migration step

At 1.0.0, `WORKHORSE_SCHEMA_VERSION` equals the last 0.x minor's, `sql/migrations/` gains no file,
and no new artifact is frozen under `sql/releases/`. That is the whole content of "schema-identical"
in ADR 0054, and each of the three is visible in a diff.

### The cutoff is release-shaped, not date-shaped

A schema change is allowed up to and including the last 0.x minor. The 1.0.0 train opens when the
last Issue tagged `0.x-only` lands; from that commit onward a schema change is 1.1.0 work. Nothing
here needs a date, because the rule binds one release rather than a calendar, and the release before
1.0.0 is knowable the moment the train opens.

A defect found during the train is fixed by publishing another 0.x minor and reopening the train
behind it, never by adding a migration inside 1.0.0.

### The upgrade from the last 0.x is the ordinary one

`workhorse schema migrate`, then the package bump — the same two steps as every 0.x minor since
0.1.0. The migrate step is a no-op at this boundary, and it is still run. A procedure that
special-cases one release teaches the wrong procedure for every release after it, and
`migrateSchema` already leaves an already-current schema unchanged.

No swap-only path is offered, and none is needed. The question of whether to offer a migration from
the last 0.x was a question only while there was no chain; there is one, and this boundary is a step
inside it that happens to be empty.

### Enforcement is the release checklist, not a digest

The 1.0.0 candidate must show, against the last 0.x minor: an unchanged `WORKHORSE_SCHEMA_VERSION`,
no added file under `sql/migrations/`, and no added artifact under `sql/releases/`. WH-584 files that
as a checklist item on the 1.0.0 train.

No digest is pinned into `typescript/core/test/schema-installation.test.ts`. The released-artifact
test already requires every frozen artifact to migrate to a byte-identical clean installation, which
is a stronger statement than a digest of one baseline: it holds for every release, and it fails on
the drift a digest would only notice at the one version it pinned.

### The rehearsal is a populated database, in two places

**The demo is the recurring rehearsal.** Since WH-608 it migrates from its deployment pipeline
against a database it writes to continuously, so every demo deploy exercises `migrateSchema` on real
rows at real volume. The pre-deploy hook exiting non-zero is the signal, before any process from the
new release starts.

**The test suite gains a populated variant.** The released-artifact loop seeds each artifact before
migrating it — jobs across every status, a partitioned span, schedules, and audit rows — then
asserts both the schema dump match and that every seeded row survives with its values intact. That
is what proves a migration preserves data rather than merely shape. WH-614 carries it.

## Consequences

1.0.0 stops being a schema event. It moves no version, freezes no artifact, and its release notes
have nothing to say about the database beyond which versions it accepts. The interesting schema
release is the last 0.x minor, and that is where a reader's attention should be pointed.

The rule costs the train one release when a schema defect surfaces late. Publishing another 0.x
minor to carry the fix is slower than folding it into 1.0.0, and it is the price of a boundary that
a reader can trust without reading the diff.

The empty step at the boundary is deliberate and looks like waste. A deployment runs
`workhorse schema migrate` and nothing happens. That is the point: the procedure is the same one it
ran last month and will run next month.

Reusing the released-artifact test for the populated rehearsal makes that test slower and its
fixtures a maintained asset — seed data must keep covering the shapes a migration could damage. The
alternative is trusting a schema dump to speak for rows, which it cannot.
