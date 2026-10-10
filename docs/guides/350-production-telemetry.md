# How do I see what workers are doing in production?

<!-- scenario-names: payments, pdf.render, exports, welcome-email, invoice-88 -->

Workhorse emits OpenTelemetry traces, logs, and metrics through the standard language APIs. Your
application chooses the SDK, log handler, and backend, so telemetry does not affect queue
correctness. Python workers use the optional `telemetry` package extra. The Go worker uses
`log/slog` for logs.

TypeScript keeps OpenTelemetry outside core. Install `@stablemates/workhorse-otel` with compatible
OpenTelemetry API packages. Configure your global SDK providers, then call
`registerOpenTelemetry()` once during process startup. Importing either package has no side effect,
and core stays silent when no provider is registered.

```ts
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";

const unregisterTelemetry = registerOpenTelemetry();
```

Stop workers and metric observers before calling `unregisterTelemetry()` during shutdown. A second
active provider is rejected, so two libraries cannot silently replace each other's telemetry.

<details>
<summary>Reference: TypeScript provider registration</summary>

`@stablemates/workhorse-otel` declares these peer dependencies:

- `@opentelemetry/api >=1.9.0 <2`
- `@opentelemetry/api-logs >=0.200.0 <0.300.0`
- `@stablemates/workhorse >=0.7.0 <0.8.0`

`registerOpenTelemetry()` calls `registerTelemetryProvider(provider)` and returns its cleanup
function.

- Until a provider registers, core's permanent no-op provider discards every record.
- Registration rejects another active provider.
- The cleanup function is idempotent and restores the no-op provider.
- Core re-creates its instruments when the provider changes, so registration may happen after
  import.

More detail: [Telemetry: Telemetry provider contract](../architecture/telemetry.md#telemetry-provider-contract) and [Telemetry: OpenTelemetry adapter](../architecture/telemetry.md#opentelemetry-adapter).

</details>

## Follow a task from enqueue to execution

> **Example.** A web request signs up a user. The handler enqueues task `welcome-email` with a run
> time ten minutes later. A worker in another process runs it.
>
> 1. **At 0 min — the enqueue.** The request is inside an HTTP server span. The TypeScript queue
>    creates an enqueue span under it. PostgreSQL stores that span's W3C trace context beside the
>    payload. The payload your handler will receive does not change.
> 2. **At 10 min — the claim.** A worker claims the task. The claim returns the stored context.
> 3. **The handler.** Before it creates the handler span, the worker restores the stored context as
>    the parent. The handler span joins the original trace.

In your backend, one trace now shows the HTTP request, the enqueue, and the handler run ten minutes
later in another process.

The TypeScript queue creates an enqueue span and stores its context. Python, Go, Rust, and Ruby
queues store the active caller context. Every worker restores either form and uses the same span
names, so mixed-language deployments share traces. The Go host installs its providers without
adding an SDK or exporter to the library.

Suppose the web request also carried baggage, such as the user's email address. Workhorse does not
persist baggage. Baggage often contains user-controlled or sensitive values, and durable storage
would make those values difficult to bound and redact.

<details>
<summary>Reference: trace context and spans</summary>

**Stored context.** `task.trace_context` holds `traceparent` and an optional `tracestate`.

- Each language enforces 1,024 bytes before enqueue: TypeScript `MAX_TRACE_CONTEXT_BYTES`, Python
  `_telemetry.MAX_TRACE_CONTEXT_BYTES`, and Go `maxTraceContextBytes`.
- The column is separate from `task.payload` and excluded from operator projections.
- An idempotent replay keeps the first accepted context.
- Baggage is never persisted.
- A child task prefers its parent task's stored context over the ambient handler context.

**TypeScript spans:** `workhorse.enqueue`, `workhorse.claim`, `workhorse.handler`,
`workhorse.heartbeat`, `workhorse.retry`, `workhorse.complete`, `workhorse.recovery`,
`workhorse.maintenance`, and `workhorse.schedule.synchronize`.

`workhorse.handler` is a consumer span. Span attributes may include `workhorse.task.id`,
`workhorse.task.type`, `workhorse.task.attempt`, and `workhorse.queue.name`. Workhorse emits at most
eight attributes on one span and exports `TRACE_ATTRIBUTE_COUNT_LIMIT = 8`.

More detail: [Telemetry: Trace context propagation](../architecture/telemetry.md#trace-context-propagation) and [Telemetry: TypeScript spans](../architecture/telemetry.md#typescript-spans).

</details>

## Read lifecycle logs without exposing task data

Task `invoice-88` fails on its last attempt. At info severity, the worker writes
`workhorse.task.failure_processed`. The record names the task ID, task type, attempt outcome, and
worker ID. It does not contain the error message or the invoice payload. To read the error, you
open the task by its ID. At the same moment, the maintenance loop of another worker finds nothing
to recover. It writes no log at all.

Info logs describe operator-relevant state changes, including worker lifecycle, execution outcomes,
cancellation, recovery, maintenance, and schedule changes. Debug logs describe high-volume details,
including claims, heartbeats, handler boundaries, checkpoints, and progress.

Routine maintenance that finds nothing to change stays in metrics instead of logs. This includes
expected lock contention between workers. A maintenance log therefore points to changed rows or a
failed phase rather than an idle poll.

Logs carry stable event names and structured task, queue, worker, and schedule identifiers. They do
not carry payloads, results, error messages, idempotency keys, or saved durable values. A shared
backend therefore does not receive another copy of the application data with every record.

Go applications pass an `*slog.Logger` through `WorkerOptions.Logger`. Handler boundaries, claims,
settlements, rejected heartbeats, recovery, and batch dispatch then use the same event and attribute
vocabulary as the JavaScript worker.

<details>
<summary>Reference: log severities and content</summary>

| Severity | Records cover                                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debug    | Enqueue acceptance and replay, claims, accepted heartbeats, handler registration and execution boundaries, checkpoints, progress, schedule replay, and worker deregistration.          |
| Info     | Queue and worker lifecycle, final execution outcomes, rejected heartbeats, completion and failure, cancellation, durable waits, promotion and recovery, schedule changes, and redrive. |
| Warning  | `workhorse.handler.signal_swallowed` and `workhorse.worker.polling_only`.                                                                                                              |

`workhorse.maintenance.completed` is info, and only when the phase changes rows or returns an error.
Successful no-ops and skipped advisory locks emit no log. Maintenance counters and duration
histograms still record them.

**Never logged:** payloads, results, error messages, cancellation reasons, idempotency keys, and
progress and checkpoint values.

**Go.** A nil `WorkerOptions.Logger` uses a disabled handler, so routine records do not reach the
process default logger.

More detail: [Telemetry: Structured logs](../architecture/telemetry.md#structured-logs).

</details>

### Dashboard requests

An operator pauses queue `payments` from the dashboard and types a reason. The request takes a
second and a half. After the procedure returns, the dashboard host writes one warning record. It
names the procedure, the HTTP status, and the duration. It does not contain the reason or the queue
name the operator sent.

The dashboard host emits one structured log after each matched oRPC procedure returns. Successful
requests use debug severity, slow requests use warning, and failed requests use error. Routine
polling therefore stays available without crowding higher-severity views.

Each request record omits inputs, outputs, error details, headers, and query values. An operator
action stays traceable without copying application data into the logging backend. Assets and
application pages do not produce these records.

<details>
<summary>Reference: dashboard RPC logs</summary>

| Event                               | Severity and condition                              |
| ----------------------------------- | --------------------------------------------------- |
| `workhorse.dashboard.rpc_completed` | Debug below 1,000 ms. Warning at or above 1,000 ms. |
| `workhorse.dashboard.rpc_failed`    | Error for an HTTP status of 400 or greater.         |

Both set `rpc.system = "orpc"`, `rpc.method`, `http.response.status_code`, and
`workhorse.dashboard.rpc.duration_ms`. In workspaces mode they add `workhorse.dashboard.workspace`.

Assets, application pages, authorization failures, and schema compatibility failures produce no
RPC record.

More detail: [Telemetry: RPC logs](../architecture/telemetry.md#rpc-logs).

</details>

### Demo log files

A developer runs the demo in plain mode, and a demo worker fails a task.

1. The worker writes its structured failure record to its own local log file. The demo server
   writes to a separate file.
2. The developer reads the record locally. Nothing is exported.
3. The developer restarts the demo in telemetry mode. The same records now also go to the OTLP
   backend, in the same format.

The demo writes the same structured records to separate rotating files for its server and worker.
Plain demo mode keeps those local files without exporting traces or metrics. The telemetry demo
adds OTLP export to the same pipeline. Comparing a local record with its backend copy therefore
does not need two logging formats.

<details>
<summary>Reference: demo log files</summary>

- Path: `logs/<environment>/<service>.ndjson` under the repository root.
- `WORKHORSE_DEMO_ENV` sets `<environment>`. The default is `development`.
- A file rotates before it would pass 10,485,760 bytes. Five numbered archives are kept.
- `WORKHORSE_DEMO_LOG_DIRECTORY`, `WORKHORSE_DEMO_LOG_MAX_BYTES`, and `WORKHORSE_DEMO_LOG_ARCHIVES`
  override the root, the byte limit, and the archive count.
- `WORKHORSE_DEMO_TELEMETRY = "true"` adds one OTLP log processor plus trace and metric
  instrumentation.

More detail: [Telemetry: Demo log files](../architecture/telemetry.md#demo-log-files).

</details>

## Collect database metrics

Database-wide queue state needs a collector because process metrics cannot reconstruct shared
state. The [metrics guide](355-observability.md#database-metrics-need-a-dedicated-collector)
explains both public collectors, their instrument sets, and how to avoid duplicate observations.

## Ask business questions by task type and queue

Your team asks which task type got slower after Tuesday's release. You group the handler duration
histogram by task type and see that `pdf.render` doubled its runtime. Then you group failures by
queue and see they all come from `exports`.

Lifecycle counters and handler timing metrics attach the task type and queue name. SigNoz can group
throughput, failures, retries, and runtime by either value.

Use the [enqueue outcome metric](355-observability.md#reading-the-signals-together) to inspect
coalescing rates.

Keep both values as stable application identifiers. The [metrics guide](355-observability.md)
explains which attributes metrics may carry and why unbounded values stay out. Traces retain
per-task identity instead.

<details>
<summary>Reference: metric attributes and cardinality</summary>

| Instruments                                                     | Attributes                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| Lifecycle counters and handler instruments                      | `workhorse.queue.name` and `workhorse.task.type`             |
| `workhorse.tasks.enqueue.outcomes`                              | Queue and bounded `workhorse.enqueue.outcome`                |
| `workhorse.handler.executions` and `workhorse.handler.duration` | Add the bounded `workhorse.handler.outcome`                  |
| `workhorse.schedule.fired` and `workhorse.schedule.lag`         | `workhorse.schedule.namespace` and `workhorse.schedule.name` |

Task IDs, worker IDs, tags, payload values, and error messages are forbidden metric attributes.
Schedule namespace and name appear only on the two schedule instruments.

Workhorse exports `METRIC_ATTRIBUTE_CARDINALITY_LIMIT = 2,000` for explicit SDK reader limits.

More detail: [Telemetry: Metric attributes](../architecture/telemetry.md#metric-attributes) and [Telemetry: Cardinality](../architecture/telemetry.md#cardinality).

</details>

## Filter every signal by its deployment

Your staging and production deployments both run `payments` workers, and both send telemetry to one
SigNoz.

1. **At startup** each host application sets its environment and service name on its OpenTelemetry
   resource.
2. **While it runs** the SDK attaches both values to every log, metric, and trace the process emits.
3. **During an incident** an operator opens the Workhorse tasks dashboard in SigNoz and selects
   production. Every panel now shows only production.

Set `deployment.environment.name` and `service.name` as OpenTelemetry resource attributes in the
host application. The SDK attaches them to logs, metrics, and traces, so Workhorse does not repeat
them at every recording site.

`pnpm demo:otel` reconciles the Workhorse tasks dashboard into SigNoz. Run
`pnpm signoz:dashboards` to apply dashboard changes without restarting SigNoz. Its variables filter
by environment, service, queue, and task type. Its panels cover throughput, terminal failures,
runtime percentiles, worker slots, queue pressure, success rate, and estimated drain time.

The slow-task table ranks task types from handler spans. Trace sampling can change that ranking, so
use the handler histogram when you need unsampled percentiles for one task type.

<details>
<summary>Reference: SigNoz dashboard</summary>

The import artifact is `docs/signoz/workhorse-business-metrics-v1.json`, dashboard
`workhorse-tasks`.

| Variable    | Attribute                     |
| ----------- | ----------------------------- |
| Environment | `deployment.environment.name` |
| Service     | `service.name`                |
| Queue       | `workhorse.queue.name`        |
| Task type   | `workhorse.task.type`         |

Panels: Enqueued tasks, Started tasks, Running and waiting tasks, Completed tasks, Execution
outcomes, Handler runtime percentiles, 10 slowest task types, Worker slots, Queue depth, Oldest
ready task, Estimated queue drain time, Terminal success rate, and 10 slowest task executions.

More detail: [Telemetry: Dashboards and alerts](../architecture/telemetry.md#dashboards-and-alerts).

</details>

## Next

- [355-observability.md](355-observability.md) — collect and interpret runtime and database metrics
- [310-workers.md](310-workers.md) — where telemetry runs in a deployment
- [320-statistics.md](320-statistics.md) — how the dashboard gets longer-window statistics

---

Exact instruments, attributes, storage bounds, and alert thresholds:
[`architecture/telemetry.md`](../architecture/telemetry.md#opentelemetry-traces-logs-and-baseline-metrics).
