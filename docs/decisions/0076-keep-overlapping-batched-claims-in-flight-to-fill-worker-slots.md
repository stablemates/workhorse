# ADR 0076: Keep overlapping batched claims in flight to fill worker slots

- **Status:** Accepted
- **Date:** 2026-09-23
- **Amended by:** SM-919 (a worker that batches completions splits its slots into cohorts; see below)
- **Amended by:** SM-1676 (a fused refill gives the other queues of a worker a claim; see below).
  Rule 17 is not shipped: SM-1834 removed it before 0.10.0, and
  [SM-1833](https://linear.app/stablemates/issue/SM-1833) owns a corrected rule.
- **Amended by:** [ADR 0078](0078-start-a-long-running-workers-first-claim-beside-its-startup-maintenance-pass.md)
  (a long-running worker starts its first claim beside its startup maintenance pass)
- **Related:** [ADR 0071](0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md),
  [ADR 0072](0072-converge-the-worker-runtime-defaults.md),
  [ADR 0075](0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md)

## Context

[SM-907](https://linear.app/stablemates/issue/SM-907) measured Node worker throughput and found it
flat as concurrency grew: 647 tasks/s at concurrency 1 and 809 at concurrency 16.
[SM-909](https://linear.app/stablemates/issue/SM-909) found the cause in the dispatch loop.

Every SDK ran the same loop. It filled its free slots with one `claim_many_v1` call and waited for
that call to return. Once every slot was busy, it waited for one handler to finish, claimed
`concurrency - active` tasks, and waited again. In the steady state that difference is almost always
1, so a worker made one claim round trip per task, one at a time. Batch claiming only helped the
first fill.

A profile made the ceiling visible. Sixteen slots behind one dispatch loop ran 1,607 tasks/s.
The same sixteen slots behind sixteen dispatch loops, in the same process and on the same pool,
ran 8,095. Each task cost exactly one claim, and PostgreSQL sat idle waiting for the worker.

Python, Go and Rust have the same shape in `Worker._run_loop`, `fillSlots` and the Rust run loop.
The planned Ruby worker in ADR 0075 claims "only as many tasks as the pool has idle threads", so it
would have copied the ceiling.

## Decision

**A worker keeps more than one claim in flight, and each refill claim covers a batch of slots.**
Every SDK implements the same rules, including Ruby.

1. **Reservation.** A claim in flight reserves as many slots as its limit. The free slots are
   `concurrency` minus the running handlers minus the reserved slots. Claimed tasks therefore never
   exceed `concurrency`, and the worker keeps no prefetch buffer. A claimed task holds a lease, so
   a buffered task would spend lease time without running.
2. **The first claim.** When no claim is in flight, any free slot starts a claim for every free
   slot. An idle worker reacts to one finished handler as quickly as before.
3. **Overlapping claims.** While a claim is in flight, the worker starts another only when the free
   slots reach the refill batch, `ceil(concurrency / 4)`. A busy worker therefore claims about a
   quarter of its slots per round trip. At most four claims per worker are in flight, which bounds
   the connections a claim burst takes from the pool that ADR 0071 sizes.
4. **The loop never blocks on a claim.** It waits for the first of three events: a handler
   finished, a claim returned, or a wake. Starting a claim only records a pending result.
5. **Empty claims.** A claim that returns no task counts as empty. So does a claim that returns
   only tasks without a registered handler, which the worker releases with `release_owned_v1` as
   before. An empty claim increments the empty-claim count and starts the empty-poll wait. During
   that wait the worker starts no claim until the poll deadline from ADR 0072 passes, or until a
   dispatch wake arrives after that claim started. A claim that ran a handler resets the count and
   ends the wait.
6. **Notification delay.** The random delay before a notification-triggered claim runs inside the
   claim, so it never blocks the loop. It applies only when the last claim found nothing (SM-933).
   A busy worker would claim at once anyway, and a dependency release notifies on every completion. If the worker paused or stopped during the delay, it sends no
   claim and frees the reservation.
7. **Pause.** A paused worker starts no claim. It keeps observing its handlers and its claims in
   flight.
8. **Claimed tasks always run.** A claim can return after `stop`, after `pause`, after a handler
   failure or after another claim failed. The worker still starts every task that claim returns,
   because each one holds a lease that only the worker can settle.
9. **Shutdown.** On `stop`, the worker starts no further claim. It waits for every claim in
   flight, runs the tasks they return, and then waits for every handler. Each SDK keeps the error
   policy it had before this decision. The Node, Python and Go workers also shut down this way on a
   fatal handler failure or a claim error, and report the handler failure first. The Rust worker
   logs a claim error, backs off as after an empty claim, and keeps running after a handler error.
   Aligning that policy is a separate decision.

`run_once` and the other single-pass entry points keep their contracts. They end after one empty
sweep and report whether a handler ran.

The shared runtime fixture `busy-worker-refills-slots-with-overlapping-batched-claims` in
`protocol/v1/runtime.json` pins rules 2 and 3 in every SDK. At concurrency 8 it holds claims open
in PostgreSQL's path and requires the claim limits 8, 1 and 2 with two claims in flight. It then
requires fewer than one claim per task over the whole run. Each SDK adds unit tests for pause,
drain at `stop`, the empty-poll wait and the release of unhandled task types.

### Cohorts for batched completions

_Amended by [SM-919](https://linear.app/stablemates/issue/SM-919)._ ADR 0077 lets a worker complete
fast-tier tasks in batches. Concurrent completions share one `complete_many_and_claim_v1` round
trip, and that round trip claims the tasks that refill their slots. A busy worker then settles into
lockstep. Its handlers finish together, wait together for one completion round trip, and restart
together, so every slot idles for the same round trip.

A worker that batches completions therefore splits its slots into cohorts. Each cohort then waits
on its own completion round trip while the other cohorts' handlers run.

10. **Cohort shares.** The `cohorts` option splits `concurrency` into that many fixed shares. The
    first cohorts take the remainder. Every claimed task belongs to one cohort for its whole run.
11. **Default.** A worker that batches completions has one cohort per 8 slots, rounded up, with
    at least 2 and at most 8. Below concurrency 8 it has one. One cohort is the dispatch described
    by rules 1 to 9. When the worker knows the size of the pool that runs its statements, the
    default is also at most the connections left after the listener and the heartbeat connection,
    and at least 1. An explicit `cohorts` is not capped.
12. **Batched completions stay within a cohort.** Concurrent completions share a round trip only
    within one cohort. A completion's fused claim asks for at most its cohort's free slots, and the
    tasks it claims join that cohort.
13. **Refill batch per cohort.** Rule 3 applies to a fused claim within its cohort. A claim in
    flight for another cohort does not hold back a completion's claim for its own free slots.
14. **Plain claims.** While no claim is in flight, a plain claim fills the cohort with the most
    free slots. The next cohort's claim starts when that claim returns. The first claim asks for one
    cohort's share, which starts the cohorts out of phase. It still reserves every free slot until
    it learns the tier, so a queue that answers on the full tier fills every slot as before.
15. **Full-tier queues.** A worker ignores cohorts while any of its queues answers on the full tier,
    and uses rules 1 to 9 unchanged. The shared fixture therefore still requires the claim limits 8,
    1 and 2 at the default of two cohorts.
16. **Every worker batches.** The TypeScript, Python, Go and Rust workers all follow rules 10 to
    15 on the fast tier. Each groups its completions by queue and cohort into fused
    `complete_many_and_claim_v1` statements.

More cohorts cost more round trips. Each completion batch is smaller, so statement time per task
rises, and each cohort can hold one more pooled connection. At concurrency 16 on the fast tier, two
cohorts ran about 1.2 times the throughput of one. They raised statement CPU per task from 0.029 ms
to 0.040 ms, and pooled connections in use from 3 to 4. At concurrency 4, two cohorts did not beat
the spread between repetitions.

The best count grows with the round trip between the worker and PostgreSQL. A cohort idles for one
round trip per batch, so a longer round trip needs more cohorts to keep slots busy. At concurrency
64 with 1 ms added to each round trip, eight cohorts ran about 1.23 times the throughput of two.
With no added round trip, eight cohorts ran about 0.94 times the throughput of two. Sixteen or more
cohorts ran slower than eight at both delays, because every cohort adds claims that contend in
PostgreSQL. The default therefore grows one cohort per 8 slots and stops at 8. That contention
depends on the database's CPU, so a worker can set `cohorts` for its deployment.

Each cohort can have its own round trip in flight, so a worker at 8 cohorts peaked at 10 pooled
connections: one per cohort, the listener and the heartbeat connection. A smaller pool makes the
cohorts queue for connections. At concurrency 64, eight cohorts against one ran about 1.11 times the
throughput on a 32-connection pool and about 1.2 times on a 10-connection pool. On a 4-connection
pool the ratio fell to between 0.92 and 1.16, and on a 3-connection pool to about 0.6. Capping the
count at the spare connections gave 4 cohorts on a 6-connection pool and 2 on a 4-connection pool,
which ran about 1.4 times the throughput of one. Rule 11 therefore caps the default by the pool size
when the worker can read it.

### Queue fairness for fused refills

**Status of rule 17: not shipped.** No release contains rule 17. A measurement in the private
performance lab ([SM-1821](https://linear.app/stablemates/issue/SM-1821)) did not confirm the cost
estimate below for every worker. Thus the maintainer decided not to ship rule 17 in 0.10.0, and
[SM-1834](https://linear.app/stablemates/issue/SM-1834) removed it from every
SDK worker. Every worker again behaves as rule 12 states: while one fast-tier queue has a backlog,
the other queues of the worker can get no claim until that backlog ends. The fixture
`a-fused-refill-gives-the-other-queues-a-claim` is also removed.
[SM-1833](https://linear.app/stablemates/issue/SM-1833) owns a corrected rule. The text below
records the decision of SM-1676 and the rejected options without change.

_Amended by [SM-1676](https://linear.app/stablemates/issue/SM-1676)._ Rule 12 lets a fast-tier
completion refill its slot in the same statement. That fused claim asks only the queue of the
completed task. A worker can serve several queues, and its plain claims rotate across them. But a
plain claim starts only for a free slot. While one fast-tier queue has a backlog, its completions
refill every slot, so no plain claim starts, and the other queues get no claim until the backlog
ends.

**Example.**

1. A worker serves fast-tier queues `a` and `b`, with concurrency 1.
2. Queue `a` holds 100 ready tasks. Queue `b` holds 1 task.
3. Each `a` completion claims the next `a` task, so the slot never becomes free.
4. Before this amendment, the `b` task ran after the last `a` task.

The amendment adds rule 17.

17. **Queue fairness.** A worker with more than one queue records when a claim last asked each
    queue. A plain claim records each queue that its rotation asks. A fused claim records its own
    queue when its limit is above 0. At the start of a run, every queue counts as asked. If another
    queue had no claim for one fairness interval, the next fast-tier completion claims with limit 0.
    Its slot becomes free, and the next plain claim continues the rotation. Only one completion at a
    time gives up its refill, until the next plain claim starts. Until then, a fused claim refills
    only the slot of its own task, so it cannot take the slot that the skip gave back. The fairness
    interval is the explicit poll interval, or 250 ms without one. A worker with one queue does not
    change.

The plain claim keeps the rotation, so it can ask the busy queue first and fill its limit there.
Then the next completion gives up its refill at once, and the plain claim after it asks the other
queue. With two queues, a ready task on the other queue waits at most about one fairness interval,
plus two handler runs and two claim round trips. The cost is at most two plain claim round trips for
each fairness interval, and only for a worker with more than one queue. During each round trip, the
slot that gave up its refill is idle. The fixture `a-fused-refill-gives-the-other-queues-a-claim` pins
the rule in every SDK.

The rule uses time and not a count of tasks, so its cost does not grow with the task rate. A count,
such as one skipped refill after each `concurrency` completions, would send every second task
through a plain claim at concurrency 1.

## Consequences

### Positive

- One worker's throughput rises with its concurrency instead of stopping at one claim round trip
  per task.
- A busy worker sends fewer claims than it runs tasks, which lowers claim traffic on PostgreSQL.
- The five SDKs share one dispatch shape, so one fixture and one table compare them.

### Negative

- A worker can hold up to four claim transactions at once, where it used to hold one. A pool below
  the size ADR 0071 recommends waits for a connection instead of failing, but a claim burst can
  delay a handler's own query on the same pool.
- The dispatch loop is harder to read. It now tracks claims in flight and reserved slots beside
  running handlers, and every SDK has to handle a claim that returns during shutdown.
- A quarter of the concurrency is a fixed ratio, not a tuned one. A worker with very slow claims
  and very fast handlers may still wait on claims.

## Rejected alternatives

### Prefetch a buffer of claimed tasks

A worker could claim ahead of its free slots and hand buffered tasks to slots as they free.

It was rejected because a Workhorse claim takes a lease. A buffered task spends lease time and
attempt timeout without running, and a crashed worker strands its whole buffer until lease
recovery. Rule 1 gets most of the benefit without either cost.

### Claim only at a low-water mark

A worker could wait until a quarter of its slots were free and then claim them in one call, with
one claim in flight at most.

It was rejected because it leaves slots idle by design. At concurrency 4 the batch is one slot,
which is the old loop. At concurrency 16 four slots sit idle for a full round trip before each
refill. Overlapping claims keep the same batch size but refill while earlier claims are still out.

### Accept the starvation and advise one worker per hot queue

SM-1676 considered keeping rule 12 as it was. The ADR would then advise a separate worker for each
fast-tier queue with a continuous backlog.

It was rejected because the wait of the other queues has no bound and no signal. Nothing in the
dashboard or the logs shows why a task on the other queue does not run. The `queues` option also
promises one budget that rotates across the queues.

### Fuse the refill with the next queue in rotation

A fused completion could claim from the next fast-tier queue in rotation instead of its own queue.

It was rejected because each SDK batches completions by queue and cohort. The batch key would have
to follow the claim queue in seven SDKs. If the next queue is empty, the fused claim returns no task,
and the slot waits for a plain claim round trip. A full-tier queue cannot take part, because
`complete_many_and_claim_v1` rejects a queue that is not on the fast tier.

### Claim across several queues in one fused statement

A new version of `complete_many_and_claim_v1` could take a list of queues and claim from them in
rotation.

It was rejected because it needs a new SQL protocol version and a change in every SDK for the same
result as rule 17. It still could not claim from a full-tier queue.

### Give each queue a fixed share of the slots

A worker could split its slots by queue, and a fused refill could fill only its queue's share.

It was rejected because the slots of an idle queue stay empty, which lowers throughput for most
workers. It is a new feature, not a correction of rule 12.

### Run one dispatch loop per slot

The profile showed that sixteen single-slot loops reach 8,095 tasks/s.

It was rejected because each loop sends a claim for every task, which doubles claim traffic on
PostgreSQL compared with batched refills. Sixteen loops also split one worker's queue rotation,
pause state and empty-poll backoff into sixteen copies.
