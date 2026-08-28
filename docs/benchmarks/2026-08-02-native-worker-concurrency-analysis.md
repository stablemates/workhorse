# Native worker concurrency benchmark analysis

**Date:** 2026-08-02  
**Status:** local engineering evidence from a dirty working tree, not publication-grade production evidence

## Scope

This run closes two gaps in the previous benchmark coverage:

1. the external competitor target now exercises one real Workhorse `Worker` with
   `WorkerOptions.concurrency`, rather than creating one manual claim loop and worker ID per concurrency
   unit;
2. the `worker-concurrency` lifecycle scenario compares equal total capacity across one multi-slot
   worker, two balanced workers, and multiple single-slot workers under immediate and I/O-like handlers.

All topology runs use separate `Worker` objects in one Node.js process. They do not measure operating-system
process isolation, container scaling, or global queue concurrency.

## Artifacts

- [`results/2026-08-02-worker-concurrency-default.json`](results/2026-08-02-worker-concurrency-default.json)

Environment: AMD Ryzen 7 8745HS, 16 logical CPUs, Node.js 24.15.0, local PostgreSQL, schema v12.
Both artifacts correctly report a dirty source tree because the benchmark implementation itself was uncommitted.

## Native slot scaling

The lifecycle scenario used 24 jobs and an approximately 120 ms handler delay, long enough to exercise
independent heartbeats.

| Local concurrency | Duration | Jobs/s | Maximum handler overlap | Claim calls | Heartbeats |
| ----------------: | -------: | -----: | ----------------------: | ----------: | ---------: |
|                 1 | 2,969 ms |   8.08 |                       1 |          24 |         50 |
|                 4 |   754 ms |  31.83 |                       4 |          25 |         57 |
|                 8 |   382 ms |  62.85 |                       8 |          25 |         54 |

For this I/O-like workload, one native Worker scaled close to the configured slot count while preserving
serial claims. The scenario completed all 104 correctness assertions.

## Equal-capacity topology comparison

Each topology exposed eight total handler slots and processed 24 jobs.

### Immediate handlers

| Topology    | Workers × slots | Jobs/s | Start p95 | Claim calls | Max concurrent claims | Max handler overlap |
| ----------- | --------------- | -----: | --------: | ----------: | --------------------: | ------------------: |
| Single      | 1 × 8           |    998 |   22.0 ms |          24 |                     1 |                   1 |
| Balanced    | 2 × 4           |  1,626 |   13.2 ms |          25 |                     2 |                   1 |
| Distributed | 8 × 1           |  2,064 |   10.4 ms |          26 |                     6 |                   1 |

The handlers completed too quickly to overlap. Throughput was dominated by claim round trips. Multiple
independent workers issued claims concurrently and therefore completed the synthetic no-op workload faster,
but increased concurrent claim pressure from one to six and issued more total claims.

### I/O-like handlers

| Topology    | Workers × slots | Jobs/s | Start p95 | Claim calls | Max concurrent claims | Max handler overlap |
| ----------- | --------------- | -----: | --------: | ----------: | --------------------: | ------------------: |
| Single      | 1 × 8           |  63.11 |  257.6 ms |          25 |                     1 |                   8 |
| Balanced    | 2 × 4           |  63.82 |  254.3 ms |          25 |                     2 |                   8 |
| Distributed | 8 × 1           |  64.32 |  251.0 ms |          24 |                     8 |                   8 |

Once handler time dominated claim time, all three topologies produced nearly identical throughput and start
latency. The single multi-slot Worker achieved this with serialized claims, while the distributed topology
allowed eight simultaneous claim queries.

## Graceful shutdown evidence

The shutdown sub-scenario seeded six jobs, filled four active slots, called `worker.stop()`, and then released
the handlers.

- claim calls at stop: **4**;
- claim calls after drain: **4**;
- active jobs completed: **4**;
- unclaimed jobs left ready: **2**;
- final active slots: **0**;
- final active leases: **0**;
- final expired leases: **0**.

This confirms the implemented graceful behavior: `stop()` prevents additional claims, keeps already active
handlers running with their heartbeat/fence machinery, waits for their terminal transitions, and resolves
`run()` only after those handlers drain. It does not impose a timeout or forcibly interrupt handlers. A handler
that never settles can therefore delay shutdown indefinitely unless the application supplies its own shutdown
policy and cooperative cancellation.

## Recommendation

Keep the current single-coordinator, multi-slot model as the default architecture. It reaches the same
throughput as multiple workers when handlers contain meaningful asynchronous work, while bounding concurrent
claim pressure and retaining a simpler pause/drain lifecycle.

The next optimization should be a bounded `claimMany(limit = freeSlots)` prototype with independent per-job
fences and handler settlement. Compare it against the current serial claim path using both no-op and I/O-like
profiles. Do not replace the architecture with one polling loop per slot based only on no-op throughput.
