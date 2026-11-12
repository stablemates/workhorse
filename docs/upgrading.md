# Upgrade notes

An upgrade note states what changes for an operator when a deployment moves from one release to
the next. Each section below covers one minor line, newest first. It names the migrations, the
schema version, and the steps that the upgrade needs.

[Compatibility and support boundary](compatibility.md) states the schema guarantees that every
upgrade keeps. Each changelog states the full changes of its release.

## Upgrade from 0.12.x to the next release

The next release corrects how debounce, enqueue, queue purge, and claims use the clock and their
locks. It also limits the queue name of an enqueue, and it keeps one failed schedule from stopping
the other schedules. It makes cold export wait for the transactions that can still write into a
day. It also corrects the statistics catch-up and the completion of history retention. Terminal cleanup
and queue health use one retention rule, and each retention window is a fixed number of hours. It
keeps the audit of each settings change of the dashboard, lets each embedded dashboard withhold
error stacks, and opens the detail of each record of the event feed. It gives the expired-lease scan
a floor, and it counts the active leases of one admission shard through an index. The upgrade
is a rolling deployment, and a mixed fleet is supported while it runs.

1. If you run cold exporters, stop each one and let it finish its object and manifest uploads. Keep
   cold export enabled, so retention keeps waiting for the export.
2. Run `workhorse schema migrate`. It applies migrations 0093 through 0102 and leaves the schema at
   version 101. Do this before the first process of the new release starts, because the floor rises.
   Migration 0102 builds an index on `task_runtime` without a block on writes. On a large table the
   build can take a long time, as the next section states.
3. Roll out the new processes in any order. Then start the exporters again.

A 0.12.0 database is at schema version 91. The migrations replace function bodies, 0095 adds
three nullable columns, 0096 adds two nullable columns, 0097 adds one table and one nullable column, 0099 adds one nullable column to each policy table, 0100 adds functions, and 0102 adds one index. Only 0096 changes stored rows: it fences
each `cold_export_segment` row that is exporting.

| Migration                                                                         | Schema version | Changes                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0093-decide-debounce-with-one-clock-and-keep-pending-debounce-keys.sql`          | 92             | `enqueue_debounce_v1`, `enqueue_batch_v1`, `lock_enqueue_prerequisites_internal_v1`, and `prune_enqueue_idempotency_v1` correct enqueue defects                                                                                                                                                                                                                                           |
| `0094-purge-locked-tasks-lock-stale-tiers-and-start-leases-after-locks.sql`       | 93             | `purge_queue_internal_v1`, `lock_queue_tiers_v1`, `set_queue_tier_v1`, `enqueue_batch_v1`, `enqueue_debounce_v1`, `sync_schedule_definitions_internal_v1`, `add_task_group_members_v1`, `claim_policy_batch_v1`, and `claim_one_v1` correct purge, tier, queue name, and lease defects                                                                                                    |
| `0095-isolate-each-schedule-in-a-pass-and-match-two-wildcard-day-fields.sql`      | 94             | `fire_due_schedules_v2` isolates each schedule and records its error in three new `schedule_definition` columns, `sync_schedule_definitions_internal_v1` refuses a fast-tier concurrency key, `cron_occurrences_v1` matches two wildcard day fields, and `dashboard_cron_v1` returns the error                                                                                            |
| `0096-export-a-day-after-its-snapshot-frontier-and-keep-held-retention-due.sql`   | 95             | `claim_cold_export_segment_v1` waits for a snapshot frontier in two new `cold_export_dataset` columns, `send_signal_v1`, `complete_human_wait_v1`, and `record_batch_event_v1` take a transaction ID before an event, `rollup_stats_v1` keeps statistics rows that a coarser tier needs, and `retain_history_v1` keeps a held pass due                                                    |
| `0097-give-cleanup-and-health-one-retention-rule-in-fixed-hours.sql`              | 96             | The new table `terminal_prune_position` lets `prune_full_terminal_tasks_internal_v1` and `prune_fast_terminal_tasks_internal_v1` examine bounded slices and lock only rows that they can delete, `queue_health_v1` applies the cleanup holds with a capped walk, `evaluate_queue_health_v1` adds `maintenance-failing` and `schedule-failing`, and each retention cutoff uses fixed hours |
| `0098-compare-wait-targets-in-milliseconds-and-report-second-child-sets.sql`      | 97             | `schedule_wait_v2` compares an absolute target at milliseconds, `send_signal_v2` answers `stale` for a terminal task with no wait, `create_children_v2` answers `limit_exceeded` for a second child set, and `get_task_group_v1` shows a callback that failed to enqueue                                                                                                                  |
| `0099-keep-the-settings-audit-withhold-error-stacks-and-find-derived-records.sql` | 98             | `override_*_policy_v2` and `revert_*_policy_v2` record the audit of each setting in the new `operator_audit` column of each policy table, the released policy writers keep each entry true, three dashboard reads take `redactErrorStacks`, and `dashboard_event_detail_v1` finds each derived record                                                                                     |
| `0100-bound-failure-envelopes-and-answer-oversized-checkpoints.sql`               | 99             | `fail_v2` and `fast_fail_v2` cut the fields of a failure envelope, and `save_checkpoint_v3` answers `value_too_large` for a checkpoint value that it cannot store                                                                                                                                                                                                                         |
| `0101-floor-the-lease-scan-gate-and-count-one-admission-shard.sql`                | 100            | `tick_v1` runs the expired-lease scan at most once in 500 ms while a live worker is registered, and `notify_concurrency_capacity_v1` counts one admission shard with parts that an index can serve                                                                                                                                                                                        |
| `0102-index-the-active-leases-of-each-admission-shard.sql`                        | 101            | Builds `task_runtime_active_queue_shard_idx` on `(queue_name, admission_shard)` for active rows with `CREATE INDEX CONCURRENTLY`, outside a transaction                                                                                                                                                                                                                                   |

Migrations 0093 through 0097 keep the floor. With migrations 0098, 0099, and 0100, the SDK schema floor rises from 76 to 99.
Migrations 0101 and 0102 add no function that an SDK calls, so they keep the floor at 99.
Each SDK statement catalogue of the new release names `schedule_wait_v2`, `send_signal_v2`, and
`create_children_v2`, which schema version 97 adds. The dashboard host of each SDK calls
`override_retention_policy_v2` and the three other audited policy functions, which schema version
98 adds. Migration 0100 adds `fail_v2` and `save_checkpoint_v3`, which each catalogue also names, so
the floor rises to 99. A new process refuses every mutation on a schema below version 99. A 0.12
worker keeps calling `fail_v1` and `save_checkpoint_v2`, which keep their answers. The SQL functions
change for every SDK version when each migration commits:

- A debounce request reads the clock after its last lock. It no longer writes a second task when a
  lock wait ends after its window.
- A debounce request locks the runtime row of its task before the key row. It no longer deadlocks
  with `run_task_now_v1` or a queue purge.
- A batch with more than one debounce member locks the runtime rows of their tasks in task ID
  order, the order of a purge.
- Maintenance keeps the key of a debounced task while that task is `ready` or `scheduled`. A late
  same-key request then returns `non_replaceable` with `window_elapsed_pending`.
- An enqueue batch reads its timestamp after its tier and prerequisite locks.
- A queue purge removes only the tasks that it locked. A task that a producer commits during the
  purge stays, and a worker can claim and complete it.
- An enqueue refuses a queue name above 256 UTF-8 bytes. Before, a name of 257 to 7,999 bytes was
  accepted. Existing tasks with a longer name continue to run at read committed. At repeatable read
  or serializable, an enqueue, redrive, or group add that names such a queue fails with the same
  error. A producer that uses such a name
  fails after the upgrade, so change it to a shorter queue name first.
- Schedule synchronization refuses a new or changed schedule with such a queue name. A stored
  schedule with such a name stays, but it no longer fires, because each fire fails in the enqueue.
  Migration 0095 (SM-1927) runs each schedule in its own subtransaction, so that failure does not
  stop the other schedules. Both migrations ship in the same release. Find these schedules with
  `SELECT namespace, schedule_name FROM workhorse.schedule_definition WHERE octet_length(queue_name) > 256;`,
  and synchronize each one with a shorter queue name, or remove it.
- An enqueue at repeatable read or serializable locks the `queue_control` row of each queue. If a
  tier change committed after the snapshot of the transaction, the enqueue fails with SQLSTATE
  `40001`, and the application retries. `set_queue_tier_v1` refuses isolation levels other than
  read committed with SQLSTATE `0A000`.
- A claim computes the lease expiry from a clock sample taken after its row locks.
- If one schedule fails in a schedule pass, the other schedules of the pass still fire, and the
  worker continues. Before, one failure rolled back the whole pass, and the TypeScript and Go
  workers ended their run. The failed schedule keeps its position and stores the error in
  `last_error_at`, `last_error_code`, and `last_error_message`. Find these schedules with
  `SELECT namespace, schedule_name, last_error_code, last_error_message FROM workhorse.schedule_definition WHERE last_error_at IS NOT NULL;`.
- Schedule synchronization refuses an enabled schedule with a concurrency key on a fast-tier queue,
  with SQLSTATE `P1007`. Before the upgrade, remove the key from such a schedule, or disable it.
- `0 12 * * ?` and the other expressions with `?` in day-of-week and a wildcard day-of-month now
  match each day. The synchronization refused them before, so no stored schedule changes.
- Cold export gives out a day at the earliest 60 s after the end of the day. It also waits until each
  transaction that was open at that time has ended. A long write transaction in any database of
  the server delays the export of a day until it ends. An exporter must call the claim in a
  transaction of its own. It must read all pages of a day in one `REPEATABLE READ` transaction that
  starts after the claim. A claim in a transaction that already has a transaction ID records no
  frontier. Thus it cannot start the wait for a new day
  ([Cold export](guides/335-cold-export.md)).
- An exporter that holds a segment when migration 0096 runs cannot complete or fail it. Its
  completion raises `not held by attempt`. The next claim gives out the day again after its
  frontier, and the exporter writes the same object key again. The fence cannot stop an upload that is
  already in flight. That upload can write an earlier read of the day over the newer object. Thus stop the exporters and let their uploads finish before the migration, as step 1
  says.
- A day that an exporter completed before migration 0096 used the earlier gate. A late commit into
  that day is not in its export object.
- After a stop of the statistics rollup of more than two days, the catch-up keeps each minute
  bucket until the hour tier uses it. Before, each catch-up pass lost the minutes after its last
  complete hour.
- Terminal cleanup locks only the terminal tasks that it can delete. When the
  `enqueue_idempotency` or `released_dependencies` phase deletes the key or edge of a terminal task,
  it records the end of that hold in the new column `task_outcome.held_until`. A task that a schedule
  occurrence, an enqueue key, a dependency edge, or a young child keeps no longer stops the deletion
  of other tasks. When cleanup deletes the last target of a redrive source and the batch has room, it
  deletes the source in the same batch.
- Queue health does not count a row as `retention-lag` while cleanup keeps it on purpose: a redrive
  source with a target, a prerequisite of a live dependent, a parent of a child that is not yet
  eligible, or a task of an unexpired schedule occurrence or enqueue key. The lag of such a row counts
  from the end of its hold ([ADR 0122](decisions/0122-give-cleanup-and-health-one-retention-rule.md)).
- Queue health reports the degraded reason `maintenance-failing` when three runs of a routine
  failed one after another after its last completion, and `schedule-failing` when an enabled schedule failed in its last schedule pass.
  A dashboard package older than this release does not show these two reasons.
- Each retention window of N days is N times 24 hours. Before, PostgreSQL stepped calendar days in
  the session TimeZone, so across a daylight-saving change a window was one hour longer or shorter.
  In a UTC session, nothing changes.
- If the rollup or the export holds back a history retention pass, the pass records `incomplete`. It
  runs again on the next offer until the hold ends. Before, it recorded `succeeded` and waited for the
  next local date.
- `override_retention_policy_v1`, `revert_retention_policy_v1`, `override_maintenance_policy_v1`,
  and `revert_maintenance_policy_v1`, which `Queue.overrideRetentionPolicy` and the three other
  `Queue` policy methods call, remove the audit entry of each setting that they change. A forced
  `sync_*_policy_v1` removes every entry, and a sync without force removes the entry of each
  setting whose effective value it changes. Each function that returns a policy row returns the new
  `operator_audit` column at its end.
- `dashboard_event_detail_v1` accepts any UUID in canonical form, so a record that the dashboard
  derives for a fast-tier task opens its detail. Before, it returned null for almost each such
  record.

Migration 0098 adds function versions, so its answers reach only the processes of the new release:

- A replay of an absolute timer compares the target at millisecond precision. Before, a task that a
  Python, Go, or Rust worker parked with digits below the millisecond failed with a wait conflict
  when a TypeScript, Ruby, JVM, or .NET worker replayed it. A worker of an earlier release still
  calls `schedule_wait_v1`. Thus during the rollout, such a task can still conflict when a
  TypeScript, Ruby, JVM, or .NET worker of the earlier release replays it. Each SDK keeps the
  precision that it sends, so a rollout inside one language is safe.
- A signal to a terminal task that has no wait of that name returns `stale` and records no event.
  Before, it returned `not_waiting` and recorded `signal_rejected` each time. A sender that tries
  again after `not_waiting` can stop at `stale`.
- A second child set in one activation raises the child limit error of the SDK, not its conflict
  error. The task still fails with no retry.
- The group snapshot shows a callback that failed to enqueue at the finish, with its SQLSTATE, error message, and time. Retention deletes this record with the group.

Migration 0100 also adds function versions. A worker of the new release changes two failure rules:

- It cuts the `name`, the `message`, and the `stack` of a failure envelope to 1,024, 16,384, and 65,536
  UTF-8 bytes, and it adds `"truncated": true` to an envelope that it cut. A reader that expects
  the whole `message` of a long handler error gets the first part only
  ([Schema and SQL protocol: Envelope limits](architecture/schema-and-protocol.md#envelope-limits)).
- If a checkpoint value has more than 1,048,576 bytes of jsonb text, the worker fails the task
  without a retry, with `CheckpointValueSizeLimitError` or the name of its SDK. Before, each retry
  ran the operation of the checkpoint again. Correct the handler, and then redrive the task
  ([Delivery guarantees](guides/030-delivery-guarantees.md#keep-a-checkpoint-value-below-its-limit)).

A worker of the new release also changes two rules that need no migration:

- A child limit refusal now fails the task at the first attempt and not after `maxAttempts`. This
  applies to a second single child, a set of more than 100 children, and a child join whose
  results are larger than the result limit of the task. A second child set already failed at the
  first attempt. A handler replays the same child calls, so a retry got the same refusal and ran
  again the work that no checkpoint holds. Correct the handler, and then redrive the task
  ([Schema and SQL protocol: Durable replay conflicts](architecture/schema-and-protocol.md#durable-replay-conflicts)).
- A Rust worker that continued after a failed maintenance pass now ends its run, as the workers of
  the other six SDKs do. `Worker::run` drains the tasks in flight and returns the error of the pass.
  This also applies to the first pass at startup. Its supervisor must start it again
  ([Schema and SQL protocol: Failed maintenance pass](architecture/schema-and-protocol.md#failed-maintenance-pass)).

A 0.12 process keeps working on schema version 101, because a migration inside a major line only
adds. Migration 0098 keeps `schedule_wait_v1`, `send_signal_v1`, and `create_children_v1` and their
answers. Migration 0100 keeps `fail_v1`, `fast_fail_v1`, and `save_checkpoint_v2` and their answers.

Migration 0101 changes two function bodies for every SDK version when it commits:

- While a live worker is registered, `tick_v1` runs the expired-lease scan of the full tier at most
  once in 500 ms. The gate interval is the shortest live `maintenance_interval_ms`, but never less
  than 1,000 ms, the default of each SDK. If you set a maintenance interval below 1,000 ms to find
  expired leases sooner, the full tier now finds an expired lease up to 500 ms plus that interval
  after it expires. That worker still ticks at its own interval, and each tick still promotes and
  recovers deadlines, attempt timeouts, and fast-tier leases. A fleet whose shortest interval is
  1,000 ms or more scans as before. A direct `tick_v1` caller with no live registered worker still
  scans on each tick
  ([Lifecycle: Maintenance cadence](architecture/lifecycle.md#maintenance-cadence)).
- A release from a queue with a concurrency policy counts the active leases of one admission shard
  through the index of migration 0102. It gives the same answer as before, and without the index it
  gives the same answer more slowly
  ([Lifecycle: Capacity release notifications](architecture/lifecycle.md#capacity-release-notifications)).

### Build the shard index

Migration 0102 runs outside a transaction. `CREATE INDEX CONCURRENTLY` lets claims, heartbeats,
and releases continue during the build. The build reads the whole `task_runtime` table, so its time
grows with the size of the table. It also waits for each transaction that was open on the table when
it started, so a long transaction delays it. A process of the new release does not wait for the
build, because the floor is 99. Until the build ends, each release with a concurrency policy counts
its shard more slowly. After the build, each claim writes one more index entry, and a heartbeat
stays a HOT update.

If the build fails, PostgreSQL keeps an invalid index with the name
`task_runtime_active_queue_shard_idx`, and the schema stays at version 100. A second run of the
migration stops with the error
`workhorse.task_runtime_active_queue_shard_idx is invalid after an earlier failed build`. If a
peer migrator failed its build at the same time, the step stops with the error
`workhorse.task_runtime_active_queue_shard_idx is missing or invalid after its build`. The
`workhorse schema migrate` command reports only that the step failed part-way. To repair the
database:

1. Find the cause of the failure, for example a canceled statement or a full disk, and correct it.
2. Remove the invalid index:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS workhorse.task_runtime_active_queue_shard_idx;
   ```

3. Run `workhorse schema migrate` again.

[Non-transactional steps](schema-lifecycle.md#non-transactional-steps) states the general rule.

## Upgrade from 0.11.x to 0.12.0

0.12.0 shows the task group of a member task in the dashboard task detail. It also makes
the dashboard task estimate follow the current size of the task table. The upgrade is a rolling
deployment, and a mixed fleet is supported while it runs.

1. Run `workhorse schema migrate`. It applies migrations 0091 through 0092 and leaves the schema at
   version 91.
2. Roll out the new processes in any order.

A 0.11.0 database is at schema version 89. The migrations replace dashboard functions and change no
stored rows:

| Migration                                                      | Schema version | Changes                                                                       |
| -------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `0091-show-the-task-group-in-the-task-detail.sql`              | 90             | `dashboard_task_detail_v1` returns the task group of a member task            |
| `0092-scale-the-dashboard-task-estimate-by-the-table-size.sql` | 91             | `dashboard_task_estimate_v1` scales the stored task density by the table size |

Each of the two migrations does not raise the floor, so it stays 76. Migration 0091 replaces the body of
`dashboard_task_detail_v1`, and its document gains the key `group`. For a member task, `group` holds
the group ID, the position of the member, and the state of the group. For another task, it is null.
A dashboard host of every SDK version passes the document through, so it serves the key when the
migration commits. A dashboard of 0.12.0 on a schema below 90 gets no `group` key and
shows no group in the task detail.

Migration 0092 replaces `dashboard_task_estimate_v1`. Before it, the estimate was `reltuples` as the
last `ANALYZE` or `VACUUM` stored it. Thus, after a bulk enqueue, the sidebar counts and the Queues
page counted every task row exactly until autoanalyze ran. Now the estimate scales the stored rows
per page by the current number of pages, so both reads use their estimates at once. The migration
also replaces the body of `dashboard_task_counts_v1`, to change only a comment.

A 0.11 process keeps working on schema version 91, because a migration inside a major line only
adds. 0.12.0 freezes `sql/releases/0091.sql`.

## Upgrade from 0.10.x to 0.11.0

A 0.10.0 database is at schema version 86. Migrations 0088 through 0090 do not raise the SDK schema
floor. Thus the upgrade is a rolling deployment, and a mixed fleet is supported while it runs.

1. Run `workhorse schema migrate`. It applies migrations 0088 through 0090 and leaves the schema at
   version 89.
2. In the code and the configuration of each worker, remove the heartbeat opt-out. The table below
   gives its name in each SDK.
3. Give each worker a pool with a known size of at least 3.
4. Roll out the new processes in any order.

0.11.0 removes the heartbeat opt-out from every SDK. With the opt-out, heartbeat rounds borrowed
ordinary pool connections. A round could then wait behind claims and settlements, a lease could
expire, and a task could run twice. Now every worker reserves a dedicated heartbeat connection.
A worker needs 3 connections: the listener, the heartbeat connection, and one statement. The Rust
listener opens its connection outside the pool, so a Rust pool of 3 holds the heartbeat connection
and two statement connections. A worker on
a pool below 3, or on a pool of unknown size, fails at construction. Its error names the size that
it found, the size that it needs, and the next step. [ADR
0071](decisions/0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md) records the
decision.

| SDK        | Remove                                                                                                                                   | Give the worker                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| TypeScript | `sharedHeartbeats` from each `Worker` and `createWorker` call                                                                            | A node-postgres `Pool` with `max` of at least 3. An adapter takes it as the option `pool`. |
| Python     | `shared_heartbeats` from `Worker`, `AsyncWorker.from_psycopg`, and `AsyncWorker.from_asyncpg`                                            | A pool that reports a maximum size of at least 3.                                          |
| Go         | `WorkerOptions.SharedHeartbeats`                                                                                                         | A `*pgxpool.Pool` with `MaxConns` of at least 3.                                           |
| Rust       | `WorkerOptions::shared_heartbeats`                                                                                                       | A pool with a maximum size of at least 3.                                                  |
| Ruby       | `shared_heartbeats:` from `Worker.new`                                                                                                   | A pool that reports a `size` of at least 3.                                                |
| JVM        | `Worker.Builder.sharedHeartbeats(boolean)`, Kotlin `sharedHeartbeats`, and the Spring Boot property `workhorse.worker.shared-heartbeats` | A `DataSource` pool of at least 3. If you declare `poolMaxSize`, declare the real size.    |
| .NET       | `WorkerOptions.SharedHeartbeats` and the `Workhorse.Hosting` key `Workhorse:Worker:SharedHeartbeats`                                     | An `NpgsqlDataSource` with `Max Pool Size` of at least 3.                                  |

A JVM `DataSource` with no declared `poolMaxSize` reports no size. A .NET data source with
`Pooling=false` has no pool limit. In these two cases, the worker does not check a size at
construction. The readiness check at the start of each run is then the guard. The worker must
reserve the heartbeat connection and borrow one more connection within its startup budget. If it
cannot, the run throws `WorkhorseException` on the JVM or `WorkerStartupException` in .NET.

A caller that still gives the removed option gets a compile failure or an error that names the
removal. A `Queue` does not change: it still takes a connection or a transaction.

| Migration                                                                    | Schema version | Changes                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0088-count-only-prunable-rows-as-row-retention-lag.sql`                     | 87             | Row retention lag skips a member of an unfinished task group and counts from the finish of the group                                                                                               |
| `0089-settle-cancel-timeouts-and-bound-schedule-reads.sql`                   | 88             | Recovery skips a timed-out attempt that waits for its cancellation, the Schedules page reads a bounded number of occurrences, and the registry prune finds expired kept pauses through their index |
| `0090-settle-a-fast-tier-cancellation-at-its-deadline-after-its-timeout.sql` | 89             | Fast-tier recovery closes an attempt with a pending cancellation `canceled` when its deadline passed after its timeout                                                                             |

Migration 0088 does not raise the floor, so it stays 76. It replaces `queue_health_v1`. Its row
retention lag skips a member of a task group that has not finished, because terminal cleanup keeps
that row on purpose. The lag of a member also counts from the finish of its group. The health
document keeps its keys, and the migration changes no rows. Thus every process of every SDK version
gets the new result when the migration commits.

Migration 0089 does not raise the floor either. It replaces the bodies of `recover_expired_v1`,
`dashboard_cron_v1`, `prune_worker_registry_v1`, and `create_history_day_v1`, and it changes no
rows:

- The full-tier timeout scan skips an attempt with a pending cancellation while its deadline is
  ahead.
- `dashboard_cron_v1` reads at most 1,001 occurrences for each listed schedule and reports at most
  1,000. The new key `occurrenceCountCapped` is `true` above that count. A dashboard host of every
  SDK version passes the document through, so it serves the key when the migration commits.
- The registry prune deletes expired kept pauses through `worker_pause_tombstone_expires_idx`.
- The comment in `create_history_day_v1` states the real lock order of the history parents. Its
  statements do not change.

Migration 0090 does not raise the floor either. It replaces the body of `fast_recover_expired_v1`,
and it changes no rows. If a fast-tier attempt has a pending cancellation and its deadline passed,
recovery closes the task `canceled`, also when its attempt timeout is earlier than its deadline.
Before, recovery locked that row in each tick and settled nothing until the lease expired.

A 0.10 process keeps working on schema version 89, because a migration inside a major line only
adds. 0.11.0 freezes `sql/releases/0089.sql`.

## Upgrade from 0.9.x to 0.10.0

0.10.0 lets a producer throttle an enqueue into a fast-tier queue. Its dashboard hosts
read the retention preview through the new `dashboard_retention_preview_v1`. Its workers deregister
through the new `deregister_worker_v2`. Thus the schema floor rises. The upgrade is a rolling
deployment, and a mixed fleet is supported while it runs.

1. Run `workhorse schema migrate`. It applies migrations 0075 through 0087 and leaves the schema at
   version 86.
2. Roll out the new processes in any order.

A 0.9.0 database is at schema version 73. The migrations only add, or change behavior that was an
error:

| Migration                                                               | Schema version | Changes                                                                                                                          |
| ----------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `0075-allow-throttle-on-fast-tier-queues.sql`                           | 74             | `enqueue_throttle_v1` and `enqueue_many_v1` accept throttle on a fast-tier queue                                                 |
| `0076-add-the-dashboard-retention-preview-function.sql`                 | 75             | `dashboard_retention_preview_v1`, which returns the retention preview document                                                   |
| `0077-fence-the-worker-deregistration-by-instance.sql`                  | 76             | `deregister_worker_v2`, which deletes a registry row only for the instance of the caller                                         |
| `0078-copy-the-diagnostic-details-into-hint.sql`                        | 77             | Each P1001 to P1010 error also carries its DETAIL JSON in HINT                                                                   |
| `0079-bound-the-history-partition-lock-waits.sql`                       | 78             | Partition DDL waits at most 250 ms for each lock, and retention and partition preparation run last                               |
| `0080-compare-the-enqueue-fingerprint-instants-as-values.sql`           | 79             | An enqueue fingerprint compares `runAt` and `deadline` as instants, so a replay matches from any session time zone               |
| `0081-bound-the-dense-cron-evaluation.sql`                              | 80             | `cron_occurrences_v1` resolves only the wall-clock times near its window, and its results do not change                          |
| `0082-keep-the-operator-pause-after-a-registry-prune.sql`               | 81             | A registry prune keeps the operator pause of a paused instance, and the same instance gets it back                               |
| `0083-fire-skip-schedules-within-the-supported-delay.sql`               | 82             | A `skip` schedule fires each occurrence inside the supported delay and records the occurrences it skips                          |
| `0084-recheck-terminal-cleanup-references-and-continue-lease-scans.sql` | 83             | Terminal cleanup keeps a task that got a new reference during a batch, and a full expired-lease scan does not space the next one |
| `0085-make-the-day-and-schedule-lock-keys-unambiguous.sql`              | 84             | A history-day lock does not depend on the session DateStyle or time zone, and two schedules do not share an occurrence lock      |
| `0086-report-the-fast-tier-retry-of-an-expired-timeout.sql`             | 85             | A fast-tier attempt timeout that starts another attempt returns its retry state                                                  |
| `0087-show-the-last-schedule-skip-on-the-dashboard.sql`                 | 86             | The dashboard Schedules page shows the last skip of a `skip` schedule                                                            |

The SDK schema floor rises from 73 to 76. Every SDK statement catalogue names
`dashboard_retention_preview_v1`, which schema version 75 adds, and `deregister_worker_v2`, which
schema version 76 adds. Thus the migrations must run before the first new process starts. 0.10.0
freezes `sql/releases/0086.sql`.

If the schema is below version 76, the compatibility check refuses it. A new dashboard host refuses
its requests, and a new worker refuses to start. A new `Queue` or `Admin` refuses each call before
its first statement. The TypeScript SDK does this from 0.11.0. In 0.10.0, only
`assertSchemaCompatible` and a TypeScript `Worker.run` with a dedicated heartbeat connection
refuse.

Schema version 77 does not raise the floor. Migration 0078 changes only the HINT of the P1001 to
P1010 errors, and DETAIL does not change.

Schema version 78 does not raise the floor. Migration 0079 changes only the bodies of
`prepare_history_partitions_v1`, `retire_history_partitions_v1`, and `run_maintenance_v1`, and no
signature. Every process gets the
bounded partition lock waits when the migration commits.

Migration 0079 changes the row order of `run_maintenance_v1`. The set of phases does not change.
`history_partitions` and the retention phases now come after `worker_registry`, because the DDL
phases must run last so that their parent locks end when the call commits. No SDK reads the rows by
position, so this is a change of behavior and not a breaking change.

Schema version 79 does not raise the floor. Migration 0080 changes the bodies of `enqueue_batch_v1`
and `enqueue_debounce_v1`, and no signature. A replay that the earlier schema rejected only because
of the session time zone now returns the bound task. A fingerprint stored before the migration
still matches an exact replay. Every process gets the new comparison when the migration commits.

Schema version 80 does not raise the floor. Migration 0081 changes only the body of
`cron_occurrences_v1`, and no signature. The occurrences and their order do not change. Every
process gets the bounded evaluation when the migration commits.

Schema version 81 does not raise the floor. Migration 0082 adds the table `worker_pause_tombstone`.
It changes the bodies of `register_worker_v1`, `deregister_worker_v1`, `deregister_worker_v2`,
`set_worker_paused_internal_v1`, and `prune_worker_registry_v1`, and no signature. A worker of any
SDK version gets its kept pause back when it registers again, because the pause comes back in the
return value of `register_worker_v1`. A registration with a long `registry_interval_ms` now stays
for at least three intervals before maintenance prunes it.

Schema version 82 does not raise the floor. Migration 0083 adds the nullable columns
`last_skipped_at`, `last_skipped_count`, and `last_skipped_through` to `schedule_definition`. It
changes only the body of `fire_due_schedules_v2`, and no signature or result shape. A `skip`
schedule now fires each occurrence that is not older than the supported delay,
`GREATEST(60 seconds, 2 × evaluation_window_ms)`, and records the older occurrences it skips. Thus
after a delay inside the supported delay, a `skip` schedule fires occurrences that the earlier
schema skipped. The pass also tries each namespace lock before it reads occurrence history. Every
process of every SDK version gets the new behavior when the migration commits.

Schema version 83 does not raise the floor. Migration 0084 changes only the bodies of
`prune_full_terminal_tasks_internal_v1`, `recover_expired_v1`, and `tick_v1`, and no signature or
result shape. Terminal cleanup now rechecks the references of its locked rows in a second
statement. Thus at read committed, a task that got a dependency during a batch stays, and the rest
of the batch is deleted. The terminal_tasks phase no longer fails with SQLSTATE `23001` there.

A recovery scan that fills its share of the limit no longer spaces the next expired-lease scan.
Every process of every SDK version gets the new behavior when the migration commits.

Schema version 84 does not raise the floor. Migration 0085 changes the bodies of `fire_schedule_v1`,
`fire_due_schedules_v2`, `create_history_day_v1`, `retire_history_day_v1`,
`retire_history_partitions_v1`, and `prepare_history_partitions_v1`, and no signature or result
shape. A history-day lock now gives one day the same lock under every session DateStyle and time
zone. A history partition gets the name of its UTC day under every session time zone. Two schedules
whose namespace or name contains a colon no longer share an occurrence lock, so one no longer defers
the other.

Migration 0085 also renames a history partition that has the name of the wrong UTC day. Only a
calendar day that the session time zone skipped can produce such a name. Every process of every SDK
version gets the new locks when the migration commits.

Schema version 85 does not raise the floor. Migration 0086 changes the body of
`expire_owned_telemetry_v1`, and no signature or result shape. A fast-tier attempt timeout that
starts another attempt now returns `ready` or `scheduled` in `retry_state`, not null. Thus the
workers of all seven SDKs record the retry span and the retry count for it. A Go or Rust worker
from before SM-1734 does not read `retry_state`, so it records no retry telemetry for a timeout.
Every process of every SDK version gets the new result when the migration commits.

Schema version 86 does not raise the floor. Migration 0087 appends `last_skipped_at`,
`last_skipped_count`, and `last_skipped_through` to `dashboard_schedule_definition_v1`.
`dashboard_cron_v1` returns them as `lastSkippedAt`, `lastSkippedCount`, and `lastSkippedThrough`
on each application schedule. The view keeps its earlier columns, and the document only gains keys.
A dashboard host of every SDK version passes the document through, so it serves the keys when the
migration commits. A dashboard of this release on a schema below 86 gets no skip keys and shows no
skip.

A 0.9 process keeps working on schema version 86. Its dashboard host still sends its own retention
preview statement, which reads tables that the migrations do not change. Its worker still sends
`deregister_worker_v1`, which migration 0077 does not change. Every process gets the throttle
behavior when migration 0075 commits. On schema 73, a throttled enqueue into a fast-tier queue still
raises the fast-tier error with the feature `throttle`.

While the fleet is mixed, the deregistration fence stops only a late deregistration that a new
process sends. A 0.9 process and a new process can use the same worker ID. Then a late
`deregister_worker_v1` call of the 0.9 process can still delete the row of the new run. The fence
is complete when no 0.9 worker runs. Each SDK keeps its own guard for one release. The guard stops
a late statement of an earlier run in the same process from changing the row of a later run.

## Upgrade from 0.8.x to 0.9.0

0.9.0 renews leases through `heartbeat_many_v2`, which does not wait for a locked
task row ([ADR 0105](decisions/0105-skip-a-locked-row-in-a-heartbeat-and-report-the-lease-as-busy.md)).
It also adds `heartbeat_v2`, which renews one lease by the same rule. Its SDKs call the new
functions, so the schema floor rises. The upgrade is a rolling deployment, and a mixed fleet is
supported while it runs.

1. Run `workhorse schema migrate`. It applies migrations 0073 through 0074 and leaves the schema at
   version 73.
2. Roll out the new processes, producers too.

A 0.8.0 database is at schema version 71. The migrations only add:

| Migration                                             | Schema version | Adds                                                        |
| ----------------------------------------------------- | -------------- | ----------------------------------------------------------- |
| `0073-skip-a-locked-row-in-a-heartbeat.sql`           | 72             | `heartbeat_many_v2`, which reports a locked lease as `busy` |
| `0074-skip-a-locked-row-in-a-one-lease-heartbeat.sql` | 73             | `heartbeat_v2`, which reports a locked lease as `busy`      |

The SDK schema floor rises from 69 to 73. Every SDK statement catalogue names `heartbeat_many_v2`
and `heartbeat_v2`. The compatibility check of 0.9.0 refuses a schema below version 73. Thus the
migrations must run before the first new process starts. 0.9.0 freezes `sql/releases/0073.sql`.

A 0.8 process keeps working on schema version 73. It calls `heartbeat_many_v1` and `heartbeat_v1`,
which do not change, so it still waits for a locked row. A new worker calls `heartbeat_many_v2` and
does not wait. Both renew the same columns.

The TypeScript return type of the batched heartbeat surfaces gains `busy`, as
[`CHANGELOG.md`](../CHANGELOG.md) states. The new `Queue.tryHeartbeat` calls `heartbeat_v2`.
`Queue.heartbeat` and `Queue.heartbeatStatus` still call `heartbeat_v1` and wait for a locked row.

## Upgrade from 0.7.x to 0.8.0

0.8.0 adds task groups and the checkpoint input check. Its SDKs call new SQL functions, so the
schema floor rises. The upgrade is a rolling deployment, and a mixed fleet is supported while it
runs.

1. Run `workhorse schema migrate`. It applies migrations 0066 through 0072 and leaves the schema at
   version 71.
2. Roll out the 0.8.0 processes.

A 0.7.0 or 0.7.1 database is at schema version 64. The migrations only add:

| Migration                                                              | Schema version | Adds                                                                                                        |
| ---------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `0066-add-task-groups-with-completion-callbacks.sql`                   | 65             | The task group tables and functions that every SDK statement catalogue names                                |
| `0067-count-task-group-outcomes-in-counter-shards.sql`                 | 66             | Counter shards for task groups, and `dashboard_task_groups_v1`                                              |
| `0068-read-the-newest-task-group-events.sql`                           | 67             | `list_newest_task_group_events_v1`, for the task group detail of the dashboard                              |
| `0069-check-the-input-of-a-checkpoint-on-replay.sql`                   | 68             | `task_checkpoint.input_fingerprint` and `save_checkpoint_v2`                                                |
| `0070-fence-a-task-group-member-add-and-index-the-group-list.sql`      | 69             | A lease check for a member add in `add_task_group_members_v1`, and the index `task_group_state_created_idx` |
| `0071-lock-purged-runtime-rows-in-identity-order.sql`                  | 70             | A lock order for `purge_queue_internal_v1`: every runtime row, then every task row, each in identity order  |
| `0072-purge-a-queue-that-holds-a-prerequisite-of-a-live-dependent.sql` | 71             | A purge that cancels, not deletes, a task whose dependent outside the purge waits (ADR 0101)                |

Migration 0070 is the first non-transactional step. It builds `task_group_state_created_idx` with
`CREATE INDEX CONCURRENTLY`, so the build does not block writes to `task_group`. If the step fails
part-way, the earlier statements stay applied and the schema stays at version 68. A failed build
can leave an invalid index, and the rerun then skips the build. Before you run the step again, do
these steps:

1. Drop the invalid index:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS workhorse.task_group_state_created_idx;
   ```

2. Run `workhorse schema migrate` again.

[Non-transactional steps](schema-lifecycle.md#non-transactional-steps) gives the query that lists
every invalid Workhorse index.

The SDK schema floor rises from 54 to 69. Every SDK statement catalogue names `save_checkpoint_v2`,
which schema version 68 adds. Schema version 69 also fences a member add: on an earlier schema, a
worker whose lease expired can still add tasks to the group of its member task. The compatibility
check of 0.8.0 refuses a schema below version 69. Thus the migration must run before the first
0.8.0 process starts.

Schema versions 70 and 71 do not raise the floor, so it stays 69. Migration 0071 changes only the
lock order of a queue purge. Migration 0072 changes what a purge does with a task that a dependent
outside the purge waits for: the purge cancels that task instead of a delete, and the purge count
includes it. No SDK statement and no result shape changes, and no SDK reads the difference between
a deleted and a canceled task in the purge result. Every process uses the new purge when the
migration commits, so a higher floor only refuses schema 69 or 70 and adds no protection. On
schema 69 or 70, such a purge still fails with `23001`.

A 0.7 process keeps working on schema version 71, because a migration inside a major line only
adds. Thus old and new processes can run together during the rollout:

- A 0.7 worker can run a member task. PostgreSQL counts the outcome of a member task in a trigger
  on `task_outcome`, so the group counts do not depend on the SDK version.
- A 0.7 process cannot create a task group, and its handlers cannot read or add to a group.
- A 0.7 worker saves a checkpoint through `save_checkpoint_v1`. That function calls
  `save_checkpoint_v2` with no input fingerprint, so its results do not change.

A checkpoint that Workhorse saved before the upgrade has no input fingerprint. A checkpoint that a
0.7 worker saves during the rollout also has none. If the stored checkpoint has no fingerprint,
Workhorse does not check the input. The replay returns the stored value, even when the handler now
gives an input. A 0.7 worker does not compare fingerprints at all. Thus the check applies only to
checkpoints that a 0.8.0 worker saves with an input, and only when a 0.8.0 worker replays them.

0.8.0 also changes two TypeScript behaviors. `Worker.runOnce()` returns `false` after a pass that
only released tasks, and a child request with no queue goes to the queue of its parent task.
[`CHANGELOG.md`](../CHANGELOG.md) gives the details of each change.
