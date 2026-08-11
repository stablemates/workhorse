# Workhorse validation MVP

Workhorse is a PostgreSQL-native durable execution protocol with deploy-synchronized recurring jobs, fenced ownership, cooperative cancellation, PostgreSQL-owned deadlines and execution timeouts, immutable dead letters with audited redrive, immutable history, and a live-only dispatch relation.

The current implementation remains an evidence-first validation release rather than a production-support promise. Its purpose is to validate transactional enqueue, declarative worker-scheduled recurring jobs, fenced ownership, cooperative cancellation, immutable attempt history, durable checkpoint replay, lease-releasing timer waits, attribution-safe automated retention, failure recovery, PostgreSQL diagnostics, and long-run churn behavior.

## Documentation

- [`workhorse.run`](https://workhorse.run): public TypeScript SDK guides, API reference, integrations, examples, and live-demo entry point.
- [`TODO.md`](TODO.md): prioritized, dependency-aware roadmap for future feature development.
- [`docs/architecture.md`](docs/architecture.md): system boundaries, module ownership, data model, field-by-field database and API dictionaries, lifecycle, transactions, fencing, crash semantics, health model, and invariants.
- [`docs/features.md`](docs/features.md): authoritative Supported, Partial, and Not Supported feature matrix.
- [`docs/compatibility.md`](docs/compatibility.md): supported Node.js and PostgreSQL versions, schema and protocol compatibility guarantees, release and provenance process, and why the support boundary is not the benchmark boundary.
- [`CHANGELOG.md`](CHANGELOG.md): released versions, the schema version each requires, and upgrade notes.
- [`docs/mvp-protocol.md`](docs/mvp-protocol.md): concise table and SQL transition reference.
- [`docs/benchmarking.md`](docs/benchmarking.md): exact benchmark commands, scale ladder, JSON interpretation, environment capture, limitations, and troubleshooting.
- [`docs/worker-processes.md`](docs/worker-processes.md): dedicated production worker CLI, signal and drain semantics, probes, deployment examples, concurrency findings, and topology guidance.
- [`docs/rolling-statistics.md`](docs/rolling-statistics.md): per-minute operator aggregates, bucket schema and grain semantics, the rollup watermark and its retention interlock, the stitched read path, mergeable wait histograms, and current limits.
- [`docs/demo-findings.md`](docs/demo-findings.md): API, packaging, documentation, and developer-experience gaps found by the end-to-end demo.
- [`demo/README.md`](demo/README.md): interactive Workhorse demo covering transactional enqueue, workers, retries, failures, recurring jobs, and operational inspection.
- [`docs/decisions/0009-enqueue-idempotency-keys.md`](docs/decisions/0009-enqueue-idempotency-keys.md): scoped enqueue-key ownership, request equivalence, safe diagnostics, expiry, and cleanup.
- [`docs/decisions/0010-cooperative-job-cancellation.md`](docs/decisions/0010-cooperative-job-cancellation.md): cooperative delivery, exact-fence acknowledgement, race ownership, truthful history, recurring behavior, and non-goals.
- [`docs/decisions/0017-durable-worker-registry.md`](docs/decisions/0017-durable-worker-registry.md): fleet registration, split row ownership, process-scoped operator pause, identity versus placement, and non-goals.
- [`docs/decisions/0018-framework-neutral-dashboard-host.md`](docs/decisions/0018-framework-neutral-dashboard-host.md): the `Request`/`Response` dashboard host, Node bridge, one HTML contract, single-origin development, and why the mount takes a connection rather than a URL.
- [`docs/decisions/0019-derived-rolling-statistics.md`](docs/decisions/0019-derived-rolling-statistics.md): why operator statistics are derived from history rather than counted on the dispatch path, one bucket definition evaluated two ways, idempotent recomputation, the retention interlock, and bounded dimensions.
- [`docs/decisions/0020-database-authoritative-configuration.md`](docs/decisions/0020-database-authoritative-configuration.md): why the database rather than the last deploy owns policy, seed-versus-assert sync semantics, per-setting provenance, the database/process boundary, and what an operator settings surface owes its reader.

Run the Fumadocs site locally without PostgreSQL:

```bash
pnpm install
pnpm docs:dev
```

The site listens on `http://localhost:3000`. Run `pnpm demo` separately when you also want the live operator demo; set `NEXT_PUBLIC_WORKHORSE_DEMO_URL` for a custom demo origin.

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
- fenced latest-value progress updates with 64 KiB values, ten changed writes per second per
  ownership generation, revision provenance, lookup, timeline telemetry, and dashboard inspection;
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
- absolute enqueue deadlines plus cooperative, fenced per-attempt execution timeouts;
- cursor-based dead-letter queries plus idempotent single and bounded bulk redrive with dry-run and
  retained lineage;
- cursor-based cross-state job listing on a dedicated operator projection, with payload omission,
  top-level redaction, byte bounds, and merged lifecycle timelines;
- a durable worker registry that discovers the live fleet, reports declared concurrency, slot use,
  and draining, and carries cooperative operator pause to workers in any process;
- separate Drizzle, Prisma, TypeORM, and Kysely integration packages;
- a separately packaged `@workhorse/dashboard` React operator dashboard with a framework-neutral
  request host, a Connect-style Node bridge, an injected transport-neutral client boundary,
  package-owned styles/assets, and audited local controls;
- `workhorse init` project scaffolding, `workhorse schema install`/`status`, and a standalone
  `workhorse dashboard` console for any Workhorse database;
- deterministic worker crash failpoints;
- a JSON PostgreSQL queue-health command;
- a reproducible conventional-table versus live-runtime benchmark.

Explicitly excluded: workflows, additional ORM adapters, framework integration packages, production authentication and RBAC, cross-queue concurrency policies, general-purpose signals, child jobs, arbitrary scheduled SQL, forced handler interruption, exactly-once external effects, and unsupported performance claims.

Checkpoint outputs remain immutable restart evidence. Mutable progress is stored separately and never
changes the accepted payload, checkpoint outputs, or terminal result.

### Cooperative cancellation

Schema version 11 adds `Queue.cancel(jobId, { requestedBy?, reason? })`. Ready, future-scheduled,
and durable-wait jobs become terminal `canceled` immediately. Active jobs retain their fenced lease
and record one cancellation request. `heartbeat_v2` returns `accepted`, `cancel_requested`, `deadline_exceeded`, `timeout_exceeded`, or `stale`;
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

### Dead letters and redrive

Schema version 14 keeps terminal failures in the cold `job_outcome` relation and exposes them through
`Queue.listDeadLetters()`. Stable `(finishedAt, jobId)` cursors support bounded pages filtered by queue,
type, required tags, error name, and completion window. The partial failure index is separate from every
ready, scheduled, active, and expiry dispatch index.

`Queue.redrive()` creates a new ready job linked to the failed source. It copies queue, type, payload,
tags, retry policy, attempt budget, and per-attempt execution timeout, while clearing the old absolute
deadline and never copying checkpoints, waits, attempts, result, or cancellation state. The source
outcome's semantic terminal evidence remains immutable; only its existing retention watermark may
advance when the append-only redrive event is recorded.

```ts
const page = await queue.listDeadLetters({ queue: "billing", errorName: "CardDeclined" });
const source = page.items[0];
if (source) {
  await queue.redrive(source.jobId, {
    requestedBy: "operator@example.com",
    reason: "provider incident resolved",
    requestId: "incident-2026-08-03:billing-redrive",
  });
}
```

Every redrive requires actor, reason, and request identity. The raw request ID is never persisted.
An exact source/request replay returns the original target; a materially different replay raises
`RedriveIdempotencyConflictError`. `Queue.redriveMany()` returns `{ results, nextCursor }` for at most
1,000 oldest matching failures. Pass `nextCursor` back as `options.cursor` to advance a large backlog;
repeating the same cursor and request replays that exact page. `{ dryRun: true }` returns eligible
sources without writes. Redrive is
another at-least-once execution and can repeat external effects, so handlers still need provider
idempotency or compensation. `Queue.getRedriveLineage()` returns bounded retained edges and reports
whether traversal was truncated.

### Payload contracts

The third `Queue` constructor argument accepts versioned contracts per job type. A contract can
validate payloads before enqueue, validate handler results before completion, override durable JSON
size ceilings, and name top-level fields that operator reads must remove.

```ts
const queue = new Queue(pool, "default", {
  contracts: {
    "mail.send": {
      currentVersion: "mail-current",
      versions: {
        "mail-current": {
          validatePayload: (value) =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof value.recipient === "string",
          sensitivePayloadKeys: ["accessToken"],
        },
      },
    },
  },
});
```

Each job stores its accepted version, limits, and redaction keys. Keep old versions configured while
old jobs can still run or be redriven; reads remain available without running historical validators.

### Job listing and lifecycle timelines

Schema version 15 adds `Queue.listJobs()` over a dedicated `job_query` projection. Operator reads use
separate global, queue, type, and state creation-time indexes instead of broadening ready, scheduled,
active, deadline, timeout, or recovery indexes. Pages are ordered by immutable `(createdAt, jobId)` and
return a cursor bound to the filter and payload projection that produced it.

```ts
const page = await queue.listJobs({
  queue: "billing",
  states: ["active", "failed"],
  createdAfter: new Date("2026-08-01T00:00:00Z"),
  payload: {
    include: true,
    maxBytes: 16_384,
    redactKeys: ["cardNumber", "accessToken"],
  },
});

const timeline = await queue.getJobTimeline(page.items[0]!.id, { limit: 100 });
```

Payload is omitted by default. PostgreSQL applies at most 50 unique top-level redaction keys before
checking the caller's 1-byte through 1-MiB response ceiling. Each row reports `omitted`, `included`, or
`too_large`; an omitted or oversized payload is returned as `null`. Candidate identities are selected
before payload rows are joined, so only the bounded page touches payload storage.

`Queue.getJobTimeline()` merges retained lifecycle events and closed attempts into one latest-first,
cursor-based stream. Pages are capped at 1,000. Listing is intentionally weakly consistent across calls:
new jobs can appear before an existing cursor, and concurrent state changes can change membership in a
filtered later page. Timeline retention is independent, so an existing job may have partial or empty
history. Use `Queue.getJob()` separately when identity existence matters.

### Worker fleet registration

Schema version 17 adds `workhorse.worker_registry`. Every worker announces itself and refreshes its
runtime state on a configurable cadence (`WorkerOptions.registryIntervalMs`, five seconds by
default; set it to `0` to opt out). Ownership is split deliberately: the worker owns the reported
`concurrency`, `active_slots`, and `draining` columns, while PostgreSQL owns the operator-requested
`paused` flag, which the worker reads back on every refresh.

This exists so an operator surface can observe and control a fleet it does not host. Process-local
memory cannot answer "which workers exist" once workers are deployed independently of the web tier.

```ts
const workers = await queue.listWorkers();
await queue.setWorkerPaused("billing-worker-1", true, {
  requestedBy: "operator",
  reason: "rolling deploy",
});
```

Pause is cooperative in exactly the same sense as cancellation. The worker stops claiming when it
next refreshes its registration, any handler already executing runs to completion, and a local
`worker.resume()` cannot override an operator pause that is still in effect. `requestedBy` and
`reason` are bounded audit attribution, never authorization; callers must enforce their own
permission checks.

Pause is **process-scoped**. Each worker announces a fresh instance id, so a restarted or replaced
worker always comes back running and inherits no decision aimed at the process it replaced. This is
deliberate: a pause that outlived deployments would become a forgotten flag that silently idles a
worker weeks later. The durable lever for "stop processing this work" is queue pause, which is keyed
by queue name and unaffected by worker lifecycles.

A worker that stops refreshing is reported offline once its registration goes stale, and is
eventually dropped by `prune_worker_registry_v1`. Graceful shutdown deregisters explicitly. The
registry holds one row per live worker and is never consulted by the claim path, so it cannot affect
dispatch cost.

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

Requirements: Node.js **>= 22**, pnpm, and PostgreSQL **15 or newer**. No PostgreSQL extension is
required. CI runs the full suite against every combination of Node.js 22, 24 and PostgreSQL 15, 16,
17, 18; see [`docs/compatibility.md`](docs/compatibility.md) for what that support boundary does and
does not promise.

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
schema, builds the development runtime artifacts, starts the Hono server, starts **three dedicated
worker processes**, and serves `@workhorse/dashboard` from source through Vite:

```bash
pnpm demo
```

The demo deliberately runs each worker in its own process. The server and workers share nothing but
PostgreSQL: the workers
announce themselves in `workhorse.worker_registry`, and the dashboard reads the fleet from there on
a bounded polling interval.

Open `http://workhorse.localhost:43155/tasks` for the operator dashboard. The standalone demo mounts the
packaged dashboard at `/`; host applications may instead mount the same dashboard below a namespace such
as `/workhorse` through the framework-neutral dashboard host. The default startup seeds successful, retried, and failed jobs so
the operational views are populated. Three durable seeds persistently fail at
configured stage boundaries, never execute later stages, and retry at about 5, 7, and 10 minutes. Their
checkpoint-backed interim artifacts, attempt failures, and eventual terminal result or failure evidence are
inspectable in the existing task drawer. Set `SEED_DEMO_DATA=false` for an empty console. The recurring
heartbeat demonstration runs on the worker's built-in scheduler with no extra infrastructure. See the
demo README for development, production-mode, fixture, and connection overrides.

## Adding Workhorse to an existing project

```bash
# Scaffold a worker configuration. This writes one file and never edits package.json or your routes.
npx workhorse init

# Install the schema into a clean database. Reads --database-url, WORKHORSE_DATABASE_URL, or DATABASE_URL.
npx workhorse schema install
npx workhorse schema status

# Run the workers as their own process.
npx workhorse worker --config workhorse.config.js

# Or just look at the queue, with no application involved.
npx workhorse dashboard --port 3000
```

`workhorse dashboard` serves the operator console as its own process against any Workhorse
database. It binds `127.0.0.1` and is read-only by default, because a standalone server has no
session to authorize against; `--host` and `--allow-mutations` widen that and say so on startup.

`init` detects your ORM and framework from `package.json`, generates a worker configuration, and
prints the dashboard mount for your framework. Nothing about the mount needs to know where the
workers run: they register themselves in PostgreSQL.

Schema installation is clean-database only and refuses to modify an existing schema rather than
pretending to be a migration. Ordered migrations are roadmap item P2-07.

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
  statisticsRetentionDays: 180,
  terminalJobPruneLimit: 1_000,
  historyPartitionsPerPass: 4,
  defaultPartitionRowsPerPass: 10_000,
  occurrenceRowsPerPass: 10_000,
});

// Sync updates application defaults without replacing operator overrides. Infrastructure-as-code
// deployments that must own every value can pass { force: true } as the second argument.

// Jobs default to 25 total attempts. Override only when this job needs a different budget.
await queue.enqueue("email", { to: "person@example.com" });

const worker = new Worker(queue, {
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

Long-running workers use PostgreSQL `LISTEN workhorse_jobs` as a wake hint. Workers backed by the
same node-postgres pool share one dedicated listener connection, route queue-specific notifications
only to matching workers, and all wake for the wildcard emitted by promotion and recovery. A lost
listener reconnects with bounded backoff and prompts an immediate claim after reconnect. Polling
remains authoritative: `run()` defaults to a jittered five-second fallback when listening is
available and 250 milliseconds otherwise, while an explicit `pollMs` sets the fallback base.
`runOnce()` retains its 250-millisecond compatibility cadence because it does not keep a listener
open. `onNotificationError` observes listener failures without making a wake-hint failure fatal.
A pool capped at one connection remains polling-only, because reserving its sole connection would
prevent claims from running.

To enqueue atomically with application writes, pass the active `PoolClient` as the fourth argument to `enqueue`.

Durable waits are not exact-time alarms. The stored target is a not-before boundary; promotion cadence,
queue pause, worker availability, and database downtime can delay the next claim. The default
one-second maintenance cadence makes sub-second durable waits inefficient. Use
`context.sleepUntil(name, date)` for an immutable absolute target.

### Database provider packages

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

`@workhorse/prisma`, `@workhorse/typeorm`, and `@workhorse/kysely` expose the same transaction
boundary through each provider's transaction object. Their workers can use an explicitly supplied
node-postgres pool for notification-assisted dispatch, or poll when no pool is available.

### Mounting the dashboard on any framework

Dashboard behavior lives in a framework-neutral host in `@workhorse/dashboard/server` that takes a
`Request` and returns a `Response`, or `null` when the request is not its own. Fetch-native hosts
(Hono, Next.js route handlers, SvelteKit, Nitro) call `host.handle(request)` directly;
Connect-style hosts (Express, Connect, Fastify via `@fastify/middie`) use `dashboardNodeMiddleware`.

Mounting requires only a database connection. It does not require a worker runtime,
because worker identity and runtime state are read from `workhorse.worker_registry` rather than from
process-local objects. This is what allows the dashboard and the workers to be separate deployments.

Workers own scheduling and maintenance in process, the same model good_job, pg-boss, and Oban use on plain PostgreSQL. A fast tick (`workhorse.tick_v1`, once per second by default) promotes due jobs, recovers expired leases, and drives schedule evaluation. Three slower SQL-owned tasks have independent advisory locks and persisted due state: `prepare_history_partitions_v1` maintains UTC-daily history partitions every six hours, `retain_history_v1` retires event, attempt, and schedule-occurrence history once per local date at or after the configured local time in the configured IANA timezone, and `prune_terminal_storage_v1` removes expired idempotency bindings and safe terminal bundles every five minutes. Clean installation uses 03:00 UTC, but `Queue.syncMaintenancePolicy`, operator overrides, and the dashboard settings page can change both parts of that boundary. Workers poll task eligibility every minute by default, but PostgreSQL decides whether work is due globally, so additional workers produce cheap no-ops rather than multiplying cleanup. Every task returns per-phase telemetry `(phase, rows_affected, duration_ms, skipped_lock, error)`, exposed through `worker.maintenanceTelemetry()` and `onMaintenance`.

Clean installation creates the current UTC day plus three future daily partitions. Retention defaults to 14 days for identity, outcomes, events, attempts, and occurrences, and each window remains configurable through `Queue.syncRetentionPolicy`. Terminal identity deletion is interlocked with a persisted history-retention watermark, so frequent terminal cleanup cannot outrun daily history retirement or late history insertion.

The settings page groups values by ownership. When the host supplies
`DashboardSettingsController`, operators can change the maintenance timezone and daily retention
time, and they can revert those values individually. Retention windows, cleanup limits, and the
partition preparation and terminal cleanup intervals show their effective values, application
defaults, and operator-override status, but they remain read-only because changing them can delete
history or alter internal maintenance behavior. Browser display preferences live in a separate
section because they affect only the current browser. Worker concurrency, lease, heartbeat, and
polling values are reported from live processes but remain read-only because changing them requires
a deployment.

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

For safer rolling deployments, keep ordinary handlers at or below **110 seconds**. Work that can run
longer should be modeled as durable execution: split it into idempotent stages with named checkpoints
and use lease-releasing durable waits between stages. This is deployment guidance rather than a hard
protocol limit; configure execution timeouts and process shutdown grace periods for the environment.

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
