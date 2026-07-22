# Ironshift selling points and proof plan

**Date:** 2026-07-22
**Basis:** repository research, the current feature matrix, and the v3 benchmark analysis only.

## Target customer and job to be done

**Near-term design partner:** a TypeScript/PostgreSQL team with sustained background-job churn, material vacuum/index growth or queue-induced latency, no appetite for another broker, and enough operational pain to test a young correctness-critical core.

**Longer-term protocol customer:** a modular monolith or small service fleet inside one trust boundary that shares PostgreSQL, uses at least two of TypeScript, Go, Rust, Python, and Ruby, and has painful work involving long waits, explicit checkpoints, or per-entity serialization.

**Job to be done:** “Let us commit background work with application data, survive worker crashes with inspectable state, and operate that work across our existing PostgreSQL applications without adding a separate control plane.”

**Strategic reconciliation:** the standalone no-build verdict applies to **another general-purpose TypeScript queue**, where mature incumbents already own the feature checklist, trust, and distribution. The cross-language opportunity is a different and still-unproven category: **one versioned PostgreSQL execution protocol with first-party multi-language activity workers and explicit durable boundaries**. Ironshift should not fund that broader product from theory. It should use the current TypeScript validation core and benchmark harness to prove the storage and correctness substrate, then validate cross-language demand with a minimal protocol slice. Failure of either proof means extending an incumbent, not expanding into a standalone platform.

## Strongest current selling points

1. **A precise correctness core, not vague durability language.** Transactional immediate/delayed enqueue, short `SKIP LOCKED` claims, renewable leases, monotonic fencing, heartbeat rejection, expiry recovery, retries, and explicit at-least-once semantics are implemented.
2. **Operational state is separated from history.** One live-only runtime relation serves dispatch while payload, terminal outcome, lifecycle events, and attempt outcomes are isolated or append-only. This creates a coherent path to retention and diagnostics without using the claim table as an analytics store.
3. **Crash behavior is executable.** Deterministic failpoints cover five worker boundaries, and integration tests exercise fencing, recovery, retries, health degradation, and partition retirement against live PostgreSQL.
4. **PostgreSQL-specific health is built into the validation artifact.** Machine-readable diagnostics expose queue depth, oldest-ready age, relation/index size, tuple churn, HOT ratio, vacuum timestamps, lock waits, oldest transactions, and notification queue usage.
5. **The architecture survived its first performance correction.** Set-based ingress removed v2’s dominant bottleneck while preserving the projection/history model. This is evidence that the design can be optimized at a seam rather than rewritten wholesale.
6. **Recurring jobs are deployment state, not dashboard-only configuration.** Namespaced TypeScript definitions synchronize into pg_cron, update or prune safely on deploy, deduplicate occurrence enqueue, and execute through the same retry, fencing, history, and diagnostics protocol as other jobs.
7. **The schema is a plausible protocol foundation.** Stable job identity, versioned SQL transition functions, canonical JSON-compatible payloads, fencing, events, attempts, and declarative schedules are the right primitives for later conformance-tested language clients, although no cross-language contract exists yet.

## Claims already proven

These claims are supportable now, with the stated scope:

- Ironshift implements the TypeScript/PostgreSQL core documented in [`docs/features.md`](../features.md), including transactional enqueue, deploy-synchronized pg_cron schedules, centralized runtime maintenance, FIFO multi-worker claims, leases, heartbeats, fencing, recovery, retries, append-only history, manual partition retirement, diagnostics, and crash-boundary tests.
- In the v3 local default-profile experiment, batched ingress reduced the hybrid/conventional enqueue-duration ratio from roughly 5.3–6.0× to 1.08–1.50×.
- In that same 100-job, three-repetition experiment, hybrid end-to-end throughput measured 98.2%, 100.0%, and 100.3% of the conventional comparator at 1, 4, and 8 workers. The large v2 gap disappeared, but equivalence or superiority is not proven.
- At an equal offered load of 100 jobs/s, both designs accepted and completed 500 jobs, reached the same maximum observed backlog of 25, and drained in about 14 ms. This proves comparable behavior only below capacity on the tested machine.
- All 90 lifecycle assertions passed, including scheduled promotion, stale-heartbeat rejection, five crash boundaries, lease recovery, retry paths, retention, and degraded-health detection.
- The tested hybrid model carries a measurable cost: about 17% more fixed-run WAL and 46–55% more small-scale physical schema growth, with one churn pair showing about 31% more relation growth. These are engineering signals, not production cost estimates.

## Hypotheses requiring competitor benchmarks

| Hypothesis | Required comparison and measure |
|---|---|
| Hybrid projections preserve latency under sustained churn better than mature queues. | Current pg-boss and Graphile Worker versus Ironshift after 10k, 100k, 1M, and ultimately 100M lifecycle transitions; compare p50/p95/p99 claim and end-to-end latency, query plans, dead tuples, vacuum work, index growth, WAL, and operator intervention. |
| A large future schedule does not degrade ready claims. | Equivalent delayed backlogs and promotion rates; measure ready-claim p99, scheduler drift, promotion throughput, and lock waits. |
| Deploy synchronization remains safe under concurrent or failed releases. | Race two namespace syncs, inject failure between target and cron reconciliation, restore/clone databases, and verify convergence, exact ownership pruning, inactive clone policy, and no unintended external work. |
| pg_cron coordination removes worker hot-path cost without sacrificing schedule latency. | Compare external maintenance against worker-managed fallback across worker counts; measure queries/job, connection-pool pressure, promotion drift, recovery delay, and sustainable throughput. |
| Ironshift degrades more gracefully near saturation and after overload. | Repeated, counterbalanced rate sweeps at 100, 500, 1k, 2k, 3k jobs/s and above sustainable capacity; measure backlog age, completion latency, drain time, retry/error rate, and recovery slope. |
| Dispatch remains stable when cleanup is blocked. | Hold an old transaction or replication horizon during churn; compare latency growth, heap/index growth, vacuum recovery time, and manual remediation. |
| Diagnostics and future UI analytics are isolated from dispatch. | Run representative health/dashboard queries concurrently; require less than 10% p99 claim-latency regression and document query/resource budgets. |
| The write/storage premium is acceptable at realistic scale. | Repeat WAL with isolated controls and retained-history sizes up to 1M+, varied payloads, heartbeats, and retention policies; report bytes per completed job and reclaimed storage after partition retirement. |
| The protocol is valuable across languages, rather than merely callable SQL. | Build one thin non-TypeScript activity worker and shared golden tests; recruit teams using at least two target languages and measure whether they choose shared typed execution over separate incumbent queues. |
| Explicit checkpoints solve a valuable workflow problem without becoming a general platform. | Pilot one long-wait or per-entity serialized workflow; measure recovered work avoided, duplicate external effects, operator steps, and implementation complexity versus the team’s incumbent approach. |

## Claims to avoid

- “Faster than pg-boss, Graphile Worker, or conventional queues.” No equivalent incumbent benchmark exists, and v3 is too small for superiority claims.
- “Stable under churn,” “zero bloat,” or “vacuum-proof.” The long-run, held-horizon, and retained-history evidence is not yet present.
- “Production ready.” Migrations, compatibility matrices, CI, security, automatic job/outcome retention, operational automation, and broad failure injection are missing.
- “Exactly once” without qualification. Attempts and external effects are at least once. Only same-PostgreSQL application writes can potentially share an atomic transaction with a completion/checkpoint record.
- “Cross-language runtime” or “shared protocol” as a current feature. SQL is callable, but no stable protocol, conformance suite, or maintained non-TypeScript SDK exists.
- “Exactly-once cron execution.” One schedule occurrence is deduplicated before enqueue, but the resulting worker job remains at least once.
- “Durable workflows,” “resumable execution,” or arbitrary continuation. There are no workflow identities, step journals, replay/versioning rules, durable signals, or checkpoints today.
- “Better dashboard,” “built-in observability,” or “framework native” as current differentiation. The present artifact has health JSON but no UI, OpenTelemetry package, auth/RBAC, or framework/ORM adapters.
- “Another queue, but better.” Basic queue features, transactional enqueue, dashboards, telemetry, and framework integrations are crowded and copyable.

## Measurable proof plan

1. **Make comparisons semantically valid.** Implement equivalent lease, retry, recovery, and retained-history behavior in the conventional comparator. Add at least 10 paired repetitions, raw latency samples, counterbalanced order, and telemetry-disabled controls. Gate: no published cross-design claim until semantic and statistical review passes.
2. **Prove or reject the storage wedge.** Run retained-history, delayed-backlog, heartbeat, dashboard-load, partition-retirement, held-horizon, saturation, and overload scenarios against Ironshift, current pg-boss, and current Graphile Worker. Primary gate: after 100M transitions, Ironshift p99 claim latency stays within 2× its clean baseline while the best incumbent degrades at least 5× or requires materially more intervention. Secondary gates: dashboard load adds under 10% p99 regression, no accepted job is lost, and stale completion is always rejected.
3. **Quantify the cost side.** Report WAL/job, storage/job, vacuum I/O/time, partition-retirement lock time, and reclaimed bytes across realistic payload and retention matrices. Gate: publish an explicit capacity envelope and show that the operational benefit exceeds the write/storage premium for at least one design-partner workload.
4. **Validate the scheduler wedge before breadth.** Interview 20 qualified teams; obtain sanitized schedule/deploy/queue evidence from at least 5 and production-pilot commitments from at least 3. Measure whether Git-reviewed schedule synchronization, same-database enqueue, fencing, retained outcomes, and PostgreSQL diagnostics replace meaningful custom operational work. Stop if teams only need a basic cron UI or an incumbent extension delivers at least 70% of the value.
5. **Test the cross-language thesis as a separate gate.** Add one thin non-TypeScript activity worker, canonical payload/error fixtures, and a shared transition conformance suite. Pilot with teams already using PostgreSQL and at least two target languages. Gate: at least 3 teams prefer one shared execution protocol for a real long-wait or keyed workflow over retaining separate queues.
6. **Choose the product form from evidence.** If the storage gate passes but protocol demand does not, ship diagnostics, benchmarks, and storage improvements as incumbent extensions or a narrow queue core. If protocol demand passes but storage differentiation does not, build atop an existing PostgreSQL queue/runtime. Fund standalone Ironshift only if both gates pass, a credible path to 100 qualified first-year evaluations exists, and two-maintainer coverage is funded for 24 months.
