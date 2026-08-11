# Dedicated worker processes

Workhorse workers run in dedicated processes. The web tier and worker tier communicate through
PostgreSQL, but they scale, restart, and fail independently.

This document records the worker-concurrency investigation, benchmark findings, process-lifecycle contract, CLI usage, deployment tradeoffs, and remaining limitations.

## Why workers are separate from web servers

A worker and an HTTP application have different scaling and failure boundaries. A dedicated process
keeps job capacity independent of HTTP replica count, isolates handler failures from web ingress,
and gives each worker an explicit PostgreSQL pool, memory budget, and shutdown path.

Prefer one worker per process when you want each worker identity, concurrency budget, and failure
boundary to map directly to an operating-system process or orchestrator replica. A process may still
contain several workers when they intentionally share one lifecycle and resource budget.

The optional Workhorse probe server described below is **not application HTTP ingress**. It serves only liveness and readiness status for an orchestrator.

### Observing and controlling a fleet you do not host

Separating workers from the web tier used to mean the operator dashboard could not see them: it read
runtime state from process-local `Worker` objects, so it only ever knew about workers sharing its
own process.

Schema version 17 removes that constraint. Every worker upserts `workhorse.worker_registry` on its
`registryIntervalMs` cadence with the concurrency it declared, the slots it currently has busy, and
whether it is draining, and reads back the operator-requested pause flag in the same round trip.
A dashboard mounted anywhere reads the fleet from that relation.

This makes worker control cooperative and durable rather than a process-local method call:

- `Queue.setWorkerPaused(workerId, paused, { requestedBy, reason })` commits the request to
  PostgreSQL. The worker stops claiming when it next refreshes, so pause takes effect within roughly
  one `registryIntervalMs`.
- A handler already executing runs to completion. Pause never interrupts work.
- The pause is scoped to the running process, not to the worker name. A restarted or replaced
  worker comes back running, whether or not its id is stable, so a pause can never become a
  forgotten flag that idles a worker after a later deployment. Use queue pause when you need to
  stop work durably.
- A local `worker.resume()` cannot clear an operator pause that is still in effect.
- Reported slot use is only as fresh as the cadence. Treat it as an operational indicator, not as a
  synchronous read of another process's event loop.

The registry holds one row per live worker, is never consulted by the claim path, and cannot affect
dispatch cost. `registryIntervalMs: 0` opts out entirely, at the cost of the worker becoming
invisible to operator surfaces.

The dashboard reads worker state from PostgreSQL on its bounded polling interval, so it does not
observe handlers or depend on worker process notifications.

## Configuration and CLI

Create a configuration module in application code:

```ts
// src/workhorse.worker.ts
import { createWorkhorseAdapter, defineWorkerProcess } from "@workhorse/core";
import { Pool } from "pg";
import { generateReport, sendEmail } from "./jobs.js";

export default defineWorkerProcess({
  adapter() {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (transaction: typeof pool) => transaction,
      close: () => pool.end(),
    });
  },
  workers: [
    {
      options: {
        concurrency: 8,
        scheduleNamespaces: ["production"],
      },
      configure(worker) {
        worker.handle("email.send", sendEmail);
        worker.handle("report.generate", generateReport);
      },
    },
  ],
  shutdownTimeoutMs: 25_000,
  probes: {
    hostname: "0.0.0.0",
    port: 9090,
  },
});
```

Compile the application and run the default export:

```bash
workhorse worker --config ./dist/workhorse.worker.js
```

The packaged CLI imports JavaScript understood by the current Node.js process. It does not bundle a TypeScript loader. Development environments may invoke the source module through their own loader, but production should run compiled application output.

`--shutdown-timeout-ms` overrides the configured deadline:

```bash
workhorse worker \
  --config ./dist/workhorse.worker.js \
  --shutdown-timeout-ms 25000
```

Applications that already own process supervision can use the APIs directly:

- `defineWorkerProcess(definition)` type-checks and returns a configuration.
- `startWorkerProcess(definition)` starts workers without installing global signal handlers.
- `runWorkerProcess(definition, options)` installs the standalone Node process lifecycle.

## Process lifecycle contract

Keep ordinary handlers at or below **110 seconds** for safer rolling deployments. If work can exceed
that duration, split it into durable, idempotent stages with named checkpoints and lease-releasing
waits. A longer shutdown timeout can provide more drain time, but it is not a substitute for durable
boundaries because platforms may still terminate a process at the end of their grace period.

For Kubernetes, set the Pod's `terminationGracePeriodSeconds` to at least 120 seconds when relying on
the 110-second recommendation. Kubernetes defaults this field to 30 seconds and does not document a
120-second maximum. The kubelet normally sends `SIGTERM` and force-kills remaining processes after the
configured grace expires. A `preStop` hook consumes the same budget; an overrun receives only a
one-off two-second extension. Force deletion, node failure, and some eviction or node-shutdown paths
can still shorten or bypass the normal graceful path.

### Startup

1. Validate the definition, timeout, and probe configuration.
2. Create one process-owned adapter.
3. Create and configure every `Worker`.
4. Start the optional probe-only HTTP server.
5. Start every worker run loop.
6. Report readiness only after the workers have started.

A configuration or probe startup failure closes adapter-owned resources and rejects startup. An unexpected resolution or rejection from any worker is fatal to the dedicated process runtime: sibling workers are stopped, all runs settle, resources close, and the CLI exits unsuccessfully.

### First `SIGTERM` or `SIGINT`

The first termination signal:

1. Marks readiness false.
2. Calls `stop()` on every worker.
3. Stops issuing later claim requests.
4. Continues per-job heartbeat loops and waits for active handlers to settle.
5. Closes adapter-owned resources and the probe server after the drain.
6. Exits normally when shutdown succeeds.

A process signal does **not** abort active handler `AbortSignal`s. Handler cancellation remains a durable job-level operation through `Queue.cancel()`. Process shutdown asks active work to finish while preserving its lease.

There is one unavoidable transaction boundary: a claim query already in flight when shutdown begins may commit. That committed job is treated as active work and drained. The guarantee is therefore “no new claim requests after shutdown is observed,” not “no claim can commit after the signal timestamp.”

### Deadline and second signal

The default shutdown deadline is 25 seconds and may be configured from 1 millisecond through 1 hour. Set it below the deployment platform's termination grace period so Node has time to hard-exit before the platform sends `SIGKILL`.

- A second `SIGINT` exits immediately with code 130.
- A second `SIGTERM` exits immediately with code 143.
- A missed graceful-shutdown deadline exits immediately with code 1.
- A fatal worker-loop failure uses the same deadline while sibling workers drain, then exits with code 1 if they do not settle.

A hard exit does not invent a job failure or retry transition. Active leases remain durable PostgreSQL state. Another worker recovers them after lease expiry using the existing fenced recovery protocol. External effects remain at least once, so handlers must retain their normal idempotency strategy.

The deadline exists because JavaScript cannot safely preempt an arbitrary promise or synchronous computation. A handler that never settles can otherwise keep graceful shutdown pending forever.

## Probes

When `probes` is configured, Workhorse starts a small status-only HTTP server:

| Endpoint      | Running | Draining |
| ------------- | ------: | -------: |
| `GET /livez`  |     200 |      200 |
| `GET /readyz` |     200 |      503 |

Both paths are configurable. `HEAD` is supported. Other paths and methods return 404. The default hostname is `127.0.0.1`; bind `0.0.0.0` only when the orchestrator must reach the pod or container network address.

The server does not expose queues, jobs, handlers, application routes, metrics, or mutation APIs. Authentication and TLS should be handled by the deployment network if the listener is exposed beyond a trusted probe network.

## Concurrency findings

`WorkerOptions.concurrency` is the number of async handler executions one `Worker` may own concurrently. It is:

- not an operating-system thread count;
- not a Node worker-thread pool;
- not a process-global limit;
- multiplied by the number of worker instances and process replicas that can claim the same work.

A worker with `concurrency: 8` uses one dispatch coordinator, serial claim queries to fill free slots, and up to eight independently heartbeating handler executions.

The 2026-08-02 lifecycle benchmark produced these relevant results.

### Slot scaling with approximately 120 ms handlers

| Concurrency |   Throughput | Maximum overlap |
| ----------: | -----------: | --------------: |
|           1 |  8.08 jobs/s |               1 |
|           4 | 31.83 jobs/s |               4 |
|           8 | 62.85 jobs/s |               8 |

All 104 benchmark assertions passed. Handler overlap, lease ownership, shutdown, pause behavior, and slot bounds remained correct.

### Equal total capacity of eight slots

For I/O-like handlers, `1×8`, `2×4`, and `8×1` achieved approximately 63 to 64 jobs/s. One eight-slot worker bounded concurrent claim pressure at one query while preserving the same handler overlap. Eight one-slot workers allowed eight simultaneous claim queries without meaningfully improving useful-work throughput.

For immediate no-op handlers, multiple one-slot workers were faster because independent claim coordinators overlapped PostgreSQL round trips. That result measures claim latency more than representative handler capacity and does not justify multiplying pollers for ordinary asynchronous work.

### Topology recommendation

Use one multi-slot `Worker` per distinct queue or policy group inside each process. Add more worker definitions only when they require materially different:

- queue names;
- handler registries;
- lease or heartbeat policies;
- recurring schedule namespaces;
- maintenance behavior;
- retry overrides.

Scale process replicas for availability and aggregate capacity. Do not create one `Worker` per concurrency slot. If extremely short jobs become a primary workload, prototype and benchmark bounded batch claiming or notification-assisted dispatch before changing the coordinator model.

Detailed benchmark artifacts remain in:

- [`benchmarks/results/2026-08-02-worker-concurrency-default.json`](benchmarks/results/2026-08-02-worker-concurrency-default.json)
- [`benchmarks/results/2026-08-02-competitor-native-worker-smoke.json`](benchmarks/results/2026-08-02-competitor-native-worker-smoke.json)
- [`benchmarks/2026-08-02-native-worker-concurrency-analysis.md`](benchmarks/2026-08-02-native-worker-concurrency-analysis.md)

## Deployment examples

### Kubernetes

The platform grace period should exceed the Workhorse deadline:

```yaml
spec:
  terminationGracePeriodSeconds: 35
  containers:
    - name: worker
      command:
        - workhorse
        - worker
        - --config
        - ./dist/workhorse.worker.js
      ports:
        - name: probes
          containerPort: 9090
      readinessProbe:
        httpGet:
          path: /readyz
          port: probes
      livenessProbe:
        httpGet:
          path: /livez
          port: probes
```

A 25-second Workhorse deadline leaves approximately ten seconds before the example platform grace expires. Choose values based on the longest handler drain that the service is willing to wait for.

### systemd

```ini
[Service]
ExecStart=/app/node_modules/.bin/workhorse worker --config /app/dist/workhorse.worker.js
KillSignal=SIGTERM
TimeoutStopSec=35
Restart=on-failure
```

## Operational guidance

- Give every process its own database pool and close it only after workers drain.
- Budget pool capacity across process replicas. Notification-assisted dispatch reserves one shared listener connection per node-postgres pool; claims, heartbeats, handler queries, and maintenance use the remaining pool capacity.
- Keep the process-level deadline below the orchestrator grace period.
- Keep job leases long enough to tolerate normal heartbeat jitter, but short enough to meet recovery objectives after hard termination.
- Treat an unexpected worker-loop failure as process-fatal and let the supervisor restart a clean process.
- Use at least two process replicas when worker availability matters.
- Synchronize recurring schedules during deployment. Workers execute matching synchronized namespaces, but should not be the only place definitions are authored.
- Keep handlers idempotent and cancellation-aware. Graceful process shutdown does not change Workhorse's at-least-once delivery contract.

## Remaining work

The dedicated process lifecycle does not implement:

- OpenTelemetry spans or process metrics;
- handler execution deadlines or forced handler cancellation;
- cross-queue weighted scheduling;
- dynamic configuration reload;
- zero-downtime handler registry version negotiation.

Those concerns should remain separate from signal correctness. In particular, adding forced handler interruption would require a new durable execution contract rather than a process-runner shortcut.
