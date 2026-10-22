# ADR 0101: Cancel a purged prerequisite whose dependent stays

- **Status:** Accepted
- **Date:** 2026-10-13
- **Related:** [ADR 0095](0095-add-task-groups-with-completion-callbacks.md)
- **Issue:** SM-1284. SM-1282 gave the purge its lock order.

## Context

A queue purge, `purge_queue_internal_v1`, deletes the `blocked`, `ready`, and `scheduled` tasks of
a queue. `task_dependency.prerequisite_task_id` restricts deletion. If a purged task was the
prerequisite of a dependent, PostgreSQL refused the delete with `23001`, and the whole purge failed.

**Example.**

1. The queue `imports` holds the task `A` in `ready`.
2. The task `B` in the queue `exports` names `A` as a prerequisite, and `B` is `blocked`.
3. An operator purges `imports`.
4. The purge fails with `23001`. The caller sees a raw database error.

The purge also failed when `B` was in `imports`, because one delete removed both ends of the edge.
It failed when `B` was already terminal, because a terminal dependent keeps its released edge until
pruning removes it.

The first decision on SM-1284 resolved a dependent that stays through `resolve_dependents_many_v1`
with the `canceled` state, and then deleted the prerequisite. That is not sufficient. The resolver
releases an edge but keeps the row, so the purge must delete the released edge too. A dependent with
a rejecting resolution waits for all its other edges before it settles. If the purge deletes the
rejecting edge first, `settle_dependents_v1` later finds no `fail` or `cancel` edge. It treats the
rejection flag as drift, clears it, and releases the dependent. The dependent's own policy said to
cancel or fail it.

## Decision

A purge never fails with `23001` because of a dependency edge.

1. If the purge deletes the dependent too, the edge goes with it.
2. A purged task stays when a pending edge leads to a dependent outside the purge, or to a purged
   task that stays. The purge does not delete that task. It cancels it as `cancel_v1` does, with
   the reason `queue purge`.
3. The canceled outcome's trigger resolves the dependents of that task. Each dependent's own
   `on_cancellation` policy decides its outcome, exactly as for a cancel.
4. A purged task whose only remaining edges are released, and lead to terminal dependents, is
   deleted. The purge deletes those edges first, as the pruning of released edges would.
5. Retention removes a canceled task later, as it removes any terminal task.

The purge uses the lock protocol of a cancel, so it has no deadlock that a cancel of the same tasks
does not also have:

1. It locks the runtime rows of the purged tasks in identity order, `FOR UPDATE`, then their task
   rows, as SM-1282 made it.
2. It locks the blocked dependents outside the purge in identity order, `FOR NO KEY UPDATE`, as the
   resolver does.
3. `cancel_v1` settles the dependents. A dependent that its policy cancels or fails takes
   `FOR UPDATE` before its runtime row is deleted, as for any cancel. Transitive dependents lock
   level by level.

A terminal transition of a purged task also locks the task before its dependents. Thus a concurrent
cancel, or a cascade that settles a purged task, cannot deadlock with the purge. The
`FOR NO KEY UPDATE` lock does not conflict with the key-share lock of an enqueue. Thus an enqueue
that names a purged task and a dependent that its policy releases cannot deadlock with the purge.

One limit remains. An enqueue that names a purged task and a dependent that its policy cancels or
fails can deadlock with the purge, and PostgreSQL then aborts one of them with `40P01`. A cancel of
the same task has the same limit. SM-1286 keeps the limit, as the second amendment below records.

Two purges run one after the other, also for different queues. Each purge takes one transaction
advisory lock, `hashtextextended('workhorse:purge-queue', 0)`, before any row lock. Without it, two
purges whose queues depend on each other could deadlock. For example, a purge of `q1` holds the
task `C` and waits for its dependent `B` in `q2`, while a purge of `q2` holds `B` and waits for its
dependent `C`. Two cancels cannot form that cycle. The cost is that a purge waits for any other
purge to commit, also when the two queues have no dependency between them. A purge is a rare
operator action, so this cost is small.

The purge lock has one limit. A transaction that already holds task row locks, for example after a
cancel or an enqueue, must not call a purge. Another purge can hold the purge lock and wait for one
of those rows, while the transaction waits for the purge lock. PostgreSQL then aborts one of them
with `40P01`. The admin CLI and the dashboard run a purge in its own transaction, so the limit does
not apply to them. SM-1289 keeps the limit, as the amendment below records.

A first design locked the purged tasks and their dependents in one identity order, `FOR UPDATE`.
That protected the enqueue case, but a dependent below its prerequisite was then locked before the
prerequisite. A concurrent cancel of the prerequisite, which locks it first, could thus deadlock
with the purge.

The purge deletes first and cancels after the deletes. Thus a group callback that a cancel enqueues
on the purged queue survives, as it does for the member counts of the deleted tasks.

The signature and the result of `purge_queue_v1` do not change. The result column `deleted_count`,
and `deletedCount` in the SDKs and in the CLI JSON, count the canceled tasks too, because each of
them leaves the waiting set of the queue. The name thus no longer matches its meaning exactly.
SM-1285 keeps the name and the shape. A rename or a separate count of canceled tasks needs a
`purge_queue_v2` and a change in every SDK and in the admin CLI. `docs/compatibility.md` sets this
rule. That cost is too large for a change of name only. The documentation of each surface states
that the count includes the canceled tasks.

## Consequences

- A purge succeeds for every dependency graph.
- A dependent outside the purge gets the outcome that a cancel of its prerequisite gives it. A
  dependent that waits for other prerequisites keeps its rejection until they finish.
- A canceled task keeps its history and its idempotency, debounce, and throttle bindings, as after
  a cancel. A later request with its key gets the result that it gets after a cancel, not a new
  task.
- A purge can now enqueue work and settle tasks in other queues through the outcome trigger. A
  cancel of the prerequisite does the same.
- The purge count, `deleted_count` in SQL and `deletedCount` in the SDKs, the CLI JSON, and the
  dashboard API, includes the canceled tasks. A caller cannot get the number of deleted tasks
  alone from the result.
- A purge in a transaction that already holds task row locks can deadlock with another purge. The
  amendment below keeps this limit.
- An enqueue that names a purged or canceled task and a dependent that its policy rejects can
  deadlock with the purge or the cancel. The second amendment below keeps this limit.

## Amendment: keep the purge lock limit (2026-10-22)

SM-1289 keeps the limit of the purge lock. A purge does not check whether its transaction already
holds task row locks. PostgreSQL cannot reliably tell whether the own transaction holds row locks,
so such a check cannot be exact. `pg_locks` lists a row lock only while another transaction waits
for it. Otherwise the lock is only in the header of the row.

The admin CLI and the dashboard run a purge in its own transaction, so the limit does not apply to
them. An `Admin` that runs in a transaction of the caller must call a purge before it locks task
rows, or in a separate transaction.

`typescript/core/test/integration-purge-transaction-deadlock.test.ts` reproduces the cycle:

1. The transaction T1 cancels the task `X`, so T1 holds a lock on `X`.
2. A purge in T2 takes the purge lock and waits for `X`.
3. T1 then purges another queue and waits for the purge lock.
4. PostgreSQL aborts one of them with `40P01`. The error detail names the advisory lock.

The two other choices of SM-1289 have these costs:

- A purge could take the purge lock only when it has a dependent in another queue. Such a purge
  still has the cycle.
- A refusal check cannot find the row locks of its own transaction in `pg_locks`. A check for a
  transaction ID refuses too much, because any earlier write, also outside the task tables, gives
  the transaction an ID.

## Amendment: keep the cancel and enqueue lock limit (2026-10-22)

SM-1286 keeps the limit between a cancel, or a purge, and an enqueue. Workhorse adds no retry and no
new lock order, because an SDK cannot send again an enqueue that runs in a transaction of the
caller, and a cancel learns its dependents only after it locks its task.

The cycle needs a dependent that sorts below its prerequisite. Task identities are random, so about
half of all pairs have that order. `typescript/core/test/integration-cancel-enqueue-deadlock.test.ts`
reproduces the cycle:

1. The task `B` depends on `A` with `on_cancellation = cancel`, and `B` sorts below `A`.
2. A cancel of `A` locks `A`. A third transaction holds `B` and pauses the cancel.
3. An enqueue names `A` and `B`. It locks `B` and waits for `A`.
4. The third transaction ends. The cancel locks `B` for deletion and waits for the enqueue.
5. PostgreSQL aborts one of them with `40P01`.

The same test shows that an enqueue waits for the cancel without a cycle when `B` sorts above `A`.

The other choices have these costs:

- An SDK retry of an enqueue on `40P01` cannot replay the statements that the caller ran earlier in
  the same transaction. It would also have to exist in six SDKs.
- A global lock order needs the dependents before the cancel locks its task. The cancel finds them
  only through its outcome trigger, after the lock.

A caller that gets `40P01` from a cancel, a purge, or an enqueue can run its transaction again.

## Rejected alternatives

### Settle the dependent at once

The purge could resolve the dependent, settle it at once with its `fail` or `cancel` resolution, and
delete the edge. A dependent that waits for other prerequisites then settles earlier than after a
cancel, and a later failure no longer takes precedence over the cancel.

### Store the rejection without the edge

A stored rejection action on `task_runtime` could replace the deleted edge as evidence. That changes
`settle_dependents_v1`, the drift report, and the counter repair, which is a large change to the
dependency core for one caller.

### Refuse the purge

The purge could refuse with a Workhorse error code. Then the operator must first clean up every
dependent by hand, and a purge of one queue depends on the state of other queues.
