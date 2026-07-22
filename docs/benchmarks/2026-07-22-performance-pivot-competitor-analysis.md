# Performance pivot and competitor baseline analysis

**Date:** 2026-07-22
**Status:** local engineering evidence, not publication-grade production evidence

## Executive conclusion

The architecture pivot is **worth keeping for write-path efficiency and operational isolation**, but it did **not** make Ironshift categorically faster.

Against the previous v3 architecture, the new live-runtime/cold-outcome model reduced hybrid enqueue time by roughly **7–12%** and fixed-run WAL by roughly **8–13%**. At one and four workers it brought hybrid WAL to about **1.02×** the internal conventional reference. Processing throughput was essentially unchanged at one and four workers and **8.5% lower** in the separate eight-worker run. The pivot therefore improves write amplification and hot-state boundedness, not proven dispatch speed.

Against external products under a controlled per-job handler contract:

- Ironshift measured **84–86% of Graphile Worker throughput** at one and four workers.
- At 16 workers, Ironshift's mean was **12% higher**, but the confidence intervals were wide and overlapped substantially. Superiority is not established.
- pg-boss's per-job worker configuration drained a preloaded queue at only **2–40 jobs/s** because its worker loop waits between single-job fetches. This is a product configuration characteristic, not evidence that its SQL engine is intrinsically slow.
- Enabling pg-boss's native ten-job handler batching changed its measured mean to **6,020–15,156 jobs/s**. Because that changes handler invocation and settlement semantics, it is a sensitivity result, not a common-contract ranking.
- At an offered load of 60 jobs/s, all three products completed all 600 jobs with maximum observed backlog 1. This workload was below capacity and does not distinguish overload behavior.

The defensible position is not “Ironshift is faster.” It is:

> Ironshift is a correctness-first PostgreSQL execution protocol with explicit fencing and crash semantics, bounded live dispatch state, immutable operational history, and PostgreSQL-aware diagnostics. Its current per-job throughput is competitive with Graphile Worker on this small local test, while its retained audit model costs materially more WAL and storage.

## Evidence artifacts

| Artifact                                                                                                         | Purpose                                              | Clean source            |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------- |
| [`2026-07-22-runtime-pivot-v3-default.json`](results/2026-07-22-runtime-pivot-v3-default.json)                   | Same v3 harness before/after architecture comparison | commit `8398a6d`, clean |
| [`2026-07-22-competitor-smoke.json`](results/2026-07-22-competitor-smoke.json)                                   | Controlled three-target wiring and invariant gate    | commit `3e5acfc`, clean |
| [`2026-07-22-competitor-default.json`](results/2026-07-22-competitor-default.json)                               | Controlled per-job baseline                          | commit `3e5acfc`, clean |
| [`2026-07-22-competitor-pgboss-batched-default.json`](results/2026-07-22-competitor-pgboss-batched-default.json) | Separately labeled pg-boss batch-size sensitivity    | commit `719cfd2`, clean |
| [`2026-07-21-v3-default.json`](results/2026-07-21-v3-default.json)                                               | Previous architecture reference                      | commit `477eee4`, clean |

The final repository validation also covers the later review fixes and sensitivity CLI. The controlled artifacts remain reproducible evidence for their exact clean commits.

## What changed architecturally

Schema version 2 replaces the old current/ready/scheduled/lease projection set with:

1. immutable `job` identity and payload;
2. one mutable `job_runtime` row only while work is scheduled, ready, or active;
3. immutable `job_outcome` terminal materialization;
4. append-only, partitioned `job_event` and `attempt_history`.

Terminal transitions delete the runtime row and insert the outcome atomically. The ready, scheduled, and expiry indexes contain only live work. The architecture preserves transactional batch enqueue, FIFO ordering, leases, monotonic fencing, heartbeats, retries, recovery, immutable attempts/events, and the public Queue/Worker API.

Independent review found and fixed three issues before acceptance:

- schema installation now refuses mixed v1/v2 or unversioned existing schemas, and health no longer reports a mixed schema as clean v2;
- retry and recovery reset the fence token to zero when a job becomes unowned again;
- benchmark documentation now names the v2 `job_runtime_ready_idx` claim index.

## Architecture pivot results

The table compares the previous hybrid architecture with the new runtime architecture using the same v3 default harness. These are separate local runs, so deltas are engineering signals rather than paired causal estimates.

| Workers | Old hybrid jobs/s | Pivot jobs/s | Throughput change | Old enqueue ms | Pivot enqueue ms | Enqueue change | Old WAL bytes | Pivot WAL bytes | WAL change | Pivot throughput vs conventional | Pivot WAL vs conventional |
| ------: | ----------------: | -----------: | ----------------: | -------------: | ---------------: | -------------: | ------------: | --------------: | ---------: | -------------------------------: | ------------------------: |
|       1 |               748 |          734 |             -1.9% |           5.78 |             5.38 |          -7.0% |       338,125 |         293,763 |     -13.1% |                           102.6% |                     1.02× |
|       4 |             1,951 |        1,936 |             -0.7% |           6.39 |             5.63 |         -11.9% |       332,869 |         293,829 |     -11.7% |                            99.0% |                     1.02× |
|       8 |             3,317 |        3,035 |             -8.5% |           6.32 |             5.74 |          -9.2% |       336,189 |         310,384 |      -7.7% |                            93.4% |                     1.10× |

### Interpretation

- The pivot achieved its clearest goal: fewer mutable relations and less WAL per lifecycle.
- Enqueue improved consistently.
- Dispatch did not improve consistently. The eight-worker decline means the architecture should not be called performance-superior.
- Retained terminal state no longer occupies the dispatch relation or its partial indexes. That structural property matters more at long retention horizons than in this 100-job benchmark and still requires long-run proof.

## Controlled external baseline

### Contract

The controlled baseline uses:

- the same Node process, PostgreSQL database class, 32-connection ceiling, payload, job counts, ingress batches, concurrency sweep, and exact handler-completion requirement;
- public APIs only;
- per-job handler invocation for every product;
- deterministic three-target order rotation with six repetitions per worker count;
- 100 preloaded immediate jobs per fixed run;
- 600 jobs at 60 jobs/s for the exploratory churn run;
- graceful shutdown and telemetry outside timed phases;
- explicit acknowledgement that handler completion is not a cross-product durable-settlement oracle.

The products are not semantically equivalent. Ironshift retains job identity, outcomes, events, and attempts. pg-boss retains successful jobs in this run. Graphile Worker deletes successful jobs. WAL and storage are therefore native lifecycle costs, not retention-normalized rankings.

### Fixed-run processing throughput

Mean jobs/s with 95% Student-t confidence intervals across six repetitions:

| Workers |            Ironshift |      Graphile Worker | Ironshift / Graphile |      pg-boss per-job |
| ------: | -------------------: | -------------------: | -------------------: | -------------------: |
|       1 |       747 [726, 767] |       891 [833, 949] |                83.8% |    2.04 [2.03, 2.05] |
|       4 | 2,060 [1,949, 2,172] | 2,387 [1,783, 2,991] |                86.3% |    8.69 [8.68, 8.69] |
|      16 | 4,164 [3,297, 5,031] | 3,703 [2,186, 5,220] |               112.4% | 39.81 [39.73, 39.90] |

Ironshift and Graphile overlap at 16 workers and the environment variance is large. The safe conclusion is that Ironshift is in the same local order of magnitude, not that it wins.

The pg-boss result needs special interpretation. With `batchSize: 1`, pg-boss intentionally does not hot-loop on every successful single-job fetch. A preloaded no-op queue therefore exposes polling cadence rather than maximum SQL throughput. The value is useful as a controlled per-job product-runtime result, but it is not a fair basis for claiming Ironshift is hundreds of times faster.

### pg-boss batching sensitivity

A separate clean run changed only pg-boss handler batch size to 10 and enabled its full-batch burst path:

| Workers | pg-boss per-job jobs/s | pg-boss batch-10 jobs/s |
| ------: | ---------------------: | ----------------------: |
|       1 |                   2.04 |                   6,020 |
|       4 |                   8.69 |                  15,156 |
|      16 |                  39.81 |                  11,283 |

This inversion is one of the most important results. For no-op work, runtime configuration and handler batching dominate the ranking. The batch-10 values are a valid native-product sensitivity, but not a common per-job comparison. A future publication should include a declared matrix of controlled and product-optimized modes for all competitors.

### Ingress

Controlled mean enqueue durations for 100 jobs were:

| Workers | Ironshift | Graphile Worker | pg-boss |
| ------: | --------: | --------------: | ------: |
|       1 |   6.72 ms |         5.91 ms | 6.69 ms |
|       4 |   6.81 ms |         6.14 ms | 6.62 ms |
|      16 |   6.57 ms |         5.72 ms | 6.80 ms |

Ironshift ingress was roughly 11–15% slower than Graphile Worker in this run and close to pg-boss. The difference is small in absolute terms and does not establish a practical user-visible disadvantage without larger payload and transaction tests.

### Churn

At 60 offered jobs/s and 16 workers:

| Target          | Completion rate | Max backlog |   Drain |         WAL | Schema growth |
| --------------- | --------------: | ----------: | ------: | ----------: | ------------: |
| Ironshift       |    59.98 jobs/s |           1 | 1.83 ms | 2,190,480 B |   1,376,256 B |
| pg-boss         |    59.96 jobs/s |           1 | 3.81 ms |   808,168 B |     303,104 B |
| Graphile Worker |    59.97 jobs/s |           1 | 2.54 ms |   684,168 B |     196,608 B |

All targets kept up. This is a below-capacity correctness result, not a saturation ranking. Churn has one observation per target, so no confidence-backed claim is justified.

The resource cost is nevertheless visible under an equal-duration workload. Ironshift emitted about **2.7× pg-boss WAL** and **3.2× Graphile WAL**, with about **4.5× pg-boss** and **7.0× Graphile** schema growth. Much of this is the chosen retained identity/outcome/event/attempt model. The result is a cost that must be justified by operational value.

## Supported selling points

These are supported by implementation, tests, and the current evidence:

1. **Explicit correctness semantics.** Transactional enqueue, scheduling, FIFO claims, renewable leases, monotonic fencing, stale-owner rejection, retries, expiry recovery, and at-least-once boundaries are specified in versioned SQL functions.
2. **Executable crash behavior.** Deterministic failpoints cover worker boundaries, and live PostgreSQL tests verify the resulting durable state and recovery behavior.
3. **Bounded live dispatch state.** Terminal jobs leave `job_runtime`; payload, terminal outcome, events, and attempts are isolated from the ready/scheduled/expiry indexes.
4. **Immutable operational history.** Attempts and lifecycle events are append-only and partitionable, supporting audit and postmortem analysis without querying the dispatch relation as an analytics table.
5. **PostgreSQL-aware health.** The API exposes queue depths, oldest-ready age, relation/index size, dead tuples, HOT ratio, vacuum timestamps, lock waits, oldest transactions, and notification queue usage.
6. **Same-database transactional composition.** Enqueue can participate in the caller's PostgreSQL transaction, avoiding a separate broker/outbox hop for same-database application changes.
7. **A credible protocol seam.** Stable job identity, canonical JSON payloads, fencing, outcomes, events, and versioned transition functions are plausible foundations for future conformance-tested language clients.
8. **Measured write-path improvement from the pivot.** The new model reduced local v3 enqueue time and WAL without weakening lifecycle semantics.

## Claims not supported

Do not claim:

- that Ironshift is generally faster than Graphile Worker or pg-boss;
- that the 16-worker Graphile result proves superiority;
- that controlled pg-boss per-job throughput represents its optimized capacity;
- that pg-boss batch-10 throughput is semantically equivalent to per-job handlers;
- that Ironshift is storage-efficient relative to products that delete successful jobs or retain less audit state;
- that the queue is stable under saturation, overload, long retained history, held snapshots, or replication lag;
- exactly-once external effects;
- production readiness or a current cross-language runtime.

## Product and architecture recommendation

Keep the live-runtime/cold-outcome architecture. It is simpler, makes the hot state structurally bounded, and reduces write amplification. Do not market the pivot as a throughput breakthrough.

The next performance work should target round trips rather than another table-layout rewrite:

1. prototype `claimMany` with per-job fencing and per-job handler invocation;
2. prototype batched or pipelined settlement that preserves independent job outcomes;
3. separate maintenance cadence from every worker iteration;
4. add controlled versus product-optimized configuration matrices;
5. run saturation sweeps and long retained-history tests at 10k, 100k, and 1M completed jobs;
6. measure p95/p99 start latency, vacuum work, dead tuples, and claim-plan stability while cleanup is blocked.

The commercial decision remains gated. Ironshift should proceed as a narrow correctness and operability core only if design partners value fencing, crash evidence, retained history, and PostgreSQL diagnostics enough to accept the measured write/storage premium. If buyers mainly want raw no-op throughput, pg-boss batching and mature incumbents are the stronger starting point.
