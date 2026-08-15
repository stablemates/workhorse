# ADR 0026: Keep daily history partitions above the measured retention threshold

- **Status:** Accepted
- **Date:** 2026-08-12
- **Related:** [ADR 0011](0011-daily-retention-and-split-maintenance.md)

## Context

ADR 0011 chose UTC-daily partitions for `job_event` and `attempt_history`. That design makes
retention a metadata operation, but it also adds catalog objects, partition preparation, fallback
tables, and DDL to the maintenance path. A single indexed history table would remove that machinery.
It would instead delete expired rows and depend on vacuum to recover reusable space.

The choice needs a measured threshold. Small queues may not write enough history in one day to
justify a partition, while sustained queues can make row deletion, WAL, dead tuples, and vacuum the
larger operating cost. The existing claim path must also remain stable while retention runs.

History insertion has a separate cost. `lock_history_job_v1` locks the parent identity and advances
retention metadata, so its overhead must be measured rather than attributed to partition routing.

## Measurement

`typescript/core/benchmarks/retention-strategies.ts` creates two isolated synthetic schemas with the same indexed
ready queue, history row shape, and parent-existence trigger. The partition design creates one
paired `job_event` and `attempt_history` generation per churn cycle and drops both expired children
in one statement. The row design stores both histories in indexed tables, deletes the expired rows,
then runs `VACUUM (ANALYZE)` on both tables.

Each scale runs seven churn cycles and retains two generations. Five cycles therefore measure
cleanup. Sequential claim-candidate cohorts establish before and after baselines. A forty-probe
cohort launches concurrently with each cleanup and executes the indexed `FOR UPDATE SKIP LOCKED`
path, so pool wait and lock delay stay in the observation. The benchmark records cleanup time,
median WAL, relation bytes, live and dead tuple estimates before and after vacuum, vacuum time,
counters and timestamps, and claim p50/p95/p99 over time. Strategy order alternates by scale.

The benchmark ran on PostgreSQL 18.4 and Node 24.15.0 with 128-byte history payloads. It measured
10, 50, 100, 250, 500, 1,000, 10,000, and 50,000 expired rows per history table per cleanup. Each
cleanup therefore retires twice the table's stated row count. Full environment data, raw samples,
confidence intervals, and relation snapshots are in
`docs/benchmarks/results/2026-08-12-retention-strategies.json`.

WAL LSNs are cluster-wide, so another database can write between a sample's start and end. Raw
samples remain in the artifact. The cross-strategy table uses the median of five cleanup samples to
resist unrelated cluster writes.

| Expired rows | Partition drop | Delete + vacuum | Time ratio | Partition WAL median | Row WAL median | WAL ratio | Partition bytes | Row bytes |
| -----------: | -------------: | --------------: | ---------: | -------------------: | -------------: | --------: | --------------: | --------: |
|           10 |        3.61 ms |         5.07 ms |      1.40× |              13.9 KB |        12.8 KB |     0.92× |           64 KB |    128 KB |
|           50 |        2.92 ms |         6.23 ms |      2.13× |              14.2 KB |        28.5 KB |     2.00× |          192 KB |    176 KB |
|          100 |        2.72 ms |         5.44 ms |      2.00× |              14.3 KB |        28.0 KB |     1.96× |          224 KB |    240 KB |
|          250 |        2.78 ms |         6.60 ms |      2.37× |              14.3 KB |        47.5 KB |     3.32× |          352 KB |    416 KB |
|          500 |        2.74 ms |         6.89 ms |      2.51× |              14.3 KB |        83.6 KB |     5.86× |          544 KB |    800 KB |
|        1,000 |        2.57 ms |         8.16 ms |      3.17× |              14.0 KB |       180.2 KB |    12.91× |          928 KB |   1.38 MB |
|       10,000 |        3.22 ms |        41.47 ms |     12.89× |              13.8 KB |        1.37 MB |    99.48× |         7.75 MB |  12.09 MB |
|       50,000 |        9.58 ms |       200.13 ms |     20.89× |              2.38 MB |        8.91 MB |     3.74× |        38.25 MB |  59.83 MB |

At 50 rows, the row table is 8 KB smaller because a partition's minimum relation allocation
dominates the payload. At 100 rows, partition storage becomes smaller, and the difference widens
with scale. Partition cleanup time stays nearly flat through 10,000 rows because PostgreSQL removes
a relation instead of visiting each tuple. Row cleanup grows with the expired generation and adds a
vacuum pass.

Before each manual vacuum, PostgreSQL reported twice the stated scale as dead tuples, one expired
generation across both tables. After vacuum, dead tuples returned to zero and the combined vacuum
counter advanced by two. Autovacuum remained at zero because the benchmark deliberately compares a
complete delete-and-vacuum maintenance operation. Relation bytes usually stayed at their high-water
mark, so vacuum made space reusable but did not reliably return it to the filesystem.

The mean concurrent-cohort claim p95 ranged from 1.4 ms to 9.2 ms. Neither strategy's latency grew
monotonically below the largest scale, and the slower strategy alternated across those scales. At
50,000 rows the row design reached 9.17 ms against 7.39 ms for partition drop. This run shows bounded
contention at the measured scale, but it does not support a general claim-latency win.

Across both schemas and all scale runs, inserting 2,000 rows through the parent-existence trigger
took 18.2–32.6 ms per repetition. Plain insertion took 3.1–6.7 ms, so the trigger cost 3.5–6.1×.
Both retention strategies pay the same trigger, and their triggered timings overlap. The trigger is
a measurable attribution-safety cost, but removing partitions would not remove it.

## Decision

Keep UTC-daily partitions for `job_event` and `attempt_history`.

The measured threshold is 100 expired rows in each history table for one completed day. At and
above that point,
partition drop wins cleanup time, median WAL, and retained relation bytes together. Below it, row
deletion never wins time in this run and wins storage only at 50 rows, by one PostgreSQL page. That
saving does not justify a second storage mode or removing the design that scales with sustained
history.

Keep bounded deletion for the default fallback partitions. Those tables exist for late or
temporarily unrouteable rows, so their normal volume should remain below the partition threshold.
Health already reports fallback occupancy and retention lag. A fallback that stays above the
threshold indicates failed partition preparation and should be repaired rather than promoted into
the primary storage design.

## Consequences

- Workhorse keeps partition preparation, paired daily children, fallback cleanup, and bounded DDL
  lock waits because measured cleanup cost stays nearly independent of expired row count.
- Retention policy should continue to drop completed days rather than copy their rows into a shared
  table for deletion.
- The 100-row threshold is an operating crossover from one machine and PostgreSQL version, not a
  universal constant in runtime code. A future storage redesign must rerun this ladder on its target
  PostgreSQL version and representative payload sizes.
- `lock_history_job_v1` remains because both candidate designs require attribution safety. Its
  measured insert cost warrants separate optimization only if production history insertion becomes
  material to enqueue or completion latency.

## Rejected alternatives

### Replace partitions with one indexed history table

This removes catalog and DDL machinery, but every cleanup visits expired tuples, writes per-row WAL,
and requires two vacuums. The difference grows from 2× cleanup time at the threshold to almost 21×
at 50,000 rows per table.

### Switch storage modes below the threshold

A hybrid threshold would need to move rows between layouts or route each queue differently. The
only measured win below the threshold is one page of storage at 50 rows, so that complexity cannot
pay for itself.

### Remove the parent-existence trigger with partitioning

The trigger cost is real, but it is independent of partition routing. Removing it would reopen the
orphan-history and retention-watermark races that ADR 0011 closed.

## Validation

Run `pnpm benchmark:retention-strategies` against the checkout's dedicated benchmark database. The
run must preserve raw per-cycle samples, alternate strategy order, measure every threshold scale,
and record claim, WAL, storage, dead-tuple, vacuum, and trigger evidence in one JSON artifact.
