# How does Workhorse delete old data without losing the audit trail?

<!-- scenario-names: emails, invoice.send, invoice-7, invoice-7b, welcome-17 -->

A busy queue produces an enormous amount of history. Every state change is an event, and every
finished attempt is a row. Left alone, those tables become most of your database.

Retention deletes the old rows. Doing that safely is more subtle than a nightly `DELETE`, because
cleanup must never destroy evidence that something else still needs.

## One maintenance pass, five routines

**Example.** A fleet runs only Go workers. Each worker offers the slow maintenance pass about once a
minute.

1. **At 02:59** a worker offers the pass. PostgreSQL runs only the routines that are due. The
   [statistics rollup](320-statistics.md), the background pass that summarizes history into
   buckets, is due, because a minute has passed since its last run.
2. **At 03:00** another worker offers the pass. The rollup runs again. The daily history retention
   routine is now due, so PostgreSQL runs it after the rollup.
3. **A moment later** a third worker offers the pass. The routines have just run and are not due
   again, so this pass does no work.

Every worker runtime offers the same pass through `run_maintenance_v1`. PostgreSQL orders the
routines: statistics, partition preparation, retention, terminal cleanup, and registry cleanup. Each
routine keeps its own due check and lock. A fleet that runs only Python or Go therefore keeps the same
evidence and partition guarantees as a TypeScript fleet.

PostgreSQL also keeps a bounded execution history of the maintenance routines. On the dashboard, the
Schedules page expands each routine into recent outcomes, affected rows, phase timings, and errors.
Successful idle ticks are omitted, because their latest completion already proves the loop is alive.

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

## Windows are minimums, not deadlines

The event window is 14 days. A task writes an event on day 1 at 10:00 UTC.

1. **On day 15 at 03:00** the daily history pass runs. Its cutoff is the start of day 1, so the
   day-1 events are still inside the cutoff.
2. **On day 15 at 10:00** the event is 14 days old. Nothing deletes it yet.
3. **On day 16 at 03:00** the next pass runs. Its cutoff is the start of day 2. Every event of day 1
   has now expired, so the pass drops that day.

The event lived about 14 days and 17 hours, not exactly 14 days.

You configure how long to keep each category of data: finished tasks, outcomes, events, attempts,
schedule occurrences, and statistics. Each category has its own default and can be set on its own.
A category can also opt out of cleanup.

The important word is _minimum_. A window protects everything younger than its cutoff. It does not
promise that older data disappears promptly. Cleanup runs in bounded batches, works through whole
days, and skips anything still referenced. Real retention is always somewhat longer than configured,
because cleanup errs toward keeping evidence.

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

## Deleting by the day, not by the row

Events and attempts are stored in daily partitions. In the example above, the day-1 events sat in
one partition.

1. **On day 16 at 03:00** the history pass finds that every row in the day-1 partition has expired.
2. **It drops the whole partition.** That costs about the same whether the day held a hundred rows or
   ten million.
3. **Suppose a long query holds a lock on that partition.** Dropping a table needs an exclusive lock.
   The pass waits only briefly, then gives up on that day rather than queueing behind live traffic
   and stalling dispatch. The next pass tries again.

Cleanup mostly does not delete rows at all. It drops whole days once every row in them has expired.

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

## A task outlives its history

Every event, attempt, and occurrence points at a task. Suppose an operator sets the task window to
7 days while events stay for 14.

1. **The operator saves the policy.** On day 8 the task row would be deleted.
2. **Its events would still be there**, pointing at a task that no longer exists.
3. **So Workhorse rejects the policy.** The save fails, and the old policy stays in force.

The task identity is what everything else points at. Its window must therefore be at least as long
as every window that depends on it.

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

## Cleanup waits for the rollup

Go back to the day-1 event. On day 16 at 03:00 its window has passed, but the statistics rollup
stalled on day 0.

1. **On day 16 at 03:00** the history pass would drop day 1. The rollup has not summarized day 1
   yet, so the pass keeps it.
2. **While the rollup stays stalled**, history piles up and retention lag grows.
3. **When the rollup catches up**, the next pass drops day 1.

Statistics can only be rebuilt from raw history. So cleanup never deletes history the rollup has not
summarized yet, even when the window allows it. See [320-statistics.md](320-statistics.md) for how
the watermark works.

<details>
<summary>Reference: rollup interlock</summary>

- `retain_history_v1` clamps its event and attempt cutoffs to `task_stat_state.rolled_up_through`.
- A stalled rollup surfaces as growing retention lag and a rising `QueueHealth.statistics.lagMs`.
- While cold export is enabled, a second clamp applies per dataset to
  `cold_export_dataset.exported_through`.

More detail: [Data model: Retention interlock](../architecture/data-model.md#retention-interlock).

</details>

## A task with descendants stays

Task `invoice-7` failed on day 1. An operator [redrove](340-redrive.md) it on day 10. That created a
new task, `invoice-7b`, linked to `invoice-7` as its descendant.

1. **On day 16** `invoice-7` is past every window. Deleting it would break the lineage to
   `invoice-7b`, so cleanup keeps it.
2. **In the same pass** cleanup steps past `invoice-7` to the younger eligible tasks behind it. It
   deletes them as usual. A waiting task never holds up the rest.
3. **On day 25** `invoice-7b` is past its windows, and cleanup deletes it.
4. **On a later pass** `invoice-7` has no retained descendant, and cleanup deletes it too.

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

## Fast-tier tasks

Task `welcome-17` runs on the fast-tier queue `emails`. It succeeds on day 1 at 10:00 UTC, and every
window is 14 days.

1. **On day 1** Workhorse writes its outcome row. It writes no events or attempts.
2. **On day 15 at 10:00** the outcome and identity windows have passed. The history pass of that
   morning has not released day 1, so cleanup keeps the row.
3. **On day 16 at 03:00** the history pass releases day 1. The next terminal cleanup pass deletes
   the task, and its outcome row goes with it.

A task on a [fast-tier queue](305-fast-tier.md) usually has no events or attempts. Its outcome row
stands in for its history. Cleanup deletes that row only once both the outcome window and the history
window have passed, and once the task identity window has too.

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

## Statistics are the exception

A deployment keeps tasks for 14 days and statistics for 365. An `invoice.send` task succeeds on day 1
and counts in that day's summary.

1. **On day 16** cleanup deletes the task and its history, as the earlier sections describe.
2. **The day summary stays.** It still counts the task in day 1's throughput.
3. **About a year later** the summary's own window has passed, and cleanup deletes it.

Summary rows are the one category _not_ bound by "keep the task at least as long". That is
intentional. A summary describes many tasks rather than pointing at one, so summaries can outlive the
tasks they summarize. A deployment can keep a year of daily throughput while it keeps two weeks of
tasks.

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

## When cleanup does not keep up

A queue finishes about two million tasks a day. At 03:00 the daily history pass releases a whole day
of them, so two million tasks become eligible for cleanup at once.

1. **At 03:01** a terminal cleanup pass runs. Every batch fills, so the pass repeats batches until its
   time budget runs out. Eligible tasks remain, so it records that a backlog began.
2. **At the next offer** the follow-up pass runs. While a backlog is recorded, the next pass is due
   seconds after the last one rather than after the full cleanup interval.
3. **When a pass ends with a batch that is not full**, cleanup has caught up. It clears the backlog
   record, and the configured interval applies again.
4. **If completions outrun even that pace**, the backlog record stays set from pass to pass. The
   oldest eligible task keeps aging. Once the backlog has lasted longer than its budget, queue health
   reports a terminal cleanup backlog. Once the oldest task has waited too long, it reports retention
   lag as well.

Full-tier and fast-tier tasks share every batch. A backlog in one tier therefore cannot keep the
other tier's tasks from being deleted.

Cleanup is bounded on purpose: a limited number of tasks, partitions, and rows per pass. If the
incoming rate outruns it, tables grow. This shows up in queue health rather than as a stall: first as
the backlog record, then as a backlog reason or retention lag. The fix is usually a shorter window rather than a bigger
batch.

Health also reports how many rows sit in the fallback partitions. Those are the default partitions
that catch rows when partition maintenance falls behind, so that condition cannot stay invisible.

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

## Schedule runs expire between passes

Schedule runs are deleted only by the daily history pass. A run passes its window at 04:00 on one
day. The next pass runs at 03:00 the following day.

1. **From 04:00 to 03:00 next day** the expired run waits. That is by design, so health does not
   report it.
2. **At 03:00** the pass runs and deletes it.
3. **Suppose that pass never starts.** Its due time is now behind, and expired runs remain. Health
   reports schedule-run lag once that delay exceeds the lag threshold.

Health therefore judges schedule runs against the daily pass. It reports them when the latest pass
left late rows behind. It also reports them when the next pass is overdue and expired runs remain.

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

An engineer sees the `task` table grow and deletes every task that finished more than three days
ago with raw SQL. The event window is 14 days.

1. **The delete runs.** PostgreSQL cascades it into those tasks' events and attempts.
2. **A week later** an operator looks for one of those tasks. The task and its events are gone,
   although the event window promised to keep the events.

It is tempting to write your own `DELETE FROM task WHERE ...`. Do not. The cleanup functions exist to
enforce the rules above. Raw SQL bypasses them. It cascades into retained history, and it removes
evidence before statistics can be rebuilt.

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

- [320-statistics.md](320-statistics.md) — the watermark that gates cleanup
- [340-redrive.md](340-redrive.md) — why some failed tasks stay longer
- [010-tasks-and-state.md](010-tasks-and-state.md) — which tables hold what

---

Exact windows, bounds, and health fields:
[`architecture/data-model.md`](../architecture/data-model.md#retention_policy).
