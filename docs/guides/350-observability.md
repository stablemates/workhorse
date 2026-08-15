# How do I observe Workhorse in production?

Workhorse emits OpenTelemetry metrics for activity inside each process. A separate observer reports
the shared state in PostgreSQL, because every worker sees the same queues and would otherwise count
that state more than once.

## Process metrics happen automatically

Workhorse uses the OpenTelemetry API when it enqueues, claims, executes, cancels, recovers, or
performs redrive operations. It also records schedule firing and maintenance. Once your application
configures an OpenTelemetry SDK, those measurements flow through your chosen exporter. Configure it
before or after you import `@workhorse/core`; Workhorse notices the change and follows the SDK you
installed. Without an SDK the measurements are harmless no-ops.

Execution metrics use queue, job type, and outcome as attributes. They never use a job ID, payload,
worker ID, or error message. Those values grow without a stable bound, so putting them in metric
attributes would make the monitoring backend create an ever-growing set of time series. Use traces
for per-job evidence instead.

## Database metrics need a dedicated observer

Queue depth, the age of ready work, expired leases, paused queues, deadline pressure, and fleet
capacity are current database state. `WorkhorseMetricsObserver` reads that state and records gauges.

Run the observer alongside a long-lived service that owns a PostgreSQL pool:

```ts
import { WorkhorseMetricsObserver } from "@workhorse/core";

const observer = new WorkhorseMetricsObserver(pool, {
  onError: (error) => logger.error({ error }, "Workhorse metrics collection failed"),
}).start();

// During service shutdown:
observer.stop();
```

Do not start the observer in every worker replica. Each observer reads the same queues and fleet rows, so
multiple observers would export duplicate gauges and add unnecessary queries.

## Reading the signals together

Use `workhorse.jobs.enqueued` and `workhorse.jobs.claimed` to see whether work enters and leaves the
ready queue. If enqueue continues while claim stops, compare `workhorse.queue.paused`, worker
capacity, and the age of the oldest ready job.

Use `workhorse.jobs.enqueue.outcomes` to compare `accepted`, `replayed`, `replaced`,
`non_replaceable`, and `coalesced` requests by queue. The metric omits keyed-request material, so
coalescing rates remain visible without exposing or multiplying time series by keys.

Use `workhorse.handler.executions` for outcomes and `workhorse.handler.duration` for handler
latency. Both carry the same bounded outcome attribute. A rising retry or lease-loss rate points to
different problems than terminal failures, so that attribute keeps those paths separate without
identifying individual jobs.

Every event reaches one instrument only. If you want the number of activations that ended a given
way, count `workhorse.handler.executions`; if you want the durable result the queue wrote, count
`workhorse.jobs.completed`, `workhorse.jobs.failed`, or `workhorse.jobs.retried`. The two differ
when an attempt suspends on a durable wait, which closes an activation without ending the attempt.

Use the maintenance, schedule-lag, expired-lease, overdue-deadline, and overdue-timeout metrics to
detect work that should have advanced but did not. PostgreSQL remains authoritative; the metrics
describe its transitions and current state rather than reconstructing queue truth in memory.

## Next

- [310-workers.md](310-workers.md) — how workers claim and drain work
- [320-statistics.md](320-statistics.md) — durable historical rates maintained in PostgreSQL
- [340-redrive.md](340-redrive.md) — how operators create a fresh attempt from failed work

---

Exact instrument names, attributes, units, and observer behavior:
[`architecture.md`](../architecture.md#opentelemetry-metrics).
