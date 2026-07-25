# Ironshift Hono + Drizzle demo

This example is the first end-to-end application for Ironshift. It combines:

- a Hono HTTP application;
- a Drizzle-owned PostgreSQL pool and application table;
- transactional creation of an order and its durable Ironshift job;
- two named Hono-managed workers that process queued orders;
- an intentional retry flow and optional pg_cron-backed recurring job; and
- complete operational inspection through the dashboard.

The implementation findings and remaining product gaps are recorded in
[`docs/demo-findings.md`](../../docs/demo-findings.md).

Prerequisites are Node.js 22+, pnpm 10+, workspace dependencies installed with `pnpm install`, and
PostgreSQL 15+ with the local `ironshift` role described in the root README. pg_cron is optional unless
you want to run the recurring-job portion.

From the repository root, run the complete demo with one command:

```bash
pnpm demo
```

The command recreates only the purpose-guarded `ironshift_demo` database, builds the runtime packages,
then starts Vite with HMR at `http://localhost:3000/` and a watched Hono process behind its development
proxy. The JSON API index remains available at `http://localhost:3000/api`. Set
`IRONSHIFT_API_PORT` if the default internal Hono port `3001` is unavailable, or
`IRONSHIFT_WORKER_POLL_MS` to override the workers' 15-second idle polling delay.
Startup seeds one successful transactional order, one recoverable retry, one terminal failure, and one
future scheduled job, so the Jobs, Cron, Workers, and Health views are useful immediately. The local
dashboard can also enqueue audited success, retry, and failure jobs. Set `SEED_DEMO_DATA=false` to start
with an empty dashboard instead. The versioned seed marker makes direct application restarts idempotent.

Create an order:

```bash
curl --fail-with-body http://localhost:3000/orders \
  --header 'content-type: application/json' \
  --data '{"customerEmail":"operator@example.com","description":"Ship the demo order"}'
```

The response contains `orderId` and `jobId`. Inspect them with `GET /orders/:orderId` and
`GET /jobs/:jobId`, or inspect queue health with `GET /health`.

Create a job that deliberately fails once, then succeeds on its second attempt:

```bash
curl --fail-with-body --request POST http://localhost:3000/demo/retries
```

The response contains a `jobId`. The job view shows attempt 2 after recovery, while immutable attempt
history records the first `retry` outcome followed by `succeeded`.

Create a terminal failure for the Failures view:

```bash
curl --fail-with-body --request POST http://localhost:3000/demo/failures
```

This job has one allowed attempt, so the worker records an immutable failed outcome that appears in the
Jobs discarded tab and PostgreSQL health data.

Open `http://localhost:3000/tasks` for the Mantine operator dashboard. Its full-width application shell
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
enqueue and worker activity plus PostgreSQL's `ironshift_jobs` notification channel, coalesces bursts,
then refreshes only the active page through its dedicated oRPC reader. Task filtering and pagination
happen in PostgreSQL, so the client never downloads the full task list. A 15-second SSE safety hint
covers transitions that do not currently emit a PostgreSQL notification and connection loss without
treating notifications as truth.

The reusable `createDemoApplication` boundary remains read-only by default. The one-command local demo
injects a deliberately narrow writable operator that can enqueue test jobs and enable or disable its
heartbeat schedule. Every action records actor, reason, request ID, timestamp, target, before/after
state, and status in `public.ironshift_demo_audit`. Cancellation, redrive, and arbitrary schedule
editing remain unavailable.

The local command derives the pg_cron metadata URL by changing the target database name to `postgres`.
Set `CRON_DATABASE_URL` explicitly when the cluster uses another metadata database. The deployment role
must match `DATABASE_URL`:

```bash
CRON_DATABASE_URL=postgresql://ironshift:ironshift@localhost:5432/postgres \
  pnpm --filter @ironshift/example-hono-drizzle start
```

Startup reconciles a namespaced one-minute schedule plus Ironshift's centralized maintenance registration
through `PgCronScheduler`. The Cron view distinguishes the application heartbeat from the system-owned
maintenance loop that promotes due jobs, recovers expired leases, and prunes old occurrence rows. The
heartbeat's audited control reconciles both the durable definition and the underlying pg_cron entry. Jobs
and Workers show each resulting execution. When pg_cron is unavailable, startup warns, keeps worker-owned
maintenance as the fallback, and continues with the rest of the demo.

Dashboard mounting is optional at the application boundary. Pass `{ dashboard: false }` to
`createDemoApplication` to omit both oRPC and SSE routes while retaining Hono order creation,
transactional enqueue, workers, job inspection, and health. The integration suite verifies that the
application order row and accepted Ironshift job have the same PostgreSQL transaction ID.

Set `DATABASE_URL` and `PORT` to override the local defaults. The application installs the current
Ironshift schema and its idempotent demo table at startup. It prefers centralized pg_cron maintenance
and falls back to Ironshift's portable worker-owned maintenance mode when pg_cron is unavailable.
