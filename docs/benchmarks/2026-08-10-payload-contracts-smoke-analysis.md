# Payload-contract smoke benchmark, 2026-08-10

This smoke run verifies the benchmark coverage added with payload contracts. It is correctness and
diagnostic evidence, not a throughput or latency claim.

The `retry-paths` scenario completed all 35 assertions on PostgreSQL 18.4. Its contracted job
retained version `1`, completed successfully, and removed the configured payload and result fields
from the operator snapshot.

The run records full client-observed contracted transitions:

- enqueue: 2.46 ms;
- claim: 2.46 ms;
- completion: 2.33 ms.

These are one-run smoke observations from a dirty source tree. They do not isolate validation cost,
provide a baseline comparison, or support an overhead claim. A default-profile run with independent
repetitions is required before making a performance claim.

Artifact: [`results/2026-08-10-payload-contracts-smoke.json`](results/2026-08-10-payload-contracts-smoke.json).
