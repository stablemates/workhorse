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
- Existing installations keep their bound pair until they are upgraded.
- The host does not negotiate concurrent contract versions. It therefore sends no `Deprecation` or
  `Sunset` response headers.

### Shared type names

Every `$defs` key carries the `Dashboard` prefix, whether or not the TypeScript symbol it was
resolved from does. `dashboardDefinitionName` in
`typescript/dashboard-server/spec/response-schemas.ts` applies that rule. The
`names every shared wire type with the Dashboard prefix` test in
`typescript/dashboard-server/test/dashboard-spec.test.ts` pins it to the committed artifact.

The rule prevents a duplicate type in generated bindings. Without it, a core type that reaches a
dashboard response would name a second copy of itself, beside the core one the same SDK already
exports. These core types are all keyed with the prefix:

- `CancelStatus`
- `SignalDeliveryStatus`
- `HumanWaitCompletionStatus`
- `Json`
- `QueueHealthReason`
- `QueueHealthReasonCode`
- `RetentionPolicyImpact`

The prefix names the contract's schema, not the TypeScript symbol, so the core type stays the one
source of the shape. `generate-bindings.ts` resolves a procedure input's local `__schema0` to the
shared `DashboardJson`. `z.toJSONSchema` names `__schema0` inside that input document.

### Artifact generation

The committed dashboard artifacts are the authority, and `dashboardRouter` is their generator. The
SQL flow has the opposite ownership: `sql/schema/current.sql` is the tracked authority, and the
build generates `sql/schema.sql` from it.

`typescript/dashboard-server/spec/generate.ts` derives the schemas from two sources:

- input schemas from the router's Zod inputs via `z.toJSONSchema`;
- response schemas from the checker-resolved `DashboardV1Responses` in
  `typescript/dashboard-server/spec/responses.ts`.

`pnpm dashboard-spec:generate` rewrites the artifacts. `pnpm dashboard-spec:check` and
`typescript/dashboard-server/test/dashboard-spec.test.ts` fail on any divergence. A router change
that alters the wire contract therefore lands only with regenerated, reviewed artifacts. The spec
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
same schema to `procedures.json.html.runtimeConfig`. The server type and versioned schema therefore
cannot drift.

### Conformance fixtures

`dashboard/v1/conformance.json` adds executable HTTP-level conformance fixtures analogous to
`protocol/v1/scenarios.json`:

1. SQL seed steps bring a freshly installed schema to a known state.
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

The connection must have `autocommit=True`. The host rejects transactional connections so a WSGI
request cannot leave locks or an idle transaction behind.

`DashboardPrincipal.actor` is the authenticated identity. `DashboardResponse` lets the authorization
hook return a complete denial or redirect response. `audit_actor` names the actor only when
`authorize` returns `True`, and defaults to `dashboard`.

The host handles a request in this order:

1. A non-empty `allowed_hosts` refuses any other `HTTP_HOST` with 421.
2. `authorize` runs.
3. `assert_sync_compatible` runs.
4. The host rejects cross-origin mutations, before decoding input.
5. It validates through `dashboard_v1.validate_input`.
6. It overwrites `audit.actor`.
7. It calls the private `workhorse.dashboard._backend.DashboardBackend`.

The backend's `procedures()` implements every database-owned contract procedure through versioned
dashboard views and lifecycle functions. The host supplies `enqueueTest` and `setSchedulePaused`,
whose behavior belongs to the embedding runtime.
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

Two functions return one document or SQL `NULL`:

- `workhorse.dashboard_checkpoint_value_v1(p_input jsonb)` returns one complete checkpoint
  document. It returns SQL `NULL` when the task has no checkpoint of that name.
- `workhorse.dashboard_event_detail_v1(p_input jsonb)` returns one complete event-detail document.
  It returns SQL `NULL` when the stable event identity does not exist.

TypeScript, Python, and Go validate the wire input, call the matching function, and decode its
single `jsonb` result. The TypeScript host may add its application-owned durability summary after
`dashboard_tasks_v1` or `dashboard_task_detail_v1` returns. `DashboardDurabilityProjector` is an
in-process callback rather than database state.

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

### Presentation policy

ADR 0037 keeps presentation policy out of those backends. The backends return raw inputs:

- `settings.recommendationInputs` returns health reasons, rollup measurements, fallback-partition
  counts, and the measured enqueue rate.
- `system.status.reasons` returns the database verdict inputs without English checks.
- Retry buckets use `upperBoundMs`.
- Worker rows use `lastHeartbeatAt`.
- Activity returns every group.
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

- `dashboard_task_outcome_v1`: `result` is absent; read it through `dashboard_task_result_v1`.
- `dashboard_task_query_v1`: the routing projection is indexed on `queue_name` and on `task_type`.
  A facet list therefore seeks one row per distinct value. A task list filtered by queue or task
  type prunes on the same indexes.
- `dashboard_task_v1`: `payload` is `redact_top_level_keys_v1(payload, payload_redact_keys)`. The
  key arrays are projected so a reader can report how many keys were withheld.

### Task result and estimate

`dashboard_task_result_v1(p_task_id uuid)` returns one task's terminal result with the
operator-declared `result_redact_keys` removed.

It is a function rather than a view column because the two inputs live apart. The redaction keys
live on `task`, while the result lives on `task_outcome`. Projecting a redacted `result` from
`dashboard_task_outcome_v1` would join every reader of that view to `task`. Those readers include
the task list and the activity chart, which never read a result.
`docs/benchmarks/results/2026-08-22-dashboard-read-surface.json` records both plans.

`dashboard_task_estimate_v1()` returns the planner tuple estimate for the private `task` table.
The dashboard uses it to choose exact counts or estimates without naming the private relation.

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
`humanWait: { name, deadlineAt, quickAction }`, with no `context`. A listing is polled, and one
context can hold 65,536 bytes. `dashboard_human_wait_quick_action_v1` derives `quickAction`:

1. `context.dashboard.quickAction.label` is a string.
2. `context.dashboard.quickAction` has a `result` key, whatever its value.
3. The label is not empty after trimming whitespace.

Trimming removes the characters JavaScript's `String.prototype.trim` removes, so a label a row
offers is one the SPA accepts from the full context. When all three hold, `quickAction` is
`{ label }`, with the trimmed label cut to 200 characters.
Otherwise it is `null`. When an operator picks the quick action from a row, the SPA reads
`dashboard.taskDetail`, whose `humanWait` keeps the full context. It confirms the result from that
context. If the task no longer waits on that decision, it reports that and sends nothing.

Removing `context` from listed rows was an in-place `dashboard/v1` break under the ADR 0064
exception in [compatibility.md](../compatibility.md).

#### Total and `hasMore`

`count` defaults to `none`.

- With `none`, the function reads `page * pageSize + 1` matching identities. It reports how many it
  read as `total`, and sets `hasMore` when it read the extra row.
- `total` is exact whenever it is at most `page * pageSize`. Otherwise it is one more than the page
  bound, and the caller knows only that more exist.
- With `count: exact`, `total` counts every matching task. That count reads the whole selection
  rather than one page of it.

#### Query composition

The function is PL/pgSQL and composes its query, so it names which tasks the request can reach
before the runtime and outcome joins read a row. It picks the first matching scope:

1. A `tags` request adds a `task_scope` CTE that seeks `task_tags_gin_idx`.
2. Otherwise, a `queue` or `taskType` request adds one that seeks `task_query_queue_created_idx` or
   `task_query_type_created_idx`.
3. Otherwise, no scope is added, and `task_rows` reads `dashboard_task_v1` directly.

Only fixed SQL fragments are composed. The request stays in the bound JSON parameter, so the
planner sees each filter as a value it can seek. The filter list below the scope still applies
every predicate. A request that names both a tag and a queue therefore seeks the tag index and
filters on the queue.

The tag array reaches the scan through `dashboard_tag_filter_v1(p_tags jsonb)`. That immutable
function returns the request's `tags` as `text[]`. An inline
`ARRAY(SELECT jsonb_array_elements_text(...))` would not work. It is a subquery, which the planner
evaluates once per execution and never folds into the scan. `task_tags_gin_idx` would stay
unreachable behind it.

#### Enqueued event lookup

Both task listings constrain their page-scoped `enqueued` event lookup to the interval from
`task.created_at` through `statement_timestamp()`. An enqueued event is committed before a
dashboard read statement can observe it. The bounds prune daily partitions before the task existed
and prepared partitions after the read began. Both functions disable JIT for input-specific plans.

### Cursor task listing

`dashboard_tasks_cursor_v1(p_input jsonb)` backs the additive `tasksCursor` procedure.

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
- Live and terminal rows use separate query branches, preserving the terminal update-time index.
- No update-time index is added to live rows, because heartbeats must retain HOT eligibility.
- It reads the tag filter through `dashboard_tag_filter_v1` for the same reason `tasks` does.
- A `queue` or `taskType` request adds a join to `dashboard_task_query_v1`. That projection's index
  then prunes before the ordering walk reads a task.
- Absent both, no join enters the query. The walk stays on the update-time indexes, which already
  return the page in order.

#### SPA cursor navigation

The SPA uses cursor navigation.

- It preserves a legacy page-number link by walking `tasksCursor` from the first page. The walk
  stops at the requested page or the last available page.
- It carries the cursor in the URL. Its pager offers a first-page control that drops the cursor. The
  control keeps every filter, the sort, the page size, the chart settings, and the open drawer.
- While a page is pinned, the SPA offers a link back to the first page after the refresh control.
  The paused indicator alone names neither the cause nor the way back.
- A narrow viewport states the same fact at the pager instead, where that row has room for it.
- A cursor request answered with `previousCursor: null` was answered from the first page. The SPA
  then replaces the URL to drop the anchor it no longer needs.
- That judgement pairs each answer with the request that asked for it. During a pager click, the
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
one seek per partition. The list also stops at 1,000 values. A worker that ran tasks and then left
the registry is therefore still offered as a filter while its history is retained.

The tag sample walks `task_created_retention_idx` newest first and returns at most 1,000 distinct
values. No index supports a distinct array scan, so the bound keeps facet latency independent of
the full task table.

### Activity

`dashboard_activity_v1(p_input jsonb)` builds the activity chart:

1. It maps `period` to its trailing window and bucket width.
2. It selects tasks whose runtime or outcome changed inside the window.
3. It applies `filter`, `groupBy`, `tags`, `queue`, and `worker`.

It probes `dashboard_attempt_history_v1` for the latest worker only when worker grouping or
filtering requires that value. It returns the complete version 1 activity JSON document. UTC
bucket timestamps are rendered by `dashboard_iso_v1`. The wire validator limits each string filter
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

A success clears the failure. A result for a different query is never drawn under the current
controls. Series keys come from `activityChartModel`, so a group named `a.b`, `bucket`, or `other`
cannot collide with another series or with the axis key.

### Event feed

`dashboard_events_v1(p_input jsonb)` returns the complete version 1 events JSON document. The
document includes the effective range and the retention days from `dashboard_retention_policy_v1`.

#### Time range and filters

The function accepts a fixed `window`, or an inclusive `rangeStart` and exclusive `rangeEnd`.
Callers must supply both ISO-8601 range instants, and `rangeEnd` must be later than `rangeStart`.

It applies the time bound, `kind`, `queue`, `taskType`, `types`, and `taskId` before merging
`dashboard_task_event_v1` with `dashboard_attempt_history_v1`. Each source reads at most
`page * pageSize + 1` rows before the merge. Before the backend calls the function, the wire
validator limits `page` to `dashboardPageMax`, 100, and each string filter to 200 characters.

The event listing also accepts `worker` and `search`. Both filters apply before source limits and
in the exact count. Both strings are limited to 200 characters.

- `worker` matches the recorded attempt worker, including lifecycle records linked to that
  attempt. An event's explicit `details.worker_id` takes precedence over the linked attempt worker.
- `search` performs a case-insensitive literal substring match. It covers task ID, queue, type,
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
`page` validator and the Events pager both read it. The pager offers at most that many pages. When
`total` exceeds `dashboardPageMax * pageSize`, the page says how many events the pager reaches.
`parseEventsLocation` and `eventsLocationHref` read a `page` above `dashboardPageMax` as
`dashboardPageMax`, so a bookmarked URL cannot ask for a page the router rejects.

On the last page, Continue with older events sets a custom range. `continueEventsRange` keeps the
current `rangeStart` and ends the range 1 millisecond after the oldest event shown, because
`rangeEnd` is exclusive. Events at that instant that the last page did not reach stay in range. The
events it did reach at that instant appear again.

When that end would not move the range back, every page shares the oldest instant. The range then
ends at that instant, and the page says that continuing skips the rest of its events. When the
oldest event shown sits at `rangeStart`, the range holds nothing older, and the page offers no
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
`scheduleCount` counts every definition. When it exceeds the rows returned, the Schedules page
says `Showing 50 of <scheduleCount> schedules`.

Each definition includes `evaluatorCount`. It counts registrations that meet both conditions:

- `schedule_namespaces` contains the definition namespace;
- `last_heartbeat_at` is no older than 30 seconds.

Application rows return `configuredEnabled`, `paused`, `pausedBy`, `pausedReason`, `pausedAt`, and
effective `active`.

On the Schedules page:

- Each application schedule's occurrence count links to `/tasks?queue=<queue>&type=<task type>` in
  a new browser tab. The task listing has no schedule filter. The link therefore narrows by the
  schedule's destination queue as well as its task type.
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
`prune_terminal_storage_v1` gates its follow-up pass on the same delay.

The Schedules page uses the tick state's completion time as the built-in tick row's last run.

Each routine includes `recordedRunCount` for its retained total and its five newest recorded
`maintenance_run` rows. The Schedules page shows:

- the retained total, labelled as such;
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

### Timestamp rendering

`dashboard_iso_v1(p_value timestamptz)` renders procedure timestamps in UTC with millisecond
precision and a `Z` suffix. Every backend returns a procedure document as PostgreSQL wrote it. Task
payloads, results, checkpoints, progress, and event details keep their stored text, including
strings that look like timestamps.

### Human waits

`dashboard_human_waits_v1(p_input jsonb)` accepts `canComplete` and `canSignal`.

- It returns the first 50 human waits in `(created_at, task_id, token_name)` order.
- It returns the first 50 signal waits in `(created_at, task_id, signal_name)` order.
- It projects the `externalWaits` diagnostics from the `health` document into the wire document.

A caller that already read a `health` document for this request supplies it as `health`. Without
it, the function calls `queue_health_v1()` itself. Every backend supplies it, each caching one
document for three seconds:

| Backend    | Reader                             |
| ---------- | ---------------------------------- |
| TypeScript | `createDashboardQueueHealthReader` |
| Go         | `backend.queueHealth`              |
| Python     | `DashboardBackend._queue_health`   |

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
Go, and Rust leave it null.

#### Current state and result

`current` carries the terminal result once, under `current.outcome.result`. A result exists only
once a task finishes. A second copy beside it doubled what a large result cost to open and named no
new fact. `current.error` stays, because a live runtime carries one. A reader needs the latest
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
`dashboard_inline_value_bytes_v1()` bytes, and sets `valueOmitted` otherwise.
`dashboard_checkpoint_value_v1(p_input jsonb)` accepts `id` and `name`. It returns that one
checkpoint with its value, whatever its size.

The three bounds are 200 rows, 1,000 rows, and 65,536 bytes.

#### Planner hint and JIT

The final select cross joins every section with the task row. The `task` CTE therefore carries a
`LIMIT 1` planner hint. The identity is a primary key, so the hint changes no result.

Before schema version 42, the planner estimated nine task rows and multiplied that estimate through
the joins. The plan then cost about 1.2 billion, and PostgreSQL compiled it with JIT on every call.
Compiling took two to five seconds on a loaded host; executing took about one millisecond.

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
label makes the aggregation's queue-tier coverage explicit. That section shows these measures for
the selected window:

- `SystemWindowKpis` shows `kpis.drain`, `kpis.errorRate`, `kpis.queueWait`, and
  `kpis.lease.recovered`.
- `QueueActivity` shows each queue's `enqueuedPerMinute` and `completedPerMinute`.
- The `outcomes` chart and `failingTypes` table use the same window.

Health checks remain above that section, with a `Now` label.

Current operations contains `SystemKpiList`, `QueuePressure`, shared budgets, upcoming retries,
background maintenance, and storage. Those measures do not use the selected window.
External-wait rejected deliveries retain their fixed trailing-day scope. Changing `window` reloads
the page document, so current measures can also change as the snapshot refreshes.

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
versioned core surfaces used by the dashboard server. A core migration may change private tables
without a dashboard release when it preserves these view and function contracts.

### Task event vocabulary

`DashboardTaskEventType`, the router's `eventTypeValues`, and the wire package's
`dashboardTaskEventTypes` enumerate every lifecycle event written by `schema.sql`. That includes
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
- Throttle preserves its initial acceptance window when that event remains available.
- The section counts `debounced` or `throttled` events. For debounce tasks, it also counts
  `debounce_rejected` events.
- Rejected proposals remain visible in Task history and never establish the task's accepted mode.
- The initial request digest comes from safe idempotency metadata. Neither section reads
  `key_preview` or a raw key.

#### Listing enqueue mode

The listing's optional `enqueueMode` is `idempotency`, `debounce`, `throttle`, or null. It is
derived from the initial `enqueued` event. `dashboard_tasks_v1` and `dashboard_tasks_cursor_v1`
expose this field using the existing page-scoped event lookup.

The UI labels each accepted mode explicitly. It falls back to Keyed for older hosts that only
supply `keyed`. The enqueue menu groups Idempotency, Debounce, and Throttle under Enqueue behavior.

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

The dashboard application retains its build-time dependency on
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
restated `DashboardActivityGroupBy` and `DashboardActivityPeriod` member for member.

### Controller types

A host implements the five controllers, so `./server` exports every type their methods name.

`DashboardTaskController` returns these results:

- `DashboardRunNowResult`;
- `DashboardSignalTaskResult`;
- `DashboardCompleteHumanWaitResult`;
- `DashboardCancelTaskResult`.

Python and Go already generate the first three. `cancelTask` receives
`DashboardCancellationAuditContext`. Its `reason` is nullable, because an operator may cancel
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
`RedriveStatus` itself rather than a hand-copied union.

The `redriveDeadLetters` procedure accepts a `limit` from 1 through `dashboardRedriveBatchMax`,
1,000, which is `MAX_REDRIVE_BATCH_SIZE`. It defaults the limit to
`dashboardRedriveBatchDefault`, 100. Its `cursor` is the `nextCursor` a previous page returned.
`redrive_v1` leaves the source failed, so an uncursored repeat would select the same page again.

The controllers apply `options.requestedBy` to both methods. A host with a configured trusted actor
therefore owns the `task_redrive` attribution rather than the browser.

### Internal read model

Nothing `typescript/dashboard-server/src/server/read-model.ts` declares reaches a subpath. That
covers:

- its thirteen `readDashboard*` functions;
- `createDashboardQueueHealthReader`;
- the `DashboardTasksQuery` and `DashboardEventsQuery` argument types.

The read model is the implementation of `dashboardRouter`, not a second way in. The router is where
the read-only mode, the `canManageWorkers` decision, and the error-stack redaction live.

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
turns that default off. A loopback or Unix-socket listener without a remote public origin keeps
stacks.

### Read timeouts

Every dashboard read is bounded. `dashboardDatabase(database, timeoutMs)` handles each read in
these steps:

1. It resolves the pool with `connectionPoolOf`.
2. It borrows one connection.
3. It runs the read inside `BEGIN READ
ONLY` after `set_config('statement_timeout', timeoutMs, true)`, so the bound ends with the
   transaction.

A read PostgreSQL cancels with SQLSTATE `57014` throws `DashboardReadTimeoutError`, which carries
`timeoutMs`. The connection is already released.

The bound defaults to `DASHBOARD_STATEMENT_TIMEOUT_MS`, 15,000 ms. `createDashboardHost` takes the
first value set from this order:

1. `DashboardWorkspaceOptions.statementTimeoutMs`;
2. `DashboardHostOptions.statementTimeoutMs`;
3. that default.

Each workspace's `Admin` reads through `boundedQueryable` over the same `DashboardDatabase`, so the
retention preview runs under the bound too.

A `Queryable` with no pool — neither `connect()` nor an attached pool — is read directly and
unbounded. Sending `BEGIN` and the read separately through a shared entry point could leave another
caller's connection inside a transaction. Drizzle over a node-postgres pool and TypeORM attach a
pool. The Prisma and Kysely adapters attach one only through their `pool` option.

### Wire name prefix

The idempotency wire family carries the `Dashboard` prefix every other wire name has:

- `DashboardIdempotencyEvidence`
- `readDashboardIdempotencyEvidence`
- `hasDashboardIdempotencyEvidence`
- `dashboardIdempotencyEventDetailKeys`

Each unprefixed name remains an exported `@deprecated` alias for the rest of the `0.x` line. It is
removed in `1.0.0`.

`MaintenanceLoopCadences` becomes `DashboardMaintenanceLoopCadences`, keeping the name Python and
Go share, because every `dashboard/v1` `$defs` key now carries that prefix.

`DashboardCancelStatus` is `CancelStatus` itself rather than a hand-copied union. The dashboard
vocabulary and the one `Queue.cancel` reports therefore cannot drift.

### Static bundle

`scripts/generate-dashboard-bundle.ts` packages `dashboard/app/dist/app` and
`dashboard/app/browser/login.html` into the deterministic
`dashboard/v1/bundle/read-surface-<readSurfaceVersion>.tar.gz` tracked artifact. `bundle.json`
records the archive name, read-surface version, and SHA-256 digest.

- The generator copies both files into `go/dashboard` and `python/src/workhorse/dashboard`.
- `pnpm dashboard-bundle:check` rebuilds the application and rejects a stale artifact or language
  copy.
- `go/dashboard.Files` embeds the Go copy.
- Python distributions retain their copy as package data for `importlib.resources`.

#### Version injection

The archive contains no Workhorse package version. Each TypeScript, Python, or Go host adds its own
published version to `DashboardRuntimeConfig.workhorseVersion` when it renders `app/index.html`.
The browser passes that value to `DashboardProps.workhorseVersion`. A direct React embed may supply
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
until `pnpm dashboard-bundle:generate` updates the canonical, Go, and Python copies.

### HTML assembly

`dashboard/app/browser/index.html` is the authoritative document template for production and
development. `renderDashboardHtml` is the sole assembler:

1. It serializes `DashboardRuntimeConfig` with `JSON.stringify` and escapes each `<` as `\u003c`.
2. It fills the runtime-config placeholder with a replacement callback.
3. It HTML-attribute escapes each host-owned browser module URL.
4. It fills that placeholder with another callback.

The Python, Ruby, and Rust hosts write their own runtime configuration and escape each `<` the
same way. Python and Ruby also escape `>` and `&`.

Dollar patterns in either input remain literal data rather than `String.prototype.replace` syntax.
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

- A request without a valid session gets `302` to `{basePath}/login` when it is a `GET` outside
  `rpc` and `assets/`. Any other request gets `401` with `{ "error": "Unauthorized" }`.
- `POST /logout` deletes the server record, expires the cookie, and answers `303` to the login path.
  Another method on the logout path answers `405` with `Allow: POST`.
- An expired server record never authorizes a request, even if a client retains its cookie.
- A successful login answers `303` to the mount path. The mount path is the login path without its
  trailing `/login`, or `/` for a root mount.
- Each process retains at most 16 sessions. Login removes expired records and evicts the oldest
  record before exceeding that bound.

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
2. Each form submission reserves capacity for its client before scrypt begins, so concurrent
   requests cannot bypass the bound.
3. Invalid submissions retain their reservations and return the generic `401` response.
4. Further submissions from that client return `429` with `Retry-After` until its oldest
   reservation leaves the window. Other clients keep logging in.
5. A successful login clears that client's reservations.

The server tracks at most `MAX_TRACKED_LOGIN_CLIENTS` (1,024) clients. Before it tracks another,
it removes clients without a current reservation, then the client it started tracking longest
ago.

At most `MAX_CONCURRENT_PASSWORD_HASHES` (2) scrypt derivations run at once across every client.
A submission that finds both slots busy returns `429` with `Retry-After: 1`. It reserves nothing.

`dashboardNodeMiddleware` passes `request.socket.remoteAddress` as `clientAddress` by default. A
host that calls `handle(request, context)` itself supplies an address it established. Behind a
reverse proxy the socket peer is the proxy, so every client of that proxy shares one key unless
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

1. With an empty list, or when the socket peer is not listed, the answer is the peer. No header is
   read.
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
- An embedded `authorize` callback may return a `DashboardPrincipal` with an `actor`.
- A compatible boolean `true` result uses the server-owned `auditActor`, which defaults to
  `dashboard`.

A principal always wins over the configured audit actor. The Python and Ruby hosts follow the same
rule with `audit_actor`. The Go `Authorize` and Rust `authorize` callbacks cannot return `true`, so
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
  stream. It retains at most 4,096 bytes, cancels the stream as soon as it crosses the bound, and
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

An embedded host that leaves it unset relies on its application to validate `Host`.

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

A database the command could not use is reported as one sentence rather than a stack.
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

It never prints the URL, which may carry a password. Anything unrecognised keeps its stack, and both
exit 1.
