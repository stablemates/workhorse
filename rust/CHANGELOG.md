# Rust changelog

`workhorse` crate versions and release notes live here because the crate publishes to crates.io
from the release workflow's `crates-io` job, apart from the npm packages. It carries the version
the TypeScript packages, the Python distribution, and the Go module carry, because every tag names
one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## Unreleased

Requires **schema v69**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** The upgrade is a rolling deployment:

1. Run `workhorse schema migrate`. The final schema version is **71**.
2. Roll out the updated processes.

The SDK compatibility floor is schema version **69**, which migration 0070 reaches. The floor rises
from 54. Every SDK statement catalogue now names the task group functions that migration 0066 adds,
and `save_checkpoint_v2`, which migration 0069 adds. The dashboard of each SDK calls
`dashboard_task_groups_v1`, which migration 0067 adds, and `list_newest_task_group_events_v1`, which
migration 0068 adds. Migration 0070 fences a member add, so an updated process does not add tasks to
a group without that check. An updated process refuses a schema below version 69 at startup. A 0.7
process keeps working on version 71, because a migration inside a major line only adds.

Migration 0066 (`0066-add-task-groups-with-completion-callbacks.sql`) adds task groups (SM-1231,
[ADR 0095](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0095-add-task-groups-with-completion-callbacks.md)).
A task group is a set of full-tier tasks that Workhorse tracks as one unit. When the group is
sealed and every member task is finished, Workhorse enqueues its `onFinish`, `onSuccess`, or
`onFailure` callback task. The migration adds the `task_group`, `task_group_member`,
`task_group_callback`, and `task_group_event` tables, and a trigger on `task_outcome` that counts
each member outcome in the transaction that writes it. A queue purge counts a purged member task as
`canceled`. The `terminal_storage` routine keeps member tasks while their group is not finished,
reports a new `task_groups` phase after `terminal_tasks`, and deletes a finished group after its
callback tasks are terminal. New SQLSTATEs: `P1008` (the task group does not accept tasks), `P1009`
(member limit of 100,000), and `P1010` (an enqueue idempotency hit returns a task that is not a
member of the group).

Migration 0067 (`0067-count-task-group-outcomes-in-counter-shards.sql`) counts task group outcomes
in counter shards (SM-1245,
[ADR 0096](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0096-count-task-group-outcomes-in-counter-shards.md)).
Each group gets 32 rows in the new `task_group_shard` table, and a member outcome locks only its
shard row at commit. The outcome locks the group row only when the pending count of its shard
becomes 0. The migration moves the counts of existing groups into the shards. It locks `task_group`
in `EXCLUSIVE` mode while it runs, so task group changes wait for it. The counts on a `task_group`
row stay 0 until the group finishes, so read the counts through `get_task_group_v1`. The migration
also adds `dashboard_task_groups_v1`, which lists task groups one page at a time. The dashboard of
each SDK reads the task group list through it (SM-1237).

Migration 0068 (`0068-read-the-newest-task-group-events.sql`) adds
`list_newest_task_group_events_v1`, which returns the newest events of a task group first
(SM-1254). The task group detail of the dashboard reads its events through it. A group with more
than 1,000 events now shows its newest 100 events. `eventsTruncated` is true when the group has
older events that the detail does not show. `list_task_group_events_v1` does not change. The
migration changes no stored data.

Migration 0069 (`0069-check-the-input-of-a-checkpoint-on-replay.sql`) adds the nullable column
`task_checkpoint.input_fingerprint` and `save_checkpoint_v2` (SM-1211,
[ADR 0098](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0098-check-the-input-of-a-checkpoint-on-replay.md)).
If a checkpoint name exists, `save_checkpoint_v2` returns `input_conflict` when the stored and the
given input fingerprints are both present and differ. `save_checkpoint_v1` now calls
`save_checkpoint_v2` with no fingerprint, so its results do not change. The checkpoint reads of each
statement catalogue return the new column. Existing rows keep a NULL fingerprint. The migration adds
the column without a table scan.

Migration 0070 (`0070-fence-a-task-group-member-add-and-index-the-group-list.sql`) fences a task
group member add (SM-1273). `add_task_group_members_v1` now locks the runtime row of the member task
first, before the shard rows and the group row, as a completion does. Then it refuses the add with
`P1008` and the reason `not_running_member` if the lease of the member task expired, its deadline or
attempt timeout passed, or a cancel was requested. Before, a worker whose lease expired could add
tasks after Workhorse gave the member task to a new worker. The signature does not change. The
migration also adds `task_group_state_created_idx`, so `dashboard_task_groups_v1` reads one page of
a state without a read of the groups of other states. The migration is a non-transactional step: it
builds the index with `CREATE INDEX CONCURRENTLY`, so writes to `task_group` continue. If it fails
part-way, drop the invalid index before the rerun, as `docs/schema-lifecycle.md` describes. It
changes no stored data.

Migration 0071 (`0071-lock-purged-runtime-rows-in-identity-order.sql`) makes a queue purge lock its
tasks in identity order (SM-1282). Before, `purge_queue_internal_v1` locked the runtime rows and the
task rows of the queue in scan order. An enqueue that named two of those tasks as prerequisites
locks them in identity order. Thus the purge and the enqueue could wait for each other, and
PostgreSQL aborted one of them with `40P01`. The purge now locks every runtime row, then every task
row, each in identity order. The signature and the deleted count do not change. The migration does
not raise the SDK compatibility floor, because no SDK statement changes and every process gets the
new lock order when the migration commits. It changes no stored data.

Migration 0072 (`0072-purge-a-queue-that-holds-a-prerequisite-of-a-live-dependent.sql`) lets a
queue purge succeed when it holds a prerequisite of a waiting dependent (SM-1284,
[ADR 0101](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0101-cancel-a-purged-prerequisite-whose-dependent-stays.md)).
Before, the purge deleted that prerequisite, and PostgreSQL refused the delete with `23001`. The
whole purge then failed, also when the dependent was in the same queue. Now the purge deletes a
dependent in the same purge with its prerequisite. If the dependent stays, for example in another
queue, the purge cancels the prerequisite instead of a delete. The dependent's own
`on_cancellation` policy then decides its outcome, as after a cancel. The canceled task keeps its
history and its keys. The purge count, `deleted_count` and `deletedCount`, includes the canceled
tasks. The purge locks the dependents after its own tasks, as a cancel does, so it has no
deadlock that a cancel of the same tasks does not also have. Two purges run one after the
other, also for different queues. The migration does not raise the SDK compatibility
floor, because no SDK statement or result shape changes. It changes no stored data.

### New features

- Task groups (SM-1235, ADR 0095). `Queue` gains `create_task_group`, `add_to_task_group`,
  `seal_task_group`, the block form `task_group`, `get_task_group`, `list_task_group_members`, and
  `find_task_group`. `TaskGroupCallbacks` holds the `on_finish`, `on_success`, and `on_failure`
  requests. The block form creates, adds, and seals in one statement. A `Queue` over a transaction
  executor makes the other calls part of the caller's transaction.
- A handler reads its group through `ctx.task_group().get()`, as a member task or as a callback
  task. A running member task adds tasks through `ctx.task_group().add()`, under its fenced lease,
  also after the seal. If a request names no queue, `add()` puts the task in the queue of the member
  task (SM-1251,
  [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
  `BatchHandlerContext::task_group` gives a batch member the same calls.
- `Admin` gains `get_task_group`, `list_task_group_members`, `list_task_group_events`,
  `cancel_task_group`, `list_task_group_drift`, and `repair_task_group_drift`.
- `Error` gains `TaskGroupClosed` (`P1008`), `TaskGroupLimitExceeded` (`P1009`), and
  `TaskGroupMembershipConflict` (`P1010`), with their `DETAIL` documents. `Operation` gains
  `AddToTaskGroup`.
- `list_task_group_members` of `Queue` and `Admin` returns `next_after: None` on the last page,
  also when the page is full (SM-1277). Before, a full last page gave a `next_after` that read an
  empty page. A full page now costs one more read of one member. `TaskGroup::callbacks` keeps the
  order `on_finish`, `on_success`, `on_failure`, and a test now asserts it. The change adds no SQL
  function and no migration.
- Checkpoint input check (SM-1263,
  [ADR 0098](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0098-check-the-input-of-a-checkpoint-on-replay.md)).
  `HandlerContext::checkpoint_with_input(name, &input, op)` stores the fingerprint of the input with
  the result, through `save_checkpoint_v2`. If a later call gives an input with a different
  fingerprint, the call fails with `Error::CheckpointInputConflict`, and `op` does not run.
  Overlapping calls with one name compare their inputs too. If the call or the stored checkpoint has
  no input, nothing is compared. The worker settles the conflict as the terminal replay conflict
  `CheckpointInputConflictError`, so the task fails at once and keeps the current attempt.
  `BatchHandlerContext` gains the same method. `checkpoint` without an input does not change.
- `checkpoint_input_fingerprint(&input)` returns the fingerprint: the SHA-256 digest of the RFC 8785
  canonical JSON of the input, as 64 lowercase hexadecimal characters. It gives the same digest as
  the TypeScript SDK, and every SDK refuses the same inputs (SM-1274). A number larger than 2^53 - 1
  in magnitude, such as `u64::MAX` or `1e21`, returns `Error::InvalidArgument`.
- `TaskCheckpoint` gains `input_fingerprint`, the stored fingerprint or `None`. Code that builds a
  `TaskCheckpoint` with a struct literal must set the new field.

### Behaviour changes

- If a child task request names no queue, `HandlerContext::run_child`, `run_children`, and
  `run_children_all` put the child in the queue of the parent task (SM-1260,
  [ADR 0097](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md)).
  Before, the child went to the queue `default`. If no worker served `default`, the child stayed
  `ready`, and the parent task did not continue. To keep the old queue, name it on the request, for
  example `EnqueueOptions { queue: Some("default".into()), ..Default::default() }`.
  A parent task that created a child before the upgrade can replay that request after the upgrade.
  If the replayed request names no queue, it keeps the queue of the stored child, so the parent
  task joins its child.
- `Worker::run_once` does not change: a pass that released every task that it claimed returns
  `false`, and the next call claims at once (SM-1259, [ADR 0099](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0099-report-a-released-only-single-pass-as-no-progress.md)). TypeScript
  `runOnce()` now does the same. If you call the single-pass call in a loop, wait after `false`.

## 0.7.1 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

The crate has no changes in 0.7.1. It releases at 0.7.1 to keep one version across the
registries ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists because the npm publish of 0.7.0 stopped partway.
The crate never published at 0.7.0, so 0.7.1 is the first release with the 0.7.0 changes below.

**A 0.7.0 database needs no migration.** 0.7.1 adds no migration, so the final schema version is
**64** and the SDK compatibility floor stays at schema version **54**. An installation on 0.6
follows the [0.7.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#070--2026-10-09).

## 0.7.0 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

### Upgrade steps

**Migrate the schema before starting updated processes.** The upgrade is a rolling deployment: run `workhorse schema migrate`, then roll out the 0.7
processes. The final schema version is **64**. The SDK compatibility floor is schema version
**54**, which migration 0055 reaches. A 0.7 process refuses a schema below version 54 at startup,
and a 0.6 process keeps working on version 64. Each migration commits on its own, and each SQL
change takes effect when its migration commits.

**Migration 0059 clears incomplete rate settings.** A per-key rate limit or a budget rate with one
or two of its three fields null used to pass its CHECK constraint. The migration clears such a
setting, and deletes a budget that the clearing leaves without a limit. After the migration,
PostgreSQL rejects a synchronization that writes an incomplete rate setting. To keep a limit the
migration cleared, complete it in your synchronized definitions and synchronize after the
migration.

**Accept the new `terminal-cleanup-backlog` health reason.** Queue health can now report it as
degraded, so code that switches on reason codes should accept it. Its budget,
`terminal_cleanup_backlog_ms`, starts from your `row_retention_lag_ms` setting, so existing alerts
evaluate as before. After migration 0065 the two budgets are independent.

**Update `dashboard/v1` clients that read `humanWait.context` from a task listing.**
`dashboard.tasks` and `dashboard.tasksCursor` rows carry `humanWait.quickAction` instead, which is
`{ label }` or `null`. `dashboard.taskDetail` still returns the full context (SM-1171).

**Handler authors: a durable replay conflict now fails its task on the first occurrence.** The
behaviour changes below describe it. A 0.6 worker still retries a conflict under the task's retry
policy until the 0.6 processes are gone.

### Breaking changes

- `dashboard::DashboardOptions::audit_actor` is removed. It replaced the verified principal's actor
  on every mutation, so a dashboard could record a service name instead of the operator who acted.
  The dashboard now always records the actor of the returned `Authorization::Principal`, as the
  `dashboard/v1` protocol requires. Delete the field from your options. To record a fixed actor,
  return a `Principal` with that `actor` from `authorize` (SM-1152).
- `HandlerError` gains private fields, so a struct literal no longer builds one. Use
  `HandlerError::new` or `HandlerError::named`, then set `stack` or `name` on the result. One field
  marks an error converted from `Error::Conflict`, and the worker fails the task without a retry
  only when it is set. Before, the worker read the name, so an application error built with
  `HandlerError::named("WaitConflictError", …)` failed its task for good (SM-1164).
- The generic `From<E>` conversion into `HandlerError` requires `E: 'static`, so it can inspect the
  source chain and keep a conflict's class. For an error that borrows local data, build
  `HandlerError::new(error.to_string())` explicitly (SM-1107).
- **`dashboard/v1`:** task listing rows carry `humanWait.quickAction` instead of
  `humanWait.context`, as the upgrade steps describe. The break is taken in place under the ADR 0064
  exception in
  [`docs/compatibility.md`](https://github.com/stablemates/workhorse/blob/main/docs/compatibility.md)
  (SM-1171).

### Behaviour changes

Durable execution and workers:

- Durable checkpoint, timer, child, child-set, and human-decision replay conflicts fail the task on
  their first occurrence. The worker preserves the current attempt and records the conflict class.
  Before, a conflict retried under the task's retry policy, and every retry met the same conflict.
  Redaction still hides error details. Transient failures, lease loss, child-limit errors, and
  already-waiting signal errors keep their existing behaviour. Conflict settlement bypasses the
  worker's retry-delay callback (SM-1107, migration 0055).
- A renamed individual child on replay raises a child conflict with the stored and requested names.
  Before, it raised a child-limit error. A second child after joining the retained child in the same
  handler run still exceeds the child limit (SM-1106, migration 0054).
- The worker measures a handler result as PostgreSQL measures it, `octet_length` of its jsonb text,
  before it sends the completion. A result over the task's `result_max_bytes` fails its attempt with
  `TaskValueSizeLimitError` on both tiers, and the task's retry policy and the worker's
  `retry_delay` apply. Before, `complete_v1` raised, which left a full-tier task active until lease
  recovery. The fast tier's batched completion failed the attempt in PostgreSQL, which skipped
  `retry_delay` (SM-1159).
- `HandlerContext::checkpoint` and `HandlerContext::set_progress`, and their `BatchHandlerContext`
  wrappers, refuse a value that holds `NaN` or an infinity at any depth. A checkpoint returns a
  `HandlerError`, and `set_progress` returns `Error::InvalidArgument`, both before any write.
  `serde_json` had stored such a number as `null`, so a `checkpoint::<f64>` failed to decode on
  every retry (SM-1180).
- A handler that panics after its `CancelReason::Shutdown` cancellation fails its attempt, as any
  handler panic does. Before, the worker released the task without charging the attempt (SM-1164).
- With the `opentelemetry` feature, the `workhorse.handler` span descends only from the task's
  stored trace context. A task without one starts a new trace instead of joining the current
  `tracing` span. The `tracing` span still nests under that span, so its log events keep their scope
  (SM-1179).

Dashboard host:

- The dashboard service answers an unexpected schema-compatibility failure with a generic `503`. It
  logs the cause through `tracing` instead of returning the driver error text (SM-1168).

Maintenance, health, and administration, from the SQL changes:

- Terminal cleanup repeats its batch while each one fills, for up to one second per pass. A pass
  that still ends with a full batch makes its follow-up due five seconds later. Full-tier and
  fast-tier tasks share every batch (SM-1160, migration 0058).
- `tick_v1` runs the expired-lease scan only when no tick ran it within half the shortest
  maintenance interval of the live registered workers. A worker that opts out of the registry with
  `WorkerOptions::disable_registry` does not shorten that spacing. Recovery of an expired lease can
  then take longer (SM-1167, SM-1192, migration 0061).
- Row retention lag counts from the scheduled history pass that released the row, so health no
  longer reports task records and finished results as late after every daily pass (SM-1134,
  migration 0056).
- Queue health raises `terminal-cleanup-backlog` once `terminal_cleanup_backlog_since` is older than
  its budget (SM-1178, SM-1197, migrations 0063 and 0065).
- `run_task_now_v1` reports `not_scheduled` for a blocked task instead of raising an error. A rate
  synchronization refills each changed bucket at the old rate up to one clock reading. An update
  can no longer change a dependency edge's endpoints or outcome policies (SM-1165, migration 0059).
- A full-tier task that a worker without a handler released can be canceled, and deadline recovery
  terminalizes it. Both close it like never-started work (SM-1158, migration 0057).

Dashboard, from the shared browser bundle:

- Pausing a schedule asks for confirmation, as resuming one already did (SM-1147).
- The Events pager stops at the last page the server accepts and offers older events through a
  custom range. The activity chart shows loading, error, and stale states with a Retry button
  (SM-1171).
- The Schedules page says how many schedules past the first 50 it does not show, and the System
  page lists the terminal cleanup backlog check (SM-1171, SM-1178).

### Migrations

Migration 0054 is the first since 0.6.1. The
[root changelog](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md) describes each in
full.

- **0054** adds versioned child functions and the nullable `task_child.last_seen_fence_token`
  fence marker. Older clients keep their v1 functions (SM-1106).
- **0055** reserves a retry delay of -1 in `fail_v1` and `fast_fail_v1` as the terminal failure
  override. It is the SDK compatibility floor, schema version 54 (SM-1107).
- **0056** changes `queue_health_v1` to count row retention lag from the releasing history pass
  (SM-1134).
- **0057** changes `cancel_v1` and `terminalize_deadline_v1` to close a released task like
  never-started work (SM-1158).
- **0058** lets terminal cleanup keep pace and share its batches across tiers, and adds two
  `maintenance_state` columns (SM-1160).
- **0059** closes five SQL integrity gaps. It adds `rate_limit_policy_per_key_complete_check`,
  `budget_rate_complete_check`, and a trigger that rejects a dependency edge update (SM-1165).
- **0060** judges `fast_complete_many_v1` and `fast_acknowledge_cancel_v1` at the time they act
  (SM-1163).
- **0061** adds `fast_task_outcome_failed_finished_idx`, bounds `aggregate_stats_v1`, and spaces the
  expired-lease scan in `tick_v1` with the new `maintenance_state.lease_recovery_started_at` column
  (SM-1167).
- **0062** adds `dashboard_human_wait_quick_action_v1` and bounds four dashboard read functions
  (SM-1171).
- **0063** raises the `terminal-cleanup-backlog` health reason and adds
  `terminal_cleanup_follow_up_delay_ms_v1` (SM-1178).
- **0064** disables JIT for `aggregate_stats_v1` (SM-1193).
- **0065** gives `terminal-cleanup-backlog` its own budget in `queue_health_policy`, adds
  `sync_queue_health_policy_v2`, and keeps `sync_queue_health_policy_v1` (SM-1197).

### Added

- `EnqueueClient` and the `EnqueueTransport` trait let an adapter author run enqueue, contract
  synchronization, and the compatibility check over a mutable transport, such as a borrowed
  transaction. `EnqueueQuery`, `EnqueueBind`, `EnqueueColumn`, `EnqueueColumnType`, `EnqueueValue`,
  and `EnqueueRow` describe each statement and its rows. `Error::Database` carries a driver error
  with its SQLSTATE and detail. `Queue` keeps its API
  ([ADR 0086](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0086-separate-rust-enqueue-preparation-from-mutable-transports.md),
  SM-1123).
- The optional `sqlx` feature implements `EnqueueTransport` for `sqlx::Transaction<'_, Postgres>`,
  so an enqueue commits or rolls back with the application's SQLx transaction. It pins SQLx 0.8.6
  exactly, and `examples/sqlx_transaction.rs` shows it
  ([ADR 0088](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0088-borrow-sqlx-transactions-for-rust-enqueue.md),
  SM-1124).
- `Queue::health` reports the backlog budget as `budgets.terminalCleanupBacklogMs` with schema 64,
  and `status.reasons` can carry `terminal-cleanup-backlog` (SM-1178, SM-1197).

### Fixed

- A heartbeat response applies only to the claim fence it was sent for. Before, a heartbeat round
  that returned after a durable parent suspended and resumed under a new fence could cancel the
  resumed handler. The task then waited for lease recovery (SM-1099).

### Recipes

- A batch handler example shows how batch-handler tasks are enqueued (SM-1135).

## 0.6.1 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

The crate has no changes in 0.6.1. It releases at 0.6.1 to keep one version across the
registries ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists for the Python distribution, whose 0.6.0 files on PyPI have no PEP 740
attestations.

**A 0.6.0 database needs no migration.** 0.6.1 adds no migration, so the final schema version is
**52** and the SDK compatibility floor stays at schema version **43**. An installation on 0.5
follows the [0.6.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#060--2026-10-02).

## 0.6.0 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

**Upgrade: migrate the schema before any 0.6 process starts.** The final schema version is **52**.
The SDK compatibility floor stays at schema version **43**, so a 0.5.0 process keeps working on
version 52. The migrations only add, so the upgrade is a rolling deployment. The
[root changelog](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md) lists the SQL fixes. Each takes effect when its
migration commits, and version 52 includes them all.

**An installation that runs cold export stops its exporters across migration 0052.** That migration
repairs the export ledger, but it cannot stop an upload already in flight. Upgrade in this order:

1. Stop every cold exporter, and let each finish its object and manifest uploads.
2. Keep cold export enabled, so retention keeps waiting for the export.
3. Run `workhorse schema migrate`.
4. Restart the exporters after the migration commits.

An installation that never enabled cold export needs no extra step. The
[cold export guide](https://github.com/stablemates/workhorse/blob/main/docs/guides/335-cold-export.md#a-day-is-a-utc-day) explains the repair.

**A handler result holding NUL now fails only its task.** jsonb refuses a NUL character. Such a
result used to reach the completion statement, whose refusal left the task leased until its lease
expired, and `Worker::run` returned that error at shutdown. The worker now fails the attempt under
the task's retry policy with an error named `Error` and the message `<task type> result contains a
NUL character or an unpaired surrogate, which PostgreSQL jsonb cannot store`. A Rust string cannot
hold an unpaired surrogate. On the fast tier the other members of a completion batch still
complete.

**Schedule sync now applies the current task contract.** `Queue::sync_schedules` wrote every
definition without its contract, so a fired task skipped payload validation, used the default size
limits, and exposed sensitive payload keys. It now reads each task type's current contract from
PostgreSQL before the write. A payload that fails the schema returns `Error::ContractValidation` and
writes nothing. A valid definition stores the contract version, its size limits, and its redaction
keys, as TypeScript and Go do.

**A dropped batch member no longer joins a later batch.** Dropping `Worker::run` or
`Worker::run_once` while a member waited for its batch's linger left that member in the worker's
batch coordinator. The next batch on the same worker then passed the abandoned payload to the
callback beside current members, even after recovery handed the same task out again. The callback
could repeat external effects, and the worker discarded that outcome. Dropping the execution now
removes its waiting member at once, as
[ADR 0074](../docs/decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md) promises.

**Breaking: contract schemas can no longer use `pattern` or `patternProperties`.** The SDKs' regular
expression engines accept different syntax and match differently, so one contract could validate
differently in each language.
[ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now leaves both
keywords out of the contract profile. Compiling or synchronizing the contract returns
`Error::InvalidArgument` with `<path> is outside the Workhorse contract profile` when either keyword
appears at any depth. A property named `pattern` stays valid. Check a string's shape in handler code
instead; `format` stays an annotation. A `$ref` must also point at a subschema, so it cannot reach
a schema hidden in `default` or `examples`; any other reference returns `Error::InvalidArgument`
with `<path>.$ref must point at a subschema of the contract`. That includes a pointer that encodes
`/` as `%2F`. Upgrade in this order:

1. Find each contract version that uses `pattern` or `patternProperties`, or a `$ref` that points
   outside a subschema. A version synced before the upgrade stops compiling once the SDK is
   upgraded.
2. Publish a new version without either keyword, and move `currentVersion` to it.
3. Let tasks that hold the old version finish before you upgrade workers. A worker checks a task's
   result against the version the task holds. If that version's result schema uses either keyword,
   completing the task fails the attempt with the profile error, and the task's retry policy
   applies. Each payload was checked at enqueue, so a keyword in the payload schema does not affect
   tasks already queued.

**Breaking: a contract `$ref` must be `#` or `#/$defs/<name>`, and `$anchor` is no longer
accepted.** The SDKs' JSON Schema libraries disagreed on how to decode and resolve other reference
forms, so a reference could reach a schema the profile check never saw.
[ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now names two reference forms: `#`, the root schema, and `#/$defs/<name>`, where
`<name>` is a key of the root `$defs`. Compiling or synchronizing the contract returns `Error::InvalidArgument` for any other reference, with
`<path>.$ref must point at a subschema of the contract`; for `$defs` below the root; for a `$defs`
name that does not match `^[A-Za-z_][-A-Za-z0-9._]*$`; and for `$anchor` at any depth. A property
named `$anchor` stays valid. Upgrade in this order:

1. Find each contract version that references anything other than `#` or a root definition, nests
   `$defs`, uses `$anchor`, or names a definition outside that pattern. A version synced before the
   upgrade stops compiling once the SDK is upgraded.
2. Move each referenced or anchored subschema into the root `$defs` and reference it as
   `#/$defs/<name>`. Rename each definition outside the pattern and update the references to it.
   Declare a new contract version, because contract rows are immutable, and move `currentVersion` to
   it.
3. Let tasks that hold the old version finish before you upgrade workers. A worker checks a task's
   result against the version the task holds, so a removed form in that result schema fails the
   attempt with the profile error, and the task's retry policy applies.

**The crate now depends on `jsonschema` 0.58 instead of 0.57.** An application that also depends on
`jsonschema` directly builds both versions until it moves to 0.58.

Fixes:

- Dropping the `Worker::run` or `run_once` future stops renewing its tasks' leases, so they expire
  instead. The worker's background loops and reserved heartbeat connection end with it.
- A batch callback runs inside the execution of the member that filled or lingered out the batch.
  Callbacks stay inside `concurrency`, and the shutdown drain waits for them.
- `Worker::run` fixes its shutdown deadline when shutdown starts and bounds every step by it. A
  stalled claim, registry row, or heartbeat round could hold `run` indefinitely.
- A worker with a batch handler is freed once its last handle is dropped. Dispatch after that
  rejects each member with `BatchAbandoned`.
- A batch callback that panics before returning its future fails each member with `HandlerPanic`
  and records the batch failure.
- `run_child`, `run_children`, and `run_children_all` validate each child payload and stamp the
  child type's current contract on the request.
- The worker keys its result-schema cache by task type and version. Two pairs whose names contain
  `|` could share one cached schema.
- The dashboard shows stored payloads, results, and checkpoints as stored. It used to rewrite any
  timestamp-like string to UTC.
- The orchestration example runs its child tasks on the queue its worker serves.

## 0.5.0 — 2026-09-28

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v43**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

**Breaking: a 0.4.x database upgrades offline, across one contract step.** Migration 0025 adds the
fast tier and SQL protocol version 5. It is a contract step shipped in a minor release, which
[ADR 0077](../docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md) §6
allows once. It narrows the protocol to exactly 5 and drops `fire_due_schedules_v1` and
`sync_schedule_definitions_v1` without a shim, so a 0.4.x process fails its compatibility check
against the new schema. `workhorse schema migrate` stops before a contract step. Upgrade in this
order:

1. Stop every worker and every producer.
2. Run `workhorse schema migrate`. It applies nothing past schema version 24 and reports the pending
   contract step.
3. Run `workhorse schema contract --yes`, which applies migration 0025 and leaves schema version 25.
4. Run `workhorse schema migrate` again. It applies migrations 0026 through 0044 and leaves schema
   version 43.
5. Start the processes from this release.

Every queue starts full-tier, so live tasks stay where they are and no history needs a backfill.

**Breaking: a process from this release refuses a schema below version 43.** The compatibility
floor moves from schema version 18 to 43 and the protocol floor from 1 to 5, because the SDK now
calls functions that migrations up to 0044 add.

**Add a fast task tier.** A fast-tier queue records one `fast_task_outcome` row per task instead of
the attempt and event history, and completes a batch and claims its refill in one statement. It
refuses dependencies, child tasks, concurrency keys, budgets, debounce, throttle, and concurrency or
rate-limit policies with SQLSTATE `P1007`. A queue moves tiers only while it is empty
([ADR 0077](../docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md)).

- Add `Admin::set_queue_tier` and `Admin::set_queue_history`, with the `QueueTier` and
  `QueueHistory` types. `set_queue_history` opts a fast-tier queue into attempt or claim history.
- Return `Error::FastTierUnsupported` for a `P1007` refusal, naming the queue, the feature, and the
  batch ordinal.
- Batch fast-tier completions with a fused refill claim. `WorkerOptions::cohorts` splits the slots
  into fixed shares that each complete and claim together. The default is 1 below a concurrency of 8
  and otherwise one cohort per eight slots, between 2 and 8, capped by the pool's spare connections.
- Govern the crate's public API as a checked surface, recorded in `api/rust.txt`
  ([ADR 0079](../docs/decisions/0079-govern-the-rust-api-as-an-eighth-surface.md)).
- Keep overlapping batched claims in flight, so a worker fills free slots while a claim is still
  running
  ([ADR 0076](../docs/decisions/0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md)).
- Skip the notification claim delay while claims keep finding work.
- Resend a fenced write and the concurrency policy sync when PostgreSQL chooses them as a deadlock
  victim, up to three attempts. Inside a caller's transaction the original deadlock error is raised.
- Claim policy- and rate-limited tasks as a set, and shard the admission counters so claims on a
  governed queue no longer serialize
  ([ADR 0082](../docs/decisions/0082-shard-the-admission-counters.md)). A plain full-tier claim
  also costs less.
- Release dependents through a pending-prerequisite counter, and settle a parent whose child is
  already terminal when it is created. Migration 0032 repairs parents an earlier release left
  waiting. A full-tier enqueue batch with several invalid members can report a different member's
  error than before.
- Release a fused claim's row locks before they can deadlock
  ([ADR 0081](../docs/decisions/0081-release-a-fused-claim-lock-before-it-can-deadlock.md)).
- Add a Tier column to the embedded dashboard Queues page, and link a schedule's tasks to that
  schedule's queue on the Schedules page.

## 0.4.0 — 2026-09-23

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v18**, Rust **1.89** or newer, and PostgreSQL **15** or newer.

**This is the first published `workhorse` crate.** Crates.io held only a `0.0.0` placeholder that
reserved the name. Add the crate with `cargo add workhorse`, and install or migrate the schema
with the schema tool of the same release. The crate never installs or migrates the schema itself.
[ADR 0074](../docs/decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md) shapes it as
one crate that follows the Python SDK's surface on Tokio.

- Add `Queue`, which enqueues, cancels, and signals tasks and synchronizes schedules, policies,
  budgets, and contracts. `Queue::new` accepts a `tokio_postgres` or `deadpool_postgres` client,
  pool, or transaction, and a caller's transaction makes the enqueue part of its commit.
- Add `Admin`, the operator client that lists, inspects, and repairs tasks, dead letters, waits,
  workers, and queues.
- Add `Worker`, which takes a `deadpool_postgres::Pool`, registers typed handlers by task type, and
  runs them under a lease. `run_worker_process` drains it within a grace period on SIGINT or
  SIGTERM.
- Add the durable `HandlerContext`: checkpoints, durable sleeps, signal and human waits, child
  tasks, and progress. PostgreSQL owns every durable decision, and an unresolved wait suspends the
  task.
- Add the `dashboard` feature, an embedded dashboard backend served as a `tower::Service` that axum,
  hyper, or any tower host mounts under its own path. A build without the feature compiles no HTTP
  dependency.
- Emit `tracing` spans always. The `opentelemetry` feature adds metrics and trace propagation.
- Verify `Queue::assert_compatible` and `Admin::assert_compatible` against the same schema window
  the other SDKs accept. A refusal is `workhorse::Error::Compatibility`, whose `code` names the
  reason.
- Run every `protocol/v1` fixture and the shared dashboard conformance fixture through the Rust
  adapters. No fixture is listed as unsupported.
- Verify the packaged crate before it publishes. The release check builds a consumer from the
  unpacked `.crate` archive outside the workspace, and runs one task through a `Worker` against a
  scratch database. Crates.io trusted publishing publishes the crate, so the release holds no
  long-lived token.
