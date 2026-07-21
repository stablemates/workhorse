# Ironshift validation MVP

Ironshift is an evidence-first prototype for the hybrid PostgreSQL durable-job architecture described in [`docs/research/postgres-queue-product-viability-evaluation.md`](docs/research/postgres-queue-product-viability-evaluation.md).

This is deliberately **not** a general-purpose queue product. Its purpose is to validate transactional enqueue, narrow ready/scheduled/lease projections, fenced ownership, immutable attempt history, failure recovery, PostgreSQL diagnostics, and long-run churn behavior.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): system boundaries, module ownership, data model, field-by-field database and API dictionaries, lifecycle, transactions, fencing, crash semantics, health model, and invariants.
- [`docs/features.md`](docs/features.md): authoritative Supported, Partial, and Not Supported feature matrix.
- [`docs/mvp-protocol.md`](docs/mvp-protocol.md): concise table and SQL transition reference.
- [`docs/benchmarking.md`](docs/benchmarking.md): exact benchmark commands, scale ladder, JSON interpretation, environment capture, limitations, and troubleshooting.

## Included scope

- enqueue inside an existing `pg` transaction;
- separate ready and scheduled projections;
- `FOR UPDATE SKIP LOCKED` claims with monotonically increasing fence tokens;
- fenced heartbeat, completion, retry, and expired-lease recovery;
- append-only, time-partitioned lifecycle events and finalized attempts;
- a single TypeScript `pg` client and worker runtime;
- deterministic worker crash failpoints;
- a JSON PostgreSQL queue-health command;
- a reproducible conventional-table versus hybrid-projection benchmark.

Explicitly excluded: cron, workflows, UI, ORM/framework adapters, RBAC, cancellation, rate limits, concurrency policies, signals, child jobs, and performance claims.

## Development

Requirements: Node.js 22+, pnpm, and a host PostgreSQL 15+ instance.

```bash
pnpm install
pnpm db:reset:all
pnpm check
```

Local tooling keeps three databases separate:

| Database          | Purpose                                      | Commands                                |
| ----------------- | -------------------------------------------- | --------------------------------------- |
| `ironshift_dev`   | Manual development and `pnpm health`         | `pnpm db:reset` or `pnpm db:reset:dev`  |
| `ironshift_test`  | Automated integration tests only             | `pnpm db:reset:test`, `pnpm test`       |
| `ironshift_bench` | Destructive benchmark runs and their history | `pnpm db:reset:bench`, `pnpm benchmark` |

`pnpm db:reset:all` recreates all three and installs canonical `sql/schema.sql`. Run it after every schema change. Each destructive command verifies its purpose-specific `_dev`, `_test`, or `_bench` suffix, requires confirmation internally, and refuses remote hosts unless `IRONSHIFT_ALLOW_REMOTE_RESET=1` is deliberately set.

The defaults use the local `ironshift` role. Override them independently with `IRONSHIFT_DEV_DATABASE_URL`, `IRONSHIFT_TEST_DATABASE_URL`, and `IRONSHIFT_BENCH_DATABASE_URL`. Purpose-specific reset, test, and benchmark workflows intentionally ignore generic `DATABASE_URL`, which remains the application runtime connection string and is accepted by the packaged health CLI.

## Minimal usage

```ts
import { Pool } from "pg";
import { installSchema, Queue, Worker } from "ironshift";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);

const queue = new Queue(pool);
await queue.enqueue("email", { to: "person@example.com" }, { maxAttempts: 3 });

const worker = new Worker(queue, { workerId: "email-1" }).handle("email", async ({ to }) => {
  // External effects remain at least once. Use a provider idempotency key.
  return { deliveredTo: to };
});

await worker.runOnce();
```

To enqueue atomically with application writes, pass the active `PoolClient` as the fourth argument to `enqueue`.

## Diagnostics and evidence

```bash
pnpm benchmark -- --help

pnpm health

pnpm db:reset:bench
pnpm benchmark -- --profile smoke --suite all --output benchmark-v2-smoke.json
pnpm benchmark -- --profile default --suite comparative --output benchmark-v2-comparative.json
```

Benchmark suite v2 compares a purpose-built mutable-table protocol implementing the measured lifecycle semantics with the hybrid projection design across independent repetitions, Student-t 95% confidence intervals, worker-concurrency sweeps, concurrent producer-consumer churn, relation-level storage, WAL, vacuum, I/O, activity, and executable claim plans. Its lifecycle suite also asserts scheduled promotion, heartbeat fencing, all worker crash boundaries, lease recovery, retries, monthly history retirement, and explicitly degraded health snapshots. Small runs are smoke tests only. They are not evidence of product superiority. Publication-grade evidence still requires larger retained-history horizons, production-shaped payloads, stable hardware, reference systems, and preserved raw results.

Follow the complete [benchmark runbook](docs/benchmarking.md) before running or interpreting anything beyond a smoke test.

## Correctness contract

- Accepted jobs are durable in PostgreSQL.
- Handlers execute outside database transactions and are **at least once**.
- Only the current unexpired worker/fence pair can heartbeat, complete, or fail an attempt.
- Recovery closes an expired attempt immutably and creates a new attempt.
- A stale worker cannot commit queue completion after recovery.
- PostgreSQL cannot make HTTP calls, emails, payments, or other external effects exactly once. Use stable external idempotency keys, an outbox/inbox, or compensation.

See [`docs/architecture.md`](docs/architecture.md) for the full design and [`docs/mvp-protocol.md`](docs/mvp-protocol.md) for the compact transition reference.
