# Benchmark suite v3 default-profile analysis, 2026-07-21

## Executive conclusion

V3 validates the targeted optimization strategy. It does **not** justify replacing the hybrid projection architecture.

The new set-based `enqueueMany` path reduced the hybrid/conventional enqueue-duration ratio from roughly **5.3–6.0× in v2** to **1.08–1.50× in v3**. With enqueue no longer dominating the run, end-to-end throughput was approximately at parity across the 1, 4, and 8 worker configurations:

- 1 worker: hybrid reached **98.2%** of conventional throughput;
- 4 workers: **100.0%**;
- 8 workers: **100.3%**.

The three-repetition nominal t intervals remain too weak for formal equivalence or superiority claims. The defensible conclusion is narrower: **the large v2 throughput gap disappeared after batching, and no material claim/complete processing disadvantage is visible in this run.**

Under equal offered load, both designs accepted and completed exactly 500 jobs at a target 100 jobs/s, built the same maximum observed backlog of 25 jobs, and drained in about 14 ms. This workload is intentionally below capacity. It proves comparable behavior at the selected rate, not maximum sustainable throughput.

Hybrid retained a measurable write/storage premium. Fixed-run WAL was about **17% higher**, and fixed-run physical schema growth was about **46–55% higher** at this very small 100-job scale. The single churn pair recorded nearly equal WAL but **31% more relation growth** for hybrid. WAL is cluster-wide, storage is page-granular, and one churn pair is unstable, so these are engineering signals rather than production cost estimates.

All **90/90 lifecycle assertions passed**.

Raw artifacts:

- [`results/2026-07-21-v3-smoke.json`](results/2026-07-21-v3-smoke.json)
- [`results/2026-07-21-v3-default.json`](results/2026-07-21-v3-default.json)

This historical artifact predates the P0-03 `worker-concurrency` lifecycle scenario. Its comparative
1/4/8-worker results use separate serial worker loops and are not evidence for the later single-worker
`WorkerOptions.concurrency` contract, slot bounds, per-job heartbeat overlap, or graceful drain behavior.

## What changed from v2

V3 implements the highest-priority actions from the v2 analysis:

1. `Queue.enqueueMany()` and the conventional comparator now use equivalent set-based batch ingress.
2. Single-row enqueue delegates to the batch core, preventing semantic drift.
3. Each batch is atomic, preserves result/FIFO order, supports mixed ready/scheduled jobs and caller transactions, writes one enqueue event per job, and emits at most one notification per ready queue.
4. Fixed runs record enqueue, processing, and total phase rates separately.
5. Worker/repetition pairs are deterministically shuffled, while first-design order is counterbalanced within each worker level before shuffling.
6. The report emits paired hybrid/conventional differences and ratios.
7. Churn supplies both designs the same exact job count and target arrival rate.
8. Telemetry sampling runs on an independent schedule and records each sample's duration.
9. Provenance includes untracked benchmark-affecting source files while excluding generated result artifacts.

Both final artifacts record clean source commit `477eee40f5870ca671cd86634736359e136e3e3b`.

## Run shape

- PostgreSQL 18.4 on Linux.
- AMD Ryzen 7 8745HS, 16 logical CPUs, approximately 27.2 GiB memory.
- 100 jobs per fixed run.
- Enqueue batch size: 25 jobs, so four enqueue requests per design/run.
- Three paired repetitions at 1, 4, and 8 workers.
- Seeded, shuffled execution plan with per-worker counterbalanced first-design order.
- Equal-load churn: 500 jobs at 100 jobs/s, batch size 25, four workers.
- Seven deterministic lifecycle scenarios.

The paired intervals below are Student-t intervals over only three repetition-level ratios. With two degrees of freedom, they are nominal stability summaries, not defensible 95% coverage guarantees.

## Fixed-run throughput

| Workers | Conventional jobs/s | Hybrid jobs/s | Hybrid / conventional | Nominal t-based 95% interval |
| ------: | ------------------: | ------------: | --------------------: | ---------------------------: |
|       1 |                 761 |           748 |                 98.2% |                   97.1–99.4% |
|       4 |               1,951 |         1,951 |                100.0% |                  95.5–104.5% |
|       8 |               3,307 |         3,317 |                100.3% |                  99.8–100.8% |

At one worker, the nominal interval sits slightly below parity. At four and eight workers, it includes parity. Given `n = 3`, these differences should not be treated as stable effect estimates.

The important v2-to-v3 change is the removal of the large structural gap:

| Workers | V2 hybrid/conventional throughput | V3 hybrid/conventional throughput |
| ------: | --------------------------------: | --------------------------------: |
|       1 |                             81.1% |                             98.2% |
|       4 |                             56.7% |                            100.0% |
|       8 |                             45.1% |                            100.3% |

This is a cross-version engineering comparison, not a formally paired experiment. V3 changed batching, ordering, and workload methodology together.

## Phase diagnosis

### Enqueue

| Workers | Conventional mean | Hybrid mean | Mean paired duration ratio | Nominal t-based 95% interval |
| ------: | ----------------: | ----------: | -------------------------: | ---------------------------: |
|       1 |           4.68 ms |     5.78 ms |                      1.24× |                   1.10–1.38× |
|       4 |           5.91 ms |     6.39 ms |                      1.08× |                   0.69–1.48× |
|       8 |           4.25 ms |     6.32 ms |                      1.50× |                   0.72–2.28× |

V2 measured hybrid enqueue at roughly 5.3–6.0× conventional. V3 reduces that ratio by about three quarters or more. The remaining absolute difference is approximately 0.5–2.1 ms per 100-job batch workload in these runs.

The eight-worker ratio is noisy because the enqueue phase is only a few milliseconds, so scheduler and database jitter strongly affect ratios. Larger batches and more repetitions are required before optimizing the remaining difference.

### Claim and complete

| Workers | Conventional processing | Hybrid processing | Hybrid / conventional time |
| ------: | ----------------------: | ----------------: | -------------------------: |
|       1 |               126.70 ms |         127.94 ms |                      1.01× |
|       4 |                45.41 ms |          44.94 ms |                      0.99× |
|       8 |                26.02 ms |          23.84 ms |                      0.92× |

Mean per-run successful-claim p95 latency was:

| Workers | Conventional |  Hybrid |
| ------: | -----------: | ------: |
|       1 |      0.70 ms | 0.77 ms |
|       4 |      1.10 ms | 1.13 ms |
|       8 |      1.88 ms | 1.61 ms |

No consistent hybrid processing penalty is visible. This reinforces the v2 diagnosis that the narrow ready and lease projections are serving the claim path effectively.

## Equal-load churn

| Metric                      |  Conventional |        Hybrid |
| --------------------------- | ------------: | ------------: |
| Target jobs                 |           500 |           500 |
| Completed jobs              |           500 |           500 |
| Target arrival rate         |    100 jobs/s |    100 jobs/s |
| Production duration         |       4.753 s |       4.753 s |
| Drain duration              |       13.7 ms |       13.5 ms |
| Overall completion rate     | 104.89 jobs/s | 104.90 jobs/s |
| Maximum observed backlog    |            25 |            25 |
| Successful-claim p95        |       1.32 ms |       1.32 ms |
| Producer scheduling-lag p95 |       0.38 ms |       0.00 ms |

This fixes v2's largest churn confound. V2's self-paced producer injected 56,275 conventional jobs but only 7,075 hybrid jobs, making the backlogs and drain periods incomparable. V3 gives both designs the same arrival process and exact completion requirement.

The chosen 100 jobs/s rate is far below the fixed-run processing rates. Therefore this result supports only the statement that both designs comfortably keep up at this rate. It does not estimate saturation throughput, queueing behavior near capacity, or overload recovery.

V3 should next run a paired rate sweep, for example:

- below capacity: 100 and 500 jobs/s;
- near expected capacity: 1,000, 2,000, and 3,000 jobs/s;
- overload: a rate above measured sustainable capacity.

Each rate needs repeated, counterbalanced design order and end-to-end job latency, backlog age, drain time, and error/retry reporting.

## WAL and storage

### Fixed 100-job runs

| Workers | Conventional WAL | Hybrid WAL | Hybrid overhead |
| ------: | ---------------: | ---------: | --------------: |
|       1 |        288,203 B |  338,125 B |           17.3% |
|       4 |        283,461 B |  332,869 B |           17.4% |
|       8 |        287,941 B |  336,189 B |           16.8% |

The direction is consistent across worker levels and close to v2's 15–19% fixed-run WAL premium. This suggests batching solved round-trip and statement overhead without removing the hybrid design's additional write amplification.

Mean physical schema growth from each freshly reset baseline was:

| Workers | Conventional growth | Hybrid growth | Hybrid / conventional |
| ------: | ------------------: | ------------: | --------------------: |
|       1 |             248 KiB |       368 KiB |                 1.48× |
|       4 |             269 KiB |       419 KiB |                 1.55× |
|       8 |             341 KiB |       499 KiB |                 1.46× |

At 100 jobs, relation and index page allocation is a large fixed component. These ratios are not asymptotic storage estimates.

### Churn

- Conventional WAL: 1,518,608 B.
- Hybrid WAL: 1,526,120 B, about 0.5% higher in this single pair.
- Conventional relation growth: 892,928 B.
- Hybrid relation growth: 1,171,456 B, about 31.2% higher.

The previous order-balanced artifact regeneration observed a materially different churn WAL ratio, demonstrating that one cluster-wide WAL pair is unstable. Do not interpret the final 0.5% as a stable premium. Repeat the churn pair and isolate unrelated/checkpoint writes before publishing a WAL estimate.

Tuple counts are PostgreSQL statistics estimates, can lag, and can change after vacuum. They are retained as snapshots, not exact workload deltas.

## Lifecycle evidence

All 90 assertions passed:

- scheduled promotion: 24/24 jobs promoted in three bounded batches;
- heartbeat fencing: current heartbeats accepted and stale heartbeats rejected;
- crash boundaries: all five deterministic boundaries reached expected durable states;
- lease recovery: expired work recovered with attempt and fence advancement;
- retries: immediate, delayed/promoted, and terminal exhaustion paths passed;
- retention: 40 historical rows retired while current job identities remained;
- health: explicit degraded state detected from an expired lease.

These are correctness results. Their single-run timings are not latency distributions.

### Schema v10 benchmark follow-through

The recorded 2026-07-21 v3 artifacts predate enqueue idempotency and therefore remain unchanged historical
evidence. Schema v10 retires the former missing-workload limitation in the harness by adding the
`idempotent-ingress` operational scenario. It invariant-checks exact replay without duplicate durable or
FIFO effects, whole-batch conflict rollback, equivalent same-batch duplicates alongside unkeyed requests,
and reuse after expiry. It records full client-observed transition timings, but no measured latency or
overhead number is claimed here because no new artifact is attached to this analysis.

## Methodological limits

1. **Three fixed-run repetitions are insufficient for equivalence claims.** Use at least 10 paired repetitions, preferably more for millisecond-scale phases.
2. **Churn has one pair at one under-saturation rate.** Add repeated rate sweeps with counterbalanced order.
3. **Telemetry still perturbs the same database cluster.** It is scheduled independently and sample duration is recorded, but relation/statistics queries consume database resources. Run telemetry-disabled controls or an external observer.
4. **WAL is cluster-wide.** Checkpoints and unrelated writes can contaminate the delta.
5. **Tuple statistics are stale estimates.** Do not subtract them as exact churn counts.
6. **Small data sets emphasize fixed pages and cache warmth.** Repeat with 10k, 100k, and 1M retained completions.
7. **Single process and local PostgreSQL.** This omits network latency, proxies, multiple worker processes, replicas, and noisy neighbors.
8. **Tiny payloads and zero-cost handlers.** Add payload-size and handler-duration matrices.

## Architecture recommendation

**Keep the hybrid transactional PostgreSQL queue architecture and adopt batched ingress as the primary high-throughput API.**

The evidence now supports this design split:

- immutable identity/history plus mutable current-state projections for lifecycle correctness and observability;
- narrow ready/scheduled/lease projections for efficient dispatch;
- set-based `enqueueMany` for ingress efficiency;
- single-row `enqueue` as a semantic wrapper over the batch core.

A full rewrite to the conventional lifetime-row model would trade away the hybrid model's explicit projection/history structure without a demonstrated processing-throughput benefit. The remaining costs are write amplification and storage, not a broad execution-path failure.

The next architectural decision should be made only after larger retained-history and saturation-rate experiments. If those show unacceptable write/storage amplification, optimize projection/index shape or history retention first. Do not replace the architecture based on the v2 enqueue bottleneck, because v3 shows that bottleneck was addressable at the ingress seam.

## Bottom line

- Batched ingress removed the dominant v2 performance defect.
- Fixed-run end-to-end throughput is approximately at parity in this local 100-job experiment.
- Claim/complete processing remains competitive.
- Both designs behave nearly identically at an equal offered load of 100 jobs/s.
- Hybrid still pays a write and storage premium.
- Lifecycle correctness remains intact at 90/90 assertions in the recorded v3 artifact; schema v10 adds an unmeasured invariant-gated idempotent-ingress scenario.
- The appropriate pivot is **API and SQL batching**, not a wholesale architecture redesign.
