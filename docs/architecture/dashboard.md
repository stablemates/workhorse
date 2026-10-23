# Workhorse architecture: dashboard

This page is part of the [Workhorse architecture reference](../architecture.md). It owns the
`dashboard/v1` wire contract and the dashboard package boundary.

## Dashboard wire contract

`dashboard/v1` is the language-neutral contract an embedded dashboard backend implements (ADR
0029).

### Contract artifacts

`dashboard/v1/manifest.json` declares:

- format 1, contract 1, and read surface 1;
- the oRPC RPC transport envelope;
- the delegated-authentication and same-origin CSRF expectations;
- each procedure's mutation flag.

`dashboard/v1/procedures.json` carries every procedure's URL path, request-input JSON Schema, and
response JSON Schema. Shared wire types live under `$defs`. Its `html` section defines the
application document:

| Key                              | Value                                             |
| -------------------------------- | ------------------------------------------------- |
| `html.runtimeConfigPlaceholder`  | `/*__WORKHORSE_RUNTIME_CONFIG__*/`                |
| `html.browserModulesPlaceholder` | `<!--__WORKHORSE_BROWSER_MODULES__-->`            |
| `html.runtimeConfig`             | the complete `DashboardRuntimeConfig` JSON Schema |

`dashboard/v1/README.md` specifies the envelope, error codes, request handling order, and the
application-serving surfaces.

### Contract versioning

The contract version belongs to these artifacts, not the HTTP path.

- Each SDK release binds one backend to the matching contract and browser bundle. It serves that
  pair at its configured mount path.
- A release that moves to `dashboard/v2` ships its matching pair. Its release notes give operators
  the transition steps.
- Existing installations keep their bound pair until their operators upgrade them.
- The host does not negotiate concurrent contract versions. It therefore sends no `Deprecation` or
  `Sunset` response headers.

### Shared type names

Every `$defs` key carries the `Dashboard` prefix. This rule applies also when the TypeScript symbol
that the key comes from has no prefix. `dashboardDefinitionName` in
`typescript/dashboard-server/spec/response-schemas.ts` applies that rule. The
`names every shared wire type with the Dashboard prefix` test in
`typescript/dashboard-server/test/dashboard-spec.test.ts` pins it to the committed artifact.

The rule prevents a duplicate type in generated bindings. Without the rule, a core type that
reaches a dashboard response gets a second copy. That copy is beside the core type that the same
SDK already exports. The contract keys all of these core types with the prefix:

- `CancelStatus`
- `SignalDeliveryStatus`
- `HumanWaitCompletionStatus`
- `Json`
- `QueueHealthReason`
- `QueueHealthReasonCode`
- `RetentionPolicyImpact`

The prefix names the contract's schema, not the TypeScript symbol. Thus the core type stays the
one source of the shape. `generate-bindings.ts` resolves a procedure input's local `__schema0` to the
shared `DashboardJson`. `z.toJSONSchema` names `__schema0` inside that input document.

### Artifact generation

The committed dashboard artifacts are the authority, and `dashboardRouter` is their generator. The
SQL flow has the opposite ownership. There, `sql/schema/current.sql` is the tracked authority, and
the build generates `sql/schema.sql` from it.

`typescript/dashboard-server/spec/generate.ts` derives the schemas from two sources:

- input schemas from the router's Zod inputs via `z.toJSONSchema`;
- response schemas from the checker-resolved `DashboardV1Responses` in
  `typescript/dashboard-server/spec/responses.ts`.

`pnpm dashboard-spec:generate` rewrites the artifacts. `pnpm dashboard-spec:check` and
`typescript/dashboard-server/test/dashboard-spec.test.ts` fail on any divergence. Thus a router change
that changes the wire contract can merge only with regenerated, reviewed artifacts. The spec
commands run `dashboard-bindings:generate` or `dashboard-bindings:check` after the artifact step.

#### Go and Python bindings

`typescript/dashboard-server/spec/generate-bindings.ts` reads `procedures.json` and emits
`go/dashboard/v1_generated.go` and `python/src/workhorse/dashboard_v1.py`. Those files contain the
request and response types and `DashboardRuntimeConfig`.

| Binding                | Go                                                         | Python                                                                        |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `DashboardJson`        | no declaration; Go spells an arbitrary JSON value `any`    | `DashboardJSON`, a recursive union, the only way to type the same value there |
| Validation entry point | `ValidateInput`                                            | `validate_input`                                                              |
| Per-procedure wrapper  | one `Validate<Procedure>Input` per procedure               | one `validate_<procedure>_input` per procedure                                |
| Internal interpreter   | `validateSchema`, using `number` for JSON numeric coercion | `_validate_schema`                                                            |
| Validation error       |                                                            | raises `DashboardInputValidationError`                                        |

#### Runtime configuration schema

The internal `dashboardRuntimeConfigSchema` in `typescript/dashboard-server/src/server/html.ts` is
the source of the exported `DashboardRuntimeConfig` through `z.infer`. `z.toJSONSchema` writes the
same schema to `procedures.json.html.runtimeConfig`. Thus the server type and the versioned schema
cannot differ.

### Conformance fixtures

`dashboard/v1/conformance.json` adds executable HTTP-level conformance fixtures similar to
`protocol/v1/scenarios.json`:

1. SQL seed steps put a newly installed schema in a known state.
2. Golden request/response exchanges cover every procedure, the error envelope, the same-origin
   mutation rejection, and read-only `FORBIDDEN` behavior.

`scripts/verify-dashboard-conformance.ts` executes the fixtures and enforces that coverage.
`typescript/dashboard-server/test/conformance.test.ts` binds the TypeScript server as the reference
implementation that must pass them. `pnpm dashboard-conformance:generate` regenerates the golden
`expect` blocks from that server. `dashboard/v1/README.md` specifies the fixture format and the
harness a backend under test must present.

### Python backend

`workhorse.dashboard.DashboardHost` is the Python WSGI backend. Its constructor takes one
caller-owned Psycopg connection plus these arguments:

- `authorize`, `path`, `environment`, `audit_actor`, `read_only`;
- `browser_modules`, `configured_workers`, `maintenance_loops`, `allowed_hosts`;
- the optional `enqueue_test` extension.

The connection must have `autocommit=True`. The host rejects transactional connections. Thus a WSGI
request cannot leave locks or an idle transaction open.

`DashboardPrincipal.actor` is the authenticated identity. `DashboardResponse` lets the authorization
hook return a complete denial or redirect response. `audit_actor` names the actor only when
`authorize` returns `True`. Its default is `dashboard`.

The host handles a request in this order:

1. A non-empty `allowed_hosts` refuses any other `HTTP_HOST` with 421.
2. `authorize` runs.
3. `assert_sync_compatible` runs.
4. The host rejects cross-origin mutations, before decoding input.
5. It validates through `dashboard_v1.validate_input`.
6. It overwrites `audit.actor`.
7. It calls the private `workhorse.dashboard._backend.DashboardBackend`.

The backend's `procedures()` implements the database-owned contract procedures through versioned
dashboard views and lifecycle functions. `previewRetentionPolicy` calls
`dashboard_retention_preview_v1`, as every host does. The host supplies `enqueueTest` and
`setSchedulePaused`. The behavior of these two procedures belongs to the embedding runtime.
`python/tests/test_dashboard_conformance.py` executes all six scenarios and all 81 exchanges
against both writable and read-only hosts.

### Procedure document functions

These functions return their complete `dashboard/v1` response documents:

- `workhorse.dashboard_tasks_v1(p_input jsonb)`
- `workhorse.dashboard_queues_v1(p_input jsonb)`
- `workhorse.dashboard_task_counts_v1(p_input jsonb)`
- `workhorse.dashboard_task_facets_v1(p_input jsonb)`
- `workhorse.dashboard_activity_v1(p_input jsonb)`
- `workhorse.dashboard_events_v1(p_input jsonb)`
- `workhorse.dashboard_task_detail_v1(p_input jsonb)`
- `workhorse.dashboard_human_waits_v1(p_input jsonb)`
- `workhorse.dashboard_retention_preview_v1(p_input jsonb)`. It merges the input `definition` into
  the effective retention policy. An absent setting keeps its effective value, and an explicit null
  disables its category. It returns the `RetentionPolicyImpact` document: each count is capped at
  10,000, and `capped` is true for a count with more eligible rows.

Two functions return one document or SQL `NULL`:

- `workhorse.dashboard_checkpoint_value_v1(p_input jsonb)` returns one complete checkpoint
  document. It returns SQL `NULL` when the task has no checkpoint of that name.
- `workhorse.dashboard_event_detail_v1(p_input jsonb)` returns one complete event-detail document.
  It returns SQL `NULL` when the stable event identity does not exist.

TypeScript, Python, Go, Rust, Ruby, JVM, and .NET hosts validate the wire input. They call the matching
function and decode its single `jsonb` result. The TypeScript host can add its application-owned
durability summary after `dashboard_tasks_v1` or `dashboard_task_detail_v1` returns.
`DashboardDurabilityProjector` is an in-process callback, not database state.

### Go backend

`dashboard.NewHandler` is the Go `net/http` backend. `HandlerOptions` takes a caller-owned
`workhorse.Executor` plus these options:

- `Authorize`, `Path`, `Environment`, `ReadOnly`;
- `BrowserModules`, `ConfiguredWorkers`, `MaintenanceLoops`, `AllowedHosts`;
- optional `Procedures` extensions.

A non-empty `AllowedHosts` refuses any other `Request.Host` with 421 before `Authorize` runs.
`Principal.Actor` supplies authenticated attribution. `Authorization.Response` can supply a
complete denial or redirect.

The handler preserves the same authorization, compatibility, CSRF, validation, attribution, and
dispatch order as Python. `RPCError` carries defined status, code, message, and data.

`typescript/dashboard-server/test/go-conformance.test.ts` runs the shared fixture verifier against
the Go HTTP backend. `go/dashboard/cmd/conformance` supplies the contract's `enqueueTest` and
`setSchedulePaused` extensions and the writable/read-only deployments.

### JVM backend

`run.workhorse.dashboard.Dashboard` is the JVM backend. It implements
`jakarta.servlet.Filter`. `Dashboard.builder(ConnectionSource connections, DashboardAuthorizer
authorize)` returns a `Dashboard.Builder` with these options and defaults:

| Option              | Default                     |
| ------------------- | --------------------------- |
| `path`              | `"/workhorse"`              |
| `environment`       | `"development"`             |
| `auditActor`        | `"dashboard"`               |
| `readOnly`          | `false`                     |
| `browserModules`    | empty                       |
| `configuredWorkers` | empty                       |
| `maintenanceLoops`  | `{"tickIntervalMs": 1000}`  |
| `allowedHosts`      | empty                       |
| `procedures`        | empty                       |
| `enqueueTest`       | unset, so the procedure 403 |
| `setSchedulePaused` | unset, so the procedure 403 |
| `codec`             | `JsonCodec.standard()`      |

The Kotlin module adds no dashboard API. A Kotlin application uses the Java API.

`DashboardAuthorizer.authorize(HttpServletRequest)` returns a sealed `DashboardAuthorization`:
`principal(actor)`, `allow()`, `deny()`, or `response(status, headers, body)`. `Principal.actor` is
the authenticated identity. `auditActor` names the actor only when `authorize` returns `allow()`.
`deny()` answers 401 with `{"error":"Unauthorized"}`.

`response` lets the authorizer give a
complete denial or redirect, as Ruby's Rack response and Python's `DashboardResponse` do. The filter
sends its status, headers, and body as-is. `response` copies the headers and the body, and throws
`IllegalArgumentException` for a status outside 100 through 599.

If `authorize` throws a
checked exception other than `IOException` or `ServletException`, the filter wraps it in a
`ServletException`.

The filter reads the request path as `getRequestURI()` less `getContextPath()`. `owns(path)` is true
for the base path and for each path under it. The filter passes any other request, and any request
that is not HTTP, to `chain.doFilter`. Thus the host's own servlets still answer it.

The filter handles a request that it owns in this order:

1. A non-empty `allowedHosts` refuses any other `Host` with 421, before `authorize` runs.
2. `authorize` runs. A `deny()` or a `response` ends the request here.
3. The schema compatibility check runs. The filter caches only a passing answer.
4. The filter rejects a mutation that is not same-origin with 403, before it decodes the input. It
   then rejects a mutation on a read-only host with 403.
5. It reads at most 2 MiB of request body, and answers 413 for a larger body.
   It answers 400 for a body that is not JSON, or for a number token with more than 1,000
   characters after an optional minus sign. The limit also applies to `signalTask.payload` and
   `completeHumanWait.result`. The Go, Ruby, and Python hosts accept a longer number there.
6. It validates the input against the generated `dashboard/v1` schemas. A mutation `audit.requestId`
   of more than 512 UTF-8 bytes answers 400.
7. It overwrites `audit.actor`, and calls the procedure.

Each `allowedHosts` entry is a bare `host[:port]`. `build()` throws `IllegalArgumentException` for
an entry with user information, a path, a query, a fragment, or an empty port. The filter compares
hosts in lowercase, without the default port of the request scheme. The same-origin check compares
the `Origin` scheme and host with `getScheme()` and the `Host` header as exact strings.

Reads and controls go through `Admin`, `Queue`, and the generated `SqlCatalogue` statements. Each
call uses its own connection, and the filter opens no transaction. The jar carries the browser
bundle as resources, and the filter unpacks it once. It serves each asset with `Cache-Control:
public, max-age=31536000, immutable`.

The `dashboard/v1` input schemas use ECMA-262 `pattern`. The filter compiles each pattern through
an internal translator before `java.util.regex` reads it:

- Outside a bracket expression, `^` becomes `\A` and `$` becomes `\z`. Thus a final line terminator
  does not match.
- The translator accepts literals, `\d`, the escaped syntax characters, bracket expressions, groups,
  non-capturing groups, alternation, and quantifiers.
- It refuses every other construct, such as `.`, a lookaround, a backreference, `\s`, `\b`, a
  property escape, or a flag, with `IllegalArgumentException`.

`DashboardConformanceTest` replays every shared fixture exchange against a writable and a read-only
filter in an embedded servlet container.

### .NET backend

`Workhorse.AspNetCore` is the .NET backend. The extension method
`IEndpointRouteBuilder.MapWorkhorseDashboard(string pattern, DashboardOptions options)` maps one
route group under `pattern`, with a catch-all route for the browser application. It returns the
`IEndpointConventionBuilder` of the group. Thus the host can add its own metadata, for example
`RequireAuthorization("operators")` or a rate limiter. `Authorize` still runs for each request.

`pattern` is a literal mount path, such as `/workhorse`, and `/` mounts the dashboard at the root. A
pattern with a route parameter throws `ArgumentException`. A request outside the group goes to the
other endpoints of the host, because endpoint routing matches only the routes of the group. The
backend reads `HttpRequest.PathBase`, so an application under a path base still works.

`DashboardOptions` has these properties and defaults:

| Property            | Default                                            |
| ------------------- | -------------------------------------------------- |
| `DataSource`        | `required`                                         |
| `Authorize`         | `required`                                         |
| `Environment`       | `"development"`                                    |
| `AuditActor`        | `"dashboard"`                                      |
| `ReadOnly`          | `false`                                            |
| `BrowserModules`    | empty                                              |
| `ConfiguredWorkers` | empty                                              |
| `MaintenanceLoops`  | `{"tickIntervalMs": 1000}`                         |
| `AllowedHosts`      | empty                                              |
| `Procedures`        | empty                                              |
| `EnqueueTest`       | unset, so the procedure 403                        |
| `SetSchedulePaused` | unset, so the procedure 403                        |
| `Json`              | `null`, which selects `JsonSerializerDefaults.Web` |

`Authorize` is a `Func<HttpContext, ValueTask<DashboardAuthorization>>`. `DashboardAuthorization` is
a closed result family with four factory methods: `Principal(actor, claims)`, `Allow()`, `Deny()`,
and `Response(status, headers, body)`. A principal names its own actor. `AuditActor` names the actor
only when `Authorize` returns `Allow()`. `Deny()` answers 401 with `{"error":"Unauthorized"}`.
`Response` sends its status, headers, and body as they are. If `Authorize` throws, the backend logs
the error and answers 500.

A `DashboardProcedure` is a delegate over the `JsonElement` input, the actor, and a
`CancellationToken`. `Procedures` adds or replaces procedures by name. A procedure can throw
`DashboardRpcException` with a status, a code, an error message, and optional details. The backend encodes
the result of a host procedure with `Json`.

The backend handles a request under the mount path in this order:

1. A non-empty `AllowedHosts` refuses any other `Host` with 421, before `Authorize` runs.
2. `Authorize` runs. A `Deny()` or a `Response` ends the request here.
3. The schema compatibility check runs. The backend caches only a passing answer.
4. The backend rejects a cross-origin request with 403. It rejects a mutation that is not
   same-origin with 403, before it decodes the input, and a mutation on a read-only host with 403.
5. It reads at most 2 MiB of request body, and answers 413 for a larger body. It answers 400 for a
   body that is not JSON, or for a number token with more than 1,000 characters after an optional
   minus sign.
6. It validates the input against the generated `dashboard/v1` schemas. A mutation
   `audit.requestId` of more than 512 UTF-8 bytes answers 400.
7. It overwrites `audit.actor`, and calls the procedure.

Each `AllowedHosts` entry is a bare `host[:port]`. The backend compares hosts in lowercase, without
the default port of the request scheme. The backend is same-origin only, so a CORS policy must not cover the group. The CORS middleware
answers a preflight request before the backend sees it. A host
behind a proxy that ends TLS must apply the forwarded headers middleware first.

Reads and controls go through `Admin`, `Queue`, and the generated `DashboardSqlCatalogue`
statements. `typescript/dashboard-server/spec/generate-bindings.ts` writes the procedure bindings
into `V1.g.cs`. Each call uses its own connection in autocommit, and the backend opens no
transaction. The assembly embeds the browser bundle as resources, and the backend unpacks it once.
It serves each asset with `Cache-Control: public, max-age=31536000, immutable`. The backend is
asynchronous throughout, so it needs no synchronous I/O from Kestrel.

The `dashboard/v1` input schemas use ECMA-262 `pattern`. The backend compiles each pattern through
an internal translator before `System.Text.RegularExpressions` reads it:

- Outside a bracket expression, `^` becomes `\A` and `$` becomes `\z`. Thus a final line terminator
  does not match.
- `\d` becomes `[0-9]` outside a bracket expression, and `0-9` inside one. Thus a non-ASCII digit does not match.
- The translator accepts literals, escapes, bracket expressions, `\d`, `^`, `$`, groups,
  non-capturing groups, alternation, and quantifiers.
- It refuses every other construct, such as `.`, a lookaround, a backreference, `\s`, `\w`, `\b`, a
  property escape, or a flag, with `ArgumentException`.
- It compiles the result with `RegexOptions.NonBacktracking` and `RegexOptions.CultureInvariant`.

`DashboardConformanceTests` replays every shared fixture exchange against a writable and a
read-only backend.

### Presentation policy

ADR 0037 keeps presentation policy out of those backends. The backends return raw inputs:

- `settings.recommendationInputs` returns health reasons, rollup measurements, fallback-partition
  counts, and the measured enqueue rate.
- `system.status.reasons` returns the database verdict inputs without English checks.
- Retry buckets use `upperBoundMs`.
- Worker rows use `lastHeartbeatAt`.
- `activity` returns every group.
- System queue rows retain database order.
- `cron.maintenance` returns the maintenance policy, cadences, and routine state instead of
  fabricated schedule rows.
- Retention categories and storage relations carry identifiers and measurements without labels or
  groups.

`dashboard/app/src/presentation-policy.ts` owns the exact presentation policy:

| Function                                                                   | Behavior                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deriveSettingsRecommendations`                                            | Warns about cleanup pressure when the measured daily enqueue rate exceeds 80% of the daily deletion ceiling. Derives the retention, rollup, and fallback-partition recommendations.                                                |
| `healthCheckMessages`, `retentionCategoryLabels`, `presentStorageRelation` | Map reason, retention-category, and relation identifiers to English wording and storage groups.                                                                                                                                    |
| `retryBucketLabel`                                                         | Maps upper bounds of 60,000, 300,000, 900,000, and 3,600,000 milliseconds to `1m`, `5m`, `15m`, and `1h`. Every other bound is `later`.                                                                                            |
| `workerStatus`                                                             | See the status rules below.                                                                                                                                                                                                        |
| `sortQueuesByRisk`                                                         | Orders descending by `oldestReadyMs + ready * 1,000 + dueSoon * 100`, then by queue name.                                                                                                                                          |
| `activityChartModel`                                                       | Keeps at most 10 legend series. When more exist, it keeps the nine highest-count groups and combines the rest into one `Other` series. Keys each series `series-<position>`, never by its group name.                              |
| `presentSchedules`                                                         | Adds the `workhorse:tick`, `workhorse:history-partitions`, `workhorse:history-retention`, and `workhorse:terminal-storage` rows. Derives their descriptions and maintenance state from the raw policy, cadence, and routine state. |

`workerStatus` checks these conditions in order:

1. `active` when `activeTasks` is positive.
2. `idle` when a registered worker's heartbeat is at most 30,000 milliseconds old.
3. `recent` when `lastSeenAt` is at most 300,000 milliseconds old.
4. `offline` otherwise.

## Dashboard package boundary

Core owns the dashboard's relational read contract.

### Version 1 views

The version 1 views expose these exact columns:

| View                               | Columns                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard_attempt_history_v1`     | `attempt_id`, `task_id`, `attempt`, `fence_token`, `worker_id`, `outcome`, `started_at`, `claimed_at`, `finished_at`, `error`, `occurred_at`                                                                                                                                                                  |
| `dashboard_concurrency_policy_v1`  | `namespace`, `queue_name`, `max_active`, `max_active_per_key`, `updated_at`                                                                                                                                                                                                                                   |
| `dashboard_human_wait_v1`          | `task_id`, `queue_name`, `task_type`, `token_name`, `context`, `attempt`, `created_at`, `completed_at`, `completed_by`, `deadline_at`                                                                                                                                                                         |
| `dashboard_task_checkpoint_v1`     | `task_id`, `checkpoint_name`, `checkpoint_value`, `attempt`, `fence_token`, `worker_id`, `created_at`                                                                                                                                                                                                         |
| `dashboard_task_child_v1`          | `parent_task_id`, `child_task_id`, `child_name`, `created_at`, `joined_at`                                                                                                                                                                                                                                    |
| `dashboard_task_redrive_v1`        | `source_task_id`, `target_task_id`, `request_id_preview`, `request_id_digest`, `request_id_length`, `requested_by`, `reason`, `source_state`, `target_initial_state`, `requested_at`                                                                                                                          |
| `dashboard_task_event_v1`          | `event_id`, `task_id`, `attempt`, `event_type`, `details`, `occurred_at`                                                                                                                                                                                                                                      |
| `dashboard_task_outcome_v1`        | `task_id`, `state`, `current_attempt`, `run_at`, `error`, `finished_at`, `updated_at`                                                                                                                                                                                                                         |
| `dashboard_task_progress_v1`       | `task_id`, `progress_value`, `revision`, `attempt`, `fence_token`, `worker_id`, `created_at`, `updated_at`                                                                                                                                                                                                    |
| `dashboard_task_query_v1`          | `task_id`, `queue_name`, `task_type`, `created_at`                                                                                                                                                                                                                                                            |
| `dashboard_task_runtime_v1`        | `task_id`, `queue_name`, `state`, `current_attempt`, `fence_token`, `run_at`, `ready_at`, `worker_id`, `acquired_at`, `heartbeat_at`, `expires_at`, `attempt_timeout_at`, `wait_name`, `attempt_started_at`, `cancel_requested_at`, `cancel_requested_by`, `cancel_reason`, `error`, `updated_at`, `priority` |
| `dashboard_task_v1`                | `id`, `queue_name`, `task_type`, `concurrency_key`, `payload`, `payload_redact_keys`, `result_redact_keys`, `tags`, `max_attempts`, `retry_policy`, `deadline_at`, `execution_timeout_ms`, `created_at`, `priority`                                                                                           |
| `dashboard_task_wait_v1`           | `task_id`, `wait_name`, `mode`, `duration_ms`, `requested_wake_at`, `wake_at`, `attempt`, `fence_token`, `worker_id`, `created_at`                                                                                                                                                                            |
| `dashboard_maintenance_policy_v1`  | `singleton`, `timezone`, `partition_preparation_interval_ms`, `terminal_cleanup_interval_ms`, `history_retention_local_time`, `statistics_rollup_interval_ms`, `statistics_group_limit`, `statistics_recompute_buckets`, `updated_at`                                                                         |
| `dashboard_maintenance_run_v1`     | `run_id`, `routine_name`, `started_at`, `completed_at`, `outcome`, `rows_affected`, `phases`                                                                                                                                                                                                                  |
| `dashboard_maintenance_state_v1`   | `routine_name`, `last_started_at`, `last_completed_at`, `last_completed_local_date`, `terminal_cleanup_backlog_since`                                                                                                                                                                                         |
| `dashboard_queue_control_v1`       | `queue_name`, `paused`, `tier`, `record_attempts`, `record_claims`                                                                                                                                                                                                                                            |
| `dashboard_rate_limit_policy_v1`   | `queue_name`                                                                                                                                                                                                                                                                                                  |
| `dashboard_retention_policy_v1`    | `singleton`, `task_event_retention_days`, `attempt_history_retention_days`                                                                                                                                                                                                                                    |
| `dashboard_schedule_definition_v1` | `namespace`, `schedule_name`, `cron_expression`, `timezone`, `queue_name`, `task_type`, `configured_enabled`, `paused`, `paused_by`, `paused_reason`, `paused_at`, `revision`, `updated_at`, `priority`                                                                                                       |
| `dashboard_schedule_occurrence_v1` | `namespace`, `schedule_name`, `occurrence_at`, `fired_at`                                                                                                                                                                                                                                                     |
| `dashboard_signal_wait_v1`         | `task_id`, `queue_name`, `task_type`, `signal_name`, `attempt`, `created_at`, `deadline_at`                                                                                                                                                                                                                   |
| `dashboard_worker_registry_v1`     | `worker_id`, `hostname`, `pid`, `queue_name`, `concurrency`, `lease_ms`, `heartbeat_ms`, `poll_ms`, `maintenance_interval_ms`, `maintenance_routine_poll_ms`, `registry_interval_ms`, `active_slots`, `draining`, `paused`, `started_at`, `last_heartbeat_at`, `queue_names`, `schedule_namespaces`           |

Three views carry extra rules:

- `dashboard_task_outcome_v1`: `result` is absent. Read it through `dashboard_task_result_v1`.
- `dashboard_task_query_v1`: the routing projection has an index on `queue_name` and an index on
  `task_type`.
  A facet list therefore seeks one row per distinct value. A task list filtered by queue or task
  type prunes on the same indexes.
- `dashboard_task_v1`: `payload` is `redact_top_level_keys_v1(payload, payload_redact_keys)`. The
  view projects the key arrays, so a reader can report how many keys the view withheld.

### Task result and estimate

`dashboard_task_result_v1(p_task_id uuid)` returns one task's terminal result with the
operator-declared `result_redact_keys` removed.

It is a function, not a view column, because the two inputs are in different relations. The
redaction keys are on `task`, and the result is on `task_outcome`. If `dashboard_task_outcome_v1`
projected a redacted `result`, every reader of that view would join to `task`. Those readers include
the task list and the activity chart, which never read a result.
`docs/benchmarks/results/2026-08-22-dashboard-read-surface.json` records both plans.

`dashboard_task_estimate_v1()` returns the planner tuple estimate for the private `task` table.
The dashboard uses it to choose exact counts or estimates without naming the private relation.

### Redaction scope

`payload_redact_keys` and `result_redact_keys` apply only to the payload and the result. The
dashboard read surface returns these other handler-written values as the handler stored them:

| Value              | Stored in                          | Dashboard reads                                                                          |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Checkpoint value   | `task_checkpoint.checkpoint_value` | `dashboard_task_detail_v1` (`checkpoints`), `dashboard_checkpoint_value_v1`              |
| Progress value     | `task_progress.progress_value`     | `dashboard_task_detail_v1` (`progress.value`)                                            |
| Human-wait context | `task_human_wait.context`          | `dashboard_task_detail_v1` (`humanWait.context`), `dashboard_human_waits_v1` (`context`) |

No dashboard function applies `redact_top_level_keys_v1` to these values. If a handler copies a secret into
one of them, every dashboard operator can read that secret. The handler must remove each secret
before it saves a checkpoint, sets a progress value, or starts a human wait.

The task listing reads human-wait context only through `dashboard_human_wait_quick_action_v1`. That
function returns the `dashboard.quickAction.label` string, trimmed and cut to 200 characters. It
returns no other part of the context.

### Task listing

`dashboard_tasks_v1(p_input jsonb)` applies these inputs and returns the complete version 1
task-page JSON document: `filter`, `queue`, `worker`, `taskType`, `priority`, `tags`, `search`,
`sort`, `page`, `pageSize`, and `count`.

Before the backend calls the function, the wire validator applies these limits:

| Input                        | Limit                             |
| ---------------------------- | --------------------------------- |
| `pageSize`                   | 25, 50, or 100                    |
| `page`                       | at most `dashboardPageMax`, 100   |
| selected tags                | at most 20 values                 |
| each search or string filter | at most 200 characters            |
| `priority`                   | null, or 0 through 100            |
| `sort`                       | `updated` (default) or `priority` |

#### Human decisions in rows

`dashboard_tasks_v1` and `dashboard_tasks_cursor_v1` return a pending human decision as
`humanWait: { name, deadlineAt, quickAction }`, with no `context`. Clients poll a listing, and one
context can hold 65,536 bytes. `dashboard_human_wait_quick_action_v1` derives `quickAction`:

1. `context.dashboard.quickAction.label` is a string.
2. `context.dashboard.quickAction` has a `result` key, whatever its value.
3. The label is not empty after trimming whitespace.

Trimming removes the same characters as JavaScript's `String.prototype.trim`. Thus each label that
a row offers is a label that the SPA accepts from the full context. When all three conditions are
true, `quickAction` is `{ label }`. The label is trimmed and cut to 200 characters. Otherwise
`quickAction` is `null`.

If an operator selects the quick action in a row, the SPA reads `dashboard.taskDetail`. Its
`humanWait` keeps the full context. The SPA confirms the result from that context. If the task no
longer waits on that decision, the SPA reports this and sends nothing.

The removal of `context` from listed rows was an in-place `dashboard/v1` break under the ADR 0064
exception in [compatibility.md](../compatibility.md).

#### Total and `hasMore`

`count` defaults to `none`.

- With `none`, the function reads `page * pageSize + 1` matching identities. It reports how many it
  read as `total`, and sets `hasMore` when it read the extra row.
- `total` is exact whenever it is at most `page * pageSize`. Otherwise it is one more than the page
  bound, and the caller knows only that more tasks exist.
- With `count: exact`, `total` counts every matching task. That count reads the whole selection,
  not only one page of it.

#### Query composition

The function is PL/pgSQL and composes its query. Thus it names the tasks that the request can
reach before the runtime and outcome joins read a row. It selects the first scope that matches:

1. A `tags` request adds a `task_scope` CTE that seeks `task_tags_gin_idx`.
2. Otherwise, a `queue` or `taskType` request adds one that seeks `task_query_queue_created_idx` or
   `task_query_type_created_idx`.
3. Otherwise, the function adds no scope, and `task_rows` reads `dashboard_task_v1` directly.

The function composes only fixed SQL fragments. The request stays in the bound JSON parameter, so the
planner sees each filter as a value it can seek. The filter list below the scope still applies
every predicate. A request that names both a tag and a queue therefore seeks the tag index and
filters on the queue.

The tag array reaches the scan through `dashboard_tag_filter_v1(p_tags jsonb)`. That immutable
function returns the request's `tags` as `text[]`. An inline
`ARRAY(SELECT jsonb_array_elements_text(...))` would not work. It is a subquery. The planner
evaluates it once per execution and never folds it into the scan. The scan then could not reach
`task_tags_gin_idx`.

#### Enqueued event lookup

Both task listings constrain their page-scoped `enqueued` event lookup to the interval from
`task.created_at` through `statement_timestamp()`. Workhorse commits an enqueued event before a
dashboard read statement can observe it. The bounds prune daily partitions before the task existed
and prepared partitions after the read began. Both functions disable JIT for input-specific plans.

### Cursor task listing

`dashboard_tasks_cursor_v1(p_input jsonb)` implements the additive `tasksCursor` procedure.

#### Inputs and response

- It accepts the same filters and page sizes as `tasks`, without a page number.
- `cursor` contains `id`, `priority`, and `updatedAt` with six fractional timestamp digits.
  Callers pass returned cursors unchanged.
- `direction` is `next` by default, or `previous`.
- `count` defaults to `none`, which returns `total: null` without counting the full selection.
- With `count: exact`, `total` counts all matching tasks, independently of the cursor.
- `nextCursor` and `previousCursor` are null when no further page is known in that direction.

Concurrent state changes can move tasks between pages. Browsing does not hold a snapshot across
requests.

#### Query plan

- The query reads one extra candidate before enriching the requested page.
- Updated ordering uses `(updated_at, task_id)`. Priority ordering prefixes that tuple with
  `priority`.
- Live and terminal rows use separate query branches. This preserves the terminal update-time
  index.
- Workhorse adds no update-time index to live rows, because heartbeats must keep HOT eligibility.
- It reads the tag filter through `dashboard_tag_filter_v1` for the same reason `tasks` does.
- A `queue` or `taskType` request adds a join to `dashboard_task_query_v1`. That projection's index
  then prunes before the ordering walk reads a task.
- If the request has neither, the query has no join. The walk stays on the update-time indexes, which already
  return the page in order.

#### SPA cursor navigation

The SPA uses cursor navigation.

- It keeps a legacy page-number link working. It walks `tasksCursor` from the first page. The
  walk stops at the requested page or the last available page.
- It carries the cursor in the URL. Its pager offers a first-page control that removes the cursor. The
  control keeps every filter, the sort, the page size, the chart settings, and the open drawer.
- While a page is pinned, the SPA offers a link back to the first page after the refresh control.
  The paused indicator alone names neither the cause nor the way back.
- A narrow viewport states the same fact at the pager instead, where that row has room for it.
- If the answer to a cursor request has `previousCursor: null`, the answer came from the first
  page. The SPA then replaces the URL to remove the anchor that it no longer needs.
- This check pairs each answer with the request that asked for it. During a pager click, the
  page still on screen reports the same thing about the page the operator left.

### Sidebar counts

`dashboard_task_counts_v1(p_input jsonb)` returns the complete version 1 sidebar-count JSON
document and ignores its input. The function disables JIT for itself.

If the task estimate is below 50,000, it counts every filter bucket exactly. It reads
`dashboard_task_v1` joined to `dashboard_task_runtime_v1` and `dashboard_task_outcome_v1`.

At or above the threshold, each bucket has its own source:

| Bucket                                                                                               | Source                                                                                       |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `all`                                                                                                | the task estimate                                                                            |
| live buckets: `blocked`, `waiting`, `scheduled`, `queued`, `running`, and the live half of `retried` | counted exactly from `dashboard_task_runtime_v1`                                             |
| `completed`, `discarded`, `canceled`, and the terminal half of `retried`                             | one `EXPLAIN (FORMAT JSON)` probe each over `dashboard_task_outcome_v1`, reading `Plan Rows` |

Both branches count `waiting` by probing `dashboard_signal_wait_v1` and `dashboard_human_wait_v1`.
They probe only for a row whose runtime state is `scheduled` with a non-null `wait_name`. Both views
already require that predicate, so a ready or delayed row costs no index probe. The waiting filter
of `dashboard_activity_v1` applies the same guard.

### Facets

`dashboard_task_facets_v1(p_input jsonb)` accepts `configuredWorkers`. It returns the complete
version 1 facet JSON document:

| Facet       | Sources                                                                                                              | Bound                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `queues`    | sorted distinct values from `dashboard_task_query_v1` and `dashboard_queue_control_v1`                               | 1,000 values from the index scan |
| `workers`   | the configured list, `dashboard_worker_registry_v1`, `dashboard_task_runtime_v1`, and `dashboard_attempt_history_v1` | 1,000 values from the index scan |
| `taskTypes` | `dashboard_task_query_v1`                                                                                            | 1,000 values                     |
| `tags`      | the newest 10,000 rows of `dashboard_task_v1`                                                                        | at most 1,000 distinct values    |

The queue and type lists are recursive scans. Each seeks the next distinct value through
`task_query_queue_created_idx` and `task_query_type_created_idx`. Each costs one index seek per
distinct value and stops at 1,000 values.

The worker list also reads `dashboard_attempt_history_v1` through the same recursive scan over
`attempt_history_worker_idx`. That index exists on every partition, so each distinct worker costs
one seek per partition. The list also stops at 1,000 values. Thus, if a worker ran tasks and then
left the registry, the list still offers it as a filter while Workhorse retains its history.

The tag sample walks `task_created_retention_idx` newest first and returns at most 1,000 distinct
values. No index supports a distinct array scan. Thus the bound keeps facet latency independent of
the full task table.

<a id="activity"></a>

### Activity chart

`dashboard_activity_v1(p_input jsonb)` builds the activity chart:

1. It maps `period` to its trailing window and bucket width.
2. It selects tasks whose runtime or outcome changed inside the window.
3. It applies `filter`, `groupBy`, `tags`, `queue`, and `worker`.

It probes `dashboard_attempt_history_v1` for the latest worker only when worker grouping or
filtering requires that value. It returns the complete version 1 activity JSON document.
`dashboard_iso_v1` renders the UTC bucket timestamps. The wire validator limits each string filter
to 200 characters before the backend calls the function.

#### Activity chart states

The SPA keys each activity result by the query that produced it: `filter`, `period`, `groupBy`,
`tags`, `queue`, and `worker`. `activityView` in `dashboard/app/src/charts/activity.tsx` decides
what the chart shows for the query its controls name:

| Newest result for this query | Newest failure for this query | Chart shows                            |
| ---------------------------- | ----------------------------- | -------------------------------------- |
| none                         | none                          | loading                                |
| none                         | present                       | an error alert with Retry, and no bars |
| present                      | none                          | the bars                               |
| present                      | present                       | the bars with a stale alert and Retry  |

A success clears the failure. The chart never draws a result for a different query under the
current controls. Series keys come from `activityChartModel`, so a group named `a.b`, `bucket`, or `other`
cannot collide with another series or with the axis key.

### Event feed

`dashboard_events_v1(p_input jsonb)` returns the complete version 1 events JSON document. The
document includes the effective range and the retention days from `dashboard_retention_policy_v1`.

#### Time range and filters

The function accepts a fixed `window`, or an inclusive `rangeStart` and exclusive `rangeEnd`.
Callers must supply both ISO-8601 range instants. `rangeEnd` must be later than `rangeStart`.

It applies the time bound, `kind`, `queue`, `taskType`, `types`, and `taskId` before merging
`dashboard_task_event_v1` with `dashboard_attempt_history_v1`. Each source reads at most
`page * pageSize + 1` rows before the merge. Before the backend calls the function, the wire
validator limits `page` to `dashboardPageMax`, 100, and each string filter to 200 characters.

The event listing also accepts `worker` and `search`. Both filters apply before source limits and
in the exact count. The limit for both strings is 200 characters.

- `worker` matches the recorded attempt worker, including lifecycle records linked to that
  attempt. An event's explicit `details.worker_id` has priority over the linked attempt worker.
- `search` does a case-insensitive literal substring match. It covers task ID, queue, type,
  event name, worker, and recorded details or error message.

#### Total and `hasMore`

`count` defaults to `none`. The merged feed then keeps `page * pageSize + 1` rows and reports how
many it kept as `total`. It sets `hasMore` when it kept the extra row, exactly as the task
listing does.

With `count: exact`, `total` counts every record matching the window and the filters. That count
applies the filter to both source tables a second time. A one-time filter on the count mode keeps
that second pass out of the plan for every other request.

The function disables JIT. Compiling its generic partitioned plan costs more than executing the
bounded reads.

#### Page limit in the SPA

`dashboardPageMax` in `typescript/dashboard-server/src/wire.ts` is the one page limit. The router's
`page` validator and the Events pager both read it. The pager offers at most that many pages. If
`total` is more than `dashboardPageMax * pageSize`, the page says how many events the pager
reaches. `parseEventsLocation` and `eventsLocationHref` read a `page` above `dashboardPageMax` as
`dashboardPageMax`. Thus a bookmarked URL cannot ask for a page that the router rejects.

On the last page, Continue with older events sets a custom range. `continueEventsRange` keeps the
current `rangeStart` and ends the range 1 millisecond after the oldest event shown, because
`rangeEnd` is exclusive. Events at that instant that the last page did not reach stay in range. The
events it did reach at that instant appear again.

When that end would not move the range back, every page shares the oldest instant. The range then
ends at that instant, and the page says that continuing skips the rest of its events. When the
oldest event shown is at `rangeStart`, the range holds nothing older, and the page offers no
Continue.

#### Event rows

Each event row keeps the native table row role, so assistive technology pairs every cell with its
column. A pointer click anywhere on the row opens the event. The Event cell holds a button whose
accessible name starts with the visible event label, such as `Task claimed event, inspect for
invoice.send`. Keyboard and screen-reader users open the event through that button.

### Event detail

`dashboard_event_detail_v1(p_input jsonb)` accepts the stable `event:<UUIDv7 event_id>` or
`attempt:<UUIDv7 attempt_id>` identity. It returns the complete version 1 event-detail JSON
document, which includes attempt timing and error fields.

A malformed or missing identity returns SQL `NULL`. Backends map SQL `NULL` to the version 1
`NOT_FOUND` error.

Event details use the same attempt-linked worker resolution as the event listing.

### Workers page

`dashboard_workers_v1(p_input jsonb)` accepts `configuredWorkers` and `canManageWorkers`. It
returns the complete version 1 worker-page JSON document.

- The worker fleet combines configured identities with `dashboard_worker_registry_v1`.
- Active-task counts come from `dashboard_task_runtime_v1`.
- Attempt counts, failure counts, average execution time, and last-seen times cover the previous
  hour of `dashboard_attempt_history_v1`.

The function reads `clock_timestamp()` once into `v_since` and filters `occurred_at` and
`finished_at` with that variable. A volatile `clock_timestamp()` in the predicate would stop the
planner from pruning history partitions or using the `occurred_at` key. Every poll would then read
all retained attempt history. With `v_since`, a poll reads the partitions that can hold the past
hour.

### Schedules page

`dashboard_cron_v1(p_input jsonb)` accepts `maintenanceLoops` and returns the complete version 1
cron-page JSON document.

#### Application schedules

The function returns at most 50 schedule definitions ordered by `namespace` and `schedule_name`.
Occurrence counts and last-fired times come from `dashboard_schedule_occurrence_v1`.
`scheduleCount` counts every definition. If it is more than the number of rows returned, the
Schedules page says `Showing 50 of <scheduleCount> schedules`.

Each definition includes `evaluatorCount`. It counts registrations that meet both conditions:

- `schedule_namespaces` contains the definition namespace;
- `last_heartbeat_at` is no older than 30 seconds.

Application rows return `configuredEnabled`, `paused`, `pausedBy`, `pausedReason`, `pausedAt`, and
effective `active`.

On the Schedules page:

- Each application schedule's occurrence count links to `/tasks?queue=<queue>&type=<task type>` in
  a new browser tab. The task listing has no schedule filter. Thus the link filters by the
  schedule's destination queue and by its task type.
- Compact rows show the queue, evaluator count, and Pause or Resume action.
- A deployment-disabled definition shows `Config off`.
- Focusable tooltips carry the task type, priority, worker wording, pause durability, and full
  maintenance status.

#### Maintenance routines

The maintenance policy comes from `dashboard_maintenance_policy_v1`. The function derives `due`
and `incomplete` for `tick`, `history_partitions`, `history_retention`, and `terminal_storage`
from these inputs:

- `dashboard_maintenance_state_v1`;
- the supplied tick cadence;
- the policy;
- the current database time.

While `terminal_cleanup_backlog_since` is set, `terminal_storage` is due after
`terminal_cleanup_follow_up_delay_ms_v1()` or `terminal_cleanup_interval_ms`, whichever is shorter.
`prune_terminal_storage_v1` uses the same delay to gate its follow-up pass.

The Schedules page uses the tick state's completion time as the built-in tick row's last run.

Each routine includes `recordedRunCount` for its retained total and its five newest recorded
`maintenance_run` rows. The Schedules page shows:

- the retained total, with a label that says so;
- which five-row display subset it shows;
- the tick sampling policy;
- the run outcome, duration, affected-row total, phase timings, and phase errors.

### Queues page

`dashboard_queues_v1(p_input jsonb)` returns the complete version 1 queue-page JSON document. It
calls `queue_health_v1()` once per invocation.

- If the task estimate is at least 50,000, it runs one `EXPLAIN (FORMAT JSON)` probe for each known
  queue and terminal state and reads `Plan Rows`. Every probe uses `dashboard_task_v1` and
  `dashboard_task_outcome_v1`.
- Below the threshold, it runs one exact grouped terminal-count query.

Since schema version 37, each queue row carries `tier`, `recordAttempts`, and `recordClaims` from
`queue_control`. A queue without a control row reports `full`, `false`, and `false`. An older
schema omits the three keys, and the Queues page shows a dash in its Tier column.

Two mutations change these values. Both are optional `DashboardQueueController` methods and
optional procedures in `DashboardClient`. If a client has no such method, the Queues page shows
the action disabled with the reason. It also disables the actions when the schema omits `tier`.

- `setQueueTier` takes `queue`, `tier` (`fast` or `full`), and `audit`. The shared controller calls
  `Admin.setQueueTier` with the server-assigned actor and the audit reason. `set_queue_tier_v1`
  writes them to `queue_control.updated_by` and `queue_control.reason`. The answer is
  `{ status, tier }`. `status` is `set`, or the guard that refused the switch: `live_tasks`,
  `concurrency_policy`, or `rate_limit_policy`. A refused switch answers a null `tier` and changes
  nothing. Each host maps the `P1007` refusal of its own `Admin` to the status, from the `feature`
  in the error detail, and has no guard of its own.
- `setQueueHistory` takes `queue`, optional `recordAttempts` and `recordClaims`, and `audit`. It calls
  `Admin.setQueueHistory`. An absent setting keeps its value. The answer holds both settings after
  the change. `set_queue_history_v1` records no attribution, so only a host runner that writes its
  own audit row, such as the demo, keeps the `audit` of this call.

### Task groups page

The Task groups page shows the [task groups](task-groups.md) of the database. It has a list of
groups and a detail view for each group. Three `dashboard/v1` procedures serve it, and
`dashboard/v1/conformance.json` covers each of them.

| Procedure         | Kind     | Input                                                        | Response                                   |
| ----------------- | -------- | ------------------------------------------------------------ | ------------------------------------------ |
| `taskGroups`      | Read     | `state`, `page`, `pageSize`                                  | `DashboardTaskGroupsPage`                  |
| `taskGroupDetail` | Read     | `id`, `after`, `pageSize`                                    | `DashboardTaskGroupDetail`, or `NOT_FOUND` |
| `cancelTaskGroup` | Mutation | `id`, and an `audit` with `actor`, `reason`, and `requestId` | `DashboardTaskGroup`, or `NOT_FOUND`       |

The input limits are:

| Field       | Values                                                         | Default |
| ----------- | -------------------------------------------------------------- | ------- |
| `state`     | `all`, `open`, `sealed`, or `finished`                         | `all`   |
| `page`      | 1 through `dashboardPageMax`, 100                              | 1       |
| `pageSize`  | 25, 50, or 100 (`dashboardTaskGroupPageSizes`)                 | 50      |
| `id`        | A UUID                                                         |         |
| `after`     | 0 through 100,000, or null; null and 0 start at position 1     | null    |
| `reason`    | 1 through 2,000 characters; the TypeScript host trims it first |         |
| `requestId` | 1 through 512 UTF-8 bytes                                      |         |

`typescript/dashboard-server/src/server/task-group-statements.ts` holds the SQL of the three
procedures. `typescript/dashboard-server/spec/generate-bindings.ts` copies it into the Go, Python,
Rust, Ruby, Java, and C# bindings. Thus the seven backends send the same SQL for the list and the
detail.
The cancel uses a different path in TypeScript, as [Cancel](#cancel) describes. The statements call
only functions and name no task group table. Thus the task group tables are not a governed dashboard
read ([Task groups: Reads](task-groups.md#reads)).

#### Task group document

`DashboardTaskGroup` is the snapshot of `get_task_group_v1`. Each procedure returns it in the same
form:

- `id`, `state` (`open`, `sealed`, or `finished`), and `result` (`succeeded`, `failed`, or null
  until the group finishes).
- `counts`, with `total`, `succeeded`, `failed`, `canceled`, and `pending`.
- `createdAt`, `sealedAt`, `finishedAt`, and `canceledAt`, as UTC times with three fractional
  digits. A time that did not occur is null.
- `canceledBy` and `cancelReason`. The three cancel fields are all set or all null. A canceled
  group finishes through its member outcomes, so `state` and `canceledAt` are independent.
- `callbacks`, one `{ kind, taskId }` for each callback that the creator requested, in the order
  `onFinish`, `onSuccess`, `onFailure`. `taskId` is null until the finished group enqueues the
  callback.

#### List

`taskGroups` calls `dashboard_task_groups_v1` and returns `state`, `page`, `pageSize`, `hasMore`,
and `groups`, newest first. The function reads one group more than the page, so `hasMore` costs
no count of all groups. The function accepts pages up to 1,000, but the procedure input stops at
page 100.

#### Detail

`taskGroupDetail` is one statement over `get_task_group_v1`, `list_task_group_members_v1`, and
`list_newest_task_group_events_v1`. It returns these fields:

| Field             | Value                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| `group`           | The task group document                                                           |
| `members`         | At most `pageSize` member tasks after the position `after`, in position order     |
| `nextAfter`       | The position of the last member on the page when a later member exists, else null |
| `events`          | The newest events first, at most `dashboardTaskGroupEventLimit`, 100              |
| `eventsTruncated` | True when the group has older events that `events` does not carry                 |
| `canCancel`       | True when this dashboard can cancel the group, as [Cancel](#cancel) describes     |

The statement reads one member more than `pageSize` and 101 events, so `nextAfter` and
`eventsTruncated` cost no count. Each member has `position`, `taskId`, `queue`, `taskType`,
`state`, `outcome`, `addedAt`, and `countedAt`:

- `queue` and `taskType` are null when a purge or retention deleted the task row. `state` is then
  null too.
- `outcome` is the outcome that the group counted. It is null while the member is pending.

Each event has `id`, `type`, `details`, and `occurredAt`. If the group does not exist, the procedure
returns `NOT_FOUND`.

#### Cancel

`cancelTaskGroup` is a mutation. It seals the group and cancels each member task that is not
terminal, through `cancel_task_group_v1`
([Task groups: Cancel](task-groups.md#cancel)). The canceled members count as not succeeded. The
group then finishes as usual, and its result selects the callbacks. If every member task already
succeeded, or the group has no member tasks, the result is `succeeded`. A finished group does not
change, and the procedure returns its snapshot.

The backends differ in how they cancel and in when they allow it:

| Backend                               | Cancel path                                                                                                                 | `canCancel` is true when                                                                     | `FORBIDDEN` when                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| TypeScript                            | `DashboardTaskController.cancelTaskGroup`. `createDashboardOperatorControllers` implements it with `Admin.cancelTaskGroup`. | The operator mode is `writable` and the host gives `DashboardTaskController.cancelTaskGroup` | The host gives no cancel controller |
| Go, Python, Rust, Ruby, JVM, and .NET | The shared cancel statement, which calls `cancel_task_group_v1`                                                             | The host is not read-only                                                                    | The host is read-only               |

Every backend also returns `FORBIDDEN` for a mutation when its operator mode is read-only. The
authenticated actor replaces the browser `audit.actor`, as
[Mutations and attribution](#mutations-and-attribution) describes. `cancel_task_group_v1` requires
an actor of 1 through 200 characters. If the group does not exist, the
procedure returns `NOT_FOUND`.

#### Page

The sidebar entry Task groups opens the route `/groups`. The address bar holds the view, so a reload
or a copied link shows the same page:

- The list uses the query parameters `state`, `page`, and `pageSize`.
- The detail uses `group`, the group ID, `after`, the member position, and `pageSize`.
- A default value stays out of the URL. A value out of range falls back to its default.

The list has a state filter (All, Open, Sealed, and Finished) and a table with the columns Group,
State, Progress, Failed, Canceled, Created, and Finished. The progress bar draws the succeeded,
failed, and canceled member tasks of the counts. Previous page and Next page move between pages.
On page 100 with more groups, the page says that it is the last page that the list reads.

The detail shows these parts:

1. The state, the progress bar, the five counts, and the four times. A canceled group also shows
   who canceled it and why. An open group shows that it cannot finish until the application seals
   it.
2. Callbacks: a link to each callback task, or the reason that the callback has no task yet.
3. Member tasks: the columns #, Task, Type, Queue, State, Counted outcome, and Added, with pages
   of `pageSize` members.
4. Events: the newest group events first. If `eventsTruncated` is true, the page says that it does
   not show the older events.

If the group is not finished and `canCancel` is true, the detail has a Cancel group button. The
button opens a confirmation that requires a reason. If `canCancel` is false, the detail says that
this dashboard cannot cancel task groups.

### Timestamp rendering

`dashboard_iso_v1(p_value timestamptz)` renders procedure timestamps in UTC with millisecond
precision and a `Z` suffix. Every backend returns a procedure document as PostgreSQL wrote it. Task
payloads, results, checkpoints, progress, and event details keep their stored text, including
strings that look like timestamps.

### Browser preferences

The SPA keeps display preferences in the browser's `localStorage`. These preferences change only
the display, so the dashboard must work when the browser does not let it read or write storage.
For example, a browser policy can block site data for the dashboard origin.

| Key                            | Preference                                 | Default           |
| ------------------------------ | ------------------------------------------ | ----------------- |
| `workhorse-theme-scheme`       | Color theme, `light`, `dark`, or `system`  | `system`          |
| `workhorse-timezone`           | Display time zone, or `system`             | Browser time zone |
| `workhorse-auto-refresh`       | Automatic refresh interval                 | `15s`             |
| `workhorse-system-window`      | Time window on the System page             | `1h`              |
| `workhorse-activity-period`    | Activity chart period                      | `1h`              |
| `workhorse-activity-group`     | Activity chart grouping                    | `task`            |
| `workhorse-task-chart-visible` | Activity chart visibility on the task page | Visible           |
| `workhorse-task-drawer-width`  | Task drawer width in pixels                | `780`             |

`dashboard/app/src/browser-storage.ts` is the only SPA module that calls `localStorage`. Its
`readStoredValue` returns `null` when a read throws, so the caller uses the default. If a write
throws, `storeValue` keeps the value in a module map for the current page session. A later
`readStoredValue` for that key returns the map value before it reads `localStorage`, so an old
stored value cannot replace the change. A successful write removes the key from the map.

An `oxlint` `no-restricted-globals` rule rejects `localStorage`, `window.localStorage`, and
`globalThis.localStorage` in other SPA source modules. The inline theme script in
`dashboard/app/browser/index.html` runs before the SPA modules load. It catches a failed read and
uses the system color scheme.

The color theme control in the header offers Light, Dark, and System.

- If no value is stored, or the stored value is unknown, the preference is `system`.
  `readStoredThemePreference` in `dashboard/app/src/theme.tsx` makes this decision.
- The SPA stores `workhorse-theme-scheme` only when the user selects an option. Opening the
  dashboard does not store a value.
- While the preference is `system`, the dashboard follows `prefers-color-scheme`.
  `followSystemScheme` listens for each change of the browser setting.
- The inline theme script reads `system` the same as a missing value.

The display time zone setting on the Settings page offers System, then UTC, then every IANA zone
that `Intl.supportedValuesOf("timeZone")` returns. The user can search the list.

- If the browser has no `Intl.supportedValuesOf`, or the call fails or returns no zone, the list has
  13 zones: UTC and 12 common zones. `supportedTimeZones` in
  `dashboard/app/src/pages/settings/index.tsx` makes this decision.
- If the browser does not recognize the stored `workhorse-timezone` value, the dashboard uses the
  browser time zone. `readStoredTimeZone` in `dashboard/app/src/preferences.tsx` makes this decision.
- If the selected zone is not in the list, `displayTimeZoneOptions` adds it as the last choice.
- The Maintenance timezone setting uses the same zone list without System.

### Client request IDs

The SPA creates a random UUID for each mutation `audit.requestId` and each `idempotencyKey`. It
also creates one for a notification ID when the caller gives no ID. `randomUuid` in
`dashboard/app/src/random-uuid.ts` makes these UUIDs. A browser gives `crypto.randomUUID()` only in
a secure context. If the browser gives `crypto.randomUUID()`, `randomUuid` calls it. If not,
`randomUuid` builds a version 4 UUID from `crypto.getRandomValues()`, which every context gives.
This fallback does not make plain HTTP a supported deployment.

### Page loads, task reloads, and focus

The SPA reads each page again on manual refresh, on auto refresh, and after an operator action.
These rules keep the data on screen readable and keep keyboard focus in a known place.

A page load that fails has two outcomes. `failedLoadState` in `dashboard/app/src/render-identity.ts`
selects one:

| Data on screen                                   | Load state | Page area                                       |
| ------------------------------------------------ | ---------- | ----------------------------------------------- |
| Answers the same request: route, listing, window | `stale`    | The page, with a `Refresh failed` warning above |
| None, or data for a different request            | `error`    | The full error screen with a `Try again` button |

- The `stale` state keeps the ISO time of the last load that succeeded for that request. The
  warning shows that time with `formatClock`, and states that the data can be out of date.
- The warning is inside a `role="status"` region that stays mounted. A repeated failure with the
  same error text keeps the same state object, so the warning does not announce again on each poll.
- A manual refresh of the same request keeps the `stale` state until a load succeeds.
  `startedLoadState` makes this decision. The refresh control shows its spinner meanwhile. A load
  for another request, such as another page, starts from the `loading` state.
- The header status badge shows `Refresh failed` for `stale` and `Disconnected` for `error`.
- The next successful load returns the state to `ready` and removes the warning.

The task drawer reloads its task after an action such as Retry, Run now, or a delivered signal.

- `taskDetailKeepsShownDetail` in `dashboard/app/src/task-drawer.ts` keeps the shown detail while
  the same task reloads. The drawer keeps its scroll position, its field text, and focus.
- A load for a different task empties the drawer first, so the old detail never shows under the
  new task. `createLatestRequestGuard` still lets only the newest detail request write.
- If a reload of the shown task fails, the drawer keeps the detail and shows the error above it.
- If a reload removes the control that had focus, and focus fell to the document body, focus moves
  to the task heading `task-overview-heading`. `taskDetailFocusLost` makes this decision. The
  heading has `tabIndex={-1}`, so it takes focus from a script only.
- When the drawer closes, focus returns to the control that opened it. If a refresh replaced that
  row, focus goes to the row's new open control. If the row is gone, focus goes to the page
  heading.

Navigation between routes changes the document and the focus.

- The document title is `<page> · Workhorse`, for example `Queues · Workhorse`. `documentTitle` in
  `dashboard/app/src/shell/controller.tsx` builds it. On unmount the shell restores the host's
  title.
- After a route change, including Back and Forward, `usePageHeadingFocus` in
  `dashboard/app/src/page-focus.ts` moves focus to the first `h1` in the page area. It waits until
  `pageContentRoute` names the new route, so the heading of the previous page does not take focus.
  If the heading arrives after the data loads, it waits for it. If focus moved into the page or a
  detail drawer first, it does nothing.
- Polling, filters, the pager, and the task drawer do not change the route, so they do not move
  focus.
- The Tasks and Events pages have no visible page heading. The shell gives them a visually hidden
  `h1`. The full error screen also has an `h1`.
- The first focusable element is a `Skip to main content` link. It moves focus to the page area
  `#dashboard-main`, and it shows only while it has focus.

### Auto refresh and its pauses

Auto refresh reads the open page again at a fixed interval. It pauses while a refresh could replace
data that the operator reads or edits. `dashboard/app/src/refresh-policy.ts` and
`dashboard/app/src/refresh-blockers.tsx` own these rules.

#### Interval

The operator selects the interval in the menu beside the `Refresh` button. The SPA stores the
choice in the `workhorse-auto-refresh` browser preference. The default is `15s`.

| Value | Menu label          | Interval   |
| ----- | ------------------- | ---------- |
| `off` | Manual refresh only | none       |
| `5s`  | Every 5s            | 5 seconds  |
| `15s` | Every 15s           | 15 seconds |
| `30s` | Every 30s           | 30 seconds |
| `1m`  | Every minute        | 60 seconds |
| `5m`  | Every 5 minutes     | 5 minutes  |

Each tick reads the open page and the navigation counts. On the Tasks page it also reloads the
activity chart. `createDashboardPollingClock` schedules the ticks.

#### Pause conditions

Auto refresh pauses while one or more of these conditions is true:

| Condition                                                                                                                                                 | Source                                            | Priority |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------- |
| The window is not active: the document is hidden, or the document does not have focus. A visible window without focus also pauses.                        | `dashboardWindowIsActive`, `inactiveWindow`       | 30       |
| A task action menu is open. It can be in the task listing or in the task drawer.                                                                          | `Menu` with `blocksRefresh`, `taskContextMenu`    | 20       |
| A queue tier menu is open on the Queues page.                                                                                                             | `Menu` with `blocksRefresh`, `taskContextMenu`    | 20       |
| A confirmation dialog for one of these actions is open: cancel a task, cancel a task group, or pause or resume a schedule. Other dialogs do not pause.    | `useConfirmationActivity`, `taskContextMenu`      | 20       |
| The task drawer is open.                                                                                                                                  | `taskDrawerOpened`, `taskDrawer`                  | 10       |
| The Settings page has unsaved maintenance changes: time zone or history retention time.                                                                   | `dirtySettings`                                   | 10       |
| The task listing is pinned to a cursor or to a page after the first.                                                                                      | `taskListingPinned`, `pinnedTaskPage`             | 5        |
| An `input`, a `textarea`, a `select`, or a `contenteditable` element in the dashboard has focus. A `hidden`, `checkbox`, or `radio` input does not pause. | `dashboardInputTypeBlocksRefresh`, `focusedInput` | 0        |

- `subscribeDashboardWindowActivity` checks the window again on `focus`, `blur`, and
  `visibilitychange`. After `visibilitychange` it checks once more after a zero-delay timer.
- The interval button shows `paused`. Its `title` and `aria-label` give the description of the
  condition with the highest priority, for example `Auto refresh paused while task details are open`.
- The pause keeps the time that is left in the current interval. The progress bar under the control
  stops at the same point.
- A background read of the page data or the navigation counts that returns while a condition is
  true is discarded. `discardBackgroundRefresh` makes this decision. The activity chart on the Tasks
  page has its own request, and it does not check the conditions. If a chart request starts before
  a pause, its response can change the chart during the pause.

#### Resume countdown

When the last condition ends, auto refresh does not continue at once.
`createDashboardRefreshResumePolicy` starts a countdown of 3 seconds.

1. The `Refresh` button shows `Refresh (3)`, then `Refresh (2)`, then `Refresh (1)`.
2. The interval button stays `paused`. Its description is `Auto refresh resumes in N seconds`.
3. If a condition starts again during the countdown, the countdown stops. The next end of all
   conditions starts a new countdown.
4. When the countdown ends, the polling clock continues with the time that was left in the
   interval.

If the interval is `off`, no countdown starts.

#### Manual refresh

The `Refresh` button works in every state, also while auto refresh pauses or counts down.

- It reads the open page as a foreground load. A pause condition does not discard its response.
- It starts the interval again from its full length. A route change and an interval change also
  start it again.
- It does not end a pause condition. If a condition is still true, auto refresh stays paused.

### Status labels and explanations

Status labels repeat on each row of a list, and a list can show 100 rows. These rules keep the
labels readable without a screen reader announcement for each row.

- A status label is static text. `StatusBadge`, `StatusLabel`, and the task wait, blocked, and
  cancellation badges have no `role="status"` and no `aria-live`.
- `StatusText` in `dashboard/app/src/status-badge.tsx` hides the visible text from assistive
  technology and gives the full label as visually hidden text. A badge is a generic element, so
  an `aria-label` on it gives no accessible name.
- A label with details, such as an error message, is focusable. Its tooltip opens on hover, focus,
  and touch.
- A refresh does not announce changed rows. The dashboard keeps a live region only where one
  element reports one change: the header connection badge, the `Refresh failed` warning, and
  the copy result in the task drawer.

The queue, budget, and System queue tables show short values, such as `8 / 8`, with a longer
explanation.

- `ExplainedValue` in `dashboard/app/src/components/explained-value.tsx` puts the explanation
  after the value as visually hidden text, so a screen reader reads it with the cell.
- The value is focusable, and its tooltip opens on hover, focus, and touch. A tap on the value
  does not select its row.
- No paragraph has an `aria-label`, because a paragraph has no accessible name.

The task and event drawers have one heading each.

- Mantine renders the drawer title as the `h2` that names the dialog. The title is plain text.
- `ResizableTaskDrawer` composes the drawer parts. The resize separator is in the header, next to
  the title and outside it. It keeps `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and
  `aria-valuetext`.

Status text has a contrast ratio of at least 4.5:1 in the light and the dark theme.

- `statusTextColors` in `dashboard/app/src/status-colors.ts` holds the warning and danger text
  colors for each theme. The theme gives them as `--workhorse-color-warning-text` and
  `--workhorse-color-danger-text`.
- Retry counts, blocked counts, throttled counts, error rates, and overdue deadlines use these
  colors.
- Text in a tooltip keeps the tooltip text color. The tooltip background is inverted, so a page
  text color has low contrast on it. The failure detail in a status tooltip follows this rule.
- A light badge in the light theme sets its text to 25% lightness with the badge hue. Mantine's
  shade 9 text gives yellow, orange, green, and teal badges less than 4.5:1.
- `dashboard/app/src/accessibility-semantics-ui.test.tsx` computes each ratio from the Mantine
  theme values. It checks the body, striped row, and hovered row backgrounds of a table.

### Human waits

`dashboard_human_waits_v1(p_input jsonb)` accepts `canComplete` and `canSignal`.

- It returns the first 50 human waits in `(created_at, task_id, token_name)` order.
- It returns the first 50 signal waits in `(created_at, task_id, signal_name)` order.
- It projects the `externalWaits` diagnostics from the `health` document into the wire document.

A caller that already read a `health` document for this request supplies it as `health`. Without
it, the function calls `queue_health_v1()` itself. Every backend supplies it. Each backend caches one
document for three seconds:

| Backend    | Reader                             |
| ---------- | ---------------------------------- |
| TypeScript | `createDashboardQueueHealthReader` |
| Go         | `backend.queueHealth`              |
| Python     | `DashboardBackend._queue_health`   |
| Rust       | `Backend::queue_health`            |
| Ruby       | `Backend#queue_health`             |
| JVM        | `Backend.queueHealth`              |
| .NET       | `Backend.QueueHealthAsync`         |

`dashboard_task_detail_v1` takes the same input from the same cache.

### Task detail

`dashboard_task_detail_v1(p_input jsonb)` accepts `id`, `canSignal`, and `health`. It returns SQL
`NULL` when `id` does not exist.

#### Sections

One SQL statement builds each response section from its own named CTE. The sections cover:

- identity and lineage;
- policy, waits, and progress;
- current state and batch executions;
- attempts, checkpoints, and events.

The function also returns `tags`, `humanWait`, and `canCompleteHumanWait`. The host supplies
`canCompleteHumanWait` from its operator mode and completion capability. The shared SPA uses these
fields for the same action menu shown in task listings.

The concurrency utilization of a live task comes from the supplied `health` document. When the
caller supplied none, it comes from `queue_health_v1()`.

TypeScript replaces the returned `durability: null` with `DashboardDurabilityProjector`. Python,
Go, Rust, Ruby, the JVM, and .NET leave it null.

#### Current state and result

`current` carries the terminal result once, under `current.outcome.result`. A result exists only
after a task finishes. A second copy beside it doubled the cost to open a large result, and it gave
no new fact. `current.error` stays, because a live runtime carries one. A reader needs the latest
error without choosing between two branches.

#### Section bounds and truncation

Lineage sections read one row past their bound:

- Dependency and redrive lineage read 101 rows and return 100.
- Child lineage reads 102 rows and returns 101.

The extra row sets each section's `truncated` flag without a separate count.

Attempts, checkpoints, and waits each keep their newest `dashboard_task_detail_limit_v1()` rows.
Events keep their newest `dashboard_task_event_limit_v1()` rows. Each is read newest first and
returned oldest first. Each section reads one row beyond its bound, and the `truncated` object
reports which of the four were cut.

A checkpoint always reports `valueBytes`. It carries `value` only when the stored value is at most
`dashboard_inline_value_bytes_v1()` bytes. Otherwise it sets `valueOmitted`.
`dashboard_checkpoint_value_v1(p_input jsonb)` accepts `id` and `name`. It returns that one
checkpoint with its value, whatever its size.

The three bounds are 200 rows, 1,000 rows, and 65,536 bytes.

#### Planner hint and JIT

The final select cross joins every section with the task row. The `task` CTE therefore carries a
`LIMIT 1` planner hint. The identity is a primary key, so the hint changes no result.

Before schema version 42, the planner estimated nine task rows and multiplied that estimate through
the joins. The plan then cost about 1.2 billion, and PostgreSQL compiled it with JIT on every call.
Compiling took two to five seconds on a loaded host. Executing took about one millisecond.

The function also disables JIT for itself, because its attempt, checkpoint, and event reads still
grow their estimates with history.

### System page

After the backend validates the input, `dashboard_system_v1(p_input jsonb)` accepts `window` as
`15m`, `1h`, or `24h`. It returns the complete version 1 system-page JSON document. The function
calls `queue_health_v1()` once per invocation.

PostgreSQL owns these projections:

- the rolling statistics;
- queue and priority backlog;
- retry buckets and failing types;
- retention, storage, and partition;
- admission-policy and health.

The due-but-unpromoted count uses a 10-second grace period.

#### Page layout

The SPA places the window selector in the Activity over time section. Its `Full + fast tiers`
label states which queue tiers the aggregation covers. That section shows these measures for
the selected window:

- `SystemWindowKpis` shows `kpis.drain`, `kpis.errorRate`, `kpis.queueWait`, and
  `kpis.lease.recovered`.
- `QueueActivity` shows each queue's `enqueuedPerMinute` and `completedPerMinute`.
- The `outcomes` chart and `failingTypes` table use the same window.

Health checks stay above that section, with a `Now` label.

Current operations contains `SystemKpiList`, `QueuePressure`, shared budgets, upcoming retries,
background maintenance, and storage. Those measures do not use the selected window.
Rejected external-wait deliveries keep their fixed trailing-day scope. A change to `window` reloads
the page document. Thus current measures can also change when the snapshot refreshes.

### Settings page

`dashboard_settings_v1(p_input jsonb)` accepts the process-owned `writable` and
`settingsController` flags. It sets `editable` only when both flags are true. It returns the
complete version 1 settings-page JSON document.

- It calls `queue_health_v1()` once.
- It reads `get_maintenance_policy_v1()` and `get_retention_policy_v1()`.
- It sums the trailing statistics hour.
- It includes registry rows whose heartbeat is within the greater of 30 seconds or three registry
  intervals.
- Policy values include application defaults, operator provenance, and `updatedAt`.

### Read-surface benchmark

`pnpm benchmark:dashboard-read-surface` compares the pre-WH-388 and current `tasks` and `queues`
request shapes. Each comparison reports the statements per call and p50, p95, and p99 latency
across at least 20 repetitions. The recorded PostgreSQL 18.4 run is
`docs/benchmarks/results/2026-08-24-dashboard-read-surface.json`.

### Redrive lineage

`redrive_lineage_v1(p_task_id uuid, p_limit integer)` accepts `p_limit` from 1 through 1,001. It
traverses and returns at most that many edges. Deterministic breadth-first order makes every
smaller response a prefix of a larger response. It returns:

- identity columns `source_task_id` and `target_task_id`;
- audit columns `requested_by`, `reason`, and `requested_at`;
- request evidence columns `request_id_preview`, `request_id_digest`, and `request_id_length`;
- state columns `source_state` and `target_initial_state`.

### Other versioned core surfaces

`stat_buckets_v1`, `redact_top_level_keys_v1`, and the maintenance functions remain the other
versioned core surfaces that the dashboard server uses. If a core migration preserves these view
and function contracts, it can change private tables without a dashboard release.

### Task event vocabulary

`DashboardTaskEventType`, the router's `eventTypeValues`, and the wire package's
`dashboardTaskEventTypes` enumerate every lifecycle event that `schema.sql` writes. That includes
coalescing, dependency, child, signal, human-wait, progress, and cancellation events.

- The Events feed exposes that vocabulary as filter values.
- The task drawer renders every returned event.
- When a newer SQL producer returns an unknown type, the drawer uses a humanized type name with a
  neutral color.

#### Enqueue mode section

`TaskEnqueueSection` renders one accepted mode: Idempotency, Debounce, or Throttle. Debounce and
throttle acceptance events also contain shared idempotency metadata. The drawer does not render a
second Idempotency section for them.

`coalescingEvidenceFor` reads `scope`, `key_digest`, `key_length`, `window_ms`, `schedule`, and
`expires_at` from `details.debounce` or `details.throttle`. It reads them on `enqueued`,
`debounced`, and `throttled` events.

- Debounce uses the latest accepted settings.
- If that event is still available, throttle preserves its initial acceptance window.
- The section counts `debounced` or `throttled` events. For debounce tasks, it also counts
  `debounce_rejected` events.
- Rejected proposals stay visible in Task history. They never establish the task's accepted mode.
- The initial request digest comes from safe idempotency metadata. Neither section reads
  `key_preview` or a raw key.

#### Listing enqueue mode

The listing's optional `enqueueMode` is `idempotency`, `debounce`, `throttle`, or null. Workhorse
derives it from the initial `enqueued` event. `dashboard_tasks_v1` and `dashboard_tasks_cursor_v1`
expose this field through the existing page-scoped event lookup.

The UI labels each accepted mode explicitly. For older hosts that supply only `keyed`, it shows
Keyed. The enqueue menu groups Idempotency, Debounce, and Throttle under Enqueue behavior.

### Packages

#### Dashboard contract package

`@stablemates/workhorse-dashboard-contract` exports `DashboardCommandOptions`, `RunningDashboard`,
and `DashboardStandaloneModule<Database>`. The package contains declarations only. It imports
neither `@stablemates/workhorse` nor `@stablemates/workhorse-dashboard`. Both packages depend on
this contract, so neither copies the standalone API from the other.

#### Shared application

`dashboard/app` owns these parts:

- the shared React application, its styles, and its assets;
- the Vite development harness;
- the compiled static bundle in `dashboard/app/dist/app`.

Its private workspace package is `@stablemates/workhorse-dashboard-app`.

The dashboard application keeps its build-time dependency on
`@stablemates/workhorse-dashboard-server`. Vite uses `renderDashboardHtml` for the development
transform, and the browser imports shared wire types. The compiled static archive contains no
Node.js module, so the dependency does not cross the language-neutral delivery boundary.

#### Compatibility package

`typescript/dashboard` is the thin `@stablemates/workhorse-dashboard` compatibility package. Its
build copies three things:

- the compiled library from `dashboard/app/dist/library`. Those modules export the React API and
  re-export the backend entry points under their existing public names.
- `dashboard/app/browser/index.html` to `development/browser/index.html`.
- the non-test files from `dashboard/app/src` to `development/src`.

If `createDashboardDevServer()` runs from the copied `dist/dev.js`, `developmentRoot()` selects that
`development` directory. It supplies the HTML template and the `/src` Vite alias. The programmatic
Vite server sets esbuild's `jsx` mode to `automatic`. TSX modules then import the React JSX runtime
without loading the private application's Vite configuration.

#### Server package

`typescript/dashboard-server` owns the TypeScript backend. Its package is
`@stablemates/workhorse-dashboard-server`. It implements:

- the wire types and RPC client;
- the read model and operator controllers;
- the request host, Node middleware, and standalone server.

The full build copies `dashboard/app/dist/app` to `typescript/dashboard-server/dist/app`.
`dashboardAssetsDirectory()` serves that copied artifact. No React application source lives in the
backend package.

### Public subpaths

Each public name reaches a consumer from exactly one subpath:

| Subpath    | Owns                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `./wire`   | the wire vocabulary, including `dashboardTaskEventTypes` and `dashboardAttemptOutcomes` |
| `./server` | `DashboardWorkspaceLink`, which `.` and `./client` no longer re-export                  |
| `./client` | `createDashboardClient` and `DashboardAuthenticationRoutes`                             |

`sql`, `DashboardSql`, and `CompleteDashboardOptions` are internal and reach no subpath:

- The bare `sql` collides with the `drizzle` and `kysely` template tags in a consumer namespace.
- `CompleteDashboardOptions` only proves a local option array covers its union.

A consumer builds no fragment, because `dashboardDatabase(database)` returns the
`DashboardDatabase` that `createDashboardHost` accepts.

The dashboard application's `.` subpath drops `TaskActivityGroup` and `TaskActivityPeriod`. They
repeated `DashboardActivityGroupBy` and `DashboardActivityPeriod` member for member.

### Controller types

A host implements the five controllers, so `./server` exports every type their methods name.

`DashboardTaskController` returns these results:

- `DashboardRunNowResult`;
- `DashboardSignalTaskResult`;
- `DashboardCompleteHumanWaitResult`;
- `DashboardCancelTaskResult`.

Python and Go already generate the first three. `cancelTask` receives
`DashboardCancellationAuditContext`. Its `reason` is nullable, because an operator can cancel
without stating one.

Each result field resolves from a subpath too:

- `DashboardRunNowStatus` from `./wire`;
- `CancelStatus`, `SignalDeliveryStatus`, `HumanWaitCompletionStatus`, and `Json` from
  `@stablemates/workhorse`.

#### Redrive controllers

| Method               | Returns (from `./server`) | Receives                                                                                                         |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `redriveTask`        | `DashboardRedriveResult`  |                                                                                                                  |
| `redriveDeadLetters` | `DashboardRedriveBatch`   | a `DashboardRedriveFilter` of `queue`, `taskType`, and `tags`; a `limit`; and a `DashboardRedriveCursor` or null |

`DashboardRedriveStatus` and `DashboardRedriveCursor` resolve from `./wire`. The status is
`RedriveStatus` itself, not a hand-copied union.

The `redriveDeadLetters` procedure accepts a `limit` from 1 through `dashboardRedriveBatchMax`,
1,000, which is `MAX_REDRIVE_BATCH_SIZE`. It defaults the limit to
`dashboardRedriveBatchDefault`, 100. Its `cursor` is the `nextCursor` a previous page returned.
`redrive_v1` leaves the source failed. Thus a repeat without a cursor would select the same page
again.

The controllers apply `options.requestedBy` to both methods. Thus a host with a configured trusted actor
owns the `task_redrive` attribution, not the browser.

### Internal read model

Nothing `typescript/dashboard-server/src/server/read-model.ts` declares reaches a subpath. That
covers:

- its thirteen `readDashboard*` functions;
- `createDashboardQueueHealthReader`;
- the `DashboardTasksQuery` and `DashboardEventsQuery` argument types.

The read model is the implementation of `dashboardRouter`, not a second entry point. The read-only
mode, the `canManageWorkers` decision, and the error-stack redaction are in the router.

A host reads through the procedure it already mounts. `readDashboardEvents`,
`readDashboardEventDetail`, `readDashboardWorkers`, and `DashboardEventsQuery` therefore leave
`./server`, which had exposed three of those readers for no stated reason. This repository's own
suites import the module by relative path, as they already do for `readDashboardTaskDetail`.

#### Error-stack redaction

Three readers take a `redactErrorStacks` argument and default it to false:

- `readDashboardTaskDetail`, called directly, returns persisted worker stacks that the mounted
  dashboard never shows.
- `readDashboardEventDetail` needs the argument because `dashboard_event_detail_v1` projects the
  whole `attempt_history.error` for an attempt record. The Events drawer renders it.
- `readDashboardEvents` needs it because a lifecycle event copies the worker error into
  `details.error`.

Two kinds of lifecycle event carry that copy:

- a `failed` or `retry_scheduled` row in `task_event`;
- a fast-tier terminal event that `dashboard_task_event_v1` synthesizes.

With the flag set, task detail, the event feed, and event detail drop `stack` from that
`details.error`. They keep every other details key. All three procedures pass
`DashboardRpcContext.redactErrorStacks`. A host that withholds a stack from task detail therefore
withholds it from every event record that carries a copy.

`startDashboardServer` sets `redactErrorStacks` when the listener is remotely reachable:

- a TCP listener that is not loopback; or
- any listener whose `publicOrigin` names a non-loopback host.

`DashboardCommandOptions.revealErrorStacks`, which the CLI maps from `--reveal-error-stacks`,
disables that default. A loopback or Unix-socket listener without a remote public origin keeps
stacks.

### Read timeouts

Workhorse bounds every dashboard read. `dashboardDatabase(database, timeoutMs)` handles each read in
these steps:

1. It resolves the pool with `connectionPoolOf`.
2. It borrows one connection.
3. It runs the read inside `BEGIN READ
   ONLY` after `set_config('statement_timeout', timeoutMs, true)`, so the bound ends with the
   transaction.

If PostgreSQL cancels a read with SQLSTATE `57014`, the read throws `DashboardReadTimeoutError`.
That error carries `timeoutMs`. The connection is already released.

The bound defaults to `DASHBOARD_STATEMENT_TIMEOUT_MS`, 15,000 ms. `createDashboardHost` takes the
first value set from this order:

1. `DashboardWorkspaceOptions.statementTimeoutMs`;
2. `DashboardHostOptions.statementTimeoutMs`;
3. that default.

Each workspace's `Admin` reads through `boundedQueryable` over the same `DashboardDatabase`, so the
retention preview runs under the bound too.

A `Queryable` with no pool has neither `connect()` nor an attached pool. The dashboard reads it
directly and with no bound. Sending `BEGIN` and the read separately through a shared entry point could leave another
caller's connection inside a transaction. Drizzle over a node-postgres pool and TypeORM attach a
pool. The Prisma and Kysely adapters attach one only through their `pool` option.

### Wire name prefix

The idempotency wire family carries the `Dashboard` prefix every other wire name has:

- `DashboardIdempotencyEvidence`
- `readDashboardIdempotencyEvidence`
- `hasDashboardIdempotencyEvidence`
- `dashboardIdempotencyEventDetailKeys`

Each unprefixed name remains an exported `@deprecated` alias for the rest of the `0.x` line.
Version `1.0.0` removes it.

`MaintenanceLoopCadences` becomes `DashboardMaintenanceLoopCadences`. This keeps the name that
Python and Go share, because every `dashboard/v1` `$defs` key now carries that prefix.

`DashboardCancelStatus` is `CancelStatus` itself, not a hand-copied union. Thus the dashboard
vocabulary and the vocabulary that `Queue.cancel` reports cannot differ.

### Static bundle

`scripts/generate-dashboard-bundle.ts` packages `dashboard/app/dist/app` and
`dashboard/app/browser/login.html` into the deterministic
`dashboard/v1/bundle/read-surface-<readSurfaceVersion>.tar.gz` tracked artifact. `bundle.json`
records the archive name, read-surface version, and SHA-256 digest.

- The generator copies both files into `go/dashboard`, `python/src/workhorse/dashboard`,
  `rust/dashboard`, and `ruby/lib/stablemates/workhorse/dashboard`.
- `pnpm dashboard-bundle:check` rebuilds the application and rejects a stale artifact or language
  copy.
- `go/dashboard.Files` embeds the Go copy.
- Python distributions keep their copy as package data for `importlib.resources`.
- The Rust crate embeds its copy with `include_bytes!` in `rust/src/dashboard/mod.rs`.
- The Ruby gem packages its copy, and `Dashboard#bundle_files` reads it from the gem.
- The JVM has no language copy. `processResources` in `jvm/workhorse/build.gradle.kts` puts the
  canonical `bundle.json` and `read-surface-*.tar.gz` into the jar under `run/workhorse/dashboard`.
  `Bundle` reads both files as jar resources.
- .NET has no language copy. `Workhorse.AspNetCore.csproj` embeds the canonical `bundle.json` and
  `read-surface-*.tar.gz` as resources with the prefix `Workhorse.AspNetCore.Bundle.`. The internal
  `Bundle` type reads both resources and unpacks the `.tar.gz` file once.

#### Version injection

The archive contains no Workhorse package version. Each TypeScript, Python, Go, Rust, Ruby, JVM, or
.NET host adds its own published version to `DashboardRuntimeConfig.workhorseVersion` when it renders
`app/index.html`. The JVM host reads the version through `SdkVersion.current()`. It sends `unknown`
if the build wrote no version resource. The .NET host reads the informational version of its
assembly, which is the train version.
The browser passes that value to `DashboardProps.workhorseVersion`. A direct React embed can supply
the same prop or omit the version display. A package-only version change therefore leaves the
archive digest unchanged.

#### Third-party notices

The Vite `workhorse-dashboard-third-party-notices` plugin derives `app/THIRD_PARTY_NOTICES.txt`.
Its input is the package roots represented in Rollup's production chunk module graph. Each section
records:

- the package name and version;
- the declared licence and source URL;
- the complete contents of every root `LICENSE`, `LICENCE`, `COPYING`, and `NOTICE` file.

If the installed npm archive omitted that file, the plugin requires a version-specific reviewed
copy under `dashboard/app/third-party-legal`. The build fails if a bundled package has no declared
licence or matching legal file. The archive digest makes any dependency or legal-text change stale
until `pnpm dashboard-bundle:generate` updates the canonical copy and the Go, Python, Rust, and Ruby
copies.

### HTML assembly

`dashboard/app/browser/index.html` is the authoritative document template for production and
development. `renderDashboardHtml` is the only assembler:

1. It serializes `DashboardRuntimeConfig` with `JSON.stringify` and escapes each `<` as `\u003c`.
2. It fills the runtime-config placeholder with a replacement callback.
3. It HTML-attribute escapes each host-owned browser module URL.
4. It fills that placeholder with another callback.

The Python, Ruby, Rust, and .NET hosts write their own runtime configuration and escape each `<`
the same way. Python, Ruby, and .NET also escape `>` and `&`. .NET also escapes U+2028 and U+2029.

Dollar patterns in either input stay literal data, not `String.prototype.replace` syntax.
`typescript/dashboard-server/test/html.test.ts` exercises both substitutions against the packaged
template. It requires one runtime assignment with no remaining placeholder.

### Standalone server

`@stablemates/workhorse-dashboard/standalone` re-exports
`@stablemates/workhorse-dashboard-server/standalone.startDashboardServer(database, options)`. The
caller owns `database` and closes it after `RunningDashboard.close()` stops the HTTP listener.

The backend entry owns `Queue`, `createDashboardOperatorControllers`, `createDashboardHost`,
`dashboardNodeMiddleware`, and the Node HTTP server.

- It binds `options.hostname` and `options.port`.
- It uses `/` as the dashboard path.
- It enables queue, task, and worker mutations only when `options.allowMutations` is true.

### Single-admin authentication

`DashboardCommandOptions.authentication` selects the standalone single-admin mode.

#### Credentials

The authentication options contain:

- a username of 1 through 256 characters;
- a `scrypt-v1$<base64url-salt>$<base64url-digest>` password hash;
- an optional session lifetime.

| Setting            | Value                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| scrypt (version 1) | `N=16384`, `r=8`, `p=1`                                                            |
| salt               | at least 16 bytes                                                                  |
| digest             | exactly 32 bytes                                                                   |
| session lifetime   | default 28,800 seconds (8 hours); integer lifetimes from 60 through 86,400 seconds |

The server compares the derived digest with `timingSafeEqual`. A password longer than 1,024
characters never matches.

#### Password rotation

`previousPasswordHash` and `previousPasswordHashExpiresAt` form one optional rotation pair. The
expiry is an absolute ISO 8601 timestamp.

- Before that timestamp, either hash can authenticate.
- A session created with the previous hash expires at the earlier of the configured session
  lifetime and the rotation timestamp.
- At and after the timestamp, the previous hash and every session it created fail authentication.

The CLI maps the pair from `WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH` and
`WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH_EXPIRES_AT`, including their `_FILE` variants.

#### Sessions

The server stores only a random 32-byte session token and its expiry. The browser receives the
token in `__Host-workhorse-dashboard-session` with `Path=/`, `Max-Age`, `Secure`, `HttpOnly`, and
`SameSite=Strict`.

- If a request without a valid session is a `GET` outside `rpc` and `assets/`, it gets `302` to
  `{basePath}/login`. Any other request gets `401` with `{ "error": "Unauthorized" }`.
- `POST /logout` deletes the server record, expires the cookie, and answers `303` to the login path.
  Another method on the logout path answers `405` with `Allow: POST`.
- An expired server record never authorizes a request, even if a client retains its cookie.
- A successful login answers `303` to the mount path. The mount path is the login path without its
  trailing `/login`, or `/` for a root mount.
- Each process retains at most 16 sessions. Login removes expired records. Before the count
  exceeds that bound, login evicts the oldest record.

#### Login page and client

`loginPage()` renders the shipped `login.html` document with the Workhorse mark, light and dark
color schemes, and an optional generic invalid-credential alert. The template contains the single
`<!--__WORKHORSE_LOGIN_ERROR__-->` placeholder.

`DashboardRuntimeConfig.authentication` is either `{ loginUrl, logoutUrl }` for `singleAdmin`, or
`null` for host-owned authorization. `serveApplication()` serializes the request's
`authenticatedActor` as `auditActor`.

`createDashboardClient()` wraps the oRPC fetch adapter. When the authentication routes are
present, it calls `window.location.replace(loginUrl)` once after a `401` response. It leaves those
RPC calls pending until navigation unloads the document. Page-level error handlers therefore cannot
report session expiry as a generic RPC failure.

`Dashboard` shows the authenticated actor in its header menu and submits sign-out to `logoutUrl`
with `POST`.

#### Login rate limit

Single-admin authentication retains at most five login reservations per client in a rolling
60-second window.

1. `loginThrottleKey()` derives the client from the transport peer address in
   `DashboardRequestContext.clientAddress`. An IPv4 address, or an IPv4-mapped IPv6 address, is its
   own key. An IPv6 address shares one key with its /64 prefix. A request without a parseable
   address uses the shared key `unidentified`.
2. Each form submission reserves capacity for its client before scrypt starts. Thus concurrent
   requests cannot bypass the bound.
3. Invalid submissions retain their reservations and return the generic `401` response.
4. Further submissions from that client return `429` with `Retry-After` until its oldest
   reservation leaves the window. Other clients keep their own windows, so this `429` does not
   reach them.
5. A successful login clears that client's reservations.

The server tracks at most `MAX_TRACKED_LOGIN_CLIENTS` (1,024) clients. Before it tracks another,
it removes clients without a current reservation, then the client it started tracking longest
ago.

At most `MAX_CONCURRENT_PASSWORD_HASHES` (2) scrypt derivations run at once across every client.
A submission that finds both slots busy returns `429` with `Retry-After: 1`. The rejection adds no
reservation to the client's window. It also keeps no slot and no place in a queue for the client.

The hash slots are shared, so this `429` can reject a correct password. If two submissions from
any clients are in scrypt, the administrator's login from another address gets `429`. The
administrator must submit again after the slots are free. The per-client window keeps one client's
failures from blocking another client. The hash slots do not, because they bound CPU and memory,
not failures.

`dashboardNodeMiddleware` passes `request.socket.remoteAddress` as `clientAddress` by default. A
host that calls `handle(request, context)` itself supplies an address it established. Behind a
reverse proxy, the socket peer is the proxy. Thus every client of that proxy shares one key, unless
the operator names the proxy in `DashboardNodeMiddlewareOptions.trustedProxies`.

`trustedProxyCheck()` parses that list when the middleware is created. A malformed entry throws a
`TypeError`.

- An entry is one IPv4 or IPv6 address, or one CIDR range such as `10.0.0.0/8`.
- A range must not set bits beyond its prefix. Its prefix is a decimal number from 1 to 32 for
  IPv4, or to 128 for IPv6, without a leading zero.
- An IPv4-mapped IPv6 entry must be written as its IPv4 address. An address with a zone is
  refused.
- An IPv4-mapped IPv6 peer, as a dual-stack socket reports it, matches as its IPv4 address.

`forwardedClientAddress()` then derives `clientAddress` for each request:

1. If the list is empty, or if the list does not contain the socket peer, the answer is the peer.
   The middleware reads no header.
2. A listed peer's request must carry exactly one of `X-Forwarded-For` and `Forwarded`. With both
   or neither, the answer is the peer.
3. The hops are the comma-separated entries of that header. For `Forwarded`, each hop is the single
   `for` parameter of its element. Commas and semicolons inside a quoted string do not separate,
   and a backslash escapes the next character. A `Forwarded` header whose quoted string never
   closes keeps the peer. An optional port, and the brackets around an IPv6 address, are removed.
4. The walk starts at the rightmost hop. A listed hop is a proxy, and the walk continues left. The
   first hop that is not listed is the answer.
5. An unparseable hop, such as `unknown` or `_hidden`, ends the walk. The answer is the listed
   address to its right.
6. When every hop is listed, the answer is the leftmost hop.

`startDashboardServer` passes `DashboardCommandOptions.trustedProxies` to the middleware. It
validates the list before `listen`, and refuses a non-empty list on a Unix socket listener.
[ADR 0093](../decisions/0093-key-single-admin-login-throttling-by-transport-peer.md) records the
identity model, and
[ADR 0094](../decisions/0094-read-the-login-throttle-client-through-trusted-proxies.md) records the
trusted-proxy rules.

#### Process boundary

ADR 0032 makes that process boundary explicit. Built-in authentication supports one standalone
server replica, and a restart revokes every session. Replicated deployments use host-owned
authorization or an identity-aware proxy with its own shared session boundary.

#### CLI credential configuration

The CLI reads `WORKHORSE_DASHBOARD_USERNAME` and `WORKHORSE_DASHBOARD_PASSWORD_HASH`.

- Each value can instead come from its `_FILE` variant, with one trailing line ending removed.
- A direct value and its file variant are mutually exclusive.
- The username and hash must be configured together.

`createDashboardHost` accepts either `authorize` or `singleAdmin`, and rejects both or neither.

### Mutations and attribution

Each state-changing router declaration uses `mutationProcedure`, which stores `mutation: true` in
the oRPC procedure metadata. `isDashboardMutation` resolves the request path against
`dashboardRouter` and reads that metadata. The host therefore does not maintain a second procedure
list.

For every mutation, `rejectCrossOriginMutation` requires an `Origin` header whose parsed origin
exactly matches the request URL origin.

The authenticated actor comes from one of these sources:

- The single-admin session contributes its configured username as
  `DashboardRpcContext.authenticatedActor`.
- An embedded `authorize` callback can return a `DashboardPrincipal` with an `actor`.
- A compatible boolean `true` result uses the server-owned `auditActor`, which defaults to
  `dashboard`.

A principal always wins over the configured audit actor. The Python and Ruby hosts follow the same
rule with `audit_actor`, and the .NET host with `AuditActor`. The Go `Authorize` and Rust `authorize` callbacks cannot return `true`, so
the returned principal's actor is their only attribution.

`auditWithOccurredAt` replaces the parsed browser `audit.actor` with that authenticated actor
before any operator controller runs.

`BoundaryTimeline` reads `details.requested_by` from task events and renders it beside the event's
reason. Cancellation, signal, redrive, and other operator events therefore retain visible
attribution.

### Schema compatibility answer

Every dashboard host checks schema compatibility after authorization and before it serves a
request. It caches only a passing answer.

- A compatibility verdict, such as `schema-too-old`, answers `503` with the verdict's message. That
  message names only codes and versions.
- Any other failure answers `503` with the fixed message "Unable to verify Workhorse schema
  compatibility because the database query failed." A driver error can name a database host, user,
  or path, so the host logs it instead.

| Host       | Where the unexpected failure is logged                                  |
| ---------- | ----------------------------------------------------------------------- |
| TypeScript | OpenTelemetry record `workhorse.dashboard.compatibility_check_failed`   |
| Python     | `logging.getLogger("workhorse.dashboard")`, at error with the traceback |
| Ruby       | the Rack `rack.errors` stream                                           |
| Go         | `slog.ErrorContext` on the default logger                               |
| Rust       | `tracing::error!`                                                       |
| .NET       | the `ILogger` category `Workhorse.AspNetCore.Dashboard`, at `Error`     |

### Listener exposure

`DashboardCommandOptions.socketPath` selects a Unix socket instead of `hostname` and `port`.

- The unauthenticated development bypass accepts only an address in `127.0.0.0/8`, `::1`, or a
  Unix socket.
- A remotely reachable TCP listener without authentication fails before `listen`.
- An unauthenticated loopback or Unix-socket listener also rejects a non-loopback `publicOrigin`.
  An explicit proxy configuration therefore cannot publish the development bypass.
- An authenticated remote TCP listener also requires `publicOrigin`. Its protocol must be HTTPS.

`dashboardNodeMiddleware` ignores `Forwarded` and `X-Forwarded-*` when it constructs the Fetch
request URL. If `publicOrigin` is configured, that canonical HTTP or HTTPS origin supplies the
scheme and authority instead. Secure-cookie and same-origin mutation policy therefore stay
independent of untrusted proxy headers.

The CLI maps `--socket`, `--public-origin`, and `WORKHORSE_DASHBOARD_PUBLIC_ORIGIN` to those
options. It maps the repeatable `--trusted-proxy` and the comma-separated
`WORKHORSE_DASHBOARD_TRUSTED_PROXIES` to `trustedProxies`, and any flag replaces the whole variable
(see [Login rate limit](#login-rate-limit)).

### Login body limit

`MAX_LOGIN_BODY_BYTES` is 4,096 bytes.

- When `content-length` is present, the login endpoint requires decimal non-negative digits. Their
  value must be a safe integer no greater than that bound.
- A malformed, unsafe, or oversized declared length receives `413` before the form is read.
- If the header is absent, `readLoginBody` treats the length as unknown and counts the request
  stream. It keeps at most 4,096 bytes. It cancels the stream when the count crosses the bound, and
  returns `413`.
- A `content-type` that does not start with `application/x-www-form-urlencoded` receives `415`.

### Allowed hosts

`DashboardHostOptions.allowedHosts` lists the `host[:port]` values a host answers to. When it is
set, `createDashboardHost` answers any owned request whose URL host is not listed with 421 and
`{ "error": "Misdirected Request" }`.

- The check runs before the single-admin login and logout routes and before `authorize`.
- Entries compare as `URL.host` does, so letter case and the protocol's default port do not matter.
- An entry that is not a bare `host[:port]` fails construction.

`startDashboardServer` binds first. For a TCP listener without `publicOrigin`, it then sets
`allowedHosts` to two entries: the bound loopback address with its port, and `localhost` with that
port. Two listeners set no list:

- A Unix socket has no host name to check.
- A configured `publicOrigin` replaces the inbound host.

If an embedded host does not set it, that host relies on its application to validate `Host`.

### Browser security headers

`startDashboardServer` sets five browser headers on every response, before the middleware writes.
A dashboard response that names one of them therefore still wins.

- `content-security-policy`
- `x-content-type-options: nosniff`
- `referrer-policy: strict-origin-when-cross-origin`
- `x-frame-options: DENY`
- `x-robots-tag: noindex, nofollow, noarchive`

The policy is:

```text
default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'
```

`unsafe-inline` covers three things:

- the packaged document's two boot scripts;
- the runtime configuration `renderDashboardHtml` writes into it;
- the style elements Mantine injects while the application renders.

`createDashboardHost` sets none of these headers. An embedded application shares the origin with
its own pages. A second policy on the dashboard's responses would intersect with the application's
own. `typescript/dashboard-server/README.md` states the policy an embedder copies.

### Container image

`Dockerfile.dashboard` builds four tarballs: the core, dashboard contract, dashboard server, and
shared dashboard application. It then installs those release-shaped artifacts with production
dependencies into a Node 24 Alpine image pinned by digest.

- The dependencies come from `pnpm deploy --prod`, one deploy per packed package that declares any.
  Every version is therefore the one `pnpm-lock.yaml` records, not whatever a range resolved to on
  the day of the build.
- The four packages themselves are unpacked from the tarballs over the workspace links those
  deploys leave behind.

The image runs as the `node` user, exposes port 3000, binds `0.0.0.0`, and starts the read-only
dashboard command. Its startup contract requires:

- `DATABASE_URL` or `WORKHORSE_DATABASE_URL`;
- both single-admin credential values;
- an HTTPS `WORKHORSE_DASHBOARD_PUBLIC_ORIGIN`.

Behind a reverse proxy, `WORKHORSE_DASHBOARD_TRUSTED_PROXIES` names the proxy so its clients get
separate login windows.

The packed test asserts that the image consumes the generated tarball names. It also asserts that
the image starts the installed standalone CLI through the same remote-listener contract.

### CLI integration

`typescript/core/src/cli/dashboard.ts` imports only the shared contract. It loads the optional
`@stablemates/workhorse-dashboard/standalone` entry and verifies that the module exports
`startDashboardServer`.

The `@stablemates/workhorse` manifest declares `@stablemates/workhorse-dashboard` as an optional
peer. A worker-only installation therefore does not install React or the dashboard package.
`workhorse dashboard` reports the missing optional package before it opens a listener.

#### Argument parsing

The `@stablemates/workhorse` manifest exposes only the `workhorse` binary.

- `parseCommandArgs()` calls Node.js `parseArgs()` with `strict: true` for each command.
- String options accept `--flag value` and `--flag=value`.
- `resolveDatabaseUrl()` uses `--database-url`, `WORKHORSE_DATABASE_URL`, then `DATABASE_URL`.

#### Schema status output

`workhorse schema status
--json` returns `schema.state`, `schema.compatible`, and the other `schema` fields separately from
the `postgres` fields:

| Group      | Fields                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`   | `schema.installedVersion`, `schema.expectedVersion`, `schema.minimumVersion`, `schema.clientProtocolVersion`, `schema.installedProtocolVersions`, `schema.state`, `schema.compatible`, `schema.refusal`, `schema.refusalCode` |
| `postgres` | `postgres.major`, `postgres.version`, `postgres.supported`, `postgres.tested`, `postgres.minimumMajor`, `postgres.level`                                                                                                      |

- `schema.state` is `not-installed`, `behind`, `current`, or `ahead`, and reports position only.
- `schema.compatible` reports whether this build would start against the installed schema.
- `schema.refusal` carries the sentence `assertSchemaCompatible` would throw.
- `schema.refusalCode` carries the `SchemaCompatibilityCode` that error would carry.
- Both `schema.refusal` and `schema.refusalCode` come from the shared `schemaCompatibilityRefusal`.
  Both are null when compatible.

The status command exits 1 when `schema.compatible` is false or `postgres.supported` is false.
`ahead` alone is therefore not a failure.

`workhorse health --json` returns `QueueHealth`.

#### Exit codes

| Condition                         | Exit code |
| --------------------------------- | --------- |
| Help (before database resolution) | 0         |
| Runtime failure                   | 1         |
| Health degradation                | 2         |
| `CliUsageError`                   | 64        |

#### Database failure reporting

If the command cannot use a database, it reports the failure as one sentence, not as a stack.
`describeDatabaseFailure()` in `typescript/core/src/cli/database-failure.ts` recognises:

- the socket and DNS codes `ECONNREFUSED`, `ECONNRESET`, `EHOSTUNREACH`, `ENETUNREACH`,
  `ENOTFOUND`, `EPIPE`, `ETIMEDOUT`, and `EAI_AGAIN`;
- the PostgreSQL SQLSTATE classes `08` and `28`, plus `3D000`.

It searches the error, every member of an `AggregateError`, and each `cause`. Node.js reports one
dial across several addresses as an aggregate.

The sentence names:

- the failing code;
- the host and port, when the failure carries them;
- which of `--database-url`, `WORKHORSE_DATABASE_URL`, or `DATABASE_URL` supplied the value, read
  from `resolvedDatabaseUrlSource()`.

It never prints the URL, which can carry a password. Anything unrecognised keeps its stack, and both
exit 1.
