# Benchmark runbook

This runbook explains how to execute the Ironshift benchmark, preserve reproducible results, and interpret them without making unsupported performance claims.

## Recorded evidence

- [2026-07-21 small-scale ladder](benchmarks/2026-07-21-small-scale-analysis.md): 25 through 5,000 jobs per round, three retained-history rounds, raw JSON, normalized CSV, environment metadata, and analysis.

## What the current benchmark measures

Each round runs two designs against the same PostgreSQL database:

1. **Conventional:** one mutable job table with a partial ready index. Claim and completion update the same lifetime row.
2. **Hybrid:** immutable `job`, current projection, narrow `ready_job`, bounded `lease`, and append-only history.

The benchmark-only `ironshift_benchmark_conventional.job` fields are:

| Field         | PostgreSQL type             | Purpose                                                                                                                      |
| ------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `bigint` generated identity | Stable row identity and FIFO ordering key for the conventional claim.                                                        |
| `queue_name`  | `text`                      | Queue predicate used by the partial ready index.                                                                             |
| `payload`     | `jsonb`                     | Benchmark payload stored on the same mutable row, intentionally representing the conventional wide-table shape.              |
| `status`      | `text`                      | Mutable state used by the partial ready index. The current workload writes `ready`, `active`, and `succeeded`.               |
| `attempt`     | `integer`                   | Attempt counter placeholder, defaulting to `1`. The success-path baseline does not currently exercise conventional retries.  |
| `fence_token` | `bigint`                    | Mutable ownership-generation placeholder incremented on claim. The baseline does not yet enforce full lease/fence semantics. |
| `result`      | `jsonb`                     | Successful result written on the lifetime job row.                                                                           |
| `created_at`  | `timestamptz`               | Row creation time.                                                                                                           |
| `updated_at`  | `timestamptz`               | Last claim or completion mutation time.                                                                                      |

For each design and round the report includes:

- jobs completed per second;
- p50, p95, and p99 client-observed claim query latency;
- total relation bytes in the design schema;
- PostgreSQL's estimated dead tuple count;
- WAL bytes generated between the round's start and end;
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for a populated ready-queue claim.

Terminal rows and history are retained between rounds. This is intentional. It lets later rounds show whether claim latency, storage, plans, and dead tuples change as lifetime history grows.

## Benchmark JSON field dictionary

The top-level report contains:

| Field             | Type            | Purpose                                                                                                             |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `generatedAt`     | ISO 8601 string | Client wall-clock time when report construction began. Use it to correlate the run with system and PostgreSQL logs. |
| `database`        | `string`        | Full result of PostgreSQL `version()`, including server version, platform, and compiler information.                |
| `settings.jobs`   | `number`        | Jobs executed per design in each round.                                                                             |
| `settings.rounds` | `number`        | Number of retained-history rounds requested.                                                                        |
| `results`         | result array    | One result for each design in each round, ordered conventional then hybrid for round 1, then round 2, and so on.    |

Every entry in `results` contains:

| Field                 | Type                       | Purpose                                                                                                                                                                                                                                                |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `design`              | `conventional \| hybrid`   | Workload implementation that produced this result.                                                                                                                                                                                                     |
| `round`               | `number`                   | One-based retained-history round number. Rows from prior rounds still exist when this round runs.                                                                                                                                                      |
| `jobs`                | `number`                   | Number of jobs enqueued, claimed, and completed by this design in this round.                                                                                                                                                                          |
| `throughputPerSecond` | `number`                   | `jobs / elapsed wall-clock seconds` for enqueue, all claims, and all completions in the round. It is end-to-end round throughput, not claim-only throughput.                                                                                           |
| `claimLatencyMs.p50`  | `number`                   | Nearest-rank 50th percentile of client-observed claim query durations.                                                                                                                                                                                 |
| `claimLatencyMs.p95`  | `number`                   | Nearest-rank 95th percentile of client-observed claim query durations.                                                                                                                                                                                 |
| `claimLatencyMs.p99`  | `number`                   | Nearest-rank 99th percentile of client-observed claim query durations. This is the primary long-tail dispatch signal.                                                                                                                                  |
| `relationBytes`       | `number`                   | Sum of `pg_total_relation_size` for ordinary and partitioned relations in the design schema after the round. It includes heap, indexes, and auxiliary storage and can double-count parent metadata only where PostgreSQL reports non-zero parent size. |
| `deadTuples`          | `number`                   | Sum of PostgreSQL's estimated `n_dead_tup` for design relations after forcing a statistics flush. It is approximate and may change after vacuum.                                                                                                       |
| `walBytes`            | `number`                   | Difference between WAL locations at round start and end. Unrelated writes to the same PostgreSQL cluster contaminate this value.                                                                                                                       |
| `claimPlan`           | PostgreSQL JSON plan array | Raw `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` output for a claim select while the ready set is populated. Its nested fields are PostgreSQL-version-specific and are intentionally preserved without reshaping.                                         |

The benchmark currently stores percentile summaries, not every raw claim sample. A publication-grade harness should also persist raw or histogram latency data so percentiles can be recomputed independently.

## Important limitation

The conventional implementation is currently a success-path baseline. It does not yet reproduce every hybrid lease, recovery, and history write. Compare trends within each design before comparing absolute numbers between designs. Do not publish product superiority claims from this harness until semantics are equivalent and the broader scenarios below are implemented.

## Prerequisites

- Node.js 22 or newer
- pnpm
- PostgreSQL 15 or newer running on the host
- an `ironshift` login role that can create databases
- enough free disk and WAL capacity for the selected workload

The benchmark defaults to its isolated local database. Override only that role when needed:

```bash
export IRONSHIFT_BENCH_DATABASE_URL=postgres://ironshift:ironshift@localhost:5432/ironshift_bench
```

The benchmark is destructive to Ironshift and benchmark tables in that database. It rejects database names that do not end in `_bench`. It does not read `DATABASE_URL`, `IRONSHIFT_DEV_DATABASE_URL`, or `IRONSHIFT_TEST_DATABASE_URL`.

## Discover CLI options

```bash
pnpm benchmark -- --help
```

Options:

| Option          | Default | Meaning                                                        |
| --------------- | ------: | -------------------------------------------------------------- |
| `--jobs N`      |  `1000` | Jobs enqueued, claimed, and completed per design in each round |
| `--rounds N`    |     `3` | Number of retained-history rounds                              |
| `--output PATH` |    none | Write the JSON report to a file in addition to stdout          |

## First smoke run

Reset the database after any schema change, then run a small workload:

```bash
pnpm db:reset:bench
pnpm benchmark -- --jobs 25 --rounds 1 --output benchmark-smoke.json
```

A successful report contains two results, one for `conventional` and one for `hybrid`. Confirm the executable plans saw a ready row:

```bash
jq '.results[] | {
  design,
  p99_ms: .claimLatencyMs.p99,
  actual_rows: .claimPlan[0].Plan["Actual Rows"]
}' benchmark-smoke.json
```

`actual_rows` should be `1`. A zero indicates the plan was captured against an empty or ineligible ready set and the run should not be used.

## Development comparison

Use enough rounds to retain visible history without committing to a long run:

```bash
pnpm db:reset:bench
pnpm benchmark -- --jobs 1000 --rounds 5 --output benchmark-dev.json
```

Inspect per-round trends:

```bash
jq -r '
  ["design", "round", "jobs_per_sec", "p50_ms", "p95_ms", "p99_ms", "MiB", "dead", "wal_MiB"],
  (.results[] | [
    .design,
    .round,
    (.throughputPerSecond | floor),
    .claimLatencyMs.p50,
    .claimLatencyMs.p95,
    .claimLatencyMs.p99,
    (.relationBytes / 1048576),
    .deadTuples,
    (.walBytes / 1048576)
  ]) | @tsv
' benchmark-dev.json | column -t
```

Look for the slope across rounds, not just the fastest single result:

- Does p99 claim latency grow as terminal history accumulates?
- Does the claim plan remain an index scan with stable rows removed by filter?
- How quickly do relation bytes and WAL grow?
- Do dead tuple estimates keep increasing between autovacuum cycles?

## Longer churn run

Start conservatively and monitor disk/WAL usage in another terminal:

```bash
pnpm db:reset:bench
pnpm benchmark -- --jobs 100000 --rounds 10 --output benchmark-churn-100k-x10.json
```

Monitor PostgreSQL while it runs. Stop the loop with Ctrl-C:

```bash
while true; do
  psql "$IRONSHIFT_BENCH_DATABASE_URL" -x <<'SQL'
SELECT now(),
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       pg_notification_queue_usage() AS notification_queue_usage;
SELECT schemaname, relname, n_live_tup, n_dead_tup, n_tup_upd, n_tup_hot_upd,
       last_autovacuum, autovacuum_count
FROM pg_stat_user_tables
WHERE schemaname IN ('ironshift', 'ironshift_benchmark_conventional')
ORDER BY schemaname, relname;
SQL
  sleep 2
done
```

The current implementation performs one client claim and completion at a time. Large runs can take a long time. Run them in a stable environment without unrelated application load.

## Capture environment metadata

A benchmark file already records PostgreSQL's version, job count, rounds, timestamp, results, and plans. For reproducibility, save these alongside it:

```bash
mkdir -p benchmark-artifacts
cp benchmark-churn-100k-x10.json benchmark-artifacts/

node --version > benchmark-artifacts/node-version.txt
pnpm --version > benchmark-artifacts/pnpm-version.txt
uname -a > benchmark-artifacts/uname.txt
lscpu > benchmark-artifacts/lscpu.txt
psql "$IRONSHIFT_BENCH_DATABASE_URL" -Atc "SELECT version()" > benchmark-artifacts/postgres-version.txt
psql "$IRONSHIFT_BENCH_DATABASE_URL" -Atc "SELECT name || '=' || setting || COALESCE(unit, '')
  FROM pg_settings
  WHERE name IN (
    'shared_buffers', 'work_mem', 'maintenance_work_mem',
    'max_connections', 'autovacuum', 'autovacuum_naptime',
    'checkpoint_timeout', 'max_wal_size', 'synchronous_commit'
  ) ORDER BY name" > benchmark-artifacts/postgres-settings.txt
```

Also record whether the database was freshly reset, what else was running, storage type, container/VM status, and any held transactions or replication slots.

## Reading claim plans

Extract the top plan for each result:

```bash
jq '.results[] | {design, round, plan: .claimPlan[0].Plan}' benchmark-dev.json
```

Useful fields include:

- `Node Type` and child plan node types;
- `Index Name`;
- `Actual Rows` and `Rows Removed by Filter`;
- `Shared Hit Blocks` and `Shared Read Blocks`;
- planning and execution time.

The hybrid claim should use `ready_job_claim_idx`. The conventional claim should use `conventional_claim_idx`. Plan regressions should be investigated before comparing latency numbers.

## Run health diagnostics

Before and after a benchmark:

```bash
pnpm exec tsx src/cli/health.ts --database bench > health-before.json
pnpm benchmark -- --jobs 1000 --rounds 5 --output benchmark-dev.json
pnpm exec tsx src/cli/health.ts --database bench > health-after.json
```

`pnpm health:bench` is convenient for humans, but pnpm prints its package script banner. Use the executable directly when stdout must contain only JSON:

```bash
pnpm exec tsx src/cli/health.ts --database bench > health.json
```

Compare relation churn:

```bash
jq '.relations[] | {
  relation,
  totalBytes,
  tableBytes,
  indexBytes,
  deadTuples,
  hotUpdateRatio,
  lastVacuum,
  lastAutovacuum
}' health-after.json
```

## Reset between independent experiments

Rounds inside one run intentionally retain history. Separate experiments should begin from a clean database:

```bash
pnpm db:reset:bench
```

Do not reset between rounds. Doing so removes the retained-history effect the benchmark is intended to observe.

## Current missing scenarios

The research plan requires more than the existing sustained success path. Future benchmark suites should add:

- empty queue followed by burst enqueue;
- large ready backlog;
- large future schedule and bounded promotion;
- many concurrent worker connections;
- frequent heartbeats;
- crash and expiry at every transition boundary;
- a deliberately held old transaction or replication horizon;
- concurrent health/dashboard-style reads;
- history partition retirement timing and lock impact;
- a separate PgQue reference run;
- semantics-equivalent conventional retry, lease, and event history.

Until these exist, the harness validates mechanics and produces development evidence. It does not satisfy the final commercial build gate.

## Troubleshooting

### Override points at the wrong database

Use the benchmark-specific variable and preserve the `_bench` suffix:

```bash
export IRONSHIFT_BENCH_DATABASE_URL=postgres://ironshift:ironshift@localhost:5432/custom_bench
```

### Reset refuses the database

The benchmark database name must end in `_bench`. The reset command additionally requires the purpose to match that suffix. Remote resets also require `IRONSHIFT_ALLOW_REMOTE_RESET=1`. These guards are intentional.

### Permission denied for `pg_current_wal_lsn` or statistics

Run with a local development role that can read the required PostgreSQL statistics. Do not broaden production permissions merely to run this validation harness.

### `actual_rows` is zero

Make sure the schema is current with `pnpm db:reset:bench`, use at least one job, and check whether the claim predicate or queue name changed.

### Results vary between runs

Warm caches, checkpoints, autovacuum, CPU frequency, other database clients, and storage contention all affect small samples. Increase workload size, repeat the experiment, retain raw results, and compare distributions and trends rather than one number.
