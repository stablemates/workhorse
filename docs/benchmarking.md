# Benchmark suite v3 runbook

This runbook explains how to execute Ironshift's benchmark suite, preserve reproducible evidence, and interpret results without making unsupported performance claims.

## Recorded evidence

- [2026-07-21 small-scale ladder](benchmarks/2026-07-21-small-scale-analysis.md): legacy v1 success-path results retained for historical comparison.
- [`results/2026-07-21-v3-smoke.json`](benchmarks/results/2026-07-21-v3-smoke.json): fresh v3 smoke artifact covering comparative and lifecycle suites.
- [`results/2026-07-21-v3-default.json`](benchmarks/results/2026-07-21-v3-default.json): clean-source v3 default artifact with batched ingress, counterbalanced paired runs, equal-load churn, and all lifecycle scenarios.
- [2026-07-21 v3 default-profile analysis](benchmarks/2026-07-21-v3-default-analysis.md): v2-to-v3 phase comparison, equal-load interpretation, WAL/storage limits, and architecture recommendation.
- [`results/2026-07-21-v2-default.json`](benchmarks/results/2026-07-21-v2-default.json): fresh v2 default-profile artifact with three repetitions at 1/4/8 workers, concurrent churn, and all lifecycle scenarios.
- [2026-07-21 v2 default-profile analysis](benchmarks/2026-07-21-v2-default-analysis.md): phase-level throughput diagnosis, paired comparisons, storage/WAL interpretation, churn limitations, and prioritized follow-up work.

## What v3 measures

V3 has two suites.

### Comparative suite

The comparative suite runs equivalent queue lifecycle semantics through two storage designs:

1. **Conventional:** a mutable lifetime job table with ready, scheduled, and expired-lease indexes plus event and attempt history.
2. **Hybrid:** immutable job identity, current-state projection, narrow ready/scheduled/lease projections, and append-only event and attempt history.

A seeded execution plan shuffles worker/repetition pairs and alternates which design runs first. The exact plan is recorded in `executionPlan`. For each pair, both designs are independently reset before measurement. The suite records:

- configurable `enqueueMany` batch size and the exact enqueue request count;
- enqueue, processing, and end-to-end duration plus phase-specific jobs/second;
- completed jobs per second;
- paired hybrid/conventional ratios and differences by worker level;
- raw client-observed claim latency samples and p50/p95/p99;
- Student-t 95% confidence intervals across independent repetitions;
- WAL bytes;
- per-relation heap, index, and total bytes;
- live/dead tuples, updates, HOT updates, deletes, vacuum, and analyze counters;
- schema totals;
- PostgreSQL activity before and after the run;
- `pg_stat_io` deltas where supported;
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the populated claim path.

The suite also performs equal-load fixed-rate producer-consumer churn. Both designs receive the same exact `targetJobs` at the same `targetRatePerSecond`; concurrent workers drain every job before the run can pass. It records production and drain duration, producer scheduling-lag distribution, maximum observed backlog, and exact completion. Telemetry runs on an independent scheduled task, not in the producer loop, and every sample records its own `sampleDurationMs`.

### Lifecycle suite

The lifecycle suite runs deterministic operational scenarios with hard invariants:

| Scenario                    | Evidence produced                                                    |
| --------------------------- | -------------------------------------------------------------------- |
| `scheduled-promotion-drift` | bounded promotion batches and due-time drift distribution            |
| `heartbeat-fencing`         | accepted heartbeat cost and stale-fence rejection cost               |
| `crash-before-completion`   | durable state at all five worker crash boundaries                    |
| `lease-expiry-recovery`     | recovery latency, new attempt/fence, and stale completion rejection  |
| `retry-paths`               | immediate, delayed, promoted, and terminal retry transitions         |
| `retention-pruning`         | bounded history retention behavior and retained job identity         |
| `health-snapshot`           | health-query latency and internally consistent degraded-state counts |

Scenario invariant failures abort the suite. This prevents a fast but semantically incorrect run from being treated as evidence.

## Safety and prerequisites

Requirements:

- Node.js 22 or newer;
- pnpm;
- PostgreSQL 15 or newer;
- enough free disk and WAL capacity for the chosen profile.

The suite defaults to `ironshift_bench` and rejects database names without the `_bench` suffix. Override only with a benchmark-specific URL:

```bash
export IRONSHIFT_BENCH_DATABASE_URL=postgres://ironshift:ironshift@localhost:5432/ironshift_bench
```

The benchmark resets Ironshift and benchmark-only tables while running. Never point it at production.

## Discover options

```bash
pnpm benchmark -- --help
```

Core options:

| Option            | Values                            | Meaning                                  |
| ----------------- | --------------------------------- | ---------------------------------------- |
| `--suite`         | `all`, `comparative`, `lifecycle` | Select the suite                         |
| `--profile`       | `smoke`, `default`, `full`        | Select a bounded configuration           |
| `--scenario`      | comma-separated names             | Run a lifecycle subset                   |
| `--seed`          | non-negative integer              | Seed the deterministic shuffled plan     |
| `--jobs`          | positive integer                  | Jobs per fixed comparative run           |
| `--enqueue-batch` | positive integer                  | Jobs per `enqueueMany` request           |
| `--repetitions`   | positive integer                  | Independent repetitions                  |
| `--workers`       | comma-separated integers          | Worker-concurrency sweep                 |
| `--churn-rate`    | positive integer                  | Producer target jobs per second          |
| `--churn-jobs`    | positive integer                  | Exact churn jobs per design              |
| `--sample-ms`     | positive integer                  | Independent telemetry interval           |
| `--output`        | path                              | Persist canonical deterministic-key JSON |

## Profiles

| Profile   | Intended use           | Fixed runs                                       | Equal-load churn    |
| --------- | ---------------------- | ------------------------------------------------ | ------------------- |
| `smoke`   | correctness and wiring | 12 jobs, batch 4, 2 reps, workers 1/2            | 20 jobs at 40/s     |
| `default` | local evidence         | 100 jobs, batch 25, 3 reps, workers 1/4/8        | 500 jobs at 100/s   |
| `full`    | controlled evidence    | 1,000 jobs, batch 100, 5 reps, workers 1/4/16/32 | 6,000 jobs at 100/s |

Profile values are starting points, not universal publication standards. Use CLI overrides for the hardware and research question.

## Fresh smoke run

Always reset the benchmark database after schema changes:

```bash
pnpm db:reset:bench
pnpm benchmark -- \
  --profile smoke \
  --suite all \
  --output docs/benchmarks/results/v3-smoke.json
```

A valid artifact has `schemaVersion: 3`, comparative runs and summaries, two churn results, and all lifecycle scenario assertions passing.

Useful checks:

```bash
jq '{schemaVersion, suite, profile, environment}' docs/benchmarks/results/v3-smoke.json

jq '.comparative.summaries[] | {
  design,
  workers: .workerConcurrency,
  throughput: .throughputPerSecond,
  claim_p95: .claimLatencyMs.perRunP95
}' docs/benchmarks/results/v3-smoke.json

jq '.lifecycle.scenarios[] | {
  name,
  durationMs,
  assertions_passed: ([.assertions[].passed] | all)
}' docs/benchmarks/results/v3-smoke.json
```

## Focused runs

Comparative only:

```bash
pnpm db:reset:bench
pnpm benchmark -- --suite comparative --profile default --output comparative.json
```

A worker sweep with custom churn:

```bash
pnpm benchmark -- \
  --suite comparative \
  --profile smoke \
  --seed 42 \
  --jobs 500 \
  --enqueue-batch 50 \
  --repetitions 5 \
  --workers 1,4,16 \
  --churn-rate 200 \
  --churn-jobs 6000 \
  --sample-ms 1000 \
  --output worker-sweep.json
```

Lifecycle only or one scenario:

```bash
pnpm benchmark -- --suite lifecycle --profile smoke --output lifecycle.json
pnpm benchmark -- --suite lifecycle --profile smoke --scenario lease-expiry-recovery
```

## Canonical JSON contract

Top-level fields:

- `schemaVersion`: report contract version, currently `3`;
- `generatedAt`: client wall-clock timestamp;
- `suite` and `profile`: resolved run selection;
- `environment`: database name, PostgreSQL version, and material PostgreSQL settings;
- `provenance`: exact command arguments, Node/OS/CPU/memory runtime metadata, source commit, and dirty state across benchmark-affecting source/configuration paths, including untracked files but excluding generated result artifacts;
- `configuration`: comparative and lifecycle inputs;
- `comparative`: independent runs, confidence summaries, and churn telemetry when selected;
- `lifecycle`: scenario metrics and assertions when selected.

Raw claim samples and raw PostgreSQL plans are intentionally retained so derived metrics can be independently recomputed. Dates and big integers are serialized safely.

## Interpretation rules

- Compare distributions and confidence intervals, not the single fastest run.
- Treat WAL as cluster-wide. Other database writes contaminate the delta.
- Treat tuple statistics as estimates that may lag or change after vacuum.
- Confirm claim plans use `conventional_job_claim_idx` and `job_runtime_ready_idx` before comparing latency.
- A smoke run proves wiring and invariants, not production scalability.
- Run publication-grade tests on stable hardware without unrelated load and preserve raw JSON plus environment metadata.
- External side effects remain at least once. Queue benchmark success does not prove exactly-once delivery to HTTP, email, or payment providers.

## Environment metadata

Alongside a publication artifact, capture at least:

```bash
node --version
pnpm --version
uname -a
lscpu
psql "$IRONSHIFT_BENCH_DATABASE_URL" -Atc "SELECT version()"
psql "$IRONSHIFT_BENCH_DATABASE_URL" -Atc "SELECT name || '=' || setting || COALESCE(unit, '')
  FROM pg_settings
  WHERE name IN (
    'shared_buffers', 'work_mem', 'maintenance_work_mem',
    'max_connections', 'autovacuum', 'autovacuum_naptime',
    'checkpoint_timeout', 'max_wal_size', 'synchronous_commit'
  ) ORDER BY name"
```

Also record storage type, VM/container status, concurrent workloads, held transactions, replication slots, and whether the database was freshly reset.

## Remaining evidence gaps

V2 closes the original equivalent-semantics, confidence interval, concurrency, churn, telemetry, and lifecycle-scenario gaps. A commercial build decision still needs larger retained-history horizons, deliberately held old snapshots or replication horizons, production-shaped payloads, reference-system comparisons, multiple PostgreSQL versions, and repeated runs on production-class hardware.

## Troubleshooting

### Reset or benchmark refuses the database

Preserve the `_bench` suffix. Remote resets additionally require `IRONSHIFT_ALLOW_REMOTE_RESET=1`.

### PostgreSQL statistics are unavailable

Run with a local development role allowed to read the required statistics. Do not broaden production privileges for this harness.

### Results vary

Caches, checkpoints, autovacuum, CPU frequency, storage contention, and other clients affect results. Increase repetitions, stabilize the environment, and compare distributions.

### A lifecycle scenario aborts

The scenario detected an invariant failure. Treat the run as invalid, inspect the named scenario and database state, fix correctness first, then rerun from a fresh database.

## Standalone competitor baseline

The competitor suite compares the common **successful immediate-job workload**, not the complete semantics of each queue:

```bash
pnpm db:reset:bench
pnpm benchmark:competitors -- --profile smoke --output docs/benchmarks/results/competitor-smoke.json
pnpm benchmark:competitors -- --profile default --output docs/benchmarks/results/competitor-default.json
```

### Targets and isolation

| Target          | Version            | Schema                       | Public APIs                                                      | Success retention                  |
| --------------- | ------------------ | ---------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Ironshift       | repository version | `ironshift`                  | `Queue.enqueueMany`, `claim`, `complete`; installed SQL protocol | retained with history              |
| pg-boss         | 12.26.2            | `pgboss_competitor`          | `insert`, `createQueue`, `work`, graceful `stop`                 | retained (`deleteAfterSeconds: 0`) |
| Graphile Worker | 0.17.3             | `graphile_worker_competitor` | `makeWorkerUtils().migrate/addJobs`, `run`, graceful `stop`      | deleted on success                 |

All targets use a 32-connection ceiling. pg-boss is configured with `retryLimit: 0`, `deleteAfterSeconds: 0`, `notify: true`, `useListenNotify: true`, and a per-job `batchSize: 1`; worker concurrency is supplied as `localConcurrency`. Graphile jobs use `maxAttempts: 1`, and `run()` receives the task list and concurrency without local claim batching. Ironshift jobs use one attempt and a 30-second lease.

The common target interface is workload-level: `reset/setup`, batched enqueue, start consumers, observe the exact expected completion set, stop, close, and expose schema metadata/capabilities. This deliberately hides native worker-loop differences while preserving them in target notes.

### Workloads and ordering

Both profiles run fixed batched burn-downs and one equal-offered-load producer/consumer churn per target. The plan uses deterministic shuffled three-target blocks. Within every worker/repetition block each target appears once, and repetitions rotate the three positions so position counts are balanced when repetitions are a multiple of three. Smoke uses three repetitions for this reason. Churn has only one observation per target and is exploratory; it cannot support a confidence-backed ranking.

The controlled default remains deliberately bounded at 100 jobs per fixed run and 600 churn jobs. pg-boss intentionally waits between single-job fetches from a preloaded backlog, and increasing `batchSize` would change the handler contract. Large native-throughput studies therefore require a separate configuration matrix with each product's batching behavior labeled explicitly.

Each run records enqueue, processing, and total phases; churn also records production, drain, sampled backlog, and maximum backlog. Exact completion is mandatory. Database evidence includes WAL bytes, schema totals/growth, and per-relation telemetry before and after the workload.

### Artifact contract

The JSON root is `artifactVersion: 1`, `contract: "common-success-path-v1"`, and `semanticEquivalence: false`. It contains:

- normalized profile configuration and deterministic execution plan;
- provenance: command, git SHA, source dirty state, Node/platform, database name and PostgreSQL version;
- target package versions, schema/queue configuration, capability flags, retention behavior, and semantic notes;
- per-run offered/enqueued/completed counts, exact-completion flag, position, phase durations, rates, load samples, WAL, schema growth, and relation telemetry;
- summaries grouped by target, workload kind, and concurrency.

Do not compare Graphile's post-success schema size as if it retained completed jobs. Do not interpret pg-boss or Graphile handler timing as directly comparable manual claim latency, and do not infer fencing guarantees from this suite. Ironshift exposes public claim/fence operations; both competitor worker APIs own claiming internally.

The timed end point is successful completion of every task handler. Framework-owned durable settlement can finish after a handler returns, so the suite does not claim a cross-product durable-settlement latency. Graceful shutdown and telemetry collection are outside timed phases. Product-specific handler/claim batching must be reported in a separately labeled optimized profile rather than mixed into this common per-job baseline.
