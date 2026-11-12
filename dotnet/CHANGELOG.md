# .NET changelog

The versions and release notes of the four .NET packages live here: `Workhorse`,
`Workhorse.Hosting`, `Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`. The four packages
always carry one version. It is the version that the other SDKs carry, because every release tag
names one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## Unreleased

### Debounce and enqueue decide with the clock after their locks

Migration 0093 (`0093-decide-debounce-with-one-clock-and-keep-pending-debounce-keys.sql`) moves the
schema to version 92. A debounce request that waits for a lock past its window no longer writes a
second task, and it no longer deadlocks with run-now or a queue purge of its task. Maintenance keeps
the key of a pending debounced task, so a late request on a paused queue gets
`window_elapsed_pending`. An enqueue batch reads its timestamp after its locks. The migration does
not raise the SDK compatibility floor.

### Each failure in the shutdown unwind window releases its task

A .NET worker stops, and at the end of the shutdown grace it sets `CancelReason.Shutdown` and
cancels the token of a handler. Before, only an `OperationCanceledException` of that token or a
`CancelledException` with `CancelReason.Shutdown` returned the task to its queue. Each other
exception, and each result that the task could not store, failed the attempt through `fail_v1`.
Now the cancellation decides, not the type of the exception. The worker reads the reason when the
handler returns, and a batch member reads it when the batch handler returns. If the reason is
`CancelReason.Shutdown` then, each exception releases the task through `release_owned_v1`. A
result that cannot be stored also releases it (SM-1933, ADR 0117). A handler that fails before the
cancellation keeps its usual settlement.

### Queue purge, tier read, queue name, and claim lease use their locks

Migration 0094 (`0094-purge-locked-tasks-lock-stale-tiers-and-start-leases-after-locks.sql`) moves
the schema to version 93. A queue purge removes only the tasks that it locked, so a task that a
producer commits during the purge stays and its worker can complete it. An enqueue at repeatable
read or serializable fails with SQLSTATE `40001` after a newer tier change, and a tier change
outside read committed fails with SQLSTATE `0A000`. An enqueue to a queue name above 256 UTF-8
bytes now fails, and schedule synchronization refuses such a name. A stored schedule with such a
name no longer fires. A claim computes its lease from a clock sample taken after
its row locks. The migration does not raise the SDK compatibility floor.

### A failed expiry request keeps the handler running

A task reached its deadline or its execution timeout, and the .NET worker asked PostgreSQL to
expire the attempt. If that request failed, for example during a failover, the worker cancelled the
handler, wrote nothing for the attempt, and ended its run with the error. Now a failed request does
not confirm the expiry. The worker logs `workhorse.worker.expiration_request_failed` at warning
level, keeps the handler running, and asks again with the backoff that it uses for `not_due`. The
lease watchdog still ends an attempt that nobody renews (SM-1934).

### One failed schedule no longer stops the schedule pass

Migration 0095 (`0095-isolate-each-schedule-in-a-pass-and-match-two-wildcard-day-fields.sql`) moves
the schema to version 94. Before it, one schedule whose fire failed in the enqueue rolled back the
schedule pass of every offered namespace, and the worker run ended. Now each schedule runs in a subtransaction. A
failed schedule keeps its position and stores its error in `last_error_at`, `last_error_code`, and
`last_error_message` of `schedule_definition`. The other schedules fire, and a later pass that fires
the schedule clears the error. An error of SQLSTATE class `40` or `57` still fails the whole pass.
Schedule synchronization refuses an enabled schedule with a concurrency key on a fast-tier queue,
with SQLSTATE `P1007`. The dashboard schedule read returns `lastErrorAt`, `lastErrorCode`, and
`lastErrorMessage`. A cron expression with `?` in day-of-week and a wildcard day-of-month now
matches each day. The migration does not raise the SDK compatibility floor (SM-1927, SM-1947,
ADR 0118).

### Cold export waits for the transactions that can still write into a day

A history row gets its time when it is written, but other sessions see it only after its
transaction commits. Cold export gave out a day when the day had ended and the statistics rollup
had passed it. If a transaction wrote into the day and committed later, its row was in no export
object, and history retention later deleted it. `claim_cold_export_segment_v1` now waits for a
snapshot frontier. At least 60 s after the end of the day, the claim records a new transaction ID
in the new `cold_export_dataset` columns `frontier_day_end` and `frontier_xid`. It gives out the
day only after each transaction older than that ID has ended. A long write transaction in any
database of the server delays the export of a day until it ends. An exporter calls the claim in a transaction of its own. It
reads all pages of a day in one `REPEATABLE READ` transaction that starts after the claim. A re-lease passes the same frontier. The migration fences each segment that is exporting.
A completion from before the migration then fails, and the day is given out again. `send_signal_v1` and `complete_human_wait_v1`, when no wait exists, and
`record_batch_event_v1` take their transaction ID before they write their event (SM-1928,
ADR 0121).

After a stop of the statistics rollup of more than two days, each catch-up pass deleted some
minute buckets that it had just written. The hour and day tiers lost those counts. Statistics retention now keeps each minute bucket and each hour bucket until no later pass
rebuilds a coarser tier from it (SM-1978). A history retention pass that the rollup or the
export held back recorded `succeeded` and waited for the next local date. It now records
`incomplete` and runs again on the next offer (SM-1979). The statistics guide states that the
rollup does not count a history row whose transaction commits after the recompute window passed
its minute (SM-1959).

Migration 0096 (`0096-export-a-day-after-its-snapshot-frontier-and-keep-held-retention-due.sql`)
moves the schema to version 95. It adds the two nullable columns and
`cold_export_frontier_margin_ms_v1`, and replaces the bodies of `claim_cold_export_segment_v1`,
`send_signal_v1`, `complete_human_wait_v1`, `record_batch_event_v1`, `rollup_stats_v1`, and
`retain_history_v1`. It does not raise the SDK compatibility floor and changes only the exporting
rows of `cold_export_segment`. Run `workhorse schema migrate`.

### The EF Core documents show the execution strategy form

A context with `EnableRetryOnFailure()` refuses a transaction that the application begins outside
its execution strategy, so the first `SaveChangesAsync` in that transaction throws
`InvalidOperationException` before any Workhorse call. `dotnet/README.md` and the transactional enqueue guide now show the
`CreateExecutionStrategy().ExecuteAsync(...)` form, and an example test runs it (SM-1986). They also
state that `GetWorkhorseConnection()` on an open connection with no transaction runs the enqueue in
autocommit (SM-1971).

### The embedded dashboard bounds each read and drops undeclared input keys

An operator opened an events page with a wide range, a search string, and an exact count. The read
ran with no time bound and held one connection of the data source. Now `MapWorkhorseDashboard` runs
each read in its own read-only transaction with a transaction-local `statement_timeout`. The
default is 15 seconds, and the new `DashboardOptions.StatementTimeout` changes it. A read that
PostgreSQL cancels answers the `TIMEOUT` RPC error with status 408. Keep the `CommandTimeout` of
the data source above the bound, because a shorter client limit stops the read first. The backend
also drops each
input key that the `dashboard/v1` contract does not declare, as the TypeScript host does (SM-1966,
SM-2000).

### Terminal cleanup and queue health use one retention rule

Terminal cleanup locked the oldest finished tasks, up to four times its limit, and only then removed
each task that a schedule occurrence, an enqueue key, a dependency edge, or a young child keeps.
When such tasks filled that window, each pass deleted nothing. Cleanup now locks only the tasks that
it can delete, so a kept task no longer stops the deletion of other tasks (SM-1935). Each batch
examines one slice of four times its share of the limit, at least 1,000 and at most 100,000 rows,
after a position that the new table `terminal_prune_position` stores. A second walk takes the batch after each batch that deleted tasks, and it
reaches the tasks behind that position. Thus many kept tasks do not make a batch
read more, and cleanup no longer deletes in strict age order. When a batch deletes the
last target of a redrive source and has room left, it deletes that source in the same batch,
and it continues down a redrive chain while it has room.
`retentionPruneStarved` still reports a pass that a dependency edge stops.

Queue health counted a task as `retention-lag` although cleanup keeps it on purpose. Such a task is
a redrive source with a target, a prerequisite of a live dependent, or a parent of a child that is
not yet eligible. It can also be a task of an unexpired schedule occurrence or enqueue key. Health
now skips these tasks, and the lag of such a task counts from the end of its hold. Health still
counts a task that a runtime row, a history row, or an expired occurrence keeps, because cleanup is
then late (SM-1852). When cleanup deletes an expired key or an edge to a finished dependent, it records the end of
that hold in the new column `task_outcome.held_until`, so health counts the task from it. If
another transaction holds the outcome of the task, the key or edge stays for a later pass. An
enqueue that reuses an expired key, the occurrence cleanup, a cleanup batch that deletes a
child, a dependent, or a redrive target, a queue purge, and the deletion of a finished task group
save the end of the hold in the same way. Health adds no reason for an old unfinished task group.

Each health poll read every task and every terminal outcome when no row was past its windows,
because the cutoffs read a volatile clock. A held history watermark and the members of finished task
groups also made the read grow. Health now reads the clock one time for its retention cutoffs. Each
retention walk stops at its cutoff, at the watermark, at the first row that cannot be due earlier,
and after 1,000 rows. Behind more kept rows than that, row lag is null, and
`terminal-cleanup-backlog` reports a late cleanup (SM-1936, SM-1990).

Each retention window of N days is now N times 24 hours. Before, PostgreSQL stepped calendar days in
the session TimeZone, so across a daylight-saving change cleanup and the lag moved by one hour. In a
UTC session nothing changes (ADR 0122).

**Accept the new `maintenance-failing` and `schedule-failing` health reasons.** Queue health reports
`maintenance-failing`, with a `routine` field, when three recorded runs of a maintenance routine
failed one after another after its last completion. It reports `schedule-failing` when an
enabled schedule stored an error in its last schedule pass. Both are degraded. Code that switches on
reason codes should accept them. A dashboard package older than this schema does not show the two
new reasons on its System page (SM-1992).

Migration 0097 (`0097-give-cleanup-and-health-one-retention-rule-in-fixed-hours.sql`) moves the
schema to version 96. It adds the table `terminal_prune_position`, the nullable column
`task_outcome.held_until`, and thirteen internal functions, and it
replaces the bodies of `queue_health_v1`, `evaluate_queue_health_v1`,
`prune_full_terminal_tasks_internal_v1`, `prune_fast_terminal_tasks_internal_v1`,
`prune_terminal_storage_v1`, `prune_released_dependencies_v1`, `retain_history_v1`,
`sync_retention_policy_v1`, `override_retention_policy_v1`, `prune_enqueue_idempotency_v1`,
`rollup_stats_v1`, `dashboard_retention_preview_v1`,
`enqueue_batch_v1`, `purge_queue_internal_v1`, `prune_schedule_occurrences_v1`, and
`maintain_task_groups_v1`. It rewrites no row and does not raise the
SDK compatibility floor. Run `workhorse schema migrate`.

### Three replay answers move to new function versions, and the floor rises to 97

A Python, Go, or Rust worker parked a task until an absolute time with digits below the
millisecond. A TypeScript, Ruby, JVM, or .NET worker replayed the same instant at milliseconds, and
`schedule_wait_v1` answered `conflict`, so the task failed with no retry. The worker now calls
`schedule_wait_v2`, which compares the stored target and the sent target at millisecond precision
and stores the target as sent. A different millisecond still answers `conflict`. The .NET
SDK sends a `DateTimeOffset` cut to milliseconds (SM-1945).

A signal to a task that failed, completed, or was canceled before it declared the wait answered
`not_waiting` and recorded a `signal_rejected` event each time. A sender that tried again had no
end condition, and the events kept the task out of terminal cleanup. The SDK now calls
`send_signal_v2`. For a terminal task with no wait of that name, it answers `stale` and records no
event. A live task that has not reached the wait still answers `not_waiting` (SM-1946).

A task holds one child set. A handler that asked for a second set got `ConflictException`, which says
that the handler code changed. The SDK now calls `create_children_v2`, which answers
`limit_exceeded` for a second set in the activation that created or joined the first set. The SDK
raises `LimitExceededException`, and the worker still fails the task with no retry. A second, different `RunChildrenAsync` call in one activation threw `ConflictException` before any statement. It now throws the same limit error. A changed set
from another activation still raises the conflict error. The other child limit refusals now end the task too, as
a later entry states (SM-1956).

A group callback that failed to enqueue at the finish left only a `callback_failed` event. The
group snapshot now shows the failure on that callback. `TaskGroupCallback` gains `Failure`, a nullable `TaskGroupCallbackFailure` with `Code`, `Message`, and `FailedAt`. Retention deletes this
record with the group (SM-1955, ADR 0095).

Migration 0098 (`0098-compare-wait-targets-in-milliseconds-and-report-second-child-sets.sql`)
moves the schema to version 97. It adds `schedule_wait_v2`, `send_signal_v2`, and
`create_children_v2`, and replaces the body of `get_task_group_v1`. The `_v1` functions keep their
answers. The SDK floor rises from 76 to 97, so run `workhorse schema migrate` before the first
process of this release starts.

### The dashboard keeps the audit of each settings change

An operator decreased `taskEventRetentionDays` on the Settings page and gave a reason. The next
retention pass deleted the older history, and no table named the operator or the reason.
`MapWorkhorseDashboard` now calls `override_retention_policy_v2`, `revert_retention_policy_v2`,
`override_maintenance_policy_v2`, or `revert_maintenance_policy_v2`. Each records the authenticated
actor, the reason, a preview and a digest of the request ID, and the time for each changed setting
in the new nullable `operator_audit` column of `retention_policy` or `maintenance_policy`. The
`settings` read shows it as `lastChanges.<setting>` of each policy, and the Settings page shows who made
the last change and why. A revert keeps its own entry. `override_*_policy_v1`, `revert_*_policy_v1`,
and each `sync_*_policy_v1` remove the entries of the settings whose value they change, so a setting
never names an actor who did not set its value (SM-1996).

### The dashboard can withhold error stacks and opens each derived record

`DashboardOptions.RedactErrorStacks` of `MapWorkhorseDashboard` removes the stack of each worker error from task detail, the event feed, and event
detail, also from `details.error` of a `failed` or `retry_scheduled` event. It is off by default.
`dashboard_task_detail_v1`, `dashboard_events_v1`, and `dashboard_event_detail_v1` do the
redaction from the `redactErrorStacks` input key. The host sets the key after it drops the
undeclared input keys, so a request cannot turn the redaction off, and the event search does not
match a withheld stack (SM-1968).

A record that the dashboard derives for a fast-tier task has an MD5 identity, and event detail
refused almost each one with an input validation error. `eventDetail` now accepts any UUID in
canonical form, and `dashboard_event_detail_v1` finds the derived record (SM-1999). The comment
and the architecture page state that a `tasks` request with no tag, queue, or task type reads each
task (SM-1961).

Migration 0099 (`0099-keep-the-settings-audit-withhold-error-stacks-and-find-derived-records.sql`)
moves the schema to version 98. It adds the two nullable columns, the four audited functions, and
three helper functions, and replaces the bodies of the six released policy writers and of five
dashboard functions. It changes no rows. The dashboard host calls the audited functions, so the
SDK compatibility floor rises from 97 to 98. Run `workhorse schema migrate` before the new
processes start.

### An oversized checkpoint value fails the task without a retry

A checkpoint value above 1,048,576 bytes of jsonb text made PostgreSQL raise a plain exception, and
the worker retried the task. The operation of the checkpoint runs before the save. Thus each retry ran
the operation again, with its effects, and no attempt could store the value. The worker now calls
`save_checkpoint_v3`, which answers `value_too_large` and stores nothing. The error
`CheckpointValueSizeLimitException` gives the checkpoint name, the measured bytes, and the limit. The worker fails the
task at once, also when the handler wraps the error. Correct the handler, and then redrive the task. The
limit counts the jsonb text, which has a space after each `,` and `:`, so only PostgreSQL measures it
(SM-1982).

### A failure envelope has a size limit

A handler error with a very large message, such as a full response body, was stored as it came, and
a retry wrote it three times. The worker now cuts the `name`, the `message`, and the `stack` of the
failure envelope to 1,024, 16,384, and 65,536 UTF-8 bytes. Each cut is at a character boundary.
When the worker cuts a field, it adds `"truncated": true`. It sends the envelope to the new `fail_v2`, which applies
the same cut. Thus a client that does not cut cannot store a longer field (SM-1983). Migration 0100
adds these functions, and the schema floor rises to 99. `fail_v1`, `fast_fail_v1`, and
`save_checkpoint_v2` keep their answers.

### Each child limit refusal ends the task

A handler replays the same child calls on each attempt, so a child limit refusal came again on each
retry. Each retry also ran again the work that no checkpoint holds, until `maxAttempts`. The worker
now fails the task at the first attempt with no retry, and keeps the current attempt. This applies
to a second single child, a single child after a child set, a set of more than 100 children, and a
child join whose results are larger than the result limit of the task. A second child set already
ended the task. The error is `LimitExceededException` with the operation `runChild` or `runChildren`, or `ChildResultLimitExceededException` for a join that is too large, and the failure
envelope records the name of the exception. The worker finds the error also when the handler wraps it. If a
handler relied on a retry after such a refusal, correct its calls, and then redrive the task
(SM-2025).

### The expired-lease scan runs at most once in 500 ms

`tick_v1` ran the expired-lease scan of the full tier when no tick ran it within half the shortest
maintenance interval of the live registered workers. The scan reads every active lease. Thus one
worker with a `WorkerOptions.MaintenanceInterval` of 100 ms made the fleet scan every 50 ms. Its
ticks held the tick lock for almost all the time, and the ticks of the other workers skipped
(SM-1960). The gate interval now has a floor of 1,000 ms, the default interval, so the scan runs at
most once in 500 ms while a live worker is registered. If you set an interval below 1,000 ms to find
expired leases sooner, the full tier now finds an expired lease up to 500 ms plus that interval
after it expires. A short interval still makes that worker tick, promote, and recover deadlines,
attempt timeouts, and fast-tier leases at its own rate. A fleet at the default interval or above
scans as before.

### A capacity release counts one admission shard through an index

When an active task left a queue with a concurrency policy, the release trigger counted the active
leases of its admission shard with a filter that no index served. It thus read almost every active
lease of the queue (SM-1991). The count now reads only the leases of that shard through the new
index `task_runtime_active_queue_shard_idx`, and it gives the same answers. Migration 0101 changes
the two function bodies, and migration 0102 builds the index with `CREATE INDEX CONCURRENTLY`,
outside a transaction. The build does not block writes, but its time grows with the size of
`task_runtime`. Each claim on the full tier writes one more index entry, also on a queue with no
concurrency policy. In return, a release on a queue with a policy reads the leases of one shard, not
of the whole queue. A heartbeat stays a HOT update. The schema moves to version 101, and the floor
stays 99. If the build fails, drop the invalid index with `DROP INDEX CONCURRENTLY IF EXISTS
workhorse.task_runtime_active_queue_shard_idx` and run `workhorse schema migrate` again.

### Breaking: configuration cannot set the JSON options

An operator set `Workhorse:Worker:Json:WriteIndented=true` in `appsettings.json`. The binder then
created a `JsonSerializerOptions` with the general defaults, and the worker used it in place of the
Web defaults. Thus a payload property `OrderId` was stored as `OrderId`, not `orderId`, and reads
became case-sensitive. Now the options bind only the keys that `ConfigurationKeys.json` lists.
`AddWorkhorse` throws `InvalidOperationException` for a `Json` section under `Workhorse:Queue` or
`Workhorse:Worker`. The message names the section and says to set the JSON options in code. A
`RetryDelay` or `LoggerFactory` section with a child key still fails when the worker options are
first read, as before, but now with the same message. Such a key with no child key stays accepted,
and so does a key that names no option. The queue options still follow a reload of their
listed keys, and a reload never sets `Json`. The `Json` properties do not change. To upgrade,
remove the section, and set the option in code:
`services.Configure<WorkerOptions>(options => options.Json = ...)`, or register a `Queue` with
`new QueueOptions { Json = ... }` before `AddWorkhorse` (SM-2041).

### The dashboard answers a canceled authorizer with 500

If the `Authorize` callback of the dashboard throws `OperationCanceledException` or
`TaskCanceledException` and the client did not cancel the request, the backend now logs the
exception and answers 500 with `{"error":"Internal Server Error"}`. This is the answer for each
other exception of the callback. If the client cancels the request, the backend ends the request
with no answer, as before (SM-2042).

An `ArgumentException` that a driver or a library throws in a built-in dashboard procedure now gets
500 `INTERNAL_SERVER_ERROR` with the message `Internal server error`, and the backend logs it. An
`ArgumentException` that Workhorse throws keeps its 400 `BAD_REQUEST` answer and its message
(SM-2043).

### An enqueue call takes its locks in one order

Migration 0103 (`0103-take-enqueue-locks-in-key-tier-row-order.sql`) moves the schema to version 102. A batch that replaces a debounced task and names a dependent of that task as a prerequisite no
longer deadlocks with a cancel or a rejecting completion of the task. At repeatable read or
serializable, a group cancel and a keyed group add no longer deadlock with a purge or an enqueue
that creates the same `queue_control` row. A few cases can still end one transaction with `40P01`,
as the root changelog states, and that transaction can run again. At repeatable read, a group cancel
and the completion of the last member of the group can now end one transaction with `40P01`, where
the cancel failed with `40001` before. A read committed enqueue takes no new lock. The migration
does not raise the SDK compatibility floor.

### The embedded dashboard shows a group callback that failed to enqueue

A finished group that failed to enqueue a callback showed that callback with no task and no
reason. The `taskGroupDetail` and `cancelTaskGroup` answers now add `failure` to such a callback,
with `code`, `message`, and `failedAt`. The key is optional and new in `dashboard/v1`, an additive
change. The group list does not carry it. A schema below version 97 returns no `failure`. The group
detail page shows the failure as text (SM-2027).

### Queue health keeps the end of each hold, also on the fast tier

An enqueue that reuses an expired key, and a queue purge, never wait for the outcome of the old
task. When another transaction held that outcome, they dropped the end of the hold, and health
counted the old task from its windows (SM-2022). A fast-tier task had the same result after the key
phase deleted its expired key, because `fast_task_outcome` has no `held_until` (SM-2024). Each such
end now goes to the new table `terminal_hold_end`, whose insert takes no row lock, and health counts
the task from it. The cold export rows of `fast_task_outcome` do not change.

### A health poll does not read the same held rows again, and a stalled cleanup is reported

Behind more than 1,000 rows that a hold keeps on purpose, each health poll read those rows again
(SM-2021). A poll now stores where they end, and the next poll starts there while none of them can
become eligible. A poll writes only at read committed in a writable transaction, and it waits for no lock. The new degraded
reason `terminal-cleanup-stalled` reports terminal cleanup that did not complete a pass for longer
than `row_retention_lag_ms` plus `terminal_cleanup_interval_ms` while finished tasks exist (SM-2019).
Before a first completion, it waits until a finished task is past both row windows. Code that switches on reason codes should accept it.

### Terminal cleanup tests each array of its hold code once

The hold code of terminal cleanup and the queue purge tested batch membership with
`NOT x = ANY(array)`, which a generic plan evaluates once for each row (SM-2023). Each such test now
takes one sort or one hash over the batch, and the results do not change. Migration 0104 moves the
schema to version 103. It adds two tables, rewrites no row, and does not raise the floor. Run
`workhorse schema migrate`.

### Event detail reads only the history of its task

The dashboard derives the history records of a fast-tier task, and no index
holds their identities. Thus `dashboard_event_detail_v1` read each row of `fast_task_runtime` and
`fast_task_outcome` to find one record (SM-2029). The page now sends the task of the record as the new optional
`taskId` key of `eventDetail`, and the embedded dashboard accepts it and passes it to
`dashboard_event_detail_v1`. The function then reads only the history rows of that task, and a
record of another task returns `NOT_FOUND`. A request without `taskId` gets the same answer as
before. The host works on schema version 103 and earlier, which ignore the key. Migration 0105 moves the
schema to version 104, and the floor stays 99.

### Two worker warnings name the worker and the outcome

The `workhorse.worker.expiration_request_failed` warning now names the values `WorkerId` and
`ErrorType` in its log template, next to `TaskId` and the exception (SM-2013). The
`workhorse.handler.signal_swallowed` warning now names `WorkerId` and `HandlerOutcome`, which is
`suspended` (SM-2016). An alert can then match the worker and the kind of the failure, as the
other SDKs carry `workhorse.worker.id`, `error.type`, and `workhorse.handler.outcome`.

### A wrapped enqueue error does not make the EF Core strategy run the block again

The EF Core retrying execution strategy runs a block again only for an exception that it classifies
as transient. It reads the `InnerException` of a `DbUpdateException` only. The caller form of `Queue` throws
`DatabaseException` for a driver error, with the `NpgsqlException` as `InnerException`. Thus a
transient failure during `EnqueueAsync` does not make the strategy run the block again. The README,
the enqueue guide, and the architecture page now state this limit, and a test checks it (SM-2014).

## 0.12.0 — 2026-11-07

The npm packages, Python distribution, Go module, Rust crate, Ruby gem, JVM artifacts, and .NET
packages release from one source commit.

Requires **schema v76**, .NET **10** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** Run `workhorse schema migrate` before any
process of this release starts, producers too. Migrations 0091 and 0092 move the schema from
version 89 to version **91**. They replace function bodies and change no stored rows. The SDK
compatibility floor stays at **76**. A 0.11 process keeps working on version 91, because a
migration inside a major line only adds.

### A full-tier queue no longer makes PostgreSQL log an error at each tier probe

Before a tier probe, the worker now reads the tier of the queue from `queue_control` with one
`SELECT`. It sends the fast claim only to a fast-tier queue. Before, PostgreSQL rejected the probe
of each full-tier queue every 30 seconds and wrote that error to its log. A tier change still
reaches a running worker within 30 seconds. The change needs no migration and does not change the
SDK compatibility floor.

### The dashboard task detail shows the task group of a member task

Migration 0091 (`0091-show-the-task-group-in-the-task-detail.sql`) moves the schema to version 90.
The `dashboard/v1` task detail document gains `group`, with the group ID, the member position, and
the group state of a member task, an additive change. The migration does not raise the SDK
compatibility floor.

### The dashboard task estimate follows the current size of the task table

Migration 0092 (`0092-scale-the-dashboard-task-estimate-by-the-table-size.sql`) moves the schema to
version 91. `dashboard_task_estimate_v1` now scales the stored rows per page of the task table by
its current number of pages. After a bulk enqueue, the dashboard sidebar counts and the Queues page
use their estimates before autoanalyze runs. The migration does not raise the SDK compatibility
floor.

## 0.11.0 — 2026-10-28

The npm packages, Python distribution, Go module, Rust crate, Ruby gem, JVM artifacts, and .NET
packages release from one source commit.

Requires **schema v76**, .NET **10** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** Run `workhorse schema migrate` before any
process of this release starts, producers too. Migrations 0088, 0089, and 0090 move the schema
from version 86 to version **89**. They replace function bodies and change no stored rows. The SDK
compatibility floor stays at **76**. A 0.10 process keeps working on version 89, because a
migration inside a major line only adds.

**Give each worker a pool with at least 3 connections, and remove the heartbeat opt-out.** A worker
needs the listener, the heartbeat connection, and one connection for statements. Remove every
assignment of `WorkerOptions.SharedHeartbeats` and the configuration key
`Workhorse:Worker:SharedHeartbeats`. If the connection string sets `Max Pool Size`, set it to at
least 3. See "The heartbeat opt-out is removed".

### Breaking changes

- The heartbeat opt-out is removed (SM-1902). `WorkerOptions.SharedHeartbeats` and the
  `Workhorse.Hosting` configuration key `Workhorse:Worker:SharedHeartbeats` no longer exist. Every
  worker uses the dedicated heartbeat connection. See "The heartbeat opt-out is removed".

### Behavior changes

These changes can make code that worked on 0.10 act differently:

1. `TimeSpan.Zero` still selects the default idempotency TTL. The queue now throws
   `ArgumentException` for a nonzero TTL that rounds to 0 ms (SM-1857). See "An idempotency
   TTL that rounds to 0 ms is refused".
2. The TypeScript `Queue`, `Admin`, and `Worker.runOnce()` now check the schema before their first
   statement (SM-1864). This SDK already did, so it does not change.
3. After a lease lapses while a handler runs, a stale failure or release now settles a due
   deadline or attempt timeout at once. The worker reports `deadline_exceeded` or `timeout`, not
   `lease_lost` (SM-1884). See "A stale failure or release after a lapsed lease settles its
   cause".
4. Every SDK removes the heartbeat opt-out (SM-1899, SM-1901, SM-1902). In this SDK, code that
   sets `WorkerOptions.SharedHeartbeats` no longer compiles, and the `Worker` constructor throws
   `ArgumentException` for a `Max Pool Size` below 3. With `Pooling=false`, a run on a pool that is
   too small throws `WorkerStartupException` at its readiness check. See "The heartbeat opt-out is
   removed".

### The heartbeat opt-out is removed

ADR 0071 gives each worker a dedicated heartbeat connection, and it kept an opt-out for small pools.
Under the opt-out, each heartbeat round opened its own connection. A round could then wait behind
claims and settlements for a pool connection, a lease could expire, and a task could run twice.

**Example.** A worker runs on a data source with `Max Pool Size=2` and `SharedHeartbeats = true`.

1. Before 0.11.0, the worker starts and polls, and each heartbeat round opens a connection.
2. In 0.11.0, the code does not compile, because `WorkerOptions.SharedHeartbeats` no longer exists.
3. After the assignment is removed, the `Worker` constructor throws `ArgumentException`. The message
   names `Max Pool Size=2`, the size of 3 that the worker needs, and the next step.

With `Pooling=false`, Npgsql has no pool and no client-side limit, so the worker does not check a
size when it is built. The readiness check at the start of each run is then the guard. Within the
larger of the heartbeat interval and 5 s, the worker reserves the heartbeat connection, starts the
listener, and opens one more connection. If a step fails, the run throws `WorkerStartupException`,
and the worker does not start.

`Workhorse.Hosting` refuses the key `Workhorse:Worker:SharedHeartbeats` with each value. Binding
`WorkerOptions` throws an `InvalidOperationException` that names the removal and the next step.

### Row retention lag skips a member of an unfinished task group

Terminal cleanup keeps each member of a task group that has not finished, because the group needs
its member outcomes when it finishes. Before this change, queue health counted such a member as row
retention lag after it passed its windows (SM-1851). An open or sealed group can stay unfinished for
any length of time. Thus health reported "Retention cleanup is late for task records, finished
results", and the lag grew without end. The public demo keeps one open and one sealed group on
purpose, so its Health page showed the report every day.

Migration 0088 (`0088-count-only-prunable-rows-as-row-retention-lag.sql`) moves the schema to
version 87. Now `queue_health_v1` skips a member of an unfinished group when it measures task
identity and terminal outcome lag. For a group member, lag counts from the latest of window
expiry, history release, and group finish. The health document keeps its keys, and the schema floor
does not change.
Every process of every SDK version gets the new result when the migration commits.

### A stale failure or release after a lapsed lease settles its cause

A lease can lapse while a handler runs, with no change to the fence. Then `fail_v1` and
`release_owned_v1` answer `stale`, but `expire_owned_v1` can still settle a due deadline or attempt
timeout under that fence. Before this change, the worker settled nothing, and lease recovery
settled the task later (SM-1884).

Now the worker calls `expire_owned_v1` at once and settles the due boundary, as the Go and Rust
workers do:

- After a lapsed lease with a due deadline, the handler outcome was `lease_lost`. Now it is
  `deadline_exceeded`, and the task fails at once.
- After a lapsed lease with a due attempt timeout, the handler outcome was `lease_lost`. Now it is
  `timeout`, and PostgreSQL applies the retry policy at once.
- After a lapsed lease with no due boundary, the outcome stays `lease_lost`.

The handler span records `deadline_exceeded` or `timeout_exceeded`. Before this change, it
recorded `stale`.

If `fail_v1` or `release_owned_v1` answers `cancel_requested` and `acknowledge_cancel_v1` refuses,
the worker settles nothing. After a failed cancellation acknowledgement, the handler outcome was
`unknown`. Now it is `lease_lost`. The handler span records `stale`. Before this change, it recorded
`cancel_requested`. A late heartbeat round can also deliver the cancellation request, after a
failure, a release, or a refused completion. If the acknowledgement then refuses, the handler
outcome was `canceled`. Now it is `lease_lost`.

### The dashboard bundle uses Mantine 9.7.4

`Workhorse.AspNetCore` serves the shared dashboard browser bundle. After 0.10.0, a dependency update
moved the dashboard to Mantine 9.7.4 and rebuilt that bundle (SM-1839). The `Workhorse.AspNetCore`
package now carries the rebuilt `read-surface-1.tar.gz`. Its `bundle.json` records the sha256
`a7d61ed1d0433e38a8d227cbcc8f98a0bf668f2d3bb1d47391b1882fd69bf795`.

The `dashboard/v1` procedures and the read surface version do not change (SM-1858).

### The dashboard page tells each cache not to store it

The dashboard page holds `window.workhorseDashboard`, which contains the `auditActor` of the
operator. Before this change, the `Workhorse.AspNetCore` dashboard backend sent the page with only
`Content-Type`. A shared cache in front of the application could store the page by heuristic. A
later visitor could then get the stored page and see the actor name of an earlier operator. A
browser could also show the page from its cache after logout (SM-1870).

Now the `Workhorse.AspNetCore` dashboard backend sends the page with `Cache-Control: no-store`, as
the TypeScript host does. Each asset keeps `Cache-Control: public, max-age=31536000, immutable`.

### An idempotency TTL that rounds to 0 ms is refused

The queue rounds `Idempotency.Ttl` to the nearest millisecond. Before this change, a positive
`TimeSpan` below 0.5 ms rounded to 0, and the queue kept the key for the default one day without a
warning (SM-1857).

Now the queue throws `ArgumentException` for a nonzero `TimeSpan` that rounds to 0 ms.
`TimeSpan.Zero` still selects the default. ADR 0115 records the rule for all seven SDKs.

### Recovery no longer locks a timed-out attempt that waits for its cancellation

An operator cancels a running task after its execution timeout passed, and its lease is still live.
Before migration 0089, each maintenance tick locked that attempt in its timeout scan, but settled
nothing, because the cancellation wins over the timeout. While the tick ran, the heartbeat of the
owning worker reported the lease busy. The locked rows also used the recovery limit, so a real
timeout behind them waited for their leases to expire (SM-1866).

Now the full-tier timeout scan skips such an attempt while its lease is live and its deadline is
ahead, as the fast tier does. If the deadline passed after the timeout, recovery closes the task
`canceled` at once.

### Fast-tier recovery closes a canceled attempt when its deadline passes

A fast-tier task has a pending cancellation and a live lease. Its execution timeout passes, and
later its deadline passes. Before migration 0090, each maintenance tick locked that attempt and
settled nothing until the lease expired. The cancellation blocks the timeout, and recovery took the
deadline only when the deadline was not later than the timeout (SM-1881).

Now fast-tier recovery closes the task `canceled` when its deadline passes, as the full tier does.

### The dashboard Schedules page reads a bounded number of occurrences

Before migration 0089, `dashboard_cron_v1` counted every retained occurrence of each listed
schedule. A schedule that fires each second keeps about 1.2 million occurrences in the default
retention of 14 days. Each poll of the Schedules page read all of them (SM-1866).

Now the function reads at most 1,001 occurrences for each listed schedule. `occurrenceCount` stops
at 1,000, and the new optional key `occurrenceCountCapped` is `true` when more occurrences are
retained. The bundled Schedules page then shows `1,000+`. `lastFiredAt` is the fire time of the
newest occurrence. The `dashboard/v1` change is additive. A database below schema 88 returns an
exact count and no `occurrenceCountCapped`. The page change rebuilds the shared dashboard bundle
again. The sha256 in "The dashboard bundle uses Mantine 9.7.4" is the sha256 of that bundle.

### The worker registry prune finds expired kept pauses through their index

Before migration 0089, `prune_worker_registry_v1` deleted expired kept pauses with a condition that
the planner could not match to `worker_pause_tombstone_expires_idx`. Each maintenance pass read the
whole table. Now the delete reads only the expired rows through the index (SM-1866).

## 0.10.0 — 2026-10-26

### The first publish of the .NET SDK

This is the first release of the .NET SDK on nuget.org. The npm packages, Python distribution, Go
module, Rust crate, Ruby gem, JVM artifacts, and .NET packages release from one source commit.

Requires **schema v76**, .NET **10** or newer, and PostgreSQL **15** or newer.

- The .NET SDK needs schema version 76 or later. The SDK compatibility floor is schema version
  **76**. Install or migrate the schema with the `workhorse` CLI as a deployment step, before the
  application starts. The application never installs or migrates the schema.
- The SDK has four packages. All four use one version ([ADR
  0107](../docs/decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)):
  - `Workhorse`: the queue client, `Admin`, the worker, and the durable handler context.
  - `Workhorse.Hosting`: dependency injection, options, the hosted worker, and health checks for
    the Generic Host.
  - `Workhorse.EntityFrameworkCore`: an enqueue in the transaction of an EF Core `DbContext`.
  - `Workhorse.AspNetCore`: the embedded dashboard backend, mapped as ASP.NET Core endpoints.
- Each package other than `Workhorse` depends on `Workhorse` at the same version. Use the same
  version for each package that you add.
- Every package targets `net10.0`, and a .NET 11 application runs it without a second target. Every
  package needs Npgsql 10.0.3 or later. `Workhorse` and `Workhorse.Hosting` need
  `Microsoft.Extensions.*` 10.0.0 or later. `Workhorse.EntityFrameworkCore` needs EF Core
  Relational 10.0.0 or later. `Workhorse.AspNetCore` uses the ASP.NET Core shared framework of the
  installed runtime. [Supported versions](../docs/compatibility.md#supported-versions) states each
  floor and its end-of-life date.
- nuget.org signs each package. Each package has a symbol package with SourceLink to the commit of
  the release.
