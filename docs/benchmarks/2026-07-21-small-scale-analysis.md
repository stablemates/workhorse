# Small-scale benchmark ladder, 2026-07-21

## Executive summary

The current harness completed all five scales successfully and used the intended claim indexes in every round. At 500 to 5,000 jobs per round, the hybrid design sustained roughly **87% to 92%** of the conventional baseline's throughput, while average claim p99 was **6% to 10% higher**. The hybrid schema produced about **3.3x the WAL per job** and occupied about **7.6x to 7.8x the measured relation space** after three rounds.

Those ratios are expected to include the cost of stronger semantics, not just an architectural penalty. The hybrid path writes durable job identity, current state, dispatch projection, lease/fencing state, attempt history, and lifecycle events. The conventional path remains a mutable success-path baseline without equivalent lease, recovery, and immutable-history behavior. These results therefore validate mechanics and reveal early churn trends. They do **not** establish product superiority or a production capacity limit.

The clearest warning signal appears at 5,000 jobs per round. Hybrid throughput fell from **675 jobs/s in round 1 to 604 jobs/s in round 3**, while p99 claim latency rose from **1.086 ms to 1.189 ms** and claim-plan shared-buffer hits rose from **4 to 49**. The claim still used `ready_job_claim_idx`, returned one row, performed no disk reads, and removed no rows by filter. More retained-history and vacuum-focused testing is needed to determine whether this slope stabilizes.

## Method

- Source commit: `11ab33bbdafb73dba9709080da97a00367ae8947`
- Database: isolated local `workhorse_bench`
- Scales: 25, 100, 500, 1,000, and 5,000 jobs per design per round
- Rounds: 3 retained-history rounds at every scale
- Isolation: database reset before every scale and after the complete ladder
- Execution: one client, sequential claim and completion
- PostgreSQL: 18.4, `synchronous_commit=on`, autovacuum enabled
- Host: AMD Ryzen 7 8745HS, 16 logical CPUs, approximately 27 GiB RAM

Each report contains two results per round: the conventional mutable-table baseline followed by the hybrid projection/history design. Throughput covers enqueue, claim, and completion for the round. Claim percentiles measure only the client-observed claim call. WAL is measured around the whole round. Relation size covers all ordinary and partitioned relations in the design's schema.

Full environment settings are in [`environment.json`](results/2026-07-21-small-scale/environment.json). The normalized 30-row dataset is in [`round-summary.csv`](results/2026-07-21-small-scale/round-summary.csv).

## Scale summary

Values below are averages across the three retained-history rounds. Final size and dead tuples are the round-3 values. WAL is normalized per job.

| Jobs/round | Design       | Throughput jobs/s | Claim p50 ms | Claim p95 ms | Claim p99 ms | Final size MiB | Final dead tuples* | WAL KiB/job |
| ---------: | ------------ | ----------------: | -----------: | -----------: | -----------: | -------------: | -----------------: | ----------: |
|         25 | Conventional |             712.5 |        0.693 |        0.911 |        1.049 |          0.078 |                150 |       0.809 |
|         25 | Hybrid       |             628.2 |        0.736 |        0.975 |        1.306 |          0.516 |                183 |       3.182 |
|        100 | Conventional |             771.2 |        0.662 |        0.808 |        0.877 |          0.117 |                200 |       0.924 |
|        100 | Hybrid       |             666.3 |        0.709 |        0.922 |        1.907 |          0.867 |                424 |       3.741 |
|        500 | Conventional |             804.6 |        0.645 |        0.761 |        0.882 |          0.359 |              3,000 |       0.935 |
|        500 | Hybrid       |             739.6 |        0.665 |        0.822 |        0.971 |          2.781 |              3,463 |       3.048 |
|      1,000 | Conventional |             762.2 |        0.689 |        0.846 |        0.958 |          0.656 |              4,560 |       0.972 |
|      1,000 | Hybrid       |             698.7 |        0.706 |        0.889 |        1.016 |          5.102 |              1,677 |       3.166 |
|      5,000 | Conventional |             730.3 |        0.731 |        0.920 |        1.037 |          2.914 |             20,000 |       0.932 |
|      5,000 | Hybrid       |             634.9 |        0.752 |        0.965 |        1.133 |         22.289 |             27,172 |       3.053 |

\* `n_dead_tup` is a statistics estimate affected by flush timing and autovacuum. Its direction is useful, but individual values are not exact row counts. The 1,000-job hybrid value dropped in round 3, which is consistent with vacuum/statistics activity and demonstrates why it must not be treated as an exact counter.

## Relative cost at the more stable scales

The 25- and 100-job runs are dominated by fixed costs and occasional tail outliers. The 500-job and larger runs provide a more useful early comparison.

| Jobs/round | Hybrid throughput vs conventional | Hybrid p99 vs conventional | Hybrid final size vs conventional | Hybrid WAL/job vs conventional |
| ---------: | --------------------------------: | -------------------------: | --------------------------------: | -----------------------------: |
|        500 |                             91.9% |                      1.10x |                             7.74x |                          3.26x |
|      1,000 |                             91.7% |                      1.06x |                             7.77x |                          3.26x |
|      5,000 |                             86.9% |                      1.09x |                             7.65x |                          3.28x |

Interpretation:

1. **Claim latency remains low in this warm-cache, uncontended scenario.** Average p99 stayed near 1 ms for both designs at 500 jobs and above. The hybrid's additional SQL protocol did not create an order-of-magnitude claim penalty.
2. **End-to-end throughput has a visible hybrid cost.** The gap is approximately 8% at 500 and 1,000 jobs, widening to 13% at 5,000 jobs. This includes the hybrid's additional durable writes and immutable history, which the baseline does not reproduce.
3. **WAL amplification is stable enough to treat as a real signal.** At 500 jobs and above, the hybrid generated about 3.26x to 3.28x the baseline WAL per job. Capacity planning must include this multiplier unless later schema/protocol optimization reduces it.
4. **Measured storage amplification is also stable.** The hybrid occupied around 7.7x the baseline schema size after three rounds. This is mostly a semantics and retention difference, so the next comparison needs a conventional baseline with equivalent attempts/events before judging architecture efficiency.

## Retained-history behavior at 5,000 jobs

| Design       | Round | Throughput jobs/s | p99 ms | Relation MiB | Dead tuples* | WAL MiB | Claim shared hits | Claim plan ms |
| ------------ | ----: | ----------------: | -----: | -----------: | -----------: | ------: | ----------------: | ------------: |
| Conventional |     1 |             715.0 |  1.094 |        1.062 |        3,080 |   4.640 |                 4 |         0.059 |
| Conventional |     2 |             747.3 |  0.978 |        1.930 |       10,000 |   4.508 |                 4 |         0.026 |
| Conventional |     3 |             728.5 |  1.039 |        2.914 |       20,000 |   4.503 |                28 |         0.061 |
| Hybrid       |     1 |             675.4 |  1.086 |        7.922 |        3,858 |  15.211 |                 4 |         0.020 |
| Hybrid       |     2 |             625.6 |  1.124 |       14.789 |       15,520 |  14.735 |                14 |         0.108 |
| Hybrid       |     3 |             603.6 |  1.189 |       22.289 |       27,172 |  14.770 |                49 |         0.100 |

The hybrid round-3 throughput is 89.4% of its round-1 throughput. Conventional round-3 throughput is 101.9% of round 1. Hybrid relation size grows nearly linearly because terminal job state and immutable history are intentionally retained. The increase in claim shared-buffer hits suggests that ready-projection churn or dead index entries are making the index path touch more cached pages as rounds accumulate. It is still an index scan, and the execution remains far below 1 ms, so this is an investigation signal rather than a demonstrated failure.

## Claim-plan validation

All 30 measured design-round combinations passed these checks:

- top plan returned exactly one row;
- conventional claims used `conventional_claim_idx`;
- hybrid claims used `ready_job_claim_idx`;
- no claim plan performed a shared disk read;
- no inner index scan reported rows removed by filter.

The absence of disk reads means this ladder exercised warm-cache behavior only. The largest hybrid schema was about 22 MiB, far below PostgreSQL's configured shared buffers and the host's available memory. These results say nothing about cold-cache or storage-I/O saturation behavior.

## Small-run noise

The 100-job hybrid round 2 produced a 3.253 ms p99 while adjacent rounds measured 1.462 ms and 1.006 ms. With only 100 samples, one or a few scheduler/runtime pauses strongly affect p99. Throughput also rises from 25 to 500 jobs as fixed setup costs are amortized. The 25- and 100-job reports should therefore be used only as correctness smoke tests.

## What this run proves

- The benchmark can complete a controlled scale ladder against the isolated benchmark database.
- Both designs preserve their intended index-backed claim path through 15,000 retained jobs at the largest scale.
- The hybrid path's warm-cache claim latency remains approximately 1 ms p99 in the current sequential scenario.
- WAL, storage, and retained-history overhead are material and measurable.
- At 5,000 jobs per round, the hybrid path shows an early negative throughput and buffer-touch slope worth investigating.

## What this run does not prove

- It is not a fair product comparison because the conventional baseline omits equivalent leases, recovery, attempts, and events.
- It does not measure concurrency, lock contention, connection pressure, scheduled promotion, heartbeats, retries, crashes, recovery, dashboard load, or partition retirement.
- It does not measure cold-cache or disk-bound operation.
- Each scale was executed once. The three rounds retain history and are not independent statistical repetitions.
- The largest workload is still small and short-lived relative to the viability evaluation's sustained-churn requirement.

## Recommended next benchmark work

1. **Make the baseline semantics-equivalent.** Add lease, retry/recovery, and immutable attempt/event writes to the conventional design before interpreting cross-design cost ratios as architecture evidence.
2. **Repeat independent experiments.** Run at least five resets per scale and report distributions or confidence intervals, not one ladder.
3. **Add concurrent workers.** Sweep worker counts such as 1, 4, 16, and 32 while recording lock waits, active connections, throughput, and p99.
4. **Extend retained churn.** Run 25,000 to 100,000 jobs per round for enough rounds to cross shared-buffer capacity, while sampling table/index size, HOT ratio, vacuum duration, WAL, and claim-plan buffer reads.
5. **Break storage down by relation.** Separate canonical jobs, current state, projections, leases, events, attempts, and indexes to show exactly where the 7.7x footprint comes from.
6. **Exercise required failure scenarios.** Add scheduled backlog, heartbeats, crash boundaries, expiry recovery, held transaction horizons, dashboard reads, and partition retirement.

## Raw evidence

- [`jobs-25-rounds-3.json`](results/2026-07-21-small-scale/jobs-25-rounds-3.json)
- [`jobs-100-rounds-3.json`](results/2026-07-21-small-scale/jobs-100-rounds-3.json)
- [`jobs-500-rounds-3.json`](results/2026-07-21-small-scale/jobs-500-rounds-3.json)
- [`jobs-1000-rounds-3.json`](results/2026-07-21-small-scale/jobs-1000-rounds-3.json)
- [`jobs-5000-rounds-3.json`](results/2026-07-21-small-scale/jobs-5000-rounds-3.json)
- [`round-summary.csv`](results/2026-07-21-small-scale/round-summary.csv)
- [`environment.json`](results/2026-07-21-small-scale/environment.json)
