# Rolling statistics

Workhorse answers every operator time window — throughput charts, error rates, per-queue drain, wait percentiles, failing task types — from **per-minute aggregates derived from raw history**, rather than from scans over the history itself.

This document records the problem, the design, the schema, the read path, the operational contract, and the limits of the implementation retained in schema version 36.

## Why

The dashboard system page auto-refreshes. Before this change, one refresh ran five window queries against unbounded relations:

| Panel                  | Query before                                                      | Cost driver                         |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| Throughput chart       | `job_event` + `attempt_history` scans over the window             | Events in window                    |
| Drain / error-rate KPI | `attempt_history` scan over **twice** the window                  | Attempts in two windows             |
| First-attempt wait     | `job_event` **self join**, claimed rows to their enqueued partner | One index probe per first claim     |
| Per-queue rows         | `job_event` and `attempt_history` each joined to `job`            | Events in window × join to identity |
| Failing task types     | `attempt_history` joined to `job`, grouped by queue and type      | Attempts in window                  |

Each is correct and each is proportional to throughput. Together they make a dashboard cost the most exactly when the system is busiest, which is when an operator is most likely to be looking at it. A 24-hour window on a busy queue is millions of rows re-scanned every refresh.

The activity chart on the tasks page was worse in a different way: it built its base relation from **every job that ever existed**, left-joined to runtime, outcome, and a per-job `attempt_history` LATERAL, and only then applied the time window in a join condition.

The goal was to make these costs track the _window_ and the number of _active `(queue, job type)` pairs_ instead of throughput, without adding anything to the dispatch path.

## What was deliberately not done

**Nothing was added to enqueue, claim, or complete.** No triggers on the hot path, no counter rows to contend on.

The obvious implementation — a trigger that upserts a counter row per event — would put a hot-row update in the middle of a queue whose entire value proposition is dispatch throughput. Every enqueue on the same queue and job type in the same minute would serialize on one tuple. A statistics feature that makes the queue slower is a bad trade regardless of how fast it makes the dashboard.

Instead a maintenance pass aggregates raw history for minutes that have already closed. Aggregation cost is proportional to _new_ history only, once per minute, in a pass that is already running.

## Schema

### `workhorse.job_stat_bucket`

One row per closed minute per `(queue_name, job_type)`. Primary key `(bucket_start, queue_name, job_type)`; the leading key column makes every window a range scan without an extra index.

| Column                                                                                              | Grain   | Meaning                                                         |
| --------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------- |
| `bucket_start`                                                                                      | —       | Minute boundary, `date_bin('1 minute', …, '2000-01-01')`        |
| `enqueued`                                                                                          | job     | `job_event` rows with `event_type = 'enqueued'`                 |
| `job_succeeded`, `job_failed`, `job_canceled`                                                       | job     | `job_outcome` rows by terminal state                            |
| `attempt_succeeded`, `attempt_failed`, `attempt_retry`, `attempt_lease_expired`, `attempt_canceled` | attempt | `attempt_history` rows by outcome                               |
| `attempt_other`                                                                                     | attempt | `deadline_exceeded` and `timeout` closures                      |
| `attempt_duration_ms`                                                                               | attempt | Sum of `finished_at - started_at`                               |
| `last_attempt_at`, `last_error`, `last_error_at`                                                    | attempt | Latest attempt and latest error message (≤ 500 chars) in minute |

**Grain is never conflated.** A job that retried four times before succeeding contributes one `job_succeeded` and five attempts. Mixing the two is the usual way a throughput panel starts disagreeing with a task list, so the columns are named for their grain and the dashboard picks one deliberately per panel.

`attempt_other` is separate from `attempt_failed` on purpose: a deadline or execution timeout is an error, but it is not a handler failure, and folding them together would misattribute a scheduling problem to application code.

### `workhorse.job_stat_state`

Singleton. `rolled_up_through` is the exclusive, minute-aligned watermark: every closed minute below it is materialized. `last_run_at` records the last pass for health.

### `job_outcome_updated_idx`

`workhorse.job_outcome (updated_at, job_id)`, added for the activity chart's candidate set. It is safe on `job_outcome` because `updated_at` is stamped once when the row is written and never bumped afterwards — the same index on `job_runtime` would cost every heartbeat its HOT update, which is why the activity query scans `job_runtime` (small by design, live jobs only) instead of indexing it.

## Functions

### `aggregate_stats_v1(p_from, p_to, p_group_limit default 200)`

The single definition of what a bucket means. A `STABLE` SQL function returning the full bucket shape for `[p_from, p_to)`, derived from four sources:

| Source            | Rows                      | Bucketed by   |
| ----------------- | ------------------------- | ------------- |
| `job_event`       | `event_type = 'enqueued'` | `occurred_at` |
| `attempt_history` | all closed attempts       | `occurred_at` |
| `job_outcome`     | all terminal jobs         | `finished_at` |

Each grain is bucketed by the timestamp its own row carries when it lands. `occurred_at` is also the history partition key, so ranges prune. Bucketing by anything a row does _not_ carry would make recomputation non-idempotent.

### `stat_overflow_type_v1()` — cardinality bound

Returns `'__other__'`. Within each bucket, `(queue, job type)` pairs are ranked by volume; everything past `p_group_limit` is folded into the `__other__` job type **within its own queue**, so per-queue rates stay accurate while the row count per bucket stays bounded by `group_limit + distinct queues`.

Queue and job type are the only dimensions in the rollup because they are the only two whose cardinality is bounded by code rather than by data. Worker and tag dimensions were considered and left to live queries; see Limits.

### `rollup_stats_v1(p_now, p_max_buckets, p_recompute_buckets, p_group_limit)`

Defaults: `clock_timestamp(), 240, 2, 200`. Returns the standard maintenance phase shape (`phase, rows_affected, duration_ms, skipped_lock, error`) for two phases, `stat_rollup` and `stat_retention`.

1. Take `pg_try_advisory_xact_lock('workhorse:maintenance:stat-rollup')`. A losing caller returns both phases with `skipped_lock = true` and does nothing, so every worker can run it.
2. `v_closed = date_bin('1 minute', p_now)` — only fully elapsed minutes are eligible.
3. `v_from = LEAST(rolled_up_through - p_recompute_buckets minutes, v_closed)`.
4. `v_to = LEAST(v_closed, v_from + p_max_buckets minutes)` — catching up after an outage advances in bounded passes rather than in one long transaction.
5. `DELETE` then `INSERT … SELECT * FROM aggregate_stats_v1(v_from, v_to)`, then advance the watermark to `v_to`.
6. `stat_retention` deletes expired buckets, bounded by policy (below).

**Why the pass rewrites minutes it already closed.** A bucket is a pure function of the raw history in its minute. A transaction that commits its history row after its own minute closed would otherwise be lost forever; rewriting the last couple of minutes absorbs it. The same property makes the pass safe to run twice — it converges rather than double counting, which is what the "recompute" integration test asserts.

`job_outcome` rows can be deleted by terminal pruning, which would make a recompute of a long-past bucket lose counts. This cannot happen: pruning only touches rows days old, far outside a two-minute recompute window.

### `stat_buckets_v1(p_from, p_to)`

The read entry point. Returns materialized buckets for `[p_from, min(p_to, watermark))` unioned with `aggregate_stats_v1(max(p_from, watermark), p_to)` for the live tail.

Callers never need to know where the watermark sits. A window is correct the instant a job runs, without waiting for a rollup pass, and a rollup that is behind costs a longer live tail rather than a wrong answer. In steady state the tail is one to three minutes of partition-pruned raw history.

Lower bounds must be minute-aligned. Stored buckets are selected by `bucket_start`, so an unaligned bound would drop a whole minute the live tail would have included, and the two halves of a stitched window would disagree. `statWindowStart` in the dashboard exists to make that alignment impossible to forget.

## Retention interlock

Raw history is the only input a bucket can be rebuilt from, so `retain_history_v1` clamps its event and attempt cutoffs to `rolled_up_through`:

```sql
v_event_before   := LEAST(v_event_before, v_rolled_up_through);
v_attempt_before := LEAST(v_attempt_before, v_rolled_up_through);
```

A stalled rollup therefore **holds history** instead of silently deleting the input to a window nobody has computed yet. The pass reports itself incomplete, `history_retained_before` does not advance, and the growing retention lag surfaces on the health page alongside `QueueHealth.statistics.lagMs`.

Terminal identity pruning is gated transitively: `prune_terminal_storage_v1` already refuses to delete past `history_retained_before`, so clamping in one place protects both.

In normal operation the clamp never binds — the rollup runs every minute, and retention cutoffs are days back.

## Bucket retention

Buckets are a sixth retained category, configured exactly like the other five through
`retention_policy` and `Queue.syncRetentionPolicy()`:

- `statisticsRetentionDays` — default 14, null keeps buckets forever.
- `statisticsRowsPerPass` — default 10,000, the per-pass deletion bound.

It sits **outside** the `job_identity >= dependents` constraint that governs the history categories,
and that placement is the point. A bucket summarizes jobs; it does not attribute one. Keeping
aggregates long after the events they were derived from have been deleted is the intended
configuration, not a violation, and it is the only way to answer a long window cheaply once history
is gone.

Deletion is bounded per pass like every other prune. Shortening the policy makes the next pass
eligible to delete months of buckets at once, and an unbounded statement there would hold a long
lock on the relation every operator window reads.

Lag and oldest-retained are reported through `QueueHealth.retentionLagMs.statistics` and
`oldestRetainedAt.statistics`, and rendered as a retention category on the system page.

## Runtime API

```ts
// Materialize closed minutes and advance the watermark. Safe from every worker, safe to repeat.
await queue.rollupStatistics({ now, maxBuckets, recomputeBuckets });

// Rollup progress, for alerting.
const { rolledUpThrough, lagMs, lastRunAt } = (await queue.health()).statistics;
```

Workers run the pass on `WorkerOptions.statisticsRollupIntervalMs`:

- Default `60_000`, matching the bucket width. Passing more often only rewrites the same closed minutes; passing less often makes windows derive a longer live tail.
- Minimum `1_000`. `0` opts out entirely — windows stay fully derived and history retention holds at the current watermark.
- It runs **before** the retention pass in the same cycle, so the cycle can reclaim the history it just summarized.
- Phases arrive through `onMaintenance` as loop `statistics_rollup`, phases `stat_rollup` and `stat_retention`.

## Dashboard read path

`packages/dashboard/src/server/rolling-stats.ts` provides the query fragments:

| Export                                     | Purpose                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `statWindow(windowSeconds, multiple)`      | `stat_buckets_v1(…) stat` for the _n_-th window back           |
| `statWindowStart(windowSeconds, multiple)` | Minute-aligned lower bound                                     |
| `statAttempts`                             | All closed attempts in a bucket                                |
| `statAttemptErrors`                        | Attempts that neither succeeded nor were canceled              |
| `statCompleted`                            | Attempts that closed their job                                 |
| `approximateWaitPercentile(histogram, q)`  | Quantile from a merged histogram, interpolated within its slot |

`statAttemptErrors` counts retries. A retry is an error the system absorbed, and an error rate that ignored retries would read as healthy while a queue burned its attempt budget.

### System page

| Panel                                | Source after                                                         |
| ------------------------------------ | -------------------------------------------------------------------- |
| Throughput chart                     | Buckets grouped by minute                                            |
| Drain, error rate (current + prior)  | Two window aggregates, `statWindow(w, 1)` and `statWindow(w, 2)`     |
| First-attempt wait percentiles       | Merged `wait_histogram`, percentiles computed in TypeScript          |
| Per-queue enqueued / completed rates | Buckets grouped by `queue_name`                                      |
| Failing task types                   | Buckets grouped by `(queue_name, job_type)`, error text from the row |

Storing `last_error` per bucket is what lets the failing-types panel name a cause without touching `attempt_history` at all.

Still read live, because they are live gauges over the small `job_runtime` relation rather than windows: backlog, lease pressure, retry backoff buckets, retry-storm top types, partition presence, and `Queue.health()`.

The per-queue query also dropped a `job` scan: the queue-name set previously unioned `job` rows created within the window, and now unions the rolled-up queue names, which is equivalent because every job creates an enqueued event.

### Activity chart

Not moved to rollups, and deliberately so. Its semantics are "tasks whose `updated_at` fell in this bucket, filtered by current state" — a live-state question, not an event-count one. Mapping it onto event buckets would have silently changed what the chart means.

It was made cheap the other way instead, with no semantic change:

- The base relation now starts from tasks that changed inside the window — a `UNION` of `job_runtime` and `job_outcome` candidates — instead of from every job that ever existed. `UNION` handles the brief window where a live runtime row and a terminal outcome row coexist for one task, and the projection keeps the original runtime-wins `COALESCE` precedence.
- The per-job `attempt_history` LATERAL now only appears when grouping by worker or filtering by worker, which is the only thing that needed it.

## Measured effect

Method: synthetic history seeded over a trailing 24 hours across 4 queues × 15 job types, one closed attempt per job plus a second attempt for 10% that retried, one terminal outcome per job, and enqueue and claim events. Median of three runs per query on one developer machine, warm cache. The seed keeps all 60 `(queue, type)` pairs active in every minute, which is the **worst case for the rollup**: bucket count is fixed at 86,400 per day regardless of volume, so compression comes only from throughput.

**2,000,000 jobs/day (~23/s), 24-hour window** — 4.0M events, 2.2M attempts, 86,418 buckets:

| Query              | Before    | After    | Change    |
| ------------------ | --------- | -------- | --------- |
| Per-queue rows     | 1,274 ms  | 54 ms    | **23.5x** |
| Throughput chart   | 763 ms    | 61 ms    | **12.5x** |
| Failing task types | 1,400 ms  | 163 ms   | **8.6x**  |
| Drain / error rate | 358 ms    | 52 ms    | **6.9x**  |
| Activity chart     | 16,961 ms | 5,074 ms | **3.3x**  |

**200,000 jobs/day (~2.3/s), 24-hour window** — 400k events, 220k attempts, 86,400 buckets:

| Query              | Before   | After  | Change |
| ------------------ | -------- | ------ | ------ |
| Per-queue rows     | 163 ms   | 77 ms  | 2.1x   |
| Activity chart     | 1,113 ms | 669 ms | 1.7x   |
| Failing task types | 183 ms   | 141 ms | 1.3x   |
| Throughput chart   | 90 ms    | 82 ms  | 1.1x   |
| Drain / error rate | 61 ms    | 77 ms  | 0.8x   |

**At low volume the rollup roughly breaks even.** With ~2 events per pair per minute, a bucket
compresses almost nothing. The benefit is a function of events per bucket, not of table size — it
turns on somewhere around 1M jobs/day at this pair cardinality, and earlier for deployments with
fewer active pairs per minute.

First-attempt wait percentiles are excluded from both tables: they still read the event log. A
mergeable histogram was implemented and removed, because it cost accuracy at every scale and was 3x
slower than the self join below roughly 1M jobs/day. A coarser aggregate tier is the intended answer
there, not an approximation.

Rollup cost: 26–88 ms per steady-state pass, 2.7 s for a cold 24-hour backfill. Storage: 24 MB per
day of buckets at 86k rows/day, against 1.1 GB/day of raw history at 2M jobs/day.

**A note on that upper figure.** 2M jobs/day is comfortably within PostgreSQL's dispatch capacity,
but it is above what the _default_ retention settings can delete. `terminal_job_prune_limit` (1,000)
times the `terminal_cleanup_interval_ms` cadence (5 minutes) caps terminal-job deletion at roughly
288,000 jobs/day, so a deployment at that volume must raise those limits or retention falls
permanently behind. The benchmark scale demonstrates where the read costs go; it is not a claim that
the defaults sustain it.

Two defects surfaced only under this benchmark, both fixed:

- `stat_buckets_v1` read the watermark through a CTE and cross-joined it. With no statistics for the CTE the planner estimated a 7.6M-row join, carried the plan past `jit_above_cost`, and paid ~1 second of LLVM compilation on every call — making every window **slower than before**. Reading the watermark through scalar subqueries fixed it (971 ms → 9 ms).
- The wait histogram query joined a slot series against the buckets, re-scanning the window once per slot. That query is gone with the histogram, but the shape is worth remembering: a set-returning function in the inner side of a nested loop is re-executed per outer row.

## Testing

| Test                                                                            | Asserts                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `test/integration.test.ts` — "materializes closed minutes"                      | Grain separation, error capture, and convergence on repeated passes |
| `test/integration.test.ts` — "stitches materialized buckets"                    | A window is correct before _and_ after materialization              |
| `test/integration.test.ts` — "folds statistics beyond the group limit"          | Overflow folds into `__other__` and totals are preserved            |
| `test/integration.test.ts` — "reports rollup progress through health"           | `lagMs` and `lastRunAt`                                             |
| `test/integration.test.ts` — "refuses to delete raw history past the watermark" | The retention interlock, held and then released                     |
| `test/integration.test.ts` — "prunes statistics buckets on their own policy"    | Independent window, and that it is not bound by the identity chain  |
| `test/integration.test.ts` — "bounds statistics pruning by the rows per pass"   | Per-pass deletion cap                                               |
| `test/integration.test.ts` — "reports history size with daily partitions"       | Partition trees folded into their parent in health                  |

## Limits and open work

- **Wait percentiles still read the event log.** They are the one system-page panel not served by rollups, and the most expensive query on the page at high throughput. Exact percentiles are not mergeable across buckets; the fix is a coarser tier, not an approximation.
- **No worker or tag dimensions.** Both have cardinality bounded by data rather than by code, and tags are per-job arrays. The dashboard serves them from live queries; whether they belong in the rollup is tracked in TODO P2-10.
- **One tier only.** Minute buckets, kept for a configurable window defaulting to 14 days. Hourly and daily tiers remain in TODO P2-10, and are what would let a long window stay cheap without keeping minute resolution for months.
- **Window edges are minute-granular.** A 15-minute window is 15 whole minutes, not 15 minutes to the microsecond.
- **Schema baseline.** Rolling statistics entered the version 23 baseline described in [`schema-lifecycle.md`](schema-lifecycle.md). The later migration steps leave these relations unchanged.
