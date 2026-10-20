# ADR 0105: Skip a locked row in a heartbeat and report the lease as busy

- **Status:** Accepted
- **Date:** 2026-10-18
- **Related:** [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0056](0056-set-the-1-0-0-exit-criteria.md),
  [ADR 0057](0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md),
  [ADR 0081](0081-release-a-fused-claim-lock-before-it-can-deadlock.md)
- **Issue:** SM-1443. SM-1439 records the decision between the options. SM-1442 and SM-1444 change
  the same heartbeat round.

## Context

A heartbeat renews the lease of each task that a worker runs. `heartbeat_many_v1` locks the rows of
the worker with `FOR NO KEY UPDATE`, and it waits for a row that another transaction locks.

**Example.** A worker runs one task with an execution timeout.

1. The timeout is due. The worker calls `expire_owned_v1`, which locks the row and moves the task to
   `ready`, attempt 2, with no worker.
2. A heartbeat round of the same worker starts and waits for that row lock.
3. The expiry commits. PostgreSQL locks the new row version for the heartbeat, which then reports
   `stale`. The heartbeat keeps the row lock until its own transaction ends.
4. The next claim selects ready rows with `SKIP LOCKED`, so it skips the task. It claims nothing.

SM-1434 proved this without load. A heartbeat also locks its rows in task ID order, so while it
waits on one row, it holds the rows before it. The mixed batch of `heartbeat_many_v1`, which names
tasks of both tiers, calls the blocking `heartbeat_v1` for each lease, and its `UPDATE` selects all
input rows again.

SM-1442 ends a heartbeat statement on the server at the deadline of its round. That limits the time
that a heartbeat holds a row, but the heartbeat still waits.

## Decision

**A new function, `heartbeat_many_v2`, does not wait for a row lock that another transaction holds.
It reports such a lease as `busy`. Every SDK worker calls it, and retries only the busy leases.**

### The function

1. Migration 0073 moves the schema from 71 to 72. It adds
   `heartbeat_many_v2(p_worker_id text, p_leases jsonb) RETURNS TABLE (ordinal bigint, task_id uuid, status text)`.
   The input and its limits are the same as in `heartbeat_many_v1`.
2. The function locks the named rows of the worker on both tiers with
   `FOR NO KEY UPDATE SKIP LOCKED`, in task ID order for each tier. It reads the clock after both
   lock steps.
3. One `UPDATE` for each tier changes only the rows that the function locked. Each `UPDATE` keeps
   the filters on the task, the worker, the fence token, and the active state. The function calls
   no other heartbeat function, also for a mixed batch.
4. A lease gets `busy` when the function did not lock its row and a plain read in the same
   statement still shows that active generation. Any other lease that no `UPDATE` matched gets
   `stale`, as in `heartbeat_many_v1`. The other statuses do not change. The function returns one
   row for each lease, in input order.
5. A `FOR KEY SHARE` lock, which a foreign-key check takes, does not conflict with the lock step.
   So it does not cause `busy`.
6. `heartbeat_many_v1` does not change. It still waits for a row lock.

**`busy` means no renewal and no ownership verdict.** It does not mean that the worker still owns the
lease. A settlement can have changed the row in a transaction that has not committed, or it can
commit after the read. An expired lease can also match the generation check.

**`SKIP LOCKED` does not stop every wait.** ADR 0081 records the case. Another transaction can
update and commit the row after the snapshot of the lock step, but before the lock. PostgreSQL then
follows the update chain to the new row version. That walk waits for a transaction that locks the
new version. A test in `integration-busy-heartbeat.test.ts` opens that gap. On PostgreSQL 18 the
statement waited until the other transaction committed, and it reported `stale`. So the server
timeouts of SM-1442 stay on every bounded round. Workhorse does not promise that a heartbeat never
waits.

### The worker

1. Only `accepted` moves the local lease watchdog. A `busy` lease stays in the heartbeat set, and its
   watchdog does not move. The worker does not abort the handler and does not report a lost lease.
2. A result counts only for the membership that the round sent: the same registered lease, with the
   same task and fence token. A lease that left or was replaced while the round ran gets nothing
   from it. A late answer never revives a watchdog that has ended.
3. After a round with a busy lease, the worker schedules one busy retry. A busy retry is a round
   that sends only the busy leases. It falls due after `base × (1 + random)`, with
   `base = min(100 ms, heartbeat interval / 8)`. The jitter keeps two workers from meeting the same
   lock holder in step.
4. Regular rounds and busy retries share one scheduler and one in-flight rule. A busy retry does not
   move the regular schedule of SM-1444.
5. When a busy retry falls due, it keeps only the leases that are still registered with the same
   membership and whose watchdog has not ended. At or after the next regular slot, the worker drops
   the selection, and the regular round sends every registered lease, also the busy ones.
6. A bounded busy retry has the deadline `min(retry start + round bound, next regular slot, earliest
   watchdog end of its leases)`. It uses the SM-1442 transaction and server timeouts. A round under
   shared heartbeats has no deadline, and its busy retry has none either.
7. A failed busy retry schedules no other retry. The next regular round tries again.

A busy retry is an opportunity to renew, not a guarantee. `SKIP LOCKED` gives no fairness.

### Lease margin

The defaults are a lease of 30 s, an interval of 10 s, and a round bound of 7.5 s. After an
accepted round sent at 0 s, the watchdog ends at 30 s. The regular rounds at 10 s and 20 s can both
be busy. Between them, a busy retry starts about every 100 ms to 200 ms, plus the time of each
round. If no round locks the row by 30 s, the watchdog ends the attempt. It
submits `lease_expired`, stops the heartbeat, and aborts the handler. Settlement records
`lease_lost`.

### Healthy operations that cause busy

`update_progress_v1`, `save_checkpoint_v2`, the durable sleep and wait functions, `cancel_v1`, and
each settlement lock the row for their transaction. The tick locks only an expired lease. A short
lock makes only the round that meets it busy. A lock that stays held blocks every renewal until it
commits, for example a progress update in a long transaction of the caller (`forTransaction`). If
that transaction commits after the watchdog end, the attempt loses its lease. Before this change, the
heartbeat waited on that lock until the round deadline, with the same result.

### Paths outside this decision

- `heartbeat_v1`, and `Queue.heartbeat()` and `Queue.heartbeatStatus()` in TypeScript, do not
  change. They renew one lease and still wait for a row lock. SM-1461 owns a successor.
- A TypeScript `Worker` with a custom `WorkerQueueApi` that has no `heartbeatMany` renews each lease
  through `heartbeatStatus`. That path never reports `busy`, and it can wait. The built-in `Queue`
  always has `heartbeatMany`, and a test checks that its worker never calls `heartbeatStatus`.

### Public API

Only TypeScript exposes a heartbeat status on a governed surface.

- The scalar `HeartbeatStatus` does not change.
- A new type, `HeartbeatBatchStatus`, is `HeartbeatStatus | "busy"`. `WorkerQueueApi.heartbeatMany`,
  `WorkerHeartbeatChannel.heartbeatMany`, and the internal `Queue.heartbeatMany` return it.
- The Python `heartbeat_many` binding is a statement binding. The Go, Rust, Ruby, and JVM statuses
  are internal.

This is a breaking return change in a 0.x minor, which ADR 0054 permits. Code that implements
`WorkerQueueApi.heartbeatMany` compiles unchanged. Code that reads its result and checks every
status must handle `busy` as "not renewed, no verdict". Scalar heartbeat behavior does not change.

The change is non-additive on the TypeScript API, so it restarts both clocks of ADR 0056 Gate 2.

### Upgrade

Every SDK statement catalogue names `heartbeat_many_v2`, so the SDK schema floor rises from 69 to 72. Run `workhorse schema migrate` before any process of the new release starts, producers too. A
new process refuses a schema below 72 at startup. The next minor release must freeze
`sql/releases/0072.sql`.

Old and new processes can run together. An old worker calls `heartbeat_many_v1` and waits on a
locked row, as before. A new worker calls `heartbeat_many_v2` and does not wait. Both renew the same
columns. A `heartbeat_many_v1` call can wait for a row that a `heartbeat_many_v2` call locks for the
time of its statement, as two `heartbeat_many_v1` calls can today.

### Retirement of `heartbeat_many_v1`

A new and an old protocol-5 client look the same in `workhorse.worker_registry`. So the registry
cannot show when no worker calls `heartbeat_many_v1`, and "no SDK calls it" is not sufficient.
Removal needs a future protocol boundary: a client protocol that only new workers report. ADR 0057
then applies with both retention conditions, and the operator removes the function with its
contract step.

## Consequences

- A heartbeat no longer keeps the row of a settled task locked. A claim takes the task at once after
  the settlement commits. The SM-1434 test retries are gone.
- A heartbeat that meets a lock holder answers at once, and the worker retries soon. With the
  defaults, a lease has two regular rounds and many busy retries before its watchdog ends.
- Contention that lasts longer than the lease still loses the lease, as before.
- A mixed batch locks set-based and calls no single-lease function.
- An update-chain wait can still occur, so the server timeouts stay.
- The heartbeat failure counter, `workhorse.worker.heartbeat.failure`, counts `busy` as a status.
- Two functions renew a batch until a future protocol boundary retires `heartbeat_many_v1`.

## Rejected alternatives

### Make `heartbeat_many_v1` skip locked rows

An old worker does not know `busy`. If v1 reported busy, an old worker would treat it as an unknown
status. If v1 reported a skipped lease as `stale`, an old worker would lose a lease that it still
holds.

### Wait for the in-flight round before a settlement (option B of SM-1439)

The worker's own next claim could then not meet the lock. Another worker could still meet it, and
the change would not fix the mixed batch.

### Retry only at the next regular round

With the defaults, a lease survives only two busy regular rounds. Progress updates, checkpoint
writes, and durable sleep replay can lock the row many times in that period.

## Amendment: a busy retry with less than 20 ms left sends nothing (2026-10-20)

Worker rule 6 gives a bounded busy retry the deadline `min(retry start + round bound, next regular
slot, earliest watchdog end of its leases)`. Until this amendment, a retry ran when that deadline
was later than its start, so it could start with a few milliseconds left. The round then failed
after `BEGIN`, and the worker discarded its reserved heartbeat connection. SM-1492 found this case.

A bounded busy retry now runs only if its deadline is at least 20 ms after its start. The 20 ms is
the 8 ms that a round needs at its settings statement, plus a margin of 12 ms for the payload, the
wait for the connection, and `BEGIN`. If less time remains, the retry sends nothing and schedules no
other retry. The regular round then sends every registered lease, the busy ones too. A retry
without a client deadline does not skip. Under shared heartbeats, only Go bounds its rounds, so only
a Go retry under shared heartbeats can skip. All six SDKs use the same rule and the same values.

## Amendment: a one-lease successor, heartbeat_v2 (2026-10-20)

"Paths outside this decision" names `heartbeat_v1` as a path that still waits for a row lock, and
it gives the successor to SM-1461. This amendment records that successor. The rule text above does
not change.

1. Migration 0074 moves the schema from 72 to 73. It adds
   `heartbeat_v2(p_task_id uuid, p_worker_id text, p_fence_token bigint, p_lease_ms integer DEFAULT 30000) RETURNS text`.
   The input, the checks, and the errors are the same as in `heartbeat_v1`.
2. A null task ID or fence token gives `stale`, as in `heartbeat_v1`. Every other call returns the
   status that `heartbeat_many_v2` gives the one lease. Thus the function rules 2 through 5 above
   apply to it, `busy` too.
3. `heartbeat_v1` does not change, under ADR 0057. `Queue.heartbeat()` and `Queue.heartbeatStatus()`
   still call it and still wait.
4. TypeScript adds `Queue.tryHeartbeat(task, workerId, leaseMs?)`, which calls `heartbeat_v2` and
   returns `HeartbeatBatchStatus`. The change is additive. It has no busy retry: on `busy`, the
   caller decides when to call again. The scalar `HeartbeatStatus` does not change.
5. A TypeScript `Worker` with a custom `WorkerQueueApi` that has no `heartbeatMany` still renews
   through `heartbeatStatus`. It can wait and never reports `busy`. `WorkerQueueApi` gets no new
   method. A custom API must implement `heartbeatMany` to get the busy rule and the busy retry.

Every SDK statement catalogue names `heartbeat_v2`, so the SDK schema floor rises from 72 to 73. No
release published schema 72. The next minor release must freeze `sql/releases/0073.sql`.
