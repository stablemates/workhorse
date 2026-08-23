# How do I see what workers are doing in production?

Workhorse emits OpenTelemetry traces, logs, and metrics through the standard language APIs. Your
application chooses the SDK, log handler, and backend, so telemetry does not affect queue correctness.
Python workers use the optional `telemetry` package extra. The Go worker uses `log/slog` for logs.

## Follow a job from enqueue to execution

When application code enqueues a job, `Queue.enqueue` creates an enqueue span and captures its W3C
trace context. PostgreSQL stores that context beside the payload, without changing the payload your
handler receives.

When a worker claims the job, `Worker` restores the stored parent before it creates the handler
span. The enqueue and handler can run in different processes or at very different times while
remaining part of one trace.

The TypeScript queue creates the enqueue span and stores its context. Python and Go workers restore
that context and use the same worker span names, so mixed-language deployments share traces. The Go
host installs its W3C propagator and providers without adding an SDK or exporter to the library.

Workhorse does not persist baggage. Baggage often contains user-controlled or sensitive values,
and durable storage would make those values difficult to bound and redact.

## Read lifecycle logs without exposing job data

Info logs describe operator-relevant state changes, including worker lifecycle, execution outcomes,
cancellation, recovery, maintenance, and schedule changes. Debug logs describe high-volume details,
including claims, heartbeats, handler boundaries, checkpoints, and progress.

Routine maintenance that finds nothing to change stays in metrics instead of logs. This includes
expected lock contention between workers, so a maintenance log points to changed rows or a failed
phase rather than an idle poll.

Logs carry stable event names and structured job, queue, worker, and schedule identifiers. They do
not carry payloads, results, error messages, idempotency keys, or saved durable values. A shared
backend therefore does not receive another copy of the application data with every record.

Go applications pass an `*slog.Logger` through `WorkerOptions.Logger`. Handler boundaries, claims,
settlements, rejected heartbeats, recovery, and batch dispatch then use the same event and attribute
vocabulary as the JavaScript worker.

The dashboard host also emits a structured log after each matched oRPC procedure returns.
Successful requests use debug severity, slow requests use warning, and failed requests use error,
so routine polling stays available without crowding higher-severity views.

Each request record names the procedure, HTTP status, and duration. It omits inputs, outputs, error
details, headers, and query values, so an operator action remains traceable without copying
application data into the logging backend. Assets and application pages do not produce these
records.

The demo writes the same structured records to separate rotating files for its server and worker.
Plain demo mode keeps those local files without exporting traces or metrics. The telemetry demo
adds OTLP export to the same pipeline, so comparing a local record with its backend copy does not
require two logging formats.

## Collect database metrics

Database-wide queue state needs a collector because process metrics cannot reconstruct shared
state. The [metrics guide](355-observability.md#database-metrics-need-a-dedicated-collector)
explains both public collectors, their instrument sets, and how to avoid duplicate observations.

## Ask business questions by job type and queue

Lifecycle counters and handler timing metrics attach the job type and queue name. SigNoz can group
throughput, failures, retries, and runtime by either value.

Use the [enqueue outcome metric](355-observability.md#reading-the-signals-together) to inspect
coalescing rates.

Keep both values as stable application identifiers; the [metrics guide](355-observability.md)
explains which attributes metrics may carry and why unbounded values stay out. Traces retain
per-job identity instead.

## Filter every signal by its deployment

Set `deployment.environment.name` and `service.name` as OpenTelemetry resource attributes in the
host application. The SDK attaches them to logs, metrics, and traces, so Workhorse does not repeat
them at every recording site.

`pnpm demo:otel` reconciles the Workhorse jobs dashboard into SigNoz. Run
`pnpm signoz:dashboards` to apply dashboard changes without restarting SigNoz. Its variables filter
by environment, service, queue, and job type. Its panels cover throughput, terminal failures,
runtime percentiles, worker slots, queue pressure, success rate, and estimated drain time.

The slow-task table ranks task types from handler spans. Trace sampling can change that ranking, so
use the handler histogram when you need unsampled percentiles for one task type.

## Next

- [355-observability.md](355-observability.md) — collect and interpret runtime and database metrics
- [310-workers.md](310-workers.md) — where telemetry runs in a deployment
- [320-statistics.md](320-statistics.md) — how the dashboard gets longer-window statistics

---

Exact instruments, attributes, storage bounds, and alert thresholds:
[`architecture.md`](../architecture.md#opentelemetry-traces-logs-and-baseline-metrics).
