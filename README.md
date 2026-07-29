# Workhorse validation MVP

Workhorse is a PostgreSQL-native durable execution protocol with deploy-synchronized recurring jobs, fenced ownership, immutable history, and a live-only dispatch relation.

The current implementation remains an evidence-first validation release rather than a production-support promise. Its purpose is to validate transactional enqueue, declarative worker-scheduled recurring jobs, fenced ownership, immutable attempt history, failure recovery, PostgreSQL diagnostics, and long-run churn behavior.

## Documentation

- [`TODO.md`](TODO.md): prioritized, dependency-aware roadmap for future feature development.
- [`docs/architecture.md`](docs/architecture.md): system boundaries, module ownership, data model, field-by-field database and API dictionaries, lifecycle, transactions, fencing, crash semantics, health model, and invariants.
- [`docs/features.md`](docs/features.md): authoritative Supported, Partial, and Not Supported feature matrix.
- [`docs/mvp-protocol.md`](docs/mvp-protocol.md): concise table and SQL transition reference.
- [`docs/benchmarking.md`](docs/benchmarking.md): exact benchmark commands, scale ladder, JSON interpretation, environment capture, limitations, and troubleshooting.
- [`docs/demo-findings.md`](docs/demo-findings.md): API, packaging, documentation, and developer-experience gaps found by the end-to-end demo.
- [`demo/README.md`](demo/README.md): interactive Workhorse demo covering transactional enqueue, workers, retries, failures, recurring jobs, and operational inspection.

## Included scope

- enqueue inside an existing `pg` transaction;
- one live-only runtime relation with selective ready, scheduled, and expired-lease indexes;
- `FOR UPDATE SKIP LOCKED` claims with monotonically increasing fence tokens;
- fenced heartbeat, completion, retry, and expired-lease recovery;
- append-only, time-partitioned lifecycle events and finalized attempts;
- namespaced declarative recurring jobs synchronized into the target database during deployment;
- worker-owned in-process cron scheduling with advisory-lock coordination and SQL occurrence deduplication;
- centralized promotion and lease recovery off the worker claim hot path;
- a single TypeScript `pg` client and worker runtime;
- separate `@workhorse/drizzle` and `@workhorse/hono` integration packages;
- an optional read-only React operator dashboard with a typed oRPC boundary;
- deterministic worker crash failpoints;
- a JSON PostgreSQL queue-health command;
- a reproducible conventional-table versus live-runtime benchmark.

Explicitly excluded: workflows, additional ORM/framework adapters, RBAC, mutating operator actions, rate limits, concurrency policies, signals, child jobs, arbitrary scheduled SQL, and unsupported performance claims.

## Development

Requirements: Node.js 22+, pnpm, and PostgreSQL 15+. No PostgreSQL extension is required.

```bash
pnpm install
pnpm db:reset:all
pnpm check
```

Run `pnpm dev` for the demo at `http://workhorse.localhost:43155`. Portless assigns the application port and
automatically prefixes linked worktrees with their branch name, for example
`http://feature-name.workhorse.localhost:43155`. Workhorse keeps Portless state in
`~/.portless-workhorse`, uses plain HTTP on an unprivileged high port, and therefore never needs
`sudo`. The API remains behind Vite on a deterministic worktree-specific internal port.

`pnpm check` finishes by exporting only tracked files to a temporary clean checkout, installing the
frozen lockfile, running `pnpm demo`, and exercising the dashboard snapshot, recurring schedule
synchronization, transactional order, worker, retry, and terminal-failure paths.

Local tooling keeps four databases separate:

| Database          | Purpose                                      | Commands                                |
| ----------------- | -------------------------------------------- | --------------------------------------- |
| `workhorse_dev`   | Manual development and `pnpm health`         | `pnpm db:reset` or `pnpm db:reset:dev`  |
| `workhorse_test`  | Automated integration tests only             | `pnpm db:reset:test`, `pnpm test`       |
| `workhorse_bench` | Destructive benchmark runs and their history | `pnpm db:reset:bench`, `pnpm benchmark` |
| `workhorse_demo`  | Reproducible local demo data                 | `pnpm db:reset:demo`, `pnpm demo`       |

`pnpm db:reset:all` recreates all four databases and installs canonical `sql/schema.sql`. Run it after every schema change. Each destructive command verifies its purpose-specific `_dev`, `_test`, `_bench`, or `_demo` suffix, requires confirmation internally, and refuses remote hosts unless `WORKHORSE_ALLOW_REMOTE_RESET=1` is deliberately set.

The defaults use the local `workhorse` role. Override them independently with `WORKHORSE_DEV_DATABASE_URL`, `WORKHORSE_TEST_DATABASE_URL`, `WORKHORSE_BENCH_DATABASE_URL`, and `WORKHORSE_DEMO_DATABASE_URL`. Purpose-specific destructive reset, test, and benchmark tooling intentionally ignores generic `DATABASE_URL`. Application runtimes may still accept `DATABASE_URL`; the demo otherwise inherits `WORKHORSE_DEMO_DATABASE_URL`.

### Worktrees

Use linked Git worktrees for medium and large features. The Lefthook `post-checkout` hook installs
the frozen lockfile, copies local `.env` files from the primary checkout with mode `0600`, rewrites
all four database URLs with a stable worktree suffix, assigns a unique internal API port, and
provisions the four databases. Portless uses the branch name in the public `.localhost` URL.

Remove a worktree with `pnpm worktree:remove <path>` so its four databases are dropped before Git
removes the checkout. Git has no `post-worktree-remove` hook, so `post-checkout` and `post-merge`
also run `pnpm worktree:prune` to clean registered databases left behind by a manual
`git worktree remove`. Run `pnpm worktree:cleanup` inside a linked worktree only when you want to
drop its databases without removing the checkout.

## Run the demo

After `pnpm install`, the demo needs only PostgreSQL 15+ and the local `workhorse` role described above.
One command safely recreates the purpose-guarded `workhorse_demo` database, builds every workspace
package, installs the application schema, starts the Hono worker, and serves the dashboard:

```bash
pnpm demo
```

Open `http://localhost:3000/`; it redirects to the operator dashboard. The default startup seeds successful, retried, and failed jobs
so the operational views are populated; set `SEED_DEMO_DATA=false` for an empty console. The recurring
heartbeat demonstration runs on the worker's built-in scheduler with no extra infrastructure. See the
demo README for curl requests and connection overrides.

## Minimal usage

```ts
import { Pool } from "pg";
import { installSchema, Queue, Worker } from "@workhorse/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);

const queue = new Queue(pool);

// Run this during every deployment. Omitted names in this namespace are disabled.
await queue.syncSchedules("billing-production", [
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

// Jobs default to 25 total attempts. Override only when this job needs a different budget.
await queue.enqueue("email", { to: "person@example.com" });

const worker = new Worker(queue, {
  workerId: "email-1",
  // This worker also evaluates and fires this namespace's recurring schedules.
  scheduleNamespaces: ["billing-production"],
}).handle("email", async ({ to }) => {
  // External effects remain at least once. Use a provider idempotency key.
  return { deliveredTo: to };
});

await worker.runOnce();
```

To enqueue atomically with application writes, pass the active `PoolClient` as the fourth argument to `enqueue`.

### Drizzle and Hono packages

`@workhorse/drizzle` adapts node-postgres Drizzle databases and caller-owned transactions without
adding Drizzle to the core package:

```ts
import { createDrizzleAdapter } from "@workhorse/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle({ client: pool });
const workhorse = createDrizzleAdapter(db);

await db.transaction(async (tx) => {
  await tx.insert(account).values({ id: accountId });
  await workhorse.forTransaction(tx).enqueue("account.created", { accountId });
});
```

`@workhorse/hono` exposes the queue through typed middleware, starts configured workers once, and
provides a Node server handle whose idempotent shutdown stops new claims, drains in-flight handlers
and requests, then closes explicitly provider-owned resources. See the package READMEs for complete
configuration and ownership behavior.

Workers own scheduling and maintenance in process, the same model good_job, pg-boss, and Oban use on plain PostgreSQL, split across two cadences. A fast tick (`workhorse.tick_v1`, once per second by default) promotes due jobs and recovers expired leases, and also drives in-process schedule evaluation. A slower housekeeping pass (`workhorse.housekeep_v1`, once per minute by default) replenishes history partitions and deletes at most 10,000 occurrence keys older than 30 days, so slow cleanup can never delay dispatch. Transaction-scoped advisory locks inside `tick_v1`, `housekeep_v1`, and `workhorse.fire_schedule_v1` make concurrent passes from other workers cheap no-ops, so running many workers neither duplicates schedules nor multiplies maintenance load, and any surviving worker keeps schedules firing. Both entry points return per-phase telemetry `(phase, rows_affected, duration_ms, skipped_lock, error)`, exposed through `worker.maintenanceTelemetry()` and the `onMaintenance` callback.

Handler failures use SQL-owned, Sidekiq-inspired retry scheduling. For zero-based retry count `count` (the first failed attempt is `0`), the delay is `(count ** 4) + 15 + floor(random() * 10) * (count + 1)` seconds. The default 25-attempt budget spreads retries across roughly 20 days. Keeping the calculation in `fail_v1` gives every client the same durable protocol; `WorkerOptions.retryDelayMs` remains an explicit override, including `0` for an immediate retry.

Definitions contain typed Workhorse jobs rather than arbitrary SQL. Workers parse cron expressions in process and call revision-fenced `workhorse.fire_schedule_v1` with the planned occurrence second, which a durable `schedule_occurrence` key deduplicates in SQL. Schedule names are stable deployment identities; synchronization updates changed definitions and disables omitted definitions atomically in the target database. A stale definition revision cannot execute a newly committed payload at its old cadence.

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

Run the standalone, success-path-only baseline against Workhorse, pg-boss 12.26.2, and Graphile Worker 0.17.3:

```bash
pnpm db:reset:bench
pnpm benchmark:competitors -- --profile smoke --output docs/benchmarks/results/competitor-smoke.json
```

The suite uses isolated schemas and reports native retention differences. It does not claim full semantic equivalence. See [docs/benchmarking.md](docs/benchmarking.md#standalone-competitor-baseline).
