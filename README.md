# Ironshift validation MVP

Ironshift is an evidence-first prototype for the hybrid PostgreSQL durable-job architecture described in [`docs/research/postgres-queue-product-viability-evaluation.md`](docs/research/postgres-queue-product-viability-evaluation.md).

This is deliberately **not** a general-purpose queue product. Its purpose is to validate transactional enqueue, narrow ready/scheduled/lease projections, fenced ownership, immutable attempt history, failure recovery, PostgreSQL diagnostics, and long-run churn behavior.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): system boundaries, module ownership, data model, field-by-field database and API dictionaries, lifecycle, transactions, fencing, crash semantics, health model, and invariants.
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
DATABASE_URL=postgres://ironshift:ironshift@localhost:5432/ironshift_test pnpm db:reset
DATABASE_URL=postgres://ironshift:ironshift@localhost:5432/ironshift_test pnpm check
```

The reset command refuses to touch a database whose name does not end in `_test`. It drops and recreates the dedicated database, then installs the canonical `sql/schema.sql`. Run it after every schema change. The test suite also truncates Ironshift tables, so never point development commands at production.

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

DATABASE_URL=postgres://ironshift:ironshift@localhost:5432/ironshift_test pnpm health

DATABASE_URL=postgres://ironshift:ironshift@localhost:5432/ironshift_test \
  pnpm benchmark -- --jobs 1000 --rounds 3 --output benchmark.json
```

The benchmark retains terminal rows between rounds and reports throughput, p50/p95/p99 claim latency, relation size, estimated dead tuples, WAL bytes, and executable claim plans for both designs. The conventional prototype is currently a success-path baseline, not yet a fully semantics-equivalent lease/recovery implementation. Small runs are smoke tests only. They are not evidence of product superiority. The viability gate requires equivalent semantics, sustained runs at much larger scale, retained history, delayed cleanup horizons, production-shaped payloads, and published raw results.

Follow the complete [benchmark runbook](docs/benchmarking.md) before running or interpreting anything beyond a smoke test.

## Correctness contract

- Accepted jobs are durable in PostgreSQL.
- Handlers execute outside database transactions and are **at least once**.
- Only the current unexpired worker/fence pair can heartbeat, complete, or fail an attempt.
- Recovery closes an expired attempt immutably and creates a new attempt.
- A stale worker cannot commit queue completion after recovery.
- PostgreSQL cannot make HTTP calls, emails, payments, or other external effects exactly once. Use stable external idempotency keys, an outbox/inbox, or compensation.

See [`docs/architecture.md`](docs/architecture.md) for the full design and [`docs/mvp-protocol.md`](docs/mvp-protocol.md) for the compact transition reference.
