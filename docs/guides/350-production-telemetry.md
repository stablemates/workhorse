# How do I see what workers are doing in production?

Workhorse emits OpenTelemetry traces and metrics through the standard JavaScript API. Your
application chooses the SDK and backend, so telemetry does not affect queue correctness.

## Follow a job from enqueue to execution

When application code enqueues a job, `Queue.enqueue` creates an enqueue span and captures its W3C
trace context. PostgreSQL stores that context beside the payload, without changing the payload your
handler receives.

When a worker claims the job, `Worker` restores the stored parent before it creates the handler
span. The enqueue and handler can run in different processes or at very different times while
remaining part of one trace.

Workhorse does not persist baggage. Baggage often contains user-controlled or sensitive values,
and durable storage would make those values difficult to bound and redact.

## Export queue pressure

Lifecycle counters and latency histograms emit automatically after your application configures the
OpenTelemetry SDK. Database-wide queue depth and oldest-ready age need an asynchronous observation:

```ts
import { registerQueueMetrics } from "@workhorse/core";

const unregisterQueueMetrics = registerQueueMetrics(adapter.queue);

// Call this during application shutdown.
unregisterQueueMetrics();
```

Register the callback once for each database telemetry resource. If every worker registers the
same database, the backend receives duplicate observations.

## Keep metric dimensions bounded

Workhorse metrics use fixed state and outcome values. They never attach a job id, job type, queue
name, worker id, schedule name, or namespace, because those values can create an unlimited number
of time series.

Traces can carry job and queue identifiers because sampling bounds their event volume. Configure
your exporter and backend retention according to the sensitivity of those identifiers.

## Next

- [310-workers.md](310-workers.md) — where telemetry runs in a deployment
- [320-statistics.md](320-statistics.md) — how the dashboard gets longer-window statistics
- [330-retention.md](330-retention.md) — how durable history is bounded

---

Exact instruments, attributes, storage bounds, and alert thresholds:
[`architecture.md`](../architecture.md#production-telemetry).
