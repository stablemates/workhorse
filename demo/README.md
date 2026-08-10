# Workhorse demo

This is the end-to-end product demo for Workhorse. It lets you create test jobs from the operator dashboard, request cooperative cancellation, watch workers process them, inspect retries and terminal failures, and observe recurring work, retention health, and queue health.

The demo application uses Hono and Drizzle to exercise both integration packages in a realistic setup.
Seed data includes a transactionally created order and durable job, and worker-owned scheduling drives
recurring work. Those frameworks support the demo; Workhorse's durable execution model is what the demo
is designed to show.

**The demo runs its workers as a separate process.** That is the topology the documentation recommends
for production, and running it here means the demo has to actually solve the problem it recommends:
the server and the workers share nothing but PostgreSQL. Workers announce themselves in
`workhorse.worker_registry`, the dashboard reads the fleet from there, and operator pause travels
through SQL. The browser refreshes on a bounded polling interval. Set
`WORKHORSE_DEMO_IN_PROCESS_WORKERS=true` to co-host workers in the server instead, which is the
supported small-application topology and what the integration tests exercise.

The demo imports the complete admin application from the publishable packages. `@workhorse/hono`
mounts `@workhorse/dashboard` at `/`, including its oRPC API. The demo owns no
Vite config, no browser entry, and no React dependency: it is a plain consumer, doing nothing a real
application could not copy. It contributes only demo-owned workers, controllers, projections, and
seed data.

Editing the dashboard UI still works out of the box. In development the demo mounts
`@workhorse/dashboard`'s own Vite middleware, so the single demo URL serves the live-compiled UI
with hot reload while the page itself is assembled by the same packaged host a production consumer
runs. There is no second server, no second port, and no separate command. Production serves the
packaged bundle through that same host, so the two differ only in where modules come from.

`pnpm dashboard:dev` remains available for working on the UI against some other backend, such as a
`workhorse dashboard` console pointed at a different database.

The implementation findings and remaining product gaps are recorded in
[`docs/demo-findings.md`](../docs/demo-findings.md).

The demo installs schema version 17, including daily retained history, split scheduled maintenance,
a dedicated operator query projection with bounded payload controls and merged timelines,
scoped enqueue idempotency, cooperative cancellation, absolute deadlines, and per-attempt execution
timeouts. One deterministic keyed seed exposes deduplication evidence without persisting or displaying
the raw key. The operator menu also retains an explicit idempotent enqueue path.

Prerequisites are Node.js 22+, pnpm 10+, workspace dependencies installed with `pnpm install`, and
PostgreSQL 15+ with the local `workhorse` role described in the root README. No PostgreSQL extensions are
required; recurring work runs through the workers themselves.

The observability demo exports OpenTelemetry logs, traces, and metrics to a local SigNoz collector. Install the
supported SigNoz Foundry CLI, then start SigNoz and the instrumented demo from the repository root:

```bash
curl -fsSL https://signoz.io/foundry.sh | bash
pnpm demo:otel
```

Open SigNoz at `http://signoz.localhost:43155`. The server and worker appear as separate services, while HTTP,
PostgreSQL, Node.js runtime, and Workhorse queue, execution, schedule, maintenance, and fleet telemetry share
the same local OTLP endpoint. Structured logs retain their active trace context, so SigNoz can correlate
handler activity with its trace. The server owns the database-wide metric observations, so queue and worker
gauges are not duplicated by the worker process. `signoz:up` also reconciles the version-controlled
**Workhorse Operations**, **Workhorse Reliability**, and **Workhorse jobs** dashboards. Run
`pnpm signoz:dashboards` to apply dashboard changes without restarting SigNoz. Run
`pnpm signoz:down` to stop the containers without deleting their volumes. Plain `pnpm demo` does not
initialize OpenTelemetry or require SigNoz. The loopback-only local stack uses SigNoz impersonation mode,
so any process on this machine has administrator access to it.

From the repository root, run the complete demo with one command:

```bash
pnpm demo
```

The command recreates only the purpose-guarded `workhorse_demo` database, compiles the server-side runtime
packages, then starts a watched Hono server and a watched dedicated worker process. Everything is served from
`http://workhorse.localhost:43155/`, mounted at `/`; the demo intentionally exposes no ad hoc public job
API. Set `WORKHORSE_WORKER_POLL_MS` to override the workers' 15-second idle polling delay.
Startup also creates a living feature showcase: eight task-visible feature families each contribute three
one-off scenarios and one recurring definition. The 24 scenarios cover ingress and routing, retry policies,
durable checkpoints, durable waits, mutable progress, timing controls, cancellation, and dead letters with
redrive. Each recurring occurrence deterministically selects a success, recovery, cancellation, or terminal
failure variant as appropriate, so the dashboard continues changing while it is open. See
[`docs/demo-feature-coverage.md`](../docs/demo-feature-coverage.md) for the complete mapping and the
operational features intentionally represented outside task rows.

The earlier representative layer still seeds one successful transactional order, one named durable timer, fixed, exponential, and
decorrelated-jitter retry examples, one checkpointed recoverable retry, three recoverable multi-step
durable pipelines, three intentionally persistent durable pipelines, one terminal failure, one future
scheduled job, and three timing examples. The timing examples include a materialized expired deadline,
an active handler that cooperatively reaches a one-second execution timeout, and a future scheduled task
with a later absolute deadline plus a 90-second per-attempt budget. The durable pipelines cover order
fulfillment, customer onboarding, and report publication.
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
existing task drawer. Timing seeds expose deadline and timeout policy in the same drawer, while the
System page shows current deadline pressure. Use the dashboard's **enqueue test job** menu to create fresh success, retry,
durable pipeline, durable timer, failure, and 20-second long-running paths. The dedicated Steps column shows
**N/M** for durable rows, and their task drawer uses a Mantine Stepper to show saved, running, and pending
restart boundaries. Each new durable operation takes two seconds so progress remains visible. Set
`SEED_DEMO_DATA=false` to start empty instead. The versioned seed marker makes direct application restarts
idempotent.

Open `http://workhorse.localhost:43155/tasks` for the Mantine operator dashboard. Its full-width
application shell keeps the header and responsive sidebar in place while browser URLs switch between
`/tasks`, `/cron`, `/system`, and `/workers`. Task filters are nested under Current Tasks and persist as
the `filter` query parameter, with pagination persisted as `page`.

The demo runs **one** worker process hosting **two** workers, one with three execution slots and one
strictly serial. They therefore share a hostname and pid and differ only in their generated identity
— which is exactly why the default id carries a random suffix as well as host and pid. A production
deployment would more often run one worker per replica; the demo packs two into a process so the
fleet view shows heterogeneous capacity without needing two deployments.

Neither worker is **named**. They take the same generated
`<hostname>-<pid>-<random>` identity any deployment gets by default, so the dashboard has to
discover the fleet from PostgreSQL rather than be told about it in advance. The mount passes no
declared worker list at all. Worker status is explicit: `busy` owns an active lease,
`idle` is a registered worker refreshing its registration with no current work, `recent` completed an
attempt during the bounded five-minute observation window without a live registration, and `offline` is
a declared worker that has stopped refreshing. The global header shows connection state and supports an
explicit refresh. Both workers use a 15-second idle polling delay by default; set
`WORKHORSE_WORKER_POLL_MS`, or pass `workerPollMs` to `createDemoApplication` for the in-process
topology. Mantine follows the browser's preferred light or dark color scheme.

Pausing a worker from the dashboard writes to `workhorse.worker_registry` rather than calling a method
on a local object, so it reaches the worker process. Like cancellation it is cooperative: claiming stops
at the worker's next registration refresh and any handler already running finishes.

The demo declares three slots for one worker and one slot for the other. Core workers may configure
an integer from 1 through 100 and publish `{ concurrency, activeSlots, draining }` to the registry, but
the demo's two-worker shape
is for lifecycle visibility and failover behavior, not a measured throughput comparison. Use the
`worker-concurrency` lifecycle benchmark against a `_bench` database for invariant-gated concurrency
evidence, and do not infer performance from the dashboard.

The browser refreshes only the active page through its dedicated oRPC reader on a bounded polling cadence.
The default is 15 seconds, with 5-second, 30-second, 1-minute, 5-minute, and manual-only options. It does
not reload on every worker or PostgreSQL notification, so concurrent job volume cannot directly create a
browser request storm. Task filtering and pagination happen in PostgreSQL, so the client never downloads
the full task list.

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

Startup synchronizes a namespaced one-minute heartbeat, a five-minute report, a one-minute lightweight
long-running schedule, and one one-minute definition for each of the eight feature families through
`Queue.syncSchedules`. The workers evaluate due schedules
in-process with advisory-lock coordination and SQL-level occurrence deduplication. The Cron view distinguishes the application heartbeat from four worker-owned maintenance entries: the fast tick, partition preparation, daily history retention at the configured local time, and terminal/idempotency cleanup. PostgreSQL stores the global IANA maintenance timezone, local retention time, and task due state. The heartbeat's
audited control updates the durable schedule definition, and Jobs and Workers show each resulting
execution.

Dashboard mounting is optional at the application boundary. Pass `{ dashboard: false }` to
`createDemoApplication` to omit the browser application and oRPC endpoint while retaining the
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
