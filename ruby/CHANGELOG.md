# Ruby changelog

`stablemates-workhorse` gem versions and release notes live here. The gem carries the version the
other SDKs carry, because every tag names one release of all of them.

## Unreleased

### A refused completion settles a due deadline or attempt timeout

A handler can return just before its deadline or attempt timeout, and the completion write can then
arrive after that boundary. PostgreSQL refuses the completion. Before this change, the worker only
tried to acknowledge a cancellation, then recorded `lease_expired` and left the task to lease
recovery. The task then settled up to one lease later with the wrong outcome. Now
`reconcile_rejected_completion` calls `expire_owned_telemetry_v1` under the attempt's fence before
the completion path returns. The attempt then ends with the outcome of the due boundary. A
cancellation request and a lost lease keep their own outcomes (SM-1649).

### Workers on one pool renew their leases in one transaction

On the dedicated heartbeat connection, a round sent one transaction for each worker and each 100
leases. Each transaction needs at least 3 round trips to PostgreSQL. With 8 workers on one pool and
80 ms for each round trip, workers lost leases while PostgreSQL still answered (SM-1631). Now the heartbeat thread of the pool sends one transaction for each round, with one `heartbeat_pool_v1` statement for every worker and every 100 leases. The
transaction locks the task rows of every worker in it until its `COMMIT`. A round renews all of its
leases or none. The settings statement now sets `statement_timeout` and
`idle_in_transaction_session_timeout` each to one quarter of the time that remains, not to one half
and one eighth. The statement needs no schema change. The `shared_heartbeats` opt-out does not change (SM-1633).

### The dashboard sets the tier and the history of a queue

The Rack dashboard answers two new mutations, `setQueueTier` and `setQueueHistory`. `setQueueTier`
calls `Admin#set_queue_tier` with the authenticated actor and answers `{status: "set", tier}`. If
Workhorse refuses the switch, the dashboard answers the guard as the status: `live_tasks`,
`concurrency_policy`, or `rate_limit_policy`. Then `tier` is `null`, and the queue keeps its tier.
`setQueueHistory` calls `Admin#set_queue_history`. An absent setting keeps its current value. A
read-only dashboard refuses both mutations (SM-966).

### `Admin` moves a queue between tiers and sets its history

`Admin#set_queue_tier(queue, tier, audit:)` moves a queue to the `:fast` or `:full` tier and returns
the tier after the change. If the tier differs and the queue holds a live task, the method raises
`FastTierUnsupportedError`.
`Admin#set_queue_history(queue, record_attempts: nil, record_claims: nil)` chooses the history a
fast-tier queue records. A `nil` setting keeps its current value. The method returns a
`QueueHistory`. The other SDKs already have these controls (SM-1417).

### A worker on a pool of 1 polls under the opt-out

Before this change, a worker with `shared_heartbeats: true` started the shared listener on any pool.
On a pool of 1, the listener held the only connection. Registration, claims, and handler statements
then waited for the pool timeout, and no task ran (SM-1585).

Now, with `shared_heartbeats: true`, the worker starts the listener only when the pool `size` is an
Integer of at least 2. On a pool of 1, or on a pool without a `size`, the worker polls. Each run
then logs `workhorse.worker.polling_only` once at warn level. The message names
`workhorse.worker.queues` and `workhorse.worker.pool_max_size`. A worker with `polling_only: true`
logs no warning. Without the opt-out, nothing changes.

### A contract compares a stored schema number with all its digits

Before this change, the Ruby SDK read a stored contract schema with `JSON.parse`, which reads a
fraction as a Float. Another SDK can store `"minimum": 0.30000000000000000001`, which a Float cannot
hold. The Ruby SDK then accepted `0.3`. Now a fraction that a Float cannot hold stays a Rational,
and the contract keywords compare it exactly (SM-1541, ADR 0039). `ContractSchema.new` still
accepts only JSON values.

### A worker reserves its heartbeat connection at startup, and refuses to start without it

Before this change, a worker took the heartbeat connection of its pool only when a task arrived,
and returned it when no task remained. If the pool had no free connection then, the worker still
claimed tasks. The heartbeat waited for a connection, and the leases of those tasks could expire
(SM-1577). These changes apply to a worker without `shared_heartbeats: true`:

- **A startup reservation failure now ends the run.** This changes behavior. `run` and `run_once`
  first reserve the heartbeat connection, then borrow one other connection for the compatibility
  query and return it at once. Both steps must end within the larger of `heartbeat` and 5 s. This
  bound includes a connect and the query itself, for every kind of pool. If a step does not end in
  time, the run raises the new `Stablemates::Workhorse::WorkerStartupError` before the worker
  registers. Its message names the pool, the budget, and the `shared_heartbeats: true` opt-out. A
  compatibility query that fails keeps its own error type. Before this change, the same worker started and claimed tasks. A
  supervisor that restarts a failed process, such as `run_worker_processes`, starts the worker
  again.
- **The reservation lasts while a worker runs.** The heartbeat keeps its connection while any worker
  on the pool runs, also when no task runs. The last worker that stops returns it. Thus a pool keeps
  one heartbeat connection for its running workers, apart from the short replacement after a lost
  connection.
- **No claim without a heartbeat connection.** While the pool has no usable heartbeat connection,
  the worker claims no task. A claim checks this after it has its connection, immediately before
  each attempt, and only for its own run. A fast-tier completion then settles its task with a claim
  limit of 0. A rejected or busy lease does not stop claims. The heartbeat checks its connection
  between rounds, also when no task runs. If the connection is lost, or a round fails, the heartbeat
  asks for a new one at once. It waits for a checkout at most one round bound, and at most one
  heartbeat interval between failed attempts. When the new connection is ready, the worker claims at
  once.
- **One shutdown deadline.** `shutdown_grace` now starts when dispatch ends. Every wait of the stop
  path ends by that deadline or one unwind window later. This includes the registration statements
  and the release of the listener and the heartbeat connection. Thus a stop takes at most
  `shutdown_grace` plus the unwind window. A claim that returns after the deadline starts no task,
  and its leases expire. The heartbeat connection stays reserved until that claim statement
  settles. A stop during the startup reservation ends the run without an error.
- **A new run waits for the stop statements of the previous run.** The next `run` or `run_once` of
  the same worker waits for them within its startup budget. Then a late deregistration cannot
  delete the registry row of the new run. If a statement still runs when the budget ends, the run
  raises `WorkerStartupError`. A stop during this wait ends the run without an error.

### Throttle works on a fast-tier queue

Before this change, a throttled enqueue into a fast-tier queue raised the fast-tier error with the feature
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
`dashboard_retention_preview_v1`. The Ruby dashboard host now calls it. The `previewRetentionPolicy` response does
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

`Stablemates::Workhorse::Worker` now calls `deregister_worker_v2` with the instance of the run that
stops.

Each SDK keeps its guard for this release: a new run still waits for the stop statements of the
previous run, or it refuses to start. Every SDK statement catalogue names the new function, so the
SDK compatibility floor rises from schema 75 to 76. Run `workhorse schema migrate` before the first
process of this release starts. A 0.9 process keeps working on schema 76. The migration changes no
stored data.

## 0.9.0 — 2026-10-20

The npm packages, Python distribution, Go module, Rust crate, Ruby gem, and JVM artifacts release from one source commit.

Requires **schema v73**, Ruby **3.3** or newer, and PostgreSQL **15** or newer.

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

Before this release, the dedicated heartbeat connection bounded each heartbeat statement by one full
interval. After a failed round, the heartbeat thread started a new schedule on its new connection.
With the defaults, one timed-out round thus left about 0 s before the lease watchdog expired
(SM-1444). Also, when the worker stopped waiting for a round, PostgreSQL continued to run the
heartbeat statement, and that statement kept its row locks (SM-1442). These changes apply to each
round on the dedicated heartbeat connection:

- **Rounds start on a fixed schedule.** A round falls due one interval after the previous round
  started, not after it ended. The schedule uses a monotonic clock. If a round ends after its next
  slot, the worker starts one overdue round at once and sends no round for the other missed slots.
- **The round bound is shorter.** A round ends by
  `max(1 ms, interval × 3 / 4, min(50 ms, interval))`. For an interval of 200 ms or more, this is
  three quarters of the interval. With the defaults (lease 30 s, interval 10 s), the bound is 7.5 s,
  so one timed-out round leaves a margin of 2.5 s. An attempt keeps its lease after one timed-out
  round if `2 × interval + round bound < lease`. The worker does not reject an interval that breaks
  this rule. Before this release, each statement of a round had its own bound of one interval. Now
  all statements of one round share one deadline, and a statement that would start after it waits
  for the next round. Each round starts with the next statement in turn, so a statement that is
  always slow cannot keep a later statement from its turn.
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
  one round failed. Every task continues, and the next round tries again. A deadlock (`40P01`) also
  fails the round.
- **A busy retry with less than 20 ms left sends nothing** (SM-1492). A bounded busy retry runs
  only if its deadline is at least 20 ms after its start: the 8 ms that a round needs at its
  settings statement, plus a 12 ms margin. Otherwise the next regular round renews the busy leases.
- **Replacement connections.** The heartbeat thread keeps the start of the latest round when it
  replaces a failed connection.
- **100 ms is the smallest supported heartbeat interval** (SM-1471). This applies to `heartbeat:` of
  `Worker`, in seconds: the smallest supported value is 0.1. At 100 ms, the round bound is 75 ms.
  The worker still accepts a shorter interval, and it does not warn. On a loaded host, a shorter
  interval can make each round miss its deadline, and attempts can then lose their leases.

Rounds under `shared_heartbeats: true` have no client deadline and set no server timeouts, as
before. They follow the new schedule. The [heartbeat round
deadline](../docs/architecture/lifecycle.md#heartbeat-round-deadline) and the [heartbeat
schedule](../docs/architecture/lifecycle.md#heartbeat-schedule) state each rule.

### A payload contract compares the decimals of numbers

Before this release, `ContractSchema` compared an Integer with the binary value of a Float in the
bound keywords, `const`, `enum`, and `uniqueItems` (SM-1539). Thus `1152921504606846980` failed
`{"maximum": 1.152921504606847e18}`, although PostgreSQL stores the constant as
`1152921504606847000`. A contract now compares each Float through the decimal of `Float#to_s`
(ADR 0039). Ruby still reads a stored schema constant that a double cannot hold as a Float
(SM-1541).

### A bad worker interval raises ArgumentError

Before this release, a bad value for `heartbeat`, `poll_interval`, `maintenance_interval`,
`maintenance_routine_interval`, or `registry_interval` raised `NoMethodError`, because these options
have no upper limit (SM-1511). For example, `heartbeat: 0` did this. Now `Worker.new` raises
`ArgumentError`, and the message names the option and its lower limit.

### The `workhorse.tasks.retried` description matches `api/telemetry.txt`

The Ruby worker now describes `workhorse.tasks.retried` as "Failed or expired tasks returned to live
work", as the contract does (SM-1514). The counter already counted expired tasks. Only the
description changes.

### A wrapped durable replay conflict is terminal

Before this release, the Ruby worker checked only the outermost error for a durable replay conflict
(ADR 0098). If a handler wrapped a conflict in its own error, the worker recorded a retryable
failure, and the conflict repeated until `max_attempts` (SM-1512). The worker now follows the cause
chain of the error, as the Go and Rust workers do. It reads at most 16 errors, so a cyclic chain
cannot stop it. It reads `Exception#cause`, so an error raised in a `rescue` block also counts. A
wrapped conflict fails the task at once. The failure envelope records the name of the conflict. Its
fields `message` and `stack` stay those of the outer error.

### A heartbeat round sends at most 100 leases in each statement

`heartbeat_many_v2` accepts at most 100 leases. A fused completion claim registers its tasks before
the completing attempts unregister, so a round can hold more leases than the concurrency limit. That
round raised an error, and no lease in it renewed (SM-1495). The worker now splits a round into
statements of at most 100 leases. Each statement counts on its own. A failed statement renews none
of its leases, and the statements before it still count, as before for the statements of each
worker.

## 0.8.0 — 2026-10-13

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v69**, Ruby **3.3** or newer, and PostgreSQL **15** or newer.

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

**Give the eighth member when you build a `TaskCheckpoint`.** `TaskCheckpoint` is a `Data` class.
0.8.0 adds `input_fingerprint` as its eighth member (SM-1264). A call to `TaskCheckpoint.new` with
seven positional arguments raises `ArgumentError`. A call with keywords and no
`input_fingerprint:` also raises it. The gem has no compatible constructor. If your code builds a
`TaskCheckpoint`, for example in a test, give the eighth value. For a checkpoint without an input,
give `input_fingerprint: nil` or a positional `nil`.

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

The Ruby SDK adds task groups (SM-1236). Use the block form to create a group, add its member
tasks, and seal it in one statement, so in one transaction:

```ruby
result = queue.task_group(on_finish: Stablemates::Workhorse::EnqueueRequest.new(
  task_type: "import.report", payload: {"importId" => 42}
)) do |group|
  rows.each { |row| group.enqueue("import.row", {"row" => row}) }
end
```

- `Queue#task_group` takes the `on_finish:`, `on_success:`, and `on_failure:` callbacks. Each
  callback is an `EnqueueRequest` without idempotency, debounce, or throttle. The block receives a
  `TaskGroupBuilder` with `add` and `enqueue`. If the block raises, nothing is enqueued.
- `Queue#create_task_group`, `Queue#add_to_task_group`, and `Queue#seal_task_group` build a group in
  more than one transaction.
- `Queue#get_task_group`, `Queue#list_task_group_members`, and `Queue#find_task_group` read a
  group. `Admin` has `get_task_group`, `list_task_group_members`, `list_task_group_events`,
  `cancel_task_group`, `list_task_group_drift`, and `repair_task_group_drift`.
- `HandlerContext#task_group` and `BatchHandlerContext#task_group` return a `TaskGroupContext`.
  Its `get` returns the `TaskGroupLink` of the task, with the group ID and the counts. Its `add`
  adds tasks from a running member task, also after the seal. If a request names no queue, `add`
  puts the task in the queue of the member task, not in the first queue of the worker (SM-1251,
  [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
- `Stablemates::Workhorse::ActiveJob.task_group` runs a block in which each job that the
  Workhorse adapter enqueues becomes a member task. Its callbacks can be Active Job instances,
  such as `ReportJob.new(import.id)`. A job reads its group through
  `Stablemates::Workhorse::ActiveJob.current_task_group`.
- A job class with `enqueue_after_transaction_commit` set to true cannot join a task group. Rails
  would enqueue that job after the transaction commits, so outside the group. If a task group block
  enqueues such a job through the Workhorse adapter, the SDK raises `ArgumentError` before Rails
  defers the job. Set `enqueue_after_transaction_commit` to false on that job class. The group
  statement runs in the caller's transaction, so the member tasks still commit with it.
- `TaskGroupClosedError` (`P1008`), `TaskGroupLimitExceededError` (`P1009`), and
  `TaskGroupMembershipConflictError` (`P1010`) report the task group refusals.
- `Queue#list_task_group_members` and `Admin#list_task_group_members` return a nil `next_after`
  on the last page, also when the page is full (SM-1277). Before, a full last page gave a
  `next_after` that read an empty page. A full page now costs one more read of one member.
  `TaskGroup#callbacks` keeps the order `on_finish`, `on_success`, `on_failure`, and a test now
  asserts it. The change adds no SQL function and no migration.

### Checkpoint input

A checkpoint finds its stored result by name only. If a deployment changes the input of a checkpoint
operation, a replay returns the result of the old input and gives no error. A Ruby handler can now
give the input of a checkpoint (SM-1264,
[ADR 0098](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0098-check-the-input-of-a-checkpoint-on-replay.md)):

```ruby
context.checkpoint("charge-card", input: {"amountCents" => amount}) { gateway.charge(amount) }
```

- `HandlerContext#checkpoint` and `BatchHandlerContext#checkpoint` take the `input:` keyword, a JSON
  value. The checkpoint stores the fingerprint of the input with its value, through
  `save_checkpoint_v2`. A call without `input:` keeps its current behavior. `input: nil` gives the
  JSON input null.
- If the stored checkpoint, or an overlapping call with the same name, has the fingerprint of a
  different input, the call raises `CheckpointInputConflictError` and the block does not run. If the
  call or the stored checkpoint has no input, the call compares nothing.
- `CheckpointInputConflictError` is a subclass of `ConflictError`. The worker fails the task at once
  and keeps the current attempt, as for every replay conflict. The task error names the class.
- `Stablemates::Workhorse.checkpoint_input_fingerprint(input)` returns the fingerprint: the SHA-256
  digest of the RFC 8785 canonical JSON of the input, as 64 lowercase hexadecimal characters. It
  refuses an Integer or a Float larger than 2**53 - 1 in magnitude, such as `1e21`, because RFC 8785
  writes each number as an IEEE 754 double. Every SDK refuses the same inputs (SM-1274).
- `TaskCheckpoint#input_fingerprint` returns the stored fingerprint, or nil. `Admin#get_checkpoint`,
  `Admin#list_checkpoints`, and `HandlerContext#get_checkpoint` return it.

### Behaviour changes

- If a child task request names no queue, `run_child`, `run_children`, and `run_children_all` put
  the child in the queue of the parent task (SM-1260, [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
  Before, the child went to the first queue in the `queues:` list of the worker. To keep the old
  queue, name that queue on the request, for example `queue: "default"`.
  A parent task that created a child before the upgrade can replay that request after the upgrade.
  If the replayed request names no queue, it keeps the queue of the stored child, so the parent
  task joins its child.
- `Worker#run_once` does not change: a pass that released every task that it claimed returns
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
- The Rack dashboard refuses a mutation whose `audit.requestId` is more than 512 UTF-8 bytes
  with `BAD_REQUEST`, before any SQL runs (SM-1253). It measures the value as sent, before trim.
  Before, the SQL audit function refused the value, and the client got an internal server error.

## 0.7.1 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54**, Ruby **3.3** or newer, and PostgreSQL **15** or newer.

The gem has no changes in 0.7.1. It releases at 0.7.1 to keep one version across the
registries ([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists because the npm publish of 0.7.0 stopped partway.
The gem never published at 0.7.0, so 0.7.1 is the first release with the 0.7.0 changes below.

**A 0.7.0 database needs no migration.** 0.7.1 adds no migration, so the final schema version is
**64** and the SDK compatibility floor stays at schema version **54**. An installation on 0.6
follows the [0.7.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#070--2026-10-09).

## 0.7.0 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54**, Ruby **3.3** or newer, and PostgreSQL **15** or newer.

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

- **`dashboard/v1`:** task listing rows carry `humanWait.quickAction` instead of
  `humanWait.context`, as the upgrade steps describe. The break is taken in place under the ADR 0064
  exception in [`docs/compatibility.md`](../docs/compatibility.md) (SM-1171).

### Behaviour changes

Durable execution and workers:

- Durable checkpoint, timer, child, child-set, and human-decision replay conflicts fail the task on
  their first occurrence. The worker preserves the current attempt and records the conflict class.
  Before, a conflict retried under the task's retry policy, and every retry met the same conflict.
  Redaction still hides error details. Transient failures, lease loss, child-limit errors, and
  already-waiting signal errors keep their existing behaviour. Conflict settlement bypasses the
  worker's retry-delay callback (SM-1107, migration 0055).
- A renamed individual child on replay raises `ConflictError` with the stored and requested names,
  and `ConflictError.new` takes a `stored_name:` keyword. Before, it raised a child-limit error. A
  second child after joining the retained child in the same handler run still exceeds the child
  limit (SM-1106, migration 0054).
- A handler that raises the `CancelledError` of its `:shutdown` cancellation no longer charges an
  attempt. The worker hands its task to `release_owned_v1`, as it does for a task without a handler.
  Before, `CancelledError(:shutdown)` reached `fail_v1`, so a task on its last attempt failed
  because its worker stopped (SM-1164).
- The `workhorse.handler` span descends only from the task's stored trace context. A task without
  one starts a new trace instead of joining a span that a context-propagating executor carries into
  the handler thread (SM-1179).

Dashboard host:

- `Dashboard.new(audit_actor: ...)` no longer replaces the actor of a `Principal` that `authorize`
  returns. The dashboard records the principal's actor, as the `dashboard/v1` protocol requires.
  `audit_actor` still names the actor when `authorize` returns `true`, and defaults to `dashboard`
  there (SM-1152).
- `Dashboard` refuses an RPC body over 2 MiB, or a malformed declared length, with `413` before
  parsing. An unexpected schema-compatibility failure, such as a connection error, answers a generic
  `503` and is written to `rack.errors` instead of escaping the Rack app (SM-1168).

Maintenance, health, and administration, from the SQL changes:

- Terminal cleanup repeats its batch while each one fills, for up to one second per pass. A pass
  that still ends with a full batch makes its follow-up due five seconds later. Full-tier and
  fast-tier tasks share every batch (SM-1160, migration 0058).
- `tick_v1` runs the expired-lease scan only when no tick ran it within half the shortest
  maintenance interval of the live registered workers. A worker that opts out of the registry with
  `disable_registry: true` does not shorten that spacing. Recovery of an expired lease can then take
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

- `Queue#health` reports the backlog budget as `budgets.terminalCleanupBacklogMs` with schema 64,
  and `status.reasons` can carry `terminal-cleanup-backlog` (SM-1178, SM-1197).

### Dependencies

- The gemspec declares `logger` at least 1.6 and below 2. Ruby 4.0 no longer ships `logger` as a
  default gem. On Ruby 4.0, 0.6.1 raises `LoadError` at `require "stablemates/workhorse"` unless
  the application already installs `logger` (SM-1138).
- The dashboard requires `cgi/escape` instead of `cgi`, which Ruby 4.0 reduces to a stub that warns
  (SM-1138).

### Recipes

- A new tested recipe enqueues through Sequel on its native `pg` connection (SM-1114).
- The quick start and the agent playbook print their results as JSON (SM-1139), and a batch handler
  example shows how batch-handler tasks are enqueued (SM-1135).

## 0.6.1 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Ruby **3.3** or newer, and PostgreSQL **15** or newer.

The gem has no changes in 0.6.1. It releases at 0.6.1 to keep one version across the
registries ([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists for the Python distribution, whose 0.6.0 files on PyPI have no PEP 740
attestations.

**A 0.6.0 database needs no migration.** 0.6.1 adds no migration, so the final schema version is
**52** and the SDK compatibility floor stays at schema version **43**. An installation on 0.5
follows the [0.6.0 upgrade steps](../CHANGELOG.md#060--2026-10-02).

## 0.6.0 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Ruby **3.3** or newer, and PostgreSQL **15** or newer.

- The gem needs schema version 43 or later. The SDK compatibility floor is schema version **43**,
  and the final schema version is **52**. The migrations since 0.5.0 only add, so the upgrade is a
  rolling deployment: run `workhorse schema migrate` before any new process starts. The
  [root changelog](../CHANGELOG.md) lists the SQL fixes. Each takes effect when its migration commits, and version 52
  includes them all.
- An installation that runs cold export stops its exporters across migration 0052. That migration
  repairs the export ledger, but it cannot stop an upload already in flight. Upgrade in this order:

  1. Stop every cold exporter, and let each finish its object and manifest uploads.
  2. Keep cold export enabled, so retention keeps waiting for the export.
  3. Run `workhorse schema migrate`.
  4. Restart the exporters after the migration commits.

  An installation that never enabled cold export needs no extra step. The
  [cold export guide](../docs/guides/335-cold-export.md#a-day-is-a-utc-day) explains the repair.

- A handler result PostgreSQL cannot store now fails only its task. jsonb refuses a NUL character
  and an unpaired surrogate. Such a result used to reach the completion statement, whose refusal
  ended `run` and left the task leased. The worker now fails the attempt under the task's retry
  policy with an `ArgumentError`. Its message names the task type and carries no part of the value.
  On the fast tier the other members of a completion batch still complete. A database error during
  completion still ends `run`.
- `Queue#sync_schedules` applies each task type's current contract, read from PostgreSQL, before
  the write. A payload that fails the schema raises `ContractValidationError` and writes nothing. A
  valid definition stores the contract version, its size limits, and its redaction keys.
- Add the `Queue` client: `enqueue` and `enqueue_many` with every client enqueue option,
  cancellation, signal and human wait delivery, queue health, and schedule and contract
  synchronization. `sync_concurrency_policies`, `sync_rate_limit_policies`, and `sync_budgets`
  replace a namespace's definitions, and the list methods read them back.
- Durations, including a `RateLimit` interval, are finite Numeric seconds. The client refuses a
  value outside a protocol bound with `ArgumentError` before it sends any statement.
- Contract schemas are checked against the draft 2020-12 meta-schema. The contract profile rejects
  `pattern` and `patternProperties` at any depth with `ArgumentError`, as every SDK does
  ([ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md)). Check a
  string's shape in handler code instead. A `$ref` must point at a subschema, so it cannot reach a
  schema hidden in `default` or `examples`; any other reference raises `ArgumentError` with
  `<path>.$ref must point at a subschema of the contract`, including a pointer that encodes `/` as
  `%2F`.
- **Breaking: a contract version that another SDK's 0.5 release synced with `pattern` or
  `patternProperties` does not compile in this gem.** Upgrade in this order:
  1. Find each contract version that uses either keyword, or a `$ref` that points outside a
     subschema.
  2. Publish a new version without either keyword, and move `currentVersion` to it.
  3. Let tasks that hold the old version finish before you run Ruby workers. A worker checks a
     task's result against the version the task holds. If that version's result schema uses either
     keyword, completing the task fails the attempt with `ArgumentError`, and the task's retry
     policy applies. Each payload was checked at enqueue, so a keyword in the payload schema does
     not affect tasks already queued.
- **Breaking: a contract `$ref` must be `#` or `#/$defs/<name>`, and `$anchor` is no longer
  accepted** ([ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md)).
  `<name>` is a key of the root `$defs`. `ArgumentError` names any other reference with
  `<path>.$ref must point at a subschema of the contract`, and also `$defs` below the root, a
  `$defs` name that does not match `^[A-Za-z_][-A-Za-z0-9._]*$`, and `$anchor` at any depth. A
  property named `$anchor` stays valid. Upgrade in this order:
  1. Find each contract version that references anything other than `#` or a root definition, nests
     `$defs`, uses `$anchor`, or names a definition outside that pattern.
  2. Move each referenced or anchored subschema into the root `$defs` and reference it as
     `#/$defs/<name>`. Rename each definition outside the pattern and update the references to it.
     Declare a new contract version, because contract rows are immutable, and move `currentVersion`
     to it.
  3. Let tasks that hold the old version finish before you run Ruby workers. A removed form in a
     task's result schema fails the attempt with `ArgumentError`, and the task's retry policy
     applies.
- Add the executor forms: a `PG::Connection`, a `ConnectionPool`, or any object whose `with`
  yields a connection. `ActiveRecordExecutor` joins the caller's Active Record transaction.
- Add the error hierarchy under `Stablemates::Workhorse::Error`.
- Add the `Admin` operator client: task, timeline, checkpoint, progress, and wait inspection, dead
  letter listing and redrive, worker pause, and queue pause, resume, and purge. Every control takes
  an `AdminAudit`.
- Add `Dashboard`, a Rack application that serves the operator dashboard under a Rails `mount` or a
  `Rack::Builder#map`. It answers the dashboard/v1 procedures and serves the bundled browser app.
- `Executor.for` ignores the `Object#with` that ActiveSupport defines, so a plain object is still
  refused.
- Add `Worker`: it claims, heartbeats, completes, fails, and retries tasks over a
  `ConnectionPool`, and runs handlers on a thread pool of `concurrency` threads. A handler receives
  its payload and a `HandlerContext` with the task and a `CancellationToken`. `stop` requests
  shutdown. `run` then drains handlers within `shutdown_grace`, cancels the rest with `:shutdown`,
  and raises `ShutdownIncompleteError` when any handler still runs.
- Add the durable `HandlerContext` calls: `checkpoint`, `sleep`, `sleep_until`, `wait_for_signal`,
  `wait_for_human`, `run_child`, `run_children`, `run_children_all`, `get_progress`, and
  `set_progress`. A call that waits suspends the attempt and releases its lease, and the task
  resumes in the same attempt. A handler that swallows the suspension still suspends, and the
  worker logs `workhorse.handler.signal_swallowed`. After the lease is lost, every durable write
  raises `LeaseLostError`; reads and checkpoint replays still return. A child without a queue runs on the worker's first queue.
- Under Rails, handlers run inside `Rails.application.executor.wrap`. `run` warns when the Active
  Record pool is smaller than `concurrency`.
- `Worker` runs tasks on a fast-tier queue: it probes each queue with `complete_many_and_claim_v1`,
  records one `fast_task_outcome` row per task, and fuses each completion with a refill claim.
  `Worker.new(cohorts:)` splits the slots into dispatch cohorts; without it, the worker keeps one
  below concurrency 8, else `concurrency / 8` from 2 through 8, capped by the pool's spare
  connections. The handler thread pool now allows two threads per slot.
  A fast-tier task's `HandlerContext` raises `FastTierUnsupportedError` for checkpoints,
  progress writes, durable waits, and child tasks before any durable write. That holds for a
  task claimed through `claim_many_v1` after its queue moved to the fast tier.
- `HandlerContext#wait_for_signal`, `wait_for_human`, `run_child`, `run_children`, and
  `run_children_all` validate each step name before the deferred tier read or any write, as
  `checkpoint` and `sleep` do. An invalid name raises `ArgumentError`. A child set is checked for
  its type and size before its names.
- A pooled connection that PostgreSQL dropped is discarded through the pool's
  `discard_current_connection`, so the next statement gets a fresh connection. Before, the pool
  reused the dead connection until the process restarted. An ordinary SQL error keeps the
  connection, and the failed statement is never resent.
- `Worker` measures a result as PostgreSQL does, by the UTF-8 length of its `jsonb` text, before
  it completes the task. A result over the task's limit fails only its own attempt with
  `ValueSizeLimitError`, and the retry policy decides what happens next. The worker no longer stops
  when PostgreSQL refuses an oversized completion. That holds on both tiers and for batch members.
- Add `Worker#handle_batch` with `max_size:` and `linger:` in seconds. Once the worker stops, a
  lingering batch runs as soon as every task it claimed has arrived.
- Change the `handle_batch` block from `|payloads, context|` to `|items|`. Each `BatchHandlerItem`
  holds a member's `payload` and its own `BatchHandlerContext` with `task`, `cancellation`,
  `get_checkpoint`, `checkpoint`, `get_progress`, and `set_progress`. The batch-wide `tasks` and
  shared `cancellation` are gone. Each write is fenced on its member's lease, and a member's
  checkpoint replays whatever batch a retry puts it in. A fast-tier member's `checkpoint` and
  `set_progress` raise `FastTierUnsupportedError` before any durable write.
- Add `HandlerContext#get_checkpoint`.
- `HandlerContext#checkpoint`, `sleep`, and `sleep_until` refuse a name outside 1 to 200
  characters with `ArgumentError` before the block runs or any statement. `get_progress` keeps the
  highest progress revision PostgreSQL acknowledged when `set_progress` calls return out of order.
- The Active Job adapter's `enqueue_all` clears each job's `enqueue_error`, so a job reports only
  the error of the current call.
- Add `run_worker_process`, which stops the worker on `TERM` or `INT` and exits at once on a second
  signal, and `run_worker_processes`, which forks, supervises, and restarts worker processes.
- A `logger` that raises no longer reaches worker lifecycle code. An accepted heartbeat still
  renews the lease, `Worker#stop` still wakes the dispatcher, and a second signal still exits the
  process. The first failure of each logger is written to standard error.
- Add the Active Job adapter, selected with `config.active_job.queue_adapter =
  :stablemates_workhorse`. It requires Active Job 8.0 or later. A default job runs under the
  `active_job` task type. A typed job declares its task type with `workhorse_options` and carries
  one JSON `Hash`, so another SDK can enqueue or run it. `Stablemates::Workhorse::ActiveJob.handle`
  registers both formats on a `Worker`.
- Workers built on one pool share one notification listener connection, as they share the
  heartbeat connection. Each worker is woken only for its own queues, and the listener stops when
  the last worker on the pool stops.
- `EnqueueResult#reason` says why a debounced enqueue was `:non_replaceable`:
  `:incompatible_key_mode`, `:not_pending`, or `:window_elapsed_pending`. It is `nil` for every other
  outcome.
