# Ruby changelog

`stablemates-workhorse` gem versions and release notes live here. The gem carries the version the
other SDKs carry, because every tag names one release of all of them.

## Unreleased

- Add the `Queue` client: `enqueue` and `enqueue_many` with every client enqueue option,
  cancellation, signal and human wait delivery, queue health, and schedule and contract
  synchronization. `sync_concurrency_policies`, `sync_rate_limit_policies`, and `sync_budgets`
  replace a namespace's definitions, and the list methods read them back.
- Durations, including a `RateLimit` interval, are finite Numeric seconds. The client refuses a
  value outside a protocol bound with `ArgumentError` before it sends any statement.
- Contract schemas are checked against the draft 2020-12 meta-schema, and `pattern` matches with
  ECMA-262 semantics.
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
