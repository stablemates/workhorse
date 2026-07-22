# PostgreSQL job-queue competitor selection for Ironshift benchmarks

**Date:** 2026-07-22
**Scope:** current first-party documentation and source only
**Decision:** benchmark **pg-boss 12.26.2**, **Graphile Worker 0.17.3**, and **River 0.40.0**. Exclude **PGMQ 1.12.0** and **PgQue 0.2.0** from the primary job-queue comparison because their message/log semantics require Ironshift's worker, retry, scheduling, and completion lifecycle to be reimplemented in the benchmark harness.

## Executive recommendation

The most defensible primary set is:

1. **pg-boss 12.26.2**: the closest Node.js/PostgreSQL framework comparison and the cleanest adapter to Ironshift's existing `enqueueMany -> claim -> complete` benchmark seam.
2. **Graphile Worker 0.17.3**: a mature Node.js/PostgreSQL worker framework with a first-party bulk enqueue function, `LISTEN/NOTIFY` plus polling, configurable worker concurrency, automatic retry, cron, and explicit high-throughput batching controls.
3. **River 0.40.0**: the strongest third competitor. It is a full job framework with transactional and `COPY FROM` batch enqueue, bounded worker concurrency, retries, scheduled and periodic jobs, maintenance, retention, `LISTEN/NOTIFY` fallback polling, and its own first-party burn-down/continuous benchmark modes. Its Go runtime is a confounder, but its lifecycle is materially fairer than PGMQ or PgQue.

Use all three for **public job-framework throughput and latency comparisons**, but preserve two qualifications:

- pg-boss and River retain finalized rows until cleanup, while Graphile Worker deletes a job on successful completion. Storage/WAL results therefore describe the products' real default lifecycle, not identical physical retention.
- River's public API owns claiming inside its worker loop. Measure handler-start and completion events rather than pretending a public manual `claim()` call exists.

Do **not** include PGMQ or PgQue in the main ranking. They can support a separate future study explicitly labeled **PostgreSQL message/log primitives**, not a job-framework benchmark.

## Method and selection criteria

The review first used the required Context7 flow for pg-boss and Graphile Worker, resolving `/timgit/pg-boss` and `/graphile/worker`, then querying installation, enqueue, work, completion, retry, scheduling, cleanup, and polling behavior. Every conclusion below was then checked against current official documentation, release metadata, or source.

A primary competitor had to provide first-party equivalents for most of this lifecycle:

1. deterministic installation and schema reset;
2. immediate and transactional enqueue;
3. true multi-job enqueue;
4. competing worker claim semantics;
5. success completion and failure transitions;
6. configurable concurrency;
7. bounded attempts and retry delay;
8. delayed and recurring scheduling;
9. cleanup or retention behavior;
10. documented notification/polling behavior and observable benchmark boundaries.

That matches Ironshift's comparative suite, which separates enqueue, processing, and end-to-end time, sweeps worker concurrency, records claim latency, and also runs equal-load producer/consumer churn.[^ironshift-runbook]

## Version pins and reproducible installation

| System          | Pin for benchmark        | Install                                                                                                                                                                                                                      | Dedicated-database setup                                                                                                                                                                | Full reset between independent runs                                                                                                                                                                    |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pg-boss         | `pg-boss@12.26.2`        | `npm install --save-exact pg-boss@12.26.2`                                                                                                                                                                                   | Start `PgBoss` and allow its default migration, or use the CLI `migrate`; create the named queue explicitly. Default schema is `pgboss`.[^pgboss-release][^pgboss-install][^pgboss-cli] | Stop all instances, `DROP SCHEMA pgboss CASCADE`, then rerun migration/start and `createQueue`. This is the documented uninstall path.[^pgboss-install]                                                |
| Graphile Worker | `graphile-worker@0.17.3` | `npm install --save-exact graphile-worker@0.17.3`                                                                                                                                                                            | `npx graphile-worker -c "$DATABASE_URL" --schema-only`, or `await workerUtils.migrate()`. Default schema is `graphile_worker`.[^graphile-package][^graphile-install][^graphile-queue]   | Scale workers to zero, `DROP SCHEMA graphile_worker CASCADE`, then rerun migrations. The docs warn that `CASCADE` can remove dependent objects, so use a benchmark-only database.[^graphile-uninstall] |
| River           | Go modules at `v0.40.0`  | `go get github.com/riverqueue/river@v0.40.0` and the selected driver, normally `github.com/riverqueue/river/riverdriver/riverpgxv5@v0.40.0`; install the CLI with `go install github.com/riverqueue/river/cmd/river@v0.40.0` | `river migrate-up --line main --database-url "$DATABASE_URL"`.[^river-release][^river-start][^river-migrations]                                                                         | Stop clients, then `river migrate-down --line main --database-url "$DATABASE_URL" --max-steps 10` followed by `migrate-up`. The down migration is explicitly destructive.[^river-migrations]           |

Pin container images, transitive lockfiles, PostgreSQL version, and source revisions in the result artifact. Do not use `@latest` in benchmark automation even where first-party getting-started docs use it.

## Capability matrix

| Dimension                    | pg-boss 12.26.2                                                                                                                                                                                                                                    | Graphile Worker 0.17.3                                                                                                                                                                                                                                             | River 0.40.0                                                                                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema setup                 | Automatic dedicated-schema creation/migration by default; migration CLI and SQL plans are available.[^pgboss-install][^pgboss-cli]                                                                                                                 | CLI `--schema-only`, `runMigrations()`, or `WorkerUtils.migrate()`.[^graphile-queue][^graphile-run]                                                                                                                                                                | Versioned CLI migrations, down migrations, list, and SQL export.[^river-migrations]                                                                                                                                                   |
| Transactional enqueue        | `send()`/`insert()` accept a custom `db` adapter; official ORM transaction adapters are provided. The caller owns the surrounding transaction when supplying the adapter.[^pgboss-jobs][^pgboss-adapters]                                          | The SQL functions `graphile_worker.add_job()` and `add_jobs()` can be invoked on the application's existing PostgreSQL transaction. The normal JS convenience methods acquire their own pool client.[^graphile-add-job][^graphile-add-jobs][^graphile-sql-add-job] | First-class `InsertTx` and `InsertManyTx`; uncommitted jobs are not worked and rollback removes them.[^river-start][^river-batch]                                                                                                     |
| Batch enqueue                | `insert(name, Job[], options)` creates multiple jobs in one request.[^pgboss-jobs]                                                                                                                                                                 | `addJobs(jobSpecs)` defers to the set-oriented SQL `add_jobs()` function. This is distinct from a single “batch job” whose payload is an array.[^graphile-add-jobs][^graphile-add-job]                                                                             | `InsertMany`/`InsertManyTx`; `InsertManyFast`/`InsertManyFastTx` use PostgreSQL `COPY FROM` with documented limitations.[^river-batch]                                                                                                |
| Claim/work                   | Public `fetch(name, { batchSize })` enables a direct claim seam; `work()` provides managed polling workers and batch handlers.[^pgboss-jobs][^pgboss-workers]                                                                                      | Managed runner owns claim and dispatch. `concurrentJobs` sets pool width; optional `localQueue` prefetches/locks multiple jobs.[^graphile-run][^graphile-config][^graphile-performance]                                                                            | Managed `Client.Start()` owns fetch/dispatch. Queue `MaxWorkers` controls worker goroutines; no public manual-claim benchmark API should be invented.[^river-start][^river-client-source]                                             |
| Completion/failure           | Manual `complete()`, `fail()`, and `deleteJob()` support scalar or ID-array settlement; `work()` automatically completes on return and fails on throw.[^pgboss-jobs][^pgboss-workers]                                                              | Task return completes; throw fails. Completion deletes the job. Optional completion/failure batching coalesces releases into fewer round trips.[^graphile-errors][^graphile-admin][^graphile-performance]                                                          | Returning `nil` completes; errors retry or eventually discard. `JobCompleteTx` atomically completes with application changes. Public subscriptions expose completed events.[^river-retries][^river-complete-tx][^river-subscriptions] |
| Concurrency                  | `localConcurrency` creates per-process workers; `batchSize` controls jobs per fetch. Group concurrency features exist but should be disabled for the baseline.[^pgboss-workers]                                                                    | `concurrentJobs` defaults to 1 and scales per process; multiple processes provide horizontal scaling. `localQueue` changes prefetch/lock behavior and must be a declared benchmark profile.[^graphile-config][^graphile-performance]                               | Per-queue `MaxWorkers`; multiple clients compete through PostgreSQL. Use the same total worker count as other systems.[^river-start][^river-client-source]                                                                            |
| Retry                        | Default `retryLimit: 2`, configurable fixed or exponential backoff, max delay, expiry, heartbeat, and dead-letter queue.[^pgboss-jobs][^pgboss-queues]                                                                                             | Default `maxAttempts: 25`; failures use exponential backoff `exp(least(10, attempt))`. Forceful shutdown fails running work for later retry.[^graphile-add-job][^graphile-errors][^graphile-backoff]                                                               | Default 25 attempts; default delay is `attempts^4` seconds with ±10% jitter, customizable per client or worker.[^river-retries]                                                                                                       |
| Delayed/recurring scheduling | `startAfter`/`sendAfter`; `schedule()` uses cron. Schedules are checked every 30 seconds by default and at least one instance must run.[^pgboss-jobs][^pgboss-scheduling]                                                                          | `runAt` for delay; distributed crontab with ACID duplicate prevention and optional backfill.[^graphile-add-job][^graphile-cron]                                                                                                                                    | `ScheduledAt` moves jobs through scheduled state, generally within 5 seconds after due; in-memory periodic/cron jobs are leader-owned and have documented restart/election caveats.[^river-scheduled][^river-periodic]                |
| Cleanup/retention            | Per-job/queue `retentionSeconds` and `deleteAfterSeconds`; default completed retention is 7 days. Daily maintenance drops eligible queued/completed jobs by default.[^pgboss-jobs][^pgboss-constructor]                                            | Successful jobs are deleted immediately. Permanently failed jobs remain until operator cleanup; `cleanup()` can delete permafailed jobs and garbage-collect unused queue/task identifiers.[^graphile-scaling][^graphile-admin]                                     | Cleaner retains completed/cancelled jobs for 24 hours and discarded jobs for 7 days by default, all configurable.[^river-maintenance][^river-client-source]                                                                           |
| Notification/polling         | Polling defaults to 2 seconds. New in the pinned release, opt-in `useListenNotify` plus queue `notify: true` wakes workers, with a 30-second polling backstop while the listener is active.[^pgboss-workers][^pgboss-constructor][^pgboss-release] | Workers `LISTEN` on `jobs:insert` and also poll; current default `pollInterval` is 2,000 ms. The listener uses a dedicated pool client and reconnects with backoff.[^graphile-config-source][^graphile-main-source]                                                | `LISTEN/NOTIFY` normally wakes fetchers; `FetchCooldown` defaults to 100 ms and fallback `FetchPollInterval` to 1 second. `PollOnly` disables listeners for transaction-pooling compatibility.[^river-client-source]                  |
| Native benchmark seam        | Best direct fit: `insert()` for ingress, `fetch()` timestamped per call for claim latency, `complete(ids)` for settlement, or `work()` for framework-realistic throughput.                                                                         | Use `addJobs()` for ingress and the normal runner for processing. Timestamp `job:start`/`job:success` worker events or task entry/completion, not private SQL claim functions. Declare batching profile.                                                           | Use `InsertMany` or `InsertManyFast`, task-entry timestamp, and completion subscriptions. River's own `bench` command confirms burn-down and continuous modes but should not replace the common Ironshift harness.[^river-bench]      |

## Candidate-specific benchmark designs

### 1. pg-boss: include

#### Defensible baseline

```ts
const boss = new PgBoss({
  connectionString,
  schema: "pgboss_bench",
  supervise: true,
  schedule: false,
  useListenNotify: false,
});
await boss.start();
await boss.createQueue(queueName);
```

Use a unique benchmark schema if the harness supports parameterized resets. Keep queue policy `standard`, no uniqueness, no priority variation, no dead-letter queue, no heartbeat, and a payload equivalent to Ironshift's synthetic payload.

#### Enqueue-only seam

Call one `boss.insert(queueName, jobs)` per configured Ironshift enqueue batch. Keep `returnId` disabled unless IDs are required because the docs state IDs are otherwise not returned by default. Record request count exactly.[^pgboss-jobs]

For the transactional scenario, pass the official `db` adapter bound to the harness transaction and verify rollback leaves zero jobs. Do not time ORM setup inside the enqueue phase.

#### Claim/completion seam

Two useful profiles should not be mixed:

- **Primitive lifecycle:** `fetch(queueName, { batchSize: 1 })`, timestamp each call, then `complete(queueName, id)` or array completion. This maps most closely to Ironshift's current adapter.
- **Framework-realistic:** `work(queueName, { localConcurrency: N, batchSize: 1 }, handler)`. Timestamp the first handler instruction and handler resolution. This includes pg-boss polling, dispatch, and automatic settlement.

The primary public result should use framework-realistic processing. Keep primitive claim microbenchmarks as diagnostic evidence.

#### Notification profile

The pinned 12.26.2 release added first-party `LISTEN/NOTIFY` support. Benchmark the default polling profile separately from `useListenNotify: true` plus queue `notify: true`; never silently enable it for only one competitor. Future-scheduled pg-boss jobs do not emit immediate notifications and mature through polling.[^pgboss-workers][^pgboss-queues]

### 2. Graphile Worker: include

#### Defensible baseline

```ts
const preset = {
  worker: {
    connectionString,
    schema: "graphile_worker_bench",
    concurrentJobs: workers,
    pollInterval: 2000,
    localQueue: { size: -1 },
    completeJobBatchDelay: -1,
    failJobBatchDelay: -1,
  },
};
```

Run migrations before timing. Supply an in-memory `taskList` with one no-op task. The no-batching profile above is the cleanest semantic baseline, but it is not Graphile Worker's recommended high-throughput configuration.

Therefore publish a second declared **optimized** profile using the project's starting guidance: `localQueue.size = concurrentJobs + 1` and nonnegative completion/failure batch delays. The official performance page warns that local queueing checks out extra jobs and that delayed settlement changes crash exposure.[^graphile-performance]

#### Enqueue-only seam

Use one `workerUtils.addJobs(jobSpecs)` call per configured batch. Do not represent many benchmark jobs as one Graphile “batch job” with an array payload, because that changes job identity and retry semantics.[^graphile-add-job][^graphile-add-jobs]

For transactional enqueue, issue `SELECT graphile_worker.add_jobs(...)` through the harness's existing `pg` transaction. This uses the documented public SQL API and avoids relying on private tables.

#### Work/completion seam

Start the normal runner with `concurrentJobs = N`. Count a job as claimed when its task handler begins and complete when the handler resolves or the `job:success` event is observed. Do not call private `get_jobs` SQL directly merely to force Graphile into Ironshift's manual-claim interface.

Graphile completion deletes rows. Accordingly:

- completed count should come from harness events/counters, not post-run job-table rows;
- relation/WAL measurements remain valuable but must be described as product-default lifecycle cost;
- retention-pruning is not equivalent to Ironshift's retained identity/history scenario and should be marked **not comparable**, rather than forcing permanent-failure cleanup into the success path.

### 3. River: include as the third competitor

River is a full lifecycle match. It supports transactional enqueue, batch and `COPY FROM` enqueue, managed competing workers, configurable attempts/backoff, scheduled jobs, periodic/cron jobs, stuck-job rescue, retention cleanup, and notification-backed fetch. Its own benchmark utility explicitly implements fixed burn-down and continuous producer/consumer modes, which closely resemble Ironshift's two comparative workload shapes.[^river-bench]

#### Defensible baseline

Build a small pinned Go benchmark adapter using `riverpgxv5` and a single no-op worker kind:

```go
client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
    Queues: map[string]river.QueueConfig{
        river.QueueDefault: {MaxWorkers: workers},
    },
    Workers: workersBundle,
})
```

Use default listener/polling behavior and default completion path. Disable periodic jobs and do not use Pro-only batching or concurrency-limit features.

#### Enqueue-only seam

Use `InsertMany` for the main cross-product comparison because it returns inserted job results and has conventional multi-row semantics. Add `InsertManyFast` as an explicitly optimized ingress profile. It uses `COPY FROM`, does not return inserted rows, and handles uniqueness conflicts differently, so it must not silently replace the normal profile.[^river-batch]

Use `InsertManyTx` for rollback/commit correctness. River documents that jobs are not worked until commit and disappear on rollback.[^river-batch]

#### Work/completion seam

River intentionally owns fetch/claim. Timestamp:

1. immediately before batch insert;
2. the first instruction in `Work()` for per-job enqueue-to-handler latency;
3. handler return;
4. `EventKindJobCompleted` subscription receipt for durable completion observation.

Treat subscription delay as a separate observation if it is included. Throughput completion should be based on River completion events or a final state query, not merely handler returns.

River does not provide Ironshift-style fencing tokens in the public worker API. Its crash/stuck-job recovery can be studied, but the exact stale-completion rejection lifecycle scenario is not a direct equivalence and should not enter the common throughput score.

## Why PGMQ is excluded from the primary benchmark

PGMQ 1.12.0 is a well-defined PostgreSQL message queue, but its own first-party description says it has **no background worker**, messages remain until explicitly removed, and retry is visibility-timeout redelivery.[^pgmq-release][^pgmq-readme]

Its primitive mapping would be:

- enqueue: `pgmq.send_batch()`;
- claim: `pgmq.read(queue_name, vt, qty)`;
- success: `pgmq.delete()` or `pgmq.archive()`;
- recovery: allow the visibility timeout to expire.

That is useful for an SQS-style primitive benchmark, but the harness would have to invent:

- worker lifecycle and concurrency management;
- max-attempt and backoff policy;
- terminal failure/dead-letter behavior;
- recurring scheduling;
- automatic retention cleanup;
- notification behavior, because the core model is application polling.

The resulting score would measure Ironshift's benchmark adapter around PGMQ as much as PGMQ itself. It would also compare a job framework against a lower-level queue primitive whose absence of worker and maintenance writes is part of its category, not an optimization of equivalent semantics. Exclude it from the headline comparison.

A future **primitive queue** appendix could fairly compare Ironshift's low-level SQL operations with PGMQ `send_batch/read/delete`, using identical client-side worker loops and clearly limiting claims to immediate jobs, visibility timeout, and explicit delete/archive.

## Why PgQue is excluded from the primary benchmark

PgQue 0.2.0 is even less semantically aligned. Its official README explicitly describes it as a durable shared event stream “closer to Kafka” than a task queue and explicitly categorizes River, pg-boss, and Graphile Worker as job frameworks while PgQue is an event/message queue.[^pgque-release][^pgque-readme]

Its architecture uses snapshot batches, independent consumer cursors, ticks, and table rotation. The documented default ticker runs every 100 ms, and delivery requires `pg_cron`, `pg_timetable`, or an application-driven ticker. Its own comparison notes that job queues are preferable for per-job lifecycle, priority, cron scheduling, and low dispatch latency.[^pgque-readme]

Including it would change all of these semantics:

- one shared event can be observed by multiple independent consumers rather than claimed by exactly one competing worker;
- receive/ack operates at consumer batch/cursor boundaries;
- delivery latency includes configurable tick cadence by design;
- its zero-bloat claim rests on log rotation rather than mutable per-job state;
- retry, acknowledgement, and dead-letter behavior are event-consumer mechanics, not Ironshift's leased job attempt/fencing model.

PgQue is an interesting architecture reference for Ironshift, especially for sustained-load storage behavior, but not a defensible third entry in a job-framework throughput ranking. A separate event-stream benchmark would need fan-out, cursor lag, tick cadence, batch acknowledgement, and long-running rotation as first-class workload dimensions.

## Fairness rules for implementation

1. **Pin exact versions** listed above and save lockfiles/module sums.
2. **Use a dedicated database or schema per system** and fully reset it before each independent repetition.
3. **Counterbalance execution order** using Ironshift's existing seeded plan.
4. **Use the same payload bytes, job count, batch size, producer rate, total worker concurrency, PostgreSQL instance, and connection budget.**
5. **Separate baseline and optimized profiles.** In particular, do not compare default Graphile Worker without batching against River `InsertManyFast` or pg-boss notification mode and call it a product ranking.
6. **Measure framework-realistic processing for the headline result.** Manual claim APIs may be secondary diagnostics only.
7. **Record completion semantics.** Graphile deletes on completion; pg-boss and River retain finalized rows until cleanup. Do not normalize this away with private-table mutations.
8. **Disable scheduling during immediate-job throughput runs.** Preserve separate delayed/recurring correctness tests.
9. **Keep retries off the success-path throughput test** by setting equivalent max attempts without inducing failures. Run retry behavior as a separate deterministic lifecycle scenario.
10. **Do not use private tables or private SQL claim functions** to make adapters look uniform. Use public APIs and record where observability differs.
11. **Keep notification profiles explicit.** Default polling and notification-assisted dispatch answer different latency questions.
12. **Report runtime cost honestly.** pg-boss and Graphile run in Node.js; River runs in Go. Database telemetry is directly comparable, while client CPU/memory and handler dispatch include runtime differences.
13. **Do not reuse vendor benchmark claims as Ironshift evidence.** River and Graphile publish benchmark utilities/results, but both caution that environment and configuration dominate. Run the common harness on the same machine.[^river-bench][^graphile-performance]

## Proposed adapter contract

Ironshift's current internal adapter assumes a public manual claim. A competitor harness should use a slightly deeper interface so managed-worker frameworks are not penalized or accessed through private APIs:

```ts
interface CompetitorAdapter {
  name: "pg-boss" | "graphile-worker" | "river";
  version: string;
  reset(): Promise<void>;
  install(): Promise<void>;
  enqueueMany(jobs: BenchmarkJob[]): Promise<void>;
  startWorkers(options: {
    concurrency: number;
    onStart(jobId: string, enqueuedAt: number): void;
    onComplete(jobId: string): void;
  }): Promise<{ stop(): Promise<void> }>;
  countCompleted(): Promise<number>;
  relationScope(): Promise<string[]>;
}
```

Optional diagnostic capability:

```ts
interface ManualClaimAdapter {
  claimOne(): Promise<ClaimedJob | null>;
  completeOne(job: ClaimedJob): Promise<void>;
}
```

Only pg-boss cleanly implements the optional interface through documented public methods. The common score should use `startWorkers()` for all three.

## Final decision

| Candidate              | Decision                 | Confidence | Reason                                                                                                           |
| ---------------------- | ------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| pg-boss 12.26.2        | **Include**              | High       | Closest ecosystem and excellent public benchmark seams; full job lifecycle.                                      |
| Graphile Worker 0.17.3 | **Include**              | High       | Mature, semantically complete worker framework; bulk SQL API and well-documented performance profiles.           |
| River 0.40.0           | **Include as third**     | High       | Strongest lifecycle match and benchmark maturity. Go runtime is a disclosed confounder, not a semantic mismatch. |
| PGMQ 1.12.0            | **Exclude from primary** | High       | SQS-like message primitive without managed workers, retry policy, scheduling, or automatic lifecycle cleanup.    |
| PgQue 0.2.0            | **Exclude from primary** | High       | Shared event-log/cursor/tick architecture explicitly positioned as a different category from job frameworks.     |

## First-party sources

[^ironshift-runbook]: Ironshift, [Benchmark suite v3 runbook](../benchmarking.md).

[^pgboss-release]: pg-boss, [release 12.26.2](https://github.com/timgit/pg-boss/releases/tag/12.26.2) and [package manifest at that tag](https://github.com/timgit/pg-boss/blob/12.26.2/package.json).

[^pgboss-install]: pg-boss, [database install and uninstall](https://github.com/timgit/pg-boss/blob/12.26.2/docs/install.md).

[^pgboss-cli]: pg-boss, [migration CLI](https://github.com/timgit/pg-boss/blob/12.26.2/docs/cli.md).

[^pgboss-jobs]: pg-boss, [jobs API: send, insert, fetch, complete, fail, delete, retry, retention](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/jobs.md).

[^pgboss-adapters]: pg-boss, [ORM transaction adapters](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/adapters.md).

[^pgboss-workers]: pg-boss, [workers, concurrency, batch handling, polling, and LISTEN/NOTIFY](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/workers.md).

[^pgboss-queues]: pg-boss, [queue policies, dead letters, and notify option](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/queues.md).

[^pgboss-scheduling]: pg-boss, [cron scheduling](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/scheduling.md).

[^pgboss-constructor]: pg-boss, [constructor, migration, supervision, maintenance, and notification options](https://github.com/timgit/pg-boss/blob/12.26.2/docs/api/constructor.md).

[^graphile-package]: Graphile Worker, [official npm registry metadata for 0.17.3](https://registry.npmjs.org/graphile-worker/0.17.3) and [package manifest](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/package.json).

[^graphile-install]: Graphile Worker, [installation](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/installation.md).

[^graphile-queue]: Graphile Worker, [queueing and migrations with WorkerUtils](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/library/queue.md).

[^graphile-run]: Graphile Worker, [library runner, runOnce, and runMigrations](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/library/run.md).

[^graphile-add-job]: Graphile Worker, [`addJob()` and batch-job payload semantics](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/library/add-job.md).

[^graphile-add-jobs]: Graphile Worker, [`addJobs()` bulk enqueue](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/library/add-jobs.md).

[^graphile-sql-add-job]: Graphile Worker, [public SQL `add_job` and `add_jobs` APIs](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/sql-add-job.md).

[^graphile-config]: Graphile Worker, [worker configuration](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/config.md).

[^graphile-performance]: Graphile Worker, [performance and batching](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/performance.md).

[^graphile-errors]: Graphile Worker, [failure, retry, and shutdown behavior](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/error-handling.md).

[^graphile-backoff]: Graphile Worker, [exponential backoff formula](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/exponential-backoff.md).

[^graphile-cron]: Graphile Worker, [distributed crontab and backfill](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/cron.md).

[^graphile-admin]: Graphile Worker, [administrative completion, failure, unlock, and cleanup](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/admin-functions.md).

[^graphile-scaling]: Graphile Worker, [successful-job deletion and permafailed-job cleanup guidance](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/scaling.md).

[^graphile-uninstall]: Graphile Worker, [uninstall/reset](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/website/docs/uninstall.md).

[^graphile-config-source]: Graphile Worker, [default poll interval and concurrency source](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/src/config.ts).

[^graphile-main-source]: Graphile Worker, [LISTEN/NOTIFY listener and reconnect source](https://github.com/graphile/worker/blob/ca2cef1c8c6bf9d9c818d19f194f596971c212df/src/main.ts).

[^river-release]: River, [release v0.40.0](https://github.com/riverqueue/river/releases/tag/v0.40.0).

[^river-start]: River, [getting started](https://riverqueue.com/docs).

[^river-migrations]: River, [migrations](https://riverqueue.com/docs/migrations).

[^river-batch]: River, [inserting many jobs](https://riverqueue.com/docs/batch-job-insertion).

[^river-retries]: River, [job retries](https://riverqueue.com/docs/job-retries).

[^river-scheduled]: River, [scheduled jobs](https://riverqueue.com/docs/scheduled-jobs).

[^river-periodic]: River, [periodic and cron jobs](https://riverqueue.com/docs/periodic-jobs).

[^river-maintenance]: River, [maintenance services and retention](https://riverqueue.com/docs/maintenance-services).

[^river-complete-tx]: River, [transactional job completion](https://riverqueue.com/docs/transactional-job-completion).

[^river-subscriptions]: River, [subscriptions](https://riverqueue.com/docs/subscriptions).

[^river-bench]: River, [official benchmark utility and workload modes](https://riverqueue.com/docs/benchmarks).

[^river-client-source]: River v0.40.0, [`Config` defaults for workers, retention, fetch cooldown, polling, and LISTEN/NOTIFY](https://github.com/riverqueue/river/blob/v0.40.0/client.go).

[^pgmq-release]: PGMQ, [release v1.12.0](https://github.com/pgmq/pgmq/releases/tag/v1.12.0) and [extension version](https://github.com/pgmq/pgmq/blob/v1.12.0/pgmq-extension/pgmq.control).

[^pgmq-readme]: PGMQ, [official README: no worker, visibility timeout, send/read/delete/archive](https://github.com/pgmq/pgmq/blob/v1.12.0/pgmq-extension/README.md) and [installation/reset](https://github.com/pgmq/pgmq/blob/v1.12.0/INSTALLATION.md).

[^pgque-release]: PgQue, [release v0.2.0](https://github.com/NikolayS/PgQue/releases/tag/v0.2.0).

[^pgque-readme]: PgQue, [official README: event-log category, tick architecture, install, and comparison](https://github.com/NikolayS/PgQue/blob/v0.2.0/README.md).
