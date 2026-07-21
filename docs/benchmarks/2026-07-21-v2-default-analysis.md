# Benchmark suite v2 default-profile analysis, 2026-07-21

## Executive conclusion

The default-profile run is useful evidence, but its strongest conclusion is narrower than “the conventional design is 2× faster.”

**The hybrid claim-and-complete processing path is approximately at parity with the conventional design at 1, 4, and 8 workers. The end-to-end throughput gap is overwhelmingly caused by hybrid enqueue latency, which is about 5–6× higher for this 100-job workload.**

The single churn execution suggests that hybrid used roughly 20% more total relation bytes per completed job and 9% more WAL per completed job. Those observations came from unequal retained-history horizons and exposure times, so they are directional rather than stable design-premium estimates. They are nevertheless materially smaller than the legacy v1 gaps because v2 compares much closer lifecycle semantics.

All seven lifecycle scenarios passed, including every worker crash boundary, stale-fence rejection, retry paths, recovery, retention, and degraded health. Those scenarios are correctness evidence. Their single-run timings are not performance distributions.

The raw artifact is [`results/2026-07-21-v2-default.json`](results/2026-07-21-v2-default.json).

## Run shape

- PostgreSQL 18.4 on Linux, AMD Ryzen 7 8745HS, 16 logical CPUs, approximately 27.2 GiB memory.
- 100 jobs per comparative run.
- Three reset-and-run repetitions per design and worker level.
- Worker sweep: 1, 4, and 8.
- Five-second concurrent producer-consumer churn per design, followed by a complete drain.
- Seven deterministic lifecycle scenarios.
- The artifact records source commit `198c995eeb982c3dbcbb63e51848f5e8f06ace03` with a clean tree.

`prepareExplain()` resets both benchmark schemas before every measured run, captures the claim plan, resets again, and then starts telemetry. The repetitions therefore begin from freshly truncated data. PostgreSQL DML and vacuum counters remain cumulative across truncation, while live/dead tuple values are lagging estimates; both require before/after context and the tuple estimates must not be treated as exact workload deltas.

## Comparative throughput

The table below uses the artifact means. The paired ratio interval is a post-hoc Student-t interval over the three repetition-level hybrid/conventional ratios. With only three fixed-order pairs, independence, distribution stability, and approximate normality cannot be assessed. Treat it as a nominal t-based 95% stability interval, not an interval with defensible 95% coverage.

| Workers | Conventional jobs/s | Hybrid jobs/s | Hybrid / conventional | Nominal t-based 95% interval |
| ------: | ------------------: | ------------: | --------------------: | ---------------------------: |
|       1 |                 696 |           564 |                 81.1% |                   75.2–87.0% |
|       4 |               1,883 |         1,068 |                 56.7% |                   56.3–57.1% |
|       8 |               3,145 |         1,420 |                 45.1% |                   43.2–47.1% |

Taken alone, this looks like progressively worse hybrid worker scaling. The phase timings show that interpretation is incomplete.

## The gap is enqueue, not worker processing

### Enqueue phase

| Workers | Conventional enqueue | Hybrid enqueue | Ratio of displayed means |
| ------: | -------------------: | -------------: | -----------------------: |
|       1 |              9.24 ms |       47.83 ms |                    5.17× |
|       4 |              8.23 ms |       48.00 ms |                    5.83× |
|       8 |              7.77 ms |       46.90 ms |                    6.04× |

This corresponds to approximately 10,800–12,900 conventional enqueues/s versus 2,080–2,130 hybrid enqueues/s in these small batches.

### Claim-and-complete processing phase

| Workers | Conventional processing | Hybrid processing | Hybrid / conventional time | Processing-rate ratio |
| ------: | ----------------------: | ----------------: | -------------------------: | --------------------: |
|       1 |               134.51 ms |         129.43 ms |                      0.96× |                 1.04× |
|       4 |                44.88 ms |          45.64 ms |                      1.02× |                 0.98× |
|       8 |                24.03 ms |          23.54 ms |                      0.98× |                 1.02× |

The processing-only rates are approximately:

- 1 worker: 743 conventional versus 773 hybrid jobs/s;
- 4 workers: 2,228 conventional versus 2,191 hybrid jobs/s;
- 8 workers: 4,161 conventional versus 4,248 hybrid jobs/s.

Successful-claim p95 latency is also similar in the fixed 100-job runs. The mean per-run p95 values are 0.79 versus 0.77 ms at one worker, 1.11 versus 1.16 ms at four, and 1.63 versus 1.72 ms at eight. The paired intervals are wide and include parity.

**Interpretation:** the narrow ready/lease projections are doing their intended job on claim and completion. The current hybrid enqueue transaction is the dominant performance problem. As worker concurrency rises, processing gets shorter for both designs, but hybrid’s approximately 47 ms enqueue phase does not shrink, so it dominates total duration and makes the end-to-end ratio look progressively worse.

## WAL

Mean WAL per 100-job fixed run:

| Workers | Conventional |    Hybrid | Ratio-of-means overhead |
| ------: | -----------: | --------: | ----------------------: |
|       1 |    314,531 B | 372,771 B |                   18.5% |
|       4 |    295,091 B | 338,843 B |                   14.8% |
|       8 |    295,043 B | 344,984 B |                   16.9% |

Only the four-worker paired interval excludes parity in this three-repetition sample. The direction is consistent, but more repetitions are required for a stable estimate.

During churn, WAL was approximately:

- conventional: 2,794 B per completed job;
- hybrid: 3,033 B per completed job;
- hybrid overhead: 8.5%.

This is a much smaller difference than the legacy v1 finding of roughly 3.3× WAL. The main reason is methodological improvement: v2’s conventional comparator now records leases, attempts, events, retries, and recovery semantics rather than measuring only a simplified success path.

WAL is cluster-wide, so unrelated writes would contaminate these values. This local run was controlled, but the metric is not intrinsically relation-scoped.

## Storage and churn

### Fixed 100-job runs

The mean physical schema size after each run was approximately:

| Workers | Conventional |    Hybrid | Hybrid / conventional |
| ------: | -----------: | --------: | --------------------: |
|       1 |    557.3 KiB | 845.3 KiB |                 1.52× |
|       4 |    466.7 KiB | 850.7 KiB |                 1.82× |
|       8 |    490.7 KiB | 920.0 KiB |                 1.88× |

At this scale, PostgreSQL page allocation and fixed relation/index overhead are a large fraction of the total. These ratios should not be extrapolated linearly.

### Sustained churn per completed job

| Metric                    | Conventional |  Hybrid | Hybrid overhead |
| ------------------------- | -----------: | ------: | --------------: |
| Total relation growth/job |      1,357 B | 1,621 B |           19.5% |
| Table growth/job          |        872 B | 1,093 B |           25.4% |
| Index growth/job          |        485 B |   528 B |            8.9% |
| WAL/job                   |      2,794 B | 3,033 B |            8.5% |

The hybrid storage cost in this execution was moderate. Its largest relations were the monthly `job_event` partition, `lease`, the monthly `attempt_history` partition, `job`, `job_current`, and `ready_job`, in that order. The conventional design concentrated most bytes in `job_event`, the mutable `job` table, and `attempt_history`.

The mutable conventional `job` table accumulated about 101,777 estimated dead tuples after 56,275 completed jobs. Hybrid spread churn across `lease`, `ready_job`, and `job_current`, with approximately 14,088 estimated dead tuples in aggregate at the end of its smaller 7,075-job workload. These absolute values are not directly comparable because the workloads completed different job counts and statistics estimates can lag.

## Churn result and its major limitation

Recorded churn totals:

| Design       | Timed-window enqueues | Backlog near 5 s | Actual total duration | Overall completed jobs/s | Successful-claim p95 |
| ------------ | --------------------: | ---------------: | --------------------: | -----------------------: | -------------------: |
| Conventional |                56,275 |           50,591 |               27.82 s |                    2,023 |              1.82 ms |
| Hybrid       |                 7,075 |              168 |                5.08 s |                    1,393 |              6.93 ms |

The producer is self-paced rather than fixed-rate. Because conventional enqueue is much faster, it injected almost eight times as many jobs during the same five-second production window and built a backlog above 50,000. Hybrid enqueue naturally throttled its producer close to the four-worker consumer rate and built almost no backlog.

This means the churn figures are **not an equal-arrival-rate comparison**. They measure the coupled behavior of each full system, including producer speed, database-pool contention, backlog creation, telemetry sampling, and final draining. Conventional recorded a higher coupled-system completion rate in this workload, but the run does not isolate maximum consumer capacity. It also created uncontrolled overload and a 22.8-second post-production drain. Hybrid recorded a lower coupled-system rate but substantially tighter producer-consumer balance.

The hybrid churn claim p95 of 6.93 ms versus 1.82 ms is a meaningful warning signal, but it was observed under very different backlog and arrival conditions. A fixed-rate workload is required to isolate whether hybrid claim latency degrades under equivalent pressure.

## Lifecycle evidence

All 90 assertions passed.

| Scenario            | Result                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled promotion | 24/24 promoted in three bounded batches; drift p50 28.43 ms, p95 29.41 ms                                                          |
| Heartbeat fencing   | 8/8 current heartbeats accepted; 8/8 stale heartbeats rejected                                                                     |
| Crash boundaries    | All five injected boundaries produced the expected durable state; four remained recoverable and `afterComplete` remained succeeded |
| Lease recovery      | One expired lease recovered; attempt advanced 1→2; fence advanced; recovery call took 4.80 ms                                      |
| Retry paths         | Immediate, delayed/promoted, and terminal exhaustion paths all reached the expected state                                          |
| Retention           | 40 historical rows retired; all 10 current job identities retained                                                                 |
| Health              | Correct 12 ready, 12 scheduled, one expired lease; explicit degraded state; snapshot took 3.28 ms                                  |

These timings are one deterministic execution each. They establish wiring and invariants, not latency distributions or tail guarantees.

## Methodological limits

1. **Only three comparative repetitions.** Student-t intervals with two degrees of freedom are fragile. Ten or more paired repetitions would produce much more useful estimates.
2. **Fixed design, worker-level, and churn order.** Every pair runs conventional before hybrid, worker levels always run 1→4→8, and conventional churn precedes hybrid churn. The schemas are reset, but cache, checkpoint, WAL, cumulative statistics, plan warming, and background activity can still create chronological effects. Alternate or randomize these orders.
3. **Churn offered load is unequal.** The self-paced producer creates radically different arrival counts and backlog. Add fixed-rate and fixed-job-count churn modes.
4. **Churn sampling perturbs the workload.** Relation, schema, and activity telemetry is captured synchronously inside the producer loop. The hybrid sampler also examines more relations than the conventional sampler. Move sampling to an independent connection and schedule, then quantify sampler overhead.
5. **PostgreSQL statistics require different treatment by field.** DML and vacuum counts are cumulative counters and can be differenced. `liveTuples` and `deadTuples` are lagging estimates, so subtracting them does not produce an exact workload delta. Consider explicit statistics reset in a dedicated benchmark cluster and retain the estimates as snapshots.
6. **Single process and one local database.** This does not model network latency, multiple Node processes, connection proxies, replicas, noisy neighbors, or production storage.
7. **Small fixed workload and bounded database concurrency.** One hundred enqueue promises are submitted concurrently, but the CLI pool is capped at 14 connections. The workload emphasizes fixed relation/page costs and client round trips.
8. **No payload or handler-cost matrix.** Results apply to tiny payloads and effectively zero-cost handlers. Real handlers will reduce the relative importance of queue overhead.
9. **Artifact summaries are per-design.** Because runs are naturally paired by repetition, the report should also emit paired differences and ratio stability intervals directly.

## Prioritized next work

1. **Optimize or batch hybrid enqueue.** Profile the transaction and SQL calls first. The processing path is already competitive, so enqueue is the clearest high-value target.
2. **Add equal-offered-load churn.** Run fixed rates below capacity, near saturation, and above saturation while recording backlog age, end-to-end completion latency, and drain time.
3. **Increase and randomize repetitions.** Use at least ten paired repetitions and alternate design order.
4. **Separate throughput dimensions.** Publish enqueue-only, claim/complete-only, and end-to-end rates rather than relying on one combined number.
5. **Repeat at larger retained-history horizons.** Use at least 10k, 100k, and 1M completed jobs to distinguish fixed overhead from asymptotic storage and plan behavior.
6. **Add multi-process workers and realistic payload/handler matrices.** Include small/medium/large JSON payloads and handler times such as 0, 10, 100, and 1,000 ms.

## Bottom line

V2 changes the architectural diagnosis from the legacy benchmark:

- The hybrid claim/complete projection is not showing a meaningful processing-throughput disadvantage in this run.
- Hybrid enqueue is the bottleneck and took approximately 5–6× as long for 100 concurrently submitted enqueue promises through a 14-connection pool.
- In the single unequal-horizon churn execution, hybrid recorded approximately 9% more WAL and 20% more relation growth per completed job. These are directional observations, not stable premium estimates.
- Conventional recorded a higher coupled-system completion rate, while hybrid’s slower producer avoided the extreme backlog seen in conventional churn.
- Correctness and failure behavior passed every executable lifecycle invariant.

The most defensible engineering decision is therefore to focus optimization on enqueue and rerun with equal arrival rates before changing the projection architecture.
