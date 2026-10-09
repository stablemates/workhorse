# Ruby changelog

`stablemates-workhorse` gem versions and release notes live here. The gem carries the version the
other SDKs carry, because every tag names one release of all of them.

## 0.7.0 — 2026-10-09

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v54**, Ruby **3.3** or newer, and PostgreSQL **15** or newer.

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

- **`dashboard/v1`:** task listing rows carry `humanWait.quickAction` instead of
  `humanWait.context`, as the upgrade steps describe. The break is taken in place under the ADR 0064
  exception in [`docs/compatibility.md`](../docs/compatibility.md) (SM-1171).

### Behaviour changes

Durable execution and workers:

- Durable checkpoint, timer, child, child-set, and human-decision replay conflicts fail the task on
  their first occurrence. The worker preserves the current attempt and records the conflict class.
  Before, a conflict retried under the task's retry policy, and every retry met the same conflict.
  Redaction still hides error details. Transient failures, lease loss, child-limit errors, and
  already-waiting signal errors keep their existing behaviour. Conflict settlement bypasses the
  worker's retry-delay callback (SM-1107, migration 0055).
- A renamed individual child on replay raises `ConflictError` with the stored and requested names,
  and `ConflictError.new` takes a `stored_name:` keyword. Before, it raised a child-limit error. A
  second child after joining the retained child in the same handler run still exceeds the child
  limit (SM-1106, migration 0054).
- A handler that raises the `CancelledError` of its `:shutdown` cancellation no longer charges an
  attempt. The worker hands its task to `release_owned_v1`, as it does for a task without a handler.
  Before, `CancelledError(:shutdown)` reached `fail_v1`, so a task on its last attempt failed
  because its worker stopped (SM-1164).
- The `workhorse.handler` span descends only from the task's stored trace context. A task without
  one starts a new trace instead of joining a span that a context-propagating executor carries into
  the handler thread (SM-1179).

Dashboard host:

- `Dashboard.new(audit_actor: ...)` no longer replaces the actor of a `Principal` that `authorize`
  returns. The dashboard records the principal's actor, as the `dashboard/v1` protocol requires.
  `audit_actor` still names the actor when `authorize` returns `true`, and defaults to `dashboard`
  there (SM-1152).
- `Dashboard` refuses an RPC body over 2 MiB, or a malformed declared length, with `413` before
  parsing. An unexpected schema-compatibility failure, such as a connection error, answers a generic
  `503` and is written to `rack.errors` instead of escaping the Rack app (SM-1168).

Maintenance, health, and administration, from the SQL changes:

- Terminal cleanup repeats its batch while each one fills, for up to one second per pass. A pass
  that still ends with a full batch makes its follow-up due five seconds later. Full-tier and
  fast-tier tasks share every batch (SM-1160, migration 0058).
- `tick_v1` runs the expired-lease scan only when no tick ran it within half the shortest
  maintenance interval of the live registered workers. A worker that opts out of the registry with
  `disable_registry: true` does not shorten that spacing. Recovery of an expired lease can then take
  longer (SM-1167, SM-1192, migration 0061).
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

- `Queue#health` reports the backlog budget as `budgets.terminalCleanupBacklogMs` with schema 64,
  and `status.reasons` can carry `terminal-cleanup-backlog` (SM-1178, SM-1197).

### Dependencies

- The gemspec declares `logger` at least 1.6 and below 2. Ruby 4.0 no longer ships `logger` as a
  default gem. On Ruby 4.0, 0.6.1 raises `LoadError` at `require "stablemates/workhorse"` unless
  the application already installs `logger` (SM-1138).
- The dashboard requires `cgi/escape` instead of `cgi`, which Ruby 4.0 reduces to a stub that warns
  (SM-1138).

### Recipes

- A new tested recipe enqueues through Sequel on its native `pg` connection (SM-1114).
- The quick start and the agent playbook print their results as JSON (SM-1139), and a batch handler
  example shows how batch-handler tasks are enqueued (SM-1135).

## 0.6.1 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Ruby **3.3** or newer, and PostgreSQL **15** or newer.

The gem has no changes in 0.6.1. It releases at 0.6.1 to keep one version across the
registries ([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists for the Python distribution, whose 0.6.0 files on PyPI have no PEP 740
attestations.

**A 0.6.0 database needs no migration.** 0.6.1 adds no migration, so the final schema version is
**52** and the SDK compatibility floor stays at schema version **43**. An installation on 0.5
follows the [0.6.0 upgrade steps](../CHANGELOG.md#060--2026-10-02).

## 0.6.0 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Ruby **3.3** or newer, and PostgreSQL **15** or newer.

- The gem needs schema version 43 or later. The SDK compatibility floor is schema version **43**,
  and the final schema version is **52**. The migrations since 0.5.0 only add, so the upgrade is a
  rolling deployment: run `workhorse schema migrate` before any new process starts. The
  [root changelog](../CHANGELOG.md) lists the SQL fixes. Each takes effect when its migration commits, and version 52
  includes them all.
- An installation that runs cold export stops its exporters across migration 0052. That migration
  repairs the export ledger, but it cannot stop an upload already in flight. Upgrade in this order:

  1. Stop every cold exporter, and let each finish its object and manifest uploads.
  2. Keep cold export enabled, so retention keeps waiting for the export.
  3. Run `workhorse schema migrate`.
  4. Restart the exporters after the migration commits.

  An installation that never enabled cold export needs no extra step. The
  [cold export guide](../docs/guides/335-cold-export.md#a-day-is-a-utc-day) explains the repair.

- A handler result PostgreSQL cannot store now fails only its task. jsonb refuses a NUL character
  and an unpaired surrogate. Such a result used to reach the completion statement, whose refusal
  ended `run` and left the task leased. The worker now fails the attempt under the task's retry
  policy with an `ArgumentError`. Its message names the task type and carries no part of the value.
  On the fast tier the other members of a completion batch still complete. A database error during
  completion still ends `run`.
- `Queue#sync_schedules` applies each task type's current contract, read from PostgreSQL, before
  the write. A payload that fails the schema raises `ContractValidationError` and writes nothing. A
  valid definition stores the contract version, its size limits, and its redaction keys.
- Add the `Queue` client: `enqueue` and `enqueue_many` with every client enqueue option,
  cancellation, signal and human wait delivery, queue health, and schedule and contract
  synchronization. `sync_concurrency_policies`, `sync_rate_limit_policies`, and `sync_budgets`
  replace a namespace's definitions, and the list methods read them back.
- Durations, including a `RateLimit` interval, are finite Numeric seconds. The client refuses a
  value outside a protocol bound with `ArgumentError` before it sends any statement.
- Contract schemas are checked against the draft 2020-12 meta-schema. The contract profile rejects
  `pattern` and `patternProperties` at any depth with `ArgumentError`, as every SDK does
  ([ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md)). Check a
  string's shape in handler code instead. A `$ref` must point at a subschema, so it cannot reach a
  schema hidden in `default` or `examples`; any other reference raises `ArgumentError` with
  `<path>.$ref must point at a subschema of the contract`, including a pointer that encodes `/` as
  `%2F`.
- **Breaking: a contract version that another SDK's 0.5 release synced with `pattern` or
  `patternProperties` does not compile in this gem.** Upgrade in this order:
  1. Find each contract version that uses either keyword, or a `$ref` that points outside a
     subschema.
  2. Publish a new version without either keyword, and move `currentVersion` to it.
  3. Let tasks that hold the old version finish before you run Ruby workers. A worker checks a
     task's result against the version the task holds. If that version's result schema uses either
     keyword, completing the task fails the attempt with `ArgumentError`, and the task's retry
     policy applies. Each payload was checked at enqueue, so a keyword in the payload schema does
     not affect tasks already queued.
- **Breaking: a contract `$ref` must be `#` or `#/$defs/<name>`, and `$anchor` is no longer
  accepted** ([ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md)).
  `<name>` is a key of the root `$defs`. `ArgumentError` names any other reference with
  `<path>.$ref must point at a subschema of the contract`, and also `$defs` below the root, a
  `$defs` name that does not match `^[A-Za-z_][-A-Za-z0-9._]*$`, and `$anchor` at any depth. A
  property named `$anchor` stays valid. Upgrade in this order:
  1. Find each contract version that references anything other than `#` or a root definition, nests
     `$defs`, uses `$anchor`, or names a definition outside that pattern.
  2. Move each referenced or anchored subschema into the root `$defs` and reference it as
     `#/$defs/<name>`. Rename each definition outside the pattern and update the references to it.
     Declare a new contract version, because contract rows are immutable, and move `currentVersion`
     to it.
  3. Let tasks that hold the old version finish before you run Ruby workers. A removed form in a
     task's result schema fails the attempt with `ArgumentError`, and the task's retry policy
     applies.
- Add the executor forms: a `PG::Connection`, a `ConnectionPool`, or any object whose `with`
  yields a connection. `ActiveRecordExecutor` joins the caller's Active Record transaction.
- Add the error hierarchy under `Stablemates::Workhorse::Error`.
- Add the `Admin` operator client: task, timeline, checkpoint, progress, and wait inspection, dead
  letter listing and redrive, worker pause, and queue pause, resume, and purge. Every control takes
  an `AdminAudit`.
- Add `Dashboard`, a Rack application that serves the operator dashboard under a Rails `mount` or a
  `Rack::Builder#map`. It answers the dashboard/v1 procedures and serves the bundled browser app.
- `Executor.for` ignores the `Object#with` that ActiveSupport defines, so a plain object is still
  refused.
- Add `Worker`: it claims, heartbeats, completes, fails, and retries tasks over a
  `ConnectionPool`, and runs handlers on a thread pool of `concurrency` threads. A handler receives
  its payload and a `HandlerContext` with the task and a `CancellationToken`. `stop` requests
  shutdown. `run` then drains handlers within `shutdown_grace`, cancels the rest with `:shutdown`,
  and raises `ShutdownIncompleteError` when any handler still runs.
- Add the durable `HandlerContext` calls: `checkpoint`, `sleep`, `sleep_until`, `wait_for_signal`,
  `wait_for_human`, `run_child`, `run_children`, `run_children_all`, `get_progress`, and
  `set_progress`. A call that waits suspends the attempt and releases its lease, and the task
  resumes in the same attempt. A handler that swallows the suspension still suspends, and the
  worker logs `workhorse.handler.signal_swallowed`. After the lease is lost, every durable write
  raises `LeaseLostError`; reads and checkpoint replays still return. A child without a queue runs on the worker's first queue.
- Under Rails, handlers run inside `Rails.application.executor.wrap`. `run` warns when the Active
  Record pool is smaller than `concurrency`.
- `Worker` runs tasks on a fast-tier queue: it probes each queue with `complete_many_and_claim_v1`,
  records one `fast_task_outcome` row per task, and fuses each completion with a refill claim.
  `Worker.new(cohorts:)` splits the slots into dispatch cohorts; without it, the worker keeps one
  below concurrency 8, else `concurrency / 8` from 2 through 8, capped by the pool's spare
  connections. The handler thread pool now allows two threads per slot.
  A fast-tier task's `HandlerContext` raises `FastTierUnsupportedError` for checkpoints,
  progress writes, durable waits, and child tasks before any durable write. That holds for a
  task claimed through `claim_many_v1` after its queue moved to the fast tier.
- `HandlerContext#wait_for_signal`, `wait_for_human`, `run_child`, `run_children`, and
  `run_children_all` validate each step name before the deferred tier read or any write, as
  `checkpoint` and `sleep` do. An invalid name raises `ArgumentError`. A child set is checked for
  its type and size before its names.
- A pooled connection that PostgreSQL dropped is discarded through the pool's
  `discard_current_connection`, so the next statement gets a fresh connection. Before, the pool
  reused the dead connection until the process restarted. An ordinary SQL error keeps the
  connection, and the failed statement is never resent.
- `Worker` measures a result as PostgreSQL does, by the UTF-8 length of its `jsonb` text, before
  it completes the task. A result over the task's limit fails only its own attempt with
  `ValueSizeLimitError`, and the retry policy decides what happens next. The worker no longer stops
  when PostgreSQL refuses an oversized completion. That holds on both tiers and for batch members.
- Add `Worker#handle_batch` with `max_size:` and `linger:` in seconds. Once the worker stops, a
  lingering batch runs as soon as every task it claimed has arrived.
- Change the `handle_batch` block from `|payloads, context|` to `|items|`. Each `BatchHandlerItem`
  holds a member's `payload` and its own `BatchHandlerContext` with `task`, `cancellation`,
  `get_checkpoint`, `checkpoint`, `get_progress`, and `set_progress`. The batch-wide `tasks` and
  shared `cancellation` are gone. Each write is fenced on its member's lease, and a member's
  checkpoint replays whatever batch a retry puts it in. A fast-tier member's `checkpoint` and
  `set_progress` raise `FastTierUnsupportedError` before any durable write.
- Add `HandlerContext#get_checkpoint`.
- `HandlerContext#checkpoint`, `sleep`, and `sleep_until` refuse a name outside 1 to 200
  characters with `ArgumentError` before the block runs or any statement. `get_progress` keeps the
  highest progress revision PostgreSQL acknowledged when `set_progress` calls return out of order.
- The Active Job adapter's `enqueue_all` clears each job's `enqueue_error`, so a job reports only
  the error of the current call.
- Add `run_worker_process`, which stops the worker on `TERM` or `INT` and exits at once on a second
  signal, and `run_worker_processes`, which forks, supervises, and restarts worker processes.
- A `logger` that raises no longer reaches worker lifecycle code. An accepted heartbeat still
  renews the lease, `Worker#stop` still wakes the dispatcher, and a second signal still exits the
  process. The first failure of each logger is written to standard error.
- Add the Active Job adapter, selected with `config.active_job.queue_adapter =
:stablemates_workhorse`. It requires Active Job 8.0 or later. A default job runs under the
  `active_job` task type. A typed job declares its task type with `workhorse_options` and carries
  one JSON `Hash`, so another SDK can enqueue or run it. `Stablemates::Workhorse::ActiveJob.handle`
  registers both formats on a `Worker`.
- Workers built on one pool share one notification listener connection, as they share the
  heartbeat connection. Each worker is woken only for its own queues, and the listener stops when
  the last worker on the pool stops.
- `EnqueueResult#reason` says why a debounced enqueue was `:non_replaceable`:
  `:incompatible_key_mode`, `:not_pending`, or `:window_elapsed_pending`. It is `nil` for every other
  outcome.
