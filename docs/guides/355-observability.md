# How do I read Workhorse metrics in production?

<!-- scenario-names: billing, invoice.send -->

A metric is a count or a measurement that a monitoring backend shows over time. The
[production telemetry](350-production-telemetry.md) of Workhorse includes metrics for the work of
each process and for the shared state in PostgreSQL. This guide tells how to collect these metrics
and how to read them.

## Read the metrics that each process records

**Example.** A TypeScript service registers telemetry at startup. It runs a worker for the queue
`billing`.

1. The application enqueues an `invoice.send` task. Workhorse adds one to
   `workhorse.tasks.enqueued` for the queue `billing` and the type `invoice.send`.
2. A worker claims the task. Workhorse adds one to `workhorse.tasks.claimed`. It also records the
   duration of the claim statement.
3. The handler succeeds. Workhorse records one handler activation, with the outcome `succeeded`
   and its duration. An activation is one run of the handler.
4. Workhorse adds one to `workhorse.tasks.completed`.

No metric names the task. Your backend shows counts and durations for each queue and task type.

After the application [registers telemetry](350-production-telemetry.md), Workhorse records
metrics for each enqueue, claim, execution, cancellation, recovery, and redrive. It also records
schedule firing and routines. Before registration, TypeScript core records nothing.

The Python worker records the metrics of the worker: claims, settlements, handler outcomes and
durations, batch delivery, and rejected heartbeats. It also records lease recovery, schedule
firing, and routines. It does not record enqueue, cancellation, or redrive metrics.

The Go worker records the metrics of the worker through the OpenTelemetry Go API. Claims,
settlements, handler outcomes and durations, batch delivery, rejected heartbeats, and lease
recovery use the same instrument names, units, and attributes as the JavaScript worker.

Execution metrics use the queue, the task type, and the outcome as attributes. They never use a
task ID, a payload, a worker ID, or an error message. These values have no stable bound. As metric
attributes, they make the backend create more and more time series. For the evidence of one task,
use traces.

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

Stable metrics include `workhorse.tasks.enqueued`, `workhorse.tasks.claimed`,
`workhorse.queue.paused`, `workhorse.tasks.enqueue.outcomes`, `workhorse.handler.executions`,
`workhorse.handler.duration`, `workhorse.tasks.completed`, `workhorse.tasks.failed`, and
`workhorse.tasks.retried`.

Go recovery cannot see the queue and type of a recovered task. Its retry count uses `unknown` for
both, as the TypeScript fallback does.

More detail: [Telemetry: Synchronous instruments](../architecture/telemetry.md#synchronous-instruments).

</details>

## Collect database metrics in one service

Some metrics describe the shared state in PostgreSQL. Examples are queue depth, the age of ready
work, expired leases, paused queues, deadline pressure, and worker capacity. The metrics of one
process cannot show this state. `WorkhorseMetricsObserver` reads the state from PostgreSQL and
records gauges. A gauge is a metric that shows a current value.

**Example.** Your deployment runs ten worker replicas.

1. A developer adds the metrics observer to the startup code of the worker.
2. Ten observers now read the same queues at each interval.
3. Each observer exports the same queue depth.
4. The dashboard shows ten copies of each gauge.

Do not start the observer in each worker replica. Run one observer in a long-lived service that has
a PostgreSQL pool:

```ts
import { WorkhorseMetricsObserver } from "@stablemates/workhorse";

const observer = new WorkhorseMetricsObserver(pool, {
  onError: (error) => logger.error({ error }, "Workhorse metrics collection failed"),
}).start();

// During service shutdown:
observer.stop();
```

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
A multi-queue worker appears under every queue it serves, so do not add the values of different
queues.

The observer records a series one time as 0 when a later collection no longer returns it. The timer
does not await `onError`, which can return a promise. If the reporter throws or rejects, the
observer writes the failure to `console.error`. The failure does not become an unhandled rejection.

More detail: [Telemetry: Metrics observer](../architecture/telemetry.md#metrics-observer).

</details>

`registerQueueMetrics` is a second collector. It reads through a `Queue`. In addition to queue depth
and age, it adds gauges for concurrency, dependencies, child tasks, and rate limits:

```ts
import { registerQueueMetrics } from "@stablemates/workhorse";

const unregisterQueueMetrics = registerQueueMetrics(adapter.queue);

// During service shutdown:
unregisterQueueMetrics();
```

The two collectors use different instrument names, but both report queue depth and age. Select the
instrument set that your dashboards use. Register each collector only one time for a database and a
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

It returns a cleanup function. If you register it before a telemetry provider, it starts when a
provider registers. Provider cleanup detaches it, and a later provider attaches it again.

`workhorse.queue.depth` and the observer's `workhorse.tasks.count` measure the same live work.

More detail: [Telemetry: Baseline queue metrics](../architecture/telemetry.md#baseline-queue-metrics).

</details>

## Read the signals together

One metric seldom tells why work stops. Compare the metrics of the processes with the gauges of the
database.

**Example.** On the queue `billing`, `workhorse.tasks.enqueued` continues to increase. But
`workhorse.tasks.claimed` falls to zero.

1. Is the queue paused? `workhorse.queue.paused` is 0, so the queue is not paused.
2. Are workers available? `workhorse.worker.capacity` for `billing` is 0 in the state `running`.
3. The workers that served `billing` now show as `offline`.
4. Is work waiting? The age of the oldest ready task increases.

The workers stopped, and ready work collects in the queue.

Use `workhorse.tasks.enqueued` and `workhorse.tasks.claimed` to see if work goes into and out of the
ready queue. If enqueue continues and claims stop, compare `workhorse.queue.paused`, worker
capacity, and the age of the oldest ready task.

Use `workhorse.tasks.enqueue.outcomes` to compare the `accepted`, `replayed`, `replaced`,
`non_replaceable`, and `coalesced` requests of each queue. The `non_replaceable` outcome shows a
keyed request that Workhorse did not accept as a replacement. It is not a transport failure. The
metric does not contain the keys of keyed requests. Thus, you can see how frequently Workhorse
combines requests, and the keys do not add time series.

Use `workhorse.handler.executions` for outcomes and `workhorse.handler.duration` for handler
latency. Both have the same outcome attribute, which has a fixed set of values. Retries, lost
leases, and terminal failures show different problems. The outcome attribute keeps them separate
and does not identify tasks.

A handler activation and a durable result are different events. Each event goes to one instrument:

- To count the activations that ended in a given way, use `workhorse.handler.executions`.
- To count the durable results that the queue wrote, use `workhorse.tasks.completed`,
  `workhorse.tasks.failed`, and `workhorse.tasks.retried`.

The two counts are different when an attempt suspends on a durable wait. The suspension ends the
activation, but the attempt continues.

`workhorse.tasks.failed` counts each failure that the worker sends, also a failure that causes a
retry. Its attempt outcome attribute tells which. To count the tasks that failed permanently, filter
it to `failed`. A failure that causes a retry also adds one to `workhorse.tasks.retried`.

Use the metrics for routines, schedule lag, expired leases, late deadlines, and late timeouts. They
show work that did not move forward when it should. PostgreSQL holds the correct state of the
queue. The metrics show its transitions and its current state. They do not build the state again
in memory.

<details>
<summary>Reference: outcome attributes and suggested alerts</summary>

**`workhorse.handler.outcome`:** `succeeded`, `retry`, `failed`, `canceled`, `deadline_exceeded`,
`timeout`, `lease_lost`, `suspended`, and `released`. `released` means that the worker gave the
claim back with its attempt intact, for example for a task type that it has no handler for. An
activation that ends without a recorded outcome reports `unknown` on the duration histogram.

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

Replace the age and latency thresholds with your own objectives for queue delay and handler
duration.

More detail: [Telemetry: Dashboards and alerts](../architecture/telemetry.md#dashboards-and-alerts).

</details>

## Next

- [350-production-telemetry.md](350-production-telemetry.md) — connect traces, logs, and metrics to
  your telemetry backend
- [310-workers.md](310-workers.md) — how workers claim and drain work
- [320-statistics.md](320-statistics.md) — durable rates that PostgreSQL keeps for long windows

---

Exact instrument names, attributes, units, and observer behavior:
[`architecture/telemetry.md`](../architecture/telemetry.md#opentelemetry-metrics).
