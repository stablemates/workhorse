# ADR 0019: Rolling statistics derived from history, not written on the dispatch path

- **Status:** Accepted
- **Date:** 2026-08-05
- **Related:** [ADR 0007](0007-automated-retention.md), [ADR 0011](0011-daily-retention-and-split-maintenance.md), [ADR 0004](0004-two-cadence-maintenance.md), [ADR 0015](0015-operator-query-api.md)

## Context

The operator dashboard auto-refreshes, and every time window on its system page was a scan over unbounded relations: throughput and drain from `job_event` and `attempt_history`, error rate from twice the window, per-queue rates from both joined to `job`, failing types from attempts joined to `job`, and first-attempt wait from a `job_event` self join pairing each claim with its enqueue.

Each query was correct and each was proportional to throughput. Together they made observing the system most expensive exactly when the system was busiest, which is when an operator is most likely to be watching. On a busy queue a 24-hour window re-scanned millions of rows per refresh.

TODO P2-10 had scoped a full long-horizon rollup — hourly and daily tiers, a retention ladder, benchmarks. That is the right eventual shape, but the dashboard needed the cost curve fixed before the tiering question was answered.

## Decision

Aggregate raw history into per-minute buckets in a maintenance pass, and read every operator window through a function that stitches those buckets to a live tail.

### Derive from history rather than count on the write path

The obvious implementation is a trigger that upserts a counter row per lifecycle event. It is rejected.

A counter row keyed by `(minute, queue, job type)` is a hot tuple. Every enqueue on the same queue and type within the same minute would serialize on it, putting lock contention in the middle of a queue whose entire value proposition is dispatch throughput. Sharding the counter, or writing insert-only deltas and compacting them, buys back the concurrency but reintroduces the compaction pass we would then have written anyway.

Deriving from history has none of that. Nothing is added to enqueue, claim, or complete. Aggregation cost is proportional to new history only, once per minute, inside a maintenance pass that already runs. `attempt_history` and `job_event` are already partitioned by the timestamp we bucket on, so each pass reads one pruned range.

The cost is latency: a bucket exists only after its minute closes. That is what the live tail solves.

### One definition of a bucket, evaluated two ways

`aggregate_stats_v1(from, to)` defines what a bucket contains. `rollup_stats_v1` materializes it for closed minutes; `stat_buckets_v1` reads materialized buckets below the watermark and evaluates the _same function_ above it.

A second, hand-written "recent data" query would be the obvious alternative and would drift from the first the moment either changed — and it would drift silently, because both would return plausible numbers. Sharing the definition means the stitched halves of a window cannot disagree by construction.

It also makes the watermark invisible to callers. A window is correct the instant a job runs, and a rollup that is behind costs a longer live tail rather than a wrong answer.

### Recompute closed minutes instead of trusting them

Each pass rewrites the last two closed minutes rather than only appending new ones.

History rows are stamped with `clock_timestamp()` at write, but they become visible at commit. A transaction that commits after its own minute closed would be aggregated into nothing and lost forever. Because a bucket is a pure function of the raw history in its minute, deleting and reinserting it absorbs the straggler, and running the pass twice converges rather than double counting.

The alternative — a fixed grace period before a minute is eligible — delays every bucket to protect against the rare late commit, and still loses anything later than the grace.

### The watermark is a retention interlock

Raw history is the only input a bucket can be rebuilt from, so `retain_history_v1` clamps its event and attempt cutoffs to `rolled_up_through`.

Without the clamp, a rollup that stops for a week would let retention delete the history for windows nobody has computed, producing permanent holes that no later pass can fill — and producing them silently, because a chart with missing minutes still renders. With it, a stalled rollup holds history, retention reports itself incomplete, and the growing lag surfaces on the health page next to `QueueHealth.statistics.lagMs`. Degrading storage is recoverable; losing the data is not.

### Bounded dimensions, bounded cardinality

Buckets are keyed by `(queue, job type)` only, and pairs past a per-bucket limit fold into an `__other__` job type within their own queue.

Queue and job type are the only dimensions whose cardinality is bounded by code rather than by data. Worker identity and tags are not, and tags are per-job arrays besides, so both stay on live queries. The overflow fold means even a deployment that generates job types cannot make the statistics table grow without limit, and folding within the queue keeps per-queue rates accurate while doing it.

### Statistics retention is its own category, outside the identity chain

Buckets are retained by `statistics_retention_days`, configured like every other category but
deliberately exempt from the `job_identity >= dependents` constraint.

Every history category is bounded by identity retention because it is _attribution_: deleting the
job while keeping the evidence would orphan the evidence. A bucket is not attribution. It names no
job and holds no payload. Keeping aggregates long after the events behind them are gone is the
reason to derive them at all, so binding them to the identity window would forbid the main use case.

Deletion is bounded per pass like every other prune. The first pass after shortening the window is
eligible to delete months of buckets, and an unbounded statement there would hold a long lock on the
relation every operator window reads.

## Consequences

- Every system-page window costs one pass over the buckets in the window plus a one-to-three-minute live tail, instead of a scan proportional to throughput.
- Statistics can be rolled up from every worker. Passes serialize on a transaction-scoped advisory lock, so extra callers are no-ops, matching the maintenance model in ADR 0004.
- Catch-up after an outage is bounded per pass, so a long gap advances over several cycles rather than in one long transaction.
- The rollup runs before retention in the same worker cycle, so a cycle can reclaim the history it just summarized.
- Setting `statisticsRollupIntervalMs` to `0` is a supported configuration: windows stay fully derived and history retention holds at the current watermark. Correctness does not depend on the pass running.
- First-attempt wait is attributed to the minute the attempt _finished_, not the minute it was claimed. The two differ by the attempt's own duration.
- Window edges are minute-granular. A 15-minute window is 15 whole minutes.
- Bucket retention is independent of raw history and operator-configurable, defaulting to 14 days. A minute of aggregate is orders of magnitude smaller than the events it summarizes, so a much longer window is affordable when someone wants one.
- First-attempt wait percentiles are the one panel not served by rollups. A mergeable histogram was implemented and removed: it cost accuracy at every scale and was slower than the exact self join below roughly 1M jobs/day. Aggregate tiers, not approximation, are the answer there.

## Non-goals

- Hourly and daily tiers. They remain in TODO P2-10; the minute tier is the substrate they would be derived from, and they are what would make long windows cheap without keeping minute resolution for months.
- Approximate percentiles. Rejected once already, on the evidence above.
- Worker and tag dimensions. Adding either changes the cardinality argument above and belongs in its own decision.
- Moving the tasks-page activity chart onto these buckets. Its semantics are a live-state question — tasks whose `updated_at` fell in a bucket, filtered by current state — not an event count, and mapping it onto event buckets would silently change what the chart means. It was made cheap by starting from the tasks that changed inside the window instead.
- An exported metrics endpoint. These aggregates are an operator read model, not a telemetry pipeline.
