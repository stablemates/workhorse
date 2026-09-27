# ADR 0080: Keep delayed fast-tier tasks in the ready index

- **Status:** Accepted
- **Date:** 2026-09-27
- **Related:** [ADR 0077](0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md),
  [SM-942](https://linear.app/stablemates/issue/SM-942)

## Context

ADR 0077 gave the fast tier two states, ready and active. A delayed fast-tier task is a ready row
whose `run_at` lies in the future. `fast_claim_v1` reads `fast_task_runtime_ready_idx` in
`priority DESC, run_at, sequence` order and keeps rows whose `run_at` has arrived. Within one
priority the due rows sort first. A delayed row at a higher priority than every due row still sorts
ahead of them, so the claim reads past it. With nothing due, the claim reads past the whole backlog.

Two changes would stop that read. A due-time partial index would hold only rows that are due. A
scheduled state would keep delayed rows out of `ready` until they come due, as the full tier does.

[SM-942](https://linear.app/stablemates/issue/SM-942) measured the cost
([analysis](../benchmarks/2026-09-27-fast-claim-backlog-analysis.md)). The result depends on the
PostgreSQL major version:

- On PostgreSQL 18, a btree skip scan makes one index descent per priority above the due work. A
  million delayed rows added 0.07 ms to a claim with due work and 0.16 ms to a claim without.
- On PostgreSQL 15 and 17, the scan reads every delayed index entry above the due work. The claim
  cost grows with the backlog: about 2 to 3 ms at 100,000 delayed rows and 30 to 48 ms at a
  million.

## Decision

**Delayed fast-tier tasks stay in `ready`, in the one ready index.** Workhorse adds neither a
due-time partial index nor a scheduled state to the fast tier.

1. **No due-time partial index.** A partial index predicate must be immutable, so it cannot compare
   `run_at` with the current time. An index that leads with `run_at` instead would find due rows
   first, but it would lose the priority order the claim returns.
2. **No scheduled state.** On PostgreSQL 18 the backlog costs a fraction of a millisecond at a
   million rows, bounded by the number of distinct priorities. A scheduled state would add a
   promotion step and a second transition to every delayed task to save that fraction.

## Consequences

- A fast-tier claim on PostgreSQL 18 stays near its cost without a backlog, whatever the backlog
  size.
- On PostgreSQL 15 through 17, a large delayed backlog above the due work slows every fast-tier
  claim in proportion to its size. Those versions remain supported. A remedy for them changes
  `fast_claim_v1`, needs a schema migration, and is a separate decision.
- A deployment that holds a large delayed backlog on the fast tier and runs PostgreSQL 15 through
  17 can keep that backlog on a full-tier queue, whose delayed tasks wait outside the ready index.
