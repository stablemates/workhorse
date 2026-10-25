# Python changelog

`stablemates-workhorse` versions and release notes live here because the Python distribution builds
and publishes from its own tag. It carries the version the TypeScript packages, the Go module, and
the Rust crate carry, because every release tag names one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## Unreleased

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

### The worker counts each failed heartbeat round

A heartbeat round can fail before PostgreSQL returns a status for its leases, for example when the
connection closes or the round reaches its deadline. Before this change, the Python worker left no
log record and no metric for such a round (SM-1704).

Now the worker counts each failed round once in the new counter
`workhorse.worker.heartbeat.round_failure`, by the bounded attribute
`workhorse.heartbeat.failure_reason`: `timeout`, `connection`, `database`, or `other`. The
TypeScript worker uses the same counter and the same rules. A failed round still gives no ownership
verdict, so `workhorse.worker.heartbeat.failure` does not change. The new instrument is an
addition.

### A canceled task leaves its batch while it waits

A batch handler waits up to its linger for a partial batch. Before this change, a waiting task
stayed in the batch after a cancel request or a lease loss cancelled its `cancellation` token. The
batch handler then got a task that the worker no longer owned, and the task settled only after the
linger (SM-1709).

Now the worker removes such a task from the batch at once. The task raises the reason of the token,
and the batch handler never gets it. The other waiting tasks keep their order and dispatch. The
TypeScript, Go, and Rust workers already remove such a task.

### The worker waits longer after each not_due expiry answer

When the local timer of a deadline or an execution timeout fires, the worker asks PostgreSQL to
expire the attempt. If the clock of PostgreSQL has not reached its expiry, PostgreSQL answers
`not_due`. Before this change, the worker asked again every 5 ms. Each request locks the task row,
so the heartbeat of the same attempt answered `busy`. If the worker clock ran ahead by more than one
lease, the attempt could lose its lease before the database expiry (SM-1701).

Now the first retry waits 5 ms, and each later retry waits twice as long, to a maximum of 1 s. The
TypeScript, Go, and Rust workers already use this schedule.

### The Python client measures signal and human wait values as PostgreSQL does

PostgreSQL limits a signal payload, a human wait context, and a human wait result to 65,536 bytes of
`octet_length(value::jsonb::text)`. That text has a space after each `:` and `,`, so it can be
longer than compact JSON. Before this change, the Python client counted the compact JSON. A value
near the limit passed that check, and then PostgreSQL refused the statement with a database error
(SM-1639).

Now `Queue.send_signal`, `Queue.complete_human_wait`, their `AsyncQueue` forms, and `wait_for_human`
measure the canonical JSONB text before any statement. An oversized value raises `ValueError`. The
queue also checks these arguments before its compatibility probe, so an oversized value runs no
statement. The limit does not change.

### The worker warns when a maintenance pass or a claim waits longer than the stop budget

A maintenance pass or a claim can wait for a lock that another session holds. Before this change,
the worker logged nothing while it waited. A test run blocked for about one hour, and no log named
the statement (SM-1785).

Now `Worker` and `AsyncWorker` logs `workhorse.worker.statement_slow` once, at warn level, if a
maintenance pass or a claim waits longer than the stop budget. The stop budget is
max(`heartbeat_ms`, 5 s), the stop deadline. The record carries `workhorse.worker.id`,
`workhorse.worker.statement` (`maintenance` or `claim`), and `workhorse.worker.elapsed_ms`.
`workhorse.worker.elapsed_ms` is the wait at the moment of the warning. The statement continues to
wait, and no other behavior changes.

### An execution timeout of 0 enqueues a task with no timeout

**Behavior change.** Before this change, `execution_timeout_ms=0` reached `enqueue_many_v1`, and
PostgreSQL refused the enqueue. Go, Rust, Ruby, the JVM, and .NET read 0 as no timeout. Thus one
task definition succeeded in one SDK and failed in another (SM-1714).

Now `Queue`, `AsyncQueue`, and a child task request send no execution timeout for 0. The task has no
timeout, the same as `None`. A fraction or a value outside 1 through 31,536,000,000 is still
refused. ADR 0114 records the rule for all seven SDKs.

### The worker intervals refuse a value above the SQL integer limit

`register_worker_v1` takes `maintenance_interval_ms`, `maintenance_routine_poll_ms`, and
`registry_interval_ms` as PostgreSQL `integer` values. Before this change, `Worker` accepted a
larger value, and then each registration failed (SM-1668).

Now `Worker` and `AsyncWorker` raise `ValueError` at construction if one of these intervals is not
an integer from 100 through 2,147,483,647. `registry_interval_ms=0` still turns off registration.
This is a behavior change for a caller who passes a larger value. ADR 0112 records the range for
all seven SDKs.

### retry_delay_ms refuses a value above the fail_v1 range

`fail_v1` takes the retry delay as a PostgreSQL `integer`. Before this change, `Worker` accepted a
fixed `retry_delay_ms` of any size, and it did not check a fixed value at construction. A value
above 2,147,483,647 reached `fail_v1`, and the failure write failed (SM-1668).

Now `Worker` and `AsyncWorker` raise `ValueError` at construction if a fixed value is not an
integer from 0 through 2,147,483,647. If a callable returns such a value, the worker raises
`ValueError` before `fail_v1`. ADR 0111 records the rule for all seven SDKs.

### A raising reporter callback no longer stops the worker

An application can give `on_registration_error` to the worker to send an alert. Before this change,
a registration refresh could fail, and then the callback could raise. The exception left the
registry path and could stop the run. The worker also discarded a raise from
`on_notification_error` without a record (SM-1696).

Now `Worker` and `AsyncWorker` catch an `Exception` from either callback and continue. They log the
failure to the `workhorse.worker` logger at the error level. For each callback, the worker logs the
first failure. Then it logs at most one failure in each 60 s, with the count of the failures that it
did not log. It never calls the failed callback for its own failure.

### Workers use the database clock for maintenance

Maintenance writes shared state: the due time of each routine and the retention cutoffs. Before
this change, the Python worker sent its host clock as the maintenance time. If that clock was two days
fast, other workers skipped a routine until that future time. Retention also deleted a 13-day-old
schedule occurrence under a 14-day policy (SM-1645).

Now `Worker` and `AsyncWorker` over psycopg bind the text `now`, and PostgreSQL resolves it to its
own time at the start of the call. asyncpg binds only a `datetime` to a `timestamptz` parameter.
Thus `AsyncWorker.from_asyncpg` first reads the time with the internal `database_time` statement,
which adds one round trip to each routine pass.

The schema does not change.

### The dashboard names an action that the host does not provide

A dashboard host answers the `enqueueTest` and `setSchedulePaused` procedures only when the
application gives a handler for them. Before this change, a writable host without that handler
answered `FORBIDDEN` with the message "This procedure is not available". Now the message is "This
dashboard host does not provide the <action> action", as in the TypeScript dashboard server. A
read-only host keeps the message "This dashboard is read-only". The code `FORBIDDEN` and the HTTP
status 403 do not change (SM-1705).

### Admin time filters reject a naive `datetime`

`Admin.list_tasks` sent `created_after` and `created_before` with `datetime.isoformat()`. So did
`list_dead_letters` and `redrive_many` for `finished_after` and `finished_before`. If a bound was
naive, the text had no offset, and PostgreSQL read it in the session `TimeZone`. Two sessions could
then select different time ranges for the same filter (SM-1700).

Now a naive bound raises `ValueError("timestamps must include a timezone")`, as `run_at` and
`deadline` already do. The SDK does not call the SQL function. An aware bound goes to SQL as UTC
text that ends in `Z`, with microseconds.

### A lost notification subscription restarts the poll backoff

A worker without a live subscription waits 250 ms after an empty claim, and doubles that wait
toward 5,000 ms. Before this change, the empty claims of a live period counted toward that backoff.
After a loss, a worker that was idle for some time therefore waited the 5,000 ms ceiling at once,
and a new task waited up to 5 s (SM-1648).

Now the backoff restarts at 250 ms when the subscription is lost. The `subscription-recovery` case
in `protocol/v1/runtime.json` checks this rule in every SDK.

### A worker on a pool of one reserves no listener connection for its cohorts

A worker without a `cohorts` option caps its default cohort count by the connections that its pool
can lend. A pool with a maximum size of 1 lends no listener, so the worker only polls. The worker
now reserves no listener connection in that case. The cohort count does not change, because such a
pool gives one cohort in both cases. Tests now pin the count for each heartbeat configuration
(SM-1668).

### A handler error with text that jsonb cannot store settles by its retry policy

PostgreSQL `jsonb` cannot store a NUL character or an unpaired surrogate. Before this change, a
handler error with such text made `fail_v1` refuse the failure envelope. The worker stopped, and the
task stayed active until lease recovery (SM-1650).

Now `_error_envelope` replaces each NUL character and each surrogate code point outside a pair with
U+FFFD. It does this in the name, the message, and the stack. The JVM and .NET workers use the same
rule. The retry policy then settles the task. A valid surrogate pair and all other text do not
change.

The `protocol/v1/failures.json` fixtures pin the rule for every SDK.

### Workers on one pool renew their leases in one transaction

On the dedicated heartbeat connection, a round sent one transaction for each worker and each 100
leases. Each transaction needs at least 3 round trips to PostgreSQL. With 8 workers on one pool and
80 ms for each round trip, workers lost leases while PostgreSQL still answered (SM-1631). Now the rounds that wait for the connection share one transaction, with one `heartbeat_pool_v1` statement for every worker and every 100 leases. The round that leads the transaction takes every waiting round whose deadline is not earlier than its own. The
transaction locks the task rows of every worker in it until its `COMMIT`. A round renews all of its
leases or none. The settings statement now sets `statement_timeout` and
`idle_in_transaction_session_timeout` each to one quarter of the time that remains, not to one half
and one eighth. The statement needs no schema change. The `shared_heartbeats` opt-out does not change (SM-1633).

### The dashboard sets the tier and the history of a queue

Before this change, an operator could change the tier or the history settings of a queue only
through `Admin`. The Python dashboard host now answers the `setQueueTier` and `setQueueHistory`
procedures (SM-966). Both are mutations, so a read-only dashboard refuses them with `FORBIDDEN`.

`setQueueTier` calls `Admin.set_queue_tier` with the signed-in actor and answers the new tier.
If `set_queue_tier_v1` refuses the switch, the answer gives the reason as a status:
`live_tasks`, `concurrency_policy`, or `rate_limit_policy`. `setQueueHistory` calls
`Admin.set_queue_history`. It keeps a setting that the request omits, and it answers both settings.

### A worker on a pool of 1 polls under the opt-out

Before this change, a worker with `shared_heartbeats=True` started the shared listener on any pool.
On a pool of 1, the listener held the only connection. Registration, claims, and handler statements
then could not borrow a connection, and the run ended with a `TimeoutError` (SM-1585).

Now, with `shared_heartbeats=True`, the worker starts the listener only when the pool reports a
`max_size` or `get_max_size()` of at least 2. This rule applies to `Worker`,
`AsyncWorker.from_psycopg`, and `AsyncWorker.from_asyncpg`. On a pool of 1, or on a pool that
reports no size, the worker polls. Each run then logs `workhorse.worker.polling_only` once at warn
severity. The record carries `workhorse.worker.id`, `workhorse.worker.queues`, and
`workhorse.worker.pool_max_size`. Without the opt-out, nothing changes.

The worker reads the pool size at the start of each run, just before the listener subscribes. It
does not keep the size from construction. Thus, if the application resizes the pool to 1 after it
constructs the worker, the worker polls and does not start the listener (SM-1677).

### A contract compares a stored schema number with all its digits

Before this change, the Python SDK read a stored contract schema with `json.loads`, which reads a
fraction as a float. Another SDK can store `"minimum": 0.30000000000000000001`, which a float cannot
hold. The Python SDK then accepted `0.3`. Now the SDK reads the stored schema as jsonb text, and a
fraction that a float cannot hold stays a `Decimal` (SM-1541, ADR 0039). The contract keywords
compare it exactly.

### Workers on one pool share one listener and one heartbeat connection

Before this change, each Python worker took its own listener connection and its own heartbeat
connection from its pool. Several workers on one pool could hold every connection of the pool.
Claims then waited for a connection, and workers without a heartbeat connection could not renew
their leases. A stop with a full pool waited for the pool timeout, and an asyncpg acquisition had
no timeout.

Now every worker on one pool object shares one listener connection and one heartbeat connection,
as ADR 0071 requires (SM-1571). Each of the three pool types is its own domain: the psycopg
`ConnectionPool`, the psycopg `AsyncConnectionPool`, and the `asyncpg.Pool`. The worker keys the
shared connections by the pool object and holds only a weak reference to the pool. When the last worker
on the pool stops, the shared connections go back to the pool.

- **Startup.** Within max(`heartbeat_ms`, 5 s), a worker first reserves the shared heartbeat
  connection. Then it borrows one connection for the compatibility check. If either step does not
  finish in time, the worker raises `TimeoutError`, and the error names the pool, the budget, and
  `shared_heartbeats=True`.
- **No claim without a heartbeat connection.** While the pool holds no usable heartbeat connection,
  a worker claims no task, and a completion claims no next task. The worker reads this again after
  each claim borrows its connection, because the heartbeat connection can be lost during that wait.
  The worker opens the replacement at once. It retries after a backoff that starts at 100 ms and
  doubles up to `heartbeat_ms`. A random factor from 0.9 to 1.1 multiplies each wait, and then the
  worker caps the wait at `heartbeat_ms` (SM-1584). Thus no wait is longer than `heartbeat_ms`.
  When the replacement is ready, the worker claims again at once.
- **Fair heartbeat rounds.** The rounds of the workers on one pool take the shared heartbeat
  connection in arrival order. A round with less than a quarter of its time left skips, so it cannot
  expire during a statement and lose the connection for every worker.
- **Every start checks the pool.** Each run, also a later run of the same worker, borrows one
  connection for the compatibility query. One deadline bounds the reservation, the query, and the
  return of the connection.
- **Event loop.** An async worker must run on the event loop of its pool. A worker on another event
  loop raises `RuntimeError` and does not start, also before the first worker of a pool and after
  its last worker stopped.
- **Bounded waits.** Every asyncpg `acquire()` of a worker now has a timeout: 30 s for an ordinary
  statement, and less where a budget applies. A registration refresh waits at most
  max(`heartbeat_ms`, 5 s) for a connection.
- **Stop.** The first `stop()` fixes a stop deadline, max(`heartbeat_ms`, 5 s) later. Claims in
  flight, the maintenance thread, and the draining registration refresh end at that deadline.
  After the drain, deregistration waits at most 1 s for a connection. The handler drain still has
  no bound in the worker; `run_worker_process` bounds it with `shutdown_timeout_ms`. A claim that
  the deadline leaves behind can hold a lease until recovery takes the task.

**Behavior change: a startup reservation failure now ends the run.** Before this change, a worker
took its heartbeat connection only when its first task ran, and a failed reservation did not stop
the run. Now `run()` and `run_once()` raise if the worker cannot reserve the heartbeat connection
within its startup budget. A transient failure at startup can thus end a run that earlier
continued. A pool whose connections do not use `autocommit=True` now makes the worker refuse to
start at once, because the heartbeat connection requires autocommit. To keep the earlier behavior
on a small pool, set `shared_heartbeats=True`. The floor of 3 connections for each pool does not
change.

### Throttle works on a fast-tier queue

Before this change, a throttled enqueue into a fast-tier queue raised `FastTierUnsupportedError` with the feature
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
`dashboard_retention_preview_v1`. The Python dashboard host now calls it. The `previewRetentionPolicy` response does
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

`Worker` and `AsyncWorker` now call `deregister_worker_v2` with the instance of the run that stops.

Each SDK keeps its guard for this release: a new run still waits for the stop statements of the
previous run, or it refuses to start. Every SDK statement catalogue names the new function, so the
SDK compatibility floor rises from schema 75 to 76. Run `workhorse schema migrate` before the first
process of this release starts. A 0.9 process keeps working on schema 76. The migration changes no
stored data.

## 0.9.0 — 2026-10-20

The npm packages, Python distribution, Go module, Rust crate, Ruby gem, and JVM artifacts release from one source commit.

Requires **schema v73** and Python **3.12** or newer.

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

The `heartbeat_many` statement binding now names `heartbeat_many_v2`, and its rows can carry the
status `busy`. The synchronous psycopg, asynchronous psycopg, and asyncpg workers handle it.

**One-lease heartbeat without a row lock wait.** Migration 0074 adds `heartbeat_v2` (SM-1461). It
renews one lease by the rule of `heartbeat_many_v2`, so it reports a locked row as `busy`. This SDK
names it in its statement catalogue but does not call it. `heartbeat_v1` does not change.

### The retention preview counts finished fast-tier tasks

Before this release, the Python dashboard did not count a finished fast-tier task in the
`terminalTasks` count of the retention preview. Its SQL read only `workhorse.task_outcome`, and
Workhorse keeps the outcome of a fast-tier task in `workhorse.fast_task_outcome`. The dashboard now
sends the shared `retention_policy_preview` statement, which reads both tables, as the TypeScript,
Rust, Ruby, and JVM dashboards do (SM-1477).

### Heartbeat rounds get a deadline and end on the server

Before this release, a round on the dedicated heartbeat connection had no client deadline. A stalled
heartbeat statement held the heartbeat thread until the statement ended, and the next round fell due
one interval after that round ended (SM-1442, SM-1444). These changes apply to each round on the
dedicated heartbeat connection:

- **Rounds start on a fixed schedule.** A round falls due one interval after the previous round
  started, not after it ended. The schedule uses a monotonic clock. If a round ends after its next
  slot, the worker starts one overdue round at once and sends no round for the other missed slots.
- **Each round has a deadline.** A round ends by
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
- **Replacement connections.** A failed round now opens its replacement connection when the round
  ends, so the connect starts before the next round. A bounded round runs on a thread of its own, so
  the heartbeat thread stops at the deadline.
- **100 ms is the smallest supported heartbeat interval** (SM-1471). This applies to `heartbeat_ms`
  of `Worker` and `AsyncWorker`: the smallest supported value is 100. At 100 ms, the round bound is
  75 ms. The worker still accepts a shorter interval, and it does not warn. On a loaded host, a
  shorter interval can make each round miss its deadline, and attempts can then lose their leases.

Rounds under `shared_heartbeats=True` have no client deadline and set no server timeouts, as before.
They follow the new schedule. The [heartbeat round
deadline](../docs/architecture/lifecycle.md#heartbeat-round-deadline) and the [heartbeat
schedule](../docs/architecture/lifecycle.md#heartbeat-schedule) state each rule.

### A heartbeat round prepares its statements before its server timeouts start

Some drivers prepare a statement in a cycle of its own, and PostgreSQL then restarts the statement
timer. A preparation after the settings statement would thus give the heartbeat statement a full
budget after it, so the round could end on the server after its deadline (SM-1449). Thus no driver
prepares a round statement in a cycle of its own after the settings statement:

- With asyncpg, a bounded round prepares the settings statement and the heartbeat statement before
  `BEGIN`, once on each connection. It sends `BEGIN`, `COMMIT`, and `ROLLBACK` as simple queries.
- With psycopg, the synchronous and asynchronous heartbeat connections send each round statement
  with `prepare=False`. PostgreSQL then parses each statement inside its own budget.

If a preparation uses the time that remains, the round fails before it sends `BEGIN`.

### A payload contract compares the decimals of numbers

Before this release, the contract validator divided floats in `multipleOf`, so
`{"multipleOf": 0.01}` refused `1.15` (SM-1539). It also compared an int with the binary value of a
float. Thus `1152921504606846980` failed `{"maximum": 1.152921504606847e18}`, although PostgreSQL
stores the constant as `1152921504606847000`. A contract now compares the decimal that `json.dumps`
writes to PostgreSQL (ADR 0039). The validator replaces `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, `multipleOf`, `const`, `enum`, and `uniqueItems` of `Draft202012Validator`. The
public API does not change. Python still reads a stored schema constant that a double cannot hold as
a float (SM-1541).

### The `workhorse.tasks.retried` description matches `api/telemetry.txt`

The Python worker now describes `workhorse.tasks.retried` as "Failed or expired tasks returned to
live work", as the contract does (SM-1514). The counter already counted expired tasks. Only the
description changes.

### A wrapped durable replay conflict is terminal

Before this release, the Python worker checked only the outermost error for a durable replay
conflict (ADR 0098). If a handler wrapped a conflict in its own error, the worker recorded a
retryable failure, and the conflict repeated until `max_attempts` (SM-1512). The worker now follows
the cause chain of the error, as the Go and Rust workers do. It reads at most 16 errors, so a cyclic
chain cannot stop it. It reads `__cause__`, or else `__context__` if `__suppress_context__` is not
set, so an exception raised in an `except` block also counts. A wrapped conflict fails the task at
once. The failure envelope records the name of the conflict. Its fields `message` and `stack` stay
those of the outer error.

### A heartbeat round sends at most 100 leases in each statement

`heartbeat_many_v2` accepts at most 100 leases. A fused completion claim registers its tasks before
the completing attempts unregister, so a round can hold more leases than the concurrency limit. That
round raised an error, and no lease in it renewed (SM-1495). The worker now splits a round into
statements of at most 100 leases. If one statement fails, the round fails, as before.

## 0.8.0 — 2026-10-13

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v69** and Python **3.12** or newer.

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

### Task groups

The Python SDK adds task groups (SM-1233). The names follow the TypeScript SDK, in Python form.

- `Queue` and `AsyncQueue` gain `create_task_group`, `add_to_task_group`, `seal_task_group`,
  `get_task_group`, `list_task_group_members`, and `find_task_group`. Each callback is a keyword
  argument: `on_finish`, `on_success`, or `on_failure`, with an `EnqueueRequest` as its value.
- The block form `with queue.task_group(on_finish=...) as builder:` (`async with` on
  `AsyncQueue`) collects the tasks that `builder.add` receives. When the block exits without an
  error, one statement creates the group, adds the tasks, and seals the group. `builder.result`
  then holds the group and the enqueue results. If the block raises, nothing is created.
- A handler reads its group through `ctx.task_group.get()`, and a running member task adds tasks
  through `ctx.task_group.add()` under its fenced lease. If a request names no queue, `add()` puts
  the task in the queue of the member task (SM-1251,
  [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
  `AsyncHandlerContext.task_group` gives the
  same calls as coroutines. A callback handler reads the group ID and the counts through `get()`.
- `BatchHandlerContext.task_group` and `AsyncBatchHandlerContext.task_group` give each task in a
  batch the same `get()` and `add()` (SM-1252). An add uses the fenced lease of that task, and a
  request with no queue goes to the queue of that task. After the lease of that task ends, `add()`
  raises `TaskGroupClosedError` with the reason `not_running_member`.
- `Admin` and `AsyncAdmin` gain `get_task_group`, `list_task_group_members`,
  `list_task_group_events`, `cancel_task_group`, `list_task_group_drift`, and
  `repair_task_group_drift`.
- `P1008`, `P1009`, and `P1010` raise `TaskGroupClosedError`, `TaskGroupLimitExceededError`, and
  `TaskGroupMembershipConflictError`. A fast-tier member raises `FastTierUnsupportedError` with the
  feature `task groups`.
- New public types: `TaskGroup`, `TaskGroupCounts`, `TaskGroupCallback`, `TaskGroupMember`,
  `TaskGroupMemberPage`, `TaskGroupLink`, `TaskGroupEvent`, `TaskGroupBuilder`,
  `TaskGroupBlockResult`, `TaskGroupDrift`, `TaskGroupRecordedCounts`, `TaskGroupRepair`,
  `TaskGroupContext`, `AsyncTaskGroupContext`, their literal types, and the constants
  `MAX_TASK_GROUP_MEMBERS`, `MAX_TASK_GROUP_PAGE_SIZE`, and `MAX_TASK_GROUP_DRIFT_LIMIT`.
- `TaskGroup.callbacks` lists the requested callbacks in the order `on_finish`, `on_success`,
  `on_failure` (SM-1277). Before, the tuple had the key order of the PostgreSQL `jsonb` object, for
  example `on_finish`, `on_failure`, `on_success`. `list_task_group_members` of each `Queue` and
  `Admin` returns `next_after=None` on the last page, also when the page is full. Before, a full
  last page gave a `next_after` that read an empty page. A full page now costs one more read of one
  member. The change adds no SQL function and no migration.

### Checkpoint input check

A Python handler can give the input of a checkpoint (SM-1261,
[ADR 0098](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0098-check-the-input-of-a-checkpoint-on-replay.md)).

- `HandlerContext.checkpoint(name, operation, input=value)` stores the fingerprint of the input with
  the value, through `save_checkpoint_v2`. `AsyncHandlerContext`, `BatchHandlerContext`, and
  `AsyncBatchHandlerContext` take the same keyword argument. A call without `input` does not change.
- If the stored checkpoint, an overlapping call with the same name, or the `input_conflict` status
  of the save has a different fingerprint, the call raises `CheckpointInputConflictError`, and the
  operation does not run. If the call or the stored checkpoint has no input, nothing is compared.
- `CheckpointInputConflictError` is a subclass of `CheckpointConflictError`, so the worker fails the
  task at once and keeps the current attempt. It carries `task_id`, `checkpoint_name`,
  `stored_fingerprint`, and `requested_fingerprint`.
- `checkpoint_input_fingerprint(input)` returns the fingerprint: the SHA-256 digest of the RFC 8785
  canonical JSON of the input, as 64 lowercase hexadecimal characters. It gives the same digest as
  the TypeScript SDK, and every SDK refuses the same inputs (SM-1274). It raises `ValueError` for a
  non-finite number, a string with a lone surrogate, and an `int` or a `float` larger than
  2**53 - 1 in magnitude, such as `1e21`.
- `TaskCheckpoint` gains `input_fingerprint`, the stored fingerprint or `None`. The handler context
  and the `Admin` and `AsyncAdmin` reads fill it.

### Behaviour changes

- If a child task request names no queue, `run_child`, `run_children`, and `run_children_all` put
  the child in the queue of the parent task (SM-1260, [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
  `AsyncHandlerContext` does the same. Before, the child went to the queue `default`. If no worker
  served `default`, the child stayed `ready`, and the parent task did not continue. To keep the old
  queue, name it on the request, for example `EnqueueOptions(queue="default")`.
  A parent task that created a child before the upgrade can replay that request after the upgrade.
  If the replayed request names no queue, it keeps the queue of the stored child, so the parent
  task joins its child.
- `Worker.run_once()` and `AsyncWorker.run_once()` do not change: a pass that released every task
  that it claimed returns `False`, and the next call claims at once (SM-1259, [ADR 0099](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0099-report-a-released-only-single-pass-as-no-progress.md)). TypeScript
  `runOnce()` now does the same. If you call `run_once()` in a loop, wait after `False`.
- A continuous worker that released every task of a claim now waits for its next poll before it
  claims again (SM-1247). A worker releases a task when it has no handler for the task type, for
  example during a rolling deployment. Before, the release notification ended the empty wait of the
  same worker, so it claimed the task again after 0 to 50 ms. One listening worker released one task
  about 30 times each second. Now a notification does not end this release wait. Only its deadline,
  a stop, or a pause ends it. The deadline is the poll interval while the listener is active, or the
  poll backoff without a listener. Thus a worker claims a task that it cannot run at most once in
  each poll interval.
- The WSGI dashboard refuses a mutation whose `audit.requestId` is more than 512 UTF-8 bytes
  with `BAD_REQUEST`, before any SQL runs (SM-1253). It measures the value as sent, before trim.
  Before, the SQL audit function refused the value, and the client got an internal server error.
- The generated `workhorse.dashboard_v1.DashboardRuntimeConfig` gains the optional key
  `workhorseRevision` (SM-1215). The TypeScript dashboard host sets it to show the source commit
  beside the version. The Python dashboard does not set it, so it shows the dashboard as before.

## 0.7.1 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54** and Python **3.12** or newer.

The Python distribution has no changes in 0.7.1. It releases at 0.7.1 to keep one version across
the registries ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists because the npm publish of 0.7.0 stopped partway. The 0.7.0 distribution on
PyPI is not defective, and 0.7.1 supersedes it.

**A 0.7.0 database needs no migration.** 0.7.1 adds no migration, so the final schema version is
**64** and the SDK compatibility floor stays at schema version **54**. An installation on 0.6
follows the [0.7.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#070--2026-10-09).

## 0.7.0 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54** and Python **3.12** or newer.

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

- **`dashboard/v1`:** a task listing row's `humanWait` is now `DashboardTaskRowHumanWait`, which
  carries `name`, `deadlineAt`, and `quickAction` instead of `context`. `quickAction` is a
  `DashboardHumanWaitQuickActionSummary` with a `label`, or `None`. The break is taken in place
  under the ADR 0064 exception in
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
- A renamed individual child on replay raises `ChildConflictError` with the stored and requested
  names. Its constructor takes an optional `stored_child_name`. Before, it raised a child-limit
  error. A second child after joining the retained child in the same handler run still exceeds the
  child limit (SM-1106, migration 0054).
- A fatal worker error starts the `run_worker_process` deadline. Suppose PostgreSQL fails while a
  handler ignores cancellation. Before, claims stopped, but the drain waited for that handler
  without a bound, and the process never exited. The worker now reports its first claim,
  maintenance, execution, or settlement failure before it drains. The runner then starts the
  `shutdown_timeout_ms` deadline, and a missed deadline calls `force_exit(1)` (SM-1175).
- The `workhorse.handler` span descends only from the task's stored trace context. A task without
  one starts a new trace instead of joining a span active where the worker runs. A stored context is
  extracted onto an empty context (SM-1176).

Dashboard host:

- `DashboardHost(audit_actor=...)` no longer replaces the actor of a `DashboardPrincipal` that
  `authorize` returns. The dashboard records the principal's actor, as the `dashboard/v1` protocol
  requires. `audit_actor` still names the actor when `authorize` returns `True`, and defaults to
  `dashboard` there (SM-1152).
- `workhorse.dashboard.DashboardHost` escapes `<`, `>`, and `&` in the embedded runtime
  configuration, so a principal's actor cannot close its script element. It refuses an RPC body over
  2 MiB, or a malformed declared length, with `413` before parsing. An unexpected
  schema-compatibility failure answers a generic `503` and is logged on the `workhorse.dashboard`
  logger (SM-1168).

Maintenance, health, and administration, from the SQL changes:

- Terminal cleanup repeats its batch while each one fills, for up to one second per pass. A pass
  that still ends with a full batch makes its follow-up due five seconds later. Full-tier and
  fast-tier tasks share every batch (SM-1160, migration 0058).
- `tick_v1` runs the expired-lease scan only when no tick ran it within half the shortest
  maintenance interval of the live registered workers. A worker that opts out of the registry with
  `registry_interval_ms=0` does not shorten that spacing. Recovery of an expired lease can then take
  longer (SM-1167, SM-1192, migration 0061).
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

- `workhorse.django.WorkhorseTaskBackend` is a bounded Django Tasks backend. It submits allowlisted
  tasks only inside `transaction.atomic`, and runs them on a dedicated Workhorse worker through
  `bind_worker`. Its result reports initial acceptance, and it offers no result lookup.
  `workhorse.django.enqueue_in_atomic` borrows the connection of the named database's open `atomic`
  block for one enqueue.
  Install both with the new `django` extra, which requires Django 6.1
  ([ADR 0087](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0087-bounded-django-tasks-backend.md),
  SM-1119).
- `Queue.health()` reports the backlog budget as `budgets.terminalCleanupBacklogMs` with schema 64,
  and `status.reasons` can carry `terminal-cleanup-backlog` (SM-1178, SM-1197).
  `DashboardQueueHealthReasonCode` includes `terminal-cleanup-backlog`.

### Recipes

- New tested recipes: Django-owned transactional enqueue (SM-1110), async SQLAlchemy enqueue with
  its asyncpg boundaries (SM-1116), a bounded persistent LangGraph approval bridge (SM-1122), and a
  bounded PydanticAI deferred-approval flow (SM-1129). A migration overview replaces the Celery
  recipe (SM-1128, SM-1142).
- The LangGraph bridge's `stop()` records the stop as the graph outcome while the bridge is still
  preparing. Before, a task canceled before the graph saved a checkpoint raised on every reconcile
  call (SM-1170).

## 0.6.1 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43** and Python **3.12** or newer.

**Fixed: the release uploads its PEP 740 attestations again.** 0.6.0 reached PyPI without
provenance. The release workflow generated an attestation beside each distribution, but the pinned
uv 0.8.9 predates attestation upload and still exited 0. The workflow now publishes with uv 0.12.21.
Every Release Python run, dry runs included, rehearses the upload against a local endpoint first.
`pnpm release:verify python` now fails unless PyPI shows an attestation from this repository's
release workflow for every file. The 0.6.0 files are unchanged and stay without provenance.

**A 0.6.0 database needs no migration.** 0.6.1 adds no migration, so the final schema version is
**52** and the SDK compatibility floor stays at schema version **43**. An installation on 0.5
follows the [0.6.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#060--2026-10-02).

## 0.6.0 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43** and Python **3.12** or newer.

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

**Schedule sync now applies the current task contract.** `Queue.sync_schedules` and
`AsyncQueue.sync_schedules` wrote every definition without its contract, so a fired task skipped
payload validation, used the default size limits, and exposed sensitive payload keys. Both now read
each task type's current contract from PostgreSQL before the write. A payload that fails the schema
raises `TaskContractValidationError` and writes nothing. A valid definition stores the contract
version, its size limits, and its redaction keys, as TypeScript and Go do.

**A task's lease now keeps renewing until its final transition is written.** The worker used to
leave the heartbeat round as soon as the handler returned. A completion or failure that waited past
the remaining lease let lease recovery take the task, so a peer could repeat finished work and the
original result was discarded. `Worker` and `AsyncWorker` now keep the heartbeat and the lease
watchdog through result validation and the fenced write on both tiers, and end them once on every
path. After the handler returns, a refused renewal only stops renewing, as in the Go worker. When
PostgreSQL then refuses the completion, the worker settles the cause under the attempt's fence: a
deadline or attempt timeout that came due during the final write ends as `deadline_exceeded` or
`attempt_timeout` instead of waiting for lease recovery.

**A handler result PostgreSQL cannot store now fails only its task.** jsonb refuses a NUL character
and an unpaired surrogate. Such a result used to reach the completion statement, whose refusal
stopped the worker and left the task leased. The worker now raises `ValueError` with
`<task type> result contains a NUL character or an unpaired surrogate, which PostgreSQL jsonb cannot
store` and fails the attempt under the task's retry policy. On the fast tier the other members of a
completion batch still complete. A database error during completion still stops the worker.

**Breaking: contract schemas can no longer use `pattern` or `patternProperties`.** The SDKs' regular
expression engines accept different syntax and match differently, so one contract could validate
differently in each language.
[ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now leaves both
keywords out of the contract profile. The SDK raises `TypeError` with
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
`<name>` is a key of the root `$defs`. The SDK raises `TypeError` for any other reference, with
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

**A cancelled `AsyncWorker` checkpoint can still leave a checkpoint.** The documentation said a
cancelled `await context.checkpoint(name, operation)` stores nothing. That holds only while the
operation runs. Once the operation returns, its save may already be under way, and the worker waits
for that save instead of undoing it. The handler then sees `CancelledError` while a later attempt
replays the saved value without calling the operation. The behavior is unchanged; the worker guide,
the architecture reference, and the package README now describe it. Treat a cancelled await as
proof of neither a missing checkpoint nor undone effects on other systems.

**The worker documentation now shows `AsyncWorker` taking a pool.** The worker guide passed a
connection to `AsyncWorker.from_asyncpg`, and the README and the workers page said a worker runs
claims on dedicated connections. A worker takes a caller-owned pool. It borrows a pool connection
for each claim and lifecycle statement, and it reserves its own heartbeat and listener connections
from that pool. It never closes the pool. The behavior is unchanged.

Fixes:

- A long-running worker runs maintenance on its own thread. A saturated or paused worker used to
  stop ticking, so due tasks stayed scheduled and expired leases waited for recovery.
- The worker measures each handler result before completion and encodes it with `allow_nan=False`.
  An oversized result raises `TaskValueSizeLimitError` and fails the attempt under the task's retry
  policy. It used to stop the run loop.
- `SyncExecutor` and `AsyncPsycopgExecutor` open every cursor with `row_factory=tuple_row`. A
  connection with `dict_row` or `class_row` no longer breaks the SDK's queries.
- Cancelling a handler that awaits `AsyncHandlerContext.checkpoint` cancels the operation too. The
  operation runs in the handler's context, so it sees the handler's context variables and span.
- `AsyncWorker` keeps draining when its run is cancelled a second time. It used to close its bridge
  while handlers still ran.
- `run_child`, `run_children`, and `run_children_all` validate each child payload and stamp the
  child type's current contract on the request.
- An enqueue whose cached contract rejects the payload rereads the definition once and validates
  again. A definition the same enqueue already read is not reread.
- `Queue` and `AsyncQueue` keep the contract definitions each enqueue used. A concurrent cache
  replacement no longer fails a later valid request in the same batch. An older in-flight load no
  longer replaces a newer cache entry, and it no longer refills the cache after `sync_contracts()`
  clears it.
- `AsyncWorker` removes its asyncpg notification callback when it stops, and it starts no listener
  in the synchronous core.
- The documentation shows workers taking connection pools and states each language's listener and
  heartbeat connection budget.

## 0.5.0 — 2026-09-28

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v43** and Python **3.12** or newer.

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

- Add `set_queue_tier` and `set_queue_history` to the sync and async admin clients, with the
  `QueueTier` and `QueueHistory` types. `set_queue_history` opts a fast-tier queue into attempt or
  claim history.
- Raise `FastTierUnsupportedError` for a `P1007` refusal, naming the queue, the feature, and the
  batch ordinal.
- Batch fast-tier completions with a fused refill claim. `Worker(cohorts=)` splits the slots into
  fixed shares that each complete and claim together. The default is 1 below a concurrency of 8 and
  otherwise one cohort per eight slots, between 2 and 8, capped by the pool's spare connections.
  The fused completion is retried when PostgreSQL chooses it as a deadlock victim.
- Start a long-running worker's first claim beside its startup maintenance pass
  ([ADR 0078](../docs/decisions/0078-start-a-long-running-workers-first-claim-beside-its-startup-maintenance-pass.md)).
- Report an attempt's deadline before the stale-lease answer it causes, so the handler sees the
  deadline the task row records instead of `StaleLeaseError`.
- Make `workhorse.__version__` public API.
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

Requires **schema v18** and Python **3.12** or newer.

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

Requires **schema v18** and Python **3.12** or newer.

**A worker takes a connection pool, not a connection.** `Worker` takes a
`psycopg_pool.ConnectionPool`, `AsyncWorker.from_psycopg` takes an `AsyncConnectionPool`, and
`AsyncWorker.from_asyncpg` takes an `asyncpg.Pool`. The `heartbeat_connection_factory` and
`notification_connection_factory` options are removed, because the worker now takes its dedicated
connections from the pool
([ADR 0071](../docs/decisions/0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md)).
Every other statement borrows a connection for that one statement and returns it, replacing the
model in which one connection serialized every statement for up to 100 handler threads.

The pool needs a known capacity of at least 3: the listener, the heartbeat connection, and one
statement. A worker whose pool is smaller refuses to start and names the capacity it found, the
capacity it needs, and the opt-out. `shared_heartbeats=True` takes heartbeat rounds back to the
shared pool, which is how a small pool runs. `concurrency` does not raise the floor, but a pool of
`concurrency + 3` lets the dispatcher and every handler run a statement at the same time.

**A worker offers the slow maintenance routines once a minute, not on every tick.** A worker used to
offer them on every one-second tick, sending sixty times the intended rate of `run_maintenance`
calls. The cadence [ADR 0011](../docs/decisions/0011-daily-retention-and-split-maintenance.md)
decided is restored, and the new `maintenance_routine_poll_ms` option gates it
([ADR 0072](../docs/decisions/0072-converge-the-worker-runtime-defaults.md)).

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

- Accept `retry_delay_ms` on the worker, as a whole number of milliseconds or a callable over the
  attempt, and send it to `fail_v1`. A worker that sets nothing still leaves every delay to the
  persisted retry policy.
- Treat a failed heartbeat round as unknown until the lease lapses. A single round that threw used
  to cancel every in-flight attempt and re-raise out of the handler. The round now retries on the
  next beat, and each attempt keeps its own lease watchdog: once one lease passes with no accepted
  renewal, the attempt submits `lease_expired`, aborts its handler, and records `lease_lost`.
- Run `AsyncWorker` context calls on dedicated threads.
- Raise a fresh suspension from a durable wait, and run handler cleanup in `finally`.
- Release a task whose type the worker has no handler for, instead of failing it.
  `release_owned_v1` returns the claim to its queue with the attempt intact and appends a `released`
  event. During a rolling deployment the old release no longer spends the retry budget of a type
  only the new release runs.
- Count a sweep that only released a claim as no progress, so a caller looping `run_once` waits
  instead of claiming and releasing the same task.
- Cache the compatibility check and the contract definitions in the producer.
- Never skip a busy schedule occurrence, and read the evaluation instant from the database clock.
- Release a canceled dependent's incoming dependency edges, which used to hold a prerequisite's
  identity against retention.
- Lock only the row a claim takes, and skip the enqueue dependency block for a request that declares
  no prerequisite.
- Document the 2^53 integer bound that Python clears where TypeScript and Go do not.

## 0.2.1 — 2026-09-18

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

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

## 0.2.0 — 2026-09-17

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

**A 0.1.5 database upgrades in place.** This is the first release that ships migrations. Run
`workhorse schema migrate` from a deployment step before any process from this release starts. It
applies migrations 0002 through 0006 and leaves the installation at schema version 6. No database is
dropped and no data is lost.

- Add named budgets that span queues. `sync_budgets()` declares a namespace of budgets,
  `list_budgets()` reads them, and an enqueue names one through `budget`. A budget caps the
  unexpired active tasks that name it, refills one shared token bucket, or does both. The
  synchronous and asynchronous clients carry both methods.
- Skip missed schedule occurrences by default. `ScheduleDefinition` carries a `catchup_policy` of
  `skip`, `latest`, or `all`. A schedule that a paused deployment left behind no longer enqueues
  every occurrence it missed. Existing schedules take `skip`.
- Look each contracted task type up once per enqueue batch instead of once per row, and hoist the
  telemetry constants a worker rebuilt on every attempt.
- Bound every dashboard read procedure to the page it returns, and serve the browser bundle as page
  chunks with compressed, cached assets.
- Document two tenancy tiers. One database per tenant is the boundary Workhorse enforces; a shared
  database carries the tenant on the concurrency key, a budget, and a tag.

## 0.1.5 — 2026-09-14

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

**A 0.1.4 database must be dropped and reinstalled.** This release re-cuts schema v1 to separate
deployment-owned schedule activation from durable operator pauses and to retain maintenance-run
history; no migration exists between 0.1.4 and 0.1.5.

- Preserve operator schedule pauses across deployment synchronization, removal, and re-addition,
  and expose the configured, paused, and effective states through the dashboard bindings.
- Record recent maintenance executions with phase timings, errors, and affected-row counts. The
  shared dashboard shows those runs and supports exact event time ranges.
- Defer `SIGINT` and `SIGTERM` shutdown through a nonblocking self-pipe, so the signal handler stays
  responsive while worker state is locked and a second signal can still force an exit.
- Verify and document transactional enqueue through SQLAlchemy's synchronous connection accessor.
- Report the Python distribution version from the dashboard host instead of baking a version into
  the shared browser bundle.

## 0.1.4 — 2026-09-11

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

**A 0.1.x database must be dropped and reinstalled.** This release renames the unit of work from
"job" to "task" on every surface and re-cuts the schema baseline in place; no migration exists
between 0.1.3 and 0.1.4 ([ADR 0064](../docs/decisions/0064-rename-the-unit-noun-from-job-to-task.md)).

- Rename every `Job*` class, `job_id` argument and attribute, `context.job`, and `Admin.get_job`,
  `list_jobs`, and `get_job_timeline` to their `Task` and `task` spellings; the package exports no
  bare `Task` name, so `asyncio.Task` cannot collide with it.
- Rename the schema, the `workhorse_jobs` notification channel (now `workhorse_tasks`), and the
  substituted error name `RedactedJobError` (now `RedactedTaskError`).
- Rename the OpenTelemetry names from `workhorse.jobs.*` and `workhorse.job.*` to
  `workhorse.tasks.*` and `workhorse.task.*`, with the `{task}` unit.
- Rename the `dashboard/v1` bindings: `jobDetail` becomes `taskDetail` and every `job*` field
  becomes `task*`; `maintenanceTaskPollMs` becomes `maintenanceRoutinePollMs` and the cron page
  lists `maintenance.routines`.

## 0.1.3 — 2026-09-10

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Python **3.12** or newer.

- Improve task and event tables with readable status labels, compact columns, full hover text,
  and task ID copy controls.
- Add worker and search filters to Events, and show task tags and accepted enqueue modes in details.
- Share task actions between listings and details, with cancellation confirmation and an optional reason.
- Keep task menus responsive on long pages and reset pagination when selecting a task view in the sidebar.
- Remember chart visibility and task drawer width, and clarify rate-limit labels on Queues.

## 0.1.2 — 2026-09-10

Published to PyPI from one source commit shared with the npm packages and the Go module, tagged
`python/v0.1.2`. Workhorse stays a public beta on the `0.x` line.

Requires **schema v1** and Python **3.12** or newer.

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

Published to PyPI from one source commit shared with the npm packages and the Go module, tagged
`python/v0.1.0`. This is the first version without a prerelease suffix
([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)). The distribution
stays a public beta on the `0.x` line, and its classifier stays `Development Status :: 4 - Beta`.

Requires **schema v1** and Python **3.12** or newer.

### Added

- The dashboard backend serves `redriveTask` and `redriveDeadLetters`, which the shared
  `dashboard/v1` contract added this release. Both map onto `Admin.redrive` and
  `Admin.redrive_many`: a source the queue does not hold answers 404, and a bulk page reports every
  result plus the continuation cursor the next page resumes from. The host lists both as mutations,
  so a cross-origin or read-only request is refused before dispatch. `workhorse.dashboard_v1` gains
  their generated input and output types.
- **The Python worker records what it is.** The schema baseline carries `client_protocol_version`,
  `sdk_language`, and `sdk_version` to `workhorse.worker_registry`, and every registration refresh
  reports `python` with this distribution's version and the SQL protocol version it speaks. The
  dashboard shows them per worker, and `workhorse schema status --json` counts the live workers by
  protocol so an operator can see whether a protocol is still in use before retiring it. The
  columns are nullable and the older call is retained, so a worker running an earlier release keeps
  registering during a rolling deploy.
- `workhorse.compatibility` publishes the startup schema check that the installation page tells every
  runtime to make. `assert_schema_compatible(connection)` takes a Psycopg connection, and
  `assert_schema_compatible_psycopg` and `assert_schema_compatible_asyncpg` name their asynchronous
  driver, mirroring `AsyncQueue.from_psycopg` and `AsyncQueue.from_asyncpg`.
- `workhorse` exports nine names that were reachable only through a submodule and are the declared
  type of an already-exported field or callback: `CancelStatus`, `CompatibilityCode`,
  `DependencyPolicy`, `EnqueueOutcome`, `Handler`, `HumanWaitCompletionStatus`, `JobState`,
  `JobTimelineEntry`, and `SignalDeliveryStatus`. `workhorse.dashboard` exports `Authorize`, the
  declared type of its documented `authorize` hook, and `DashboardProcedure`, the declared type of
  its `enqueue_test` and `set_schedule_enabled` parameters.
- Every module under `workhorse` whose name carries no leading underscore now declares `__all__`,
  so `from workhorse.worker import *` and `dir(workhorse.admin)` describe the supported surface.
  Only `workhorse.dashboard` declared one before.

### Fixed

- `Worker.handle_batch` groups and orders members by the worker's claim order. Each job runs on its
  own handler thread, so members previously reached the coordinator in thread scheduling order, and
  two equal-priority jobs could appear in a batch in either order. `AsyncWorker.handle_batch`
  shares the coordinator and gains the same guarantee. This change landed after `0.1.0b3` published
  and was listed under that entry in error.

### Changed

- **The compatibility check declares a floor and no ceiling, and reads the ceiling from the
  database.** It refused any schema newer than the version this build was compiled against, which
  would have turned the first in-place migration into an outage for the length of a rolling
  deployment. A build cannot know which later release stops serving it, so the installed schema
  declares that instead: `workhorse.protocol_version` records the SQL protocol versions it still
  serves, and a client whose protocol is absent from that list raises
  `ProtocolCompatibilityError`. Below the oldest served version is `schema-too-new`; above the
  newest is `schema-too-old`. A schema that records nothing enforces nothing. One statement returns
  the schema version and the served list together, so the check stays one round trip.
- The README states the unpinned install command and the schema install step, which the TypeScript
  CLI owns.

### Removed

- The public submodules no longer re-export the private helpers they import. About seventy names
  from `workhorse._compatibility`, `workhorse._contracts`, `workhorse._drivers`,
  `workhorse._external_waits`, `workhorse._notifications`, `workhorse._protocol`,
  `workhorse._statements`, and `workhorse._telemetry` are gone from `workhorse.admin`,
  `workhorse.client`, `workhorse.compatibility`, `workhorse.dashboard`, and `workhorse.worker`.
  Among them are `SQL_STATEMENTS`, `STATEMENTS`, `DriverStatement`, `Row`, `SyncConnection`,
  `SyncExecutor`, `PsycopgConnection`, `AsyncpgConnection`, and every other driver protocol. Import
  the supported name from `workhorse` instead; nothing in the documented surface referenced them.
- `workhorse.errors.translate_database_error`, `workhorse.worker.AttemptOutcome`,
  `workhorse.worker.JobExecutionOutcome`, `workhorse.async_worker.T`,
  `workhorse.types.TJson`, `workhorse.dashboard.DashboardBackend`,
  `workhorse.dashboard.DashboardRPCError`, and `workhorse.dashboard.normalize_dashboard_path`
  are private. They were internal helpers that no document or test named.
- The `workhorse.admin` statement and limit constants `GET_*`, `LIST_*`, `REDRIVE`,
  `REDRIVE_MANY`, `SET_*`, `PURGE_QUEUE`, `DEFAULT_PAYLOAD_BYTES`, `JOB_STATES`, `MAX_PAGE_SIZE`,
  `MAX_PAYLOAD_BYTES`, `MAX_REDACT_KEYS`, and `MAX_REDRIVE_BATCH_SIZE` are private. The limits stay
  internal rather than becoming public under the TypeScript names, because the Go module publishes
  no counterpart and no Python document states them.
- The dashboard backend's run-now action calls the audited `workhorse.run_task_now_v1` instead of
  `workhorse.dashboard_run_task_now_v1`, which is removed from the schema. The action now records
  the authenticated actor, the reason, and the request identity in its `promoted` event, matching
  the TypeScript dashboard server.
- **Type names.** Two exported type aliases take the names the TypeScript and Go SDKs already share:
  `workhorse.types.TerminalPolicy` becomes `DependencyTerminalPolicy` and
  `workhorse.types.NonReplaceableReason` becomes `EnqueueNonReplaceableReason`. Both new names are
  exported from `workhorse`, which neither old name was. Each old name stays in `workhorse.types` as
  a deprecated alias of its replacement, so no code has to change on this release. The aliases are
  removed in `1.0.0`.
- **`workhorse.dashboard_v1` type names.** Every type generated from a shared `dashboard/v1` wire
  type now carries the `Dashboard` prefix, so the module no longer declares a second `CancelStatus`
  and `JSON` beside `workhorse.types`. `CancelStatus`, `SendSignalStatus`,
  `CompleteHumanWaitStatus`, `JSON`, `QueueHealthReason`, `QueueHealthReasonCode`,
  `RetentionPolicyImpact`, and `MaintenanceLoopCadences` become `DashboardCancelStatus`,
  `DashboardSignalDeliveryStatus`, `DashboardHumanWaitCompletionStatus`, `DashboardJSON`,
  `DashboardQueueHealthReason`, `DashboardQueueHealthReasonCode`,
  `DashboardRetentionPolicyImpact`, and `DashboardMaintenanceLoopCadences`. The module is
  generated, so it carries no aliases: a caller that names one of the eight updates the name. No
  request or response payload changes.

### Upgrade notes

- **Schema version.** `0.1.0` stays at schema version 1, but its baseline is not the one the last
  beta installed: `workhorse.valid_tags` was renamed `workhorse.valid_tags_v1` and
  `workhorse.dashboard_run_task_now_v1` was removed. A database installed by any beta reports
  version 1 and passes the compatibility check, yet holds the old function names. You must recreate the database and
  install the new baseline with
  `npx --package @stablemates/workhorse@0.1.0 workhorse schema install`.
  This is the last release that asks for a recreation: from `0.1.0` the schema is frozen as the
  migration baseline, and later releases upgrade a database in place.

## 0.1.0b3 — 2026-09-01

Published to PyPI from commit `663c526805746786f12b3be3e151e8ce06c80057`, tagged
`python/v0.1.0b3`.

### Fixed

- The fix-forward release uploads PEP 740 attestations with its wheel and source distribution.
  The package behavior is unchanged from `0.1.0b1`.

## 0.1.0b2 — 2026-08-31

Published to PyPI from commit `0c15212cc5510501bbc9b74bd372fa480e77a1ff`, tagged
`python/v0.1.0b2`.

### Fixed

- The release workflow generated PEP 740 attestations but omitted them from the PyPI upload.
  The package behavior is unchanged from `0.1.0b1`.

## 0.1.0b1 — 2026-08-31

Published to PyPI from commit `6769c768d19861fb8c5c7ea3764e8d5abc62fcf4`, tagged
`python/v0.1.0b1`.

### Changed

- The distribution uses the Apache License, Version 2.0. Contributions require the
  repository `CLA.md`.

### Added

- Synchronous and asynchronous queue clients, workers, administrative clients, and an embedded
  WSGI dashboard implement the Workhorse SQL protocol through Psycopg and asyncpg.
- Handlers can use durable batches, timers, signals, human decisions, child jobs, progress, and
  checkpoints with the same fenced ownership rules as the TypeScript runtime.
- Synchronous handlers can suspend through named signal and human-decision waits, then replay the
  retained external value in the same logical attempt. Synchronous and asynchronous queue clients
  deliver attributed values with idempotency and typed conflict errors.
- `run_worker_process` adds bounded `SIGINT` and `SIGTERM` drain handling for the synchronous
  worker. A second signal exits with its conventional code, while an expired deadline exits with
  failure so PostgreSQL can recover active leases.
- Synchronous `Worker.handle_batch` delivery supports queue-isolated full and partial groups,
  explicit per-member outcomes, independent fences and retries, and durable batch evidence.
- Typed synchronous Psycopg and asynchronous Psycopg or asyncpg enqueue clients support delayed and
  recurring work, priority, atomic batches, idempotency, debounce, throttle, dependencies,
  caller-owned transactions, compatibility refusal, and shared SQL conformance.
