# Benchmark suite v2 runbook

This runbook explains how to execute Ironshift's benchmark suite, preserve reproducible evidence, and interpret results without making unsupported performance claims.

## Recorded evidence

- [2026-07-21 small-scale ladder](benchmarks/2026-07-21-small-scale-analysis.md): legacy v1 success-path results retained for historical comparison.
- [`results/2026-07-21-v2-smoke.json`](benchmarks/results/2026-07-21-v2-smoke.json): fresh v2 smoke artifact covering comparative and lifecycle suites.
- [`results/2026-07-21-v2-default.json`](benchmarks/results/2026-07-21-v2-default.json): fresh v2 default-profile artifact with three repetitions at 1/4/8 workers, concurrent churn, and all lifecycle scenarios.

## What v2 measures

V2 has two suites.

### Comparative suite

The comparative suite runs equivalent queue lifecycle semantics through two storage designs:

1. **Conventional:** a mutable lifetime job table with ready, scheduled, and expired-lease indexes plus event and attempt history.
2. **Hybrid:** immutable job identity, current-state projection, narrow ready/scheduled/lease projections, and append-only event and attempt history.

For each worker-concurrency level and independent repetition, both designs are reset before measurement. The suite records:

- enqueue, processing, and end-to-end duration;
- completed jobs per second;
- raw client-observed claim latency samples and p50/p95/p99;
- Student-t 95% confidence intervals across independent repetitions;
- WAL bytes;
- per-relation heap, index, and total bytes;
- live/dead tuples, updates, HOT updates, deletes, vacuum, and analyze counters;
- schema totals;
- PostgreSQL activity before and after the run;
- `pg_stat_io` deltas where supported;
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the populated claim path.

The suite also performs sustained producer-consumer churn. A producer continuously enqueues batches while concurrent workers claim and complete jobs; after the timed production window closes, workers drain the remaining backlog. Periodic relation, schema, and activity samples are captured while production and consumption overlap. The JSON records this as `workloadModel: "concurrent-producer-consumer"`.

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

| Option          | Values                            | Meaning                                      |
| --------------- | --------------------------------- | -------------------------------------------- |
| `--suite`       | `all`, `comparative`, `lifecycle` | Select the suite                             |
| `--profile`     | `smoke`, `default`, `full`        | Select a bounded configuration               |
| `--scenario`    | comma-separated scenario names    | Run a lifecycle subset                       |
| `--jobs`        | positive integer                  | Override jobs per comparative run            |
| `--repetitions` | positive integer                  | Override independent repetitions             |
| `--rounds`      | positive integer                  | Legacy alias for `--repetitions`             |
| `--workers`     | comma-separated integers          | Override the worker-concurrency sweep        |
| `--churn-ms`    | positive integer                  | Override sustained churn duration            |
| `--sample-ms`   | positive integer                  | Override churn sampling interval             |
| `--output`      | path                              | Persist canonical JSON in addition to stdout |

## Profiles

| Profile   | Intended use               | Comparative shape                                        |
| --------- | -------------------------- | -------------------------------------------------------- |
| `smoke`   | correctness and wiring     | 12 jobs, 2 repetitions, workers 1/2, 500 ms churn        |
| `default` | local development evidence | 100 jobs, 3 repetitions, workers 1/4/8, 5 s churn        |
| `full`    | controlled evidence runs   | 1,000 jobs, 5 repetitions, workers 1/4/16/32, 60 s churn |

Profile values are starting points, not universal publication standards. Use CLI overrides for the hardware and research question.

## Fresh smoke run

Always reset the benchmark database after schema changes:

```bash
pnpm db:reset:bench
pnpm benchmark -- \
  --profile smoke \
  --suite all \
  --output docs/benchmarks/results/v2-smoke.json
```

A valid artifact has `schemaVersion: 2`, comparative runs and summaries, two churn results, and all lifecycle scenario assertions passing.

Useful checks:

```bash
jq '{schemaVersion, suite, profile, environment}' docs/benchmarks/results/v2-smoke.json

jq '.comparative.summaries[] | {
  design,
  workers: .workerConcurrency,
  throughput: .throughputPerSecond,
  claim_p95: .claimLatencyMs.perRunP95
}' docs/benchmarks/results/v2-smoke.json

jq '.lifecycle.scenarios[] | {
  name,
  durationMs,
  assertions_passed: ([.assertions[].passed] | all)
}' docs/benchmarks/results/v2-smoke.json
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
  --jobs 500 \
  --repetitions 5 \
  --workers 1,4,16 \
  --churn-ms 30000 \
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

- `schemaVersion`: report contract version, currently `2`;
- `generatedAt`: client wall-clock timestamp;
- `suite` and `profile`: resolved run selection;
- `environment`: database name, PostgreSQL version, and material PostgreSQL settings;
- `provenance`: exact command arguments, Node/OS/CPU/memory runtime metadata, source commit, and dirty-tree state;
- `configuration`: comparative and lifecycle inputs;
- `comparative`: independent runs, confidence summaries, and churn telemetry when selected;
- `lifecycle`: scenario metrics and assertions when selected.

Raw claim samples and raw PostgreSQL plans are intentionally retained so derived metrics can be independently recomputed. Dates and big integers are serialized safely.

## Interpretation rules

- Compare distributions and confidence intervals, not the single fastest run.
- Treat WAL as cluster-wide. Other database writes contaminate the delta.
- Treat tuple statistics as estimates that may lag or change after vacuum.
- Confirm claim plans use `conventional_job_claim_idx` and `ready_job_claim_idx` before comparing latency.
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
