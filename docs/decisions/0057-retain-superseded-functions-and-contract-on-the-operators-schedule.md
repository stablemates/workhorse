# ADR 0057: Retain superseded functions for a stated window and contract on the operator's schedule

- **Status:** Accepted
- **Date:** 2026-09-02
- **Amends:** [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
  [ADR 0027](0027-keep-versioned-dashboard-views.md)
- **Related:** [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0034](0034-reset-the-pre-release-schema-baseline.md),
  [WH-582](https://ontrack.sh/projects/WH/issues/WH-582),
  [WH-576](https://ontrack.sh/projects/WH/issues/WH-576),
  [WH-584](https://ontrack.sh/projects/WH/issues/WH-584)

## Context

WH-582 was charted when `assertSchemaCompatible` refused a mismatch in either direction, so every
schema change stopped every worker and producer. That premise no longer holds. ADR 0053 made
migrations additive and gave the runtime a floor with no ceiling inside a major line, and ADR 0054
established that 1.0.0 removes nothing. Rolling deploys and mixed fleets are answered. The backup,
rollback, and failed-migration path is written down, and `workhorse schema status --json` already
reports `schema.state` and `schema.compatible` as two independent facts so a deployment gate can
read one and an operator can read the other.

What both ADRs left is the far end of the same promise. ADR 0053 says a superseded `_vN` function is
"removed at the next major release, never before". That is a floor with no ceiling and no date. A
major release is an undated event, so an operator reading it learns only that the function will
survive an unknown length of time and then disappear at a moment they did not choose. It is not a
promise anyone can plan an upgrade against.

The undated event is worse than vague, because it is the one event in the product's life that stops
a fleet. Removing a function narrows `workhorse.protocol_version`, and every runtime that speaks the
removed protocol refuses at once, in the same statement it uses to read the schema version. ADR 0054
spent a permanently larger schema to keep the 1.0.0 boundary uneventful, on the reasoning that the
cost of a stopped fleet lands on exactly the readers who accepted the invitation to run early. That
reasoning does not stop being true at 2.0.0.

It is also an ordering that cannot work. Inside a major line the deployment order is fixed: migrate
first, then roll out, because the schema only grows. At a boundary that inverts and then contradicts
itself. Migrating first narrows the protocol and stops the fleet that has not rolled out yet.
Rolling out first gives the new release a schema that lacks the functions it calls. There is no
order in which a single narrowing migration and a fleet rollout are both safe, so as long as
removal is welded to the major release, a major upgrade is an outage by construction.

WH-576 found the same shape in the survey. Every painful upgrade it recorded — pg-boss v10 to v11,
Graphile Worker 0.14.0 — was a release that removed or rebuilt something while users were mid-fleet.
River Pro is the counterexample and it is the shape this ADR takes: "Run v6 first, deploy v0.24.0 to
all River Pro nodes, and run v7 only after the rollout is complete." The removal is a step the
operator runs when their own fleet is ready, not a step a release performs on their behalf.

## Decision

### A major release adds; a separate contract step removes

A major release is an ordinary rolling deployment. Its migrations only add, exactly as inside a
major line, and it keeps serving every protocol its predecessor served. `workhorse.protocol_version`
is untouched by it. A fleet running the previous major keeps running while the new major rolls out.

Removal moves into a **contract step**: a separate migration, shipped by the new major line, that
drops superseded functions and narrows `workhorse.protocol_version`. `workhorse schema migrate` never
applies it. The operator applies it with `workhorse schema contract`, once their own fleet is
entirely on the new major.

This makes every upgrade in the product's life a rolling deployment, and makes the one destructive
act an operator's deliberate choice with a command of its own.

### Retention is a date, not a release number

A superseded function is retained until both of these are true, whichever is later:

1. A major release has shipped that supersedes it, and
2. **twelve months** have passed since the release that shipped its successor.

The release offering the contract step is not published before that. Twelve months is chosen so an
operator who upgrades on an annual cadence never finds a function gone between two consecutive
upgrades; a shorter window would make the promise depend on how often they deploy.

Retention is not support. Keeping `claim_v1` beside `claim_v2` costs schema size and nothing else —
no backports, no branches, no second implementation to test. That is why this project can promise it
without the support organisation ADR 0054 declined to imply. Which released versions receive fixes
is a different question, and `SECURITY.md` owns it.

### A database may lag arbitrarily far behind

The migration chain is never pruned. Every released step stays in `sql/migrations/` and in
`SCHEMA_MIGRATIONS` for the life of the project, so a database at any released schema version
migrates forward in one `workhorse schema migrate` run. There is no supported upgrade window in the
sense of a version below which a database is stranded, and skipping is not something an operator
does: the runner applies every intervening step in order.

The chain crosses major boundaries unbroken, because the narrowing is no longer in it.

### The fleet is not an inventory, but the registry gates the one step that needs it

`workhorse schema status` reports one process's view of one database. There is no fleet view, and
1.0 does not add one. Building a process inventory would mean tracking every producer, and a
producer is any transaction in any application.

`workhorse schema contract` needs less than an inventory. `workhorse.worker_registry` gains the
client protocol version, SDK language, and SDK version of each registering worker, so the command
can refuse while a worker on the retiring protocol has heartbeated inside its lease. Producers do
not register, so this is evidence and not proof: the command says which workers it can see, states
that it cannot see producers, and requires explicit confirmation.

### The dashboard views are schema objects under the same additive rule

`dashboard_*_v1` is a versioned projection, and the additive rule governs it like every other schema
object. A migration may add a column to a shipped view. It may not remove one, retype one, or change
what one means; a new shape is `dashboard_*_v2` beside it, retained and contracted on the same
schedule as a superseded function.

A core upgrade therefore never requires a dashboard release inside a major line. This retires
ADR 0027's last consequence — that the dashboard stays "pinned to the compatible pre-release line
until schema capability negotiation replaces exact-version compatibility". The negotiation arrived:
it is `workhorse.protocol_version`, read by the same statement that reads the schema version. At
1.0.0 the dashboard's peer range on `@stablemates/workhorse` widens from the minor line to the major
line.

### Backup and rollback are settled, and the non-promise is deliberate

The framework ships no down migrations and will not. Restoring the backup taken before the migration
is the rollback path, it discards jobs enqueued since, and a clean rollback window means stopping
producers first. `docs/schema-lifecycle.md` already records this and it is not reopened here. It is
named as settled so it stops being asked: the absence of down migrations is the decision, not a gap
in one.

## Consequences

The schema grows monotonically and can only shrink when an operator acts. A database whose operator
never runs `workhorse schema contract` carries superseded functions indefinitely. That is the trade:
a schema larger than necessary is a cost the operator chose, and a fleet stopped by an upgrade is
one they did not.

**A clean install and a migrated database legitimately differ across a major boundary.** A clean
install of major N+1 installs the contracted shape. A database migrated into N+1 keeps the retained
functions until it contracts. `typescript/core/test/schema-migrations.test.ts` requires a migrated
database to dump identically to a clean install; that guarantee is now scoped to inside a major
line, and the first contract step is what will need it restated. No test changes today, because no
major boundary exists yet.

`workhorse.protocol_version` becomes operator state rather than release state. Two databases at the
same schema version may serve different protocol sets. Nothing about the compatibility check moves:
`assertSchemaCompatible`, `AssertCompatible`, and `assert_compatible` already read the table instead
of inferring a bound from the schema version, which is exactly the property that makes this decision
implementable without touching them.

Twelve months puts a floor under the interval between a supersession and the release that offers to
remove it. It does not slow a major release, because the major no longer removes anything. It does
mean a rename decided late in a major line cannot be cleaned up early in the next one.

Two pieces of execution work follow, both `ready-for-agent` and tagged `release-1.0`: the
`workhorse schema contract` command with its gated step class in the migration runner, and the
protocol and SDK columns on `worker_registry` reported by all three SDKs. Neither changes
`assertSchemaCompatible` or the Python and Go compatibility checks.

## Rejected alternatives

### Keep removal welded to the major release

This is ADR 0053 as written. It is rejected because there is no deployment order that makes it safe,
so it would make every major upgrade the outage that ADR 0054 spent a permanently larger schema to
avoid at 1.0.0.

### Prune the migration chain to the last two majors

pg-boss did this and then shipped two majors with an empty migration array, telling users at or
below v10 that automatic migration is not supported (WH-576). Pruning creates a version at which a database is
stranded and must be recreated. Stranding is the failure the whole 0.1.0 migration decision exists to
remove, so buying a shorter chain with it is a bad trade.

### Express retention in releases rather than months

"Retained for two majors" is unusable when majors are undated: two majors can be four months or four
years. The operator's question is how long their pinned runtime keeps working, and only a date
answers it.

### Build a fleet inventory so removal can be automatic

Automatic removal needs proof that no old process exists. A producer is any transaction in any
application, so that proof is unobtainable, and a mechanism that looks like proof but is not would
be worse than the operator's own knowledge of their deployment.
