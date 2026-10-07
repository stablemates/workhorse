# Workhorse architecture: operations and CLI

This page is part of the [Workhorse architecture reference](../architecture.md). It owns
deployment synchronization, the worker process lifecycle, the command-line entry points, the
administrative CLI and TUI, and operational limits.

## Deployment synchronization

### Schedule definitions

`Queue.syncSchedules(namespace, definitions, { prune })` is a desired-state reconciler:

1. It validates stable namespace and schedule names plus queue task definitions, including
   optional retry policies.
2. It atomically upserts deployment intent through `sync_schedule_definitions_v2`. By default it
   deactivates omitted names. It does not change the durable operator pause.
3. A per-namespace advisory lock serializes concurrent deployments of the same namespace.

Because definitions live only in the target database, a deployment is one transaction. There is no
second metadata database to converge.

Every material definition change increments a revision, and worker fires pass the revision they
loaded. A stale in-process schedule therefore becomes a no-op instead of running a new payload at
an old cadence.

Before a disable deployment returns, definition row locking makes it wait for a fire that already
began.

### Contract stamping

Before the write, every SDK applies each task type's current contract to the definitions:

| SDK        | How it applies the contract                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| TypeScript | `taskAcceptance`                                                                                                |
| Go         | `applyScheduleContracts`                                                                                        |
| Python     | `Queue.sync_schedules` and `AsyncQueue.sync_schedules` read `get_contract_definition_v1` once per distinct type |
| Rust       | `Queue::sync_schedules` reads `get_contract_definition_v1` once per distinct type                               |
| Ruby       | `Queue#sync_schedules` reads `get_contract_definition_v1` once per distinct type                                |

The four SDKs other than TypeScript bypass their contract cache. The reason is that
`fire_schedule_v1` never checks `contract_policy`, so a stale version would persist on every
occurrence.

A payload that fails the schema raises the SDK's contract validation error and writes nothing.
`protocol/v1/schedules.json` fixture `contracted-schedule-definition` covers the stamped fields.

### Concurrency policies

`Queue.syncConcurrencyPolicies(namespace, definitions, { prune })` reconciles queue dispatch
budgets in the same target database.

- A queue has one namespace owner.
- Concurrent synchronization serializes before ownership checks.
- A second namespace cannot replace the owner silently.
- Scheduled definitions retain their `concurrencyKey`. `fire_schedule_v1` sends it through
  ordinary enqueue admission metadata.

## Worker process lifecycle

Three layers build a worker process:

- `defineWorkerProcess()` declares a process-owned adapter and one or more worker configurations.
- `startWorkerProcess()` provides framework-neutral orchestration without global signals.
- `runWorkerProcess()` and `workhorse worker --config` add the standalone Node lifecycle.

### Graceful shutdown

The first `SIGINT` or `SIGTERM` marks readiness false and calls `stop()` on every Worker. Then:

- Later claim requests stop.
- Active handlers and their worker-level heartbeat batch continue.
- Adapter resources close only after every run loop settles.

A claim transaction already in flight may commit after shutdown begins. The worker drains that
committed lease rather than abandoning it.

Process termination does not synthesize durable task cancellation or abort a handler.

### Shutdown deadline and failure

A configurable deadline, 25 seconds by default, prevents an uncooperative handler from blocking
termination forever. `shutdownTimeoutMs` sets it: a safe integer from 1 through 3,600,000, with a
default of 25,000 ms.

| Event                          | Exit                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| Second signal                  | Conventional signal code                                                 |
| Missed deadline                | Code 1                                                                   |
| Unexpected worker-loop failure | Stops sibling workers, applies the same bounded drain, fails the process |

Hard termination leaves active leases for ordinary fenced expiry recovery. A failed process lets an
external supervisor restart it.

### Probe listener

The optional probe-only listener reports liveness while running or draining. It reports readiness
only while accepting claims. It does not expose application HTTP ingress, queue data, or mutations.

## Command-line entry points

### Dispatcher and exit codes

The published `@stablemates/workhorse` package declares one `bin`, `workhorse`, which resolves to
`dist/src/cli/workhorse.js`.

That dispatcher owns every documented command: `init`, `schema`, `worker`, `dashboard`, `admin`,
`tui`, and `health`. `workhorse --help` lists them, and `workhorse --version` prints the package
version.

Exit codes are shared across commands:

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Success                                                                        |
| 1    | Runtime failure or an unusable schema verdict                                  |
| 2    | Queue degradation reported by `health`                                         |
| 64   | Usage error, including an unknown command, an unknown flag, or a missing value |

### Repository scripts outside the dispatcher

`typescript/core/src/cli/benchmark.ts` and `typescript/core/src/cli/reset-db.ts` are repository
scripts rather than commands of that dispatcher.

- `tsconfig.build.json` excludes both, so neither module reaches `dist` or the npm tarball.
- That exclusion also drops `typescript/core/benchmarks/`. The benchmark script is its only
  importer.
- Both files stay under `typescript/core/src/cli/` and stay typechecked by
  `typescript/core/tsconfig.source.json`.

A contributor runs the two from source through the root package scripts `pnpm benchmark` and
`pnpm db:reset:*`. That is why `docs/benchmarking.md` spells the benchmark invocation
`pnpm benchmark -- --help` and never `workhorse benchmark`.

### `workhorse init`

`workhorse init` scaffolds a worker configuration for an existing project.

#### Project detection

The command reads the target directory's `package.json`. `detectProject` in
`typescript/core/src/cli/init.ts` derives three facts from its dependencies:

- **ORM:** `drizzle`, `prisma`, `typeorm`, `kysely`, or plain `pg`.
- **Web framework:** `hono`, `express`, `fastify`, `next`, or `none`.
- **Package manager:** `pnpm`, `npm`, `yarn`, or `bun`.

`detectPackageManager` decides the package manager in this order:

1. The `packageManager` field.
2. The directory's lockfile, checked in this order: `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`,
   `yarn.lock`, `package-lock.json`, `npm-shrinkwrap.json`. Bun's own lockfile therefore decides
   before the `yarn.lock` it may also write.
3. `pnpm`, only when the project declares neither.

#### Output

The command writes `workhorse.config.ts`. When the project declares no TypeScript dependency, it
writes `workhorse.config.js` instead.

It then prints three things:

- the schema install command;
- the worker command;
- a framework-shaped dashboard mount snippet.

For an `npm` project, the commands are printed as `npm exec --no --`. That form runs the local
binary or fails. Bare `npx` would fetch an unrelated registry package of that name.

The snippet is printed only. `init` writes no route file and edits no existing file.

#### Options

`workhorse init` takes two options besides `--help`:

- `--dir <path>` names the project directory, resolved against the current working directory. The
  default is the current directory.
- `--force` rewrites the generated configuration when one already exists. Without it, an existing
  `workhorse.config.ts` or `workhorse.config.js` is left untouched. The command says so, and it
  still prints the detection result and the next steps.

## Administrative CLI and TUI

### Shared admin client

`workhorse admin` and `workhorse tui` are thin fronts over one shared client,
`WorkhorseAdminClient` in `typescript/core/src/cli/admin-client.ts`.

| Backing API | Client operations                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Admin`     | `listTasks`, `getTask`, `getTaskTimeline`, `listDeadLetters`, `queueMetricSnapshot`, `schedules`, `listWorkers`, `listCheckpoints`, `getCheckpoint`, `listWaits`, `getWait`, `listHumanWaits`, `listSignalWaits`, policy reads, `redrive`, `redriveMany`, `pauseQueue`, `resumeQueue`, `purgeQueue`, `setWorkerPaused`, `health` |
| `Queue`     | `cancel`, `sendSignal`, `completeHumanWait`                                                                                                                                                                                                                                                                                      |

Queue status still merges metric snapshots with `workhorse.queue_control`. Namespace discovery
reads `workhorse.schedule_definition`.

### Inspection commands

The inspection commands are:

- `admin tasks`
- `admin task <id>`
- `admin timeline <id>`
- `admin checkpoints <task-id>`
- `admin waits <task-id>`
- `admin external-waits`
- `admin failures`
- `admin queues`
- `admin schedules`
- `admin workers`
- `admin maintenance`

By default, each renders an aligned text table or key/value listing. With `--json`, each emits the
underlying API result. Bigint fence tokens and schedule revisions serialize as strings.
`adminJsonReplacer` in `typescript/core/src/cli/admin-format.ts` does that serialization. That file
owns all row projection shared by the CLI and the TUI.

Listing filters:

- `--queue`
- `--type`
- `--state`, repeatable or comma-separated, validated against the `TaskState` union
- `--limit`
- `--namespace`, for schedules

#### Checkpoints and waits

`admin checkpoints <task-id>` renders `Admin.listCheckpoints`. `admin waits <task-id>` renders
`Admin.listWaits` over `workhorse.task_wait`.

Both accept `--name <name>` to render the single `Admin.getCheckpoint` or `Admin.getWait` read
instead of the list. A name the task never recorded prints to stderr and exits 1, matching
`admin task`.

#### External waits

`admin external-waits` is the fleet-wide read. It lists boundaries only; `admin signal` and
`admin complete-human` answer them.

It runs `Admin.listHumanWaits` and `Admin.listSignalWaits` concurrently through
`WorkhorseAdminClient.externalWaits`. Under `--json` it emits
`{"human": {"items", "nextCursor"}, "signal": {"items", "nextCursor"}}`.

The table merges both lists oldest-first with a `KIND` column. Only a human decision carries
`CONTEXT`.

`--limit` applies to both lists and is capped at `MAX_EXTERNAL_WAIT_LIST_SIZE` (1,000).

Each list pages independently, because `ExternalWaitCursor` is scoped to one list.
`--human-cursor` and `--signal-cursor` each take back the exact JSON `nextCursor` object the
previous page printed. A value that is not an object with string `createdAt`, `taskId`, and `name`
fields is a usage error exiting 64.

### Pagination and range filters

`admin tasks`, `admin timeline`, and `admin failures` accept `--cursor` containing their exact JSON
`nextCursor`. Text output prints the continuation too. `parseCursor` preserves timestamp strings
without converting them to JavaScript dates.

Required cursor fields:

| Command          | Required fields                            |
| ---------------- | ------------------------------------------ |
| `admin tasks`    | `createdAt`, `taskId`, `signature`         |
| `admin failures` | `finishedAt`, `taskId`                     |
| `admin timeline` | `taskId`, `occurredAt`, `kind`, `recordId` |

For timelines, `kind` must be `event` or `attempt`, and the task must match. Malformed cursor
shapes exit 64.

PostgreSQL still verifies task-list signatures against the normalized filters. These pages remain
weakly consistent; CLI continuation adds no snapshot guarantee.

Range filters:

- Tasks accept `--created-after` and `--created-before`.
- Failure listings and bulk recovery accept `--finished-after`, `--finished-before`, repeated
  `--tag` (all required), and `--error-name`.

`parseDateRange` requires finite ISO timestamps with explicit timezones and increasing bounds.
Lower bounds are inclusive and upper bounds exclusive.

Tasks, timelines, failures, and bulk recovery cap `--limit` at 1,000. The default is 100.

Inapplicable selection, delivery, or dry-run flags exit 64 rather than being ignored.

### Guarded commands

The guarded commands are:

- `admin cancel <task-id>`
- `admin redrive <task-id>`
- `admin pause <queue>`
- `admin resume <queue>`
- `admin purge <queue>`
- `admin set-tier <queue>`
- `admin set-history <queue>`
- `admin pause-worker <worker-id>`
- `admin resume-worker <worker-id>`
- `admin redrive-many`
- `admin repair-dependencies`
- `admin signal <task-id>`
- `admin complete-human <task-id>`

#### Safety checks

Two independent checks gate every mutation:

1. **Explicit target environment.** The command requires `--env <database>`.
   `WorkhorseAdminClient.confirmEnvironment` compares it against `current_database()` on the live
   connection.
   - A mismatch throws `AdminSafetyError`. The CLI reports `Refused:` and exits 1.
   - The check exists because ambient `WORKHORSE_DATABASE_URL`/`DATABASE_URL` values can point a
     shell at a database the operator did not intend.
   - Success returns a `ConfirmedEnvironment` token. Every mutation method on the client requires
     that token as its first parameter, so no front end can reach a destructive operation around
     the check.
2. **Confirmation.** Without `--yes`, an interactive session must retype the exact target — task
   id, queue name, or worker id — at a prompt written to stderr. `admin repair-dependencies` asks
   for the literal target `dependencies`.
   - A mismatched answer changes nothing and exits 1.
   - A non-interactive session without `--yes` is a usage error.

#### Audit fields and request identity

Every guarded command except `admin cancel`, `admin signal`, `admin complete-human`, and
`admin set-history` requires `--reason`. They record `--actor` (default `workhorse-admin`).

Existing controls default `--request-id` to a random UUID. Bulk recovery execution and
external-wait delivery require it explicitly.

Redrive and purge use the request identity for idempotency. Scripts must preserve it on retries.

Queue and worker pause retain a safe request preview, digest, and length with the actor and reason.

`admin cancel` records attribution optionally.

#### Purge

`admin purge` prints the deleted row count. Under `--json` it emits it as `deletedCount` beside
`queue`.

A reused request identity carrying different audit fields raises
`PurgeIdempotencyConflictError`. The CLI reports it as `Refused:` and exits 1.

#### Bulk redrive

`admin redrive-many` calls `Admin.redriveMany` once per invocation and emits `BulkRedrivePage`
under `--json`. It selects sources oldest-first through PostgreSQL, with the same filters as
failure listing.

`Admin.redriveMany` accepts a `limit` from 1 through 1,000 (`MAX_REDRIVE_BATCH_SIZE`) and defaults
it to 100. `redrive_many_v1` rejects any other limit.

Preview and execution differ:

| Mode                  | Behavior                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview (`--dry-run`) | Calls `WorkhorseAdminClient.previewRedrive`, which always passes `dryRun: true` and writes no database state. Requires `--reason` but no `--env`, confirmation, or request ID. The default request ID is `workhorse-admin-preview`. |
| Execution             | Requires an explicit `--request-id` and the usual environment and confirmation checks.                                                                                                                                              |

For an unfiltered queue selection, interactive confirmation requires typing `all queues`.

Use only a previous bulk page's cursor. Failure listing orders the same cursor fields
newest-first.

Preserving request identity and audit fields replays each selected source's original target.

A preview does not reserve candidates. Each execution processes only its bounded page.

#### Dependency drift repair

`admin repair-dependencies` examines at most `--limit` drifted dependents, default 1,000 and at
most `MAX_DEPENDENCY_DRIFT_LIMIT` (100,000).

| Mode                  | Behavior                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Preview (`--dry-run`) | Calls `WorkhorseAdminClient.listDependencyDrift` and writes nothing. Requires no `--reason`, `--env`, or confirmation.     |
| Execution             | Calls `WorkhorseAdminClient.repairDependencyDrift`. Requires `--reason` and the usual environment and confirmation checks. |

Execution defaults `--request-id` to a random UUID. The request id correlates the repair and is not
an idempotency key. [Data model: Governed drift repair](data-model.md#governed-drift-repair-schema-version-40)
owns the functions and audit fields.

#### Signal and human-wait delivery

`admin signal <task-id>` and `admin complete-human <task-id>` require:

- `--name`;
- `--request-id`;
- exactly one of `--payload-json` or `--payload-file`. The latter reads UTF-8 JSON from a file.

`readDeliveryPayload` accepts every JSON shape, including `null`. It reports malformed input
without echoing payload content.

Before confirmation, the CLI validates existing external-wait name, value-size, actor, and
idempotency bounds.

The CLI passes the actor as `requestedBy` and the request ID as `idempotencyKey` to
`Queue.sendSignal` or `Queue.completeHumanWait`. The database records delivery attribution; these
commands do not record a reason.

JSON output is `SignalDeliveryResult` or `HumanWaitCompletionResult`, with dates serialized as ISO
strings.

| Outcome                                                                       | Exit    |
| ----------------------------------------------------------------------------- | ------- |
| `delivered`, `completed`, `duplicate`                                         | Success |
| `not_found`, `not_waiting`, `already_delivered`, `already_completed`, `stale` | 1       |

Conflicts also fail without replacing the accepted answer.

#### Queue tier

`admin set-tier <queue> --tier <fast|full>` calls `Admin.setQueueTier` with `--actor` and
`--reason`. Under `--json` it emits `{queue, tier}`.

It rejects `--request-id` with exit 64, because `set_queue_tier_v1` records none.

A `P1007` refusal from `set_queue_tier_v1` prints `Refused:` and exits 1. The command words the
refusal itself instead of printing the `FastTierUnsupportedError` message, which calls every
refused queue fast-tier:

- Feature `tier change`: the queue has live tasks.
- A policy feature: the queue cannot move to the fast tier.

#### Queue history

`admin set-history <queue>` takes `--record-attempts <on|off>`, `--record-claims <on|off>`, or
both, and calls `Admin.setQueueHistory`. An omitted flag keeps its setting. Under `--json` it emits
`{queue, tier, recordAttempts, recordClaims}`.

Because `set_queue_history_v1` records no audit, the command rejects `--actor`, `--reason`, and
`--request-id` with exit 64.

`set_queue_history_v1` accepts any queue name and upserts its `queue_control` row. The command
therefore reads `queue_control` and `Admin.queueMetricSnapshot` before the change, and writes to
stderr:

- a `Note:` when the queue is on the full tier, whose history the switches do not change;
- a `Warning:` when the queue had neither a control row nor a live task, which usually means a
  misspelled name.

Neither message changes the exit code.

#### Queue status columns

`admin queues` reads `tier`, `record_attempts`, and `record_claims` from `queue_control` into
`AdminQueueStatus`. A queue without a control row reports `full` with both switches off.

Its table adds `TIER` and `HISTORY` columns, which the TUI queues view shares. `HISTORY` is `all`
for a full-tier queue. Otherwise it is `none` or the enabled switches, such as `attempts,claims`.

#### Worker pause

`admin pause-worker` and `admin resume-worker` write `workhorse.worker_registry.paused` through
`Admin.setWorkerPaused`. Under `--json` they emit the stored `WorkerPauseResult`:

- `workerId`
- `paused`
- `pausedBy`
- `reason`
- `pausedAt`
- `lastHeartbeatAt`

A worker id carrying no registration row exits 1 with `is not registered`.

The pause is the registry row rather than a message to a live process. A worker reads it on its
next `register_worker_v1` call. That same function clears the pause when a different
`instance_id` claims the worker id, so a restarted worker starts unpaused.

#### Non-mutating outcomes

Outcome statuses that did not mutate — `not_found`, `already_terminal`, `not_failed` — exit 1.
Malformed usage exits 64, matching the CLI-wide convention in
`typescript/core/src/cli/arguments.ts`.

### TUI

`workhorse tui` renders six views over the same client: tasks, queues, schedules, failures,
workers, and health.

| Key     | Action       |
| ------- | ------------ |
| `1`–`6` | Switch views |
| `r`     | Refresh      |
| `q`     | Quit         |

The current view re-fetches every `TUI_REFRESH_INTERVAL_MS` (5,000 ms). List views fetch
`TUI_PAGE_SIZE` (50) rows.

The session is read-only unless launched with `--env <database>`. That flag runs the same
`confirmEnvironment` check at startup. Only then can the queues view stage a pause or resume of the
selected queue, applied only after an explicit `y` confirmation.

Frame rendering (`renderTuiFrame`) and key handling (`handleTuiKey`) in
`typescript/core/src/cli/tui.ts` are pure functions over `TuiState`. Both are therefore
unit-tested without a terminal.

Launching without an interactive stdin and stdout is refused with exit 1.

## Operational limits

### Schema and PostgreSQL

- The canonical artifact installs version 63, the whole current schema.
- Version 6 is the migration baseline and is frozen as `sql/releases/0006.sql`.
- A schema change is an upgrade rather than a reinstall: `migrateSchema` applies the ordered steps
  under `sql/migrations/`, which run from 6 to 63.
- A database below 6 is not carried forward
  ([ADR 0073](../decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)).
- Only plain PostgreSQL 15+ is required. No extension beyond the default `plpgsql` is installed.
- `uuid_v7_v1()` uses core UUID and byte functions rather than `pgcrypto` or `uuid-ossp`.
- Runtime updates centralize churn in one relation. They require vacuum and HOT-update validation
  under sustained heartbeat load.

### Schedules

- Schedules fire only while one worker has matching `scheduleNamespaces` or
  `schedule_namespaces`.
- `maintenanceIntervalMs` or `maintenance_interval_ms` bounds drift.
- `scheduleCatchupLimit` or `schedule_catchup_limit` bounds each `all` catch-up pass after
  downtime.
- Definitions default to `skip`. `latest` coalesces missed occurrences to one task.
- Schedules have one-second precision.
- Cron expressions are evaluated in the definition's validated IANA timezone.

### Retention and cold export

- Task, outcome, event, attempt, and schedule-occurrence retention default to 14 days. Each remains
  independently configurable.
- Enqueue-idempotency bindings expire by their request TTL. They are cleaned before terminal
  identity pruning.
- Retention operates on minimum windows. Daily granularity, bounded passes, and retained
  attribution can extend actual storage beyond a configured cutoff.
- Terminal cleanup repeats its batch while each batch fills, for up to one second per pass. The
  full and fast tiers share every batch, so neither tier starves the other.
- A terminal cleanup pass that ends with a full batch makes its follow-up due after the 5,000 ms
  that `terminal_cleanup_follow_up_delay_ms_v1()` returns, not after `terminal_cleanup_interval_ms`. With one worker's 60-second offers and the default
  limit, cleanup removes at least 1,000 tasks a minute while a backlog remains.
- `terminal_cleanup_backlog_since` in the `queue_health_v1` document shows when a terminal cleanup
  backlog began. It is null while cleanup keeps pace. A backlog older than `row_retention_lag_ms`
  raises the degraded health reason `terminal-cleanup-backlog`.
- Cold export is off by default. While it is on:
  - Event and attempt retention never pass that dataset's `cold_export_dataset.exported_through`.
  - A day is exportable only after it closed and the minute rollup passed it.
  - One exporter claim covers one UTC day of one dataset.
  - A claim lease is 1,000 through 86,400,000 ms. `claim_cold_export_segment_v1` requires
    `p_lease_ms` and has no default.

### Maintenance and health bounds

Default work bounds:

| Work                   | Default bound               |
| ---------------------- | --------------------------- |
| Terminal tasks         | 1,000 per batch             |
| History partitions     | four per category           |
| Default-partition rows | 10,000 per category         |
| Schedule occurrences   | 10,000 per maintenance pass |

When counting, health snapshots scan at most 100,001 terminal outcomes and 100,001 statistic
buckets. Capped counts are flagged; they are exact-until-the-cap lower bounds.

The health snapshot and the dashboard reads that embed it disable JIT for themselves. Compiling
their plan costs far more than executing them. Their remaining cost tracks live `task_runtime`
depth: roughly tens of milliseconds at a few thousand ready rows and a few hundred at 200,000.

`dashboard_task_detail_v1` disables JIT for the same reason; it reads one task.

### Task notifications

`NOTIFY` is a wake hint. Polling remains the correctness mechanism.

#### Shared listener

`Worker.run()` subscribes through a process-local `TaskNotificationHub` keyed by the exact
notification connection identity.

- `Queue.supportsTaskNotifications()` checks that capability.
- `Queue.subscribeToTaskNotifications()` returns a `TaskNotificationSubscription`.
- Its `close()` removes that worker and closes the hub after the final subscriber.

A node-postgres pool therefore reserves one shared connection for `LISTEN workhorse_tasks`. That
holds regardless of the number of subscribing `Queue` or `Worker` objects.

The hub takes its connection from the queryable's pool:

| Adapter        | Pool source     |
| -------------- | --------------- |
| Drizzle        | `$client`       |
| TypeORM        | `driver.master` |
| Prisma, Kysely | `pool` option   |

The hub is keyed by that pool object, and its capacity is `options.max`.

#### Polling-only cases

- Without a pool, the queryable remains polling-only.
- A pool whose capacity is 1 also remains polling-only. This prevents its sole connection from
  being held away from claims.
- When `Worker.run()` starts with no subscription, it logs `workhorse.worker.polling_only` at warn
  once.

The capability check sees the pool's shape, not its pooling mode. A transaction-mode pooler accepts
`LISTEN` without ever delivering a notification. Capability then stays reported while the fallback
poll does the work (see [Connection poolers](overview.md#connection-poolers)).

#### Wake routing

- Queue-name payloads wake matching subscribers, and `*` wakes all subscribers.
- `promote_v1`, `run_task_now_v1`, `recover_expired_v1`, `sync_concurrency_policies_v1`, and
  `sync_rate_limit_policies_v1` notify once per distinct affected queue.
- Task notifications abort only the dispatch loop's `dispatchWakeController`.
- Maintenance and registration retain their configured sleep cadence through `wakeController`.
- Lifecycle changes abort both controllers.
- Repeated notifications never create concurrent claim loops.

#### Listener failure and reconnect

On an error or end event, the listener releases the failed client and wakes all subscribers. It
then reconnects after exponential delays from 100 ms through 5,000 ms with ±10% jitter.

Initial connection and every reconnect also wake all subscribers. Work committed during the gap
therefore gets an immediate claim.

`WorkerOptions.onNotificationError` observes failures; they never fail dispatch. A throwing
`onNotificationError` never stops the listener.

The final subscriber issues `UNLISTEN`, releases the shared connection, and lets normal worker
drain finish. That subscriber still observes an `UNLISTEN` failure. The listener keeps its `error`
handler until release. `UNLISTEN` has 1,000 ms to finish. Past that deadline the listener reports a
failure and releases the client with the error, which destroys the connection.

### Polling cadence

| Case                                        | Wait                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- |
| Notification-capable `Worker.run()`         | 5,000 ms default fallback poll, ±10% jitter                      |
| Notification after an empty claim           | Random delay from 0 through 50 ms before claiming                |
| Explicit `pollMs`                           | Replaces the fallback base                                       |
| No active listener, consecutive empty waits | Double through a 5,000 ms cap, ±10% jitter                       |
| Query-only adapters                         | Start at 250 ms                                                  |
| `runOnce()`                                 | Retains the 250 ms compatibility default; never opens a listener |

Every pass uses authoritative `claim_many_v1` transitions.

### Dashboard refresh and build reuse

#### Request sharing

The SPA shares identical in-flight reads by route and filter.

- Background refreshes skip an identical pending page request.
- After a mutation, a foreground refresh waits for an older read and then fetches the committed
  result.
- Failures release the pending entry so a later refresh can retry.

#### Auto refresh on pinned pages

Auto refresh pauses while a task listing is pinned to a cursor or to a page beyond the first.
Update-time ordering moves exactly the tasks a refresh would report out of the pinned window.

Manual refresh is unaffected. Returning to the first page resumes the configured cadence through
the usual resume countdown.

#### `dashboard_system_v1`

`dashboard_system_v1` captures one timestamp for its window bounds and response timestamp.

A materialized CTE reads the current statistics window once for outcomes, summaries, queue-wait
percentiles, queue rates, and failing types. The previous comparison window is read separately.

The retained `dashboard_system_v1` remains callable by older clients.

#### Build fingerprints

`pnpm build` records source and output fingerprints after completing the full build.

- `pnpm build:check` rejects missing or stale artifacts.
- The `test:packed:built`, `test:site-smoke:built`, and `test:demo-smoke:built` commands check
  those fingerprints before testing.
- Standalone test commands build first. `pnpm check` and smoke CI reuse one full build.
- When passed `--reuse-build`, the demo smoke harness copies those verified outputs into its
  isolated source checkout. It preserves its clean dependency installation without compiling
  again.
