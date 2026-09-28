# ADR 0078: Start a long-running worker's first claim beside its startup maintenance pass

- **Status:** Accepted
- **Date:** 2026-09-26
- **Amends:** [ADR 0072](0072-converge-the-worker-runtime-defaults.md),
  [ADR 0076](0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md)
- **Related:** [ADR 0011](0011-daily-retention-and-split-maintenance.md),
  [SM-907](https://linear.app/stablemates/issue/SM-907),
  [SM-912](https://linear.app/stablemates/issue/SM-912)

## Context

A worker offers maintenance on a fixed cadence. Each offer calls `tick_v1`, evaluates the
in-process schedules, and offers `run_maintenance_v1` when that routine is due. ADR 0072 fixed the
cadences. ADR 0076 fixed how a worker fills its slots. Neither record said when the first offer
runs relative to the first claim.

The four SDKs therefore disagreed. The Go and Rust workers registered and then started their
maintenance loop beside dispatch. The TypeScript and Python workers registered, finished a whole
maintenance pass, and only then claimed.

[SM-912](https://linear.app/stablemates/issue/SM-912) measured what that order costs. On a freshly
installed schema, the first `run_maintenance_v1` call compiles every function it reaches. The
startup pass took 26 to 30 ms before the TypeScript worker's first claim. A benchmark control
drained the same 100 tasks in 21 to 42 ms. A short run after a deploy therefore measured mostly the
startup pass. Starting the first claim beside that pass moved the first claim to 2 to 7 ms.

The pass does nothing a first claim needs. `claim_many_v1` claims every runnable task without it.
`tick_v1` promotes due tasks and recovers expired leases, and the next tick from any worker in the
fleet does the same work one interval later.

## Decision

**A long-running worker registers, then starts its first claim beside its startup maintenance
pass.** The TypeScript `Worker.run()`, the Python `Worker.run()` and `AsyncWorker.run()`, the Go
`Worker.Run`, and the Rust `Worker::run` all follow this order.

1. **Registration first.** The worker writes its registry row before its first claim, so a claimed
   task never names an unregistered worker instance.
2. **No wait for maintenance.** The worker does not wait for the startup maintenance pass before it
   claims. The pass runs on its own thread, task, or promise.
3. **One pass at a time.** The worker makes no further maintenance offer until the startup pass
   returns. The cadence from ADR 0072 then applies.
4. **A failed pass ends the run.** A startup pass that fails stops the run. The worker drains as ADR
   0076 rule 9 describes, and `run` reports the pass's error.
5. **A stopped run skips the pass.** A run that is already stopping when it starts makes no
   maintenance offer.

The single-pass entry points keep their order. TypeScript `runOnce()`, Go `RunOnce`, and Rust
`run_once` run maintenance before they claim. The Python `run_once()` does so whenever its
maintenance interval has elapsed. A single pass exists to make progress in one call, and a caller
that loops it would otherwise never wait for maintenance at all.

The TypeScript and Python workers pin rules 2 and 4 with unit tests. One test holds the startup
pass open and requires a claim before it returns. A second test fails the pass and requires `run`
to end with that error.

## Consequences

- A freshly deployed worker starts work sooner. The saving is largest on a new schema, where the
  first pass compiles functions, and in a deployment with many workers starting together.
- A task that became due while no worker ran waits up to one maintenance interval longer for
  promotion, unless a claim finds it runnable first. A task whose lease expired while no worker ran
  waits the same way for recovery. The bound matches a running fleet, where the tick-holding worker
  may promote just after another worker's claim.
- A schedule occurrence due at startup fires when the startup pass evaluates it, beside the first
  claims instead of before them.
- The SDKs no longer differ in startup order. `docs/architecture.md` states the order once for all
  four.
