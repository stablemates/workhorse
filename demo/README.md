# Workhorse demo

This is the end-to-end product demo for Workhorse. It lets you create test jobs from the operator dashboard, request cooperative cancellation, watch workers process them, inspect retries and terminal failures, and observe recurring work, retention health, and queue health.

The demo application uses Hono and Drizzle to exercise both integration packages in a realistic setup.
Seed data includes a transactionally created order and durable job, two Hono-managed workers process
the queue, and worker-owned in-process scheduling drives recurring work. Those frameworks support the demo;
Workhorse's durable execution model is what the demo is designed to show.

The demo imports the complete admin application from the publishable packages. `@workhorse/hono`
mounts `@workhorse/dashboard` at `/`, including its oRPC API and event endpoint. Development serves
dashboard source through Vite, while production serves the packaged browser assets. The demo contributes
only demo-owned workers, controllers, projections, and seed data.

The implementation findings and remaining product gaps are recorded in
[`docs/demo-findings.md`](../docs/demo-findings.md).

The demo installs schema version 12, including daily retained history, split scheduled maintenance, scoped enqueue idempotency, and cooperative cancellation.
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

The command recreates only the purpose-guarded `workhorse_demo` database, compiles the server-side runtime
packages, then starts a watched Hono API and a Vite development frontend at
`http://workhorse.localhost:43155/`. Vite serves `@workhorse/dashboard` directly from source with React
development metadata, HMR, source maps, and the demo-owned React Grab module. It does not run a production
dashboard bundle first. The Hono API is mounted at `/`; the demo intentionally exposes no ad hoc public job
API. The previous `/workhorse/*` URLs redirect to the equivalent root routes. Set
`WORKHORSE_WORKER_POLL_MS` to override the workers' 15-second idle polling delay. Each development run
allocates a free private Hono API port. Set `WORKHORSE_API_PORT` to a positive value only when a fixed
internal port is required; `0` or an omitted value requests automatic allocation.
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
durable pipeline, durable timer, failure, and 20-second long-running paths. The dedicated Steps column shows
**N/M** for durable rows, and their task drawer uses a Mantine Stepper to show saved, running, and pending
restart boundaries. Each new durable operation takes two seconds so progress remains visible. Set
`SEED_DEMO_DATA=false` to start empty instead. The versioned seed marker makes direct application restarts
idempotent.

Open `http://workhorse.localhost:43155/tasks` for the Mantine operator dashboard. Its full-width
application shell keeps the header and responsive sidebar in place while browser URLs switch between
`/tasks`, `/cron`, `/system`, and `/workers`. Task filters are nested under Current Tasks and persist as
the `filter` query parameter, with pagination persisted as `page`.

The demo starts `demo-worker-1` and `demo-worker-2`. Worker status is explicit: `busy` owns an active
lease, `recent` completed an attempt during the bounded five-minute observation window, and `idle` is a
configured worker without current or recent work. The global header shows connection state and supports
an explicit refresh. Both workers use a 15-second idle polling delay by default; pass `workerPollMs` to
`createDemoApplication` to override it. Mantine follows the browser's preferred light or dark color
scheme.

The demo declares three slots for `demo-worker-1` and one for `demo-worker-2`. Core workers may configure
an integer from 1 through 100 and expose local `{ concurrency, activeSlots, paused, draining }` state, but
the demo's two-worker shape
is for lifecycle visibility and failover behavior, not a measured throughput comparison. Use the
`worker-concurrency` lifecycle benchmark against a `_bench` database for invariant-gated concurrency
evidence, and do not infer performance from the dashboard.

The browser refreshes only the active page through its dedicated oRPC reader on a bounded polling cadence.
The default is 30 seconds, with 5-second, 15-second, 1-minute, 5-minute, and manual-only options. It does
not reload on every worker or PostgreSQL notification, so concurrent job volume cannot directly create a
browser request storm. Task filtering and pagination happen in PostgreSQL, so the client never downloads
the full task list. The mounted event endpoint remains available for a future explicitly coalesced design.

The System Health integrity panel shows future daily partition coverage, persisted retention lag,
oldest retained data, fully expired days awaiting bounded cleanup, and cumulative rows in the default
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

Startup synchronizes a namespaced one-minute heartbeat, a five-minute report, and a one-minute
lightweight long-running schedule through `Queue.syncSchedules`. The workers evaluate due schedules
in-process with advisory-lock coordination and SQL-level occurrence deduplication. The Cron view distinguishes the application heartbeat from four worker-owned maintenance entries: the fast tick, six-hour partition preparation, daily local-03:00 history retention, and five-minute terminal/idempotency cleanup. PostgreSQL stores the global IANA maintenance timezone and task due state. The heartbeat's
audited control updates the durable schedule definition, and Jobs and Workers show each resulting
execution.

Dashboard mounting is optional at the application boundary. Pass `{ dashboard: false }` to
`createDemoApplication` to omit the browser application, oRPC, and event endpoint while retaining the
configured workers. React Grab lives only in the demo development frontend; it is not a dependency or asset
of `@workhorse/dashboard` and is not included in production.

For the deployable production shape, build and start the compiled demo explicitly:

```bash
pnpm demo:production
```

That path creates the optimized dashboard bundle and serves it from Hono without Vite, HMR, or React Grab.
It does not reset the database, which makes it suitable as the basis for future public deployment work.

Set `DATABASE_URL` and `PORT` to override the local defaults. The application installs the current
Workhorse schema and its idempotent demo table at startup. Maintenance runs through the workers
themselves, so no external scheduler or PostgreSQL extension is required.
