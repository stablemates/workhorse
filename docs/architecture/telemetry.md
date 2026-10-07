# Workhorse architecture: telemetry

This page is part of the [Workhorse architecture reference](../architecture.md). It owns
OpenTelemetry metrics, traces, logs, and baseline metrics.

## OpenTelemetry metrics

### Telemetry provider contract

`@stablemates/workhorse` has no OpenTelemetry dependency or emitted OpenTelemetry import.
`typescript/core/src/telemetry.ts` owns every instrument definition. It routes records through the
process-wide `WorkhorseTelemetryProvider`.

- Its permanent no-op provider discards records until `registerTelemetryProvider(provider)`
  installs one provider.
- Registration rejects another active provider.
- Registration returns an idempotent cleanup function that restores the no-op provider.
- Every log, span, context, and synchronous metric operation reads the current provider.
- `lazyCounter`, `lazyHistogram`, and `lazyGauge` re-create their provider instrument when that
  provider identity changes. Registration may therefore happen after core import.

ADR 0024 records the measurement that selected this lifecycle over module-scope instrument
creation.

### OpenTelemetry adapter

`@stablemates/workhorse-otel` implements the contract. `registerOpenTelemetry()` has no import side
effect. It returns `registerTelemetryProvider()`'s cleanup function.

The adapter declares these peer dependencies:

- `@opentelemetry/api >=1.9.0 <2`
- `@opentelemetry/api-logs >=0.200.0 <0.300.0`
- `@stablemates/workhorse >=0.6.0 <0.7.0`

The adapter resolves tracer, meter, logger, context, and propagation state from those host-owned API
copies. Its synchronous metric and log wrappers re-read the OpenTelemetry global provider. SDK
registration after adapter registration therefore still takes effect.

### Synchronous instruments

Queue and worker operations emit these synchronous instruments:

| Instrument                           | Kind and unit           | Recording point and attributes                                                                                                                                                                                                                   |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workhorse.tasks.enqueued`           | counter, `{task}`       | One accepted `enqueue_batch_v1` member, grouped by `workhorse.queue.name` and `workhorse.task.type`. An outer caller transaction may still roll back after this statement returns.                                                               |
| `workhorse.tasks.enqueue.outcomes`   | counter, `{request}`    | Every `enqueue_many_v1` result, grouped by `workhorse.queue.name` and bounded `workhorse.enqueue.outcome`. Outcomes are `accepted`, `replayed`, `replaced`, `non_replaceable`, and `coalesced`; an outer caller transaction may still roll back. |
| `workhorse.tasks.claimed`            | counter, `{task}`       | One successfully claimed task, by queue and task type. Empty claim polls emit nothing.                                                                                                                                                           |
| `workhorse.tasks.completed`          | counter, `{task}`       | One accepted `complete_v1`, by queue and task type. A rejected stale completion emits nothing.                                                                                                                                                   |
| `workhorse.tasks.failed`             | counter, `{task}`       | One `fail_v1` result, by queue, task type, and `workhorse.attempt.outcome`.                                                                                                                                                                      |
| `workhorse.tasks.retried`            | counter, `{task}`       | Each attempt returned to live work by failure, owned expiry, or bounded recovery, by queue and task type. Recovery rows without dimensions use `unknown` for both.                                                                               |
| `workhorse.tasks.cancellation`       | counter, `{request}`    | One `cancel_v1` result, by `workhorse.cancellation.status`.                                                                                                                                                                                      |
| `workhorse.tasks.redrive`            | counter, `{request}`    | Every result from single or bulk redrive operations, by `workhorse.redrive.status`.                                                                                                                                                              |
| `workhorse.handler.executions`       | counter, `{execution}`  | One worker handler activation, by queue, task type, and `workhorse.handler.outcome`. Outcomes are `succeeded`, `retry`, `failed`, `canceled`, `deadline_exceeded`, `timeout`, `lease_lost`, and `suspended`.                                     |
| `workhorse.handler.duration`         | histogram, `ms`         | Wall-clock duration of the same activation, with the same attributes. An activation that ends without a recorded outcome reports `unknown`. Durable wait suspension closes an activation without closing its logical attempt.                    |
| `workhorse.handler.runtime`          | counter, `ms`           | Cumulative handler execution time by queue and task type.                                                                                                                                                                                        |
| `workhorse.handler.batch.size`       | histogram, `{task}`     | Tasks delivered in one `BatchHandler` invocation, by queue, task type, and bounded full/partial flag.                                                                                                                                            |
| `workhorse.handler.batch.linger`     | histogram, `ms`         | Time from the first member reaching its coordinator until batch dispatch, with the same attributes.                                                                                                                                              |
| `workhorse.claim.duration`           | histogram, `ms`         | One `claim_v1`, `claim_many_v1`, or `complete_many_and_claim_v1` statement, by queue and the bounded `workhorse.claim.result` values `claimed` and `empty`.                                                                                      |
| `workhorse.leases.expired`           | counter, `{lease}`      | Leases recovered by `recover_expired_v1`; zero-result passes emit nothing.                                                                                                                                                                       |
| `workhorse.schedule.fired`           | counter, `{occurrence}` | One `fire_schedule_v1` call that returns a task ID, by schedule namespace and name.                                                                                                                                                              |
| `workhorse.schedule.lag`             | histogram, `s`          | Delay from the planned occurrence to the successful fire, with the schedule attributes.                                                                                                                                                          |
| `workhorse.worker.heartbeat.failure` | counter, `{heartbeat}`  | Every per-task `heartbeat_many_v1` status other than `accepted`, by `workhorse.heartbeat.status`.                                                                                                                                                |
| `workhorse.maintenance.runs`         | counter, `{run}`        | Each maintenance result, by loop, phase, and skipped-lock flag.                                                                                                                                                                                  |
| `workhorse.maintenance.rows`         | counter, `{row}`        | Rows affected by the same result and attributes.                                                                                                                                                                                                 |
| `workhorse.maintenance.duration`     | histogram, `ms`         | SQL-reported duration for the same result and attributes.                                                                                                                                                                                        |
| `workhorse.maintenance.errors`       | counter, `{error}`      | Maintenance results whose `error` is non-null, with the same attributes.                                                                                                                                                                         |
| `workhorse.maintenance.drift`        | histogram, `ms`         | Delay beyond a worker maintenance loop's configured cadence, by loop.                                                                                                                                                                            |

Each lifecycle event reaches exactly one instrument. `workhorse.handler.executions` counts a handler
activation, and `workhorse.handler.duration` times it. Both are dimensioned by outcome. The write
the activation produces is counted at the queue operation that performed it. That counter is
`workhorse.tasks.completed`, `workhorse.tasks.failed`, or `workhorse.tasks.retried`.

### Go worker metrics

The Go worker emits these instruments from the table:

- `workhorse.tasks.claimed`, `workhorse.tasks.completed`, `workhorse.tasks.failed`, and
  `workhorse.tasks.retried`
- `workhorse.leases.expired`
- `workhorse.claim.duration`
- all five `workhorse.handler.*` instruments
- `workhorse.worker.heartbeat.failure`

It uses the same units and attribute keys as the TypeScript runtime. Recovery cannot recover the
original queue and type from its aggregate SQL result. Its retry count therefore uses `unknown` for
both bounded dimensions, matching the TypeScript fallback.

### Metrics observer

`WorkhorseMetricsObserver` lives in `typescript/core/src/metrics-observer.ts`. It records its gauges
through the same lazy lifecycle. It performs two concurrent read-only queries every `intervalMs`.
`intervalMs` defaults to 10,000 and must be a safe integer from 1,000 through 2,147,483,647. Node
runs a longer timer delay every millisecond.

| Member      | Behavior                                                     |
| ----------- | ------------------------------------------------------------ |
| `start()`   | Collects immediately, then repeats on an unreferenced timer. |
| `stop()`    | Clears the timer.                                            |
| `collect()` | Provides a serialized one-shot collection.                   |
| `onError`   | Receives interval failures.                                  |

Applications must run at most one observer per database. Every observer sees the same global
PostgreSQL state.

The timer calls `onError` and does not await it. A reporter may be synchronous or return a promise.
When the reporter throws or its promise rejects, the observer writes that failure to `console.error`.
The failure never becomes an unhandled rejection. A direct `collect()` call rejects to its caller
instead of calling `onError`.

#### Queue query

The queue query is pinned as `metrics_observer` in `protocol/v1/manifest.json`. It joins
`queue_control` for the pause flag. It counts live rows from both `task_runtime` and
`fast_task_runtime`. A fast-tier row has no scheduled state, so a ready row with a future `run_at`
counts as scheduled, as in `queue_health_v1`. The observer records these gauges from it:

- `workhorse.tasks.count` for scheduled, ready, and active rows, by queue and state
- `workhorse.queue.oldest_ready.age`, which is 0 for a queue with no ready task
- `workhorse.queue.paused`
- `workhorse.lease.expired`
- `workhorse.deadline.overdue`
- `workhorse.execution_timeout.overdue`

#### Worker query

The second query groups `worker_registry` rows into mutually exclusive states for every queue in
`queue_names`:

- `running`
- `paused`
- `draining`
- `offline`, meaning the last heartbeat is at least 30 seconds old

The observer then records `workhorse.worker.count`, `workhorse.worker.capacity`, and
`workhorse.worker.active` by queue and worker state.

Capacity and active-slot observations repeat a multi-queue worker under every queue it can serve.
They describe eligible shared capacity per queue. Do not sum them across queue labels.

#### Series that disappear

Every observer gauge is synchronous, so an exporter with cumulative temporality repeats a series'
last recorded value. Each observer therefore remembers the series its last collection recorded.
When a later collection no longer returns a series, the observer records 0 for it once and then
forgets it. This covers a worker group whose workers change state or leave `worker_registry`, and a
queue that no longer has live rows or a `queue_control` row. A failed collection records nothing
and keeps the remembered series for the next collection.

#### Observer attributes

The observer never uses these values as metric attributes: task IDs, worker IDs, payloads, error
text, cancellation attribution, or redrive attribution.

## OpenTelemetry traces, logs, and baseline metrics

### Host setup

The TypeScript host performs these steps:

1. Install `@stablemates/workhorse-otel` and compatible API peers.
2. Configure the OpenTelemetry context manager, propagator, readers, processors, exporters, and
   resource.
3. Call `registerOpenTelemetry()` once.

Importing core or the adapter does not register a provider. Queue correctness is unchanged when the
adapter or an SDK is absent.

The operational instruments above provide the detailed queue, task type, outcome, and fleet
dimensions. The bundled SigNoz dashboards use those dimensions. The baseline instruments below
retain a smaller attribute set for deployments that enforce a fixed cardinality cap.

### Go worker setup

The Go worker imports only `go.opentelemetry.io/otel`, `otel/metric`, and `otel/trace` in production
files. Its SDK metric and trace packages are test dependencies.

The application installs global providers and a W3C `propagation.TraceContext`. Without them, the
API instruments are no-ops.

The Go worker accepts an optional `*slog.Logger` as `WorkerOptions.Logger`. A nil logger uses a
disabled handler, so routine lifecycle records do not write to the process default logger.

### Trace context propagation

Each enqueue path stores a W3C trace context in the new task's `task.trace_context`:

- TypeScript `Queue.enqueueMany` creates `workhorse.enqueue` and injects that span's context.
- Python `Queue.enqueue_many` and `AsyncQueue.enqueue_many` inject the active caller context.
- Go `Queue.EnqueueMany` injects the active caller context.

Each language enforces 1,024 bytes before enqueue. The constants are TypeScript
`MAX_TRACE_CONTEXT_BYTES`, Python `_telemetry.MAX_TRACE_CONTEXT_BYTES`, and Go
`maxTraceContextBytes`.

The `task.trace_context` column has these rules:

- It accepts only `traceparent` and optional `tracestate`.
- It requires `traceparent`.
- It caps canonical JSONB text at the same size.
- It is separate from `task.payload` and is excluded from operator projections.
- An idempotent replay keeps the first accepted context.
- Baggage is never persisted.

`claim_v1` returns the stored value. Each worker extracts it before creating the `workhorse.handler`
consumer span. The Go worker performs the same extraction and creates the same consumer span. A
stored enqueue or caller context can therefore parent any language's handler span.

Every worker parents a handler span only to its task's stored context. A task without one starts a
new trace, even when a span is active where the worker runs. Each worker achieves this as follows:

- TypeScript extracts a stored context onto `ROOT_CONTEXT`.
- Python `_telemetry.start_span` starts a consumer span from an empty `Context` and extracts a
  stored context onto it.
- Go `extractTraceContext` replaces the span in the worker's context with an empty span context
  before extraction. The Go handler context keeps the worker context's cancellation and values.
- Rust `telemetry::handler_span` sets the span's OpenTelemetry parent to the stored context, or to
  an empty `Context`. The `tracing` span keeps its contextual parent, so its log events still nest
  under the caller's `tracing` span.
- Ruby `Telemetry.span` starts a consumer span from `OpenTelemetry::Context.empty` and extracts a
  stored context onto it.

Child tasks prefer the parent task's stored context over the ambient handler context. Replay
therefore preserves the original trace chain.

### Spans

#### TypeScript spans

The TypeScript runtime emits these spans:

- `workhorse.enqueue`
- `workhorse.claim`
- `workhorse.handler`
- `workhorse.heartbeat`
- `workhorse.retry`
- `workhorse.complete`
- `workhorse.recovery`
- `workhorse.maintenance`
- `workhorse.schedule.synchronize`

Span attributes may include `workhorse.task.id`, `workhorse.task.type`, `workhorse.task.attempt`,
and `workhorse.queue.name`. Spans may carry these because spans are sampled event records rather
than metric dimensions. Single-request enqueue spans also carry the bounded
`workhorse.enqueue.outcome` returned by PostgreSQL.

A worker probes an unfamiliar queue with a fast claim. When the queue is on the full tier, the
`workhorse.claim` span ends without an error status. It carries `workhorse.queue.tier = "full"`.

Workhorse emits at most eight attributes on one span. It exports `TRACE_ATTRIBUTE_COUNT_LIMIT = 8`
for matching SDK span limits.

#### Go spans

The Go worker's `workhorse.handler` span carries these attributes:

- `workhorse.queue.name`
- `workhorse.task.id`
- `workhorse.task.type`
- `workhorse.task.attempt`
- the bounded `workhorse.handler.outcome`

#### Python spans

The synchronous Python worker emits `workhorse.claim`, `workhorse.handler`, `workhorse.heartbeat`,
`workhorse.retry`, `workhorse.complete`, `workhorse.recovery`, and `workhorse.maintenance`. They
have the same attributes and parent relationships as the TypeScript spans.

`python/src/workhorse/_telemetry.py` exports `TRACE_ATTRIBUTE_COUNT_LIMIT = 8` and
`METRIC_ATTRIBUTE_CARDINALITY_LIMIT = 2,000`.

The `stablemates-workhorse[telemetry]` extra installs `opentelemetry-api` but no SDK. Both of these
cases preserve worker behavior:

- If the API extra is absent, the module supplies local no-op instruments.
- If the API is present without an SDK, OpenTelemetry's providers remain no-ops.

### Structured logs

The TypeScript runtime submits vendor-neutral structured records to `WorkhorseTelemetryProvider`.
The OpenTelemetry adapter emits them through `@opentelemetry/api-logs`. The Python worker uses
`opentelemetry._logs` for the matching worker event names.

#### Severity coverage

| Severity | Records cover                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debug    | Enqueue acceptance and replay, claims, accepted heartbeats, handler registration and execution boundaries, checkpoints, progress, schedule replay, and worker deregistration.                                                             |
| Info     | Queue and worker lifecycle, final execution outcomes, rejected heartbeats, completion and failure, cancellation, durable waits, promotion and recovery, schedule changes, redrive, and maintenance that changes rows or returns an error. |
| Warning  | Handlers that catch a durable-wait suspension signal and return normally.                                                                                                                                                                 |

#### Debug event names

- `workhorse.task.enqueued`
- `workhorse.task.enqueue_replayed`
- `workhorse.task.claimed`
- `workhorse.task.heartbeat_accepted`
- `workhorse.task.checkpoint_saved`
- `workhorse.task.progress_updated`
- `workhorse.handler.registered`
- `workhorse.handler.started`
- `workhorse.handler.finished`
- `workhorse.schedule.fire_replayed`
- `workhorse.worker.registered`
- `workhorse.worker.deregistered`

#### Info event names

- `workhorse.tasks.promoted`
- `workhorse.leases.recovered`
- `workhorse.queue.paused`
- `workhorse.queue.resumed`
- `workhorse.queue.tier_set`
- `workhorse.queue.purged`
- `workhorse.schedules.synchronized`
- `workhorse.schedule.fired`
- `workhorse.tasks.redrive_processed`
- `workhorse.task.run_now_requested`
- `workhorse.task.cancellation_processed`
- `workhorse.task.cancellation_acknowledged`
- `workhorse.task.redrive_processed`
- `workhorse.task.wait_processed`
- `workhorse.task.child_processed`
- `workhorse.task.completed`
- `workhorse.task.completion_rejected`
- `workhorse.task.failure_processed`
- `workhorse.task.heartbeat_rejected`
- `workhorse.task.ownership_expired`
- `workhorse.task.execution_finished`
- `workhorse.worker.paused`
- `workhorse.worker.resumed`
- `workhorse.worker.registration_failed`
- `workhorse.worker.started`
- `workhorse.worker.stop_requested`
- `workhorse.worker.stopped`

`workhorse.retention_policy.synchronized` and `workhorse.maintenance_policy.synchronized` record
successful configuration changes at info.

#### Conditional events

| Event                              | Severity and condition                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workhorse.maintenance.completed`  | Info, emitted only when the phase changes rows or returns an error. Successful no-ops and skipped advisory locks emit no log; maintenance counters and duration histograms still record them. |
| `workhorse.worker_registry.pruned` | Debug when no stale registrations exist. Info when PostgreSQL removes registrations.                                                                                                          |

#### Warning event names

- `workhorse.handler.signal_swallowed` carries bounded task and worker identity plus
  `workhorse.handler.outcome`. It never carries the swallowed value or error.
- `workhorse.worker.polling_only` carries `workhorse.worker.id` and `workhorse.worker.queues`. A
  `Worker.run()` that starts without a notification subscription emits it once.

#### Log record attributes

The internal `logDebug`, `logInfo`, and `logWarn` functions accept the closed `WorkhorseLogEvent`
union. They set `eventName`, `severityNumber`, `severityText`, and a stable text body.

| Record kind | Attributes                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task        | May use `workhorse.task.id`, `workhorse.task.type`, `workhorse.task.attempt`, `workhorse.task.state`, and `workhorse.operation.status`. Owned transitions add `workhorse.worker.id`. |
| Queue       | Use `workhorse.queue.name` and may add `workhorse.task.count`.                                                                                                                       |
| Schedule    | May use `workhorse.schedule.namespace`, `workhorse.schedule.name`, and `workhorse.schedule.count`.                                                                                   |
| Recovery    | Use `workhorse.recovery.rows_affected`, `workhorse.recovery.expired_leases`, and `workhorse.recovery.retried`.                                                                       |
| Redrive     | May use `workhorse.redrive.target_task_id` and `workhorse.redrive.dry_run`.                                                                                                          |
| Durable     | Use the bounded status plus `workhorse.checkpoint.name` or `workhorse.wait.name`. They never use the stored value.                                                                   |
| Maintenance | Use `workhorse.maintenance.operation`, `workhorse.maintenance.phase`, `workhorse.maintenance.rows_affected`, and `workhorse.maintenance.skipped_lock`.                               |
| Worker      | Life-cycle records use `workhorse.worker.queues` for the complete configured queue array. Registration records may also use concurrency, active slots, draining, and pause state.    |
| Handler     | Completion adds `workhorse.handler.duration_ms`.                                                                                                                                     |

#### Worker registration logs

`Worker.refreshRegistration` emits `workhorse.worker.registered` in two cases:

- after the first successful registration
- when `activeSlots`, `draining`, or the PostgreSQL-owned pause result changes

The durable heartbeat still runs at `registryIntervalMs`. An unchanged refresh emits no log.

#### Log content limits

Logs may include task, worker, schedule, and checkpoint identity because logs are event records.

Workhorse never logs these values:

- payloads
- results
- error messages
- cancellation reasons
- idempotency keys
- progress and checkpoint values

The active OpenTelemetry context remains attached at emission. An SDK can therefore correlate
handler logs with the current trace. If the host installs no Logs SDK, the API remains a no-op and
queue behavior is unchanged.

### Dashboard host

#### RPC body limit

`createDashboardHost` reads at most `MAX_RPC_BODY_BYTES`, 131,072 bytes, of an RPC request body.

- A request that declares a larger `content-length` receives `413` with the `PAYLOAD_TOO_LARGE`
  error envelope. This happens before any procedure is matched.
- oRPC's `BodyLimitPlugin` enforces the same bound on a body that declares no length while it is
  read.

The bound is twice the 65,536-byte cap the database places on a signal payload or a human-wait
result. Every `audit.reason` accepts at most 2,000 characters, the limit the database enforces.

The embedded SDK hosts read at most 2,097,152 bytes (`2 << 20`) of an RPC request body.

- Python `DashboardHost` (`_MAX_REQUEST_BYTES`) and Ruby `Dashboard` (`MAX_REQUEST_BYTES`) answer
  `413` with the `PAYLOAD_TOO_LARGE` envelope before reading when the declared length is larger or
  is not decimal digits. Without a declared length they read at most one byte past the bound and
  answer `413` when that byte arrives. Python reads such a body only when the server sets
  `wsgi.input_terminated`.
- Go `Handler` decodes the first JSON value from at most the bound. An envelope that crosses the
  bound fails decoding with `400`. Bytes after a complete envelope are never read.
- Rust `MAX_REQUEST_BYTES` bounds the body with `http_body_util::Limited`; a longer body answers
  `400`.

#### RPC logs

`createDashboardHost` emits one OpenTelemetry log after `RPCHandler` returns a matched dashboard RPC
response.

| Event                               | Severity and condition                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `workhorse.dashboard.rpc_completed` | Debug below 1,000 milliseconds. Warning at or above 1,000 milliseconds. |
| `workhorse.dashboard.rpc_failed`    | Error for an HTTP status of 400 or greater.                             |

Both events set these attributes:

- `rpc.system = "orpc"`
- `rpc.method`, the dot-separated procedure path
- `http.response.status_code`
- `workhorse.dashboard.rpc.duration_ms`
- `workhorse.dashboard.workspace`, the serving workspace name, in workspaces mode only.
  Single-workspace mode omits the attribute.

They never include the request input, response output, error details, headers, or URL query.

Dashboard assets, application pages, authorization failures, and schema compatibility failures do
not produce these RPC records. Without a Logs SDK, the OpenTelemetry API discards them.

#### Compatibility check records

When the schema-compatibility check fails without a compatibility verdict, such as a query that
cannot reach the database, `createDashboardHost` emits one error record,
`workhorse.dashboard.compatibility_check_failed`. It carries these attributes:

- `exception.message`, the text of the underlying error
- `workhorse.dashboard.workspace`, in workspaces mode only

A compatibility verdict, such as a schema that is too old, emits no record. Its version message is
the `503` answer.

#### Workspace records

In workspaces mode `createDashboardHost` also emits one info record at construction,
`workhorse.dashboard.workspaces_configured`. It carries these attributes:

- `workhorse.dashboard.workspace_count`
- `workhorse.dashboard.workspace_names`
- `workhorse.dashboard.default_workspace`

Single-workspace mode emits no construction record.

The demo states its workspace mode at startup:

- `workhorse.demo.workspaces_enabled` when `DATABASE_URL_SECONDARY` provisions the staging
  workspace
- `workhorse.demo.single_workspace_fallback` when the variable is absent and the dashboard serves a
  single workspace

### Demo server

#### Write rate limit

The demo HTTP server applies a process-local token bucket to writable dashboard RPC paths.

- Each client may spend a burst of five tokens.
- Tokens refill at twelve per minute.
- The server selects the right-most `X-Forwarded-For` address appended by the trusted deployment
  proxy. It falls back to the socket address.
- It retains at most 10,000 client buckets. Above that bound it evicts the least recently used
  bucket.
- Rejected requests return `429`, `Retry-After`, and `Cache-Control: no-store`. The rejection
  happens before the request reaches the dashboard host or appends an audit row.
- Reads, assets, login routes, and `/up` do not spend tokens.

#### Request bounds

The demo server applies three further bounds before a request reaches the application:

1. A request whose declared `Content-Length` exceeds 131,072 bytes is refused with `413`. A `POST`,
   `PUT`, or `PATCH` that arrives with `Transfer-Encoding` but no declared length is refused with
   `411`.
2. At most four operator mutations may execute concurrently. Admissions beyond that answer `503`
   with `Retry-After`.
3. `server.requestTimeout` is set to 60,000 milliseconds. It also bounds how slowly an in-limit body
   may arrive.

`createDemoRequestListener` returns a mutation's slot when the application's answer settles, not
when the response closes. A client that disconnects mid-mutation therefore keeps its slot until the
mutation's transaction ends. A mutation whose client leaves before the application starts it is not
started.

The application has `DEMO_REQUEST_TIMEOUT_MS`, 60,000 milliseconds, to answer. Past it the client
receives `504`, and the slot stays held until the work settles.

`runOperatorTransaction` sets a transaction-local `statement_timeout` of
`DEMO_OPERATOR_STATEMENT_TIMEOUT_MS`, 10,000 milliseconds. That bounds each statement of an operator
transaction, not the transaction as a whole.

#### Operator work budget

Independently of the HTTP layer, every RPC that creates tasks shares a budget of
`DEMO_OPERATOR_MAX_PENDING_TASKS`, 50 tasks. Those RPCs are `enqueueTest`, `redriveTask`, and
`redriveDeadLetters`.

`assertDemoOperatorWorkBudget` counts these rows:

- `task_runtime` rows in `ready` or `active` state
- `fast_task_runtime` rows that are `active`, or `ready` with `run_at <= statement_timestamp()`

A fast-tier task delayed into the future does not count. Scheduled and blocked tasks do not count.
The count uses `statement_timestamp()` because `now()` predates the lock wait. Fast-tier work
committed during that wait would otherwise look delayed.

Each admission first takes `pg_advisory_xact_lock(hashtext('workhorse-demo:operator-work-budget'))`.
Concurrent admissions therefore count each other's committed work and cannot overshoot the budget.

- An RPC refuses with `TOO_MANY_REQUESTS` unless the budget has room for every task it creates.
- A feature example of `enqueueTest` seeds up to three tasks.
- `redriveDeadLetters` clips its `limit` to the remaining room and returns a continuation cursor.
  The audit row records `admittedLimit` beside `limit`.
- Mutations that act on existing tasks stay available under saturation.

#### Audit retention

`public.workhorse_demo_audit` retains rows for seven days. The demo server deletes the oldest 1,000
expired rows once at startup and once per minute, using the `(occurred_at, id)` index. One pass can
therefore reclaim more rows than the rate limiter can admit between passes.

- A failed periodic pass emits `workhorse.demo.audit_retention_failed`.
- A failed startup pass prevents the server from accepting traffic.

#### Demo log files

The demo preload always installs one `NodeSDK` and one rotating file log processor. It writes NDJSON
to `logs/<environment>/<service>.ndjson` under the repository root. The preload resolves the root
from its own location rather than the working directory.

`WORKHORSE_DEMO_ENV` supplies these values and defaults to `development`:

- the dashboard environment, `<environment>`
- the OpenTelemetry `deployment.environment.name` and `deployment.environment` resource attributes

The preload rotates before the next record would take the current file past 10,485,760 bytes. It
retains five numbered archives. These variables override the defaults:

| Variable                       | Overrides     |
| ------------------------------ | ------------- |
| `WORKHORSE_DEMO_LOG_DIRECTORY` | root          |
| `WORKHORSE_DEMO_LOG_MAX_BYTES` | byte limit    |
| `WORKHORSE_DEMO_LOG_ARCHIVES`  | archive count |

The server and worker use different `service.name` values, so they never write the same file.

If `WORKHORSE_DEMO_TELEMETRY = "true"`, the same SDK adds exactly one OTLP log processor plus
automatic trace and metric instrumentation. Otherwise trace and metric exporters are disabled while
local structured logs remain active.

### Baseline queue metrics

`registerQueueMetrics` adds these observable instruments. The meter reads them at collection time
rather than on an emission path.

- `workhorse.queue.depth` is an observable gauge split by `workhorse.queue.name` and the
  `workhorse.task.state` values `ready`, `scheduled`, and `active`.
- `workhorse.queue.oldest_ready_age` is an observable gauge in milliseconds, split by
  `workhorse.queue.name`.
- `workhorse.queue.concurrency.limit` is the queue's configured active-task limit.
- `workhorse.queue.concurrency.active` counts active rows with unexpired leases in governed queues.
- `workhorse.queue.concurrency.blocked_ready` reports bounded ready work that policy admission
  rejects.
- `workhorse.queue.dependencies.blocked`, `workhorse.queue.dependencies.pending_edges`, and
  `workhorse.queue.dependencies.failed_resolutions` report bounded dependency pressure by queue.
  `workhorse.queue.dependencies.capped` reports lower-bound samples. None uses stable task
  identities as attributes.
- `workhorse.queue.children.waiting_parents`, `workhorse.queue.children.pending`,
  `workhorse.queue.children.unjoined_results`, `workhorse.queue.children.failed_parents`, and
  `workhorse.queue.children.canceled_parents` report bounded child orchestration by parent queue.
  `workhorse.queue.children.capped` reports lower-bound samples.
- `workhorse.queue.rate_limit.configured`, `workhorse.queue.rate_limit.available_tokens`,
  `workhorse.queue.rate_limit.throttled_ready`, and
  `workhorse.queue.rate_limit.next_eligible_delay` report rate-policy state for governed queues.

#### Shared aggregates

`workhorse.queue.depth` and `WorkhorseMetricsObserver`'s `workhorse.tasks.count` measure the same
live work. Both use manifest-pinned statements. `queue_health_v1`, `queue_metric_snapshot`, and
`metrics_observer` in `protocol/v1/manifest.json` own their exact aggregates over
`workhorse.task_runtime` and `workhorse.fast_task_runtime`. Each counts a fast-tier ready row with a
future `run_at` as scheduled.

Every count aggregates the `task_id` primary key. A queue with no runtime rows therefore reports
zero across the outer join rather than one. Callers supply their own queue-name source and name the
aggregates they need. No caller writes its own aggregate.

#### Registration lifecycle

`registerQueueMetrics(queue)` stores the database-wide observation in core and returns a cleanup
function.

- If the no-op provider is active, core activates the observation when a provider registers.
- Provider cleanup detaches it.
- Later provider registration attaches it again until the queue cleanup runs.

Register it once per database and telemetry resource. Registering it for every worker duplicates
observations.

`Queue.queueMetricSnapshot()` groups live pressure by every queue present in any of these sources:

- `task_runtime`
- `queue_control`
- any `worker_registry.queue_names` member
- `concurrency_policy`
- `rate_limit_policy`
- `Queue.defaultQueue`

Concurrency metrics carry only `workhorse.queue.name`. Raw key values never become metric
attributes.

### Metric attributes

| Instruments                                                     | Attributes                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Lifecycle counters and handler instruments                      | `workhorse.queue.name` and `workhorse.task.type`                                 |
| `workhorse.tasks.enqueue.outcomes`                              | Queue and bounded `workhorse.enqueue.outcome`, without task type or key material |
| `workhorse.handler.executions` and `workhorse.handler.duration` | Add the bounded `workhorse.handler.outcome`                                      |
| `workhorse.tasks.failed`                                        | Also uses the bounded `workhorse.attempt.outcome`                                |
| Claim latency                                                   | `workhorse.queue.name` and the bounded `workhorse.claim.result`                  |
| Maintenance instruments                                         | Retain their bounded loop attribute                                              |

The `workhorse.attempt.outcome` values are those `fail_v1` returns: `ready`, `scheduled`, `failed`,
`cancel_requested`, `deadline_exceeded`, `timeout_exceeded`, and `stale`.

Task IDs, worker IDs, schedule names, namespaces, tags, payload values, and error messages remain
forbidden metric attributes.

### Python worker metrics

The Python worker records these worker instruments:

- `workhorse.tasks.claimed`, `workhorse.tasks.completed`, `workhorse.tasks.failed`, and
  `workhorse.tasks.retried`
- `workhorse.claim.duration`
- `workhorse.handler.duration`, `workhorse.handler.runtime`, `workhorse.handler.executions`,
  `workhorse.handler.batch.size`, and `workhorse.handler.batch.linger`
- `workhorse.worker.heartbeat.failure`

Maintenance and schedule firing also record these instruments:

- `workhorse.leases.expired`
- `workhorse.schedule.fired` and `workhorse.schedule.lag`
- `workhorse.maintenance.runs`, `workhorse.maintenance.rows`, `workhorse.maintenance.duration`, and
  `workhorse.maintenance.errors`

Their attributes follow the same restrictions and bounded outcome vocabularies as the TypeScript
instruments.

### Cardinality

Queue and task type multiply the number of time series. Applications must keep both as stable
identifiers. Applications must not embed customer or request identity in either value.

Workhorse exports `METRIC_ATTRIBUTE_CARDINALITY_LIMIT = 2,000` for applications that configure
explicit reader limits. The value matches the OpenTelemetry JavaScript SDK default. Values beyond
the configured SDK limit enter its overflow series.

### Dashboards and alerts

The host sets deployment-wide filters as OpenTelemetry resource attributes:

- `deployment.environment.name` for the environment
- `service.name` for the emitting process

The SigNoz v6 import artifact at `docs/signoz/workhorse-business-metrics-v1.json` defines dynamic
environment, service, queue, and task-type variables.

Start production dashboards with these panels:

- ready and scheduled depth
- oldest-ready age
- claiming and handler latency percentiles
- rates for enqueueing, claiming, and completing tasks
- failure and retry rates
- expired leases
- maintenance drift

| Condition                                                                  | Alert                     | Critical                     |
| -------------------------------------------------------------------------- | ------------------------- | ---------------------------- |
| Ready depth stays above zero while claiming and completion rates stay zero | for 5 minutes             | for 15 minutes               |
| Maintenance drift, for three consecutive observations                      | exceeds twice the cadence | above five times the cadence |
| Expired leases as a share of tasks workers claim, over 10 minutes          | exceeds 1%                | —                            |
| Failures as a share of handler settlements, over 10 minutes                | exceeds 5%                | above 20%                    |

Replace the age and latency thresholds with the application's queue-delay and handler-duration SLOs
rather than using a library-wide guess.

### Telemetry overhead scenario

The `telemetry-context` operational scenario compares full enqueue and claiming durations for equal
baseline and instrumented cohorts. The instrumented cohort activates in-memory span and metric
exporters.

The scenario verifies these properties:

- exports
- payload isolation
- context recovery
- the absence of a dispatch index

Its stable order makes the timings diagnostic rather than a performance claim.
