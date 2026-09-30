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
- Add `run_worker_process`, which stops the worker on `TERM` or `INT` and exits at once on a second
  signal, and `run_worker_processes`, which forks, supervises, and restarts worker processes.
- Add the Active Job adapter, selected with `config.active_job.queue_adapter =
:stablemates_workhorse`. It requires Active Job 8.0 or later. A default job runs under the
  `active_job` task type. A typed job declares its task type with `workhorse_options` and carries
  one JSON `Hash`, so another SDK can enqueue or run it. `Stablemates::Workhorse::ActiveJob.handle`
  registers both formats on a `Worker`.
