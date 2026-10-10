# How do I read Workhorse metrics in production?

<!-- scenario-names: exports, pdf.render -->

Workhorse's [production telemetry](350-production-telemetry.md) includes bounded metrics for runtime
activity and shared PostgreSQL state. This guide explains how to collect and interpret those metrics.

## Runtime metrics happen automatically

> **Example.** A TypeScript service registers telemetry at startup and runs a worker for queue
> `exports`.
>
> 1. **The enqueue.** The app enqueues a `pdf.render` task. Workhorse adds one to
>    `workhorse.tasks.enqueued` for queue `exports` and type `pdf.render`.
> 2. **The claim.** A worker claims it. Workhorse adds one to `workhorse.tasks.claimed` and records
>    how long the claim statement took.
> 3. **The run.** The handler succeeds. Workhorse records one handler activation with outcome
>    `succeeded`, its duration, and one `workhorse.tasks.completed`.

No metric names the task. Your backend sees counts and timings per queue and task type.

Once the application [registers telemetry](350-production-telemetry.md), Workhorse records metrics
when it enqueues, claims, executes, cancels, recovers, or performs redrive operations. It also
records schedule firing and maintenance. Until then, TypeScript core records nothing.

The Python worker records the worker-side metrics: claims, settlements, handler outcomes and timing,
batch delivery, and rejected heartbeats. It also records lease recovery, schedule firing, and
maintenance. It does not record enqueue, cancellation, or redrive metrics. The Go worker emits the
worker-owned subset through the OpenTelemetry Go API. Claims, settlements, handler outcomes and
timing, batch delivery, rejected heartbeats, and lease recovery use the same instrument names,
units, and bounded attributes as the JavaScript runtime.

Execution metrics use queue, task type, and outcome as attributes. They never use a task ID,
payload, worker ID, or error message. Those values grow without a stable bound. Putting them in
metric attributes would make the monitoring backend create an ever-growing set of time series. Use
traces for per-task evidence instead.

<details>
<summary>Reference: runtime instruments by runtime</summary>

| Instrument                                                     | TypeScript | Python | Go  |
| -------------------------------------------------------------- | ---------- | ------ | --- |
| `workhorse.tasks.enqueued`, `workhorse.tasks.enqueue.outcomes` | Yes        | No     | No  |
| `workhorse.tasks.claimed`, `.completed`, `.failed`, `.retried` | Yes        | Yes    | Yes |
| `workhorse.tasks.cancellation`, `workhorse.tasks.redrive`      | Yes        | No     | No  |
| `workhorse.claim.duration`                                     | Yes        | Yes    | Yes |
| `workhorse.handler.*` (five instruments)                       | Yes        | Yes    | Yes |
| `workhorse.worker.heartbeat.failure`                           | Yes        | Yes    | Yes |
| `workhorse.leases.expired`                                     | Yes        | Yes    | Yes |
| `workhorse.schedule.fired`, `workhorse.schedule.lag`           | Yes        | Yes    | No  |
| `workhorse.maintenance.runs`, `.rows`, `.duration`, `.errors`  | Yes        | Yes    | No  |
| `workhorse.maintenance.drift`                                  | Yes        | No     | No  |

The five handler instruments are `workhorse.handler.executions`, `workhorse.handler.duration`,
`workhorse.handler.runtime`, `workhorse.handler.batch.size`, and `workhorse.handler.batch.linger`.

Go recovery cannot see the queue and type of a recovered task. Its retry count uses `unknown` for
both, as the TypeScript fallback does.

More detail: [Telemetry: Synchronous instruments](../architecture/telemetry.md#synchronous-instruments).

</details>

## Database metrics need a dedicated collector

Your deployment runs ten worker replicas. Someone adds the metrics observer to the worker's startup
code. Now ten observers query the same queues on every interval. Each exports the same queue depth,
so the dashboard shows ten copies of every gauge.

Queue depth, the age of ready work, expired leases, paused queues, deadline pressure, and fleet
capacity are current database state. `WorkhorseMetricsObserver` reads that state and records gauges.

Run the observer alongside a long-lived service that owns a PostgreSQL pool:

```ts
import { WorkhorseMetricsObserver } from "@stablemates/workhorse";

const observer = new WorkhorseMetricsObserver(pool, {
  onError: (error) => logger.error({ error }, "Workhorse metrics collection failed"),
}).start();

// During service shutdown:
observer.stop();
```

Do not start the observer in every worker replica. Each observer reads the same queues and fleet
rows, so multiple observers would export duplicate gauges and add unnecessary queries.

<details>
<summary>Reference: WorkhorseMetricsObserver</summary>

| Member       | Behavior                                                         |
| ------------ | ---------------------------------------------------------------- |
| `intervalMs` | Default 10,000. A safe integer from 1,000 through 2,147,483,647. |
| `start()`    | Collects immediately, then repeats on an unreferenced timer.     |
| `stop()`     | Clears the timer.                                                |
| `collect()`  | One serialized collection.                                       |
| `onError`    | Receives interval failures.                                      |

Each collection runs two read-only queries at once.

**Queue gauges:** `workhorse.tasks.count` by queue and state, `workhorse.queue.oldest_ready.age`,
`workhorse.queue.paused`, `workhorse.lease.expired`, `workhorse.deadline.overdue`, and
`workhorse.execution_timeout.overdue`. They count both full-tier and fast-tier tasks. The oldest
ready age is 0 when no task is ready.

**Worker gauges:** `workhorse.worker.count`, `workhorse.worker.capacity`, and
`workhorse.worker.active`, by queue and worker state. The states are `running`, `paused`,
`draining`, and `offline`. A worker is `offline` when its last heartbeat is at least 30 seconds old.
A multi-queue worker appears under every queue it serves, so do not sum across queues.

A series that a later collection no longer returns is recorded once as 0. The timer does not await
`onError`, which may return a promise. A reporter that throws or rejects is written to
`console.error` instead of becoming an unhandled rejection.

More detail: [Telemetry: Metrics observer](../architecture/telemetry.md#metrics-observer).

</details>

`registerQueueMetrics` reads through a `Queue` instead. It adds policy and orchestration gauges for
concurrency, dependencies, child tasks, and rate limits alongside queue depth and age:

```ts
import { registerQueueMetrics } from "@stablemates/workhorse";

const unregisterQueueMetrics = registerQueueMetrics(adapter.queue);

// During service shutdown:
unregisterQueueMetrics();
```

The two collectors use distinct instrument names, but both report queue depth and age. Choose the
instrument set your dashboards consume. Register each collector only once for a database and
telemetry resource.

<details>
<summary>Reference: registerQueueMetrics</summary>

`registerQueueMetrics(queue)` adds observable gauges that the meter reads at collection time:

- `workhorse.queue.depth` by queue and state (`ready`, `scheduled`, `active`)
- `workhorse.queue.oldest_ready_age` in milliseconds, by queue
- `workhorse.queue.concurrency.*`: `limit`, `active`, `blocked_ready`
- `workhorse.queue.dependencies.*`: `blocked`, `pending_edges`, `failed_resolutions`, `capped`
- `workhorse.queue.children.*`: `waiting_parents`, `pending`, `unjoined_results`, `failed_parents`,
  `canceled_parents`, `capped`
- `workhorse.queue.rate_limit.*`: `configured`, `available_tokens`, `throttled_ready`,
  `next_eligible_delay`

It returns a cleanup function. Registered before a telemetry provider, it activates when one
registers. Provider cleanup detaches it, and a later provider attaches it again.

`workhorse.queue.depth` and the observer's `workhorse.tasks.count` measure the same live work.

More detail: [Telemetry: Baseline queue metrics](../architecture/telemetry.md#baseline-queue-metrics).

</details>

## Reading the signals together

On queue `exports`, `workhorse.tasks.enqueued` keeps rising, but `workhorse.tasks.claimed` drops to
zero.

1. **Is the queue paused?** `workhorse.queue.paused` is 0, so no.
2. **Are workers there?** `workhorse.worker.capacity` for `exports` is 0 under `running`. The only
   workers that served `exports` now show as `offline`.
3. **Is work waiting?** The age of the oldest ready task climbs steadily.

The workers stopped. Ready work piles up behind them.

Use `workhorse.tasks.enqueued` and `workhorse.tasks.claimed` to see whether work enters and leaves
the ready queue. If enqueue continues while claim stops, compare `workhorse.queue.paused`, worker
capacity, and the age of the oldest ready task.

Use `workhorse.tasks.enqueue.outcomes` to compare `accepted`, `replayed`, `replaced`,
`non_replaceable`, and `coalesced` requests by queue. The metric omits keyed-request material, so
coalescing rates remain visible without exposing or multiplying time series by keys.

Use `workhorse.handler.executions` for outcomes and `workhorse.handler.duration` for handler
latency. Both carry the same bounded outcome attribute. A rising retry or lease-loss rate points to
different problems than terminal failures. That attribute keeps those paths separate without
identifying individual tasks.

An activation and a durable result are different events, and each reaches one instrument. To count
activations that ended a given way, count `workhorse.handler.executions`. To count the durable
result the queue wrote, use `workhorse.tasks.completed`, `workhorse.tasks.failed`, and
`workhorse.tasks.retried`. The two differ when an attempt suspends on a durable wait. That closes an
activation without ending the attempt.

`workhorse.tasks.failed` counts every failure the worker submits, including one that leads to a
retry. Its attempt outcome attribute says which. Filter it to `failed` to count tasks that failed
for good. A failure that retries also counts once in `workhorse.tasks.retried`.

Use the maintenance, schedule-lag, expired-lease, overdue-deadline, and overdue-timeout metrics to
detect work that should have advanced but did not. PostgreSQL remains authoritative. The metrics
describe its transitions and current state rather than reconstructing queue truth in memory.

<details>
<summary>Reference: outcome attributes and suggested alerts</summary>

**`workhorse.handler.outcome`:** `succeeded`, `retry`, `failed`, `canceled`, `deadline_exceeded`,
`timeout`, `lease_lost`, `suspended`, and `released`. `released` means the worker handed the claim
back with its attempt intact, for example for a task type it has no handler for. An activation that ends without a recorded outcome
reports `unknown` on the duration histogram.

**`workhorse.attempt.outcome`** on `workhorse.tasks.failed` is the state `fail_v1` returns: `ready`,
`scheduled`, `failed`, `cancel_requested`, `deadline_exceeded`, `timeout_exceeded`, or `stale`.
`ready` and `scheduled` also add one to `workhorse.tasks.retried`.

**Suggested alerts**

| Condition                                                                  | Alert                     | Critical                     |
| -------------------------------------------------------------------------- | ------------------------- | ---------------------------- |
| Ready depth stays above zero while claiming and completion rates stay zero | for 5 minutes             | for 15 minutes               |
| Maintenance drift, for three consecutive observations                      | exceeds twice the cadence | above five times the cadence |
| Expired leases as a share of tasks workers claim, over 10 minutes          | exceeds 1%                | —                            |
| Failures as a share of handler settlements, over 10 minutes                | exceeds 5%                | above 20%                    |

Replace age and latency thresholds with your own queue-delay and handler-duration objectives.

More detail: [Telemetry: Dashboards and alerts](../architecture/telemetry.md#dashboards-and-alerts).

</details>

## Next

- [350-production-telemetry.md](350-production-telemetry.md) — connect traces, logs, and metrics to your telemetry backend
- [310-workers.md](310-workers.md) — how workers claim and drain work
- [320-statistics.md](320-statistics.md) — durable historical rates maintained in PostgreSQL

---

Exact instrument names, attributes, units, and observer behavior:
[`architecture/telemetry.md`](../architecture/telemetry.md#opentelemetry-metrics).
