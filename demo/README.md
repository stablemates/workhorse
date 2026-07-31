# Workhorse demo

This is the end-to-end product demo for Workhorse. It lets you create live jobs, watch workers process
them, inspect retries and terminal failures, and observe recurring work and queue health from the
operator dashboard.

The demo application uses Hono and Drizzle to exercise both integration packages in a realistic setup.
An order and its durable job are committed in one Drizzle transaction, two Hono-managed workers process
the queue, and worker-owned in-process scheduling drives recurring work. Those frameworks support the demo;
Workhorse's durable execution model is what the demo is designed to show.

The implementation findings and remaining product gaps are recorded in
[`docs/demo-findings.md`](../docs/demo-findings.md).

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
Startup seeds one successful transactional order, one checkpointed recoverable retry, one terminal failure, and one
future scheduled job, so Tasks, Schedules, Workers, and System Health are useful immediately. Use the
dashboard's **enqueue test job** menu to create fresh success, retry, failure, and 20-second long-running
paths, then open a task to inspect its payload, durable checkpoints, and immutable attempt history. The long-running case gives
the Running and Workers views enough time to show an active lease. Set `SEED_DEMO_DATA=false` to start
empty instead. The versioned seed marker makes direct application restarts idempotent.

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
`succeeded` attempt history alongside it.

Create a terminal failure for the Failures view:

```bash
curl --fail-with-body --request POST http://workhorse.localhost:43155/demo/failures
```

This job has one allowed attempt, so the worker records an immutable failed outcome that appears in the
Jobs discarded tab and PostgreSQL health data.

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

The browser does not poll job rows. It receives Server-Sent Event invalidation hints from local
enqueue and worker activity plus PostgreSQL's `workhorse_jobs` notification channel, coalesces bursts,
then refreshes only the active page through its dedicated oRPC reader. Task filtering and pagination
happen in PostgreSQL, so the client never downloads the full task list. A 15-second SSE safety hint
covers transitions that do not currently emit a PostgreSQL notification and connection loss without
treating notifications as truth.

The reusable `createDemoApplication` boundary remains read-only by default. The one-command local demo
injects a deliberately narrow writable operator that can enqueue test jobs and enable or disable its
heartbeat schedule. Every action records actor, reason, request ID, timestamp, target, before/after
state, and status in `public.workhorse_demo_audit`. Cancellation, redrive, and arbitrary schedule
editing remain unavailable.

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
