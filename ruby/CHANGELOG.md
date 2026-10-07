# Ruby changelog

`stablemates-workhorse` gem versions and release notes live here. The gem carries the version the
other SDKs carry, because every tag names one release of all of them.

## Unreleased

Requires **schema v54**. Migrate the schema before starting updated processes.
The final schema version is **57**, and the SDK compatibility floor is schema version **54**.
Migration 0054 adds versioned child functions and a nullable fence marker; older clients keep their v1 functions.

A renamed individual child on replay now raises a conflict with the stored and requested names.
A second child after joining the retained child in the same handler run still exceeds the child limit (SM-1106).

Migration 0055 (`0055-fail-durable-replay-conflicts-without-retrying.sql`) adds the terminal failure override.

Durable checkpoint, timer, child, child-set, and human-decision replay conflicts now fail the task
on their first occurrence, preserving its current attempt and recording the conflict class.
Redaction still hides error details. Transient failures, lease loss, child-limit errors, and
already-waiting signal errors retain their existing behavior. Conflict settlement bypasses the
worker's retry-delay callback.

Migration 0056 (`0056-count-row-retention-lag-from-the-history-pass-that-released-the-row.sql`) changes only `queue_health_v1`. Row retention lag now counts from the scheduled history pass that released the row when that pass came after the row window, so health no longer reports task records and finished results as late after every daily pass (SM-1134).

**Behavior change:** `Dashboard.new(audit_actor: ...)` no longer replaces the actor of a `Principal`
that `authorize` returns. The dashboard records the principal's actor, as the `dashboard/v1`
protocol requires. `audit_actor` still names the actor when `authorize` returns `true`, and
defaults to `dashboard` there (SM-1152).

The gemspec now declares `logger` at least 1.6 and below 2. Ruby 4.0 no longer ships `logger` as a
default gem. On Ruby 4.0, 0.6.1 raises `LoadError` at `require "stablemates/workhorse"` unless the
application already installs `logger` (SM-1138). The dashboard requires `cgi/escape` instead of
`cgi`, which Ruby 4.0 reduces to a stub that warns.

Migration 0057 (`0057-close-a-released-task-without-attributing-its-unrun-attempt.sql`) changes only `cancel_v1` and `terminalize_deadline_v1`. A full-tier task that a worker without a handler returned through `release_owned_v1` can now be canceled, and deadline recovery terminalizes it instead of rolling back the whole recovery pass. Both close it like never-started work, with no attempt history row (SM-1158).

`Dashboard` refuses an RPC body over 2 MiB, or a malformed declared length, with `413` before parsing.
An unexpected schema-compatibility failure, such as a connection error, now answers a generic `503` and is
written to `rack.errors` instead of escaping the Rack app (SM-1168).

Migration 0058 (`0058-let-terminal-cleanup-keep-pace-and-share-its-budget-across-tiers.sql`) changes `prune_terminal_tasks_v1`, `prune_terminal_storage_v1`, and `queue_health_v1`, and adds two `maintenance_state` columns. Terminal cleanup repeats its batch while each one fills, for up to one second per pass, and a pass that still ends with a full batch makes its follow-up due five seconds later instead of after the five-minute interval. Full-tier and fast-tier tasks share every batch, so neither tier starves the other. The health document reports `terminal_cleanup_backlog_since` while cleanup is behind (SM-1160).

**Fixed:** A handler that raises the `CancelledError` of its `:shutdown` cancellation no longer
charges an attempt. The worker hands its task to `release_owned_v1`, as it does for a task without a
handler. Before, `CancelledError(:shutdown)` reached `fail_v1`, so a task on its last attempt failed
because its worker stopped (SM-1164).

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
