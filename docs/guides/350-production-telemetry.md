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

## Ask business questions by job type and queue

Lifecycle counters and handler timing metrics attach the job type and queue name. SigNoz can group
throughput, failures, retries, and runtime by either value.

Keep both values as stable application identifiers. If a job type contains a customer or request
identifier, every value creates more time series and makes metric storage grow continuously.

Workhorse never attaches a job id, worker id, schedule name, payload value, or arbitrary job tag to
a metric. Traces retain job identity because sampling and trace retention bound their event volume.

## Filter every signal by its deployment

Set `deployment.environment.name` and `service.name` as OpenTelemetry resource attributes in the
host application. The SDK attaches them to metrics and traces, so Workhorse does not repeat them at
every recording site.

Import the Workhorse jobs dashboard from `docs/signoz/` into SigNoz. Its variables filter by
environment, service, queue, and job type. Its panels cover throughput, terminal failures, retries,
runtime percentiles, worker capacity, queue pressure, and estimated drain time.

The slow-task table ranks task types from handler spans. Trace sampling can change that ranking, so
use the handler histogram when you need unsampled percentiles for one task type.

## Next

- [310-workers.md](310-workers.md) — where telemetry runs in a deployment
- [320-statistics.md](320-statistics.md) — how the dashboard gets longer-window statistics
- [330-retention.md](330-retention.md) — how durable history is bounded

---

Exact instruments, attributes, storage bounds, and alert thresholds:
[`architecture.md`](../architecture.md#production-telemetry).
