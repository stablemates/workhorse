# Workhorse demo

This is the end-to-end product demo for Workhorse. It lets you create live jobs, request cooperative cancellation, watch workers process them, inspect retries and terminal failures, and observe recurring work, retention health, and queue health from the operator dashboard.

The demo application uses Hono and Drizzle to exercise both integration packages in a realistic setup.
An order and its durable job are committed in one Drizzle transaction, two Hono-managed workers process
the queue, and worker-owned in-process scheduling drives recurring work. Those frameworks support the demo;
Workhorse's durable execution model is what the demo is designed to show.

The implementation findings and remaining product gaps are recorded in
[`docs/demo-findings.md`](../docs/demo-findings.md).

The demo installs schema version 11, including scoped enqueue idempotency and cooperative cancellation.
It does not add a dedicated idempotency-key seed or dashboard form. Application code using `Queue` or the
Drizzle transaction adapter can opt in to scoped deduplication, while the demo keeps raw keys out of
persistence and its UI and preserves the distinction between enqueue replay and at-least-once effects.

Prerequisites are Node.js 22+, pnpm 10+, workspace dependencies installed with `pnpm install`, and
PostgreSQL 15+ with the local `workhorse` role described in the root README. No PostgreSQL extensions are
required; recurring work runs through the workers themselves.

From the repository root, run the complete demo with one command:

```bash
pnpm demo
```

The command recreates only the purpose-guarded `workhorse_demo` database, builds the runtime packages,
then starts Vite with HMR at `http://workhorse.localhost:43155/` and a watched Hono process behind its
development proxy. The JSON API index remains available at `http://workhorse.localhost:43155/api`.
Each run allocates a free internal Hono port so multiple worktrees can run concurrently. Set
`WORKHORSE_API_PORT` only when an explicit internal port is required, or `WORKHORSE_WORKER_POLL_MS` to
override the workers' 15-second idle polling delay.
Startup seeds one successful transactional order, one named durable timer, fixed, exponential, and
decorrelated-jitter retry examples, one checkpointed recoverable retry, three recoverable multi-step
durable pipelines, three intentionally persistent durable pipelines, one terminal failure, and one future
scheduled job. The durable pipelines cover order fulfillment, customer onboarding, and report publication.
Recoverable examples crash after different checkpoints on attempt 1, then continue without repeating
completed operations. Three representative persistent-failure seeds stop at their configured boundary on
every attempt and never execute a later stage:

- order fulfillment preserves its completed boundary evidence and schedules the next retry from its
  configured fixed policy at about 5 minutes;
- customer onboarding preserves its completed boundary evidence and schedules its next configured
  exponential retry at about 7 minutes;
- report publication preserves its completed boundary evidence and schedules its next configured
  decorrelated-jitter retry at about 10 minutes.

Their immutable checkpoint artifacts and per-attempt failure evidence remain visible between retries in the
existing task drawer. Use the dashboard's **enqueue test job** menu to create fresh success, retry,
durable pipeline, durable timer, failure, and 20-second long-running paths. Durable rows show a violet
**Durable N/M** badge, and their task drawer uses a Mantine Stepper to show saved, running, and pending
restart boundaries. Each new durable operation takes two seconds so progress remains visible. Set
`SEED_DEMO_DATA=false` to start empty instead. The versioned seed marker makes direct application restarts
idempotent.

Create an order:

```bash
curl --fail-with-body http://workhorse.localhost:43155/orders \
  --header 'content-type: application/json' \
  --data '{"customerEmail":"operator@example.com","description":"Ship the demo order"}'
```

The response contains `orderId` and `jobId`. Inspect them with `GET /orders/:orderId` and
`GET /jobs/:jobId`, or inspect queue health with `GET /health`.

Create a job that deliberately fails once, then succeeds on its second attempt:

```bash
curl --fail-with-body --request POST http://workhorse.localhost:43155/demo/retries
```

The response contains a `jobId` and the expected `reserve-capacity` checkpoint name. Attempt 1 stores a
simulated capacity reservation and then fails deliberately. Attempt 2 reuses that exact reservation instead
of running the checkpoint operation again. The task drawer labels the checkpoint
**Persisted across retry**, shows its attempt and worker provenance, and keeps the immutable `retry` then
`succeeded` attempt history alongside it. Retry-policy rows and the drawer show the persisted fixed,
exponential, or decorrelated-jitter configuration. The lifecycle timeline shows PostgreSQL's selected
delay and whether its source was the persisted policy, a manual override, the legacy handler default, or
immediate lease recovery.

These policies are durable job data, not worker callback configuration. PostgreSQL validates them,
selects the delay for handler failure and lease recovery, and records provenance. Decorrelated jitter is
deterministic from job identity, attempt, and persisted previous delay, so refreshing the dashboard or
recreating a `Queue` does not alter the next selection.

Create a four-step order-fulfillment pipeline:

```bash
curl --fail-with-body http://workhorse.localhost:43155/demo/durable \
  --header 'content-type: application/json' \
  --data '{"scenario":"order-fulfillment"}'
```

The response declares the checkpoint plan. `validate-order` and `reserve-inventory` complete on attempt 1,
then the handler crashes deliberately. Attempt 2 reuses both checkpoint values before completing
`authorize-payment` and `arrange-shipment`. The Stepper plan is demo-owned presentation metadata;
Workhorse itself stores only immutable checkpoint evidence. The other supported scenarios are
`customer-onboarding` and `report-publication`.

The drawer treats saved checkpoint values as interim artifacts, not mutable progress. They were already
public, durable schema v11 data and remain unchanged across retries. Fenced, bounded mutable progress is a
separate roadmap feature and is not implied by this inspection view.

Create a publication job that prepares once, releases its lease into a named durable timer, and publishes
after a later claim:

```bash
curl --fail-with-body --request POST http://workhorse.localhost:43155/demo/timers
```

The first activation saves `prepare-publication`, schedules the immutable `publication-delay` wait, and
returns ownership to PostgreSQL without consuming attempt 1. The task row remains scheduled with no active
worker, while retaining the wait name, wake time, and last-held worker provenance. After promotion, a new
claim gets a new fence in the same logical attempt. Handler code restarts, reuses the prepare checkpoint,
replays the named wait, saves `publish-after-wait`, and succeeds. The normal demo uses a ten-second wait so
the Sleeping state remains visible. Its approximately one-second maintenance cadence is only a scheduling
floor; queue pause, downtime, the conservative worker poll, and worker availability can make wake-up later.

This is explicit replay, not stack persistence. Code before the wait runs again unless it is protected by a
checkpoint or application idempotency, and Workhorse does not build a workflow graph from these boundaries.

Create a terminal failure for the Failures view:

```bash
curl --fail-with-body --request POST http://workhorse.localhost:43155/demo/failures
```

This job has one allowed attempt, so the worker records an immutable failed outcome that appears in the
Jobs discarded tab and PostgreSQL health data. Schema v11 already persisted terminal outcomes and JSON
results; selecting a terminal task now exposes its stored result or failure evidence in the existing task
drawer alongside checkpoint outputs and immutable attempt history.

Open `http://workhorse.localhost:43155/tasks` for the Mantine operator dashboard. Its full-width application shell
keeps the header and responsive sidebar in place while browser URLs switch between `/tasks`, `/cron`,
`/system`, and `/workers`. Task filters are nested under Current Tasks and persist as the `filter`
query parameter, with pagination persisted as `page`.

The demo starts `demo-worker-1` and `demo-worker-2`. Worker status is explicit: `busy` owns an active
lease, `recent` completed an attempt during the bounded five-minute observation window, and `idle` is a
configured worker without current or recent work. The global header shows connection state and supports
an explicit refresh. Both workers use a 15-second idle polling delay by default; pass `workerPollMs` to
`createDemoApplication` to override it. Mantine follows the browser's preferred light or dark color
scheme.

Both demo workers retain the `concurrency: 1` default. Core workers may configure an integer from 1 through
100 and expose local `{ concurrency, activeSlots, paused, draining }` state, but the demo's two-worker shape
is for lifecycle visibility and failover behavior, not a measured throughput comparison. Use the
`worker-concurrency` lifecycle benchmark against a `_bench` database for invariant-gated concurrency
evidence, and do not infer performance from the dashboard.

The browser does not poll job rows. It receives Server-Sent Event invalidation hints from local
enqueue and worker activity plus PostgreSQL's `workhorse_jobs` notification channel, coalesces bursts,
then refreshes only the active page through its dedicated oRPC reader. Task filtering and pagination
happen in PostgreSQL, so the client never downloads the full task list. A 15-second SSE safety hint
covers transitions that do not currently emit a PostgreSQL notification and connection loss without
treating notifications as truth.

The System Health integrity panel shows future weekly partition coverage, persisted retention lag,
oldest retained data, fully expired weeks awaiting bounded cleanup, and cumulative rows in the default
history partitions. Retention backlog is shown as degraded because it consumes storage without stopping
dispatch; expired leases, stalled promotion, or missing future partitions remain critical. Demo seeds
intentionally represent a healthy retention state rather than manufacturing time-dependent cleanup
failures.

The reusable `createDemoApplication` boundary remains read-only by default. The one-command local demo
injects a deliberately narrow writable operator that can enqueue test jobs, request cancellation, and
enable or disable its heartbeat schedule. Every action records actor, reason, request ID, timestamp,
target, before/after state, and status in `public.workhorse_demo_audit`. Redrive and arbitrary schedule
editing remain unavailable.

Cancellation is shown as **Cancellation requested** while an active handler still owns the lease and as
**Canceled** only after exact-fence acknowledgement or requested-lease expiry. Ready, future-scheduled,
and durable-wait jobs cancel immediately. The handler receives `CancellationRequestedError` through its
`AbortSignal`; this is cooperative and does not forcibly interrupt JavaScript. The operator attribution is
not authorization, and the demo does not claim exactly-once external effects. Canceling a recurring job
changes only that occurrence, not the schedule or its next fire.

Startup synchronizes a namespaced one-minute heartbeat schedule through `Queue.syncSchedules`, and the
workers evaluate due schedules in-process with advisory-lock coordination and SQL-level occurrence
deduplication. The Cron view distinguishes the application heartbeat from the worker-owned maintenance
loops: a fast tick that promotes due jobs and recovers expired leases, and a slower housekeeping pass
that prunes old occurrence rows and replenishes history partitions. The heartbeat's
audited control updates the durable schedule definition, and Jobs and Workers show each resulting
execution.

Dashboard mounting is optional at the application boundary. Pass `{ dashboard: false }` to
`createDemoApplication` to omit both oRPC and SSE routes while retaining Hono order creation,
transactional enqueue, workers, job inspection, and health. The integration suite verifies that the
application order row and accepted Workhorse job have the same PostgreSQL transaction ID.

Set `DATABASE_URL` and `PORT` to override the local defaults. The application installs the current
Workhorse schema and its idempotent demo table at startup. Maintenance runs through the workers
themselves, so no external scheduler or PostgreSQL extension is required.
