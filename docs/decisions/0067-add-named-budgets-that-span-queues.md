# ADR 0067: Add named budgets that span queues

- **Status:** Accepted
- **Date:** 2026-09-15
- **Related:** SM-738, [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
  [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0056](0056-set-the-1-0-0-exit-criteria.md)

## Context

`workhorse.concurrency_policy` and `workhorse.rate_limit_policy` are keyed by `queue_name`. A
downstream resource that three queues share, such as one vendor API or one connection pool, cannot
be given one cap. The documented workaround merges the queues, which loses their separate priority
order, pause control, and health rows. `docs/features.md` and the site's limitations page record the
gap as "Cross-queue concurrency policies: Not supported."

Two shapes were considered. A **queue-set policy** would list the queues it governs. At claim time
the queue would have to find every set it belongs to, two sets sharing a queue would need a rule for
which one wins, and a queue could not send part of its work to one budget and part to another. A
**named budget** is referenced by the task instead. The task already names its queue and an optional
`concurrencyKey` at enqueue time; naming a budget the same way keeps admission a property of the
task, keeps membership explicit, and lets one queue hold tasks under different budgets.

The claim path must stay bounded. `claim_v1` inspects at most 100 ready rows when a per-key limit
can pass over a saturated key. A budget is also a per-task property, so a saturated budget must be
passed over the same way, without turning every ungoverned queue onto that window.

## Decision

**One object carries both limits.** A budget is one row in `workhorse.budget` with a `budget_name`,
an owning `namespace`, a nullable `max_active`, and a nullable token bucket (`rate_limit`,
`rate_interval_ms`, `rate_burst`). At least one limit must be set. A task names at most one budget,
so separate concurrency and rate objects would either force two references on the task or force the
same name to mean two rows. One row keeps ownership, pruning, listing, and health reporting to one
surface.

**A budget has no per-key sub-limit.** Keys stay queue-scoped, as they are today. A per-key limit on
a budget would count and store key state a second time across queues, and it is the one shape that
can be added later without a rename. The decision is recorded here so the omission reads as chosen.

**A budget is an additional admission check.** Queue policies are unchanged. A task must pass its
queue's concurrency policy, its queue's rate policy, and its budget. A task that names a budget with
no matching row admits freely, the same way a queue with no policy row has no limit. This keeps
enqueue independent of deployment order.

**The reference lives on the task.** `workhorse.task.budget_name` and
`workhorse.task_runtime.budget_name` are nullable columns, mirrored the way `concurrency_key` is, so
admission never joins `task`. Enqueue accepts a `budget` request key, validates it as 1 through 256
UTF-8 bytes, and includes it in the idempotency fingerprint. Redrive copies it.

**Admission serializes on one advisory lock.** Budget capacity is counted across queues, so two
claims on different queues cannot both read `active = limit - 1` and both admit. When a queue holds
at least one ready row that names a budget, `claim_v1` takes the exclusive transaction advisory lock
`workhorse:budgets` before it reads the clock, and inspects the 100-row window. A queue with no
budget-named ready work never takes the lock and keeps the one-row fast path. The lock is held for
one short claim transaction, and budgets exist to protect a scarce resource, so serializing their
admission is the cost accepted in exchange for an exact cap.

**Capacity follows leases.** `max_active` counts active rows whose lease has not expired, through a
partial index on `budget_name`. An expired lease returns budget capacity before maintenance recovers
the row. A release of budget capacity wakes every queue that holds ready work naming that budget.

**Rate limits use one bucket per budget.** `workhorse.budget_bucket` holds one row per budget,
refilled from `clock_timestamp()` with the same arithmetic as the queue bucket. One admitted start
consumes one token from the queue bucket, the key bucket, and the budget bucket. Nothing refunds a
token.

**Namespaces own budgets.** `sync_budgets_v1(namespace, definitions, prune)` reconciles one
namespace atomically, rejects a budget owned by another namespace, and prunes omitted budgets unless
pruning is disabled. Deleting a budget cascades its bucket state, so a recreated budget begins with
a full burst.

Everything ships additively under ADR 0053 and ADR 0054: new tables, new columns, new indexes, new
functions, a new enqueue key, new SDK methods, new health fields, and new telemetry instruments.
`claim_v1` keeps its signature. The migration is `sql/migrations/0003-named-budgets.sql`, schema
version 3, protocol version 3.

## Consequences

- An operator caps work across queues with one name at enqueue time and one definition at deploy
  time, without merging queues.
- A budget-governed queue pays the 100-row window and the `workhorse:budgets` lock on every claim
  that has budget-named ready work. Ungoverned queues are unchanged.
- `Queue.health()` reports bounded budget summaries under `budgetPolicies`, because `budgets`
  already names the health thresholds. The OpenTelemetry adapter exports budget gauges with the
  budget name as their only dimension.
- Schedules and child tasks do not name a budget in this release. Adding a `budget` field to their
  definitions is additive and can follow.
- Per-key limits inside a budget are not supported. Adding them later means new nullable columns.
