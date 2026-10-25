# Go changelog

`github.com/stablemates/workhorse/go` versions and release notes live here because the Go module
builds and publishes from its own tag. It carries the version the TypeScript packages, the Python
distribution, and the Rust crate carry, because every release tag names one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## Unreleased

### The Go client measures signal and human wait values as PostgreSQL does

PostgreSQL limits a signal payload, a human wait context, and a human wait result to 65,536 bytes of
`octet_length(value::jsonb::text)`. That text has a space after each `:` and `,`, so it can be
longer than compact JSON. Before this change, the Go client counted the compact JSON. A value near
the limit passed that check, and then PostgreSQL refused the statement with a database error
(SM-1639).

Now `Queue.SendSignal`, `Queue.CompleteHumanWait`, and `HandlerContext.WaitForHuman` measure the
canonical JSONB text before any statement. An oversized value raises an error. The limit does not
change.

### The worker warns when a statement waits past ShutdownGracePeriod

A maintenance pass or a claim can wait for a lock that another session holds. Before this change,
the worker logged nothing while it waited (SM-1785).

Now the worker logs `workhorse.worker.statement_slow` once, at warn level, if a maintenance pass or
a claim waits longer than the stop budget. The stop budget is `ShutdownGracePeriod`. The record
carries `workhorse.worker.id`, `workhorse.worker.statement` (`maintenance` or `claim`), and
`workhorse.worker.elapsed_ms`. `workhorse.worker.elapsed_ms` is the wait at the moment of the
warning. The statement continues to wait, and no other behavior changes.

### The worker intervals accept 100 through 2,147,483,647 ms

`register_worker_v1` takes `MaintenanceInterval`, `MaintenanceRoutineInterval`, and
`RegistryInterval` as PostgreSQL `integer` milliseconds, and the registry refuses a value below 100. Before this change, `NewWorker` accepted a tick or routine interval from 1 ms. The worker ran
at that cadence but wrote 100 ms to the registry. It also accepted a value above 2,147,483,647 ms,
and then each registration failed (SM-1668).

Now `NewWorker` returns an error if one of these intervals is not a whole number of milliseconds
from 100 ms through 2,147,483,647 ms. Zero still selects the default, and `DisableRegistry` still
turns off registration. This is a behavior change for a caller who passes such a value. ADR 0112
records the range for all seven SDKs.

### RetryDelay refuses a duration outside the fail_v1 range

`fail_v1` takes the retry delay as a PostgreSQL `integer`. Before this change, a `RetryDelay`
callback that returned a negative duration gave no override, so the persisted policy applied. A
duration above 2,147,483,647 ms reached `fail_v1`, and the failure write failed. The worker also
truncated a fraction of a millisecond (SM-1668).

Now the worker rounds the duration to the nearest millisecond, half up. A negative duration, or one
that rounds above 2,147,483,647 ms, is an error before `fail_v1`, and `Run` returns it. ADR 0111
records the rule for all seven SDKs.

### A panic in OnRegistrationError no longer stops the worker

An application can give `OnRegistrationError` to the worker to send an alert. Before this change,
a registration refresh could fail, and then the callback could panic. The panic left the registry
path and could end the process. A registration failure must never stop a worker (SM-1696).

Now the worker recovers the panic and continues. It logs the failure through `Logger` at the error
level. It logs the first failure. Then it logs at most one failure in each 60 s, with the count of
the failures that it did not log. It never calls the failed callback for its own failure.

### Workers use the database clock for maintenance

Maintenance writes shared state: the due time of each routine and the retention cutoffs. Before
this change, the Go worker sent its host clock as the maintenance time. If that clock was two days
fast, other workers skipped a routine until that future time. Retention also deleted a 13-day-old
schedule occurrence under a 14-day policy (SM-1645).

Now `Worker.Run` and `Worker.RunOnce` bind the text `now`, and PostgreSQL resolves it to its own
time at the start of the call.

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
for new work. Before this change, the Go worker chose that wait from its configuration, not from
the state of its listener. If the listener had not run `LISTEN` yet, or reconnected after a lost
connection, nothing woke the worker. A new task then waited up to 5 s for a claim (SM-1648).

Now `Worker.Run` reads the listener state before each wait. Without a live subscription, the default
wait starts at 250 ms and doubles toward 5,000 ms after each empty claim, as in the other SDKs.
When `LISTEN` succeeds, the 5,000 ms wait applies again. An explicit `PollInterval` does not change.

When a live subscription is lost, the backoff restarts at 250 ms, because the empty claims of the
live period do not count. Before this change, a worker that was idle for some time while it
listened went to the 5,000 ms ceiling at once after a loss.

The `subscription-recovery` case in `protocol/v1/runtime.json` checks these rules in every SDK.

### A handler error with text that jsonb cannot store settles by its retry policy

PostgreSQL `jsonb` cannot store a NUL character or an unpaired surrogate. Before this change, a
handler error with such text made `fail_v1` refuse the failure envelope. The worker stopped, and the
task stayed active until lease recovery (SM-1650).

Now `handlerErrorEnvelope` replaces each NUL character and each byte that is not UTF-8 with U+FFFD.
It does this in the name, the message, and the stack. The JVM and .NET workers use the same rule.
The retry policy then settles the task. All other text does not change.

The `protocol/v1/failures.json` fixtures pin the rule for every SDK.

### Workers on one pool renew their leases in one transaction

On the dedicated heartbeat connection, a round sent one transaction for each worker and each 100
leases. Each transaction needs at least 3 round trips to PostgreSQL. With 8 workers on one pool and
80 ms for each round trip, workers lost leases while PostgreSQL still answered (SM-1631). Now the rounds that wait for the connection share one transaction, with one `heartbeat_pool_v1` statement for every worker and every 100 leases. The round that leads the transaction takes every waiting round whose deadline is not earlier than its own. The
transaction locks the task rows of every worker in it until its `COMMIT`. A round renews all of its
leases or none. The settings statement now sets `statement_timeout` and
`idle_in_transaction_session_timeout` each to one quarter of the time that remains, not to one half
and one eighth. The statement needs no schema change. The `SharedHeartbeats` opt-out does not change (SM-1633).

### A handler can receive a typed payload

Before this release, a Go handler received its payload as `any`. A handler that read a field used a
chain of type assertions, each with its own error branch. Now `workhorse.Typed[P]` adapts a handler
that takes its payload as `P` to a `Handler`, so `Worker.Handle` does not change (SM-1218).

```go
worker.Handle("email.welcome", workhorse.Typed(func(
	_ context.Context, message welcome, _ *workhorse.HandlerContext,
) (any, error) {
	return map[string]any{"deliveredTo": message.To}, nil
}))
```

The adapter decodes the payload with `encoding/json`. A field that the payload omits keeps its zero
value, so use a payload contract to require a field. If the payload does not decode into `P`, the
handler does not run, and the attempt fails under the retry policy of the task.

`workhorse.DecodeValue[T]` decodes a checkpoint result, a signal payload, or a human wait response
into `T` with the same rules. These operations return decoded JSON, so a checkpoint whose operation
returns a struct gives back a map, and `DecodeValue` turns it into the struct again.

**Behavior change.** A payload that the worker cannot decode now fails its attempt with a
`*PayloadDecodeError`. Before this release, the failure envelope recorded the name `Error`. Now it
records `PayloadDecodeError`, the name the Rust SDK records. A `Typed` handler whose payload does
not fit `P` fails with the same error.

### A worker refuses to start without its heartbeat connection

**Behavior change.** Before this release, `Worker.Run` and `Worker.RunOnce` tried to reserve the
dedicated heartbeat connection for one heartbeat interval and ignored a failure. The worker then
claimed tasks that it could renew only after a later round got a connection. Now a startup
reservation failure ends a run that previously continued (ADR 0071, SM-1576).

The startup budget is the larger of `HeartbeatInterval` and 5 s. In the budget, the worker first
reserves the heartbeat connection. Then it borrows one more connection from the pool, runs the
compatibility check on it, and returns the connection at once. If either step fails, `Run` and
`RunOnce` return an error. The error names the pool, its `MaxConns`, the step, the budget, the
`SharedHeartbeats` opt-out, and the error of the last failed connection attempt. If the database
accepts connections, give the pool more connections or set `SharedHeartbeats`.

While the pool holds no heartbeat connection, the worker claims no task. The worker checks for the
connection before each claim statement, and also before a deadlock resend. A fast-tier completion
settles its task and claims no replacement. The worker asks the pool for a replacement at once. It
retries after each failure, and it waits at most one heartbeat interval between two attempts. When
the replacement arrives, the worker claims at once and does not wait for the next poll. A heartbeat
round that fails and keeps its connection does not stop claims.

One loop for each pool acquires the heartbeat connection, with one acquisition in flight. A round or
a startup that stops waiting does not end that acquisition and starts no other one. At stop, the
deregistration and the wait for the listener end by the grace period plus the 250 ms unwind window.
A worker with `SharedHeartbeats` keeps the earlier behavior: it reserves nothing and has no claim
gate.

### A new worker waits for the released heartbeat connection to return

Before this release, a pool could lend two heartbeat connections at once. Worker A released its
last hold while one of its heartbeat rounds still used the connection. Worker B then started on the
same pool and took a second heartbeat connection before the round returned the first. A connection
that arrived for A after A released could also overlap a new one for B.

Now the heartbeat connection of a pool has one owner until it settles. It settles when its last
round has ended and the pool no longer counts its connections. This includes a connection that
arrived after the release. A new worker on that pool acquires its heartbeat connection only after
that. The notification listener already waits for its predecessor the same way (SM-1579).

**Behavior change.** When the last worker on a pool releases the heartbeat connection, the worker
now closes that connection and removes it from the pool. Before, it returned the connection to the
pool as idle. The pool does not call `AfterRelease` for this connection. The next worker on the pool
opens a new connection or takes an idle one.

pgxpool gives back a connection on a goroutine when the pool has an `AfterRelease` hook, and it
destroys a closed or expired connection on a goroutine too. The worker cannot see when that return
ends. So the worker does what the pool's destructor does: it calls `BeforeClose`, closes the
connection within 15 s, and then removes it from the pool. It does this on a goroutine of its own,
also for a connection that a failed round discards. So a heartbeat round never waits for a close,
and the next round uses the replacement at once. A stop does not wait for the close either, so a
close can end up to 15 s after `BeforeClose` returns, after `Run` has returned.

The startup budget of the new worker bounds its wait. The round bound of the released worker bounds
the round (ADR 0071), and the close of each removed connection also counts. If the connection does
not return within the budget, the new worker refuses to start. The error says that the worker waited
for the released connection. A startup that ends this way leaves no goroutine that waits for the
round.

### A stop logs the claims it still waits for at the end of the grace

A stop waits for every claim in flight, also after the shutdown grace. The worker keeps its
heartbeat connection until each claim returns, so a claim cannot lease tasks that no heartbeat
renews. If claims are still in flight when the grace ends, the worker now logs one warning, "claims
are still in flight at the end of the shutdown grace; the worker waits for them". The warning gives
the counts in `claims` and `completion_claims` (SM-1579).

### A fast-tier completion claims only for the run that started it

Before this release, a fast-tier handler could outlive a `Run` that returned
`ErrShutdownIncomplete`. If the caller then ran the same `Worker` again, that handler's completion
could reserve slots of the new run and claim tasks for them. The counters of the new run then
included a task that it did not launch.

Now each task records the run that launched it. Its completion asks only that run for replacement
tasks. A completion that outlives its run settles its task and claims nothing. It also goes in a
statement of its own, so it cannot join or fail a batch of the new run (SM-1579).

### Handlers of an ended run keep their slots in the next run

Before this release, the handlers that outlived a `Run` that returned `ErrShutdownIncomplete` still
held their slots. The next `Run` of the same `Worker` did not count them. It claimed tasks for those
slots, and then its dispatch loop waited for a slot to start the claimed tasks. During that wait the
loop did not read its context, so the stop of the new run had no deadline. The claimed leases
waited for the old handlers.

Now each run counts the handlers of an ended run against `Concurrency`. A run claims only the slots
that it can start now, so the handlers of all runs stay within `Concurrency`. When one of those
handlers returns, the dispatch loop of the new run counts the freed slot at once, without a wait
for the next poll. `RunOnce` claims nothing while those handlers hold every slot (SM-1582).

### Dependencies

- The repository now builds and checks the module with go1.26.10, because advisory GO-2026-6809 in
  `crypto/x509` is fixed there. The module still declares `go 1.25.0`, so the supported floor stays
  Go 1.25. If you build on Go 1.26.x, use go1.26.10 or newer (SM-1567).

### Throttle works on a fast-tier queue

Before this change, a throttled enqueue into a fast-tier queue raised `*FastTierUnsupportedError` with the feature
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
`dashboard_retention_preview_v1`. The Go dashboard host now calls it. The `previewRetentionPolicy` response does
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

`Worker.Run` and `Worker.RunOnce` now call `deregister_worker_v2` with the instance of the run that
stops.

Each SDK keeps its guard for this release: a new run still waits for the stop statements of the
previous run, or it refuses to start. Every SDK statement catalogue names the new function, so the
SDK compatibility floor rises from schema 75 to 76. Run `workhorse schema migrate` before the first
process of this release starts. A 0.9 process keeps working on schema 76. The migration changes no
stored data.

### The dashboard sets the tier and the history of a queue

Before this change, an operator used `Admin.SetQueueTier` or `Admin.SetQueueHistory` to change a
queue tier or the history that a fast-tier queue records. The dashboard showed these settings but
could not change them (SM-966). The Go dashboard host now answers two new mutations.

`setQueueTier` calls `Admin.SetQueueTier` with the actor that the host assigns. If the switch
succeeds, the response is `{"status":"set","tier":...}`. If `set_queue_tier_v1` refuses the switch,
the response names the guard as `live_tasks`, `concurrency_policy`, or `rate_limit_policy`, and
`tier` is `null`. The queue keeps its tier. Any other error stays an error.

`setQueueHistory` calls `Admin.SetQueueHistory`. A setting that the request omits keeps its current
value. The response gives `recordAttempts` and `recordClaims`.

Both mutations require a same-origin request. A read-only dashboard refuses them with `FORBIDDEN`.
No schema change is necessary.

## 0.9.0 — 2026-10-20

The npm packages, Python distribution, Go module, Rust crate, Ruby gem, and JVM artifacts release from one source commit.

Requires **schema v73** and Go **1.25** or newer.

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

### The retention preview counts finished fast-tier tasks

Before this release, the Go dashboard did not count a finished fast-tier task in the
`terminalTasks` count of the retention preview. Its SQL read only `workhorse.task_outcome`, and
Workhorse keeps the outcome of a fast-tier task in `workhorse.fast_task_outcome`. The dashboard now
sends the shared `retention_policy_preview` statement, which reads both tables, as the TypeScript,
Rust, Ruby, and JVM dashboards do (SM-1477).

The Go dashboard also used the current policy value when the preview set a retention setting to
`null`. A `null` setting disables its category, so the preview now counts no rows for it, as the
TypeScript, Python, Ruby, and JVM dashboards do.

### Heartbeat rounds keep a renewal margin and end on the server

Before this release, the worker bounded each heartbeat round, on the dedicated connection or under
`WorkerOptions.SharedHeartbeats`, by one full interval. After a failed round, the next round fell
due one interval after that round ended. With the defaults, one timed-out round thus left about 0 s
before the lease watchdog expired (SM-1444). Also, when the worker stopped waiting for a round,
PostgreSQL continued to run the heartbeat statement, and that statement kept its row locks
(SM-1442). These changes apply to each round, on the dedicated connection and under
`WorkerOptions.SharedHeartbeats`:

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
  one round failed. Every task continues, and the next round tries again. A deadlock (`40P01`) is
  sent again in a new transaction with the time that remains.
- **A busy retry with less than 20 ms left sends nothing** (SM-1492). A bounded busy retry runs
  only if its deadline is at least 20 ms after its start: the 8 ms that a round needs at its
  settings statement, plus a 12 ms margin. Otherwise the next regular round renews the busy leases.
- **Replacement connections.** On the dedicated connection, a failed round now opens its replacement
  connection when the round ends, so the connect starts before the next round.
- **100 ms is the smallest supported heartbeat interval** (SM-1471). This applies to
  `WorkerOptions.HeartbeatInterval`: the smallest supported value is 100 ms. At 100 ms, the round
  bound is 75 ms. The worker still accepts a shorter interval, and it does not warn. On a loaded
  host, a shorter interval can make each round miss its deadline, and attempts can then lose their
  leases.

A round under `WorkerOptions.SharedHeartbeats` acquires one pool connection for the round, and it
discards that connection if the round fails while a statement may still run. A round that expires
before its heartbeat statement returns the connection to the pool open. The [heartbeat round
deadline](../docs/architecture/lifecycle.md#heartbeat-round-deadline) and the [heartbeat
schedule](../docs/architecture/lifecycle.md#heartbeat-schedule) state each rule.

### The Admin returns UUID text for linked task IDs

Before this release, an `Admin` that used `NewPGXExecutor` returned byte lists such as
`[45 151 121 ...]` for some IDs (SM-1542). The pgx executor decodes a `uuid` column as `[16]byte`,
and the `Admin` formatted that value with `fmt.Sprint`. This applied to `PrerequisiteTaskID`,
`PrerequisiteTaskIDs`, `ParentTaskID`, and `ChildTaskIDs` from `GetTask` and `ListTasks`, and to
`WorkerRegistryEntry.InstanceID` from `ListWorkers`. The `Admin` now returns canonical UUID text
for each of these fields.

### Each heartbeat result goes to the lease that it belongs to

A new attempt of a task can register its lease before the old attempt unregisters. A heartbeat round
then sends the task twice, with two fence tokens. The Go worker read the results by task ID, so the
result of the old fence could reach the new attempt. The worker then ended an attempt whose lease
PostgreSQL had renewed (SM-1494). The worker now matches each result row to the lease that it sent,
by its position in the statement.

### A heartbeat round sends at most 100 leases in each statement

`heartbeat_many_v2` accepts at most 100 leases. A fused completion claim registers its tasks before
the completing attempts unregister, so a round can hold more leases than the concurrency limit. That
round raised an error, and no lease in it renewed (SM-1495). The worker now splits a round into
statements of at most 100 leases. If one statement fails, the round fails, as before.

### The default heartbeat interval is at least 100 ms

Before this release, the Go worker set the default heartbeat interval to lease / 3. For a lease
below 300 ms, that is below the 100 ms that every SDK supports. The default is now `max(100 ms,
lease / 3)`, as in TypeScript, Python, Ruby, and the JVM (SM-1510). A lease of 100 ms thus needs an
explicit, shorter heartbeat interval.

## 0.8.0 — 2026-10-13

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v69** and Go **1.25** or newer.

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

`Queue` gains `CreateTaskGroup`, `AddToTaskGroup`, `SealTaskGroup`, the block form `TaskGroup`,
`GetTaskGroup`, `ListTaskGroupMembers`, and `FindTaskGroup` (SM-1234). The block form creates,
adds, and seals in one statement, so in one transaction. To create a group in your own
transaction, use a `Queue` over a transaction executor. `TaskGroupCallbacks` holds the `OnFinish`,
`OnSuccess`, and `OnFailure` requests. A handler reads its group through
`HandlerContext.GetTaskGroup`, and a running member task adds tasks through
`HandlerContext.AddToTaskGroup`. If a request names no queue, `AddToTaskGroup` puts the task in the
queue of the member task (SM-1251,
[ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
`BatchHandlerContext` gains `GetTaskGroup` and `AddToTaskGroup`, which give each task in a batch the
same read and add (SM-1252). An add uses the fenced lease of that task, and a request with no queue
goes to the queue of that task. After the lease of that task ends, `AddToTaskGroup` returns a
`TaskGroupClosedError` with the reason `not_running_member`.
`Admin` gains `GetTaskGroup`, `ListTaskGroupMembers`,
`ListTaskGroupEvents`, `CancelTaskGroup`, `ListTaskGroupDrift`, and `RepairTaskGroupDrift`.
`P1008`, `P1009`, and `P1010` map to `TaskGroupClosedError`, `TaskGroupLimitExceededError`, and
`TaskGroupMembershipConflictError`, which match `ErrTaskGroupClosed`, `ErrTaskGroupLimitExceeded`,
and `ErrTaskGroupMembershipConflict`. A fast-tier member gives `FastTierUnsupportedError`.

`ListTaskGroupMembers` of `Queue` and `Admin` returns a nil `NextAfter` on the last page, also when
the page is full (SM-1277). Before, a full last page gave a `NextAfter` that read an empty page. A
full page now costs one more read of one member. `TaskGroup.Callbacks` keeps the order `OnFinish`,
`OnSuccess`, `OnFailure`, and a test now asserts it. The change adds no SQL function and no
migration.

### Checkpoint input

A checkpoint finds its stored result by name only. If a deployment changes the input of a checkpoint
operation, a replay returns the result of the old input and gives no error. A Go handler can now
give the input of a checkpoint (SM-1262,
[ADR 0098](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0098-check-the-input-of-a-checkpoint-on-replay.md)):

```go
charged, err := handler.Checkpoint("charge-card", func() (any, error) {
	return gateway.Charge(amount)
}, workhorse.CheckpointOptions{Input: map[string]any{"amountCents": amount}})
```

- `HandlerContext.Checkpoint` and `BatchHandlerContext.Checkpoint` take an optional
  `CheckpointOptions` value. If its `Input` is not nil, the checkpoint stores the fingerprint of the
  input with its value, through `save_checkpoint_v2`. A call without an input keeps its current
  behavior. Use `json.RawMessage("null")` for the JSON input null.
- If the stored checkpoint, or an overlapping call with the same name, has the fingerprint of a
  different input, the call returns `*CheckpointInputConflictError`, and the operation does not
  run. If either side has no input, nothing is compared. The error carries `TaskID`,
  `CheckpointName`, `StoredFingerprint`, and `RequestedFingerprint`.
- The worker finds the error with `errors.As`, also through a wrapper, and settles it as the
  terminal replay conflict `CheckpointInputConflictError`. The task fails at once and keeps the
  current attempt.
- `CheckpointInputFingerprint(input)` returns the fingerprint: the SHA-256 digest of the RFC 8785
  canonical JSON of the input, as 64 lowercase hexadecimal characters. It gives the same digest as
  the other SDKs. `encoding/json` encodes the input first, so `MarshalJSON` methods and struct tags
  apply. Every SDK refuses the same inputs (SM-1274). A non-finite number, a number larger than
  2^53 - 1 in magnitude, or a string or key with invalid UTF-8 or a lone surrogate escape returns an
  error that wraps the new
  `ErrInvalidCheckpointInput`. `encoding/json` writes invalid UTF-8 as the escape `\ufffd`, so a
  `MarshalJSON` method or a `json.RawMessage` that writes U+FFFD as an escape, in either case, is
  refused too.
- `TaskCheckpoint` gains `InputFingerprint`, the stored fingerprint or nil.
- The `Checkpoint` methods now take a variadic `options ...CheckpointOptions` parameter. A call
  does not change, but a function value of the old method type must change its type.

### Behaviour changes

- If a child task request names no queue, `HandlerContext.RunChild`, `RunChildren`, and
  `RunChildrenAll` put the child in the queue of the parent task (SM-1260,
  [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
  Before, the child went to the queue `default`. If no worker served `default`, the child stayed
  `ready`, and the parent task did not continue. To keep the old queue, name it on the request, for
  example `EnqueueOptions{Queue: "default"}`.
  A parent task that created a child before the upgrade can replay that request after the upgrade.
  If the replayed request names no queue, it keeps the queue of the stored child, so the parent
  task joins its child.
- `Worker.RunOnce` does not change: a pass that released every task that it claimed returns
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
- The dashboard handler refuses a mutation whose `audit.requestId` is more than 512 UTF-8 bytes
  with `BAD_REQUEST`, before any SQL runs (SM-1253). It measures the value as sent, before trim.
  Before, the SQL audit function refused the value, and the client got an internal server error.
- The generated `dashboard.DashboardRuntimeConfig` gains the optional field `WorkhorseRevision`
  (SM-1215). The TypeScript dashboard host sets it to show the source commit beside the version.
  The Go dashboard does not set it, so it shows the dashboard as before.

## 0.7.1 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54** and Go **1.25** or newer.

The Go module has no changes in 0.7.1. It releases at 0.7.1 to keep one version across the
registries ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists because the npm publish of 0.7.0 stopped partway.
The Go module never published at 0.7.0, so 0.7.1 is the first release with the 0.7.0 changes below.

**A 0.7.0 database needs no migration.** 0.7.1 adds no migration, so the final schema version is
**64** and the SDK compatibility floor stays at schema version **54**. An installation on 0.6
follows the [0.7.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#070--2026-10-09).

## 0.7.0 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54** and Go **1.25** or newer.

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

- `dashboard.HandlerOptions.AuditActor` is removed. It replaced the verified principal's actor on
  every mutation, so a dashboard could record a service name instead of the operator who acted. The
  dashboard now always records `Authorization.Principal.Actor`, as the `dashboard/v1` protocol
  requires. Delete the field from your options. To record a fixed actor, return a `Principal` with
  that `Actor` from `Authorize` (SM-1152).
- **`dashboard/v1`:** `dashboard.DashboardTaskRow.HumanWait` changes from
  `*DashboardHumanWaitSummary` to `*DashboardTaskRowHumanWait`, which carries `QuickAction` instead
  of `Context`. The break is taken in place under the ADR 0064 exception in
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
- A renamed individual child on replay returns `ChildConflictError` with the stored and requested
  names, and the error carries `StoredChildName`. Before, it returned a child-limit error. A second
  child after joining the retained child in the same handler run still exceeds the child limit
  (SM-1106, migration 0054).
- A handler that returns an error after its shutdown cancellation no longer charges an attempt. The
  worker hands its task to `release_owned_v1` within the 250 ms unwind period. Before, the worker
  left the task unsettled, and lease recovery charged the attempt as `lease_expired`. A task on its
  last attempt then failed because its worker stopped. A handler panic keeps its usual settlement
  (SM-1164).
- A handler that returns a value after its shutdown cancellation completes its task, as a Rust
  handler does. Before, lease recovery charged the attempt, so the task ran again or failed on its
  last attempt although its handler succeeded. The worker writes the fenced completion within the
  250 ms unwind period. When a cancellation request or an expiry rejects that write, the worker
  acknowledges or settles it (SM-1187).
- When a shutdown release or completion still fails, the worker logs
  `Shutdown settlement failed; lease recovery will settle the task`, and lease recovery settles the
  task as before (SM-1164, SM-1187).
- The `workhorse.handler` span descends only from the task's stored trace context. A task without
  one starts a new trace instead of joining a span carried by the worker's context. The handler
  context still carries that context's cancellation and values (SM-1176).

Dashboard host:

- The dashboard handler answers an unexpected schema-compatibility failure with a generic `503`. It
  logs the cause through the default `slog` logger instead of returning the driver error text
  (SM-1168).

Maintenance, health, and administration, from the SQL changes:

- Terminal cleanup repeats its batch while each one fills, for up to one second per pass. A pass
  that still ends with a full batch makes its follow-up due five seconds later. Full-tier and
  fast-tier tasks share every batch (SM-1160, migration 0058).
- `tick_v1` runs the expired-lease scan only when no tick ran it within half the shortest
  maintenance interval of the live registered workers. A worker that opts out of the registry with
  `WorkerOptions.DisableRegistry` does not shorten that spacing. Recovery of an expired lease can
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

- `Queue.Health` reports the backlog budget as `budgets.terminalCleanupBacklogMs` with schema 64,
  and `status.reasons` can carry `terminal-cleanup-backlog` (SM-1178, SM-1197).

### Dependencies

- The repository now builds and checks the module with go1.26.9, because seven standard library
  advisories in `net/http`, `mime/multipart`, and `crypto/tls` are fixed only there. The module
  still declares `go 1.25.0`, so the supported floor stays Go 1.25. If you build on Go 1.25.x, take
  the next 1.25 security release when Go publishes one (SM-1206).
- `golang.org/x/text` moves to v0.41.0 for advisory GO-2026-6629, and `golang.org/x/sync` moves to
  v0.22.0 with it (SM-1198).
- The module now requires Bun 1.3.0, GORM 1.31.2, GORM's PostgreSQL driver 1.6.3, sqlx 1.4.0, and
  `github.com/google/uuid` 1.6.0 directly, for its tested examples. Minimum version selection raises
  an application's own requirement on any of them to at least that version (SM-1112, SM-1113,
  SM-1115).

### Recipes

- New tested recipes: transactional enqueue through GORM and the Go SQL executor (SM-1112), through
  Bun on `database/sql` (SM-1113), and through sqlc and sqlx (SM-1115).

## 0.6.1 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43** and Go **1.25** or newer.

The Go module has no changes in 0.6.1. It releases at 0.6.1 to keep one version across the
registries ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists for the Python distribution, whose 0.6.0 files on PyPI have no PEP 740
attestations.

**A 0.6.0 database needs no migration.** 0.6.1 adds no migration, so the final schema version is
**52** and the SDK compatibility floor stays at schema version **43**. An installation on 0.5
follows the [0.6.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#060--2026-10-02).

## 0.6.0 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43** and Go **1.25** or newer.

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

**A handler result PostgreSQL cannot store now fails only its task.** jsonb refuses a NUL character
and an unpaired surrogate. Such a result used to reach the completion statement, whose refusal
ended `Worker.Run` and left the task leased. The worker now fails the attempt under the task's retry
policy with an error named `Error` and the message `<task type> result contains a NUL character or
an unpaired surrogate, which PostgreSQL jsonb cannot store`. On the fast tier the other members of
a completion batch still complete. A database error during completion still ends `Worker.Run`.

**Breaking: contract schemas can no longer use `pattern` or `patternProperties`.** The SDKs' regular
expression engines accept different syntax and match differently, so one contract could validate
differently in each language.
[ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now leaves both
keywords out of the contract profile. Compiling or synchronizing the contract returns an error with
`<path> is outside the Workhorse contract profile` when either keyword appears at any depth. A
property named `pattern` stays valid. Check a string's shape in handler code instead; `format` stays
an annotation. A `$ref` must also point at a subschema, so it cannot reach a schema hidden in
`default` or `examples`; every SDK rejects any other reference with
`<path>.$ref must point at a subschema of the contract`. That includes a pointer that encodes
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
`<name>` is a key of the root `$defs`. Compiling or synchronizing the contract returns an error for any other reference, with
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

Fixes:

- A handler result over the task's result size limit fails the attempt with
  `TaskValueSizeLimitError` under the task's retry policy. It used to end `Worker.Run`. On the fast
  tier, an oversized result never joins a completion batch.
- The worker keeps renewing a task's lease until the final fenced transition is written. A slow
  completion could let a peer recover and rerun the task.
- `ShutdownGracePeriod` starts when `Run` observes its context end, and it bounds the in-flight
  claim and the draining registration refresh. `Run` could wait forever on a saturated pool.
- `Queue.SyncSchedules` applies each task type's current contract. A payload the schema rejects
  returns `TaskContractValidationError` and writes nothing.
- `RunChild`, `RunChildren`, and `RunChildrenAll` validate each child payload and stamp the child
  type's current contract on the request.
- A checkpoint operation that panics releases the duplicates waiting on it with an error. A
  duplicate also returns once the handler context ends.
- A `RunOnce` canceled while it waits behind an active invocation no longer releases that
  invocation's heartbeat connection.
- Workers on one pool share one notification listener connection.
- An enqueue whose cached contract rejects the payload reloads the definition once and validates
  again. Later requests of that type in the same enqueue use the definition it read.
- The dashboard shows stored payloads, results, and checkpoints as stored. It used to rewrite any
  timestamp-like string to UTC.
- Under `NewSQLExecutor`, `signalTask` and `completeHumanWait` return the retained JSON as JSON
  rather than base64.
- The transactional enqueue example rolls back when any step fails.

## 0.5.0 — 2026-09-28

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v43** and Go **1.25** or newer.

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

- Add `Admin.SetQueueTier` and `Admin.SetQueueHistory`, with the `QueueTier` and `QueueHistory`
  types. `SetQueueHistory` opts a fast-tier queue into attempt or claim history.
- Return `FastTierUnsupportedError` for a `P1007` refusal, naming the queue, the feature, and the
  batch ordinal. It matches `ErrFastTierUnsupported` under `errors.Is`.
- Batch fast-tier completions with a fused refill claim. `WorkerOptions.Cohorts` splits the slots
  into fixed shares that each complete and claim together. The default is 1 below a concurrency of 8
  and otherwise one cohort per eight slots, between 2 and 8, capped by the pool's spare connections.
- Keep the worker running when a task's payload is a JSON string. The payload used to be decoded
  twice, and the error ended `Run` and stranded the lease.
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

Requires **schema v18** and Go **1.25** or newer.

**A 0.3.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migration 0024 and leaves the installation at
schema version 24. The step is additive: it replaces one read function. No table changes, no
database is dropped, and no data is lost. The compatibility floor stays at version 18.

- Measure row retention lag against the history gate the prune applies. `prune_terminal_tasks_v1`
  keeps a terminal task until daily history retention passes its `history_through_at`, but queue
  health counted a row held only by that gate as lag. The measured lag climbed toward a day between
  history passes, so health read Degraded for most of every day. Migration 0024 replaces
  `queue_health_v1` so both eligible boundaries apply the prune's predicate. A history pass that
  stops advancing still shows as task event and attempt history lag.
- Fit the embedded dashboard Workers table on a laptop viewport without horizontal scrolling. Schedules
  become a calendar icon with a hover card, the Paused badge moves to the placement line, queues
  stack one per line, and a long worker name is truncated in the middle with the full name on hover.

## 0.3.0 — 2026-09-21

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v18** and Go **1.25** or newer.

**A Go worker behaves differently after this upgrade even when it configures nothing.** Four runtime
defaults move to the values the TypeScript and Python workers publish, and the shutdown path gains
an outcome it did not have
([ADR 0072](../docs/decisions/0072-converge-the-worker-runtime-defaults.md)). Read this list before
upgrading a deployment that relies on the current numbers.

- **Idle claim polling drops from a flat 1000 ms.** A worker whose `LISTEN` subscription is live now
  waits the 5000 ms ceiling between empty claims, and a worker that cannot subscribe starts at
  250 ms and backs off exponentially toward that same ceiling. In the subscribed shape most
  installations run, a worker sends about a fifth of the idle claim traffic it used to.
- **Shutdown grace tightens from 30 s to 25 s.** The old value equalled the default
  `terminationGracePeriodSeconds` of a Kubernetes pod, so it was the value most likely to be cut off
  mid-drain. A caller that needs the old window sets `WorkerOptions.ShutdownGracePeriod`.
- **`Run` returns `ErrShutdownIncomplete` where it previously hung forever.** A handler that ignored
  its context used to block `Run` until the platform sent `SIGKILL`. `Run` now cancels the handlers
  that outlive the grace period, gives them one bounded window to unwind, stops renewing their
  leases, and returns. PostgreSQL recovers those tasks when the leases expire. The abandoned
  goroutines may still use the pool, so a caller that receives this error should end the process
  rather than close the pool and carry on.
- **The slow maintenance routines are offered once a minute, not on every one-second tick.** That
  restores the cadence [ADR 0011](../docs/decisions/0011-daily-retention-and-split-maintenance.md)
  decided: PostgreSQL owns the global due decision, so a worker was sending sixty times the intended
  rate of `run_maintenance` calls. `WorkerOptions.MaintenanceRoutineInterval` gates it.

**A 0.2.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migrations 0010 through 0023 and leaves the
installation at schema version 23. Every step is additive: it replaces read and transition functions
or adds one, and 0023 also releases the dependency edges a cancellation abandoned. No table changes,
no database is dropped, and no data is lost.

**A process from this release refuses a schema below version 18.** The compatibility gate's floor is
now derived from the newest function the SDKs call, rather than held at 1 by hand. A lagging
installation is refused at startup instead of failing on its first dashboard read, after the process
has taken work.

**0.1.x support is dropped.** The migration chain now starts at the 0.2.0 baseline, schema version 6
([ADR 0073](../docs/decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)). Workhorse
0.2.1 is the last release that migrates a database below the baseline: reach the baseline with
0.2.1, then upgrade to this release. The refusal names it.

- Refuse to start a worker whose pool cannot lend a dedicated heartbeat connection. `NewWorker`
  needs a known capacity of at least 3, for the listener, the heartbeat connection, and one
  statement. It names the capacity it found, the capacity it needs, and the opt-out.
  `WorkerOptions.SharedHeartbeats` takes heartbeat rounds back to the shared pool
  ([ADR 0071](../docs/decisions/0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md)).
- Add `WorkerOptions.RetryDelay`, so a caller can shape one failed attempt's delay without
  persisting a retry policy.
- Name a failure the way the other two SDKs name it. A worker reads a name through `ErrorNamer`,
  falls back to an exported concrete type, and defaults to `Error`; it reads an optional stack
  through `ErrorStacker` and records null when the error supplies none. `errors.As` walks the chain,
  and a recovered panic becomes a `HandlerPanicError` carrying the stack captured at recovery.
  Every `errors.New` value used to file under `*errors.errorString`, so one failure mode split
  across dashboard buckets that mean nothing.
- Release a task whose type the worker has no handler for, instead of failing it.
  `release_owned_v1` returns the claim to its queue with the attempt intact and appends a `released`
  event. During a rolling deployment the old release no longer spends the retry budget of a type
  only the new release runs.
- Report a pass that only released a claim as unprocessed. `RunOnce` used to report it as progress,
  so a caller looping it claimed and released the same task without waiting.
- Keep a worker running through a lease loss and a maintenance phase error, and log by default. A
  slow expiry no longer stalls the heartbeats of the other tasks claimed in the same pass.
- Stop a worker whose claim fails without returning a task, and run the tasks claimed before it.
- Cache the compatibility check and the contract definitions in the producer.
- Never skip a busy schedule occurrence, and read the evaluation instant from the database clock.
- Release a canceled dependent's incoming dependency edges, which used to hold a prerequisite's
  identity against retention.
- Lock only the row a claim takes, and skip the enqueue dependency block for a request that declares
  no prerequisite.
- Require pgx 5.11.0, raised from 5.9.2, and OpenTelemetry Go 1.46.0, raised from 1.45.0.

## 0.2.1 — 2026-09-18

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

**A 0.2.0 database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migrations 0007 through 0009 and leaves the
installation at schema version 9. The migrations change read functions and no table. No database is
dropped and no data is lost.

- Prune the dashboard task lists on the task table's indexes. A list filtered by a tag, a queue, or
  a task type seeks that index before it reads the runtime and outcome projections, and an
  unfiltered list no longer joins every task back to itself.
- Stop compiling the queue health snapshot with JIT on every call. Past a few thousand ready tasks,
  compilation cost about two seconds for a statement that executes in tens of milliseconds.
- Release a pinned task page in the dashboard. While a pager click holds the list on an older
  page, auto refresh pauses and says why, and a first-page control returns to the live list with
  every filter kept.
- Require OpenTelemetry Go 1.45.0, raised from 1.43.0.

## 0.2.0 — 2026-09-17

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

**A 0.1.5 database upgrades in place.** This is the first release that ships migrations. Run
`workhorse schema migrate` from a deployment step before any process from this release starts. It
applies migrations 0002 through 0006 and leaves the installation at schema version 6. No database is
dropped and no data is lost.

- Add named budgets that span queues. `Queue.SyncBudgets` declares a namespace of budgets,
  `Queue.ListBudgets` reads them, and an enqueue names one through `Budget`. A budget caps the
  unexpired active tasks that name it, refills one shared token bucket, or does both.
- Skip missed schedule occurrences by default. A schedule definition carries a `CatchupPolicy` of
  `ScheduleCatchupSkip`, `ScheduleCatchupLatest`, or `ScheduleCatchupAll`. A schedule that a paused
  deployment left behind no longer enqueues every occurrence it missed. Existing schedules take
  `ScheduleCatchupSkip`.
- Look each contracted task type up once per enqueue batch instead of once per row, trim the
  heartbeat fan-out, the child-set decode, and the hostname lookup, and build worker log attributes
  only when a logger is enabled.
- Leave promotion to the maintenance tick on the claim path, so a claim no longer pays for promotion
  work on every call.
- Bound every dashboard read procedure to the page it returns. `DashboardTaskRow` drops `DeadlineAt`
  and `ExecutionTimeoutMs`, a task detail's `Current` drops its duplicate `Result`, and each
  checkpoint carries `ValueBytes` and `ValueOmitted`.
- Document two tenancy tiers. One database per tenant is the boundary Workhorse enforces; a shared
  database carries the tenant on the concurrency key, a budget, and a tag.

## 0.1.5 — 2026-09-14

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

**A 0.1.4 database must be dropped and reinstalled.** This release re-cuts schema v1 to separate
deployment-owned schedule activation from durable operator pauses and to retain maintenance-run
history; no migration exists between 0.1.4 and 0.1.5.

- Preserve operator schedule pauses across deployment synchronization, removal, and re-addition,
  and expose the configured, paused, and effective states through the dashboard bindings.
- Record recent maintenance executions with phase timings, errors, and affected-row counts. The
  shared dashboard shows those runs and supports exact event time ranges.
- Use opaque, versioned task cursor URLs while continuing to accept old JSON cursors, and link task
  menus directly to scoped event history.
- Report the Go module version from the dashboard host instead of baking a version into the shared
  browser bundle.
- Update the OpenTelemetry dependencies to their current supported releases.

## 0.1.4 — 2026-09-11

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

**A 0.1.x database must be dropped and reinstalled.** This release renames the unit of work from
"job" to "task" on every surface and re-cuts the schema baseline in place; no migration exists
between 0.1.3 and 0.1.4 ([ADR 0064](../docs/decisions/0064-rename-the-unit-noun-from-job-to-task.md)).

- Rename every `Job*` identifier to its `Task` spelling: `ClaimedJob` is `ClaimedTask`,
  `HandlerContext.Job` is `HandlerContext.Task`, `ChildJobRequest` is `ChildTaskRequest`,
  `PrerequisiteJobIDs` is `PrerequisiteTaskIDs`, and `GetJob`, `ListJobs`, and `GetJobTimeline`
  are `GetTask`, `ListTasks`, and `GetTaskTimeline`. `api/go.txt` lists every removed name.
- Remove the pre-rename aliases `AssertCompatible`, `CreateChild`, `CreateChildren`, and
  `CreateChildrenAll` that `go/deprecated.go` carried.
- Rename the schema, the `workhorse_jobs` notification channel (now `workhorse_tasks`), and the
  substituted error name `RedactedJobError` (now `RedactedTaskError`).
- Rename the OpenTelemetry names from `workhorse.jobs.*` and `workhorse.job.*` to
  `workhorse.tasks.*` and `workhorse.task.*`, with the `{task}` unit.
- Rename the `dashboard/v1` bindings: `JobDetail` becomes `TaskDetail` and every `Job*` field
  becomes `Task*`; `MaintenanceTaskPollMs` becomes `MaintenanceRoutinePollMs` and the cron page
  lists `Maintenance.Routines`.

## 0.1.3 — 2026-09-10

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

- Improve task and event tables with readable status labels, compact columns, full hover text,
  and task ID copy controls.
- Add worker and search filters to Events, and show task tags and accepted enqueue modes in details.
- Share task actions between listings and details, with cancellation confirmation and an optional reason.
- Keep task menus responsive on long pages and reset pagination when selecting a task view in the sidebar.
- Remember chart visibility and task drawer width, and clarify rate-limit labels on Queues.

## 0.1.2 — 2026-09-10

Published to the Go module proxy from one source commit shared with the npm packages and the Python
distribution, tagged `go/v0.1.2`. Workhorse stays a public beta on the `0.x` line.

Requires **schema v1** and Go **1.25** or newer.

**Upgrading from `0.1.0` means you recreate the database.** The clean-install baseline was re-cut
so that schema version 1 installs the corrected statistics functions. A `0.1.0` database still
reports version 1 and passes `assertSchemaCompatible`, yet holds the uncorrected ones, and no
migration carries it forward. Recreate the database, or keep running `0.1.0`.

**`0.1.1` was a stopped train and its number is spent.** Its npm stage failed before it wrote
anything: `npm publish --provenance` is rejected from a runner npm reads as `self-hosted`, which is
how it classifies the Depot runners every job used. Nothing reached npm and the Go tag was never
pushed, so `0.1.1` exists only on PyPI, where the distribution is complete and not defective.
`0.1.2` carries the identical content to all three registries and supersedes it. Nothing on npm
needs deprecating, because nothing was published there.

- Add cursor task browsing through `tasksCursor`, with optional exact totals and backward navigation.
- Read system statistics once per response, sharing the live history tail across dashboard panels.
- Coalesce dashboard refreshes and reuse validated full builds across repository smoke checks.
- Anchor every statistics bucket on UTC, so day and hour boundaries no longer follow the
  database's timezone setting.
- Publish npm packages from a GitHub-hosted runner, which is the only environment npm accepts a
  provenance attestation from.

## 0.1.0 — 2026-09-04

Published through the Go module proxy from one source commit shared with the npm packages and the
Python distribution, tagged `go/v0.1.0`. This is the first version without a prerelease suffix
([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)). The module stays
a public beta on the `0.x` line.

Requires **schema v1** and Go **1.25** or newer.

### Removed

- `AdminJobProgress` is gone. It was field-identical to `JobProgress`, which the worker's
  `HandlerContext` already returns, so `Admin.GetProgress` and `JobSnapshot.Progress` now return
  `*JobProgress`. A caller that named the type replaces the name; the fields are unchanged.
- `dashboard.HandlerOptions.SkipCompatibilityCheck` is gone. It existed for this repository's
  transport tests, whose executor cannot reach PostgreSQL, and those tests now use an unexported
  constructor. Every `dashboard.NewHandler` caller runs the schema compatibility check.
- `dashboard.DashboardJSON`, which this release had already renamed from `dashboard.JSON`, is gone
  entirely. `type DashboardJSON any` named nothing that `any` does not, so the generated bindings
  now spell an arbitrary JSON value `any` in `DashboardCompleteHumanWaitResult.Result`,
  `DashboardSignalTaskResult.Payload`, `SignalTaskInput.Payload`, and
  `CompleteHumanWaitInput.Result`. The field types are identical; only the spelling changed.
  Python keeps its `DashboardJSON`, which is a recursive union Go does not need.
- `dashboard.NormalizePath` is unexported. It had one caller, inside the package.

### Changed

- **`CheckCompatibility` takes the protocol versions the schema declares it serves.** Its signature
  is now `func(*int, int, []int) error`. The check refused any schema newer than the version this
  build was compiled against, which would have turned the first in-place migration into an outage
  for the length of a rolling deployment. A build cannot know which later release stops serving it,
  so the ceiling comes from the database: `workhorse.protocol_version` records the SQL protocol
  versions the installed schema still serves, and a client whose protocol is absent from that list
  refuses with `SchemaTooNew` below the oldest served version and `SchemaTooOld` above the newest.
  An empty declaration enforces nothing. `AssertSchemaCompatible` reads both facts in one statement,
  so its per-call check stays one round trip.
- **Shared names for three parts of the public API.** Go was the odd language out on each one, so
  each moved to the spelling TypeScript and Python already share. `AssertCompatible` is now
  `AssertSchemaCompatible`. `HandlerContext.CreateChild`, `CreateChildren`, and `CreateChildrenAll`
  are now `RunChild`, `RunChildren`, and `RunChildrenAll`. The three `EnqueueNonReplaceableReason`
  constants now carry the enum prefix every other constant group in the package carries:
  `IncompatibleKeyMode`, `NotPending`, and `WindowElapsedPending` are now
  `NonReplaceableIncompatibleKeyMode`, `NonReplaceableNotPending`, and
  `NonReplaceableWindowElapsed`. Every old name stays in the module as a deprecated alias with the
  same behaviour and the same value, so no caller changes on this release. The aliases are removed
  in `1.0.0`.
- **`dashboard` package type names.** Every type generated from a shared `dashboard/v1` wire type
  now carries the `Dashboard` prefix, so the package no longer declares a second `CancelStatus`,
  `SignalDeliveryStatus`, and `HumanWaitCompletionStatus` beside the ones the root package already
  exports. `CancelStatus`, `SendSignalStatus`, `CompleteHumanWaitStatus`, `JSON`,
  `QueueHealthReason`, `QueueHealthReasonCode`, `RetentionPolicyImpact`, and
  `MaintenanceLoopCadences` become `DashboardCancelStatus`, `DashboardSignalDeliveryStatus`,
  `DashboardHumanWaitCompletionStatus`, `DashboardJSON`, `DashboardQueueHealthReason`,
  `DashboardQueueHealthReasonCode`, `DashboardRetentionPolicyImpact`, and
  `DashboardMaintenanceLoopCadences`. The file is generated, so it carries no aliases: a caller
  that names one of the eight updates the name. No request or response payload changes.
- The three entries above and the removals are the exported API changes since `0.1.0-beta.1`. The
  README states the unpinned install command and the schema install step, which the TypeScript CLI
  owns.
- The dashboard backend's run-now action calls the audited `workhorse.run_task_now_v1` instead of
  `workhorse.dashboard_run_task_now_v1`, which is removed from the schema. The action now records
  the authenticated actor, the reason, and the request identity in its `promoted` event, matching
  the TypeScript dashboard server.
- **Dashboard timestamps.** Every timestamp a dashboard mutation returns is now UTC with exactly
  three fractional digits, matching the TypeScript and Python backends. It was `time.RFC3339Nano`,
  which dropped a trailing zero and passed through PostgreSQL's microseconds, so this module
  answered `2026-09-02T14:30:00Z` and `...:00.123456Z` where the other two answer
  `2026-09-02T14:30:00.000Z` and `...:00.123Z`. A client that compares or displays the string sees
  a different value; one that parses it does not.

### Added

- The `dashboard` package serves `redriveTask` and `redriveDeadLetters`, which the shared
  `dashboard/v1` contract added this release. Both reach `Admin.Redrive` and `Admin.RedriveMany`: a
  source the queue does not hold answers 404, and a bulk page reports every result plus the
  continuation cursor the next page resumes from. The host lists both as mutations, so a
  cross-origin or read-only request is refused before dispatch.

### Upgrade notes

- **`CheckCompatibility` callers.** The function takes a third argument, the protocol versions the
  installed schema declares it serves. `AssertSchemaCompatible` reads them for you; a caller that
  invokes `CheckCompatibility` directly passes the list it read, or `nil` to enforce no ceiling,
  which is what an empty declaration means.
- **Schema version.** `0.1.0` stays at schema version 1, but its baseline is not the one the last
  beta installed: `workhorse.valid_tags` was renamed `workhorse.valid_tags_v1` and
  `workhorse.dashboard_run_task_now_v1` was removed. A database installed by any beta reports
  version 1 and passes the compatibility check, yet holds the old function names. You must recreate the database and
  install the new baseline with
  `npx --package @stablemates/workhorse@0.1.0 workhorse schema install`.
  This is the last release that asks for a recreation: from `0.1.0` the schema is frozen as the
  migration baseline, and later releases upgrade a database in place.

## 0.1.0-beta.1 — 2026-09-01

Published through the Go module proxy from commit `dbd5437362930f712157ffcc72c3296e971e4f5a`,
tagged `go/v0.1.0-beta.1`.

### Changed

- The module uses the Apache License, Version 2.0 from the repository root.
  Contributions require the repository `CLA.md`.

### Added

- **The Go worker records what it is.** The schema baseline carries `client_protocol_version`,
  `sdk_language`, and `sdk_version` to `workhorse.worker_registry`, and every registration refresh
  reports `go` with the new exported `workhorse.Version` and the SQL protocol version it speaks.
  The dashboard shows them per worker, and `workhorse schema status --json` counts the live workers
  by protocol so an operator can see whether a protocol is still in use before retiring it. The
  columns are nullable and the older call is retained, so a worker running an earlier release keeps
  registering during a rolling deploy.
- `workhorse.Version` names this module's published version, which the module could not report
  before because it carries no manifest of its own.
- Queue, worker, and administrative APIs implement the Workhorse SQL protocol through pgx,
  `database/sql`, caller-owned transactions, and connection pools.
- The worker supports durable batches, timers, signals, human decisions, child jobs, progress,
  checkpoints, graceful drain, and recovery after a process crash.
- Individual handler panics become recorded attempt failures without stopping the worker. Compiled
  process and external-module coverage verifies graceful signal drain, crash recovery, and the
  public worker API under the race detector.
