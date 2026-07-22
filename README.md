# Ironshift validation MVP

Ironshift is a PostgreSQL-native durable execution protocol with deploy-synchronized recurring jobs, fenced ownership, immutable history, and a live-only dispatch relation.

The current implementation remains an evidence-first validation release rather than a production-support promise. Its purpose is to validate transactional enqueue, declarative pg_cron scheduling, fenced ownership, immutable attempt history, failure recovery, PostgreSQL diagnostics, and long-run churn behavior.

## Documentation

- [`TODO.md`](TODO.md): prioritized, dependency-aware roadmap for future feature development.
- [`docs/architecture.md`](docs/architecture.md): system boundaries, module ownership, data model, field-by-field database and API dictionaries, lifecycle, transactions, fencing, crash semantics, health model, and invariants.
- [`docs/features.md`](docs/features.md): authoritative Supported, Partial, and Not Supported feature matrix.
- [`docs/mvp-protocol.md`](docs/mvp-protocol.md): concise table and SQL transition reference.
- [`docs/benchmarking.md`](docs/benchmarking.md): exact benchmark commands, scale ladder, JSON interpretation, environment capture, limitations, and troubleshooting.
- [`docs/pg-cron-requirements.md`](docs/pg-cron-requirements.md): administrator grants, executable preflight, provider compatibility, authentication, capacity, and retention.

## Included scope

- enqueue inside an existing `pg` transaction;
- one live-only runtime relation with selective ready, scheduled, and expired-lease indexes;
- `FOR UPDATE SKIP LOCKED` claims with monotonically increasing fence tokens;
- fenced heartbeat, completion, retry, and expired-lease recovery;
- append-only, time-partitioned lifecycle events and finalized attempts;
- namespaced declarative recurring jobs synchronized into pg_cron during deployment;
- centralized pg_cron promotion and lease recovery outside the worker claim path;
- a single TypeScript `pg` client and worker runtime;
- deterministic worker crash failpoints;
- a JSON PostgreSQL queue-health command;
- a reproducible conventional-table versus live-runtime benchmark.

Explicitly excluded: workflows, UI, ORM/framework adapters, RBAC, cancellation, rate limits, concurrency policies, signals, child jobs, arbitrary scheduled SQL, and unsupported performance claims.

## Development

Requirements: Node.js 22+, pnpm, PostgreSQL 15+, and pg_cron 1.6+ installed in the cluster's `postgres` database.

pg_cron must be preloaded and configured by a database administrator. Exact provider controls differ, but a self-hosted setup is equivalent to:

```sql
-- Set shared_preload_libraries = 'pg_cron' and cron.database_name = 'postgres', then restart.
\c postgres
CREATE EXTENSION IF NOT EXISTS pg_cron;
GRANT USAGE ON SCHEMA cron TO ironshift;
GRANT SELECT ON cron.job, cron.job_run_details TO ironshift;
GRANT EXECUTE ON FUNCTION
  cron.schedule_in_database(text, text, text, text, text, boolean) TO ironshift;
GRANT EXECUTE ON FUNCTION cron.unschedule(bigint) TO ironshift;
```

The target and metadata pools must use the same deployment role. That role also needs `CONNECT` to the target database and normal access to the installed `ironshift` schema. pg_cron must be able to authenticate as that role when it connects to the target database. When `cron.use_background_workers` is disabled, configure PostgreSQL host authentication and a password source such as `.pgpass`; when it is enabled, size `max_worker_processes` for `cron.max_running_jobs`. Keep serverless database compute active or schedules will pause while it is suspended. Use UTC for `cron.timezone` unless every schedule deliberately follows another cluster-wide timezone. Configure operator-owned retention for `cron.job_run_details`; Ironshift reads that history but does not delete cluster-wide pg_cron records.

```bash
pnpm install
pnpm pg-cron:check
pnpm db:reset:all
pnpm check
```

Local tooling keeps three databases separate:

| Database          | Purpose                                      | Commands                                |
| ----------------- | -------------------------------------------- | --------------------------------------- |
| `ironshift_dev`   | Manual development and `pnpm health`         | `pnpm db:reset` or `pnpm db:reset:dev`  |
| `ironshift_test`  | Automated integration tests only             | `pnpm db:reset:test`, `pnpm test`       |
| `ironshift_bench` | Destructive benchmark runs and their history | `pnpm db:reset:bench`, `pnpm benchmark` |

`pnpm db:reset:all` unschedules Ironshift-owned pg_cron entries, recreates all three databases, and installs canonical `sql/schema.sql`. Run it after every schema change. Each destructive command verifies its purpose-specific `_dev`, `_test`, or `_bench` suffix, requires confirmation internally, and refuses remote hosts unless `IRONSHIFT_ALLOW_REMOTE_RESET=1` is deliberately set.

The defaults use the local `ironshift` role. Override them independently with `IRONSHIFT_DEV_DATABASE_URL`, `IRONSHIFT_TEST_DATABASE_URL`, and `IRONSHIFT_BENCH_DATABASE_URL`. Purpose-specific reset, test, and benchmark workflows intentionally ignore generic `DATABASE_URL`, which remains the application runtime connection string and is accepted by the packaged health CLI.

`pnpm pg-cron:check` schedules a temporary `SELECT 1` in the target database and waits for the daemon result, so `ready: true` proves grants plus target authentication and execution. Use `-- --database test` or `bench` for an isolated local target, or set `DATABASE_URL` and `CRON_DATABASE_URL` for a deployed environment.

## Minimal usage

```ts
import { Pool } from "pg";
import { installSchema, PgCronScheduler, Queue, Worker } from "ironshift";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Use the same deployment role against the cluster's configured pg_cron metadata database.
const cronPool = new Pool({ connectionString: process.env.CRON_DATABASE_URL });
await installSchema(pool);

// Run this during every deployment. Only this namespace's removed entries are pruned.
const scheduler = new PgCronScheduler(pool, cronPool, { namespace: "billing-production" });
await scheduler.sync([
  {
    name: "daily-invoices",
    schedule: "0 6 * * *",
    job: {
      type: "generate-invoices",
      queue: "billing",
      payload: { scope: "daily" },
      maxAttempts: 5,
    },
  },
]);

const queue = new Queue(pool);
await queue.enqueue("email", { to: "person@example.com" }, { maxAttempts: 3 });

const worker = new Worker(queue, { workerId: "email-1" }).handle("email", async ({ to }) => {
  // External effects remain at least once. Use a provider idempotency key.
  return { deliveredTo: to };
});

await worker.runOnce();
```

To enqueue atomically with application writes, pass the active `PoolClient` as the fourth argument to `enqueue`.

`scheduler.sync()` also installs one bounded maintenance job, every second by default, for due-job promotion, expired-lease recovery, and deletion of at most 10,000 occurrence keys older than 30 days. Workers therefore default to external maintenance and do not pay those two database round trips before every claim. Deployments without pg_cron can explicitly use `new Worker(queue, { maintenance: "worker" })` as a portability fallback.

Definitions contain typed Ironshift jobs rather than arbitrary SQL. pg_cron stores only revision-fenced calls to stable `ironshift.fire_schedule_v1` and `ironshift.maintain_v1` functions. Schedule names are stable deployment identities; synchronization updates changed definitions, disables omitted definitions, and prunes only pg_cron jobs owned by the same target database and namespace. A stale cron entry cannot execute a newly committed payload at its old cadence.

## Diagnostics and evidence

```bash
pnpm benchmark -- --help

pnpm health

pnpm db:reset:bench
pnpm benchmark -- --profile smoke --suite all --output benchmark-v3-smoke.json
pnpm benchmark -- --profile default --suite comparative --output benchmark-v3-comparative.json
```

Benchmark suite v3 compares a purpose-built mutable-table protocol implementing the measured lifecycle semantics with the live-runtime/cold-outcome design across a seeded shuffled execution plan, alternating paired design order, batched enqueue metrics, paired ratios/differences, fixed-rate equal-load producer-consumer churn, relation-level storage, WAL, vacuum, I/O, activity, and executable claim plans. Its lifecycle suite also asserts scheduled promotion, heartbeat fencing, all worker crash boundaries, lease recovery, retries, monthly history retirement, and explicitly degraded health snapshots. Small runs are smoke tests only. They are not evidence of product superiority. Publication-grade evidence still requires larger retained-history horizons, production-shaped payloads, stable hardware, reference systems, and preserved raw results.

Follow the complete [benchmark runbook](docs/benchmarking.md) before running or interpreting anything beyond a smoke test.

## Correctness contract

- Accepted jobs are durable in PostgreSQL.
- Handlers execute outside database transactions and are **at least once**.
- Only the current unexpired worker/fence pair can heartbeat, complete, or fail an attempt.
- Recovery closes an expired attempt immutably and creates a new attempt.
- A stale worker cannot commit queue completion after recovery.
- PostgreSQL cannot make HTTP calls, emails, payments, or other external effects exactly once. Use stable external idempotency keys, an outbox/inbox, or compensation.

See [`docs/architecture.md`](docs/architecture.md) for the full design and [`docs/mvp-protocol.md`](docs/mvp-protocol.md) for the compact transition reference.

## Competitor baseline

Run the standalone, success-path-only baseline against Ironshift, pg-boss 12.26.2, and Graphile Worker 0.17.3:

```bash
pnpm db:reset:bench
pnpm benchmark:competitors -- --profile smoke --output docs/benchmarks/results/competitor-smoke.json
```

The suite uses isolated schemas and reports native retention differences. It does not claim full semantic equivalence. See [docs/benchmarking.md](docs/benchmarking.md#standalone-competitor-baseline).
