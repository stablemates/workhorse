# Rate-limit admission smoke evidence

The schema v23 `rate-limit-admission` lifecycle scenario passed all seven correctness assertions on PostgreSQL 18.4 and Node.js 24.15.0. This smoke run validates the token-bucket invariants; its single timings are not throughput or latency claims.

The queue-scoped bucket admitted its burst of two jobs and rejected the third claim. `Queue.health()` reported one throttled ready job, a future eligibility time, and the configured effective refill rate. After the refill window, the remaining accepted identity became claimable.

The key-scoped case spent the first key's token, left another job for that key ready, and admitted a later job for a different key. That proves the bounded lookahead path remains work-conserving across independent buckets.

The recorded artifact is [`results/2026-08-11-rate-limit-admission-smoke.json`](results/2026-08-11-rate-limit-admission-smoke.json). A production performance claim would require repeated workloads with mixed key cardinality, contention, storage growth, and confidence intervals.
