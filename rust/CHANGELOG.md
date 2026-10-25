# Rust changelog

`workhorse` crate versions and release notes live here because the crate publishes to crates.io
from the release workflow's `crates-io` job, apart from the npm packages. It carries the version
the TypeScript packages, the Python distribution, and the Go module carry, because every tag names
one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## Unreleased

### The worker checks its poll interval

Before this change, `Worker::new` did not check `WorkerOptions::poll_interval` (SM-1778). A value
near `Duration::MAX` passed construction and could overflow the jitter or the deadline of the wait.

Now `Worker::new` refuses a `poll_interval` that is not a whole number of milliseconds from 1
through 2,147,483,647 with `Error::InvalidArgument`. Every SDK accepts this range (ADR 0112). A
caller who passed zero or a value below 1 ms gets an error at construction. `None` keeps the
default.

### A busy fast-tier queue no longer keeps the worker from its other queues

While one fast-tier queue had a backlog, the fused refill of each completion kept every slot, so the
worker did not claim from its other queues until the backlog ended (SM-1676). Now, if another queue
had no claim for one poll interval, the next fast-tier completion claims no task, and the next plain
claim continues the queue rotation. The interval is the explicit poll interval, or 250 ms without
one. A worker with one queue does not change. The change needs no migration.

### The dashboard Schedules page shows the last skip of a schedule

Migration 0087 (`0087-show-the-last-schedule-skip-on-the-dashboard.sql`) moves the schema to version 86. The `dashboard/v1` cron document gains `lastSkippedAt`, `lastSkippedCount`, and
`lastSkippedThrough` on each application schedule, an additive change. The bundled Schedules page
shows a `Skipped` badge with the count and the time of the last skip of a `skip` schedule (SM-1708).
The migration does not raise the SDK compatibility floor.

### The worker refuses a shutdown grace above one day

Before this change, `WorkerOptions::shutdown_grace_period` had no upper limit (SM-1778). A grace
near `Duration::MAX` passed construction, and `Worker::run` then panicked when it computed its
shutdown deadline. Ruby, the JVM, and .NET already refuse a grace above 86,400,000 ms.

Now `Worker::new` refuses a grace above 86,400,000 ms (one day) with its usual option error. A
caller who passed a longer grace gets an error at construction. The lower limit and the
whole-millisecond check do not change.

### The worker records the retry span

Before this change, the Rust worker recorded no `workhorse.retry` span. When an attempt timeout
retried a task through `expire_owned_telemetry_v1`, the worker read only `status`, so it also added
nothing to `workhorse.tasks.retried` (SM-1734).

Now the worker starts the `workhorse.retry` span around each `fail_v1` write, as the TypeScript
worker does. When `expire_owned_telemetry_v1` returns a `retry_state`, the worker records the span
and adds one to `workhorse.tasks.retried`. The span is a child of the `workhorse.handler` span. It
carries `workhorse.task.id`, `workhorse.task.type`, `workhorse.task.attempt`, and
`workhorse.retry.outcome`. Both tiers behave the same. The span is an addition. Like the handler
span, it is a `tracing` span, and a `tracing-opentelemetry` layer that the application installs
exports it.

### The worker counts each failed heartbeat round

A heartbeat round can fail before PostgreSQL gives a verdict for its leases. Before this change, the
Rust worker only logged such a round at warn level. A metric did not show how often rounds failed
or why (SM-1704).

Now the worker counts each failed round once in the new counter
`workhorse.worker.heartbeat.round_failure`, with the unit `{round}`. The bounded attribute
`workhorse.heartbeat.failure_reason` gives the cause: `timeout`, `connection`, `database`, or
`other`. A failed round gives no ownership verdict, so `workhorse.worker.heartbeat.failure` does not
change. The warn log stays. The new instrument is an addition, and it records only with the
`opentelemetry` feature.

### The Rust client measures signal and human wait values as PostgreSQL does

PostgreSQL limits a signal payload, a human wait context, and a human wait result to 65,536 bytes of
`octet_length(value::jsonb::text)`. That text has a space after each `:` and `,`, so it can be
longer than compact JSON. Before this change, the Rust client counted the compact JSON. A value near
the limit passed that check, and then PostgreSQL refused the statement with a database error
(SM-1639).

Now `Queue::send_signal`, `Queue::complete_human_wait`, and `HandlerContext::wait_for_human` measure
the canonical JSONB text before any statement. An oversized value raises `Error::InvalidArgument`.
The limit does not change.

### The worker warns when a statement waits past shutdown_grace_period

A maintenance pass or a claim can wait for a lock that another session holds. Before this change,
the worker logged nothing while it waited (SM-1785).

Now the worker logs `workhorse.worker.statement_slow` once, at warn level, if a maintenance pass or
a claim waits longer than the stop budget. The stop budget is `shutdown_grace_period`. The record
carries `workhorse.worker.id`, `workhorse.worker.statement` (`maintenance` or `claim`), and
`workhorse.worker.elapsed_ms`. `workhorse.worker.elapsed_ms` is the wait at the moment of the
warning. The statement continues to wait, and no other behavior changes.

### The worker intervals accept 100 through 2,147,483,647 ms

`register_worker_v1` takes `maintenance_interval`, `maintenance_routine_interval`, and
`registry_interval` as PostgreSQL `integer` milliseconds, and the registry refuses a value below 100. Before this change, `Worker::new` accepted a tick or routine interval from 1 ms. The worker
ran at that cadence but wrote 100 ms to the registry. It also accepted a value above
2,147,483,647 ms and wrote 2,147,483,647 ms instead (SM-1668).

Now `Worker::new` returns `Error::InvalidArgument` if one of these intervals is not a whole number
of milliseconds from 100 ms through 2,147,483,647 ms. `disable_registry` still turns off
registration. This is a behavior change for a caller who passes such a value. ADR 0112 records the
range for all seven SDKs.

### retry_delay refuses a duration above the fail_v1 range

`fail_v1` takes the retry delay as a PostgreSQL `integer`. Before this change, the worker clamped a
`retry_delay` result above 2,147,483,647 ms to that limit without a record. It also truncated a
fraction of a millisecond (SM-1668).

Now the worker rounds the duration to the nearest millisecond, half up. A duration that rounds above
2,147,483,647 ms makes the failure settlement return `Error::InvalidArgument` before `fail_v1`.
ADR 0111 records the rule for all seven SDKs.

### A panic in on_registration_error no longer stops the worker

An application can give `on_registration_error` to the worker to send an alert. Before this change,
a panic of the hook in the first registration made `Worker::run` panic. A panic in a later
registration ended the registry loop, so the worker stopped its registry refreshes (SM-1696).

Now the worker catches the panic and continues. It logs the failure through `tracing` at the error
level. It logs the first failure. Then it logs at most one failure in each 60 s, with the count of
the failures that it did not log. It never calls the failed hook for its own failure.

### Workers use the database clock for maintenance

Maintenance writes shared state: the due time of each routine and the retention cutoffs. Before
this change, the Rust worker sent its host clock as the maintenance time. If that clock was two days
fast, other workers skipped a routine until that future time. Retention also deleted a 13-day-old
schedule occurrence under a 14-day policy (SM-1645).

Now `Worker::run` and `Worker::run_once` bind the text `now` in text format, and PostgreSQL
resolves it to its own time at the start of the call. The `bytes` crate, which tokio-postgres
already uses, is now a required dependency.

The schema does not change.

### The dashboard names an action that the host does not provide

A dashboard host answers the `enqueueTest` and `setSchedulePaused` procedures only when the
application gives a handler for them. Before this change, a writable host without that handler
answered `FORBIDDEN` with the message "This procedure is not available". Now the message is "This
dashboard host does not provide the <action> action", as in the TypeScript dashboard server. A
read-only host keeps the message "This dashboard is read-only". The code `FORBIDDEN` and the HTTP
status 403 do not change (SM-1705).

### A worker without a live notification subscription polls at the short interval

A worker that can listen uses a 5,000 ms wait after an empty claim, because a notification wakes it
for new work. Before this change, the Rust worker chose that wait from its configuration, not from
the state of its listener. If the listener had not run `LISTEN` yet, or reconnected after a lost
connection, nothing woke the worker. A new task then waited up to 5 s for a claim (SM-1648).

Now `Worker::run` reads the listener state before each wait. Without a live subscription, the default
wait starts at 250 ms and doubles toward 5,000 ms after each empty claim, as in the other SDKs.
When `LISTEN` succeeds, the 5,000 ms wait applies again. An explicit `poll_interval` does not change.

When a live subscription is lost, the backoff restarts at 250 ms, because the empty claims of the
live period do not count. Before this change, a worker that was idle for some time while it
listened went to the 5,000 ms ceiling at once after a loss. The Rust listener now also wakes its workers after a
lost connection, so a 5,000 ms wait from the live period ends at once.

The `subscription-recovery` case in `protocol/v1/runtime.json` checks these rules in every SDK.

### A handler error with text that jsonb cannot store settles by its retry policy

PostgreSQL `jsonb` cannot store a NUL character or an unpaired surrogate. Before this change, a
handler error with such text made `fail_v1` refuse the failure envelope. The worker stopped, and the
task stayed active until lease recovery (SM-1650).

Now `fail_with_state` replaces each NUL character with U+FFFD. It does this in the name, the
message, and the stack. The JVM and .NET workers use the same rule. The retry policy then settles
the task. A Rust `String` cannot hold an unpaired surrogate.

The `protocol/v1/failures.json` fixtures pin the rule for every SDK.

### Workers on one pool renew their leases in one transaction

On the dedicated heartbeat connection, a round sent one transaction for each worker and each 100
leases. Each transaction needs at least 3 round trips to PostgreSQL. With 8 workers on one pool and
80 ms for each round trip, workers lost leases while PostgreSQL still answered (SM-1631). Now the rounds that wait for the connection share one transaction, with one `heartbeat_pool_v1` statement for every worker and every 100 leases. The round that leads the transaction takes every waiting round whose deadline is not earlier than its own. The
transaction locks the task rows of every worker in it until its `COMMIT`. A round renews all of its
leases or none. The settings statement now sets `statement_timeout` and
`idle_in_transaction_session_timeout` each to one quarter of the time that remains, not to one half
and one eighth. The statement needs no schema change. The `shared_heartbeats` opt-out does not change (SM-1633).

### The dashboard changes a queue's tier and history

Before this change, an operator used `workhorse admin set-tier` and `set-history` to move a queue
between tiers or to change the history that a fast-tier queue records. The dashboard showed the
tier but could not change it (SM-966, ADR 0077). The Rust dashboard host now answers two
mutations. `setQueueTier` calls `Admin::set_queue_tier` and records the authenticated actor and
the audit reason on the queue. `setQueueHistory` calls `Admin::set_queue_history`. An omitted
setting keeps its value.

`set_queue_tier_v1` holds every guard. If it refuses a switch, the host answers a status and a
null tier, and the queue does not change. The status is `live_tasks` when the queue holds a live
task. It is `concurrency_policy` or `rate_limit_policy` when a fast switch meets that queue policy.
Both mutations need a same-origin request and a writable dashboard. No schema change is necessary.

### A contract compares every number as an exact decimal

Before this change, the Rust SDK read a stored contract schema into a `serde_json::Value`, which
reads a fraction, and an integer outside `i64` and `u64`, as an `f64`. jsonschema-rs also compared
an integer above 2^53 with the binary value of a fraction-typed constant. Thus
`1152921504606846980` failed `{"maximum": 1.152921504606847e18}`, although PostgreSQL stores the
constant as `1152921504606847000`. Now the SDK reads the stored schema as jsonb text and keeps each
number token (SM-1541, ADR 0039). `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`,
`multipleOf`, `const`, `enum`, and `uniqueItems` compare exact decimals, also in a schema that you
give to `compile_contract_schema`. The SDK does not turn on the `serde_json` `arbitrary_precision`
feature, and `contracts/numbers-compare-exact-decimals` leaves the expected-unsupported list.

A custom `EnqueueTransport` now gets the contract query with its `schema` column declared as
`EnqueueColumnType::Text`. A transport that decodes each column by its declared kind needs no
change.

### Workers on one pool share one heartbeat connection and one listener connection

Before this change, each worker took its own heartbeat connection from its pool and opened its own
listener connection outside the pool. If a pool had no more connections than its workers, the
heartbeat connections held every pooled connection. No claim started, and `run` did not stop. Now
all workers on clones of one pool share one heartbeat connection from the pool and one listener
connection outside it (SM-1572, ADR 0071). The pool identity is the address that `Pool::manager()`
returns, so two pools that you build separately do not share. `Worker::new(pool, options)` does not
change.

**Upgrade steps.** Budget one heartbeat connection for each pool, not for each worker. The pool
still needs at least 3 connections unless `shared_heartbeats` is set. If workers on one pool set
`listen_config`, give each worker the same value: a worker whose value differs from that of a
running worker on the same pool refuses to start.

**A failed startup reservation now ends the run.** Before this change, a worker that could not
reserve its heartbeat connection within one heartbeat interval ran without it. Now startup has a
budget, the larger of the heartbeat interval and 5 s. Within it, the shared heartbeat connection
must be present, and one more pooled connection must run the compatibility check. If either step
does not finish, `run` returns an error that names the pool, the budget, and the opt-out. A
`shutdown` that resolves during startup ends the run with `Ok`.

**No claim without the heartbeat connection.** If a failed round discards the shared heartbeat
connection, no worker on the pool claims a task until a replacement arrives. A claim reads this gate
again after it gets its pooled connection, so a claim that waited for a connection sends nothing. A
fast-tier completion then claims nothing. The last worker to stop waits for the claim statements in
flight before it closes the heartbeat connection. The replacement starts at once, also when no task
runs, and the delay between attempts grows to at most the heartbeat interval. When the replacement
arrives, the workers claim at once and do not wait for their poll.

**Bounded waits for a pooled connection.** A statement of the worker or of a `HandlerContext` now
waits for a pooled connection for the larger of the lease and 5 s at most. Before this change, a
full pool could hold startup or a statement without a limit. A stop with a full pool now ends within
the grace period, the unwind window, and the cleanup window.

**A stop does not wait for a registry statement without a limit.** A stop now waits for the first
registration, a registry refresh, the draining refresh, and the deregistration until the stop
deadline at most. A dropped run gets one cleanup window as its deadline. A statement that outlives
the deadline keeps running, and the next run of the worker waits for it before it registers. If it
still runs at the end of the startup budget, `run` refuses to start.

### Throttle works on a fast-tier queue

Before this change, a throttled enqueue into a fast-tier queue raised `Error::FastTierUnsupported` with the feature
`throttle`. Throttle only decides if Workhorse accepts an enqueue request, so it needs no state of
the full tier (SM-928, ADR 0077). Migration 0075
(`0075-allow-throttle-on-fast-tier-queues.sql`) moves the schema to version 74. After it,
`enqueue_throttle_v1` and `enqueue_many_v1` accept throttle on a fast-tier queue. The outcomes are
`accepted` and `coalesced`, as on the full tier.

A coalesced request on a fast-tier task writes no `throttled` event, because a fast-tier task
records only the history that its queue enables. The SDK still emits the throttle log and the
enqueue outcome metric. In a batch with a debounce or a throttle member, a fast-tier rejection of
one member now reports the position of that member in the batch. Debounce on a fast-tier queue is
still rejected.

The migration does not raise the SDK compatibility floor. No SDK statement changes. The migration changes no stored data.

### The retention preview reads through a dashboard function

Before this change, each dashboard host read the retention policy, sent a shared statement that
counted rows directly in the tables, and capped the counts in its own code. ADR 0040 asks for one
SQL implementation for each dashboard procedure (SM-1478). Migration 0076
(`0076-add-the-dashboard-retention-preview-function.sql`) moves the schema to version 75 and adds
`dashboard_retention_preview_v1`. The Rust dashboard host now calls it. The `previewRetentionPolicy` response does
not change.

Every SDK statement catalogue names the new function, so the SDK compatibility floor rises from
schema 73 to 75. Run `workhorse schema migrate` before the first process of this release starts.
A 0.9 process keeps working on schema 75. The migration changes no stored data.

### A late worker deregistration cannot delete the row of a later run

Before this change, a worker that stopped sent `deregister_worker_v1`, which deletes the registry
row by worker ID only. If the stop path was slow and the same worker ID started again, the late
deregistration could delete the row of the new run and its operator pause state. Each SDK guarded
against this in its own code (SM-1589). Migration
0077 (`0077-fence-the-worker-deregistration-by-instance.sql`) moves the schema to version 76 and
adds `deregister_worker_v2`. It deletes the row only while the row names the instance of the run
that stops. `deregister_worker_v1` does not change.

`Worker` now calls `deregister_worker_v2` with the instance of the run that stops.

Each SDK keeps its guard for this release: a new run still waits for the stop statements of the
previous run, or it refuses to start. Every SDK statement catalogue names the new function, so the
SDK compatibility floor rises from schema 75 to 76. Run `workhorse schema migrate` before the first
process of this release starts. A 0.9 process keeps working on schema 76. The migration changes no
stored data.

## 0.9.0 — 2026-10-20

The npm packages, Python distribution, Go module, Rust crate, Ruby gem, and JVM artifacts release from one source commit.

Requires **schema v73**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** Run `workhorse schema migrate` before any
process of this release starts, producers too. Migrations 0073 and 0074 move the schema to version
**73**. The SDK compatibility floor rises from 69 to **73**, because every SDK statement catalogue
now names `heartbeat_many_v2` and `heartbeat_v2`. An updated process refuses a schema below version
73 at startup. A 0.8 process keeps working on version 73, because a migration inside a major line
only adds.

### Heartbeats do not wait for a locked task row

Before this release, a heartbeat waited for a task row that another transaction locked. If a
settlement held the row, the heartbeat then kept the row locked after the settlement committed, and
a claim skipped the ready task (SM-1434). The worker now renews leases through `heartbeat_many_v2`
(SM-1443, ADR 0105). It skips a locked row and reports that lease as `busy`: no renewal and no
ownership verdict. The worker keeps a busy lease, retries only the busy leases after a short delay
with jitter, and does not move the regular heartbeat schedule. A busy answer never extends the local
lease watchdog, so a lease that stays busy until the watchdog ends is lost, as before. Old and new
workers can run together: an old worker keeps calling `heartbeat_many_v1`, which does not change.

**One-lease heartbeat without a row lock wait.** Migration 0074 adds `heartbeat_v2` (SM-1461). It
renews one lease by the rule of `heartbeat_many_v2`, so it reports a locked row as `busy`. This SDK
names it in its statement catalogue but does not call it. `heartbeat_v1` does not change.

### Heartbeat rounds keep a renewal margin and end on the server

Before this release, the reserved heartbeat connection bounded the heartbeat statement by one full
interval. A replacement connection after a failed round had no bound. After a failed round, the next
round fell due one interval after that round ended. With the defaults, one timed-out round thus left
about 0 s before the lease watchdog expired (SM-1444). Also, when the worker stopped waiting for a
statement, PostgreSQL continued to run it, and that statement kept its row locks (SM-1442). These
changes apply to each round on the reserved heartbeat connection:

- **Rounds start on a fixed schedule.** A round falls due one interval after the previous round
  started, not after it ended. The schedule uses a monotonic clock. If a round ends after its next
  slot, the worker starts one overdue round at once and sends no round for the other missed slots.
- **The round bound is shorter.** A round ends by
  `max(1 ms, interval × 3 / 4, min(50 ms, interval))`. For an interval of 200 ms or more, this is
  three quarters of the interval. With the defaults (lease 30 s, interval 10 s), the bound is 7.5 s,
  so one timed-out round leaves a margin of 2.5 s. An attempt keeps its lease after one timed-out
  round if `2 × interval + round bound < lease`. The worker does not reject an interval that breaks
  this rule.
- **Each round sets server timeouts.** The round sends `BEGIN`, then one `set_config` statement for
  `statement_timeout` and `idle_in_transaction_session_timeout`, then `heartbeat_many_v2`, then
  `COMMIT`. Both settings are transaction-local. The heartbeat statement gets one half of the time
  that remains, and each idle gap one eighth. If less than 8 ms remains at the settings statement,
  the round fails before the heartbeat. The worker counts a renewal only after a `COMMIT` that ends
  before the deadline. No setting bounds `COMMIT` on PostgreSQL 15 and later.
- **A failed round discards its connection only when a statement may still run** (SM-1492). A
  round that expires before it sends the heartbeat statement rolls back and keeps its connection.
  Under load, PostgreSQL can log
  `canceling statement due to statement timeout` for a heartbeat statement. It can also end the
  session with `terminating connection due to idle-in-transaction timeout`. Each message means that
  one round failed. Every task continues, and the next round tries again. A deadlock (`40P01`) now
  fails the round, and the next round sends the heartbeat again. Before this release, the round sent
  a deadlocked heartbeat again, up to three attempts in total. A round under
  `WorkerOptions::shared_heartbeats` still does.
- **A busy retry with less than 20 ms left sends nothing** (SM-1492). A bounded busy retry runs
  only if its deadline is at least 20 ms after its start: the 8 ms that a round needs at its
  settings statement, plus a 12 ms margin. Otherwise the next regular round renews the busy leases.
- **Replacement connections.** The next round opens a replacement connection inside its own
  deadline. A connect that is not ready by the deadline continues, and each later round waits for it
  until its own deadline.
- **100 ms is the smallest supported heartbeat interval** (SM-1471). This applies to
  `WorkerOptions::heartbeat_interval`: the smallest supported value is 100 ms. At 100 ms, the round
  bound is 75 ms. The worker still accepts a shorter interval, and it does not warn. On a loaded
  host, a shorter interval can make each round miss its deadline, and attempts can then lose their
  leases.

Rounds under `WorkerOptions::shared_heartbeats` have no client deadline and set no server timeouts,
as before. They follow the new schedule. The [heartbeat round
deadline](../docs/architecture/lifecycle.md#heartbeat-round-deadline) and the [heartbeat
schedule](../docs/architecture/lifecycle.md#heartbeat-schedule) state each rule.

### A lease leaves the heartbeat set when its watchdog expires

Before this release, the lease watchdog cancelled the handler with `CancelReason::LeaseLost` when no
renewal was accepted within one lease. But the attempt stayed in the heartbeat set until the handler
returned. Thus a handler that ignored its cancellation kept its lease alive (SM-1445). Now the
attempt leaves the heartbeat set when the watchdog expires, as in the other SDKs. A round that the
worker sent before can still commit one renewal, but no later round includes the lease. A late
handler return still settles as `lease_lost`.

### The retention preview disables a category for an explicit null

Before this release, the dashboard `previewRetentionPolicy` procedure used the current policy value
when the request set a retention setting to `null` (SM-1509). A `null` setting disables its
category, so the preview counted rows that the other SDK hosts do not count. The Rust host now uses
the current value only when the request does not have the setting.

### Worker telemetry matches `api/telemetry.txt`

Before this release, the Rust worker added `workhorse.handler.outcome` to
`workhorse.handler.runtime`. A chart of that counter by queue thus had one series for each outcome,
and the series did not match the other SDKs (SM-1514). The counter now carries only
`workhorse.queue.name` and `workhorse.task.type`. If a dashboard groups the Rust runtime counter by
outcome, use `workhorse.handler.duration` or `workhorse.handler.executions` for that grouping.

The `workhorse.handler.batch_dispatched` log record now names its linger
`workhorse.handler.batch.linger_ms`, as the contract does. Before this release, it used the
instrument name `workhorse.handler.batch.linger`. Each Rust instrument now also has the description
from `api/telemetry.txt`.

Before this release, lease recovery added to `workhorse.tasks.retried` only the retries that the
`retry_dimensions` of its result listed. If the result held more retries than entries, a fleet chart
showed too few retries for Rust workers (SM-1551). Recovery now adds the difference with `unknown`
for `workhorse.queue.name` and `workhorse.task.type`, as the other SDKs do.

### The default heartbeat interval is at least 100 ms

Before this release, the Rust worker set the default heartbeat interval to lease / 3. For a lease
below 300 ms, that is below the 100 ms that every SDK supports. The default is now `max(100 ms,
lease / 3)`, as in TypeScript, Python, Ruby, and the JVM (SM-1510). A lease of 100 ms thus needs an
explicit, shorter heartbeat interval.

## 0.8.0 — 2026-10-13

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v69**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** The upgrade is a rolling deployment:

1. Run `workhorse schema migrate`. The final schema version is **71**.
2. Roll out the updated processes.

The SDK compatibility floor is schema version **69**, which migration 0070 reaches. The floor rises
from 54. Every SDK statement catalogue now names the task group functions that migration 0066 adds,
and `save_checkpoint_v2`, which migration 0069 adds. The dashboard of each SDK calls
`dashboard_task_groups_v1`, which migration 0067 adds, and `list_newest_task_group_events_v1`, which
migration 0068 adds. Migration 0070 fences a member add, so an updated process does not add tasks to
a group without that check. An updated process refuses a schema below version 69 at startup. A 0.7
process keeps working on version 71, because a migration inside a major line only adds.

Migration 0066 (`0066-add-task-groups-with-completion-callbacks.sql`) adds task groups (SM-1231,
[ADR 0095](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0095-add-task-groups-with-completion-callbacks.md)).
A task group is a set of full-tier tasks that Workhorse tracks as one unit. When the group is
sealed and every member task is finished, Workhorse enqueues its `onFinish`, `onSuccess`, or
`onFailure` callback task. The migration adds the `task_group`, `task_group_member`,
`task_group_callback`, and `task_group_event` tables, and a trigger on `task_outcome` that counts
each member outcome in the transaction that writes it. A queue purge counts a purged member task as
`canceled`. The `terminal_storage` routine keeps member tasks while their group is not finished,
reports a new `task_groups` phase after `terminal_tasks`, and deletes a finished group after its
callback tasks are terminal. New SQLSTATEs: `P1008` (the task group does not accept tasks), `P1009`
(member limit of 100,000), and `P1010` (an enqueue idempotency hit returns a task that is not a
member of the group).

Migration 0067 (`0067-count-task-group-outcomes-in-counter-shards.sql`) counts task group outcomes
in counter shards (SM-1245,
[ADR 0096](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0096-count-task-group-outcomes-in-counter-shards.md)).
Each group gets 32 rows in the new `task_group_shard` table, and a member outcome locks only its
shard row at commit. The outcome locks the group row only when the pending count of its shard
becomes 0. The migration moves the counts of existing groups into the shards. It locks `task_group`
in `EXCLUSIVE` mode while it runs, so task group changes wait for it. The counts on a `task_group`
row stay 0 until the group finishes, so read the counts through `get_task_group_v1`. The migration
also adds `dashboard_task_groups_v1`, which lists task groups one page at a time. The dashboard of
each SDK reads the task group list through it (SM-1237).

Migration 0068 (`0068-read-the-newest-task-group-events.sql`) adds
`list_newest_task_group_events_v1`, which returns the newest events of a task group first
(SM-1254). The task group detail of the dashboard reads its events through it. A group with more
than 1,000 events now shows its newest 100 events. `eventsTruncated` is true when the group has
older events that the detail does not show. `list_task_group_events_v1` does not change. The
migration changes no stored data.

Migration 0069 (`0069-check-the-input-of-a-checkpoint-on-replay.sql`) adds the nullable column
`task_checkpoint.input_fingerprint` and `save_checkpoint_v2` (SM-1211,
[ADR 0098](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0098-check-the-input-of-a-checkpoint-on-replay.md)).
If a checkpoint name exists, `save_checkpoint_v2` returns `input_conflict` when the stored and the
given input fingerprints are both present and differ. `save_checkpoint_v1` now calls
`save_checkpoint_v2` with no fingerprint, so its results do not change. The checkpoint reads of each
statement catalogue return the new column. Existing rows keep a NULL fingerprint. The migration adds
the column without a table scan.

Migration 0070 (`0070-fence-a-task-group-member-add-and-index-the-group-list.sql`) fences a task
group member add (SM-1273). `add_task_group_members_v1` now locks the runtime row of the member task
first, before the shard rows and the group row, as a completion does. Then it refuses the add with
`P1008` and the reason `not_running_member` if the lease of the member task expired, its deadline or
attempt timeout passed, or a cancel was requested. Before, a worker whose lease expired could add
tasks after Workhorse gave the member task to a new worker. The signature does not change. The
migration also adds `task_group_state_created_idx`, so `dashboard_task_groups_v1` reads one page of
a state without a read of the groups of other states. The migration is a non-transactional step: it
builds the index with `CREATE INDEX CONCURRENTLY`, so writes to `task_group` continue. If it fails
part-way, drop the invalid index before the rerun, as `docs/schema-lifecycle.md` describes. It
changes no stored data.

Migration 0071 (`0071-lock-purged-runtime-rows-in-identity-order.sql`) makes a queue purge lock its
tasks in identity order (SM-1282). Before, `purge_queue_internal_v1` locked the runtime rows and the
task rows of the queue in scan order. An enqueue that named two of those tasks as prerequisites
locks them in identity order. Thus the purge and the enqueue could wait for each other, and
PostgreSQL aborted one of them with `40P01`. The purge now locks every runtime row, then every task
row, each in identity order. The signature and the deleted count do not change. The migration does
not raise the SDK compatibility floor, because no SDK statement changes and every process gets the
new lock order when the migration commits. It changes no stored data.

Migration 0072 (`0072-purge-a-queue-that-holds-a-prerequisite-of-a-live-dependent.sql`) lets a
queue purge succeed when it holds a prerequisite of a waiting dependent (SM-1284,
[ADR 0101](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0101-cancel-a-purged-prerequisite-whose-dependent-stays.md)).
Before, the purge deleted that prerequisite, and PostgreSQL refused the delete with `23001`. The
whole purge then failed, also when the dependent was in the same queue. Now the purge deletes a
dependent in the same purge with its prerequisite. If the dependent stays, for example in another
queue, the purge cancels the prerequisite instead of a delete. The dependent's own
`on_cancellation` policy then decides its outcome, as after a cancel. The canceled task keeps its
history and its keys. The purge count, `deleted_count` and `deletedCount`, includes the canceled
tasks. The purge locks the dependents after its own tasks, as a cancel does, so it has no
deadlock that a cancel of the same tasks does not also have. Two purges run one after the
other, also for different queues. The migration does not raise the SDK compatibility
floor, because no SDK statement or result shape changes. It changes no stored data.

### New features

- Task groups (SM-1235, ADR 0095). `Queue` gains `create_task_group`, `add_to_task_group`,
  `seal_task_group`, the block form `task_group`, `get_task_group`, `list_task_group_members`, and
  `find_task_group`. `TaskGroupCallbacks` holds the `on_finish`, `on_success`, and `on_failure`
  requests. The block form creates, adds, and seals in one statement. A `Queue` over a transaction
  executor makes the other calls part of the caller's transaction.
- A handler reads its group through `ctx.task_group().get()`, as a member task or as a callback
  task. A running member task adds tasks through `ctx.task_group().add()`, under its fenced lease,
  also after the seal. If a request names no queue, `add()` puts the task in the queue of the member
  task (SM-1251,
  [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
  `BatchHandlerContext::task_group` gives a batch member the same calls.
- `Admin` gains `get_task_group`, `list_task_group_members`, `list_task_group_events`,
  `cancel_task_group`, `list_task_group_drift`, and `repair_task_group_drift`.
- `Error` gains `TaskGroupClosed` (`P1008`), `TaskGroupLimitExceeded` (`P1009`), and
  `TaskGroupMembershipConflict` (`P1010`), with their `DETAIL` documents. `Operation` gains
  `AddToTaskGroup`.
- `list_task_group_members` of `Queue` and `Admin` returns `next_after: None` on the last page,
  also when the page is full (SM-1277). Before, a full last page gave a `next_after` that read an
  empty page. A full page now costs one more read of one member. `TaskGroup::callbacks` keeps the
  order `on_finish`, `on_success`, `on_failure`, and a test now asserts it. The change adds no SQL
  function and no migration.
- Checkpoint input check (SM-1263,
  [ADR 0098](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0098-check-the-input-of-a-checkpoint-on-replay.md)).
  `HandlerContext::checkpoint_with_input(name, &input, op)` stores the fingerprint of the input with
  the result, through `save_checkpoint_v2`. If a later call gives an input with a different
  fingerprint, the call fails with `Error::CheckpointInputConflict`, and `op` does not run.
  Overlapping calls with one name compare their inputs too. If the call or the stored checkpoint has
  no input, nothing is compared. The worker settles the conflict as the terminal replay conflict
  `CheckpointInputConflictError`, so the task fails at once and keeps the current attempt.
  `BatchHandlerContext` gains the same method. `checkpoint` without an input does not change.
- `checkpoint_input_fingerprint(&input)` returns the fingerprint: the SHA-256 digest of the RFC 8785
  canonical JSON of the input, as 64 lowercase hexadecimal characters. It gives the same digest as
  the TypeScript SDK, and every SDK refuses the same inputs (SM-1274). A number larger than 2^53 - 1
  in magnitude, such as `u64::MAX` or `1e21`, returns `Error::InvalidArgument`.
- `TaskCheckpoint` gains `input_fingerprint`, the stored fingerprint or `None`. Code that builds a
  `TaskCheckpoint` with a struct literal must set the new field.

### Behaviour changes

- If a child task request names no queue, `HandlerContext::run_child`, `run_children`, and
  `run_children_all` put the child in the queue of the parent task (SM-1260,
  [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
  Before, the child went to the queue `default`. If no worker served `default`, the child stayed
  `ready`, and the parent task did not continue. To keep the old queue, name it on the request, for
  example `EnqueueOptions { queue: Some("default".into()), ..Default::default() }`.
  A parent task that created a child before the upgrade can replay that request after the upgrade.
  If the replayed request names no queue, it keeps the queue of the stored child, so the parent
  task joins its child.
- `Worker::run_once` does not change: a pass that released every task that it claimed returns
  `false`, and the next call claims at once (SM-1259, [ADR 0099](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0099-report-a-released-only-single-pass-as-no-progress.md)). TypeScript
  `runOnce()` now does the same. If you call the single-pass call in a loop, wait after `false`.
- A continuous worker that released every task of a claim now waits for its next poll before it
  claims again (SM-1247). A worker releases a task when it has no handler for the task type, for
  example during a rolling deployment. Before, the release notification ended the empty wait of the
  same worker, so it claimed the task again after 0 to 50 ms. One listening worker released one task
  about 30 times each second. Now a notification does not end this release wait. Only its deadline,
  a stop, or a pause ends it. The deadline is the poll interval while the listener is active, or the
  poll backoff without a listener. Thus a worker claims a task that it cannot run at most once in
  each poll interval.
- The dashboard router refuses a mutation whose `audit.requestId` is more than 512 UTF-8 bytes
  with `BAD_REQUEST`, before any SQL runs (SM-1253). It measures the value as sent, before trim.
  Before, the SQL audit function refused the value, and the client got an internal server error.

## 0.7.1 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

The crate has no changes in 0.7.1. It releases at 0.7.1 to keep one version across the
registries ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists because the npm publish of 0.7.0 stopped partway.
The crate never published at 0.7.0, so 0.7.1 is the first release with the 0.7.0 changes below.

**A 0.7.0 database needs no migration.** 0.7.1 adds no migration, so the final schema version is
**64** and the SDK compatibility floor stays at schema version **54**. An installation on 0.6
follows the [0.7.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#070--2026-10-09).

## 0.7.0 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** The upgrade is a rolling deployment: run `workhorse schema migrate`, then roll out the 0.7
processes. The final schema version is **64**. The SDK compatibility floor is schema version
**54**, which migration 0055 reaches. A 0.7 process refuses a schema below version 54 at startup,
and a 0.6 process keeps working on version 64. Each migration commits on its own, and each SQL
change takes effect when its migration commits.

**Migration 0059 clears incomplete rate settings.** A per-key rate limit or a budget rate with one
or two of its three fields null used to pass its CHECK constraint. The migration clears such a
setting, and deletes a budget that the clearing leaves without a limit. After the migration,
PostgreSQL rejects a synchronization that writes an incomplete rate setting. To keep a limit the
migration cleared, complete it in your synchronized definitions and synchronize after the
migration.

**Accept the new `terminal-cleanup-backlog` health reason.** Queue health can now report it as
degraded, so code that switches on reason codes should accept it. Its budget,
`terminal_cleanup_backlog_ms`, starts from your `row_retention_lag_ms` setting, so existing alerts
evaluate as before. After migration 0065 the two budgets are independent.

**Update `dashboard/v1` clients that read `humanWait.context` from a task listing.**
`dashboard.tasks` and `dashboard.tasksCursor` rows carry `humanWait.quickAction` instead, which is
`{ label }` or `null`. `dashboard.taskDetail` still returns the full context (SM-1171).

**Handler authors: a durable replay conflict now fails its task on the first occurrence.** The
behaviour changes below describe it. A 0.6 worker still retries a conflict under the task's retry
policy until the 0.6 processes are gone.

### Breaking changes

- `dashboard::DashboardOptions::audit_actor` is removed. It replaced the verified principal's actor
  on every mutation, so a dashboard could record a service name instead of the operator who acted.
  The dashboard now always records the actor of the returned `Authorization::Principal`, as the
  `dashboard/v1` protocol requires. Delete the field from your options. To record a fixed actor,
  return a `Principal` with that `actor` from `authorize` (SM-1152).
- `HandlerError` gains private fields, so a struct literal no longer builds one. Use
  `HandlerError::new` or `HandlerError::named`, then set `stack` or `name` on the result. One field
  marks an error converted from `Error::Conflict`, and the worker fails the task without a retry
  only when it is set. Before, the worker read the name, so an application error built with
  `HandlerError::named("WaitConflictError", …)` failed its task for good (SM-1164).
- The generic `From<E>` conversion into `HandlerError` requires `E: 'static`, so it can inspect the
  source chain and keep a conflict's class. For an error that borrows local data, build
  `HandlerError::new(error.to_string())` explicitly (SM-1107).
- **`dashboard/v1`:** task listing rows carry `humanWait.quickAction` instead of
  `humanWait.context`, as the upgrade steps describe. The break is taken in place under the ADR 0064
  exception in
  [`docs/compatibility.md`](https://github.com/stablemates/workhorse/blob/main/docs/compatibility.md)
  (SM-1171).

### Behaviour changes

Durable execution and workers:

- Durable checkpoint, timer, child, child-set, and human-decision replay conflicts fail the task on
  their first occurrence. The worker preserves the current attempt and records the conflict class.
  Before, a conflict retried under the task's retry policy, and every retry met the same conflict.
  Redaction still hides error details. Transient failures, lease loss, child-limit errors, and
  already-waiting signal errors keep their existing behaviour. Conflict settlement bypasses the
  worker's retry-delay callback (SM-1107, migration 0055).
- A renamed individual child on replay raises a child conflict with the stored and requested names.
  Before, it raised a child-limit error. A second child after joining the retained child in the same
  handler run still exceeds the child limit (SM-1106, migration 0054).
- The worker measures a handler result as PostgreSQL measures it, `octet_length` of its jsonb text,
  before it sends the completion. A result over the task's `result_max_bytes` fails its attempt with
  `TaskValueSizeLimitError` on both tiers, and the task's retry policy and the worker's
  `retry_delay` apply. Before, `complete_v1` raised, which left a full-tier task active until lease
  recovery. The fast tier's batched completion failed the attempt in PostgreSQL, which skipped
  `retry_delay` (SM-1159).
- `HandlerContext::checkpoint` and `HandlerContext::set_progress`, and their `BatchHandlerContext`
  wrappers, refuse a value that holds `NaN` or an infinity at any depth. A checkpoint returns a
  `HandlerError`, and `set_progress` returns `Error::InvalidArgument`, both before any write.
  `serde_json` had stored such a number as `null`, so a `checkpoint::<f64>` failed to decode on
  every retry (SM-1180).
- A handler that panics after its `CancelReason::Shutdown` cancellation fails its attempt, as any
  handler panic does. Before, the worker released the task without charging the attempt (SM-1164).
- With the `opentelemetry` feature, the `workhorse.handler` span descends only from the task's
  stored trace context. A task without one starts a new trace instead of joining the current
  `tracing` span. The `tracing` span still nests under that span, so its log events keep their scope
  (SM-1179).

Dashboard host:

- The dashboard service answers an unexpected schema-compatibility failure with a generic `503`. It
  logs the cause through `tracing` instead of returning the driver error text (SM-1168).

Maintenance, health, and administration, from the SQL changes:

- Terminal cleanup repeats its batch while each one fills, for up to one second per pass. A pass
  that still ends with a full batch makes its follow-up due five seconds later. Full-tier and
  fast-tier tasks share every batch (SM-1160, migration 0058).
- `tick_v1` runs the expired-lease scan only when no tick ran it within half the shortest
  maintenance interval of the live registered workers. A worker that opts out of the registry with
  `WorkerOptions::disable_registry` does not shorten that spacing. Recovery of an expired lease can
  then take longer (SM-1167, SM-1192, migration 0061).
- Row retention lag counts from the scheduled history pass that released the row, so health no
  longer reports task records and finished results as late after every daily pass (SM-1134,
  migration 0056).
- Queue health raises `terminal-cleanup-backlog` once `terminal_cleanup_backlog_since` is older than
  its budget (SM-1178, SM-1197, migrations 0063 and 0065).
- `run_task_now_v1` reports `not_scheduled` for a blocked task instead of raising an error. A rate
  synchronization refills each changed bucket at the old rate up to one clock reading. An update
  can no longer change a dependency edge's endpoints or outcome policies (SM-1165, migration 0059).
- A full-tier task that a worker without a handler released can be canceled, and deadline recovery
  terminalizes it. Both close it like never-started work (SM-1158, migration 0057).

Dashboard, from the shared browser bundle:

- Pausing a schedule asks for confirmation, as resuming one already did (SM-1147).
- The Events pager stops at the last page the server accepts and offers older events through a
  custom range. The activity chart shows loading, error, and stale states with a Retry button
  (SM-1171).
- The Schedules page says how many schedules past the first 50 it does not show, and the System
  page lists the terminal cleanup backlog check (SM-1171, SM-1178).

### Migrations

Migration 0054 is the first since 0.6.1. The
[root changelog](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md) describes each in
full.

- **0054** adds versioned child functions and the nullable `task_child.last_seen_fence_token`
  fence marker. Older clients keep their v1 functions (SM-1106).
- **0055** reserves a retry delay of -1 in `fail_v1` and `fast_fail_v1` as the terminal failure
  override. It is the SDK compatibility floor, schema version 54 (SM-1107).
- **0056** changes `queue_health_v1` to count row retention lag from the releasing history pass
  (SM-1134).
- **0057** changes `cancel_v1` and `terminalize_deadline_v1` to close a released task like
  never-started work (SM-1158).
- **0058** lets terminal cleanup keep pace and share its batches across tiers, and adds two
  `maintenance_state` columns (SM-1160).
- **0059** closes five SQL integrity gaps. It adds `rate_limit_policy_per_key_complete_check`,
  `budget_rate_complete_check`, and a trigger that rejects a dependency edge update (SM-1165).
- **0060** judges `fast_complete_many_v1` and `fast_acknowledge_cancel_v1` at the time they act
  (SM-1163).
- **0061** adds `fast_task_outcome_failed_finished_idx`, bounds `aggregate_stats_v1`, and spaces the
  expired-lease scan in `tick_v1` with the new `maintenance_state.lease_recovery_started_at` column
  (SM-1167).
- **0062** adds `dashboard_human_wait_quick_action_v1` and bounds four dashboard read functions
  (SM-1171).
- **0063** raises the `terminal-cleanup-backlog` health reason and adds
  `terminal_cleanup_follow_up_delay_ms_v1` (SM-1178).
- **0064** disables JIT for `aggregate_stats_v1` (SM-1193).
- **0065** gives `terminal-cleanup-backlog` its own budget in `queue_health_policy`, adds
  `sync_queue_health_policy_v2`, and keeps `sync_queue_health_policy_v1` (SM-1197).

### Added

- `EnqueueClient` and the `EnqueueTransport` trait let an adapter author run enqueue, contract
  synchronization, and the compatibility check over a mutable transport, such as a borrowed
  transaction. `EnqueueQuery`, `EnqueueBind`, `EnqueueColumn`, `EnqueueColumnType`, `EnqueueValue`,
  and `EnqueueRow` describe each statement and its rows. `Error::Database` carries a driver error
  with its SQLSTATE and detail. `Queue` keeps its API
  ([ADR 0086](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0086-separate-rust-enqueue-preparation-from-mutable-transports.md),
  SM-1123).
- The optional `sqlx` feature implements `EnqueueTransport` for `sqlx::Transaction<'_, Postgres>`,
  so an enqueue commits or rolls back with the application's SQLx transaction. It pins SQLx 0.8.6
  exactly, and `examples/sqlx_transaction.rs` shows it
  ([ADR 0088](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0088-borrow-sqlx-transactions-for-rust-enqueue.md),
  SM-1124).
- `Queue::health` reports the backlog budget as `budgets.terminalCleanupBacklogMs` with schema 64,
  and `status.reasons` can carry `terminal-cleanup-backlog` (SM-1178, SM-1197).

### Fixed

- A heartbeat response applies only to the claim fence it was sent for. Before, a heartbeat round
  that returned after a durable parent suspended and resumed under a new fence could cancel the
  resumed handler. The task then waited for lease recovery (SM-1099).

### Recipes

- A batch handler example shows how batch-handler tasks are enqueued (SM-1135).

## 0.6.1 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

The crate has no changes in 0.6.1. It releases at 0.6.1 to keep one version across the
registries ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists for the Python distribution, whose 0.6.0 files on PyPI have no PEP 740
attestations.

**A 0.6.0 database needs no migration.** 0.6.1 adds no migration, so the final schema version is
**52** and the SDK compatibility floor stays at schema version **43**. An installation on 0.5
follows the [0.6.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#060--2026-10-02).

## 0.6.0 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

**Upgrade: migrate the schema before any 0.6 process starts.** The final schema version is **52**.
The SDK compatibility floor stays at schema version **43**, so a 0.5.0 process keeps working on
version 52. The migrations only add, so the upgrade is a rolling deployment. The
[root changelog](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md) lists the SQL fixes. Each takes effect when its
migration commits, and version 52 includes them all.

**An installation that runs cold export stops its exporters across migration 0052.** That migration
repairs the export ledger, but it cannot stop an upload already in flight. Upgrade in this order:

1. Stop every cold exporter, and let each finish its object and manifest uploads.
2. Keep cold export enabled, so retention keeps waiting for the export.
3. Run `workhorse schema migrate`.
4. Restart the exporters after the migration commits.

An installation that never enabled cold export needs no extra step. The
[cold export guide](https://github.com/stablemates/workhorse/blob/main/docs/guides/335-cold-export.md#a-day-is-a-utc-day) explains the repair.

**A handler result holding NUL now fails only its task.** jsonb refuses a NUL character. Such a
result used to reach the completion statement, whose refusal left the task leased until its lease
expired, and `Worker::run` returned that error at shutdown. The worker now fails the attempt under
the task's retry policy with an error named `Error` and the message `<task type> result contains a
NUL character or an unpaired surrogate, which PostgreSQL jsonb cannot store`. A Rust string cannot
hold an unpaired surrogate. On the fast tier the other members of a completion batch still
complete.

**Schedule sync now applies the current task contract.** `Queue::sync_schedules` wrote every
definition without its contract, so a fired task skipped payload validation, used the default size
limits, and exposed sensitive payload keys. It now reads each task type's current contract from
PostgreSQL before the write. A payload that fails the schema returns `Error::ContractValidation` and
writes nothing. A valid definition stores the contract version, its size limits, and its redaction
keys, as TypeScript and Go do.

**A dropped batch member no longer joins a later batch.** Dropping `Worker::run` or
`Worker::run_once` while a member waited for its batch's linger left that member in the worker's
batch coordinator. The next batch on the same worker then passed the abandoned payload to the
callback beside current members, even after recovery handed the same task out again. The callback
could repeat external effects, and the worker discarded that outcome. Dropping the execution now
removes its waiting member at once, as
[ADR 0074](../docs/decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md) promises.

**Breaking: contract schemas can no longer use `pattern` or `patternProperties`.** The SDKs' regular
expression engines accept different syntax and match differently, so one contract could validate
differently in each language.
[ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now leaves both
keywords out of the contract profile. Compiling or synchronizing the contract returns
`Error::InvalidArgument` with `<path> is outside the Workhorse contract profile` when either keyword
appears at any depth. A property named `pattern` stays valid. Check a string's shape in handler code
instead; `format` stays an annotation. A `$ref` must also point at a subschema, so it cannot reach
a schema hidden in `default` or `examples`; any other reference returns `Error::InvalidArgument`
with `<path>.$ref must point at a subschema of the contract`. That includes a pointer that encodes
`/` as `%2F`. Upgrade in this order:

1. Find each contract version that uses `pattern` or `patternProperties`, or a `$ref` that points
   outside a subschema. A version synced before the upgrade stops compiling once the SDK is
   upgraded.
2. Publish a new version without either keyword, and move `currentVersion` to it.
3. Let tasks that hold the old version finish before you upgrade workers. A worker checks a task's
   result against the version the task holds. If that version's result schema uses either keyword,
   completing the task fails the attempt with the profile error, and the task's retry policy
   applies. Each payload was checked at enqueue, so a keyword in the payload schema does not affect
   tasks already queued.

**Breaking: a contract `$ref` must be `#` or `#/$defs/<name>`, and `$anchor` is no longer
accepted.** The SDKs' JSON Schema libraries disagreed on how to decode and resolve other reference
forms, so a reference could reach a schema the profile check never saw.
[ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now names two reference forms: `#`, the root schema, and `#/$defs/<name>`, where
`<name>` is a key of the root `$defs`. Compiling or synchronizing the contract returns `Error::InvalidArgument` for any other reference, with
`<path>.$ref must point at a subschema of the contract`; for `$defs` below the root; for a `$defs`
name that does not match `^[A-Za-z_][-A-Za-z0-9._]*$`; and for `$anchor` at any depth. A property
named `$anchor` stays valid. Upgrade in this order:

1. Find each contract version that references anything other than `#` or a root definition, nests
   `$defs`, uses `$anchor`, or names a definition outside that pattern. A version synced before the
   upgrade stops compiling once the SDK is upgraded.
2. Move each referenced or anchored subschema into the root `$defs` and reference it as
   `#/$defs/<name>`. Rename each definition outside the pattern and update the references to it.
   Declare a new contract version, because contract rows are immutable, and move `currentVersion` to
   it.
3. Let tasks that hold the old version finish before you upgrade workers. A worker checks a task's
   result against the version the task holds, so a removed form in that result schema fails the
   attempt with the profile error, and the task's retry policy applies.

**The crate now depends on `jsonschema` 0.58 instead of 0.57.** An application that also depends on
`jsonschema` directly builds both versions until it moves to 0.58.

Fixes:

- Dropping the `Worker::run` or `run_once` future stops renewing its tasks' leases, so they expire
  instead. The worker's background loops and reserved heartbeat connection end with it.
- A batch callback runs inside the execution of the member that filled or lingered out the batch.
  Callbacks stay inside `concurrency`, and the shutdown drain waits for them.
- `Worker::run` fixes its shutdown deadline when shutdown starts and bounds every step by it. A
  stalled claim, registry row, or heartbeat round could hold `run` indefinitely.
- A worker with a batch handler is freed once its last handle is dropped. Dispatch after that
  rejects each member with `BatchAbandoned`.
- A batch callback that panics before returning its future fails each member with `HandlerPanic`
  and records the batch failure.
- `run_child`, `run_children`, and `run_children_all` validate each child payload and stamp the
  child type's current contract on the request.
- The worker keys its result-schema cache by task type and version. Two pairs whose names contain
  `|` could share one cached schema.
- The dashboard shows stored payloads, results, and checkpoints as stored. It used to rewrite any
  timestamp-like string to UTC.
- The orchestration example runs its child tasks on the queue its worker serves.

## 0.5.0 — 2026-09-28

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v43**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

**Breaking: a 0.4.x database upgrades offline, across one contract step.** Migration 0025 adds the
fast tier and SQL protocol version 5. It is a contract step shipped in a minor release, which
[ADR 0077](../docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md) §6
allows once. It narrows the protocol to exactly 5 and drops `fire_due_schedules_v1` and
`sync_schedule_definitions_v1` without a shim, so a 0.4.x process fails its compatibility check
against the new schema. `workhorse schema migrate` stops before a contract step. Upgrade in this
order:

1. Stop every worker and every producer.
2. Run `workhorse schema migrate`. It applies nothing past schema version 24 and reports the pending
   contract step.
3. Run `workhorse schema contract --yes`, which applies migration 0025 and leaves schema version 25.
4. Run `workhorse schema migrate` again. It applies migrations 0026 through 0044 and leaves schema
   version 43.
5. Start the processes from this release.

Every queue starts full-tier, so live tasks stay where they are and no history needs a backfill.

**Breaking: a process from this release refuses a schema below version 43.** The compatibility
floor moves from schema version 18 to 43 and the protocol floor from 1 to 5, because the SDK now
calls functions that migrations up to 0044 add.

**Add a fast task tier.** A fast-tier queue records one `fast_task_outcome` row per task instead of
the attempt and event history, and completes a batch and claims its refill in one statement. It
refuses dependencies, child tasks, concurrency keys, budgets, debounce, throttle, and concurrency or
rate-limit policies with SQLSTATE `P1007`. A queue moves tiers only while it is empty
([ADR 0077](../docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md)).

- Add `Admin::set_queue_tier` and `Admin::set_queue_history`, with the `QueueTier` and
  `QueueHistory` types. `set_queue_history` opts a fast-tier queue into attempt or claim history.
- Return `Error::FastTierUnsupported` for a `P1007` refusal, naming the queue, the feature, and the
  batch ordinal.
- Batch fast-tier completions with a fused refill claim. `WorkerOptions::cohorts` splits the slots
  into fixed shares that each complete and claim together. The default is 1 below a concurrency of 8
  and otherwise one cohort per eight slots, between 2 and 8, capped by the pool's spare connections.
- Govern the crate's public API as a checked surface, recorded in `api/rust.txt`
  ([ADR 0079](../docs/decisions/0079-govern-the-rust-api-as-an-eighth-surface.md)).
- Keep overlapping batched claims in flight, so a worker fills free slots while a claim is still
  running
  ([ADR 0076](../docs/decisions/0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md)).
- Skip the notification claim delay while claims keep finding work.
- Resend a fenced write and the concurrency policy sync when PostgreSQL chooses them as a deadlock
  victim, up to three attempts. Inside a caller's transaction the original deadlock error is raised.
- Claim policy- and rate-limited tasks as a set, and shard the admission counters so claims on a
  governed queue no longer serialize
  ([ADR 0082](../docs/decisions/0082-shard-the-admission-counters.md)). A plain full-tier claim
  also costs less.
- Release dependents through a pending-prerequisite counter, and settle a parent whose child is
  already terminal when it is created. Migration 0032 repairs parents an earlier release left
  waiting. A full-tier enqueue batch with several invalid members can report a different member's
  error than before.
- Release a fused claim's row locks before they can deadlock
  ([ADR 0081](../docs/decisions/0081-release-a-fused-claim-lock-before-it-can-deadlock.md)).
- Add a Tier column to the embedded dashboard Queues page, and link a schedule's tasks to that
  schedule's queue on the Schedules page.

## 0.4.0 — 2026-09-23

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v18**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

**This is the first published `workhorse` crate.** Crates.io held only a `0.0.0` placeholder that
reserved the name. Add the crate with `cargo add workhorse`, and install or migrate the schema
with the schema tool of the same release. The crate never installs or migrates the schema itself.
[ADR 0074](../docs/decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md) shapes it as
one crate that follows the Python SDK's surface on Tokio.

- Add `Queue`, which enqueues, cancels, and signals tasks and synchronizes schedules, policies,
  budgets, and contracts. `Queue::new` accepts a `tokio_postgres` or `deadpool_postgres` client,
  pool, or transaction, and a caller's transaction makes the enqueue part of its commit.
- Add `Admin`, the operator client that lists, inspects, and repairs tasks, dead letters, waits,
  workers, and queues.
- Add `Worker`, which takes a `deadpool_postgres::Pool`, registers typed handlers by task type, and
  runs them under a lease. `run_worker_process` drains it within a grace period on SIGINT or
  SIGTERM.
- Add the durable `HandlerContext`: checkpoints, durable sleeps, signal and human waits, child
  tasks, and progress. PostgreSQL owns every durable decision, and an unresolved wait suspends the
  task.
- Add the `dashboard` feature, an embedded dashboard backend served as a `tower::Service` that axum,
  hyper, or any tower host mounts under its own path. A build without the feature compiles no HTTP
  dependency.
- Emit `tracing` spans always. The `opentelemetry` feature adds metrics and trace propagation.
- Verify `Queue::assert_compatible` and `Admin::assert_compatible` against the same schema window
  the other SDKs accept. A refusal is `workhorse::Error::Compatibility`, whose `code` names the
  reason.
- Run every `protocol/v1` fixture and the shared dashboard conformance fixture through the Rust
  adapters. No fixture is listed as unsupported.
- Verify the packaged crate before it publishes. The release check builds a consumer from the
  unpacked `.crate` archive outside the workspace, and runs one task through a `Worker` against a
  scratch database. Crates.io trusted publishing publishes the crate, so the release holds no
  long-lived token.
