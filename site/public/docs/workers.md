# Workers

> Register handlers, size concurrency, tune the lease, and drain active work safely.

Jobs sit in PostgreSQL until a process runs them. That process is a `Worker`: a loop that
claims ready jobs, runs your handlers, and records each result. This page covers everything
between `new Worker(queue)` and a clean shutdown.

## Register handlers and run

`Worker.handle` binds a job type to an async function. Registration chains, so one worker can
serve many types. Each handler receives the payload and a `HandlerContext`, and returns a JSON
result that becomes the job's durable outcome.

```ts
import { Worker } from "@workhorse/core";

const worker = new Worker(queue, { queue: "email", concurrency: 5 })
  .handle("email.send", async (payload: { to: string }, ctx) => {
    await mailer.send(payload.to, { signal: ctx.signal });
    return { deliveredTo: payload.to };
  })
  .handle("email.digest", async (payload: { userId: string }) => {
    return { sent: await sendDigest(payload.userId) };
  });

await worker.run();
```

`run` loops until you stop it; pass an `AbortSignal` as `worker.run(signal)` to tie its
lifetime to your process. `runOnce` performs a single claim-and-run pass and returns whether
it found work — useful in tests and scripts.

The `HandlerContext` carries the claimed job, its `AbortSignal`, checkpoints, durable waits,
and progress. Every context method writes under the current fence, so handler code cannot
accidentally write as a stale owner after the job moves on.

## The options that matter

```ts
const worker = new Worker(queue, {
  queue: "email", // queue to claim from
  concurrency: 5, // simultaneous handler slots, default 1
  leaseMs: 30_000, // ownership granted per claim and heartbeat (the default)
  workerId: "email-worker-1", // defaults to <hostname>-<pid>-<random>
});
```

- **`concurrency`** caps simultaneous handlers in this one `Worker`. Replicas multiply that
  capacity. When the fleet must share one budget, use
  [concurrency policies](/docs/concurrency-policies); for a shared start rate, use
  [rate limits](/docs/rate-limits).
- **`leaseMs`** is how long a claim owns a job before the database may recover it. Each
  active job runs its own background heartbeat — every `heartbeatMs`, defaulting to a third
  of `leaseMs` — that extends the lease while the handler runs. A shorter lease means faster
  recovery after a crash; a longer one tolerates worse network pauses.
- **`workerId`** identifies the lease owner. Leave it generated unless a process manager
  guarantees uniqueness: two live workers sharing one identity collide over ownership. The
  default embeds host and pid, so fleet views stay readable.
- **`retryDelayMs`** overrides the persisted retry policy — a number, or
  `(attempt, job) => number | undefined`, where `undefined` defers to the database.
- **`scheduleNamespaces`** and **`scheduleCatchupLimit`** opt this worker into evaluating
  [recurring schedules](/docs/schedules).

Group handlers that share a queue and operational policy into one multi-slot worker. Add a
second worker when work needs a different queue, lease, retry override, or schedule namespace.

## Process jobs in batches

`Worker.handleBatch` groups claimed jobs of one type when one provider call can process several
payloads efficiently. Every member still occupies one concurrency slot and keeps its own lease,
fence, cancellation signal, progress, retry budget, and final result.

```ts
worker.handleBatch("email.send", { maxSize: 20, lingerMs: 50 }, async (items) => {
  const deliveries = await mailer.sendMany(items.map((item) => item.payload));
  return deliveries.map((delivery) =>
    delivery.error
      ? { status: "failed", error: delivery.error }
      : { status: "succeeded", result: { providerId: delivery.id } },
  );
});
```

The callback must return one ordered outcome per member. Batch contexts omit durable waits,
signals, human decisions, and child joins because one member cannot suspend independently inside a
shared invocation. See [Batch handlers](/docs/batch-handlers) for grouping and failure rules.

## Run workers in a dedicated process

Queue depth and HTTP traffic rarely scale together, so production deployments put workers in
their own process. `defineWorkerProcess` describes the adapter and workers; the
`workhorse worker` CLI loads the compiled definition and adds signal handling and supervision.

```ts
import { createWorkhorseAdapter, defineWorkerProcess } from "@workhorse/core";

export default defineWorkerProcess({
  adapter: () => createWorkhorseAdapter(adapterOptions),
  workers: [
    {
      options: { queue: "email", concurrency: 5 },
      configure(worker) {
        worker.handle("email.send", sendEmail);
      },
    },
  ],
});
```

The process owns its database resources, worker loops, optional probes, and shutdown. Compile
the definition before the CLI imports it — the CLI does not install a TypeScript loader.

## Pause, stop, and drain

Three verbs cover controlled slowdown, and each answers a different situation:

- **`worker.pause()`** stops this worker from claiming while active handlers finish.
  `worker.resume()` lets it claim again; `worker.isPaused()` reads the effective state.
- **`worker.stop()`** drains: no new claims, active handlers run to completion, then `run`
  resolves. On `SIGTERM`, the worker process does this for you.
- **`Queue.setWorkerPaused`** stores an operator pause in `worker_registry`. The worker picks
  it up on its next registration refresh — about `registryIntervalMs`, five seconds by
  default — so a dashboard can pause a process it does not host. A local `resume()` cannot
  clear an operator pause, and an operator pause dies with the process incarnation it named.

If work must stop durably — surviving worker restarts — pause the queue with
`Queue.pauseQueue`, not the worker.

## Read fleet state carefully

`Worker.runtimeState()` reads the local process: slots, pause flags, draining. `Queue.listWorkers`
reads the durable registry that every worker refreshes on an interval. Registry slot counts are
recent observations, not synchronous views of another event loop — treat them as a moment-ago
snapshot.

A worker that dies stops refreshing and goes stale in the registry. Its jobs are not lost: their
leases expire and recovery makes them claimable again.

## Next

- [Deployment and operations](/docs/operations) — supervise and drain the worker process
- [Batch handlers](/docs/batch-handlers) — share one application call across jobs
- [Cancellation](/docs/cancellation) — make handlers stop cooperatively
- [Schedules](/docs/schedules) — let workers evaluate recurring work

---

Exact worker options, registry fields, heartbeat behavior, and process lifecycle:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#worker-concurrency-and-lifecycle).
