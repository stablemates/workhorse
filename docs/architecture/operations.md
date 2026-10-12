# Workhorse architecture: operations and CLI

This page is part of the [Workhorse architecture reference](../architecture.md). It owns
deployment synchronization, the worker process lifecycle, the command-line entry points, the
administrative CLI and TUI, and operational limits.

## Deployment synchronization

A deployment synchronizes schedule definitions and concurrency policies into the target database.

### Schedule definitions

`Queue.syncSchedules(namespace, definitions, { prune })` is a desired-state reconciler:

1. It validates the stable namespace and schedule names. It also validates the queue task
   definitions, including optional retry policies.
2. It upserts the deployment intent atomically through `sync_schedule_definitions_v2`. By default,
   it deactivates the names that the deployment omits. It does not change a schedule pause.
3. A per-namespace advisory lock serializes concurrent deployments of the same namespace.

The definitions are only in the target database. Thus a deployment is one transaction. No second
metadata database exists that must converge.

Each material change to a definition increments a revision. When a worker fires a schedule, it
passes the revision that it loaded. Thus a stale in-process schedule becomes a no-op. It does not
run a new payload at an old cadence.

A deployment can deactivate a schedule while a fire of that schedule already runs. In that case,
definition row locking makes the deployment wait for the fire before the deployment returns.

### Contract stamping

Before the write, every SDK applies the current payload contract of each task type to the
definitions:

| SDK        | How it applies the contract                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| TypeScript | `taskAcceptance`                                                                                                |
| Go         | `applyScheduleContracts`                                                                                        |
| Python     | `Queue.sync_schedules` and `AsyncQueue.sync_schedules` read `get_contract_definition_v1` once per distinct type |
| Rust       | `Queue::sync_schedules` reads `get_contract_definition_v1` once per distinct type                               |
| Ruby       | `Queue#sync_schedules` reads `get_contract_definition_v1` once per distinct type                                |

The four SDKs other than TypeScript skip their contract cache. The reason is that
`fire_schedule_v1` never checks `contract_policy`. Thus a stale version would stay on every
occurrence.

If a payload fails the schema, the SDK raises its contract validation error and writes nothing.
The fixture `contracted-schedule-definition` in `protocol/v1/schedules.json` covers the stamped
fields.

### Concurrency policies

`Queue.syncConcurrencyPolicies(namespace, definitions, { prune })` reconciles the dispatch budgets
of queues in the same target database.

- A queue has one namespace owner.
- Workhorse serializes concurrent synchronizations before it checks ownership.
- A second namespace cannot replace the owner silently.
- Scheduled definitions keep their `concurrencyKey`. `fire_schedule_v1` sends it in the ordinary
  admission metadata of an enqueue.

## Worker process lifecycle

Three layers build a worker process:

- `defineWorkerProcess()` declares a process-owned adapter and one or more worker configurations.
- `startWorkerProcess()` gives framework-neutral orchestration that does not use global signals.
- `runWorkerProcess()` and `workhorse worker --config` add the standalone Node lifecycle.

### Graceful shutdown

When the process gets the first `SIGINT` or `SIGTERM`, it sets readiness to false. It then calls
`stop()` on every Worker. After that:

- The workers send no more claim requests.
- Active handlers continue. Their worker-level heartbeat batch also continues.
- The adapter resources close only after every run loop finishes.

A claim transaction that is already in progress can commit after the shutdown starts. The worker
drains that committed lease. It does not abandon the lease.

Process termination does not create a durable task cancellation. It also does not abort a handler.

### Shutdown deadline and failure

A configurable deadline prevents an uncooperative handler from blocking termination forever. The
default deadline is 25 seconds. `shutdownTimeoutMs` sets the deadline. Its value is a safe integer
from 1 through 3,600,000, and its default is 25,000 ms.

| Event                          | Exit                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| Second signal                  | Conventional signal code                                                 |
| Missed deadline                | Code 1                                                                   |
| Unexpected worker-loop failure | Stops sibling workers, applies the same bounded drain, fails the process |

Hard termination leaves active leases to ordinary fenced expiry recovery. If the process fails, an
external supervisor can restart it.

### Probe listener

The optional probe-only listener reports liveness while the process runs or drains. It reports
readiness only while the process accepts claims. It does not expose application HTTP ingress,
queue data, or mutations.

## Command-line entry points

Workhorse has one command-line dispatcher. The repository also has scripts outside that dispatcher.

### Dispatcher and exit codes

The published `@stablemates/workhorse` package declares one `bin`, `workhorse`. It resolves to
`dist/src/cli/workhorse.js`.

That dispatcher owns every documented command: `init`, `schema`, `worker`, `dashboard`, `admin`,
`tui`, and `health`. `workhorse --help` lists them. `workhorse --version` prints the package
version.

All commands use the same exit codes:

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Success                                                                        |
| 1    | Runtime failure or an unusable schema verdict                                  |
| 2    | Queue degradation reported by `health`                                         |
| 64   | Usage error, including an unknown command, an unknown flag, or a missing value |

### Repository scripts outside the dispatcher

`typescript/core/src/cli/benchmark.ts` and `typescript/core/src/cli/reset-db.ts` are repository
scripts. They are not commands of that dispatcher.

- `tsconfig.build.json` excludes both. Thus neither module gets into `dist` or the npm tarball.
- That exclusion also removes `typescript/core/benchmarks/`. The benchmark script is its only
  importer.
- Both files stay under `typescript/core/src/cli/`. `typescript/core/tsconfig.source.json` still
  typechecks them.

A contributor runs the two scripts from source through the root package scripts `pnpm benchmark`
and `pnpm db:reset:*`. For this reason, `docs/benchmarking.md` writes the benchmark command as
`pnpm benchmark -- --help`. It never writes `workhorse benchmark`.

### `workhorse init`

`workhorse init` creates a worker configuration for an existing project.

#### Project detection

The command reads the `package.json` file in the target directory. `detectProject` in
`typescript/core/src/cli/init.ts` gets three facts from its dependencies:

- **ORM:** `drizzle`, `prisma`, `typeorm`, `kysely`, or plain `pg`.
- **Web framework:** `hono`, `express`, `fastify`, `next`, or `none`.
- **Package manager:** `pnpm`, `npm`, `yarn`, or `bun`.

`detectPackageManager` decides the package manager in this order:

1. The `packageManager` field.
2. The lockfile in the directory. `detectPackageManager` checks the lockfiles in this order:
   `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `yarn.lock`, `package-lock.json`,
   `npm-shrinkwrap.json`. Thus Bun's own lockfile decides before the `yarn.lock` that Bun can also
   write.
3. `pnpm`, only when the project declares neither.

#### Output

The command writes `workhorse.config.ts`. If the project declares no TypeScript dependency, it
writes `workhorse.config.js` instead.

It then prints three things:

- the schema install command;
- the worker command;
- a dashboard mount snippet in the shape of the framework.

For an `npm` project, the command prints the commands in the form `npm exec --no --`. That form
runs the local binary or fails. Bare `npx` would fetch an unrelated registry package with that
name.

The command only prints the snippet. `init` writes no route file and edits no existing file.

#### Options

`workhorse init` takes two options in addition to `--help`:

- `--dir <path>` names the project directory. The command resolves the path against the current
  working directory. The default is the current directory.
- If a generated configuration already exists, `--force` writes it again. Without it, the command
  does not change an existing `workhorse.config.ts` or `workhorse.config.js`. The command reports
  this. It still prints the detection result and the next steps.

## Administrative CLI and TUI

Operators inspect and change Workhorse state through the administrative CLI and the TUI.

### Shared admin client

`workhorse admin` and `workhorse tui` are thin front ends over one shared client. That client is
`WorkhorseAdminClient` in `typescript/core/src/cli/admin-client.ts`.

| Backing API | Client operations                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Admin`     | `listTasks`, `getTask`, `getTaskTimeline`, `listDeadLetters`, `queueMetricSnapshot`, `schedules`, `listWorkers`, `listCheckpoints`, `getCheckpoint`, `listWaits`, `getWait`, `listHumanWaits`, `listSignalWaits`, policy reads, `redrive`, `redriveMany`, `pauseQueue`, `resumeQueue`, `purgeQueue`, `setWorkerPaused`, `health`, `getTaskGroup`, `listTaskGroupMembers`, `cancelTaskGroup` |
| `Queue`     | `cancel`, `sendSignal`, `completeHumanWait`                                                                                                                                                                                                                                                                                                                                                 |

Queue status still merges metric snapshots with `workhorse.queue_control`. Namespace discovery
reads `workhorse.schedule_definition`. No `Admin` call lists task groups or reads the newest events
of a group. Thus the client calls `dashboard_task_groups_v1` and `list_newest_task_group_events_v1`
through the `admin` statement catalogue, the same functions that the dashboard calls.

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
- `admin task-groups`
- `admin task-group <group-id>`

By default, each command renders an aligned text table or a key/value list. With `--json`, each
command emits the result of the API call that it makes. The JSON output gives bigint fence tokens
and schedule revisions as strings. `adminJsonReplacer` in `typescript/core/src/cli/admin-format.ts`
does that serialization. That file owns all the row projection that the CLI and the TUI share.

The list commands accept these filters:

- `--queue`
- `--type`
- `--state`, which you can repeat or separate with commas. The CLI validates it against the
  `TaskState` union.
- `--limit`
- `--namespace`, for schedules

#### Checkpoints and waits

`admin checkpoints <task-id>` renders `Admin.listCheckpoints`. `admin waits <task-id>` renders
`Admin.listWaits` over `workhorse.task_wait`.

Both accept `--name <name>`. With this option, the command renders the single `Admin.getCheckpoint`
or `Admin.getWait` read instead of the list. If the task never recorded the name, the command prints
to stderr and exits 1. `admin task` does the same.

#### External waits

`admin external-waits` is the fleet-wide read. It only lists boundaries. `admin signal` and
`admin complete-human` answer them.

It runs `Admin.listHumanWaits` and `Admin.listSignalWaits` concurrently through
`WorkhorseAdminClient.externalWaits`. With `--json`, it emits
`{"human": {"items", "nextCursor"}, "signal": {"items", "nextCursor"}}`.

The table merges both lists, oldest first, and adds a `KIND` column. Only a human decision has a
`CONTEXT` value.

`--limit` applies to both lists. Its maximum is `MAX_EXTERNAL_WAIT_LIST_SIZE` (1,000).

Each list has its own pages, because the scope of `ExternalWaitCursor` is one list.
`--human-cursor` and `--signal-cursor` each take the exact JSON `nextCursor` object that the
previous page printed. If the value is not an object with string `createdAt`, `taskId`, and `name`
fields, the command reports a usage error and exits 64.

#### Task groups

`admin task-groups` calls `WorkhorseAdminClient.listTaskGroups` over `dashboard_task_groups_v1`. It
lists groups newest first. With `--json`, it emits `AdminTaskGroupPage`:
`{state, page, pageSize, hasMore, groups}`. Each group has the `TaskGroup` shape of
`Admin.getTaskGroup`, with dates as ISO strings.

| Flag      | Values                                                     | Default |
| --------- | ---------------------------------------------------------- | ------- |
| `--state` | One of `open`, `sealed`, or `finished`. Omit it for all.   | All     |
| `--limit` | 1 through 100                                              | 50      |
| `--page`  | 1 through 1,000. Read `page + 1` when `hasMore` is `true`. | 1       |

The function pages by number, not by cursor. Thus a group that is created between two reads moves
the later pages by one group.

`admin task-group <group-id>` calls `WorkhorseAdminClient.getTaskGroupDetail`. It reads the
group through `Admin.getTaskGroup`. Then it reads one member page through
`Admin.listTaskGroupMembers` and the newest 101 events through
`list_newest_task_group_events_v1`, concurrently. With `--json`, it emits `AdminTaskGroupDetail`:

- `group`, the `TaskGroup` snapshot with its counts and callbacks;
- `members`, at most `--limit` members after the position `--after` (default 0);
- `nextAfter`, the `--after` value of the next member page, or `null` on the last page;
- `events`, the newest 100 events, newest first;
- `eventsTruncated`, `true` when the group has older events than these 100.

`--limit` is from 1 through `MAX_TASK_GROUP_PAGE_SIZE` (1,000). Its default is 100. `--after` is from
0 through 2,147,483,647, the range of a PostgreSQL `integer`. `Admin.listTaskGroupMembers` gives a
next position for each full page. Thus, after a full page, the client reads one more member after
the last position, and it sets `nextAfter` to `null` when no member follows. The reads are separate
statements, so the detail is not one snapshot.

The group id must be a UUID. Any other value is a usage error and exits 64. An unknown group prints
`was not found` to stderr and exits 1.

### Pagination and range filters

`admin tasks`, `admin timeline`, and `admin failures` accept `--cursor` with their exact JSON
`nextCursor`. The text output also prints the continuation. `parseCursor` keeps timestamp strings
as strings. It does not convert them to JavaScript dates.

Each cursor must have these fields:

| Command          | Required fields                            |
| ---------------- | ------------------------------------------ |
| `admin tasks`    | `createdAt`, `taskId`, `signature`         |
| `admin failures` | `finishedAt`, `taskId`                     |
| `admin timeline` | `taskId`, `occurredAt`, `kind`, `recordId` |

For a timeline cursor, `kind` must be `event` or `attempt`, and the task must match. If a cursor
has a malformed shape, the command exits 64.

PostgreSQL still verifies the task-list signatures against the normalized filters. These pages stay
weakly consistent. CLI continuation adds no snapshot guarantee.

Range filters:

- Tasks accept `--created-after` and `--created-before`.
- Failure listings and bulk recovery accept `--finished-after`, `--finished-before`, repeated
  `--tag` (all required), and `--error-name`.

`parseDateRange` requires finite ISO timestamps with explicit timezones. It also requires
increasing bounds. Lower bounds are inclusive, and upper bounds are exclusive.

For tasks, timelines, failures, and bulk recovery, the maximum `--limit` is 1,000. Its default
value is 100.

If a command gets a selection, delivery, or dry-run flag that does not apply to it, the command
exits 64. It does not ignore the flag.

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
- `admin cancel-task-group <group-id>`
- `admin signal <task-id>`
- `admin complete-human <task-id>`

#### Safety checks

Two independent checks protect every mutation:

1. **Explicit target environment.** The command requires `--env <database>`.
   `WorkhorseAdminClient.confirmEnvironment` compares it with `current_database()` on the live
   connection.
   - A mismatch throws `AdminSafetyError`. The CLI reports `Refused:` and exits 1.
   - The check is necessary because ambient `WORKHORSE_DATABASE_URL`/`DATABASE_URL` values can
     connect a shell to a database that the operator did not intend.
   - If the check succeeds, it returns a `ConfirmedEnvironment` token. Every mutation method on the
     client requires that token as its first parameter. Thus no front end can get to a destructive
     operation without the check.
2. **Confirmation.** Without `--yes`, an interactive session must type the exact target again at a
   prompt on stderr. The target is a task id, a queue name, a worker id, or a group id.
   `admin repair-dependencies` asks for the literal target `dependencies`.
   - A mismatched answer changes nothing and exits 1.
   - A non-interactive session without `--yes` is a usage error.

#### Audit fields and request identity

Every guarded command except `admin cancel`, `admin signal`, `admin complete-human`, and
`admin set-history` requires `--reason`. These commands record `--actor` (default
`workhorse-admin`).

For the existing controls, `--request-id` defaults to a random UUID. Bulk recovery execution and
external-wait delivery require an explicit value.

Redrive and purge use the request identity for idempotency. Scripts must keep it the same when they
retry.

Queue pause and worker pause keep a safe request preview, digest, and length, together with the
actor and the reason.

For `admin cancel`, attribution is optional.

#### Purge

`admin purge` prints the number of deleted rows. With `--json`, it emits that number as
`deletedCount` next to `queue`.

If a reused request identity has different audit fields, Workhorse raises
`PurgeIdempotencyConflictError`. The CLI reports it as `Refused:` and exits 1.

#### Bulk redrive

`admin redrive-many` calls `Admin.redriveMany` once per invocation. With `--json`, it emits
`BulkRedrivePage`. It selects sources oldest first through PostgreSQL. It uses the same filters as
the failure listing.

`Admin.redriveMany` accepts a `limit` from 1 through 1,000 (`MAX_REDRIVE_BATCH_SIZE`). The default
is 100. `redrive_many_v1` rejects any other limit.

Preview and execution are different:

| Mode                  | Behavior                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview (`--dry-run`) | Calls `WorkhorseAdminClient.previewRedrive`, which always passes `dryRun: true` and writes no database state. Requires `--reason` but no `--env`, confirmation, or request ID. The default request ID is `workhorse-admin-preview`. |
| Execution             | Requires an explicit `--request-id` and the usual environment and confirmation checks.                                                                                                                                              |

If the selection has no queue filter, the interactive confirmation requires the text `all queues`.

Use only the cursor of a previous bulk page. The failure listing orders the same cursor fields
newest first.

If you keep the same request identity and audit fields, the command replays the original target of
each selected source.

A preview does not reserve candidates. Each execution processes only its bounded page.

#### Dependency drift repair

`admin repair-dependencies` examines at most `--limit` drifted dependents. The default is 1,000.
The limit is at most `MAX_DEPENDENCY_DRIFT_LIMIT` (100,000).

| Mode                  | Behavior                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Preview (`--dry-run`) | Calls `WorkhorseAdminClient.listDependencyDrift` and writes nothing. Requires no `--reason`, `--env`, or confirmation.     |
| Execution             | Calls `WorkhorseAdminClient.repairDependencyDrift`. Requires `--reason` and the usual environment and confirmation checks. |

During execution, `--request-id` defaults to a random UUID. The request id correlates the repair.
It is not an idempotency key.
[Data model: Governed drift repair](data-model.md#governed-drift-repair-schema-version-40) owns the
functions and audit fields.

#### Task group cancel

`admin cancel-task-group <group-id>` requires `--reason`. It calls
`WorkhorseAdminClient.cancelTaskGroup` with `--actor` and `--request-id`, which defaults to a
random UUID. The request id correlates the `canceled` event. It is not an idempotency key.

`cancel_task_group_v1` returns the unchanged snapshot of a finished group. An earlier cancel can
also set `canceledAt` on that snapshot. Thus the snapshot does not show whether this call changed
the group. The function writes a `canceled` event only when it does work, and the event records
`request_id_digest`, the first 12 hex digits of the SHA-256 of the request id. The client uses this
event:

1. It reads the newest 1,000 events through `list_newest_task_group_events_v1`, and keeps the ids
   of the `canceled` events.
2. It calls `Admin.cancelTaskGroup`.
3. It reads the newest 1,000 events again. If a new `canceled` event has the digest of its request
   id, the call canceled the group.

With `--json`, the command emits `AdminTaskGroupCancelResult`, `{status, group}`:

| `status`           | Meaning                                                           | Exit |
| ------------------ | ----------------------------------------------------------------- | ---- |
| `canceled`         | The cancel sealed the group and canceled each pending member task | 0    |
| `already_finished` | The group was finished when the cancel ran, so nothing changed    | 1    |
| `not_found`        | No group has this id. `group` is `null`.                          | 1    |

If the group finishes after the first read and before the cancel, the function writes no event.
The command then reports `already_finished`, also for a group that an earlier cancel canceled.

The check has two limits. The digest names the request, not the call. Thus two calls with the same
`--request-id` at the same time can both report `canceled`. If more than 1,000 events follow the
new `canceled` event before the second read, the command reports `already_finished` for a call
that canceled the group.

After a `canceled` result, an active member task gets a cancel request. The group stays `sealed`
until that task stops, and the text output gives the number of pending member tasks.
[Task groups: Cancel](task-groups.md#cancel) owns the function.

#### Signal and human-wait delivery

`admin signal <task-id>` and `admin complete-human <task-id>` require:

- `--name`;
- `--request-id`;
- exactly one of `--payload-json` or `--payload-file`. The latter reads UTF-8 JSON from a file.

`readDeliveryPayload` accepts every JSON shape, including `null`. It reports malformed input, but
it does not show the payload content.

Before the confirmation, the CLI validates the existing external-wait bounds for the name, the
value size, the actor, and the idempotency key.

The CLI passes the actor as `requestedBy` and the request ID as `idempotencyKey` to
`Queue.sendSignal` or `Queue.completeHumanWait`. The database records the delivery attribution.
These commands do not record a reason.

The JSON output is `SignalDeliveryResult` or `HumanWaitCompletionResult`. It gives dates as ISO
strings.

| Outcome                                                                       | Exit    |
| ----------------------------------------------------------------------------- | ------- |
| `delivered`, `completed`, `duplicate`                                         | Success |
| `not_found`, `not_waiting`, `already_delivered`, `already_completed`, `stale` | 1       |

A conflict also fails. It does not replace the accepted answer.

#### Queue tier

`admin set-tier <queue> --tier <fast|full>` calls `Admin.setQueueTier` with `--actor` and
`--reason`. With `--json`, it emits `{queue, tier}`.

It rejects `--request-id` with exit 64, because `set_queue_tier_v1` records no request id.

If `set_queue_tier_v1` refuses with `P1007`, the command prints `Refused:` and exits 1. The command
writes its own text for the refusal. It does not print the `FastTierUnsupportedError` message,
because the `FastTierUnsupportedError` message calls every refused queue fast-tier. The text depends on the feature:

- Feature `tier change`: the queue has live tasks.
- A policy feature: the queue cannot move to the fast tier.

#### Queue history

`admin set-history <queue>` takes `--record-attempts <on|off>`, `--record-claims <on|off>`, or
both. It calls `Admin.setQueueHistory`. An omitted flag keeps its setting. With `--json`, it emits
`{queue, tier, recordAttempts, recordClaims}`.

`set_queue_history_v1` records no audit. Thus the command rejects `--actor`, `--reason`, and
`--request-id` with exit 64.

`set_queue_history_v1` accepts any queue name and upserts its `queue_control` row. Thus the command
reads `queue_control` and `Admin.queueMetricSnapshot` before the change. Then it writes to
stderr:

- a `Note:` if the queue is on the full tier. The switches do not change the history of a full-tier
  queue.
- a `Warning:` if the queue had no control row and no live task. This usually means a misspelled
  name.

Neither message changes the exit code.

#### Queue status columns

`admin queues` reads `tier`, `record_attempts`, and `record_claims` from `queue_control` into
`AdminQueueStatus`. A queue without a control row reports `full` with both switches off.

Its table adds the `TIER` and `HISTORY` columns. The TUI queues view shows the same columns.
`HISTORY` is `all` for a full-tier queue. For other queues, it is `none` or the enabled switches,
such as `attempts,claims`.

#### Worker pause

`admin pause-worker` and `admin resume-worker` write `workhorse.worker_registry.paused` through
`Admin.setWorkerPaused`. With `--json`, they emit the stored `WorkerPauseResult`:

- `workerId`
- `paused`
- `pausedBy`
- `reason`
- `pausedAt`
- `lastHeartbeatAt`

If a worker id has no registration row, the command exits 1 with `is not registered`.

The pause is the registry row. It is not a message to a live process. A worker reads the pause on
its next `register_worker_v1` call. If a different `instance_id` claims the worker id, that same
function clears the pause. Thus a restarted worker starts unpaused.

#### Non-mutating outcomes

The outcome statuses `not_found`, `already_terminal`, `already_finished`, and `not_failed` mean
that the command changed nothing. These statuses exit 1. Malformed usage exits 64. This agrees with the CLI-wide
convention in `typescript/core/src/cli/arguments.ts`.

### TUI

`workhorse tui` renders six views over the same client: tasks, queues, schedules, failures,
workers, and health.

| Key     | Action       |
| ------- | ------------ |
| `1`–`6` | Switch views |
| `r`     | Refresh      |
| `q`     | Quit         |

The current view fetches its data again every `TUI_REFRESH_INTERVAL_MS` (5,000 ms). List views
fetch `TUI_PAGE_SIZE` (50) rows.

The session is read-only unless you start it with `--env <database>`. That flag runs the same
`confirmEnvironment` check at startup. Only then can the queues view stage a pause or resume of the
selected queue. The TUI applies the staged change only after an explicit `y` confirmation.

Frame rendering (`renderTuiFrame`) and key handling (`handleTuiKey`) in
`typescript/core/src/cli/tui.ts` are pure functions over `TuiState`. Thus the unit tests test both
without a terminal.

If stdin or stdout is not interactive, the TUI refuses to start and exits 1.

## Operational limits

This section states the limits and defaults that operators must know.

### Schema and PostgreSQL

- The canonical artifact installs version 68, the whole current schema.
- Version 6 is the migration baseline. Its frozen copy is `sql/releases/0006.sql`.
- A schema change is an upgrade, not a reinstall. `migrateSchema` applies the ordered steps under
  `sql/migrations/`, which run from 6 to 68.
- Workhorse does not upgrade a database below 6
  ([ADR 0073](../decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)).
- Workhorse requires only plain PostgreSQL 15+. Workhorse installs no extension beyond the default
  `plpgsql`.
- `uuid_v7_v1()` uses core UUID and byte functions. It does not use `pgcrypto` or `uuid-ossp`.
- Runtime updates put their churn in one relation. They require validation of vacuum and HOT
  updates under sustained heartbeat load.

### Schedules

- Schedules fire only while one worker has matching `scheduleNamespaces` or
  `schedule_namespaces`.
- `maintenanceIntervalMs` or `maintenance_interval_ms` limits the drift.
- `scheduleCatchupLimit` or `schedule_catchup_limit` limits each `all` catch-up pass after
  downtime.
- Definitions default to `skip`. `latest` combines missed occurrences into one task.
- Schedules have one-second precision.
- Workhorse evaluates cron expressions in the validated IANA timezone of the definition.

### Retention and cold export

- The retention of tasks, outcomes, events, attempts, and schedule occurrences defaults to 14
  days. You can configure each one independently.
- Enqueue-idempotency bindings expire after their request TTL. Workhorse removes them before it
  prunes terminal identities.
- Retention uses minimum windows. Daily granularity, bounded passes, and retained attribution can
  keep data in storage after a configured cutoff.
- Terminal cleanup repeats its batch while each batch is full, for up to one second per pass. The
  full and fast tiers share every batch. Thus neither tier starves the other.
- If a terminal cleanup pass ends with a full batch, its follow-up is due after 5,000 ms.
  `terminal_cleanup_follow_up_delay_ms_v1()` returns that delay. The follow-up does not wait for
  `terminal_cleanup_interval_ms`. With 60-second offers from one worker and the default limit,
  cleanup removes at least 1,000 tasks a minute while a backlog remains.
- `terminal_cleanup_backlog_since` in the `queue_health_v1` document shows when a terminal cleanup
  backlog started. It is null while cleanup has no backlog. If a backlog is older than
  `terminal_cleanup_backlog_ms`, Workhorse raises the degraded health reason
  `terminal-cleanup-backlog`.
- `terminal_cleanup_backlog_ms` defaults to 21,600,000 ms (6 h). From schema 64, it is independent
  of `row_retention_lag_ms`. `sync_queue_health_policy_v2` sets it together with the other five
  budgets. A five-value `sync_queue_health_policy_v1` call no longer changes it. Thus a deployment
  that tunes row retention through v1 sets the backlog budget through v2 or
  `override_queue_health_policy_v1`.
- Cold export is off by default. While it is on:
  - Event and attempt retention never go past the `cold_export_dataset.exported_through` value of
    that dataset.
  - A day is exportable only after the day ends and the minute rollup passes it.
  - One exporter claim covers one UTC day of one dataset.
  - A claim lease is from 1,000 through 86,400,000 ms. `claim_cold_export_segment_v1` requires
    `p_lease_ms` and has no default.

### Maintenance and health bounds

The default work bounds are:

| Work                   | Default bound               |
| ---------------------- | --------------------------- |
| Terminal tasks         | 1,000 per batch             |
| History partitions     | four per category           |
| Default-partition rows | 10,000 per category         |
| Schedule occurrences   | 10,000 per maintenance pass |

When a health snapshot counts, it scans at most 100,001 terminal outcomes and 100,001 statistic
buckets. The snapshot flags a capped count. A capped count is exact until the cap, and it is a
lower bound.

The health snapshot and the dashboard reads that embed it disable JIT for themselves. The reason
is that compiling their plan costs much more than executing them. Their remaining cost follows the
live depth of `task_runtime`. It is approximately tens of milliseconds at a few thousand ready
rows. It is a few hundred milliseconds at 200,000 ready rows.

`dashboard_task_detail_v1` disables JIT for the same reason. It reads one task.

### Task notifications

`NOTIFY` is a wake hint. Polling stays the mechanism that gives correctness.

#### Shared listener

`Worker.run()` subscribes through a process-local `TaskNotificationHub`. The key of the hub is the
exact identity of the notification connection.

- `Queue.supportsTaskNotifications()` checks that capability.
- `Queue.subscribeToTaskNotifications()` returns a `TaskNotificationSubscription`.
- Its `close()` removes that worker. After the final subscriber closes, it also closes the hub.

Thus a node-postgres pool reserves one shared connection for `LISTEN workhorse_tasks`. This is
true for any number of subscribing `Queue` or `Worker` objects.

The hub takes its connection from the pool of the queryable:

| Adapter        | Pool source     |
| -------------- | --------------- |
| Drizzle        | `$client`       |
| TypeORM        | `driver.master` |
| Prisma, Kysely | `pool` option   |

The key of the hub is that pool object. Its capacity is `options.max`.

#### Polling-only cases

- If the queryable has no pool, it stays polling-only.
- A pool with a capacity of 1 also stays polling-only. Thus its only connection stays available
  for claims.
- If `Worker.run()` starts with no subscription, it logs `workhorse.worker.polling_only` at warn
  level once.

The capability check sees the shape of the pool, not its pooling mode. A transaction-mode pooler
accepts `LISTEN` but never delivers a notification. In that case, the check still reports the
capability, and the fallback poll does the work (see
[Connection poolers](overview.md#connection-poolers)).

#### Wake routing

- A queue-name payload wakes the matching subscribers. `*` wakes all subscribers.
- `promote_v1`, `run_task_now_v1`, `recover_expired_v1`, `sync_concurrency_policies_v1`, and
  `sync_rate_limit_policies_v1` notify once per distinct affected queue.
- Task notifications abort only the `dispatchWakeController` of the dispatch loop.
- Maintenance and registration keep their configured sleep cadence through `wakeController`.
- Lifecycle changes abort both controllers.
- Repeated notifications never create concurrent claim loops.

#### Listener failure and reconnect

If the listener gets an error or end event, it releases the failed client and wakes all
subscribers. It then connects again after exponential delays from 100 ms through 5,000 ms with
±10% jitter.

The initial connection and every reconnect also wake all subscribers. Thus work that commits
during the gap gets an immediate claim.

`WorkerOptions.onNotificationError` observes failures. These failures never cause dispatch to fail.
If `onNotificationError` throws, that never stops the listener.

The final subscriber sends `UNLISTEN` and releases the shared connection. Then the normal worker
drain can finish. That subscriber still observes an `UNLISTEN` failure. The listener keeps its
`error` handler until the release. `UNLISTEN` has 1,000 ms to finish. After that deadline, the
listener reports a failure and releases the client with the error. This release destroys the
connection.

### Polling cadence

| Case                                        | Wait                                                |
| ------------------------------------------- | --------------------------------------------------- |
| Notification-capable `Worker.run()`         | 5,000 ms default fallback poll, ±10% jitter         |
| Notification after an empty claim           | Random delay from 0 through 50 ms before claiming   |
| Claim that released every task              | The next empty wait; a notification does not end it |
| Explicit `pollMs`                           | Replaces the fallback base                          |
| No active listener, consecutive empty waits | Double through a 5,000 ms cap, ±10% jitter          |
| Query-only adapters                         | Start at 250 ms                                     |
| `runOnce()`                                 | No wait; never opens a listener                     |

Every pass uses authoritative `claim_many_v1` transitions.

### Dashboard refresh and build reuse

The dashboard SPA shares reads and pauses auto refresh in some cases. The build records
fingerprints so that tests can reuse it.

#### Request sharing

The SPA shares identical in-flight reads by route and filter.

- Background refreshes skip an identical pending page request.
- After a mutation, a foreground refresh waits for an older read and then fetches the committed
  result.
- A failure releases the pending entry, so a later refresh can try again.

#### Auto refresh on pinned pages

Auto refresh pauses while a task listing is pinned to a cursor or to a page after the first page.
Update-time ordering moves tasks out of the pinned window. These are exactly the tasks that a
refresh would report.

This pause does not affect manual refresh. If you go back to the first page, auto refresh resumes
the configured cadence through the usual resume countdown.

#### `dashboard_system_v1`

`dashboard_system_v1` captures one timestamp. It uses that timestamp for its window bounds and for
its response timestamp.

A materialized CTE reads the current statistics window once. That read gives the outcomes,
summaries, queue-wait percentiles, queue rates, and failing types. A separate read gets the
previous comparison window.

Older clients can still call the retained `dashboard_system_v1`.

#### Build fingerprints

After `pnpm build` completes the full build, it records source and output fingerprints.

- `pnpm build:check` rejects missing or stale artifacts.
- The `test:packed:built`, `test:site-smoke:built`, and `test:demo-smoke:built` commands check
  those fingerprints before they run tests.
- Standalone test commands build first. `pnpm check` and smoke CI reuse one full build.
- If you pass `--reuse-build`, the demo smoke harness copies those verified outputs into its
  isolated source checkout. It keeps its clean dependency installation and does not compile again.
