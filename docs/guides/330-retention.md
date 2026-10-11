# How does Workhorse delete old data without losing the audit trail?

<!-- scenario-names: emails, invoice.send, invoice-7, invoice-7b, welcome-17 -->

A busy queue writes a large quantity of history. Each state change writes an event, and each
finished attempt writes a row. If nothing deletes these rows, they can fill most of your database.

Retention is the set of rules that decides when Workhorse deletes old rows. Workhorse must not
delete evidence that other data still needs. Thus retention follows more rules than a nightly
`DELETE`.

## Let the workers run the routines

**Example.** A fleet runs only Go workers. Each worker offers the slow maintenance pass
approximately one time each minute. A maintenance pass is one call that runs each routine that is
due.

1. At 02:59, a worker offers the pass. The [statistics rollup](320-statistics.md), the routine that
   summarizes history into buckets, is due. Its last run was one minute ago, so PostgreSQL runs it.
2. At 03:00, another worker offers the pass. The rollup runs again. The daily history retention
   routine is now due, so PostgreSQL runs it after the rollup.
3. Some seconds later, a third worker offers the pass. No routine is due, so the pass does no work.

Each worker runtime offers the same pass. PostgreSQL sets the order of the routines: statistics,
partition preparation, history retention, terminal cleanup, and registry cleanup. Terminal cleanup
deletes finished tasks. Each routine has its own due check and its own lock. Thus a fleet that runs
only Python or Go workers keeps the same evidence and partitions as a TypeScript fleet.

PostgreSQL also keeps a short run history for each routine. On the dashboard, the Schedules page
shows the recent outcomes of each routine, its affected rows, its phase times, and its errors. The
page omits successful ticks that changed nothing. The latest completion of the tick already shows
that the loop runs.

<details>
<summary>Reference: routines, cadences, and run history</summary>

**Order inside `run_maintenance_v1`**

1. `rollup_stats_v1`
2. `prepare_history_partitions_v1`
3. `retain_history_v1`
4. `prune_terminal_storage_v1`
5. `prune_worker_registry_v1`, with a one-minute maximum age

**Cadences** (`maintenance_policy`)

| Column                              | Accepted values              | Default      |
| ----------------------------------- | ---------------------------- | ------------ |
| `timezone`                          | One validated IANA time zone | UTC          |
| `partition_preparation_interval_ms` | 60,000 to 604,800,000        | Six hours    |
| `terminal_cleanup_interval_ms`      | 1,000 to 86,400,000          | Five minutes |
| `history_retention_local_time`      | Second precision             | 03:00        |
| `statistics_rollup_interval_ms`     | 0, or 1,000 to 86,400,000    | One minute   |

PostgreSQL performs the due check and the advisory-lock coordination. A worker only bounds how often
it offers the pass:

| SDK        | Option                                     | Default   |
| ---------- | ------------------------------------------ | --------- |
| TypeScript | `WorkerOptions.maintenanceRoutinePollMs`   | 60,000 ms |
| Python     | `maintenance_routine_poll_ms`              | 60,000 ms |
| Go         | `WorkerOptions.MaintenanceRoutineInterval` | 60,000 ms |

**Run history.** `maintenance_run` keeps the newest 50 recorded executions per routine. Each row
stores a `run_id`, start and completion instants, a `succeeded`, `failed`, or `incomplete` outcome,
total affected rows, and the ordered phase results. Slow routines record every eligible execution.
`tick_v1` records only executions that return a phase error or change at least one task. It samples
successful task-changing executions at most once per minute.

More detail: [Data model: `maintenance_policy` and `maintenance_state`](../architecture/data-model.md#maintenance_policy-and-maintenance_state).

</details>

## Set how long Workhorse keeps each kind of data

**Example.** The event window is 14 days. A task writes an event on day 1 at 10:00 UTC. The daily
history pass runs at 03:00 UTC.

1. On day 15 at 03:00, the daily history pass runs. Its cutoff is the start of day 1. The day-1
   events are not older than the cutoff, so the pass keeps them.
2. On day 15 at 10:00, the event becomes 14 days old. No routine deletes it yet.
3. On day 16 at 03:00, the next pass runs. Its cutoff is the start of day 2. All events of day 1
   are older than the cutoff, so the pass deletes day 1.

The event stays for approximately 14 days and 17 hours, not for exactly 14 days.

A window is the minimum time that Workhorse keeps one kind of data. You set a window for each kind:
finished tasks, outcomes, events, attempts, schedule runs, and statistics. Each kind has its own
default, and you can set each one separately. You can also turn off cleanup for one kind.

A window is a minimum, not a deadline. Workhorse keeps all data that is younger than the cutoff. It
does not delete older data immediately. Cleanup runs in limited batches, deletes whole days, and
skips rows that other data still uses. Thus Workhorse always keeps data a little longer than its
window.

<details>
<summary>Reference: retention policy</summary>

One singleton row, `retention_policy`, holds the policy.

| Column                               | Category             | Default |
| ------------------------------------ | -------------------- | ------- |
| `task_identity_retention_days`       | Task identity        | 14      |
| `terminal_outcome_retention_days`    | Terminal outcome     | 14      |
| `task_event_retention_days`          | Task events          | 14      |
| `attempt_history_retention_days`     | Attempt history      | 14      |
| `schedule_occurrence_retention_days` | Schedule occurrences | 14      |
| `statistics_retention_days`          | Statistics           | 14      |

Each window is an integer from 1 to 36,500 days. Null disables automatic deletion for that category.

**History cutoffs.** A pass computes one cutoff per category. The event cutoff is the start of the
current UTC day minus `task_event_retention_days`. The attempt cutoff is the same day start minus
`attempt_history_retention_days`. Each cutoff is then clamped to the statistics rollup watermark,
and, while cold export is enabled, to that category's export watermark. The pass runs once a day at
`history_retention_local_time` in `maintenance_policy.timezone`.

After a complete pass, `maintenance_state.history_retained_before` records the earlier of the two
cutoffs. Terminal-task pruning uses that value as its history cutoff.

**Changing the policy**

| Function                       | Queue method                    | Effect                                                       |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------ |
| `sync_retention_policy_v1`     | `Queue.syncRetentionPolicy`     | Sets application values; keeps operator-owned values         |
| `override_retention_policy_v1` | `Queue.overrideRetentionPolicy` | Sets selected effective values and marks them operator-owned |
| `revert_retention_policy_v1`   | `Queue.revertRetentionPolicy`   | Restores selected application values                         |

`Queue.previewRetentionPolicy` writes nothing. It counts at most 10,001 eligible rows per category.

More detail: [Data model: `retention_policy`](../architecture/data-model.md#retention_policy).

</details>

## Expect cleanup to delete a whole day at a time

Workhorse stores events and attempts in daily partitions. A partition is a part of a table. Each
daily partition holds the rows of one UTC day.

**Example.** The day-1 events of the first example are in one partition.

1. On day 16 at 03:00, the history pass finds that all rows in the day-1 partition are expired.
2. The pass drops the full partition. This costs approximately the same for a hundred rows or for
   ten million rows.
3. If a long query holds a lock on the partition, the pass cannot get its exclusive lock. The pass
   waits for a short time and then skips the day. Thus live work does not wait behind the pass.
4. The next pass tries to drop the day again.

Usually, cleanup does not delete rows one at a time. It drops a whole day when all rows of that day
are expired.

<details>
<summary>Reference: partition retention</summary>

Event and attempt retention are independent phases inside `retain_history_v1`. Each phase:

- drops only fully expired, completed UTC days;
- retires at most `history_partitions_per_pass` days per pass;
- skips a day whose lock is busy;
- caps each DDL lock wait at 250 ms;
- deletes expired rows from its default partition, up to `default_partition_rows_per_pass`.

| Work limit                        | Accepted values | Default |
| --------------------------------- | --------------- | ------- |
| `history_partitions_per_pass`     | 1 to 52         | 4       |
| `default_partition_rows_per_pass` | 1 to 1,000,000  | 10,000  |

A default partition catches rows when no day partition exists for them.

More detail: [Data model: Retention](../architecture/data-model.md#retention-2) and [Data model: `retention_policy`](../architecture/data-model.md#retention_policy).

</details>

## Keep the task window as long as its history

Each event, attempt, and schedule run points to its task. If Workhorse deletes the task first, that
history points to a task that does not exist.

**Example.** An operator sets the task window to 7 days. The event window stays at 14 days.

1. The operator tries to save the policy.
2. Workhorse finds that the task row can expire 7 days before its events.
3. Workhorse rejects the policy. The old policy stays in use.

The task window must be at least as long as each window that depends on it.

<details>
<summary>Reference: validity rules</summary>

A finite `task_identity_retention_days` requires:

- a finite `terminal_outcome_retention_days`;
- finite event, attempt, and schedule-occurrence windows;
- an identity window at least as long as each of those four.

A finite outcome window also requires a finite identity window. PostgreSQL rejects any other
combination.

More detail: [Data model: Validity rules](../architecture/data-model.md#validity-rules).

</details>

## Keep the statistics rollup running

Workhorse can rebuild statistics only from raw history. Thus cleanup does not delete history that
the rollup has not summarized, even if the window permits it. Retention lag is the time that expired
data waits for deletion.

**Example.** On day 16 at 03:00, the window of the day-1 event has passed. But the statistics
rollup stopped on day 0.

1. On day 16 at 03:00, the history pass can delete day 1 by its window. The rollup has not
   summarized day 1, so the pass keeps it.
2. While the rollup stays stopped, history increases and retention lag increases.
3. When the rollup summarizes day 1, the next pass deletes day 1.

[320-statistics.md](320-statistics.md) explains the rollup watermark.

<details>
<summary>Reference: rollup interlock</summary>

- `retain_history_v1` clamps its event and attempt cutoffs to `task_stat_state.rolled_up_through`.
- A stalled rollup surfaces as growing retention lag and a rising `QueueHealth.statistics.lagMs`.
- While cold export is enabled, a second clamp applies per dataset to
  `cold_export_dataset.exported_through`.

More detail: [Data model: Retention interlock](../architecture/data-model.md#retention-interlock).

</details>

## Expect a redriven task to stay longer

A [redrive](340-redrive.md) makes a new task from a failed task. The new task is a descendant of the
failed task. Workhorse keeps the failed task while its descendant exists, so that the link stays
complete.

**Example.** Task `invoice-7` fails on day 1. On day 10, an operator redrives it. The redrive makes
the new task `invoice-7b`, a descendant of `invoice-7`.

1. On day 16, `invoice-7` is past all its windows. A deletion breaks the link to `invoice-7b`, so
   cleanup keeps `invoice-7`.
2. In the same pass, cleanup skips `invoice-7` and deletes the younger expired tasks as usual.
3. On day 25, `invoice-7b` is past its windows, and cleanup deletes it.
4. On a later pass, `invoice-7` has no descendant, and cleanup deletes it.

A kept task does not stop the deletion of other tasks.

<details>
<summary>Reference: lineage retention</summary>

- Terminal identity pruning skips any redrive source with a retained descendant edge.
- It skips the source before it bounds the candidate window, so a retained source never keeps a pass
  from reaching younger eligible tasks.
- Deleting the target cascades its inbound edge. The source can then become eligible under the
  normal windows.
- `terminal_task_prune_limit` bounds each terminal batch: 1 to 100,000 tasks, default 1,000.

More detail: [Data model: Lineage retention](../architecture/data-model.md#lineage-retention) and [Data model: `retention_policy`](../architecture/data-model.md#retention_policy).

</details>

## Expect fast-tier outcomes to follow the history window

A task on a [fast-tier queue](305-fast-tier.md) usually writes no events or attempts. Its outcome
row is its only history.

**Example.** Task `welcome-17` runs on the fast-tier queue `emails`. It succeeds on day 1 at
10:00 UTC. Each window is 14 days.

1. On day 1, Workhorse writes the outcome row of the task. It writes no events or attempts.
2. On day 15 at 10:00, the outcome window and the task window pass. The history pass of that
   morning did not release day 1, so cleanup keeps the row.
3. On day 16 at 03:00, the history pass releases day 1.
4. The next terminal cleanup pass deletes the task and its outcome row.

Cleanup deletes a fast-tier outcome only after three windows pass: the outcome window, the history
window, and the task window.

<details>
<summary>Reference: fast-tier outcome retention</summary>

`prune_terminal_tasks_v1` deletes a fast outcome when all of these hold:

1. `finished_at` is earlier than the outcome cutoff.
2. `finished_at` is earlier than the history cutoff. While cold export is enabled, that cutoff is
   clamped to the `fast_task_outcome` dataset's `exported_through`.
3. The task identity's `created_at` is earlier than the identity cutoff.
4. No `task_event`, `attempt_history`, `schedule_occurrence`, or `enqueue_idempotency` row
   references the task.
5. No `task_redrive` row names the task as its source. A redrive that targets the task does not
   block pruning: deleting the target cascades that edge.

The full and fast tiers share each batch. The tier that goes first gets half the limit, rounded up,
and the first tier alternates on every call. A share that one tier cannot use goes to the other
tier. Cleanup deletes the `task` identity, which cascades to the outcome.

More detail: [Fast tier: Retention](../architecture/fast-tier.md#retention).

</details>

## Keep statistics longer than tasks

Statistics are the only kind of data that can stay longer than its tasks. A summary counts many
tasks and does not point to one task.

**Example.** A deployment keeps tasks for 14 days and statistics for 365 days. An `invoice.send`
task succeeds on day 1. The summary of day 1 counts it.

1. On day 16, cleanup deletes the task and its history.
2. The summary of day 1 stays. It still counts the task in the throughput of day 1.
3. Approximately one year later, the window of the summary passes, and cleanup deletes it.

Thus a deployment can keep a year of daily throughput and two weeks of tasks. In the statistics
window, older summaries use larger buckets. Thus a long window keeps totals and wait percentiles
that can be merged, but not the finest detail.

<details>
<summary>Reference: statistics retention</summary>

| Tier   | Retention                           |
| ------ | ----------------------------------- |
| Minute | At most two days                    |
| Hour   | At most ninety days                 |
| Day    | Follows `statistics_retention_days` |

- A shorter configured window shortens every tier.
- Each table deletes at most `statistics_rows_per_pass` rows per pass: 1 to 1,000,000, default
  10,000.

More detail: [Data model: Bucket retention](../architecture/data-model.md#bucket-retention) and [Data model: `retention_policy`](../architecture/data-model.md#retention_policy).

</details>

## Find cleanup that does not keep up

Cleanup has limits on purpose. Each pass deletes a limited number of tasks, partitions, and rows. If
new data arrives faster, the tables become larger. Queue health shows this condition before the
disk is full.

**Example.** A queue finishes approximately two million tasks each day. At 03:00, the daily history
pass releases a full day, so two million tasks are ready for cleanup at the same time.

1. At 03:01, a terminal cleanup pass runs. Each batch is full, so the pass runs batches until its
   time limit. Expired tasks remain, so the pass records the start of a backlog.
2. While the backlog record exists, the next pass is due after some seconds, not after the full
   cleanup interval.
3. If a pass ends with a batch that is not full, the backlog is gone. The pass clears the record,
   and the usual interval applies again.
4. If tasks finish faster than cleanup deletes them, the record stays. The oldest expired task
   becomes older.
5. When the backlog is older than its limit, queue health reports a terminal cleanup backlog. When
   the oldest task waits too long, queue health also reports retention lag.

Full-tier and fast-tier tasks share each batch. Thus a backlog in one tier cannot stop the deletion
of tasks in the other tier.

Queue health shows a slow cleanup in steps: first the backlog record, then a backlog reason or
retention lag. Usually, a shorter window is a better fix than a larger batch.

Queue health also counts the rows in the default partitions. A default partition holds rows when no
daily partition exists for them. Thus you can see when partition preparation is late.

<details>
<summary>Reference: retention health</summary>

Retention health includes:

- the persisted policy;
- the oldest retained timestamps;
- per-category cleanup lag;
- counts of fully eligible event and attempt partitions;
- bounded row counts for both default partitions.

Fallback counts are exact through 10,000 rows. `defaultHistoryRowsCapped` marks 10,001 as a lower
bound.

Lag differs by category:

- **Task identity and terminal outcome lag** count from the later of two instants: the row passing
  its window, and the history pass that released it.
- **Event and attempt lag** count from the configured window alone. A partitioned row counts past
  the start of the UTC day its window reaches, and a default-partition row past the window itself.
  The rollup and export clamps are not applied. So a stalled rollup or exporter shows as growing
  history lag, even while retention may not delete those rows.

| `queue_health_policy` column  | Default          |
| ----------------------------- | ---------------- |
| `row_retention_lag_ms`        | 21,600,000 (6 h) |
| `terminal_cleanup_backlog_ms` | 21,600,000 (6 h) |

**Terminal cleanup pace**

- `terminal_task_prune_limit` bounds each batch. The `terminal_tasks` phase repeats batches while
  each one fills, for at most one second per pass.
- A pass whose last batch filled sets `maintenance_state.terminal_cleanup_backlog_since`, or keeps
  its earlier value. The next pass is then due after the follow-up delay of five seconds, or after
  `terminal_cleanup_interval_ms` when that is shorter. The dashboard's `due` flag for the routine
  uses the same delay.
- A successful pass that ends without a full batch clears the column.
- The `queue_health_v1` document reports the column as `terminal_cleanup_backlog_since`. Go,
  Python, Rust, and Ruby return that key. TypeScript `Queue.health()` maps it to
  `terminalCleanupBacklogSince`.
- A backlog older than `terminal_cleanup_backlog_ms` raises the degraded reason
  `terminal-cleanup-backlog`. Its `observed` value is the backlog's age in milliseconds.
- Each `terminal_storage` row in `maintenance_run` records the rows its pass deleted.

More detail: [Task lifecycle: Retention health](../architecture/lifecycle.md#retention-health), [Task lifecycle: Health policy](../architecture/lifecycle.md#health-policy), and [Task lifecycle: Background routines](../architecture/lifecycle.md#background-routines).

</details>

## Read the lag of schedule runs

Only the daily history pass deletes schedule runs. Thus an expired schedule run can wait almost one
day before deletion.

**Example.** A schedule run passes its window at 04:00. The next history pass runs at 03:00 on the
next day.

1. From 04:00 until 03:00, the expired run waits. This is the usual behavior, so queue health does
   not report it.
2. At 03:00, the pass runs and deletes the run.
3. If that pass does not start, its due time passes and expired runs remain.
4. When this delay is longer than the lag limit, queue health reports schedule-run lag.

Queue health measures schedule runs against the daily pass. It reports them if the latest pass left
late rows. It also reports them if the next pass is late and expired runs remain.

<details>
<summary>Reference: schedule-run lag</summary>

`queue_health_v1` computes two internal lags:

- `schedule_occurrence_pass_lag_ms` measures the oldest run the latest pass should have deleted,
  as of that pass's start.
- `schedule_occurrence_due_lag_ms` is the time since the first scheduled pass after the latest start
  fell due.

`evaluate_queue_health_v1` reports schedule runs when either holds:

1. The pass lag exceeds `row_retention_lag_ms`.
2. The due lag exceeds `row_retention_lag_ms` while `schedule_occurrence_lag_ms` is above 0.

Between on-time passes, expired runs alone do not degrade health.

More detail: [Task lifecycle: Schedule run retention lag](../architecture/lifecycle.md#schedule-run-retention-lag).

</details>

## Do not delete tasks yourself

The cleanup routines apply the rules on this page. Raw SQL ignores these rules.

**Example.** An engineer sees that the `task` table becomes large. The event window is 14 days.

1. With raw SQL, the engineer deletes each task that finished more than three days ago.
2. PostgreSQL also deletes the events and attempts of those tasks.
3. One week later, an operator looks for one of those tasks. The task and its events are gone, but
   the event window promised to keep the events.

Do not write your own `DELETE FROM task WHERE ...`. It deletes the kept history of each task. It can
also delete evidence before the rollup summarizes it.

<details>
<summary>Reference: identity deletion</summary>

- `task_event.task_id` and `attempt_history.task_id` reference `task.id` with `ON DELETE CASCADE`.
  Direct identity deletion therefore deletes that history too.
- `prune_terminal_tasks_v1` excludes identities with retained history.
- `prune_terminal_storage_v1` deletes a terminal identity only behind the retained-through
  watermark, which advances once both history categories are clear before their cutoffs.
- Direct application SQL that deletes package-owned `task` rows is unsupported.

More detail: [Data model: Attribution and identity deletion](../architecture/data-model.md#attribution-and-identity-deletion).

</details>

## Next

- [320-statistics.md](320-statistics.md) — the watermark that controls cleanup
- [340-redrive.md](340-redrive.md) — why some failed tasks stay longer
- [010-tasks-and-state.md](010-tasks-and-state.md) — which tables hold which data

---

Exact windows, limits, and health fields:
[`architecture/data-model.md`](../architecture/data-model.md#retention_policy).
