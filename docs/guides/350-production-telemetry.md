# How do I see what workers do in production?

<!-- scenario-names: billing, invoice.send -->

Telemetry is the traces, logs, and metrics that a process sends to a monitoring backend. Workhorse
sends its telemetry through the standard OpenTelemetry APIs of each language. Your application
selects the SDK, the log handler, and the backend. Telemetry does not change the behavior of the
queue.

A telemetry provider is the one destination in a process for Workhorse traces, metrics, and logs.
If no provider is registered, Workhorse discards these records. The queue and the worker operate
as usual.

## Register a telemetry provider

**Example.** A TypeScript worker process starts, runs tasks, and stops.

1. At startup, the process imports core and creates a worker. No provider is registered, so core
   discards each span, log, and metric.
2. The process configures the global OpenTelemetry SDK. Then it calls `registerOpenTelemetry()`.
   Core now sends its records to that SDK.
3. Later, another library tries to register its own provider. Workhorse rejects it. The first
   provider continues to get the records.
4. At shutdown, the process stops its workers and metric observers. Then it calls the cleanup
   function that registration returned. Core discards records again.

In TypeScript, OpenTelemetry is not part of core. To connect it:

1. Install `@stablemates/workhorse-otel` and the OpenTelemetry API packages that it accepts.
2. Configure the global SDK providers.
3. Call `registerOpenTelemetry()` one time when the process starts.

```ts
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";

const unregisterTelemetry = registerOpenTelemetry();
```

An import of either package does not register a provider. Core stays silent until a provider is
registered. At shutdown, stop the workers and metric observers first. Then call
`unregisterTelemetry()`.

Workhorse rejects a second active provider. Thus, two libraries cannot replace the telemetry of each
other.

Python workers use the optional `telemetry` package extra. Go applications install their own
providers, and the Go worker uses `log/slog` for logs.

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
- Core re-creates its instruments when the provider changes, so registration can occur after
  import.

More detail: [Telemetry: Telemetry provider contract](../architecture/telemetry.md#telemetry-provider-contract) and [Telemetry: OpenTelemetry adapter](../architecture/telemetry.md#opentelemetry-adapter).

</details>

## Follow a task from enqueue to execution

A trace shows the spans of one request across processes. A span is one timed operation in a trace.
Workhorse keeps the trace of a task across the time between enqueue and execution.

**Example.** A web request places an order. The request handler enqueues an `invoice.send` task
with a run time 10 minutes later. A worker in another process runs the task.

1. At 0 min, the web request is in an HTTP server span. The TypeScript queue makes an enqueue span
   below it.
2. PostgreSQL stores the trace context of the enqueue span next to the payload. The payload does
   not change.
3. At 10 min, a worker claims the task. The claim returns the stored trace context.
4. The worker makes the stored context the parent of the handler span. The handler span joins the
   first trace.

In your backend, one trace shows the HTTP request, the enqueue, and the handler run. The handler ran
10 minutes later in another process.

The TypeScript queue makes an enqueue span and stores its context. Python, Go, Rust, and Ruby queues
store the active context of the caller. Each worker can restore the two forms, and all workers use
the same span names. Thus, one trace can include workers in different languages. The Go host
installs its own providers, and the library adds no SDK or exporter.

The web request can also carry baggage, for example the email address of the customer. Baggage is a
set of values that OpenTelemetry sends with a request. Workhorse does not store baggage. Baggage
often holds sensitive values or values that a user controls. In durable storage, these values are
difficult to limit and to remove.

<details>
<summary>Reference: trace context and spans</summary>

**Stored context.** `task.trace_context` holds `traceparent` and an optional `tracestate`.

- Each language enforces 1,024 bytes before enqueue: TypeScript `MAX_TRACE_CONTEXT_BYTES`, Python
  `_telemetry.MAX_TRACE_CONTEXT_BYTES`, and Go `maxTraceContextBytes`.
- The column is separate from `task.payload` and excluded from operator projections.
- An idempotent replay keeps the first accepted context.
- Workhorse never persists baggage.
- A child task prefers its parent task's stored context over the ambient handler context.

**TypeScript spans:** `workhorse.enqueue`, `workhorse.claim`, `workhorse.handler`,
`workhorse.heartbeat`, `workhorse.retry`, `workhorse.complete`, `workhorse.recovery`,
`workhorse.maintenance`, and `workhorse.schedule.synchronize`.

`workhorse.handler` is a consumer span. Span attributes can include `workhorse.task.id`,
`workhorse.task.type`, `workhorse.task.attempt`, and `workhorse.queue.name`. Workhorse emits at most
eight attributes on one span and exports `TRACE_ATTRIBUTE_COUNT_LIMIT = 8`.

More detail: [Telemetry: Trace context propagation](../architecture/telemetry.md#trace-context-propagation) and [Telemetry: TypeScript spans](../architecture/telemetry.md#typescript-spans).

</details>

## Read lifecycle logs without task data

Workhorse logs tell you what changed in a task, a queue, or a worker. The logs do not contain the
data of your application.

**Example.** An `invoice.send` task fails on its last attempt.

1. The worker writes `workhorse.task.failure_processed` at info severity.
2. The record names the task ID, the task type, the attempt outcome, and the worker ID.
3. The record does not contain the error message or the invoice payload.
4. To read the error, you open the task by its ID.

At the same time, another worker looks for expired leases and finds none. That worker writes no log.

Info logs show state changes that are important to an operator. Examples are worker lifecycle,
execution outcomes, cancellation, recovery, routines, and schedule changes. Debug logs show
frequent details, such as claims, heartbeats, handler boundaries, checkpoints, and progress.

If a routine finds nothing to change, Workhorse records it only in metrics. This includes an
expected lock conflict between workers. Thus, a routine log shows changed rows or a failed phase.

Logs carry stable event names and the identifiers of the task, queue, worker, and schedule. Logs do
not carry payloads, results, error messages, idempotency keys, or durable values that a handler
saved. Thus, a shared backend does not get a copy of your application data with each record.

Go applications give an `*slog.Logger` in `WorkerOptions.Logger`. The Go worker then uses the same
event names and attributes as the JavaScript worker. This applies to handler boundaries, claims,
settlements, rejected heartbeats, recovery, and batch dispatch.

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

### Read the logs of dashboard requests

The dashboard host writes one log record for each operator request. The record shows the request
and its result, but not the data that the operator sent.

**Example.** An operator pauses the queue `billing` from the dashboard and types a reason.

1. The request takes 1.5 seconds.
2. After the procedure returns, the dashboard host writes one record at warning severity.
3. The record names the procedure, the HTTP status, and the duration.
4. The record does not contain the reason or the queue name.

The dashboard host writes one structured log after each matched oRPC procedure returns. A
successful request uses debug severity. A slow request uses warning severity. A failed request uses
error severity. Thus, frequent polling does not fill the views of higher severity.

A request record does not contain inputs, outputs, error details, headers, or query values. You can
trace an operator action, and the logging backend gets no application data. Assets and application
pages do not make these records.

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

### Read the demo log files

The demo writes the same structured records to local files. The demo server and the demo worker
each write to a separate file. The files rotate when they get large.

**Example.** A developer runs the demo in plain mode. A demo worker fails a task.

1. The worker writes its failure record to its own local log file.
2. The developer reads the record in the file. The demo exports nothing.
3. The developer starts the demo again in telemetry mode.
4. The same records now also go to the OTLP backend, in the same format.

Plain mode keeps the local files and does not export traces or metrics. Telemetry mode adds OTLP
export to the same pipeline. Thus, a local record and its copy in the backend have the same format.

<details>
<summary>Reference: demo log files</summary>

- Path: `logs/<environment>/<service>.ndjson` under the repository root.
- `WORKHORSE_DEMO_ENV` sets `<environment>`. The default is `development`.
- A file rotates before it would pass 10,485,760 bytes. The demo keeps five numbered archives.
- `WORKHORSE_DEMO_LOG_DIRECTORY`, `WORKHORSE_DEMO_LOG_MAX_BYTES`, and `WORKHORSE_DEMO_LOG_ARCHIVES`
  override the root, the byte limit, and the archive count.
- `WORKHORSE_DEMO_TELEMETRY = "true"` adds one OTLP log processor plus trace and metric
  instrumentation.

More detail: [Telemetry: Demo log files](../architecture/telemetry.md#demo-log-files).

</details>

## Collect database metrics

The state of all queues is in the database. The metrics of one process cannot show it, so you need
a collector. The [metrics guide](355-observability.md#collect-database-metrics-in-one-service)
explains the two public collectors and their instruments. It also tells how to prevent duplicate
observations.

## Group metrics by task type and queue

**Example.** Your team wants to know which task type got slower after the release on Tuesday.

1. You group the handler duration histogram by task type.
2. The runtime of `invoice.send` is two times longer than before.
3. You group the failures by queue. All failures come from `billing`.

Lifecycle counters and handler timing metrics have the task type and the queue name as attributes.
SigNoz can group throughput, failures, retries, and runtime by either value. To see how frequently
Workhorse combines keyed requests, use the
[enqueue outcome metric](355-observability.md#read-the-signals-together).

Keep the queue names and task types as stable application identifiers. The
[metrics guide](355-observability.md) tells which attributes metrics can carry. It also tells why
values without a bound are not attributes. Traces keep the identity of each task.

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

## Filter each signal by deployment

Set the environment and the service name in the host application. Then you can filter each log,
metric, and trace by deployment.

**Example.** Your staging and production deployments both run `billing` workers. Both send
telemetry to one SigNoz.

1. At startup, each host application sets its environment and service name on its OpenTelemetry
   resource.
2. While the process runs, the SDK adds the two values to each log, metric, and trace.
3. During an incident, an operator opens the Workhorse tasks dashboard in SigNoz and selects
   production.
4. Each panel shows only production.

Set `deployment.environment.name` and `service.name` as OpenTelemetry resource attributes in the
host application. The SDK adds them to logs, metrics, and traces. Thus, Workhorse does not repeat
them at each recording site. Producer calls, such as `Queue.enqueue`, get the same attributes.

`pnpm demo:otel` loads the Workhorse tasks dashboard into SigNoz. To apply dashboard changes
without a restart of SigNoz, run `pnpm signoz:dashboards`. The dashboard variables filter by
environment, service, queue, and task type. The panels show throughput, terminal failures, runtime
percentiles, worker slots, queue pressure, success rate, and the estimated time to empty the queue.

The table of slow tasks ranks task types from handler spans. Trace sampling can change that rank.
For percentiles of one task type without sampling, use the handler histogram.

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

- [355-observability.md](355-observability.md) — collect and read runtime and database metrics
- [310-workers.md](310-workers.md) — where telemetry runs in a deployment
- [320-statistics.md](320-statistics.md) — how the dashboard gets statistics for long windows

---

Exact instruments, attributes, storage bounds, and alert thresholds:
[`architecture/telemetry.md`](../architecture/telemetry.md#opentelemetry-traces-logs-and-baseline-metrics).
