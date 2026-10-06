# How does Workhorse count tasks without rescanning all history?

<!-- scenario-names: invoice.send, exports, billing -->

The dashboard needs to answer questions like "how many tasks failed in the last hour?" This guide
explains why that is harder than it sounds, and how Workhorse answers it at a bounded cost.

## Why counting raw history fails

An operator keeps the dashboard open, and it refreshes the hourly failure count every few seconds.

1. **On day one** the event log holds a few thousand rows. Counting them is quick.
2. **On day thirty** the log holds millions of rows. Each refresh counts far more rows, and the
   query slows down.
3. **During an incident** traffic spikes, the log grows faster, and more people open the dashboard.
   The count is most expensive exactly when the operator needs it most.

Counting the raw event log on every request works on day one and gets slower every day, because the
log only grows. A dashboard that refreshes on its own would cost more the busier the system is.

## Summaries per minute, hour, and day

So Workhorse keeps running summaries per queue and task type. Take one task.

1. **At 10:01:10** the app enqueues `invoice.send` on the queue `billing`.
2. **At 10:01:12** attempt 1 fails. **At 10:01:45** attempt 2 fails.
3. **At 10:03:20** attempt 3 succeeds.

The summaries count this as one task that succeeded. They also count three closed attempts: two
failed and one succeeded. Both numbers are kept, separately and on purpose:

- **Tasks.** A task that retried several times and then succeeded counts as one success.
- **Attempts.** Each recorded or retained closed attempt counts separately.

Mixing the two is how a failure rate can exceed the number of tasks that ran.

Recent summary rows cover one minute each, older rows cover hours, and the oldest rows cover days.
Each row also holds the last error seen, so a dashboard can name a likely cause without touching
history.

The summaries include full-tier and fast-tier queues. Fast-tier counts come from the compact runtime
and outcome records, even when the queue's optional history is off.

<details>
<summary>Reference: tiers and measures</summary>

| Table                   | Grain                                                   |
| ----------------------- | ------------------------------------------------------- |
| `task_stat_bucket`      | One row per closed minute per `(queue_name, task_type)` |
| `task_stat_bucket_hour` | Complete hours derived from minute rows                 |
| `task_stat_bucket_day`  | Complete days derived from hour rows                    |

**Measures**

- `enqueued` and the `task_*` columns count tasks.
- The `attempt_*` columns count closed attempts.
- Each row carries the latest attempt error and a `wait_sketch`.

**Fast tier.** Inputs come from `fast_task_runtime` and `fast_task_outcome`. When `record_attempts`
is enabled, recorded `attempt_history` rows replace the compact error entries, and the final attempt
is not counted twice. If the compact error list overflows, older unrecorded attempts can be absent
from a raw recomputation.

More detail: [Data model: Tiers and measures](../architecture/data-model.md#tiers-and-measures).

</details>

## The watermark keeps every window current

1. **At 10:05:00** minute 10:04 closes.
2. **At 10:05:02** the rollup runs. The rollup is a background pass that summarizes periods that
   have fully elapsed. It summarizes 10:04 and records how far it got, 10:05. That marker is the
   **watermark**.
3. **At 10:05:40** an operator asks for the last hour. Workhorse reads summary rows below the
   watermark. It computes the part from 10:05 onward live from raw history.

A window is therefore correct the instant a task runs. You never wait for a rollup to see your own
work. If the rollup falls behind, you get a longer live section and a slower query, not a wrong
answer.

<details>
<summary>Reference: rollup and window reads</summary>

**Rollup.** `rollup_stats_v1` runs these steps:

1. It materializes complete minutes through `aggregate_stats_v1(from, to)`, the single definition of
   a minute bucket.
2. It derives complete hours, then complete days.
3. It advances `rolled_up_through`, `hourly_rolled_up_through`, and `daily_rolled_up_through` in
   `task_stat_state`.

**Window reads.** `stat_buckets_v1(from, to)` selects a tier for complete periods. It then uses finer
rows and `aggregate_stats_v1` for the newest part.

| Window length     | Tier   | Lower bound must be |
| ----------------- | ------ | ------------------- |
| Under 2 days      | Minute | Minute-aligned      |
| 2 days to 90 days | Hour   | Hour-aligned        |
| At least 90 days  | Day    | Day-aligned         |

`stat_window_tier_v1(from, to)` chooses the tier and rejects a misaligned lower bound.

More detail: [Data model: Window reads](../architecture/data-model.md#window-reads).

</details>

## Late commits and repeated passes

A summary must not miss a row that commits late, and it must not count a row twice.

1. **At 10:04:59** a task fails, and its transaction writes the attempt row with that time.
2. **At 10:05:02** the rollup summarizes 10:04. The transaction has not committed yet, so the rollup
   cannot see the row.
3. **At 10:05:03** the transaction commits.
4. **At 10:06:02** the next pass summarizes 10:05. It also rewrites the last few closed minutes,
   including 10:04. This time it sees the row.

Each pass rebuilds a minute from the raw history in that minute. It replaces the row instead of
adding to it. Running the pass twice therefore produces the same numbers rather than double counting.

Hour summaries come only from complete minute summaries. Day summaries come only from complete hour
summaries. A long window starts on the matching tier boundary and uses coarse complete rows. It then
fills its newest part from finer rows and raw history.

<details>
<summary>Reference: rewrites and cadence</summary>

**Maintenance policy** (`maintenance_policy`)

| Column                          | Accepted values           | Default   |
| ------------------------------- | ------------------------- | --------- |
| `statistics_rollup_interval_ms` | 0, or 1,000 to 86,400,000 | 60,000 ms |
| `statistics_recompute_buckets`  | 0 to 1,440                | 2 minutes |

- Each pass rewrites the last `statistics_recompute_buckets` closed minutes.
- A bucket is a pure function of the raw history in its minute.
- Workers offer `run_maintenance_v1` on their slow maintenance cadence. It runs `rollup_stats_v1`
  before retention.
- `rollup_stats_v1` returns without work until the interval has elapsed.
- Passes serialize on a transaction-scoped advisory lock, so every worker may offer it.

More detail: [Data model: Rewrites and cardinality](../architecture/data-model.md#rewrites-and-cardinality) and [Data model: Policy columns](../architecture/data-model.md#policy-columns-1).

</details>

## Every boundary is a UTC boundary

Two operators open the throughput chart. One works in Tokyo and one in New York. The database runs
with `TimeZone` set to `America/Chicago`.

1. **At 23:59 UTC** an `invoice.send` task succeeds on the queue `billing`. In Tokyo it is already
   the next morning. In New York and Chicago it is still the evening before.
2. **Later** the rollup builds the day summary for that UTC day. The task counts in it.
3. **Both operators** look at the chart. The task falls in the same day bar on both screens.

Both charts split days at the same instants, because every summary boundary is a UTC boundary. A day
summary covers a UTC day, whatever timezone the database is set to. A daylight-saving change does
not shift a boundary. A day summary also lines up with the day of history it came from, because the
history partitions are UTC days too.

<details>
<summary>Reference: bin origin</summary>

Every bin anchors on `timestamp '2000-01-01' AT TIME ZONE 'UTC'`, a fixed instant. Bucket
boundaries are therefore UTC boundaries on every database, whatever its `TimeZone`. Each window step
is a fixed number of hours, so the session `TimeZone` cannot move a boundary.

The history day partitions also pin UTC. The day tier therefore agrees with them.

More detail: [Data model: UTC bin origin](../architecture/data-model.md#utc-bin-origin).

</details>

## Wait percentiles

An operator asks for the 95th percentile of queue wait over the last 30 days. Wait here means the
time from enqueue to the first claim.

1. **Workhorse reads the summary rows** for the window: hour rows for most of it, and finer rows for
   its newest part. Each row holds a sketch of its waits.
2. **For the last few minutes**, which the rollup has not summarized yet, it builds the same kind of
   sketch from the raw `enqueued` and `claimed` events.
3. **It merges the sketches** by adding the counts of matching bins.
4. **It reads the 95th percentile** from the merged sketch.

Workhorse does not keep a list of every wait sample. Each summary row holds a logarithmic sketch: a
count of waits per bin, where each bin covers a slightly wider range than the one before. Sketches
merge by adding the counts of matching bins. So a long window reads raw events only for the short
tail after the rollup watermark, and never needs the samples.

<details>
<summary>Reference: wait sketch</summary>

`wait_sketch` is a JSON object from bin index to count.

| Function                               | Behavior                                                |
| -------------------------------------- | ------------------------------------------------------- |
| `stat_sketch_index_v1(value_ms)`       | `floor(ln(1 + value_ms) / ln(1.02))`                    |
| `stat_sketch_merge_v1(sketches)`       | Adds matching counts                                    |
| `stat_sketch_percentile_v1(sketch, q)` | Returns `1.02^(bin + 0.5) - 1` for the nearest-rank bin |

The estimate has roughly one percent relative error. Zero and sub-millisecond waits stay
representable.

For full-tier tasks, the wait is attributed to the minute of the first `claimed` event.

More detail: [Data model: Wait sketch](../architecture/data-model.md#wait-sketch).

</details>

## Why the watermark protects history

This is the part that connects to cleanup. The rollup can rebuild a summary row only by re-reading
the raw history it came from. Delete that history first, and those numbers are gone for good.

Suppose events are kept for 14 days.

1. **On day 1 at 02:00** the rollup stops, for example because its pass keeps failing. The
   watermark stays at day 1, 02:00.
2. **On day 16 at 03:00** the daily [retention](330-retention.md) pass runs. Its 14-day window
   would delete events up to the start of day 2.
3. **The pass stops at the watermark.** It deletes nothing from day 1, 02:00 onward, because the
   rollup has not summarized it.
4. **Health reports the gap.** Statistics lag and retention lag grow on the health page until the
   rollup runs again.

A stuck rollup makes history pile up rather than making data disappear. That is annoying but
fixable. The alternative would be a silent hole in your numbers, which is not.

<details>
<summary>Reference: retention interlock</summary>

- `task_event_retention_days` and `attempt_history_retention_days` default to 14 days.
- `retain_history_v1` clamps its event and attempt cutoffs to `rolled_up_through`.
- A stalled rollup surfaces as growing retention lag and a rising `QueueHealth.statistics.lagMs`.
- While cold export is enabled, `retain_history_v1` also clamps each dataset to
  `cold_export_dataset.exported_through`.

More detail: [Data model: Retention interlock](../architecture/data-model.md#retention-interlock) and [Data model: `retention_policy`](../architecture/data-model.md#retention_policy).

</details>

## Generated task types

The queue `exports` runs one task type per customer: `export.customer-0001`, `export.customer-0002`,
and so on. In one busy minute, 500 of those types run.

Without a bound, that minute would need 500 summary rows, and the next busy minute another 500. So
each minute keeps its own rows only for the busiest pairs up to a limit. Workhorse folds the rest
into a catch-all type within their own queue. You lose the per-type breakdown for the long tail. You
keep the totals, and the table stays bounded.

Worker identities and tags stay out of the summaries, because deployment data controls how many
there are. Unstable worker names or tenant tags would multiply every row. Views filtered by those
dimensions therefore keep using bounded live queries.

<details>
<summary>Reference: group limit</summary>

| Column                   | Accepted values | Default    |
| ------------------------ | --------------- | ---------- |
| `statistics_group_limit` | 1 to 10,000     | 200 groups |

- The limit applies per minute bucket.
- `aggregate_stats_v1` ranks `(queue_name, task_type)` pairs by activity: `enqueued` plus every
  `attempt_*` count, highest first. Ties go by queue name, then task type.
- Pairs ranked beyond the limit are folded into the task type `__other__` within their own queue.
- Worker and tag dimensions are never rolled up.

More detail: [Data model: Rewrites and cardinality](../architecture/data-model.md#rewrites-and-cardinality) and [Data model: Policy columns](../architecture/data-model.md#policy-columns-1).

</details>

## Turning it off

A team runs one worker against a small database and wants every window computed from raw history.

1. They disable the rollup in maintenance policy. The whole fleet stops rolling up, because the
   setting lives in the database, not in each worker.
2. A dashboard window now reads raw history each time. It stays correct, but it gets slower as
   history grows.
3. History retention stops advancing at the last watermark. The settings page warns about that.

Disable the rollup, and every window is computed live from raw history. Windows stay
correct but get slower, and history retention stops advancing. The interval is maintenance policy
stored beside the other cleanup cadences, so the whole fleet opts out together. This suits only a
small deployment. The settings page warns while retention depends on the watermark.

<details>
<summary>Reference: opting out</summary>

- Set `maintenance_policy.statistics_rollup_interval_ms` to `0`.
- Windows stay fully derived from raw history.
- History retention holds at the current watermark.

More detail: [Data model: Rollup cadence](../architecture/data-model.md#rollup-cadence).

</details>

## Next

- [330-retention.md](330-retention.md) — the cleanup this interlocks with
- [310-workers.md](310-workers.md) — who runs the rollup pass
- [010-tasks-and-state.md](010-tasks-and-state.md) — where the raw history lives

---

Exact measures, bucket definition, and health fields:
[`architecture/data-model.md`](../architecture/data-model.md#task_stat_bucket-task_stat_bucket_hour-task_stat_bucket_day-and-task_stat_state).
