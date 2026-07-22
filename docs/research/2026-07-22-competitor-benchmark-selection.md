# Competitor benchmark selection

**Date:** 2026-07-22
**Decision:** use **pg-boss 12.26.2** and **Graphile Worker 0.17.3** as the first direct product competitors. Keep Ironshift's **internal conventional SQL model** as a non-product architecture reference. Do not include River, PGMQ, or PgQue in the first headline baseline.

## Decision summary

The first baseline should answer a narrow question: how does Ironshift compare with established job-queue implementations that run in the same TypeScript/Node.js and PostgreSQL environment under a common success-path workload?

| Candidate | First-baseline role | Reason |
|---|---|---|
| pg-boss `12.26.2` | Direct competitor | Node.js/PostgreSQL job framework with public bulk insertion, managed workers, completion, retries, queues, retention, and operational APIs. |
| Graphile Worker `0.17.3` | Direct competitor | TypeScript/Node.js/PostgreSQL job framework with public `run()` and `addJobs()` APIs, managed concurrency, retries, scheduling, and documented performance controls. |
| Conventional SQL model | Non-product reference | Internal mutable-table implementation that isolates Ironshift's hybrid storage design from product/runtime differences. It is not an external competitor and must never appear in a market ranking. |
| River | Excluded now; future matrix target | TypeScript can enqueue, but official workers execute in Go. That runtime difference confounds the first Node.js comparison. River is the strongest future native cross-language matrix target. |
| PGMQ | Excluded | PostgreSQL message-queue primitive with no background worker. A benchmark adapter would have to invent the job runtime and lifecycle. |
| PgQue | Excluded | Snapshot-batched durable event stream with independent consumer cursors and tick-based visibility, closer to Kafka than a task queue. Its semantics and latency model are intentionally different. |

This selection is not a claim that the excluded systems are inferior. It is a control decision that minimizes runtime and semantic confounders in the first published baseline.

## Evidence and version pins

The repository already pins both direct competitors exactly in `package.json` and `pnpm-lock.yaml`: `pg-boss: 12.26.2` and `graphile-worker: 0.17.3`. The installed package metadata agrees with those pins. pg-boss declares Node `>=22.12.0`, while Ironshift declares Node `>=22`; the benchmark environment must therefore use Node `>=22.12.0`.[^pgboss-package] Graphile Worker 0.17.3 declares Node `>=14`, so the same Node 22 process is supported.[^graphile-package]

The installed declarations are also the implementation contract for adapters:

- `node_modules/pg-boss/dist/index.d.ts` exports `PgBoss`, its string/options constructors, `insert()`, `work()`, `complete()`, `fail()`, queue management, and operational methods. `dist/types.d.ts` supplies the corresponding constructor, job, worker, queue, and retention types.
- `node_modules/graphile-worker/dist/index.d.ts` exports `run`, `runMigrations`, `makeWorkerUtils`, and the public interfaces. `dist/interfaces.d.ts` defines `AddJobsFunction`, `WorkerUtils`, task handlers, jobs, runner options, and worker events.

These checks matter because documentation can describe multiple releases. Benchmark code must compile against the installed declarations, and citations must be pinned to the selected releases where possible.

## Repository-organization findings

The competitor adapters should fit Ironshift's existing benchmark organization rather than become separate ad hoc programs:

- `benchmarks/comparative.ts` defines the current fixed-run and producer/consumer result shapes, timing phases, concurrency sweep, counters, latency samples, telemetry, counterbalanced execution plan, and paired summaries.
- `benchmarks/conventional.ts` plus `sql/benchmark-conventional.sql` implement the internal conventional reference behind the same `enqueueMany -> claim -> complete` seam.
- `benchmarks/telemetry.ts` owns WAL, relation, schema, activity, I/O, and query-plan collection.
- `docs/benchmarking.md` defines the existing reproducibility and claim discipline.

The upstream repositories support public-adapter implementations. pg-boss publishes compiled declarations and schema artifacts from `dist`, with its APIs documented by constructor, jobs, workers, operations, and queues pages.[^pgboss-constructor][^pgboss-jobs][^pgboss-workers][^pgboss-ops][^pgboss-queues] Graphile Worker 0.17.3 is organized around `src`, generated/bundled `sql`, `perfTest`, tests, and `website`, and publishes `dist` plus `sql`; its package scripts expose the upstream performance harness and SQL build.[^graphile-repo][^graphile-package] This supports using public library/SQL APIs while forbidding dependencies on either project's private tables or unexported modules.

## Why these are the two direct competitors

### pg-boss 12.26.2

pg-boss is the closest direct match to Ironshift's current product boundary. The official constructor accepts a PostgreSQL connection string or options, controls pool size and schema, and documents supervision, migration, scheduling, and optional `LISTEN/NOTIFY` layered over polling.[^pgboss-constructor] The jobs API provides immediate/deferred submission, bulk `insert()`, retries, expiration, completed-job retention, explicit operations, and transaction adapters.[^pgboss-jobs][^pgboss-ops] The workers API owns polling and handler settlement through `work()`, with configurable `batchSize` and `pollingIntervalSeconds`.[^pgboss-workers] Queues make retry, retention, policy, partition, and notification choices explicit.[^pgboss-queues]

That is enough public surface to implement enqueue, managed processing, success completion, scheduling, and cleanup without reproducing the product in the harness.

### Graphile Worker 0.17.3

Graphile Worker is also a direct TypeScript/Node.js/PostgreSQL job framework. The official `run()` API accepts a task list, connection/pool, concurrency, polling, schema, events, and shutdown controls.[^graphile-run] The official `addJobs()` API efficiently inserts immediate or delayed jobs as distinct records and delegates to the public SQL function.[^graphile-addjobs] Its performance documentation separates default behavior from optional local claim and settlement batching, and provides concrete configuration guidance rather than a single universal optimum.[^graphile-performance]

The schema documentation explicitly says private tables are not a public interface and notes that successfully completed jobs are deleted.[^graphile-schema] The adapter must therefore use exported library APIs, documented SQL functions, events, and permitted views only.

## Why the other candidates are outside the first baseline

### River: runtime mismatch now, cross-language target later

River is a full job framework and is more semantically comparable than PGMQ or PgQue. However, River's official TypeScript client is an insertion client: the documentation says TypeScript inserts jobs that are **worked in Go**.[^river-typescript] A first-run comparison would therefore combine queue architecture with Node-versus-Go handler, scheduler, driver, process, and instrumentation effects.

Exclude River from the first direct TypeScript baseline. Add it later as the first **native cross-language matrix** target, using River's TypeScript producer with its Go worker and labeling the result accordingly. That future matrix can answer a different product question: how do native runtimes interact through one PostgreSQL job protocol? It must not be merged silently into the same-runtime headline ranking.

### PGMQ: lifecycle mismatch

PGMQ describes itself as a lightweight SQS-like PostgreSQL message queue with no background worker; messages remain until explicitly removed, and delivery uses a visibility timeout.[^pgmq-readme] Its SQL primitives can support enqueue, read, archive/delete, and visibility-timeout redelivery, but the benchmark harness would have to supply worker concurrency, task dispatch, retry/backoff policy, terminal failure, recurring scheduling, and cleanup policy.

That would benchmark an Ironshift-authored runtime around PGMQ, not an equivalent PGMQ product lifecycle. PGMQ belongs in a separate future **message-primitive** study with a shared client-side worker loop and narrower claims.

### PgQue: consumption and latency mismatch

PgQue 0.2.0 describes itself as a durable event stream closer to Kafka than ActiveMQ or RabbitMQ, using a shared event log, independent consumer cursors, snapshot-based batching, table rotation, and periodic ticks.[^pgque-readme] Its default end-to-end visibility is intentionally tied to tick cadence, and acknowledgement advances consumer progress rather than completing one exclusively claimed task in the same sense as the selected job frameworks.

Forcing PgQue into `enqueue -> exclusive claim -> successful job deletion/completion` would erase the architecture being evaluated. It belongs in a future **durable event-stream and sustained-churn** study, not the first job-framework baseline.

## Common success-path benchmark contract

Only behavior all four implementations can represent without private APIs enters the common score: Ironshift, pg-boss, Graphile Worker, and the conventional SQL reference.

### Workload

1. Run on the same dedicated PostgreSQL server/database class, Node version, machine, payload bytes, task code, and client instrumentation.
2. Use one logical task type and independent jobs with unique IDs. The handler performs the same bounded no-op or deterministic payload check and no application I/O.
3. Pre-create/migrate schemas and queues before timing. Reset only the implementation under test between independent repetitions.
4. Use the same job counts, enqueue batch sizes, concurrency levels, repetition count, deterministic counterbalanced order, warm-up policy, and timeout.
5. Require exact success: every accepted job starts once in the measured success run, every handler resolves successfully, and the implementation reports or permits observation of durable completion. Any missing, duplicate, failed, or timed-out job invalidates the run.

### Timing boundaries

| Metric | Common boundary |
|---|---|
| Enqueue duration | Immediately before the first public batch enqueue call through completion of the final public batch enqueue call. |
| Start latency | Successful enqueue-call completion for each batch/job to the first instruction in that job's handler. Report p50/p95/p99 and samples. Do not call this manual claim latency for managed-worker products. |
| Processing duration | Worker availability/start signal to observation that all accepted jobs have completed successfully. |
| End-to-end duration | Immediately before first enqueue to observation of final successful completion. |
| Throughput | Exact successfully completed jobs divided by the declared processing or end-to-end interval. Keep both denominators named. |

Handler return alone is not sufficient if a framework settles completion afterward. The adapter must use the strongest public completion observation available, then document any residual observation delay. Post-run table counts cannot be the shared completion oracle because Graphile Worker deletes successful jobs.

### Common telemetry

Collect PostgreSQL WAL bytes, implementation schema/relation sizes, dead/live tuples, vacuum/analyze counters, database activity, and `pg_stat_io` where available. Query plans may be collected only through public/documented functions or permitted views. Graphile Worker's private tables are explicitly out of bounds. Telemetry queries must not run inside timed transactions or block workers.

## Configuration choices

Publish at least one **controlled baseline**. Optional optimized profiles must be named and reported separately.

| Choice | Ironshift / conventional | pg-boss 12.26.2 | Graphile Worker 0.17.3 |
|---|---|---|---|
| Runtime | Same Node process/version | Same Node process/version | Same Node process/version |
| Queue | One ordinary queue | Explicit `createQueue`, standard policy | Jobs without `queueName`; a Graphile queue name serializes work and would defeat global concurrency |
| Concurrency | `N` competing worker loops | `N` `work()` registrations, `batchSize: 1` | `run()` with `concurrency: N` and one in-memory task handler |
| Ingress | Public `enqueueMany` | Public `insert(name, jobs)` | Public `workerUtils.addJobs(specs)` |
| Payload | Identical JSON object | Identical JSON object | Identical JSON object |
| Retries in success run | Configured but not exercised | Declare `retryLimit`; no failures injected | Declare `maxAttempts`; no failures injected |
| Scheduling | Immediate only | No `startAfter` | No future `runAt` |
| Notification/polling baseline | Existing declared behavior | `useListenNotify: false`, queue `notify: false`; declare polling intervals | Declare `pollInterval`; notification behavior remains product-owned |
| Product batching | Adapter ingress batches only | `batchSize: 1`, no handler batch settlement | Disable `localQueue` and settlement delays for controlled baseline |
| Maintenance | Product default unless it contaminates timing; record all changes | Keep normal supervision/migrations outside timed setup | Run migrations outside timing; otherwise default maintenance |

For pg-boss, run the controlled baseline with polling settings declared. A second profile may enable `useListenNotify: true` and queue `notify: true`, because the docs define it as an optional latency optimization with polling fallback.[^pgboss-constructor][^pgboss-queues] Do not mix those results.

For Graphile Worker, the controlled baseline disables local queueing and completion/failure delays. A separately labeled optimized profile may follow the official starting guidance, such as `localQueue.size = concurrentJobs + 1` and declared settlement delays.[^graphile-performance] Local claim batching changes crash exposure and database round trips, so it cannot silently replace the baseline.

## Retention and physical-cost interpretation

Successful completion does not leave equivalent physical state:

- Ironshift and the conventional reference retain job identity/history according to their configured retention model.
- pg-boss retains completed jobs until `deleteAfterSeconds`; its documented default is seven days, and `0` means never delete.[^pgboss-jobs]
- Graphile Worker deletes successfully completed jobs and recommends an application shadow table when completed-job tracking is required.[^graphile-schema]

Therefore:

1. throughput and start/end-to-end latency may be compared under the common success contract;
2. WAL, relation growth, dead tuples, and cleanup work must be reported as **product lifecycle cost under the stated retention configuration**, not as a normalized storage-efficiency ranking;
3. do not force immediate pg-boss deletion or add a Graphile shadow-history table in the baseline merely to imitate Ironshift;
4. add a separate retention-normalized experiment only if every transformation is explicit and the default-lifecycle results remain available.

## Non-comparable features

The following remain feature/scenario evidence, not inputs to the common throughput score:

- Ironshift fencing tokens, stale-heartbeat/stale-completion rejection, explicit lease renewal, append-only events/attempts, partition retirement, and health snapshot;
- pg-boss queue policies, dead-letter/redrive, throttling/debounce, group concurrency, flows, and explicit administrative operations;
- Graphile Worker job keys, flags, named-queue serialization, cron behavior, private local-queue crash semantics, and successful-row deletion;
- any product's retry/backoff, delayed scheduling, cron, failure, cancellation, cleanup, or crash-recovery behavior until a separate scenario defines equivalent outcomes;
- the conventional model's architecture results as evidence of market-product maturity, operability, or feature completeness.

These may receive dedicated scenario tables with pass/fail invariants and implementation-specific notes. They must not be collapsed into a single synthetic score.

## Claim rules

Every published conclusion must follow these rules:

1. **Name the exact versions, commit/document pins, environment, PostgreSQL/Node versions, configuration, workload, and sample count.**
2. **Separate measured fact from explanation.** A latency or WAL difference does not prove its architectural cause without additional evidence.
3. **Use paired, counterbalanced repetitions and report distributions/confidence intervals.** Do not rank products from one run or only the fastest run.
4. **Use precise scopes:** “in this benchmark,” “on this machine,” “under this success-path configuration,” and “with product-default retention,” as applicable.
5. **Do not claim equivalence from a non-significant difference.** State that the experiment did not resolve a difference and report the interval/power limitation.
6. **Do not compare upstream marketing numbers with local results.** Upstream performance pages inform configuration and follow-up tests only.
7. **Do not call handler-start latency `claim latency` across managed-worker products.** The shared measure is enqueue-to-handler-start latency.
8. **Do not normalize away real lifecycle behavior without a separate profile.** Default-retention and normalized-retention results require distinct labels.
9. **Do not describe the conventional SQL model as a competitor or product.** It is an internal storage-control reference.
10. **Do not generalize exclusions into quality judgments.** River, PGMQ, and PgQue are excluded because the first baseline controls runtime and semantics, not because they are unsuitable in their intended categories.
11. **Do not make a headline winner claim unless exact completion invariants pass and the advantage persists across declared scales, repetitions, and relevant latency percentiles.**
12. **Preserve artifacts.** Publish raw run JSON, environment metadata, adapter/configuration source revision, schema reset procedure, and analysis beside any summary.

## Resulting baseline plan

The first deliverable is a three-column implementation study plus Ironshift:

1. Ironshift hybrid model;
2. internal conventional SQL reference, clearly marked non-product;
3. pg-boss 12.26.2;
4. Graphile Worker 0.17.3.

Run the common immediate-success workload first. Then add separately labeled product-default notification and optimized-batching profiles. Keep failure, retry, scheduling, crash recovery, retention normalization, and very-long-churn experiments outside the headline score until each has a fair semantic contract.

After the same-runtime baseline is stable, add River as the first native cross-language matrix target. Study PGMQ as a message primitive and PgQue as a durable event stream only in category-appropriate suites.

## Sources

[^pgboss-package]: pg-boss 12.26.2, [`package.json`](https://github.com/timgit/pg-boss/blob/12.26.2/package.json).
[^pgboss-constructor]: pg-boss 12.26.2, [Constructor](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/constructor.md).
[^pgboss-jobs]: pg-boss 12.26.2, [Jobs](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/jobs.md).
[^pgboss-workers]: pg-boss 12.26.2, [Workers](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/workers.md).
[^pgboss-ops]: pg-boss 12.26.2, [Operations](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/ops.md).
[^pgboss-queues]: pg-boss 12.26.2, [Queues](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/queues.md).
[^graphile-package]: Graphile Worker 0.17.3, [`package.json`](https://github.com/graphile/worker/blob/v0.17.3/package.json).
[^graphile-repo]: Graphile Worker 0.17.3, [repository tree](https://github.com/graphile/worker/tree/v0.17.3).
[^graphile-run]: Graphile Worker, [Library: running jobs](https://worker.graphile.org/docs/library/run).
[^graphile-addjobs]: Graphile Worker, [`addJobs()`](https://worker.graphile.org/docs/library/add-jobs).
[^graphile-performance]: Graphile Worker, [Performance](https://worker.graphile.org/docs/performance).
[^graphile-schema]: Graphile Worker, [Database schema](https://worker.graphile.org/docs/schema).
[^river-typescript]: River, [Inserting jobs from TypeScript](https://riverqueue.com/docs/typescript).
[^pgmq-readme]: PGMQ 1.12.0, [official extension README](https://github.com/pgmq/pgmq/blob/v1.12.0/pgmq-extension/README.md).
[^pgque-readme]: PgQue 0.2.0, [official README](https://github.com/NikolayS/PgQue/blob/v0.2.0/README.md).
