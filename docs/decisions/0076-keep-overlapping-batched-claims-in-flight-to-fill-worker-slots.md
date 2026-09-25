# ADR 0076: Keep overlapping batched claims in flight to fill worker slots

- **Status:** Accepted
- **Date:** 2026-09-23
- **Related:** [ADR 0071](0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md),
  [ADR 0072](0072-converge-the-worker-runtime-defaults.md),
  [ADR 0075](https://github.com/stablemates/workhorse/pull/236)

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
   claim, so it never blocks the loop. If the worker paused or stopped during the delay, it sends no
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

### Run one dispatch loop per slot

The profile showed that sixteen single-slot loops reach 8,095 tasks/s.

It was rejected because each loop sends a claim for every task, which doubles claim traffic on
PostgreSQL compared with batched refills. Sixteen loops also split one worker's queue rotation,
pause state and empty-poll backoff into sixteen copies.
