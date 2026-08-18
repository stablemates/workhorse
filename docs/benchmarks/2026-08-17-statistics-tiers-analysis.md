# Long-horizon statistics tiers

The hour and day tiers make long-window wait percentiles five to six times faster than the raw
event join in this sparse, high-cardinality profile. The logarithmic sketch kept p95 error below one
percent, but retained rollups still consumed 76.9% of raw history bytes. Materialized worker and
tag candidates increased rows, bytes, and tier-aware query latency enough to keep both dimensions
on live queries.

## Method

`pnpm benchmark:statistics-tiers` rebuilt the dedicated benchmark database and loaded 200,000 jobs
uniformly across 120 days. Each job carried a 2 KiB JSON payload, three tags, one of 16 queues, one
of 128 job types, and one of 64 independently assigned worker identities. The three tag namespaces
also vary independently of job type. Each job wrote an enqueue event, a first-claim event, one
successful attempt, and one terminal outcome.

The run used five measured repetitions after one warmup. It compared p95 from the exact event self
join with p95 from `stat_buckets_v1` and the merged `wait_sketch`. The retained statistics policy
was 365 days, so minute rows aged after two days, hour rows after ninety days, and day rows covered
the full horizon. Separate baseline, worker, and tag tables used that same retention ladder and the
same tier-selection rule to measure candidate row count, storage, and query latency.

The complete machine-readable result is
[`2026-08-17-statistics-tiers.json`](results/2026-08-17-statistics-tiers.json).

## Results

| Window   | Tiered mean | Raw mean | Speedup | Relative p95 error |
| -------- | ----------: | -------: | ------: | -----------------: |
| 1 day    |     19.7 ms | 431.0 ms |   21.9x |             -0.23% |
| 30 days  |     90.8 ms | 497.7 ms |    5.5x |             -0.25% |
| 120 days |    100.5 ms | 645.0 ms |    6.4x |             -0.26% |

The catch-up required two bounded rollup passes. The largest pass took 58.7 seconds because it
covered the cold historical load; steady retention-drain passes averaged 48.4 ms.

The three tiers wrote 3.42 aggregate rows per job during catch-up. After the retention ladder
settled, they retained 0.90 rows per job and occupied 138.7 MB against 180.3 MB of event and attempt
history. This workload intentionally spreads traffic over many `(queue, job type)` pairs, so it
compresses poorly and exposes the storage cost rather than hiding it behind a high-throughput case.

| Candidate dimensions | Rows/job | Row multiplier |  Storage | Byte multiplier | Query mean |
| -------------------- | -------: | -------------: | -------: | --------------: | ---------: |
| Queue + job type     |     0.90 |          1.00x |  34.7 MB |           1.00x |   137.3 ms |
| + worker             |     1.77 |          1.96x |  61.9 MB |           1.79x |   593.8 ms |
| + tag                |     3.45 |          3.83x | 125.0 MB |           3.61x |   792.1 ms |

## Decision

Keep queue and job type as the only rollup dimensions. Worker identity nearly doubled retained rows
and raised the candidate query mean more than fourfold. Tags nearly quadrupled rows and raised the
query mean almost sixfold. Those dimensions remain on bounded live queries.

Retain the logarithmic wait sketch. It removes the raw-event percentile join, merges unchanged
through every tier, and stayed within its intended relative-error bound at every measured window.
