# Workhorse validation MVP

Workhorse is a PostgreSQL-native durable execution protocol with deploy-synchronized recurring jobs, fenced ownership, cooperative cancellation, immutable history, and a live-only dispatch relation.

The current implementation remains an evidence-first validation release rather than a production-support promise. Its purpose is to validate transactional enqueue, declarative worker-scheduled recurring jobs, fenced ownership, cooperative cancellation, immutable attempt history, durable checkpoint replay, lease-releasing timer waits, attribution-safe automated retention, failure recovery, PostgreSQL diagnostics, and long-run churn behavior.

## Documentation

- [`TODO.md`](TODO.md): prioritized, dependency-aware roadmap for future feature development.
- [`docs/architecture.md`](docs/architecture.md): system boundaries, module ownership, data model, field-by-field database and API dictionaries, lifecycle, transactions, fencing, crash semantics, health model, and invariants.
- [`docs/features.md`](docs/features.md): authoritative Supported, Partial, and Not Supported feature matrix.
- [`docs/mvp-protocol.md`](docs/mvp-protocol.md): concise table and SQL transition reference.
- [`docs/benchmarking.md`](docs/benchmarking.md): exact benchmark commands, scale ladder, JSON interpretation, environment capture, limitations, and troubleshooting.
- [`docs/worker-processes.md`](docs/worker-processes.md): dedicated production worker CLI, signal and drain semantics, probes, deployment examples, concurrency findings, and topology guidance.
- [`docs/demo-findings.md`](docs/demo-findings.md): API, packaging, documentation, and developer-experience gaps found by the end-to-end demo.
- [`demo/README.md`](demo/README.md): interactive Workhorse demo covering transactional enqueue, workers, retries, failures, recurring jobs, and operational inspection.
- [`docs/decisions/0009-enqueue-idempotency-keys.md`](docs/decisions/0009-enqueue-idempotency-keys.md): scoped enqueue-key ownership, request equivalence, safe diagnostics, expiry, and cleanup.
- [`docs/decisions/0010-cooperative-job-cancellation.md`](docs/decisions/0010-cooperative-job-cancellation.md): cooperative delivery, exact-fence acknowledgement, race ownership, truthful history, recurring behavior, and non-goals.

## Included scope

- enqueue inside an existing `pg` transaction;
- optional PostgreSQL-owned scoped enqueue idempotency with atomic exact replay and conflict rollback;
- one live-only runtime relation with selective ready, scheduled, and expired-lease indexes;
- `FOR UPDATE SKIP LOCKED` claims with monotonically increasing fence tokens;
- fenced heartbeat, completion, retry, cancellation, and expired-lease recovery;
- optional PostgreSQL-validated fixed, exponential, and decorrelated-jitter retry policies persisted
  with jobs and recurring schedule definitions;
- append-only, time-partitioned lifecycle events and finalized attempts;
- immutable named handler checkpoints that survive retry and are fenced against stale workers;
- persisted terminal outcomes/results and checkpoint-backed interim artifacts inspectable in the existing
  demo task drawer;
- named durable timer waits that release the worker lease and restart in the same logical attempt;
- persisted, bounded retention for terminal jobs, history partitions, fallback rows, and schedule
  occurrences, with live-job and retained-attribution safety guards;
- namespaced declarative recurring jobs synchronized into the target database during deployment;
- worker-owned in-process cron scheduling with advisory-lock coordination and SQL occurrence deduplication;
- centralized promotion and lease recovery off the worker claim hot path;
- a TypeScript `pg` client and worker runtime with configurable per-instance concurrency;
- a dedicated `workhorse worker` process runner with bounded graceful shutdown and optional probes;
- immediate cancellation for queued, scheduled, and durable-wait work plus cooperative requests for
  active handlers;
- separate `@workhorse/drizzle` and `@workhorse/hono` integration packages;
- a separately packaged `@workhorse/dashboard` React operator dashboard with an injected,
  transport-neutral client boundary, package-owned styles/assets, and audited local controls;
- deterministic worker crash failpoints;
- a JSON PostgreSQL queue-health command;
- a reproducible conventional-table versus live-runtime benchmark.

Explicitly excluded: workflows, additional ORM/framework adapters, production authentication and RBAC, rate limits, cross-queue concurrency policies, general-purpose signals, child jobs, arbitrary scheduled SQL, forced handler interruption, exactly-once external effects, and unsupported performance claims.

Checkpoint outputs are immutable evidence, not mutable progress updates. Their task-drawer visibility does
not complete roadmap item **P1-09 Progress and job metadata**.

### Cooperative cancellation

Schema version 11 adds `Queue.cancel(jobId, { requestedBy?, reason? })`. Ready, future-scheduled,
and durable-wait jobs become terminal `canceled` immediately. Active jobs retain their fenced lease
and record one cancellation request. `heartbeat_v2` returns `accepted`, `cancel_requested`, or `stale`;
the worker converts `cancel_requested` into a `CancellationRequestedError` on the handler's
`AbortSignal` and acknowledges only with the exact worker/fence generation. Boolean `heartbeat_v1`
remains available and maps only `accepted` to `true`.

Cancellation is cooperative. JavaScript is not forcibly preempted. A handler should observe its
`AbortSignal`, stop starting new effects, settle promptly, and leave external side effects idempotent.
If it ignores the signal until its lease expires, bounded recovery materializes the requested
cancellation rather than creating another attempt. A canceled outcome is immutable, stale completion,
failure, checkpoint, wait, heartbeat, or acknowledgement writes cannot replace it, and cancellation
races with completion/failure use first-committer-wins ordering.

Never-started jobs have no attempt-history row. A canceled active or previously started durable-wait
attempt has exactly one `canceled` attempt row. Repeated requests return the existing request or outcome
without duplicate terminal rows or events. `requestedBy` is audit attribution, not authorization, so
applications and operator layers must enforce their own permission checks. Canceling a job created by a
recurring schedule affects only that occurrence and does not disable the schedule or later occurrences.

### Enqueue idempotency keys

Schema version 11 accepts `options.idempotency` on `Queue.enqueue()` and each `Queue.enqueueMany()`
request:

```ts
await queue.enqueue(
  "invoice.capture",
  { invoiceId: "inv-1" },
  {
    queue: "billing",
    idempotency: {
      key: "capture:inv-1",
      scope: "tenant-42", // defaults to "default"
      ttlMs: 86_400_000, // defaults to 24 hours
    },
  },
);
```

Keys are unique within their scope while retained. Keys are limited to 512 UTF-8 bytes, scopes to
256 UTF-8 bytes, and TTLs to integer values from 1 millisecond through 365 days. An exact equivalent
replay returns the original job ID without creating another job, event, FIFO placement, or notification.
Material mismatch raises a structured conflict and rolls back the entire enqueue statement or batch.

Equivalence covers queue, type, payload, sorted tags, `maxAttempts`, normalized `retryPolicy`, TTL, and
an explicitly supplied `runAt`. For keyed immediate ingress, omitted `runAt` remains omitted in the
fingerprint rather than being replaced by the current time, so a later retry can replay. Unkeyed enqueue
retains its prior behavior and always creates a new job.

Raw keys are never persisted. `workhorse.enqueue_idempotency` stores the scope plus a full SHA-256 key
hash; events, UI projections, and errors use a bounded preview plus a 12-hex key digest. The initial
`enqueued` event records that safe metadata once, while exact replay emits no event. Expired bindings can
be reused; terminal-storage maintenance removes them before terminal identity pruning, and purging queued
or scheduled jobs releases their bindings.

This deduplicates durable enqueue acceptance only. Handler delivery and external effects remain at least
once and still require provider idempotency, an outbox/inbox, or compensation.

### Persisted retry policies

Schema version 12 accepts an optional `retryPolicy` on enqueue requests and recurring schedule job
definitions:

```ts
type RetryPolicy =
  | { type: "fixed"; delayMs: number }
  | {
      type: "exponential";
      initialDelayMs: number;
      multiplier: number;
      maxDelayMs: number;
    }
  | { type: "decorrelated-jitter"; baseDelayMs: number; maxDelayMs: number };
```

PostgreSQL validates and normalizes the policy, selects each delay, performs the retry or recovery
transition, and records policy provenance. Explicit policies apply equally to handler failure and
expired-lease recovery. Omitting the policy preserves compatibility: handler failure uses the legacy
Sidekiq-inspired random backoff, while lease recovery is immediate. Numeric `Queue.fail` delays and
`WorkerOptions.retryDelayMs` are higher-precedence manual overrides; a callback may return
`undefined` to defer to the persisted policy or compatibility default. An omitted
`Queue.recoverExpired` delay is passed as SQL `NULL` so PostgreSQL can select the persisted policy.

Decorrelated jitter is deterministic from the stable job identity, attempt, and persisted previous
delay, so replay and `Queue` recreation cannot change the selected value. Every delay is an integer
from zero through 365 days, exponential multipliers are integers from 1 through 100, and exponential
or jitter maxima must be at least their initial or base delay. Claims and `JobSnapshot` expose the
persisted policy. `retry_scheduled` and `lease_expired` event details expose `retry_policy`,
`retry_delay_ms`, and `retry_delay_source`.

## Development

Requirements: Node.js 22+, pnpm, and PostgreSQL 15+. No PostgreSQL extension is required.

```bash
pnpm install
pnpm db:reset:all
pnpm check
```

Run `pnpm demo` for the project at `http://workhorse.localhost:43155`. Portless assigns the application port and
automatically prefixes linked worktrees with their branch name, for example
`http://feature-name.workhorse.localhost:43155`. Workhorse keeps Portless state in
`~/.portless-workhorse`, uses plain HTTP on an unprivileged high port, and therefore never needs
`sudo`. The API remains behind Vite on a free internal port allocated separately for every run.

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
all four database URLs with a stable worktree suffix, and provisions the four databases. Portless
uses the branch name in the public `.localhost` URL, while each demo run allocates a free internal
API port.

Remove a worktree with `pnpm worktree:remove <path>` so its four databases are dropped before Git
removes the checkout. Git has no `post-worktree-remove` hook, so `post-checkout` and `post-merge`
also run `pnpm worktree:prune` to clean registered databases left behind by a manual
`git worktree remove`. Run `pnpm worktree:cleanup` inside a linked worktree only when you want to
drop its databases without removing the checkout.

## Run the demo

After `pnpm install`, the demo needs only PostgreSQL 15+ and the local `workhorse` role described above.
One command safely recreates the purpose-guarded `workhorse_demo` database, installs the application
schema, builds the development runtime artifacts, starts the Hono worker, and serves
`@workhorse/dashboard` from source through Vite:

```bash
pnpm demo
```

Open `http://workhorse.localhost:43155/tasks` for the operator dashboard. The standalone demo mounts the
packaged dashboard at `/`; host applications may instead mount the same dashboard below a namespace such
as `/workhorse` through `@workhorse/hono`. The default startup seeds successful, retried, and failed jobs so
the operational views are populated. Three durable seeds persistently fail at
configured stage boundaries, never execute later stages, and retry at about 5, 7, and 10 minutes. Their
checkpoint-backed interim artifacts, attempt failures, and eventual terminal result or failure evidence are
inspectable in the existing task drawer. Set `SEED_DEMO_DATA=false` for an empty console. The recurring
heartbeat demonstration runs on the worker's built-in scheduler with no extra infrastructure. See the
demo README for development, production-mode, fixture, and connection overrides.

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

// Retention is persisted once for the database, so every worker applies the same policy.
// Destructive job/event/attempt retention is disabled by default. These are minimum windows:
// retained attribution or bounded catch-up can keep data longer, never shorter.
await queue.syncRetentionPolicy({
  jobIdentityRetentionDays: 180,
  terminalOutcomeRetentionDays: 90,
  jobEventRetentionDays: 90,
  attemptHistoryRetentionDays: 90,
  scheduleOccurrenceRetentionDays: 30,
  terminalJobPruneLimit: 1_000,
  historyPartitionsPerPass: 4,
  defaultPartitionRowsPerPass: 10_000,
  occurrenceRowsPerPass: 10_000,
});

// Jobs default to 25 total attempts. Override only when this job needs a different budget.
await queue.enqueue("email", { to: "person@example.com" });

const worker = new Worker(queue, {
  workerId: "email-1",
  // Integer 1..100. The default is 1 for backward-compatible serial execution.
  concurrency: 4,
  // This worker also evaluates and fires this namespace's recurring schedules.
  scheduleNamespaces: ["billing-production"],
}).handle("email", async ({ to }, { checkpoint, sleep }) => {
  const delivery = await checkpoint("provider-delivery", async () => {
    // The checkpoint prevents this completed step from running again after a later restart.
    // A crash between the external effect and checkpoint commit is still possible, so the provider
    // call must use a stable idempotency key.
    return { deliveredTo: to };
  });

  // This commits a named PostgreSQL timer, releases the lease and worker slot, and restarts the
  // handler after promotion. The provider checkpoint is replayed rather than executed again.
  await sleep("delivery-observation-window", 60_000);
  return delivery;
});

await worker.runOnce();
```

`worker.concurrency` is readonly. `worker.runtimeState()` returns
`{ concurrency, activeSlots, paused, draining }` for local lifecycle inspection. A claim pass issues
one claim at a time, starts each claimed job in its own handler slot, never claims beyond the configured
bound, and stops filling the pass at the first null claim. Every active job owns its own heartbeat and
fence lifecycle. `pause()` blocks new claims without interrupting active handlers; `resume()` reopens
claims immediately. `stop()` blocks new claims and resolves `run()` only after active handlers drain.
These are process-local controls and observations, not a durable worker registry or a cross-worker rate
limit.

To enqueue atomically with application writes, pass the active `PoolClient` as the fourth argument to `enqueue`.

Durable waits are not exact-time alarms. The stored target is a not-before boundary; promotion cadence,
queue pause, worker availability, and database downtime can delay the next claim. The default
one-second maintenance cadence makes sub-second durable waits inefficient. Use
`context.sleepUntil(name, date)` for an immutable absolute target.

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

Workers own scheduling and maintenance in process, the same model good_job, pg-boss, and Oban use on plain PostgreSQL. A fast tick (`workhorse.tick_v1`, once per second by default) promotes due jobs, recovers expired leases, and drives schedule evaluation. Three slower SQL-owned tasks have independent advisory locks and persisted due state: `prepare_history_partitions_v1` maintains UTC-daily history partitions every six hours, `retain_history_v1` retires event, attempt, and schedule-occurrence history once per local date at or after 03:00 in the configured IANA timezone, and `prune_terminal_storage_v1` removes expired idempotency bindings and safe terminal bundles every five minutes. Workers poll task eligibility every minute by default, but PostgreSQL decides whether work is due globally, so additional workers produce cheap no-ops rather than multiplying cleanup. Every task returns per-phase telemetry `(phase, rows_affected, duration_ms, skipped_lock, error)`, exposed through `worker.maintenanceTelemetry()` and `onMaintenance`.

Clean installation creates the current UTC day plus three future daily partitions. Retention defaults to 14 days for identity, outcomes, events, attempts, and occurrences, and each window remains configurable through `Queue.syncRetentionPolicy`. Terminal identity deletion is interlocked with a persisted history-retention watermark, so frequent terminal cleanup cannot outrun daily history retirement or late history insertion.

Handler failures use SQL-owned, Sidekiq-inspired retry scheduling. For zero-based retry count `count` (the first failed attempt is `0`), the delay is `(count ** 4) + 15 + floor(random() * 10) * (count + 1)` seconds. The default 25-attempt budget spreads retries across roughly 20 days. Keeping the calculation in `fail_v1` gives every client the same durable protocol; `WorkerOptions.retryDelayMs` remains an explicit override, including `0` for an immediate retry or a callback `(attempt, job) => milliseconds | undefined`; returning `undefined` defers to PostgreSQL's persisted policy or compatibility default.

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
- Only that owner can save a checkpoint or schedule a durable wait; both names are immutable and survive handler restarts.
- A durable wait clears active ownership, consumes no retry attempt, and restarts the handler from its entry point after due promotion.
- Code before a wait can execute again. Put completed external or expensive work behind a checkpoint or another idempotency boundary.
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
