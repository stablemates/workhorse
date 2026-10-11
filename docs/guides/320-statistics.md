# How does Workhorse count tasks without a scan of all history?

<!-- scenario-names: invoice.send, billing -->

The dashboard must answer questions such as "how many tasks failed in the last hour?" Workhorse
answers them from summaries of the history, not from the full history. Thus, the cost of a count
stays bounded while the history grows.

## Read counts at a bounded cost

**Example.** An operator keeps the dashboard open. The dashboard counts the failures of the last
hour again every few seconds.

1. On day one, the event history holds a few thousand rows. The count is fast.
2. On day thirty, the history holds millions of rows. Each count reads more rows, and the query
   gets slow.
3. During an incident, more tasks fail and more people open the dashboard. The count is most
   expensive when the operator needs it most.

A count of the raw history gets slower each day, because the history only grows. Thus, Workhorse
keeps summaries for each queue and task type. A summary row covers one minute, one hour, or one day.
Recent rows cover minutes, older rows cover hours, and the oldest rows cover days. Each row also
holds the last error. Thus, the dashboard can show a probable cause without a read of the history.

The summaries include full-tier and fast-tier queues. A fast-tier queue gets summaries also when its
optional history is off.

<details>
<summary>Reference: summary tiers</summary>

| Table                   | Grain                                                   |
| ----------------------- | ------------------------------------------------------- |
| `task_stat_bucket`      | One row per closed minute per `(queue_name, task_type)` |
| `task_stat_bucket_hour` | Complete hours derived from minute rows                 |
| `task_stat_bucket_day`  | Complete days derived from hour rows                    |

Each row carries the latest attempt error and a `wait_sketch`.

**Fast tier.** Inputs come from `fast_task_runtime` and `fast_task_outcome`. When `record_attempts`
is enabled, recorded `attempt_history` rows replace the compact error entries, and Workhorse does
not count the final attempt twice. If the compact error list overflows, a raw recomputation can miss
older unrecorded attempts.

More detail: [Data model: Tiers and measures](../architecture/data-model.md#tiers-and-measures).

</details>

## Tell task counts from attempt counts

**Example.** The application enqueues one `invoice.send` task on the queue `billing`.

1. At 10:01:10, the application enqueues the task.
2. At 10:01:12, attempt 1 fails.
3. At 10:01:45, attempt 2 fails.
4. At 10:03:20, attempt 3 succeeds.

The summaries count one task that succeeded. They also count three closed attempts: two that failed
and one that succeeded. The summaries keep the two numbers separately:

- **Tasks.** A task that retries and then succeeds counts as one success.
- **Attempts.** Each closed attempt that Workhorse records or keeps counts separately.

If you mix the two numbers, a failure count can be larger than the number of tasks that ran. Use
task counts for the result of the work. Use attempt counts for the number of tries.

<details>
<summary>Reference: measures</summary>

- `enqueued` and the `task_*` columns count tasks.
- The `attempt_*` columns count closed attempts.

More detail: [Data model: Tiers and measures](../architecture/data-model.md#tiers-and-measures).

</details>

## See your own work in a window at once

The rollup is a routine that summarizes each period after the period ends. A routine is work that a
worker offers to PostgreSQL on a schedule. The watermark is the time up to which the rollup has
summarized the history.

**Example.** The operator asks for the last hour at 10:05:40.

1. At 10:05:00, the minute 10:04 ends.
2. At 10:05:02, the rollup summarizes 10:04. It moves the watermark to 10:05.
3. At 10:05:40, Workhorse reads the summary rows before the watermark.
4. Workhorse counts the part after 10:05 from the raw history.

A window is correct as soon as a task runs. You do not wait for the rollup to see your own work. If
the rollup is late, the raw part of the window is longer and the query is slower. The answer stays
correct.

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

## Count a late commit one time

A summary must include a row that commits late. It must also not count a row two times.

**Example.** An `invoice.send` attempt fails at the end of a minute.

1. At 10:04:59, the attempt fails. Its transaction writes the attempt row with that time.
2. At 10:05:02, the rollup summarizes 10:04. The transaction is not committed, so the rollup does
   not see the row.
3. At 10:05:03, the transaction commits.
4. At 10:06:02, the next pass summarizes 10:05. It also writes the last closed minutes again,
   10:04 included. This time it sees the row.

Each pass builds a minute again from the raw history of that minute. It replaces the row. It does
not add to the row. Thus, if the pass runs two times, the numbers stay the same.

Workhorse makes hour summaries only from complete minute summaries. It makes day summaries only from
complete hour summaries. A long window starts on a boundary of its tier and uses complete rows. For
its newest part, it uses smaller rows and the raw history.

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
- Passes serialize on a transaction-scoped advisory lock, so every worker can offer it.

More detail: [Data model: Rewrites and cardinality](../architecture/data-model.md#rewrites-and-cardinality) and [Data model: Policy columns](../architecture/data-model.md#policy-columns-1).

</details>

## Compare charts from different timezones

Each summary boundary is a UTC boundary. Thus, two operators in different timezones see the same
days.

**Example.** Two operators open the throughput chart. One operator works in Tokyo, and one works in
New York. The `TimeZone` setting of the database is `America/Chicago`.

1. At 23:59 UTC, an `invoice.send` task succeeds. In Tokyo, it is the next morning. In New York and
   Chicago, it is the evening before.
2. Later, the rollup makes the day summary for that UTC day. The summary counts the task.
3. Both operators look at the chart. The task is in the same day bar on the two screens.

A day summary covers one UTC day. The `TimeZone` setting of the database does not change this. A
change to or from daylight saving time does not move a boundary. A day summary also agrees with the
day of history that it comes from, because each history partition is a UTC day too.

<details>
<summary>Reference: bin origin</summary>

Every bin anchors on `timestamp '2000-01-01' AT TIME ZONE 'UTC'`, a fixed instant. Thus, bucket
boundaries are UTC boundaries on every database, whatever its `TimeZone`. Each window step is a
fixed number of hours, so the session `TimeZone` cannot move a boundary.

The history day partitions also pin UTC. Thus, the day tier agrees with them.

More detail: [Data model: UTC bin origin](../architecture/data-model.md#utc-bin-origin).

</details>

## Read a wait percentile for a long window

The wait of a task is the time from enqueue to the first claim. Workhorse does not keep a list of
all wait values. Each summary row keeps a sketch of its waits. A sketch is a set of bins, with a
count of waits in each bin. Each bin covers a slightly wider range than the bin before it.

**Example.** The operator asks for the 95th percentile of the wait in the last 30 days.

1. Workhorse reads the summary rows of the window. Most are hour rows. The newest part uses smaller
   rows.
2. For the last minutes, Workhorse makes a sketch from the raw `enqueued` and `claimed` events.
3. Workhorse merges all sketches. It adds the counts of each bin.
4. Workhorse reads the 95th percentile from the merged sketch.

Workhorse merges sketches with an addition of counts. Thus, a long window reads raw events only for
the short part after the watermark. It does not need each wait value.

<details>
<summary>Reference: wait sketch</summary>

`wait_sketch` is a JSON object from bin index to count.

| Function                               | Behavior                                                |
| -------------------------------------- | ------------------------------------------------------- |
| `stat_sketch_index_v1(value_ms)`       | `floor(ln(1 + value_ms) / ln(1.02))`                    |
| `stat_sketch_merge_v1(sketches)`       | Adds matching counts                                    |
| `stat_sketch_percentile_v1(sketch, q)` | Returns `1.02^(bin + 0.5) - 1` for the nearest-rank bin |

The estimate has a relative error of approximately one percent. The sketch can show zero and
sub-millisecond waits.

For full-tier tasks, Workhorse assigns the wait to the minute of the first `claimed` event.

More detail: [Data model: Wait sketch](../architecture/data-model.md#wait-sketch).

</details>

## Keep history until the rollup summarizes it

The rollup makes a summary row from the raw history. If [retention](330-retention.md) deletes the
raw history first, those numbers are lost. Thus, retention does not delete history that the rollup
has not summarized.

**Example.** The retention window for events is 14 days.

1. On day 1 at 02:00, the rollup stops, because each pass fails. The watermark stays at day 1,
   02:00.
2. On day 16 at 03:00, the daily retention pass starts. Its window lets it delete events up to the
   start of day 2.
3. The pass stops at the watermark. It does not delete events from day 1, 02:00 or later.
4. The health page shows the gap. Statistics lag and retention lag increase until the rollup runs
   again.

If the rollup stops, the history increases. Workhorse does not lose data, and the summaries have no
gap. Repair the rollup, and retention continues.

<details>
<summary>Reference: retention interlock</summary>

- `task_event_retention_days` and `attempt_history_retention_days` default to 14 days.
- `retain_history_v1` clamps its event and attempt cutoffs to `rolled_up_through`.
- A stalled rollup shows as growing retention lag and a rising `QueueHealth.statistics.lagMs`.
- While cold export is enabled, `retain_history_v1` also clamps each dataset to
  `cold_export_dataset.exported_through`.

More detail: [Data model: Retention interlock](../architecture/data-model.md#retention-interlock) and [Data model: `retention_policy`](../architecture/data-model.md#retention_policy).

</details>

## Limit the rows for generated task types

Some applications make one task type for each customer. Without a limit, each of these types adds a
summary row in each minute.

**Example.** The queue `billing` runs one task type for each customer: `invoice.customer-0001`,
`invoice.customer-0002`, and more. In one busy minute, 500 of these types run.

1. Workhorse ranks the pairs of queue and task type. A pair with more enqueues and attempts ranks
   higher.
2. Workhorse keeps one summary row for each pair up to the group limit.
3. Workhorse adds the other pairs to one catch-all task type in the queue `billing`.

You lose the details for each rare task type. You keep the totals, and the summary table stays
bounded.

The summaries do not include worker identities or tags. Your deployment controls how many of these
values exist. Changing worker names or tenant tags can multiply each row. Thus, a view that filters
by worker or tag uses a bounded query of the raw history.

<details>
<summary>Reference: group limit</summary>

| Column                   | Accepted values | Default    |
| ------------------------ | --------------- | ---------- |
| `statistics_group_limit` | 1 to 10,000     | 200 groups |

- The limit applies per minute bucket.
- `aggregate_stats_v1` ranks `(queue_name, task_type)` pairs by activity: `enqueued` plus every
  `attempt_*` count, highest first. Ties go by queue name, then task type.
- Workhorse folds pairs ranked beyond the limit into the task type `__other__` within their own
  queue.
- Workhorse never rolls up worker and tag dimensions.

More detail: [Data model: Rewrites and cardinality](../architecture/data-model.md#rewrites-and-cardinality) and [Data model: Policy columns](../architecture/data-model.md#policy-columns-1).

</details>

## Turn off the rollup

The rollup interval is a setting in the maintenance policy. The maintenance policy is in the
database, so one change applies to all workers. Turn off the rollup only for a small deployment.

**Example.** A team runs one worker on a small database. The team wants each window from the raw
history.

1. The team sets the rollup interval to zero. All workers stop the rollup.
2. Each dashboard window reads the raw history. The window stays correct, but it gets slower while
   the history increases.
3. History retention stops at the last watermark. The settings page shows a warning.

If the rollup is off, Workhorse counts each window from the raw history. History retention does not
continue past the last watermark.

<details>
<summary>Reference: opting out</summary>

- Set `maintenance_policy.statistics_rollup_interval_ms` to `0`.
- Windows stay fully derived from raw history.
- History retention holds at the current watermark.

More detail: [Data model: Rollup cadence](../architecture/data-model.md#rollup-cadence).

</details>

## Next

- [330-retention.md](330-retention.md) — the cleanup that waits for the rollup
- [310-workers.md](310-workers.md) — the workers that run the rollup
- [010-tasks-and-state.md](010-tasks-and-state.md) — where the raw history is

---

Exact measures, bucket definition, and health fields:
[`architecture/data-model.md`](../architecture/data-model.md#task_stat_bucket-task_stat_bucket_hour-task_stat_bucket_day-and-task_stat_state).
